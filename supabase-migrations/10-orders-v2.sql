-- ==========================================================================
-- Orders v2: structured items, real event dates, payments, timeline
-- ==========================================================================
-- Used by the admin Orders tab (js/admin-orders*.js) and the public order
-- forms (js/app.js submitOrder()). Run it AFTER supabase-setup.sql: it needs
-- public.orders, public.is_admin() and public.blocked_dates from there.
--
-- How to run: Supabase Dashboard -> SQL Editor -> New query -> paste this
-- whole file -> Run. Safe to re-run (if not exists / drop ... if exists /
-- create or replace everywhere). Purely additive: no column, row or policy
-- that already exists is removed.
--
-- Until this has been run, nothing breaks:
--   - the public checkout / custom-order forms notice the new columns are
--     missing and resend the order the old way;
--   - the admin Orders tab shows a notice and hides payment / timeline
--     tools, and keeps using the old free-text event_date.
--
-- What this adds:
--   1. New columns on public.orders (items, total_amount, event_on,
--      event_time, fulfillment, payment_status, deposit_amount,
--      amount_paid, source) and the 'quoted' status.
--   2. A conservative backfill of event_on / event_time / total_amount /
--      fulfillment from the old free-text columns.
--   3. An insert guard so a logged-out shopper can't pre-mark an order as
--      paid (same idea as orders_reset_admin_fields in supabase-setup.sql).
--   4. public.order_events — the per-order timeline (status and payment
--      changes are logged automatically by a trigger; the admin page adds
--      "message sent" entries).
--   5. Indexes for the paged / filtered Orders list and the calendar.
--   6. Adds orders to Supabase Realtime so new orders appear live.

-- 1. Columns --------------------------------------------------------------

-- Cart lines as sent by the checkout: each is the cart line as-is plus the
-- normalized keys {product_id, name, qty, unit_price, line_total, variant?,
-- addons?: [{name, price}], image_url?}. '[]' for custom orders and for
-- every order placed before this existed.
alter table public.orders add column if not exists items jsonb not null default '[]'::jsonb;
-- Numeric total. The old `total` text column ('$120', 'Budget: ...') is
-- kept and still written, for anything that reads it.
alter table public.orders add column if not exists total_amount numeric(10,2);
-- The real event date. The old free-text event_date is kept and still
-- written too (fully_booked_dates() in supabase-setup.sql reads it).
alter table public.orders add column if not exists event_on date;
-- Delivery / set-up time or window, free text ('14:00', '2-4pm').
alter table public.orders add column if not exists event_time text default '';
alter table public.orders add column if not exists fulfillment text default 'delivery';
-- Admin-only payment tracking (reset on public inserts, see step 3).
alter table public.orders add column if not exists payment_status text not null default 'unpaid';
alter table public.orders add column if not exists deposit_amount numeric(10,2);
alter table public.orders add column if not exists amount_paid numeric(10,2) not null default 0;
-- Where the customer came from ('instagram', 'google', 'direct', ...),
-- captured by js/order-source.js when they land on the site.
alter table public.orders add column if not exists source text default '';

-- Same "not valid" convention as the Data integrity section of
-- supabase-setup.sql: enforced on every new insert/update, existing rows
-- aren't re-checked (so one odd legacy row can't abort this script).
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('new', 'contacted', 'quoted', 'fulfilled', 'cancelled')) not valid;

alter table public.orders drop constraint if exists orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check
  check (payment_status in ('unpaid', 'deposit_paid', 'paid', 'refunded')) not valid;

alter table public.orders drop constraint if exists orders_fulfillment_check;
alter table public.orders add constraint orders_fulfillment_check
  check (fulfillment is null or fulfillment in ('delivery', 'pickup')) not valid;

alter table public.orders drop constraint if exists orders_amounts_check;
alter table public.orders add constraint orders_amounts_check
  check (amount_paid >= 0
         and (deposit_amount is null or deposit_amount >= 0)
         and (total_amount is null or total_amount >= 0)) not valid;

alter table public.orders drop constraint if exists orders_items_array_check;
alter table public.orders add constraint orders_items_array_check
  check (pg_catalog.jsonb_typeof(items) = 'array') not valid;

-- 2. Backfill -------------------------------------------------------------

-- 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM' (what checkout / custom orders have
-- always written) -> date. Anything else, including impossible dates like
-- 2026-02-30, -> null. Never throws.
create or replace function public.orders_parse_event_date(raw text)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := pg_catalog.btrim(coalesce(raw, ''));
begin
  if v !~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])([ T][0-9]{1,2}:[0-9]{2})?$' then
    return null;
  end if;
  -- make_date() raises on 2026-02-30 instead of rolling over like to_date().
  return pg_catalog.make_date(substr(v, 1, 4)::integer, substr(v, 6, 2)::integer, substr(v, 9, 2)::integer);
exception when others then
  return null;
end;
$$;

-- '$120', '$1,200', '120.50' -> 120.00 / 1200.00 / 120.50. Anything with
-- words in it ('Budget: around 300', 'TBD') -> null. Never throws.
create or replace function public.orders_parse_amount(raw text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := pg_catalog.btrim(coalesce(raw, ''));
  n numeric;
begin
  if v !~ '^[$£€]?\s*[0-9]{1,3}(,?[0-9]{3})*(\.[0-9]{1,2})?$' then
    return null;
  end if;
  n := pg_catalog.regexp_replace(v, '[^0-9.]', '', 'g')::numeric;
  if n < 0 or n >= 100000000 then
    return null;
  end if;
  return pg_catalog.round(n, 2);
exception when others then
  return null;
end;
$$;

update public.orders
   set event_on = public.orders_parse_event_date(event_date)
 where event_on is null
   and public.orders_parse_event_date(event_date) is not null;

-- Custom orders stored the time as 'YYYY-MM-DD HH:MM'.
update public.orders
   set event_time = pg_catalog.btrim(substr(pg_catalog.btrim(event_date), 12))
 where coalesce(event_time, '') = ''
   and pg_catalog.btrim(coalesce(event_date, '')) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{1,2}:[0-9]{2}$';

-- Only checkout totals: a custom order's `total` is the customer's budget,
-- not a price.
update public.orders
   set total_amount = public.orders_parse_amount(total)
 where total_amount is null
   and kind = 'checkout'
   and public.orders_parse_amount(total) is not null;

-- Custom orders wrote "Service option: Pick-up" into notes.
update public.orders
   set fulfillment = 'pickup'
 where kind = 'custom'
   and coalesce(fulfillment, 'delivery') = 'delivery'
   and coalesce(notes, '') like 'Service option: Pick-up%';

-- 3. Insert guard ---------------------------------------------------------

-- Anyone can insert an order, and the insert policy can't restrict
-- individual columns. For every insert that isn't the admin this:
--   - resets the admin-only payment fields (payment_status, amount_paid,
--     deposit_amount), like orders_reset_admin_fields does for status and
--     admin_notes;
--   - keeps the new customer-supplied fields sane (items must be a list of
--     at most 100 lines / ~50 KB; event_time and source are trimmed to a
--     sensible length; an unknown fulfillment becomes 'delivery'; an
--     impossible total becomes null).
-- For everyone (admin included) it fills event_on from event_date when the
-- caller didn't send one, so orders from an older cached copy of the site
-- still land on the calendar.
--
-- This is a separate trigger rather than an edit of
-- orders_reset_admin_fields() so that re-running supabase-setup.sql (which
-- recreates that function) can never silently drop these protections.
-- Raises 'order_field_too_long' (22001), which js/app.js already turns into
-- a friendly message. security definer + empty search_path, same hardening
-- as the other order triggers.
create or replace function public.orders_v2_insert_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not coalesce(public.is_admin(), false) then
    new.payment_status := 'unpaid';
    new.amount_paid := 0;
    new.deposit_amount := null;

    if new.items is null or pg_catalog.jsonb_typeof(new.items) <> 'array' then
      new.items := '[]'::jsonb;
    end if;
    if pg_catalog.jsonb_array_length(new.items) > 100
       or pg_catalog.octet_length(new.items::text) > 50000 then
      raise exception 'order_field_too_long'
        using errcode = '22001',
              hint = 'The order has more items than the site allows.';
    end if;

    new.event_time := pg_catalog.left(coalesce(new.event_time, ''), 100);
    new.source := pg_catalog.left(coalesce(new.source, ''), 100);
    if new.fulfillment is null or new.fulfillment not in ('delivery', 'pickup') then
      new.fulfillment := 'delivery';
    end if;
    if new.total_amount is not null and (new.total_amount < 0 or new.total_amount > 1000000) then
      new.total_amount := null;
    end if;
  end if;

  if new.event_on is null then
    new.event_on := public.orders_parse_event_date(new.event_date);
  end if;
  return new;
end;
$$;

revoke all on function public.orders_v2_insert_guard() from public;

drop trigger if exists orders_v2_insert_guard on public.orders;
create trigger orders_v2_insert_guard
  before insert on public.orders
  for each row
  execute function public.orders_v2_insert_guard();

-- 4. Timeline (order_events) ----------------------------------------------

-- One row per thing that happened to an order. kind is one of:
--   'status'   status changed      (from_value -> to_value), by trigger
--   'payment'  payment_status changed                      , by trigger
--   'amount_paid' amount_paid changed                      , by trigger
--   'message'  the admin sent a templated message: to_value is the
--              template (quote/confirmation/reminder/thankyou), from_value
--              the channel (whatsapp/email/copy), note the first part of
--              the text — written by js/admin-orders-messages.js
--   'note'     anything else the admin page wants to record
-- Admin-only: customers can't read or write it.
create table if not exists public.order_events (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.orders (id) on delete cascade,
  created_at timestamptz not null default now(),
  actor_email text default '',
  kind text not null default 'note',
  from_value text default '',
  to_value text default '',
  note text default ''
);

create index if not exists order_events_order_time_idx
  on public.order_events (order_id, created_at);

alter table public.order_events enable row level security;

drop policy if exists "Admin can manage order events" on public.order_events;
create policy "Admin can manage order events"
  on public.order_events for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

alter table public.order_events drop constraint if exists order_events_lengths_check;
alter table public.order_events add constraint order_events_lengths_check
  check (pg_catalog.char_length(kind) <= 40
         and pg_catalog.char_length(coalesce(from_value, '')) <= 200
         and pg_catalog.char_length(coalesce(to_value, '')) <= 200
         and pg_catalog.char_length(coalesce(note, '')) <= 2000) not valid;

-- Logs status / payment changes made by anyone (admin page, SQL editor,
-- scripts). actor_email is the logged-in user's email from the request's
-- JWT, or 'system' when there isn't one (e.g. a change in the SQL editor).
create or replace function public.orders_log_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor text;
begin
  v_actor := coalesce(nullif(auth.jwt() ->> 'email', ''), 'system');

  if new.status is distinct from old.status then
    insert into public.order_events (order_id, actor_email, kind, from_value, to_value)
    values (new.id, v_actor, 'status', coalesce(old.status, ''), coalesce(new.status, ''));
  end if;

  if new.payment_status is distinct from old.payment_status then
    insert into public.order_events (order_id, actor_email, kind, from_value, to_value)
    values (new.id, v_actor, 'payment', coalesce(old.payment_status, ''), coalesce(new.payment_status, ''));
  end if;

  if new.amount_paid is distinct from old.amount_paid then
    insert into public.order_events (order_id, actor_email, kind, from_value, to_value)
    values (new.id, v_actor, 'amount_paid', coalesce(old.amount_paid::text, ''), coalesce(new.amount_paid::text, ''));
  end if;

  return new;
exception when others then
  -- The timeline is a nice-to-have: never let it block saving the order.
  return new;
end;
$$;

revoke all on function public.orders_log_changes() from public;

drop trigger if exists orders_log_changes on public.orders;
create trigger orders_log_changes
  after update on public.orders
  for each row
  execute function public.orders_log_changes();

-- 5. Indexes --------------------------------------------------------------

create index if not exists orders_status_idx on public.orders (status);
create index if not exists orders_event_on_idx on public.orders (event_on);
create index if not exists orders_created_at_idx on public.orders (created_at);
create index if not exists orders_payment_status_idx on public.orders (payment_status);

-- 6. Realtime -------------------------------------------------------------

-- Lets the admin Orders tab show new orders without a reload. Realtime
-- still applies the orders RLS policies, so only the admin receives them.
-- Skipped quietly when the project has no supabase_realtime publication
-- or orders is already in it.
do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_catalog.pg_publication_tables
                      where pubname = 'supabase_realtime'
                        and schemaname = 'public' and tablename = 'orders') then
    alter publication supabase_realtime add table public.orders;
  end if;
end;
$$;
