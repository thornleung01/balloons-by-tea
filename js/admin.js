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

/* ===== Image compression =====
   Every place in this file that uploads a raw File to Supabase Storage
   runs it through compressImageFile() first. Admin phone/camera photos
   can easily be 4-12MB and 4000+px wide for something that only ever
   displays at a few hundred px on the public site, so this resizes to a
   sane max dimension and re-encodes before upload as WebP (which keeps the
   transparent backgrounds some PNG photos rely on). In a browser that
   can't encode WebP, PNGs are kept as PNG (resized but not otherwise
   degraded) and everything else is re-encoded as JPEG at a reasonable
   quality. Files already small enough that this
   wouldn't meaningfully help are returned unchanged. Any failure here
   (corrupt image, canvas/codec issue, old browser) falls back to
   uploading the ORIGINAL file — a bug in this helper must never block a
   real save the admin is trying to make. */

/* createImageBitmap isn't available in every browser (older Safari in
   particular) — fall back to decoding through an <img> element, which
   works everywhere a <canvas> does. */
async function loadDrawableImageSource(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch (e) {
      // Fall through to the <img> fallback below (e.g. an unsupported
      // format for createImageBitmap in this browser).
    }
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Couldn't read file"));
    reader.readAsDataURL(file);
  });
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't decode image"));
    img.src = dataUrl;
  });
}

async function compressImageFile(file, { maxDimension = 1600, webpQuality = 0.82, jpegQuality = 0.82, skipBelowBytes = 200 * 1024 } = {}) {
  if (!file || typeof file.type !== "string" || !file.type.startsWith("image/")) return file; // never touch non-images
  if (file.size <= skipBelowBytes) return file; // already small — not worth the processing

  let source = null;
  try {
    source = await loadDrawableImageSource(file);
    const width = source.width || source.naturalWidth || 0;
    const height = source.height || source.naturalHeight || 0;
    if (!width || !height) return file;

    const scale = Math.min(1, maxDimension / Math.max(width, height));
    const keepPng = file.type === "image/png";
    // Always redraw through canvas, even at scale 1 — a large-but-already-
    // right-sized JPEG might just be poorly compressed (e.g. quality 100
    // straight off a camera), and re-encoding at jpegQuality can still
    // shrink it meaningfully. The size check below guarantees this never
    // ships something bigger than what was uploaded.
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

    const encode = (type, quality) => new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))),
        type,
        quality
      );
    });
    // WebP keeps PNG transparency and is far smaller than PNG or JPEG.
    // Browsers that can't encode WebP silently hand back a PNG instead, so
    // check the real type and fall back to the PNG/JPEG path in that case.
    let outputType = "image/webp";
    let blob = await encode(outputType, webpQuality);
    if (!blob || blob.type !== "image/webp") {
      outputType = keepPng ? "image/png" : "image/jpeg";
      blob = await encode(outputType, keepPng ? undefined : jpegQuality);
    }
    if (!blob || blob.size >= file.size) return file; // never ship something bigger than the original

    const ext = { "image/webp": ".webp", "image/jpeg": ".jpg" }[outputType];
    const newName = ext ? file.name.replace(/\.[a-zA-Z0-9]+$/, "") + ext : file.name;
    return new File([blob], newName, { type: outputType, lastModified: Date.now() });
  } catch (err) {
    // Corrupt image, canvas/codec failure, etc. — upload the original
    // rather than let a processing bug block a real upload.
    return file;
  } finally {
    // Release the ImageBitmap's backing memory promptly on every exit
    // path (early returns included), not just the success path.
    if (source && typeof source.close === "function") source.close();
  }
}

/* Runs an update/delete/upsert and treats "no rows changed" as a failure.
   When Row Level Security blocks a write (most often because the login
   session has expired or been lost), Supabase doesn't return an error —
   it returns success with zero rows. Without this check every save button
   would report "updated"/"deleted" while nothing actually changed.
   Callers keep using { error } exactly as before. */
async function mustAffect(query) {
  const { data, error } = await query.select();
  if (error) return { data, error };
  if (!data || data.length === 0) {
    return {
      data,
      // Either the row no longer exists (deleted elsewhere) or RLS blocked
      // the write (login expired) — the response can't tell which.
      error: { message: "Nothing was changed — it may already have been deleted, or your login may have expired. Refresh the page and try again." }
    };
  }
  return { data, error: null };
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

let loggingOutOnPurpose = false;

async function handleLogout() {
  if ((itemFormIsDirty() || settingsFormIsDirty()) && !confirm("You have unsaved changes. Log out anyway?")) return;
  const client = getSupabaseClient();
  loggingOutOnPurpose = true;
  try {
    await client.auth.signOut();
  } finally {
    // Always reset, even if signOut throws (e.g. offline) — otherwise the
    // lost-session watcher would stay switched off for the rest of the page.
    loggingOutOnPurpose = false;
  }
  showLoginView();
}

/* If the session ends on its own (token refresh failed, signed out in
   another tab), return to the login screen with an explanation instead of
   leaving a dashboard up whose saves can no longer succeed. The forms are
   only hidden, not cleared, so unsaved work is still there after logging
   back in. */
function watchForLostSession(client) {
  client.auth.onAuthStateChange((event) => {
    if (event !== "SIGNED_OUT" || loggingOutOnPurpose) return;
    if (document.getElementById("dashboardView").hidden) return;
    showLoginView();
    document.getElementById("loginError").textContent =
      "Your login expired — please log in again. Anything you hadn't saved is still in the form.";
  });
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
  // First clean snapshot of the item form, taken only once the category
  // dropdown has its real options (filling it changes the form's value).
  if (itemFormSnapshot === null) markItemFormClean();
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
  const { error } = await mustAffect(client.from("products").update({ collection: newSlug }).eq("id", id));
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
  const { error } = await mustAffect(client.from("products").update({ active }).in("id", ids));
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
  const { error } = await mustAffect(client.from("products").delete().in("id", ids));
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
  const { error } = await mustAffect(client.from("products").update({ active }).eq("id", id));
  if (error) {
    alert("Couldn't update: " + error.message);
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
    photos: currentPhotoEntries.map((e) => (e.type === "url" ? e.value : `file:${e.value.name}:${e.value.size}`))
  });
}
function markItemFormClean() { itemFormSnapshot = itemFormState(); }
function itemFormIsDirty() { return itemFormSnapshot !== null && itemFormState() !== itemFormSnapshot; }
function confirmDiscardItemEdits() {
  return !itemFormIsDirty() || confirm("You have unsaved changes to this item. Discard them?");
}

function startEdit(item) {
  if (!confirmDiscardItemEdits()) return;
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
  markItemFormClean();
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
  // Report the failure instead of returning an empty listing: an outage
  // would otherwise read as "Nothing here yet" and an empty folder check
  // would pass.
  if (error) return { folders: [], files: [], error: error.message };
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
  const { folders, files, error } = await listLibraryPath(path);
  if (error) throw new Error(error); // a skipped folder would make the scan quietly incomplete
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
     - gallery_items.image_url (the Gallery tab's photos), skipped when
       that table hasn't been created yet.
   Note: collection card photos and the settings hero/logo photo are
   actually uploaded to a different bucket entirely ("site-images", see
   uploadSiteImage() below) rather than "product-photos", so in practice
   neither of those two sources will ever match anything in this bucket's
   scan — but their values are still included here since checking them
   costs nothing and guards against any future change in how they're
   stored. */
/* Gallery tab (js/admin-gallery.js): gallery_items.image_url is a photo
   reference too. That table only exists once the "Gallery" section of supabase-setup.sql has been
   run, so a missing table counts as "no gallery photos" here; any other
   read error is returned as-is so the callers below still refuse to guess. */
async function selectGalleryItemsForReferences(client, columns) {
  const res = await client.from("gallery_items").select(columns);
  if (res.error && isMissingTableError(res.error, "gallery_items")) return { data: [], error: null };
  return res;
}

async function gatherReferencedPhotoUrls() {
  const client = getSupabaseClient();
  const urls = new Set();
  const add = (v) => { if (v && typeof v === "string" && v.trim()) urls.add(v.trim()); };

  const [productsRes, collectionsRes, settingsRes, overridesRes, galleryRes] = await Promise.all([
    client.from("products").select("image_url,images"),
    client.from("collections").select("card_image_url"),
    client.from("site_settings").select("key,value"),
    client.from("layout_overrides").select("value"),
    selectGalleryItemsForReferences(client, "image_url") // Gallery tab
  ]);

  const firstError = productsRes.error || collectionsRes.error || settingsRes.error || overridesRes.error || galleryRes.error;
  if (firstError) throw new Error(firstError.message);
  (galleryRes.data || []).forEach((g) => add(g.image_url)); // Gallery tab

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

/* Finds every real, human-readable place a given photo URL is currently
   referenced from — used to warn before a destructive delete. Checks the
   same sources as gatherReferencedPhotoUrls(), just keeping track of
   WHERE each match came from instead of only whether one exists. Throws if
   any lookup fails: "couldn't check" must never be mistaken for "unused". */
async function findReferencesForUrl(url) {
  const client = getSupabaseClient();
  const refs = [];
  const [productsRes, collectionsRes, settingsRes, galleryRes] = await Promise.all([
    client.from("products").select("id,name,image_url,images"),
    client.from("collections").select("id,title,card_image_url"),
    client.from("site_settings").select("key,value"),
    selectGalleryItemsForReferences(client, "id,caption,image_url") // Gallery tab
  ]);
  const readError = productsRes.error || collectionsRes.error || settingsRes.error || galleryRes.error;
  if (readError) throw new Error(readError.message);

  (productsRes.data || []).forEach((p) => {
    const inImages = Array.isArray(p.images) && p.images.includes(url);
    if (p.image_url === url || inImages) refs.push(`product "${p.name}"`);
  });
  (galleryRes.data || []).forEach((g) => {
    if (g.image_url === url) refs.push(g.caption ? `gallery photo "${g.caption}"` : `gallery photo #${g.id}`);
  });
  (collectionsRes.data || []).forEach((c) => {
    if (c.card_image_url === url) refs.push(`category "${c.title}"`);
  });
  (settingsRes.data || []).forEach((s) => {
    if (s.value === url) refs.push(`site setting "${s.key}"`);
  });
  return refs;
}

/* Works out (without writing anything) every DB change needed to repoint
   references from oldUrl to newUrl. Throws if any lookup fails, so a move
   can be refused before anything has changed. Returns a list of functions,
   each performing one checked write. */
async function planReferenceUpdates(oldUrl, newUrl) {
  const client = getSupabaseClient();
  const [productsRes, collectionsRes, settingsRes, galleryRes] = await Promise.all([
    client.from("products").select("id,image_url,images"),
    client.from("collections").select("id,card_image_url"),
    client.from("site_settings").select("key,value"),
    selectGalleryItemsForReferences(client, "id,image_url") // Gallery tab
  ]);
  const readError = productsRes.error || collectionsRes.error || settingsRes.error || galleryRes.error;
  if (readError) throw new Error(readError.message);

  const writes = [];
  (galleryRes.data || []).forEach((g) => {
    if (g.image_url === oldUrl) writes.push(() => mustAffect(client.from("gallery_items").update({ image_url: newUrl }).eq("id", g.id)));
  });
  (productsRes.data || []).forEach((p) => {
    const inImages = Array.isArray(p.images) && p.images.includes(oldUrl);
    if (p.image_url !== oldUrl && !inImages) return;
    const images = Array.isArray(p.images) ? p.images.map((u) => (u === oldUrl ? newUrl : u)) : p.images;
    const image_url = p.image_url === oldUrl ? newUrl : p.image_url;
    writes.push(() => mustAffect(client.from("products").update({ image_url, images }).eq("id", p.id)));
  });
  (collectionsRes.data || []).forEach((c) => {
    if (c.card_image_url === oldUrl) writes.push(() => mustAffect(client.from("collections").update({ card_image_url: newUrl }).eq("id", c.id)));
  });
  (settingsRes.data || []).forEach((s) => {
    if (s.value === oldUrl) writes.push(() => mustAffect(client.from("site_settings").update({ value: newUrl }).eq("key", s.key)));
  });
  return writes;
}

/* Deletes one Library photo. Returns { deleted, error }: a cancelled
   confirm is { deleted: false, error: null }, which callers must NOT treat
   as a successful delete. Pass { skipReferenceCheck: true } only when the
   caller has just verified the photo is unused itself. */
async function deleteLibraryFile(path, { skipReferenceCheck = false } = {}) {
  const client = getSupabaseClient();
  if (!skipReferenceCheck) {
    const url = client.storage.from("product-photos").getPublicUrl(path).data.publicUrl;
    let refs;
    try {
      refs = await findReferencesForUrl(url);
    } catch (err) {
      const proceed = confirm(`Couldn't check whether this photo is still used by a product (${err.message}). If it is, deleting it will break that listing. Delete anyway?`);
      if (!proceed) return { deleted: false, error: null };
      refs = [];
    }
    if (refs.length) {
      const proceed = confirm(
        `This photo is currently used by ${refs.join(", ")}. Deleting it will break ${refs.length === 1 ? "that listing" : "those listings"}. Delete anyway?`
      );
      if (!proceed) return { deleted: false, error: null };
    }
  }
  const { error } = await client.storage.from("product-photos").remove([path]);
  return error ? { deleted: false, error: error.message } : { deleted: true, error: null };
}

async function deleteLibraryFolder(path) {
  // No recursive delete — refuse rather than silently nuking contents.
  // The admin can move/delete what's inside first, same as any ordinary
  // file manager would require.
  const { folders, files, error: listError } = await listLibraryPath(path);
  if (listError) return `Couldn't check whether that folder is empty, so it wasn't deleted: ${listError}`;
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
  const fromUrl = client.storage.from("product-photos").getPublicUrl(fromPath).data.publicUrl;
  const toUrl = client.storage.from("product-photos").getPublicUrl(toPath).data.publicUrl;

  // Plan the reference updates BEFORE moving: if we can't even read what
  // uses this photo, refuse now while nothing has changed.
  let forward, backward;
  try {
    forward = await planReferenceUpdates(fromUrl, toUrl);
  } catch (err) {
    return `Couldn't check what uses this photo, so it wasn't moved: ${err.message}`;
  }

  const { error } = await client.storage.from("product-photos").move(fromPath, toPath);
  if (error) return error.message;

  // The file's URL just changed — repoint everything that used it, so
  // organizing photos into folders never silently breaks a listing.
  const results = await Promise.all(forward.map((write) => write()));
  const failed = results.filter((r) => r.error);
  if (failed.length) {
    // Roll back so the site stays consistent: put the file back, and undo
    // whichever reference updates did succeed. Report honestly if the
    // rollback itself fails — never claim "nothing changed" when it did.
    const reason = failed[0].error.message;
    const { error: moveBackError } = await client.storage.from("product-photos").move(toPath, fromPath);
    if (moveBackError) {
      return `Photo move failed partway and couldn't be undone: the file is now in "${toFolder || "Library"}" but ${failed.length} listing${failed.length === 1 ? "" : "s"} still point at its old location, so those images may be broken. Move it back manually. (${reason}; move-back: ${moveBackError.message})`;
    }
    let revertProblem = null;
    try {
      backward = await planReferenceUpdates(toUrl, fromUrl);
      const reverted = await Promise.all(backward.map((write) => write()));
      const revertFailed = reverted.filter((r) => r.error);
      if (revertFailed.length) revertProblem = revertFailed[0].error.message;
    } catch (err) {
      revertProblem = err.message;
    }
    if (revertProblem) {
      return `Photo move failed and the file was put back, but some listings couldn't be pointed back at it — check products using "${filename}" for broken images. (${reason}; revert: ${revertProblem})`;
    }
    return `Photo not moved — couldn't update ${failed.length} place${failed.length === 1 ? "" : "s"} that use it (${reason}). Nothing was changed.`;
  }
  if (forward.length > 0) {
    alert(`Moved — and updated ${forward.length} place${forward.length === 1 ? "" : "s"} that was using this photo so it keeps working.`);
  }
  return null;
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
      const result = await deleteLibraryFile(btn.dataset.deleteFile);
      if (result.error) { alert("Couldn't delete: " + result.error); return; }
      if (result.deleted) afterMutate();
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
    const compressed = await compressImageFile(file);
    const safeName = compressed.name.replace(/[^a-zA-Z0-9.-]/g, "_");
    const path = basePath ? `${basePath}/${Date.now()}-${safeName}` : `${Date.now()}-${safeName}`;
    const { error } = await client.storage.from("product-photos").upload(path, compressed, { upsert: true });
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
  if (pickerEntries.error) {
    grid.innerHTML = `<p class="form-status error">Couldn't load photos: ${escapeHtml(pickerEntries.error)}</p>`;
    return;
  }
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

/* Gallery tab (js/admin-gallery.js) reuses this picker: it passes
   { onAdd(urls), subtitle }. The item form's button passes the click event
   instead, which has no onAdd, so it keeps the original behavior. */
let photoLibraryAddHandler = null;
const PHOTO_LIBRARY_DEFAULT_SUBTITLE = "Every photo you've uploaded before. Pick as many as you want to add to this item.";

async function openPhotoLibrary(options) {
  const modal = ensurePhotoLibraryModal();
  photoLibraryAddHandler = options && typeof options.onAdd === "function" ? options.onAdd : null;
  const subtitle = modal.querySelector(".modal-head p");
  if (subtitle) subtitle.textContent = (photoLibraryAddHandler && options.subtitle) || PHOTO_LIBRARY_DEFAULT_SUBTITLE;
  photoLibrarySelected.clear();
  modal.classList.add("open");
  await navigatePickerTo("");
}

function closePhotoLibrary() {
  const modal = document.getElementById("photoLibraryModal");
  if (modal) modal.classList.remove("open");
}

function addSelectedLibraryPhotos() {
  if (photoLibraryAddHandler) { // opened from the Gallery tab
    const handler = photoLibraryAddHandler;
    const urls = Array.from(photoLibrarySelected);
    photoLibraryAddHandler = null;
    closePhotoLibrary();
    handler(urls);
    return;
  }
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
  if (libraryTabEntries.error) {
    grid.innerHTML = `<p class="form-status error">Couldn't load photos: ${escapeHtml(libraryTabEntries.error)}</p>`;
    return;
  }
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

  // Re-check references once, right before deleting: something may have
  // started using one of these photos since the scan. If the check itself
  // fails, delete nothing rather than guess.
  let referenced;
  try {
    referenced = await gatherReferencedPhotoUrls();
  } catch (err) {
    if (btn) btn.disabled = false;
    alert(`Couldn't re-check whether these photos are in use (${err.message}), so nothing was deleted. Try again.`);
    return;
  }
  const failures = [];
  const succeededPaths = new Set();
  for (const f of toDelete) {
    if (referenced.has(f.url)) { failures.push(`${f.name}: now used by a listing — skipped`); continue; }
    const result = await deleteLibraryFile(f.path, { skipReferenceCheck: true });
    if (result.deleted) succeededPaths.add(f.path);
    else failures.push(`${f.name}: ${result.error || "not deleted"}`);
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

    let error;
    if (currentEditId) {
      ({ error } = await mustAffect(client.from("products").update(payload).eq("id", currentEditId)));
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
  const { error } = await mustAffect(client.from("products").delete().eq("id", id));
  if (error) {
    alert("Couldn't delete: " + error.message);
    return;
  }
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
  // Two independent features share this tab, each in its own file
  // (js/admin-availability.js, js/admin-delivery-areas.js).
  delivery: { btnId: "tabDeliveryBtn", panelId: "deliveryPanel", onEnter: () => {
    window.refreshAvailabilityAdmin();
    window.refreshDeliveryAreaAdmin();
  } },
  collections: { btnId: "tabCollectionsBtn", panelId: "collectionsPanel", onEnter: refreshCollectionList },
  library: { btnId: "tabLibraryBtn", panelId: "libraryPanel", onEnter: refreshLibraryPanel },
  // Past events gallery — lives in js/admin-gallery.js.
  gallery: { btnId: "tabGalleryBtn", panelId: "galleryPanel", onEnter: () => window.refreshGalleryAdmin() },
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

/* Shared by the Collections, Nav and FAQ drag-to-reorder lists. Every
   row's write is checked; if any fail the admin is told, and the list is
   re-read from the database either way so it shows what was really saved
   rather than a half-applied order. */
async function persistSortOrder(table, cache, refresh) {
  const client = getSupabaseClient();
  const results = await Promise.all(cache.map((row, i) => mustAffect(client.from(table).update({ sort_order: i }).eq("id", row.id))));
  const failed = results.filter((r) => r.error);
  if (failed.length) alert(`Couldn't save the new order (${failed.length} of ${cache.length} rows failed): ${failed[0].error.message}`);
  await refresh();
}

async function persistCollectionOrder(cache) {
  await persistSortOrder("collections", cache, refreshCollectionList);
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

/* `folder` is optional (the Gallery tab passes "gallery"); without it the
   file goes in the bucket root as before. */
async function uploadSiteImage(client, file, compressOptions, folder) {
  const compressed = await compressImageFile(file, compressOptions);
  const safeName = compressed.name.replace(/[^a-zA-Z0-9.-]/g, "_");
  const path = `${folder ? folder + "/" : ""}${Date.now()}-${safeName}`;
  const { error } = await client.storage.from("site-images").upload(path, compressed, { upsert: true });
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
      ({ error } = await mustAffect(client.from("collections").update(payload).eq("id", currentCollectionEditId)));
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
  const { error } = await mustAffect(client.from("collections").delete().eq("id", id));
  if (error) { alert("Couldn't delete: " + error.message); return; }
  if (String(currentCollectionEditId) === String(id)) resetCollectionForm(); // number (DB) vs string (data-id)
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
  const { error } = await mustAffect(client.from("nav_items").update({ visible }).eq("id", id));
  if (error) {
    alert("Couldn't update: " + error.message);
    toggleEl.checked = !visible;
    toggleEl.disabled = false;
    return;
  }
  await refreshNavList();
}

async function persistNavOrder(cache) {
  await persistSortOrder("nav_items", cache, refreshNavList);
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
      ({ error } = await mustAffect(client.from("nav_items").update(payload).eq("id", currentNavEditId)));
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
  const { error } = await mustAffect(client.from("nav_items").delete().eq("id", id));
  if (error) { alert("Couldn't delete: " + error.message); return; }
  if (String(currentNavEditId) === String(id)) resetNavForm(); // number (DB) vs string (data-id)
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
  await persistSortOrder("faq_items", cache, refreshFaqList);
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
      ({ error } = await mustAffect(client.from("faq_items").update(payload).eq("id", currentFaqEditId)));
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
  const { error } = await mustAffect(client.from("faq_items").delete().eq("id", id));
  if (error) { alert("Couldn't delete: " + error.message); return; }
  if (String(currentFaqEditId) === String(id)) resetFaqForm(); // number (DB) vs string (data-id)
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

/* Values as last successfully loaded from the database (key -> value), or
   null if no load has succeeded yet. Save is disabled until it's set, and
   Save only writes fields that differ from it. Both guard the same
   failure: if the settings read failed, the form would be full of blanks
   and black colour-picker defaults, and saving all 23 keys from it would
   wipe the homepage text, contact details and theme across the live site. */
let settingsBaseline = null;

function settingsFormIsDirty() {
  if (!settingsBaseline) return false;
  if (currentHeroPhotoFile || currentLogoPhotoFile) return true;
  return SETTINGS_KEYS.some((key) => {
    const input = document.getElementById(`s-${key}`);
    return input && input.value !== settingsBaseline[key];
  });
}

async function loadSettingsIntoForm() {
  const statusEl = document.getElementById("settingsFormStatus");
  const saveBtn = document.getElementById("saveSettingsBtn");
  // Re-entering the tab with unsaved edits: keep them rather than reload
  // over them.
  if (settingsFormIsDirty()) {
    statusEl.textContent = "You have unsaved changes.";
    statusEl.className = "form-status";
    return;
  }
  saveBtn.disabled = true;
  statusEl.textContent = "Loading settings...";
  statusEl.className = "form-status";
  // Reset staged photos before the fetch, not after — otherwise a photo
  // picked while this request is in flight gets silently thrown away.
  // Clear the file inputs too: if one kept showing a filename after its
  // staged file was dropped, re-picking that same file fires no change
  // event and Save would quietly skip the upload.
  currentHeroPhotoFile = null;
  currentLogoPhotoFile = null;
  ["s-hero_image", "s-logo_image"].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.value = "";
  });
  // Snapshot text fields so anything typed while the request is in flight
  // isn't overwritten by the loaded values.
  const valuesAtStart = {};
  SETTINGS_KEYS.forEach((key) => {
    const input = document.getElementById(`s-${key}`);
    if (input) valuesAtStart[key] = input.value;
  });
  const client = getSupabaseClient();
  const { data, error } = await client.from("site_settings").select("*");
  if (error) {
    statusEl.textContent = `Couldn't load settings (${error.message}). Saving is disabled so blank fields can't overwrite the live site — reload the page to try again.`;
    statusEl.className = "form-status error";
    return; // Save stays disabled
  }
  const map = {};
  (data || []).forEach((row) => { map[row.key] = row.value; });

  // How a value looks once a field of this kind has held it. Browsers
  // normalize: colour inputs lowercase hex (and turn invalid values into
  // #000000), textareas turn CRLF into LF. Comparing against the raw DB
  // value would make such fields look permanently "changed".
  const asFieldValue = (input, value) => {
    const probe = input.cloneNode(false);
    probe.value = value;
    return probe.value;
  };
  const baseline = {};
  SETTINGS_KEYS.forEach((key) => {
    const input = document.getElementById(`s-${key}`);
    if (!input) return;
    const editedMidLoad = input.value !== valuesAtStart[key];
    if (map[key] != null && !editedMidLoad) input.value = map[key];
    // The baseline is what the database holds, as this field would show
    // it. A key the database doesn't have yet gets the input's own default
    // as its baseline, so an untouched default (e.g. the colour picker's
    // black) is never written.
    baseline[key] = map[key] != null
      ? asFieldValue(input, map[key])
      : (editedMidLoad ? valuesAtStart[key] : input.value);
  });
  settingsBaseline = baseline;

  if (!currentHeroPhotoFile) {
    document.getElementById("heroPhotoPreview").innerHTML = map.hero_image_url ? `<img src="${escapeHtml(map.hero_image_url)}" alt=""/>` : "No photo";
  }
  if (!currentLogoPhotoFile) {
    document.getElementById("logoPhotoPreview").innerHTML = map.logo_url ? `<img src="${escapeHtml(map.logo_url)}" alt=""/>` : "No photo";
  }
  statusEl.textContent = "";
  saveBtn.disabled = false;
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
    if (!settingsBaseline) throw new Error("Settings haven't loaded, so nothing was saved. Reload the page and try again.");
    // Only write what actually changed since the last successful load.
    const rows = SETTINGS_KEYS
      .map((key) => ({ key, value: document.getElementById(`s-${key}`).value }))
      .filter((row) => row.value !== settingsBaseline[row.key]);

    if (currentHeroPhotoFile) {
      // The hero photo renders full-bleed (.hero-photo-img, width/height:
      // 100% of its section) up to the full viewport width, unlike every
      // other compressed image in this file which only ever displays at a
      // few hundred px — the generic 1600px cap would visibly soften it on
      // any desktop monitor or retina display. Give it a larger ceiling.
      rows.push({ key: "hero_image_url", value: await uploadSiteImage(client, currentHeroPhotoFile, { maxDimension: 2560 }) });
    }
    if (currentLogoPhotoFile) {
      rows.push({ key: "logo_url", value: await uploadSiteImage(client, currentLogoPhotoFile) });
    }

    if (!rows.length) {
      statusEl.textContent = "Nothing has changed — nothing to save.";
      statusEl.className = "form-status";
      return;
    }
    const { error } = await mustAffect(client.from("site_settings").upsert(rows, { onConflict: "key" }));
    if (error) throw error;

    rows.forEach((row) => { if (row.key in settingsBaseline) settingsBaseline[row.key] = row.value; });
    currentHeroPhotoFile = null;
    currentLogoPhotoFile = null;
    statusEl.textContent = "Settings saved.";
    statusEl.className = "form-status success";
  } catch (err) {
    statusEl.textContent = err.message || "Something went wrong saving settings.";
    statusEl.className = "form-status error";
  } finally {
    saveBtn.disabled = !settingsBaseline;
  }
}

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

/* ===== Analytics =====
   Reads the analytics_events table js/analytics.js writes to from every
   public page (see trackEvent() there for the exact event names/shapes).
   A funnel step's count is the number of DISTINCT SESSIONS that logged
   that event, not the raw row count — a field-error event can fire
   several times in one session (one per failed submit attempt), and
   counting rows instead of sessions would overstate drop-off.

   The counting happens in Postgres (analytics_summary(), see
   supabase-setup.sql), which returns one small summary object. Until that
   function has been created, the same summary is built here in the
   browser from every event in the range, fetched page by page
   (computeAnalyticsSummary — keep its rules in sync with the SQL). */
let analyticsRangeDays = 30;
// Bumped on every refresh so a slow, older load (e.g. after a quick range
// switch) can't overwrite the panel once a newer one has started.
let analyticsRefreshSeq = 0;
const ANALYTICS_PAGE_SIZE = 1000;

function analyticsRangeStartIso() {
  if (analyticsRangeDays === "all") return "1970-01-01T00:00:00Z";
  const d = new Date();
  d.setDate(d.getDate() - Number(analyticsRangeDays));
  return d.toISOString();
}

async function refreshAnalyticsPanel() {
  const seq = ++analyticsRefreshSeq;
  const content = document.getElementById("analyticsContent");
  content.innerHTML = `<p class="empty-note">Loading...</p>`;
  const client = getSupabaseClient();
  // A fixed upper bound so both paths count exactly the same window, and
  // events logged mid-load can't shift the fallback's pages.
  const fromIso = analyticsRangeStartIso();
  const toIso = new Date().toISOString();

  let { data, error } = await client.rpc("analytics_summary", { from_ts: fromIso, to_ts: toIso });
  if (seq !== analyticsRefreshSeq) return;
  let usedFallback = false;
  if (error && isMissingTableError(error, "analytics_summary")) {
    usedFallback = true;
    const events = await fetchAllAnalyticsEvents(client, fromIso, toIso);
    if (seq !== analyticsRefreshSeq) return;
    error = events.error;
    data = error ? null : computeAnalyticsSummary(events.data);
  }

  if (error) {
    // Most likely cause: the analytics_events table/migration hasn't been
    // run yet (see supabase-setup.sql) — give a specific, actionable
    // message instead of a raw Postgres error for that common case.
    content.innerHTML = `<p class="form-status error">${isMissingTableError(error, "analytics_events")
      ? "The analytics_events table doesn't exist yet — run the latest supabase-setup.sql in your Supabase SQL Editor to turn tracking on."
      : "Couldn't load analytics: " + escapeHtml(error.message)}</p>`;
    return;
  }
  renderAnalyticsPanel(data, usedFallback);
}

/* Fallback only: every event in [fromIso, toIso), fetched in pages with
   .range() because PostgREST caps a single response (1000 rows by
   default). Ordered by created_at then id so pages never overlap or skip.
   Stops on an empty page rather than a short one, so a server whose row
   cap is set lower than ANALYTICS_PAGE_SIZE still gets read in full. */
async function fetchAllAnalyticsEvents(client, fromIso, toIso) {
  const rows = [];
  for (;;) {
    const { data, error } = await client
      .from("analytics_events")
      .select("id,event_name,session_id,metadata,created_at")
      .gte("created_at", fromIso)
      .lt("created_at", toIso)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(rows.length, rows.length + ANALYTICS_PAGE_SIZE - 1);
    if (error) return { data: null, error };
    if (!data || !data.length) break;
    data.forEach((row) => rows.push(row));
  }
  return { data: rows, error: null };
}

/* A metadata value as analytics_summary() reads it (metadata ->> key):
   non-empty strings as-is, numbers/booleans as text, anything else
   (missing, null, "", object, array) as absent. */
function analyticsMetaText(meta, key) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const v = meta[key];
  if (typeof v === "string") return v === "" ? null : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/* created_at as microseconds since the epoch, for exact newest-row
   comparisons (Date.parse alone drops Postgres's last 3 digits). */
function analyticsTimeValue(iso) {
  const ms = Date.parse(iso || "");
  if (Number.isNaN(ms)) return -Infinity;
  const frac = /\.(\d+)/.exec(iso);
  return ms * 1000 + (frac ? Number((frac[1] + "000000").slice(3, 6)) : 0);
}

// count desc, then key in code-point order — same as the SQL's collate "C".
function analyticsCountOrder(aCount, aKey, bCount, bKey) {
  if (aCount !== bCount) return bCount - aCount;
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

function analyticsSortedFieldCounts(counts) {
  return Object.entries(counts)
    .sort((a, b) => analyticsCountOrder(a[1], a[0], b[1], b[0]))
    .map(([field, count]) => ({ field, count }));
}

/* Browser-side twin of analytics_summary() — same input window, same
   output shape, same rules (see the comment above that function in
   supabase-setup.sql). Used only when the function doesn't exist yet. */
function computeAnalyticsSummary(events) {
  const eventsByEvent = {};
  const sessionSets = {};
  const checkoutFieldErrors = {};
  const customFieldErrors = {};
  const abandonFields = {};
  const products = {}; // key -> { key, count, name, collection, time, id }

  events.forEach((e) => {
    const name = e.event_name;
    eventsByEvent[name] = (eventsByEvent[name] || 0) + 1;
    (sessionSets[name] = sessionSets[name] || new Set()).add(e.session_id);
    const meta = e.metadata;

    if (name === "checkout_field_error" || name === "custom_order_field_error") {
      const target = name === "checkout_field_error" ? checkoutFieldErrors : customFieldErrors;
      const f = analyticsMetaText(meta, "field") || "unknown";
      target[f] = (target[f] || 0) + 1;
    } else if (name === "checkout_abandoned") {
      const filled = meta && typeof meta === "object" && !Array.isArray(meta) ? meta.filledFields : null;
      if (Array.isArray(filled)) {
        filled.forEach((v) => {
          const f = analyticsMetaText({ v }, "v");
          if (f !== null) abandonFields[f] = (abandonFields[f] || 0) + 1;
        });
      }
    } else if (name === "add_to_cart") {
      const productName = analyticsMetaText(meta, "name");
      const key = analyticsMetaText(meta, "productId") || productName || "Unknown product";
      const time = analyticsTimeValue(e.created_at);
      const id = Number(e.id) || 0;
      const p = products[key] || (products[key] = { key, count: 0, name: null, collection: null, time: -Infinity, id: -Infinity });
      p.count += 1;
      if (time > p.time || (time === p.time && id > p.id)) {
        p.time = time;
        p.id = id;
        p.name = productName;
        p.collection = analyticsMetaText(meta, "collection");
      }
    }
  });

  const sessionsByEvent = {};
  Object.keys(sessionSets).forEach((name) => { sessionsByEvent[name] = sessionSets[name].size; });
  const sortedProducts = Object.values(products).sort((a, b) => analyticsCountOrder(a.count, a.key, b.count, b.key));

  return {
    total_events: events.length,
    events_by_event: eventsByEvent,
    sessions_by_event: sessionsByEvent,
    checkout_field_errors: analyticsSortedFieldCounts(checkoutFieldErrors),
    custom_field_errors: analyticsSortedFieldCounts(customFieldErrors),
    abandon_fields: analyticsSortedFieldCounts(abandonFields),
    top_products: sortedProducts.slice(0, 8).map((p) => ({ key: p.key, name: p.name, collection: p.collection, count: p.count })),
    product_count: sortedProducts.length
  };
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
  const max = counts[0].count;
  return `
    <div class="analytics-card">
      <h3>${escapeHtml(title)}</h3>
      ${counts.map(({ field, count }) => funnelBarHtml(field, count, max)).join("")}
    </div>
  `;
}

/* Leaderboard of which products get added to cart the most — a raw row
   count per product (NOT deduped by session, unlike the funnel steps
   above), since every add is a separate signal of interest. Grouped by
   metadata.productId, falling back to metadata.name as the key for any
   row missing a productId so one malformed row can't blow up the whole
   aggregation. The display name/collection for a product comes from the
   newest row for that key (summary.top_products already holds the top 8
   in order), since a product's name could change over time and only the
   event metadata (not live catalog data) is available here. */
function topProductsHtml(summary) {
  const top = summary.top_products || [];
  if (!top.length) {
    return `<div class="analytics-card"><h3>Most added to cart</h3><p class="empty-note">No data in this range.</p></div>`;
  }

  const max = top[0].count;
  const extraCount = (summary.product_count || 0) - top.length;

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

  // Count on the server rather than mustAffect()'s .select(), which would
  // send every deleted event back to the browser just to check it's > 0.
  let { error: deleteError, count: deletedCount } = await client
    .from("analytics_events")
    .delete({ count: "exact" })
    .lt("created_at", cutoffIso);
  if (!deleteError && !deletedCount) {
    deleteError = { message: "Nothing was deleted — your login may have expired. Refresh the page and try again." };
  }

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

/* summary is analytics_summary()'s object (or computeAnalyticsSummary()'s,
   same shape). usedFallback adds a nudge to create the server function. */
function renderAnalyticsPanel(summary, usedFallback) {
  const content = document.getElementById("analyticsContent");
  const tipHtml = usedFallback
    ? `<p class="analytics-note">Tip: run the latest supabase-setup.sql for faster analytics.</p>`
    : "";
  if (!summary || !summary.total_events) {
    content.innerHTML = `<p class="empty-note">No analytics events in this range yet.</p>${tipHtml}`;
    return;
  }
  const sessionsByEvent = summary.sessions_by_event || {};
  const eventsByEvent = summary.events_by_event || {};

  const mainFunnelSteps = [
    ["page_view", "Visited the site"],
    ["add_to_cart", "Added something to cart"],
    ["cart_opened", "Opened the cart"],
    ["checkout_started", "Started checkout"],
    ["checkout_submitted", "Completed checkout"]
  ];
  const mainCounts = mainFunnelSteps.map(([name, label]) => [label, sessionsByEvent[name] || 0]);
  const mainMax = mainCounts[0][1] || 1;

  const customFunnelSteps = [
    ["custom_order_started", "Started the custom-order form"],
    ["custom_order_submitted", "Submitted a custom-order request"]
  ];
  const customCounts = customFunnelSteps.map(([name, label]) => [label, sessionsByEvent[name] || 0]);
  const customMax = customCounts[0][1] || 1;

  const abandonCount = eventsByEvent.checkout_abandoned || 0;
  const abandonFields = summary.abandon_fields || [];
  const checkoutFailedCount = eventsByEvent.checkout_failed || 0;

  content.innerHTML = `
    ${topProductsHtml(summary)}
    <div class="analytics-card">
      <h3>Checkout funnel</h3>
      ${mainCounts.map(([label, count]) => funnelBarHtml(label, count, mainMax)).join("")}
      ${checkoutFailedCount > 0 ? `<p class="analytics-note">${checkoutFailedCount} checkout submission${checkoutFailedCount === 1 ? "" : "s"} failed with a backend error in this range.</p>` : ""}
    </div>
    <div class="analytics-card">
      <h3>Checkout abandoned (closed with unsaved input)</h3>
      <p class="analytics-big-number">${abandonCount}</p>
      ${abandonFields.length
        ? `<p class="analytics-note">Fields already filled in when people bailed, most common first:</p>${abandonFields.map(({ field, count }) => funnelBarHtml(field, count, abandonFields[0].count)).join("")}`
        : `<p class="empty-note">No abandonment data in this range.</p>`}
    </div>
    ${fieldBreakdownHtml("Checkout form — which field trips people up", summary.checkout_field_errors || [])}
    <div class="analytics-card">
      <h3>Custom-order funnel</h3>
      ${customCounts.map(([label, count]) => funnelBarHtml(label, count, customMax)).join("")}
    </div>
    ${fieldBreakdownHtml("Custom-order form — which field trips people up", summary.custom_field_errors || [])}
    ${tipHtml}
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
  watchForLostSession(client);
  document.getElementById("logoutBtn").addEventListener("click", handleLogout);
  document.getElementById("itemForm").addEventListener("submit", handleSaveItem);
  document.getElementById("f-photo").addEventListener("change", handlePhotoChange);
  document.getElementById("cancelEditBtn").addEventListener("click", () => {
    if (confirmDiscardItemEdits()) resetForm();
  });
  // Closing/reloading the page with unsaved item or settings edits.
  window.addEventListener("beforeunload", (e) => {
    if (itemFormIsDirty() || settingsFormIsDirty()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  document.getElementById("openPhotoLibraryBtn").addEventListener("click", openPhotoLibrary);
  Object.keys(TABS).forEach((key) => {
    document.getElementById(TABS[key].btnId).addEventListener("click", () => switchTab(key));
  });
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
