/*
  Lightweight first-party funnel/friction tracking — backed by a Supabase
  table (analytics_events), not a third-party script. Same anon-can-INSERT,
  only-admin-can-read pattern already used for `orders` (see
  supabase-setup.sql). Every call is fire-and-forget and swallows its own
  errors: analytics must never be able to break the real site, and it
  never blocks or delays the action it's recording.

  Pairs with Microsoft Clarity (session replay/heatmaps, added separately
  via a script tag once a project ID exists) for the qualitative "why" —
  this file is for the quantitative "where exactly do people stop."
*/

const ANALYTICS_SESSION_KEY = "balloons_analytics_session";

function getAnalyticsSessionId() {
  try {
    let id = sessionStorage.getItem(ANALYTICS_SESSION_KEY);
    if (!id) {
      id = (typeof crypto !== "undefined" && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem(ANALYTICS_SESSION_KEY, id);
    }
    return id;
  } catch (err) {
    return "unknown"; // sessionStorage can throw in some private-browsing modes
  }
}

/* True if supabase-js has a stored login session in this browser (its
   localStorage key is "sb-<project-ref>-auth-token"). Checked synchronously
   instead of via auth.getSession(), which may make a network call to
   refresh an expired token — and if that refresh failed, the admin's own
   visit would get counted after all. An expired-but-present session still
   means "this is the admin's browser", which is what matters here. */
function hasStoredAuthSession() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (/^sb-.+-auth-token$/.test(key) && localStorage.getItem(key)) return true;
    }
  } catch (err) {
    // storage blocked (private mode etc.) — treat as a normal visitor
  }
  return false;
}

/* ===== Traffic source (where this browser session came from) =====
   Worked out once per browser session from the landing URL's utm_* params
   and document.referrer, then attached to the session's FIRST event only
   as metadata keys traffic_source / ref_host / utm_source / utm_medium /
   utm_campaign (the admin Analytics tab reads traffic_source off each
   session's earliest event — see supabase-migrations/50-analytics.sql).
   Values for traffic_source match orders.source:
     'instagram' | 'google' | 'facebook' | 'tiktok' | 'direct'
     | 'referral:<host>' | any other utm_source value (lower-cased).
   utm_source wins over the referrer; ad click ids (gclid/fbclid/ttclid)
   come next; a referrer from this same site counts as direct. The result
   is kept in sessionStorage so later pages in the session (and the order
   forms, via analyticsSessionTrafficSource()) see the same answer. */
const ANALYTICS_SOURCE_KEY = "balloons_analytics_source";
const ANALYTICS_SOURCE_SENT_KEY = "balloons_analytics_source_sent";
const ANALYTICS_KNOWN_SOURCES = [
  ["instagram", /(^|\.)instagram\.com$/],
  ["facebook", /(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com)$/],
  ["tiktok", /(^|\.)tiktok\.com$/],
  ["google", /(^|\.)google\.[a-z.]+$|(^|\.)googleadservices\.com$/]
];
const ANALYTICS_SOURCE_ALIASES = { ig: "instagram", insta: "instagram", fb: "facebook", tt: "tiktok" };

function analyticsCleanParam(value, max) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._:\-]+/g, "-").slice(0, max || 60);
}

function analyticsHost(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch (err) { return ""; }
}

/* Pure: { search, referrer, ownHost } -> the metadata object described
   above. Separate from the location/document reads so it can be tested. */
function classifyTrafficSource({ search, referrer, ownHost }) {
  let params;
  try { params = new URLSearchParams(search || ""); } catch (err) { params = new URLSearchParams(); }
  const utmSource = analyticsCleanParam(params.get("utm_source"));
  const utmMedium = analyticsCleanParam(params.get("utm_medium"));
  const utmCampaign = analyticsCleanParam(params.get("utm_campaign"), 80);
  let refHost = analyticsHost(referrer);
  if (refHost && ownHost && refHost === String(ownHost).toLowerCase().replace(/^www\./, "")) refHost = "";

  const known = (host) => (ANALYTICS_KNOWN_SOURCES.find(([, re]) => re.test(host)) || [])[0] || "";
  let source;
  if (utmSource) {
    source = ANALYTICS_SOURCE_ALIASES[utmSource] || known(utmSource) || utmSource;
  } else if (params.get("gclid")) {
    source = "google";
  } else if (params.get("ttclid")) {
    source = "tiktok";
  } else if (refHost) {
    source = known(refHost) || `referral:${refHost}`;
  } else if (params.get("fbclid")) {
    source = "facebook"; // Instagram links carry fbclid too, but send a referrer
  } else {
    source = "direct";
  }

  const meta = { traffic_source: source };
  if (refHost) meta.ref_host = refHost;
  if (utmSource) meta.utm_source = utmSource;
  if (utmMedium) meta.utm_medium = utmMedium;
  if (utmCampaign) meta.utm_campaign = utmCampaign;
  return meta;
}

/* The session's traffic-source metadata (computed on first call, then
   remembered for the rest of the browser session). Never throws. */
function analyticsSessionTrafficMeta() {
  try {
    const stored = sessionStorage.getItem(ANALYTICS_SOURCE_KEY);
    if (stored) return JSON.parse(stored);
  } catch (err) { /* storage blocked or bad JSON — recompute */ }
  let meta;
  try {
    meta = classifyTrafficSource({ search: location.search, referrer: document.referrer, ownHost: location.hostname });
  } catch (err) {
    meta = { traffic_source: "direct" };
  }
  try { sessionStorage.setItem(ANALYTICS_SOURCE_KEY, JSON.stringify(meta)); } catch (err) { /* fine */ }
  return meta;
}

/* Just the source string, for the order forms to store in orders.source. */
function analyticsSessionTrafficSource() {
  return analyticsSessionTrafficMeta().traffic_source || "direct";
}

/* event_name is a short machine-readable tag (e.g. "checkout_started");
   metadata is a small plain object for extra context (field name on a
   validation error, product id on an add-to-cart, etc). Never await this
   from a caller — it's intentionally not awaited internally either, so a
   slow/offline network never makes tracking feel like it's blocking the
   actual user action it's attached to. */
function trackEvent(eventName, metadata) {
  try {
    const client = typeof getSupabaseClient === "function" ? getSupabaseClient() : null;
    if (!client) return;
    const row = {
      session_id: getAnalyticsSessionId(),
      event_name: eventName,
      page: (document.body && document.body.dataset.page) || location.pathname,
      metadata: metadata || {}
    };
    // Skip logged-in sessions: the only account that ever signs in is the
    // admin, and their own page visits (e.g. opening a page to use edit
    // mode) would otherwise inflate "Visited the site" in the funnel.
    if (hasStoredAuthSession()) return;
    // First event of this browser session: say where the visit came from.
    // Copied, never mutating the caller's metadata object. If
    // sessionStorage is blocked, every event carries it (harmless).
    let sourceSent = false;
    try { sourceSent = sessionStorage.getItem(ANALYTICS_SOURCE_SENT_KEY) === "1"; } catch (err) { /* blocked */ }
    if (!sourceSent) {
      row.metadata = { ...analyticsSessionTrafficMeta(), ...row.metadata };
      try { sessionStorage.setItem(ANALYTICS_SOURCE_SENT_KEY, "1"); } catch (err) { /* blocked */ }
    }
    client.from("analytics_events").insert(row).then(
      () => {},
      () => {} // a failed insert (offline, RLS misconfigured, etc.) is silently dropped
    );
  } catch (err) {
    // analytics must never throw into the caller's control flow
  }
}

document.addEventListener("DOMContentLoaded", () => {
  trackEvent("page_view");
});
