/*
  Live visual edit mode — admin-only direct manipulation of the public
  page, toggled by a floating button that only appears when a Supabase
  auth session exists (the same login used for admin.html). Everything
  this writes lands in the layout_overrides table via
  saveLayoutOverride()/clearLayoutOverride() (js/layout-editor.js), which
  is what every visitor's applyLayoutOverrides() call then reads back.

  A non-admin visitor never sees any of this: the toggle button is never
  created unless the session check succeeds, and nothing in this file
  runs before that check passes.
*/

let editModeActive = false;

async function initEditMode() {
  const client = typeof getSupabaseClient === "function" ? getSupabaseClient() : null;
  if (!client) return;

  let session;
  try {
    ({ data: { session } } = await client.auth.getSession());
  } catch (err) {
    return;
  }
  if (!session) return;

  buildEditModeToggle();
}

function buildEditModeToggle() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "editModeToggle";
  btn.className = "edit-mode-toggle";
  btn.setAttribute("aria-pressed", "false");
  btn.title = "Toggle edit mode";
  btn.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  document.body.appendChild(btn);
  btn.addEventListener("click", () => setEditMode(!editModeActive));

  const historyBtn = document.createElement("button");
  historyBtn.type = "button";
  historyBtn.id = "editHistoryToggle";
  historyBtn.className = "edit-mode-toggle edit-history-toggle";
  historyBtn.title = "Change history";
  historyBtn.hidden = true;
  historyBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7" stroke-linecap="round"/><path d="M3 4v4.5h4.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 8v4l3 2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  document.body.appendChild(historyBtn);
  historyBtn.addEventListener("click", () => toggleHistoryPanel());
}

function setEditMode(on) {
  editModeActive = on;
  const btn = document.getElementById("editModeToggle");
  btn.classList.toggle("active", on);
  btn.setAttribute("aria-pressed", String(on));
  document.body.classList.toggle("edit-mode-active", on);
  document.getElementById("editHistoryToggle").hidden = !on;

  if (on) {
    revealHiddenForEditing();
    renderEditHandles();
  } else {
    selectedKeys.clear();
    renderSelectionToolbar();
    removeEditHandles();
    applyLayoutOverrides();
    closeHistoryPanel();
  }
}

document.addEventListener("click", (e) => {
  if (!editModeActive || !selectedKeys.size) return;
  if (e.target.closest("[data-edit-key], .edit-selection-bar, .edit-history-panel, .edit-mode-toggle")) return;
  clearSelection();
});

/* ===== Change history / revert ===== */

async function toggleHistoryPanel() {
  const existing = document.getElementById("editHistoryPanel");
  if (existing) { closeHistoryPanel(); return; }

  const panel = document.createElement("div");
  panel.id = "editHistoryPanel";
  panel.className = "edit-history-panel";
  panel.innerHTML = `
    <div class="edit-history-head">
      <strong>Change history</strong>
      <button type="button" class="edit-icon-btn" id="editHistoryClose" aria-label="Close">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 5l14 14M19 5L5 19" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="edit-history-list" id="editHistoryList"><p class="edit-history-empty">Loading…</p></div>
  `;
  document.body.appendChild(panel);
  document.getElementById("editHistoryClose").addEventListener("click", closeHistoryPanel);
  await loadHistoryList();
}

function closeHistoryPanel() {
  const panel = document.getElementById("editHistoryPanel");
  if (panel) panel.remove();
}

function describeHistoryRow(row) {
  const labels = { "padding-bottom": "spacing", "font-size": "text size", scale: "size", hidden: "visibility", locked: "lock" };
  const propLabel = labels[row.property] || row.property;
  const niceKey = row.element_key.startsWith("product:") ? "product card" : row.element_key.replace(/-/g, " ");
  return `${niceKey} — ${propLabel}`;
}

async function loadHistoryList() {
  const listEl = document.getElementById("editHistoryList");
  if (!listEl) return;
  const client = getSupabaseClient();
  const page = document.body.dataset.page || "";
  const { data, error } = await client
    .from("layout_overrides_history")
    .select("*")
    .eq("page", page)
    .order("changed_at", { ascending: false })
    .limit(30);

  if (error) {
    listEl.innerHTML = `<p class="edit-history-empty">Couldn't load history: ${error.message}</p>`;
    return;
  }
  if (!data || !data.length) {
    listEl.innerHTML = `<p class="edit-history-empty">No changes yet.</p>`;
    return;
  }

  listEl.innerHTML = data.map((row) => `
    <div class="edit-history-row" data-history-id="${row.id}">
      <div class="edit-history-row-main">
        <div class="edit-history-what">${describeHistoryRow(row)}</div>
        <div class="edit-history-when">${new Date(row.changed_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>
      </div>
      <button type="button" class="edit-history-revert-btn" data-revert-id="${row.id}">Revert</button>
    </div>
  `).join("");

  listEl.querySelectorAll("[data-revert-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = data.find((r) => String(r.id) === btn.dataset.revertId);
      if (row) revertHistoryRow(row);
    });
  });
}

/* applyLayoutOverrides() only ever ADDS inline styles for overrides that
   currently exist — on a fresh page load there's nothing stale to clear,
   so that's fine there. But a revert happening live, in the same session
   as the original drag, needs to actively remove/replace whatever inline
   style that drag already set; otherwise the DOM just keeps showing the
   old value even after the override is deleted underneath it. */
function resetElementStyle(el, property, value) {
  if (property === "padding-bottom") el.style.paddingBottom = value || "";
  else if (property === "font-size") el.style.fontSize = value || "";
  else if (property === "scale") el.style.transform = value ? `scale(${value})` : "";
  else if (property === "order") el.style.order = value || "";
}

async function revertHistoryRow(row) {
  try {
    if (row.old_value == null) {
      await clearLayoutOverride(row.element_key, row.property);
    } else {
      await saveLayoutOverride(row.element_key, row.property, row.old_value);
    }

    const el = document.querySelector(`[data-edit-key="${CSS.escape(row.element_key)}"]`);
    if (el) {
      if (row.property === "hidden") {
        el.classList.toggle("edit-is-hidden", row.old_value === "true");
        if (!editModeActive) el.style.display = row.old_value === "true" ? "none" : "";
      } else {
        resetElementStyle(el, row.property, row.old_value);
      }
    }

    if (editModeActive) {
      revealHiddenForEditing();
      renderEditHandles();
    } else {
      applyLayoutOverrides();
    }
    await loadHistoryList();
  } catch (err) {
    alert("Couldn't revert: " + err.message);
  }
}

/* While editing, a "hidden" section/card shows dimmed with a restore
   affordance instead of actually disappearing — otherwise there'd be no
   way to find and unhide it again. True display:none only happens for
   non-admin visitors, applied by the base applyLayoutOverrides() pass. */
function revealHiddenForEditing() {
  document.querySelectorAll("[data-edit-key]").forEach((el) => {
    const key = el.dataset.editKey;
    if (!key) return;
    el.style.display = "";
    const overrides = LAYOUT_OVERRIDES[key];
    if (overrides && overrides.hidden === "true") {
      el.classList.add("edit-is-hidden");
    }
  });
}

function elementEditType(el) {
  if (el.classList.contains("product-card")) return "product";
  if (el.tagName === "H1" || el.classList.contains("hero-sub")) return "text";
  return "section";
}

function removeEditHandles() {
  document.querySelectorAll(".edit-controls, .edit-divider-handle").forEach((el) => el.remove());
  document.querySelectorAll("[data-edit-key]").forEach((el) => el.classList.remove("edit-is-hidden", "edit-is-locked", "edit-selected"));
}

/* ===== Multi-select ("sort of like Figma") =====
   Plain click selects just that element; shift-click adds/removes it from
   the current selection. "Select row" grabs every product card sharing
   the clicked one's visual row (same rounded top offset within its grid
   container) so a whole row can be locked or resized together without
   shift-clicking each card individually. */
let selectedKeys = new Set();

function clearSelection() {
  selectedKeys.clear();
  document.querySelectorAll(".edit-selected").forEach((el) => el.classList.remove("edit-selected"));
  renderSelectionToolbar();
}

function toggleSelect(key, additive) {
  if (!additive) {
    if (selectedKeys.size === 1 && selectedKeys.has(key)) {
      selectedKeys.clear();
    } else {
      selectedKeys.clear();
      selectedKeys.add(key);
    }
  } else if (selectedKeys.has(key)) {
    selectedKeys.delete(key);
  } else {
    selectedKeys.add(key);
  }
  document.querySelectorAll("[data-edit-key]").forEach((el) => {
    el.classList.toggle("edit-selected", selectedKeys.has(el.dataset.editKey));
  });
  renderSelectionToolbar();
}

function selectRow(el) {
  const parent = el.parentElement;
  const top = Math.round(el.getBoundingClientRect().top);
  const rowSiblings = Array.from(parent.children).filter(
    (sib) => sib.dataset && sib.dataset.editKey && Math.round(sib.getBoundingClientRect().top) === top
  );
  selectedKeys = new Set(rowSiblings.map((sib) => sib.dataset.editKey));
  document.querySelectorAll("[data-edit-key]").forEach((e) => {
    e.classList.toggle("edit-selected", selectedKeys.has(e.dataset.editKey));
  });
  renderSelectionToolbar();
}

function renderEditHandles() {
  removeEditHandles();
  document.querySelectorAll("[data-edit-key]").forEach((el) => {
    const key = el.dataset.editKey;
    if (!key) return;
    const type = elementEditType(el);
    const locked = !!(LAYOUT_OVERRIDES[key] && LAYOUT_OVERRIDES[key].locked === "true");
    el.classList.toggle("edit-is-locked", locked);
    el.classList.toggle("edit-selected", selectedKeys.has(key));

    const controls = document.createElement("div");
    controls.className = "edit-controls";
    controls.innerHTML = `
      <button type="button" class="edit-icon-btn lock-btn ${locked ? "is-locked" : ""}" title="${locked ? "Locked, click to unlock" : "Lock in place"}" aria-label="${locked ? "Unlock" : "Lock"}">${locked
        ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
        : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>'
      }</button>
      ${type === "section" ? `<button type="button" class="edit-icon-btn hide-btn" title="Hide this section" aria-label="Hide section"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12s3.5-7 9-7 9 7 9 7-3.5 7-9 7-9-7-9-7Z"/><circle cx="12" cy="12" r="2.5"/></svg></button>` : ""}
      ${type === "product" ? `<button type="button" class="edit-icon-btn remove-btn" title="Remove from site" aria-label="Remove product"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 5l14 14M19 5L5 19" stroke-linecap="round"/></svg></button>` : ""}
      ${type === "product" ? `<button type="button" class="edit-icon-btn select-row-btn" title="Select this whole row" aria-label="Select row"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="9" width="5" height="6" rx="1"/><rect x="9.5" y="9" width="5" height="6" rx="1"/><rect x="16" y="9" width="5" height="6" rx="1"/></svg></button>` : ""}
    `;
    el.appendChild(controls);

    if (type !== "section" && !locked) {
      const resizeHandle = document.createElement("span");
      resizeHandle.className = "edit-resize-handle";
      resizeHandle.title = "Drag to resize";
      el.appendChild(resizeHandle);
      wireResizeHandle(el, key, type, resizeHandle);
    }

    if (type === "section" && !locked) {
      const divider = document.createElement("div");
      divider.className = "edit-divider-handle";
      divider.title = "Drag to adjust space below this section";
      el.appendChild(divider);
      wireSectionDivider(el, key, divider);
    }

    controls.querySelector(".lock-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleLock(key, !locked);
    });
    const hideBtn = controls.querySelector(".hide-btn");
    if (hideBtn) hideBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleHidden(el, key); });
    const removeBtn = controls.querySelector(".remove-btn");
    if (removeBtn) removeBtn.addEventListener("click", (e) => { e.stopPropagation(); removeProduct(el, key); });
    const selectRowBtn = controls.querySelector(".select-row-btn");
    if (selectRowBtn) selectRowBtn.addEventListener("click", (e) => { e.stopPropagation(); selectRow(el); });

    /* Capture phase, not bubble: .product-art and .add-btn have their own
       click listeners (open lightbox / add to cart) registered directly on
       themselves in app.js. A bubble-phase listener here would fire too
       late — those descendant listeners already ran. Capturing on the way
       down lets us intercept and stopPropagation() before the event ever
       reaches them.
       Every [data-edit-key] element gets one of these (sections AND the
       product cards nested inside them), and capture fires outside-in, so
       without the closest() check below a section would always win the
       click before it ever reached the card nested inside it. Only the
       innermost matching element should handle the click — everything
       else just lets it keep capturing downward. */
    el.addEventListener("click", (e) => {
      if (e.target.closest(".edit-controls, .edit-resize-handle, .edit-divider-handle")) return;
      if (e.target.closest("[data-edit-key]") !== el) return;
      e.preventDefault();
      e.stopPropagation();
      toggleSelect(key, e.shiftKey);
    }, true);
  });
}

/* ===== Group toolbar (shown once 1+ elements are selected) ===== */

function renderSelectionToolbar() {
  let bar = document.getElementById("editSelectionBar");
  if (!selectedKeys.size) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "editSelectionBar";
    bar.className = "edit-selection-bar";
    document.body.appendChild(bar);
  }
  const allLocked = [...selectedKeys].every((k) => LAYOUT_OVERRIDES[k] && LAYOUT_OVERRIDES[k].locked === "true");
  bar.innerHTML = `
    <span class="edit-selection-count">${selectedKeys.size} selected</span>
    <button type="button" class="edit-icon-btn ${allLocked ? "is-locked" : ""}" id="selectionLockBtn" title="${allLocked ? "Unlock selected" : "Lock selected"}">${allLocked
      ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
      : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>'
    }</button>
    <span class="edit-selection-resize" id="selectionResizeHandle" title="Drag to resize all selected">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v5a2 2 0 0 1-2 2H1M16 21v-5a2 2 0 0 1 2-2h5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </span>
    <button type="button" class="edit-icon-btn" id="selectionClearBtn" title="Clear selection" aria-label="Clear selection">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 5l14 14M19 5L5 19" stroke-linecap="round"/></svg>
    </button>
  `;
  document.getElementById("selectionLockBtn").addEventListener("click", () => groupToggleLock(!allLocked));
  document.getElementById("selectionClearBtn").addEventListener("click", clearSelection);
  wireGroupResizeHandle(document.getElementById("selectionResizeHandle"));
}

async function groupToggleLock(locked) {
  try {
    for (const key of selectedKeys) {
      if (locked) await saveLayoutOverride(key, "locked", "true");
      else await clearLayoutOverride(key, "locked");
    }
    renderEditHandles();
    // renderEditHandles() alone leaves the toolbar's lock button bound to
    // its old "allLocked" closure from the last time the bar was built, so
    // without this the button never flips to its "unlock" label/action.
    renderSelectionToolbar();
  } catch (err) {
    alert("Couldn't update lock: " + err.message);
  }
}

function wireGroupResizeHandle(handle) {
  let startX = 0, startY = 0;
  const startScales = {};

  function onMove(e) {
    const delta = (e.clientX - startX) + (e.clientY - startY);
    selectedKeys.forEach((key) => {
      const el = document.querySelector(`[data-edit-key="${CSS.escape(key)}"]`);
      if (!el || el.classList.contains("edit-is-locked")) return;
      const base = startScales[key] || 1;
      const next = Math.max(0.7, Math.min(1.5, base + delta / 150));
      el.style.transform = `scale(${next})`;
    });
  }
  async function onUp() {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    try {
      for (const key of selectedKeys) {
        const el = document.querySelector(`[data-edit-key="${CSS.escape(key)}"]`);
        if (!el || el.classList.contains("edit-is-locked")) continue;
        const match = /scale\(([\d.]+)\)/.exec(el.style.transform || "");
        if (match) await saveLayoutOverride(key, "scale", match[1]);
      }
    } catch (err) {
      alert("Couldn't save sizes: " + err.message);
    }
  }
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    startX = e.clientX;
    startY = e.clientY;
    selectedKeys.forEach((key) => {
      const el = document.querySelector(`[data-edit-key="${CSS.escape(key)}"]`);
      const m = el ? /scale\(([\d.]+)\)/.exec(el.style.transform || "") : null;
      startScales[key] = m ? parseFloat(m[1]) : 1;
    });
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });
}

async function toggleLock(key, locked) {
  try {
    if (locked) await saveLayoutOverride(key, "locked", "true");
    else await clearLayoutOverride(key, "locked");
    renderEditHandles();
  } catch (err) {
    alert("Couldn't update lock: " + err.message);
  }
}

async function toggleHidden(el, key) {
  const alreadyHidden = el.classList.contains("edit-is-hidden");
  try {
    if (alreadyHidden) {
      await clearLayoutOverride(key, "hidden");
      el.classList.remove("edit-is-hidden");
    } else {
      await saveLayoutOverride(key, "hidden", "true");
      el.classList.add("edit-is-hidden");
    }
  } catch (err) {
    alert("Couldn't update: " + err.message);
  }
}

async function removeProduct(el, key) {
  if (!confirm("Remove this product from the site? You can turn it back on from the Products admin tab.")) return;
  const productId = key.replace("product:", "");
  const client = getSupabaseClient();
  try {
    const { error } = await client.from("products").update({ active: false }).eq("id", productId);
    if (error) throw error;
    el.classList.add("edit-is-hidden");
  } catch (err) {
    alert("Couldn't remove: " + err.message);
  }
}

function wireSectionDivider(el, key, handle) {
  let startY = 0;
  let startPadding = 0;

  function onMove(e) {
    const delta = Math.max(-200, Math.min(200, e.clientY - startY));
    const next = Math.max(0, Math.min(280, startPadding + delta));
    el.style.paddingBottom = next + "px";
  }
  async function onUp() {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    const finalPadding = parseFloat(el.style.paddingBottom) || 0;
    try {
      await saveLayoutOverride(key, "padding-bottom", finalPadding + "px");
    } catch (err) {
      alert("Couldn't save spacing: " + err.message);
    }
  }
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    startY = e.clientY;
    startPadding = parseFloat(getComputedStyle(el).paddingBottom) || 0;
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });
}

function wireResizeHandle(el, key, type, handle) {
  let startX = 0, startY = 0;
  let startValue = 1;

  function onMove(e) {
    const delta = (e.clientX - startX) + (e.clientY - startY);
    if (type === "text") {
      const next = Math.max(0.6, Math.min(1.8, startValue + delta / 150));
      el.style.fontSize = (startFontPx * next) + "px";
    } else {
      const next = Math.max(0.7, Math.min(1.5, startValue + delta / 150));
      el.style.transform = `scale(${next})`;
    }
  }
  let startFontPx = 16;
  async function onUp() {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    try {
      if (type === "text") {
        await saveLayoutOverride(key, "font-size", (parseFloat(getComputedStyle(el).fontSize)) + "px");
      } else {
        const match = /scale\(([\d.]+)\)/.exec(el.style.transform || "");
        await saveLayoutOverride(key, "scale", match ? match[1] : "1");
      }
    } catch (err) {
      alert("Couldn't save size: " + err.message);
    }
  }
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    startX = e.clientX;
    startY = e.clientY;
    startFontPx = parseFloat(getComputedStyle(el).fontSize) || 16;
    startValue = 1;
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });
}
