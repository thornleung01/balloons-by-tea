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
