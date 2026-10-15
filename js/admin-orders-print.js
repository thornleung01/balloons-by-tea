/* Printable work orders for the admin Orders tab.

   - printOrder(order): one order on a page, for the day of the event —
     event date/time, fulfilment, address, contact, items, totals and
     balance, customer notes, private admin notes and inspiration photo
     thumbnails.
   - printDaySheet('YYYY-MM-DD'): every non-cancelled order on that date,
     sorted by time, one block per order (page breaks between orders when
     they don't fit).

   Opens a new window holding a self-contained, print-styled page and calls
   print() on it once the photos have loaded. The window is opened straight
   from the click (before any network wait) so popup blockers allow it.

   Exposes window.AdminOrderPrint = { printOrder, printDaySheet }. Uses
   helpers from js/admin-core.js and js/admin-orders.js. */
(function () {
  const PRINT_CSS = `
    * { box-sizing: border-box; }
    body { font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: #222; margin: 0; padding: 24px; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    h2 { font-size: 17px; margin: 0; }
    h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #666; margin: 14px 0 4px; }
    .toolbar { margin-bottom: 16px; display: flex; gap: 8px; }
    .toolbar button { font: inherit; padding: 6px 14px; border: 1px solid #999; border-radius: 6px; background: #fff; cursor: pointer; }
    .order { border: 1px solid #bbb; border-radius: 8px; padding: 14px 16px; margin-bottom: 16px; page-break-inside: avoid; break-inside: avoid; }
    .order-head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; border-bottom: 2px solid #222; padding-bottom: 8px; }
    .when { font-size: 18px; font-weight: 700; }
    .meta { color: #555; font-size: 12px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 24px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid #ddd; vertical-align: top; }
    th { font-size: 11px; text-transform: uppercase; color: #666; }
    .num { text-align: right; white-space: nowrap; }
    tfoot td { font-weight: 700; border-bottom: none; }
    .sub { color: #555; font-size: 12px; }
    .pre { white-space: pre-wrap; }
    .money { display: flex; gap: 18px; flex-wrap: wrap; font-size: 13px; }
    .money strong { font-size: 15px; }
    .due { color: #b00020; }
    .photos { display: flex; gap: 8px; flex-wrap: wrap; }
    .photos img { width: 150px; height: 150px; object-fit: cover; border-radius: 6px; border: 1px solid #ccc; }
    .checks { display: flex; gap: 18px; flex-wrap: wrap; margin-top: 10px; font-size: 13px; }
    .checks span::before { content: ""; display: inline-block; width: 13px; height: 13px; border: 1.5px solid #444; border-radius: 2px; margin-right: 6px; vertical-align: -2px; }
    .empty { color: #666; font-style: italic; }
    @media (max-width: 600px) { .grid { grid-template-columns: 1fr; } body { padding: 12px; } }
    @media print {
      body { padding: 0; }
      .toolbar { display: none; }
      .order { border-color: #888; }
      .page-break { page-break-before: always; break-before: page; }
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
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body><p class="empty">Preparing...</p></body></html>`);
    w.document.close();
    return w;
  }

  function writeAndPrint(w, title, bodyHtml) {
    if (!w || w.closed) return;
    w.document.open();
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body>
      <div class="toolbar"><button type="button" data-act="print">Print</button><button type="button" data-act="close">Close</button></div>
      ${bodyHtml}</body></html>`);
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
      return summary ? `<div class="pre">${esc(summary)}</div>` : `<p class="empty">No items listed.</p>`;
    }
    const total = orderTotalAmount(order);
    return `<table>
      <thead><tr><th>Qty</th><th>Item</th><th class="num">Line total</th></tr></thead>
      <tbody>${items.map((l) => {
        const variant = l.variant ? (typeof l.variant === "object" ? (l.variant.name || l.variant.label || "") : l.variant) : "";
        const addons = orderItemAddonsText(l);
        return `<tr><td>${esc(l.qty || 1)}</td><td>${esc(l.name || "Item")}${variant ? `<div class="sub">${esc(variant)}</div>` : ""}${addons ? `<div class="sub">+ ${esc(addons)}</div>` : ""}</td><td class="num">${esc(formatOrderMoney(l.line_total))}</td></tr>`;
      }).join("")}</tbody>
      ${total !== null ? `<tfoot><tr><td></td><td>Total</td><td class="num">${esc(formatOrderMoney(total))}</td></tr></tfoot>` : ""}
    </table>`;
  }

  function moneyHtml(order) {
    const total = orderTotalAmount(order);
    if (total === null) return order.total ? `<p>${esc(order.total)}</p>` : "";
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
    const photos = orderAttachmentPaths(order).map((p) => photoUrls.get(p)).filter(Boolean);
    const missingPhotos = orderAttachmentPaths(order).length - photos.length;
    return `<section class="order">
      <div class="order-head">
        <div>
          <div class="when">${esc(when)}${time ? ` · ${esc(time)}` : ""}</div>
          <h2>${esc(order.name || "(no name)")}</h2>
        </div>
        <div class="meta">
          ${ref ? `<div>${esc(ref)}</div>` : ""}
          <div>${esc(orderKindLabel(order.kind))} · ${esc(order.fulfillment === "pickup" ? "Pick-up" : "Delivery")}</div>
          <div>Status: ${esc(orderStatusLabel(order.status))}</div>
        </div>
      </div>
      <div class="grid">
        <div>
          <h3>${order.fulfillment === "pickup" ? "Pick-up" : "Address"}</h3>
          <div class="pre">${esc(order.address || "—")}</div>
        </div>
        <div>
          <h3>Contact</h3>
          <div>${esc(order.phone || "")}</div>
          <div>${esc(order.email || "")}</div>
        </div>
      </div>
      <h3>Items</h3>
      ${itemsHtml(order)}
      ${moneyHtml(order)}
      ${order.notes ? `<h3>Customer notes</h3><div class="pre">${esc(order.notes)}</div>` : ""}
      ${order.admin_notes ? `<h3>Our notes</h3><div class="pre">${esc(order.admin_notes)}</div>` : ""}
      ${photos.length || missingPhotos ? `<h3>Inspiration photos</h3><div class="photos">${photos.map((u, i) => `<img src="${esc(u)}" alt="Inspiration photo ${i + 1}">`).join("")}</div>${missingPhotos ? `<p class="empty">${missingPhotos} photo${missingPhotos === 1 ? "" : "s"} couldn't be loaded.</p>` : ""}` : ""}
      <div class="checks"><span>Loaded</span><span>Delivered / picked up</span><span>Set up</span><span>Balance collected</span><span>Photos taken</span></div>
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
    const title = `Work order — ${order.name || "order"}`;
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

  async function printDaySheet(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || "")) {
      adminToast("Pick a date for the day sheet first.", { kind: "info" });
      return;
    }
    const title = `Day sheet — ${friendlyOrderDay(iso)}`;
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
    const summary = orders.length
      ? `<p class="meta">${orders.length} order${orders.length === 1 ? "" : "s"}: ${orders.map((o) => `${esc(formatOrderTime(orderEventTime(o)) || "time TBC")} ${esc(o.name || "")}`).join(" · ")}</p>`
      : "";
    writeAndPrint(w, title, `<h1>${esc(title)}</h1>${summary}${orders.length ? orders.map((o) => orderBlock(o, urls)).join("") : `<p class="empty">No orders on this date.</p>`}`);
  }

  window.AdminOrderPrint = { printOrder, printDaySheet };
})();
