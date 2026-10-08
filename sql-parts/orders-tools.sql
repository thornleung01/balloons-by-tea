-- ==========================================================================
-- Orders tools: private admin notes, "cancelled" status, insert hardening
-- ==========================================================================
-- Used by the admin Orders tab (js/admin.js). Safe to re-run. Until this
-- has been run the Orders tab still works; only saving a private note and
-- setting an order to Cancelled fail, with a message pointing here.

-- Private per-order notes, only ever shown in the admin panel. Customers
-- can't read orders at all (RLS), so this never reaches the public site.
alter table public.orders add column if not exists admin_notes text not null default '';

-- Adds 'cancelled' to the statuses the admin can set (ORDER_STATUSES in
-- js/admin.js). Replaces the three-status version of this constraint in
-- the "Data integrity" section of supabase-setup.sql.
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('new', 'contacted', 'fulfilled', 'cancelled')) not valid;

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
