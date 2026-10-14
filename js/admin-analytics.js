/* Admin "Analytics" tab. Uses helpers from js/admin-core.js. */

/* ===== Analytics =====
   Reads the analytics_events table js/analytics.js writes to from every
   public page (see trackEvent() there for the exact event names/shapes).
   A funnel step's count is the number of DISTINCT SESSIONS that logged
   that event, not the raw row count — a field-error event can fire
   several times in one session (one per failed submit attempt), and
   counting rows instead of sessions would overstate drop-off.

   The counting happens in Postgres (analytics_summary(), see
   supabase-setup.sql), which returns one small summary object. Until that
   function has been created, the same summary is built here in the
   browser from every event in the range, fetched page by page
   (computeAnalyticsSummary — keep its rules in sync with the SQL). */
let analyticsRangeDays = 30;
// Bumped on every refresh so a slow, older load (e.g. after a quick range
// switch) can't overwrite the panel once a newer one has started.
let analyticsRefreshSeq = 0;
const ANALYTICS_PAGE_SIZE = 1000;

function analyticsRangeStartIso() {
  if (analyticsRangeDays === "all") return "1970-01-01T00:00:00Z";
  const d = new Date();
  d.setDate(d.getDate() - Number(analyticsRangeDays));
  return d.toISOString();
}

async function refreshAnalyticsPanel() {
  const seq = ++analyticsRefreshSeq;
  const content = document.getElementById("analyticsContent");
  content.innerHTML = `<p class="empty-note">Loading...</p>`;
  const client = getSupabaseClient();
  // A fixed upper bound so both paths count exactly the same window, and
  // events logged mid-load can't shift the fallback's pages.
  const fromIso = analyticsRangeStartIso();
  const toIso = new Date().toISOString();

  let { data, error } = await client.rpc("analytics_summary", { from_ts: fromIso, to_ts: toIso });
  if (seq !== analyticsRefreshSeq) return;
  let usedFallback = false;
  if (error && isMissingTableError(error, "analytics_summary")) {
    usedFallback = true;
    const events = await fetchAllAnalyticsEvents(client, fromIso, toIso);
    if (seq !== analyticsRefreshSeq) return;
    error = events.error;
    data = error ? null : computeAnalyticsSummary(events.data);
  }

  if (error) {
    // Most likely cause: the analytics_events table/migration hasn't been
    // run yet (see supabase-setup.sql) — give a specific, actionable
    // message instead of a raw Postgres error for that common case.
    content.innerHTML = `<p class="form-status error">${isMissingTableError(error, "analytics_events")
      ? "The analytics_events table doesn't exist yet — run the latest supabase-setup.sql in your Supabase SQL Editor to turn tracking on."
      : "Couldn't load analytics: " + escapeHtml(error.message)}</p>`;
    return;
  }
  renderAnalyticsPanel(data, usedFallback);
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
   supabase-setup.sql). Used only when the function doesn't exist yet. */
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

function funnelBarHtml(label, count, maxCount) {
  const pct = maxCount > 0 ? Math.round((count / maxCount) * 100) : 0;
  return `
    <div class="analytics-funnel-row">
      <span class="analytics-funnel-label">${escapeHtml(label)}</span>
      <div class="analytics-funnel-track"><div class="analytics-funnel-fill" style="width:${pct}%"></div></div>
      <span class="analytics-funnel-count">${count}</span>
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

/* Leaderboard of which products get added to cart the most — a raw row
   count per product (NOT deduped by session, unlike the funnel steps
   above), since every add is a separate signal of interest. Grouped by
   metadata.productId, falling back to metadata.name as the key for any
   row missing a productId so one malformed row can't blow up the whole
   aggregation. The display name/collection for a product comes from the
   newest row for that key (summary.top_products already holds the top 8
   in order), since a product's name could change over time and only the
   event metadata (not live catalog data) is available here. */
function topProductsHtml(summary) {
  const top = summary.top_products || [];
  if (!top.length) {
    return `<div class="analytics-card"><h3>Most added to cart</h3><p class="empty-note">No data in this range.</p></div>`;
  }

  const max = top[0].count;
  const extraCount = (summary.product_count || 0) - top.length;

  const rows = top
    .map((p) => {
      const name = p.name || "Unknown product";
      const label = p.collection ? `${name} (${p.collection})` : name;
      return funnelBarHtml(label, p.count, max);
    })
    .join("");

  return `
    <div class="analytics-card">
      <h3>Most added to cart</h3>
      ${rows}
      ${extraCount > 0 ? `<p class="analytics-note">+${extraCount} more product${extraCount === 1 ? "" : "s"} added to cart in this range.</p>` : ""}
    </div>
  `;
}

/* Deletes analytics_events rows older than the cutoff picked in the
   "Clear old events" select. Always counts the exact rows that WOULD be
   deleted first (a head-only, count:"exact" select — no rows fetched) so
   the confirm() dialog states a real number instead of a vague warning,
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
    alert("Couldn't clear events: " + countError.message);
    return;
  }

  if (!count) {
    btn.disabled = false;
    select.disabled = false;
    statusEl.textContent = "No events older than that to clear.";
    return;
  }

  const confirmed = confirm(`Delete ${count.toLocaleString()} analytics events older than ${cutoffDateLabel}? This can't be undone.`);
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
    deleteError = { message: "Nothing was deleted — your login may have expired. Refresh the page and try again." };
  }

  btn.disabled = false;
  select.disabled = false;

  if (deleteError) {
    alert("Couldn't clear events: " + deleteError.message);
    return;
  }

  statusEl.textContent = `Cleared ${count.toLocaleString()} old analytics event${count === 1 ? "" : "s"}.`;
  statusEl.className = "form-status success";
  await refreshAnalyticsPanel();
}

/* summary is analytics_summary()'s object (or computeAnalyticsSummary()'s,
   same shape). usedFallback adds a nudge to create the server function. */
function renderAnalyticsPanel(summary, usedFallback) {
  const content = document.getElementById("analyticsContent");
  const tipHtml = usedFallback
    ? `<p class="analytics-note">Tip: run the latest supabase-setup.sql for faster analytics.</p>`
    : "";
  if (!summary || !summary.total_events) {
    content.innerHTML = `<p class="empty-note">No analytics events in this range yet.</p>${tipHtml}`;
    return;
  }
  const sessionsByEvent = summary.sessions_by_event || {};
  const eventsByEvent = summary.events_by_event || {};

  const mainFunnelSteps = [
    ["page_view", "Visited the site"],
    ["add_to_cart", "Added something to cart"],
    ["cart_opened", "Opened the cart"],
    ["checkout_started", "Started checkout"],
    ["checkout_submitted", "Completed checkout"]
  ];
  const mainCounts = mainFunnelSteps.map(([name, label]) => [label, sessionsByEvent[name] || 0]);
  const mainMax = mainCounts[0][1] || 1;

  const customFunnelSteps = [
    ["custom_order_started", "Started the custom-order form"],
    ["custom_order_submitted", "Submitted a custom-order request"]
  ];
  const customCounts = customFunnelSteps.map(([name, label]) => [label, sessionsByEvent[name] || 0]);
  const customMax = customCounts[0][1] || 1;

  const abandonCount = eventsByEvent.checkout_abandoned || 0;
  const abandonFields = summary.abandon_fields || [];
  const checkoutFailedCount = eventsByEvent.checkout_failed || 0;

  content.innerHTML = `
    ${topProductsHtml(summary)}
    <div class="analytics-card">
      <h3>Checkout funnel</h3>
      ${mainCounts.map(([label, count]) => funnelBarHtml(label, count, mainMax)).join("")}
      ${checkoutFailedCount > 0 ? `<p class="analytics-note">${checkoutFailedCount} checkout submission${checkoutFailedCount === 1 ? "" : "s"} failed with a backend error in this range.</p>` : ""}
    </div>
    <div class="analytics-card">
      <h3>Checkout abandoned (closed with unsaved input)</h3>
      <p class="analytics-big-number">${abandonCount}</p>
      ${abandonFields.length
        ? `<p class="analytics-note">Fields already filled in when people bailed, most common first:</p>${abandonFields.map(({ field, count }) => funnelBarHtml(field, count, abandonFields[0].count)).join("")}`
        : `<p class="empty-note">No abandonment data in this range.</p>`}
    </div>
    ${fieldBreakdownHtml("Checkout form — which field trips people up", summary.checkout_field_errors || [])}
    <div class="analytics-card">
      <h3>Custom-order funnel</h3>
      ${customCounts.map(([label, count]) => funnelBarHtml(label, count, customMax)).join("")}
    </div>
    ${fieldBreakdownHtml("Custom-order form — which field trips people up", summary.custom_field_errors || [])}
    ${tipHtml}
  `;
}

registerAdminTab("analytics", { btnId: "tabAnalyticsBtn", panelId: "analyticsPanel", onEnter: refreshAnalyticsPanel });

onAdminInit(() => {
  document.getElementById("analyticsRangeFilter").addEventListener("click", (e) => {
    const btn = e.target.closest(".orders-filter-btn");
    if (!btn) return;
    analyticsRangeDays = btn.dataset.range === "all" ? "all" : Number(btn.dataset.range);
    document.querySelectorAll("#analyticsRangeFilter .orders-filter-btn").forEach((b) => b.classList.toggle("active", b === btn));
    refreshAnalyticsPanel();
  });
  document.getElementById("analyticsClearBtn").addEventListener("click", clearOldAnalyticsEvents);
});
