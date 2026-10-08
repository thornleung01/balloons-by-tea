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
    // getSession() reads the stored session locally — no network call.
    client.auth.getSession().then(({ data }) => {
      if (data && data.session) return;
      return client.from("analytics_events").insert(row);
    }).then(
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
