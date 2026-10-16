/* New-order notifications (admin side). Renders a "Notifications" card into
   the Settings tab (a <section id="notifyAdmin"> inserted just before
   #backupAdmin) and runs optional in-browser new-order alerts.

   Card:
     - Setup status: database trigger (public.notify_setup_status() from
       supabase-migrations/20-notifications.sql), Edge Function secrets
       (notify-new-order, { action: "status" }), and whether the function
       accepts calls without a Supabase login (it must, for the database
       to reach it).
     - "Connect the database": saves the function URL + shared secret to
       Vault through public.set_notify_config().
     - "Send test notification": invokes notify-new-order with
       { action: "test" }; the function sends a sample order and checks
       the caller is the admin via is_admin().
     - Customer confirmation text: site_settings keys
       notify_customer_subject / notify_customer_body.
     - Browser alerts: asks for Notification permission on a button press.

   New-order alerts: while the dashboard is open, polls public.orders for
   rows with an id above the newest one seen (every 60s). When a new order
   shows up it bumps document.title to "(n) <title>" and, if allowed, shows
   a browser Notification. Opening the Orders tab clears the count.
   window.onAdminNewOrder(order) is the hook for a realtime subscription:
   the first call switches the polling off for the rest of the page.

   Everything degrades quietly: a missing migration, an undeployed
   function or an unsupported browser just shows as "not set up". Uses
   getSupabaseClient()/isMissingTableError()/SUPABASE_CONFIG from
   js/supabase-config.js and escapeHtml()/mustAffect()/onAdminInit()/
   registerAdminDirtyCheck()/switchTab() from js/admin-core.js. */
(function () {
  const FUNCTION_NAME = "notify-new-order";
  const POLL_MS = 60 * 1000;
  const CUSTOMER_KEYS = ["notify_customer_subject", "notify_customer_body"];

  let client = null;
  let rendered = false;
  let statusLoadedOnce = false;
  let customerBaseline = null; // { subject, body } as last loaded/saved

  // New-order alert state
  const baseTitle = document.title;
  let unseenCount = 0;
  let lastSeenId = null;          // newest order id we know about
  const seenIds = new Set();
  let pollTimer = null;
  let realtimeActive = false;
  let polling = false;

  /* ===== Small helpers ===== */

  function $(id) { return document.getElementById(id); }

  function setStatus(el, message, kind) {
    if (!el) return;
    el.textContent = message;
    el.className = `form-status${kind ? " " + kind : ""}`;
  }

  function defaultFunctionUrl() {
    try {
      return `${String(SUPABASE_CONFIG.url).replace(/\/+$/, "")}/functions/v1/${FUNCTION_NAME}`;
    } catch (e) {
      return "";
    }
  }

  function randomSecret() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  /* functions.invoke() wraps non-2xx answers in an error whose `context`
     is the Response; pull the function's JSON body out of it if there is
     one. Returns { data, status, error } and never throws. */
  async function invokeFunction(body) {
    try {
      const { data, error } = await client.functions.invoke(FUNCTION_NAME, { body });
      if (!error) return { data, status: 200, error: null };
      const res = error.context;
      let parsed = null;
      let status = 0;
      if (res && typeof res.status === "number") {
        status = res.status;
        try { parsed = await res.clone().json(); } catch (e) { parsed = null; }
      }
      return { data: parsed, status, error };
    } catch (err) {
      return { data: null, status: 0, error: err };
    }
  }

  function statusItem(state, label, detail) {
    const info = { ok: ["success", "Done"], warn: ["warning", "Check"], off: ["neutral", "Optional"], bad: ["danger", "Fix"] }[state] || ["neutral", ""];
    return `<li class="notify-status-item notify-${state}"><span class="notify-status-icon a-badge a-badge--${info[0]}">${info[1]}</span><span class="notify-status-text"><strong>${escapeHtml(label)}</strong>${detail ? `<span class="notify-status-detail">${escapeHtml(detail)}</span>` : ""}</span></li>`;
  }

  /* ===== Rendering ===== */

  function renderShell(root) {
    root.innerHTML = `
      <div class="sys-head"><h2>Notifications</h2><span class="a-badge a-badge--neutral" id="notifyBadge">Not checked</span></div>
      <p class="backup-intro">Get an email (and optionally a text message) the moment a new order comes in. Setup takes about 15 minutes, step by step in <code>docs/admin-notifications.md</code>.</p>

      <h3 class="notify-subheading">Setup status</h3>
      <ul class="notify-status-list" id="notifyStatusList"><li class="notify-status-item">Not checked yet. Press Check setup.</li></ul>
      <div class="notify-actions">
        <button type="button" class="btn btn-outline" id="notifyCheckBtn">Check setup</button>
        <button type="button" class="btn btn-primary" id="notifyTestBtn">Send test notification</button>
      </div>
      <div class="form-status" id="notifyTestStatus" role="status" aria-live="polite"></div>

      <details class="notify-details" id="notifyConnectDetails">
        <summary>Connect the database to the function</summary>
        <p class="backup-intro">So new orders trigger the function automatically. Paste the same secret here and into the function's <code>NOTIFY_WEBHOOK_SECRET</code> secret (or press Generate, then copy it there).</p>
        <div class="field"><label for="notifyUrl">Function URL</label><input id="notifyUrl" type="url" autocomplete="off" spellcheck="false"/></div>
        <div class="field">
          <label for="notifySecret">Shared secret</label>
          <div class="notify-inline">
            <input id="notifySecret" class="notify-token" type="text" autocomplete="off" spellcheck="false" placeholder="Leave empty to keep the saved secret"/>
            <button type="button" class="btn btn-outline" id="notifyGenerateBtn">Generate</button>
            <button type="button" class="btn btn-outline" id="notifyCopyBtn">Copy</button>
          </div>
        </div>
        <button type="button" class="btn btn-primary" id="notifySaveConnBtn">Save connection</button>
        <div class="form-status" id="notifyConnStatus" role="status" aria-live="polite"></div>
      </details>

      <details class="notify-details" id="notifyCustomerDetails">
        <summary>Customer confirmation email</summary>
        <p class="backup-intro">Only sent when the function secret <code>NOTIFY_CUSTOMER</code> is <code>true</code> and the customer gave an email. You can use {name}, {business} and {event} (becomes " for &lt;date&gt;"). Leave a box empty to use the built-in text.</p>
        <div class="field"><label for="notifyCustSubject">Subject</label><input id="notifyCustSubject" type="text" maxlength="200" placeholder="We got your request - {business}"/></div>
        <div class="field"><label for="notifyCustBody">Message</label><textarea id="notifyCustBody" rows="6" maxlength="5000" placeholder="Hi {name}, thank you for reaching out to {business}! We've received your request{event} and will be in touch shortly."></textarea></div>
        <button type="button" class="btn btn-primary" id="notifyCustSaveBtn" disabled>Save message</button>
        <div class="form-status" id="notifyCustStatus" role="status" aria-live="polite"></div>
      </details>

      <h3 class="notify-subheading">Browser alerts</h3>
      <p class="backup-intro">While this admin page is open, show a pop-up and a count in the tab title when a new order arrives. Works in this browser only.</p>
      <div class="notify-actions">
        <button type="button" class="btn btn-outline" id="notifyBrowserBtn">Turn on browser alerts</button>
        <span class="notify-status-detail" id="notifyBrowserState"></span>
      </div>
    `;
    $("notifyUrl").value = defaultFunctionUrl();
    $("notifyCheckBtn").addEventListener("click", checkSetup);
    $("notifyTestBtn").addEventListener("click", sendTest);
    $("notifyGenerateBtn").addEventListener("click", () => { $("notifySecret").value = randomSecret(); });
    $("notifyCopyBtn").addEventListener("click", copySecret);
    $("notifySaveConnBtn").addEventListener("click", saveConnection);
    $("notifyCustSaveBtn").addEventListener("click", saveCustomerText);
    $("notifyCustomerDetails").addEventListener("toggle", () => {
      if ($("notifyCustomerDetails").open && customerBaseline === null) loadCustomerText();
    });
    $("notifyBrowserBtn").addEventListener("click", enableBrowserAlerts);
    renderBrowserState();
  }

  function ensureRendered() {
    if (rendered) return;
    const panel = $("settingsPanel");
    if (!panel) return;
    let root = $("notifyAdmin");
    if (!root) {
      root = document.createElement("section");
      root.id = "notifyAdmin";
      root.className = "backup-section notify-section";
      const backup = $("backupAdmin");
      if (backup && backup.parentNode === panel) panel.insertBefore(root, backup);
      else panel.appendChild(root);
    }
    renderShell(root);
    rendered = true;
  }

  /* ===== Setup status ===== */

  async function checkDatabase() {
    try {
      const { data, error } = await client.rpc("notify_setup_status");
      if (error) {
        if (isMissingTableError(error, "notify_setup_status")) {
          return [statusItem("off", "Database trigger: not installed", "Run supabase-migrations/20-notifications.sql in the Supabase SQL Editor.")];
        }
        return [statusItem("bad", "Database trigger: couldn't check", error.message)];
      }
      const s = data || {};
      const items = [];
      if (!s.pg_net) items.push(statusItem("bad", "pg_net extension is off", "Turn it on: Dashboard → Database → Extensions → pg_net, then re-run the migration."));
      items.push(s.trigger
        ? statusItem("ok", "Database trigger installed")
        : statusItem("bad", "Database trigger missing", "Re-run supabase-migrations/20-notifications.sql."));
      if (!s.vault) {
        items.push(statusItem("bad", "Vault not available", "Use a Dashboard Database Webhook instead (see the docs)."));
      } else if (s.url && s.secret_set) {
        items.push(statusItem("ok", "Database connected to the function", s.url));
        if (s.url) $("notifyUrl").value = s.url;
      } else {
        items.push(statusItem("warn", "Database not connected yet", "Open \"Connect the database to the function\" below. (Skip this if you set up a Database Webhook instead.)"));
      }
      return items;
    } catch (err) {
      return [statusItem("bad", "Database trigger: couldn't check", err.message || String(err))];
    }
  }

  async function checkFunction() {
    const { data, status, error } = await invokeFunction({ action: "status" });
    if (error) {
      if (status === 404) return [statusItem("off", "Function not deployed yet", `Deploy "${FUNCTION_NAME}" (see the docs).`)];
      if (status === 401) return [statusItem("bad", "Function refused your login", "Make sure is_admin() matches the account you're logged in with.")];
      const msg = (data && data.error) || error.message || "Couldn't reach the function";
      return [statusItem("bad", "Function: couldn't check", status ? `${status}: ${msg}` : msg)];
    }
    const s = data || {};
    return [
      statusItem("ok", "Function deployed"),
      s.email
        ? statusItem("ok", "Owner email configured")
        : statusItem("bad", "Owner email not configured", "Set RESEND_API_KEY, NOTIFY_EMAIL_TO and NOTIFY_EMAIL_FROM."),
      s.webhookSecret
        ? statusItem("ok", "Webhook secret set")
        : statusItem("bad", "Webhook secret missing", "Set NOTIFY_WEBHOOK_SECRET, or new orders can't trigger the function."),
      s.adminUrl
        ? statusItem("ok", "Admin link set")
        : statusItem("warn", "ADMIN_URL not set", "Emails won't have an \"Open in admin\" button."),
      s.sms ? statusItem("ok", "Text messages on (Twilio)") : statusItem("off", "Text messages off", "Optional: add the Twilio secrets."),
      s.customer ? statusItem("ok", "Customer confirmation emails on") : statusItem("off", "Customer confirmation emails off", "Optional: set NOTIFY_CUSTOMER to true.")
    ];
  }

  /* The database calls the function without a Supabase login, so the
     function must be deployed with JWT verification off. Calling it with
     no Authorization header tells the two apart: our own code answers
     "Not authorized" (good), the platform's JWT check answers something
     else, usually without CORS headers so fetch() fails outright. */
  async function checkPublicReachability() {
    const url = $("notifyUrl").value.trim() || defaultFunctionUrl();
    if (!url) return [];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ping" })
      });
      let body = null;
      try { body = await res.json(); } catch (e) { body = null; }
      if (res.status === 401 && body && body.ok === false && body.error === "Not authorized") {
        return [statusItem("ok", "Function accepts database calls", "JWT verification is off, as it should be.")];
      }
      if (res.status === 404) return [];
      return [statusItem("warn", "JWT verification may be on", "In the function's settings turn off \"Enforce JWT verification\" (or deploy with --no-verify-jwt).")];
    } catch (err) {
      return [statusItem("warn", "JWT verification may be on", "In the function's settings turn off \"Enforce JWT verification\" (or deploy with --no-verify-jwt).")];
    }
  }

  async function checkSetup() {
    const list = $("notifyStatusList");
    const btn = $("notifyCheckBtn");
    btn.disabled = true;
    list.innerHTML = `<li class="notify-status-item">Checking the setup...</li>`;
    try {
      const [db, fn] = await Promise.all([checkDatabase(), checkFunction()]);
      const deployed = !fn.some((html) => html.includes("Function not deployed"));
      const reach = deployed ? await checkPublicReachability() : [];
      const items = [...fn, ...reach, ...db];
      list.innerHTML = items.join("");
      const worst = items.some((h) => h.includes("notify-bad")) ? "bad" : items.some((h) => h.includes("notify-warn")) ? "warn" : "ok";
      const badge = $("notifyBadge");
      if (badge) {
        badge.className = `a-badge a-badge--${{ bad: "danger", warn: "warning", ok: "success" }[worst]}`;
        badge.textContent = { bad: "Needs attention", warn: "Almost ready", ok: "Ready" }[worst];
      }
    } finally {
      btn.disabled = false;
    }
  }

  /* ===== Test notification ===== */

  function describeResult(label, r) {
    if (!r) return "";
    if (r.status === "sent") return `${label}: sent`;
    if (r.status === "skipped") return `${label}: skipped (${r.detail || "not set up"})`;
    return `${label}: FAILED (${r.detail || "unknown error"})`;
  }

  async function sendTest() {
    const btn = $("notifyTestBtn");
    const statusEl = $("notifyTestStatus");
    btn.disabled = true;
    setStatus(statusEl, "Sending a sample order...");
    btn.textContent = "Sending...";
    try {
      const { data, status, error } = await invokeFunction({ action: "test" });
      const results = data && data.results;
      if (results) {
        const text = [
          describeResult("Owner email", results.owner),
          describeResult("Text message", results.sms),
          describeResult("Customer email preview", results.customer)
        ].filter(Boolean).join(" · ");
        const ok = !error && data.ok;
        setStatus(statusEl, ok ? `Test sent. ${text}. Check your inbox (and spam folder).` : `Test didn't fully work. ${text}`, ok ? "success" : "error");
        return;
      }
      if (status === 404) {
        setStatus(statusEl, `The "${FUNCTION_NAME}" function isn't deployed yet, see docs/admin-notifications.md.`, "error");
      } else {
        const msg = (data && data.error) || (error && error.message) || "Unknown error";
        setStatus(statusEl, `Couldn't send the test: ${status ? status + " " : ""}${msg}`, "error");
      }
    } finally {
      btn.disabled = false;
      btn.textContent = "Send test notification";
    }
  }

  /* ===== Connection (Vault) ===== */

  async function copySecret() {
    const value = $("notifySecret").value.trim();
    const statusEl = $("notifyConnStatus");
    if (!value) { setStatus(statusEl, "Nothing to copy yet. Press Generate first.", "error"); return; }
    try {
      await navigator.clipboard.writeText(value);
      setStatus(statusEl, "Secret copied. Paste it as NOTIFY_WEBHOOK_SECRET in the function's secrets.", "success");
      const copyBtn = $("notifyCopyBtn");
      if (copyBtn) {
        copyBtn.textContent = "Copied";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
      }
    } catch (e) {
      $("notifySecret").select();
      setStatus(statusEl, "Couldn't copy automatically. It's selected, press Ctrl+C (Cmd+C on a Mac).", "error");
    }
  }

  async function saveConnection() {
    const statusEl = $("notifyConnStatus");
    const btn = $("notifySaveConnBtn");
    const url = $("notifyUrl").value.trim();
    const secret = $("notifySecret").value.trim();
    if (!/^https:\/\/\S+$/.test(url)) { setStatus(statusEl, "The function URL must start with https://", "error"); return; }
    if (secret && secret.length < 16) { setStatus(statusEl, "Use a secret of at least 16 characters (press Generate).", "error"); return; }
    btn.disabled = true;
    setStatus(statusEl, "Saving…");
    try {
      const { data, error } = await client.rpc("set_notify_config", { p_url: url, p_secret: secret || null });
      if (error) {
        if (isMissingTableError(error, "set_notify_config")) {
          setStatus(statusEl, "Run supabase-migrations/20-notifications.sql in the Supabase SQL Editor first.", "error");
        } else {
          setStatus(statusEl, `Couldn't save: ${error.message}`, "error");
        }
        return;
      }
      if (data !== "ok") { setStatus(statusEl, String(data || "Couldn't save."), "error"); return; }
      setStatus(statusEl, secret
        ? "Saved. Make sure NOTIFY_WEBHOOK_SECRET in the function's secrets is exactly the same value."
        : "Saved (kept the existing secret).", "success");
      checkSetup();
    } finally {
      btn.disabled = false;
    }
  }

  /* ===== Customer confirmation text (site_settings) ===== */

  function customerValues() {
    return { subject: $("notifyCustSubject").value, body: $("notifyCustBody").value };
  }

  function customerTextDirty() {
    if (!rendered || customerBaseline === null) return false;
    const now = customerValues();
    return now.subject !== customerBaseline.subject || now.body !== customerBaseline.body;
  }

  async function loadCustomerText() {
    const statusEl = $("notifyCustStatus");
    const btn = $("notifyCustSaveBtn");
    btn.disabled = true;
    setStatus(statusEl, "Loading…");
    const { data, error } = await client.from("site_settings").select("key,value").in("key", CUSTOMER_KEYS);
    if (error) {
      setStatus(statusEl, `Couldn't load the message (${error.message}). Saving is off so it can't overwrite the saved text.`, "error");
      return;
    }
    const map = {};
    (data || []).forEach((r) => { map[r.key] = r.value || ""; });
    $("notifyCustSubject").value = map.notify_customer_subject || "";
    $("notifyCustBody").value = map.notify_customer_body || "";
    customerBaseline = customerValues(); // as the fields normalise it
    setStatus(statusEl, "");
    btn.disabled = false;
  }

  async function saveCustomerText() {
    const statusEl = $("notifyCustStatus");
    const btn = $("notifyCustSaveBtn");
    if (customerBaseline === null) return;
    const now = customerValues();
    const rows = [];
    if (now.subject !== customerBaseline.subject) rows.push({ key: "notify_customer_subject", value: now.subject.trim() });
    if (now.body !== customerBaseline.body) rows.push({ key: "notify_customer_body", value: now.body.trim() });
    if (!rows.length) { setStatus(statusEl, "Nothing has changed, nothing to save."); return; }
    btn.disabled = true;
    setStatus(statusEl, "Saving…");
    try {
      const { error } = await mustAffect(client.from("site_settings").upsert(rows, { onConflict: "key" }));
      if (error) { setStatus(statusEl, `Couldn't save: ${error.message}`, "error"); return; }
      customerBaseline = now;
      setStatus(statusEl, "Message saved.", "success");
    } finally {
      btn.disabled = false;
    }
  }

  /* ===== Browser alerts ===== */

  function notificationsSupported() {
    return typeof window.Notification === "function";
  }

  function renderBrowserState() {
    const btn = $("notifyBrowserBtn");
    const el = $("notifyBrowserState");
    if (!btn || !el) return;
    if (!notificationsSupported()) {
      btn.hidden = true;
      el.textContent = "This browser doesn't support pop-up alerts. The tab title will still show new orders.";
      return;
    }
    const p = Notification.permission;
    btn.hidden = p === "granted";
    el.textContent = p === "granted"
      ? "Browser alerts are on for this browser."
      : p === "denied"
        ? "Alerts are blocked. Allow notifications for this site in your browser's settings (the icon left of the address bar)."
        : "";
    if (p === "denied") btn.hidden = true;
  }

  async function enableBrowserAlerts() {
    if (!notificationsSupported()) return;
    try {
      const p = await Notification.requestPermission();
      if (p === "granted") {
        try { new Notification("Browser alerts are on", { body: "You'll see a pop-up like this when a new order arrives." }); } catch (e) { /* some mobile browsers only allow service-worker notifications */ }
      }
    } catch (e) { /* older Safari: callback-style API, ignore */ }
    renderBrowserState();
  }

  function ordersTabVisible() {
    const panel = $("ordersPanel");
    return Boolean(panel && !panel.hidden && !document.hidden);
  }

  function updateTitle() {
    document.title = unseenCount > 0 ? `(${unseenCount}) ${baseTitle}` : baseTitle;
  }

  function clearUnseen() {
    if (!unseenCount) return;
    unseenCount = 0;
    updateTitle();
  }

  function showOrderNotification(order) {
    if (!notificationsSupported() || Notification.permission !== "granted") return;
    if (ordersTabVisible() && document.hasFocus()) return; // already looking at it
    const name = (order && order.name) || "a customer";
    const when = (order && (order.event_on || order.event_date)) || "";
    const total = order && (order.total_amount != null && order.total_amount !== "" ? `$${Number(order.total_amount).toFixed(2)}` : order.total);
    const body = [when ? `Event: ${when}` : "", total ? `Total: ${total}` : "", order && order.phone ? order.phone : ""].filter(Boolean).join(" · ");
    try {
      const n = new Notification(`New ${order && order.kind === "custom" ? "request" : "order"} from ${name}`, {
        body: body || "Open the admin page to see it.",
        tag: `order-${order && order.id != null ? order.id : Date.now()}`
      });
      n.onclick = () => {
        window.focus();
        try { switchTab("orders"); } catch (e) { /* tab registry missing */ }
        n.close();
      };
    } catch (e) { /* mobile browsers may refuse page-level notifications */ }
  }

  /* Shared by polling and window.onAdminNewOrder. Returns true if the
     order was new to us. */
  function handleNewOrder(order) {
    const id = order && order.id != null ? String(order.id) : null;
    if (id !== null) {
      if (seenIds.has(id)) return false;
      seenIds.add(id);
      const n = Number(order.id);
      if (Number.isFinite(n) && (lastSeenId === null || n > lastSeenId)) lastSeenId = n;
    }
    if (!ordersTabVisible()) {
      unseenCount += 1;
      updateTitle();
    }
    showOrderNotification(order);
    return true;
  }

  function dashboardOpen() {
    const view = $("dashboardView");
    return Boolean(view && !view.hidden);
  }

  async function pollOnce() {
    if (polling || realtimeActive || !client) return;
    if (!dashboardOpen()) { lastSeenId = null; return; } // logged out: re-baseline on next login
    polling = true;
    try {
      if (lastSeenId === null) {
        const { data, error } = await client.from("orders").select("id").order("id", { ascending: false }).limit(1);
        if (error) return;
        lastSeenId = data && data.length ? Number(data[0].id) : 0;
        return;
      }
      const { data, error } = await client.from("orders").select("*").gt("id", lastSeenId).order("id", { ascending: true }).limit(20);
      if (error || !data || !data.length || realtimeActive) return;
      let anyNew = false;
      data.forEach((order) => { if (handleNewOrder(order)) anyNew = true; });
      // Keep the Orders list fresh too, unless the admin is typing in it.
      const ordersPanel = $("ordersPanel");
      const typing = ordersPanel && ordersPanel.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (anyNew && !typing && typeof refreshOrderList === "function") {
        try { await refreshOrderList(); } catch (e) { /* the list shows its own errors */ }
      }
    } catch (e) {
      // Network blip: try again next tick.
    } finally {
      polling = false;
    }
  }

  function startPolling() {
    if (pollTimer || realtimeActive) return;
    pollTimer = setInterval(pollOnce, POLL_MS);
    // First baseline shortly after login has had a chance to finish.
    setTimeout(pollOnce, 5000);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  /* Public hook for the Orders tab's realtime subscription: call it with
     each newly inserted order row. The first call turns polling off. */
  window.onAdminNewOrder = function (order) {
    if (!realtimeActive) {
      realtimeActive = true;
      stopPolling();
    }
    try { handleNewOrder(order || {}); } catch (e) { console.warn("[notifications] onAdminNewOrder failed", e); }
  };

  /* ===== Wiring ===== */

  onAdminInit((c) => {
    client = c;
    ensureRendered();
    const settingsBtn = $("tabSettingsBtn");
    if (settingsBtn) {
      settingsBtn.addEventListener("click", () => {
        if (!statusLoadedOnce) { statusLoadedOnce = true; checkSetup(); }
      });
    }
    const ordersBtn = $("tabOrdersBtn");
    if (ordersBtn) ordersBtn.addEventListener("click", clearUnseen);
    document.addEventListener("visibilitychange", () => { if (ordersTabVisible()) clearUnseen(); });
    window.addEventListener("focus", () => { if (ordersTabVisible()) clearUnseen(); });
    startPolling();
  });

  registerAdminDirtyCheck(customerTextDirty);
})();
