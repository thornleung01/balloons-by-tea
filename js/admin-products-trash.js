/* Admin "Trash" tab: products deleted from the Products tab (soft delete —
   products.deleted_at, supabase-migrations/40-products.sql). Restore puts a
   product back exactly as it was; "Delete forever" removes the row.
   Nothing is purged automatically (no cron on this site): products that
   have been in the Trash longer than TRASH_PURGE_DAYS are flagged "will be
   purged" and the owner clears them with "Empty trash" / "Delete old".

   Reads trashedProductsCache, which refreshItemList() in
   js/admin-products.js fills from the same query as the product list. */

ADMIN_ICONS.trash = '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>';

const TRASH_PURGE_DAYS = 30;
const TRASH_DAY_MS = 24 * 60 * 60 * 1000;

function trashAgeDays(row, now) {
  const t = Date.parse(row.deleted_at);
  if (Number.isNaN(t)) return 0;
  return Math.floor(((now || Date.now()) - t) / TRASH_DAY_MS);
}

function trashIsPurgeDue(row, now) {
  return trashAgeDays(row, now) >= TRASH_PURGE_DAYS;
}

function trashSortedRows() {
  return trashedProductsCache.slice().sort((a, b) => Date.parse(b.deleted_at) - Date.parse(a.deleted_at));
}

function updateTrashTabCount() {
  // (badge is created by setTabBadge from the registered badgeId)
  setTabBadge("trash", trashedProductsCache.length);
}

function renderTrashPanel() {
  const panel = document.getElementById("trashPanel");
  if (!panel) return;
  const rows = trashSortedRows();
  const now = Date.now();
  const dueCount = rows.filter((r) => trashIsPurgeDue(r, now)).length;

  if (productExtrasAvailable === false) {
    panel.innerHTML = `
      <h2>Trash</h2>
      <p class="panel-subtitle">The Trash isn't switched on yet, so deleting a product on the Products tab removes it permanently. ${escapeHtml(PRODUCT_MIGRATION_HINT)}</p>`;
    return;
  }

  panel.innerHTML = `
    <div class="orders-head trash-head">
      <h2>Trash</h2>
      <div class="trash-actions">
        <button type="button" class="orders-export-btn" id="trashPurgeOldBtn" ${dueCount ? "" : "disabled"}>Delete items older than ${TRASH_PURGE_DAYS} days${dueCount ? ` (${dueCount})` : ""}</button>
        <button type="button" class="orders-export-btn danger" id="trashEmptyBtn" ${rows.length ? "" : "disabled"}>Empty trash</button>
      </div>
    </div>
    <p class="panel-subtitle">Deleted products wait here and are hidden from the site. Restore puts one back exactly as it was. Anything here longer than ${TRASH_PURGE_DAYS} days is marked "will be purged"; nothing is removed until you press a button. Photos stay in the Library either way.</p>
    <p class="form-status" id="trashStatus" role="status" aria-live="polite"></p>
    <div id="trashList">${rows.length ? rows.map((row) => trashRowMarkup(row, now)).join("") : `<p class="empty-note">The Trash is empty.</p>`}</div>
  `;

  panel.querySelectorAll("[data-trash-restore]").forEach((btn) => btn.addEventListener("click", () => restoreTrashedProducts([btn.dataset.trashRestore], btn)));
  panel.querySelectorAll("[data-trash-delete]").forEach((btn) => btn.addEventListener("click", () => {
    const row = trashedProductsCache.find((r) => String(r.id) === btn.dataset.trashDelete);
    deleteTrashedForever([btn.dataset.trashDelete], row ? `"${row.name}"` : "this item");
  }));
  const purge = document.getElementById("trashPurgeOldBtn");
  if (purge) purge.addEventListener("click", () => {
    const ids = trashedProductsCache.filter((r) => trashIsPurgeDue(r)).map((r) => String(r.id));
    if (ids.length) deleteTrashedForever(ids, `${ids.length} item${ids.length === 1 ? "" : "s"} older than ${TRASH_PURGE_DAYS} days`);
  });
  const empty = document.getElementById("trashEmptyBtn");
  if (empty) empty.addEventListener("click", () => {
    const ids = trashedProductsCache.map((r) => String(r.id));
    if (ids.length) deleteTrashedForever(ids, `all ${ids.length} item${ids.length === 1 ? "" : "s"} in the Trash`);
  });
}

function trashRowMarkup(row, now) {
  const days = trashAgeDays(row, now);
  const due = days >= TRASH_PURGE_DAYS;
  const when = new Date(row.deleted_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const ago = days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  return `
    <div class="admin-item-row trash-row" data-id="${row.id}">
      <div class="admin-item-thumb">${row.image_url ? `<img src="${escapeHtml(row.image_url)}" alt=""/>` : ""}</div>
      <div class="admin-item-body">
        <div class="name">${escapeHtml(row.name)}</div>
        <div class="meta">${escapeHtml(collectionTitle(row.collection))} &middot; ${formatCatalogMoney(Number(row.price) || 0)} &middot; deleted ${escapeHtml(when)} (${ago})</div>
        ${due ? `<div class="product-badges"><span class="product-status-badge is-purge">Will be purged</span></div>` : ""}
      </div>
      <div class="admin-item-actions">
        <button type="button" data-trash-restore="${row.id}">Restore</button>
        <button type="button" class="danger" data-trash-delete="${row.id}">Delete forever</button>
      </div>
    </div>`;
}

function setTrashStatus(message, kind) {
  const el = document.getElementById("trashStatus");
  if (!el) return;
  el.textContent = message || "";
  el.className = "form-status" + (kind ? " " + kind : "");
}

async function restoreTrashedProducts(ids, btn) {
  if (btn) btn.disabled = true;
  const client = getSupabaseClient();
  const { error } = await mustAffect(client.from("products").update({ deleted_at: null }).in("id", ids));
  if (error) {
    if (btn) btn.disabled = false;
    setTrashStatus("Couldn't restore: " + error.message, "error");
    return;
  }
  await refreshItemList();
  setTrashStatus(ids.length === 1 ? "Restored. It's back on the Products tab." : `Restored ${ids.length} items.`, "success");
}

async function deleteTrashedForever(ids, label) {
  if (!confirm(`Permanently delete ${label}? This can't be undone.`)) return;
  const client = getSupabaseClient();
  // In batches, so "Empty trash" on a big Trash stays within URL limits.
  for (let i = 0; i < ids.length; i += 100) {
    const { error } = await mustAffect(client.from("products").delete().in("id", ids.slice(i, i + 100)));
    if (error) {
      await refreshItemList();
      setTrashStatus("Couldn't delete: " + error.message, "error");
      return;
    }
  }
  await refreshItemList();
  setTrashStatus(ids.length === 1 ? "Deleted for good." : `Deleted ${ids.length} items for good.`, "success");
}

/* No tab button in admin.html: the grouped nav is built from the registry. */
registerAdminTab("trash", { panelId: "trashPanel", label: "Trash", group: "catalog", icon: "trash", order: 15, badgeId: "trashBadge", onEnter: renderTrashPanel });

onProductListReloaded(() => {
  updateTrashTabCount();
  renderTrashPanel();
});
