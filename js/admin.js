/*
  Admin page logic. Talks directly to Supabase from the browser — there's
  no custom backend server. Real security comes from Supabase's Row Level
  Security policies (see supabase-setup.sql): anyone can read products, but
  only a logged-in user can write. This file just has to not trust anything
  the page itself claims — hence escapeHtml() on every field when rendering
  the item list.
*/

let currentEditId = null;
/* Each entry is { type: "url", value: string } for an already-uploaded
   photo being kept, or { type: "file", value: File } for a newly chosen
   one not uploaded yet. Order in this array is the order shown on the
   site; entries[0] becomes the card thumbnail (image_url). */
let currentPhotoEntries = [];

const HTML_ESCAPE_MAP = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
};
function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => HTML_ESCAPE_MAP[c]);
}

/* Row-locking (prevents an accidental drag) is a per-browser UI safety
   net, not business data, so it lives in localStorage rather than a new
   Supabase column — nothing to sync, nothing that breaks if it's empty. */
function lockStorageKey(listName, id) {
  return `admin-row-locked:${listName}:${id}`;
}
function isRowLocked(listName, id) {
  try { return localStorage.getItem(lockStorageKey(listName, id)) === "1"; } catch (e) { return false; }
}
function setRowLocked(listName, id, locked) {
  try {
    if (locked) localStorage.setItem(lockStorageKey(listName, id), "1");
    else localStorage.removeItem(lockStorageKey(listName, id));
  } catch (e) { /* localStorage unavailable (private browsing, etc.) — lock just won't persist */ }
}
function lockHandleMarkup(listName, id) {
  const locked = isRowLocked(listName, id);
  return `<button type="button" class="lock-toggle ${locked ? "is-locked" : ""}" data-lock-list="${listName}" data-lock-id="${id}" title="${locked ? "Locked, click to allow dragging" : "Click to lock in place"}" aria-label="${locked ? "Unlock row" : "Lock row"}">${locked
    ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
    : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>'
  }</button>`;
}
function wireUpLockToggles(listEl, onToggle) {
  listEl.querySelectorAll(".lock-toggle").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const { lockList, lockId } = btn.dataset;
      setRowLocked(lockList, lockId, !isRowLocked(lockList, lockId));
      onToggle();
    });
  });
}

function collectionTitle(slug) {
  const live = collectionsCache.find((c) => c.slug === slug);
  if (live) return live.title;
  return (window.COLLECTIONS && window.COLLECTIONS[slug] && window.COLLECTIONS[slug].title) || slug;
}

/* Admin-relative equivalent of js/site-content.js's collectionHref() —
   that file isn't loaded here, so the slug -> href logic is duplicated.
   admin.html sits at the repo root alongside every public page, so these
   plain relative paths (no leading segment) resolve the same way they do
   from site-content.js. Returns null when the product's collection slug
   doesn't match anything in collectionsCache (e.g. a renamed/deleted
   category) — callers should skip the "View" link in that case rather
   than link somewhere wrong. */
function collectionHrefForAdmin(slug) {
  const c = collectionsCache.find((c) => c.slug === slug);
  if (!c) return null;
  return c.is_legacy ? `${c.slug}.html` : `category.html?slug=${encodeURIComponent(c.slug)}`;
}

function show(el) { el.hidden = false; }
function hide(el) { el.hidden = true; }

function setFormStatus(message, kind) {
  const el = document.getElementById("formStatus");
  el.textContent = message || "";
  el.className = "form-status" + (kind ? " " + kind : "");
}

/* ===== Auth ===== */

async function handleLogin(e) {
  e.preventDefault();
  const client = getSupabaseClient();
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errorEl = document.getElementById("loginError");
  errorEl.textContent = "";

  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    errorEl.textContent = "Couldn't log in — check your email and password.";
    return;
  }
  await enterDashboard();
}

async function handleLogout() {
  const client = getSupabaseClient();
  await client.auth.signOut();
  showLoginView();
}

async function enterDashboard() {
  const client = getSupabaseClient();
  const { data: { session } } = await client.auth.getSession();
  if (!session) {
    showLoginView();
    return;
  }
  const who = document.getElementById("whoAmI");
  who.textContent = session.user.email;
  show(who);
  show(document.getElementById("logoutBtn"));
  hide(document.getElementById("loginView"));
  show(document.getElementById("dashboardView"));
  await loadCollectionsCache();
  await refreshItemList();
  await refreshOrderList();
}

function showLoginView() {
  hide(document.getElementById("dashboardView"));
  hide(document.getElementById("logoutBtn"));
  hide(document.getElementById("whoAmI"));
  show(document.getElementById("loginView"));
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
// draggedRowIndex below — that one reorders rows within a single list,
// this one moves a row between different list containers, and the two
// features run over the same page at the same time.
let draggedProductId = null;
// Guards against firing a second recategorize write while one is still in
// flight (e.g. a fast double-drop), mirroring the disable-while-saving
// pattern used elsewhere in this file (handleToggleActive, bulkSetActive).
let isReassigningCollection = false;

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

  productsCache = data || [];
  selectedProductIds.clear();
  populateItemFilterOptions();
  renderProductList();
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
    if (query && !item.name.toLowerCase().includes(query)) return false;
    return true;
  });

  if (itemSortMode === "alpha") items = items.slice().sort((a, b) => a.name.localeCompare(b.name));
  else if (itemSortMode === "price-asc") items = items.slice().sort((a, b) => a.price - b.price);
  else if (itemSortMode === "price-desc") items = items.slice().sort((a, b) => b.price - a.price);
  else if (itemSortMode === "newest") items = items.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const renderRow = (item) => {
    const viewHref = collectionHrefForAdmin(item.collection);
    return `
    <div class="admin-item-row ${item.active === false ? "inactive" : ""}" data-id="${item.id}">
      <input type="checkbox" class="admin-item-select" data-select-id="${item.id}" aria-label="Select ${escapeHtml(item.name)}" ${selectedProductIds.has(String(item.id)) ? "checked" : ""}/>
      <div class="admin-item-thumb">${item.image_url ? `<img src="${escapeHtml(item.image_url)}" alt=""/>` : ""}${Array.isArray(item.images) && item.images.length > 1 ? `<span class="admin-item-thumb-count">${item.images.length}</span>` : ""}</div>
      <div class="admin-item-body">
        <div class="name">${escapeHtml(item.name)}</div>
        <div class="meta">$${Number(item.price).toFixed(0)} ${item.active === false ? "&middot; hidden" : ""}</div>
      </div>
      <div class="admin-item-actions">
        <label class="toggle-switch" title="${item.active === false ? "Hidden, click to show on site" : "Live on site, click to hide"}">
          <input type="checkbox" class="active-toggle" data-id="${item.id}" ${item.active !== false ? "checked" : ""}/>
          <span class="toggle-slider"></span>
        </label>
        <button type="button" class="edit-btn" data-id="${item.id}">Edit</button>
        <button type="button" class="duplicate-btn" data-id="${item.id}">Duplicate</button>
        <button type="button" class="danger delete-btn" data-id="${item.id}">Delete</button>
        ${viewHref ? `<a class="view-link" href="${escapeHtml(viewHref)}" target="_blank" rel="noopener">View</a>` : ""}
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
    const uncategorizedItems = items.filter((item) => !knownSlugs.has(item.collection));
    if (uncategorizedItems.length) {
      groupsHtml += renderGroup("__uncategorized__", "Uncategorized", uncategorizedItems, false);
    }

    if (!groupsHtml) {
      listEl.innerHTML = `<p class="empty-note">No items match. Try a different search or category.</p>`;
      syncBulkSelectionUI([]);
      return;
    }

    listEl.innerHTML = groupsHtml;
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
   there. This is a different kind of drag than wireUpRowReorder() above
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

async function moveProductToCollection(id, newSlug) {
  if (isReassigningCollection) return;
  isReassigningCollection = true;
  const client = getSupabaseClient();
  const { error } = await client.from("products").update({ collection: newSlug }).eq("id", id);
  isReassigningCollection = false;
  if (error) {
    alert("Couldn't move item: " + error.message);
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
  const { error } = await client.from("products").update({ active }).in("id", ids);
  bar.querySelectorAll("button").forEach((b) => { b.disabled = false; });
  if (error) {
    alert("Couldn't update: " + error.message);
    return;
  }
  selectedProductIds.clear();
  await refreshItemList();
}

async function bulkDeleteProducts() {
  const ids = [...selectedProductIds];
  if (!ids.length) return;
  const label = ids.length === 1 ? "this item" : `these ${ids.length} items`;
  if (!confirm(`Delete ${label}? This can't be undone.`)) return;
  const client = getSupabaseClient();
  const bar = document.getElementById("bulkActionBar");
  bar.querySelectorAll("button").forEach((b) => { b.disabled = true; });
  const { error } = await client.from("products").delete().in("id", ids);
  bar.querySelectorAll("button").forEach((b) => { b.disabled = false; });
  if (error) {
    alert("Couldn't delete: " + error.message);
    return;
  }
  if (ids.includes(String(currentEditId))) resetForm();
  selectedProductIds.clear();
  await refreshItemList();
}

async function handleToggleActive(id, active, toggleEl) {
  const client = getSupabaseClient();
  toggleEl.disabled = true;
  const { error } = await client.from("products").update({ active }).eq("id", id);
  if (error) {
    alert("Couldn't update: " + error.message);
    toggleEl.checked = !active;
    toggleEl.disabled = false;
    return;
  }
  await refreshItemList();
}

/* ===== Form (add / edit) ===== */

function startEdit(item) {
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
  renderPhotoGallery();

  document.getElementById("formTitle").textContent = "Edit Item";
  document.getElementById("saveBtn").textContent = "Update Item";
  show(document.getElementById("cancelEditBtn"));
  setFormStatus("", null);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetForm() {
  currentEditId = null;
  currentPhotoEntries = [];
  document.getElementById("itemForm").reset();
  renderPhotoGallery();
  document.getElementById("formTitle").textContent = "Add Item";
  document.getElementById("saveBtn").textContent = "Add Item";
  hide(document.getElementById("cancelEditBtn"));
  setFormStatus("", null);
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
}

/* ===== Photo preview modal — reuses the public site's lightbox CSS
   classes (loaded via css/styles.css) without needing js/app.js, which
   wires up unrelated cart/checkout/nav behavior admin.html doesn't want. */
let previewUrls = [];
let previewIndex = 0;

function ensurePhotoPreviewModal() {
  let modal = document.getElementById("adminPhotoPreview");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.className = "modal lightbox-modal";
  modal.id = "adminPhotoPreview";
  modal.innerHTML = `
    <div class="modal-scrim" data-close-preview></div>
    <div class="lightbox-panel">
      <button type="button" class="icon-btn lightbox-close" data-close-preview aria-label="Close">&times;</button>
      <div class="lightbox-img-wrap">
        <button type="button" class="carousel-nav lightbox-nav lightbox-prev" aria-label="Previous photo">&lsaquo;</button>
        <img class="lightbox-img" src="" alt=""/>
        <button type="button" class="carousel-nav lightbox-nav lightbox-next" aria-label="Next photo">&rsaquo;</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelectorAll("[data-close-preview]").forEach((el) => el.addEventListener("click", closePhotoPreview));
  modal.querySelector(".lightbox-prev").addEventListener("click", () => stepPhotoPreview(-1));
  modal.querySelector(".lightbox-next").addEventListener("click", () => stepPhotoPreview(1));
  document.addEventListener("keydown", (e) => {
    if (!modal.classList.contains("open")) return;
    if (e.key === "Escape") closePhotoPreview();
    if (e.key === "ArrowLeft") stepPhotoPreview(-1);
    if (e.key === "ArrowRight") stepPhotoPreview(1);
  });
  return modal;
}

function renderPhotoPreviewFrame() {
  const modal = document.getElementById("adminPhotoPreview");
  if (!modal) return;
  modal.querySelector(".lightbox-img").src = previewUrls[previewIndex];
  const multi = previewUrls.length > 1;
  modal.querySelector(".lightbox-prev").hidden = !multi;
  modal.querySelector(".lightbox-next").hidden = !multi;
}

function stepPhotoPreview(delta) {
  if (previewUrls.length < 2) return;
  previewIndex = (previewIndex + delta + previewUrls.length) % previewUrls.length;
  renderPhotoPreviewFrame();
}

function openPhotoPreview(index) {
  previewUrls = currentPhotoEntries.map(photoEntryPreviewUrl);
  previewIndex = index;
  const modal = ensurePhotoPreviewModal();
  renderPhotoPreviewFrame();
  modal.classList.add("open");
}

/* Opens the shared lightbox on an arbitrary set of URLs — nav arrows
   auto-hide via renderPhotoPreviewFrame() whenever there's only one. */
function openImagePreviewSet(urls, index) {
  previewUrls = urls;
  previewIndex = index || 0;
  const modal = ensurePhotoPreviewModal();
  renderPhotoPreviewFrame();
  modal.classList.add("open");
}

/* Single-image preview (hero/logo/category card photo). */
function openImagePreview(url) {
  openImagePreviewSet([url], 0);
}

function closePhotoPreview() {
  const modal = document.getElementById("adminPhotoPreview");
  if (modal) modal.classList.remove("open");
}

/* Wires a static .photo-preview container (its innerHTML is replaced
   on every render, so delegation beats re-binding per-render) to open
   the lightbox when it currently holds an <img>. */
function wireClickablePhotoPreview(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.addEventListener("click", () => {
    const img = container.querySelector("img");
    if (img) openImagePreview(img.src);
  });
}

/* Same idea as wireClickablePhotoPreview(), but for a list container
   (#itemList/#collectionList) whose rows are rebuilt wholesale on every
   render — one delegated listener on the stable container outlives every
   re-render, instead of needing to be rebound per row each time. Each
   row's .admin-item-thumb opens the shared lightbox; getPreviewSet(id)
   resolves that row's own id to {urls, index}. */
function wireClickableThumbList(containerId, getPreviewSet) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.addEventListener("click", (e) => {
    const thumb = e.target.closest(".admin-item-thumb");
    if (!thumb || !thumb.querySelector("img")) return;
    const row = thumb.closest("[data-id]");
    if (!row) return;
    const set = getPreviewSet(row.dataset.id);
    if (set && set.urls.length) openImagePreviewSet(set.urls, set.index || 0);
  });
}

/* ===== Photo library (folder-aware) =====
   Every photo ever uploaded through the item form already lives in the
   "product-photos" Storage bucket indefinitely (nothing deletes the
   underlying file when a product is edited/deleted, only the DB row's
   reference to it) — so the bucket is already a de facto reusable photo
   library. This gives it real browsing: folders (Storage path prefixes —
   there's no separate "create folder" API, so a folder is materialized
   by uploading an empty <folder>/.keep placeholder into it, same trick
   the bucket itself already relies on implicitly) plus two front ends
   that share the same listing/rendering code:
     - a picker MODAL, opened from the item form, for choosing (possibly
       multiple) existing photos to attach to the product being edited
     - a full Library TAB, for browsing/organizing/uploading independent
       of any one product
   Photos picked via the modal become ordinary {type:"url", value:url}
   entries in currentPhotoEntries — the exact same shape startEdit()
   already produces for a product's existing photos — so handleSaveItem()
   needs no changes at all to support them. */

async function listLibraryPath(path) {
  const client = getSupabaseClient();
  const { data, error } = await client.storage
    .from("product-photos")
    .list(path || "", { limit: 500, sortBy: { column: "name", order: "asc" } });
  if (error) return { folders: [], files: [] };
  const folders = [];
  const files = [];
  (data || []).forEach((entry) => {
    if (!entry.name || entry.name === ".keep") return;
    if (entry.id === null) {
      folders.push(entry.name);
    } else {
      const fullPath = path ? `${path}/${entry.name}` : entry.name;
      files.push({ name: entry.name, path: fullPath, url: client.storage.from("product-photos").getPublicUrl(fullPath).data.publicUrl });
    }
  });
  return { folders, files };
}

/* Recursively walks every folder in the bucket — listLibraryPath() only
   sees one level at a time — and flattens the whole tree into one list
   of files, each with its bucket-relative path and public URL. This is
   the full real inventory "Find unused photos" diffs against whatever's
   actually referenced in the database. */
async function walkLibraryTree(path) {
  const { folders, files } = await listLibraryPath(path);
  let all = files.slice();
  for (const folderName of folders) {
    const subPath = path ? `${path}/${folderName}` : folderName;
    const nested = await walkLibraryTree(subPath);
    all = all.concat(nested);
  }
  return all;
}

/* Every place a photo URL can be referenced from the database — checked
   so "Find unused photos" never flags something actually in use:
     - products.image_url and every entry of products.images (the item
       form's photo gallery — see handleSaveItem() below)
     - collections.card_image_url (category card photo)
     - site_settings.value for every row. hero_image_url and logo_url are
       the only keys that actually hold a photo today (see
       loadSettingsIntoForm()/handleSaveSettings() below), but every
       row's value is folded in regardless of key — costs nothing and
       can't produce a false "unused" result.
     - layout_overrides.value for every row. The live visual editor
       (js/layout-editor.js applyLayoutOverrides(), js/edit-mode.js
       RESETTABLE_PROPERTIES) only ever stores one of text/padding-bottom/
       font-size/font-family/text-color/bg-color/order/translate-x/
       translate-y/scale/hidden/locked as a property's value — none of
       those is an image URL, so this table can't actually reference a
       photo today. Queried and folded in anyway, defensively, in case
       that ever changes.
   Note: collection card photos and the settings hero/logo photo are
   actually uploaded to a different bucket entirely ("site-images", see
   uploadSiteImage() below) rather than "product-photos", so in practice
   neither of those two sources will ever match anything in this bucket's
   scan — but their values are still included here since checking them
   costs nothing and guards against any future change in how they're
   stored. */
async function gatherReferencedPhotoUrls() {
  const client = getSupabaseClient();
  const urls = new Set();
  const add = (v) => { if (v && typeof v === "string" && v.trim()) urls.add(v.trim()); };

  const [productsRes, collectionsRes, settingsRes, overridesRes] = await Promise.all([
    client.from("products").select("image_url,images"),
    client.from("collections").select("card_image_url"),
    client.from("site_settings").select("key,value"),
    client.from("layout_overrides").select("value")
  ]);

  const firstError = productsRes.error || collectionsRes.error || settingsRes.error || overridesRes.error;
  if (firstError) throw new Error(firstError.message);

  (productsRes.data || []).forEach((p) => {
    add(p.image_url);
    if (Array.isArray(p.images)) p.images.forEach(add);
  });
  (collectionsRes.data || []).forEach((c) => add(c.card_image_url));
  (settingsRes.data || []).forEach((s) => add(s.value));
  (overridesRes.data || []).forEach((o) => add(o.value));

  return urls;
}

/* Diffs the bucket's real contents against every referenced URL gathered
   above. Matches full public URL to full public URL (not path to URL),
   since that's the exact form stored in every DB column checked — each
   Storage file's URL is built the same way (client.storage.from(...)
   .getPublicUrl(path)) that every save path in this file already uses
   to produce the URLs that end up in the database. A defensive query/
   hash-stripped comparison is also checked, in case a stored URL ever
   picked up a suffix a freshly-built public URL wouldn't have. When in
   doubt a file counts as "referenced" (excluded), never "unused". */
async function findUnusedLibraryPhotos() {
  const allFiles = await walkLibraryTree("");
  const referenced = await gatherReferencedPhotoUrls();
  const stripSuffix = (u) => u.split("?")[0].split("#")[0];
  const referencedStripped = new Set(Array.from(referenced, stripSuffix));
  return allFiles.filter((f) => !referenced.has(f.url) && !referencedStripped.has(stripSuffix(f.url)));
}

function libraryBreadcrumbSegments(path) {
  const segments = [{ label: "Library", path: "" }];
  if (!path) return segments;
  let acc = "";
  path.split("/").filter(Boolean).forEach((part) => {
    acc = acc ? `${acc}/${part}` : part;
    segments.push({ label: part, path: acc });
  });
  return segments;
}

function libraryBreadcrumbHtml(path, navAttr) {
  const segs = libraryBreadcrumbSegments(path);
  return segs.map((seg, i) => `
    <button type="button" class="library-breadcrumb-item" ${navAttr}="${escapeHtml(seg.path)}" ${i === segs.length - 1 ? "disabled" : ""}>${escapeHtml(seg.label)}</button>
  `).join(`<span class="library-breadcrumb-sep">/</span>`);
}

async function deleteLibraryFile(path) {
  const client = getSupabaseClient();
  const { error } = await client.storage.from("product-photos").remove([path]);
  return error ? error.message : null;
}

async function deleteLibraryFolder(path) {
  // No recursive delete — refuse rather than silently nuking contents.
  // The admin can move/delete what's inside first, same as any ordinary
  // file manager would require.
  const { folders, files } = await listLibraryPath(path);
  if (folders.length || files.length) return "That folder isn't empty — move or delete what's inside it first.";
  const client = getSupabaseClient();
  const { error } = await client.storage.from("product-photos").remove([`${path}/.keep`]);
  return error ? error.message : null;
}

async function moveLibraryFile(fromPath, toFolder) {
  const filename = fromPath.split("/").pop();
  const toPath = toFolder ? `${toFolder}/${filename}` : filename;
  if (toPath === fromPath) return null;
  const client = getSupabaseClient();
  const { error } = await client.storage.from("product-photos").move(fromPath, toPath);
  return error ? error.message : null;
}

/* Builds the folders+files markup shared by the Library tab and the item-
   form picker modal. selectedUrls is null outside picker mode (the tab
   has no multi-select — clicking a photo there opens the lightbox). */
function libraryGridHtml(path, entries, selectedUrls) {
  const { folders, files } = entries;
  const upTile = path ? `
    <div class="library-folder-item library-up-item" data-nav-up>
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span>Up one level</span>
    </div>
  ` : "";
  const folderHtml = folders.map((name) => `
    <div class="library-folder-item" data-open-folder="${escapeHtml(name)}">
      <button type="button" class="library-item-delete" data-delete-folder="${escapeHtml(name)}" aria-label="Delete folder ${escapeHtml(name)}">&times;</button>
      <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" stroke-linejoin="round"/></svg>
      <span>${escapeHtml(name)}</span>
    </div>
  `).join("");
  const fileHtml = files.map((f) => `
    <div class="photo-library-item ${selectedUrls && selectedUrls.has(f.url) ? "selected" : ""}" data-url="${escapeHtml(f.url)}" data-path="${escapeHtml(f.path)}" draggable="true">
      <img src="${escapeHtml(f.url)}" alt="${escapeHtml(f.name)}"/>
      <button type="button" class="library-item-delete" data-delete-file="${escapeHtml(f.path)}" aria-label="Delete photo">&times;</button>
    </div>
  `).join("");
  if (!upTile && !folderHtml && !fileHtml) return `<p class="empty-note">Nothing here yet — upload a photo or create a folder.</p>`;
  return upTile + folderHtml + fileHtml;
}

/* Wires click/delete/drag-drop behavior onto a freshly-rendered library
   grid. Drag a photo onto a folder tile (or the "up one level" tile) to
   move it there via Storage's own move() — no re-upload needed. */
function wireLibraryGrid(gridEl, { navigate, onFileClick, afterMutate, getPath }) {
  gridEl.querySelectorAll("[data-open-folder]").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".library-item-delete")) return;
      const base = getPath();
      navigate(base ? `${base}/${el.dataset.openFolder}` : el.dataset.openFolder);
    });
  });
  const upTile = gridEl.querySelector("[data-nav-up]");
  if (upTile) {
    upTile.addEventListener("click", () => {
      const parts = getPath().split("/");
      parts.pop();
      navigate(parts.join("/"));
    });
  }
  gridEl.querySelectorAll(".photo-library-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".library-item-delete")) return;
      onFileClick(el.dataset.url, el.dataset.path);
    });
  });
  gridEl.querySelectorAll("[data-delete-file]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Delete this photo? This can't be undone.")) return;
      const error = await deleteLibraryFile(btn.dataset.deleteFile);
      if (error) { alert("Couldn't delete: " + error); return; }
      afterMutate();
    });
  });
  gridEl.querySelectorAll("[data-delete-folder]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const base = getPath();
      const folderPath = base ? `${base}/${btn.dataset.deleteFolder}` : btn.dataset.deleteFolder;
      if (!confirm(`Delete the "${btn.dataset.deleteFolder}" folder?`)) return;
      const error = await deleteLibraryFolder(folderPath);
      if (error) { alert(error); return; }
      afterMutate();
    });
  });

  gridEl.querySelectorAll(".photo-library-item").forEach((el) => {
    el.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", el.dataset.path);
      e.dataTransfer.effectAllowed = "move";
      el.classList.add("dragging");
    });
    el.addEventListener("dragend", () => el.classList.remove("dragging"));
  });
  gridEl.querySelectorAll("[data-open-folder], [data-nav-up]").forEach((el) => {
    el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("drop-target-active"); });
    el.addEventListener("dragleave", () => el.classList.remove("drop-target-active"));
    el.addEventListener("drop", async (e) => {
      e.preventDefault();
      el.classList.remove("drop-target-active");
      const fromPath = e.dataTransfer.getData("text/plain");
      if (!fromPath) return;
      const base = getPath();
      let toFolder;
      if (el.dataset.openFolder) {
        toFolder = base ? `${base}/${el.dataset.openFolder}` : el.dataset.openFolder;
      } else {
        const parts = base.split("/");
        parts.pop();
        toFolder = parts.join("/");
      }
      const error = await moveLibraryFile(fromPath, toFolder);
      if (error) { alert("Couldn't move: " + error); return; }
      afterMutate();
    });
  });
}

async function createFolderAt(basePath, rawName) {
  const name = String(rawName || "").trim().replace(/[\/\\]+/g, "-").replace(/[^a-zA-Z0-9 _-]/g, "").trim();
  if (!name) return { error: "Enter a folder name." };
  const path = basePath ? `${basePath}/${name}/.keep` : `${name}/.keep`;
  const client = getSupabaseClient();
  const { error } = await client.storage.from("product-photos").upload(path, new Blob([""]), { upsert: false });
  if (error) return { error: /exists/i.test(error.message) ? "A folder with that name already exists here." : error.message };
  return { error: null };
}

async function uploadFilesToLibrary(basePath, files) {
  const client = getSupabaseClient();
  for (const file of files) {
    const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_");
    const path = basePath ? `${basePath}/${Date.now()}-${safeName}` : `${Date.now()}-${safeName}`;
    const { error } = await client.storage.from("product-photos").upload(path, file, { upsert: true });
    if (error) return { error: error.message };
  }
  return { error: null };
}

/* ----- Picker modal (used from the item form) ----- */
let pickerPath = "";
let pickerEntries = { folders: [], files: [] };
let photoLibrarySelected = new Set();

function ensurePhotoLibraryModal() {
  let modal = document.getElementById("photoLibraryModal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.className = "modal";
  modal.id = "photoLibraryModal";
  modal.innerHTML = `
    <div class="modal-scrim" data-close-library></div>
    <div class="modal-panel photo-library-panel">
      <div class="modal-head">
        <div>
          <h2>Choose from library</h2>
          <p>Every photo you've uploaded before. Pick as many as you want to add to this item.</p>
        </div>
        <button type="button" class="icon-btn" data-close-library aria-label="Close">&times;</button>
      </div>
      <div class="modal-body">
        <div class="library-breadcrumb" id="pickerBreadcrumb"></div>
        <div class="library-toolbar">
          <button type="button" class="btn btn-outline btn-sm" id="pickerNewFolderBtn">New folder</button>
          <label class="btn btn-outline btn-sm" for="pickerUploadInput">Upload here</label>
          <input id="pickerUploadInput" type="file" accept="image/*" multiple hidden/>
        </div>
        <div class="photo-library-grid" id="photoLibraryGrid"></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-primary" id="photoLibraryAddBtn" disabled>Add selected</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelectorAll("[data-close-library]").forEach((el) => el.addEventListener("click", closePhotoLibrary));
  modal.querySelector("#photoLibraryAddBtn").addEventListener("click", addSelectedLibraryPhotos);
  modal.querySelector("#pickerNewFolderBtn").addEventListener("click", async () => {
    const name = prompt("New folder name:");
    if (!name) return;
    const { error } = await createFolderAt(pickerPath, name);
    if (error) { alert(error); return; }
    await navigatePickerTo(pickerPath);
  });
  modal.querySelector("#pickerUploadInput").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    const { error } = await uploadFilesToLibrary(pickerPath, files);
    if (error) { alert("Upload failed: " + error); return; }
    await navigatePickerTo(pickerPath);
  });
  modal.querySelector("#pickerBreadcrumb").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-picker-nav]");
    if (btn) navigatePickerTo(btn.dataset.pickerNav);
  });
  return modal;
}

async function navigatePickerTo(path) {
  pickerPath = path || "";
  const grid = document.getElementById("photoLibraryGrid");
  grid.innerHTML = `<p class="empty-note">Loading...</p>`;
  pickerEntries = await listLibraryPath(pickerPath);
  renderPhotoLibraryGrid();
}

function renderPhotoLibraryGrid() {
  const grid = document.getElementById("photoLibraryGrid");
  const breadcrumb = document.getElementById("pickerBreadcrumb");
  if (!grid) return;
  if (breadcrumb) breadcrumb.innerHTML = libraryBreadcrumbHtml(pickerPath, "data-picker-nav");
  grid.innerHTML = libraryGridHtml(pickerPath, pickerEntries, photoLibrarySelected);
  wireLibraryGrid(grid, {
    navigate: navigatePickerTo,
    getPath: () => pickerPath,
    afterMutate: () => navigatePickerTo(pickerPath),
    onFileClick: (url) => {
      if (photoLibrarySelected.has(url)) photoLibrarySelected.delete(url);
      else photoLibrarySelected.add(url);
      renderPhotoLibraryGrid();
    }
  });
  updatePhotoLibraryAddBtn();
}

function updatePhotoLibraryAddBtn() {
  const btn = document.getElementById("photoLibraryAddBtn");
  if (!btn) return;
  const count = photoLibrarySelected.size;
  btn.disabled = count === 0;
  btn.textContent = count > 0 ? `Add selected (${count})` : "Add selected";
}

async function openPhotoLibrary() {
  const modal = ensurePhotoLibraryModal();
  photoLibrarySelected.clear();
  modal.classList.add("open");
  await navigatePickerTo("");
}

function closePhotoLibrary() {
  const modal = document.getElementById("photoLibraryModal");
  if (modal) modal.classList.remove("open");
}

function addSelectedLibraryPhotos() {
  const existingUrls = new Set(currentPhotoEntries.filter((e) => e.type === "url").map((e) => e.value));
  photoLibrarySelected.forEach((url) => {
    if (existingUrls.has(url)) return; // already in this item's gallery, don't duplicate
    currentPhotoEntries.push({ type: "url", value: url });
  });
  renderPhotoGallery();
  closePhotoLibrary();
}

/* ----- Library tab (independent browsing/organizing) ----- */
let libraryTabPath = "";
let libraryTabEntries = { folders: [], files: [] };

async function refreshLibraryPanel() {
  await navigateLibraryTab(libraryTabPath);
}

async function navigateLibraryTab(path) {
  libraryTabPath = path || "";
  const grid = document.getElementById("libraryTabGrid");
  if (!grid) return;
  grid.innerHTML = `<p class="empty-note">Loading...</p>`;
  libraryTabEntries = await listLibraryPath(libraryTabPath);
  renderLibraryTabGrid();
}

function renderLibraryTabGrid() {
  const grid = document.getElementById("libraryTabGrid");
  const breadcrumb = document.getElementById("libraryTabBreadcrumb");
  if (!grid) return;
  if (breadcrumb) breadcrumb.innerHTML = libraryBreadcrumbHtml(libraryTabPath, "data-library-nav");
  grid.innerHTML = libraryGridHtml(libraryTabPath, libraryTabEntries, null);
  wireLibraryGrid(grid, {
    navigate: navigateLibraryTab,
    getPath: () => libraryTabPath,
    afterMutate: () => navigateLibraryTab(libraryTabPath),
    onFileClick: (url) => openImagePreviewSet([url], 0)
  });
}

/* ----- "Find unused photos" review panel -----
   A one-off scan, shown inline below the ordinary Library grid (not a
   modal — this tool is specific to the Library tab, unlike the picker
   modal which is also opened from the item form). Deliberately
   conservative: nothing is ever auto-selected or auto-deleted. The admin
   has to tick individual photos and press "Delete selected" themselves;
   this is a permanent Storage delete with no undo. */
let unusedPhotosCandidates = [];
let unusedPhotosSelected = new Set();

async function openUnusedPhotosSection() {
  const section = document.getElementById("unusedPhotosSection");
  const status = document.getElementById("unusedPhotosStatus");
  const grid = document.getElementById("unusedPhotosGrid");
  const actions = document.getElementById("unusedPhotosActions");
  const triggerBtn = document.getElementById("findUnusedPhotosBtn");
  if (!section || !status || !grid) return;

  section.hidden = false;
  actions.hidden = true;
  grid.innerHTML = "";
  unusedPhotosSelected = new Set();
  status.textContent = "Scanning the whole photo library and checking it against every product, collection, and setting — this can take a moment...";
  if (triggerBtn) triggerBtn.disabled = true;

  try {
    unusedPhotosCandidates = await findUnusedLibraryPhotos();
    renderUnusedPhotosSection();
  } catch (err) {
    status.textContent = "Couldn't finish the scan (" + (err.message || err) + "). Nothing was checked or deleted — try again.";
  } finally {
    if (triggerBtn) triggerBtn.disabled = false;
  }
}

function closeUnusedPhotosSection() {
  const section = document.getElementById("unusedPhotosSection");
  if (section) section.hidden = true;
  unusedPhotosCandidates = [];
  unusedPhotosSelected = new Set();
}

function renderUnusedPhotosSection() {
  const status = document.getElementById("unusedPhotosStatus");
  const grid = document.getElementById("unusedPhotosGrid");
  const actions = document.getElementById("unusedPhotosActions");
  if (!status || !grid || !actions) return;

  const count = unusedPhotosCandidates.length;
  if (!count) {
    status.textContent = "No unused photos found — every file in Storage is referenced by a product, collection, or setting.";
    grid.innerHTML = "";
    actions.hidden = true;
    return;
  }

  status.textContent = `${count} photo${count === 1 ? "" : "s"} appear${count === 1 ? "s" : ""} unused. Nothing is deleted until you select photos below and click "Delete selected" — this can't be undone.`;
  grid.innerHTML = unusedPhotosCandidates.map((f) => `
    <div class="photo-library-item ${unusedPhotosSelected.has(f.url) ? "selected" : ""}" data-url="${escapeHtml(f.url)}" role="checkbox" aria-checked="${unusedPhotosSelected.has(f.url)}" title="${escapeHtml(f.path)}">
      <img src="${escapeHtml(f.url)}" alt="${escapeHtml(f.name)}"/>
    </div>
  `).join("");
  grid.querySelectorAll(".photo-library-item").forEach((el) => {
    el.addEventListener("click", () => {
      const url = el.dataset.url;
      if (unusedPhotosSelected.has(url)) unusedPhotosSelected.delete(url);
      else unusedPhotosSelected.add(url);
      renderUnusedPhotosSection();
    });
  });
  actions.hidden = false;
  updateDeleteUnusedPhotosBtn();
}

function updateDeleteUnusedPhotosBtn() {
  const btn = document.getElementById("deleteUnusedPhotosBtn");
  if (!btn) return;
  const n = unusedPhotosSelected.size;
  btn.disabled = n === 0;
  btn.textContent = n > 0 ? `Delete selected (${n})` : "Delete selected";
}

async function handleDeleteSelectedUnusedPhotos() {
  const toDelete = unusedPhotosCandidates.filter((f) => unusedPhotosSelected.has(f.url));
  if (!toDelete.length) return;
  if (!confirm(`Permanently delete ${toDelete.length} photo${toDelete.length === 1 ? "" : "s"} from Storage? This can't be undone.`)) return;

  const btn = document.getElementById("deleteUnusedPhotosBtn");
  if (btn) btn.disabled = true;

  const failures = [];
  const succeededPaths = new Set();
  for (const f of toDelete) {
    const error = await deleteLibraryFile(f.path);
    if (error) failures.push(`${f.name}: ${error}`);
    else succeededPaths.add(f.path);
  }

  unusedPhotosCandidates = unusedPhotosCandidates.filter((f) => !succeededPaths.has(f.path));
  toDelete.forEach((f) => { if (succeededPaths.has(f.path)) unusedPhotosSelected.delete(f.url); });
  renderUnusedPhotosSection();

  if (failures.length) alert("Some photos couldn't be deleted:\n" + failures.join("\n"));

  // Refresh the main Library grid too — a deleted file may have lived in
  // (or emptied out) the folder currently being browsed there.
  await navigateLibraryTab(libraryTabPath);
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

  saveBtn.disabled = true;
  setFormStatus("Saving...", null);

  try {
    const finalUrls = [];
    for (const entry of currentPhotoEntries) {
      if (entry.type === "url") {
        finalUrls.push(entry.value);
      } else {
        const safeName = entry.value.name.replace(/[^a-zA-Z0-9.-]/g, "_");
        const path = `${Date.now()}-${safeName}`;
        const { error: uploadError } = await client.storage
          .from("product-photos")
          .upload(path, entry.value, { upsert: true });
        if (uploadError) throw new Error("Photo upload failed: " + uploadError.message);
        const { data: pub } = client.storage.from("product-photos").getPublicUrl(path);
        finalUrls.push(pub.publicUrl);
      }
    }
    payload.images = finalUrls;
    payload.image_url = finalUrls[0] || null;

    let error;
    if (currentEditId) {
      ({ error } = await client.from("products").update(payload).eq("id", currentEditId));
    } else {
      ({ error } = await client.from("products").insert(payload));
    }
    if (error) throw error;

    const message = currentEditId ? "Item updated." : "Item added.";
    resetForm();
    setFormStatus(message, "success");
    await refreshItemList();
  } catch (err) {
    setFormStatus(err.message || "Something went wrong saving this item.", "error");
  } finally {
    saveBtn.disabled = false;
  }
}

async function handleDelete(id, allItems) {
  const item = allItems.find((d) => String(d.id) === String(id));
  const label = item ? item.name : "this item";
  if (!confirm(`Delete "${label}"? This can't be undone.`)) return;
  const client = getSupabaseClient();
  const { error } = await client.from("products").delete().eq("id", id);
  if (error) {
    alert("Couldn't delete: " + error.message);
    return;
  }
  if (currentEditId === id) resetForm();
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
  const { error } = await client.from("products").insert(payload);
  if (error) {
    alert("Couldn't duplicate: " + error.message);
    return;
  }
  await refreshItemList();
}

/* ===== Tabs ===== */

const TABS = {
  // onEnter re-renders (not re-fetches) the product list so that
  // switching back here after adding/renaming a category on the
  // Categories tab immediately reflects the current collectionsCache —
  // otherwise the "By Category" view's folders would only pick up a
  // just-added category after a full page reload.
  products: { btnId: "tabProductsBtn", panelId: "productsPanel", onEnter: renderProductList },
  orders: { btnId: "tabOrdersBtn", panelId: "ordersPanel", onEnter: refreshOrderList },
  analytics: { btnId: "tabAnalyticsBtn", panelId: "analyticsPanel", onEnter: refreshAnalyticsPanel },
  collections: { btnId: "tabCollectionsBtn", panelId: "collectionsPanel", onEnter: refreshCollectionList },
  library: { btnId: "tabLibraryBtn", panelId: "libraryPanel", onEnter: refreshLibraryPanel },
  nav: { btnId: "tabNavBtn", panelId: "navPanel", onEnter: refreshNavList },
  faq: { btnId: "tabFaqBtn", panelId: "faqPanel", onEnter: refreshFaqList },
  settings: { btnId: "tabSettingsBtn", panelId: "settingsPanel", onEnter: loadSettingsIntoForm }
};

function switchTab(tab) {
  Object.keys(TABS).forEach((key) => {
    const { btnId, panelId } = TABS[key];
    const active = key === tab;
    document.getElementById(btnId).classList.toggle("active", active);
    document.getElementById(btnId).setAttribute("aria-selected", String(active));
    document.getElementById(panelId).hidden = !active;
  });
  const entry = TABS[tab];
  if (entry && entry.onEnter) entry.onEnter();
}

/* ===== Collections ===== */

let collectionsCache = [];
let currentCollectionEditId = null;
let currentCollectionPhotoFile = null;

function slugify(text) {
  return String(text).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "category";
}

async function loadCollectionsCache() {
  const client = getSupabaseClient();
  const { data, error } = await client.from("collections").select("*").order("sort_order", { ascending: true });
  if (error) return;
  collectionsCache = data || [];
  const select = document.getElementById("f-collection");
  if (select) {
    const prev = select.value;
    select.innerHTML = collectionsCache.map((c) => `<option value="${escapeHtml(c.slug)}">${escapeHtml(c.title)}</option>`).join("");
    if ([...select.options].some((o) => o.value === prev)) select.value = prev;
  }
}

async function refreshCollectionList() {
  await loadCollectionsCache();
  const listEl = document.getElementById("collectionList");

  if (!collectionsCache.length) {
    listEl.innerHTML = `<p class="empty-note">No categories yet.</p>`;
    return;
  }

  const client = getSupabaseClient();
  const { data: productRows } = await client.from("products").select("collection");
  const usedSlugs = new Set((productRows || []).map((p) => p.collection));

  listEl.innerHTML = collectionsCache.map((c, i) => `
    <div class="admin-item-row draggable-row" data-id="${c.id}" data-index="${i}" draggable="${!isRowLocked("collections", c.id)}">
      ${lockHandleMarkup("collections", c.id)}
      <span class="drag-handle" aria-hidden="true" title="Drag to reorder">&#8942;&#8942;</span>
      <div class="admin-item-thumb">${c.card_image_url ? `<img src="${escapeHtml(c.card_image_url)}" alt=""/>` : ""}</div>
      <div class="admin-item-body">
        <div class="name">${escapeHtml(c.title)} ${c.is_legacy ? '<span class="form-status" style="display:inline;">(built-in)</span>' : ""}</div>
        <div class="meta">${escapeHtml(c.tagline || "")}</div>
      </div>
      <div class="admin-item-actions">
        <button type="button" class="edit-btn" data-id="${c.id}">Edit</button>
        ${c.is_legacy ? "" : `<button type="button" class="danger delete-btn" data-id="${c.id}">Delete</button>`}
      </div>
    </div>
  `).join("");

  listEl.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = collectionsCache.find((c) => String(c.id) === btn.dataset.id);
      if (row) startCollectionEdit(row);
    });
  });
  listEl.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleDeleteCollection(btn.dataset.id, usedSlugs));
  });
  wireUpRowReorder(listEl, ".draggable-row", collectionsCache, persistCollectionOrder);
  wireUpLockToggles(listEl, refreshCollectionList);
}

/* Shared native-HTML5-drag reordering for a list of .draggable-row
   elements. `cache` is the array backing the rendered rows (mutated in
   place to match the new order); `onDrop` persists the new order and
   should itself trigger a re-render when it resolves. */
let draggedRowIndex = null;

function wireUpRowReorder(listEl, selector, cache, onDrop) {
  listEl.querySelectorAll(selector).forEach((row) => {
    row.addEventListener("dragstart", () => {
      draggedRowIndex = Number(row.dataset.index);
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      draggedRowIndex = null;
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("drag-over");
      const targetIndex = Number(row.dataset.index);
      if (draggedRowIndex === null || draggedRowIndex === targetIndex) return;
      const [moved] = cache.splice(draggedRowIndex, 1);
      cache.splice(targetIndex, 0, moved);
      onDrop(cache);
    });
  });
}

async function persistCollectionOrder(cache) {
  const client = getSupabaseClient();
  await Promise.all(cache.map((c, i) => client.from("collections").update({ sort_order: i }).eq("id", c.id)));
  await refreshCollectionList();
}

function startCollectionEdit(row) {
  currentCollectionEditId = row.id;
  currentCollectionPhotoFile = null;
  document.getElementById("c-title").value = row.title || "";
  document.getElementById("c-tagline").value = row.tagline || "";
  document.getElementById("c-sort").value = row.sort_order || 0;
  document.getElementById("c-photo").value = "";
  document.getElementById("collectionPhotoPreview").innerHTML = row.card_image_url ? `<img src="${escapeHtml(row.card_image_url)}" alt=""/>` : "No photo";
  document.getElementById("collectionFormTitle").textContent = "Edit Category";
  document.getElementById("saveCollectionBtn").textContent = "Update Category";
  show(document.getElementById("cancelCollectionEditBtn"));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetCollectionForm() {
  currentCollectionEditId = null;
  currentCollectionPhotoFile = null;
  document.getElementById("collectionForm").reset();
  document.getElementById("collectionPhotoPreview").innerHTML = "No photo";
  document.getElementById("collectionFormTitle").textContent = "Add Category";
  document.getElementById("saveCollectionBtn").textContent = "Add Category";
  hide(document.getElementById("cancelCollectionEditBtn"));
  document.getElementById("collectionFormStatus").textContent = "";
}

function handleCollectionPhotoChange(e) {
  const file = e.target.files[0];
  currentCollectionPhotoFile = file || null;
  const preview = document.getElementById("collectionPhotoPreview");
  if (!file) { preview.innerHTML = "No photo"; return; }
  const reader = new FileReader();
  reader.onload = () => { preview.innerHTML = `<img src="${reader.result}" alt=""/>`; };
  reader.readAsDataURL(file);
}

async function uploadSiteImage(client, file) {
  const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_");
  const path = `${Date.now()}-${safeName}`;
  const { error } = await client.storage.from("site-images").upload(path, file, { upsert: true });
  if (error) throw new Error("Image upload failed: " + error.message);
  const { data: pub } = client.storage.from("site-images").getPublicUrl(path);
  return pub.publicUrl;
}

async function handleSaveCollection(e) {
  e.preventDefault();
  const client = getSupabaseClient();
  const saveBtn = document.getElementById("saveCollectionBtn");
  const statusEl = document.getElementById("collectionFormStatus");

  const title = document.getElementById("c-title").value.trim();
  if (!title) { statusEl.textContent = "Title is required."; statusEl.className = "form-status error"; return; }

  const payload = {
    title,
    tagline: document.getElementById("c-tagline").value.trim(),
    sort_order: Math.max(0, parseInt(document.getElementById("c-sort").value, 10) || 0)
  };

  saveBtn.disabled = true;
  statusEl.textContent = "Saving...";
  statusEl.className = "form-status";

  try {
    if (currentCollectionPhotoFile) {
      payload.card_image_url = await uploadSiteImage(client, currentCollectionPhotoFile);
    }

    let error;
    if (currentCollectionEditId) {
      ({ error } = await client.from("collections").update(payload).eq("id", currentCollectionEditId));
    } else {
      payload.slug = slugify(title);
      payload.is_legacy = false;
      ({ error } = await client.from("collections").insert(payload));
    }
    if (error) throw error;

    const message = currentCollectionEditId ? "Category updated." : "Category added.";
    resetCollectionForm();
    statusEl.textContent = message;
    statusEl.className = "form-status success";
    await refreshCollectionList();
  } catch (err) {
    statusEl.textContent = err.message || "Something went wrong saving this category.";
    statusEl.className = "form-status error";
  } finally {
    saveBtn.disabled = false;
  }
}

async function handleDeleteCollection(id, usedSlugs) {
  const row = collectionsCache.find((c) => String(c.id) === String(id));
  if (!row) return;
  if (usedSlugs.has(row.slug)) {
    alert(`Can't delete "${row.title}" — it still has products assigned to it. Move or delete those products first.`);
    return;
  }
  if (!confirm(`Delete "${row.title}"? This can't be undone.`)) return;
  const client = getSupabaseClient();
  const { error } = await client.from("collections").delete().eq("id", id);
  if (error) { alert("Couldn't delete: " + error.message); return; }
  if (currentCollectionEditId === id) resetCollectionForm();
  await refreshCollectionList();
}

/* ===== Nav items ===== */

let navCache = [];
let currentNavEditId = null;

async function refreshNavList() {
  const client = getSupabaseClient();
  const { data, error } = await client.from("nav_items").select("*").order("sort_order", { ascending: true });
  const listEl = document.getElementById("navList");
  if (error) {
    listEl.innerHTML = `<p class="form-status error">Couldn't load nav items: ${escapeHtml(error.message)}</p>`;
    return;
  }
  navCache = data || [];
  if (!navCache.length) {
    listEl.innerHTML = `<p class="empty-note">No nav items yet.</p>`;
    return;
  }

  listEl.innerHTML = navCache.map((n, i) => `
    <div class="admin-item-row draggable-row ${n.visible === false ? "inactive" : ""}" data-id="${n.id}" data-index="${i}" draggable="${!isRowLocked("nav", n.id)}">
      ${lockHandleMarkup("nav", n.id)}
      <span class="drag-handle" aria-hidden="true" title="Drag to reorder">&#8942;&#8942;</span>
      <div class="admin-item-body">
        <div class="name">${escapeHtml(n.label)} ${n.key ? '<span class="form-status" style="display:inline;">(built-in)</span>' : ""}</div>
        <div class="meta">${escapeHtml(n.href)} ${n.visible === false ? "&middot; hidden" : ""}</div>
      </div>
      <div class="admin-item-actions">
        <label class="toggle-switch" title="${n.visible === false ? "Hidden, click to show in nav" : "Showing in nav, click to hide"}">
          <input type="checkbox" class="nav-visible-toggle" data-id="${n.id}" ${n.visible !== false ? "checked" : ""}/>
          <span class="toggle-slider"></span>
        </label>
        <button type="button" class="edit-btn" data-id="${n.id}">Edit</button>
        ${n.key ? "" : `<button type="button" class="danger delete-btn" data-id="${n.id}">Delete</button>`}
      </div>
    </div>
  `).join("");

  listEl.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = navCache.find((n) => String(n.id) === btn.dataset.id);
      if (row) startNavEdit(row);
    });
  });
  listEl.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleDeleteNav(btn.dataset.id));
  });
  listEl.querySelectorAll(".nav-visible-toggle").forEach((toggle) => {
    toggle.addEventListener("change", () => handleToggleNavVisible(toggle.dataset.id, toggle.checked, toggle));
  });
  wireUpRowReorder(listEl, ".draggable-row", navCache, persistNavOrder);
  wireUpLockToggles(listEl, refreshNavList);
}

async function handleToggleNavVisible(id, visible, toggleEl) {
  const client = getSupabaseClient();
  toggleEl.disabled = true;
  const { error } = await client.from("nav_items").update({ visible }).eq("id", id);
  if (error) {
    alert("Couldn't update: " + error.message);
    toggleEl.checked = !visible;
    toggleEl.disabled = false;
    return;
  }
  await refreshNavList();
}

async function persistNavOrder(cache) {
  const client = getSupabaseClient();
  await Promise.all(cache.map((n, i) => client.from("nav_items").update({ sort_order: i }).eq("id", n.id)));
  await refreshNavList();
}

function startNavEdit(row) {
  currentNavEditId = row.id;
  document.getElementById("n-label").value = row.label || "";
  document.getElementById("n-href").value = row.href || "";
  document.getElementById("n-icon").value = row.icon || "none";
  document.getElementById("n-sort").value = row.sort_order || 0;
  document.getElementById("n-visible").checked = row.visible !== false;
  document.getElementById("navFormTitle").textContent = "Edit Nav Item";
  document.getElementById("saveNavBtn").textContent = "Update Nav Item";
  show(document.getElementById("cancelNavEditBtn"));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetNavForm() {
  currentNavEditId = null;
  document.getElementById("navForm").reset();
  document.getElementById("navFormTitle").textContent = "Add Nav Item";
  document.getElementById("saveNavBtn").textContent = "Add Nav Item";
  hide(document.getElementById("cancelNavEditBtn"));
  document.getElementById("navFormStatus").textContent = "";
}

async function handleSaveNav(e) {
  e.preventDefault();
  const client = getSupabaseClient();
  const saveBtn = document.getElementById("saveNavBtn");
  const statusEl = document.getElementById("navFormStatus");

  const label = document.getElementById("n-label").value.trim();
  const href = document.getElementById("n-href").value.trim();
  if (!label || !href) { statusEl.textContent = "Label and link are both required."; statusEl.className = "form-status error"; return; }

  const payload = {
    label,
    href,
    icon: document.getElementById("n-icon").value,
    sort_order: Math.max(0, parseInt(document.getElementById("n-sort").value, 10) || 0),
    visible: document.getElementById("n-visible").checked
  };

  saveBtn.disabled = true;
  statusEl.textContent = "Saving...";
  statusEl.className = "form-status";

  try {
    let error;
    if (currentNavEditId) {
      ({ error } = await client.from("nav_items").update(payload).eq("id", currentNavEditId));
    } else {
      ({ error } = await client.from("nav_items").insert(payload));
    }
    if (error) throw error;

    const message = currentNavEditId ? "Nav item updated." : "Nav item added.";
    resetNavForm();
    statusEl.textContent = message;
    statusEl.className = "form-status success";
    await refreshNavList();
  } catch (err) {
    statusEl.textContent = err.message || "Something went wrong saving this nav item.";
    statusEl.className = "form-status error";
  } finally {
    saveBtn.disabled = false;
  }
}

async function handleDeleteNav(id) {
  const row = navCache.find((n) => String(n.id) === String(id));
  if (!row || row.key) return;
  if (!confirm(`Delete "${row.label}"? This can't be undone.`)) return;
  const client = getSupabaseClient();
  const { error } = await client.from("nav_items").delete().eq("id", id);
  if (error) { alert("Couldn't delete: " + error.message); return; }
  if (currentNavEditId === id) resetNavForm();
  await refreshNavList();
}

/* ===== FAQ items ===== */

let faqCache = [];
let currentFaqEditId = null;

async function refreshFaqList() {
  const client = getSupabaseClient();
  const { data, error } = await client.from("faq_items").select("*").order("sort_order", { ascending: true });
  const listEl = document.getElementById("faqList");
  if (error) {
    listEl.innerHTML = `<p class="form-status error">Couldn't load FAQ items: ${escapeHtml(error.message)}</p>`;
    return;
  }
  faqCache = data || [];
  if (!faqCache.length) {
    listEl.innerHTML = `<p class="empty-note">No FAQ items yet.</p>`;
    return;
  }

  listEl.innerHTML = faqCache.map((f, i) => `
    <div class="admin-item-row draggable-row" data-id="${f.id}" data-index="${i}" draggable="${!isRowLocked("faq", f.id)}">
      ${lockHandleMarkup("faq", f.id)}
      <span class="drag-handle" aria-hidden="true" title="Drag to reorder">&#8942;&#8942;</span>
      <div class="admin-item-body">
        <div class="name">${escapeHtml(f.question)} ${f.is_open_default ? '<span class="form-status" style="display:inline;">(open by default)</span>' : ""}</div>
      </div>
      <div class="admin-item-actions">
        <button type="button" class="edit-btn" data-id="${f.id}">Edit</button>
        <button type="button" class="danger delete-btn" data-id="${f.id}">Delete</button>
      </div>
    </div>
  `).join("");

  listEl.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = faqCache.find((f) => String(f.id) === btn.dataset.id);
      if (row) startFaqEdit(row);
    });
  });
  listEl.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleDeleteFaq(btn.dataset.id));
  });
  wireUpRowReorder(listEl, ".draggable-row", faqCache, persistFaqOrder);
  wireUpLockToggles(listEl, refreshFaqList);
}

async function persistFaqOrder(cache) {
  const client = getSupabaseClient();
  await Promise.all(cache.map((f, i) => client.from("faq_items").update({ sort_order: i }).eq("id", f.id)));
  await refreshFaqList();
}

function startFaqEdit(row) {
  currentFaqEditId = row.id;
  document.getElementById("fq-question").value = row.question || "";
  document.getElementById("fq-answer").value = row.answer || "";
  document.getElementById("fq-sort").value = row.sort_order || 0;
  document.getElementById("fq-open").checked = !!row.is_open_default;
  document.getElementById("faqFormTitle").textContent = "Edit FAQ Item";
  document.getElementById("saveFaqBtn").textContent = "Update FAQ Item";
  show(document.getElementById("cancelFaqEditBtn"));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetFaqForm() {
  currentFaqEditId = null;
  document.getElementById("faqForm").reset();
  document.getElementById("faqFormTitle").textContent = "Add FAQ Item";
  document.getElementById("saveFaqBtn").textContent = "Add FAQ Item";
  hide(document.getElementById("cancelFaqEditBtn"));
  document.getElementById("faqFormStatus").textContent = "";
}

async function handleSaveFaq(e) {
  e.preventDefault();
  const client = getSupabaseClient();
  const saveBtn = document.getElementById("saveFaqBtn");
  const statusEl = document.getElementById("faqFormStatus");

  const question = document.getElementById("fq-question").value.trim();
  const answer = document.getElementById("fq-answer").value.trim();
  if (!question || !answer) { statusEl.textContent = "Question and answer are both required."; statusEl.className = "form-status error"; return; }

  const payload = {
    question,
    answer,
    sort_order: Math.max(0, parseInt(document.getElementById("fq-sort").value, 10) || 0),
    is_open_default: document.getElementById("fq-open").checked
  };

  saveBtn.disabled = true;
  statusEl.textContent = "Saving...";
  statusEl.className = "form-status";

  try {
    let error;
    if (currentFaqEditId) {
      ({ error } = await client.from("faq_items").update(payload).eq("id", currentFaqEditId));
    } else {
      ({ error } = await client.from("faq_items").insert(payload));
    }
    if (error) throw error;

    const message = currentFaqEditId ? "FAQ item updated." : "FAQ item added.";
    resetFaqForm();
    statusEl.textContent = message;
    statusEl.className = "form-status success";
    await refreshFaqList();
  } catch (err) {
    statusEl.textContent = err.message || "Something went wrong saving this FAQ item.";
    statusEl.className = "form-status error";
  } finally {
    saveBtn.disabled = false;
  }
}

async function handleDeleteFaq(id) {
  if (!confirm("Delete this FAQ item? This can't be undone.")) return;
  const client = getSupabaseClient();
  const { error } = await client.from("faq_items").delete().eq("id", id);
  if (error) { alert("Couldn't delete: " + error.message); return; }
  if (currentFaqEditId === id) resetFaqForm();
  await refreshFaqList();
}

/* ===== Settings ===== */

let currentHeroPhotoFile = null;
let currentLogoPhotoFile = null;
const SETTINGS_KEYS = [
  "hero_heading", "hero_subtext", "hero_cta_text",
  "contact_phone", "contact_email", "contact_whatsapp",
  "social_instagram", "social_rednote", "social_tiktok", "social_youtube",
  "about_intro_1", "about_intro_2",
  "about_highlight_1_heading", "about_highlight_1_body",
  "about_highlight_2_heading", "about_highlight_2_body",
  "about_highlight_3_heading", "about_highlight_3_body",
  "theme_coral", "theme_blush", "theme_baby_blue", "theme_soft_yellow", "theme_brown"
];

async function loadSettingsIntoForm() {
  const client = getSupabaseClient();
  const { data, error } = await client.from("site_settings").select("*");
  const statusEl = document.getElementById("settingsFormStatus");
  if (error) {
    statusEl.textContent = "Couldn't load settings: " + error.message;
    statusEl.className = "form-status error";
    return;
  }
  const map = {};
  (data || []).forEach((row) => { map[row.key] = row.value; });

  SETTINGS_KEYS.forEach((key) => {
    const input = document.getElementById(`s-${key}`);
    if (input && map[key] != null) input.value = map[key];
  });

  document.getElementById("heroPhotoPreview").innerHTML = map.hero_image_url ? `<img src="${escapeHtml(map.hero_image_url)}" alt=""/>` : "No photo";
  document.getElementById("logoPhotoPreview").innerHTML = map.logo_url ? `<img src="${escapeHtml(map.logo_url)}" alt=""/>` : "No photo";
  currentHeroPhotoFile = null;
  currentLogoPhotoFile = null;
  statusEl.textContent = "";
}

function handleHeroPhotoChange(e) {
  const file = e.target.files[0];
  currentHeroPhotoFile = file || null;
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { document.getElementById("heroPhotoPreview").innerHTML = `<img src="${reader.result}" alt=""/>`; };
  reader.readAsDataURL(file);
}

function handleLogoPhotoChange(e) {
  const file = e.target.files[0];
  currentLogoPhotoFile = file || null;
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { document.getElementById("logoPhotoPreview").innerHTML = `<img src="${reader.result}" alt=""/>`; };
  reader.readAsDataURL(file);
}

async function handleSaveSettings(e) {
  e.preventDefault();
  const client = getSupabaseClient();
  const saveBtn = document.getElementById("saveSettingsBtn");
  const statusEl = document.getElementById("settingsFormStatus");

  saveBtn.disabled = true;
  statusEl.textContent = "Saving...";
  statusEl.className = "form-status";

  try {
    const rows = SETTINGS_KEYS.map((key) => ({
      key,
      value: document.getElementById(`s-${key}`).value
    }));

    if (currentHeroPhotoFile) {
      rows.push({ key: "hero_image_url", value: await uploadSiteImage(client, currentHeroPhotoFile) });
    }
    if (currentLogoPhotoFile) {
      rows.push({ key: "logo_url", value: await uploadSiteImage(client, currentLogoPhotoFile) });
    }

    const { error } = await client.from("site_settings").upsert(rows, { onConflict: "key" });
    if (error) throw error;

    currentHeroPhotoFile = null;
    currentLogoPhotoFile = null;
    statusEl.textContent = "Settings saved.";
    statusEl.className = "form-status success";
  } catch (err) {
    statusEl.textContent = err.message || "Something went wrong saving settings.";
    statusEl.className = "form-status error";
  } finally {
    saveBtn.disabled = false;
  }
}

/* ===== Orders ===== */

let ordersStatusFilter = "all";
const ORDER_STATUSES = ["new", "contacted", "fulfilled"];
// Separate from selectedProductIds (Products tab) so the two bulk-selection
// features never collide — each tab's checkboxes/bulk bar only ever touch
// their own Set. IDs as strings, matching every other data-id comparison
// in this file.
let selectedOrderIds = new Set();
// The most recently rendered (status-filtered) order list, kept so
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

async function refreshOrderList() {
  const client = getSupabaseClient();
  const listEl = document.getElementById("orderList");
  const { data, error } = await client
    .from("orders")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    listEl.innerHTML = `<p class="form-status error">Couldn't load orders: ${escapeHtml(error.message)}</p>`;
    return;
  }

  const badge = document.getElementById("ordersBadge");
  const newCount = (data || []).filter((o) => (o.status || "new") === "new").length;
  if (newCount > 0) {
    badge.textContent = String(newCount);
    show(badge);
  } else {
    hide(badge);
  }

  // Drop any selected ids that no longer exist at all (e.g. deleted by
  // another admin tab/session) so stale ids don't silently pile up in the
  // Set. Checked against the full fetch, not the status-filtered list, so
  // a selection made under one filter is still intact after switching to
  // another filter and back — selection is deliberately NOT cleared just
  // because refreshOrderList() re-ran (it re-runs on every filter click).
  const allIds = new Set((data || []).map((o) => String(o.id)));
  [...selectedOrderIds].forEach((id) => { if (!allIds.has(id)) selectedOrderIds.delete(id); });

  const filtered = (data || []).filter((o) => ordersStatusFilter === "all" || (o.status || "new") === ordersStatusFilter);
  ordersVisibleCache = filtered;

  if (!filtered.length) {
    listEl.innerHTML = `<p class="empty-note">No orders ${ordersStatusFilter === "all" ? "yet" : "with this status"}.</p>`;
    syncOrderBulkSelectionUI([]);
    return;
  }

  listEl.innerHTML = filtered.map((order) => {
    const status = order.status || "new";
    return `
    <div class="order-row status-${escapeHtml(status)}" data-id="${order.id}">
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
        <select class="order-status-select" data-id="${order.id}">
          ${ORDER_STATUSES.map((s) => `<option value="${s}" ${s === status ? "selected" : ""}>${s.charAt(0).toUpperCase() + s.slice(1)}</option>`).join("")}
        </select>
        <button type="button" class="danger delete-order-btn" data-id="${order.id}">Delete</button>
      </div>
    </div>
  `;
  }).join("");

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
      syncOrderBulkSelectionUI(filtered);
    });
  });
  syncOrderBulkSelectionUI(filtered);
}

async function handleOrderStatusChange(id, status) {
  const client = getSupabaseClient();
  const { error } = await client.from("orders").update({ status }).eq("id", id);
  if (error) {
    alert("Couldn't update status: " + error.message);
    return;
  }
  await refreshOrderList();
}

async function handleDeleteOrder(id) {
  if (!confirm("Delete this order? This can't be undone.")) return;
  const client = getSupabaseClient();
  const { error } = await client.from("orders").delete().eq("id", id);
  if (error) {
    alert("Couldn't delete: " + error.message);
    return;
  }
  await refreshOrderList();
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
  const { error } = await client.from("orders").update({ status }).in("id", ids);
  bar.querySelectorAll("button").forEach((b) => { b.disabled = false; });
  if (error) {
    alert("Couldn't update: " + error.message);
    return;
  }
  selectedOrderIds.clear();
  await refreshOrderList();
}

async function bulkDeleteOrders() {
  const ids = [...selectedOrderIds];
  if (!ids.length) return;
  const label = ids.length === 1 ? "this order" : `these ${ids.length} orders`;
  if (!confirm(`Delete ${label}? This can't be undone.`)) return;
  const client = getSupabaseClient();
  const bar = document.getElementById("orderBulkActionBar");
  bar.querySelectorAll("button").forEach((b) => { b.disabled = true; });
  const { error } = await client.from("orders").delete().in("id", ids);
  bar.querySelectorAll("button").forEach((b) => { b.disabled = false; });
  if (error) {
    alert("Couldn't delete: " + error.message);
    return;
  }
  selectedOrderIds.clear();
  await refreshOrderList();
}

/* CSV field escaping per RFC 4180: wrap in double quotes (and double up
   any internal quotes) whenever the value contains a comma, quote, or
   newline — otherwise a customer name/note/address containing a comma
   would silently split into extra columns. */
function csvEscapeField(value) {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/* Exports whatever is currently visible in #orderList — i.e. respects the
   active ordersStatusFilter, using the same ordersVisibleCache that
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

  const header = ["Date", "Kind", "Name", "Phone", "Email", "Address", "Event Date", "Total", "Status", "Summary", "Notes"];
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
      order.notes || ""
    ].map(csvEscapeField).join(","));
  });

  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `orders-export-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ===== Analytics =====
   Reads the analytics_events table js/analytics.js writes to from every
   public page (see trackEvent() there for the exact event names/shapes).
   A funnel step's count is the number of DISTINCT SESSIONS that logged
   that event, not the raw row count — a field-error event can fire
   several times in one session (one per failed submit attempt), and
   counting rows instead of sessions would overstate drop-off. */
let analyticsRangeDays = 30;

function analyticsRangeStartIso() {
  if (analyticsRangeDays === "all") return "1970-01-01T00:00:00Z";
  const d = new Date();
  d.setDate(d.getDate() - Number(analyticsRangeDays));
  return d.toISOString();
}

async function refreshAnalyticsPanel() {
  const content = document.getElementById("analyticsContent");
  content.innerHTML = `<p class="empty-note">Loading...</p>`;
  const client = getSupabaseClient();
  const { data, error } = await client
    .from("analytics_events")
    .select("event_name,session_id,metadata,created_at")
    .gte("created_at", analyticsRangeStartIso())
    .order("created_at", { ascending: false })
    .limit(10000);

  if (error) {
    // Most likely cause: the analytics_events table/migration hasn't been
    // run yet (see supabase-setup.sql) — give a specific, actionable
    // message instead of a raw Postgres error for that common case.
    const isMissingTable = /relation.*analytics_events.*does not exist|could not find the table/i.test(error.message);
    content.innerHTML = `<p class="form-status error">${isMissingTable
      ? "The analytics_events table doesn't exist yet — run the latest supabase-setup.sql in your Supabase SQL Editor to turn tracking on."
      : "Couldn't load analytics: " + escapeHtml(error.message)}</p>`;
    return;
  }
  renderAnalyticsPanel(data || []);
}

function distinctSessionCount(events, eventName) {
  return new Set(events.filter((e) => e.event_name === eventName).map((e) => e.session_id)).size;
}

function funnelBarHtml(label, count, maxCount) {
  const pct = maxCount > 0 ? Math.round((count / maxCount) * 100) : 0;
  return `
    <div class="analytics-funnel-row">
      <span class="analytics-funnel-label">${escapeHtml(label)}</span>
      <div class="analytics-funnel-track"><div class="analytics-funnel-fill" style="width:${pct}%"></div></div>
      <span class="analytics-funnel-count">${count}</span>
    </div>
  `;
}

function fieldBreakdownHtml(title, counts) {
  if (!counts.length) return `<div class="analytics-card"><h3>${escapeHtml(title)}</h3><p class="empty-note">No data in this range.</p></div>`;
  const max = counts[0][1];
  return `
    <div class="analytics-card">
      <h3>${escapeHtml(title)}</h3>
      ${counts.map(([field, count]) => funnelBarHtml(field, count, max)).join("")}
    </div>
  `;
}

/* Leaderboard of which products get added to cart the most — a raw row
   count per product (NOT deduped by session, unlike the funnel steps
   above), since every add is a separate signal of interest. Grouped by
   metadata.productId, falling back to metadata.name as the key for any
   row missing a productId so one malformed row can't blow up the whole
   aggregation. The display name/collection for a product comes from the
   most-recent-by-created_at row seen for that key, since a product's
   name could change over time and only the event metadata (not live
   catalog data) is available here. */
function topProductsHtml(events) {
  const addToCartEvents = events.filter((e) => e.event_name === "add_to_cart");
  if (!addToCartEvents.length) {
    return `<div class="analytics-card"><h3>Most added to cart</h3><p class="empty-note">No data in this range.</p></div>`;
  }

  const products = {}; // key -> { count, name, collection, lastSeenIso }
  addToCartEvents.forEach((e) => {
    const meta = e.metadata || {};
    const hasProductId = meta.productId !== undefined && meta.productId !== null && meta.productId !== "";
    const key = hasProductId ? String(meta.productId) : (meta.name || "Unknown product");
    const createdAt = e.created_at || "";
    if (!products[key]) {
      products[key] = { count: 0, name: meta.name, collection: meta.collection, lastSeenIso: createdAt };
    }
    products[key].count += 1;
    if (createdAt >= (products[key].lastSeenIso || "")) {
      products[key].lastSeenIso = createdAt;
      products[key].name = meta.name;
      products[key].collection = meta.collection;
    }
  });

  const sorted = Object.values(products).sort((a, b) => b.count - a.count);
  const max = sorted[0].count;
  const top = sorted.slice(0, 8);
  const extraCount = sorted.length - top.length;

  const rows = top
    .map((p) => {
      const name = p.name || "Unknown product";
      const label = p.collection ? `${name} (${p.collection})` : name;
      return funnelBarHtml(label, p.count, max);
    })
    .join("");

  return `
    <div class="analytics-card">
      <h3>Most added to cart</h3>
      ${rows}
      ${extraCount > 0 ? `<p class="analytics-note">+${extraCount} more product${extraCount === 1 ? "" : "s"} added to cart in this range.</p>` : ""}
    </div>
  `;
}

/* Deletes analytics_events rows older than the cutoff picked in the
   "Clear old events" select. Always counts the exact rows that WOULD be
   deleted first (a head-only, count:"exact" select — no rows fetched) so
   the confirm() dialog states a real number instead of a vague warning,
   and skips the confirm entirely when there's nothing to delete. The
   button/select are disabled for the whole count+delete round trip so a
   fast double-click can't fire two deletes. */
async function clearOldAnalyticsEvents() {
  const select = document.getElementById("analyticsClearRange");
  const btn = document.getElementById("analyticsClearBtn");
  const statusEl = document.getElementById("analyticsClearStatus");
  const days = Number(select.value);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffIso = cutoff.toISOString();
  const cutoffDateLabel = cutoffIso.slice(0, 10);

  statusEl.textContent = "";
  statusEl.className = "form-status";
  btn.disabled = true;
  select.disabled = true;

  const client = getSupabaseClient();
  const { count, error: countError } = await client
    .from("analytics_events")
    .select("id", { count: "exact", head: true })
    .lt("created_at", cutoffIso);

  if (countError) {
    btn.disabled = false;
    select.disabled = false;
    alert("Couldn't clear events: " + countError.message);
    return;
  }

  if (!count) {
    btn.disabled = false;
    select.disabled = false;
    statusEl.textContent = "No events older than that to clear.";
    return;
  }

  const confirmed = confirm(`Delete ${count.toLocaleString()} analytics events older than ${cutoffDateLabel}? This can't be undone.`);
  if (!confirmed) {
    btn.disabled = false;
    select.disabled = false;
    return;
  }

  const { error: deleteError } = await client
    .from("analytics_events")
    .delete()
    .lt("created_at", cutoffIso);

  btn.disabled = false;
  select.disabled = false;

  if (deleteError) {
    alert("Couldn't clear events: " + deleteError.message);
    return;
  }

  statusEl.textContent = `Cleared ${count.toLocaleString()} old analytics event${count === 1 ? "" : "s"}.`;
  statusEl.className = "form-status success";
  await refreshAnalyticsPanel();
}

function renderAnalyticsPanel(events) {
  const content = document.getElementById("analyticsContent");
  if (!events.length) {
    content.innerHTML = `<p class="empty-note">No analytics events in this range yet.</p>`;
    return;
  }

  const mainFunnelSteps = [
    ["page_view", "Visited the site"],
    ["add_to_cart", "Added something to cart"],
    ["cart_opened", "Opened the cart"],
    ["checkout_started", "Started checkout"],
    ["checkout_submitted", "Completed checkout"]
  ];
  const mainCounts = mainFunnelSteps.map(([name, label]) => [label, distinctSessionCount(events, name)]);
  const mainMax = mainCounts[0][1] || 1;

  const customFunnelSteps = [
    ["custom_order_started", "Started the custom-order form"],
    ["custom_order_submitted", "Submitted a custom-order request"]
  ];
  const customCounts = customFunnelSteps.map(([name, label]) => [label, distinctSessionCount(events, name)]);
  const customMax = customCounts[0][1] || 1;

  const checkoutFieldErrors = {};
  const customFieldErrors = {};
  let abandonCount = 0;
  const abandonFieldCounts = {};
  let checkoutFailedCount = 0;

  events.forEach((e) => {
    if (e.event_name === "checkout_field_error") {
      const f = (e.metadata && e.metadata.field) || "unknown";
      checkoutFieldErrors[f] = (checkoutFieldErrors[f] || 0) + 1;
    } else if (e.event_name === "custom_order_field_error") {
      const f = (e.metadata && e.metadata.field) || "unknown";
      customFieldErrors[f] = (customFieldErrors[f] || 0) + 1;
    } else if (e.event_name === "checkout_abandoned") {
      abandonCount += 1;
      ((e.metadata && e.metadata.filledFields) || []).forEach((f) => {
        abandonFieldCounts[f] = (abandonFieldCounts[f] || 0) + 1;
      });
    } else if (e.event_name === "checkout_failed") {
      checkoutFailedCount += 1;
    }
  });

  const sortedCounts = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]);

  content.innerHTML = `
    ${topProductsHtml(events)}
    <div class="analytics-card">
      <h3>Checkout funnel</h3>
      ${mainCounts.map(([label, count]) => funnelBarHtml(label, count, mainMax)).join("")}
      ${checkoutFailedCount > 0 ? `<p class="analytics-note">${checkoutFailedCount} checkout submission${checkoutFailedCount === 1 ? "" : "s"} failed with a backend error in this range.</p>` : ""}
    </div>
    <div class="analytics-card">
      <h3>Checkout abandoned (closed with unsaved input)</h3>
      <p class="analytics-big-number">${abandonCount}</p>
      ${abandonFieldCounts && Object.keys(abandonFieldCounts).length
        ? `<p class="analytics-note">Fields already filled in when people bailed, most common first:</p>${sortedCounts(abandonFieldCounts).map(([f, c]) => funnelBarHtml(f, c, sortedCounts(abandonFieldCounts)[0][1])).join("")}`
        : `<p class="empty-note">No abandonment data in this range.</p>`}
    </div>
    ${fieldBreakdownHtml("Checkout form — which field trips people up", sortedCounts(checkoutFieldErrors))}
    <div class="analytics-card">
      <h3>Custom-order funnel</h3>
      ${customCounts.map(([label, count]) => funnelBarHtml(label, count, customMax)).join("")}
    </div>
    ${fieldBreakdownHtml("Custom-order form — which field trips people up", sortedCounts(customFieldErrors))}
  `;
}

/* ===== Init ===== */

document.addEventListener("DOMContentLoaded", async () => {
  if (!isSupabaseConfigured()) {
    show(document.getElementById("notConfiguredView"));
    return;
  }

  const client = getSupabaseClient();
  if (!client) {
    show(document.getElementById("notConfiguredView"));
    return;
  }

  document.getElementById("loginForm").addEventListener("submit", handleLogin);
  document.getElementById("logoutBtn").addEventListener("click", handleLogout);
  document.getElementById("itemForm").addEventListener("submit", handleSaveItem);
  document.getElementById("f-photo").addEventListener("change", handlePhotoChange);
  document.getElementById("cancelEditBtn").addEventListener("click", resetForm);
  document.getElementById("openPhotoLibraryBtn").addEventListener("click", openPhotoLibrary);
  Object.keys(TABS).forEach((key) => {
    document.getElementById(TABS[key].btnId).addEventListener("click", () => switchTab(key));
  });
  document.getElementById("ordersFilter").addEventListener("click", (e) => {
    const btn = e.target.closest(".orders-filter-btn");
    if (!btn) return;
    ordersStatusFilter = btn.dataset.status;
    document.querySelectorAll(".orders-filter-btn").forEach((b) => b.classList.toggle("active", b === btn));
    refreshOrderList();
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
  document.getElementById("orderBulkDeleteBtn").addEventListener("click", bulkDeleteOrders);
  document.getElementById("orderBulkClearBtn").addEventListener("click", clearOrderSelection);
  document.getElementById("analyticsRangeFilter").addEventListener("click", (e) => {
    const btn = e.target.closest(".orders-filter-btn");
    if (!btn) return;
    analyticsRangeDays = btn.dataset.range === "all" ? "all" : Number(btn.dataset.range);
    document.querySelectorAll("#analyticsRangeFilter .orders-filter-btn").forEach((b) => b.classList.toggle("active", b === btn));
    refreshAnalyticsPanel();
  });
  document.getElementById("analyticsClearBtn").addEventListener("click", clearOldAnalyticsEvents);

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

  document.getElementById("collectionForm").addEventListener("submit", handleSaveCollection);
  document.getElementById("c-photo").addEventListener("change", handleCollectionPhotoChange);
  document.getElementById("cancelCollectionEditBtn").addEventListener("click", resetCollectionForm);
  wireClickablePhotoPreview("collectionPhotoPreview");
  wireClickablePhotoPreview("heroPhotoPreview");
  wireClickablePhotoPreview("logoPhotoPreview");
  wireClickableThumbList("itemList", (id) => {
    const item = productsCache.find((d) => String(d.id) === String(id));
    if (!item) return null;
    const urls = Array.isArray(item.images) && item.images.length ? item.images : (item.image_url ? [item.image_url] : []);
    return { urls, index: 0 };
  });
  wireClickableThumbList("collectionList", (id) => {
    const c = collectionsCache.find((d) => String(d.id) === String(id));
    return { urls: c && c.card_image_url ? [c.card_image_url] : [], index: 0 };
  });
  document.getElementById("libraryTabBreadcrumb").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-library-nav]");
    if (btn) navigateLibraryTab(btn.dataset.libraryNav);
  });
  document.getElementById("libraryNewFolderBtn").addEventListener("click", async () => {
    const name = prompt("New folder name:");
    if (!name) return;
    const { error } = await createFolderAt(libraryTabPath, name);
    if (error) { alert(error); return; }
    await navigateLibraryTab(libraryTabPath);
  });
  document.getElementById("libraryUploadInput").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    const { error } = await uploadFilesToLibrary(libraryTabPath, files);
    if (error) { alert("Upload failed: " + error); return; }
    await navigateLibraryTab(libraryTabPath);
  });
  document.getElementById("findUnusedPhotosBtn").addEventListener("click", openUnusedPhotosSection);
  document.getElementById("closeUnusedPhotosBtn").addEventListener("click", closeUnusedPhotosSection);
  document.getElementById("unusedSelectAllBtn").addEventListener("click", () => {
    unusedPhotosCandidates.forEach((f) => unusedPhotosSelected.add(f.url));
    renderUnusedPhotosSection();
  });
  document.getElementById("unusedSelectNoneBtn").addEventListener("click", () => {
    unusedPhotosSelected = new Set();
    renderUnusedPhotosSection();
  });
  document.getElementById("deleteUnusedPhotosBtn").addEventListener("click", handleDeleteSelectedUnusedPhotos);

  document.getElementById("navForm").addEventListener("submit", handleSaveNav);
  document.getElementById("cancelNavEditBtn").addEventListener("click", resetNavForm);

  document.getElementById("faqForm").addEventListener("submit", handleSaveFaq);
  document.getElementById("cancelFaqEditBtn").addEventListener("click", resetFaqForm);

  document.getElementById("settingsForm").addEventListener("submit", handleSaveSettings);
  document.getElementById("s-hero_image").addEventListener("change", handleHeroPhotoChange);
  document.getElementById("s-logo_image").addEventListener("change", handleLogoPhotoChange);

  const { data: { session } } = await client.auth.getSession();
  if (session) {
    await enterDashboard();
  } else {
    showLoginView();
  }
});
