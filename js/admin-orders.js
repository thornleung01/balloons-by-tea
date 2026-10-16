/* Admin "Orders" tab: a compact, server-paged order list (status, payment,
   search, date filters pushed into the Supabase query), a slide-over
   detail drawer per order (contact, items, payment editor, status, photos,
   private notes, timeline), bulk actions, CSV export, and live updates via
   Supabase Realtime. Uses helpers from js/admin-core.js.

   Companion files (loaded after this one, see admin.html):
     js/admin-orders-messages.js  message templates (window.AdminOrderMessages)
     js/admin-orders-print.js     work order / day sheet (window.AdminOrderPrint)
     js/admin-orders-calendar.js  month calendar (window.AdminOrderCalendar)
   They call the plain helper functions below (formatOrderMoney,
   orderEventIso, openOrderDrawer, logOrderEvent, ...), which are global
   like every other top-level admin function.

   Orders v2 (supabase-migrations/10-orders-v2.sql) adds items, numeric
   totals, event_on, payments, the Quoted status and order_events. Until it
   has been run, ordersSchemaV2 is false and everything falls back to the
   old free-text columns, with a notice at the top of the tab. */

/* ===== Orders ===== */

const ORDER_STATUSES = ["new", "contacted", "quoted", "fulfilled", "cancelled"];
const ORDER_PAYMENT_STATUSES = ["unpaid", "deposit_paid", "paid", "refunded"];
const ORDER_PAYMENT_LABELS = { unpaid: "Unpaid", deposit_paid: "Deposit paid", paid: "Paid", refunded: "Refunded" };
const ORDERS_PAGE_SIZE = 50;
const ORDERS_MIGRATION_FILE = "supabase-migrations/10-orders-v2.sql";
const ORDERS_CURRENCY = "$";

let ordersStatusFilter = "all";
let ordersPaymentFilter = "all";
let ordersSearchQuery = "";
let ordersSortMode = "newest";
let ordersUpcomingOnly = false;
let ordersDateFrom = "";
let ordersDateTo = "";
let ordersPage = 0;
let ordersTotalMatching = 0;
// The rows of the current page, as last fetched.
let ordersAllCache = [];
// null = not checked yet; then true/false. See detectOrdersSchema().
let ordersSchemaV2 = null;
let ordersHasAdminNotes = null;
// Bumped on every list fetch so a slow, older response can't overwrite a
// newer one (fast typing in the search box).
let ordersFetchSeq = 0;
// Unsaved admin-note text per order id, so a re-render doesn't wipe a
// half-typed note.
const orderNoteDrafts = new Map();
// Note text currently being saved per order id — blur and the Save button
// can both fire for one edit, and the second shouldn't send it again.
const orderNoteSavesInFlight = new Map();
// Separate from selectedProductIds (Products tab). IDs as strings. Kept
// across pages, so a selection can span several pages.
let selectedOrderIds = new Set();
// The rows currently on screen, for "select all on this page".
let ordersVisibleCache = [];

// Detail drawer state.
let orderDrawerOrder = null;
let orderDrawerOpener = null;
let orderDrawerDirty = false;

/* ----- Small formatting helpers (also used by the companion files) ----- */

function orderKindLabel(kind) {
  return kind === "custom" ? "Custom order" : "Checkout";
}

function orderStatusLabel(status) {
  const s = status || "new";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function orderPaymentLabel(status) {
  return ORDER_PAYMENT_LABELS[status] || ORDER_PAYMENT_LABELS.unpaid;
}

function formatOrderDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function ordersLocalIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ordersTodayIso() {
  return ordersLocalIso(new Date());
}

function ordersNextIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1);
  return ordersLocalIso(d);
}

/* "Sat, Oct 18" (plus the year when it isn't this year). */
function friendlyOrderDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return iso || "";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const opts = { weekday: "short", month: "short", day: "numeric" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("en-US", opts);
}

/* "14:30" -> "2:30 PM"; anything else ("2-4pm") is shown as typed. */
function formatOrderTime(text) {
  const t = String(text || "").trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return t;
  const h = Number(m[1]);
  if (h > 23) return t;
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

function orderAmountNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return isFinite(n) ? n : null;
}

function formatOrderMoney(value) {
  const n = orderAmountNumber(value);
  if (n === null) return "";
  const cents = Math.round(n * 100) % 100 !== 0;
  return ORDERS_CURRENCY + n.toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 });
}

// Shown when a write touches something the live database doesn't have yet.
const ORDERS_SQL_HINT = "run it in the Supabase SQL Editor";
const ORDERS_V2_HINT = `needs ${ORDERS_MIGRATION_FILE}, ${ORDERS_SQL_HINT}`;

/* True when a Supabase error means a column doesn't exist yet — PostgREST
   PGRST204 ("Could not find the 'x' column ... in the schema cache") or
   Postgres 42703 (undefined column), with the message text as a fallback.
   Column-level counterpart of isMissingTableError() in supabase-config.js. */
function isMissingColumnError(error, column) {
  if (!error) return false;
  const msg = error.message || "";
  const mentionsColumn = !column || !msg || msg.includes(column);
  if ((error.code === "PGRST204" || error.code === "42703") && mentionsColumn) return true;
  return Boolean(column) && msg.includes(column) && /could not find the .*column|column .* does not exist/i.test(msg);
}

/* Friendlier text for a failed status write. Before the latest SQL, the
   live orders_status_check constraint doesn't allow "cancelled" (old
   setup) or "quoted" (before the orders v2 migration), so those fail with
   23514. */
function orderStatusErrorMessage(error, status) {
  const isCheck = error && (error.code === "23514" || /orders_status_check/.test(error.message || ""));
  if (status === "quoted" && isCheck) return `The Quoted status ${ORDERS_V2_HINT}.`;
  if (status === "cancelled" && isCheck) return `The Cancelled status needs the latest supabase-setup.sql, ${ORDERS_SQL_HINT}.`;
  return error.message;
}

/* The "AUR-XXXXXX" reference js/app.js attachOrderRef() prefixes onto
   summary as "Ref: AUR-XXXXXX\n...". "" for orders placed before refs
   existed. */
function orderRef(order) {
  const m = /^\s*Ref:\s*(AUR-[A-Z0-9]+)/i.exec(order.summary || "");
  return m ? m[1].toUpperCase() : "";
}

/* summary without its leading "Ref: ..." line. */
function orderSummaryBody(order) {
  return String(order.summary || "").replace(/^\s*Ref:\s*AUR-[A-Z0-9]+\s*\n?/i, "").trim();
}

/* event_date is free text — 'YYYY-MM-DD' from checkout, 'YYYY-MM-DD HH:MM'
   from custom orders — but older rows or hand edits can hold anything.
   Returns a local-time Date, or null for empty/unparseable values,
   including impossible dates like 2026-02-30. */
function parseOrderEventDate(text) {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?\s*$/.exec(text || "");
  if (!m) return null;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4] || "0", m[5] || "0"].map(Number);
  if (h > 23 || mi > 59) return null;
  const date = new Date(y, mo - 1, d, h, mi);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

/* The order's event day as 'YYYY-MM-DD': event_on when the v2 column has
   it, otherwise parsed from the legacy event_date text. "" when unknown. */
function orderEventIso(order) {
  if (order && order.event_on) return String(order.event_on).slice(0, 10);
  const d = parseOrderEventDate(order && order.event_date);
  return d ? ordersLocalIso(d) : "";
}

/* event_time, or the "HH:MM" tail of a legacy custom-order event_date. */
function orderEventTime(order) {
  if (order && order.event_time) return String(order.event_time);
  const m = /^\s*\d{4}-\d{2}-\d{2}[ T](\d{1,2}:\d{2})\s*$/.exec((order && order.event_date) || "");
  return m ? m[1] : "";
}

/* "Sat, Oct 18 · 2:00 PM", or the raw legacy text when it isn't a date. */
function orderEventLabel(order) {
  const iso = orderEventIso(order);
  const time = formatOrderTime(orderEventTime(order));
  if (!iso) return String(order.event_date || "").trim();
  return [friendlyOrderDay(iso), time].filter(Boolean).join(" · ");
}

// Compared by calendar day, so an event earlier today still counts as
// upcoming. Empty/unparseable dates never do.
function isUpcomingOrder(order) {
  const iso = orderEventIso(order);
  return Boolean(iso) && iso >= ordersTodayIso();
}

function orderItems(order) {
  return Array.isArray(order && order.items) ? order.items.filter((l) => l && typeof l === "object") : [];
}

function orderItemAddonsText(line) {
  const addons = Array.isArray(line.addons) ? line.addons : [];
  return addons.map((a) => (a && typeof a === "object" ? a.name : a)).filter(Boolean).join(", ");
}

/* One line per item: "2 x Pastel arch (Large) + LED lights". Falls back to
   the summary text for orders without structured items. */
function orderItemsText(order) {
  const items = orderItems(order);
  if (!items.length) return orderSummaryBody(order);
  return items.map((l) => {
    const variant = l.variant ? ` (${typeof l.variant === "object" ? (l.variant.name || l.variant.label || "") : l.variant})` : "";
    const addons = orderItemAddonsText(l);
    return `${l.qty || 1} x ${l.name || "Item"}${variant}${addons ? ` + ${addons}` : ""}`;
  }).join("\n");
}

function orderTotalAmount(order) {
  return orderAmountNumber(order && order.total_amount);
}

/* Total minus what's been paid, or null when there's no numeric total. */
function orderBalance(order) {
  const total = orderTotalAmount(order);
  if (total === null) return null;
  const paid = orderAmountNumber(order.amount_paid) || 0;
  return Math.max(0, Math.round((total - paid) * 100) / 100);
}

function orderHasBalanceDue(order) {
  if (!ordersSchemaV2 || !order) return false;
  if ((order.status || "new") === "cancelled") return false;
  if (order.payment_status === "paid" || order.payment_status === "refunded") return false;
  const balance = orderBalance(order);
  return balance !== null && balance > 0;
}

/* The total shown in the list: numeric when there is one, else the old
   text ("$120", "Budget: 300"). */
function orderTotalLabel(order) {
  const total = orderTotalAmount(order);
  return total !== null ? formatOrderMoney(total) : String(order.total || "");
}

/* wa.me wants the full international number as bare digits. 10 digits is
   taken as North American and gets the 1 country code; 11 digits starting
   with 1 already has it; anything else is used as given. Under 10 digits
   can't be a full number, so no button. */
function whatsAppNumber(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 10) return "";
  if (digits.length === 10) return "1" + digits;
  return digits;
}

// Built with DOM APIs (no innerHTML) since name/phone/summary are
// customer-supplied.
function buildWhatsAppLink(order, text) {
  const number = whatsAppNumber(order.phone);
  if (!number) return null;
  const firstName = String(order.name || "").trim().split(/\s+/)[0];
  const ref = orderRef(order);
  const message = text || `Hi ${firstName || "there"}! It's Balloons by Tea, following up on your ${ref ? `order ${ref}` : "balloon order"}.`;
  const a = document.createElement("a");
  a.className = "order-whatsapp-link";
  a.href = `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = "WhatsApp";
  return a;
}

/* The order with this id from the drawer or the current page, if loaded. */
function findLoadedOrder(id) {
  const key = String(id);
  if (orderDrawerOrder && String(orderDrawerOrder.id) === key) return orderDrawerOrder;
  return ordersAllCache.find((o) => String(o.id) === key) || null;
}

/* Applies a saved change to every loaded copy of an order. */
function patchLoadedOrder(id, changes) {
  const key = String(id);
  ordersAllCache.forEach((o) => { if (String(o.id) === key) Object.assign(o, changes); });
  if (orderDrawerOrder && String(orderDrawerOrder.id) === key) Object.assign(orderDrawerOrder, changes);
}

/* ----- Schema detection & notices ----- */

/* Works out once per page load whether the orders v2 migration (and the
   older admin_notes column) exist, with two tiny probes. An unrelated
   failure (offline) leaves it unknown so the next refresh tries again. */
async function detectOrdersSchema() {
  if (ordersSchemaV2 !== null && ordersHasAdminNotes !== null) return;
  const client = getSupabaseClient();
  const [v2, notes] = await Promise.all([
    ordersSchemaV2 === null ? client.from("orders").select("payment_status,event_on,items").limit(1) : Promise.resolve(null),
    ordersHasAdminNotes === null ? client.from("orders").select("admin_notes").limit(1) : Promise.resolve(null)
  ]);
  if (v2) {
    if (!v2.error) ordersSchemaV2 = true;
    else if (isMissingColumnError(v2.error)) ordersSchemaV2 = false;
  }
  if (notes) {
    if (!notes.error) ordersHasAdminNotes = true;
    else if (isMissingColumnError(notes.error, "admin_notes")) ordersHasAdminNotes = false;
  }
  renderOrdersNotices();
  const payFilter = document.getElementById("ordersPaymentFilter");
  if (payFilter) payFilter.hidden = !ordersSchemaV2;
}

let ordersLiveState = "off"; // off | connecting | live | unavailable
let ordersNewOrderNotices = []; // [{ id, name }]

function renderOrdersNotices() {
  const el = document.getElementById("ordersNotices");
  if (!el) return;
  const parts = [];
  if (ordersSchemaV2 === false) {
    parts.push(`<p class="orders-notice">Payments, the Quoted status, real event dates for the calendar and the order timeline ${escapeHtml(ORDERS_V2_HINT)}. Everything else works as before.</p>`);
  }
  ordersNewOrderNotices.forEach((n) => {
    parts.push(`<p class="orders-notice orders-notice-new">New order from <strong>${escapeHtml(n.name || "a customer")}</strong>
      <button type="button" class="orders-link-btn" data-notice-open="${escapeHtml(String(n.id))}">Open</button>
      <button type="button" class="orders-link-btn" data-notice-dismiss="${escapeHtml(String(n.id))}" aria-label="Dismiss">Dismiss</button></p>`);
  });
  if (ordersLiveState === "live") {
    parts.push(`<p class="orders-live-indicator"><span class="orders-live-dot" aria-hidden="true"></span>Live: new orders appear automatically</p>`);
  }
  el.innerHTML = parts.join("");
}

/* ----- Server-side list query ----- */

/* Characters that would break PostgREST's or=(...) filter syntax or act as
   wildcards are dropped from search words. */
function orderSearchWords() {
  return ordersSearchQuery.toLowerCase().split(/\s+/)
    .map((w) => w.replace(/[,()"'\\%*:]/g, ""))
    .filter(Boolean)
    .slice(0, 6);
}

/* Adds every active filter except paging/sort to a query. `skipStatus`
   leaves the status filter off (used for the per-status counts). */
function applyOrderFilters(query, { skipStatus = false, skipPayment = false } = {}) {
  let q = query;
  if (!skipStatus && ordersStatusFilter !== "all") q = q.eq("status", ordersStatusFilter);
  if (!skipPayment && ordersSchemaV2 && ordersPaymentFilter !== "all") q = applyPaymentFilter(q, ordersPaymentFilter);
  const columns = ["name", "phone", "email", "address", "notes", "summary"];
  if (ordersHasAdminNotes) columns.push("admin_notes");
  orderSearchWords().forEach((word) => {
    const ors = columns.map((c) => `${c}.ilike.%${word}%`);
    // "4165551234" should find "(416) 555-1234": match the digits in order
    // with anything between them.
    const digits = word.replace(/\D/g, "");
    if (/^[\d\s()+\-.]+$/.test(word) && digits.length >= 3) ors.push(`phone.ilike.%${digits.split("").join("%")}%`);
    q = q.or(ors.join(","));
  });
  const today = ordersTodayIso();
  const dateCol = ordersSchemaV2 ? "event_on" : "event_date";
  if (ordersUpcomingOnly) q = q.gte(dateCol, today);
  if (ordersDateFrom) q = q.gte(dateCol, ordersDateFrom);
  if (ordersDateTo) q = ordersSchemaV2 ? q.lte("event_on", ordersDateTo) : q.lt("event_date", ordersNextIso(ordersDateTo));
  return q;
}

/* "Balance due" = still owes money: unpaid or deposit paid, has a total,
   not cancelled. (The exact balance is checked per row; the database
   can't compare total_amount with amount_paid in a filter.) */
function applyPaymentFilter(query, filter) {
  if (filter === "balance_due") {
    return query.in("payment_status", ["unpaid", "deposit_paid"]).neq("status", "cancelled").gt("total_amount", 0);
  }
  return query.eq("payment_status", filter);
}

function applyOrderSort(query) {
  if (ordersSortMode === "oldest") return query.order("created_at", { ascending: true });
  if (ordersSortMode === "event") {
    const col = ordersSchemaV2 ? "event_on" : "event_date";
    return query.order(col, { ascending: true, nullsFirst: false }).order("created_at", { ascending: false });
  }
  return query.order("created_at", { ascending: false });
}

function buildOrdersPageQuery() {
  const client = getSupabaseClient();
  // select("*") rather than a column list so loading keeps working on a
  // database without the newer columns.
  let q = client.from("orders").select("*", { count: "exact" });
  q = applyOrderSort(applyOrderFilters(q));
  const from = ordersPage * ORDERS_PAGE_SIZE;
  return q.range(from, from + ORDERS_PAGE_SIZE - 1);
}

/* Per-status and per-payment counts for the filter pills, plus the tab
   badge (new orders). Head-only count queries, so no rows are downloaded.
   The counts ignore search/date filters: they answer "how many orders are
   New", not "how many match what I typed". */
async function refreshOrderCounts() {
  const client = getSupabaseClient();
  const head = () => client.from("orders").select("id", { count: "exact", head: true });
  const statusKeys = ["all", ...ORDER_STATUSES];
  const payKeys = ordersSchemaV2 ? ["balance_due", "unpaid", "deposit_paid", "paid"] : [];
  const results = await Promise.all([
    ...statusKeys.map((s) => (s === "all" ? head() : head().eq("status", s))),
    ...payKeys.map((p) => applyPaymentFilter(head(), p))
  ]);
  results.slice(0, statusKeys.length).forEach((res, i) => {
    const el = document.querySelector(`#ordersFilter .orders-filter-count[data-count-for="${statusKeys[i]}"]`);
    if (el) el.textContent = res.error || res.count == null ? "" : String(res.count);
  });
  results.slice(statusKeys.length).forEach((res, i) => {
    const el = document.querySelector(`#ordersPaymentFilter .orders-filter-count[data-pay-count-for="${payKeys[i]}"]`);
    if (el) el.textContent = res.error || res.count == null ? "" : String(res.count);
  });
  const newRes = results[statusKeys.indexOf("new")];
  const badge = document.getElementById("ordersBadge");
  if (badge && newRes && !newRes.error) {
    if (newRes.count > 0) {
      badge.textContent = String(newRes.count);
      show(badge);
    } else {
      hide(badge);
    }
  }
}

/* Re-fetches the current page (and the counts). Called on tab entry, by
   every filter/search/page change, after each save, and (debounced) by
   Realtime. opts.skipCounts avoids the count queries for pure paging. */
async function refreshOrderList(opts) {
  const options = opts || {};
  const client = getSupabaseClient();
  const listEl = document.getElementById("orderList");
  if (!client || !listEl) return;
  await detectOrdersSchema();
  startOrdersRealtime();
  if (!options.skipCounts) refreshOrderCounts().catch(() => {});

  const seq = ++ordersFetchSeq;
  // Skeleton rows only when no rows are on screen yet (first load, or after
  // an empty/error state); a refresh keeps the current rows in place.
  if (!listEl.querySelector(".order-row:not(.order-row-skeleton)")) renderOrderListLoading(listEl);
  listEl.setAttribute("aria-busy", "true");
  let { data, error, count } = await runOrdersPageQuery();
  if (error && ordersHasAdminNotes && isMissingColumnError(error, "admin_notes")) {
    ordersHasAdminNotes = false;
    ({ data, error, count } = await runOrdersPageQuery());
  }
  if (seq !== ordersFetchSeq) return;
  listEl.removeAttribute("aria-busy");

  if (error) {
    // Asking for a page past the end (rows deleted elsewhere) is a 416.
    if (ordersPage > 0 && (error.code === "PGRST103" || /range/i.test(error.message || ""))) {
      ordersPage = 0;
      return refreshOrderList({ skipCounts: true });
    }
    renderOrderListError(listEl, error);
    return;
  }

  ordersAllCache = data || [];
  ordersTotalMatching = typeof count === "number" ? count : ordersAllCache.length;
  if (!ordersAllCache.length && ordersPage > 0 && ordersTotalMatching > 0) {
    ordersPage = Math.max(0, Math.ceil(ordersTotalMatching / ORDERS_PAGE_SIZE) - 1);
    return refreshOrderList({ skipCounts: true });
  }

  renderOrderList();
  renderOrdersPager();
  checkOrderPhotosSchema();
  if (ordersView === "calendar" && window.AdminOrderCalendar && !options.skipCalendar) window.AdminOrderCalendar.refresh();
}

/* ----- List rendering ----- */

/* Badges: the shared .a-badge with a domain colour pair from
   css/admin-tokens.css (--a-status-<name>). The label always says the state. */
const ORDER_PAYMENT_BADGE = { unpaid: "unpaid", deposit_paid: "deposit", paid: "paid", refunded: "refunded" };

function orderStatusPill(status) {
  const s = ORDER_STATUSES.includes(status) ? status : "new";
  return `<span class="a-badge a-badge--status-${s} order-badge">${escapeHtml(orderStatusLabel(s))}</span>`;
}

function orderPaymentPill(order) {
  if (!ordersSchemaV2) return "";
  const p = ORDER_PAYMENT_STATUSES.includes(order.payment_status) ? order.payment_status : "unpaid";
  return `<span class="a-badge a-badge--status-${ORDER_PAYMENT_BADGE[p]} order-badge">${escapeHtml(orderPaymentLabel(p))}</span>`;
}

function orderBalancePill(order) {
  if (!orderHasBalanceDue(order)) return "";
  return `<span class="a-badge a-badge--status-balance order-badge" title="Balance due">Due ${escapeHtml(formatOrderMoney(orderBalance(order)))}</span>`;
}

/* "Today", "Tomorrow", "In 3 days" for events inside the next week; "" otherwise. */
function orderRelativeDay(iso) {
  if (!iso) return "";
  const today = ordersTodayIso();
  if (iso === today) return "Today";
  if (iso < today) return "";
  const days = Math.round((new Date(iso + "T00:00:00") - new Date(today + "T00:00:00")) / 86400000);
  if (days === 1) return "Tomorrow";
  return days <= 6 ? `In ${days} days` : "";
}

/* ----- List states: loading, error, empty ----- */

function renderOrderListLoading(listEl) {
  const row = `<div class="order-row order-row-compact order-row-skeleton" aria-hidden="true">
    <span class="a-skeleton order-skel-check"></span>
    <span class="order-row-main"><span class="a-skeleton a-skeleton--line order-skel-name"></span><span class="a-skeleton a-skeleton--line order-skel-meta"></span></span>
    <span class="order-row-pills"><span class="a-skeleton a-skeleton--pill"></span><span class="a-skeleton a-skeleton--pill"></span></span>
    <span class="a-skeleton a-skeleton--line order-skel-total"></span>
  </div>`;
  listEl.innerHTML = `<div role="status"><span class="a-visually-hidden">Loading orders</span>${row.repeat(6)}</div>`;
}

function renderOrderListError(listEl, error) {
  listEl.removeAttribute("aria-busy");
  ordersAllCache = [];
  ordersVisibleCache = [];
  const countEl = document.getElementById("ordersResultCount");
  if (countEl) countEl.textContent = "";
  const pagerEl = document.getElementById("ordersPager");
  if (pagerEl) pagerEl.innerHTML = "";
  listEl.innerHTML = `<div class="a-panel-error" role="alert">
    <p class="a-panel-error-title">Couldn't load orders</p>
    <p class="a-panel-error-text">${escapeHtml((error && error.message) || String(error || "Something went wrong."))} Check your connection and try again.</p>
    <button type="button" class="btn btn-outline btn-sm" data-orders-retry>Try again</button>
  </div>`;
  syncOrderBulkSelectionUI([]);
}

async function runOrdersPageQuery() {
  try {
    return await buildOrdersPageQuery();
  } catch (err) {
    return { data: null, count: null, error: err };
  }
}

/* Puts every filter back to its default and reloads. Also used by the
   "Clear filters" button in the no-matches state. */
function clearAllOrderFilters() {
  ordersStatusFilter = "all";
  ordersPaymentFilter = "all";
  ordersSearchQuery = "";
  ordersUpcomingOnly = false;
  ordersDateFrom = "";
  ordersDateTo = "";
  const setValue = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  setValue("orderSearch", "");
  setValue("orderDateFrom", "");
  setValue("orderDateTo", "");
  const upcoming = document.getElementById("orderUpcomingOnly");
  if (upcoming) upcoming.checked = false;
  const toEl = document.getElementById("orderDateTo");
  if (toEl) toEl.removeAttribute("min");
  const clearDates = document.getElementById("orderDateClear");
  if (clearDates) clearDates.hidden = true;
  setOrderChipActive("#ordersFilter", "status", "all");
  setOrderChipActive("#ordersPaymentFilter", "payment", "all");
  resetOrdersPagingAndRefresh();
}

/* Marks one chip in a filter group active (class + aria-pressed). */
function setOrderChipActive(groupSelector, dataKey, value) {
  document.querySelectorAll(`${groupSelector} .orders-filter-btn`).forEach((b) => {
    const on = b.dataset[dataKey] === value;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
}

function orderListEmptyHtml() {
  const hasSearchOrDates = orderSearchWords().length || ordersUpcomingOnly || ordersDateFrom || ordersDateTo || ordersPaymentFilter !== "all";
  const icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5l9-4.5 9 4.5v9l-9 4.5-9-4.5z"/><path d="M3 7.5l9 4.5 9-4.5M12 12v9"/></svg>`;
  if (hasSearchOrDates) {
    return `<div class="a-empty">${icon}
      <p class="a-empty-title">No orders match</p>
      <p class="a-empty-text">Nothing fits the current search and filters. Clear them to see every order again.</p>
      <button type="button" class="btn btn-outline btn-sm" data-orders-clear-filters>Clear filters</button>
    </div>`;
  }
  if (ordersStatusFilter !== "all") {
    return `<div class="a-empty">${icon}
      <p class="a-empty-title">No ${escapeHtml(orderStatusLabel(ordersStatusFilter).toLowerCase())} orders</p>
      <p class="a-empty-text">No order is marked ${escapeHtml(orderStatusLabel(ordersStatusFilter).toLowerCase())} right now.</p>
      <button type="button" class="btn btn-outline btn-sm" data-orders-clear-filters>Show all orders</button>
    </div>`;
  }
  return `<div class="a-empty">${icon}
    <p class="a-empty-title">No orders yet</p>
    <p class="a-empty-text">Orders from checkout and the custom order form appear here as soon as a customer places one. You will see a notice when a new one arrives.</p>
    <a class="btn btn-outline btn-sm" href="index.html" target="_blank" rel="noopener">View your site</a>
  </div>`;
}

function renderOrderList() {
  const listEl = document.getElementById("orderList");
  // The legacy schema can't filter "upcoming" exactly in the query (free
  // text dates), so finish the job here.
  let visible = ordersAllCache;
  if (ordersUpcomingOnly && !ordersSchemaV2) visible = visible.filter(isUpcomingOrder);
  ordersVisibleCache = visible;

  if (!visible.length) {
    listEl.innerHTML = orderListEmptyHtml();
    syncOrderBulkSelectionUI([]);
    return;
  }

  const today = ordersTodayIso();
  listEl.innerHTML = visible.map((order) => {
    const status = order.status || "new";
    const id = escapeHtml(String(order.id));
    const ref = orderRef(order);
    const eventIso = orderEventIso(order);
    const eventLabel = orderEventLabel(order);
    const when = orderRelativeDay(eventIso);
    const photos = orderAttachmentPaths(order).length;
    const name = order.name || "(no name)";
    const total = orderTotalLabel(order);
    const past = Boolean(eventIso) && eventIso < today;
    return `
    <div class="order-row order-row-compact status-${escapeHtml(status)}${past ? " is-past" : ""}" data-id="${id}">
      <label class="order-select-wrap"><input type="checkbox" class="order-select" data-select-id="${id}" aria-label="Select order from ${escapeHtml(order.name || "customer")}" ${selectedOrderIds.has(String(order.id)) ? "checked" : ""}/></label>
      <button type="button" class="order-row-main" data-open-id="${id}" aria-label="Open order from ${escapeHtml(order.name || "customer")}">
        <span class="order-row-line1">
          <strong class="order-row-name" title="${escapeHtml(name)}">${escapeHtml(name)}</strong>
          ${ref ? `<span class="order-row-ref">${escapeHtml(ref)}</span>` : ""}
        </span>
        <span class="order-row-line2">
          <span class="order-row-event">${eventLabel ? escapeHtml(eventLabel) : "No event date"}${when ? ` <span class="order-row-when">${escapeHtml(when)}</span>` : ""}</span>
          <span class="order-row-tags">
            <span class="a-badge a-badge--xs a-badge--neutral a-badge--outline order-kind-tag">${escapeHtml(orderKindLabel(order.kind))}</span>
            ${order.fulfillment === "pickup" ? `<span class="order-row-meta">Pick-up</span>` : ""}
            ${photos ? `<span class="order-row-meta">${photos} photo${photos === 1 ? "" : "s"}</span>` : ""}
          </span>
        </span>
      </button>
      <span class="order-row-pills">${orderStatusPill(status)}${orderPaymentPill(order)}${orderBalancePill(order)}</span>
      ${total ? `<span class="order-row-total" title="${escapeHtml(total)}">${escapeHtml(total)}</span>` : `<span class="order-row-total is-empty" aria-label="No total"><span aria-hidden="true">&ndash;</span></span>`}
    </div>`;
  }).join("");

  listEl.querySelectorAll(".order-select").forEach((box) => {
    box.addEventListener("change", () => {
      if (box.checked) selectedOrderIds.add(box.dataset.selectId);
      else selectedOrderIds.delete(box.dataset.selectId);
      syncOrderBulkSelectionUI(ordersVisibleCache);
    });
  });
  syncOrderBulkSelectionUI(visible);
}

function renderOrdersPager() {
  const el = document.getElementById("ordersPager");
  if (!el) return;
  const countEl = document.getElementById("ordersResultCount");
  if (countEl) countEl.textContent = ordersTotalMatching ? `${ordersTotalMatching} order${ordersTotalMatching === 1 ? "" : "s"}` : "";
  const pages = Math.max(1, Math.ceil(ordersTotalMatching / ORDERS_PAGE_SIZE));
  if (ordersTotalMatching <= ORDERS_PAGE_SIZE && ordersPage === 0) {
    el.innerHTML = "";
    return;
  }
  const from = ordersPage * ORDERS_PAGE_SIZE + 1;
  const to = Math.min(ordersTotalMatching, from + ORDERS_PAGE_SIZE - 1);
  el.innerHTML = `
    <button type="button" class="orders-export-btn" data-page="prev" ${ordersPage === 0 ? "disabled" : ""}>&lsaquo; Newer</button>
    <span class="orders-pager-info">${from}–${to} of ${ordersTotalMatching} · page ${ordersPage + 1} of ${pages}</span>
    <button type="button" class="orders-export-btn" data-page="next" ${ordersPage >= pages - 1 ? "disabled" : ""}>Older &rsaquo;</button>`;
}

function resetOrdersPagingAndRefresh() {
  ordersPage = 0;
  refreshOrderList({ skipCounts: true });
}

/* ----- Status & delete ----- */

async function handleOrderStatusChange(id, status) {
  const client = getSupabaseClient();
  const { error } = await mustAffect(client.from("orders").update({ status }).eq("id", id));
  if (error) {
    adminToast("Couldn't update status: " + orderStatusErrorMessage(error, status), { kind: "error" });
    if (orderDrawerOrder && String(orderDrawerOrder.id) === String(id)) renderOrderDrawer();
    return false;
  }
  patchLoadedOrder(id, { status });
  await refreshOrderList();
  if (orderDrawerOrder && String(orderDrawerOrder.id) === String(id)) {
    renderOrderDrawerHeader();
    loadOrderTimeline(orderDrawerOrder);
  }
  return true;
}

async function handleDeleteOrder(id) {
  const order = findLoadedOrder(id);
  const photoCount = order ? orderAttachmentPaths(order).length : 0;
  const photoNote = photoCount ? ` Its ${photoCount === 1 ? "photo" : `${photoCount} photos`} will be deleted too.` : "";
  const who = order ? [orderRef(order), order.name].filter(Boolean).join(" - ") : "";
  if (!(await adminConfirm({ title: who ? `Delete order ${who}?` : "Delete this order?", message: `${photoNote} This can't be undone.`.trim(), confirmLabel: "Delete order", danger: true }))) return false;
  const client = getSupabaseClient();
  const { data, error } = await mustAffect(client.from("orders").delete().eq("id", id));
  if (error) {
    adminToast("Couldn't delete: " + error.message, { kind: "error" });
    return false;
  }
  selectedOrderIds.delete(String(id));
  orderNoteDrafts.delete(String(id));
  const photoProblem = await removeOrderPhotoFiles(data || []);
  await refreshOrderList();
  if (photoProblem) adminToast("The order was deleted, but " + photoProblem, { kind: "error", duration: 12000 });
  return true;
}

/* ----- Private admin notes ----- */

function setOrderNoteStatus(id, message, kind) {
  const el = document.querySelector(`.order-admin-notes[data-notes-for="${CSS.escape(id)}"] .order-admin-notes-status`);
  if (!el) return;
  el.textContent = message;
  el.className = "form-status order-admin-notes-status" + (kind ? " " + kind : "");
}

/* Private per-order notes (orders.admin_notes). Saves on blur and on the
   Save button; the in-flight map stops the blur+click pair from saving
   the same text twice. */
async function saveOrderAdminNote(id, value, explicit) {
  const cached = findLoadedOrder(id);
  const saved = (cached && cached.admin_notes) || "";
  if (value === saved) {
    orderNoteDrafts.delete(id);
    if (explicit) setOrderNoteStatus(id, "No changes to save.", "");
    return;
  }
  if (orderNoteSavesInFlight.get(id) === value) return;
  orderNoteSavesInFlight.set(id, value);
  setOrderNoteStatus(id, "Saving...", "");
  const client = getSupabaseClient();
  const { error } = await mustAffect(client.from("orders").update({ admin_notes: value }).eq("id", id));
  orderNoteSavesInFlight.delete(id);
  if (error) {
    // The draft is kept, so the text isn't lost and the next blur retries.
    setOrderNoteStatus(id, isMissingColumnError(error, "admin_notes")
      ? `Admin notes need the latest supabase-setup.sql, ${ORDERS_SQL_HINT}.`
      : "Couldn't save note: " + error.message, "error");
    return;
  }
  patchLoadedOrder(id, { admin_notes: value });
  if (orderNoteDrafts.get(id) === value) orderNoteDrafts.delete(id);
  const textarea = document.getElementById(`orderAdminNotes-${id}`);
  if (textarea && textarea.value !== value) setOrderNoteStatus(id, "Unsaved changes", "");
  else setOrderNoteStatus(id, "Saved", "success");
}

function buildOrderAdminNotes(order) {
  const id = String(order.id);
  const saved = order.admin_notes || "";
  const wrap = document.createElement("div");
  wrap.className = "order-admin-notes";
  wrap.dataset.notesFor = id;

  const label = document.createElement("label");
  label.htmlFor = `orderAdminNotes-${id}`;
  label.textContent = "Private notes (only admins see these)";

  const textarea = document.createElement("textarea");
  textarea.id = `orderAdminNotes-${id}`;
  textarea.className = "order-admin-notes-input";
  textarea.rows = 3;
  textarea.placeholder = "Colour changes, follow-up reminders, set-up details...";
  textarea.value = orderNoteDrafts.has(id) ? orderNoteDrafts.get(id) : saved;

  const actions = document.createElement("div");
  actions.className = "order-admin-notes-actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "order-admin-notes-save";
  saveBtn.textContent = "Save note";
  const status = document.createElement("span");
  status.className = "form-status order-admin-notes-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  if (textarea.value !== saved) status.textContent = "Unsaved changes";
  actions.append(saveBtn, status);

  textarea.addEventListener("input", () => {
    const current = findLoadedOrder(id);
    const savedNow = (current && current.admin_notes) || "";
    if (textarea.value === savedNow) orderNoteDrafts.delete(id);
    else orderNoteDrafts.set(id, textarea.value);
    setOrderNoteStatus(id, textarea.value === savedNow ? "" : "Unsaved changes", "");
  });
  textarea.addEventListener("blur", () => saveOrderAdminNote(id, textarea.value, false));
  saveBtn.addEventListener("click", () => saveOrderAdminNote(id, textarea.value, true));

  wrap.append(label, textarea, actions);
  return wrap;
}

/* ----- Timeline (order_events) ----- */

let orderEventsAvailable = null; // null unknown, then true/false

/* Records something in the order's timeline. Never throws; returns the
   Supabase error (or null). Silently skipped before the migration. */
async function logOrderEvent(orderId, { kind, from_value = "", to_value = "", note = "" }) {
  if (orderEventsAvailable === false || ordersSchemaV2 === false) return null;
  try {
    const client = getSupabaseClient();
    const { data: { session } } = await client.auth.getSession();
    const row = {
      order_id: orderId,
      actor_email: (session && session.user && session.user.email) || "",
      kind: String(kind || "note").slice(0, 40),
      from_value: String(from_value || "").slice(0, 200),
      to_value: String(to_value || "").slice(0, 200),
      note: String(note || "").slice(0, 2000)
    };
    const { error } = await client.from("order_events").insert(row);
    if (error && isMissingTableError(error, "order_events")) orderEventsAvailable = false;
    return error || null;
  } catch (err) {
    return err;
  }
}

function describeOrderEvent(ev) {
  const from = ev.from_value || "";
  const to = ev.to_value || "";
  switch (ev.kind) {
    case "status": return `Status: ${orderStatusLabel(from)} → ${orderStatusLabel(to)}`;
    case "payment": return `Payment: ${orderPaymentLabel(from)} → ${orderPaymentLabel(to)}`;
    case "amount_paid": return `Amount paid: ${formatOrderMoney(from) || ORDERS_CURRENCY + "0"} → ${formatOrderMoney(to) || ORDERS_CURRENCY + "0"}`;
    case "message": {
      const label = window.AdminOrderMessages ? window.AdminOrderMessages.templateLabel(to) : to;
      const channel = { whatsapp: "WhatsApp", email: "email", copy: "copied to clipboard" }[from] || from;
      return `Message sent: ${label}${channel ? ` (${channel})` : ""}`;
    }
    default: return ev.note || ev.kind || "Update";
  }
}

async function loadOrderTimeline(order) {
  const el = document.getElementById("orderDrawerTimeline");
  if (!el || !order) return;
  const placed = `<li><span class="order-timeline-what">Order placed${order.source ? ` (came from ${escapeHtml(order.source)})` : ""}</span><span class="order-timeline-when">${escapeHtml(formatOrderDate(order.created_at))}</span></li>`;
  if (ordersSchemaV2 === false || orderEventsAvailable === false) {
    el.innerHTML = `<ul class="order-timeline">${placed}</ul><p class="orders-notice">The full timeline (status, payment and message history) ${escapeHtml(ORDERS_V2_HINT)}.</p>`;
    return;
  }
  const { data, error } = await getSupabaseClient()
    .from("order_events").select("*").eq("order_id", order.id)
    .order("created_at", { ascending: false }).limit(200);
  if (!orderDrawerOrder || String(orderDrawerOrder.id) !== String(order.id)) return;
  if (error) {
    if (isMissingTableError(error, "order_events")) {
      orderEventsAvailable = false;
      return loadOrderTimeline(order);
    }
    el.innerHTML = `<ul class="order-timeline">${placed}</ul><p class="a-inline-error" role="alert">Couldn't load the timeline: ${escapeHtml(error.message)}</p>`;
    return;
  }
  orderEventsAvailable = true;
  const rows = (data || []).map((ev) => {
    const who = ev.actor_email && ev.actor_email !== "system" ? ` · ${escapeHtml(ev.actor_email)}` : "";
    const note = ev.kind === "message" && ev.note ? `<span class="order-timeline-note">${escapeHtml(ev.note)}</span>` : "";
    return `<li><span class="order-timeline-what">${escapeHtml(describeOrderEvent(ev))}</span>${note}<span class="order-timeline-when">${escapeHtml(formatOrderDate(ev.created_at))}${who}</span></li>`;
  }).join("");
  el.innerHTML = `<ul class="order-timeline">${rows}${placed}</ul>`;
}

/* ----- Detail drawer ----- */

function ensureOrderDrawer() {
  let wrap = document.getElementById("orderDrawer");
  if (wrap) return wrap;
  wrap = document.createElement("div");
  wrap.id = "orderDrawer";
  wrap.className = "order-drawer-wrap";
  wrap.hidden = true;
  wrap.innerHTML = `
    <div class="order-drawer-scrim" data-close-order-drawer></div>
    <aside class="order-drawer" role="dialog" aria-modal="true" aria-labelledby="orderDrawerTitle" tabindex="-1">
      <div class="order-drawer-head" id="orderDrawerHead"></div>
      <div class="order-drawer-body" id="orderDrawerBody"></div>
      <div class="order-drawer-foot" id="orderDrawerFoot">
        <button type="button" class="orders-export-btn" id="orderDrawerPrint">Print work order</button>
        <button type="button" class="orders-export-btn order-drawer-foot-close" id="orderDrawerFootClose">Close</button>
      </div>
    </aside>`;
  document.body.appendChild(wrap);
  wrap.querySelector("[data-close-order-drawer]").addEventListener("click", () => closeOrderDrawer());
  wrap.querySelector("#orderDrawerFootClose").addEventListener("click", () => closeOrderDrawer());
  wrap.addEventListener("click", (e) => {
    const retry = e.target.closest("[data-order-drawer-retry]");
    if (retry) openOrderDrawer(retry.dataset.orderDrawerRetry, orderDrawerOpener);
    const thumb = e.target.closest(".order-attachment[href]");
    if (thumb) openOrderPhotoLightbox(e, thumb);
  });
  wrap.querySelector("#orderDrawerPrint").addEventListener("click", () => {
    if (window.AdminOrderPrint && orderDrawerOrder) window.AdminOrderPrint.printOrder(orderDrawerOrder);
  });
  // Another layer (confirm dialog, photo lightbox) is on top: leave keys to it.
  const layerOnTop = () => Boolean(document.querySelector("#adminPhotoPreview.open, .aui-backdrop"));
  document.addEventListener("keydown", (e) => {
    if (wrap.hidden) return;
    if (e.key === "Escape" && !layerOnTop()) { closeOrderDrawer(); return; }
    // Keep Tab inside the drawer while it is open (it is a modal dialog).
    if (e.key === "Tab" && !layerOnTop()) {
      const drawer = wrap.querySelector(".order-drawer");
      const items = Array.from(drawer.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'))
        .filter((el) => el.getClientRects().length > 0);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!drawer.contains(document.activeElement) || document.activeElement === drawer) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
  return wrap;
}

/* Opens the drawer for an order id (fetched fresh, so it also works for
   orders from the calendar that aren't on the current list page). */
async function openOrderDrawer(id, opener) {
  const wrap = ensureOrderDrawer();
  if (orderDrawerDirty && orderDrawerOrder && String(orderDrawerOrder.id) !== String(id)
      && !(await adminConfirm({ title: "Discard unsaved changes?", message: "You have unsaved changes on the open order. Discard them and open another order?", confirmLabel: "Discard changes", danger: true }))) return;
  orderDrawerOpener = opener || document.activeElement;
  orderDrawerDirty = false;
  const cached = findLoadedOrder(id);
  orderDrawerOrder = cached ? { ...cached } : { id, name: "Loading..." };
  wrap.hidden = false;
  document.body.classList.add("order-drawer-open");
  renderOrderDrawer();
  wrap.querySelector(".order-drawer").focus();
  const { data, error } = await getSupabaseClient().from("orders").select("*").eq("id", id).maybeSingle();
  if (!orderDrawerOrder || String(orderDrawerOrder.id) !== String(id)) return;
  if (error || !data) {
    if (!cached) {
      document.getElementById("orderDrawerBody").innerHTML = `<div class="a-panel-error" role="alert">
        <p class="a-panel-error-title">${error ? "Couldn't load this order" : "This order no longer exists"}</p>
        ${error ? `<p class="a-panel-error-text">${escapeHtml(error.message)}</p><button type="button" class="btn btn-outline btn-sm" data-order-drawer-retry="${escapeHtml(String(id))}">Try again</button>` : `<p class="a-panel-error-text">It may have been deleted from another device. Close this panel to go back to the list.</p>`}
      </div>`;
    }
    return;
  }
  orderDrawerOrder = data;
  if (!orderDrawerDirty) renderOrderDrawer();
}

/* async only for the unsaved-changes prompt: with force, or a clean drawer,
   there is no await, so the drawer still closes synchronously. */
let orderDrawerClosePrompt = false;
async function closeOrderDrawer(force) {
  const wrap = document.getElementById("orderDrawer");
  if (!wrap || wrap.hidden) return;
  if (!force && orderDrawerDirty) {
    if (orderDrawerClosePrompt) return; // a prompt is already open
    orderDrawerClosePrompt = true;
    let ok;
    try {
      ok = await adminConfirm({ title: "Close without saving?", message: "Close without saving your changes to this order?", confirmLabel: "Close and discard", danger: true });
    } finally {
      orderDrawerClosePrompt = false;
    }
    if (!ok || wrap.hidden) return;
  }
  wrap.hidden = true;
  document.body.classList.remove("order-drawer-open");
  orderDrawerOrder = null;
  orderDrawerDirty = false;
  if (orderDrawerOpener && document.body.contains(orderDrawerOpener)) {
    try { orderDrawerOpener.focus(); } catch (e) { /* ignore */ }
  }
  orderDrawerOpener = null;
}

function renderOrderDrawerHeader() {
  const head = document.getElementById("orderDrawerHead");
  const order = orderDrawerOrder;
  if (!head || !order) return;
  const ref = orderRef(order);
  head.innerHTML = `
    <div class="order-drawer-title-wrap">
      <h2 id="orderDrawerTitle">${escapeHtml(order.name || "(no name)")}</h2>
      <div class="order-drawer-sub">
        ${ref ? `<span class="order-drawer-ref">${escapeHtml(ref)}</span>` : ""}
        <span>${escapeHtml(orderKindLabel(order.kind))}</span>
        ${order.created_at ? `<span>Placed ${escapeHtml(formatOrderDate(order.created_at))}</span>` : ""}
      </div>
      <div class="order-drawer-pills">${orderStatusPill(order.status || "new")}${orderPaymentPill(order)}${orderBalancePill(order)}</div>
    </div>
    <button type="button" class="icon-btn order-drawer-close" id="orderDrawerClose" aria-label="Close order"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
  head.querySelector("#orderDrawerClose").addEventListener("click", () => closeOrderDrawer());
}

/* Opens a photo in the shared lightbox, stepping through the order's other
   photos; the plain link still works (new tab) with a modifier key. */
function openOrderPhotoLightbox(e, link) {
  if (typeof openImagePreviewSet !== "function" || e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
  const links = Array.from(link.closest(".order-attachments-list").querySelectorAll(".order-attachment[href]"));
  e.preventDefault();
  openImagePreviewSet(links.map((a) => a.getAttribute("href")), Math.max(0, links.indexOf(link)));
}

function moneyInputValue(v) {
  const n = orderAmountNumber(v);
  return n === null ? "" : String(n);
}

function renderOrderDrawer() {
  const order = orderDrawerOrder;
  const body = document.getElementById("orderDrawerBody");
  if (!order || !body) return;
  renderOrderDrawerHeader();
  if (order.name === "Loading..." && !order.created_at) {
    body.innerHTML = `<div role="status"><span class="a-visually-hidden">Loading order</span>
      <span class="a-skeleton a-skeleton--pill order-skel-status"></span>
      <span class="a-skeleton a-skeleton--block"></span>
      <span class="a-skeleton a-skeleton--block"></span>
      <span class="a-skeleton a-skeleton--block"></span></div>`;
    return;
  }
  const id = String(order.id);
  const status = order.status || "new";
  const v2 = Boolean(ordersSchemaV2);
  const items = orderItems(order);
  const eventIso = orderEventIso(order);
  const eventTime = orderEventTime(order);
  const total = orderTotalAmount(order);
  const mapsUrl = order.address && !/^pick-up|^address to be coordinated/i.test(order.address)
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(order.address)}` : "";

  const itemsHtml = items.length ? `
    <table class="order-items-table">
      <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Total</th></tr></thead>
      <tbody>${items.map((l) => {
        const variant = l.variant ? (typeof l.variant === "object" ? (l.variant.name || l.variant.label || "") : l.variant) : "";
        const addons = Array.isArray(l.addons) ? l.addons.filter(Boolean) : [];
        return `<tr>
          <td class="order-item-name">${escapeHtml(l.name || "Item")}
            ${variant ? `<div class="order-item-sub">${escapeHtml(variant)}</div>` : ""}
            ${addons.map((a) => `<div class="order-item-sub">+ ${escapeHtml(typeof a === "object" ? a.name || "" : a)}${typeof a === "object" && orderAmountNumber(a.price) ? ` (${escapeHtml(formatOrderMoney(a.price))})` : ""}</div>`).join("")}
          </td>
          <td class="num" data-label="Qty">${escapeHtml(String(l.qty || 1))}</td>
          <td class="num" data-label="Price">${escapeHtml(formatOrderMoney(l.unit_price))}</td>
          <td class="num" data-label="Total">${escapeHtml(formatOrderMoney(l.line_total))}</td>
        </tr>`;
      }).join("")}</tbody>
      ${total !== null ? `<tfoot><tr><td class="order-items-total-label" colspan="3">Total</td><td class="num" data-label="Total">${escapeHtml(formatOrderMoney(total))}</td></tr></tfoot>` : ""}
    </table>`
    : (orderSummaryBody(order) ? `<div class="order-field order-summary-text">${escapeHtml(orderSummaryBody(order))}</div>` : `<p class="field-note">No items listed.</p>`);

  const paymentHtml = v2 ? `
    <section class="order-drawer-section" id="orderDrawerPayment">
      <h3>Payment</h3>
      ${order.kind === "custom" && order.total ? `<p class="field-note">Customer's budget: ${escapeHtml(order.total)}</p>` : ""}
      <div class="order-money-grid">
        <label>Total<span class="order-money-field"><span aria-hidden="true">${ORDERS_CURRENCY}</span><input type="number" inputmode="decimal" min="0" step="0.01" id="odTotal" value="${escapeHtml(moneyInputValue(order.total_amount))}" placeholder="Not set"/></span></label>
        <label>Deposit<span class="order-money-field"><span aria-hidden="true">${ORDERS_CURRENCY}</span><input type="number" inputmode="decimal" min="0" step="0.01" id="odDeposit" value="${escapeHtml(moneyInputValue(order.deposit_amount))}" placeholder="None"/></span></label>
        <label>Paid so far<span class="order-money-field"><span aria-hidden="true">${ORDERS_CURRENCY}</span><input type="number" inputmode="decimal" min="0" step="0.01" id="odPaid" value="${escapeHtml(moneyInputValue(order.amount_paid) || "0")}"/></span></label>
        <div class="order-balance-box"><span>Balance due</span><strong id="odBalance"></strong></div>
      </div>
      <label class="order-inline-field">Payment status
        <select id="odPayStatus" class="order-status-select">
          ${ORDER_PAYMENT_STATUSES.map((p) => `<option value="${p}" ${p === (order.payment_status || "unpaid") ? "selected" : ""}>${escapeHtml(orderPaymentLabel(p))}</option>`).join("")}
        </select>
      </label>
      <div class="order-quick-pay" role="group" aria-label="Quick payment">
        <button type="button" class="orders-export-btn" data-pay-quick="deposit" title="Sets Paid so far to the deposit and saves">Deposit received</button>
        <button type="button" class="orders-export-btn" data-pay-quick="full" title="Sets Paid so far to the total and saves">Paid in full</button>
      </div>
      <div class="order-drawer-actions">
        <button type="button" class="btn btn-primary order-drawer-save" id="odSavePayment">Save payment</button>
        <span class="form-status" id="odPaymentStatus" role="status" aria-live="polite"></span>
      </div>
    </section>` : `
    <section class="order-drawer-section">
      <h3>Total</h3>
      <p>${escapeHtml(order.total || "Not given")}</p>
      <p class="field-note">Tracking deposits and payments ${escapeHtml(ORDERS_V2_HINT)}.</p>
    </section>`;

  const eventHtml = v2 ? `
    <div class="order-event-grid">
      <label>Date<input type="date" id="odEventOn" value="${escapeHtml(eventIso)}"/></label>
      <label>Time<input type="text" id="odEventTime" maxlength="100" value="${escapeHtml(eventTime)}" placeholder="e.g. 14:00 or 2–4pm"/></label>
      <label>Fulfilment
        <select id="odFulfillment" class="order-status-select">
          <option value="delivery" ${order.fulfillment !== "pickup" ? "selected" : ""}>Delivery</option>
          <option value="pickup" ${order.fulfillment === "pickup" ? "selected" : ""}>Pick-up</option>
        </select>
      </label>
    </div>
    ${order.event_date && order.event_date.slice(0, 10) !== eventIso ? `<p class="field-note">Customer wrote: ${escapeHtml(order.event_date)}</p>` : ""}
    <div class="order-drawer-actions">
      <button type="button" class="orders-export-btn" id="odSaveEvent">Save event details</button>
      <span class="form-status" id="odEventStatus" role="status" aria-live="polite"></span>
    </div>`
    : `<p>${escapeHtml(orderEventLabel(order) || "No date given")}</p>`;

  body.innerHTML = `
    <section class="order-drawer-section">
      <h3>Status</h3>
      <div class="order-status-chips" role="group" aria-label="Order status">
        ${ORDER_STATUSES.map((s) => `<button type="button" class="orders-filter-btn ${s === status ? "active" : ""}" data-set-status="${s}" aria-pressed="${s === status}" ${s === "quoted" && ordersSchemaV2 === false ? "disabled title=\"Needs the orders v2 SQL\"" : ""}>${escapeHtml(orderStatusLabel(s))}</button>`).join("")}
      </div>
    </section>

    <section class="order-drawer-section">
      <h3>Contact</h3>
      <div class="order-contact" id="orderDrawerContact">
        ${order.phone ? `<a href="tel:${escapeHtml(order.phone)}">${escapeHtml(order.phone)}</a>` : ""}
        ${order.email ? `<a href="mailto:${escapeHtml(order.email)}">${escapeHtml(order.email)}</a>` : ""}
      </div>
      ${order.address ? `<div class="order-field"><strong>Address:</strong> ${escapeHtml(order.address)}${mapsUrl ? ` <a href="${escapeHtml(mapsUrl)}" target="_blank" rel="noopener noreferrer">Map</a>` : ""}</div>` : ""}
      ${order.source ? `<div class="order-field"><strong>Came from:</strong> ${escapeHtml(order.source)}</div>` : ""}
    </section>

    <section class="order-drawer-section">
      <h3>Event</h3>
      ${eventHtml}
    </section>

    <section class="order-drawer-section">
      <h3>Items</h3>
      ${itemsHtml}
    </section>

    ${paymentHtml}

    <section class="order-drawer-section" id="orderDrawerMessages">
      <h3>Send a message</h3>
    </section>

    ${order.notes ? `<section class="order-drawer-section"><h3>Customer notes</h3><div class="order-field order-notes-text">${escapeHtml(order.notes)}</div></section>` : ""}

    <section class="order-drawer-section" id="orderDrawerPhotos" hidden><h3>Inspiration photos</h3></section>

    <section class="order-drawer-section" id="orderDrawerNotes"></section>

    <section class="order-drawer-section">
      <h3>Timeline</h3>
      <div id="orderDrawerTimeline" role="status"><span class="a-visually-hidden">Loading timeline</span><span class="a-skeleton a-skeleton--line order-skel-timeline"></span><span class="a-skeleton a-skeleton--line order-skel-timeline"></span></div>
    </section>

    <section class="order-drawer-section order-drawer-danger">
      <h3>Delete order</h3>
      <p class="field-note">Removes this order and its photos for good.</p>
      <button type="button" class="danger delete-order-btn" id="odDelete">Delete order</button>
    </section>`;

  // Customer text that lands in attributes/values goes through DOM APIs.
  const waLink = buildWhatsAppLink(order);
  if (waLink) document.getElementById("orderDrawerContact").appendChild(waLink);
  const photos = buildOrderAttachments(order);
  if (photos) {
    const sec = document.getElementById("orderDrawerPhotos");
    sec.hidden = false;
    sec.appendChild(photos);
    loadOrderAttachmentThumbs(sec);
  }
  document.getElementById("orderDrawerNotes").appendChild(buildOrderAdminNotes(order));
  const msgSec = document.getElementById("orderDrawerMessages");
  if (window.AdminOrderMessages) window.AdminOrderMessages.buildPanel(msgSec, order);
  else msgSec.hidden = true;

  body.querySelectorAll("[data-set-status]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const next = btn.dataset.setStatus;
      if (next === (orderDrawerOrder.status || "new")) return;
      body.querySelectorAll("[data-set-status]").forEach((b) => { b.disabled = true; });
      const ok = await handleOrderStatusChange(id, next);
      body.querySelectorAll("[data-set-status]").forEach((b) => {
        b.disabled = b.dataset.setStatus === "quoted" && ordersSchemaV2 === false;
        const active = b.dataset.setStatus === (orderDrawerOrder ? orderDrawerOrder.status || "new" : "");
        b.classList.toggle("active", ok ? active : b.classList.contains("active"));
        b.setAttribute("aria-pressed", String(b.classList.contains("active")));
      });
    });
  });
  document.getElementById("odDelete").addEventListener("click", async () => {
    if (await handleDeleteOrder(id)) closeOrderDrawer(true);
  });
  if (v2) wireOrderDrawerEditors(order);
  loadOrderTimeline(order);
}

function updateDrawerBalance() {
  const out = document.getElementById("odBalance");
  if (!out) return;
  const total = orderAmountNumber(document.getElementById("odTotal").value);
  const paid = orderAmountNumber(document.getElementById("odPaid").value) || 0;
  out.textContent = total === null ? "Not set" : formatOrderMoney(Math.max(0, total - paid)) || ORDERS_CURRENCY + "0";
}

function wireOrderDrawerEditors(order) {
  const id = String(order.id);
  const markDirty = () => { orderDrawerDirty = true; };
  ["odTotal", "odDeposit", "odPaid", "odPayStatus", "odEventOn", "odEventTime", "odFulfillment"].forEach((fid) => {
    const el = document.getElementById(fid);
    if (el) {
      el.addEventListener("input", markDirty);
      el.addEventListener("change", markDirty);
    }
  });
  ["odTotal", "odPaid"].forEach((fid) => document.getElementById(fid).addEventListener("input", updateDrawerBalance));
  updateDrawerBalance();

  document.querySelectorAll("#orderDrawerPayment [data-pay-quick]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const totalEl = document.getElementById("odTotal");
      const depositEl = document.getElementById("odDeposit");
      const paidEl = document.getElementById("odPaid");
      const statusEl = document.getElementById("odPayStatus");
      const statusOut = document.getElementById("odPaymentStatus");
      if (btn.dataset.payQuick === "deposit") {
        if (orderAmountNumber(depositEl.value) === null) {
          statusOut.textContent = "Enter the deposit amount first.";
          statusOut.className = "form-status error";
          depositEl.focus();
          return;
        }
        paidEl.value = depositEl.value;
        statusEl.value = "deposit_paid";
      } else {
        if (orderAmountNumber(totalEl.value) === null) {
          statusOut.textContent = "Enter the order total first.";
          statusOut.className = "form-status error";
          totalEl.focus();
          return;
        }
        paidEl.value = totalEl.value;
        statusEl.value = "paid";
      }
      updateDrawerBalance();
      saveOrderPayment(id);
    });
  });
  document.getElementById("odSavePayment").addEventListener("click", () => saveOrderPayment(id));
  document.getElementById("odSaveEvent").addEventListener("click", () => saveOrderEventDetails(id));
}

function setDrawerStatus(elId, text, kind) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = text;
  el.className = "form-status" + (kind ? " " + kind : "");
}

async function saveOrderPayment(id) {
  const raw = (fid) => document.getElementById(fid).value.trim();
  const total = raw("odTotal") === "" ? null : orderAmountNumber(raw("odTotal"));
  const deposit = raw("odDeposit") === "" ? null : orderAmountNumber(raw("odDeposit"));
  const paid = raw("odPaid") === "" ? 0 : orderAmountNumber(raw("odPaid"));
  const payStatus = document.getElementById("odPayStatus").value;
  const bad = [[raw("odTotal"), total], [raw("odDeposit"), deposit], [raw("odPaid"), paid]]
    .some(([text, n]) => text !== "" && (n === null || n < 0 || n >= 100000000));
  if (bad) return setDrawerStatus("odPaymentStatus", "Amounts must be numbers of 0 or more.", "error");
  const changes = {
    total_amount: total === null ? null : Math.round(total * 100) / 100,
    deposit_amount: deposit === null ? null : Math.round(deposit * 100) / 100,
    amount_paid: Math.round(paid * 100) / 100,
    payment_status: ORDER_PAYMENT_STATUSES.includes(payStatus) ? payStatus : "unpaid"
  };
  const btn = document.getElementById("odSavePayment");
  btn.disabled = true;
  setDrawerStatus("odPaymentStatus", "Saving...", "");
  const { error } = await mustAffect(getSupabaseClient().from("orders").update(changes).eq("id", id));
  if (document.getElementById("odSavePayment")) document.getElementById("odSavePayment").disabled = false;
  if (error) {
    const msg = isMissingColumnError(error) ? `Payments ${ORDERS_V2_HINT}.` : "Couldn't save: " + error.message;
    return setDrawerStatus("odPaymentStatus", msg, "error");
  }
  patchLoadedOrder(id, changes);
  orderDrawerDirty = false;
  setDrawerStatus("odPaymentStatus", "Saved", "success");
  renderOrderDrawerHeader();
  if (orderDrawerOrder) loadOrderTimeline(orderDrawerOrder);
  refreshOrderList();
}

async function saveOrderEventDetails(id) {
  const iso = document.getElementById("odEventOn").value;
  const time = document.getElementById("odEventTime").value.trim().slice(0, 100);
  const fulfillment = document.getElementById("odFulfillment").value === "pickup" ? "pickup" : "delivery";
  if (iso && !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return setDrawerStatus("odEventStatus", "Pick a valid date.", "error");
  // Keep the legacy text column in step: fully_booked_dates() (daily
  // capacity) still counts orders by event_date.
  const legacyText = iso ? (/^\d{1,2}:\d{2}$/.test(time) ? `${iso} ${time}` : iso) : "";
  const changes = { event_on: iso || null, event_time: time, fulfillment, event_date: legacyText };
  setDrawerStatus("odEventStatus", "Saving...", "");
  const { error } = await mustAffect(getSupabaseClient().from("orders").update(changes).eq("id", id));
  if (error) {
    const msg = isMissingColumnError(error) ? `Event details ${ORDERS_V2_HINT}.` : "Couldn't save: " + error.message;
    return setDrawerStatus("odEventStatus", msg, "error");
  }
  patchLoadedOrder(id, changes);
  orderDrawerDirty = false;
  setDrawerStatus("odEventStatus", "Saved", "success");
  refreshOrderList();
}

/* ----- Order photos (customer inspiration photos) -----
   Custom orders can carry up to 3 photos in orders.attachments: paths in
   the private 'order-uploads' Storage bucket (see js/order-uploads.js and
   the "Order photo uploads" section of supabase-setup.sql). Only the admin
   can read them, through short-lived signed URLs. */
const ORDER_PHOTOS_BUCKET = "order-uploads";
const ORDER_PHOTOS_SQL_HINT = "Photo uploads need the latest supabase-setup.sql";
const ORDER_PHOTO_URL_TTL = 3600; // seconds
const ORDER_PHOTO_PATH_RE = /^pending\/([0-9a-f-]{36})\/[0-9]\.(jpg|jpeg|png|webp)$/;
const ORDER_PHOTO_FOLDER_RE = /^[0-9a-f-]{36}$/;
const ORDER_PHOTO_CLEANUP_AGE_DAYS = 7;
// path -> { url, expires } so re-renders don't re-sign.
const orderPhotoUrlCache = new Map();
// path -> error message for photos that couldn't be signed (e.g. missing).
const orderPhotoUrlErrors = new Map();
let orderPhotosSchemaChecked = false;

function orderAttachmentPaths(order) {
  return Array.isArray(order && order.attachments) ? order.attachments.filter((p) => typeof p === "string" && p) : [];
}

function setOrderPhotoToolsStatus(message, kind) {
  const el = document.getElementById("orderPhotoToolsStatus");
  if (!el) return;
  el.textContent = message || "";
  el.className = "form-status" + (kind ? " " + kind : "");
}

// Built with DOM APIs; the thumbnails are filled in by
// loadOrderAttachmentThumbs() once their signed URLs exist.
function buildOrderAttachments(order) {
  const paths = orderAttachmentPaths(order);
  if (!paths.length) return null;
  const wrap = document.createElement("div");
  wrap.className = "order-attachments";
  const label = document.createElement("span");
  label.className = "order-attachments-label";
  label.textContent = `Inspiration photos (${paths.length})`;
  const list = document.createElement("div");
  list.className = "order-attachments-list";
  paths.forEach((path, i) => {
    const link = document.createElement("a");
    link.className = "order-attachment";
    link.dataset.path = path;
    link.dataset.alt = `Inspiration photo ${i + 1} from ${order.name || "the customer"}`;
    link.textContent = "Loading...";
    list.appendChild(link);
  });
  const status = document.createElement("p");
  status.className = "form-status error order-attachments-status";
  status.hidden = true;
  wrap.append(label, list, status);
  applyOrderAttachmentUrls(wrap);
  return wrap;
}

function applyOrderAttachmentUrls(root) {
  if (!root) return;
  root.querySelectorAll(".order-attachment[data-path]").forEach((link) => {
    const path = link.dataset.path;
    const cached = orderPhotoUrlCache.get(path);
    if (cached && cached.expires > Date.now()) {
      if (link.getAttribute("href") === cached.url) return;
      link.href = cached.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = "Open full size in a new tab";
      link.classList.remove("is-error");
      const img = document.createElement("img");
      img.src = cached.url;
      img.alt = link.dataset.alt || "Inspiration photo";
      img.loading = "lazy";
      link.replaceChildren(img);
    } else if (orderPhotoUrlErrors.has(path)) {
      link.removeAttribute("href");
      link.classList.add("is-error");
      link.textContent = "Photo unavailable";
      link.title = orderPhotoUrlErrors.get(path);
    }
  });
}

/* Signed URLs for these photo paths, using the cache. Resolves to a Map
   path -> url (missing entries couldn't be signed); never throws. Also
   used by the printable work order. */
async function signOrderPhotoUrls(paths) {
  const soon = Date.now() + 5 * 60 * 1000;
  const need = [...new Set(paths)].filter((p) => !orderPhotoUrlErrors.has(p) && !((orderPhotoUrlCache.get(p) || {}).expires > soon));
  let error = null;
  if (need.length) {
    let data = null;
    try {
      ({ data, error } = await getSupabaseClient().storage.from(ORDER_PHOTOS_BUCKET).createSignedUrls(need, ORDER_PHOTO_URL_TTL));
    } catch (err) {
      error = err;
    }
    if (!error) {
      const expires = Date.now() + ORDER_PHOTO_URL_TTL * 1000;
      (data || []).forEach((item) => {
        if (item && item.signedUrl && !item.error) orderPhotoUrlCache.set(item.path, { url: item.signedUrl, expires });
        else if (item && item.path) orderPhotoUrlErrors.set(item.path, String(item.error || "Couldn't load this photo"));
      });
    }
  }
  const urls = new Map();
  paths.forEach((p) => { const c = orderPhotoUrlCache.get(p); if (c) urls.set(p, c.url); });
  return { urls, error };
}

/* Signs every photo under `root` that doesn't have a fresh URL yet, in one
   request. A failed request shows a message instead of thumbnails; the
   order itself is unaffected. */
async function loadOrderAttachmentThumbs(root) {
  if (!root) return;
  const paths = [...new Set(Array.from(root.querySelectorAll(".order-attachment[data-path]"), (a) => a.dataset.path))];
  if (!paths.length) return;
  const { error } = await signOrderPhotoUrls(paths);
  if (error) {
    const message = /bucket not found/i.test(error.message || "")
      ? `${ORDER_PHOTOS_SQL_HINT}, ${ORDERS_SQL_HINT}.`
      : `Couldn't load photos: ${error.message || error}`;
    root.querySelectorAll(".order-attachments").forEach((wrap) => {
      wrap.querySelectorAll(".order-attachment[data-path]").forEach((a) => {
        if (!orderPhotoUrlCache.has(a.dataset.path)) { a.textContent = "Not loaded"; a.classList.add("is-error"); }
      });
      const status = wrap.querySelector(".order-attachments-status");
      status.textContent = message;
      status.hidden = false;
    });
    return;
  }
  applyOrderAttachmentUrls(root);
}

/* Deletes the Storage files of orders that were just deleted. Skips any
   path another loaded order still uses. Returns null on success, or a
   sentence describing what went wrong. */
async function removeOrderPhotoFiles(deletedOrders) {
  const deletedIds = new Set(deletedOrders.map((o) => String(o.id)));
  const stillUsed = new Set(ordersAllCache.filter((o) => !deletedIds.has(String(o.id))).flatMap(orderAttachmentPaths));
  const paths = [...new Set(deletedOrders.flatMap(orderAttachmentPaths))].filter((p) => !stillUsed.has(p));
  if (!paths.length) return null;
  const leftoverNote = `"Clean up unused photos" can remove them after ${ORDER_PHOTO_CLEANUP_AGE_DAYS} days.`;
  let data = null;
  let error = null;
  try {
    ({ data, error } = await getSupabaseClient().storage.from(ORDER_PHOTOS_BUCKET).remove(paths));
  } catch (err) {
    error = err;
  }
  if (error) {
    return `its ${paths.length === 1 ? "photo" : `${paths.length} photos`} couldn't be deleted (${error.message || error}). ${leftoverNote}`;
  }
  // Like mustAffect(): Storage reports success even when nothing was
  // removed (login expired, file already gone), so count what came back.
  const removed = new Set((data || []).map((o) => o.name));
  const notRemoved = paths.filter((p) => !removed.has(p));
  paths.forEach((p) => { if (removed.has(p)) orderPhotoUrlCache.delete(p); });
  if (notRemoved.length) {
    return `${notRemoved.length === 1 ? "1 photo wasn't" : `${notRemoved.length} photos weren't`} deleted (already gone, or your login may have expired). ${leftoverNote}`;
  }
  return null;
}

/* Shows the "needs the latest SQL" hint when orders has no attachments
   column yet. Checked once per page load. */
async function checkOrderPhotosSchema() {
  if (orderPhotosSchemaChecked) return;
  orderPhotosSchemaChecked = true;
  let missing;
  if (ordersAllCache.length) {
    missing = !("attachments" in ordersAllCache[0]);
  } else {
    const { error } = await getSupabaseClient().from("orders").select("attachments").limit(1);
    missing = isMissingColumnError(error, "attachments");
  }
  const btn = document.getElementById("cleanupOrderPhotosBtn");
  if (missing) {
    if (btn) btn.disabled = true;
    setOrderPhotoToolsStatus(`${ORDER_PHOTOS_SQL_HINT}, ${ORDERS_SQL_HINT}.`, "");
  }
}

// Every entry under `prefix` in the bucket, paging through list().
async function listAllOrderPhotoEntries(prefix) {
  const client = getSupabaseClient();
  const pageSize = 100;
  const all = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await client.storage.from(ORDER_PHOTOS_BUCKET).list(prefix, { limit: pageSize, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw error;
    all.push(...(data || []));
    if (!data || data.length < pageSize) return all;
  }
}

// Upload folders referenced by any order, fetched fresh and paged past
// PostgREST's 1000-row cap. Throws on any error: "couldn't check" must
// never be mistaken for "unused".
async function fetchReferencedOrderPhotoFolders() {
  const client = getSupabaseClient();
  const folders = new Set();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client.from("orders").select("id, attachments").order("id").range(from, from + pageSize - 1);
    if (error) throw error;
    (data || []).forEach((o) => orderAttachmentPaths(o).forEach((p) => {
      const folder = p.split("/")[1];
      if (folder) folders.add(folder);
    }));
    if (!data || data.length < pageSize) return folders;
  }
}

/* pending/<folder>/ folders that no order references and whose newest
   file is over ORDER_PHOTO_CLEANUP_AGE_DAYS old. A folder with any file
   whose age can't be read is left alone. */
async function findUnusedOrderPhotoFolders() {
  const referenced = await fetchReferencedOrderPhotoFolders();
  const cutoff = Date.now() - ORDER_PHOTO_CLEANUP_AGE_DAYS * 24 * 60 * 60 * 1000;
  const entries = await listAllOrderPhotoEntries("pending");
  const candidates = [];
  for (const entry of entries) {
    // Folders come back as entries without an id.
    if (entry.id || !ORDER_PHOTO_FOLDER_RE.test(entry.name) || referenced.has(entry.name)) continue;
    const files = (await listAllOrderPhotoEntries(`pending/${entry.name}`)).filter((f) => f.id);
    if (!files.length) continue;
    const times = files.map((f) => new Date(f.created_at || "").getTime());
    if (times.some((t) => isNaN(t)) || Math.max(...times) >= cutoff) continue;
    candidates.push({ folder: entry.name, paths: files.map((f) => `pending/${entry.name}/${f.name}`) });
  }
  return candidates;
}

async function handleCleanupOrderPhotos() {
  const btn = document.getElementById("cleanupOrderPhotosBtn");
  btn.disabled = true;
  setOrderPhotoToolsStatus("Looking for unused photos...", "");
  try {
    let candidates;
    try {
      candidates = await findUnusedOrderPhotoFolders();
    } catch (err) {
      const message = isMissingColumnError(err, "attachments") || /bucket not found/i.test(err.message || "")
        ? `${ORDER_PHOTOS_SQL_HINT}, ${ORDERS_SQL_HINT}.`
        : `Couldn't check for unused photos (${err.message || err}), so nothing was deleted.`;
      setOrderPhotoToolsStatus(message, "error");
      return;
    }
    if (!candidates.length) {
      setOrderPhotoToolsStatus(`No unused photos older than ${ORDER_PHOTO_CLEANUP_AGE_DAYS} days.`, "success");
      return;
    }
    const fileCount = candidates.reduce((n, c) => n + c.paths.length, 0);
    const summary = `${fileCount} photo${fileCount === 1 ? "" : "s"} from ${candidates.length} upload${candidates.length === 1 ? "" : "s"}`;
    setOrderPhotoToolsStatus(`Found ${summary} that no order uses.`, "");
    if (!(await adminConfirm({
      title: `Permanently delete ${summary}?`,
      message: `They were uploaded over ${ORDER_PHOTO_CLEANUP_AGE_DAYS} days ago and no order uses them (abandoned forms, or deleted orders). This can't be undone.`,
      confirmLabel: "Delete photos",
      danger: true,
      requireText: fileCount >= 10 ? "DELETE" : undefined,
    }))) {
      setOrderPhotoToolsStatus("Nothing was deleted.", "");
      return;
    }

    // Re-check right before deleting: an order may have started using one
    // of these since the scan. If the check fails, delete nothing.
    let referenced;
    try {
      referenced = await fetchReferencedOrderPhotoFolders();
    } catch (err) {
      setOrderPhotoToolsStatus(`Couldn't re-check whether these photos are in use (${err.message || err}), so nothing was deleted. Try again.`, "error");
      return;
    }
    const paths = candidates.filter((c) => !referenced.has(c.folder)).flatMap((c) => c.paths);
    const skipped = fileCount - paths.length;
    const client = getSupabaseClient();
    let deleted = 0;
    const failures = [];
    for (let i = 0; i < paths.length; i += 100) {
      const batch = paths.slice(i, i + 100);
      const { data, error } = await client.storage.from(ORDER_PHOTOS_BUCKET).remove(batch);
      if (error) {
        failures.push(`${batch.length} photo${batch.length === 1 ? "" : "s"}: ${error.message}`);
        continue;
      }
      const removed = new Set((data || []).map((o) => o.name));
      deleted += batch.filter((p) => removed.has(p)).length;
      const notRemoved = batch.filter((p) => !removed.has(p)).length;
      if (notRemoved) failures.push(`${notRemoved} photo${notRemoved === 1 ? "" : "s"} weren't deleted (already gone, or your login may have expired)`);
    }
    const parts = [`Deleted ${deleted} unused photo${deleted === 1 ? "" : "s"}.`];
    if (skipped) parts.push(`${skipped} skipped because an order now uses them.`);
    if (failures.length) parts.push("Problems: " + failures.join("; ") + ".");
    setOrderPhotoToolsStatus(parts.join(" "), failures.length ? "error" : "success");
    if (failures.length) await adminAlert("Some photos couldn't be deleted:\n" + failures.join("\n"), { title: "Some photos were not deleted" });
  } finally {
    btn.disabled = false;
  }
}

/* ----- Bulk selection ----- */

/* Keeps the "select all on this page" checkbox and bulk action bar in sync
   with selectedOrderIds (which can span pages). */
function syncOrderBulkSelectionUI(visibleOrders) {
  const selectAllBox = document.getElementById("orderSelectAll");
  if (selectAllBox) {
    const visibleIds = visibleOrders.map((o) => String(o.id));
    const selectedVisibleCount = visibleIds.filter((id) => selectedOrderIds.has(id)).length;
    selectAllBox.checked = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
    selectAllBox.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visibleIds.length;
  }

  const bar = document.getElementById("orderBulkActionBar");
  const count = selectedOrderIds.size;
  bar.hidden = count === 0;
  if (count > 0) {
    document.getElementById("orderBulkSelectedCount").textContent = `${count} selected`;
  }
}

function clearOrderSelection() {
  selectedOrderIds.clear();
  document.querySelectorAll("#orderList .order-select").forEach((box) => { box.checked = false; });
  syncOrderBulkSelectionUI(ordersVisibleCache);
}

async function bulkUpdateOrderStatus(status) {
  const ids = [...selectedOrderIds];
  if (!ids.length) return;
  const client = getSupabaseClient();
  const bar = document.getElementById("orderBulkActionBar");
  bar.querySelectorAll("button").forEach((b) => { b.disabled = true; });
  const { error } = await mustAffect(client.from("orders").update({ status }).in("id", ids));
  bar.querySelectorAll("button").forEach((b) => { b.disabled = false; });
  if (error) {
    adminToast("Couldn't update: " + orderStatusErrorMessage(error, status), { kind: "error" });
    return;
  }
  selectedOrderIds.clear();
  await refreshOrderList();
}

async function bulkDeleteOrders() {
  const ids = [...selectedOrderIds];
  if (!ids.length) return;
  const label = ids.length === 1 ? "this order" : `these ${ids.length} orders`;
  if (!(await adminConfirm({
    title: `Delete ${label}?`,
    message: "Any inspiration photos on them will be deleted too. This can't be undone.",
    confirmLabel: ids.length === 1 ? "Delete order" : `Delete ${ids.length} orders`,
    danger: true,
    requireText: ids.length >= 5 ? "DELETE" : undefined,
  }))) return;
  const client = getSupabaseClient();
  const bar = document.getElementById("orderBulkActionBar");
  bar.querySelectorAll("button").forEach((b) => { b.disabled = true; });
  const { data, error } = await mustAffect(client.from("orders").delete().in("id", ids));
  if (error) {
    bar.querySelectorAll("button").forEach((b) => { b.disabled = false; });
    adminToast("Couldn't delete: " + error.message, { kind: "error" });
    return;
  }
  const photoProblem = await removeOrderPhotoFiles(data || []);
  bar.querySelectorAll("button").forEach((b) => { b.disabled = false; });
  selectedOrderIds.clear();
  if (orderDrawerOrder && ids.includes(String(orderDrawerOrder.id))) closeOrderDrawer(true);
  await refreshOrderList();
  if (photoProblem) adminToast(`The order${ids.length === 1 ? " was" : "s were"} deleted, but ` + photoProblem, { kind: "error", duration: 12000 });
}

/* ----- CSV export ----- */

/* CSV field escaping per RFC 4180, plus a leading quote on anything that
   a spreadsheet would run as a formula (order fields come straight from
   the public forms). Values made only of digits/spaces/()+-. (phone
   numbers, negative amounts) pass through untouched. */
function csvEscapeField(value) {
  let str = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(str) && !/^[+\-\d\s().]+$/.test(str)) str = "'" + str;
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/* Every order matching the current filters (status, payment, search,
   upcoming, event date range) — not just the visible page — fetched 1000
   at a time. */
async function fetchAllMatchingOrders() {
  const client = getSupabaseClient();
  const all = [];
  const pageSize = 1000;
  for (let from = 0; from < 50000; from += pageSize) {
    const q = applyOrderSort(applyOrderFilters(client.from("orders").select("*"))).range(from, from + pageSize - 1);
    const { data, error } = await q;
    if (error) throw error;
    all.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return ordersUpcomingOnly && !ordersSchemaV2 ? all.filter(isUpcomingOrder) : all;
}

async function exportOrdersCsv() {
  const btn = document.getElementById("exportOrdersCsvBtn");
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Exporting...";
  let rows;
  try {
    rows = await fetchAllMatchingOrders();
  } catch (err) {
    adminToast("Couldn't export: " + (err.message || err), { kind: "error" });
    return;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
  if (!rows.length) {
    adminToast("No orders to export for the current filters.", { kind: "info" });
    return;
  }

  const header = ["Placed", "Ref", "Kind", "Name", "Phone", "Email", "Address", "Event Date", "Event Time", "Fulfilment",
    "Status", "Payment Status", "Total", "Total Amount", "Deposit", "Amount Paid", "Balance Due", "Source",
    "Items", "Summary", "Notes", "Admin Notes"];
  const lines = [header.map(csvEscapeField).join(",")];
  rows.forEach((order) => {
    const balance = orderBalance(order);
    lines.push([
      order.created_at || "",
      orderRef(order),
      orderKindLabel(order.kind),
      order.name || "",
      order.phone || "",
      order.email || "",
      order.address || "",
      orderEventIso(order) || order.event_date || "",
      orderEventTime(order),
      order.fulfillment || "",
      order.status || "new",
      order.payment_status || "",
      order.total || "",
      orderTotalAmount(order) === null ? "" : orderTotalAmount(order).toFixed(2),
      orderAmountNumber(order.deposit_amount) === null ? "" : orderAmountNumber(order.deposit_amount).toFixed(2),
      orderAmountNumber(order.amount_paid) === null ? "" : orderAmountNumber(order.amount_paid).toFixed(2),
      balance === null ? "" : balance.toFixed(2),
      order.source || "",
      orderItems(order).length ? orderItemsText(order) : "",
      orderSummaryBody(order),
      order.notes || "",
      order.admin_notes || ""
    ].map(csvEscapeField).join(","));
  });

  // Leading BOM so Excel detects UTF-8.
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const range = ordersDateFrom || ordersDateTo ? `-${ordersDateFrom || "start"}-to-${ordersDateTo || "end"}` : "";
  a.download = `orders-export${range}-${ordersTodayIso()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ----- Realtime ----- */

let ordersRealtimeChannel = null;
let ordersRealtimeFailed = false;
let ordersRealtimeTimer = null;

/* Subscribes once to inserts/updates/deletes on orders. Realtime still
   applies RLS, so this only receives rows the admin may read. If Realtime
   isn't enabled for the table (or the project), the channel errors and we
   quietly stay on manual refreshes. */
function startOrdersRealtime() {
  if (ordersRealtimeChannel || ordersRealtimeFailed) return;
  const client = getSupabaseClient();
  if (!client || typeof client.channel !== "function") return;
  try {
    ordersLiveState = "connecting";
    ordersRealtimeChannel = client
      .channel("admin-orders-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, handleOrdersRealtimeChange)
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          ordersLiveState = "live";
          renderOrdersNotices();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          ordersRealtimeFailed = true;
          stopOrdersRealtime("unavailable");
        }
      });
  } catch (err) {
    ordersRealtimeFailed = true;
    ordersRealtimeChannel = null;
    ordersLiveState = "unavailable";
  }
}

function stopOrdersRealtime(state) {
  const client = getSupabaseClient();
  const channel = ordersRealtimeChannel;
  ordersRealtimeChannel = null;
  ordersLiveState = state || "off";
  if (channel && client) {
    try { client.removeChannel(channel); } catch (e) { /* ignore */ }
  }
  renderOrdersNotices();
}

function handleOrdersRealtimeChange(payload) {
  if (payload && payload.eventType === "INSERT" && payload.new) {
    ordersNewOrderNotices = [{ id: payload.new.id, name: payload.new.name }, ...ordersNewOrderNotices.filter((n) => n.id !== payload.new.id)].slice(0, 3);
    renderOrdersNotices();
    // js/admin-notifications.js (sound/title badge); its first call also
    // switches off that file's polling fallback. It owns document.title.
    try {
      if (typeof window.onAdminNewOrder === "function") window.onAdminNewOrder(payload.new);
    } catch (err) {
      console.warn("[Orders] onAdminNewOrder failed", err);
    }
  }
  clearTimeout(ordersRealtimeTimer);
  ordersRealtimeTimer = setTimeout(async () => {
    await refreshOrderList();
    // Refresh the open drawer too, unless the owner is mid-edit there.
    const changedId = payload && (payload.new || payload.old) ? String((payload.new && payload.new.id) || (payload.old && payload.old.id)) : "";
    if (orderDrawerOrder && changedId === String(orderDrawerOrder.id)) {
      if (payload.eventType === "DELETE") return;
      const drawer = document.getElementById("orderDrawer");
      const editing = orderDrawerDirty || (drawer && drawer.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName));
      const { data } = await getSupabaseClient().from("orders").select("*").eq("id", changedId).maybeSingle();
      if (!data || !orderDrawerOrder || String(orderDrawerOrder.id) !== changedId) return;
      if (editing) {
        orderDrawerOrder = { ...orderDrawerOrder, status: data.status, payment_status: data.payment_status };
        renderOrderDrawerHeader();
        loadOrderTimeline(orderDrawerOrder);
      } else {
        orderDrawerOrder = data;
        renderOrderDrawer();
      }
    }
  }, 700);
}

/* ----- View toggle (List | Calendar) ----- */

let ordersView = "list";
const ORDERS_VIEW_KEY = "admin-orders-view";

function setOrdersView(view) {
  ordersView = view === "calendar" ? "calendar" : "list";
  try { localStorage.setItem(ORDERS_VIEW_KEY, ordersView); } catch (e) { /* not persisted */ }
  document.querySelectorAll("#ordersViewToggle [data-orders-view]").forEach((b) => {
    const active = b.dataset.ordersView === ordersView;
    b.classList.toggle("active", active);
    b.setAttribute("aria-pressed", String(active));
  });
  document.getElementById("ordersListView").hidden = ordersView !== "list";
  const cal = document.getElementById("ordersCalendarView");
  cal.hidden = ordersView !== "calendar";
  if (ordersView === "calendar" && window.AdminOrderCalendar) window.AdminOrderCalendar.show(cal);
}

/* Sets the payment filter ('all' | 'balance_due' | 'unpaid' | 'deposit_paid'
   | 'paid') and syncs the pills. Called by the Overview deep links; the
   caller (the tab's onEnter) does the refresh, otherwise pass refresh=true. */
window.setOrdersPaymentFilter = function (value, refresh) {
  const v = ["all", "balance_due", "unpaid", "deposit_paid", "paid"].includes(value) ? value : "all";
  ordersPaymentFilter = v;
  setOrderChipActive("#ordersPaymentFilter", "payment", v);
  if (refresh) resetOrdersPagingAndRefresh();
};

registerAdminTab("orders", { btnId: "tabOrdersBtn", panelId: "ordersPanel", onEnter: (params) => {
  if (params) ordersPage = 0;
  if (params && ordersView === "calendar" && (params.status || params.search != null || params.payment || params.orderId)) setOrdersView("list");
  refreshOrderList({ skipCalendar: true });
  if (params && params.orderId) openOrderDrawer(String(params.orderId));
  if (ordersView === "calendar" && window.AdminOrderCalendar) {
    detectOrdersSchema().then(() => window.AdminOrderCalendar.show(document.getElementById("ordersCalendarView")));
  }
  if (window.AdminOrderMessages) window.AdminOrderMessages.renderEditor(document.getElementById("orderMessageTemplates"));
} });

registerAdminDirtyCheck(() => orderDrawerDirty || orderNoteDrafts.size > 0);

onAdminInit((client) => {
  try {
    if (localStorage.getItem(ORDERS_VIEW_KEY) === "calendar") ordersView = "calendar";
  } catch (e) { /* default list */ }
  document.querySelectorAll("#ordersViewToggle [data-orders-view]").forEach((b) => {
    b.addEventListener("click", () => setOrdersView(b.dataset.ordersView));
  });
  if (ordersView === "calendar") {
    document.getElementById("ordersListView").hidden = true;
    document.getElementById("ordersCalendarView").hidden = false;
    document.querySelectorAll("#ordersViewToggle [data-orders-view]").forEach((b) => {
      b.classList.toggle("active", b.dataset.ordersView === "calendar");
      b.setAttribute("aria-pressed", String(b.dataset.ordersView === "calendar"));
    });
  }

  document.getElementById("ordersFilter").addEventListener("click", (e) => {
    const btn = e.target.closest(".orders-filter-btn");
    if (!btn) return;
    ordersStatusFilter = btn.dataset.status;
    // Scoped to #ordersFilter — the Analytics range buttons share the
    // .orders-filter-btn class and would otherwise lose their highlight.
    setOrderChipActive("#ordersFilter", "status", btn.dataset.status);
    resetOrdersPagingAndRefresh();
  });
  document.getElementById("ordersPaymentFilter").addEventListener("click", (e) => {
    const btn = e.target.closest(".orders-filter-btn");
    if (!btn) return;
    ordersPaymentFilter = btn.dataset.payment;
    setOrderChipActive("#ordersPaymentFilter", "payment", btn.dataset.payment);
    resetOrdersPagingAndRefresh();
  });
  let orderSearchDebounce = null;
  document.getElementById("orderSearch").addEventListener("input", (e) => {
    clearTimeout(orderSearchDebounce);
    orderSearchDebounce = setTimeout(() => {
      ordersSearchQuery = e.target.value;
      resetOrdersPagingAndRefresh();
    }, 300);
  });
  document.getElementById("orderSort").addEventListener("change", (e) => {
    ordersSortMode = e.target.value;
    resetOrdersPagingAndRefresh();
  });
  document.getElementById("orderUpcomingOnly").addEventListener("change", (e) => {
    ordersUpcomingOnly = e.target.checked;
    resetOrdersPagingAndRefresh();
  });
  const fromEl = document.getElementById("orderDateFrom");
  const toEl = document.getElementById("orderDateTo");
  const clearDates = document.getElementById("orderDateClear");
  const onDates = () => {
    ordersDateFrom = /^\d{4}-\d{2}-\d{2}$/.test(fromEl.value) ? fromEl.value : "";
    ordersDateTo = /^\d{4}-\d{2}-\d{2}$/.test(toEl.value) ? toEl.value : "";
    if (ordersDateFrom) toEl.min = ordersDateFrom; else toEl.removeAttribute("min");
    clearDates.hidden = !ordersDateFrom && !ordersDateTo;
    resetOrdersPagingAndRefresh();
  };
  fromEl.addEventListener("change", onDates);
  toEl.addEventListener("change", onDates);
  clearDates.addEventListener("click", () => { fromEl.value = ""; toEl.value = ""; onDates(); });

  document.getElementById("orderList").addEventListener("click", (e) => {
    const open = e.target.closest("[data-open-id]");
    if (open) openOrderDrawer(open.dataset.openId, open);
    if (e.target.closest("[data-orders-clear-filters]")) clearAllOrderFilters();
    if (e.target.closest("[data-orders-retry]")) refreshOrderList();
  });
  document.getElementById("ordersPager").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-page]");
    if (!btn || btn.disabled) return;
    ordersPage = Math.max(0, ordersPage + (btn.dataset.page === "next" ? 1 : -1));
    refreshOrderList({ skipCounts: true }).then(() => {
      const list = document.getElementById("orderList");
      if (list && list.getBoundingClientRect().top < 0) list.scrollIntoView({ block: "start" });
    });
  });
  document.getElementById("ordersNotices").addEventListener("click", (e) => {
    const open = e.target.closest("[data-notice-open]");
    const dismiss = e.target.closest("[data-notice-dismiss]");
    const id = open ? open.dataset.noticeOpen : dismiss ? dismiss.dataset.noticeDismiss : null;
    if (!id) return;
    ordersNewOrderNotices = ordersNewOrderNotices.filter((n) => String(n.id) !== id);
    renderOrdersNotices();
    if (open) openOrderDrawer(id);
  });

  document.getElementById("exportOrdersCsvBtn").addEventListener("click", exportOrdersCsv);
  document.getElementById("orderSelectAll").addEventListener("change", (e) => {
    document.querySelectorAll("#orderList .order-select").forEach((box) => {
      box.checked = e.target.checked;
      if (e.target.checked) selectedOrderIds.add(box.dataset.selectId);
      else selectedOrderIds.delete(box.dataset.selectId);
    });
    syncOrderBulkSelectionUI(ordersVisibleCache);
  });
  document.getElementById("orderBulkContactedBtn").addEventListener("click", () => bulkUpdateOrderStatus("contacted"));
  document.getElementById("orderBulkQuotedBtn").addEventListener("click", () => bulkUpdateOrderStatus("quoted"));
  document.getElementById("orderBulkFulfilledBtn").addEventListener("click", () => bulkUpdateOrderStatus("fulfilled"));
  document.getElementById("orderBulkCancelledBtn").addEventListener("click", () => bulkUpdateOrderStatus("cancelled"));
  document.getElementById("orderBulkDeleteBtn").addEventListener("click", bulkDeleteOrders);
  document.getElementById("orderBulkClearBtn").addEventListener("click", clearOrderSelection);
  document.getElementById("cleanupOrderPhotosBtn").addEventListener("click", handleCleanupOrderPhotos);

  const daySheetDate = document.getElementById("orderDaySheetDate");
  daySheetDate.value = ordersTodayIso();
  document.getElementById("orderDaySheetBtn").addEventListener("click", () => {
    if (window.AdminOrderPrint) window.AdminOrderPrint.printDaySheet(daySheetDate.value || ordersTodayIso());
  });

  // Stop listening when the session ends; the next login starts again.
  client.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") {
      ordersRealtimeFailed = false;
      stopOrdersRealtime("off");
      closeOrderDrawer(true);
    }
  });
});
