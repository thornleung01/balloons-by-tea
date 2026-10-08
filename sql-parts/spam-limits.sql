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
