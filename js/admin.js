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

function collectionTitle(slug) {
  const live = collectionsCache.find((c) => c.slug === slug);
  if (live) return live.title;
  return (window.COLLECTIONS && window.COLLECTIONS[slug] && window.COLLECTIONS[slug].title) || slug;
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

  if (!data || !data.length) {
    listEl.innerHTML = `<p class="empty-note">No items yet — add your first one on the left.</p>`;
    return;
  }

  const bySlug = {};
  data.forEach((item) => {
    const slug = item.collection;
    if (!bySlug[slug]) bySlug[slug] = [];
    bySlug[slug].push(item);
  });

  listEl.innerHTML = Object.keys(bySlug).map((slug) => `
    <div class="collection-group">
      <h3>${escapeHtml(collectionTitle(slug))}</h3>
      ${bySlug[slug].map((item) => `
        <div class="admin-item-row ${item.active === false ? "inactive" : ""}" data-id="${item.id}">
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
            <button type="button" class="danger delete-btn" data-id="${item.id}">Delete</button>
          </div>
        </div>
      `).join("")}
    </div>
  `).join("");

  listEl.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = data.find((d) => String(d.id) === btn.dataset.id);
      if (item) startEdit(item);
    });
  });
  listEl.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleDelete(btn.dataset.id, data));
  });
  listEl.querySelectorAll(".active-toggle").forEach((toggle) => {
    toggle.addEventListener("change", () => handleToggleActive(toggle.dataset.id, toggle.checked, toggle));
  });
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

let draggedPhotoIndex = null;

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

  gallery.querySelectorAll(".photo-gallery-item").forEach((item) => {
    item.addEventListener("dragstart", () => {
      draggedPhotoIndex = Number(item.dataset.index);
      item.classList.add("dragging");
    });
    item.addEventListener("dragend", () => {
      item.classList.remove("dragging");
      draggedPhotoIndex = null;
    });
    item.addEventListener("dragover", (e) => {
      e.preventDefault();
      item.classList.add("drag-over");
    });
    item.addEventListener("dragleave", () => item.classList.remove("drag-over"));
    item.addEventListener("drop", (e) => {
      e.preventDefault();
      item.classList.remove("drag-over");
      const targetIndex = Number(item.dataset.index);
      if (draggedPhotoIndex === null || draggedPhotoIndex === targetIndex) return;
      const [moved] = currentPhotoEntries.splice(draggedPhotoIndex, 1);
      currentPhotoEntries.splice(targetIndex, 0, moved);
      renderPhotoGallery();
    });
  });
}

/* ===== Photo preview modal — reuses the public site's lightbox CSS
   classes (loaded via css/styles.css) without needing js/app.js, which
   wires up unrelated cart/checkout/nav behavior admin.html doesn't want. */
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
  modal.querySelector(".lightbox-img").src = photoEntryPreviewUrl(currentPhotoEntries[previewIndex]);
  const multi = currentPhotoEntries.length > 1;
  modal.querySelector(".lightbox-prev").hidden = !multi;
  modal.querySelector(".lightbox-next").hidden = !multi;
}

function stepPhotoPreview(delta) {
  if (currentPhotoEntries.length < 2) return;
  previewIndex = (previewIndex + delta + currentPhotoEntries.length) % currentPhotoEntries.length;
  renderPhotoPreviewFrame();
}

function openPhotoPreview(index) {
  const modal = ensurePhotoPreviewModal();
  previewIndex = index;
  renderPhotoPreviewFrame();
  modal.classList.add("open");
}

function closePhotoPreview() {
  const modal = document.getElementById("adminPhotoPreview");
  if (modal) modal.classList.remove("open");
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

/* ===== Tabs ===== */

const TABS = {
  products: { btnId: "tabProductsBtn", panelId: "productsPanel" },
  orders: { btnId: "tabOrdersBtn", panelId: "ordersPanel", onEnter: refreshOrderList },
  collections: { btnId: "tabCollectionsBtn", panelId: "collectionsPanel", onEnter: refreshCollectionList },
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

  listEl.innerHTML = collectionsCache.map((c) => `
    <div class="admin-item-row" data-id="${c.id}">
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
    sort_order: parseInt(document.getElementById("c-sort").value, 10) || 0
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

  listEl.innerHTML = navCache.map((n) => `
    <div class="admin-item-row ${n.visible === false ? "inactive" : ""}" data-id="${n.id}">
      <div class="admin-item-body">
        <div class="name">${escapeHtml(n.label)} ${n.key ? '<span class="form-status" style="display:inline;">(built-in)</span>' : ""}</div>
        <div class="meta">${escapeHtml(n.href)} ${n.visible === false ? "&middot; hidden" : ""}</div>
      </div>
      <div class="admin-item-actions">
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
    sort_order: parseInt(document.getElementById("n-sort").value, 10) || 0,
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

  listEl.innerHTML = faqCache.map((f) => `
    <div class="admin-item-row" data-id="${f.id}">
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
    sort_order: parseInt(document.getElementById("fq-sort").value, 10) || 0,
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

  const filtered = (data || []).filter((o) => ordersStatusFilter === "all" || (o.status || "new") === ordersStatusFilter);

  if (!filtered.length) {
    listEl.innerHTML = `<p class="empty-note">No orders ${ordersStatusFilter === "all" ? "yet" : "with this status"}.</p>`;
    return;
  }

  listEl.innerHTML = filtered.map((order) => {
    const status = order.status || "new";
    return `
    <div class="order-row status-${escapeHtml(status)}" data-id="${order.id}">
      <div class="order-row-head">
        <div>
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

  document.getElementById("collectionForm").addEventListener("submit", handleSaveCollection);
  document.getElementById("c-photo").addEventListener("change", handleCollectionPhotoChange);
  document.getElementById("cancelCollectionEditBtn").addEventListener("click", resetCollectionForm);

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
