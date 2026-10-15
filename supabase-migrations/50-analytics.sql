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
