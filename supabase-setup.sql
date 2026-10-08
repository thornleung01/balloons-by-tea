-- Aura Balloon Co. — Supabase one-time setup
--
-- Run this once in your Supabase project: Dashboard -> SQL Editor -> New query
-- -> paste this whole file -> Run. Safe to re-run (uses "if not exists" /
-- drops policies before recreating them).
--
-- What this does:
--   1. Creates a `products` table (one row per balloon item).
--   2. Turns on Row Level Security so the rules below are actually enforced.
--   3. Lets anyone READ products (so the public site can show them).
--   4. Lets only a LOGGED-IN user (you, via the admin page) WRITE products.
--   5. Creates a public image bucket for product photos with the same
--      read-everyone / write-only-if-logged-in rule.

create table if not exists products (
  id bigint generated always as identity primary key,
  collection text not null,
  name text not null,
  price numeric not null default 0,
  description text default '',
  style text,
  image_url text,
  images text[] default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Safe to re-run against a project created before this column existed.
alter table products add column if not exists images text[] default '{}';

alter table products enable row level security;

drop policy if exists "Public can read products" on products;
create policy "Public can read products"
  on products for select
  to anon, authenticated
  using (true);

drop policy if exists "Authenticated can manage products" on products;
create policy "Authenticated can manage products"
  on products for all
  to authenticated
  using (true)
  with check (true);

-- Storage bucket for product photos
insert into storage.buckets (id, name, public)
  values ('product-photos', 'product-photos', true)
  on conflict (id) do nothing;

drop policy if exists "Public can view product photos" on storage.objects;
create policy "Public can view product photos"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'product-photos');

drop policy if exists "Authenticated can upload product photos" on storage.objects;
create policy "Authenticated can upload product photos"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'product-photos');

drop policy if exists "Authenticated can update product photos" on storage.objects;
create policy "Authenticated can update product photos"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'product-photos');

drop policy if exists "Authenticated can delete product photos" on storage.objects;
create policy "Authenticated can delete product photos"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'product-photos');

-- Orders table — one row per checkout or custom-order submission.
-- Anyone (including logged-out shoppers) can INSERT an order, since that's
-- how the public site submits one. Nobody but a logged-in admin can read,
-- update, or delete them, so customer contact details stay private.

create table if not exists orders (
  id bigint generated always as identity primary key,
  kind text not null default 'checkout',
  name text not null default '',
  phone text not null default '',
  email text not null default '',
  address text default '',
  event_date text default '',
  notes text default '',
  summary text default '',
  total text default '',
  status text not null default 'new',
  created_at timestamptz not null default now()
);

alter table orders enable row level security;

drop policy if exists "Anyone can submit an order" on orders;
create policy "Anyone can submit an order"
  on orders for insert
  to anon, authenticated
  with check (true);

drop policy if exists "Authenticated can manage orders" on orders;
create policy "Authenticated can manage orders"
  on orders for select
  to authenticated
  using (true);

drop policy if exists "Authenticated can update orders" on orders;
create policy "Authenticated can update orders"
  on orders for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "Authenticated can delete orders" on orders;
create policy "Authenticated can delete orders"
  on orders for delete
  to authenticated
  using (true);

-- Site content tables — hero text, about page copy, contact info, social
-- links, theme colors, nav links, shop categories, and FAQ, all editable
-- from admin.html instead of hardcoded in HTML/CSS. Same public-read /
-- authenticated-write pattern as products, since this is public content
-- (unlike orders).

create table if not exists site_settings (
  key text primary key,
  value text
);

alter table site_settings enable row level security;

drop policy if exists "Public can read settings" on site_settings;
create policy "Public can read settings"
  on site_settings for select
  to anon, authenticated
  using (true);

drop policy if exists "Authenticated can manage settings" on site_settings;
create policy "Authenticated can manage settings"
  on site_settings for all
  to authenticated
  using (true)
  with check (true);

create table if not exists collections (
  id bigint generated always as identity primary key,
  slug text not null unique,
  title text not null,
  tagline text default '',
  card_image_url text,
  is_legacy boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

alter table collections enable row level security;

drop policy if exists "Public can read collections" on collections;
create policy "Public can read collections"
  on collections for select
  to anon, authenticated
  using (true);

drop policy if exists "Authenticated can manage collections" on collections;
create policy "Authenticated can manage collections"
  on collections for all
  to authenticated
  using (true)
  with check (true);

create table if not exists nav_items (
  id bigint generated always as identity primary key,
  key text,
  label text not null,
  href text not null,
  icon text not null default 'none',
  sort_order int not null default 0,
  visible boolean not null default true,
  created_at timestamptz not null default now()
);

alter table nav_items enable row level security;

drop policy if exists "Public can read nav items" on nav_items;
create policy "Public can read nav items"
  on nav_items for select
  to anon, authenticated
  using (true);

drop policy if exists "Authenticated can manage nav items" on nav_items;
create policy "Authenticated can manage nav items"
  on nav_items for all
  to authenticated
  using (true)
  with check (true);

create table if not exists faq_items (
  id bigint generated always as identity primary key,
  question text not null,
  answer text not null,
  sort_order int not null default 0,
  is_open_default boolean not null default false,
  created_at timestamptz not null default now()
);

alter table faq_items enable row level security;

drop policy if exists "Public can read faq items" on faq_items;
create policy "Public can read faq items"
  on faq_items for select
  to anon, authenticated
  using (true);

drop policy if exists "Authenticated can manage faq items" on faq_items;
create policy "Authenticated can manage faq items"
  on faq_items for all
  to authenticated
  using (true)
  with check (true);

-- Layout overrides — live visual edit-mode on the public pages. One row
-- per (page, element, property) tweak: section spacing, text size,
-- product-card scale, hidden/locked flags. Public can read (the override
-- has to apply for every visitor, not just the logged-in admin); only a
-- logged-in user can write.

create table if not exists layout_overrides (
  id bigint generated always as identity primary key,
  page text not null,
  element_key text not null,
  property text not null,
  value text,
  updated_at timestamptz not null default now(),
  unique (page, element_key, property)
);

alter table layout_overrides enable row level security;

drop policy if exists "Public can read layout overrides" on layout_overrides;
create policy "Public can read layout overrides"
  on layout_overrides for select
  to anon, authenticated
  using (true);

drop policy if exists "Authenticated can manage layout overrides" on layout_overrides;
create policy "Authenticated can manage layout overrides"
  on layout_overrides for all
  to authenticated
  using (true)
  with check (true);

-- Change history for layout_overrides, so an edit-mode change can be
-- reverted. Admin-only (not public) since this is an internal audit
-- trail, not content a visitor needs.

create table if not exists layout_overrides_history (
  id bigint generated always as identity primary key,
  page text not null,
  element_key text not null,
  property text not null,
  old_value text,
  new_value text,
  changed_at timestamptz not null default now()
);

alter table layout_overrides_history enable row level security;

drop policy if exists "Authenticated can read layout history" on layout_overrides_history;
create policy "Authenticated can read layout history"
  on layout_overrides_history for select
  to authenticated
  using (true);

drop policy if exists "Authenticated can write layout history" on layout_overrides_history;
create policy "Authenticated can write layout history"
  on layout_overrides_history for insert
  to authenticated
  with check (true);

-- Analytics events — lightweight funnel/friction tracking (page views,
-- cart/checkout funnel steps, form validation errors, abandonment).
-- Anyone (including logged-out visitors) can INSERT an event, since
-- that's how the public site records its own behavior; nobody but a
-- logged-in admin can read or delete them. Append-only from the public
-- side (no update policy), same spirit as layout_overrides_history.

create table if not exists analytics_events (
  id bigint generated always as identity primary key,
  session_id text not null,
  event_name text not null,
  page text not null default '',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

alter table analytics_events enable row level security;

drop policy if exists "Anyone can log an analytics event" on analytics_events;
create policy "Anyone can log an analytics event"
  on analytics_events for insert
  to anon, authenticated
  with check (true);

drop policy if exists "Authenticated can read analytics events" on analytics_events;
create policy "Authenticated can read analytics events"
  on analytics_events for select
  to authenticated
  using (true);

drop policy if exists "Authenticated can delete analytics events" on analytics_events;
create policy "Authenticated can delete analytics events"
  on analytics_events for delete
  to authenticated
  using (true);

create index if not exists analytics_events_name_time_idx
  on analytics_events (event_name, created_at desc);
create index if not exists analytics_events_session_idx
  on analytics_events (session_id);

-- Storage bucket for site images (logo, hero image, collection card photos)
insert into storage.buckets (id, name, public)
  values ('site-images', 'site-images', true)
  on conflict (id) do nothing;

drop policy if exists "Public can view site images" on storage.objects;
create policy "Public can view site images"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'site-images');

drop policy if exists "Authenticated can upload site images" on storage.objects;
create policy "Authenticated can upload site images"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'site-images');

drop policy if exists "Authenticated can update site images" on storage.objects;
create policy "Authenticated can update site images"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'site-images');

drop policy if exists "Authenticated can delete site images" on storage.objects;
create policy "Authenticated can delete site images"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'site-images');

-- Hardening pass — tie "admin write" policies to the one real admin
-- account, and add DB-level CHECK constraints as a backstop behind the
-- client-side validation in js/admin.js / js/app.js.
--
-- 1. Every policy above that grants write access `to authenticated
--    using (true)` trusts ANY logged-in Supabase auth user, not
--    specifically this site's one real admin account
--    (amandatea02@outlook.com — the only account admin.html's login
--    form ever signs in via signInWithPassword; there is no sign-up
--    flow anywhere in this codebase). If self-signup were ever enabled
--    on this project (unconfirmed either way), a stranger's own account
--    would otherwise pass every one of those checks. The policies below
--    re-declare those same policy names (drop-then-recreate, same
--    mechanism this whole file already relies on) with is_admin() added
--    to their condition, so re-running this file replaces the looser
--    version with the tightened one. Public read policies and the two
--    logged-out-submission policies (orders insert, analytics_events
--    insert) are untouched on purpose — those must stay open to anon.
-- 2. CHECK constraints below are defense-in-depth: RLS controls WHO can
--    write, not WHAT they write. These mirror validation already
--    enforced client-side (required-field checks in js/admin.js,
--    <input type="number" min="0"> on price, min="0" now added to the
--    sort-order fields alongside this migration) so a UI bypass or bug
--    can't insert garbage. Only fields the app always treats as
--    required/non-negative are constrained; optional fields
--    (description, style, notes, tagline, images shape, etc.) are left
--    alone since '' / null / '{}' are legitimate values for them
--    throughout the codebase. Every constraint is added `not valid` —
--    this still enforces on every INSERT/UPDATE from the moment it's
--    added, but skips checking rows that already exist. Without it, a
--    single pre-existing row that happens to violate a brand-new
--    constraint (e.g. a sort_order that went negative before the
--    matching UI fix shipped) would abort this entire script partway
--    through, leaving the policy hardening above only half-applied on
--    whatever ran before the failure. Once you're confident no legacy
--    row violates a given constraint, `alter table X validate
--    constraint constraint_name;` retroactively checks existing rows
--    too — optional, not required for the constraint to work going
--    forward.

-- Ties every "admin-only" RLS policy to this one specific account instead
-- of trusting any authenticated Supabase user — closes a gap where, if
-- self-signup were ever enabled on this project (unconfirmed either way),
-- a stranger's own account would otherwise pass every `to authenticated`
-- check below. To add/change which account counts as admin later, this
-- function is the only place that needs editing.
-- lower()'d on both sides so a stored auth.users email with different
-- casing than this literal (possible if the account was ever touched via
-- the Supabase Dashboard rather than only through the app's own
-- signInWithPassword flow) doesn't silently fail every policy check.
-- set search_path = '' follows Supabase's own hardening guidance for
-- functions referenced inside RLS policies; auth.email() is already
-- schema-qualified so this changes nothing about how the function runs.
create or replace function is_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  select lower(auth.email()) = lower('amandatea02@outlook.com');
$$;

-- Products — tighten the one "manage" (all) policy.
drop policy if exists "Authenticated can manage products" on products;
create policy "Authenticated can manage products"
  on products for all
  to authenticated
  using (is_admin())
  with check (is_admin());

-- Storage: product-photos bucket — tighten upload/update/delete (public
-- read policy is left untouched).
drop policy if exists "Authenticated can upload product photos" on storage.objects;
create policy "Authenticated can upload product photos"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'product-photos' and is_admin());

drop policy if exists "Authenticated can update product photos" on storage.objects;
create policy "Authenticated can update product photos"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'product-photos' and is_admin());

drop policy if exists "Authenticated can delete product photos" on storage.objects;
create policy "Authenticated can delete product photos"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'product-photos' and is_admin());

-- Orders — tighten select/update/delete. The public insert policy
-- ("Anyone can submit an order") stays open to anon + authenticated,
-- since that's how checkout works for logged-out customers.
drop policy if exists "Authenticated can manage orders" on orders;
create policy "Authenticated can manage orders"
  on orders for select
  to authenticated
  using (is_admin());

drop policy if exists "Authenticated can update orders" on orders;
create policy "Authenticated can update orders"
  on orders for update
  to authenticated
  using (is_admin())
  with check (is_admin());

drop policy if exists "Authenticated can delete orders" on orders;
create policy "Authenticated can delete orders"
  on orders for delete
  to authenticated
  using (is_admin());

-- Site settings — tighten the one "manage" (all) policy.
drop policy if exists "Authenticated can manage settings" on site_settings;
create policy "Authenticated can manage settings"
  on site_settings for all
  to authenticated
  using (is_admin())
  with check (is_admin());

-- Collections — tighten the one "manage" (all) policy.
drop policy if exists "Authenticated can manage collections" on collections;
create policy "Authenticated can manage collections"
  on collections for all
  to authenticated
  using (is_admin())
  with check (is_admin());

-- Nav items — tighten the one "manage" (all) policy.
drop policy if exists "Authenticated can manage nav items" on nav_items;
create policy "Authenticated can manage nav items"
  on nav_items for all
  to authenticated
  using (is_admin())
  with check (is_admin());

-- FAQ items — tighten the one "manage" (all) policy.
drop policy if exists "Authenticated can manage faq items" on faq_items;
create policy "Authenticated can manage faq items"
  on faq_items for all
  to authenticated
  using (is_admin())
  with check (is_admin());

-- Layout overrides — tighten the one "manage" (all) policy.
drop policy if exists "Authenticated can manage layout overrides" on layout_overrides;
create policy "Authenticated can manage layout overrides"
  on layout_overrides for all
  to authenticated
  using (is_admin())
  with check (is_admin());

-- Layout overrides history — tighten both policies. The table's own
-- original comment already describes it as "admin-only, not public", so
-- its read policy gets the same tightening as its write policy for
-- consistency, even though it was already `to authenticated` rather than
-- `to anon, authenticated` (i.e. a logged-out visitor could never read it
-- either way — this closes the "any OTHER authenticated account" gap).
drop policy if exists "Authenticated can read layout history" on layout_overrides_history;
create policy "Authenticated can read layout history"
  on layout_overrides_history for select
  to authenticated
  using (is_admin());

drop policy if exists "Authenticated can write layout history" on layout_overrides_history;
create policy "Authenticated can write layout history"
  on layout_overrides_history for insert
  to authenticated
  with check (is_admin());

-- Analytics events — tighten select/delete. The public insert policy
-- ("Anyone can log an analytics event") stays open to anon +
-- authenticated, since that's how the public site records its own
-- behavior for logged-out visitors.
drop policy if exists "Authenticated can read analytics events" on analytics_events;
create policy "Authenticated can read analytics events"
  on analytics_events for select
  to authenticated
  using (is_admin());

drop policy if exists "Authenticated can delete analytics events" on analytics_events;
create policy "Authenticated can delete analytics events"
  on analytics_events for delete
  to authenticated
  using (is_admin());

-- Storage: site-images bucket — tighten upload/update/delete (public
-- read policy is left untouched).
drop policy if exists "Authenticated can upload site images" on storage.objects;
create policy "Authenticated can upload site images"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'site-images' and is_admin());

drop policy if exists "Authenticated can update site images" on storage.objects;
create policy "Authenticated can update site images"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'site-images' and is_admin());

drop policy if exists "Authenticated can delete site images" on storage.objects;
create policy "Authenticated can delete site images"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'site-images' and is_admin());

-- CHECK constraints — data-integrity backstops behind client-side
-- validation. Named explicitly so re-running this file is safe
-- (drop-if-exists before add, same spirit as the policy blocks above).

-- products: js/admin.js's handleSaveItem() requires a non-blank name
-- before it will even attempt a save; admin.html's price field is
-- <input type="number" min="0" step="0.01" required>. description,
-- style, image_url and images are legitimately optional/empty
-- ('', null, '{}') throughout the codebase, so left unconstrained.
alter table products drop constraint if exists products_price_check;
alter table products add constraint products_price_check check (price >= 0) not valid;
alter table products drop constraint if exists products_name_check;
alter table products add constraint products_name_check check (trim(name) <> '') not valid;

-- collections: handleSaveCollection() requires a non-blank title; slug
-- is always derived from title via slugify(), which falls back to
-- "category" rather than ever producing '' or null. sort_order is only
-- ever set to 0 or a non-negative index by this app's code (initial
-- default 0, drag-reorder writes 0..n-1).
alter table collections drop constraint if exists collections_title_check;
alter table collections add constraint collections_title_check check (trim(title) <> '') not valid;
alter table collections drop constraint if exists collections_slug_check;
alter table collections add constraint collections_slug_check check (trim(slug) <> '') not valid;
alter table collections drop constraint if exists collections_sort_order_check;
alter table collections add constraint collections_sort_order_check check (sort_order >= 0) not valid;

-- nav_items: handleSaveNav() requires both label and href to be
-- non-blank before saving. sort_order is only ever 0 or a non-negative
-- drag-reorder index, same as collections.
alter table nav_items drop constraint if exists nav_items_label_check;
alter table nav_items add constraint nav_items_label_check check (trim(label) <> '') not valid;
alter table nav_items drop constraint if exists nav_items_href_check;
alter table nav_items add constraint nav_items_href_check check (trim(href) <> '') not valid;
alter table nav_items drop constraint if exists nav_items_sort_order_check;
alter table nav_items add constraint nav_items_sort_order_check check (sort_order >= 0) not valid;

-- faq_items: handleSaveFaq() requires both question and answer to be
-- non-blank before saving. sort_order is only ever 0 or a non-negative
-- drag-reorder index, same as collections/nav_items.
alter table faq_items drop constraint if exists faq_items_question_check;
alter table faq_items add constraint faq_items_question_check check (trim(question) <> '') not valid;
alter table faq_items drop constraint if exists faq_items_answer_check;
alter table faq_items add constraint faq_items_answer_check check (trim(answer) <> '') not valid;
alter table faq_items drop constraint if exists faq_items_sort_order_check;
alter table faq_items add constraint faq_items_sort_order_check check (sort_order >= 0) not valid;

-- orders: every insert/update in js/app.js and js/admin.js uses exactly
-- one of these two `kind` values and exactly one of ORDER_STATUSES
-- (js/admin.js) for `status` — nothing else is ever written. name,
-- phone, email, address, notes etc. are intentionally left
-- unconstrained since the public order form doesn't require all of
-- them for every order type (e.g. a custom-order inquiry may omit
-- fields a checkout always fills).
alter table orders drop constraint if exists orders_kind_check;
alter table orders add constraint orders_kind_check check (kind in ('checkout', 'custom')) not valid;
alter table orders drop constraint if exists orders_status_check;
alter table orders add constraint orders_status_check check (status in ('new', 'contacted', 'fulfilled', 'cancelled')) not valid;

-- analytics_events: trackEvent() (js/analytics.js) always passes a
-- non-empty string literal event_name and a session_id that's either a
-- real UUID or the literal "unknown" fallback — never blank.
alter table analytics_events drop constraint if exists analytics_events_event_name_check;
alter table analytics_events add constraint analytics_events_event_name_check check (trim(event_name) <> '') not valid;
alter table analytics_events drop constraint if exists analytics_events_session_id_check;
alter table analytics_events add constraint analytics_events_session_id_check check (trim(session_id) <> '') not valid;

-- ==========================================================================
-- Event-date availability (blocked / fully booked dates)
-- ==========================================================================
-- Used by js/availability.js (customer date fields) and
-- js/admin-availability.js (admin "Delivery" tab). Until this section has
-- been run, the site simply treats every future date as available.

-- Dates the owner has closed by hand (vacation, already fully booked
-- off-site, etc.). One row per day; a range is just several rows.
-- The public can read this table so the order forms can grey dates out.
-- Note that `reason` is therefore readable by anyone too — keep it to
-- short labels like "Fully booked" or "Vacation", nothing private.
create table if not exists blocked_dates (
  day date primary key,
  reason text not null default '',
  created_at timestamptz not null default now()
);

alter table blocked_dates enable row level security;

drop policy if exists "Public can read blocked dates" on blocked_dates;
create policy "Public can read blocked dates"
  on blocked_dates for select
  to anon, authenticated
  using (true);

drop policy if exists "Admin can manage blocked dates" on blocked_dates;
create policy "Admin can manage blocked dates"
  on blocked_dates for all
  to authenticated
  using (is_admin())
  with check (is_admin());

alter table blocked_dates drop constraint if exists blocked_dates_reason_length_check;
alter table blocked_dates add constraint blocked_dates_reason_length_check check (char_length(reason) <= 200) not valid;

-- Daily capacity. The limit itself is a site_settings row
-- (key 'max_orders_per_day', value a whole number; blank / missing / 0
-- means "no limit"), edited from the admin Delivery tab.
--
-- Customers can't read the orders table (RLS), so this function runs as
-- its owner (security definer) and returns ONLY the dates in the asked-for
-- range that are at or over the limit — never any order data, counts, or
-- names. search_path is empty and every name is schema-qualified so a
-- caller can't redirect it to look-alike tables.
--
-- orders.event_date is free text ('YYYY-MM-DD' from checkout,
-- 'YYYY-MM-DD HH:MM' from custom orders). Only values whose first 10
-- characters are a real calendar date count; anything else (blank,
-- legacy text, '2026-02-30') is ignored. The date is built with
-- make_date() from range-checked parts (day-of-month added as an offset,
-- which can't overflow) and then compared back to the original text, so a
-- bad value can never make a cast throw and break the whole lookup.
-- The range is capped at 400 days to keep the query cheap.
create or replace function public.fully_booked_dates(from_day date, to_day date)
returns table (day date)
language sql
stable
security definer
set search_path = ''
as $$
  with cap as (
    select case
             when trim(s.value) ~ '^[0-9]{1,6}$' then trim(s.value)::integer
             else 0
           end as max_per_day
    from public.site_settings s
    where s.key = 'max_orders_per_day'
  ),
  order_days as (
    -- The integer casts sit inside CASE so they only ever run on values
    -- that already matched the pattern (a plain WHERE gives no such
    -- ordering guarantee once the planner pushes filters around).
    select case
             when o.event_date ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])'
             then pg_catalog.make_date(substr(o.event_date, 1, 4)::integer,
                                       substr(o.event_date, 6, 2)::integer, 1)
                  + (substr(o.event_date, 9, 2)::integer - 1)
           end as day,
           substr(o.event_date, 1, 10) as raw
    from public.orders o
    -- Only rows whose text falls in the requested window, so a call reads
    -- a handful of orders (via orders_event_date_idx below) instead of
    -- scanning and regex-matching the whole table. 'YYYY-MM-DD...' sorts as
    -- text in date order, so this is exact; the checks above still decide
    -- validity. Plain text comparison — no casts that could throw.
    where o.event_date >= pg_catalog.to_char(from_day, 'YYYY-MM-DD')
      and o.event_date <  pg_catalog.to_char(to_day + 1, 'YYYY-MM-DD')
  )
  select od.day
  from order_days od, cap
  where cap.max_per_day > 0
    and od.day is not null
    and pg_catalog.to_char(od.day, 'YYYY-MM-DD') = od.raw   -- drops 2026-02-30 etc.
    and od.day between from_day and to_day
    and to_day - from_day between 0 and 400
  group by od.day, cap.max_per_day
  having count(*) >= cap.max_per_day
  order by od.day;
$$;

-- Supports the date-window filter in fully_booked_dates() above.
create index if not exists orders_event_date_idx on public.orders (event_date);

revoke all on function public.fully_booked_dates(date, date) from public;
grant execute on function public.fully_booked_dates(date, date) to anon, authenticated;

-- ==========================================================================
-- Delivery areas (postal codes we deliver to)
-- ==========================================================================
-- One row per Forward Sortation Area — the first 3 characters of a
-- Canadian postal code (letter-digit-letter, e.g. "M5V"), stored
-- uppercase. Managed from the admin "Delivery" tab (js/admin-delivery-areas.js);
-- checked at checkout / custom-order delivery (js/delivery-area.js).
-- While this table is EMPTY the check is off and every address is
-- accepted — add your first area to switch it on.
create table if not exists delivery_areas (
  fsa text primary key,
  label text not null default '',
  created_at timestamptz not null default now()
);

alter table delivery_areas enable row level security;

drop policy if exists "Public can read delivery areas" on delivery_areas;
create policy "Public can read delivery areas"
  on delivery_areas for select
  to anon, authenticated
  using (true);

drop policy if exists "Admins can manage delivery areas" on delivery_areas;
create policy "Admins can manage delivery areas"
  on delivery_areas for all
  to authenticated
  using (is_admin())
  with check (is_admin());

alter table delivery_areas drop constraint if exists delivery_areas_fsa_check;
alter table delivery_areas add constraint delivery_areas_fsa_check check (fsa ~ '^[A-Z][0-9][A-Z]$') not valid;

-- ==========================================================================
-- Orders tools: private admin notes, "cancelled" status, insert hardening
-- ==========================================================================
-- Used by the admin Orders tab (js/admin.js). Safe to re-run. Until this
-- has been run the Orders tab still works; only saving a private note and
-- setting an order to Cancelled fail, with a message pointing here.

-- Private per-order notes, only ever shown in the admin panel. Customers
-- can't read orders at all (RLS), so this never reaches the public site.
alter table public.orders add column if not exists admin_notes text not null default '';

-- 'cancelled' is allowed by orders_status_check in the "Data integrity"
-- section above.

-- Anyone can insert an order (the public checkout/custom-order forms run
-- as anon), and the insert policy can't restrict individual columns, so a
-- hand-crafted request could arrive pre-marked "fulfilled" or with text
-- planted in admin_notes. This trigger resets both to their defaults on
-- every insert that isn't made by the admin. security definer + empty
-- search_path + schema-qualified names, same hardening as
-- fully_booked_dates() in supabase-setup.sql.
create or replace function public.orders_reset_admin_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not coalesce(public.is_admin(), false) then
    new.admin_notes := '';
    new.status := 'new';
  end if;
  return new;
end;
$$;

revoke all on function public.orders_reset_admin_fields() from public;

drop trigger if exists orders_reset_admin_fields on public.orders;
create trigger orders_reset_admin_fields
  before insert on public.orders
  for each row
  execute function public.orders_reset_admin_fields();

-- ==========================================================================
-- Analytics summary (server-side aggregation for the admin Analytics tab)
-- ==========================================================================
-- The Analytics tab used to download every raw analytics_events row and
-- count them in the browser. PostgREST caps a response at 1000 rows by
-- default, so once a range held more events than that the numbers quietly
-- stopped growing. This function does the counting in Postgres and returns
-- one small jsonb object with everything the tab shows.
--
-- js/admin.js (computeAnalyticsSummary) still has a browser-side version
-- of the exact same rules, used only until this function exists. The two
-- MUST stay in sync — change one, change the other:
--   * window: from_ts <= created_at < to_ts (null from_ts = the beginning
--     of time, null to_ts = no upper bound);
--   * sessions_by_event: DISTINCT session_ids per event_name (funnel steps);
--     events_by_event: raw row count per event_name;
--   * a metadata value counts only if it's a non-empty string, a number or
--     a boolean (anything else — missing, null, '', object, array — is
--     treated as absent);
--   * field-error breakdowns key on metadata.field, absent -> 'unknown';
--   * abandon_fields counts every usable element of metadata.filledFields
--     (only when it's an array) across all checkout_abandoned rows;
--   * top_products groups add_to_cart rows by metadata.productId, falling
--     back to metadata.name, then 'Unknown product'; name/collection shown
--     come from that product's newest row (created_at, then id);
--   * every list is sorted by count desc, then key in plain code-point
--     order (collate "C"), so ties come out the same on both sides.
--
-- Runs as its owner (security definer) so it can read the table in one
-- pass, which is why it checks is_admin() itself and refuses everyone
-- else. Only `authenticated` may execute it at all; anon and public can't.
create or replace function public.analytics_summary(from_ts timestamptz, to_ts timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'analytics_summary: admin only' using errcode = '42501';
  end if;

  with ev as (
    select e.id, e.session_id, e.event_name, e.metadata, e.created_at
    from public.analytics_events e
    where e.created_at >= coalesce(from_ts, '-infinity'::timestamptz)
      and (to_ts is null or e.created_at < to_ts)
  ),
  by_event as (
    select ev.event_name,
           pg_catalog.count(*) as row_count,
           pg_catalog.count(distinct ev.session_id) as session_count
    from ev
    group by ev.event_name
  ),
  field_errors as (
    select ev.event_name,
           coalesce(case when pg_catalog.jsonb_typeof(ev.metadata -> 'field') in ('string', 'number', 'boolean')
                         then nullif(ev.metadata ->> 'field', '') end,
                    'unknown') as field
    from ev
    where ev.event_name in ('checkout_field_error', 'custom_order_field_error')
  ),
  field_error_counts as (
    select fe.event_name, fe.field, pg_catalog.count(*) as n
    from field_errors fe
    group by fe.event_name, fe.field
  ),
  abandon_fields as (
    select nullif(f.value #>> '{}', '') as field
    from ev
    cross join lateral pg_catalog.jsonb_array_elements(
      case when pg_catalog.jsonb_typeof(ev.metadata -> 'filledFields') = 'array'
           then ev.metadata -> 'filledFields'
           else '[]'::jsonb end
    ) as f(value)
    where ev.event_name = 'checkout_abandoned'
      and pg_catalog.jsonb_typeof(f.value) in ('string', 'number', 'boolean')
  ),
  abandon_field_counts as (
    select af.field, pg_catalog.count(*) as n
    from abandon_fields af
    where af.field is not null
    group by af.field
  ),
  adds as (
    select ev.id, ev.created_at,
           case when pg_catalog.jsonb_typeof(ev.metadata -> 'productId') in ('string', 'number', 'boolean')
                then nullif(ev.metadata ->> 'productId', '') end as product_id,
           case when pg_catalog.jsonb_typeof(ev.metadata -> 'name') in ('string', 'number', 'boolean')
                then nullif(ev.metadata ->> 'name', '') end as name,
           case when pg_catalog.jsonb_typeof(ev.metadata -> 'collection') in ('string', 'number', 'boolean')
                then nullif(ev.metadata ->> 'collection', '') end as collection
    from ev
    where ev.event_name = 'add_to_cart'
  ),
  products as (
    select coalesce(a.product_id, a.name, 'Unknown product') as product_key,
           pg_catalog.count(*) as n,
           (pg_catalog.array_agg(a.name order by a.created_at desc, a.id desc))[1] as name,
           (pg_catalog.array_agg(a.collection order by a.created_at desc, a.id desc))[1] as collection
    from adds a
    group by 1
  ),
  top_products as (
    select p.*
    from products p
    order by p.n desc, p.product_key collate "C"
    limit 8
  )
  select pg_catalog.jsonb_build_object(
    'total_events', (select coalesce(pg_catalog.sum(b.row_count), 0) from by_event b),
    'events_by_event', coalesce((select pg_catalog.jsonb_object_agg(b.event_name, b.row_count) from by_event b), '{}'::jsonb),
    'sessions_by_event', coalesce((select pg_catalog.jsonb_object_agg(b.event_name, b.session_count) from by_event b), '{}'::jsonb),
    'checkout_field_errors', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('field', c.field, 'count', c.n)
                                  order by c.n desc, c.field collate "C")
      from field_error_counts c where c.event_name = 'checkout_field_error'), '[]'::jsonb),
    'custom_field_errors', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('field', c.field, 'count', c.n)
                                  order by c.n desc, c.field collate "C")
      from field_error_counts c where c.event_name = 'custom_order_field_error'), '[]'::jsonb),
    'abandon_fields', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('field', c.field, 'count', c.n)
                                  order by c.n desc, c.field collate "C")
      from abandon_field_counts c), '[]'::jsonb),
    'top_products', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('key', t.product_key, 'name', t.name,
                                                                'collection', t.collection, 'count', t.n)
                                  order by t.n desc, t.product_key collate "C")
      from top_products t), '[]'::jsonb),
    'product_count', (select pg_catalog.count(*) from products)
  )
  into result;

  return result;
end;
$$;

-- Supports the created_at window above and the browser-side fallback's
-- paged (created_at desc, id desc) reads.
create index if not exists analytics_events_created_at_idx
  on public.analytics_events (created_at desc, id desc);

revoke all on function public.analytics_summary(timestamptz, timestamptz) from public;
revoke all on function public.analytics_summary(timestamptz, timestamptz) from anon;
grant execute on function public.analytics_summary(timestamptz, timestamptz) to authenticated;

-- ==========================================================================
-- Spam limits on the two tables anyone can write to (orders,
-- analytics_events)
-- ==========================================================================
-- The anon key is public and both tables have a `with check (true)` anon
-- insert policy, so without this a script could flood them. RLS can't
-- count, so these BEFORE INSERT triggers do it instead. Safe to re-run
-- (create or replace / if not exists / drop trigger if exists), and must run
-- AFTER the main setup (it needs orders, analytics_events and is_admin()).
-- It only touches columns that supabase-setup.sql itself creates.
--
-- Who is limited: every insert that isn't from the admin (public.is_admin())
-- or a service_role key. The logged-in admin never trips a limit.
--
-- Limits (each is a constant in the function below; edit and re-run):
--   orders, per client IP ..... 5 per 10 minutes, 20 per day
--     A real customer places one order, maybe a retry or two after a typo.
--     5 in 10 minutes still leaves room for a few people on one shared
--     connection (office wifi, a mobile carrier's shared IP) ordering
--     together; 20 a day stops a slow drip from one source.
--   orders, everyone together .. 60 per hour
--     A circuit breaker for when the per-IP limit is bypassed (IP missing,
--     or a script rotating spoofed IPs, see the note on x-forwarded-for
--     below). A small balloon business doesn't get 60 genuine orders in an
--     hour, and the error tells customers to use WhatsApp meanwhile.
--   orders, field lengths ....... name/phone/email 200, address 500,
--     event_date 40, total 200, notes 8000, summary 10000 characters.
--     Generous next to anything the forms produce. total is 200, not 50,
--     because custom orders store "Budget: <whatever the customer typed>".
--     notes is 8000 because custom orders put the free-text "vision" there.
--     These live here, not in CHECK constraints, on purpose: a CHECK (even a
--     `not valid` one) is re-checked on every UPDATE, so the admin changing
--     the status of an old, over-long order would start failing. Here they
--     apply to new public inserts only.
--   analytics, per session_id ... 300 per hour (the shared "unknown"
--     fallback id is skipped; the IP limit still covers it)
--   analytics, per client IP .... 1000 per hour
--   analytics, everyone together  6000 per hour
--     A busy visit is a few dozen events. Over the limit, the event is
--     silently dropped (the trigger returns NULL): tracking must never
--     throw, and losing a flood's worth of events loses nothing real.
--   analytics, sizes ............ event_name 100, page 500 characters,
--     metadata 4 KB. Oversized events are dropped the same way.
--
-- Rejected orders raise a recognisable error that js/app.js turns into a
-- friendly message:
--   'rate_limited'          errcode P0001  (too many orders)
--   'order_field_too_long'  errcode 22001  (a field is over its cap)
--
-- Where the client IP comes from: Supabase's API passes request headers in
-- the `request.headers` setting; the first entry of x-forwarded-for is the
-- client. If it's missing or unreadable, only the global limits apply, and
-- nothing ever errors because of it. Caveat: a client can send its own
-- x-forwarded-for, so a determined script may be able to vary its IP;
-- that's what the global limits are for.
--
-- Privacy: no raw IP is stored anywhere. The IP is hashed (sha256 with a
-- random salt that exists only in this database) into
-- public.rate_limit_hits, a private table: RLS on, no policies, no grants
-- to anon/authenticated. Rows are pruned inside the trigger (analytics
-- rows after 1 hour, order rows after 1 day), so it stays small.

-- Private salt for hashing IPs, generated once on first run.
create table if not exists public.rate_limit_secret (
  id boolean primary key default true check (id),
  salt text not null default pg_catalog.gen_random_uuid()::text
);
insert into public.rate_limit_secret (id) values (true) on conflict (id) do nothing;

alter table public.rate_limit_secret enable row level security;
revoke all on public.rate_limit_secret from anon, authenticated;

-- One row per accepted public insert. client_key is the salted IP hash, or
-- null when the IP is unknown (those rows still count toward the global
-- limits).
create table if not exists public.rate_limit_hits (
  id bigint generated always as identity primary key,
  bucket text not null,
  client_key text,
  created_at timestamptz not null default now()
);

alter table public.rate_limit_hits enable row level security;
revoke all on public.rate_limit_hits from anon, authenticated;

create index if not exists rate_limit_hits_bucket_time_idx
  on public.rate_limit_hits (bucket, created_at);
create index if not exists rate_limit_hits_bucket_key_time_idx
  on public.rate_limit_hits (bucket, client_key, created_at);

-- Per-session counting for analytics.
create index if not exists analytics_events_session_time_idx
  on public.analytics_events (session_id, created_at);

-- True when the insert should skip every limit: the admin, or a
-- service_role key (server-side scripts). Never throws.
create or replace function public.rate_limit_exempt()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(public.is_admin(), false) then
    return true;
  end if;
  return coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::json->>'role',
    '') = 'service_role';
exception when others then
  return false;
end;
$$;

-- Salted hash of the caller's IP (first x-forwarded-for entry), or null if
-- there isn't one. Never throws: a missing or malformed header just means
-- "unknown IP".
create or replace function public.rate_limit_client_key()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  ip text;
  pepper text;
begin
  ip := nullif(pg_catalog.current_setting('request.headers', true), '')::json->>'x-forwarded-for';
  ip := pg_catalog.btrim(pg_catalog.split_part(coalesce(ip, ''), ',', 1));
  if ip = '' then
    return null;
  end if;
  select s.salt into pepper from public.rate_limit_secret s where s.id;
  return pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(coalesce(pepper, '') || '|' || pg_catalog.left(ip, 100), 'UTF8')),
    'hex');
exception when others then
  return null;
end;
$$;

revoke all on function public.rate_limit_exempt() from public, anon, authenticated;
revoke all on function public.rate_limit_client_key() from public, anon, authenticated;

-- orders ---------------------------------------------------------------------

create or replace function public.orders_spam_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  per_ip_10min constant integer := 5;
  per_ip_day   constant integer := 20;
  global_hour  constant integer := 60;
  v_key text;
begin
  if public.rate_limit_exempt() then
    return new;
  end if;

  if pg_catalog.char_length(coalesce(new.name, '')) > 200
     or pg_catalog.char_length(coalesce(new.phone, '')) > 200
     or pg_catalog.char_length(coalesce(new.email, '')) > 200
     or pg_catalog.char_length(coalesce(new.address, '')) > 500
     or pg_catalog.char_length(coalesce(new.event_date, '')) > 40
     or pg_catalog.char_length(coalesce(new.total, '')) > 200
     or pg_catalog.char_length(coalesce(new.notes, '')) > 8000
     or pg_catalog.char_length(coalesce(new.summary, '')) > 10000 then
    raise exception 'order_field_too_long'
      using errcode = '22001',
            hint = 'One of the order fields is longer than the site allows.';
  end if;

  -- Orders are rare, so serialising them is cheap and makes the counts
  -- exact even when a script fires requests in parallel.
  perform pg_catalog.pg_advisory_xact_lock(7240531, 1);

  delete from public.rate_limit_hits h
   where h.bucket = 'order' and h.created_at < now() - interval '1 day';

  if (select count(*) from public.rate_limit_hits h
       where h.bucket = 'order' and h.created_at > now() - interval '1 hour') >= global_hour then
    raise exception 'rate_limited'
      using errcode = 'P0001',
            hint = 'Too many orders site-wide in the last hour. Please try again later.';
  end if;

  v_key := public.rate_limit_client_key();
  if v_key is not null then
    if (select count(*) from public.rate_limit_hits h
         where h.bucket = 'order' and h.client_key = v_key
           and h.created_at > now() - interval '10 minutes') >= per_ip_10min
       or (select count(*) from public.rate_limit_hits h
         where h.bucket = 'order' and h.client_key = v_key
           and h.created_at > now() - interval '1 day') >= per_ip_day then
      raise exception 'rate_limited'
        using errcode = 'P0001',
              hint = 'Too many orders from this connection. Please wait a few minutes.';
    end if;
  end if;

  insert into public.rate_limit_hits (bucket, client_key) values ('order', v_key);
  return new;
end;
$$;

drop trigger if exists orders_spam_guard on public.orders;
create trigger orders_spam_guard
  before insert on public.orders
  for each row execute function public.orders_spam_guard();

-- analytics_events -----------------------------------------------------------

create or replace function public.analytics_events_spam_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  per_session_hour constant integer := 300;
  per_ip_hour      constant integer := 1000;
  global_hour      constant integer := 6000;
  v_key text;
begin
  if public.rate_limit_exempt() then
    return new;
  end if;

  -- Oversized events: drop silently.
  if pg_catalog.char_length(coalesce(new.event_name, '')) > 100
     or pg_catalog.char_length(coalesce(new.page, '')) > 500
     or pg_catalog.octet_length(coalesce(new.metadata, '{}'::jsonb)::text) > 4096 then
    return null;
  end if;

  delete from public.rate_limit_hits h
   where h.bucket = 'analytics' and h.created_at < now() - interval '1 hour';

  if (select count(*) from public.rate_limit_hits h
       where h.bucket = 'analytics' and h.created_at > now() - interval '1 hour') >= global_hour then
    return null;
  end if;

  if new.session_id is distinct from 'unknown'
     and (select count(*) from public.analytics_events e
           where e.session_id = new.session_id
             and e.created_at > now() - interval '1 hour') >= per_session_hour then
    return null;
  end if;

  v_key := public.rate_limit_client_key();
  if v_key is not null
     and (select count(*) from public.rate_limit_hits h
           where h.bucket = 'analytics' and h.client_key = v_key
             and h.created_at > now() - interval '1 hour') >= per_ip_hour then
    return null;
  end if;

  insert into public.rate_limit_hits (bucket, client_key) values ('analytics', v_key);
  return new;
exception when others then
  -- Never let tracking throw: on any unexpected error, keep the event.
  return new;
end;
$$;

drop trigger if exists analytics_events_spam_guard on public.analytics_events;
create trigger analytics_events_spam_guard
  before insert on public.analytics_events
  for each row execute function public.analytics_events_spam_guard();

-- ==========================================================================
-- Past events gallery (gallery.html, js/gallery.js, js/admin-gallery.js)
-- ==========================================================================
-- One row per photo on the public "Past events" wall. Managed from the
-- admin "Gallery" tab. Safe to re-run (if not exists / drop-then-create /
-- drop-constraint-then-add, same as supabase-setup.sql). Run it after
-- supabase-setup.sql: it needs products and is_admin() from there.
--
-- Until this has been run, gallery.html shows its friendly "photos coming
-- soon" state, the admin Gallery tab says to run the latest SQL, and the
-- Library's "is this photo used?" checks simply skip this table.

create table if not exists public.gallery_items (
  id bigint generated always as identity primary key,
  image_url text not null,
  caption text not null default '',
  occasion text not null default '',
  -- Optional "Order something like this" target. products.id is
  -- bigint identity (supabase-setup.sql). Deleting the product just
  -- unlinks the photo; it then falls back to the custom-order link.
  product_id bigint null references public.products(id) on delete set null,
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz default now()
);

alter table public.gallery_items enable row level security;

-- Visitors (and any logged-in non-admin) only ever see photos switched on.
drop policy if exists "Public can read active gallery items" on public.gallery_items;
create policy "Public can read active gallery items"
  on public.gallery_items for select
  to anon, authenticated
  using (active);

-- The admin can do everything, including reading hidden rows (policies are
-- OR'd together, so this select grant adds the inactive rows on top).
drop policy if exists "Admin can manage gallery items" on public.gallery_items;
create policy "Admin can manage gallery items"
  on public.gallery_items for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Defense-in-depth CHECKs mirroring the admin form's limits. `not valid`
-- for the same reason as the CHECKs in supabase-setup.sql: enforced on
-- every insert/update from now on without re-checking existing rows.
alter table public.gallery_items drop constraint if exists gallery_items_caption_length_check;
alter table public.gallery_items add constraint gallery_items_caption_length_check check (char_length(caption) <= 300) not valid;
alter table public.gallery_items drop constraint if exists gallery_items_occasion_length_check;
alter table public.gallery_items add constraint gallery_items_occasion_length_check check (char_length(occasion) <= 60) not valid;
alter table public.gallery_items drop constraint if exists gallery_items_image_url_check;
alter table public.gallery_items add constraint gallery_items_image_url_check check (trim(image_url) <> '') not valid;
alter table public.gallery_items drop constraint if exists gallery_items_sort_order_check;
alter table public.gallery_items add constraint gallery_items_sort_order_check check (sort_order >= 0) not valid;

-- The public page's only query: active rows ordered by sort_order.
create index if not exists gallery_items_active_sort_idx on public.gallery_items (active, sort_order);

-- ==========================================================================
-- Order photo uploads (custom-order "inspiration photos")
-- ==========================================================================
-- Lets a customer attach up to 3 photos to a custom order request
-- (custom-order.html, js/order-uploads.js) and lets the admin see them in
-- the Orders tab (js/admin.js). This is the first place where the public can
-- write files, so the rules are deliberately narrow.
--
-- Safe to re-run (on conflict / if not exists / create or replace / drop ...
-- if exists). Run it AFTER supabase-setup.sql: it needs public.orders,
-- public.is_admin() and the "Spam limits" helpers (public.rate_limit_hits,
-- public.rate_limit_client_key(), public.rate_limit_exempt()).
--
-- How an upload works:
--   1. When the customer submits the form, the browser makes up a random
--      folder id (crypto.randomUUID()) and calls
--      public.start_order_upload(folder). That function is rate limited per
--      client IP and site-wide, and records the folder (with the client's
--      salted IP hash) in public.order_upload_folders.
--   2. The browser uploads each resized photo to the PRIVATE bucket
--      'order-uploads' at pending/<folder>/<n>.<ext> (upsert off).
--      The storage.objects insert policy only allows that exact path shape,
--      for a folder registered in the last hour, at most 3 files per folder,
--      about 10 files per client per hour, and 200 files per hour site-wide.
--   3. The order is inserted with orders.attachments = the storage paths.
--      A trigger checks the paths (at most 3, right shape, one folder).
--
-- Why step 1 exists (instead of counting in the policy itself): Supabase's
-- Storage server checks the insert policy inside a transaction that it
-- ROLLS BACK (testPermission), then writes the real storage.objects row as
-- a superuser. Anything a policy function writes is rolled back, so a
-- policy can't record anything, only read. The per-client counting is
-- therefore recorded by the RPC, in its own committed transaction, and the
-- policy only reads committed rows (the registration and the objects that
-- were actually stored).
--
-- Who can do what in the 'order-uploads' bucket:
--   anon / authenticated  INSERT only, only under the rules above. No
--                         SELECT, UPDATE or DELETE: nobody can list,
--                         download, overwrite or remove a customer's photo.
--   the admin             SELECT (view, list, signed URLs) and DELETE.
-- The bucket itself caps each file at 2 MB and only accepts JPEG, PNG and
-- WebP. The browser resizes photos to fit long before that.

-- 1. The private bucket ----------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('order-uploads', 'order-uploads', false, 2097152,
          array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update
    set public = excluded.public,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

-- 2. orders.attachments -----------------------------------------------------

-- Storage paths of the photos attached to an order, e.g.
-- {pending/1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed/1.jpg}. Empty for orders
-- without photos (and for every order placed before this existed).
alter table public.orders add column if not exists attachments text[] not null default '{}';

-- 3. Upload folders (private) ---------------------------------------------

-- One row per upload folder a browser has asked for. client_key is the
-- salted IP hash from public.rate_limit_client_key() (null if unknown).
-- Private: RLS on, no policies, no grants. Rows older than a day are pruned
-- by start_order_upload(); only the last hour matters.
create table if not exists public.order_upload_folders (
  folder text primary key,
  client_key text,
  created_at timestamptz not null default now()
);

alter table public.order_upload_folders enable row level security;
revoke all on public.order_upload_folders from anon, authenticated;

create index if not exists order_upload_folders_key_time_idx
  on public.order_upload_folders (client_key, created_at);

-- Registers an upload folder for the caller. Called by the browser right
-- before uploading. Limits (constants below; edit and re-run):
--   per client IP ... 6 new folders per hour (one per order attempt)
--   site-wide ....... 100 new folders per hour
-- Calling it again for a folder that's already registered is a no-op and
-- doesn't count again (the customer pressing "Try again").
-- Raises 'rate_limited' (P0001) when over a limit, and
-- 'invalid_upload_folder' (22023) for anything that isn't a UUID.
create or replace function public.start_order_upload(folder uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  per_ip_hour constant integer := 6;
  global_hour constant integer := 100;
  v_folder text;
  v_key text;
begin
  if folder is null then
    raise exception 'invalid_upload_folder' using errcode = '22023';
  end if;
  -- uuid::text is always lowercase with dashes, the shape the storage
  -- policy and the orders trigger expect.
  v_folder := folder::text;

  if exists (select 1 from public.order_upload_folders f
              where f.folder = v_folder and f.created_at > now() - interval '1 hour') then
    return;
  end if;

  v_key := public.rate_limit_client_key();

  if not public.rate_limit_exempt() then
    perform pg_catalog.pg_advisory_xact_lock(7240531, 3);

    delete from public.rate_limit_hits h
     where h.bucket = 'upload' and h.created_at < now() - interval '1 hour';
    delete from public.order_upload_folders f
     where f.created_at < now() - interval '1 day';

    if (select count(*) from public.rate_limit_hits h
         where h.bucket = 'upload' and h.created_at > now() - interval '1 hour') >= global_hour then
      raise exception 'rate_limited'
        using errcode = 'P0001',
              hint = 'Too many photo uploads site-wide in the last hour. Please try again later.';
    end if;

    if v_key is not null
       and (select count(*) from public.rate_limit_hits h
             where h.bucket = 'upload' and h.client_key = v_key
               and h.created_at > now() - interval '1 hour') >= per_ip_hour then
      raise exception 'rate_limited'
        using errcode = 'P0001',
              hint = 'Too many photo uploads from this connection. Please wait a while.';
    end if;

    insert into public.rate_limit_hits (bucket, client_key) values ('upload', v_key);
  end if;

  insert into public.order_upload_folders (folder, client_key) values (v_folder, v_key)
    on conflict on constraint order_upload_folders_pkey
    do update set created_at = now(), client_key = excluded.client_key;
end;
$$;

revoke all on function public.start_order_upload(uuid) from public;
grant execute on function public.start_order_upload(uuid) to anon, authenticated;

-- The check behind the storage insert policy. Read-only on purpose (see
-- "Why step 1 exists" above). True only when:
--   - the path is exactly pending/<uuid>/<digit>.<jpg|jpeg|png|webp>;
--   - that folder was registered by start_order_upload() in the last hour;
--   - the folder holds fewer than 3 files;
--   - fewer than 10 files were stored in the last hour in folders
--     registered from the same client IP;
--   - fewer than 200 files were stored in the bucket in the last hour.
-- The admin (and service_role) always passes. Never throws: any error
-- means "no".
create or replace function public.order_upload_allowed(object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  per_folder   constant integer := 3;
  per_ip_hour  constant integer := 10;
  global_hour  constant integer := 200;
  v_folder text;
  v_key text;
begin
  if public.rate_limit_exempt() then
    return true;
  end if;

  if object_name is null
     or object_name !~ '^pending/[0-9a-f-]{36}/[0-9]\.(jpg|jpeg|png|webp)$' then
    return false;
  end if;
  v_folder := pg_catalog.split_part(object_name, '/', 2);

  select f.client_key into v_key
    from public.order_upload_folders f
   where f.folder = v_folder and f.created_at > now() - interval '1 hour';
  if not found then
    return false;
  end if;

  if (select count(*) from storage.objects o
       where o.bucket_id = 'order-uploads'
         and o.name like 'pending/' || v_folder || '/%') >= per_folder then
    return false;
  end if;

  if (select count(*) from storage.objects o
       where o.bucket_id = 'order-uploads'
         and o.created_at > now() - interval '1 hour') >= global_hour then
    return false;
  end if;

  if v_key is not null
     and (select count(*) from storage.objects o
           join public.order_upload_folders f
             on f.folder = pg_catalog.split_part(o.name, '/', 2)
          where o.bucket_id = 'order-uploads'
            and o.created_at > now() - interval '1 hour'
            and f.client_key = v_key) >= per_ip_hour then
    return false;
  end if;

  return true;
exception when others then
  return false;
end;
$$;

-- The policy runs as the uploader's role, so anon needs EXECUTE. Calling it
-- directly over the API only answers "would this path be accepted", and
-- writes nothing.
revoke all on function public.order_upload_allowed(text) from public;
grant execute on function public.order_upload_allowed(text) to anon, authenticated;

-- 4. Storage policies for the bucket ----------------------------------------

drop policy if exists "Public can upload order photos" on storage.objects;
create policy "Public can upload order photos"
  on storage.objects for insert
  to anon, authenticated
  with check (
    bucket_id = 'order-uploads'
    and name ~ '^pending/[0-9a-f-]{36}/[0-9]\.(jpg|jpeg|png|webp)$'
    and public.order_upload_allowed(name)
  );

drop policy if exists "Admin can view order photos" on storage.objects;
create policy "Admin can view order photos"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'order-uploads' and public.is_admin());

drop policy if exists "Admin can delete order photos" on storage.objects;
create policy "Admin can delete order photos"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'order-uploads' and public.is_admin());

-- No update policy: nobody (not even the admin, through the API) can
-- overwrite a photo, which is also why the browser uploads with upsert off.

-- 5. Check attachments on new orders ----------------------------------------

-- Anyone can insert an order, so a hand-made request could put anything in
-- attachments. For everyone but the admin this enforces: at most 3 paths,
-- each exactly pending/<uuid>/<digit>.<jpg|jpeg|png|webp>, all in the same
-- folder. Raises 'invalid_attachments' (22023) otherwise; js/app.js then
-- resends the order without photos so the customer is never blocked.
create or replace function public.orders_check_attachments()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_path text;
  v_folder text;
begin
  new.attachments := coalesce(new.attachments, '{}');

  if coalesce(public.is_admin(), false) then
    return new;
  end if;

  if pg_catalog.cardinality(new.attachments) = 0 then
    return new;
  end if;

  if pg_catalog.cardinality(new.attachments) > 3
     or pg_catalog.array_ndims(new.attachments) <> 1 then
    raise exception 'invalid_attachments'
      using errcode = '22023', hint = 'An order can have at most 3 photos.';
  end if;

  foreach v_path in array new.attachments loop
    if v_path is null
       or v_path !~ '^pending/[0-9a-f-]{36}/[0-9]\.(jpg|jpeg|png|webp)$' then
      raise exception 'invalid_attachments'
        using errcode = '22023', hint = 'An attachment path has the wrong shape.';
    end if;
    if v_folder is null then
      v_folder := pg_catalog.split_part(v_path, '/', 2);
    elsif pg_catalog.split_part(v_path, '/', 2) <> v_folder then
      raise exception 'invalid_attachments'
        using errcode = '22023', hint = 'All of an order''s photos must be in one folder.';
    end if;
  end loop;

  return new;
end;
$$;

revoke all on function public.orders_check_attachments() from public;

drop trigger if exists orders_check_attachments on public.orders;
create trigger orders_check_attachments
  before insert on public.orders
  for each row
  execute function public.orders_check_attachments();
