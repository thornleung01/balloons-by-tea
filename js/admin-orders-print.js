/* Printable work orders for the admin Orders tab.

   - printOrder(order): one order on a page, for the crew on the day of the
     event: a big date and time, delivery or pick-up, address, contact, items
     with quantities, money, customer and private notes, inspiration photos
     and an empty-box checklist (Packed, Loaded, Installed, Balance collected).
   - printDaySheet('YYYY-MM-DD'): a schedule table of every non-cancelled
     order on that date, sorted by time, with totals, then one work order per
     page.

   Opens a new window holding a self-contained, print-styled page and calls
   print() on it once the photos have loaded. The window is opened straight
   from the click (before any network wait) so popup blockers allow it.

   The page is black on white (no backgrounds, so it is cheap to print and
   still reads on a black-and-white printer). It does not use the admin CSS,
   so dark mode never reaches it.

   Exposes window.AdminOrderPrint = { printOrder, printDaySheet }. Uses
   helpers from js/admin-core.js and js/admin-orders.js. */
(function () {
  const PRINT_CSS = `
    @page { margin: 14mm 12mm; }
    * { box-sizing: border-box; }
    html { -webkit-print-color-adjust: economy; print-color-adjust: economy; }
    body { font: 11pt/1.4 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #000; background: #fff; margin: 0; padding: 16px; }
    .page { max-width: 190mm; margin: 0 auto; }
    h1 { font-size: 20pt; margin: 0 0 2mm; line-height: 1.15; }
    h2 { font-size: 16pt; margin: 0; line-height: 1.2; }
    h3 { font-size: 8.5pt; text-transform: uppercase; letter-spacing: .08em; color: #000; margin: 5mm 0 1.5mm; padding-bottom: 1mm; border-bottom: 1px solid #000; }
    p { margin: 0 0 2mm; }
    .toolbar { display: flex; gap: 8px; margin: 0 auto 16px; max-width: 190mm; }
    .toolbar button { font: inherit; padding: 8px 16px; border: 1.5px solid #000; border-radius: 6px; background: #fff; color: #000; cursor: pointer; }
    .order { padding-bottom: 2mm; }
    .order + .order, .schedule + .order { break-before: page; page-break-before: always; margin-top: 12mm; }
    .kicker { display: flex; justify-content: space-between; gap: 8mm; font-size: 9pt; letter-spacing: .06em; text-transform: uppercase; margin-bottom: 2mm; }
    .event { display: flex; justify-content: space-between; align-items: flex-end; gap: 6mm; flex-wrap: wrap; padding: 4mm 5mm; border: 2.5px solid #000; border-radius: 3mm; break-inside: avoid; }
    .when { font-size: 24pt; font-weight: 800; line-height: 1.1; }
    .time { font-size: 24pt; font-weight: 800; line-height: 1.1; }
    .how { font-size: 11pt; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; padding: 1mm 3mm; border: 2px solid #000; border-radius: 2mm; }
    .who { margin: 4mm 0 0; font-size: 16pt; font-weight: 700; }
    .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0 8mm; }
    .cols > div { break-inside: avoid; }
    .big { font-size: 12pt; }
    table { width: 100%; border-collapse: collapse; }
    thead { display: table-header-group; }
    tr { break-inside: avoid; }
    th, td { text-align: left; padding: 1.5mm 2mm; border-bottom: 1px solid #000; vertical-align: top; }
    th { font-size: 8pt; text-transform: uppercase; letter-spacing: .06em; border-bottom: 2px solid #000; }
    .qty { width: 14mm; font-size: 13pt; font-weight: 800; text-align: center; }
    .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    tfoot td { font-weight: 800; border-bottom: none; border-top: 2px solid #000; }
    .sub { font-size: 9.5pt; margin-top: .5mm; }
    .pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    .box { border: 1.5px solid #000; border-radius: 2mm; padding: 2.5mm 3mm; min-height: 14mm; break-inside: avoid; }
    .money { display: flex; gap: 8mm; flex-wrap: wrap; margin-top: 3mm; font-size: 10.5pt; font-variant-numeric: tabular-nums; }
    .money strong { font-size: 13pt; }
    .due strong { text-decoration: underline; }
    .photos { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3mm; }
    .photos img { width: 100%; aspect-ratio: 1; object-fit: cover; border: 1px solid #000; border-radius: 1.5mm; break-inside: avoid; filter: grayscale(1); }
    .checks { display: grid; grid-template-columns: repeat(2, 1fr); gap: 3mm 8mm; margin-top: 2mm; font-size: 12pt; break-inside: avoid; }
    .checks span { display: flex; align-items: center; gap: 3mm; }
    .checks span::before { content: ""; flex: none; width: 6mm; height: 6mm; border: 2px solid #000; border-radius: 1mm; }
    .empty { font-style: italic; }
    .schedule h1 { margin-bottom: 1mm; }
    .schedule .lead { font-size: 10.5pt; margin-bottom: 4mm; }
    .schedule td.time-col { width: 24mm; font-weight: 800; white-space: nowrap; }
    .schedule .addr { font-size: 9.5pt; }
    @media (max-width: 600px) { .cols { grid-template-columns: 1fr; } .when, .time { font-size: 18pt; } body { padding: 10px; } }
    @media print {
      body { padding: 0; }
      .toolbar { display: none; }
      a { color: inherit; text-decoration: none; }
    }`;

  function esc(v) { return escapeHtml(v == null ? "" : String(v)); }

  function openPrintWindow(title) {
    const w = window.open("", "_blank");
    if (!w) {
      adminToast("Your browser blocked the print window. Allow pop-ups for this page and try again.", { kind: "error" });
      return null;
    }
    w.document.open();
    w.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body><p class="empty">Preparing...</p></body></html>`);
    w.document.close();
    return w;
  }

  function writeAndPrint(w, title, bodyHtml) {
    if (!w || w.closed) return;
    w.document.open();
    w.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body>
      <div class="toolbar"><button type="button" data-act="print">Print</button><button type="button" data-act="close">Close</button></div>
      <div class="page">${bodyHtml}</div></body></html>`);
    w.document.close();
    // Wired from here rather than inline onclick, so a future
    // Content-Security-Policy can't break the buttons.
    w.document.querySelectorAll("[data-act]").forEach((b) => {
      b.addEventListener("click", () => (b.dataset.act === "print" ? w.print() : w.close()));
    });
    // Print once the photos are in (or after 3s, whichever comes first).
    const imgs = Array.from(w.document.images);
    let printed = false;
    const go = () => {
      if (printed || w.closed) return;
      printed = true;
      try { w.focus(); w.print(); } catch (e) { /* the Print button is still there */ }
    };
    if (!imgs.length) return setTimeout(go, 150);
    let left = imgs.length;
    const done = () => { left -= 1; if (left <= 0) go(); };
    imgs.forEach((img) => {
      if (img.complete) done();
      else { img.addEventListener("load", done); img.addEventListener("error", done); }
    });
    setTimeout(go, 3000);
  }

  function itemsHtml(order) {
    const items = orderItems(order);
    if (!items.length) {
      const summary = orderSummaryBody(order);
      return summary ? `<div class="box pre">${esc(summary)}</div>` : `<p class="empty">No items listed.</p>`;
    }
    const total = orderTotalAmount(order);
    return `<table>
      <thead><tr><th class="qty">Qty</th><th>Item</th><th class="num">Line total</th></tr></thead>
      <tbody>${items.map((l) => {
        const variant = l.variant ? (typeof l.variant === "object" ? (l.variant.name || l.variant.label || "") : l.variant) : "";
        const addons = orderItemAddonsText(l);
        return `<tr><td class="qty">${esc(l.qty || 1)}</td><td>${esc(l.name || "Item")}${variant ? `<div class="sub">${esc(variant)}</div>` : ""}${addons ? `<div class="sub">+ ${esc(addons)}</div>` : ""}</td><td class="num">${esc(formatOrderMoney(l.line_total))}</td></tr>`;
      }).join("")}</tbody>
      ${total !== null ? `<tfoot><tr><td></td><td>Total</td><td class="num">${esc(formatOrderMoney(total))}</td></tr></tfoot>` : ""}
    </table>`;
  }

  function moneyHtml(order) {
    const total = orderTotalAmount(order);
    if (total === null) return order.total ? `<p class="money">Total: ${esc(order.total)}</p>` : "";
    const balance = orderBalance(order);
    const paid = orderAmountNumber(order.amount_paid) || 0;
    const deposit = orderAmountNumber(order.deposit_amount);
    return `<div class="money">
      <span>Total <strong>${esc(formatOrderMoney(total))}</strong></span>
      ${deposit !== null ? `<span>Deposit ${esc(formatOrderMoney(deposit))}</span>` : ""}
      <span>Paid ${esc(formatOrderMoney(paid) || ORDERS_CURRENCY + "0")}</span>
      <span class="${balance > 0 ? "due" : ""}">Balance due <strong>${esc(formatOrderMoney(balance) || ORDERS_CURRENCY + "0")}</strong></span>
      ${order.payment_status ? `<span>(${esc(orderPaymentLabel(order.payment_status))})</span>` : ""}
    </div>`;
  }

  function orderBlock(order, photoUrls) {
    const iso = orderEventIso(order);
    const when = iso ? friendlyOrderDay(iso) : (order.event_date || "No date given");
    const time = formatOrderTime(orderEventTime(order));
    const ref = orderRef(order);
    const pickup = order.fulfillment === "pickup";
    const photos = orderAttachmentPaths(order).map((p) => photoUrls.get(p)).filter(Boolean);
    const missingPhotos = orderAttachmentPaths(order).length - photos.length;
    return `<section class="order">
      <div class="kicker"><span>Work order${ref ? ` ${esc(ref)}` : ""}</span><span>${esc(orderKindLabel(order.kind))} &middot; ${esc(orderStatusLabel(order.status))}</span></div>
      <div class="event">
        <div><div class="when">${esc(when)}</div><div class="time">${time ? esc(time) : "Time to be confirmed"}</div></div>
        <div class="how">${pickup ? "Pick-up" : "Delivery"}</div>
      </div>
      <p class="who">${esc(order.name || "(no name)")}</p>
      <div class="cols">
        <div>
          <h3>${pickup ? "Pick-up" : "Address"}</h3>
          <div class="pre big">${esc(order.address || (pickup ? "Customer collects" : "Not given"))}</div>
        </div>
        <div>
          <h3>Contact</h3>
          <div class="big">${esc(order.phone || "No phone")}</div>
          <div>${esc(order.email || "")}</div>
        </div>
      </div>
      <h3>Items</h3>
      ${itemsHtml(order)}
      ${moneyHtml(order)}
      ${order.notes ? `<h3>Customer notes</h3><div class="box pre">${esc(order.notes)}</div>` : ""}
      ${order.admin_notes ? `<h3>Our notes</h3><div class="box pre">${esc(order.admin_notes)}</div>` : ""}
      ${photos.length || missingPhotos ? `<h3>Inspiration photos</h3><div class="photos">${photos.map((u, i) => `<img src="${esc(u)}" alt="Inspiration photo ${i + 1}">`).join("")}</div>${missingPhotos ? `<p class="empty">${missingPhotos} photo${missingPhotos === 1 ? "" : "s"} couldn't be loaded.</p>` : ""}` : ""}
      <h3>Crew checklist</h3>
      <div class="checks"><span>Packed</span><span>Loaded</span><span>Installed</span><span>Balance collected</span></div>
    </section>`;
  }

  async function photoUrlsFor(orders) {
    const paths = orders.flatMap(orderAttachmentPaths);
    if (!paths.length) return new Map();
    const { urls } = await signOrderPhotoUrls(paths);
    return urls;
  }

  async function printOrder(order) {
    if (!order) return;
    const title = `Work order - ${order.name || "order"}`;
    const w = openPrintWindow(title);
    if (!w) return;
    const urls = await photoUrlsFor([order]);
    writeAndPrint(w, title, orderBlock(order, urls));
  }

  function timeSortKey(order) {
    const t = orderEventTime(order);
    const m = /^(\d{1,2}):(\d{2})/.exec(t);
    return m ? m[1].padStart(2, "0") + m[2] : (t ? "50" + t : "99");
  }

  /* One compact table, sorted by time, with totals. */
  function scheduleHtml(title, orders) {
    const totals = orders.reduce((acc, o) => {
      const t = orderTotalAmount(o);
      const b = orderBalance(o);
      if (t !== null) acc.total += t;
      if (b !== null && o.payment_status !== "paid") acc.balance += b;
      return acc;
    }, { total: 0, balance: 0 });
    const money = (n) => formatOrderMoney(n) || ORDERS_CURRENCY + "0";
    return `<section class="schedule">
      <h1>${esc(title)}</h1>
      <p class="lead">${orders.length} order${orders.length === 1 ? "" : "s"}. Order total ${esc(money(totals.total))}. Balance to collect ${esc(money(totals.balance))}.</p>
      <table>
        <thead><tr><th>Time</th><th>Customer</th><th>Where</th><th class="num">Total</th><th class="num">Balance</th></tr></thead>
        <tbody>${orders.map((o) => {
          const b = orderBalance(o);
          return `<tr>
            <td class="time-col">${esc(formatOrderTime(orderEventTime(o)) || "TBC")}</td>
            <td>${esc(o.name || "(no name)")}<div class="sub">${esc(o.phone || "")}</div></td>
            <td class="addr">${esc(o.fulfillment === "pickup" ? "Pick-up" : (o.address || "Address not given"))}</td>
            <td class="num">${esc(orderTotalLabel(o))}</td>
            <td class="num">${b === null ? "" : esc(money(b))}</td>
          </tr>`;
        }).join("")}</tbody>
        <tfoot><tr><td colspan="3">Totals</td><td class="num">${esc(money(totals.total))}</td><td class="num">${esc(money(totals.balance))}</td></tr></tfoot>
      </table>
    </section>`;
  }

  async function printDaySheet(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || "")) {
      adminToast("Pick a date for the day sheet first.", { kind: "info" });
      return;
    }
    const title = `Day sheet - ${friendlyOrderDay(iso)}`;
    const w = openPrintWindow(title);
    if (!w) return;
    const client = getSupabaseClient();
    let q = client.from("orders").select("*").neq("status", "cancelled");
    q = ordersSchemaV2
      ? q.eq("event_on", iso)
      : q.gte("event_date", iso).lt("event_date", ordersNextIso(iso));
    const { data, error } = await q.order("created_at", { ascending: true }).limit(500);
    if (error) {
      writeAndPrint(w, title, `<h1>${esc(title)}</h1><p class="empty">Couldn't load orders: ${esc(error.message)}</p>`);
      return;
    }
    const orders = (data || []).filter((o) => orderEventIso(o) === iso)
      .sort((a, b) => timeSortKey(a).localeCompare(timeSortKey(b)));
    const urls = await photoUrlsFor(orders);
    writeAndPrint(w, title, orders.length
      ? scheduleHtml(title, orders) + orders.map((o) => orderBlock(o, urls)).join("")
      : `<h1>${esc(title)}</h1><p class="empty">No orders on this date.</p>`);
  }

  window.AdminOrderPrint = { printOrder, printDaySheet, _css: PRINT_CSS, _orderBlock: orderBlock, _schedule: scheduleHtml };
})();
