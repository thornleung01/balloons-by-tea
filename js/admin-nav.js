/* Admin "Nav" tab (nav_items table). Uses helpers from js/admin-core.js. */

/* ===== Nav items ===== */

let navCache = [];
let currentNavEditId = null;
/* The form's values when it was last loaded/reset — compared against for
   the unsaved-changes check (same pattern as js/admin-faq.js). */
let navFormSnapshot = null;

function navFormValues() {
  return JSON.stringify([
    document.getElementById("n-label").value,
    document.getElementById("n-href").value,
    document.getElementById("n-icon").value,
    document.getElementById("n-sort").value,
    document.getElementById("n-visible").checked
  ]);
}

function markNavFormClean() {
  navFormSnapshot = navFormValues();
}

function navFormIsDirty() {
  if (navFormSnapshot === null) return false;
  return navFormValues() !== navFormSnapshot;
}

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
        <div class="name">${escapeHtml(n.label)} ${n.key ? '<span class="form-status a-inline">(built-in)</span>' : ""}</div>
        <div class="meta">${escapeHtml(n.href)} ${n.visible === false ? "&middot; hidden" : ""}</div>
      </div>
      <div class="admin-item-actions">
        <label class="toggle-switch" title="${n.visible === false ? "Hidden, click to show in nav" : "Showing in nav, click to hide"}">
          <input type="checkbox" class="nav-visible-toggle" data-id="${n.id}" aria-label="Show &quot;${escapeHtml(n.label)}&quot; in nav"${n.visible !== false ? "checked" : ""}/>
          <span class="toggle-slider"></span>
        </label>
        <button type="button" class="edit-btn" data-id="${n.id}">Edit</button>
        ${n.key ? "" : `<button type="button" class="danger delete-btn" data-id="${n.id}">Delete</button>`}
      </div>
    </div>
  `).join("");

  listEl.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = navCache.find((n) => String(n.id) === btn.dataset.id);
      if (!row) return;
      if (String(currentNavEditId) !== String(row.id) && navFormIsDirty()
        && !(await adminConfirm({ title: "Discard unsaved changes?", message: "You have unsaved changes in the nav form. Discard them and edit this item instead?", confirmLabel: "Discard and edit", danger: true }))) return;
      startNavEdit(row);
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
    adminToast("Couldn't update: " + error.message, { kind: "error" });
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
  markNavFormClean();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetNavForm() {
  currentNavEditId = null;
  document.getElementById("navForm").reset();
  document.getElementById("navFormTitle").textContent = "Add Nav Item";
  document.getElementById("saveNavBtn").textContent = "Add Nav Item";
  hide(document.getElementById("cancelNavEditBtn"));
  document.getElementById("navFormStatus").textContent = "";
  markNavFormClean();
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
  if (!(await adminConfirm({ title: `Delete nav item "${row.label}"?`, message: "This can't be undone.", confirmLabel: "Delete nav item", danger: true }))) return;
  const client = getSupabaseClient();
  const { error } = await mustAffect(client.from("nav_items").delete().eq("id", id));
  if (error) { adminToast("Couldn't delete: " + error.message, { kind: "error" }); return; }
  if (String(currentNavEditId) === String(id)) resetNavForm(); // number (DB) vs string (data-id)
  await refreshNavList();
}

registerAdminTab("nav", { btnId: "tabNavBtn", panelId: "navPanel", onEnter: refreshNavList });

registerAdminDirtyCheck(navFormIsDirty);

onAdminInit(() => {
  document.getElementById("navForm").addEventListener("submit", handleSaveNav);
  document.getElementById("cancelNavEditBtn").addEventListener("click", async () => {
    if (navFormIsDirty() && !(await adminConfirm({ title: "Discard unsaved changes?", message: "Discard your changes to this nav item?", confirmLabel: "Discard", danger: true }))) return;
    resetNavForm();
  });
  markNavFormClean();
});
