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
  active boolean not null default true,
  created_at timestamptz not null default now()
);

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
