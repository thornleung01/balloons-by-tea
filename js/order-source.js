/*
  Where did this customer come from? Works out a short label — 'instagram',
  'google', 'facebook', 'direct', or another site's name — when someone
  first lands on the site, and keeps it in sessionStorage so it survives
  until they reach checkout (by which point document.referrer is just our
  own page). js/app.js submitOrder() saves it with the order (orders.source).

  Precedence: utm_source in the landing URL, then an ad click id (gclid /
  fbclid), then the referring site, then 'direct'. Only the FIRST landing
  of a browser session counts, so clicking around the site doesn't turn an
  Instagram visitor into 'direct'.

  Loaded on every public page, before js/app.js. Never throws: if storage
  is blocked the label is simply worked out from the current page.
*/
(function () {
  const STORAGE_KEY = "aura_order_source";

  // Referrer host (without "www.") -> label. Matched as a suffix, so
  // "l.instagram.com" and "m.facebook.com" are covered.
  const KNOWN_SITES = [
    ["instagram.com", "instagram"],
    ["facebook.com", "facebook"],
    ["fb.com", "facebook"],
    ["fb.me", "facebook"],
    ["messenger.com", "facebook"],
    ["tiktok.com", "tiktok"],
    ["pinterest.com", "pinterest"],
    ["pin.it", "pinterest"],
    ["youtube.com", "youtube"],
    ["youtu.be", "youtube"],
    ["xiaohongshu.com", "rednote"],
    ["xhslink.com", "rednote"],
    ["whatsapp.com", "whatsapp"],
    ["wa.me", "whatsapp"],
    ["t.co", "twitter"],
    ["twitter.com", "twitter"],
    ["x.com", "twitter"],
    ["bing.com", "bing"],
    ["duckduckgo.com", "duckduckgo"],
    ["yahoo.com", "yahoo"],
    ["linktr.ee", "linktree"]
  ];

  function clean(value) {
    return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  }

  function labelForHost(host) {
    const h = String(host || "").toLowerCase().replace(/^www\./, "");
    if (!h) return "";
    // google.com, google.ca, google.co.uk, ...
    if (/(^|\.)google\.[a-z.]+$/.test(h)) return "google";
    for (const [suffix, label] of KNOWN_SITES) {
      if (h === suffix || h.endsWith("." + suffix)) return label;
    }
    return clean(h);
  }

  function detect() {
    let params;
    try { params = new URLSearchParams(location.search); } catch (e) { params = new URLSearchParams(); }
    const utm = clean(params.get("utm_source"));
    if (utm) return utm;
    if (params.get("gclid")) return "google";
    if (params.get("fbclid")) return "facebook";
    let refHost = "";
    try { refHost = document.referrer ? new URL(document.referrer).hostname : ""; } catch (e) { refHost = ""; }
    if (!refHost || refHost === location.hostname) return "direct";
    return labelForHost(refHost) || "direct";
  }

  function capture() {
    try {
      const existing = sessionStorage.getItem(STORAGE_KEY);
      if (existing) {
        // A new utm-tagged landing mid-session (e.g. clicked a second ad)
        // wins over a plain 'direct' first touch.
        const fresh = detect();
        if (existing === "direct" && fresh !== "direct") sessionStorage.setItem(STORAGE_KEY, fresh);
        return;
      }
      sessionStorage.setItem(STORAGE_KEY, detect());
    } catch (e) {
      // storage blocked (private mode etc.) — get() falls back to detect()
    }
  }

  function get() {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) return stored;
    } catch (e) { /* fall through */ }
    try { return detect(); } catch (e) { return ""; }
  }

  try { capture(); } catch (e) { /* never break the page */ }

  window.OrderSource = { get, _labelForHost: labelForHost };
})();
