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
