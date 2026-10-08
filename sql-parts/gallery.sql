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
