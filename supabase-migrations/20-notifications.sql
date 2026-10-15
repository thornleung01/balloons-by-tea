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
