/* Event-date availability (customer side). Owned by the availability
   feature; registers a guard in window.ORDER_GUARDS (see runOrderGuards()
   in js/app.js).

   A date is unavailable when it's in the past, when the owner blocked it
   by hand (blocked_dates table), or when it already has as many orders as
   the daily limit allows (fully_booked_dates() SQL function — customers
   can't read the orders table itself). All of that lives in the
   "Event-date availability" section of supabase-setup.sql.

   Failure policy: any error loading availability (table/function not
   created yet, offline, Supabase down, slow network) means "no
   restrictions" — a broken lookup must never stop a real customer from
   ordering. Only the past-date check works without the database.

   The data is fetched lazily — the first time a customer touches a date
   field — then cached for the page; the submit-time guard re-fetches so a
   date that filled up in the meantime is still caught. */
window.ORDER_GUARDS = window.ORDER_GUARDS || [];

(function () {
  const LOOKAHEAD_DAYS = 400; // must stay <= the cap in fully_booked_dates()
  const FETCH_TIMEOUT_MS = 6000;

  // The two date fields this feature watches. errorId is the inline error
  // element; the checkout one doesn't exist in the HTML, so it's created.
  const FIELDS = [
    { formId: "checkoutForm", inputId: "date", errorId: "error-date", kind: "checkout" },
    { formId: "customOrderForm", inputId: "co-event-date", errorId: "co-error-eventDate", kind: "custom_order" }
  ];

  function pad(n) { return String(n).padStart(2, "0"); }

  // Local (not UTC) calendar date — a customer ordering at 9pm in Toronto
  // is still on "today", even though UTC has moved on.
  function localIsoDate(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function todayIso() { return localIsoDate(new Date()); }
  function addDaysIso(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return localIsoDate(d);
  }

  const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  // "Sat, Oct 12" (plus the year when it isn't this year).
  function friendlyDate(iso) {
    const m = ISO_DAY_RE.exec(iso);
    if (!m) return iso;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const opts = { weekday: "short", month: "short", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString("en-US", opts);
  }

  function withTimeout(promise) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), FETCH_TIMEOUT_MS))
    ]);
  }

  /* Returns { blocked: Set<iso>, full: Set<iso> }, or null if nothing
     could be loaded. The two lookups fail independently: a missing
     capacity function doesn't throw away the manual blocked dates. */
  async function fetchAvailability() {
    const client = typeof getSupabaseClient === "function" ? getSupabaseClient() : null;
    if (!client) return null;
    const from = todayIso();
    const to = addDaysIso(LOOKAHEAD_DAYS);

    // Newer supabase-js retries failed requests with backoff; for a
    // best-effort check that's just a longer wait at the submit button.
    const noRetry = (q) => (q && typeof q.retry === "function" ? q.retry(false) : q);
    const [blockedRes, fullRes] = await Promise.allSettled([
      withTimeout(noRetry(client.from("blocked_dates").select("day").gte("day", from).lte("day", to))),
      withTimeout(noRetry(client.rpc("fully_booked_dates", { from_day: from, to_day: to })))
    ]);

    const toSet = (res, pick) => {
      if (res.status !== "fulfilled" || !res.value || res.value.error || !Array.isArray(res.value.data)) return null;
      const set = new Set();
      res.value.data.forEach((row) => {
        const v = String(pick(row) || "").slice(0, 10);
        if (ISO_DAY_RE.test(v)) set.add(v);
      });
      return set;
    };
    // fully_booked_dates() returns a set of plain dates; depending on the
    // PostgREST version that's either ["2026-10-12", ...] or
    // [{ fully_booked_dates: "2026-10-12" }, ...] — accept both.
    const blocked = toSet(blockedRes, (row) => row && row.day);
    const full = toSet(fullRes, (row) => (row && typeof row === "object") ? (row.day || row.fully_booked_dates) : row);
    if (!blocked && !full) return null;
    return { blocked: blocked || new Set(), full: full || new Set() };
  }

  let cached = null;       // last successful result
  let pending = null;      // in-flight first load

  function loadOnce() {
    if (cached) return Promise.resolve(cached);
    if (!pending) {
      pending = fetchAvailability()
        .catch(() => null)
        .then((result) => {
          if (result) cached = result;
          else pending = null; // allow a later retry
          return result;
        });
    }
    return pending;
  }

  async function loadFresh() {
    let result = null;
    try { result = await fetchAvailability(); } catch (e) { result = null; }
    if (result) cached = result;
    // Re-fetch failed: fall back to what the customer was already shown
    // (if anything), otherwise no restrictions.
    return result || cached;
  }

  /* null when the date is fine (or empty), otherwise the message to show. */
  function problemFor(iso, data) {
    if (!iso || !ISO_DAY_RE.test(iso)) return null;
    if (iso < todayIso()) return "That date has already passed — please pick a date from today onward.";
    if (!data) return null;
    if (data.blocked.has(iso)) return `Sorry, we're not taking orders for ${friendlyDate(iso)} — please pick another date.`;
    if (data.full.has(iso)) return `Sorry, we're fully booked on ${friendlyDate(iso)} — please pick another date.`;
    return null;
  }

  function errorElFor(field) {
    let el = document.getElementById(field.errorId);
    if (el) return el;
    const input = document.getElementById(field.inputId);
    if (!input) return null;
    el = document.createElement("div");
    el.className = "field-error";
    el.id = field.errorId;
    input.insertAdjacentElement("afterend", el);
    const describedBy = (input.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
    if (!describedBy.includes(field.errorId)) {
      describedBy.push(field.errorId);
      input.setAttribute("aria-describedby", describedBy.join(" "));
    }
    return el;
  }

  function showProblem(field, input, message) {
    const el = errorElFor(field);
    if (message) {
      if (el) el.textContent = message;
      input.setAttribute("aria-invalid", "true");
    } else {
      if (el) el.textContent = "";
      input.removeAttribute("aria-invalid");
    }
  }

  function wireField(field) {
    const form = document.getElementById(field.formId);
    const input = document.getElementById(field.inputId);
    if (!form || !input || !form.contains(input)) return;

    input.min = todayIso();
    errorElFor(field);

    // Start loading as soon as the customer heads for the field, so the
    // answer is usually ready by the time they've picked a date.
    input.addEventListener("focus", () => { loadOnce(); }, { once: true });
    input.addEventListener("pointerdown", () => { loadOnce(); }, { once: true });

    input.addEventListener("change", async () => {
      const value = input.value;
      // Past dates can be flagged immediately, no network needed.
      showProblem(field, input, problemFor(value, cached));
      if (!value || !ISO_DAY_RE.test(value) || value < todayIso()) return;
      const data = await loadOnce();
      if (input.value !== value) return; // customer changed it again meanwhile
      showProblem(field, input, problemFor(value, data));
    });
  }

  window.ORDER_GUARDS.push(async ({ form, kind }) => {
    const field = FIELDS.find((f) => f.kind === kind && f.formId === form.id);
    if (!field) return null;
    const input = document.getElementById(field.inputId);
    if (!input) return null;
    const value = input.value;
    if (!value) return null; // optional on checkout; required-ness is app.js's job

    let message = problemFor(value, null); // past date — no database needed
    if (!message) message = problemFor(value, await loadFresh());
    if (!message) {
      // Clear a stale inline message (runOrderGuards only clears the
      // form-level error).
      showProblem(field, input, null);
      return null;
    }
    return { field: input.name, message };
  });

  function init() {
    FIELDS.forEach(wireField);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
