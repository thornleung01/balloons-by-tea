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
