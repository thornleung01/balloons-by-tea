/* Admin "Categories" tab (collections table) plus collectionsCache, which
   the Products tab, the item form's category dropdown and js/admin-gallery.js
   all read. Loaded before js/admin-products.js. Uses helpers from
   js/admin-core.js. */

/* ===== Collections ===== */

let collectionsCache = [];
let collectionsLoadError = null; // message from the last failed load, for the list's error state
let currentCollectionEditId = null;
let currentCollectionPhotoFile = null;
/* The form's values when it was last loaded/reset — compared against for
   the unsaved-changes check (same pattern as js/admin-faq.js). */
let collectionFormSnapshot = null;

function collectionFormValues() {
  return JSON.stringify([
    document.getElementById("c-title").value,
    document.getElementById("c-tagline").value,
    document.getElementById("c-sort").value,
    currentCollectionPhotoFile ? [currentCollectionPhotoFile.name, currentCollectionPhotoFile.size] : null
  ]);
}

function markCollectionFormClean() {
  collectionFormSnapshot = collectionFormValues();
}

function collectionFormIsDirty() {
  if (collectionFormSnapshot === null) return false;
  return collectionFormValues() !== collectionFormSnapshot;
}

function slugify(text) {
  return String(text).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "category";
}

async function loadCollectionsCache() {
  const client = getSupabaseClient();
  const { data, error } = await client.from("collections").select("*").order("sort_order", { ascending: true });
  collectionsLoadError = error ? error.message : null;
  if (error) return;
  collectionsCache = data || [];
  const select = document.getElementById("f-collection");
  if (select) {
    // Rebuilding the dropdown can change the item form's value (e.g. after a
    // category is deleted); that isn't an edit, so a clean form stays clean.
    const itemFormWasClean = typeof itemFormIsDirty === "function" && typeof markItemFormClean === "function"
      && itemFormSnapshot !== null && !itemFormIsDirty();
    const prev = select.value;
    select.innerHTML = collectionsCache.map((c) => `<option value="${escapeHtml(c.slug)}">${escapeHtml(c.title)}</option>`).join("");
    if ([...select.options].some((o) => o.value === prev)) select.value = prev;
    if (itemFormWasClean) markItemFormClean();
  }
}

let collectionsLoadedOnce = false;

function collectionSkeletonRows(count) {
  return `<div class="collection-skeleton" role="status" aria-label="Loading categories">${'<span class="a-skeleton"></span>'.repeat(count)}</div>`;
}

async function refreshCollectionList() {
  const listEl = document.getElementById("collectionList");
  if (!collectionsLoadedOnce) listEl.innerHTML = collectionSkeletonRows(4);
  await loadCollectionsCache();

  if (collectionsLoadError && !collectionsCache.length) {
    listEl.innerHTML = `
      <div class="a-inline-error" role="alert">
        <span>Couldn't load categories: ${escapeHtml(collectionsLoadError)}</span>
        <button type="button" class="btn btn-outline btn-sm" id="retryCollectionsBtn">Try again</button>
      </div>`;
    document.getElementById("retryCollectionsBtn").addEventListener("click", refreshCollectionList);
    return;
  }
  collectionsLoadedOnce = true;

  if (!collectionsCache.length) {
    listEl.innerHTML = `
      <div class="a-empty">
        <p class="a-empty-title">No categories yet</p>
        <p class="a-empty-text">Add a category with the form. Products are grouped under categories, and each one gets its own page on the site.</p>
      </div>`;
    return;
  }

  const client = getSupabaseClient();
  const { data: productRows } = await client.from("products").select("collection");
  const usedSlugs = new Set((productRows || []).map((p) => p.collection));
  // Counts for display: every product row that points at the category (Trash included,
  // because those still block deleting it).
  const productCounts = {};
  (productRows || []).forEach((p) => { productCounts[p.collection] = (productCounts[p.collection] || 0) + 1; });

  listEl.innerHTML = collectionsCache.map((c, i) => {
    const count = productCounts[c.slug] || 0;
    const inUse = usedSlugs.has(c.slug);
    const helperId = `collectionHelp-${c.id}`;
    const helper = c.is_legacy
      ? "Built-in categories can't be deleted."
      : (inUse ? `Can't delete while ${count} product${count === 1 ? "" : "s"} use${count === 1 ? "s" : ""} it (Trash included). Move or delete ${count === 1 ? "it" : "them"} first.` : "");
    return `
    <div class="admin-item-row draggable-row" data-id="${c.id}" data-index="${i}" draggable="${!isRowLocked("collections", c.id)}">
      ${lockHandleMarkup("collections", c.id)}
      <span class="drag-handle" aria-hidden="true" title="Drag to reorder">&#8942;&#8942;</span>
      <div class="admin-item-thumb">${c.card_image_url ? `<img src="${escapeHtml(c.card_image_url)}" alt=""/>` : PRODUCT_THUMB_PLACEHOLDER}</div>
      <div class="admin-item-body">
        <div class="name">${escapeHtml(c.title)}${c.is_legacy ? ' <span class="a-badge a-badge--neutral a-badge--xs">Built-in</span>' : ""}</div>
        <div class="meta">${escapeHtml(c.tagline || "No tagline")}</div>
        <div class="collection-count">${count} product${count === 1 ? "" : "s"}</div>
      </div>
      <div class="admin-item-actions">
        <button type="button" class="edit-btn" data-id="${c.id}" aria-label="Edit ${escapeHtml(c.title)}">Edit</button>
        ${c.is_legacy ? "" : `<button type="button" class="danger delete-btn" data-id="${c.id}" aria-label="Delete ${escapeHtml(c.title)}" ${inUse ? `disabled aria-describedby="${helperId}"` : ""}>Delete</button>`}
        ${helper ? `<p class="collection-helper" id="${helperId}">${escapeHtml(helper)}</p>` : ""}
      </div>
    </div>
  `;
  }).join("");

  listEl.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = collectionsCache.find((c) => String(c.id) === btn.dataset.id);
      if (!row) return;
      if (String(currentCollectionEditId) !== String(row.id) && collectionFormIsDirty()
        && !(await adminConfirm({ title: "Discard unsaved changes?", message: "You have unsaved changes in the category form. Discard them and edit this category instead?", confirmLabel: "Discard and edit", danger: true }))) return;
      startCollectionEdit(row);
    });
  });
  listEl.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleDeleteCollection(btn.dataset.id, usedSlugs));
  });
  wireUpRowReorder(listEl, ".draggable-row", collectionsCache, persistCollectionOrder);
  wireUpLockToggles(listEl, refreshCollectionList);
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
  markCollectionFormClean();
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
  markCollectionFormClean();
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
    await adminAlert(`Can't delete "${row.title}": it still has products assigned to it. Move or delete those products first.`, { title: "Category in use" });
    return;
  }
  if (!(await adminConfirm({ title: `Delete category "${row.title}"?`, message: "This can't be undone.", confirmLabel: "Delete category", danger: true }))) return;
  const client = getSupabaseClient();
  const { error } = await mustAffect(client.from("collections").delete().eq("id", id));
  if (error) { adminToast("Couldn't delete: " + error.message, { kind: "error" }); return; }
  if (String(currentCollectionEditId) === String(id)) resetCollectionForm(); // number (DB) vs string (data-id)
  await refreshCollectionList();
}

/* Category lookups used by the Products tab. */

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

registerAdminTab("collections", { btnId: "tabCollectionsBtn", panelId: "collectionsPanel", onEnter: refreshCollectionList });

registerAdminDirtyCheck(collectionFormIsDirty);

onAdminInit(() => {
  document.getElementById("collectionForm").addEventListener("submit", handleSaveCollection);
  document.getElementById("c-photo").addEventListener("change", handleCollectionPhotoChange);
  document.getElementById("cancelCollectionEditBtn").addEventListener("click", async () => {
    if (collectionFormIsDirty() && !(await adminConfirm({ title: "Discard unsaved changes?", message: "Discard your changes to this category?", confirmLabel: "Discard", danger: true }))) return;
    resetCollectionForm();
  });
  markCollectionFormClean();
  wireClickablePhotoPreview("collectionPhotoPreview");
  wireClickableThumbList("collectionList", (id) => {
    const c = collectionsCache.find((d) => String(d.id) === String(id));
    return { urls: c && c.card_image_url ? [c.card_image_url] : [], index: 0 };
  });
});
