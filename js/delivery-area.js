/* Delivery-area check (customer side).

   The owner lists the postal areas they deliver to in the admin "Delivery"
   tab (table `delivery_areas`, one row per FSA — the first 3 characters of
   a Canadian postal code, e.g. "M5V"). Here we:
     - give instant feedback when a customer types a postal code
       (checkout modal #postal, custom-order page postal field), and
     - register an order guard (see runOrderGuards() in js/app.js) that
       re-checks at submit and stops a delivery outside the area.

   The check is OFF until configured: if the table is empty, doesn't exist
   yet, Supabase isn't set up, or the fetch fails/times out, nobody is
   blocked and the postal field stays optional. Pick-up custom orders are
   never checked. */
window.ORDER_GUARDS = window.ORDER_GUARDS || [];

(function () {
  const FETCH_TIMEOUT_MS = 4000;
  // Canada Post never uses D, F, I, O, Q or U; W and Z never start a code.
  const POSTAL_RE = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/;
  const POSTAL_IN_TEXT_RE = /\b([ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z])\s?(\d[ABCEGHJ-NPRSTV-Z]\d)\b/i;

  /* "m5v 3l9" / "M5V3L9" / " m5v-3l9 " -> "M5V3L9" */
  function normalizePostal(value) {
    return String(value || "").toUpperCase().replace(/[\s-]/g, "");
  }
  function formatPostal(compact) {
    return compact.length === 6 ? `${compact.slice(0, 3)} ${compact.slice(3)}` : compact;
  }

  /* ---- Loading the area list ------------------------------------------
     Resolves to a Map(fsa -> label) when the check is ON, or null when
     there's no restriction (not configured, empty, missing, or failed). A
     failed load isn't cached, so the submit-time check retries once. */
  let areasPromise = null;
  function loadAreas() {
    if (areasPromise) return areasPromise;
    areasPromise = fetchAreas().then((result) => {
      if (result.failed) areasPromise = null;
      applyRequiredState(result.areas);
      return result.areas;
    });
    return areasPromise;
  }

  /* A single plain REST read (public anon key, same RLS as supabase-js)
     rather than client.from(): supabase-js retries failed GETs with
     backoff for several seconds, which would stall the submit button. */
  async function fetchAreas() {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;
    try {
      const configured = typeof isSupabaseConfigured === "function" && isSupabaseConfigured();
      if (!configured) return { areas: null, failed: false };
      const res = await fetch(`${SUPABASE_CONFIG.url}/rest/v1/delivery_areas?select=fsa,label`, {
        headers: { apikey: SUPABASE_CONFIG.anonKey, Accept: "application/json" },
        signal: controller ? controller.signal : undefined
      });
      // Most often a 404: the table hasn't been created yet — expected
      // until the owner runs supabase-setup.sql, so stay quiet.
      if (!res.ok) return { areas: null, failed: true };
      const data = await res.json();
      const rows = Array.isArray(data) ? data : [];
      if (!rows.length) return { areas: null, failed: false };
      const map = new Map();
      rows.forEach((r) => {
        const fsa = normalizePostal(r && r.fsa).slice(0, 3);
        if (fsa.length === 3) map.set(fsa, (r.label || "").trim());
      });
      return { areas: map.size ? map : null, failed: false };
    } catch (err) {
      return { areas: null, failed: true };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /* ---- Per-form wiring ------------------------------------------------ */
  const FORMS = {
    checkout: { formId: "checkoutForm", errorId: "error-postal", noteId: "postal-note" },
    custom_order: { formId: "customOrderForm", errorId: "co-error-postal", noteId: "co-postal-note" }
  };

  function isPickup(kind, form) {
    return kind === "custom_order" && form.elements.service && form.elements.service.value === "pickup";
  }

  function applyRequiredState(areas) {
    Object.keys(FORMS).forEach((kind) => {
      const form = document.getElementById(FORMS[kind].formId);
      const input = form && form.elements.postal;
      if (!input) return;
      const required = !!areas && !isPickup(kind, form);
      input.required = required;
      if (required) input.setAttribute("aria-required", "true");
      else input.removeAttribute("aria-required");
    });
  }

  function whatsappHref() {
    const link = document.querySelector('a.whatsapp-float[href], a[href^="https://wa.me/"]');
    return link ? link.getAttribute("href") : "";
  }

  function link(href, text, external) {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = text;
    if (external) { a.target = "_blank"; a.rel = "noopener"; }
    return a;
  }

  /* Next-step note under an out-of-area message — DOM-built, no innerHTML. */
  function outOfAreaNote(kind) {
    const wa = whatsappHref();
    const frag = document.createDocumentFragment();
    if (kind === "custom_order") {
      frag.append("Choose Pick-up above and we'll have everything ready for you");
      if (wa) frag.append(", or ", link(wa, "message us on WhatsApp", true), " and we'll see what we can do");
      frag.append(".");
    } else {
      frag.append("You can still order: send a ", link("custom-order.html", "custom order request"), " and choose Pick-up");
      if (wa) frag.append(", or ", link(wa, "message us on WhatsApp", true), " to ask about your area");
      frag.append(".");
    }
    return frag;
  }

  function setMessages(kind, { error = "", note = null, ok = false } = {}) {
    const cfg = FORMS[kind];
    const form = document.getElementById(cfg.formId);
    const input = form && form.elements.postal;
    const errorEl = document.getElementById(cfg.errorId);
    const noteEl = document.getElementById(cfg.noteId);
    if (errorEl) errorEl.textContent = error;
    if (input) {
      if (error) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    }
    if (noteEl) {
      noteEl.textContent = "";
      if (note) noteEl.append(note);
      noteEl.classList.toggle("is-ok", ok);
    }
  }

  /* The core decision, shared by the live feedback and the submit guard.
     Returns { error, note, ok } (all empty when there's nothing to say). */
  async function evaluate(kind, form) {
    if (isPickup(kind, form)) return {};
    const input = form.elements.postal;
    if (!input) return {};
    let compact = normalizePostal(input.value);
    // Checkout: if the postal field is empty but the address already
    // contains a postal code (e.g. from "use my location"), use that.
    if (!compact && form.elements.address) {
      const m = POSTAL_IN_TEXT_RE.exec(form.elements.address.value || "");
      if (m) {
        compact = (m[1] + m[2]).toUpperCase();
        input.value = formatPostal(compact);
      }
    }

    const valueBeforeLoad = normalizePostal(input.value);
    const areas = await loadAreas();
    if (!areas) return {}; // check is off — never block
    // The customer may have corrected the code while the list was loading.
    // Re-run on what's in the field now (the list is cached, so this is
    // instant) instead of writing the old value back over their edit.
    if (normalizePostal(input.value) !== valueBeforeLoad) return evaluate(kind, form);

    if (!compact) {
      return { error: "Please add your postal code so we can confirm we deliver to you." };
    }
    if (!POSTAL_RE.test(compact)) {
      return { error: "That doesn't look like a Canadian postal code. Please enter it like M5V 3L9." };
    }
    input.value = formatPostal(compact);
    const fsa = compact.slice(0, 3);
    if (areas.has(fsa)) {
      const label = areas.get(fsa);
      return { ok: true, note: `Good news: we deliver to ${fsa}${label ? ` (${label})` : ""}.` };
    }
    return { error: `Sorry, ${fsa} is outside our delivery area.`, note: outOfAreaNote(kind) };
  }

  async function checkAndShow(kind, form) {
    const input = form.elements.postal;
    const seenValue = input ? input.value : "";
    let result = {};
    try { result = await evaluate(kind, form); } catch (err) { result = {}; }
    // Customer kept typing while we loaded — a newer check will follow.
    if (input && input.value !== seenValue && normalizePostal(input.value) !== normalizePostal(seenValue)) return result;
    // Don't nag about an empty field on blur; the submit guard handles it.
    if (!result.ok && !result.note && input && !normalizePostal(input.value)) setMessages(kind);
    else setMessages(kind, result);
    return result;
  }

  function wire(kind) {
    const form = document.getElementById(FORMS[kind].formId);
    if (!form || !form.elements.postal) return;
    const input = form.elements.postal;

    // Load the area list lazily, when the customer reaches the postal (or
    // address) field — page loads and just opening checkout cost nothing.
    const preload = () => { loadAreas(); };
    input.addEventListener("focus", preload, { once: true });
    if (form.elements.address && form.elements.address.addEventListener) form.elements.address.addEventListener("focus", preload, { once: true });

    input.addEventListener("input", () => setMessages(kind));
    input.addEventListener("change", () => checkAndShow(kind, form));
    if (form.elements.address && kind === "checkout") {
      form.elements.address.addEventListener("change", () => {
        if (!normalizePostal(input.value) && POSTAL_IN_TEXT_RE.test(form.elements.address.value)) checkAndShow(kind, form);
      });
    }
    if (kind === "custom_order") {
      form.querySelectorAll('input[name="service"]').forEach((radio) => {
        radio.addEventListener("change", () => {
          if (areasPromise) areasPromise.then(applyRequiredState);
          if (isPickup(kind, form)) setMessages(kind);
          else if (normalizePostal(input.value)) checkAndShow(kind, form);
        });
      });
    }
    form.addEventListener("reset", () => setMessages(kind));
  }

  window.ORDER_GUARDS.push(async ({ form, kind }) => {
    if (!FORMS[kind] || !form || !form.elements.postal) return null;
    const result = await evaluate(kind, form);
    if (!result.error) {
      setMessages(kind, result);
      return null;
    }
    // runOrderGuards() shows result.error in the field's error element;
    // add the next-step note (with links) ourselves.
    setMessages(kind, result);
    return { field: "postal", message: result.error };
  });

  function init() {
    wire("checkout");
    wire("custom_order");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  // Exposed for the admin page / tests.
  window.DeliveryArea = { normalizePostal, formatPostal, POSTAL_RE };
})();
