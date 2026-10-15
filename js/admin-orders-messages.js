/* Message templates for the admin Orders tab: Quote, Confirmation,
   Reminder and Thank-you. The owner edits them in the "Message templates"
   box at the bottom of the Orders tab; they're stored in site_settings
   (keys msg_template_quote / _confirmation / _reminder / _thankyou, plus
   msg_business_name). site_settings is publicly readable, so templates
   must not contain anything private — they're the same words customers
   receive anyway.

   In an order's drawer the owner picks a template, can tweak the filled-in
   text, then opens WhatsApp, opens their email app, or copies it. Each
   send is recorded in the order's timeline (order_events, kind 'message').

   Placeholders: {name} (first name), {full_name}, {date}, {time}, {items},
   {total}, {deposit}, {balance}, {ref}, {business}.

   Exposes window.AdminOrderMessages = { buildPanel, renderEditor,
   templateLabel, fillTemplate }. Uses helpers from js/admin-core.js and
   js/admin-orders.js. */
(function () {
  const TEMPLATES = [
    {
      key: "quote",
      label: "Quote",
      subject: "Your balloon quote from {business}",
      text: "Hi {name}! Thank you for reaching out to {business}.\n\nHere's your quote for {date}:\n{items}\n\nTotal: {total}\nA deposit of {deposit} holds your date.\n\nLet us know if you'd like to go ahead, or if you'd like any changes!"
    },
    {
      key: "confirmation",
      label: "Confirmation",
      subject: "Your order {ref} is confirmed",
      text: "Hi {name}, your balloon order {ref} with {business} is confirmed for {date}, {time}.\n\n{items}\n\nTotal: {total}\nBalance due: {balance}\n\nThank you, we can't wait!"
    },
    {
      key: "reminder",
      label: "Reminder (event is tomorrow)",
      subject: "See you tomorrow!",
      text: "Hi {name}! Just a friendly reminder that your balloons from {business} are booked for tomorrow, {date}, {time}.\n\nBalance due: {balance}\n\nReply here if anything has changed. See you soon!"
    },
    {
      key: "thankyou",
      label: "Thank you + review request",
      subject: "Thank you from {business}",
      text: "Hi {name}, thank you so much for choosing {business}! We hope you loved your balloons.\n\nIf you have a minute, a quick review would mean the world to us. Photos from the day are always welcome too!"
    }
  ];
  const BUSINESS_KEY = "msg_business_name";
  const DEFAULT_BUSINESS = "Balloons by Tea";
  const settingKey = (key) => `msg_template_${key}`;
  const ALL_KEYS = [BUSINESS_KEY, ...TEMPLATES.map((t) => settingKey(t.key))];

  let saved = null; // key -> value from site_settings, once loaded
  let loading = null;

  function loadSaved(force) {
    if (saved && !force) return Promise.resolve(saved);
    if (loading && !force) return loading;
    loading = getSupabaseClient().from("site_settings").select("key,value").in("key", ALL_KEYS).then(({ data, error }) => {
      loading = null;
      const map = {};
      if (!error) (data || []).forEach((r) => { map[r.key] = r.value == null ? "" : String(r.value); });
      saved = map;
      return { map, error };
    }).then((res) => (res.error ? Promise.reject(res.error) : res.map)).catch((err) => {
      saved = saved || {};
      console.warn("[Orders] Couldn't load message templates; using the defaults.", err);
      return saved;
    });
    return loading;
  }

  function templateText(key) {
    const t = TEMPLATES.find((x) => x.key === key);
    const custom = saved && saved[settingKey(key)];
    return custom && custom.trim() ? custom : (t ? t.text : "");
  }

  function businessName() {
    const v = saved && saved[BUSINESS_KEY];
    return v && v.trim() ? v.trim() : DEFAULT_BUSINESS;
  }

  function templateLabel(key) {
    const t = TEMPLATES.find((x) => x.key === key);
    return t ? t.label : String(key || "message");
  }

  /* Replaces {placeholders} with this order's details. Unknown
     placeholders are left as typed so a typo is visible. */
  function fillTemplate(text, order) {
    const iso = orderEventIso(order);
    const total = orderTotalAmount(order);
    const balance = orderBalance(order);
    const deposit = orderAmountNumber(order.deposit_amount);
    const fullName = String(order.name || "").trim();
    const values = {
      name: fullName.split(/\s+/)[0] || "there",
      full_name: fullName || "there",
      date: iso ? friendlyOrderDay(iso) : (String(order.event_date || "").trim() || "your event date"),
      time: formatOrderTime(orderEventTime(order)) || "time to be confirmed",
      items: orderItemsText(order) || "your balloon order",
      total: total !== null ? formatOrderMoney(total) : (String(order.total || "").trim() || "to be confirmed"),
      deposit: deposit !== null ? formatOrderMoney(deposit) : "to be confirmed",
      balance: balance !== null ? formatOrderMoney(balance) || ORDERS_CURRENCY + "0" : "to be confirmed",
      ref: orderRef(order) || "",
      business: businessName()
    };
    return String(text || "")
      .replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(values, k) ? values[k] : m))
      .replace(/[ \t]+\n/g, "\n")
      .replace(/ {2,}/g, " ")
      .trim();
  }

  function suggestedTemplate(order) {
    const iso = orderEventIso(order);
    const tomorrow = ordersNextIso(ordersTodayIso());
    const status = order.status || "new";
    if (status === "fulfilled") return "thankyou";
    if (iso && iso === tomorrow) return "reminder";
    if (status === "quoted") return "confirmation";
    return "quote";
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fall back below */ }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  /* Fills `section` (in the order drawer) with the template picker,
     editable preview, and send buttons. */
  function buildPanel(section, order) {
    const wrap = document.createElement("div");
    wrap.className = "order-messages";
    const id = `odMsg-${order.id}`;
    wrap.innerHTML = `
      <label class="order-inline-field" for="${id}-tpl">Template
        <select id="${id}-tpl" class="order-status-select">
          ${TEMPLATES.map((t) => `<option value="${t.key}">${escapeHtml(t.label)}</option>`).join("")}
        </select>
      </label>
      <textarea id="${id}-text" class="order-admin-notes-input order-message-text" rows="7" aria-label="Message text"></textarea>
      <div class="order-drawer-actions">
        <button type="button" class="orders-export-btn" data-send="whatsapp">WhatsApp</button>
        <button type="button" class="orders-export-btn" data-send="email">Email</button>
        <button type="button" class="orders-export-btn" data-send="copy">Copy</button>
        <span class="form-status" role="status" aria-live="polite"></span>
      </div>`;
    section.appendChild(wrap);

    const select = wrap.querySelector("select");
    const textarea = wrap.querySelector("textarea");
    const status = wrap.querySelector(".form-status");
    const number = whatsAppNumber(order.phone);
    const waBtn = wrap.querySelector('[data-send="whatsapp"]');
    const emailBtn = wrap.querySelector('[data-send="email"]');
    if (!number) { waBtn.disabled = true; waBtn.title = "No full phone number on this order"; }
    if (!order.email) { emailBtn.disabled = true; emailBtn.title = "No email on this order"; }

    let edited = false;
    const fill = () => {
      textarea.value = fillTemplate(templateText(select.value), order);
      edited = false;
    };
    textarea.addEventListener("input", () => { edited = true; });
    select.value = suggestedTemplate(order);
    textarea.value = "Loading...";
    loadSaved().then(fill);
    select.addEventListener("change", async () => {
      if (edited && !(await adminConfirm({ title: "Replace your edited message?", message: "Replace your edited message with this template? Your changes to the message will be lost.", confirmLabel: "Replace message", danger: true }))) return;
      fill();
    });

    const setStatus = (text, kind) => {
      status.textContent = text;
      status.className = "form-status" + (kind ? " " + kind : "");
    };

    wrap.querySelectorAll("[data-send]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const text = textarea.value.trim();
        if (!text) return setStatus("The message is empty.", "error");
        const channel = btn.dataset.send;
        const tpl = TEMPLATES.find((t) => t.key === select.value);
        if (channel === "whatsapp") {
          window.open(`https://wa.me/${number}?text=${encodeURIComponent(text)}`, "_blank", "noopener");
        } else if (channel === "email") {
          const subject = fillTemplate(tpl ? tpl.subject : "", order);
          const a = document.createElement("a");
          a.href = `mailto:${encodeURIComponent(order.email).replace(/%40/g, "@")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
          a.rel = "noopener";
          document.body.appendChild(a);
          a.click();
          a.remove();
        } else {
          const ok = await copyText(text);
          if (!ok) return setStatus("Couldn't copy — select the text and copy it by hand.", "error");
        }
        setStatus(channel === "copy" ? "Copied. Logged in the timeline." : "Opened. Logged in the timeline.", "success");
        const err = await logOrderEvent(order.id, { kind: "message", from_value: channel, to_value: select.value, note: text.slice(0, 300) });
        if (err && !isMissingTableError(err, "order_events")) setStatus("Sent, but couldn't add it to the timeline: " + (err.message || err), "error");
        if (orderDrawerOrder && String(orderDrawerOrder.id) === String(order.id)) loadOrderTimeline(orderDrawerOrder);
      });
    });
  }

  /* ----- Template editor (bottom of the Orders tab) ----- */

  let editorBaseline = null;

  function editorValues() {
    const values = {};
    ALL_KEYS.forEach((k) => {
      const el = document.getElementById(`msgtpl-${k}`);
      if (el) values[k] = el.value;
    });
    return values;
  }

  function editorDirty() {
    if (!editorBaseline) return false;
    const now = editorValues();
    return ALL_KEYS.some((k) => k in now && now[k] !== editorBaseline[k]);
  }

  async function renderEditor(container) {
    if (!container || container.dataset.ready) return;
    container.dataset.ready = "1";
    container.innerHTML = `
      <details class="order-templates-editor">
        <summary>Message templates</summary>
        <p class="panel-subtitle">Used by "Send a message" on each order. Placeholders: {name}, {full_name}, {date}, {time}, {items}, {total}, {deposit}, {balance}, {ref}, {business}. Leave a box empty to use the built-in wording. These are stored with your site settings, which anyone can technically read — keep them to the words you'd send customers.</p>
        <div class="field">
          <label for="msgtpl-${BUSINESS_KEY}">Business name ({business})</label>
          <input type="text" id="msgtpl-${BUSINESS_KEY}" maxlength="120" placeholder="${escapeHtml(DEFAULT_BUSINESS)}"/>
        </div>
        ${TEMPLATES.map((t) => `
          <div class="field">
            <label for="msgtpl-${settingKey(t.key)}">${escapeHtml(t.label)}</label>
            <textarea id="msgtpl-${settingKey(t.key)}" rows="6" maxlength="4000" placeholder="${escapeHtml(t.text)}"></textarea>
            <button type="button" class="orders-link-btn" data-reset-template="${t.key}">Fill in the built-in wording</button>
          </div>`).join("")}
        <div class="order-drawer-actions">
          <button type="button" class="btn btn-primary" id="msgTemplatesSave">Save templates</button>
          <span class="form-status" id="msgTemplatesStatus" role="status" aria-live="polite"></span>
        </div>
      </details>`;

    const statusEl = document.getElementById("msgTemplatesStatus");
    const setStatus = (text, kind) => { statusEl.textContent = text; statusEl.className = "form-status" + (kind ? " " + kind : ""); };
    const map = await loadSaved(true);
    ALL_KEYS.forEach((k) => {
      const el = document.getElementById(`msgtpl-${k}`);
      if (el) el.value = map[k] || "";
    });
    editorBaseline = editorValues();

    container.querySelectorAll("[data-reset-template]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const t = TEMPLATES.find((x) => x.key === btn.dataset.resetTemplate);
        const el = document.getElementById(`msgtpl-${settingKey(t.key)}`);
        if (el.value.trim() && !(await adminConfirm({ title: "Reset this template?", message: "Replace this template with the built-in wording? Your current wording in this box will be lost.", confirmLabel: "Use built-in wording", danger: true }))) return;
        el.value = t.text;
      });
    });
    document.getElementById("msgTemplatesSave").addEventListener("click", async () => {
      const values = editorValues();
      const rows = ALL_KEYS.filter((k) => values[k] !== editorBaseline[k]).map((k) => ({ key: k, value: values[k].trim() }));
      if (!rows.length) return setStatus("No changes to save.", "");
      const btn = document.getElementById("msgTemplatesSave");
      btn.disabled = true;
      setStatus("Saving...", "");
      const { error } = await mustAffect(getSupabaseClient().from("site_settings").upsert(rows, { onConflict: "key" }));
      btn.disabled = false;
      if (error) return setStatus("Couldn't save: " + error.message, "error");
      rows.forEach((r) => { saved[r.key] = r.value; editorBaseline[r.key] = values[r.key]; });
      setStatus("Saved", "success");
    });
  }

  registerAdminDirtyCheck(editorDirty);

  window.AdminOrderMessages = { buildPanel, renderEditor, templateLabel, fillTemplate, _TEMPLATES: TEMPLATES };
})();
