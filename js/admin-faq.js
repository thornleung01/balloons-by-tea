/* Admin "FAQ" tab (faq_items table). Uses helpers from js/admin-core.js;
   version history from js/admin-content-history.js (loaded later, called
   at runtime). */

/* ===== FAQ items ===== */

let faqCache = [];
let currentFaqEditId = null;
/* The form's values when it was last loaded/reset — compared against for
   the unsaved-changes check. */
let faqFormSnapshot = null;

function faqFormValues() {
  return JSON.stringify([
    document.getElementById("fq-question").value,
    document.getElementById("fq-answer").value,
    document.getElementById("fq-sort").value,
    document.getElementById("fq-open").checked
  ]);
}

function markFaqFormClean() {
  faqFormSnapshot = faqFormValues();
}

function faqFormIsDirty() {
  if (faqFormSnapshot === null) return false;
  return faqFormValues() !== faqFormSnapshot;
}

/* The fields a history snapshot keeps for each FAQ row. */
function faqSnapshotRow(f) {
  return { id: f.id, question: f.question || "", answer: f.answer || "", sort_order: f.sort_order || 0, is_open_default: !!f.is_open_default };
}

async function fetchFaqSnapshot() {
  const client = getSupabaseClient();
  const { data, error } = await client.from("faq_items").select("id,question,answer,sort_order,is_open_default").order("sort_order", { ascending: true }).order("id", { ascending: true });
  if (error) throw error;
  return (data || []).map(faqSnapshotRow);
}

/* Before a write: if there's no FAQ history yet, keep the current list as
   the first version. After a write: record the new list. Both never block
   or fail the save itself. */
async function faqHistoryBeforeWrite() {
  if (typeof ensureContentHistoryBaseline === "function") {
    const snapshot = faqCache.map(faqSnapshotRow);
    await ensureContentHistoryBaseline("faq", async () => snapshot);
  }
}
function faqHistoryAfterWrite(note) {
  if (typeof recordContentHistory === "function") recordContentHistory("faq", fetchFaqSnapshot, note);
}

async function refreshFaqList() {
  const client = getSupabaseClient();
  const { data, error } = await client.from("faq_items").select("*").order("sort_order", { ascending: true });
  const listEl = document.getElementById("faqList");
  if (faqFormSnapshot === null) markFaqFormClean();
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
      if (!row) return;
      if (String(currentFaqEditId) !== String(row.id) && faqFormIsDirty() && !confirm("You have unsaved changes in the FAQ form. Discard them and edit this item instead?")) return;
      startFaqEdit(row);
    });
  });
  listEl.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleDeleteFaq(btn.dataset.id));
  });
  wireUpRowReorder(listEl, ".draggable-row", faqCache, persistFaqOrder);
  wireUpLockToggles(listEl, refreshFaqList);
}

async function persistFaqOrder(cache) {
  await faqHistoryBeforeWrite();
  await persistSortOrder("faq_items", cache, refreshFaqList);
  faqHistoryAfterWrite("Reordered questions");
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
  markFaqFormClean();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetFaqForm() {
  currentFaqEditId = null;
  document.getElementById("faqForm").reset();
  document.getElementById("faqFormTitle").textContent = "Add FAQ Item";
  document.getElementById("saveFaqBtn").textContent = "Add FAQ Item";
  hide(document.getElementById("cancelFaqEditBtn"));
  document.getElementById("faqFormStatus").textContent = "";
  markFaqFormClean();
}

async function handleSaveFaq(e) {
  e.preventDefault();
  const client = getSupabaseClient();
  const saveBtn = document.getElementById("saveFaqBtn");
  const statusEl = document.getElementById("faqFormStatus");
  if (saveBtn.disabled) return; // a save is already running (e.g. Ctrl+S twice)

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
    await faqHistoryBeforeWrite();
    let error;
    if (currentFaqEditId) {
      ({ error } = await mustAffect(client.from("faq_items").update(payload).eq("id", currentFaqEditId)));
    } else {
      ({ error } = await client.from("faq_items").insert(payload));
    }
    if (error) throw error;

    const message = currentFaqEditId ? "FAQ item updated." : "FAQ item added.";
    faqHistoryAfterWrite(`${currentFaqEditId ? "Edited" : "Added"} "${question.slice(0, 80)}"`);
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
  if (!confirm("Delete this FAQ item? You can bring it back from History.")) return;
  const client = getSupabaseClient();
  const row = faqCache.find((f) => String(f.id) === String(id));
  await faqHistoryBeforeWrite();
  const { error } = await mustAffect(client.from("faq_items").delete().eq("id", id));
  if (error) { alert("Couldn't delete: " + error.message); return; }
  faqHistoryAfterWrite(`Deleted "${row ? String(row.question).slice(0, 80) : "a question"}"`);
  if (String(currentFaqEditId) === String(id)) resetFaqForm(); // number (DB) vs string (data-id)
  await refreshFaqList();
}

/* ----- Version history ----- */

function describeFaqDiff(snapshot, current) {
  const snap = Array.isArray(snapshot) ? snapshot : [];
  const now = Array.isArray(current) ? current : [];
  const nowById = new Map(now.map((r) => [String(r.id), r]));
  const snapIds = new Set(snap.map((r) => String(r.id)));
  const changes = [];
  snap.forEach((r) => {
    const cur = nowById.get(String(r.id));
    if (!cur) { changes.push({ label: `Brings back "${truncateFaqLabel(r.question)}"` }); return; }
    if (cur.question !== r.question) changes.push({ label: "Question", from: cur.question, to: r.question });
    if (cur.answer !== r.answer) changes.push({ label: `Answer to "${truncateFaqLabel(r.question)}"`, from: cur.answer, to: r.answer });
    if (!!cur.is_open_default !== !!r.is_open_default) changes.push({ label: `"${truncateFaqLabel(r.question)}" ${r.is_open_default ? "opens" : "stops opening"} by default` });
  });
  now.forEach((r) => {
    if (!snapIds.has(String(r.id))) changes.push({ label: `Removes "${truncateFaqLabel(r.question)}"` });
  });
  const orderOf = (rows) => rows.slice().sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id)).map((r) => String(r.id)).filter((id) => snapIds.has(id) && nowById.has(id)).join(",");
  if (orderOf(snap) !== orderOf(now)) changes.push({ label: "Question order" });
  return changes;
}

function truncateFaqLabel(q) {
  const s = String(q || "");
  return s.length > 50 ? s.slice(0, 49) + "…" : s;
}

/* Makes faq_items match the snapshot. Rows keep their id where they still
   exist; a deleted row comes back as a new row (ids can't be reused), so
   any on-page edit-mode tweak made to that question doesn't come back. */
async function restoreFaqSnapshot(snapshot) {
  const client = getSupabaseClient();
  const snap = Array.isArray(snapshot) ? snapshot : [];
  const current = await fetchFaqSnapshot();
  const curById = new Map(current.map((r) => [String(r.id), r]));
  const snapIds = new Set(snap.map((r) => String(r.id)));
  const failures = [];

  for (const r of current) {
    if (snapIds.has(String(r.id))) continue;
    const { error } = await mustAffect(client.from("faq_items").delete().eq("id", r.id));
    if (error) failures.push(error.message);
  }
  for (const r of snap) {
    const payload = { question: r.question, answer: r.answer, sort_order: Math.max(0, r.sort_order || 0), is_open_default: !!r.is_open_default };
    const cur = curById.get(String(r.id));
    if (cur) {
      const same = cur.question === payload.question && cur.answer === payload.answer && cur.sort_order === payload.sort_order && cur.is_open_default === payload.is_open_default;
      if (same) continue;
      const { error } = await mustAffect(client.from("faq_items").update(payload).eq("id", r.id));
      if (error) failures.push(error.message);
    } else {
      const { error } = await client.from("faq_items").insert(payload);
      if (error) failures.push(error.message);
    }
  }
  resetFaqForm();
  await refreshFaqList();
  if (failures.length) throw new Error(`${failures.length} change${failures.length === 1 ? "" : "s"} failed (${failures[0]})`);
}

function openFaqHistory() {
  if (typeof openContentHistory !== "function") return;
  openContentHistory("faq", {
    title: "FAQ history",
    getCurrent: fetchFaqSnapshot,
    diff: describeFaqDiff,
    beforeRestore: () => {
      if (!faqFormIsDirty()) return true;
      return confirm("You have unsaved changes in the FAQ form. Restoring will clear the form. Continue?");
    },
    restore: restoreFaqSnapshot
  });
}

registerAdminTab("faq", { btnId: "tabFaqBtn", panelId: "faqPanel", onEnter: refreshFaqList });

registerAdminDirtyCheck(faqFormIsDirty);

onAdminInit(() => {
  document.getElementById("faqForm").addEventListener("submit", handleSaveFaq);
  document.getElementById("cancelFaqEditBtn").addEventListener("click", () => {
    if (faqFormIsDirty() && !confirm("Discard your changes to this FAQ item?")) return;
    resetFaqForm();
  });

  // "History" button next to the list heading (added here rather than in
  // admin.html so the FAQ markup stays as it was).
  const listCard = document.getElementById("faqList") && document.getElementById("faqList").closest(".admin-card");
  const heading = listCard && listCard.querySelector("h2");
  if (heading && !document.getElementById("faqHistoryBtn")) {
    const head = document.createElement("div");
    head.className = "faq-list-head";
    heading.replaceWith(head);
    head.appendChild(heading);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-outline btn-sm";
    btn.id = "faqHistoryBtn";
    btn.textContent = "History";
    btn.addEventListener("click", openFaqHistory);
    head.appendChild(btn);
  }
});
