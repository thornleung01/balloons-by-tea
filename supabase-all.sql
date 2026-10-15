-- ==========================================================================
-- supabase-all.sql: complete, ordered installer for a NEW Supabase project
-- ==========================================================================
-- GENERATED FILE: do not edit. Rebuild with `node scripts/build-sql.js`
-- (`node scripts/build-sql.js --check` fails when this file is out of date).
--
-- Paste the whole file into Supabase Dashboard -> SQL Editor -> Run, once.
-- It is idempotent, so running it again later is safe: it will not undo
-- team roles / 2-step login, the soft-delete products policy or the
-- 'quoted' order status.
--
-- Contents, in this order (see docs/DATABASE.md):
--   1. supabase-setup.sql (base schema)
--   2. supabase-migrations/10-orders-v2.sql
--   3. supabase-migrations/20-notifications.sql
--   4. supabase-migrations/30-safety.sql
--   5. supabase-migrations/40-products.sql
--   6. supabase-migrations/50-analytics.sql
--   7. supabase-migrations/60-content.sql
-- ==========================================================================

-- ==========================================================================
-- PART 1 of 7: supabase-setup.sql (base schema)
-- (verbatim copy of supabase-setup.sql)
-- ==========================================================================

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

-- Re-run safety: supabase-migrations/40-products.sql replaces this policy
-- with one that hides trashed / not-yet-launched products (its condition
-- mentions deleted_at). If that version is already in place, leave it alone
-- so re-running this file cannot make trashed products public again.
do $guard$
begin
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'products'
      and policyname = 'Public can read products'
      and qual like '%deleted_at%'
  ) then
    drop policy if exists "Public can read products" on products;
    create policy "Public can read products"
      on products for select
      to anon, authenticated
      using (true);
  end if;
end
$guard$;

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
-- client-side validation in js/admin-*.js / js/app.js.
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
--    enforced client-side (required-field checks in js/admin-*.js,
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
-- Re-run safety: supabase-migrations/30-safety.sql redefines is_admin() to
-- honour team roles + 2-step login (it creates public.admin_role()). Once
-- that exists, re-running this file must NOT put the single-email version
-- back, so the original definition is only installed when admin_role() is
-- absent (a fresh project, or one that never ran 30-safety.sql).
do $guard$
begin
  if pg_catalog.to_regprocedure('public.admin_role()') is null then
    execute $fn$
create or replace function is_admin()
returns boolean
language sql
stable
set search_path = ''
as $body$
  select lower(auth.email()) = lower('amandatea02@outlook.com');
$body$
    $fn$;
  end if;
end
$guard$;

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

-- products: js/admin-products.js's handleSaveItem() requires a non-blank name
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

-- orders: every insert/update in js/app.js and js/admin-orders.js uses exactly
-- one of these two `kind` values and exactly one of ORDER_STATUSES
-- (js/admin-orders.js) for `status` — nothing else is ever written. name,
-- phone, email, address, notes etc. are intentionally left
-- unconstrained since the public order form doesn't require all of
-- them for every order type (e.g. a custom-order inquiry may omit
-- fields a checkout always fills).
alter table orders drop constraint if exists orders_kind_check;
alter table orders add constraint orders_kind_check check (kind in ('checkout', 'custom')) not valid;
-- Re-run safety: supabase-migrations/10-orders-v2.sql widens this check to
-- also allow 'quoted'. Keep that version if it is already in place.
do $guard$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_status_check'
      and pg_catalog.pg_get_constraintdef(oid) like '%quoted%'
  ) then
    alter table orders drop constraint if exists orders_status_check;
    alter table orders add constraint orders_status_check check (status in ('new', 'contacted', 'fulfilled', 'cancelled')) not valid;
  end if;
end
$guard$;

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
-- Used by the admin Orders tab (js/admin-orders.js). Safe to re-run. Until this
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
-- js/admin-analytics.js (computeAnalyticsSummary) still has a browser-side version
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
-- the Orders tab (js/admin-orders.js). This is the first place where the public can
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

-- ==========================================================================
-- PART 2 of 7: supabase-migrations/10-orders-v2.sql
-- (verbatim copy of supabase-migrations/10-orders-v2.sql)
-- ==========================================================================

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

-- ==========================================================================
-- PART 3 of 7: supabase-migrations/20-notifications.sql
-- (verbatim copy of supabase-migrations/20-notifications.sql)
-- ==========================================================================

-- ==========================================================================
-- New-order notifications (email / SMS) — database side
-- ==========================================================================
-- Run this in the Supabase SQL Editor AFTER supabase-setup.sql. Safe to
-- re-run (create ... if not exists / create or replace / drop trigger if
-- exists). Step-by-step owner instructions: docs/admin-notifications.md.
--
-- What it does: after a new row lands in public.orders, it asks Supabase to
-- call the `notify-new-order` Edge Function (which sends the emails/SMS).
--
-- How:
--   * pg_net (a Supabase extension) queues an HTTP POST. The request is only
--     actually sent after the order's transaction commits, and a rolled-back
--     insert never sends anything.
--   * The function's URL and the shared secret are kept in Supabase Vault
--     (encrypted), under the names 'notify_new_order_url' and
--     'notify_new_order_secret'. The easiest way to fill them in is the
--     "Notifications" card in admin.html → Settings (it calls
--     public.set_notify_config() below, which is admin-only). Or, from the
--     SQL Editor:
--        select vault.create_secret(
--          'https://<project-ref>.supabase.co/functions/v1/notify-new-order',
--          'notify_new_order_url');
--        select vault.create_secret(
--          '<the same value as the NOTIFY_WEBHOOK_SECRET function secret>',
--          'notify_new_order_secret');
--   * Until both are set, the trigger quietly does nothing.
--
-- Spam guard: orders_spam_guard (supabase-setup.sql) is a BEFORE INSERT
-- trigger that raises an error for rejected inserts, so a rejected order is
-- never inserted and this AFTER INSERT trigger never runs for it. Only
-- orders that survived the guard notify anyone.
--
-- Never blocks an order: every step is wrapped in an exception handler, so a
-- missing extension, an empty Vault or a pg_net error just means "no
-- notification" — the customer's order is always saved.
--
-- Alternative with no SQL at all: Supabase Dashboard → Database → Webhooks →
-- "Create a new hook" on table orders, event Insert, type "Supabase Edge
-- Functions" → notify-new-order, plus an HTTP header
-- `x-notify-secret: <your secret>`. Use EITHER that webhook OR this trigger,
-- not both, or you'll get every notification twice.

create extension if not exists pg_net;

-- --------------------------------------------------------------------------
-- Trigger function
-- --------------------------------------------------------------------------
create or replace function public.orders_notify_new_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  begin
    select ds.decrypted_secret into v_url
      from vault.decrypted_secrets ds
     where ds.name = 'notify_new_order_url'
     limit 1;
    select ds.decrypted_secret into v_secret
      from vault.decrypted_secrets ds
     where ds.name = 'notify_new_order_secret'
     limit 1;

    if coalesce(v_url, '') = '' or coalesce(v_secret, '') = '' then
      return new;  -- not configured yet: nothing to do
    end if;

    perform net.http_post(
      url := v_url,
      body := pg_catalog.jsonb_build_object(
        'type', 'INSERT',
        'table', 'orders',
        'schema', 'public',
        'record', pg_catalog.to_jsonb(new)
      ),
      headers := pg_catalog.jsonb_build_object(
        'Content-Type', 'application/json',
        'x-notify-secret', v_secret
      ),
      timeout_milliseconds := 10000
    );
  exception when others then
    -- Never fail the customer's order because a notification couldn't be
    -- queued. The warning shows up in the Postgres logs.
    raise warning 'orders_notify_new_order: notification not queued: %', sqlerrm;
  end;
  return new;
end;
$$;

revoke all on function public.orders_notify_new_order() from public, anon, authenticated;

drop trigger if exists orders_notify_new_order on public.orders;
create trigger orders_notify_new_order
  after insert on public.orders
  for each row execute function public.orders_notify_new_order();

-- --------------------------------------------------------------------------
-- Admin helpers used by the "Notifications" card in admin.html
-- --------------------------------------------------------------------------

-- Saves (creates or replaces) the function URL and shared secret in Vault.
-- Admin only. Pass null/'' for p_secret to keep the current secret and only
-- change the URL. Returns a short status text instead of raising, so the
-- admin card can show what happened.
create or replace function public.set_notify_config(p_url text, p_secret text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  if coalesce(p_url, '') !~ '^https://[^\s]+$' then
    return 'error: the function URL must start with https://';
  end if;
  if p_secret is not null and p_secret <> '' and pg_catalog.char_length(p_secret) < 16 then
    return 'error: the secret must be at least 16 characters';
  end if;

  begin
    select s.id into v_id from vault.secrets s where s.name = 'notify_new_order_url' limit 1;
    if v_id is null then
      perform vault.create_secret(p_url, 'notify_new_order_url', 'notify-new-order Edge Function URL');
    else
      perform vault.update_secret(v_id, p_url, 'notify_new_order_url', 'notify-new-order Edge Function URL');
    end if;

    if p_secret is not null and p_secret <> '' then
      v_id := null;
      select s.id into v_id from vault.secrets s where s.name = 'notify_new_order_secret' limit 1;
      if v_id is null then
        perform vault.create_secret(p_secret, 'notify_new_order_secret', 'x-notify-secret header for notify-new-order');
      else
        perform vault.update_secret(v_id, p_secret, 'notify_new_order_secret', 'x-notify-secret header for notify-new-order');
      end if;
    end if;
  exception when others then
    return 'error: could not save to Vault (' || sqlerrm || ')';
  end;
  return 'ok';
end;
$$;

-- What's set up on the database side, for the admin card. Never returns
-- secret values, only true/false. Admin only.
create or replace function public.notify_setup_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pg_net boolean := false;
  v_trigger boolean := false;
  v_vault boolean := false;
  v_url text := null;
  v_secret boolean := false;
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  select exists (select 1 from pg_catalog.pg_extension e where e.extname = 'pg_net') into v_pg_net;
  select exists (
    select 1 from pg_catalog.pg_trigger t
     where t.tgname = 'orders_notify_new_order'
       and t.tgrelid = 'public.orders'::regclass
       and not t.tgisinternal
  ) into v_trigger;

  begin
    select ds.decrypted_secret into v_url
      from vault.decrypted_secrets ds where ds.name = 'notify_new_order_url' limit 1;
    select exists (
      select 1 from vault.decrypted_secrets ds
       where ds.name = 'notify_new_order_secret' and coalesce(ds.decrypted_secret, '') <> ''
    ) into v_secret;
    v_vault := true;
  exception when others then
    v_vault := false;
  end;

  return pg_catalog.jsonb_build_object(
    'pg_net', v_pg_net,
    'trigger', v_trigger,
    'vault', v_vault,
    'url', v_url,
    'secret_set', v_secret
  );
end;
$$;

revoke all on function public.set_notify_config(text, text) from public, anon;
revoke all on function public.notify_setup_status() from public, anon;
grant execute on function public.set_notify_config(text, text) to authenticated;
grant execute on function public.notify_setup_status() to authenticated;

-- ==========================================================================
-- PART 4 of 7: supabase-migrations/30-safety.sql
-- (verbatim copy of supabase-migrations/30-safety.sql)
-- ==========================================================================

-- ==========================================================================
-- 30-safety.sql — Safety & access: team roles, 2-step login (MFA) support,
-- activity (audit) log, and restore-from-backup.
-- ==========================================================================
-- Run this in Supabase: Dashboard -> SQL Editor -> New query -> paste this
-- whole file -> Run. Run it AFTER supabase-setup.sql. Safe to re-run (if not
-- exists / create or replace / drop ... if exists, same as
-- supabase-setup.sql). It only ADDS things; it never drops a table or a
-- column, and it never edits a row of your shop data.
--
-- Until this has been run the admin page keeps working exactly as before;
-- only the new Activity tab, Team card, restore button and 2-step-login
-- enforcement say "run supabase-migrations/30-safety.sql first".
--
-- What it does (owner-friendly guide: docs/admin-safety.md):
--   1. public.admin_users: who may use admin.html and as what:
--        'owner' = everything (exactly what "the admin" could do before),
--        'staff' = read orders/products, update orders (status, notes,
--                  payment), nothing else: no deletes, no settings/nav/
--                  categories/products edits, no activity log.
--      The original admin account (amandatea02@outlook.com, the one
--      supabase-setup.sql's is_admin() checks) stays an owner FOREVER, with
--      zero manual steps, even if its admin_users row is missing.
--   2. public.admin_role()        -> 'owner' | 'staff' | null
--      public.is_admin()          -> true only for owners (every existing
--                                    policy keeps meaning "owner")
--      public.is_staff_or_admin() -> true for owners and staff
--      All three also honour 2-step login: an account that has switched on
--      an authenticator app only counts once it has entered its 6-digit code
--      in this login session (JWT claim aal = 'aal2'). Accounts without 2-step
--      login are unaffected.
--   3. Staff policies on orders (read + update) and order photos (view).
--   4. public.audit_log + a trigger on every admin-managed table, readable
--      only by owners; audit_log_prune(keep_days) for retention.
--   5. public.admin_restore_rows(...) used by "Restore from backup" and by
--      "Undo" in the Activity tab. Owner only, allowlisted tables only.
--   6. Team management RPCs: admin_team_list(), admin_set_team_role(...).
--
-- Every function here is security definer with an empty search_path and
-- schema-qualified names, same hardening as supabase-setup.sql.

-- --------------------------------------------------------------------------
-- 1. Team table
-- --------------------------------------------------------------------------

-- The one account supabase-setup.sql hard-codes as admin. Kept in exactly
-- one place here; admin_role() treats it as an owner no matter what.
create or replace function public.admin_builtin_owner_email()
returns text
language sql
immutable
set search_path = ''
as $$
  select lower('amandatea02@outlook.com');
$$;

-- Only the security definer functions below call it.
revoke all on function public.admin_builtin_owner_email() from public, anon, authenticated;

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null default '',
  display_name text not null default '',
  role text not null default 'staff',
  created_at timestamptz not null default now(),
  added_by uuid
);

alter table public.admin_users add column if not exists display_name text not null default '';
alter table public.admin_users add column if not exists added_by uuid;

alter table public.admin_users drop constraint if exists admin_users_role_check;
alter table public.admin_users add constraint admin_users_role_check check (role in ('owner', 'staff')) not valid;

alter table public.admin_users enable row level security;

-- Writes only ever go through admin_set_team_role() below.
revoke insert, update, delete, truncate on public.admin_users from anon, authenticated;

-- The existing admin becomes an explicit owner row too (harmless if the
-- account doesn't exist yet: the email check in admin_role() still covers
-- it the moment it's created).
insert into public.admin_users (user_id, email, role)
select u.id, lower(u.email), 'owner'
from auth.users u
where lower(u.email) = public.admin_builtin_owner_email()
on conflict (user_id) do nothing;

-- --------------------------------------------------------------------------
-- 2. 2-step login check, roles, is_admin()
-- --------------------------------------------------------------------------

-- True when this request's login is "complete": either the account has no
-- verified authenticator (2-step login off), or this session entered its
-- code (aal2). Supabase's own documented pattern for enforcing MFA in RLS.
--
-- auth.mfa_factors normally exists and is readable by the SQL editor's
-- role. If it isn't (a very old project, or a locked-down auth schema), the
-- check would throw on EVERY policy, so this block tests it first and falls
-- back to "no extra requirement" (exactly today's behaviour) with a notice.
do $outer$
begin
  begin
    perform 1 from auth.mfa_factors limit 1;
    execute $create$
      create or replace function public.admin_mfa_satisfied()
      returns boolean
      language sql
      stable
      security definer
      set search_path = ''
      as $fn$
        select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
            or not exists (
              select 1 from auth.mfa_factors f
              where f.user_id = auth.uid() and f.status = 'verified'
            );
      $fn$;
    $create$;
  exception when others then
    execute $create$
      create or replace function public.admin_mfa_satisfied()
      returns boolean
      language sql
      stable
      security definer
      set search_path = ''
      as $fn$
        select true;
      $fn$;
    $create$;
    raise notice '30-safety: auth.mfa_factors is not readable here, so 2-step login is offered in the admin page but not enforced by the database.';
  end;
end
$outer$;

revoke all on function public.admin_mfa_satisfied() from public, anon, authenticated;

-- 'owner' | 'staff' | null for the logged-in caller.
create or replace function public.admin_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when auth.uid() is null then null
    when not public.admin_mfa_satisfied() then null
    when lower(coalesce(auth.email(), '')) = public.admin_builtin_owner_email() then 'owner'
    else (select a.role from public.admin_users a where a.user_id = auth.uid())
  end;
$$;

revoke all on function public.admin_role() from public;
grant execute on function public.admin_role() to anon, authenticated;

-- Same name, same signature, same meaning ("the full admin") as
-- supabase-setup.sql, so every existing policy, trigger and RPC keeps
-- working unchanged. Previously:
--   select lower(auth.email()) = lower('amandatea02@outlook.com');
-- That account is still an owner (see admin_role()); additional owners can
-- now be added from the Team card. Never returns null.
create or replace function public.is_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(public.admin_role() = 'owner', false);
$$;

grant execute on function public.is_admin() to anon, authenticated;

create or replace function public.is_staff_or_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(public.admin_role() in ('owner', 'staff'), false);
$$;

revoke all on function public.is_staff_or_admin() from public;
grant execute on function public.is_staff_or_admin() to anon, authenticated;

-- Team rows: owners see everyone; anyone on the team sees their own row.
drop policy if exists "Owners can read the team" on public.admin_users;
create policy "Owners can read the team"
  on public.admin_users for select
  to authenticated
  using (public.is_admin() or user_id = auth.uid());

-- --------------------------------------------------------------------------
-- 3. Staff access
-- --------------------------------------------------------------------------
-- Policies are OR'd, so these ADD staff on top of the existing owner-only
-- ones from supabase-setup.sql ("Authenticated can manage/update orders").
-- No staff delete policy anywhere: the owner-only delete policy stays the
-- only one. Which order COLUMNS staff may change is left to the orders
-- triggers (js/admin-orders.js / the Orders migration).

drop policy if exists "Staff can read orders" on public.orders;
create policy "Staff can read orders"
  on public.orders for select
  to authenticated
  using (public.is_staff_or_admin());

drop policy if exists "Staff can update orders" on public.orders;
create policy "Staff can update orders"
  on public.orders for update
  to authenticated
  using (public.is_staff_or_admin())
  with check (public.is_staff_or_admin());

-- Customer inspiration photos on orders (private bucket from
-- supabase-setup.sql). View only.
drop policy if exists "Staff can view order photos" on storage.objects;
create policy "Staff can view order photos"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'order-uploads' and public.is_staff_or_admin());

-- --------------------------------------------------------------------------
-- 4. Team management (Settings -> Team card)
-- --------------------------------------------------------------------------

-- Everyone with admin access, plus the built-in owner. Owner only.
create or replace function public.admin_team_list()
returns table (
  user_id uuid,
  email text,
  display_name text,
  role text,
  added_at timestamptz,
  last_sign_in_at timestamptz,
  builtin boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_builtin text := public.admin_builtin_owner_email();
begin
  if not public.is_admin() then
    raise exception 'admin_team_list: owner only' using errcode = '42501';
  end if;
  return query
    select u.id,
           lower(u.email)::text,
           coalesce(a.display_name, '')::text,
           (case when lower(u.email) = v_builtin then 'owner' else a.role end)::text,
           coalesce(a.created_at, u.created_at),
           u.last_sign_in_at,
           lower(u.email) = v_builtin
    from auth.users u
    left join public.admin_users a on a.user_id = u.id
    where a.user_id is not null or lower(u.email) = v_builtin
    order by (case when lower(u.email) = v_builtin then 0 when a.role = 'owner' then 1 else 2 end),
             lower(u.email);
end;
$$;

revoke all on function public.admin_team_list() from public, anon;
grant execute on function public.admin_team_list() to authenticated;

-- Gives an EXISTING Supabase login (created in Dashboard -> Authentication)
-- a role, or removes it (new_role = 'none'). Owner only.
-- Errors (errcode / message):
--   42501 'owner only'      caller isn't an owner
--   22023 'invalid_role'    new_role isn't owner / staff / none
--   P0002 'no_such_user'    no login with that email exists yet
--   42501 'builtin_owner'   the original admin account can't be demoted
--   42501 'last_owner'      the change would leave nobody as owner
create or replace function public.admin_set_team_role(member_email text, new_role text, member_name text default null)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_builtin text := public.admin_builtin_owner_email();
  v_user uuid;
  v_email text;
  v_owners integer;
begin
  if not public.is_admin() then
    raise exception 'owner only' using errcode = '42501';
  end if;
  if new_role is null or new_role not in ('owner', 'staff', 'none') then
    raise exception 'invalid_role' using errcode = '22023';
  end if;

  -- Two owners editing the team at once can't both remove each other.
  perform pg_catalog.pg_advisory_xact_lock(7240531, 30);

  select u.id, lower(u.email) into v_user, v_email
  from auth.users u
  where lower(u.email) = lower(pg_catalog.btrim(coalesce(member_email, '')))
  order by u.created_at
  limit 1;

  if v_user is null then
    raise exception 'no_such_user'
      using errcode = 'P0002',
            hint = 'Create the login first: Supabase Dashboard -> Authentication -> Users -> Add user (or Invite user).';
  end if;

  if v_email = v_builtin and new_role <> 'owner' then
    raise exception 'builtin_owner'
      using errcode = '42501',
            hint = 'The original admin account is always an owner.';
  end if;

  if new_role = 'none' then
    delete from public.admin_users a where a.user_id = v_user;
  else
    insert into public.admin_users as au (user_id, email, display_name, role, added_by)
    values (v_user, v_email, coalesce(pg_catalog.left(pg_catalog.btrim(member_name), 60), ''), new_role, auth.uid())
    on conflict (user_id) do update
      set role = excluded.role,
          email = excluded.email,
          display_name = case
            when member_name is null then au.display_name
            else excluded.display_name
          end;
  end if;

  select count(*) into v_owners
  from (
    select a.user_id from public.admin_users a where a.role = 'owner'
    union
    select u.id from auth.users u where lower(u.email) = v_builtin
  ) s;
  if v_owners = 0 then
    -- Raising rolls the change above back.
    raise exception 'last_owner'
      using errcode = '42501',
            hint = 'Someone has to stay an owner.';
  end if;

  return new_role;
end;
$$;

revoke all on function public.admin_set_team_role(text, text, text) from public, anon;
grant execute on function public.admin_set_team_role(text, text, text) to authenticated;

-- --------------------------------------------------------------------------
-- 5. Activity (audit) log
-- --------------------------------------------------------------------------
-- One row per insert / update / delete on an admin-managed table.
--   changed: update -> {"column": [old, new], ...} (changed columns only)
--            delete -> the whole old row
--            insert -> the whole new row
--   row_label: a readable name for the row (product name, category title,
--              FAQ question, customer name on an order, ...) so the
--              Activity tab can say what was changed even when the name
--              itself didn't change.
--   note: 'restore' / 'undo' when the change came from those tools.
-- Owners can read it. Nobody can write to it through the API: only the
-- trigger (security definer) inserts, only audit_log_prune() deletes.

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  actor_id uuid,
  actor_email text,
  table_name text not null,
  row_id text,
  row_label text,
  action text not null,
  changed jsonb not null default '{}'::jsonb,
  note text
);

alter table public.audit_log add column if not exists row_label text;
alter table public.audit_log add column if not exists note text;

alter table public.audit_log drop constraint if exists audit_log_action_check;
alter table public.audit_log add constraint audit_log_action_check check (action in ('insert', 'update', 'delete')) not valid;

create index if not exists audit_log_created_idx on public.audit_log (created_at desc, id desc);
create index if not exists audit_log_table_created_idx on public.audit_log (table_name, created_at desc);
create index if not exists audit_log_actor_created_idx on public.audit_log (actor_id, created_at desc);

alter table public.audit_log enable row level security;
revoke insert, update, delete, truncate on public.audit_log from anon, authenticated;

drop policy if exists "Owners can read the activity log" on public.audit_log;
create policy "Owners can read the activity log"
  on public.audit_log for select
  to authenticated
  using (public.is_admin());

-- The trigger. TG_ARGV[0] is the table's key column (id / key / day / fsa).
-- Skips changes with no logged-in user (public order form, anonymous
-- requests) EXCEPT deletes, which are always worth knowing about. Skips
-- updates where nothing but updated_at changed. Never blocks the real
-- write: if logging fails for any reason the change still goes through and
-- a warning lands in the Postgres log.
create or replace function public.audit_log_capture()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := coalesce(TG_ARGV[0], 'id');
  v_ignore constant text[] := array['updated_at'];
  v_actor uuid;
  v_email text;
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_changed jsonb := '{}'::jsonb;
  k text;
begin
  begin
    v_actor := auth.uid();
    v_email := auth.email();
  exception when others then
    v_actor := null;
    v_email := null;
  end;

  if v_actor is null and TG_OP <> 'DELETE' then
    return null;
  end if;

  if TG_OP = 'INSERT' then
    v_new := pg_catalog.to_jsonb(new);
    v_row := v_new;
    v_changed := v_new;
  elsif TG_OP = 'DELETE' then
    v_old := pg_catalog.to_jsonb(old);
    v_row := v_old;
    v_changed := v_old;
  else
    v_old := pg_catalog.to_jsonb(old);
    v_new := pg_catalog.to_jsonb(new);
    v_row := v_new;
    for k in select pg_catalog.jsonb_object_keys(v_new) loop
      if k = any(v_ignore) then
        continue;
      end if;
      if (v_old -> k) is distinct from (v_new -> k) then
        v_changed := v_changed || pg_catalog.jsonb_build_object(k, pg_catalog.jsonb_build_array(v_old -> k, v_new -> k));
      end if;
    end loop;
    if v_changed = '{}'::jsonb then
      return null;
    end if;
  end if;

  insert into public.audit_log (actor_id, actor_email, table_name, row_id, row_label, action, changed, note)
  values (
    v_actor,
    v_email,
    TG_TABLE_NAME,
    v_row ->> v_key,
    pg_catalog.left(coalesce(
      nullif(v_row ->> 'name', ''),
      nullif(v_row ->> 'title', ''),
      nullif(v_row ->> 'label', ''),
      nullif(v_row ->> 'question', ''),
      nullif(v_row ->> 'caption', ''),
      nullif(v_row ->> 'element_key', ''),
      nullif(v_row ->> 'reason', ''),
      v_row ->> v_key
    ), 120),
    pg_catalog.lower(TG_OP),
    v_changed,
    nullif(pg_catalog.current_setting('app.audit_note', true), '')
  );
  return null;
exception when others then
  raise warning 'audit_log_capture failed on %: %', TG_TABLE_NAME, SQLERRM;
  return null;
end;
$$;

revoke all on function public.audit_log_capture() from public, anon, authenticated;

-- Attach to every admin-managed table that exists. Orders: updates and
-- deletes only (new orders come from the public form and are already
-- visible in the Orders tab). A table that doesn't exist yet is skipped
-- with a notice; re-run this file after creating it.
do $$
declare
  t record;
begin
  for t in
    select * from (values
      ('products',         'id',  'insert or update or delete'),
      ('collections',      'id',  'insert or update or delete'),
      ('nav_items',        'id',  'insert or update or delete'),
      ('faq_items',        'id',  'insert or update or delete'),
      ('site_settings',    'key', 'insert or update or delete'),
      ('gallery_items',    'id',  'insert or update or delete'),
      ('blocked_dates',    'day', 'insert or update or delete'),
      ('delivery_areas',   'fsa', 'insert or update or delete'),
      ('layout_overrides', 'id',  'insert or update or delete'),
      ('orders',           'id',  'update or delete')
    ) as v(tbl, pk, ops)
  loop
    if pg_catalog.to_regclass(pg_catalog.format('public.%I', t.tbl)) is null then
      raise notice '30-safety: table public.% does not exist yet, activity logging skipped for it', t.tbl;
      continue;
    end if;
    execute pg_catalog.format('drop trigger if exists audit_log_capture on public.%I', t.tbl);
    execute pg_catalog.format(
      'create trigger audit_log_capture after %s on public.%I for each row execute function public.audit_log_capture(%L)',
      t.ops, t.tbl, t.pk);
  end loop;
end
$$;

-- Retention: deletes entries older than keep_days (at least 7). Owner only.
-- Returns how many were deleted.
create or replace function public.audit_log_prune(keep_days integer)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  if not public.is_admin() then
    raise exception 'audit_log_prune: owner only' using errcode = '42501';
  end if;
  if keep_days is null or keep_days < 7 then
    raise exception 'keep_days must be at least 7' using errcode = '22023';
  end if;
  delete from public.audit_log a
   where a.created_at < now() - pg_catalog.make_interval(days => keep_days);
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.audit_log_prune(integer) from public, anon;
grant execute on function public.audit_log_prune(integer) to authenticated;

-- --------------------------------------------------------------------------
-- 6. Restore rows (Restore from backup, Activity -> Undo)
-- --------------------------------------------------------------------------
-- Why an RPC: products, orders, collections, ... use
-- `id bigint generated always as identity`, which refuses an explicit id
-- from a normal insert/upsert. This function inserts with
-- `overriding system value`, so a restored row keeps its original id (and
-- every link to it, e.g. gallery_items.product_id), then moves the id
-- counter past the highest id so new rows never collide.
--
--   p_table  one of the allowlisted tables below, which must exist and
--            have a single-column primary key
--   p_rows   a JSON array of row objects (for 'delete_missing': row objects
--            or bare key values)
--   p_mode   'merge'          upsert by key: add missing rows, overwrite
--                             rows that differ, leave every other row alone
--            'update_only'    only update rows that exist (Undo of an edit)
--            'insert_only'    only add rows whose key is free (Undo of a
--                             delete)
--            'delete_missing' delete every row whose key is NOT in p_rows
--                             (the second half of "replace")
--   p_note   'restore' or 'undo', recorded in the activity log
--
-- Only columns that exist in the table AND appear in the rows are written,
-- so a backup from an older or newer version of the site restores what it
-- can: unknown columns are ignored, new columns keep their defaults on
-- added rows and their current values on updated rows.
-- Returns {"table","mode","received","inserted","updated","unchanged","deleted"}.
create or replace function public.admin_restore_rows(p_table text, p_rows jsonb, p_mode text default 'merge', p_note text default 'restore')
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed constant text[] := array[
    'products', 'orders', 'site_settings', 'collections', 'nav_items',
    'faq_items', 'layout_overrides', 'layout_overrides_history',
    'analytics_events', 'blocked_dates', 'delivery_areas', 'gallery_items',
    -- Added by other admin features; skipped until they exist.
    'order_events', 'content_history', 'photo_meta'
    -- Deliberately NOT restorable: admin_users (restoring role rows could
    -- grant admin access) and audit_log (the activity record must not be
    -- rewritable). Both are backed up read-only. rate_limit_secret,
    -- rate_limit_hits and order_upload_folders are private plumbing and are
    -- not backed up at all.
  ];
  v_rel regclass;
  v_pks text[];
  v_pk text;
  v_cols text[];
  v_identity_always boolean;
  v_set_cols text[];
  v_col_list text;
  v_sel_list text;
  v_set_list text;
  v_cmp_t text;
  v_cmp_src text;
  v_keys text[];
  v_received integer;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_deleted integer := 0;
  v_seq text;
  v_max bigint;
  v_last bigint;
  v_group record;
  v_n_ins integer;
  v_n_upd integer;
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'admin_restore_rows: owner only' using errcode = '42501';
  end if;
  if p_table is null or not (p_table = any(allowed)) then
    raise exception 'table_not_restorable'
      using errcode = '22023', hint = pg_catalog.format('"%s" is not on the restore allowlist.', p_table);
  end if;
  if p_mode is null or p_mode not in ('merge', 'update_only', 'insert_only', 'delete_missing') then
    raise exception 'invalid_mode' using errcode = '22023';
  end if;
  if p_rows is null or pg_catalog.jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows_must_be_an_array' using errcode = '22023';
  end if;

  v_rel := pg_catalog.to_regclass(pg_catalog.format('public.%I', p_table));
  if v_rel is null then
    raise exception 'table_missing'
      using errcode = '42P01', hint = pg_catalog.format('public.%s does not exist on this site.', p_table);
  end if;

  select pg_catalog.array_agg(a.attname::text) into v_pks
  from pg_catalog.pg_index i
  join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
  where i.indrelid = v_rel and i.indisprimary;
  if v_pks is null or pg_catalog.cardinality(v_pks) <> 1 then
    raise exception 'needs_single_column_key' using errcode = '22023';
  end if;
  v_pk := v_pks[1];

  v_received := pg_catalog.jsonb_array_length(p_rows);
  perform pg_catalog.set_config('app.audit_note', case when p_note = 'undo' then 'undo' else 'restore' end, true);

  -- ---- delete_missing ----------------------------------------------------
  if p_mode = 'delete_missing' then
    select pg_catalog.array_agg(case when pg_catalog.jsonb_typeof(e) = 'object' then e ->> v_pk else e #>> '{}' end)
      into v_keys
    from pg_catalog.jsonb_array_elements(p_rows) e;
    v_keys := coalesce(v_keys, '{}');
    if exists (select 1 from pg_catalog.unnest(v_keys) k where k is null) then
      raise exception 'row_missing_key' using errcode = '22023';
    end if;
    execute pg_catalog.format('delete from public.%I t where not (t.%I::text = any ($1))', p_table, v_pk)
      using v_keys;
    get diagnostics v_deleted = row_count;
    return pg_catalog.jsonb_build_object('table', p_table, 'mode', p_mode, 'received', v_received,
      'inserted', 0, 'updated', 0, 'unchanged', 0, 'deleted', v_deleted);
  end if;

  if v_received = 0 then
    return pg_catalog.jsonb_build_object('table', p_table, 'mode', p_mode, 'received', 0,
      'inserted', 0, 'updated', 0, 'unchanged', 0, 'deleted', 0);
  end if;

  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_rows) r
    where pg_catalog.jsonb_typeof(r) <> 'object'
       or (r -> v_pk) is null
       or pg_catalog.jsonb_typeof(r -> v_pk) = 'null'
  ) then
    raise exception 'row_missing_key'
      using errcode = '22023', hint = pg_catalog.format('Every row needs a "%s".', v_pk);
  end if;

  -- Rows are handled in groups that share the same set of keys, so a key
  -- missing from one row means "keep the default / current value" for that
  -- row rather than "set it to null". (A backup normally has one group per
  -- table; mixed shapes only happen with hand-edited files.)
  for v_group in
    select pg_catalog.jsonb_agg(r) as grp_rows
    from pg_catalog.jsonb_array_elements(p_rows) r
    group by (select pg_catalog.array_agg(k order by k) from pg_catalog.jsonb_object_keys(r) k)
  loop
    v_set_cols := null;
    v_set_list := null;

    -- Columns that exist, aren't generated, and appear in this group's rows.
    select pg_catalog.array_agg(a.attname::text order by a.attnum),
           coalesce(bool_or(a.attidentity = 'a'), false)
      into v_cols, v_identity_always
    from pg_catalog.pg_attribute a
    where a.attrelid = v_rel
      and a.attnum > 0
      and not a.attisdropped
      and a.attgenerated = ''
      and (v_group.grp_rows -> 0) ? a.attname::text;

    select pg_catalog.array_agg(c) into v_set_cols from pg_catalog.unnest(v_cols) c where c <> v_pk;

    select pg_catalog.string_agg(pg_catalog.format('%I', c), ', '),
           pg_catalog.string_agg(pg_catalog.format('r.%I', c), ', ')
      into v_col_list, v_sel_list
    from pg_catalog.unnest(v_cols) c;

    if v_set_cols is not null then
      -- Compared as text so json (no equality operator), arrays, etc. all work.
      select pg_catalog.string_agg(pg_catalog.format('%I = %s.%I', c, case when p_mode = 'update_only' then 'r' else 'excluded' end, c), ', '),
             pg_catalog.string_agg(pg_catalog.format('t.%I::text', c), ', '),
             pg_catalog.string_agg(pg_catalog.format('%s.%I::text', case when p_mode = 'update_only' then 'r' else 'excluded' end, c), ', ')
        into v_set_list, v_cmp_t, v_cmp_src
      from pg_catalog.unnest(v_set_cols) c;
    end if;

    if p_mode = 'update_only' then
      if v_set_cols is not null then
        execute pg_catalog.format(
          'with u as (update public.%1$I as t set %2$s
                      from pg_catalog.jsonb_populate_recordset(null::public.%1$I, $1) r
                      where t.%3$I = r.%3$I and row(%4$s) is distinct from row(%5$s)
                      returning 1)
           select count(*) from u',
          p_table, v_set_list, v_pk, v_cmp_t, v_cmp_src)
          into v_n_upd using v_group.grp_rows;
        v_updated := v_updated + v_n_upd;
      end if;
    else
      execute pg_catalog.format(
        'with i as (insert into public.%1$I as t (%2$s) %3$s
                    select %4$s from pg_catalog.jsonb_populate_recordset(null::public.%1$I, $1) r
                    on conflict (%5$I) %6$s
                    returning (t.xmax = 0) as is_new)
         select count(*) filter (where is_new), count(*) filter (where not is_new) from i',
        p_table,
        v_col_list,
        case when v_identity_always then 'overriding system value' else '' end,
        v_sel_list,
        v_pk,
        case
          when p_mode = 'insert_only' or v_set_cols is null then 'do nothing'
          else pg_catalog.format('do update set %s where row(%s) is distinct from row(%s)', v_set_list, v_cmp_t, v_cmp_src)
        end)
        into v_n_ins, v_n_upd using v_group.grp_rows;
      v_inserted := v_inserted + v_n_ins;
      v_updated := v_updated + v_n_upd;
    end if;
  end loop;

  if p_mode <> 'update_only' then
    -- Move the id counter past the restored ids.
    v_seq := pg_catalog.pg_get_serial_sequence(pg_catalog.format('public.%I', p_table), v_pk);
    if v_seq is not null then
      execute pg_catalog.format('select coalesce(max(%I), 0)::bigint from public.%I', v_pk, p_table) into v_max;
      execute pg_catalog.format('select last_value from %s', v_seq) into v_last;
      if v_max > v_last then
        perform pg_catalog.setval(v_seq, v_max, true);
      end if;
    end if;
  end if;

  return pg_catalog.jsonb_build_object('table', p_table, 'mode', p_mode, 'received', v_received,
    'inserted', v_inserted, 'updated', v_updated,
    'unchanged', v_received - v_inserted - v_updated, 'deleted', 0);
end;
$$;

revoke all on function public.admin_restore_rows(text, jsonb, text, text) from public, anon;
grant execute on function public.admin_restore_rows(text, jsonb, text, text) to authenticated;

-- ==========================================================================
-- PART 5 of 7: supabase-migrations/40-products.sql
-- (verbatim copy of supabase-migrations/40-products.sql)
-- ==========================================================================

-- ==========================================================================
-- 40-products.sql — Products & catalog upgrades
-- ==========================================================================
-- Adds pricing/stock, options (sizes + add-ons), scheduling, tags, manual
-- order, "featured", product-level SEO and a Trash (soft delete) to the
-- products table. Run it in the Supabase SQL editor AFTER
-- supabase-setup.sql (it needs the products table and is_admin()).
--
-- Safe to re-run: every column is `add column if not exists`, every
-- constraint is drop-then-add (`not valid`, same reasoning as
-- supabase-setup.sql: it enforces on every new write without failing on
-- an odd legacy row), policies are drop-then-create, the index is
-- `if not exists`. Purely additive: nothing is renamed or removed, and
-- every new column is optional, so the public site and the admin page
-- keep working whether or not this has been run yet.
--
-- Columns (all optional):
--   sku              your own product code; used to match rows on CSV import
--   sale_price       null = not on sale. Shown as the price, with the
--                    regular price struck through, when lower than price.
--   stock            null = unlimited / made to order; 0 = "Sold out"
--                    (add to cart disabled). Never decremented
--                    automatically — the owner edits it by hand.
--   tags             free-form labels, e.g. {pastel,helium}
--   sort_order       manual order within a collection (lower = first)
--   featured         featured products list first on the public site
--   variants         [{"name":"Large","price":180}, ...] — sizes/options;
--                    the price is what that option costs (blank/null =
--                    the product's own price)
--   addons           [{"name":"Helium top-up","price":15}, ...] — optional
--                    extras added on top of the price
--   available_from   hidden from the public site before this moment
--   available_until  hidden from the public site from this moment on
--   seo_title        <title> for the product detail view (blank = default)
--   seo_description  meta description for the product detail view
--   deleted_at       set = in the Trash (hidden everywhere public); the
--                    admin "Trash" tab can restore or delete for good

alter table public.products add column if not exists sku text;
alter table public.products add column if not exists sale_price numeric;
alter table public.products add column if not exists stock int;
alter table public.products add column if not exists tags text[] not null default '{}';
alter table public.products add column if not exists sort_order int not null default 0;
alter table public.products add column if not exists featured boolean not null default false;
alter table public.products add column if not exists variants jsonb not null default '[]'::jsonb;
alter table public.products add column if not exists addons jsonb not null default '[]'::jsonb;
alter table public.products add column if not exists available_from timestamptz;
alter table public.products add column if not exists available_until timestamptz;
alter table public.products add column if not exists seo_title text;
alter table public.products add column if not exists seo_description text;
alter table public.products add column if not exists deleted_at timestamptz;

-- Defense-in-depth, mirroring the admin form's own validation.
alter table public.products drop constraint if exists products_sale_price_check;
alter table public.products add constraint products_sale_price_check
  check (sale_price is null or sale_price >= 0) not valid;
alter table public.products drop constraint if exists products_stock_check;
alter table public.products add constraint products_stock_check
  check (stock is null or stock >= 0) not valid;
alter table public.products drop constraint if exists products_variants_check;
alter table public.products add constraint products_variants_check
  check (jsonb_typeof(variants) = 'array') not valid;
alter table public.products drop constraint if exists products_addons_check;
alter table public.products add constraint products_addons_check
  check (jsonb_typeof(addons) = 'array') not valid;
alter table public.products drop constraint if exists products_availability_check;
alter table public.products add constraint products_availability_check
  check (available_from is null or available_until is null or available_until > available_from) not valid;

-- Manual sort within a collection (admin drag-to-reorder, public default sort).
create index if not exists products_collection_sort_idx
  on public.products (collection, sort_order);

-- --------------------------------------------------------------------------
-- Public read policy
-- --------------------------------------------------------------------------
-- Before: `using (true)` — every row, including hidden ones, readable by
-- anyone; the site itself drops `active = false` rows. That client-side
-- `active` filtering is deliberately left exactly as it is.
--
-- Trashed and out-of-window rows are filtered HERE, in the database, not
-- only in the browser: a product in the Trash (or not launched yet) must
-- not be readable by visitors at all, and the database clock (now()) is
-- more trustworthy than a visitor's. The site also filters the same way
-- client-side, so it behaves identically before this file is run.
--
-- The admin still sees every row (trash, scheduled, expired): the
-- existing "Authenticated can manage products" policy (for all, using
-- is_admin()) from supabase-setup.sql also grants SELECT, and policies
-- are OR'd together. The is_admin() term below just makes that explicit
-- for the public policy too.
drop policy if exists "Public can read products" on public.products;
create policy "Public can read products"
  on public.products for select
  to anon, authenticated
  using (
    is_admin()
    or (
      deleted_at is null
      and (available_from is null or available_from <= now())
      and (available_until is null or available_until > now())
    )
  );

-- ==========================================================================
-- PART 6 of 7: supabase-migrations/50-analytics.sql
-- (verbatim copy of supabase-migrations/50-analytics.sql)
-- ==========================================================================

-- ==========================================================================
-- 50-analytics.sql — analytics_summary_v2() for the upgraded Analytics tab
-- ==========================================================================
-- Run in the Supabase SQL Editor AFTER supabase-setup.sql (it needs
-- public.analytics_events, public.is_admin() and public.analytics_summary()).
-- Safe to re-run: create or replace / if not exists only. It does not touch
-- any table's columns or policies, and does not change analytics_summary(),
-- which keeps working exactly as before for anything still calling it.
--
-- What it adds: one admin-only function that returns, in a single small
-- jsonb object, everything js/admin-analytics.js needs from the events
-- table, so the browser never downloads raw events:
--
--   * every key analytics_summary(from_ts, to_ts) returns (total_events,
--     events_by_event, sessions_by_event, field-error/abandon breakdowns,
--     top_products, product_count) — v2 calls v1 and merges, so the two
--     can't drift apart;
--   * version (2) and timezone (the zone actually used for bucketing);
--   * sessions_total ...... DISTINCT session_ids in the window;
--   * daily / weekly ...... per local day / ISO week (Monday start):
--                           sessions (distinct), page_views,
--                           product_views, adds, checkout_sessions;
--                           a session that spans midnight counts on both
--                           days, so daily sessions can sum to slightly more
--                           than sessions_total;
--   * monthly ............. same, per local calendar month ('YYYY-MM');
--   * dow ................. per ISO weekday (1 = Monday .. 7 = Sunday):
--                           sessions (distinct) and events (rows);
--   * sources ............. sessions per traffic source. A session's source
--                           is metadata.traffic_source on its EARLIEST event
--                           (looked up across the whole table, not just the
--                           window, so a session that started before from_ts
--                           still gets its source). js/analytics.js sets it
--                           on the first event of each browser session.
--                           Sessions with none (logged before capture
--                           existed) are 'unknown'. Also checkout_sessions
--                           per source (sessions that completed checkout);
--   * products ............ per product key (metadata.productId, falling back
--                           to metadata.name, then 'Unknown product') over
--                           product_viewed + add_to_cart rows: views (rows),
--                           view_sessions (distinct), adds (rows), and the
--                           newest non-null name/collection. Top 30 by views,
--                           then adds, then key; products_total = all keys;
--   * monthly_products .... top 5 products by views per month;
--   * monthly_collections . top 3 collections by views per month.
--
-- tz is an IANA zone name (the admin's browser sends its own, e.g.
-- 'Asia/Hong_Kong'); anything not in pg_timezone_names falls back to 'UTC'
-- so a bad value can never error.
--
-- The orders side (revenue, AOV, orders by source/product/event month) is
-- aggregated in the browser on purpose — see docs/admin-analytics.md. Orders
-- are few, and doing it client-side means this function never references an
-- orders column that might not exist yet on a given database.
--
-- Same security model as analytics_summary(): security definer so it can
-- read the table in one pass, so it checks is_admin() itself; only
-- `authenticated` may execute it.

create or replace function public.analytics_summary_v2(
  from_ts timestamptz,
  to_ts timestamptz default null,
  tz text default 'UTC'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  zone text := 'UTC';
  base jsonb;
  extra jsonb;
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'analytics_summary_v2: admin only' using errcode = '42501';
  end if;

  if tz is not null and exists (select 1 from pg_catalog.pg_timezone_names n where n.name = tz) then
    zone := tz;
  end if;

  base := public.analytics_summary(from_ts, to_ts);

  with ev as (
    select e.id, e.session_id, e.event_name, e.metadata, e.created_at,
           (e.created_at at time zone zone) as local_ts
    from public.analytics_events e
    where e.created_at >= coalesce(from_ts, '-infinity'::timestamptz)
      and (to_ts is null or e.created_at < to_ts)
  ),
  sessions_in as (
    select distinct ev.session_id from ev
  ),
  daily as (
    select pg_catalog.to_char(ev.local_ts, 'YYYY-MM-DD') as k,
           pg_catalog.count(distinct ev.session_id) as sessions,
           pg_catalog.count(*) filter (where ev.event_name = 'page_view') as page_views,
           pg_catalog.count(*) filter (where ev.event_name = 'product_viewed') as product_views,
           pg_catalog.count(*) filter (where ev.event_name = 'add_to_cart') as adds,
           pg_catalog.count(distinct ev.session_id) filter (where ev.event_name = 'checkout_submitted') as checkout_sessions
    from ev group by 1
  ),
  weekly as (
    select pg_catalog.to_char(pg_catalog.date_trunc('week', ev.local_ts), 'YYYY-MM-DD') as k,
           pg_catalog.count(distinct ev.session_id) as sessions,
           pg_catalog.count(*) filter (where ev.event_name = 'page_view') as page_views,
           pg_catalog.count(*) filter (where ev.event_name = 'product_viewed') as product_views,
           pg_catalog.count(*) filter (where ev.event_name = 'add_to_cart') as adds,
           pg_catalog.count(distinct ev.session_id) filter (where ev.event_name = 'checkout_submitted') as checkout_sessions
    from ev group by 1
  ),
  monthly as (
    select pg_catalog.to_char(ev.local_ts, 'YYYY-MM') as k,
           pg_catalog.count(distinct ev.session_id) as sessions,
           pg_catalog.count(*) filter (where ev.event_name = 'page_view') as page_views,
           pg_catalog.count(*) filter (where ev.event_name = 'product_viewed') as product_views,
           pg_catalog.count(*) filter (where ev.event_name = 'add_to_cart') as adds,
           pg_catalog.count(distinct ev.session_id) filter (where ev.event_name = 'checkout_submitted') as checkout_sessions
    from ev group by 1
  ),
  dow as (
    select extract(isodow from ev.local_ts)::int as d,
           pg_catalog.count(distinct ev.session_id) as sessions,
           pg_catalog.count(*) as events
    from ev group by 1
  ),
  -- Earliest event per in-window session that carries a usable
  -- traffic_source, searched over the whole table (session index).
  session_src as (
    select distinct on (e.session_id) e.session_id,
           pg_catalog.lower(e.metadata ->> 'traffic_source') as source
    from public.analytics_events e
    join sessions_in s on s.session_id = e.session_id
    where e.metadata ? 'traffic_source'
      and pg_catalog.jsonb_typeof(e.metadata -> 'traffic_source') = 'string'
      and e.metadata ->> 'traffic_source' <> ''
    order by e.session_id, e.created_at, e.id
  ),
  checkout_sessions as (
    select distinct ev.session_id from ev where ev.event_name = 'checkout_submitted'
  ),
  sources as (
    select coalesce(ss.source, 'unknown') as source,
           pg_catalog.count(*) as sessions,
           pg_catalog.count(cs.session_id) as checkout_sessions
    from sessions_in si
    left join session_src ss on ss.session_id = si.session_id
    left join checkout_sessions cs on cs.session_id = si.session_id
    group by 1
  ),
  prod_ev as (
    select ev.id, ev.session_id, ev.event_name, ev.created_at,
           pg_catalog.to_char(ev.local_ts, 'YYYY-MM') as month,
           case when pg_catalog.jsonb_typeof(ev.metadata -> 'productId') in ('string', 'number', 'boolean')
                then nullif(ev.metadata ->> 'productId', '') end as product_id,
           case when pg_catalog.jsonb_typeof(ev.metadata -> 'name') in ('string', 'number', 'boolean')
                then nullif(ev.metadata ->> 'name', '') end as name,
           case when pg_catalog.jsonb_typeof(ev.metadata -> 'collection') in ('string', 'number', 'boolean')
                then nullif(ev.metadata ->> 'collection', '') end as collection
    from ev
    where ev.event_name in ('product_viewed', 'add_to_cart')
  ),
  prod_keyed as (
    select p.*, coalesce(p.product_id, p.name, 'Unknown product') as product_key from prod_ev p
  ),
  products as (
    select p.product_key,
           pg_catalog.count(*) filter (where p.event_name = 'product_viewed') as views,
           pg_catalog.count(distinct p.session_id) filter (where p.event_name = 'product_viewed') as view_sessions,
           pg_catalog.count(*) filter (where p.event_name = 'add_to_cart') as adds,
           (pg_catalog.array_agg(p.name order by p.created_at desc, p.id desc) filter (where p.name is not null))[1] as name,
           (pg_catalog.array_agg(p.collection order by p.created_at desc, p.id desc) filter (where p.collection is not null))[1] as collection
    from prod_keyed p
    group by p.product_key
  ),
  top_products as (
    select pr.* from products pr
    order by pr.views desc, pr.adds desc, pr.product_key collate "C"
    limit 30
  ),
  month_products as (
    select p.month, p.product_key,
           pg_catalog.count(*) as views,
           (pg_catalog.array_agg(p.name order by p.created_at desc, p.id desc) filter (where p.name is not null))[1] as name,
           (pg_catalog.array_agg(p.collection order by p.created_at desc, p.id desc) filter (where p.collection is not null))[1] as collection
    from prod_keyed p
    where p.event_name = 'product_viewed'
    group by p.month, p.product_key
  ),
  month_products_ranked as (
    select mp.*, pg_catalog.row_number() over (partition by mp.month order by mp.views desc, mp.product_key collate "C") as rn
    from month_products mp
  ),
  month_collections as (
    select p.month, p.collection, pg_catalog.count(*) as views
    from prod_keyed p
    where p.event_name = 'product_viewed' and p.collection is not null
    group by p.month, p.collection
  ),
  month_collections_ranked as (
    select mc.*, pg_catalog.row_number() over (partition by mc.month order by mc.views desc, mc.collection collate "C") as rn
    from month_collections mc
  )
  select pg_catalog.jsonb_build_object(
    'version', 2,
    'timezone', zone,
    'sessions_total', (select pg_catalog.count(*) from sessions_in),
    'daily', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'key', d.k, 'sessions', d.sessions, 'page_views', d.page_views, 'product_views', d.product_views,
        'adds', d.adds, 'checkout_sessions', d.checkout_sessions) order by d.k) from daily d), '[]'::jsonb),
    'weekly', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'key', w.k, 'sessions', w.sessions, 'page_views', w.page_views, 'product_views', w.product_views,
        'adds', w.adds, 'checkout_sessions', w.checkout_sessions) order by w.k) from weekly w), '[]'::jsonb),
    'monthly', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'key', m.k, 'sessions', m.sessions, 'page_views', m.page_views, 'product_views', m.product_views,
        'adds', m.adds, 'checkout_sessions', m.checkout_sessions) order by m.k) from monthly m), '[]'::jsonb),
    'dow', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'dow', x.d, 'sessions', x.sessions, 'events', x.events) order by x.d) from dow x), '[]'::jsonb),
    'sources', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'source', s.source, 'sessions', s.sessions, 'checkout_sessions', s.checkout_sessions)
        order by s.sessions desc, s.source collate "C") from sources s), '[]'::jsonb),
    'products', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'key', t.product_key, 'name', t.name, 'collection', t.collection, 'views', t.views,
        'view_sessions', t.view_sessions, 'adds', t.adds)
        order by t.views desc, t.adds desc, t.product_key collate "C") from top_products t), '[]'::jsonb),
    'products_total', (select pg_catalog.count(*) from products),
    'monthly_products', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'month', r.month, 'key', r.product_key, 'name', r.name, 'collection', r.collection, 'views', r.views)
        order by r.month, r.rn) from month_products_ranked r where r.rn <= 5), '[]'::jsonb),
    'monthly_collections', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'month', r.month, 'collection', r.collection, 'views', r.views)
        order by r.month, r.rn) from month_collections_ranked r where r.rn <= 3), '[]'::jsonb)
  )
  into extra;

  return coalesce(base, '{}'::jsonb) || extra;
end;
$$;

revoke all on function public.analytics_summary_v2(timestamptz, timestamptz, text) from public;
revoke all on function public.analytics_summary_v2(timestamptz, timestamptz, text) from anon;
grant execute on function public.analytics_summary_v2(timestamptz, timestamptz, text) to authenticated;

-- Speeds up the per-session traffic_source lookup above (the existing
-- analytics_events_session_time_idx covers (session_id, created_at); this
-- partial index only holds the one-per-session rows that carry a source).
create index if not exists analytics_events_traffic_source_idx
  on public.analytics_events (session_id, created_at, id)
  where metadata ? 'traffic_source';

-- ==========================================================================
-- PART 7 of 7: supabase-migrations/60-content.sql
-- (verbatim copy of supabase-migrations/60-content.sql)
-- ==========================================================================

-- ==========================================================================
-- 60-content.sql — content editing upgrades (admin Settings / FAQ / Library)
-- ==========================================================================
-- Adds two tables:
--   content_history  "revert content" versions of the Settings form and the
--                    FAQ list (admin-only). Written by js/admin-content-history.js
--                    after every successful save; the newest 50 per kind are
--                    kept (older rows are pruned by a trigger on insert).
--   photo_meta       per-photo alt text, keyed by the photo's public URL.
--                    Public read (the site uses it to fill in <img alt>),
--                    admin write.
--
-- New page-level SEO settings (seo_<page>_title / seo_<page>_description /
-- seo_og_image) live in the existing site_settings table as ordinary
-- key/value rows, so they need no schema change.
--
-- Safe to re-run: if-not-exists / drop-then-create throughout, nothing is
-- dropped or altered on existing tables. Run it after supabase-setup.sql
-- (it needs public.is_admin() from there).
--
-- Until this has been run: the admin History buttons say history isn't set
-- up yet, the alt-text editor says the same, and the public site keeps its
-- current alt text. Nothing else changes.

-- --------------------------------------------------------------------------
-- content_history
-- --------------------------------------------------------------------------
create table if not exists public.content_history (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  -- Filled in by the database from the signed-in session, so a client
  -- can't claim to be someone else.
  actor_email text default auth.email(),
  kind text not null,
  snapshot jsonb not null,
  note text
);

alter table public.content_history enable row level security;

alter table public.content_history drop constraint if exists content_history_kind_check;
alter table public.content_history add constraint content_history_kind_check check (kind in ('settings', 'faq')) not valid;
alter table public.content_history drop constraint if exists content_history_note_length_check;
alter table public.content_history add constraint content_history_note_length_check check (note is null or char_length(note) <= 300) not valid;

create index if not exists content_history_kind_created_idx on public.content_history (kind, created_at desc);

-- Internal version history: admin only, never public.
drop policy if exists "Admin can read content history" on public.content_history;
create policy "Admin can read content history"
  on public.content_history for select
  to authenticated
  using (public.is_admin());

drop policy if exists "Admin can add content history" on public.content_history;
create policy "Admin can add content history"
  on public.content_history for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists "Admin can prune content history" on public.content_history;
create policy "Admin can prune content history"
  on public.content_history for delete
  to authenticated
  using (public.is_admin());

-- Keep only the newest 50 versions per kind. Runs as the inserting admin
-- (security invoker), so it's subject to the delete policy above.
create or replace function public.content_history_prune()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  delete from public.content_history h
  where h.kind = new.kind
    and h.id in (
      select id from public.content_history
      where kind = new.kind
      order by created_at desc, id desc
      offset 50
    );
  return null;
end;
$$;

drop trigger if exists content_history_prune on public.content_history;
create trigger content_history_prune
  after insert on public.content_history
  for each row execute function public.content_history_prune();

-- --------------------------------------------------------------------------
-- photo_meta (alt text)
-- --------------------------------------------------------------------------
create table if not exists public.photo_meta (
  url text primary key,
  alt text,
  updated_at timestamptz not null default now()
);

alter table public.photo_meta enable row level security;

alter table public.photo_meta drop constraint if exists photo_meta_alt_length_check;
alter table public.photo_meta add constraint photo_meta_alt_length_check check (alt is null or char_length(alt) <= 300) not valid;
alter table public.photo_meta drop constraint if exists photo_meta_url_check;
alter table public.photo_meta add constraint photo_meta_url_check check (trim(url) <> '') not valid;

drop policy if exists "Public can read photo meta" on public.photo_meta;
create policy "Public can read photo meta"
  on public.photo_meta for select
  to anon, authenticated
  using (true);

drop policy if exists "Admin can manage photo meta" on public.photo_meta;
create policy "Admin can manage photo meta"
  on public.photo_meta for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create or replace function public.photo_meta_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists photo_meta_touch on public.photo_meta;
create trigger photo_meta_touch
  before update on public.photo_meta
  for each row execute function public.photo_meta_touch();

-- ==========================================================================
-- END of supabase-all.sql
-- ==========================================================================
