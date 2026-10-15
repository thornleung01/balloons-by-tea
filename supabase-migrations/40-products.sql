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
