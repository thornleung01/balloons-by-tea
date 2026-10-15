/* Admin "Overview" tab — the default landing tab after login.

   Cards (each loads and fails independently, so one missing table or
   failed query never blanks the page):
     New orders waiting    orders.status = 'new'           -> Orders?status=new
     Unpaid balances       payment_status/total_amount/amount_paid/
                           deposit_amount (hidden until those columns exist)
     Revenue this month    total_amount, else the parsed `total` text, of
                           non-cancelled, non-quote orders, by created_at;
                           compared with last month
     Events next 7 days    event_on (date) + event_time, else the
                           'YYYY-MM-DD[ HH:MM]' event_date text
     Heads-up              blocked dates + fully booked days (next 14 days),
                           hidden products, missing contact settings
     Top products 30 days  orders.items jsonb when present, else
                           analytics_summary().top_products (add-to-cart)

   Also: deep-link param handlers for Orders/Products (see
   registerAdminTabParamHandler in js/admin-core.js), the quick actions,
   and the admin branding (business name / logo from site_settings).

   Self-contained IIFE: nothing here is a global except
   window.refreshOverviewPanel. Reads (never writes) other files' globals
   only behind typeof checks, so it degrades if they change. */
(function () {
  const OV_DAY_MS = 86400000;
  const OV_DEFAULT_BRAND = "Balloons by Tea";
  const OV_STATUS_LABELS = { new: "New", contacted: "Contacted", quoted: "Quoted", fulfilled: "Fulfilled", cancelled: "Cancelled" };
  let ovRefreshSeq = 0;
  let ovCurrency = "$";

  /* ---------- small helpers ---------- */
  const $ = (id) => document.getElementById(id);
  function pad(n) { return String(n).padStart(2, "0"); }
  function isoDay(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

  function parseIsoDay(text) {
    const m = /^\s*(\d{4})-(\d{2})-(\d{2})/.exec(text || "");
    if (!m) return null;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const date = new Date(y, mo - 1, d);
    return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? date : null;
  }

  function friendlyDay(d, withYear) {
    const opts = { weekday: "short", month: "short", day: "numeric" };
    if (withYear || d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString("en-US", opts);
  }

  function relativeDay(d) {
    const diff = Math.round((d - startOfToday()) / OV_DAY_MS);
    if (diff === 0) return "Today";
    if (diff === 1) return "Tomorrow";
    return d.toLocaleDateString("en-US", { weekday: "long" });
  }

  function money(n) {
    const v = Number(n) || 0;
    const opts = Math.abs(v) >= 1000 || Number.isInteger(v) ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
    return `${ovCurrency}${v.toLocaleString("en-US", opts)}`;
  }

  function plural(n, one, many) { return `${n} ${n === 1 ? one : many || one + "s"}`; }

  function hasValue(v) { return v != null && String(v).trim() !== ""; }

  /* total_amount when the column is there and filled, else the checkout's
     `total` text ("$120", "HK$1,200.50"). Custom-order budgets ("Budget:
     $200-300", "Budget not specified") aren't a price, so they're null. */
  function orderAmount(o) {
    if (hasValue(o.total_amount) && Number.isFinite(Number(o.total_amount))) return Number(o.total_amount);
    const t = String(o.total || "").trim();
    if (!t || /budget|not specified|tbd|quote/i.test(t)) return null;
    const m = /^\s*([A-Za-z]{0,3}\s?[$€£¥₱₩]?)\s*(\d[\d,]*(?:\.\d{1,2})?)\s*$/.exec(t);
    if (!m) return null;
    return Number(m[2].replace(/,/g, ""));
  }

  function detectCurrency(orders) {
    for (const o of orders) {
      const m = /^\s*([A-Za-z]{0,3}\s?[$€£¥₱₩])\s*\d/.exec(String(o.total || ""));
      if (m) return m[1].replace(/\s/g, "");
    }
    return "$";
  }

  /* Local Date of the event (day precision), or null. */
  function orderEventDay(o) {
    if (hasValue(o.event_on)) {
      const d = parseIsoDay(String(o.event_on));
      if (d) return d;
    }
    return parseIsoDay(o.event_date);
  }

  function orderEventTime(o) {
    if (hasValue(o.event_time)) return String(o.event_time).trim();
    const m = /^\s*\d{4}-\d{2}-\d{2}[ T](\d{1,2}):(\d{2})/.exec(o.event_date || "");
    if (!m) return "";
    const h = Number(m[1]);
    return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
  }

  function orderStatus(o) { return o.status || "new"; }

  function orderRefOf(o) {
    if (typeof orderRef === "function") {
      try { return orderRef(o); } catch (e) { /* fall through */ }
    }
    const m = /^\s*Ref:\s*(AUR-[A-Z0-9]+)/i.exec(o.summary || "");
    return m ? m[1].toUpperCase() : "";
  }

  function kindLabel(kind) {
    if (kind === "custom") return "Custom";
    if (kind === "checkout" || !kind) return "Checkout";
    return String(kind).charAt(0).toUpperCase() + String(kind).slice(1);
  }

  function cardHead(title, icon, extra) {
    return `<div class="ov-card-head"><h2>${typeof adminIconSvg === "function" ? adminIconSvg(icon, 18) : ""}<span>${escapeHtml(title)}</span></h2>${extra || ""}</div>`;
  }

  function cardError(el, title, icon, message) {
    el.hidden = false;
    el.classList.remove("is-loading");
    el.innerHTML = `${cardHead(title, icon)}<p class="ov-error">${escapeHtml(message)}</p>`;
  }

  function cardLoading(el, title, icon) {
    el.classList.add("is-loading");
    if (!el.innerHTML.trim()) el.innerHTML = `${cardHead(title, icon)}<p class="ov-muted">Loading…</p>`;
  }

  /* Runs one card's renderer; an exception or failed query only affects
     that card. */
  async function runCard(seq, id, title, icon, fn) {
    const el = $(id);
    if (!el) return;
    cardLoading(el, title, icon);
    try {
      await fn(el, () => seq === ovRefreshSeq);
    } catch (err) {
      if (seq !== ovRefreshSeq) return;
      console.error(`[overview] ${id}`, err);
      cardError(el, title, icon, `Couldn't load this card: ${(err && err.message) || err}`);
    }
    el.classList.remove("is-loading");
  }

  function wireNavLinks(el) {
    el.querySelectorAll("[data-ov-nav]").forEach((node) => {
      node.addEventListener("click", (e) => {
        e.preventDefault();
        let params;
        try { params = node.dataset.ovParams ? JSON.parse(node.dataset.ovParams) : undefined; } catch (err) { params = undefined; }
        window.adminNavigate(node.dataset.ovNav, params);
      });
    });
  }

  function navAttrs(tab, params) {
    return `data-ov-nav="${escapeHtml(tab)}"${params ? ` data-ov-params="${escapeHtml(JSON.stringify(params))}"` : ""}`;
  }

  /* ---------- data (one fetch each, shared by the cards) ---------- */
  async function fetchOrders(client) {
    const { data, error } = await client.from("orders").select("*").order("created_at", { ascending: false }).limit(2000);
    if (error) throw new Error(isMissingTableError(error, "orders") ? "The orders table doesn't exist yet — run supabase-setup.sql." : error.message);
    return data || [];
  }

  async function fetchSettings(client) {
    const { data, error } = await client.from("site_settings").select("key,value");
    if (error) throw new Error(error.message);
    const map = {};
    (data || []).forEach((r) => { map[r.key] = r.value; });
    return map;
  }

  /* ---------- cards ---------- */
  async function renderNewOrders(el, ordersP, alive) {
    const orders = await ordersP;
    if (!alive()) return;
    const fresh = orders.filter((o) => orderStatus(o) === "new");
    const oldest = fresh.reduce((min, o) => {
      const t = Date.parse(o.created_at || "");
      return Number.isFinite(t) && t < min ? t : min;
    }, Infinity);
    const waitingDays = Number.isFinite(oldest) ? Math.floor((Date.now() - oldest) / OV_DAY_MS) : 0;
    el.innerHTML = `
      ${cardHead("New orders waiting", "receipt")}
      <button type="button" class="ov-stat-btn" ${navAttrs("orders", { status: "new" })}>
        <span class="ov-big ${fresh.length ? "is-alert" : ""}">${fresh.length}</span>
        <span class="ov-sub">${fresh.length
          ? (waitingDays >= 1 ? `oldest waiting ${plural(waitingDays, "day")}` : "all from today")
          : "You're all caught up"}</span>
        <span class="ov-link">View new orders &rarr;</span>
      </button>`;
    wireNavLinks(el);
  }

  async function renderUnpaid(el, ordersP, alive) {
    const orders = await ordersP;
    if (!alive()) return;
    const hasPaymentCols = orders.some((o) => Object.prototype.hasOwnProperty.call(o, "payment_status"));
    if (!hasPaymentCols) { el.hidden = true; el.innerHTML = ""; return; }
    let count = 0;
    let sum = 0;
    let unknownTotals = 0;
    orders.forEach((o) => {
      const status = orderStatus(o);
      if (status === "cancelled" || status === "quoted") return;
      const ps = o.payment_status;
      if (ps !== "unpaid" && ps !== "deposit_paid") return;
      const total = orderAmount(o);
      let paid = Number(o.amount_paid);
      if (!Number.isFinite(paid) || !hasValue(o.amount_paid)) paid = ps === "deposit_paid" ? (Number(o.deposit_amount) || 0) : 0;
      if (total == null) { count++; unknownTotals++; return; }
      const due = Math.max(0, total - paid);
      if (due <= 0) return;
      count++;
      sum += due;
    });
    el.hidden = false;
    el.innerHTML = `
      ${cardHead("Unpaid balances", "receipt")}
      <button type="button" class="ov-stat-btn" ${navAttrs("orders", { payment: "unpaid" })}>
        <span class="ov-big">${count ? money(sum) : money(0)}</span>
        <span class="ov-sub">${count ? `across ${plural(count, "order")}${unknownTotals ? ` (${unknownTotals} without a total)` : ""}` : "Nothing outstanding"}</span>
        <span class="ov-link">View orders &rarr;</span>
      </button>`;
    wireNavLinks(el);
  }

  async function renderRevenue(el, ordersP, alive) {
    const orders = await ordersP;
    if (!alive()) return;
    const now = new Date();
    const thisStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    let thisSum = 0, lastSum = 0, lastToDate = 0, thisCount = 0, unpriced = 0;
    const dayOfMonth = now.getDate();
    orders.forEach((o) => {
      const status = orderStatus(o);
      if (status === "cancelled" || status === "quoted") return;
      const created = new Date(o.created_at || "");
      if (Number.isNaN(created.getTime()) || created < lastStart) return;
      const amount = orderAmount(o);
      if (created >= thisStart) {
        if (amount == null) { unpriced++; return; }
        thisSum += amount;
        thisCount++;
      } else {
        if (amount == null) return;
        lastSum += amount;
        if (created.getDate() <= dayOfMonth) lastToDate += amount;
      }
    });
    let delta = "";
    if (lastToDate > 0) {
      const pct = Math.round(((thisSum - lastToDate) / lastToDate) * 100);
      const up = pct >= 0;
      delta = `<span class="ov-delta ${up ? "is-up" : "is-down"}">${up ? "&#9650;" : "&#9660;"} ${Math.abs(pct)}%</span> vs same point last month`;
    } else if (thisSum > 0) {
      delta = "No priced orders by this point last month";
    }
    const monthName = now.toLocaleDateString("en-US", { month: "long" });
    const lastName = lastStart.toLocaleDateString("en-US", { month: "long" });
    el.innerHTML = `
      ${cardHead(`Revenue — ${monthName}`, "chart")}
      <span class="ov-big">${money(thisSum)}</span>
      <span class="ov-sub">${plural(thisCount, "order")}${delta ? ` · ${delta}` : ""}</span>
      <span class="ov-sub">${escapeHtml(lastName)}: ${money(lastSum)}</span>
      <p class="ov-note">Orders placed, excluding cancelled orders and quotes.${unpriced ? ` ${plural(unpriced, "order")} this month without a fixed price (e.g. custom budgets) not counted.` : ""}</p>`;
  }

  async function renderEvents(el, ordersP, alive) {
    const orders = await ordersP;
    if (!alive()) return;
    const today = startOfToday();
    const end = addDays(today, 7);
    const upcoming = orders
      .filter((o) => orderStatus(o) !== "cancelled")
      .map((o) => ({ o, day: orderEventDay(o) }))
      .filter((x) => x.day && x.day >= today && x.day < end)
      .sort((a, b) => (a.day - b.day) || orderEventTime(a.o).localeCompare(orderEventTime(b.o)));
    const head = cardHead("Events in the next 7 days", "truck", `<button type="button" class="ov-head-link" ${navAttrs("orders", { sort: "event", upcoming: "1" })}>All upcoming</button>`);
    if (!upcoming.length) {
      el.innerHTML = `${head}<p class="ov-muted">No events booked for the next 7 days.</p>`;
      wireNavLinks(el);
      return;
    }
    el.innerHTML = `${head}
      <ul class="ov-events">
        ${upcoming.slice(0, 12).map(({ o, day }) => {
          const status = orderStatus(o);
          const time = orderEventTime(o);
          const ref = orderRefOf(o);
          return `
          <li>
            <button type="button" class="ov-event" ${navAttrs("orders", { search: ref || o.name || "" })}>
              <span class="ov-event-date"><strong>${escapeHtml(relativeDay(day))}</strong><span>${escapeHtml(day.toLocaleDateString("en-US", { month: "short", day: "numeric" }))}${time ? ` · ${escapeHtml(time)}` : ""}</span></span>
              <span class="ov-event-body"><span class="ov-event-name">${escapeHtml(o.name || "No name")}</span><span class="ov-event-meta">${escapeHtml(kindLabel(o.kind))}${ref ? ` · ${escapeHtml(ref)}` : ""}</span></span>
              <span class="ov-pill ov-pill-${escapeHtml(status)}">${escapeHtml(OV_STATUS_LABELS[status] || status)}</span>
            </button>
          </li>`;
        }).join("")}
      </ul>
      ${upcoming.length > 12 ? `<p class="ov-note">+${upcoming.length - 12} more</p>` : ""}`;
    wireNavLinks(el);
  }

  async function renderHeadsUp(el, client, settingsP, alive) {
    const today = startOfToday();
    const horizon = addDays(today, 13);
    const items = []; // { level: "warn"|"info", html, tab?, params? }
    const checks = [];

    // Blocked dates in the next 14 days.
    checks.push((async () => {
      const { data, error } = await client.from("blocked_dates").select("day,reason")
        .gte("day", isoDay(today)).lte("day", isoDay(horizon)).order("day", { ascending: true });
      if (error) return; // table missing/unreadable: just skip this check
      const days = (data || []).map((r) => ({ d: parseIsoDay(String(r.day)), reason: r.reason || "" })).filter((r) => r.d);
      if (!days.length) return;
      const list = days.slice(0, 5).map((r) => `${friendlyDay(r.d)}${r.reason ? ` (${r.reason})` : ""}`).join(", ");
      items.push({ level: "info", text: `Blocked: ${list}${days.length > 5 ? ` +${days.length - 5} more` : ""}`, tab: "delivery" });
    })());

    // Days that reached the daily order limit.
    checks.push((async () => {
      let settings = {};
      try { settings = await settingsP; } catch (e) { /* settings card handles it */ }
      const cap = Number(String(settings.max_orders_per_day || "").trim());
      if (!(cap > 0)) return;
      const { data, error } = await client.rpc("fully_booked_dates", { from_day: isoDay(today), to_day: isoDay(horizon) });
      if (error) return;
      const days = (data || [])
        .map((row) => parseIsoDay(String(row && typeof row === "object" ? (row.day || row.fully_booked_dates) : row)))
        .filter(Boolean);
      if (!days.length) return;
      items.push({ level: "warn", text: `Fully booked (limit ${cap}/day): ${days.slice(0, 5).map((d) => friendlyDay(d)).join(", ")}${days.length > 5 ? ` +${days.length - 5} more` : ""}`, tab: "delivery" });
    })());

    // Hidden products.
    checks.push((async () => {
      const { count, error } = await client.from("products").select("id", { count: "exact", head: true }).eq("active", false);
      if (error || !count) return;
      items.push({ level: "info", text: `${plural(count, "product")} hidden from the site`, tab: "products" });
    })());

    // Missing contact info.
    checks.push((async () => {
      let settings;
      try { settings = await settingsP; } catch (e) { return; }
      const missing = [["contact_phone", "phone"], ["contact_email", "email"], ["contact_whatsapp", "WhatsApp link"]]
        .filter(([k]) => !hasValue(settings[k])).map(([, label]) => label);
      if (!missing.length) return;
      items.push({ level: "warn", text: `Contact info missing in Settings: ${missing.join(", ")}`, tab: "settings" });
    })());

    await Promise.allSettled(checks);
    if (!alive()) return;
    items.sort((a, b) => (a.level === b.level ? 0 : a.level === "warn" ? -1 : 1));
    const head = cardHead("Heads-up", "help");
    if (!items.length) {
      el.innerHTML = `${head}<p class="ov-muted ov-ok">All clear for the next two weeks.</p>`;
      return;
    }
    el.innerHTML = `${head}
      <ul class="ov-alerts">
        ${items.map((it) => `
          <li class="ov-alert ov-alert-${it.level}">
            <button type="button" class="ov-alert-btn" ${navAttrs(it.tab, it.params)}>
              <span class="ov-alert-dot" aria-hidden="true"></span>
              <span>${escapeHtml(it.text)}</span>
            </button>
          </li>`).join("")}
      </ul>`;
    wireNavLinks(el);
  }

  function aggregateItems(orders) {
    const since = Date.now() - 30 * OV_DAY_MS;
    const map = {};
    let sawItems = false;
    orders.forEach((o) => {
      if (orderStatus(o) === "cancelled") return;
      const t = Date.parse(o.created_at || "");
      if (!Number.isFinite(t) || t < since) return;
      let items = o.items;
      if (typeof items === "string") { try { items = JSON.parse(items); } catch (e) { items = null; } }
      if (!Array.isArray(items) || !items.length) return;
      sawItems = true;
      items.forEach((it) => {
        if (!it || typeof it !== "object") return;
        const name = it.name || it.title || it.product_name || "Unnamed item";
        const key = String(it.product_id || it.id || name);
        const qty = Number(it.qty != null ? it.qty : it.quantity != null ? it.quantity : 1) || 1;
        const entry = map[key] || (map[key] = { name, count: 0 });
        entry.count += qty;
      });
    });
    return sawItems ? Object.values(map).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)) : null;
  }

  async function renderTopProducts(el, client, ordersP, alive) {
    let rows = null;
    let source = "";
    try {
      rows = aggregateItems(await ordersP);
      if (rows) source = "Items ordered in the last 30 days (excluding cancelled).";
    } catch (e) { rows = null; }
    if (!rows) {
      const to = new Date();
      const from = new Date(to.getTime() - 30 * OV_DAY_MS);
      const { data, error } = await client.rpc("analytics_summary", { from_ts: from.toISOString(), to_ts: to.toISOString() });
      if (!error && data && Array.isArray(data.top_products)) {
        rows = data.top_products.map((p) => ({ name: p.name || p.key || "Unknown product", count: Number(p.count) || 0 }));
        source = "Add-to-cart events in the last 30 days (from Analytics).";
      }
    }
    if (!alive()) return;
    const head = cardHead("Top products (30 days)", "box", `<button type="button" class="ov-head-link" ${navAttrs("analytics")}>Analytics</button>`);
    if (!rows || !rows.length) {
      el.innerHTML = `${head}<p class="ov-muted">${rows ? "No product activity in the last 30 days." : "Not enough data yet — this fills in once orders carry item lists or analytics tracking is set up."}</p>`;
      wireNavLinks(el);
      return;
    }
    const top = rows.slice(0, 5);
    const max = top[0].count || 1;
    el.innerHTML = `${head}
      <ol class="ov-bars">
        ${top.map((r) => `
          <li>
            <span class="ov-bar-label"><span>${escapeHtml(r.name)}</span><strong>${r.count}</strong></span>
            <span class="ov-bar" aria-hidden="true"><span style="width:${Math.max(4, Math.round((r.count / max) * 100))}%"></span></span>
          </li>`).join("")}
      </ol>
      <p class="ov-note">${escapeHtml(source)}</p>`;
    wireNavLinks(el);
  }

  /* ---------- branding ---------- */
  function applyBranding(settings) {
    const name = String(settings.business_name || settings.site_name || "").trim() || OV_DEFAULT_BRAND;
    document.title = `Admin | ${name}`;
    const logo = $("adminBrandLogo");
    if (logo) {
      logo.alt = name;
      if (hasValue(settings.logo_url) && /^https?:\/\//i.test(settings.logo_url) && logo.getAttribute("src") !== settings.logo_url) {
        logo.src = settings.logo_url;
      }
    }
  }

  /* ---------- main ---------- */
  async function refreshOverviewPanel() {
    const seq = ++ovRefreshSeq;
    const client = getSupabaseClient();
    if (!client) return;
    const dateEl = $("overviewDate");
    if (dateEl) dateEl.textContent = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

    const ordersP = fetchOrders(client);
    const settingsP = fetchSettings(client);
    // Swallow here so an unawaited rejection isn't reported twice; every
    // card that awaits these still sees the error.
    ordersP.then((orders) => { ovCurrency = detectCurrency(orders); }, () => {});
    settingsP.then(applyBranding, () => {});
    const alive = () => seq === ovRefreshSeq;

    await Promise.allSettled([
      runCard(seq, "ovNewOrders", "New orders waiting", "receipt", (el) => renderNewOrders(el, ordersP, alive)),
      runCard(seq, "ovUnpaid", "Unpaid balances", "receipt", (el) => renderUnpaid(el, ordersP, alive)),
      runCard(seq, "ovRevenue", "Revenue this month", "chart", async (el) => { await ordersP.catch(() => {}); return renderRevenue(el, ordersP, alive); }),
      runCard(seq, "ovEvents", "Events in the next 7 days", "truck", (el) => renderEvents(el, ordersP, alive)),
      runCard(seq, "ovHeadsUp", "Heads-up", "help", (el) => renderHeadsUp(el, client, settingsP, alive)),
      runCard(seq, "ovTopProducts", "Top products (30 days)", "box", (el) => renderTopProducts(el, client, ordersP, alive))
    ]);
  }
  window.refreshOverviewPanel = refreshOverviewPanel;

  registerAdminTab("overview", {
    btnId: "tabOverviewBtn",
    panelId: "overviewPanel",
    label: "Overview",
    group: "overview",
    icon: "home",
    order: 0,
    onEnter: refreshOverviewPanel
  });

  /* ---------- deep-link params for tabs owned by other files ----------
     Orders: { status, search, sort, upcoming, payment }. Applied through
     the Orders tab's own controls/state so its onEnter (refreshOrderList)
     renders the filtered list. `payment` is passed to
     window.setOrdersPaymentFilter(value) when the Orders tab provides one. */
  registerAdminTabParamHandler("orders", (p) => {
    const status = p.status || (p.search ? "all" : null);
    if (status) {
      const btns = [...document.querySelectorAll("#ordersFilter .orders-filter-btn")];
      const btn = btns.find((b) => b.dataset.status === status);
      if (btn && typeof ordersStatusFilter !== "undefined") {
        ordersStatusFilter = status;
        btns.forEach((b) => b.classList.toggle("active", b === btn));
      }
    }
    if (p.search != null) {
      const input = $("orderSearch");
      if (input) input.value = String(p.search);
      if (typeof ordersSearchQuery !== "undefined") ordersSearchQuery = String(p.search);
    }
    if (p.sort) {
      const sel = $("orderSort");
      if (sel && [...sel.options].some((op) => op.value === p.sort)) {
        sel.value = p.sort;
        if (typeof ordersSortMode !== "undefined") ordersSortMode = p.sort;
      }
    }
    if (p.upcoming != null) {
      const on = p.upcoming === true || p.upcoming === "1" || p.upcoming === "true";
      const box = $("orderUpcomingOnly");
      if (box) box.checked = on;
      if (typeof ordersUpcomingOnly !== "undefined") ordersUpcomingOnly = on;
    }
    if (p.payment && typeof window.setOrdersPaymentFilter === "function") window.setOrdersPaymentFilter(p.payment);
  });

  // Products: { action: "new" } — focus the empty Add Item form.
  registerAdminTabParamHandler("products", (p) => {
    if (p.action !== "new") return;
    setTimeout(() => {
      const name = $("f-name");
      if (!name) return;
      name.scrollIntoView({ block: "center" });
      name.focus();
    }, 0);
  });

  onAdminInit(() => {
    const add = $("ovAddProductBtn");
    if (add) add.addEventListener("click", () => window.adminNavigate("products", { action: "new" }));
    const block = $("ovBlockDateBtn");
    if (block) block.addEventListener("click", () => window.adminNavigate("delivery", { focus: "block-date" }));
  });
})();
