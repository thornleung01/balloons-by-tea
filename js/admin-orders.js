/* Admin "Orders" tab: list with status filter/search/sort, private admin
   notes, customer inspiration photos (orders.attachments) and their
   cleanup, bulk actions, and CSV export. Uses helpers from
   js/admin-core.js. */

/* ===== Orders ===== */

let ordersStatusFilter = "all";
const ORDER_STATUSES = ["new", "contacted", "fulfilled", "cancelled"];
// Search/sort/"upcoming only" are applied client-side to ordersAllCache
// (the last full fetch), so typing in the search box re-renders without
// another round trip.
let ordersAllCache = [];
let ordersSearchQuery = "";
let ordersSortMode = "newest";
let ordersUpcomingOnly = false;
// Unsaved admin-note text per order id, so a re-render (status change,
// search keystroke, filter click) doesn't wipe a half-typed note.
const orderNoteDrafts = new Map();
// Note text currently being saved per order id — blur and the Save button
// can both fire for one edit, and the second shouldn't send it again.
const orderNoteSavesInFlight = new Map();
// Separate from selectedProductIds (Products tab) so the two bulk-selection
// features never collide — each tab's checkboxes/bulk bar only ever touch
// their own Set. IDs as strings, matching every other data-id comparison
// in this file.
let selectedOrderIds = new Set();
// The most recently rendered (filtered/searched/sorted) order list, kept so
// "select all" and the CSV export can act on exactly what's on screen
// without re-fetching — mirrors how renderProductList() scopes "select
// all" to its own visible/filtered `items` array.
let ordersVisibleCache = [];

function orderKindLabel(kind) {
  return kind === "custom" ? "Custom order" : "Checkout";
}

function formatOrderDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// Shown when a write touches something the live database doesn't have yet
// because the latest supabase-setup.sql hasn't been run.
const ORDERS_SQL_HINT = "run it in the Supabase SQL Editor";

/* True when a Supabase error means a column doesn't exist yet (the latest
   supabase-setup.sql hasn't been run) — PostgREST PGRST204 ("Could not
   find the 'x' column ... in the schema cache") or Postgres 42703
   (undefined column), with the message text as a fallback. Column-level
   counterpart of isMissingTableError() in supabase-config.js. */
function isMissingColumnError(error, column) {
  if (!error) return false;
  const msg = error.message || "";
  const mentionsColumn = !column || !msg || msg.includes(column);
  if ((error.code === "PGRST204" || error.code === "42703") && mentionsColumn) return true;
  return Boolean(column) && msg.includes(column) && /could not find the .*column|column .* does not exist/i.test(msg);
}

/* Friendlier text for a failed status write. Until the latest
   supabase-setup.sql is run, the live orders_status_check constraint
   only allows new/contacted/fulfilled, so "cancelled" fails with 23514. */
function orderStatusErrorMessage(error, status) {
  if (status === "cancelled" && (error.code === "23514" || /orders_status_check/.test(error.message || ""))) {
    return `The Cancelled status needs the latest supabase-setup.sql — ${ORDERS_SQL_HINT}.`;
  }
  return error.message;
}

/* The "AUR-XXXXXX" reference js/app.js attachOrderRef() prefixes onto
   summary as "Ref: AUR-XXXXXX\n...". "" for orders placed before refs
   existed. */
function orderRef(order) {
  const m = /^\s*Ref:\s*(AUR-[A-Z0-9]+)/i.exec(order.summary || "");
  return m ? m[1].toUpperCase() : "";
}

/* event_date is free text — 'YYYY-MM-DD' from checkout, 'YYYY-MM-DD HH:MM'
   from custom orders — but older rows or hand edits can hold anything.
   Returns a local-time Date, or null for empty/unparseable values,
   including impossible dates like 2026-02-30 that new Date() would
   silently roll over into March. */
function parseOrderEventDate(text) {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?\s*$/.exec(text || "");
  if (!m) return null;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4] || "0", m[5] || "0"].map(Number);
  if (h > 23 || mi > 59) return null;
  const date = new Date(y, mo - 1, d, h, mi);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

// Compared by calendar day, so an event earlier today still counts as
// upcoming. Empty/unparseable dates never do.
function isUpcomingOrder(order) {
  const date = parseOrderEventDate(order.event_date);
  if (!date) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date >= today;
}

function orderCreatedTime(order) {
  const t = new Date(order.created_at || "").getTime();
  return isNaN(t) ? 0 : t;
}

/* "newest" (the default, same as the fetch order), "oldest", or "event"
   (soonest event date first; empty/unparseable dates last, newest first
   among themselves). Returns a new array. */
function sortOrders(list, mode) {
  const byNewest = (a, b) => orderCreatedTime(b.order) - orderCreatedTime(a.order);
  const keyed = list.map((order) => ({ order, event: mode === "event" ? parseOrderEventDate(order.event_date) : null }));
  keyed.sort((a, b) => {
    if (mode === "oldest") return -byNewest(a, b);
    if (mode === "event") {
      if (a.event && b.event) return (a.event - b.event) || byNewest(a, b);
      if (a.event) return -1;
      if (b.event) return 1;
    }
    return byNewest(a, b);
  });
  return keyed.map((k) => k.order);
}

/* Every whitespace-separated search word must appear somewhere in the
   order (case-insensitive). A word made only of digits/phone punctuation
   also matches the phone's bare digits, so "4165551234" finds
   "(416) 555-1234". admin_notes is undefined until the column exists,
   which the || "" covers. */
function orderMatchesSearch(order, words) {
  if (!words.length) return true;
  const text = [order.name, order.phone, order.email, order.address, order.notes, order.summary, order.admin_notes]
    .map((v) => String(v || "")).join("\n").toLowerCase();
  const phoneDigits = String(order.phone || "").replace(/\D/g, "");
  return words.every((word) => {
    if (text.includes(word)) return true;
    const digits = word.replace(/\D/g, "");
    return /^[\d\s()+\-.]+$/.test(word) && digits.length >= 3 && phoneDigits.includes(digits);
  });
}

/* wa.me wants the full international number as bare digits. 10 digits is
   taken as North American and gets the 1 country code; 11 digits starting
   with 1 already has it; anything else is used as given. Under 10 digits
   can't be a full number, so no button. */
function whatsAppNumber(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 10) return "";
  if (digits.length === 10) return "1" + digits;
  return digits;
}

// Built with DOM APIs (no innerHTML) since name/phone/summary are
// customer-supplied.
function buildWhatsAppLink(order) {
  const number = whatsAppNumber(order.phone);
  if (!number) return null;
  const firstName = String(order.name || "").trim().split(/\s+/)[0];
  const ref = orderRef(order);
  const message = `Hi ${firstName || "there"}! It's Balloons by Tea, following up on your ${ref ? `order ${ref}` : "balloon order"}.`;
  const a = document.createElement("a");
  a.className = "order-whatsapp-link";
  a.href = `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = "WhatsApp";
  return a;
}

function setOrderNoteStatus(id, message, kind) {
  const el = document.querySelector(`#orderList .order-row[data-id="${CSS.escape(id)}"] .order-admin-notes-status`);
  if (!el) return;
  el.textContent = message;
  el.className = "form-status order-admin-notes-status" + (kind ? " " + kind : "");
}

/* Private per-order notes (orders.admin_notes). Saves on blur and on the
   Save button; the in-flight map stops the blur+click pair from saving
   the same text twice. Feedback is looked up by id when it's shown
   rather than captured, because the list may have re-rendered while the
   save was in flight. */
async function saveOrderAdminNote(id, value, explicit) {
  const cached = ordersAllCache.find((o) => String(o.id) === id);
  const saved = (cached && cached.admin_notes) || "";
  if (value === saved) {
    orderNoteDrafts.delete(id);
    if (explicit) setOrderNoteStatus(id, "No changes to save.", "");
    return;
  }
  if (orderNoteSavesInFlight.get(id) === value) return;
  orderNoteSavesInFlight.set(id, value);
  setOrderNoteStatus(id, "Saving...", "");
  const client = getSupabaseClient();
  const { error } = await mustAffect(client.from("orders").update({ admin_notes: value }).eq("id", id));
  orderNoteSavesInFlight.delete(id);
  if (error) {
    // The draft is kept, so the text isn't lost and the next blur retries.
    setOrderNoteStatus(id, isMissingColumnError(error, "admin_notes")
      ? `Admin notes need the latest supabase-setup.sql — ${ORDERS_SQL_HINT}.`
      : "Couldn't save note: " + error.message, "error");
    return;
  }
  const current = ordersAllCache.find((o) => String(o.id) === id);
  if (current) current.admin_notes = value;
  if (orderNoteDrafts.get(id) === value) orderNoteDrafts.delete(id);
  const textarea = document.getElementById(`orderAdminNotes-${id}`);
  if (textarea && textarea.value !== value) setOrderNoteStatus(id, "Unsaved changes", "");
  else setOrderNoteStatus(id, "Saved", "success");
}

function buildOrderAdminNotes(order) {
  const id = String(order.id);
  const saved = order.admin_notes || "";
  const wrap = document.createElement("div");
  wrap.className = "order-admin-notes";

  const label = document.createElement("label");
  label.htmlFor = `orderAdminNotes-${id}`;
  label.textContent = "Private notes (only admins see these)";

  const textarea = document.createElement("textarea");
  textarea.id = `orderAdminNotes-${id}`;
  textarea.className = "order-admin-notes-input";
  textarea.rows = 2;
  textarea.placeholder = "Deposit paid, colour changes, follow-up reminders...";
  textarea.value = orderNoteDrafts.has(id) ? orderNoteDrafts.get(id) : saved;

  const actions = document.createElement("div");
  actions.className = "order-admin-notes-actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "order-admin-notes-save";
  saveBtn.textContent = "Save note";
  const status = document.createElement("span");
  status.className = "form-status order-admin-notes-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  if (textarea.value !== saved) status.textContent = "Unsaved changes";
  actions.append(saveBtn, status);

  textarea.addEventListener("input", () => {
    const current = ordersAllCache.find((o) => String(o.id) === id);
    const savedNow = (current && current.admin_notes) || "";
    if (textarea.value === savedNow) orderNoteDrafts.delete(id);
    else orderNoteDrafts.set(id, textarea.value);
    setOrderNoteStatus(id, textarea.value === savedNow ? "" : "Unsaved changes", "");
  });
  textarea.addEventListener("blur", () => saveOrderAdminNote(id, textarea.value, false));
  saveBtn.addEventListener("click", () => saveOrderAdminNote(id, textarea.value, true));

  wrap.append(label, textarea, actions);
  return wrap;
}

function updateOrderFilterCounts(orders) {
  document.querySelectorAll("#ordersFilter .orders-filter-count").forEach((el) => {
    const key = el.dataset.countFor;
    const count = key === "all" ? orders.length : orders.filter((o) => (o.status || "new") === key).length;
    el.textContent = `(${count})`;
  });
}

async function refreshOrderList() {
  const client = getSupabaseClient();
  const listEl = document.getElementById("orderList");
  // select("*") rather than a column list so loading keeps working on a
  // database that doesn't have admin_notes yet.
  const { data, error } = await client
    .from("orders")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    listEl.innerHTML = `<p class="form-status error">Couldn't load orders: ${escapeHtml(error.message)}</p>`;
    return;
  }

  ordersAllCache = data || [];

  const badge = document.getElementById("ordersBadge");
  const newCount = ordersAllCache.filter((o) => (o.status || "new") === "new").length;
  if (newCount > 0) {
    badge.textContent = String(newCount);
    show(badge);
  } else {
    hide(badge);
  }

  // Drop any selected ids that no longer exist at all (e.g. deleted by
  // another admin tab/session) so stale ids don't silently pile up in the
  // Set. Checked against the full fetch, not the filtered list, so a
  // selection made under one filter is still intact after switching to
  // another filter and back — selection is deliberately NOT cleared just
  // because refreshOrderList() re-ran (it re-runs on every filter click).
  const allIds = new Set(ordersAllCache.map((o) => String(o.id)));
  [...selectedOrderIds].forEach((id) => { if (!allIds.has(id)) selectedOrderIds.delete(id); });
  [...orderNoteDrafts.keys()].forEach((id) => { if (!allIds.has(id)) orderNoteDrafts.delete(id); });

  renderOrderList();
  checkOrderPhotosSchema();
}

/* Applies the status filter, search, "upcoming only" and sort to
   ordersAllCache and renders the result. No fetch, so it's cheap enough
   to run on every (debounced) search keystroke. */
function renderOrderList() {
  const listEl = document.getElementById("orderList");
  updateOrderFilterCounts(ordersAllCache);

  const words = ordersSearchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let visible = ordersAllCache
    .filter((o) => ordersStatusFilter === "all" || (o.status || "new") === ordersStatusFilter)
    .filter((o) => orderMatchesSearch(o, words));
  if (ordersUpcomingOnly) visible = visible.filter(isUpcomingOrder);
  visible = sortOrders(visible, ordersSortMode);
  ordersVisibleCache = visible;

  if (!visible.length) {
    const message = words.length || ordersUpcomingOnly
      ? "No orders match your search and filters."
      : `No orders ${ordersStatusFilter === "all" ? "yet" : "with this status"}.`;
    listEl.innerHTML = `<p class="empty-note">${message}</p>`;
    syncOrderBulkSelectionUI([]);
    return;
  }

  listEl.innerHTML = visible.map((order) => {
    const status = order.status || "new";
    return `
    <div class="order-row status-${escapeHtml(status)}" data-id="${escapeHtml(String(order.id))}">
      <div class="order-row-head">
        <div class="order-row-title">
          <input type="checkbox" class="order-select" data-select-id="${order.id}" aria-label="Select order from ${escapeHtml(order.name || "customer")}" ${selectedOrderIds.has(String(order.id)) ? "checked" : ""}/>
          <span class="status-dot" aria-hidden="true"></span>
          <span class="order-kind-tag">${escapeHtml(orderKindLabel(order.kind))}</span>
          <strong>${escapeHtml(order.name || "(no name)")}</strong>
        </div>
        <span class="order-date">${escapeHtml(formatOrderDate(order.created_at))}</span>
      </div>
      <div class="order-contact">
        ${order.phone ? `<a href="tel:${escapeHtml(order.phone)}">${escapeHtml(order.phone)}</a>` : ""}
        ${order.email ? `<a href="mailto:${escapeHtml(order.email)}">${escapeHtml(order.email)}</a>` : ""}
      </div>
      ${order.address ? `<div class="order-field"><strong>Address:</strong> ${escapeHtml(order.address)}</div>` : ""}
      ${order.event_date ? `<div class="order-field"><strong>Date:</strong> ${escapeHtml(order.event_date)}</div>` : ""}
      ${order.total ? `<div class="order-field"><strong>${escapeHtml(order.total)}</strong></div>` : ""}
      ${order.summary ? `<div class="order-field order-summary-text">${escapeHtml(order.summary)}</div>` : ""}
      ${order.notes ? `<div class="order-field order-notes-text">${escapeHtml(order.notes)}</div>` : ""}
      <div class="order-row-actions">
        <select class="order-status-select" data-id="${order.id}" aria-label="Order status">
          ${ORDER_STATUSES.map((s) => `<option value="${s}" ${s === status ? "selected" : ""}>${s.charAt(0).toUpperCase() + s.slice(1)}</option>`).join("")}
        </select>
        <button type="button" class="danger delete-order-btn" data-id="${order.id}">Delete</button>
      </div>
    </div>
  `;
  }).join("");

  // The WhatsApp link and notes editor are added with DOM APIs rather
  // than the template above, since both put customer/admin text into
  // attributes and form values.
  const byId = new Map(visible.map((o) => [String(o.id), o]));
  listEl.querySelectorAll(".order-row").forEach((row) => {
    const order = byId.get(row.dataset.id);
    if (!order) return;
    const waLink = buildWhatsAppLink(order);
    if (waLink) row.querySelector(".order-contact").appendChild(waLink);
    const photos = buildOrderAttachments(order);
    if (photos) row.insertBefore(photos, row.querySelector(".order-row-actions"));
    row.insertBefore(buildOrderAdminNotes(order), row.querySelector(".order-row-actions"));
  });
  loadOrderAttachmentThumbs();

  listEl.querySelectorAll(".order-status-select").forEach((sel) => {
    sel.addEventListener("change", () => handleOrderStatusChange(sel.dataset.id, sel.value));
  });
  listEl.querySelectorAll(".delete-order-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleDeleteOrder(btn.dataset.id));
  });
  listEl.querySelectorAll(".order-select").forEach((box) => {
    box.addEventListener("change", () => {
      if (box.checked) selectedOrderIds.add(box.dataset.selectId);
      else selectedOrderIds.delete(box.dataset.selectId);
      syncOrderBulkSelectionUI(ordersVisibleCache);
    });
  });
  syncOrderBulkSelectionUI(visible);
}

async function handleOrderStatusChange(id, status) {
  const client = getSupabaseClient();
  const { error } = await mustAffect(client.from("orders").update({ status }).eq("id", id));
  if (error) {
    alert("Couldn't update status: " + orderStatusErrorMessage(error, status));
    // Put the dropdown back to the status that's actually saved.
    renderOrderList();
    return;
  }
  await refreshOrderList();
}

async function handleDeleteOrder(id) {
  const order = ordersAllCache.find((o) => String(o.id) === String(id));
  const photoCount = order ? orderAttachmentPaths(order).length : 0;
  const photoNote = photoCount ? ` Its ${photoCount === 1 ? "photo" : `${photoCount} photos`} will be deleted too.` : "";
  if (!confirm(`Delete this order?${photoNote} This can't be undone.`)) return;
  const client = getSupabaseClient();
  const { data, error } = await mustAffect(client.from("orders").delete().eq("id", id));
  if (error) {
    alert("Couldn't delete: " + error.message);
    return;
  }
  const photoProblem = await removeOrderPhotoFiles(data || []);
  await refreshOrderList();
  if (photoProblem) alert("The order was deleted, but " + photoProblem);
}

/* ----- Order photos (customer inspiration photos) -----
   Custom orders can carry up to 3 photos in orders.attachments: paths in
   the private 'order-uploads' Storage bucket (see js/order-uploads.js and
   the "Order photo uploads" section of supabase-setup.sql). Only the admin can read them, through
   short-lived signed URLs. */
const ORDER_PHOTOS_BUCKET = "order-uploads";
const ORDER_PHOTOS_SQL_HINT = "Photo uploads need the latest supabase-setup.sql";
const ORDER_PHOTO_URL_TTL = 3600; // seconds
const ORDER_PHOTO_PATH_RE = /^pending\/([0-9a-f-]{36})\/[0-9]\.(jpg|jpeg|png|webp)$/;
const ORDER_PHOTO_FOLDER_RE = /^[0-9a-f-]{36}$/;
const ORDER_PHOTO_CLEANUP_AGE_DAYS = 7;
// path -> { url, expires } so re-renders (every search keystroke) don't re-sign.
const orderPhotoUrlCache = new Map();
// path -> error message for photos that couldn't be signed (e.g. missing).
const orderPhotoUrlErrors = new Map();
let orderPhotosSchemaChecked = false;

function orderAttachmentPaths(order) {
  return Array.isArray(order && order.attachments) ? order.attachments.filter((p) => typeof p === "string" && p) : [];
}

function setOrderPhotoToolsStatus(message, kind) {
  const el = document.getElementById("orderPhotoToolsStatus");
  if (!el) return;
  el.textContent = message || "";
  el.className = "form-status" + (kind ? " " + kind : "");
}

// Built with DOM APIs; the thumbnails are filled in by
// loadOrderAttachmentThumbs() once their signed URLs exist.
function buildOrderAttachments(order) {
  const paths = orderAttachmentPaths(order);
  if (!paths.length) return null;
  const wrap = document.createElement("div");
  wrap.className = "order-attachments";
  const label = document.createElement("span");
  label.className = "order-attachments-label";
  label.textContent = `Inspiration photos (${paths.length})`;
  const list = document.createElement("div");
  list.className = "order-attachments-list";
  paths.forEach((path, i) => {
    const link = document.createElement("a");
    link.className = "order-attachment";
    link.dataset.path = path;
    link.dataset.alt = `Inspiration photo ${i + 1} from ${order.name || "the customer"}`;
    link.textContent = "Loading...";
    list.appendChild(link);
  });
  const status = document.createElement("p");
  status.className = "form-status error order-attachments-status";
  status.hidden = true;
  wrap.append(label, list, status);
  applyOrderAttachmentUrls(wrap);
  return wrap;
}

function applyOrderAttachmentUrls(root) {
  root.querySelectorAll(".order-attachment[data-path]").forEach((link) => {
    const path = link.dataset.path;
    const cached = orderPhotoUrlCache.get(path);
    if (cached && cached.expires > Date.now()) {
      if (link.getAttribute("href") === cached.url) return;
      link.href = cached.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = "Open full size in a new tab";
      link.classList.remove("is-error");
      const img = document.createElement("img");
      img.src = cached.url;
      img.alt = link.dataset.alt || "Inspiration photo";
      img.loading = "lazy";
      link.replaceChildren(img);
    } else if (orderPhotoUrlErrors.has(path)) {
      link.removeAttribute("href");
      link.classList.add("is-error");
      link.textContent = "Photo unavailable";
      link.title = orderPhotoUrlErrors.get(path);
    }
  });
}

/* Signs every visible photo that doesn't have a fresh URL yet, in one
   request. Looks the links up again after the await, since the list may
   have re-rendered meanwhile. A failed request shows a message on each
   affected order instead of thumbnails; the order itself is unaffected. */
async function loadOrderAttachmentThumbs() {
  const listEl = document.getElementById("orderList");
  if (!listEl) return;
  const soon = Date.now() + 5 * 60 * 1000;
  const need = [...new Set(Array.from(listEl.querySelectorAll(".order-attachment[data-path]"), (a) => a.dataset.path))]
    .filter((p) => !orderPhotoUrlErrors.has(p) && !((orderPhotoUrlCache.get(p) || {}).expires > soon));
  if (!need.length) return;
  const client = getSupabaseClient();
  let data = null;
  let error = null;
  try {
    ({ data, error } = await client.storage.from(ORDER_PHOTOS_BUCKET).createSignedUrls(need, ORDER_PHOTO_URL_TTL));
  } catch (err) {
    error = err;
  }
  if (error) {
    const message = /bucket not found/i.test(error.message || "")
      ? `${ORDER_PHOTOS_SQL_HINT} — ${ORDERS_SQL_HINT}.`
      : `Couldn't load photos: ${error.message || error}`;
    const needSet = new Set(need);
    document.querySelectorAll("#orderList .order-attachments").forEach((wrap) => {
      const links = Array.from(wrap.querySelectorAll(".order-attachment[data-path]"));
      if (!links.some((a) => needSet.has(a.dataset.path))) return;
      links.forEach((a) => { if (needSet.has(a.dataset.path)) { a.textContent = "Not loaded"; a.classList.add("is-error"); } });
      const status = wrap.querySelector(".order-attachments-status");
      status.textContent = message;
      status.hidden = false;
    });
    return;
  }
  const expires = Date.now() + ORDER_PHOTO_URL_TTL * 1000;
  (data || []).forEach((item) => {
    if (item && item.signedUrl && !item.error) orderPhotoUrlCache.set(item.path, { url: item.signedUrl, expires });
    else if (item && item.path) orderPhotoUrlErrors.set(item.path, String(item.error || "Couldn't load this photo"));
  });
  applyOrderAttachmentUrls(document.getElementById("orderList"));
}

/* Deletes the Storage files of orders that were just deleted. Skips any
   path another order still uses. Returns null on success, or a sentence
   describing what went wrong (the files are then left behind and "Clean up
   unused photos" will find them once they're a week old). */
async function removeOrderPhotoFiles(deletedOrders) {
  const deletedIds = new Set(deletedOrders.map((o) => String(o.id)));
  const stillUsed = new Set(ordersAllCache.filter((o) => !deletedIds.has(String(o.id))).flatMap(orderAttachmentPaths));
  const paths = [...new Set(deletedOrders.flatMap(orderAttachmentPaths))].filter((p) => !stillUsed.has(p));
  if (!paths.length) return null;
  const leftoverNote = `"Clean up unused photos" can remove them after ${ORDER_PHOTO_CLEANUP_AGE_DAYS} days.`;
  let data = null;
  let error = null;
  try {
    ({ data, error } = await getSupabaseClient().storage.from(ORDER_PHOTOS_BUCKET).remove(paths));
  } catch (err) {
    error = err;
  }
  if (error) {
    return `its ${paths.length === 1 ? "photo" : `${paths.length} photos`} couldn't be deleted (${error.message || error}). ${leftoverNote}`;
  }
  // Like mustAffect(): Storage reports success even when nothing was
  // removed (login expired, file already gone), so count what came back.
  const removed = new Set((data || []).map((o) => o.name));
  const notRemoved = paths.filter((p) => !removed.has(p));
  paths.forEach((p) => { if (removed.has(p)) orderPhotoUrlCache.delete(p); });
  if (notRemoved.length) {
    return `${notRemoved.length === 1 ? "1 photo wasn't" : `${notRemoved.length} photos weren't`} deleted (already gone, or your login may have expired). ${leftoverNote}`;
  }
  return null;
}

/* Shows the "needs the latest SQL" hint when orders has no attachments
   column yet. Checked once per page load, from the loaded rows when there
   are any, otherwise with a one-row probe. */
async function checkOrderPhotosSchema() {
  if (orderPhotosSchemaChecked) return;
  orderPhotosSchemaChecked = true;
  let missing;
  if (ordersAllCache.length) {
    missing = !("attachments" in ordersAllCache[0]);
  } else {
    const { error } = await getSupabaseClient().from("orders").select("attachments").limit(1);
    missing = isMissingColumnError(error, "attachments");
  }
  const btn = document.getElementById("cleanupOrderPhotosBtn");
  if (missing) {
    if (btn) btn.disabled = true;
    setOrderPhotoToolsStatus(`${ORDER_PHOTOS_SQL_HINT} — ${ORDERS_SQL_HINT}.`, "");
  }
}

// Every entry under `prefix` in the bucket, paging through list().
async function listAllOrderPhotoEntries(prefix) {
  const client = getSupabaseClient();
  const pageSize = 100;
  const all = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await client.storage.from(ORDER_PHOTOS_BUCKET).list(prefix, { limit: pageSize, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw error;
    all.push(...(data || []));
    if (!data || data.length < pageSize) return all;
  }
}

// Upload folders referenced by any order, fetched fresh (not from the
// list cache) and paged past PostgREST's 1000-row cap. Throws on any
// error: "couldn't check" must never be mistaken for "unused".
async function fetchReferencedOrderPhotoFolders() {
  const client = getSupabaseClient();
  const folders = new Set();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client.from("orders").select("id, attachments").order("id").range(from, from + pageSize - 1);
    if (error) throw error;
    (data || []).forEach((o) => orderAttachmentPaths(o).forEach((p) => {
      const folder = p.split("/")[1];
      if (folder) folders.add(folder);
    }));
    if (!data || data.length < pageSize) return folders;
  }
}

/* pending/<folder>/ folders that no order references and whose newest
   file is over ORDER_PHOTO_CLEANUP_AGE_DAYS old: uploads from abandoned
   or failed submissions, and photos of deleted orders. A folder with any
   file whose age can't be read is left alone. */
async function findUnusedOrderPhotoFolders() {
  const referenced = await fetchReferencedOrderPhotoFolders();
  const cutoff = Date.now() - ORDER_PHOTO_CLEANUP_AGE_DAYS * 24 * 60 * 60 * 1000;
  const entries = await listAllOrderPhotoEntries("pending");
  const candidates = [];
  for (const entry of entries) {
    // Folders come back as entries without an id.
    if (entry.id || !ORDER_PHOTO_FOLDER_RE.test(entry.name) || referenced.has(entry.name)) continue;
    const files = (await listAllOrderPhotoEntries(`pending/${entry.name}`)).filter((f) => f.id);
    if (!files.length) continue;
    const times = files.map((f) => new Date(f.created_at || "").getTime());
    if (times.some((t) => isNaN(t)) || Math.max(...times) >= cutoff) continue;
    candidates.push({ folder: entry.name, paths: files.map((f) => `pending/${entry.name}/${f.name}`) });
  }
  return candidates;
}

async function handleCleanupOrderPhotos() {
  const btn = document.getElementById("cleanupOrderPhotosBtn");
  btn.disabled = true;
  setOrderPhotoToolsStatus("Looking for unused photos...", "");
  try {
    let candidates;
    try {
      candidates = await findUnusedOrderPhotoFolders();
    } catch (err) {
      const message = isMissingColumnError(err, "attachments") || /bucket not found/i.test(err.message || "")
        ? `${ORDER_PHOTOS_SQL_HINT} — ${ORDERS_SQL_HINT}.`
        : `Couldn't check for unused photos (${err.message || err}), so nothing was deleted.`;
      setOrderPhotoToolsStatus(message, "error");
      return;
    }
    if (!candidates.length) {
      setOrderPhotoToolsStatus(`No unused photos older than ${ORDER_PHOTO_CLEANUP_AGE_DAYS} days.`, "success");
      return;
    }
    const fileCount = candidates.reduce((n, c) => n + c.paths.length, 0);
    const summary = `${fileCount} photo${fileCount === 1 ? "" : "s"} from ${candidates.length} upload${candidates.length === 1 ? "" : "s"}`;
    setOrderPhotoToolsStatus(`Found ${summary} that no order uses.`, "");
    if (!confirm(`Permanently delete ${summary}? They were uploaded over ${ORDER_PHOTO_CLEANUP_AGE_DAYS} days ago and no order uses them (abandoned forms, or deleted orders). This can't be undone.`)) {
      setOrderPhotoToolsStatus("Nothing was deleted.", "");
      return;
    }

    // Re-check right before deleting: an order may have started using one
    // of these since the scan. If the check fails, delete nothing.
    let referenced;
    try {
      referenced = await fetchReferencedOrderPhotoFolders();
    } catch (err) {
      setOrderPhotoToolsStatus(`Couldn't re-check whether these photos are in use (${err.message || err}), so nothing was deleted. Try again.`, "error");
      return;
    }
    const paths = candidates.filter((c) => !referenced.has(c.folder)).flatMap((c) => c.paths);
    const skipped = fileCount - paths.length;
    const client = getSupabaseClient();
    let deleted = 0;
    const failures = [];
    for (let i = 0; i < paths.length; i += 100) {
      const batch = paths.slice(i, i + 100);
      const { data, error } = await client.storage.from(ORDER_PHOTOS_BUCKET).remove(batch);
      if (error) {
        failures.push(`${batch.length} photo${batch.length === 1 ? "" : "s"}: ${error.message}`);
        continue;
      }
      const removed = new Set((data || []).map((o) => o.name));
      deleted += batch.filter((p) => removed.has(p)).length;
      const notRemoved = batch.filter((p) => !removed.has(p)).length;
      if (notRemoved) failures.push(`${notRemoved} photo${notRemoved === 1 ? "" : "s"} weren't deleted (already gone, or your login may have expired)`);
    }
    const parts = [`Deleted ${deleted} unused photo${deleted === 1 ? "" : "s"}.`];
    if (skipped) parts.push(`${skipped} skipped because an order now uses them.`);
    if (failures.length) parts.push("Problems: " + failures.join("; ") + ".");
    setOrderPhotoToolsStatus(parts.join(" "), failures.length ? "error" : "success");
    if (failures.length) alert("Some photos couldn't be deleted:\n" + failures.join("\n"));
  } finally {
    btn.disabled = false;
  }
}

/* Keeps the orders "select all" checkbox and bulk action bar in sync with
   selectedOrderIds — same job as syncBulkSelectionUI() does for Products,
   kept as a separate function (and separate Set) so neither tab's bulk
   selection can leak into the other's. Takes the currently visible
   (status-filtered) orders so "select all" only ever covers what's on
   screen. */
function syncOrderBulkSelectionUI(visibleOrders) {
  const selectAllBox = document.getElementById("orderSelectAll");
  if (selectAllBox) {
    const visibleIds = visibleOrders.map((o) => String(o.id));
    const selectedVisibleCount = visibleIds.filter((id) => selectedOrderIds.has(id)).length;
    selectAllBox.checked = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
    selectAllBox.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visibleIds.length;
  }

  const bar = document.getElementById("orderBulkActionBar");
  const count = selectedOrderIds.size;
  bar.hidden = count === 0;
  if (count > 0) {
    document.getElementById("orderBulkSelectedCount").textContent = `${count} selected`;
  }
}

function clearOrderSelection() {
  selectedOrderIds.clear();
  document.querySelectorAll("#orderList .order-select").forEach((box) => { box.checked = false; });
  syncOrderBulkSelectionUI(ordersVisibleCache);
}

async function bulkUpdateOrderStatus(status) {
  const ids = [...selectedOrderIds];
  if (!ids.length) return;
  const client = getSupabaseClient();
  const bar = document.getElementById("orderBulkActionBar");
  bar.querySelectorAll("button").forEach((b) => { b.disabled = true; });
  const { error } = await mustAffect(client.from("orders").update({ status }).in("id", ids));
  bar.querySelectorAll("button").forEach((b) => { b.disabled = false; });
  if (error) {
    alert("Couldn't update: " + orderStatusErrorMessage(error, status));
    return;
  }
  selectedOrderIds.clear();
  await refreshOrderList();
}

async function bulkDeleteOrders() {
  const ids = [...selectedOrderIds];
  if (!ids.length) return;
  const label = ids.length === 1 ? "this order" : `these ${ids.length} orders`;
  const idSet = new Set(ids);
  const photoCount = ordersAllCache.filter((o) => idSet.has(String(o.id))).reduce((n, o) => n + orderAttachmentPaths(o).length, 0);
  const photoNote = photoCount ? ` Their ${photoCount === 1 ? "photo" : `${photoCount} photos`} will be deleted too.` : "";
  if (!confirm(`Delete ${label}?${photoNote} This can't be undone.`)) return;
  const client = getSupabaseClient();
  const bar = document.getElementById("orderBulkActionBar");
  bar.querySelectorAll("button").forEach((b) => { b.disabled = true; });
  const { data, error } = await mustAffect(client.from("orders").delete().in("id", ids));
  if (error) {
    bar.querySelectorAll("button").forEach((b) => { b.disabled = false; });
    alert("Couldn't delete: " + error.message);
    return;
  }
  const photoProblem = await removeOrderPhotoFiles(data || []);
  bar.querySelectorAll("button").forEach((b) => { b.disabled = false; });
  selectedOrderIds.clear();
  await refreshOrderList();
  if (photoProblem) alert(`The order${ids.length === 1 ? " was" : "s were"} deleted, but ` + photoProblem);
}

/* CSV field escaping per RFC 4180: wrap in double quotes (and double up
   any internal quotes) whenever the value contains a comma, quote, or
   newline — otherwise a customer name/note/address containing a comma
   would silently split into extra columns. */
function csvEscapeField(value) {
  let str = value === null || value === undefined ? "" : String(value);
  // Order fields come straight from the public checkout/custom-order
  // forms, so a "customer" could submit a name like =HYPERLINK(...) that a
  // spreadsheet would execute as a formula on open. Prefix a single quote
  // to any cell starting with a formula trigger so it's read as text.
  // Values made only of digits/spaces/()+-. (phone numbers like
  // "+852 9123 4567", negative amounts) can't invoke a function, so they
  // pass through untouched instead of gaining a visible apostrophe.
  if (/^[=+\-@\t\r]/.test(str) && !/^[+\-\d\s().]+$/.test(str)) str = "'" + str;
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/* Exports whatever is currently visible in #orderList — i.e. respects the
   active status filter, search, "upcoming only" and sort, using the same
   ordersVisibleCache that
   drives "select all" — as a downloadable CSV. No bulk-selection
   dependency: exports every filtered/visible row regardless of checkbox
   state, which is the minimum useful behavior (e.g. "export all New
   orders" with nothing selected). */
function exportOrdersCsv() {
  const rows = ordersVisibleCache;
  if (!rows.length) {
    alert("No orders to export for the current filter.");
    return;
  }

  const header = ["Date", "Kind", "Name", "Phone", "Email", "Address", "Event Date", "Total", "Status", "Summary", "Notes", "Admin Notes"];
  const lines = [header.map(csvEscapeField).join(",")];
  rows.forEach((order) => {
    lines.push([
      order.created_at || "",
      orderKindLabel(order.kind),
      order.name || "",
      order.phone || "",
      order.email || "",
      order.address || "",
      order.event_date || "",
      order.total || "",
      order.status || "new",
      order.summary || "",
      order.notes || "",
      order.admin_notes || ""
    ].map(csvEscapeField).join(","));
  });

  // Leading BOM so Excel detects UTF-8 — without it, accented or non-Latin
  // names/notes open as mojibake.
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `orders-export-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

registerAdminTab("orders", { btnId: "tabOrdersBtn", panelId: "ordersPanel", onEnter: refreshOrderList });

onAdminInit(() => {
  document.getElementById("ordersFilter").addEventListener("click", (e) => {
    const btn = e.target.closest(".orders-filter-btn");
    if (!btn) return;
    ordersStatusFilter = btn.dataset.status;
    // Scoped to #ordersFilter — the Analytics range buttons share the
    // .orders-filter-btn class and would otherwise lose their highlight.
    document.querySelectorAll("#ordersFilter .orders-filter-btn").forEach((b) => b.classList.toggle("active", b === btn));
    refreshOrderList();
  });
  let orderSearchDebounce = null;
  document.getElementById("orderSearch").addEventListener("input", (e) => {
    clearTimeout(orderSearchDebounce);
    orderSearchDebounce = setTimeout(() => {
      ordersSearchQuery = e.target.value;
      renderOrderList();
    }, 180);
  });
  document.getElementById("orderSort").addEventListener("change", (e) => {
    ordersSortMode = e.target.value;
    renderOrderList();
  });
  document.getElementById("orderUpcomingOnly").addEventListener("change", (e) => {
    ordersUpcomingOnly = e.target.checked;
    renderOrderList();
  });
  document.getElementById("exportOrdersCsvBtn").addEventListener("click", exportOrdersCsv);
  document.getElementById("orderSelectAll").addEventListener("change", (e) => {
    // Only the currently visible (status-filtered) rows, not every order
    // in the table — matches what the checkbox's indeterminate state
    // reflects, same scoping as Products' itemSelectAll handler.
    document.querySelectorAll("#orderList .order-select").forEach((box) => {
      box.checked = e.target.checked;
      if (e.target.checked) selectedOrderIds.add(box.dataset.selectId);
      else selectedOrderIds.delete(box.dataset.selectId);
    });
    syncOrderBulkSelectionUI(ordersVisibleCache);
  });
  document.getElementById("orderBulkContactedBtn").addEventListener("click", () => bulkUpdateOrderStatus("contacted"));
  document.getElementById("orderBulkFulfilledBtn").addEventListener("click", () => bulkUpdateOrderStatus("fulfilled"));
  document.getElementById("orderBulkCancelledBtn").addEventListener("click", () => bulkUpdateOrderStatus("cancelled"));
  document.getElementById("orderBulkDeleteBtn").addEventListener("click", bulkDeleteOrders);
  document.getElementById("orderBulkClearBtn").addEventListener("click", clearOrderSelection);
  document.getElementById("cleanupOrderPhotosBtn").addEventListener("click", handleCleanupOrderPhotos);
});
