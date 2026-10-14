/* Admin "FAQ" tab (faq_items table). Uses helpers from js/admin-core.js. */

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

registerAdminTab("faq", { btnId: "tabFaqBtn", panelId: "faqPanel", onEnter: refreshFaqList });

onAdminInit(() => {
  document.getElementById("faqForm").addEventListener("submit", handleSaveFaq);
  document.getElementById("cancelFaqEditBtn").addEventListener("click", resetFaqForm);
});
