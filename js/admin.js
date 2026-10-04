/*
  Admin page logic. Talks directly to Supabase from the browser — there's
  no custom backend server. Real security comes from Supabase's Row Level
  Security policies (see supabase-setup.sql): anyone can read products, but
  only a logged-in user can write. This file just has to not trust anything
  the page itself claims — hence escapeHtml() on every field when rendering
  the item list.
*/

let currentEditId = null;
let currentPhotoFile = null;

const HTML_ESCAPE_MAP = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
};
function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => HTML_ESCAPE_MAP[c]);
}

function collectionTitle(slug) {
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
  await refreshItemList();
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
          <div class="admin-item-thumb">${item.image_url ? `<img src="${escapeHtml(item.image_url)}" alt=""/>` : ""}</div>
          <div class="admin-item-body">
            <div class="name">${escapeHtml(item.name)}</div>
            <div class="meta">$${Number(item.price).toFixed(0)} ${item.active === false ? "&middot; hidden" : ""}</div>
          </div>
          <div class="admin-item-actions">
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
}

/* ===== Form (add / edit) ===== */

function startEdit(item) {
  currentEditId = item.id;
  currentPhotoFile = null;
  document.getElementById("f-collection").value = item.collection;
  document.getElementById("f-name").value = item.name || "";
  document.getElementById("f-price").value = item.price || 0;
  document.getElementById("f-description").value = item.description || "";
  document.getElementById("f-style").value = item.style || "";
  document.getElementById("f-active").checked = item.active !== false;
  document.getElementById("f-photo").value = "";

  const preview = document.getElementById("photoPreview");
  preview.innerHTML = item.image_url ? `<img src="${escapeHtml(item.image_url)}" alt=""/>` : "No photo";

  document.getElementById("formTitle").textContent = "Edit Item";
  document.getElementById("saveBtn").textContent = "Update Item";
  show(document.getElementById("cancelEditBtn"));
  setFormStatus("", null);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetForm() {
  currentEditId = null;
  currentPhotoFile = null;
  document.getElementById("itemForm").reset();
  document.getElementById("photoPreview").innerHTML = "No photo";
  document.getElementById("formTitle").textContent = "Add Item";
  document.getElementById("saveBtn").textContent = "Add Item";
  hide(document.getElementById("cancelEditBtn"));
  setFormStatus("", null);
}

async function handlePhotoChange(e) {
  const file = e.target.files[0];
  currentPhotoFile = file || null;
  const preview = document.getElementById("photoPreview");
  if (!file) {
    preview.innerHTML = "No photo";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => { preview.innerHTML = `<img src="${reader.result}" alt=""/>`; };
  reader.readAsDataURL(file);
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
    if (currentPhotoFile) {
      const safeName = currentPhotoFile.name.replace(/[^a-zA-Z0-9.-]/g, "_");
      const path = `${Date.now()}-${safeName}`;
      const { error: uploadError } = await client.storage
        .from("product-photos")
        .upload(path, currentPhotoFile, { upsert: true });
      if (uploadError) throw new Error("Photo upload failed: " + uploadError.message);
      const { data: pub } = client.storage.from("product-photos").getPublicUrl(path);
      payload.image_url = pub.publicUrl;
    }

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

  const { data: { session } } = await client.auth.getSession();
  if (session) {
    await enterDashboard();
  } else {
    showLoginView();
  }
});
