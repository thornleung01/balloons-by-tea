/* Admin "Analytics" tab. Uses helpers from js/admin-core.js and the SVG
   chart helpers in js/admin-charts.js (window.AdminCharts).

   Two data sources, combined in the browser:

   1. analytics_events (what js/analytics.js logs from every public page —
      see trackEvent() calls in js/app.js / js/product-detail.js for the
      exact event names). Aggregated in Postgres by analytics_summary_v2()
      (supabase-migrations/50-analytics.sql): sessions per day/week/month,
      funnel session counts, traffic sources, product views/adds, weekday
      split, plus every field analytics_summary() returns. Called three
      times per refresh — selected range, the previous equal-length range
      (for the KPI comparison) and the last 12 calendar months (seasonality).
      Until that function exists, the same objects are built here from the
      raw events (computeAnalyticsSummaryV2, which wraps the older
      computeAnalyticsSummary twin of analytics_summary()) — keep the rules
      in sync with the SQL.

      A funnel step's count is the number of DISTINCT SESSIONS that logged
      that event, not the raw row count — a field-error event can fire
      several times in one session, and counting rows would overstate
      drop-off.

   2. orders (revenue, order counts, AOV, sources, products sold, event
      months). Aggregated HERE, not in SQL, on purpose: a small business
      has hundreds of orders, not millions; it keeps working whichever of
      the newer orders columns (total_amount, items, source, event_on) a
      given database has; and the fallbacks (parse the legacy `total` text,
      parse cart lines out of the legacy `summary`) are already JS. See
      docs/admin-analytics.md for every rule. */

let analyticsRangeDays = 30; // 7 | 30 | 90 | "all" | "custom"
let analyticsCustomRange = { from: "", to: "" }; // YYYY-MM-DD, inclusive
// Bumped on every refresh so a slow, older load (e.g. after a quick range
// switch) can't overwrite the panel once a newer one has started.
let analyticsRefreshSeq = 0;
const ANALYTICS_PAGE_SIZE = 1000;
const ANALYTICS_DAY_MS = 86400000;
// The data behind the panel currently shown, for the CSV export.
let analyticsLastReport = null;

const ANALYTICS_COLORS = {
  sessions: "var(--ac-sessions)",
  orders: "var(--ac-orders)",
  revenue: "var(--ac-revenue)"
};
const ANALYTICS_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const ANALYTICS_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* ===== Dates (all in the browser's local time zone, which is also the
   zone sent to analytics_summary_v2 so both sides bucket the same) ===== */

function analyticsTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (e) { return "UTC"; }
}
const analyticsPad2 = (n) => String(n).padStart(2, "0");
function analyticsDayKey(d) { return `${d.getFullYear()}-${analyticsPad2(d.getMonth() + 1)}-${analyticsPad2(d.getDate())}`; }
function analyticsMonthKey(d) { return `${d.getFullYear()}-${analyticsPad2(d.getMonth() + 1)}`; }
// ISO week, Monday start — same as Postgres date_trunc('week', ...).
function analyticsWeekKey(d) {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return analyticsDayKey(m);
}
function analyticsIsoDow(d) { return ((d.getDay() + 6) % 7) + 1; } // 1 = Mon .. 7 = Sun
function analyticsKeyToDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d || 1);
}

/* The selected window, its previous equal-length window (null for all
   time), the 12-month seasonality window, and the trend bucket size.
   Times are ms since the epoch; fromMs null = the beginning of time. */
function analyticsWindow(range, custom, now) {
  const nowDate = now || new Date();
  const toMs = nowDate.getTime();
  const seasonStart = new Date(nowDate.getFullYear(), nowDate.getMonth() - 11, 1).getTime();
  const base = { seasonFromMs: seasonStart, seasonToMs: toMs };
  if (range === "all") {
    return { ...base, fromMs: null, toMs, prevFromMs: null, prevToMs: null, bucket: "week", label: "All time", prevLabel: "" };
  }
  if (range === "custom") {
    const start = custom && /^\d{4}-\d{2}-\d{2}$/.test(custom.from) ? analyticsKeyToDate(custom.from) : null;
    const endDay = custom && /^\d{4}-\d{2}-\d{2}$/.test(custom.to) ? analyticsKeyToDate(custom.to) : null;
    if (!start || !endDay || endDay < start) return null;
    const end = new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate() + 1);
    const fromMs = start.getTime();
    const endMs = end.getTime();
    const days = Math.round((endMs - fromMs) / ANALYTICS_DAY_MS);
    return {
      ...base, fromMs, toMs: endMs, prevFromMs: fromMs - (endMs - fromMs), prevToMs: fromMs,
      bucket: days <= 62 ? "day" : "week",
      label: `${custom.from} to ${custom.to}`,
      prevLabel: `previous ${days} day${days === 1 ? "" : "s"}`
    };
  }
  const days = Number(range) || 30;
  const from = new Date(nowDate);
  from.setDate(from.getDate() - days);
  const fromMs = from.getTime();
  return {
    ...base, fromMs, toMs, prevFromMs: fromMs - (toMs - fromMs), prevToMs: fromMs,
    bucket: days <= 62 ? "day" : "week",
    label: `Last ${days} days`,
    prevLabel: `previous ${days} days`
  };
}

const analyticsIso = (ms) => (ms == null ? null : new Date(ms).toISOString());

/* Every bucket key from fromMs to toMs (exclusive), so empty days/weeks
   still show as zero instead of being skipped. */
function analyticsBucketKeys(fromMs, toMs, bucket) {
  if (fromMs == null || toMs == null || toMs <= fromMs) return [];
  const keys = [];
  const start = new Date(fromMs);
  let d = bucket === "week"
    ? analyticsKeyToDate(analyticsWeekKey(start))
    : new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const step = bucket === "week" ? 7 : 1;
  // Stepping by calendar days (not ms) keeps keys right across DST.
  for (let guard = 0; d.getTime() < toMs && guard < 5000; guard++) {
    keys.push(analyticsDayKey(d));
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + step);
  }
  return keys;
}

function analyticsMonthKeys(fromMs, count) {
  const start = new Date(fromMs);
  return Array.from({ length: count }, (_, i) => analyticsMonthKey(new Date(start.getFullYear(), start.getMonth() + i, 1)));
}

/* ===== Formatting ===== */

function analyticsMoney(v) {
  if (v == null || !Number.isFinite(v)) return "n/a";
  return "$" + v.toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) < 100 ? 2 : 0 });
}
function analyticsMoneyTick(v) {
  return v >= 1000 ? `$${(v / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k` : `$${v}`;
}
const analyticsInt = (v) => Math.round(Number(v) || 0).toLocaleString();
function analyticsPct(part, whole, digits) {
  if (!whole) return "n/a";
  return `${((part / whole) * 100).toLocaleString(undefined, { maximumFractionDigits: digits == null ? 1 : digits })}%`;
}
function analyticsDayLabel(key, long) {
  const d = analyticsKeyToDate(key);
  return d.toLocaleDateString(undefined, long ? { weekday: "short", day: "numeric", month: "short", year: "numeric" } : { day: "numeric", month: "short" });
}
function analyticsMonthLabel(key, long) {
  const [y, m] = key.split("-").map(Number);
  return long ? `${ANALYTICS_MONTHS[m - 1]} ${y}` : ANALYTICS_MONTHS[m - 1];
}
function analyticsSourceLabel(source) {
  const s = String(source || "unknown");
  if (s === "unknown") return "Unknown";
  if (s.startsWith("referral:")) return `${s.slice(9)} (referral)`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ▲/▼ change vs the previous period, with words as well as colour.
   mode "pct" = relative change; "pts" = difference of two rates (0..1)
   in percentage points. Returns { dir: up|down|flat|none, text, sr }. */
function analyticsDelta(cur, prev, mode) {
  if (prev == null || cur == null || !Number.isFinite(cur) || !Number.isFinite(prev)) {
    return { dir: "none", text: "No comparison", sr: "" };
  }
  if (mode === "pts") {
    const diff = (cur - prev) * 100;
    if (Math.abs(diff) < 0.05) return { dir: "flat", text: "No change", sr: "" };
    return { dir: diff > 0 ? "up" : "down", text: `${Math.abs(diff).toFixed(1)} pts`, sr: diff > 0 ? "Up" : "Down" };
  }
  if (prev === 0 && cur === 0) return { dir: "flat", text: "No change", sr: "" };
  if (prev === 0) return { dir: "up", text: "New", sr: "Up from zero," };
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  if (Math.abs(pct) < 0.5) return { dir: "flat", text: "No change", sr: "" };
  return { dir: pct > 0 ? "up" : "down", text: `${Math.abs(pct) >= 10 ? Math.round(Math.abs(pct)) : Math.abs(pct).toFixed(1)}%`, sr: pct > 0 ? "Up" : "Down" };
}

/* ===== Orders (aggregated in the browser — see the header comment) ===== */

/* "$120.00", "Total: $1,240", "HK$ 85.5" -> number. The first number in
   the text wins. Custom orders store "Budget: <what the customer typed>",
   which is a guess, not a price, so it never counts as revenue. */
function analyticsParseMoney(text) {
  const s = String(text == null ? "" : text);
  if (!s.trim() || /budget/i.test(s)) return null;
  const m = /(\d[\d,]*(?:\.\d+)?)/.exec(s);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// total_amount when the column exists and is set, else the legacy text.
function analyticsOrderAmount(order) {
  const raw = order ? order.total_amount : null;
  if (raw !== null && raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return analyticsParseMoney(order && order.total);
}

function analyticsOrderSource(order) {
  const s = order && typeof order.source === "string" ? order.source.trim().toLowerCase() : "";
  return s || "unknown";
}

function analyticsOrderCreatedMs(order) {
  const t = Date.parse((order && order.created_at) || "");
  return Number.isNaN(t) ? null : t;
}

// { y, m } (m 1-12) of the event: event_on, else the free-text event_date.
function analyticsOrderEventMonth(order) {
  const pick = (v) => {
    const m = /^\s*(\d{4})-(\d{2})-(\d{2})/.exec(v || "");
    if (!m) return null;
    const mo = Number(m[2]);
    return mo >= 1 && mo <= 12 ? { y: Number(m[1]), m: mo } : null;
  };
  return pick(order && order.event_on) || pick(order && order.event_date);
}

/* Lookup tables for naming products/collections that only arrive as an id
   or a name: the admin's own product/category caches (globals from
   js/admin-products.js / js/admin-collections.js, if loaded) and the
   built-in catalog (window.COLLECTIONS from js/products.js). */
function analyticsCatalog() {
  const byId = new Map();
  const byName = new Map();
  const collectionTitle = new Map();
  const collectionByTitle = new Map();
  const addCollection = (slug, title) => {
    if (!slug) return;
    if (title && !collectionTitle.has(slug)) collectionTitle.set(slug, title);
    if (title) collectionByTitle.set(String(title).toLowerCase(), slug);
  };
  const addProduct = (id, name, collection) => {
    const entry = { id: String(id), name, collection };
    if (id != null && !byId.has(String(id))) byId.set(String(id), entry);
    if (name && !byName.has(String(name).toLowerCase())) byName.set(String(name).toLowerCase(), entry);
  };
  try {
    if (typeof collectionsCache !== "undefined" && Array.isArray(collectionsCache)) {
      collectionsCache.forEach((c) => addCollection(c.slug, c.title));
    }
    if (typeof productsCache !== "undefined" && Array.isArray(productsCache)) {
      productsCache.forEach((p) => addProduct("sb-" + p.id, p.name, p.collection));
    }
    const builtIn = typeof window !== "undefined" ? window.COLLECTIONS : null;
    if (builtIn && typeof builtIn === "object") {
      Object.keys(builtIn).forEach((slug) => {
        const col = builtIn[slug] || {};
        addCollection(slug, col.title);
        (col.items || []).forEach((item) => addProduct(item.id, item.name, slug));
      });
    }
  } catch (e) { /* naming is best-effort */ }
  return { byId, byName, collectionTitle, collectionByTitle };
}

function analyticsCollectionLabel(catalog, slug) {
  if (!slug) return "";
  return (catalog && catalog.collectionTitle.get(slug)) || slug;
}

// A legacy checkout summary line: "2 x Ivory Arch (Anniversary) - $640".
const ANALYTICS_SUMMARY_LINE_RE = /^\s*(\d+)\s*[x×]\s+(.+?)(?:\s+\(([^()]*)\))?\s+-\s+[^\d]*([\d,]+(?:\.\d+)?)\s*$/i;

/* Cart lines of an order as [{ key, name, collection, qty, revenue }]:
   from `items` (jsonb cart lines) when present, else parsed out of the
   legacy checkout `summary` text. Custom orders have no lines. */
function analyticsOrderLines(order, catalog) {
  let items = order ? order.items : null;
  if (typeof items === "string") {
    try { items = JSON.parse(items); } catch (e) { items = null; }
  }
  const lines = [];
  if (Array.isArray(items) && items.length) {
    items.forEach((line) => {
      if (!line || typeof line !== "object") return;
      const qty = Number(line.qty) > 0 ? Number(line.qty) : 1;
      const id = line.product_id != null && line.product_id !== "" ? String(line.product_id) : null;
      const known = (id && catalog && catalog.byId.get(id)) || (line.name && catalog && catalog.byName.get(String(line.name).toLowerCase())) || null;
      let revenue = Number(line.line_total);
      if (!Number.isFinite(revenue)) revenue = Number(line.unit_price) * qty;
      lines.push({
        key: id || (known && known.id) || String(line.name || "Unknown product"),
        name: line.name || (known && known.name) || id || "Unknown product",
        collection: line.collection || (known && known.collection) || "",
        qty,
        revenue: Number.isFinite(revenue) ? revenue : 0
      });
    });
    return lines;
  }
  if (order && order.kind !== "custom" && order.summary) {
    String(order.summary).split(/\r?\n/).forEach((text) => {
      const m = ANALYTICS_SUMMARY_LINE_RE.exec(text);
      if (!m) return;
      const name = m[2].trim();
      const known = catalog ? catalog.byName.get(name.toLowerCase()) : null;
      const colFromLabel = m[3] && catalog ? catalog.collectionByTitle.get(m[3].trim().toLowerCase()) : null;
      lines.push({
        key: known ? known.id : name,
        name,
        collection: (known && known.collection) || colFromLabel || (m[3] ? m[3].trim() : ""),
        qty: Number(m[1]) || 1,
        revenue: Number(m[4].replace(/,/g, "")) || 0
      });
    });
  }
  return lines;
}

const analyticsIsCountedOrder = (order) => (order && order.status) !== "cancelled";

/* Orders whose created_at is in [fromMs, toMs), cancelled ones excluded.
   bucketOf(date) -> bucket key (or null to skip bucketing). */
function summarizeAnalyticsOrders(orders, fromMs, toMs, bucketOf, catalog) {
  const out = {
    count: 0, revenue: 0, priced: 0, cancelled: 0,
    buckets: {}, sources: {}, products: {}, collections: {},
    dow: [0, 0, 0, 0, 0, 0, 0]
  };
  (orders || []).forEach((order) => {
    const t = analyticsOrderCreatedMs(order);
    if (t == null || (fromMs != null && t < fromMs) || (toMs != null && t >= toMs)) return;
    if (!analyticsIsCountedOrder(order)) { out.cancelled += 1; return; }
    const amount = analyticsOrderAmount(order);
    const date = new Date(t);
    out.count += 1;
    if (amount != null) { out.revenue += amount; out.priced += 1; }
    out.dow[analyticsIsoDow(date) - 1] += 1;
    if (bucketOf) {
      const k = bucketOf(date);
      const b = out.buckets[k] || (out.buckets[k] = { orders: 0, revenue: 0, products: {}, collections: {} });
      b.orders += 1;
      b.revenue += amount || 0;
    }
    const src = analyticsOrderSource(order);
    const s = out.sources[src] || (out.sources[src] = { orders: 0, revenue: 0 });
    s.orders += 1;
    s.revenue += amount || 0;
    analyticsOrderLines(order, catalog).forEach((line) => {
      const p = out.products[line.key] || (out.products[line.key] = { key: line.key, name: line.name, collection: line.collection, orders: 0, qty: 0, revenue: 0 });
      p.orders += 1;
      p.qty += line.qty;
      p.revenue += line.revenue;
      if (line.collection) out.collections[line.collection] = (out.collections[line.collection] || 0) + line.qty;
      if (bucketOf) {
        const b = out.buckets[bucketOf(date)];
        b.products[line.key] = b.products[line.key] || { key: line.key, name: line.name, qty: 0 };
        b.products[line.key].qty += line.qty;
        if (line.collection) b.collections[line.collection] = (b.collections[line.collection] || 0) + line.qty;
      }
    });
  });
  out.aov = out.priced ? out.revenue / out.priced : null;
  return out;
}

/* Non-cancelled orders by calendar month of the EVENT (all years
   together) — when parties actually happen, i.e. busy seasons. */
function analyticsEventMonthCounts(orders) {
  const counts = new Array(12).fill(0);
  let dated = 0;
  (orders || []).forEach((order) => {
    if (!analyticsIsCountedOrder(order)) return;
    const em = analyticsOrderEventMonth(order);
    if (!em) return;
    counts[em.m - 1] += 1;
    dated += 1;
  });
  return { counts, dated };
}

/* Every order, paged (PostgREST caps one response at 1000 rows).
   select("*") so it works whichever orders columns exist. */
async function fetchAnalyticsOrders(client) {
  const rows = [];
  for (;;) {
    const { data, error } = await client
      .from("orders")
      .select("*")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(rows.length, rows.length + ANALYTICS_PAGE_SIZE - 1);
    if (error) return { data: null, error };
    if (!data || !data.length) break;
    data.forEach((row) => rows.push(row));
    if (data.length < ANALYTICS_PAGE_SIZE) break;
  }
  return { data: rows, error: null };
}

/* ===== Events ===== */

/* Loading placeholder shaped like the loaded page: KPI row, then a chart card. */
function analyticsSkeletonHtml() {
  const kpi = `<div class="an-kpi an-sk-kpi"><span class="a-skeleton a-skeleton--line an-sk-w50"></span><span class="a-skeleton an-sk-value"></span><span class="a-skeleton a-skeleton--line an-sk-w70"></span></div>`;
  return `<div class="an-skeleton" role="status" aria-label="Loading analytics">
    <div class="an-kpis" aria-hidden="true">${kpi.repeat(5)}</div>
    <div class="analytics-card" aria-hidden="true"><span class="a-skeleton a-skeleton--line an-sk-w30"></span><span class="a-skeleton an-sk-chart"></span><span class="a-skeleton a-skeleton--line an-sk-w30"></span><span class="a-skeleton an-sk-chart an-sk-chart-short"></span></div>
  </div>`;
}

/* Inline error with a Retry button (wired once, by delegation, in onAdminInit). */
function analyticsErrorHtml(title, message) {
  return `<div class="an-error" role="alert"><p class="a-inline-error">${escapeHtml(title)} ${escapeHtml(message)}</p><button type="button" class="btn btn-outline btn-sm" data-an-retry>Retry</button></div>`;
}

async function refreshAnalyticsPanel() {
  const seq = ++analyticsRefreshSeq;
  const content = document.getElementById("analyticsContent");
  const win = analyticsWindow(analyticsRangeDays, analyticsCustomRange);
  if (!win) {
    content.innerHTML = `<p class="a-inline-error" role="alert">Pick a start and end date. The end can't be before the start.</p>`;
    return;
  }
  content.innerHTML = analyticsSkeletonHtml();
  const client = getSupabaseClient();
  const tz = analyticsTimezone();
  const rpc = (fromMs, toMs) => client.rpc("analytics_summary_v2", { from_ts: analyticsIso(fromMs), to_ts: analyticsIso(toMs), tz });

  const [cur, prev, season, ordersRes] = await Promise.all([
    rpc(win.fromMs, win.toMs),
    win.prevFromMs != null ? rpc(win.prevFromMs, win.prevToMs) : Promise.resolve({ data: null, error: null }),
    rpc(win.seasonFromMs, win.seasonToMs),
    fetchAnalyticsOrders(client)
  ]);
  if (seq !== analyticsRefreshSeq) return;

  let summary = cur.data;
  let prevSummary = prev.data;
  let seasonSummary = season.data;
  let error = cur.error || prev.error || season.error;
  let usedFallback = false;
  // 42883 = undefined function: v2 exists but the analytics_summary() it
  // builds on doesn't (supabase-setup.sql not fully run).
  if (error && (isMissingTableError(error, "analytics_summary_v2") || error.code === "42883")) {
    // Not migrated yet: build the same objects from the raw events. One
    // download covers all three windows.
    usedFallback = true;
    const earliest = win.fromMs == null ? null : Math.min(...[win.fromMs, win.prevFromMs, win.seasonFromMs].filter((v) => v != null));
    const events = await fetchAllAnalyticsEvents(client, analyticsIso(earliest) || "1970-01-01T00:00:00Z", analyticsIso(win.toMs));
    if (seq !== analyticsRefreshSeq) return;
    error = events.error;
    if (!error) {
      summary = computeAnalyticsSummaryV2(events.data, win.fromMs, win.toMs);
      prevSummary = win.prevFromMs != null ? computeAnalyticsSummaryV2(events.data, win.prevFromMs, win.prevToMs) : null;
      seasonSummary = computeAnalyticsSummaryV2(events.data, win.seasonFromMs, win.seasonToMs);
    }
  }

  if (error) {
    // Most likely cause: the analytics_events table/migration hasn't been
    // run yet (see supabase-setup.sql) — give a specific, actionable
    // message instead of a raw Postgres error for that common case.
    content.innerHTML = isMissingTableError(error, "analytics_events")
      ? analyticsErrorHtml("The analytics_events table doesn't exist yet.", "Run the latest supabase-setup.sql in your Supabase SQL Editor to turn tracking on.")
      : analyticsErrorHtml("Couldn't load analytics.", error.message || "");
    return;
  }

  const report = buildAnalyticsReport({
    win, summary, prevSummary, seasonSummary,
    orders: ordersRes.data || [], ordersError: ordersRes.error, usedFallback
  });
  analyticsLastReport = report;
  renderAnalyticsPanel(report);
}

/* Fallback only: every event in [fromIso, toIso), fetched in pages with
   .range() because PostgREST caps a single response (1000 rows by
   default). Ordered by created_at then id so pages never overlap or skip.
   Stops on an empty page rather than a short one, so a server whose row
   cap is set lower than ANALYTICS_PAGE_SIZE still gets read in full. */
async function fetchAllAnalyticsEvents(client, fromIso, toIso) {
  const rows = [];
  for (;;) {
    const { data, error } = await client
      .from("analytics_events")
      .select("id,event_name,session_id,metadata,created_at")
      .gte("created_at", fromIso)
      .lt("created_at", toIso)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(rows.length, rows.length + ANALYTICS_PAGE_SIZE - 1);
    if (error) return { data: null, error };
    if (!data || !data.length) break;
    data.forEach((row) => rows.push(row));
  }
  return { data: rows, error: null };
}

/* A metadata value as analytics_summary() reads it (metadata ->> key):
   non-empty strings as-is, numbers/booleans as text, anything else
   (missing, null, "", object, array) as absent. */
function analyticsMetaText(meta, key) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const v = meta[key];
  if (typeof v === "string") return v === "" ? null : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/* created_at as microseconds since the epoch, for exact newest-row
   comparisons (Date.parse alone drops Postgres's last 3 digits). */
function analyticsTimeValue(iso) {
  const ms = Date.parse(iso || "");
  if (Number.isNaN(ms)) return -Infinity;
  const frac = /\.(\d+)/.exec(iso);
  return ms * 1000 + (frac ? Number((frac[1] + "000000").slice(3, 6)) : 0);
}

// count desc, then key in code-point order — same as the SQL's collate "C".
function analyticsCountOrder(aCount, aKey, bCount, bKey) {
  if (aCount !== bCount) return bCount - aCount;
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

function analyticsSortedFieldCounts(counts) {
  return Object.entries(counts)
    .sort((a, b) => analyticsCountOrder(a[1], a[0], b[1], b[0]))
    .map(([field, count]) => ({ field, count }));
}

/* Browser-side twin of analytics_summary() — same input window, same
   output shape, same rules (see the comment above that function in
   supabase-setup.sql). Used only when the server functions don't exist. */
function computeAnalyticsSummary(events) {
  const eventsByEvent = {};
  const sessionSets = {};
  const checkoutFieldErrors = {};
  const customFieldErrors = {};
  const abandonFields = {};
  const products = {}; // key -> { key, count, name, collection, time, id }

  events.forEach((e) => {
    const name = e.event_name;
    eventsByEvent[name] = (eventsByEvent[name] || 0) + 1;
    (sessionSets[name] = sessionSets[name] || new Set()).add(e.session_id);
    const meta = e.metadata;

    if (name === "checkout_field_error" || name === "custom_order_field_error") {
      const target = name === "checkout_field_error" ? checkoutFieldErrors : customFieldErrors;
      const f = analyticsMetaText(meta, "field") || "unknown";
      target[f] = (target[f] || 0) + 1;
    } else if (name === "checkout_abandoned") {
      const filled = meta && typeof meta === "object" && !Array.isArray(meta) ? meta.filledFields : null;
      if (Array.isArray(filled)) {
        filled.forEach((v) => {
          const f = analyticsMetaText({ v }, "v");
          if (f !== null) abandonFields[f] = (abandonFields[f] || 0) + 1;
        });
      }
    } else if (name === "add_to_cart") {
      const productName = analyticsMetaText(meta, "name");
      const key = analyticsMetaText(meta, "productId") || productName || "Unknown product";
      const time = analyticsTimeValue(e.created_at);
      const id = Number(e.id) || 0;
      const p = products[key] || (products[key] = { key, count: 0, name: null, collection: null, time: -Infinity, id: -Infinity });
      p.count += 1;
      if (time > p.time || (time === p.time && id > p.id)) {
        p.time = time;
        p.id = id;
        p.name = productName;
        p.collection = analyticsMetaText(meta, "collection");
      }
    }
  });

  const sessionsByEvent = {};
  Object.keys(sessionSets).forEach((name) => { sessionsByEvent[name] = sessionSets[name].size; });
  const sortedProducts = Object.values(products).sort((a, b) => analyticsCountOrder(a.count, a.key, b.count, b.key));

  return {
    total_events: events.length,
    events_by_event: eventsByEvent,
    sessions_by_event: sessionsByEvent,
    checkout_field_errors: analyticsSortedFieldCounts(checkoutFieldErrors),
    custom_field_errors: analyticsSortedFieldCounts(customFieldErrors),
    abandon_fields: analyticsSortedFieldCounts(abandonFields),
    top_products: sortedProducts.slice(0, 8).map((p) => ({ key: p.key, name: p.name, collection: p.collection, count: p.count })),
    product_count: sortedProducts.length
  };
}

/* Browser-side twin of analytics_summary_v2() (supabase-migrations/
   50-analytics.sql): computeAnalyticsSummary() for [fromMs, toMs) plus
   the v2 keys. allEvents may cover a wider window than [fromMs, toMs);
   the extra events are only used to find a session's traffic source on
   its earliest event (the SQL looks across the whole table for that). */
function computeAnalyticsSummaryV2(allEvents, fromMs, toMs) {
  const all = allEvents || [];
  const inWindow = all.filter((e) => {
    const t = Date.parse(e.created_at || "");
    return !Number.isNaN(t) && (fromMs == null || t >= fromMs) && (toMs == null || t < toMs);
  });
  const base = computeAnalyticsSummary(inWindow);

  const newBucket = () => ({ sessions: new Set(), page_views: 0, product_views: 0, adds: 0, checkout: new Set() });
  const daily = {};
  const weekly = {};
  const monthly = {};
  const dow = {};
  const sessions = new Set();
  const checkoutSessions = new Set();
  const products = {};
  const monthProducts = {}; // month -> key -> {views, name, collection, time, id}
  const monthCollections = {}; // month -> collection -> views

  inWindow.forEach((e) => {
    const d = new Date(Date.parse(e.created_at));
    const name = e.event_name;
    sessions.add(e.session_id);
    if (name === "checkout_submitted") checkoutSessions.add(e.session_id);
    [[daily, analyticsDayKey(d)], [weekly, analyticsWeekKey(d)], [monthly, analyticsMonthKey(d)]].forEach(([map, k]) => {
      const b = map[k] || (map[k] = newBucket());
      b.sessions.add(e.session_id);
      if (name === "page_view") b.page_views += 1;
      if (name === "product_viewed") b.product_views += 1;
      if (name === "add_to_cart") b.adds += 1;
      if (name === "checkout_submitted") b.checkout.add(e.session_id);
    });
    const wd = analyticsIsoDow(d);
    const w = dow[wd] || (dow[wd] = { sessions: new Set(), events: 0 });
    w.sessions.add(e.session_id);
    w.events += 1;

    if (name === "product_viewed" || name === "add_to_cart") {
      const meta = e.metadata;
      const pName = analyticsMetaText(meta, "name");
      const collection = analyticsMetaText(meta, "collection");
      const key = analyticsMetaText(meta, "productId") || pName || "Unknown product";
      const time = analyticsTimeValue(e.created_at);
      const id = Number(e.id) || 0;
      const newer = (rec) => time > rec.time || (time === rec.time && id > rec.id);
      const p = products[key] || (products[key] = { key, views: 0, viewSessions: new Set(), adds: 0, name: null, nameAt: { time: -Infinity, id: -Infinity }, collection: null, colAt: { time: -Infinity, id: -Infinity } });
      if (name === "product_viewed") { p.views += 1; p.viewSessions.add(e.session_id); } else p.adds += 1;
      if (pName !== null && newer(p.nameAt)) { p.name = pName; p.nameAt = { time, id }; }
      if (collection !== null && newer(p.colAt)) { p.collection = collection; p.colAt = { time, id }; }
      if (name === "product_viewed") {
        const mk = analyticsMonthKey(d);
        const mp = monthProducts[mk] || (monthProducts[mk] = {});
        const r = mp[key] || (mp[key] = { key, views: 0, name: null, nameAt: { time: -Infinity, id: -Infinity }, collection: null, colAt: { time: -Infinity, id: -Infinity } });
        r.views += 1;
        if (pName !== null && newer(r.nameAt)) { r.name = pName; r.nameAt = { time, id }; }
        if (collection !== null && newer(r.colAt)) { r.collection = collection; r.colAt = { time, id }; }
        if (collection !== null) {
          const mc = monthCollections[mk] || (monthCollections[mk] = {});
          mc[collection] = (mc[collection] || 0) + 1;
        }
      }
    }
  });

  // Session -> traffic_source of its earliest event that has one.
  const firstSource = {};
  all.forEach((e) => {
    if (!sessions.has(e.session_id)) return;
    const meta = e.metadata;
    const src = meta && typeof meta === "object" && typeof meta.traffic_source === "string" && meta.traffic_source !== "" ? meta.traffic_source.toLowerCase() : null;
    if (src === null) return;
    const time = analyticsTimeValue(e.created_at);
    const id = Number(e.id) || 0;
    const cur = firstSource[e.session_id];
    if (!cur || time < cur.time || (time === cur.time && id < cur.id)) firstSource[e.session_id] = { src, time, id };
  });
  const sources = {};
  sessions.forEach((sid) => {
    const src = firstSource[sid] ? firstSource[sid].src : "unknown";
    const s = sources[src] || (sources[src] = { source: src, sessions: 0, checkout_sessions: 0 });
    s.sessions += 1;
    if (checkoutSessions.has(sid)) s.checkout_sessions += 1;
  });

  const bucketList = (map) => Object.keys(map).sort().map((k) => ({
    key: k, sessions: map[k].sessions.size, page_views: map[k].page_views, product_views: map[k].product_views,
    adds: map[k].adds, checkout_sessions: map[k].checkout.size
  }));
  const keyCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const productList = Object.values(products)
    .sort((a, b) => b.views - a.views || b.adds - a.adds || keyCmp(a.key, b.key));
  const monthlyProducts = [];
  Object.keys(monthProducts).sort().forEach((mk) => {
    Object.values(monthProducts[mk]).sort((a, b) => b.views - a.views || keyCmp(a.key, b.key)).slice(0, 5)
      .forEach((r) => monthlyProducts.push({ month: mk, key: r.key, name: r.name, collection: r.collection, views: r.views }));
  });
  const monthlyCollections = [];
  Object.keys(monthCollections).sort().forEach((mk) => {
    Object.entries(monthCollections[mk]).sort((a, b) => b[1] - a[1] || keyCmp(a[0], b[0])).slice(0, 3)
      .forEach(([collection, views]) => monthlyCollections.push({ month: mk, collection, views }));
  });

  return {
    ...base,
    version: 2,
    timezone: analyticsTimezone(),
    sessions_total: sessions.size,
    daily: bucketList(daily),
    weekly: bucketList(weekly),
    monthly: bucketList(monthly),
    dow: Object.keys(dow).map(Number).sort((a, b) => a - b).map((d) => ({ dow: d, sessions: dow[d].sessions.size, events: dow[d].events })),
    sources: Object.values(sources).sort((a, b) => b.sessions - a.sessions || keyCmp(a.source, b.source)),
    products: productList.slice(0, 30).map((p) => ({ key: p.key, name: p.name, collection: p.collection, views: p.views, view_sessions: p.viewSessions.size, adds: p.adds })),
    products_total: productList.length,
    monthly_products: monthlyProducts,
    monthly_collections: monthlyCollections
  };
}

/* ===== Report: everything the panel and the CSV show, as plain data ===== */

/* Funnel steps in order. "__sessions" = every session with any event.
   A step with zero sessions while a LATER step has some can't be real
   (nobody reaches checkout without the cart), so it means that event
   isn't being tracked — it's left out and listed in `omitted`. */
const ANALYTICS_FUNNEL_STEPS = [
  ["__sessions", "Visited the site"],
  ["product_viewed", "Viewed a product"],
  ["add_to_cart", "Added to cart"],
  ["cart_opened", "Opened the cart"],
  ["checkout_started", "Started checkout"],
  ["checkout_submitted", "Placed an order"]
];

function analyticsFunnel(summary) {
  const sbe = (summary && summary.sessions_by_event) || {};
  const sessionsTotal = summary && summary.sessions_total != null ? summary.sessions_total : (sbe.page_view || 0);
  const raw = ANALYTICS_FUNNEL_STEPS.map(([key, label]) => ({ key, label, count: key === "__sessions" ? sessionsTotal : (sbe[key] || 0) }));
  const steps = [];
  const omitted = [];
  raw.forEach((step, i) => {
    const laterHasData = raw.slice(i + 1).some((s) => s.count > 0);
    if (i > 0 && step.count === 0 && laterHasData) omitted.push(step.label);
    else steps.push(step);
  });
  const first = steps.length ? steps[0].count : 0;
  steps.forEach((step, i) => {
    step.ofPrev = i === 0 ? null : (steps[i - 1].count ? step.count / steps[i - 1].count : null);
    step.ofFirst = first ? step.count / first : null;
  });
  return { steps, omitted };
}

function analyticsBucketMap(list) {
  const map = {};
  (list || []).forEach((row) => { map[row.key] = row; });
  return map;
}

function buildAnalyticsReport({ win, summary, prevSummary, seasonSummary, orders, ordersError, usedFallback, now }) {
  const catalog = analyticsCatalog();
  const s = summary || {};
  const bucket = win.bucket;
  const bucketOf = bucket === "week" ? analyticsWeekKey : analyticsDayKey;

  const curOrders = summarizeAnalyticsOrders(orders, win.fromMs, win.toMs, bucketOf, catalog);
  const prevOrders = win.prevFromMs != null ? summarizeAnalyticsOrders(orders, win.prevFromMs, win.prevToMs, null, catalog) : null;
  const seasonOrders = summarizeAnalyticsOrders(orders, win.seasonFromMs, win.seasonToMs, analyticsMonthKey, catalog);

  // ---- Trend buckets ----
  const eventBuckets = analyticsBucketMap(bucket === "week" ? s.weekly : s.daily);
  let trendFrom = win.fromMs;
  if (trendFrom == null) {
    // All time: start at the first bucket that has any data.
    const firstKeys = Object.keys(eventBuckets).concat(Object.keys(curOrders.buckets)).sort();
    trendFrom = firstKeys.length ? analyticsKeyToDate(firstKeys[0]).getTime() : win.toMs - 7 * ANALYTICS_DAY_MS;
  }
  // Don't draw empty future days for a custom range ending later than now.
  const nowMs = (now || new Date()).getTime();
  const trendTo = Math.min(win.toMs, nowMs + 1);
  const keys = analyticsBucketKeys(trendFrom, trendTo, bucket);
  const trend = keys.map((k) => ({
    key: k,
    label: analyticsDayLabel(k, false),
    tipLabel: bucket === "week" ? `Week of ${analyticsDayLabel(k, true)}` : analyticsDayLabel(k, true),
    sessions: eventBuckets[k] ? eventBuckets[k].sessions : 0,
    orders: curOrders.buckets[k] ? curOrders.buckets[k].orders : 0,
    revenue: curOrders.buckets[k] ? curOrders.buckets[k].revenue : 0
  }));

  // ---- KPIs ----
  const sessions = s.sessions_total || 0;
  const prevSessions = prevSummary ? prevSummary.sessions_total || 0 : null;
  const conv = sessions ? curOrders.count / sessions : null;
  const prevConv = prevOrders && prevSessions ? prevOrders.count / prevSessions : null;
  const kpis = [
    { key: "revenue", label: "Revenue", value: curOrders.revenue, display: analyticsMoney(curOrders.revenue), prev: prevOrders ? prevOrders.revenue : null, mode: "pct", spark: trend.map((t) => t.revenue), color: ANALYTICS_COLORS.revenue, note: "Non-cancelled orders" },
    { key: "orders", label: "Orders", value: curOrders.count, display: analyticsInt(curOrders.count), prev: prevOrders ? prevOrders.count : null, mode: "pct", spark: trend.map((t) => t.orders), color: ANALYTICS_COLORS.orders, note: curOrders.cancelled ? `${curOrders.cancelled} cancelled not counted` : "" },
    { key: "aov", label: "Avg order value", value: curOrders.aov, display: analyticsMoney(curOrders.aov), prev: prevOrders ? prevOrders.aov : null, mode: "pct", spark: null, color: ANALYTICS_COLORS.revenue, note: curOrders.priced < curOrders.count ? `${curOrders.priced} of ${curOrders.count} orders have a price` : "" },
    { key: "conversion", label: "Conversion rate", value: conv, display: conv == null ? "n/a" : analyticsPct(curOrders.count, sessions, 2), prev: prevConv, mode: "pts", spark: null, color: ANALYTICS_COLORS.orders, note: "Orders ÷ sessions" },
    { key: "sessions", label: "Sessions", value: sessions, display: analyticsInt(sessions), prev: prevSessions, mode: "pct", spark: trend.map((t) => t.sessions), color: ANALYTICS_COLORS.sessions, note: "Browser visits" }
  ].map((k) => ({ ...k, delta: analyticsDelta(k.value, k.prev, k.mode) }));

  // ---- Sources (sessions from events, orders/revenue from orders.source) ----
  const srcMap = {};
  const srcRow = (src) => srcMap[src] || (srcMap[src] = { source: src, label: analyticsSourceLabel(src), sessions: 0, checkouts: 0, orders: 0, revenue: 0 });
  (s.sources || []).forEach((r) => { const row = srcRow(r.source); row.sessions = r.sessions || 0; row.checkouts = r.checkout_sessions || 0; });
  Object.entries(curOrders.sources).forEach(([src, v]) => { const row = srcRow(src); row.orders = v.orders; row.revenue = v.revenue; });
  const sources = Object.values(srcMap).sort((a, b) => b.sessions - a.sessions || b.orders - a.orders || (a.source < b.source ? -1 : 1));
  const sourcesTracked = (s.sources || []).some((r) => r.source !== "unknown");
  const orderSourcesTracked = Object.keys(curOrders.sources).some((k) => k !== "unknown");

  // ---- Products (views/adds from events, sales from order lines) ----
  const prodMap = {};
  (s.products || []).forEach((p) => {
    prodMap[p.key] = { key: p.key, name: p.name || (catalog.byId.get(p.key) || {}).name || p.key, collection: p.collection || "", views: p.views || 0, adds: p.adds || 0, orders: 0, qty: 0, revenue: 0 };
  });
  Object.values(curOrders.products).forEach((p) => {
    const row = prodMap[p.key] || (prodMap[p.key] = { key: p.key, name: p.name, collection: p.collection || "", views: 0, adds: 0, orders: 0, qty: 0, revenue: 0 });
    row.orders = p.orders;
    row.qty = p.qty;
    row.revenue = p.revenue;
    if (!row.collection && p.collection) row.collection = p.collection;
  });
  const products = Object.values(prodMap)
    .map((p) => ({ ...p, collectionLabel: analyticsCollectionLabel(catalog, p.collection), viewToCart: p.views ? p.adds / p.views : null }))
    .sort((a, b) => b.revenue - a.revenue || b.qty - a.qty || b.views - a.views || b.adds - a.adds || (a.name < b.name ? -1 : 1))
    .slice(0, 20);

  // ---- Seasonality: last 12 calendar months ----
  const ss = seasonSummary || {};
  const seasonEvents = analyticsBucketMap(ss.monthly);
  const monthKeys = analyticsMonthKeys(win.seasonFromMs, 12);
  const topOf = (obj) => {
    const entries = Object.entries(obj || {}).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    return entries.length ? entries[0][0] : "";
  };
  const months = monthKeys.map((k) => {
    const ob = seasonOrders.buckets[k];
    const viewProducts = (ss.monthly_products || []).filter((r) => r.month === k);
    const viewCollections = (ss.monthly_collections || []).filter((r) => r.month === k);
    let topProduct = "";
    let topCollection = "";
    let basis = "";
    if (ob && Object.keys(ob.products).length) {
      const best = Object.values(ob.products).sort((a, b) => b.qty - a.qty || (a.name < b.name ? -1 : 1))[0];
      topProduct = best.name;
      topCollection = analyticsCollectionLabel(catalog, topOf(ob.collections));
      basis = "sold";
    } else if (viewProducts.length) {
      topProduct = viewProducts[0].name || viewProducts[0].key;
      topCollection = viewCollections.length ? analyticsCollectionLabel(catalog, viewCollections[0].collection) : "";
      basis = "viewed";
    }
    return {
      key: k,
      label: analyticsMonthLabel(k, false),
      longLabel: analyticsMonthLabel(k, true),
      sessions: seasonEvents[k] ? seasonEvents[k].sessions : 0,
      productViews: seasonEvents[k] ? seasonEvents[k].product_views : 0,
      orders: ob ? ob.orders : 0,
      revenue: ob ? ob.revenue : 0,
      topProduct, topCollection, basis
    };
  });
  const eventMonths = analyticsEventMonthCounts(orders);

  // ---- Weekday split (selected range) ----
  const dowEvents = {};
  (s.dow || []).forEach((r) => { dowEvents[r.dow] = r; });
  const weekdays = ANALYTICS_WEEKDAYS.map((label, i) => ({
    label,
    sessions: dowEvents[i + 1] ? dowEvents[i + 1].sessions : 0,
    events: dowEvents[i + 1] ? dowEvents[i + 1].events : 0,
    orders: curOrders.dow[i]
  }));

  return {
    win, bucket, usedFallback, ordersError: ordersError || null,
    totalEvents: s.total_events || 0,
    hasOrders: (orders || []).length > 0,
    kpis, trend,
    funnel: analyticsFunnel(s),
    sources, sourcesTracked, orderSourcesTracked,
    products, productsTotal: s.products_total || 0,
    months, eventMonths, weekdays,
    friction: {
      eventsByEvent: s.events_by_event || {},
      sessionsByEvent: s.sessions_by_event || {},
      abandonFields: s.abandon_fields || [],
      checkoutFieldErrors: s.checkout_field_errors || [],
      customFieldErrors: s.custom_field_errors || []
    }
  };
}

/* ===== Rendering ===== */

function funnelBarHtml(label, count, maxCount, extra) {
  const pct = maxCount > 0 ? Math.round((count / maxCount) * 100) : 0;
  return `
    <div class="analytics-funnel-row${extra ? " has-extra" : ""}">
      <span class="analytics-funnel-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
      <div class="analytics-funnel-track" aria-hidden="true"><div class="analytics-funnel-fill" style="width:${pct}%"></div></div>
      <span class="analytics-funnel-count">${analyticsInt(count)}</span>
      ${extra ? `<span class="analytics-funnel-extra">${extra}</span>` : ""}
    </div>
  `;
}

function fieldBreakdownHtml(title, counts) {
  if (!counts.length) return `<div class="analytics-card"><h3>${escapeHtml(title)}</h3><p class="empty-note">No data in this range.</p></div>`;
  const max = counts[0].count;
  return `
    <div class="analytics-card">
      <h3>${escapeHtml(title)}</h3>
      ${counts.map(({ field, count }) => funnelBarHtml(field, count, max)).join("")}
    </div>
  `;
}

/* A <table> from column specs [{ label, value: row => text, num }]. */
function analyticsTableHtml(caption, columns, rows, opts) {
  const o = opts || {};
  return `
    <div class="an-table-wrap">
      <table class="an-table">
        <caption class="${o.visibleCaption ? "" : "visually-hidden"}">${escapeHtml(caption)}</caption>
        <thead><tr>${columns.map((c) => `<th scope="col"${c.num ? ' class="num"' : ""}>${escapeHtml(c.label)}</th>`).join("")}</tr></thead>
        <tbody>${rows.length
          ? rows.map((r) => `<tr>${columns.map((c, i) => i === 0
              ? `<th scope="row">${c.html ? c.html(r) : escapeHtml(c.value(r))}</th>`
              : `<td${c.num ? ' class="num"' : ""}>${escapeHtml(c.value(r))}</td>`).join("")}</tr>`).join("")
          : `<tr><td colspan="${columns.length}" class="empty-note">No data in this range.</td></tr>`}</tbody>
      </table>
    </div>
  `;
}

function analyticsDataToggle(caption, columns, rows) {
  return `<details class="an-data"><summary>Show data table</summary>${analyticsTableHtml(caption, columns, rows)}</details>`;
}

function analyticsKpiHtml(k, prevLabel) {
  const arrow = k.delta.dir === "up" ? "▲" : k.delta.dir === "down" ? "▼" : k.delta.dir === "flat" ? "▬" : "";
  const vs = k.delta.dir === "none" ? "" : ` vs ${escapeHtml(prevLabel)}`;
  return `
    <div class="an-kpi" data-kpi="${k.key}">
      <div class="an-kpi-label">${escapeHtml(k.label)}</div>
      <div class="an-kpi-value">${escapeHtml(k.display)}</div>
      <div class="an-kpi-delta is-${k.delta.dir}">
        ${arrow ? `<span aria-hidden="true">${arrow}</span>` : ""}${k.delta.sr ? `<span class="visually-hidden">${escapeHtml(k.delta.sr)}</span>` : ""}
        <span>${escapeHtml(k.delta.text)}${vs}</span>
      </div>
      ${k.spark ? `<div class="an-kpi-spark">${AdminCharts.sparkline(k.spark, { width: 120, height: 26, color: k.color })}</div>` : ""}
      ${k.note ? `<div class="an-kpi-note">${escapeHtml(k.note)}</div>` : ""}
    </div>
  `;
}

function analyticsFunnelHtml(funnel) {
  const steps = funnel.steps;
  if (!steps.length || !steps[0].count) {
    return `<div class="analytics-card"><h3>Shopping funnel</h3><p class="empty-note">No visits in this range.</p></div>`;
  }
  const max = steps[0].count;
  return `
    <div class="analytics-card">
      <h3>Shopping funnel</h3>
      <p class="analytics-note">Sessions that reached each step. Percentages: share of the step before · share of all visits.</p>
      ${steps.map((st, i) => funnelBarHtml(st.label, st.count, max, i === 0 ? "" : `${analyticsPct(st.ofPrev == null ? 0 : st.ofPrev, st.ofPrev == null ? 0 : 1)} <span class="an-faint">· ${analyticsPct(st.ofFirst || 0, 1)}</span>`)).join("")}
      ${funnel.omitted.length ? `<p class="analytics-note">Not shown (not tracked in this range): ${escapeHtml(funnel.omitted.join(", "))}.</p>` : ""}
      ${analyticsDataToggle("Shopping funnel", [
        { label: "Step", value: (r) => r.label },
        { label: "Sessions", value: (r) => analyticsInt(r.count), num: true },
        { label: "% of previous", value: (r) => (r.ofPrev == null ? "n/a" : analyticsPct(r.ofPrev, 1)), num: true },
        { label: "% of visits", value: (r) => analyticsPct(r.ofFirst || 0, 1), num: true }
      ], steps)}
    </div>
  `;
}

function analyticsSeasonTable(months) {
  return analyticsTableHtml("Orders, revenue and top sellers by month, last 12 months", [
    { label: "Month", value: (m) => m.longLabel },
    { label: "Sessions", value: (m) => analyticsInt(m.sessions), num: true },
    { label: "Orders", value: (m) => analyticsInt(m.orders), num: true },
    { label: "Revenue", value: (m) => analyticsMoney(m.revenue), num: true },
    { label: "Top collection", value: (m) => m.topCollection || "n/a" },
    { label: "Top product", value: (m) => (m.topProduct ? `${m.topProduct}${m.basis === "viewed" ? " (most viewed)" : ""}` : "n/a") }
  ], months.slice().reverse());
}

function renderAnalyticsPanel(report) {
  const content = document.getElementById("analyticsContent");
  const r = report;
  const tips = [];
  if (r.usedFallback) tips.push("Tip: run supabase-migrations/50-analytics.sql in the Supabase SQL Editor for faster analytics (the numbers are being counted in your browser for now).");
  const ordersNote = r.ordersError
    ? `<p class="a-inline-error" role="alert">Couldn't load orders, so revenue and order numbers are missing. ${escapeHtml(r.ordersError.message)}</p>`
    : "";

  // Highlight the range chips when the range has nothing in it.
  const rangeBar = document.getElementById("analyticsRangeFilter");
  const isEmpty = !r.totalEvents && !r.hasOrders;
  if (rangeBar) rangeBar.classList.toggle("is-hint", isEmpty);
  if (isEmpty) {
    const longer = analyticsRangeDays !== "all";
    content.innerHTML = `${ordersNote}<div class="a-empty an-empty">${typeof adminIconSvg === "function" ? adminIconSvg("chart", 28) : ""}<p class="a-empty-title">No data in this range</p><p class="a-empty-text">Visits and orders show up here once the site has traffic.${longer ? " Try a longer range." : ""}</p>${longer ? `<button type="button" class="btn btn-outline btn-sm" data-an-range-jump="all">Show all time</button>` : ""}</div>${tips.map((t) => `<p class="analytics-note">${escapeHtml(t)}</p>`).join("")}`;
    return;
  }

  const prevLabel = r.win.prevLabel;
  const trendCols = [
    { label: r.bucket === "week" ? "Week of" : "Day", value: (t) => t.tipLabel.replace(/^Week of /, "") },
    { label: "Sessions", value: (t) => analyticsInt(t.sessions), num: true },
    { label: "Orders", value: (t) => analyticsInt(t.orders), num: true },
    { label: "Revenue", value: (t) => analyticsMoney(t.revenue), num: true }
  ];
  const f = r.friction;
  const customSteps = [["custom_order_started", "Started the custom-order form"], ["custom_order_submitted", "Submitted a custom-order request"]]
    .map(([name, label]) => [label, f.sessionsByEvent[name] || 0]);
  const customMax = customSteps[0][1] || 1;
  const abandonCount = f.eventsByEvent.checkout_abandoned || 0;
  const checkoutFailedCount = f.eventsByEvent.checkout_failed || 0;
  const sumTrend = (k) => r.trend.reduce((a, t) => a + t[k], 0);

  content.innerHTML = `
    ${ordersNote}
    <section class="an-kpis" aria-label="Key numbers, ${escapeHtml(r.win.label)}">
      ${r.kpis.map((k) => analyticsKpiHtml(k, prevLabel)).join("")}
    </section>

    <div class="analytics-card">
      <h3>Trends <span class="an-sub">${r.bucket === "week" ? "per week" : "per day"}</span></h3>
      <h4 class="an-chart-title">Sessions</h4>
      <div class="an-chart" data-chart="sessions"></div>
      <h4 class="an-chart-title">Orders</h4>
      <div class="an-chart" data-chart="orders"></div>
      <h4 class="an-chart-title">Revenue</h4>
      <div class="an-chart" data-chart="revenue"></div>
      ${analyticsDataToggle(`Sessions, orders and revenue ${r.bucket === "week" ? "per week" : "per day"}`, trendCols, r.trend)}
    </div>

    <div class="an-grid">
      ${analyticsFunnelHtml(r.funnel)}
      <div class="analytics-card">
        <h3>Traffic sources</h3>
        ${r.sourcesTracked ? "" : `<p class="analytics-note">Visit sources are recorded from now on (referrer and utm_ tags on the first page of each visit); older visits show as Unknown.</p>`}
        <h4 class="an-chart-title">Sessions by source</h4>
        <div class="an-chart" data-chart="src-sessions"></div>
        <h4 class="an-chart-title">Orders by source</h4>
        ${r.orderSourcesTracked ? `<div class="an-chart" data-chart="src-orders"></div>` : `<p class="analytics-note">Orders don't have a source recorded yet, so they all count as Unknown.</p>`}
        ${analyticsTableHtml("Sessions, orders and revenue by traffic source", [
          { label: "Source", value: (s) => s.label },
          { label: "Sessions", value: (s) => analyticsInt(s.sessions), num: true },
          { label: "Orders", value: (s) => analyticsInt(s.orders), num: true },
          { label: "Revenue", value: (s) => analyticsMoney(s.revenue), num: true },
          { label: "Conv.", value: (s) => (s.sessions ? analyticsPct(s.orders, s.sessions) : "n/a"), num: true }
        ], r.sources)}
      </div>
    </div>

    <div class="analytics-card">
      <h3>Top products</h3>
      <p class="analytics-note">Views and adds come from site visits; orders, quantity and revenue from each order's cart lines (cancelled orders excluded).</p>
      ${analyticsTableHtml("Top products: views, adds to cart and sales", [
        { label: "Product", value: (p) => p.name, html: (p) => `${escapeHtml(p.name)}${p.collectionLabel ? `<span class="an-cell-sub">${escapeHtml(p.collectionLabel)}</span>` : ""}` },
        { label: "Views", value: (p) => analyticsInt(p.views), num: true },
        { label: "Adds", value: (p) => analyticsInt(p.adds), num: true },
        { label: "View→cart", value: (p) => (p.viewToCart == null ? "n/a" : analyticsPct(p.adds, p.views, 0)), num: true },
        { label: "Orders", value: (p) => analyticsInt(p.orders), num: true },
        { label: "Qty", value: (p) => analyticsInt(p.qty), num: true },
        { label: "Revenue", value: (p) => analyticsMoney(p.revenue), num: true }
      ], r.products)}
      ${r.productsTotal > r.products.length ? `<p class="analytics-note">Showing the top ${r.products.length}; ${analyticsInt(r.productsTotal)} products were viewed or added in this range.</p>` : ""}
    </div>

    <div class="analytics-card">
      <h3>What's selling when <span class="an-sub">last 12 months, whatever range is picked above</span></h3>
      <div class="an-grid an-grid-tight">
        <div><h4 class="an-chart-title">Orders per month</h4><div class="an-chart" data-chart="m-orders"></div></div>
        <div><h4 class="an-chart-title">Revenue per month</h4><div class="an-chart" data-chart="m-revenue"></div></div>
      </div>
      <details class="an-data" open><summary>Month by month</summary>${analyticsSeasonTable(r.months)}</details>
      <h4 class="an-chart-title">Busy seasons: orders by event month <span class="an-sub">all years, by the date of the party</span></h4>
      ${r.eventMonths.dated
        ? `<div class="an-chart an-heat-host" data-chart="heat"></div><div class="an-heat-legend" aria-hidden="true"><span>Fewer orders</span><i class="ac-heat-0"></i><i class="ac-heat-1"></i><i class="ac-heat-2"></i><i class="ac-heat-3"></i><i class="ac-heat-4"></i><span>More orders</span></div><p class="analytics-note">${analyticsInt(r.eventMonths.dated)} non-cancelled order${r.eventMonths.dated === 1 ? "" : "s"} with an event date. Darker = busier; each cell shows its count.</p>`
        : `<p class="empty-note">No orders with an event date yet.</p>`}
      <h4 class="an-chart-title">Day of week <span class="an-sub">sessions, selected range</span></h4>
      <div class="an-chart" data-chart="dow"></div>
      ${analyticsDataToggle("Sessions, events and orders by day of week", [
        { label: "Day", value: (d) => d.label },
        { label: "Sessions", value: (d) => analyticsInt(d.sessions), num: true },
        { label: "Events", value: (d) => analyticsInt(d.events), num: true },
        { label: "Orders placed", value: (d) => analyticsInt(d.orders), num: true }
      ], r.weekdays)}
    </div>

    <div class="an-grid">
      <div class="analytics-card">
        <h3>Checkout abandoned (closed with unsaved input)</h3>
        <p class="analytics-big-number">${analyticsInt(abandonCount)}</p>
        ${f.abandonFields.length
          ? `<p class="analytics-note">Fields already filled in when people bailed, most common first:</p>${f.abandonFields.map(({ field, count }) => funnelBarHtml(field, count, f.abandonFields[0].count)).join("")}`
          : `<p class="empty-note">No abandonment data in this range.</p>`}
        ${checkoutFailedCount > 0 ? `<p class="analytics-note">${checkoutFailedCount} checkout submission${checkoutFailedCount === 1 ? "" : "s"} failed with a backend error in this range.</p>` : ""}
      </div>
      ${fieldBreakdownHtml("Checkout form: which field trips people up", f.checkoutFieldErrors)}
      <div class="analytics-card">
        <h3>Custom-order funnel</h3>
        ${customSteps.map(([label, count]) => funnelBarHtml(label, count, customMax)).join("")}
      </div>
      ${fieldBreakdownHtml("Custom-order form: which field trips people up", f.customFieldErrors)}
    </div>
    ${tips.map((t) => `<p class="analytics-note">${escapeHtml(t)}</p>`).join("")}
  `;

  // ---- Charts (rendered at their real width; re-render on resize) ----
  const C = window.AdminCharts;
  const chart = (name) => content.querySelector(`[data-chart="${name}"]`);
  const labels = r.trend.map((t) => t.label);
  const tipLabels = r.trend.map((t) => t.tipLabel);
  const per = r.bucket === "week" ? "per week" : "per day";
  C.mount(chart("sessions"), (width) => C.lineChart({
    width, height: width < 480 ? 160 : 190, labels, tipLabels,
    series: [{ name: "Sessions", values: r.trend.map((t) => t.sessions), color: ANALYTICS_COLORS.sessions }],
    format: analyticsInt, title: `Sessions ${per}`,
    desc: `${analyticsInt(sumTrend("sessions"))} sessions in total, ${r.win.label}. Peak ${analyticsInt(Math.max(0, ...r.trend.map((t) => t.sessions)))}.`
  }));
  C.mount(chart("orders"), (width) => C.lineChart({
    width, height: width < 480 ? 140 : 160, labels, tipLabels,
    series: [{ name: "Orders", values: r.trend.map((t) => t.orders), color: ANALYTICS_COLORS.orders }],
    format: analyticsInt, title: `Orders ${per}`,
    desc: `${analyticsInt(sumTrend("orders"))} orders in total, ${r.win.label}.`
  }));
  C.mount(chart("revenue"), (width) => C.barChart({
    width, height: width < 480 ? 140 : 160, labels, tipLabels, values: r.trend.map((t) => t.revenue),
    color: ANALYTICS_COLORS.revenue, format: analyticsMoney, yFormat: analyticsMoneyTick, valueName: "Revenue",
    title: `Revenue ${per}`, desc: `${analyticsMoney(sumTrend("revenue"))} in total, ${r.win.label}.`
  }));
  const topSessions = r.sources.filter((s) => s.sessions > 0).slice(0, 8);
  C.mount(chart("src-sessions"), (width) => C.barChart({
    width, horizontal: true, labels: topSessions.map((s) => s.label), values: topSessions.map((s) => s.sessions),
    color: ANALYTICS_COLORS.sessions, format: analyticsInt, valueName: "Sessions",
    title: "Sessions by traffic source", desc: topSessions.map((s) => `${s.label} ${s.sessions}`).join(", ") || "No sessions"
  }));
  if (chart("src-orders")) {
    const topOrders = r.sources.filter((s) => s.orders > 0).sort((a, b) => b.orders - a.orders).slice(0, 8);
    C.mount(chart("src-orders"), (width) => C.barChart({
      width, horizontal: true, labels: topOrders.map((s) => s.label), values: topOrders.map((s) => s.orders),
      tipLabels: topOrders.map((s) => `${s.label} · ${analyticsMoney(s.revenue)}`),
      color: ANALYTICS_COLORS.orders, format: analyticsInt, valueName: "Orders",
      title: "Orders by traffic source", desc: topOrders.map((s) => `${s.label} ${s.orders} orders, ${analyticsMoney(s.revenue)}`).join(", ") || "No orders"
    }));
  }
  const mLabels = r.months.map((m) => m.label);
  const mTips = r.months.map((m) => m.longLabel);
  C.mount(chart("m-orders"), (width) => C.barChart({
    width, height: 150, labels: mLabels, tipLabels: mTips, values: r.months.map((m) => m.orders),
    color: ANALYTICS_COLORS.orders, format: analyticsInt, valueName: "Orders", minLabelGap: 30,
    title: "Orders per month, last 12 months", desc: r.months.map((m) => `${m.longLabel} ${m.orders}`).join(", ")
  }));
  C.mount(chart("m-revenue"), (width) => C.barChart({
    width, height: 150, labels: mLabels, tipLabels: mTips, values: r.months.map((m) => m.revenue),
    color: ANALYTICS_COLORS.revenue, format: analyticsMoney, yFormat: analyticsMoneyTick, valueName: "Revenue", minLabelGap: 30,
    title: "Revenue per month, last 12 months", desc: r.months.map((m) => `${m.longLabel} ${analyticsMoney(m.revenue)}`).join(", ")
  }));
  if (chart("heat")) {
    C.mount(chart("heat"), () => C.heatStrip({
      labels: ANALYTICS_MONTHS, values: r.eventMonths.counts, valueName: "Orders",
      tipLabels: ANALYTICS_MONTHS.map((m) => `Events in ${m}`), format: analyticsInt,
      title: `Orders by event month: ${ANALYTICS_MONTHS.map((m, i) => `${m} ${r.eventMonths.counts[i]}`).join(", ")}`
    }));
  }
  C.mount(chart("dow"), (width) => C.barChart({
    width, height: 140, labels: r.weekdays.map((d) => d.label), values: r.weekdays.map((d) => d.sessions),
    tipLabels: r.weekdays.map((d) => `${d.label} · ${analyticsInt(d.orders)} order${d.orders === 1 ? "" : "s"} placed`),
    color: ANALYTICS_COLORS.sessions, format: analyticsInt, valueName: "Sessions", minLabelGap: 28,
    title: "Sessions by day of week", desc: r.weekdays.map((d) => `${d.label} ${d.sessions}`).join(", ")
  }));
}

/* ===== CSV export of the summary tables ===== */

// Same rules as the Orders tab's export: quote when needed, and neuter
// spreadsheet formula triggers (product names come from the public site).
function analyticsCsvField(value) {
  let str = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(str) && !/^[+\-\d\s().]+$/.test(str)) str = "'" + str;
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

const analyticsCsvNum = (v) => (v == null || !Number.isFinite(v) ? "" : String(Math.round(v * 100) / 100));

function buildAnalyticsCsv(report) {
  const r = report;
  const out = [];
  const row = (...cells) => out.push(cells.map(analyticsCsvField).join(","));
  const section = (title) => { if (out.length) out.push(""); row(title); };
  row("Analytics export", r.win.label, `generated ${new Date().toISOString()}`);

  section("Key numbers");
  row("Metric", "Value", "Previous period", "Change");
  r.kpis.forEach((k) => row(k.label, k.key === "conversion" ? analyticsCsvNum(k.value == null ? null : k.value * 100) + (k.value == null ? "" : "%") : analyticsCsvNum(k.value),
    k.key === "conversion" ? (k.prev == null ? "" : analyticsCsvNum(k.prev * 100) + "%") : analyticsCsvNum(k.prev),
    k.delta.dir === "none" ? "" : `${k.delta.sr} ${k.delta.text}`.trim()));

  section(`Trend (${r.bucket === "week" ? "weekly, week starting" : "daily"})`);
  row("Date", "Sessions", "Orders", "Revenue");
  r.trend.forEach((t) => row(t.key, t.sessions, t.orders, analyticsCsvNum(t.revenue)));

  section("Funnel (sessions)");
  row("Step", "Sessions", "% of previous", "% of visits");
  r.funnel.steps.forEach((s) => row(s.label, s.count, s.ofPrev == null ? "" : analyticsCsvNum(s.ofPrev * 100), s.ofFirst == null ? "" : analyticsCsvNum(s.ofFirst * 100)));
  if (r.funnel.omitted.length) row("Not tracked", r.funnel.omitted.join("; "));

  section("Traffic sources");
  row("Source", "Sessions", "Sessions that checked out", "Orders", "Revenue");
  r.sources.forEach((s) => row(s.source, s.sessions, s.checkouts, s.orders, analyticsCsvNum(s.revenue)));

  section("Top products");
  row("Product", "Product key", "Collection", "Views", "Adds to cart", "View to cart %", "Orders", "Qty", "Revenue");
  r.products.forEach((p) => row(p.name, p.key, p.collectionLabel, p.views, p.adds, p.viewToCart == null ? "" : analyticsCsvNum(p.viewToCart * 100), p.orders, p.qty, analyticsCsvNum(p.revenue)));

  section("By month (last 12 months)");
  row("Month", "Sessions", "Product views", "Orders", "Revenue", "Top collection", "Top product", "Top product based on");
  r.months.forEach((m) => row(m.key, m.sessions, m.productViews, m.orders, analyticsCsvNum(m.revenue), m.topCollection, m.topProduct, m.basis));

  section("Orders by event month (all years)");
  row("Month", "Orders");
  ANALYTICS_MONTHS.forEach((m, i) => row(m, r.eventMonths.counts[i]));

  section("Day of week (selected range)");
  row("Day", "Sessions", "Events", "Orders placed");
  r.weekdays.forEach((d) => row(d.label, d.sessions, d.events, d.orders));
  return out.join("\r\n");
}

function exportAnalyticsCsv() {
  if (!analyticsLastReport) {
    adminToast("Nothing to export yet. Wait for the analytics to finish loading.", { kind: "info" });
    return;
  }
  const blob = new Blob(["﻿" + buildAnalyticsCsv(analyticsLastReport)], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `analytics-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* Deletes analytics_events rows older than the cutoff picked in the
   "Clear old events" select. Always counts the exact rows that WOULD be
   deleted first (a head-only, count:"exact" select — no rows fetched) so
   the confirmation dialog states a real number instead of a vague warning,
   and skips the confirm entirely when there's nothing to delete. The
   button/select are disabled for the whole count+delete round trip so a
   fast double-click can't fire two deletes. */
async function clearOldAnalyticsEvents() {
  const select = document.getElementById("analyticsClearRange");
  const btn = document.getElementById("analyticsClearBtn");
  const statusEl = document.getElementById("analyticsClearStatus");
  const days = Number(select.value);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffIso = cutoff.toISOString();
  const cutoffDateLabel = cutoffIso.slice(0, 10);

  statusEl.textContent = "";
  statusEl.className = "form-status";
  btn.disabled = true;
  select.disabled = true;

  const client = getSupabaseClient();
  const { count, error: countError } = await client
    .from("analytics_events")
    .select("id", { count: "exact", head: true })
    .lt("created_at", cutoffIso);

  if (countError) {
    btn.disabled = false;
    select.disabled = false;
    adminToast("Couldn't clear events: " + countError.message, { kind: "error" });
    return;
  }

  if (!count) {
    btn.disabled = false;
    select.disabled = false;
    statusEl.textContent = "No events older than that to clear.";
    return;
  }

  const confirmed = await adminConfirm({
    title: `Delete ${count.toLocaleString()} analytics event${count === 1 ? "" : "s"}?`,
    message: `This permanently deletes ${count.toLocaleString()} analytics event${count === 1 ? "" : "s"} older than ${cutoffDateLabel}. This can't be undone.`,
    confirmLabel: "Delete events",
    danger: true,
    requireText: count > 100 ? "DELETE" : undefined,
  });
  if (!confirmed) {
    btn.disabled = false;
    select.disabled = false;
    return;
  }

  // Count on the server rather than mustAffect()'s .select(), which would
  // send every deleted event back to the browser just to check it's > 0.
  let { error: deleteError, count: deletedCount } = await client
    .from("analytics_events")
    .delete({ count: "exact" })
    .lt("created_at", cutoffIso);
  if (!deleteError && !deletedCount) {
    deleteError = { message: "Nothing was deleted. Your login may have expired. Refresh the page and try again." };
  }

  btn.disabled = false;
  select.disabled = false;

  if (deleteError) {
    adminToast("Couldn't clear events: " + deleteError.message, { kind: "error" });
    return;
  }

  statusEl.textContent = `Cleared ${count.toLocaleString()} old analytics event${count === 1 ? "" : "s"}.`;
  statusEl.className = "form-status success";
  await refreshAnalyticsPanel();
}

registerAdminTab("analytics", { btnId: "tabAnalyticsBtn", panelId: "analyticsPanel", onEnter: refreshAnalyticsPanel });

onAdminInit(() => {
  const customForm = document.getElementById("analyticsCustomRange");
  const fromInput = document.getElementById("analyticsFrom");
  const toInput = document.getElementById("analyticsTo");
  document.getElementById("analyticsRangeFilter").addEventListener("click", (e) => {
    const btn = e.target.closest(".orders-filter-btn");
    if (!btn) return;
    const range = btn.dataset.range;
    document.querySelectorAll("#analyticsRangeFilter .orders-filter-btn").forEach((b) => {
      b.classList.toggle("active", b === btn);
      b.setAttribute("aria-pressed", String(b === btn));
    });
    if (range === "custom") {
      if (customForm) {
        customForm.hidden = false;
        // Prefill with the last 30 days so Apply works straight away.
        if (!fromInput.value || !toInput.value) {
          const today = new Date();
          toInput.value = analyticsDayKey(today);
          fromInput.value = analyticsDayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29));
        }
        fromInput.focus();
      }
      return; // wait for Apply
    }
    if (customForm) customForm.hidden = true;
    analyticsRangeDays = range === "all" ? "all" : Number(range);
    refreshAnalyticsPanel();
  });
  if (customForm) {
    customForm.addEventListener("submit", (e) => {
      e.preventDefault();
      analyticsRangeDays = "custom";
      analyticsCustomRange = { from: fromInput.value, to: toInput.value };
      refreshAnalyticsPanel();
    });
  }
  // Retry (error state) and the "Show all time" shortcut (empty state).
  const contentEl = document.getElementById("analyticsContent");
  if (contentEl) {
    contentEl.addEventListener("click", (e) => {
      if (e.target.closest("[data-an-retry]")) { refreshAnalyticsPanel(); return; }
      const jump = e.target.closest("[data-an-range-jump]");
      if (jump) {
        const chip = document.querySelector(`#analyticsRangeFilter [data-range="${jump.dataset.anRangeJump}"]`);
        if (chip) chip.click();
      }
    });
  }
  const exportBtn = document.getElementById("analyticsExportBtn");
  if (exportBtn) exportBtn.addEventListener("click", exportAnalyticsCsv);
  document.getElementById("analyticsClearBtn").addEventListener("click", clearOldAnalyticsEvents);
});
