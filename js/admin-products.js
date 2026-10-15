/* Admin "Products" tab: the item list (search/filter/sort, "By Category"
   folders with drag-between-categories), bulk actions, and the add/edit
   item form with its photo gallery. Uses helpers from js/admin-core.js and
   collectionsCache from js/admin-collections.js. */

let currentEditId = null;
/* Each entry is { type: "url", value: string } for an already-uploaded
   photo being kept, or { type: "file", value: File } for a newly chosen
   one not uploaded yet. Order in this array is the order shown on the
   site; entries[0] becomes the card thumbnail (image_url). */
let currentPhotoEntries = [];

function setFormStatus(message, kind) {
  const el = document.getElementById("formStatus");
  el.textContent = message || "";
  el.className = "form-status" + (kind ? " " + kind : "");
}

/* ===== Item list ===== */

let productsCache = [];
let itemSearchQuery = "";
let itemFilterSlug = "all";
let itemSortMode = "collection";
// IDs as strings throughout, matching how every data-id attribute in this
// file is already compared (String(d.id) === btn.dataset.id) — avoids a
// number/string mismatch between Supabase's bigint ids and DOM dataset values.
let selectedProductIds = new Set();
// Which category folders are collapsed in the "By Category" product view.
// Keyed by collection slug (plus the "__uncategorized__" sentinel for the
// catch-all group). Pure client-side UI state — intentionally never synced
// to Supabase, so it resets on reload — but kept in a module-level Set
// (not local to renderProductList) so it survives the re-renders that a
// search keystroke or a drag-drop move triggers.
let collapsedCollectionGroups = new Set();
// Product id currently being dragged between category folders in the "By
// Category" view. Deliberately a separate variable from wireUpRowReorder's
// draggedRowIndex (js/admin-core.js) — that one reorders rows within a single list,
// this one moves a row between different list containers, and the two
// features run over the same page at the same time.
let draggedProductId = null;
// Guards against firing a second recategorize write while one is still in
// flight (e.g. a fast double-drop), mirroring the disable-while-saving
// pattern used elsewhere in this file (handleToggleActive, bulkSetActive).
let isReassigningCollection = false;

/* Products in the Trash (deleted_at set) — shown on the Trash tab
   (js/admin-products-trash.js), never in the main list. */
let trashedProductsCache = [];
/* Whether supabase-migrations/40-products.sql has been run (the products
   rows carry its columns). null = unknown yet (no rows to look at), in
   which case saves try the new columns and fall back if they're missing. */
let productExtrasAvailable = null;

/* Columns added by supabase-migrations/40-products.sql. */
const PRODUCT_EXTRA_COLUMNS = [
  "sku", "sale_price", "stock", "tags", "sort_order", "featured", "variants", "addons",
  "available_from", "available_until", "seo_title", "seo_description", "deleted_at"
];

/* PostgREST PGRST204 ("Could not find the 'sku' column of 'products' in
   the schema cache") on writes, Postgres 42703 (undefined column) on
   filters — i.e. the migration hasn't been run yet. */
function isMissingProductColumnError(error) {
  if (!error) return false;
  if (error.code === "PGRST204" || error.code === "42703") return true;
  return /could not find the '.*' column|column .* does not exist/i.test(error.message || "");
}

function stripProductExtras(payload) {
  const copy = { ...payload };
  PRODUCT_EXTRA_COLUMNS.forEach((key) => { delete copy[key]; });
  return copy;
}

/* Insert (id null) or update one product. If the new columns don't exist
   yet, retries without them so the basics still save; `extrasDropped`
   tells the caller to mention the migration. */
async function saveProductPayload(client, payload, id) {
  const run = (body) => (id
    ? mustAffect(client.from("products").update(body).eq("id", id))
    : client.from("products").insert(body).select());
  let body = productExtrasAvailable === false ? stripProductExtras(payload) : payload;
  let { data, error } = await run(body);
  let extrasDropped = body !== payload;
  if (error && isMissingProductColumnError(error)) {
    productExtrasAvailable = false;
    body = stripProductExtras(payload);
    extrasDropped = true;
    ({ data, error } = await run(body));
  }
  return { data, error, extrasDropped };
}

const PRODUCT_MIGRATION_HINT = "Run supabase-migrations/40-products.sql in Supabase to turn on sale prices, stock, options, scheduling, tags, SEO, manual order and the Trash.";

async function refreshItemList() {
  const client = getSupabaseClient();
  const listEl = document.getElementById("itemList");
  const { data, error } = await client
    .from("products")
    .select("*")
    .order("collection", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) {
    listEl.innerHTML = `<p class="form-status error">Couldn't load items: ${escapeHtml(error.message)}</p>`;
    return;
  }

  const rows = data || [];
  if (rows.length) productExtrasAvailable = "deleted_at" in rows[0];
  productsCache = rows.filter((row) => !row.deleted_at);
  trashedProductsCache = rows.filter((row) => row.deleted_at);
  selectedProductIds.clear();
  populateItemFilterOptions();
  renderProductList();
  productReloadHooks.forEach((fn) => fn());
}

/* Run after every product reload (the Trash tab count, the form's tag
   suggestions and migration notice — js/admin-products-*.js). */
const productReloadHooks = [];
function onProductListReloaded(fn) { productReloadHooks.push(fn); }

/* Status badges for a product row: what a shopper would (not) see. */
function productListBadges(item) {
  const badges = [];
  if (item.active === false) badges.push(["hidden", "Hidden"]);
  const state = productAvailabilityState(item.available_from, item.available_until);
  if (state === "scheduled") badges.push(["scheduled", "Scheduled", `Goes live ${formatAdminDateTime(item.available_from)}`]);
  if (state === "expired") badges.push(["expired", "Expired", `Ended ${formatAdminDateTime(item.available_until)}`]);
  const sale = toNumberOrNull(item.sale_price);
  if (sale !== null && sale < Number(item.price)) badges.push(["sale", "Sale"]);
  if (item.featured) badges.push(["featured", "Featured"]);
  const stock = toNumberOrNull(item.stock);
  if (stock === 0) badges.push(["out", "Out of stock"]);
  else if (stock !== null && stock <= 2) badges.push(["low", `Low stock (${stock})`]);
  return badges;
}

function formatAdminDateTime(value) {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function productListPriceText(item) {
  const fmt = (n) => formatCatalogMoney(n);
  const sale = toNumberOrNull(item.sale_price);
  if (sale !== null && sale < Number(item.price)) return `<s>${fmt(item.price)}</s> ${fmt(sale)}`;
  return fmt(Number(item.price) || 0);
}

/* Manual order within a collection: sort_order, then the original
   (created_at) order. Rows from before the migration all count as 0. */
function sortByManualOrder(items) {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => (Number(a.item.sort_order) || 0) - (Number(b.item.sort_order) || 0) || a.i - b.i)
    .map((x) => x.item);
}

function populateItemFilterOptions() {
  const select = document.getElementById("itemFilter");
  if (!select) return;
  const prev = select.value;
  select.innerHTML = `<option value="all">All Products</option>` +
    collectionsCache.map((c) => `<option value="${escapeHtml(c.slug)}">${escapeHtml(c.title)}</option>`).join("");
  if ([...select.options].some((o) => o.value === prev)) select.value = prev;
}

function renderProductList() {
  const listEl = document.getElementById("itemList");

  if (!productsCache.length) {
    listEl.innerHTML = `<p class="empty-note">No items yet — add your first one on the left.</p>`;
    syncBulkSelectionUI([]);
    return;
  }

  const query = itemSearchQuery.trim().toLowerCase();
  let items = productsCache.filter((item) => {
    if (itemFilterSlug !== "all" && item.collection !== itemFilterSlug) return false;
    if (query && !productMatchesSearch(item, query)) return false;
    return true;
  });

  if (itemSortMode === "alpha") items = items.slice().sort((a, b) => a.name.localeCompare(b.name));
  else if (itemSortMode === "price-asc") items = items.slice().sort((a, b) => a.price - b.price);
  else if (itemSortMode === "price-desc") items = items.slice().sort((a, b) => b.price - a.price);
  else if (itemSortMode === "newest") items = items.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const renderRow = (item) => {
    const viewHref = collectionHrefForAdmin(item.collection);
    const badges = productListBadges(item);
    const offSite = item.active === false || productAvailabilityState(item.available_from, item.available_until) !== "live";
    return `
    <div class="admin-item-row ${offSite ? "inactive" : ""}" data-id="${item.id}">
      <input type="checkbox" class="admin-item-select" data-select-id="${item.id}" aria-label="Select ${escapeHtml(item.name)}" ${selectedProductIds.has(String(item.id)) ? "checked" : ""}/>
      <div class="admin-item-thumb">${item.image_url ? `<img src="${escapeHtml(item.image_url)}" alt=""/>` : ""}${Array.isArray(item.images) && item.images.length > 1 ? `<span class="admin-item-thumb-count">${item.images.length}</span>` : ""}</div>
      <div class="admin-item-body">
        <div class="name">${escapeHtml(item.name)}</div>
        <div class="meta">${productListPriceText(item)}${item.sku ? ` &middot; ${escapeHtml(item.sku)}` : ""}</div>
        ${badges.length ? `<div class="product-badges">${badges.map(([kind, label, title]) => `<span class="product-status-badge is-${kind}"${title ? ` title="${escapeHtml(title)}"` : ""}>${escapeHtml(label)}</span>`).join("")}</div>` : ""}
      </div>
      <div class="admin-item-actions">
        <label class="toggle-switch" title="${item.active === false ? "Hidden, click to show on site" : "Live on site, click to hide"}">
          <input type="checkbox" class="active-toggle" data-id="${item.id}" ${item.active !== false ? "checked" : ""}/>
          <span class="toggle-slider"></span>
        </label>
        <button type="button" class="edit-btn" data-id="${item.id}">Edit</button>
        <button type="button" class="duplicate-btn" data-id="${item.id}">Duplicate</button>
        <button type="button" class="danger delete-btn" data-id="${item.id}">Delete</button>
        ${viewHref ? (item.active === false
          ? `<a class="view-link is-hidden-item" href="${escapeHtml(viewHref)}" target="_blank" rel="noopener" title="This item is hidden, so it won't appear on that page until you switch it on">View (hidden)</a>`
          : `<a class="view-link" href="${escapeHtml(viewHref)}" target="_blank" rel="noopener">View</a>`) : ""}
      </div>
    </div>
  `;
  };

  if (itemSortMode === "collection") {
    const bySlug = {};
    items.forEach((item) => {
      if (!bySlug[item.collection]) bySlug[item.collection] = [];
      bySlug[item.collection].push(item);
    });
    // Each folder in its manual (drag-to-reorder) order.
    Object.keys(bySlug).forEach((slug) => { bySlug[slug] = sortByManualOrder(bySlug[slug]); });
    const knownSlugs = new Set(collectionsCache.map((c) => c.slug));
    const searching = query.length > 0;
    // With the search box empty and no category filter applied, render a
    // folder for every category — even ones with zero items right now —
    // so they stay around as valid drag-drop targets. While actively
    // searching, only show folders that actually matched something, so a
    // long list of empty folders doesn't bury the results. A category
    // filter (itemFilterSlug) already narrows `items` to one slug, so
    // showing the rest as empty folders would just contradict the filter.
    const showEmptyFolders = itemFilterSlug === "all" && !searching;

    const renderGroup = (slug, title, groupItems, isDropTarget) => {
      const collapsed = collapsedCollectionGroups.has(slug);
      return `
        <div class="collection-group" ${isDropTarget ? `data-drop-slug="${escapeHtml(slug)}"` : ""}>
          <button type="button" class="collection-group-toggle" data-group-toggle="${escapeHtml(slug)}" aria-expanded="${collapsed ? "false" : "true"}">
            <svg class="collection-group-chevron ${collapsed ? "is-collapsed" : ""}" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
            <h3>${escapeHtml(title)}</h3>
            <span class="collection-group-count">${groupItems.length}</span>
          </button>
          <div class="collection-group-rows ${collapsed ? "is-collapsed" : ""}">
            ${groupItems.length ? groupItems.map(renderRow).join("") : `<p class="collection-group-empty">No items${isDropTarget ? " — drag one here" : ""}.</p>`}
          </div>
        </div>
      `;
    };

    let groupsHtml = collectionsCache
      .filter((c) => showEmptyFolders || (bySlug[c.slug] && bySlug[c.slug].length))
      .map((c) => renderGroup(c.slug, collectionTitle(c.slug), bySlug[c.slug] || [], true))
      .join("");

    // Safety net: a product whose `collection` doesn't match any known
    // slug (e.g. a category that was since renamed/deleted) would
    // otherwise silently vanish from the list. Not a valid drop target —
    // there's no slug here to assign — just somewhere for it to show up.
    const uncategorizedItems = sortByManualOrder(items.filter((item) => !knownSlugs.has(item.collection)));
    if (uncategorizedItems.length) {
      groupsHtml += renderGroup("__uncategorized__", "Uncategorized", uncategorizedItems, false);
    }

    if (!groupsHtml) {
      listEl.innerHTML = `<p class="empty-note">No items match. Try a different search or category.</p>`;
      syncBulkSelectionUI([]);
      return;
    }

    listEl.innerHTML = `<p class="product-drag-hint">Drag a product onto another one in the same category to change the order shoppers see; drop it on a different category to move it there.</p>` + groupsHtml;
  } else {
    if (!items.length) {
      listEl.innerHTML = `<p class="empty-note">No items match. Try a different search or category.</p>`;
      syncBulkSelectionUI([]);
      return;
    }
    listEl.innerHTML = items.map(renderRow).join("");
  }

  if (itemSortMode === "collection") {
    wireUpCollectionGroupToggles(listEl);
    wireUpCollectionGroupDrag(listEl);
  }

  listEl.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = productsCache.find((d) => String(d.id) === btn.dataset.id);
      if (item) startEdit(item);
    });
  });
  listEl.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleDelete(btn.dataset.id, productsCache));
  });
  listEl.querySelectorAll(".duplicate-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleDuplicateProduct(btn.dataset.id));
  });
  listEl.querySelectorAll(".active-toggle").forEach((toggle) => {
    toggle.addEventListener("change", () => handleToggleActive(toggle.dataset.id, toggle.checked, toggle));
  });
  listEl.querySelectorAll(".admin-item-select").forEach((box) => {
    box.addEventListener("change", () => {
      if (box.checked) selectedProductIds.add(box.dataset.selectId);
      else selectedProductIds.delete(box.dataset.selectId);
      syncBulkSelectionUI(items);
    });
  });
  syncBulkSelectionUI(items);
}

/* Disclosure toggle for each category folder header in the "By Category"
   product view. Collapsed/expanded state is tracked in
   collapsedCollectionGroups so it's still correct next time
   renderProductList() rebuilds the list (search keystroke, filter change,
   a drag-drop move) — but the actual DOM update here is done directly
   (no re-render) so the click feels instant. */
function wireUpCollectionGroupToggles(listEl) {
  listEl.querySelectorAll(".collection-group-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.groupToggle;
      const nowCollapsed = !collapsedCollectionGroups.has(key);
      if (nowCollapsed) collapsedCollectionGroups.add(key);
      else collapsedCollectionGroups.delete(key);

      const group = btn.closest(".collection-group");
      group.querySelector(".collection-group-rows").classList.toggle("is-collapsed", nowCollapsed);
      btn.querySelector(".collection-group-chevron").classList.toggle("is-collapsed", nowCollapsed);
      btn.setAttribute("aria-expanded", String(!nowCollapsed));
    });
  });
}

/* Drag-and-drop re-categorizing in the "By Category" product view: drag a
   product row onto a *different* category's whole folder to move it
   there. This is a different kind of drag than wireUpRowReorder() (js/admin-core.js)
   (which reorders rows within one list in place) — here a row moves
   between separate group containers — so it tracks its own
   draggedProductId instead of reusing wireUpRowReorder's draggedRowIndex.
   Drop targets are the .collection-group containers themselves (not the
   individual rows), and collapsing a folder only hides its
   .collection-group-rows — the group container, with its listeners, stays
   in the DOM — so a collapsed folder keeps accepting drops. */
function wireUpCollectionGroupDrag(listEl) {
  listEl.querySelectorAll(".admin-item-row").forEach((row) => {
    row.setAttribute("draggable", "true");
    row.addEventListener("dragstart", (e) => {
      draggedProductId = row.dataset.id;
      row.classList.add("dragging");
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      draggedProductId = null;
      listEl.querySelectorAll(".drop-before, .drop-after").forEach((el) => el.classList.remove("drop-before", "drop-after"));
    });

    /* Reordering within the same folder: dropping onto another row of the
       SAME category puts the dragged product before/after it (by which
       half of the row the pointer is over). A row in a different
       category falls through to the folder's own "move here" drop. */
    const sameFolder = () => {
      if (draggedProductId === null || draggedProductId === row.dataset.id) return false;
      const dragged = productsCache.find((p) => String(p.id) === String(draggedProductId));
      const target = productsCache.find((p) => String(p.id) === row.dataset.id);
      return !!dragged && !!target && dragged.collection === target.collection;
    };
    const dropAfter = (e) => {
      const rect = row.getBoundingClientRect();
      return e.clientY > rect.top + rect.height / 2;
    };
    row.addEventListener("dragover", (e) => {
      if (!sameFolder()) return;
      e.preventDefault();
      e.stopPropagation();
      const after = dropAfter(e);
      row.classList.toggle("drop-after", after);
      row.classList.toggle("drop-before", !after);
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after"));
    row.addEventListener("drop", (e) => {
      if (!sameFolder()) return;
      e.preventDefault();
      e.stopPropagation();
      row.classList.remove("drop-before", "drop-after");
      const group = row.closest(".collection-group");
      if (group) group.classList.remove("drop-target-active");
      const id = draggedProductId;
      draggedProductId = null;
      reorderProductWithinCollection(id, row.dataset.id, dropAfter(e));
    });
  });

  listEl.querySelectorAll(".collection-group[data-drop-slug]").forEach((group) => {
    group.addEventListener("dragover", (e) => {
      if (draggedProductId === null) return;
      e.preventDefault();
      group.classList.add("drop-target-active");
    });
    group.addEventListener("dragleave", (e) => {
      if (group.contains(e.relatedTarget)) return;
      group.classList.remove("drop-target-active");
    });
    group.addEventListener("drop", (e) => {
      e.preventDefault();
      group.classList.remove("drop-target-active");
      const id = draggedProductId;
      draggedProductId = null;
      if (id === null) return;
      const targetSlug = group.dataset.dropSlug;
      const item = productsCache.find((p) => String(p.id) === String(id));
      // Dropping back onto the folder a product is already in is a no-op
      // — no point writing the same value back to Supabase.
      if (!item || item.collection === targetSlug) return;
      moveProductToCollection(id, targetSlug);
    });
  });
}

/* Writes sort_order 0..n-1 for one collection in its new order (only the
   rows whose number actually changes), then reloads. The public site
   shows featured products first, then this order. */
async function reorderProductWithinCollection(draggedId, targetId, after) {
  if (isReassigningCollection) return;
  const dragged = productsCache.find((p) => String(p.id) === String(draggedId));
  if (!dragged) return;
  if (productExtrasAvailable === false) {
    adminToast("Changing the order needs the latest database update. " + PRODUCT_MIGRATION_HINT, { kind: "error" });
    return;
  }
  if (itemSearchQuery.trim()) {
    adminToast("Clear the search box first, so the whole category is in view while you reorder it.", { kind: "info" });
    return;
  }
  const group = sortByManualOrder(productsCache.filter((p) => p.collection === dragged.collection))
    .filter((p) => String(p.id) !== String(draggedId));
  let index = group.findIndex((p) => String(p.id) === String(targetId));
  if (index === -1) return;
  if (after) index += 1;
  group.splice(index, 0, dragged);

  const changes = group
    .map((p, i) => ({ p, i }))
    .filter(({ p, i }) => (Number(p.sort_order) || 0) !== i || p.sort_order === undefined);
  if (!changes.length) return;
  isReassigningCollection = true;
  const client = getSupabaseClient();
  const results = await Promise.all(changes.map(({ p, i }) =>
    mustAffect(client.from("products").update({ sort_order: i }).eq("id", p.id))));
  isReassigningCollection = false;
  const failed = results.filter((r) => r.error);
  if (failed.length) {
    const err = failed[0].error;
    adminToast(isMissingProductColumnError(err)
      ? "Changing the order needs the latest database update. " + PRODUCT_MIGRATION_HINT
      : `Couldn't save the new order (${failed.length} of ${changes.length} failed): ${err.message}`, { kind: "error" });
  }
  await refreshItemList();
}

async function moveProductToCollection(id, newSlug) {
  if (isReassigningCollection) return;
  isReassigningCollection = true;
  const client = getSupabaseClient();
  const { error } = await mustAffect(client.from("products").update({ collection: newSlug }).eq("id", id));
  isReassigningCollection = false;
  if (error) {
    adminToast("Couldn't move item: " + error.message, { kind: "error" });
    return;
  }
  await refreshItemList();
}

/* Keeps the "select all" checkbox and the bulk action bar in sync with
   selectedProductIds. Takes the currently visible (filtered/sorted) items
   so "select all" only ever covers what's on screen, not the full catalog. */
function syncBulkSelectionUI(visibleItems) {
  const selectAllBox = document.getElementById("itemSelectAll");
  if (selectAllBox) {
    const visibleIds = visibleItems.map((item) => String(item.id));
    const selectedVisibleCount = visibleIds.filter((id) => selectedProductIds.has(id)).length;
    selectAllBox.checked = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
    selectAllBox.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visibleIds.length;
  }

  const bar = document.getElementById("bulkActionBar");
  const count = selectedProductIds.size;
  bar.hidden = count === 0;
  if (count > 0) {
    document.getElementById("bulkSelectedCount").textContent = `${count} selected`;
  }
}

function clearProductSelection() {
  selectedProductIds.clear();
  renderProductList();
}

async function bulkSetActive(active) {
  const ids = [...selectedProductIds];
  if (!ids.length) return;
  const client = getSupabaseClient();
  const bar = document.getElementById("bulkActionBar");
  bar.querySelectorAll("button").forEach((b) => { b.disabled = true; });
  const { error } = await mustAffect(client.from("products").update({ active }).in("id", ids));
  bar.querySelectorAll("button").forEach((b) => { b.disabled = false; });
  if (error) {
    adminToast("Couldn't update: " + error.message, { kind: "error" });
    return;
  }
  selectedProductIds.clear();
  await refreshItemList();
}

/* Search box: name, SKU or tag. */
function productMatchesSearch(item, query) {
  if (String(item.name || "").toLowerCase().includes(query)) return true;
  if (item.sku && String(item.sku).toLowerCase().includes(query)) return true;
  return Array.isArray(item.tags) && item.tags.some((t) => String(t).toLowerCase().includes(query));
}

/* Delete = move to the Trash (deleted_at), restorable from the Trash tab.
   Before supabase-migrations/40-products.sql there's no Trash, so it falls
   back to the old permanent delete, with the old "can't be undone"
   confirmation. Returns true if anything was removed. */
async function deleteOrTrashProducts(ids, label) {
  const client = getSupabaseClient();
  if (productExtrasAvailable !== false) {
    if (!(await adminConfirm({ title: `Move ${label} to the Trash?`, message: "You can restore it from the Trash tab.", confirmLabel: "Move to Trash", danger: true }))) return false;
    const { error } = await mustAffect(client.from("products").update({ deleted_at: new Date().toISOString() }).in("id", ids));
    if (!error) return true;
    if (!isMissingProductColumnError(error)) {
      adminToast("Couldn't delete: " + error.message, { kind: "error" });
      return false;
    }
    productExtrasAvailable = false;
  }
  if (!(await adminConfirm({ title: `Delete ${label}?`, message: `This can't be undone.\n\n(${PRODUCT_MIGRATION_HINT})`, confirmLabel: "Delete permanently", danger: true, requireText: ids.length >= 5 ? "DELETE" : undefined }))) return false;
  const { error } = await mustAffect(client.from("products").delete().in("id", ids));
  if (error) {
    adminToast("Couldn't delete: " + error.message, { kind: "error" });
    return false;
  }
  return true;
}

async function bulkDeleteProducts() {
  const ids = [...selectedProductIds];
  if (!ids.length) return;
  const label = ids.length === 1 ? "this item" : `these ${ids.length} items`;
  const bar = document.getElementById("bulkActionBar");
  bar.querySelectorAll("button").forEach((b) => { b.disabled = true; });
  const removed = await deleteOrTrashProducts(ids, label);
  bar.querySelectorAll("button").forEach((b) => { b.disabled = false; });
  if (!removed) return;
  if (ids.includes(String(currentEditId))) resetForm();
  selectedProductIds.clear();
  await refreshItemList();
}

async function handleToggleActive(id, active, toggleEl) {
  const client = getSupabaseClient();
  toggleEl.disabled = true;
  const { error } = await mustAffect(client.from("products").update({ active }).eq("id", id));
  if (error) {
    adminToast("Couldn't update: " + error.message, { kind: "error" });
    toggleEl.checked = !active;
    toggleEl.disabled = false;
    return;
  }
  await refreshItemList();
}

/* ===== Form (add / edit) ===== */

/* Unsaved-changes tracking for the item form. A snapshot of the form is
   taken whenever it's in a known-clean state (just loaded for editing,
   just reset, just saved); anything different from that snapshot counts
   as unsaved work. Without this, clicking Edit on another item silently
   replaced whatever had been typed. */
let itemFormSnapshot = null;

function itemFormState() {
  const v = (id) => document.getElementById(id).value;
  return JSON.stringify({
    id: currentEditId,
    collection: v("f-collection"), name: v("f-name"), price: v("f-price"),
    description: v("f-description"), style: v("f-style"),
    active: document.getElementById("f-active").checked,
    photos: currentPhotoEntries.map((e) => (e.type === "url" ? e.value : `file:${e.value.name}:${e.value.size}`)),
    // Sale price, stock, options, visibility, tags, SEO (js/admin-products-form.js).
    extras: typeof productExtrasFormState === "function" ? productExtrasFormState() : null
  });
}
function markItemFormClean() { itemFormSnapshot = itemFormState(); }
function itemFormIsDirty() { return itemFormSnapshot !== null && itemFormState() !== itemFormSnapshot; }
/* Resolves true when it's safe to replace the form's contents. */
async function confirmDiscardItemEdits() {
  return !itemFormIsDirty() || adminConfirm({ title: "Discard unsaved changes?", message: "You have unsaved changes to this item. Discard them?", confirmLabel: "Discard changes", danger: true });
}

async function startEdit(item) {
  if (!(await confirmDiscardItemEdits())) return;
  currentEditId = item.id;
  document.getElementById("f-collection").value = item.collection;
  document.getElementById("f-name").value = item.name || "";
  document.getElementById("f-price").value = item.price || 0;
  document.getElementById("f-description").value = item.description || "";
  document.getElementById("f-style").value = item.style || "";
  document.getElementById("f-active").checked = item.active !== false;
  document.getElementById("f-photo").value = "";

  const existingUrls = Array.isArray(item.images) && item.images.length
    ? item.images
    : (item.image_url ? [item.image_url] : []);
  currentPhotoEntries = existingUrls.map((url) => ({ type: "url", value: url }));
  if (typeof loadProductExtrasIntoForm === "function") loadProductExtrasIntoForm(item);
  renderPhotoGallery();

  document.getElementById("formTitle").textContent = "Edit Item";
  document.getElementById("saveBtn").textContent = "Update Item";
  show(document.getElementById("cancelEditBtn"));
  setFormStatus("", null);
  markItemFormClean();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetForm() {
  currentEditId = null;
  currentPhotoEntries = [];
  document.getElementById("itemForm").reset();
  if (typeof loadProductExtrasIntoForm === "function") loadProductExtrasIntoForm(null);
  renderPhotoGallery();
  document.getElementById("formTitle").textContent = "Add Item";
  document.getElementById("saveBtn").textContent = "Add Item";
  hide(document.getElementById("cancelEditBtn"));
  setFormStatus("", null);
  markItemFormClean();
}

function handlePhotoChange(e) {
  const files = Array.from(e.target.files || []);
  files.forEach((file) => currentPhotoEntries.push({ type: "file", value: file }));
  e.target.value = "";
  renderPhotoGallery();
}

function photoEntryPreviewUrl(entry) {
  return entry.type === "url" ? entry.value : URL.createObjectURL(entry.value);
}

function renderPhotoGallery() {
  const gallery = document.getElementById("photoGallery");
  if (!gallery) return;
  gallery.innerHTML = currentPhotoEntries.map((entry, i) => `
    <div class="photo-gallery-item ${i === 0 ? "is-primary" : ""}" data-index="${i}" draggable="true">
      <img src="${photoEntryPreviewUrl(entry)}" alt="" data-preview="${i}"/>
      ${i === 0 ? '<span class="photo-gallery-primary-tag">Thumbnail</span>' : ""}
      <button type="button" class="photo-gallery-move move-left" data-move="-1" data-index="${i}" ${i === 0 ? "disabled" : ""} aria-label="Move photo earlier">&lsaquo;</button>
      <button type="button" class="photo-gallery-move move-right" data-move="1" data-index="${i}" ${i === currentPhotoEntries.length - 1 ? "disabled" : ""} aria-label="Move photo later">&rsaquo;</button>
      <button type="button" class="photo-gallery-remove" data-remove="${i}" aria-label="Remove photo">&times;</button>
    </div>
  `).join("");

  gallery.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      currentPhotoEntries.splice(Number(btn.dataset.remove), 1);
      renderPhotoGallery();
    });
  });
  gallery.querySelectorAll("[data-move]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const i = Number(btn.dataset.index);
      const j = i + Number(btn.dataset.move);
      if (j < 0 || j >= currentPhotoEntries.length) return;
      [currentPhotoEntries[i], currentPhotoEntries[j]] = [currentPhotoEntries[j], currentPhotoEntries[i]];
      renderPhotoGallery();
    });
  });
  gallery.querySelectorAll("[data-preview]").forEach((img) => {
    img.addEventListener("click", () => openPhotoPreview(Number(img.dataset.preview)));
  });

  wireUpRowReorder(gallery, ".photo-gallery-item", currentPhotoEntries, () => renderPhotoGallery());
  if (typeof scheduleProductPreview === "function") scheduleProductPreview();
}

/* Opens the shared lightbox (js/admin-core.js) on the item form's photos. */
function openPhotoPreview(index) {
  previewUrls = currentPhotoEntries.map(photoEntryPreviewUrl);
  previewIndex = index;
  const modal = ensurePhotoPreviewModal();
  renderPhotoPreviewFrame();
  modal.classList.add("open");
}

async function handleSaveItem(e) {
  e.preventDefault();
  const client = getSupabaseClient();
  const saveBtn = document.getElementById("saveBtn");

  const payload = {
    collection: document.getElementById("f-collection").value,
    name: document.getElementById("f-name").value.trim(),
    price: parseFloat(document.getElementById("f-price").value) || 0,
    description: document.getElementById("f-description").value.trim(),
    style: document.getElementById("f-style").value || null,
    active: document.getElementById("f-active").checked
  };

  if (!payload.name) {
    setFormStatus("Item name is required.", "error");
    return;
  }

  // Sale price, stock, options, visibility window, tags, SEO.
  if (typeof collectProductExtrasPayload === "function") {
    const extras = collectProductExtrasPayload(payload);
    if (extras.error) {
      setFormStatus(extras.error, "error");
      return;
    }
    Object.assign(payload, extras.values);
  }
  // A new product goes to the end of its category's manual order.
  if (!currentEditId && productExtrasAvailable !== false) {
    const inCollection = productsCache.filter((p) => p.collection === payload.collection);
    payload.sort_order = inCollection.reduce((max, p) => Math.max(max, Number(p.sort_order) || 0), -1) + 1;
  }

  saveBtn.disabled = true;
  setFormStatus("Saving...", null);

  try {
    const finalUrls = [];
    for (const entry of currentPhotoEntries) {
      if (entry.type === "url") {
        finalUrls.push(entry.value);
      } else {
        const compressed = await compressImageFile(entry.value);
        const safeName = compressed.name.replace(/[^a-zA-Z0-9.-]/g, "_");
        const path = `${Date.now()}-${safeName}`;
        const { error: uploadError } = await client.storage
          .from("product-photos")
          .upload(path, compressed, { upsert: true });
        if (uploadError) throw new Error("Photo upload failed: " + uploadError.message);
        const { data: pub } = client.storage.from("product-photos").getPublicUrl(path);
        finalUrls.push(pub.publicUrl);
      }
    }
    payload.images = finalUrls;
    payload.image_url = finalUrls[0] || null;

    const { error, extrasDropped } = await saveProductPayload(client, payload, currentEditId);
    if (error) throw error;

    let message = currentEditId ? "Item updated." : "Item added.";
    const usedExtras = typeof productExtrasInUse === "function" && productExtrasInUse(payload);
    if (extrasDropped && usedExtras) message += " The new fields (sale price, stock, options, schedule, tags, SEO) weren't saved yet. " + PRODUCT_MIGRATION_HINT;
    resetForm();
    setFormStatus(message, extrasDropped && usedExtras ? "error" : "success");
    await refreshItemList();
  } catch (err) {
    setFormStatus(err.message || "Something went wrong saving this item.", "error");
  } finally {
    saveBtn.disabled = false;
  }
}

async function handleDelete(id, allItems) {
  const item = allItems.find((d) => String(d.id) === String(id));
  const label = item ? `"${item.name}"` : "this item";
  if (!(await deleteOrTrashProducts([id], label))) return;
  if (String(currentEditId) === String(id)) resetForm(); // number (DB) vs string (data-id)
  await refreshItemList();
}

/* Duplicates a product row as a brand-new product (a fresh DB-generated
   id, never the original's). The copy starts inactive (active: false)
   rather than mirroring the original's active state — the admin almost
   certainly wants to tweak the duplicate (name, price, photos) before it
   goes live next to the one it was copied from, not have two identical
   listings visible to shoppers the instant "Duplicate" is clicked. */
async function handleDuplicateProduct(id) {
  const item = productsCache.find((d) => String(d.id) === String(id));
  if (!item) return;
  const client = getSupabaseClient();
  const payload = {
    collection: item.collection,
    name: `${item.name} (Copy)`,
    price: item.price,
    description: item.description,
    style: item.style,
    active: false,
    images: item.images,
    image_url: item.image_url
  };
  // Carry the extras over too (when the migration has been run), except
  // the SKU — a product code should stay unique, so the copy starts
  // without one — and the Trash state. Lands right after the original.
  if ("deleted_at" in item) {
    Object.assign(payload, {
      sale_price: item.sale_price, stock: item.stock, tags: item.tags || [],
      featured: item.featured === true, variants: item.variants || [], addons: item.addons || [],
      available_from: item.available_from, available_until: item.available_until,
      seo_title: item.seo_title, seo_description: item.seo_description,
      sort_order: (Number(item.sort_order) || 0) + 1
    });
  }
  const { error } = await saveProductPayload(client, payload, null);
  if (error) {
    adminToast("Couldn't duplicate: " + error.message, { kind: "error" });
    return;
  }
  await refreshItemList();
}

registerAdminTab("products", {
  btnId: "tabProductsBtn",
  panelId: "productsPanel",
  // onEnter re-renders (not re-fetches) the product list so that
  // switching back here after adding/renaming a category on the
  // Categories tab immediately reflects the current collectionsCache —
  // otherwise the "By Category" view's folders would only pick up a
  // just-added category after a full page reload.
  onEnter: renderProductList
});

registerAdminDirtyCheck(itemFormIsDirty);

onAdminInit(() => {
  document.getElementById("itemForm").addEventListener("submit", handleSaveItem);
  document.getElementById("f-photo").addEventListener("change", handlePhotoChange);
  document.getElementById("cancelEditBtn").addEventListener("click", async () => {
    if (await confirmDiscardItemEdits()) resetForm();
  });
  document.getElementById("openPhotoLibraryBtn").addEventListener("click", openPhotoLibrary);

  let itemSearchDebounce = null;
  document.getElementById("itemSearch").addEventListener("input", (e) => {
    clearTimeout(itemSearchDebounce);
    itemSearchDebounce = setTimeout(() => {
      itemSearchQuery = e.target.value;
      renderProductList();
    }, 180);
  });
  document.getElementById("itemFilter").addEventListener("change", (e) => {
    itemFilterSlug = e.target.value;
    renderProductList();
  });
  document.getElementById("itemSort").addEventListener("change", (e) => {
    itemSortMode = e.target.value;
    renderProductList();
  });
  document.getElementById("itemSelectAll").addEventListener("change", (e) => {
    // Only the currently visible (filtered/sorted) rows, not the whole
    // catalog — matches what the checkbox's indeterminate state reflects.
    document.querySelectorAll("#itemList .admin-item-select").forEach((box) => {
      box.checked = e.target.checked;
      if (e.target.checked) selectedProductIds.add(box.dataset.selectId);
      else selectedProductIds.delete(box.dataset.selectId);
    });
    renderProductList();
  });
  document.getElementById("bulkShowBtn").addEventListener("click", () => bulkSetActive(true));
  document.getElementById("bulkHideBtn").addEventListener("click", () => bulkSetActive(false));
  document.getElementById("bulkDeleteBtn").addEventListener("click", bulkDeleteProducts);
  document.getElementById("bulkClearBtn").addEventListener("click", clearProductSelection);

  wireClickableThumbList("itemList", (id) => {
    const item = productsCache.find((d) => String(d.id) === String(id));
    if (!item) return null;
    const urls = Array.isArray(item.images) && item.images.length ? item.images : (item.image_url ? [item.image_url] : []);
    return { urls, index: 0 };
  });
});
