/* Calendar view for the admin Orders tab (the "Calendar" side of the
   List | Calendar toggle).

   A month grid on wider screens and a day-by-day agenda on phones (both
   are rendered; css/admin-orders.css shows the right one). Each day shows:
     - the orders whose event falls on it (event_on, or the legacy
       event_date text before the orders v2 migration), cancelled ones
       left out — tap one to open its drawer;
     - "Blocked" for dates closed in the Delivery tab (blocked_dates);
     - "n / limit" and "Full" from the daily order limit
       (site_settings 'max_orders_per_day' + the fully_booked_dates()
       function, the same check the public order forms use — see
       js/admin-availability.js).
   Missing tables/functions are skipped quietly; the orders still show.

   Exposes window.AdminOrderCalendar = { show, refresh }. Uses helpers
   from js/admin-core.js and js/admin-orders.js. */
(function () {
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let container = null;
  let monthStart = null; // Date, 1st of the shown month
  let seq = 0;

  function iso(d) { return ordersLocalIso(d); }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

  function gridRange() {
    const start = addDays(monthStart, -monthStart.getDay());
    const lastOfMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
    const end = addDays(lastOfMonth, 6 - lastOfMonth.getDay());
    return { start, end };
  }

  function renderShell() {
    container.innerHTML = `
      <div class="orders-cal-toolbar">
        <h3 class="orders-cal-title" id="ordersCalTitle" aria-live="polite"></h3>
        <div class="orders-cal-nav" role="group" aria-label="Change month">
          <button type="button" class="orders-export-btn orders-cal-step" data-cal="prev" aria-label="Previous month"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button>
          <button type="button" class="orders-export-btn" data-cal="today">Today</button>
          <button type="button" class="orders-export-btn orders-cal-step" data-cal="next" aria-label="Next month"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>
        </div>
      </div>
      <ul class="orders-cal-legend" aria-label="Legend">
        ${["new", "contacted", "quoted", "fulfilled"].map((s) => `<li><span class="orders-cal-key status-${s}" aria-hidden="true"></span>${escapeHtml(orderStatusLabel(s))}</li>`).join("")}
        <li><span class="a-badge a-badge--xs a-badge--warning">Blocked</span> closed in the Delivery tab</li>
        <li><span class="a-badge a-badge--xs a-badge--danger">Full</span> daily order limit reached</li>
      </ul>
      <div id="ordersCalStatus" role="status"></div>
      <div id="ordersCalGrid" class="orders-cal-grid-wrap"></div>
      <div id="ordersCalAgenda" class="orders-cal-agenda"></div>`;
    container.addEventListener("click", (e) => {
      const nav = e.target.closest("[data-cal]");
      if (nav) {
        const step = nav.dataset.cal;
        if (step === "today") {
          const now = new Date();
          monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        } else {
          monthStart = new Date(monthStart.getFullYear(), monthStart.getMonth() + (step === "next" ? 1 : -1), 1);
        }
        refresh();
        return;
      }
      const chip = e.target.closest("[data-cal-order]");
      if (chip) {
        openOrderDrawer(chip.dataset.calOrder, chip);
        return;
      }
      const print = e.target.closest("[data-cal-print]");
      if (print && window.AdminOrderPrint) window.AdminOrderPrint.printDaySheet(print.dataset.calPrint);
    });
  }

  async function fetchMonth(startIso, endIso) {
    const client = getSupabaseClient();
    let q = client.from("orders").select("*").neq("status", "cancelled");
    q = ordersSchemaV2
      ? q.gte("event_on", startIso).lte("event_on", endIso)
      : q.gte("event_date", startIso).lt("event_date", ordersNextIso(endIso));
    const ordersP = q.order("created_at", { ascending: true }).limit(1000);
    const blockedP = client.from("blocked_dates").select("day,reason").gte("day", startIso).lte("day", endIso).limit(400);
    const capP = client.from("site_settings").select("value").eq("key", "max_orders_per_day").maybeSingle();
    const [orders, blocked, cap] = await Promise.all([ordersP, blockedP, capP]);
    const limitRaw = cap && !cap.error && cap.data && cap.data.value != null ? String(cap.data.value).trim() : "";
    const limit = /^\d{1,6}$/.test(limitRaw) ? Number(limitRaw) : 0;
    let full = new Set();
    if (limit > 0) {
      const { data, error } = await client.rpc("fully_booked_dates", { from_day: startIso, to_day: endIso });
      if (!error) {
        full = new Set((data || []).map((row) => String(row && typeof row === "object" ? (row.day || row.fully_booked_dates) : row).slice(0, 10)));
      }
    }
    return { orders, blocked, limit, full };
  }

  function chipHtml(order) {
    const status = order.status || "new";
    const time = formatOrderTime(orderEventTime(order));
    const due = orderHasBalanceDue(order) ? ` <span class="orders-cal-due" title="Balance due">${escapeHtml(formatOrderMoney(orderBalance(order)))}</span>` : "";
    return `<button type="button" class="orders-cal-chip status-${escapeHtml(status)}" data-cal-order="${escapeHtml(String(order.id))}" title="${escapeHtml(`${order.name || ""} · ${orderStatusLabel(status)}`)}">
      ${time ? `<span class="orders-cal-time">${escapeHtml(time)}</span>` : ""}<span class="orders-cal-name">${escapeHtml(order.name || "(no name)")}</span>${due}<span class="orders-cal-status">${escapeHtml(orderStatusLabel(status))}</span></button>`;
  }

  /* Blocked and Full use the warning and danger pairs; "2/3" is a quiet count. */
  function flagsHtml(day, info) {
    const parts = [];
    if (info.blocked.has(day)) parts.push(`<span class="a-badge a-badge--xs a-badge--warning orders-cal-flag" title="${escapeHtml(info.blocked.get(day) || "Blocked")}">${escapeHtml(info.blocked.get(day) || "Blocked")}</span>`);
    if (info.full.has(day)) parts.push(`<span class="a-badge a-badge--xs a-badge--danger orders-cal-flag">Full</span>`);
    const count = (info.byDay.get(day) || []).length;
    if (info.limit > 0 && count) parts.push(`<span class="a-badge a-badge--xs a-badge--neutral a-badge--outline orders-cal-flag" title="Orders that day of the daily limit">${count}/${info.limit}</span>`);
    return parts.join("");
  }

  function render(info) {
    const { start, end } = gridRange();
    const today = ordersTodayIso();
    const month = monthStart.getMonth();
    document.getElementById("ordersCalTitle").textContent = monthStart.toLocaleDateString("en-US", { month: "long", year: "numeric" });

    let cells = "";
    for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
      const day = iso(d);
      const orders = info.byDay.get(day) || [];
      const classes = ["orders-cal-cell"];
      if (d.getMonth() !== month) classes.push("is-other-month");
      if (day === today) classes.push("is-today");
      if (day < today) classes.push("is-past");
      if (info.blocked.has(day)) classes.push("is-blocked");
      if (info.full.has(day)) classes.push("is-full");
      cells += `<div class="${classes.join(" ")}">
        <div class="orders-cal-cell-head">
          <time class="orders-cal-daynum" datetime="${day}"${day === today ? ` aria-current="date"` : ""}><span aria-hidden="true">${d.getDate()}</span><span class="a-visually-hidden">${escapeHtml(friendlyOrderDay(day))}${day === today ? " (today)" : ""}</span></time>
          ${orders.length ? `<button type="button" class="orders-cal-print" data-cal-print="${day}" title="Print day sheet" aria-label="Print day sheet for ${escapeHtml(friendlyOrderDay(day))}">Print</button>` : ""}
        </div>
        <div class="orders-cal-flags">${flagsHtml(day, info)}</div>
        <div class="orders-cal-chips">${orders.map(chipHtml).join("")}</div>
      </div>`;
    }
    document.getElementById("ordersCalGrid").innerHTML = `
      <div class="orders-cal-grid" role="group" aria-label="Orders by event date">
        ${WEEKDAYS.map((w) => `<div class="orders-cal-weekday" aria-hidden="true">${w}</div>`).join("")}
        ${cells}
      </div>`;

    // Agenda: only this month's days that have something on them.
    const days = [];
    const last = new Date(monthStart.getFullYear(), month + 1, 0);
    for (let d = new Date(monthStart); d <= last; d = addDays(d, 1)) {
      const day = iso(d);
      if ((info.byDay.get(day) || []).length || info.blocked.has(day)) days.push(day);
    }
    document.getElementById("ordersCalAgenda").innerHTML = days.length
      ? days.map((day) => {
        const orders = info.byDay.get(day) || [];
        return `<section class="orders-cal-agenda-day ${day === today ? "is-today" : ""} ${day < today ? "is-past" : ""}" aria-label="${escapeHtml(friendlyOrderDay(day))}">
          <div class="orders-cal-agenda-head">
            <strong class="orders-cal-agenda-date">${escapeHtml(friendlyOrderDay(day))}</strong>
            ${day === today ? `<span class="a-badge a-badge--accent">Today</span>` : ""}
            <span class="orders-cal-flags">${flagsHtml(day, info)}</span>
            ${orders.length ? `<button type="button" class="orders-cal-print" data-cal-print="${day}">Print day sheet</button>` : ""}
          </div>
          <div class="orders-cal-chips">${orders.length ? orders.map(chipHtml).join("") : `<span class="orders-cal-none">No orders</span>`}</div>
        </section>`;
      }).join("")
      : `<div class="a-empty"><p class="a-empty-title">Nothing booked this month</p><p class="a-empty-text">Orders appear on their event date. Use the arrows to look at another month.</p></div>`;
  }

  async function refresh() {
    if (!container || container.hidden || !monthStart) return;
    const mySeq = ++seq;
    const { start, end } = gridRange();
    const startIso = iso(start);
    const endIso = iso(end);
    const statusEl = document.getElementById("ordersCalStatus");
    const gridEl = document.getElementById("ordersCalGrid");
    // Skeleton shaped like the month grid only for the first paint; later months keep the old grid until the new one is ready.
    if (!gridEl.firstElementChild) {
      gridEl.innerHTML = `<div class="orders-cal-skel" aria-hidden="true">${'<span class="a-skeleton"></span>'.repeat(14)}</div>`;
      document.getElementById("ordersCalAgenda").innerHTML = `<div aria-hidden="true">${'<span class="a-skeleton a-skeleton--block"></span>'.repeat(3)}</div>`;
    }
    statusEl.textContent = "";
    statusEl.className = "";
    let result;
    try {
      result = await fetchMonth(startIso, endIso);
    } catch (err) {
      result = { orders: { error: err }, blocked: { data: [] }, limit: 0, full: new Set() };
    }
    if (mySeq !== seq) return;
    const notes = [];
    if (result.orders.error) notes.push("Couldn't load orders: " + (result.orders.error.message || result.orders.error));
    if (ordersSchemaV2 === false) notes.push(`Dates are read from the customer's free-text date until ${ORDERS_MIGRATION_FILE} is run.`);
    statusEl.textContent = notes.join(" ");
    statusEl.className = notes.length ? (result.orders.error ? "a-inline-error" : "orders-notice") : "";

    const byDay = new Map();
    (result.orders.data || []).forEach((o) => {
      const day = orderEventIso(o);
      if (!day || day < startIso || day > endIso) return;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(o);
    });
    byDay.forEach((list) => list.sort((a, b) => String(orderEventTime(a) || "99").localeCompare(String(orderEventTime(b) || "99"))));
    const blocked = new Map();
    if (!result.blocked.error) (result.blocked.data || []).forEach((r) => blocked.set(String(r.day).slice(0, 10), r.reason || ""));
    render({ byDay, blocked, full: result.full, limit: result.limit });
  }

  function show(el) {
    if (!el) return;
    if (container !== el) {
      container = el;
      renderShell();
    }
    if (!monthStart) {
      const now = new Date();
      monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    }
    refresh();
  }

  window.AdminOrderCalendar = { show, refresh };
})();
