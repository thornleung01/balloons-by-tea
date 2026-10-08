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
alter table orders add constraint orders_status_check check (status in ('new', 'contacted', 'fulfilled')) not valid;

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

revoke all on function public.fully_booked_dates(date, date) from public;
grant execute on function public.fully_booked_dates(date, date) to anon, authenticated;

-- ==========================================================================
-- Delivery areas (postal codes we deliver to)
-- ==========================================================================
-- (filled in by the delivery-area feature)
