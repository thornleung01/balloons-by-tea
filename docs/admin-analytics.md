# Admin Analytics tab

Files: `js/admin-analytics.js` (panel, aggregation, CSV), `js/admin-charts.js` (`window.AdminCharts`, reusable SVG charts), `css/admin-analytics.css`, `supabase-migrations/50-analytics.sql`, and an additive change in `js/analytics.js`.

## Setup

Run `supabase-migrations/50-analytics.sql` once in the Supabase SQL Editor (after `supabase-setup.sql`). It is idempotent and adds `analytics_summary_v2(from_ts, to_ts, tz)` (admin-only, `is_admin()`), plus a partial index. `analytics_summary()` is untouched (the Overview tab still uses it).

Without the migration the tab still works: it downloads the raw events (paged) and builds the same objects in the browser (`computeAnalyticsSummaryV2`, a tested twin of the SQL), and shows a tip to run the migration. If the `orders` columns `total_amount`, `items`, `source`, `event_on` don't exist yet, the tab falls back to the legacy columns (below).

## What the tab shows

- **KPI row** with ▲/▼ change vs the previous equal-length period (words as well as colour; "no comparison" for All time): Revenue, Orders, Average order value, Conversion rate (orders / sessions, change in percentage points), Sessions. Cancelled orders are excluded everywhere.
- **Trends**: sessions (line/area) and orders (line/area) and revenue (bars), per day (7/30 days, custom up to 62 days) or per ISO week (90 days, all time, longer custom). Hover or tap for a tooltip. "Show data table" under the chart.
- **Shopping funnel**: sessions that reached visit, product view, add to cart, cart opened, checkout started, order placed, with % of previous step and % of visits. A step with zero sessions while a later step has some is not being tracked, so it is omitted and listed under the chart.
- **Traffic sources**: sessions by source (events), orders/revenue by source (`orders.source`), conversion per source.
- **What's selling when** (always the last 12 calendar months, independent of the range buttons): orders and revenue per month, top collection and top product per month (from order `items`; if a month has no sold items, the most viewed product, labelled "most viewed"), a heat strip of orders by event month (all years, from `event_on`, else parsed `event_date`), and sessions by day of week.
- **Top products**: views, adds, view-to-cart %, orders, quantity, revenue.
- Existing friction cards (abandonment, field errors, custom-order funnel) and **Clear old events** are kept.
- **Range**: 7 / 30 / 90 / All / Custom (from-to dates, inclusive, browser time zone). **Export CSV** writes every summary table (formula-neutralised like the Orders export).

## Rules

- Time zone: the browser's; sent to the RPC as `tz` so SQL buckets match the client. Invalid zone falls back to UTC.
- Sessions = distinct `session_id`. A session spanning midnight counts on both days, so daily sessions can exceed the range total slightly.
- Revenue per order: `total_amount` if set, else the first number in legacy `total` ("$120.00", "Total: $1,240"). `Budget: ...` (custom orders) is a guess, so it is not revenue. AOV = revenue / orders that have a price.
- Order lines: `items` jsonb (`product_id, name, qty, unit_price, line_total`), else parsed from the legacy checkout `summary` lines (`2 x Name (Collection) - $640`). Names are resolved to ids/collections via the admin product cache and the built-in catalog.
- Source: `orders.source`, lower-cased; absent = "Unknown".
- Traffic source of a session = `metadata.traffic_source` on its earliest event that has one; none = "unknown".

## Why orders are aggregated in the browser

plpgsql resolves columns when the function runs, but referencing `total_amount`/`items`/`source` in SQL would make the function fail on any database where the orders migration has not run yet, and guarding with `information_schema` + dynamic SQL is fragile. Orders number in the hundreds, the legacy fallbacks (text parsing) are already JS, and the pieces that can be large (events) are aggregated in SQL. So: events in SQL (`analytics_summary_v2`), orders in JS.

## Traffic-source capture (`js/analytics.js`)

On the first event of each browser session, metadata gets `traffic_source` plus `ref_host`, `utm_source`, `utm_medium`, `utm_campaign` when present. Values: `instagram | google | facebook | tiktok | direct | referral:<host>` or the (lower-cased) utm_source; `utm_source` wins, then `gclid`/`ttclid`, then the referrer (same-site referrer = direct), then `fbclid`. `analyticsSessionTrafficSource()` returns the same string so the order form can store it in `orders.source` (not wired into app.js by this change).

## Charts helper

`AdminCharts.lineChart / barChart (vertical or horizontal) / sparkline / heatStrip / mount(el, width => markup)`. Pure functions returning markup, `role="img"` with `<title>`/`<desc>`, a shared tooltip, redraw on resize. Colours via CSS tokens (`--ac-*` in `css/admin-analytics.css`, with a `[data-theme="dark"]` set ready for when the admin gains a dark theme).
