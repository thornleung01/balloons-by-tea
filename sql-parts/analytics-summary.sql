-- ==========================================================================
-- Analytics summary (server-side aggregation for the admin Analytics tab)
-- ==========================================================================
-- The Analytics tab used to download every raw analytics_events row and
-- count them in the browser. PostgREST caps a response at 1000 rows by
-- default, so once a range held more events than that the numbers quietly
-- stopped growing. This function does the counting in Postgres and returns
-- one small jsonb object with everything the tab shows.
--
-- js/admin.js (computeAnalyticsSummary) still has a browser-side version
-- of the exact same rules, used only until this function exists. The two
-- MUST stay in sync — change one, change the other:
--   * window: from_ts <= created_at < to_ts (null from_ts = the beginning
--     of time, null to_ts = no upper bound);
--   * sessions_by_event: DISTINCT session_ids per event_name (funnel steps);
--     events_by_event: raw row count per event_name;
--   * a metadata value counts only if it's a non-empty string, a number or
--     a boolean (anything else — missing, null, '', object, array — is
--     treated as absent);
--   * field-error breakdowns key on metadata.field, absent -> 'unknown';
--   * abandon_fields counts every usable element of metadata.filledFields
--     (only when it's an array) across all checkout_abandoned rows;
--   * top_products groups add_to_cart rows by metadata.productId, falling
--     back to metadata.name, then 'Unknown product'; name/collection shown
--     come from that product's newest row (created_at, then id);
--   * every list is sorted by count desc, then key in plain code-point
--     order (collate "C"), so ties come out the same on both sides.
--
-- Runs as its owner (security definer) so it can read the table in one
-- pass, which is why it checks is_admin() itself and refuses everyone
-- else. Only `authenticated` may execute it at all; anon and public can't.
create or replace function public.analytics_summary(from_ts timestamptz, to_ts timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'analytics_summary: admin only' using errcode = '42501';
  end if;

  with ev as (
    select e.id, e.session_id, e.event_name, e.metadata, e.created_at
    from public.analytics_events e
    where e.created_at >= coalesce(from_ts, '-infinity'::timestamptz)
      and (to_ts is null or e.created_at < to_ts)
  ),
  by_event as (
    select ev.event_name,
           pg_catalog.count(*) as row_count,
           pg_catalog.count(distinct ev.session_id) as session_count
    from ev
    group by ev.event_name
  ),
  field_errors as (
    select ev.event_name,
           coalesce(case when pg_catalog.jsonb_typeof(ev.metadata -> 'field') in ('string', 'number', 'boolean')
                         then nullif(ev.metadata ->> 'field', '') end,
                    'unknown') as field
    from ev
    where ev.event_name in ('checkout_field_error', 'custom_order_field_error')
  ),
  field_error_counts as (
    select fe.event_name, fe.field, pg_catalog.count(*) as n
    from field_errors fe
    group by fe.event_name, fe.field
  ),
  abandon_fields as (
    select nullif(f.value #>> '{}', '') as field
    from ev
    cross join lateral pg_catalog.jsonb_array_elements(
      case when pg_catalog.jsonb_typeof(ev.metadata -> 'filledFields') = 'array'
           then ev.metadata -> 'filledFields'
           else '[]'::jsonb end
    ) as f(value)
    where ev.event_name = 'checkout_abandoned'
      and pg_catalog.jsonb_typeof(f.value) in ('string', 'number', 'boolean')
  ),
  abandon_field_counts as (
    select af.field, pg_catalog.count(*) as n
    from abandon_fields af
    where af.field is not null
    group by af.field
  ),
  adds as (
    select ev.id, ev.created_at,
           case when pg_catalog.jsonb_typeof(ev.metadata -> 'productId') in ('string', 'number', 'boolean')
                then nullif(ev.metadata ->> 'productId', '') end as product_id,
           case when pg_catalog.jsonb_typeof(ev.metadata -> 'name') in ('string', 'number', 'boolean')
                then nullif(ev.metadata ->> 'name', '') end as name,
           case when pg_catalog.jsonb_typeof(ev.metadata -> 'collection') in ('string', 'number', 'boolean')
                then nullif(ev.metadata ->> 'collection', '') end as collection
    from ev
    where ev.event_name = 'add_to_cart'
  ),
  products as (
    select coalesce(a.product_id, a.name, 'Unknown product') as product_key,
           pg_catalog.count(*) as n,
           (pg_catalog.array_agg(a.name order by a.created_at desc, a.id desc))[1] as name,
           (pg_catalog.array_agg(a.collection order by a.created_at desc, a.id desc))[1] as collection
    from adds a
    group by 1
  ),
  top_products as (
    select p.*
    from products p
    order by p.n desc, p.product_key collate "C"
    limit 8
  )
  select pg_catalog.jsonb_build_object(
    'total_events', (select coalesce(pg_catalog.sum(b.row_count), 0) from by_event b),
    'events_by_event', coalesce((select pg_catalog.jsonb_object_agg(b.event_name, b.row_count) from by_event b), '{}'::jsonb),
    'sessions_by_event', coalesce((select pg_catalog.jsonb_object_agg(b.event_name, b.session_count) from by_event b), '{}'::jsonb),
    'checkout_field_errors', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('field', c.field, 'count', c.n)
                                  order by c.n desc, c.field collate "C")
      from field_error_counts c where c.event_name = 'checkout_field_error'), '[]'::jsonb),
    'custom_field_errors', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('field', c.field, 'count', c.n)
                                  order by c.n desc, c.field collate "C")
      from field_error_counts c where c.event_name = 'custom_order_field_error'), '[]'::jsonb),
    'abandon_fields', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('field', c.field, 'count', c.n)
                                  order by c.n desc, c.field collate "C")
      from abandon_field_counts c), '[]'::jsonb),
    'top_products', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('key', t.product_key, 'name', t.name,
                                                                'collection', t.collection, 'count', t.n)
                                  order by t.n desc, t.product_key collate "C")
      from top_products t), '[]'::jsonb),
    'product_count', (select pg_catalog.count(*) from products)
  )
  into result;

  return result;
end;
$$;

-- Supports the created_at window above and the browser-side fallback's
-- paged (created_at desc, id desc) reads.
create index if not exists analytics_events_created_at_idx
  on public.analytics_events (created_at desc, id desc);

revoke all on function public.analytics_summary(timestamptz, timestamptz) from public;
revoke all on function public.analytics_summary(timestamptz, timestamptz) from anon;
grant execute on function public.analytics_summary(timestamptz, timestamptz) to authenticated;
