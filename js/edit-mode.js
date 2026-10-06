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

  // Shown as soon as the pencil toggle exists (i.e. as soon as we know
  // this is an admin session) rather than gated behind edit mode being
  // on — there was previously no way back to admin.html from a public
  // page except typing the URL or browser back. A gear/dashboard icon
  // rather than a house — a house reads as "go to the homepage", which
  // is a real, different link already in the nav.
  const adminLink = document.createElement("a");
  adminLink.id = "editAdminLink";
  adminLink.className = "edit-mode-toggle edit-admin-link";
  adminLink.href = "admin.html";
  adminLink.title = "Back to admin panel";
  adminLink.setAttribute("aria-label", "Back to admin panel");
  adminLink.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="14" rx="1.6" stroke-linejoin="round"/><path d="M3 9h18" stroke-linecap="round"/><path d="M7 13h4" stroke-linecap="round"/><path d="M3 21h18" stroke-linecap="round"/></svg>`;
  document.body.appendChild(adminLink);
}

function setEditMode(on) {
  if (!on && editModeActive && hasPendingChanges()) {
    if (!confirm("You have unsaved changes. Discard them and exit edit mode?")) return;
    discardPendingChanges();
  }

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

/* Selection click + text-edit dblclick, both delegated to document rather
   than attached per-element inside renderEditHandles(). A per-element
   listener attached directly to el (not to a child node like .edit-
   controls) never gets cleaned up across re-renders — only child nodes
   get removed/recreated — so it silently accumulates duplicates, and
   worse, a stale listener from before a lock toggle keeps firing with
   its now-outdated "locked" closure. Delegating to a single listener
   that reads current state (effectiveValue, elementEditType) at dispatch
   time instead of baking it into a closure avoids both problems.
   Capture phase for the same reason as before: .product-art/.add-btn
   have their own bubble-phase listeners in app.js that need to be
   pre-empted, and capturing on document (outermost) also means this
   always runs before any [data-edit-key] element could stopPropagation()
   first. e.target.closest("[data-edit-key]") naturally resolves to the
   innermost matching ancestor-or-self, so a card nested in a section
   correctly wins over the section without needing a separate check. */
document.addEventListener("click", (e) => {
  if (!editModeActive) return;
  const el = e.target.closest("[data-edit-key]");
  if (!el) return;
  const key = el.dataset.editKey;
  if (!key) return;
  if (el.isContentEditable) return; // mid text-edit — let the click place the cursor normally
  if (e.target.closest(".edit-controls, .edit-resize-handle, .edit-divider-handle, .edit-font-popover")) return;
  e.preventDefault();
  e.stopPropagation();
  toggleSelect(key, e.shiftKey);
}, true);

document.addEventListener("dblclick", (e) => {
  if (!editModeActive) return;
  const el = e.target.closest("[data-edit-key]");
  if (!el) return;
  const key = el.dataset.editKey;
  if (!key || elementEditType(el) !== "text") return;
  if (effectiveValue(key, "locked") === "true") return;
  if (e.target.closest(".edit-controls, .edit-resize-handle, .edit-divider-handle, .edit-font-popover")) return;
  e.preventDefault();
  e.stopPropagation();
  startTextEdit(el, key);
}, true);

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
  const labels = { "padding-bottom": "spacing", "font-size": "text size", "font-family": "font", text: "wording", scale: "size", hidden: "visibility", locked: "lock", "translate-x": "horizontal position", "translate-y": "vertical position" };
  const propLabel = labels[row.property] || row.property;
  const niceKey = row.element_key.startsWith("product:") ? "product card" : row.element_key.replace(/-/g, " ");
  return `${niceKey} — ${propLabel}`;
}

async function loadHistoryList() {
  const listEl = document.getElementById("editHistoryList");
  if (!listEl) return;
  const client = getSupabaseClient();
  const page = currentLayoutPage();
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
  else if (property === "font-family") el.style.fontFamily = value || "";
  // scale/translate share one transform — recomputeTransform re-derives
  // the whole thing from whatever's currently staged/saved (the caller is
  // expected to have already updated pendingOverrides/LAYOUT_OVERRIDES
  // before calling this), so `value` isn't used for these two.
  else if (property === "scale" || property === "translate-x" || property === "translate-y") recomputeTransform(el, el.dataset.editKey);
  else if (property === "order") el.style.order = value || "";
  else if (property === "text") el.textContent = value != null ? value : (el.dataset.originalText != null ? el.dataset.originalText : el.textContent);
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
    if (effectiveValue(key, "hidden") === "true") {
      el.classList.add("edit-is-hidden");
    }
  });
}

function elementEditType(el) {
  // Icons/buttons/highlight-blocks that aren't an unambiguous heading or
  // product card get this set directly in the markup — they're movable
  // and resizable (scale) like a product card, but don't get the
  // section-only hide/divider controls or the text-only font/wording ones.
  if (el.dataset.editType === "block") return "block";
  if (el.classList.contains("product-card")) return "product";
  if (el.tagName === "H1" || el.classList.contains("hero-sub")) return "text";
  return "section";
}

function removeEditHandles() {
  // .edit-resize-handle was missing here before: every call appended a new
  // one without removing the last, so after a few unrelated re-renders
  // (e.g. a lock toggle elsewhere) an element would end up with several
  // stacked resize handles. Harmless visually (they overlap exactly) but
  // real DOM/listener bloat, now fixed alongside adding the pending dot.
  document.querySelectorAll(".edit-controls, .edit-divider-handle, .edit-resize-handle, .edit-move-handle, .edit-pending-dot, .edit-font-popover").forEach((el) => el.remove());
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

/* ===== Stage-then-save =====
   Every drag/lock/hide/remove below used to write straight to Supabase on
   release. Now it only stages into pendingOverrides/pendingProductRemovals
   (applying the visual change immediately, same as before) and nothing
   actually persists until the floating Save bar's Save button is clicked.
   effectiveValue() is what every read site (lock icons, the group-lock
   toolbar, the hidden-dim pass) uses instead of reading LAYOUT_OVERRIDES
   directly, so a staged-but-unsaved change still looks "live" everywhere. */
let pendingOverrides = {};
let pendingProductRemovals = new Set();
// One entry per staged action, most recent last, consumed by Ctrl+Z. A
// group action (group lock, group resize) pushes one entry per affected
// element rather than a single batch entry, so undoing it back out takes
// one Ctrl+Z per element — more presses, but each one is correct on its own.
let undoStack = [];

function effectiveValue(key, property) {
  if (pendingOverrides[key] && property in pendingOverrides[key]) return pendingOverrides[key][property];
  return LAYOUT_OVERRIDES[key] ? LAYOUT_OVERRIDES[key][property] : undefined;
}

/* translate-x/translate-y (position) and scale (size) both live in the
   same CSS transform, so they can't each just set el.style.transform in
   isolation without clobbering whichever one they don't know about — one
   shared place composes both. liveOverrides lets an in-progress drag
   preview a tentative value for the property it owns while still reading
   the other (settled) one normally; omit it to recompute purely from
   whatever's currently staged/saved (undo, discard, history revert). */
function recomputeTransform(el, key, liveOverrides) {
  const tx = (liveOverrides && "translate-x" in liveOverrides) ? liveOverrides["translate-x"] : effectiveValue(key, "translate-x");
  const ty = (liveOverrides && "translate-y" in liveOverrides) ? liveOverrides["translate-y"] : effectiveValue(key, "translate-y");
  const scale = (liveOverrides && "scale" in liveOverrides) ? liveOverrides.scale : effectiveValue(key, "scale");
  const parts = [];
  if (tx || ty) parts.push(`translate(${tx || "0px"}, ${ty || "0px"})`);
  if (scale) parts.push(`scale(${scale})`);
  el.style.transform = parts.join(" ");
}

function hasPendingChanges() {
  return Object.keys(pendingOverrides).length > 0 || pendingProductRemovals.size > 0;
}

/* Small dot on any element with a staged-but-unsaved change, so you can
   see at a glance what Save would actually commit before clicking it. */
function updatePendingDot(key) {
  const el = document.querySelector(`[data-edit-key="${CSS.escape(key)}"]`);
  if (!el) return;
  const isPending = !!(pendingOverrides[key] && Object.keys(pendingOverrides[key]).length) ||
    (key.startsWith("product:") && pendingProductRemovals.has(key.slice("product:".length)));
  let dot = el.querySelector(":scope > .edit-pending-dot");
  if (isPending && !dot) {
    dot = document.createElement("span");
    dot.className = "edit-pending-dot";
    dot.title = "Unsaved change";
    el.appendChild(dot);
  } else if (!isPending && dot) {
    dot.remove();
  }
}

function queueOverride(key, property, value) {
  const hadPendingEntry = !!(pendingOverrides[key] && property in pendingOverrides[key]);
  const previous = hadPendingEntry ? pendingOverrides[key][property] : undefined;
  undoStack.push({ type: "override", key, property, hadPendingEntry, previous });

  if (!pendingOverrides[key]) pendingOverrides[key] = {};
  pendingOverrides[key][property] = value; // null means "clear this override on save"
  updatePendingDot(key);
  renderSaveBar();
}

function renderSaveBar() {
  const count = Object.keys(pendingOverrides).length + pendingProductRemovals.size;
  let bar = document.getElementById("editSaveBar");
  if (!count) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "editSaveBar";
    bar.className = "edit-save-bar";
    document.body.appendChild(bar);
  }
  bar.innerHTML = `
    <span class="edit-save-count">${count} unsaved change${count === 1 ? "" : "s"}</span>
    <button type="button" class="edit-save-discard-btn" id="editDiscardBtn">Discard</button>
    <button type="button" class="edit-save-commit-btn" id="editSaveBtn">Save</button>
  `;
  document.getElementById("editDiscardBtn").addEventListener("click", discardPendingChanges);
  document.getElementById("editSaveBtn").addEventListener("click", commitPendingChanges);
}

async function commitPendingChanges() {
  const saveBtn = document.getElementById("editSaveBtn");
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }
  try {
    for (const key of Object.keys(pendingOverrides)) {
      for (const property of Object.keys(pendingOverrides[key])) {
        const value = pendingOverrides[key][property];
        if (value === null) await clearLayoutOverride(key, property);
        else await saveLayoutOverride(key, property, value);
      }
    }
    if (pendingProductRemovals.size) {
      const client = getSupabaseClient();
      for (const productId of pendingProductRemovals) {
        const { error } = await client.from("products").update({ active: false }).eq("id", productId);
        if (error) throw error;
      }
    }
    pendingOverrides = {};
    pendingProductRemovals.clear();
    undoStack = [];
    renderEditHandles();
    renderSaveBar();
    if (document.getElementById("editHistoryPanel")) await loadHistoryList();
  } catch (err) {
    alert("Couldn't save all changes: " + err.message);
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save"; }
  }
}

/* Reverts every staged-but-unsaved change back to its last-saved value.
   "locked"/"hidden" aren't inline styles — clearing pendingOverrides and
   re-rendering (which reads LAYOUT_OVERRIDES, the saved state, once the
   pending overlay is gone) is enough to restore those on its own. */
function discardPendingChanges() {
  Object.keys(pendingOverrides).forEach((key) => {
    const el = document.querySelector(`[data-edit-key="${CSS.escape(key)}"]`);
    const properties = Object.keys(pendingOverrides[key]).filter((p) => p !== "locked" && p !== "hidden");
    // Cleared BEFORE resetting styles below: resetElementStyle's scale/
    // translate branch reads back through effectiveValue(), which checks
    // pendingOverrides first — if the staged entry were still there when
    // that runs, it would just re-read the very value being discarded.
    delete pendingOverrides[key];
    if (!el) return;
    properties.forEach((property) => {
      const savedValue = LAYOUT_OVERRIDES[key] ? LAYOUT_OVERRIDES[key][property] : undefined;
      resetElementStyle(el, property, savedValue);
    });
  });
  pendingProductRemovals.forEach((productId) => {
    const el = document.querySelector(`[data-edit-key="product:${productId}"]`);
    if (el) el.classList.remove("edit-is-hidden");
  });
  pendingOverrides = {};
  pendingProductRemovals.clear();
  undoStack = [];
  revealHiddenForEditing();
  renderEditHandles();
  renderSaveBar();
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

/* ===== Font picker (text elements only) =====
   Curated to exactly the fonts already loaded on every page (the Google
   Fonts <link> plus the Blue Winter @font-face) — anything else would
   just silently fall back to the browser default, so the list is closed
   rather than a free-text field. "Default" clears the override. */
const EDIT_FONT_CHOICES = [
  { label: "Default", value: null },
  { label: "Blue Winter", value: "'Blue Winter', 'Playfair Display', Georgia, serif" },
  { label: "Playfair Display", value: "'Playfair Display', Georgia, serif" },
  { label: "Nunito", value: "'Nunito', sans-serif" },
  { label: "Inter", value: "'Inter', sans-serif" },
  { label: "Fredoka", value: "'Fredoka', sans-serif" }
];

function closeFontPopover() {
  document.querySelectorAll(".edit-font-popover").forEach((p) => p.remove());
}

function toggleFontPopover(el, key) {
  const wasOpenHere = !!el.querySelector(":scope > .edit-font-popover");
  closeFontPopover();
  if (wasOpenHere) return;

  const current = effectiveValue(key, "font-family") || null;
  const popover = document.createElement("div");
  popover.className = "edit-font-popover";
  popover.innerHTML = EDIT_FONT_CHOICES.map((choice) => `
    <button type="button" class="edit-font-option${choice.value === current ? " is-active" : ""}" style="font-family:${choice.value || "inherit"};">
      <span>${choice.label}</span>${choice.value === current ? '<span class="edit-font-check">✓</span>' : ""}
    </button>
  `).join("");
  el.appendChild(popover);

  popover.querySelectorAll(".edit-font-option").forEach((optBtn, i) => {
    optBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const choice = EDIT_FONT_CHOICES[i];
      el.style.fontFamily = choice.value || "";
      queueOverride(key, "font-family", choice.value);
      popover.remove();
    });
  });
}

/* Capture phase on document itself — document is the outermost node in
   the capture dispatch order, so this always runs before any descendant
   [data-edit-key] element's own capture-phase selection handler, even
   though that handler calls stopPropagation() (which would otherwise
   prevent this from ever firing if it were a bubble-phase listener). */
document.addEventListener("click", (e) => {
  if (!e.target.closest(".edit-font-popover, .font-btn")) closeFontPopover();
}, true);

/* ===== Inline text editing (text elements only) =====
   Double-click, or the pencil button, turns the element itself into a
   normal editable text field via contentEditable — no separate form, no
   modal, just click in and type. Enter or clicking away commits (staged,
   same as every other change here); Escape cancels and restores whatever
   was there when editing started. */
function startTextEdit(el, key) {
  if (el.isContentEditable) return;
  closeFontPopover();
  clearSelection();

  // .edit-controls, .edit-resize-handle and .edit-pending-dot are DOM
  // children of el, not siblings — contentEditable treats the whole
  // element as one text region, so leaving them in place means a
  // select-all+type wipes them out along with the real text. Pull them
  // out for the duration of the edit; renderEditHandles() rebuilds all of
  // it fresh once editing finishes.
  el.querySelectorAll(":scope > .edit-controls, :scope > .edit-resize-handle, :scope > .edit-pending-dot").forEach((n) => n.remove());

  const originalSessionText = el.textContent;
  el.contentEditable = "true";
  el.classList.add("edit-text-active");
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = (save) => {
    el.removeEventListener("blur", onBlur);
    el.removeEventListener("keydown", onKeydown);
    el.contentEditable = "false";
    el.classList.remove("edit-text-active");

    if (save) {
      const newText = el.textContent.trim();
      if (!newText) {
        el.textContent = originalSessionText; // don't allow saving blank text
      } else if (newText !== originalSessionText) {
        el.textContent = newText;
        queueOverride(key, "text", newText);
      }
    } else {
      el.textContent = originalSessionText;
    }
    renderEditHandles();
  };

  function onBlur() { finish(true); }
  function onKeydown(e) {
    if (e.key === "Enter") { e.preventDefault(); finish(true); el.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); el.blur(); }
  }
  el.addEventListener("blur", onBlur);
  el.addEventListener("keydown", onKeydown);
}

function renderEditHandles() {
  removeEditHandles();
  document.querySelectorAll("[data-edit-key]").forEach((el) => {
    const key = el.dataset.editKey;
    if (!key) return;
    const type = elementEditType(el);
    const locked = effectiveValue(key, "locked") === "true";
    el.classList.toggle("edit-is-locked", locked);
    el.classList.toggle("edit-selected", selectedKeys.has(key));
    updatePendingDot(key);

    const controls = document.createElement("div");
    controls.className = "edit-controls";
    controls.innerHTML = `
      <button type="button" class="edit-icon-btn lock-btn ${locked ? "is-locked" : ""}" title="${locked ? "Locked, click to unlock" : "Lock in place"}" aria-label="${locked ? "Unlock" : "Lock"}">${locked
        ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
        : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>'
      }</button>
      ${type === "text" && !locked ? `<button type="button" class="edit-icon-btn edit-text-btn" title="Edit the words" aria-label="Edit text"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` : ""}
      ${type === "text" ? `<button type="button" class="edit-icon-btn font-btn" title="Change font" aria-label="Change font">Aa</button>` : ""}
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

      const moveHandle = document.createElement("span");
      moveHandle.className = "edit-move-handle";
      moveHandle.title = "Drag to reposition";
      el.appendChild(moveHandle);
      wireMoveHandle(el, key, moveHandle);
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
    const editTextBtn = controls.querySelector(".edit-text-btn");
    if (editTextBtn) editTextBtn.addEventListener("click", (e) => { e.stopPropagation(); startTextEdit(el, key); });
    const fontBtn = controls.querySelector(".font-btn");
    if (fontBtn) fontBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleFontPopover(el, key); });
    const hideBtn = controls.querySelector(".hide-btn");
    if (hideBtn) hideBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleHidden(el, key); });
    const removeBtn = controls.querySelector(".remove-btn");
    if (removeBtn) removeBtn.addEventListener("click", (e) => { e.stopPropagation(); removeProduct(el, key); });
    const selectRowBtn = controls.querySelector(".select-row-btn");
    if (selectRowBtn) selectRowBtn.addEventListener("click", (e) => { e.stopPropagation(); selectRow(el); });

  });

  // removeEditHandles() above strips edit-is-hidden from every element,
  // including a product that's staged for removal but not yet saved —
  // re-apply its dim here so an unrelated re-render doesn't make it look
  // like the pending removal was undone.
  pendingProductRemovals.forEach((productId) => {
    const el = document.querySelector(`[data-edit-key="product:${productId}"]`);
    if (el) el.classList.add("edit-is-hidden");
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
  const allLocked = [...selectedKeys].every((k) => effectiveValue(k, "locked") === "true");
  bar.innerHTML = `
    <span class="edit-selection-count">${selectedKeys.size} selected</span>
    <button type="button" class="edit-icon-btn ${allLocked ? "is-locked" : ""}" id="selectionLockBtn" title="${allLocked ? "Unlock selected" : "Lock selected"}">${allLocked
      ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
      : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>'
    }</button>
    <span class="edit-selection-move" id="selectionMoveHandle" title="Drag to reposition all selected">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18M3 12h18M7 7l-4 5 4 5M17 7l4 5-4 5M7 7l5-4 5 4M7 17l5 4 5-4" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </span>
    <span class="edit-selection-resize" id="selectionResizeHandle" title="Drag to resize all selected">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v5a2 2 0 0 1-2 2H1M16 21v-5a2 2 0 0 1 2-2h5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </span>
    <button type="button" class="edit-icon-btn" id="selectionClearBtn" title="Clear selection" aria-label="Clear selection">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 5l14 14M19 5L5 19" stroke-linecap="round"/></svg>
    </button>
  `;
  document.getElementById("selectionLockBtn").addEventListener("click", () => groupToggleLock(!allLocked));
  document.getElementById("selectionClearBtn").addEventListener("click", clearSelection);
  wireGroupMoveHandle(document.getElementById("selectionMoveHandle"));
  wireGroupResizeHandle(document.getElementById("selectionResizeHandle"));
}

function groupToggleLock(locked) {
  selectedKeys.forEach((key) => queueOverride(key, "locked", locked ? "true" : null));
  renderEditHandles();
  // renderEditHandles() alone leaves the toolbar's lock button bound to
  // its old "allLocked" closure from the last time the bar was built, so
  // without this the button never flips to its "unlock" label/action.
  renderSelectionToolbar();
}

function wireGroupResizeHandle(handle) {
  let startX = 0, startY = 0;
  const startScales = {};
  const liveScales = {};

  function onMove(e) {
    const delta = (e.clientX - startX) + (e.clientY - startY);
    selectedKeys.forEach((key) => {
      const el = document.querySelector(`[data-edit-key="${CSS.escape(key)}"]`);
      if (!el || el.classList.contains("edit-is-locked")) return;
      const base = startScales[key] || 1;
      const next = Math.max(0.7, Math.min(1.5, base + delta / 150));
      liveScales[key] = next;
      recomputeTransform(el, key, { scale: next });
    });
  }
  function onUp() {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    selectedKeys.forEach((key) => {
      const el = document.querySelector(`[data-edit-key="${CSS.escape(key)}"]`);
      if (!el || el.classList.contains("edit-is-locked") || !(key in liveScales)) return;
      queueOverride(key, "scale", String(liveScales[key]));
    });
  }
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    startX = e.clientX;
    startY = e.clientY;
    selectedKeys.forEach((key) => {
      const current = effectiveValue(key, "scale");
      startScales[key] = current ? parseFloat(current) : 1;
    });
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });
}

/* ===== Figma/Canva-style alignment guides =====
   One shared overlay with up to one horizontal + one vertical dashed
   line, shown/hidden per axis during a move drag. Snap targets (every
   other editable element's rect, the dragged element's .container
   ancestor, and the viewport's horizontal center) are captured once on
   pointerdown — they don't move during the drag, only the dragged
   element does, so there's no reason to re-measure the whole page on
   every pointermove tick. */
const SNAP_THRESHOLD = 6;

function ensureAlignGuides() {
  let wrap = document.getElementById("editAlignGuides");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "editAlignGuides";
    wrap.innerHTML = `<div class="edit-align-guide edit-align-guide-h" hidden></div><div class="edit-align-guide edit-align-guide-v" hidden></div>`;
    document.body.appendChild(wrap);
  }
  return wrap;
}
function showAlignGuide(axis, position) {
  const wrap = ensureAlignGuides();
  const guide = wrap.querySelector(axis === "h" ? ".edit-align-guide-h" : ".edit-align-guide-v");
  if (axis === "h") guide.style.top = position + "px";
  else guide.style.left = position + "px";
  guide.hidden = false;
}
function hideAlignGuide(axis) {
  const wrap = document.getElementById("editAlignGuides");
  if (!wrap) return;
  wrap.querySelector(axis === "h" ? ".edit-align-guide-h" : ".edit-align-guide-v").hidden = true;
}
function hideAlignGuides() {
  hideAlignGuide("h");
  hideAlignGuide("v");
}

function computeSnapTargets(referenceEl, excludeKeys) {
  const targets = [];
  document.querySelectorAll("[data-edit-key]").forEach((el) => {
    const key = el.dataset.editKey;
    if (!key || excludeKeys.has(key)) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    targets.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, hCenter: (r.left + r.right) / 2, vCenter: (r.top + r.bottom) / 2 });
  });
  const container = referenceEl && referenceEl.closest ? referenceEl.closest(".container") : null;
  if (container) {
    const r = container.getBoundingClientRect();
    targets.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, hCenter: (r.left + r.right) / 2, vCenter: (r.top + r.bottom) / 2 });
  }
  targets.push({ hCenter: window.innerWidth / 2 });
  return targets;
}

/* Compares the dragged rect's own left/right/h-center against every
   target's left/right/h-center (and top/bottom/v-center the same way on
   the other axis), picks whichever single comparison is closest within
   SNAP_THRESHOLD per axis, and returns the delta needed to land exactly
   on it plus the line position to draw the guide at. */
function findSnap(rect, targets) {
  let bestV = null, bestH = null;
  const myH = { left: rect.left, right: rect.right, hCenter: (rect.left + rect.right) / 2 };
  const myV = { top: rect.top, bottom: rect.bottom, vCenter: (rect.top + rect.bottom) / 2 };

  targets.forEach((t) => {
    ["left", "right", "hCenter"].forEach((edgeA) => {
      if (t[edgeA] == null) return;
      ["left", "right", "hCenter"].forEach((edgeB) => {
        const diff = t[edgeA] - myH[edgeB];
        if (Math.abs(diff) <= SNAP_THRESHOLD && (!bestV || Math.abs(diff) < Math.abs(bestV.diff))) bestV = { diff, line: t[edgeA] };
      });
    });
    ["top", "bottom", "vCenter"].forEach((edgeA) => {
      if (t[edgeA] == null) return;
      ["top", "bottom", "vCenter"].forEach((edgeB) => {
        const diff = t[edgeA] - myV[edgeB];
        if (Math.abs(diff) <= SNAP_THRESHOLD && (!bestH || Math.abs(diff) < Math.abs(bestH.diff))) bestH = { diff, line: t[edgeA] };
      });
    });
  });

  return { dx: bestV ? bestV.diff : 0, vLine: bestV ? bestV.line : null, dy: bestH ? bestH.diff : 0, hLine: bestH ? bestH.line : null };
}

/* ===== Free-position dragging ===== */

function wireMoveHandle(el, key, handle) {
  let startX = 0, startY = 0;
  let baseTx = 0, baseTy = 0;
  let liveTx = 0, liveTy = 0;
  let snapTargets = [];

  function onMove(e) {
    let tx = Math.max(-1000, Math.min(1000, baseTx + (e.clientX - startX)));
    let ty = Math.max(-1000, Math.min(1000, baseTy + (e.clientY - startY)));

    // Preview at the tentative position first so the snap check compares
    // against where the element would actually be (its own size matters
    // for edge/center comparisons), then nudge onto any line it's close to.
    recomputeTransform(el, key, { "translate-x": tx + "px", "translate-y": ty + "px" });
    const snap = findSnap(el.getBoundingClientRect(), snapTargets);
    if (snap.vLine != null) tx += snap.dx;
    if (snap.hLine != null) ty += snap.dy;

    liveTx = tx;
    liveTy = ty;
    recomputeTransform(el, key, { "translate-x": tx + "px", "translate-y": ty + "px" });

    if (snap.vLine != null) showAlignGuide("v", snap.vLine); else hideAlignGuide("v");
    if (snap.hLine != null) showAlignGuide("h", snap.hLine); else hideAlignGuide("h");
  }
  function onUp() {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    hideAlignGuides();
    queueOverride(key, "translate-x", liveTx ? liveTx + "px" : null);
    queueOverride(key, "translate-y", liveTy ? liveTy + "px" : null);
  }
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    startX = e.clientX;
    startY = e.clientY;
    baseTx = parseFloat(effectiveValue(key, "translate-x")) || 0;
    baseTy = parseFloat(effectiveValue(key, "translate-y")) || 0;
    liveTx = baseTx;
    liveTy = baseTy;
    snapTargets = computeSnapTargets(el, new Set([key]));
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });
}

function wireGroupMoveHandle(handle) {
  let startX = 0, startY = 0;
  const baseTranslates = {};
  const liveTranslates = {};
  let snapTargets = [];

  function groupRect() {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    selectedKeys.forEach((key) => {
      const el = document.querySelector(`[data-edit-key="${CSS.escape(key)}"]`);
      if (!el || el.classList.contains("edit-is-locked")) return;
      const r = el.getBoundingClientRect();
      left = Math.min(left, r.left); top = Math.min(top, r.top);
      right = Math.max(right, r.right); bottom = Math.max(bottom, r.bottom);
    });
    return { left, top, right, bottom, hCenter: (left + right) / 2, vCenter: (top + bottom) / 2 };
  }

  function onMove(e) {
    const rawDx = e.clientX - startX;
    const rawDy = e.clientY - startY;
    selectedKeys.forEach((key) => {
      const el = document.querySelector(`[data-edit-key="${CSS.escape(key)}"]`);
      if (!el || el.classList.contains("edit-is-locked")) return;
      const base = baseTranslates[key] || { x: 0, y: 0 };
      const tx = Math.max(-1000, Math.min(1000, base.x + rawDx));
      const ty = Math.max(-1000, Math.min(1000, base.y + rawDy));
      liveTranslates[key] = { x: tx, y: ty };
      recomputeTransform(el, key, { "translate-x": tx + "px", "translate-y": ty + "px" });
    });

    const snap = findSnap(groupRect(), snapTargets);
    if (snap.vLine != null || snap.hLine != null) {
      selectedKeys.forEach((key) => {
        const el = document.querySelector(`[data-edit-key="${CSS.escape(key)}"]`);
        if (!el || el.classList.contains("edit-is-locked") || !liveTranslates[key]) return;
        if (snap.vLine != null) liveTranslates[key].x += snap.dx;
        if (snap.hLine != null) liveTranslates[key].y += snap.dy;
        recomputeTransform(el, key, { "translate-x": liveTranslates[key].x + "px", "translate-y": liveTranslates[key].y + "px" });
      });
    }
    if (snap.vLine != null) showAlignGuide("v", snap.vLine); else hideAlignGuide("v");
    if (snap.hLine != null) showAlignGuide("h", snap.hLine); else hideAlignGuide("h");
  }
  function onUp() {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    hideAlignGuides();
    selectedKeys.forEach((key) => {
      if (!liveTranslates[key]) return;
      queueOverride(key, "translate-x", liveTranslates[key].x ? liveTranslates[key].x + "px" : null);
      queueOverride(key, "translate-y", liveTranslates[key].y ? liveTranslates[key].y + "px" : null);
    });
  }
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    startX = e.clientX;
    startY = e.clientY;
    selectedKeys.forEach((key) => {
      baseTranslates[key] = { x: parseFloat(effectiveValue(key, "translate-x")) || 0, y: parseFloat(effectiveValue(key, "translate-y")) || 0 };
    });
    const firstKey = [...selectedKeys][0];
    const firstEl = firstKey ? document.querySelector(`[data-edit-key="${CSS.escape(firstKey)}"]`) : null;
    snapTargets = computeSnapTargets(firstEl, selectedKeys);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });
}

function toggleLock(key, locked) {
  queueOverride(key, "locked", locked ? "true" : null);
  renderEditHandles();
}

function toggleHidden(el, key) {
  const alreadyHidden = el.classList.contains("edit-is-hidden");
  if (alreadyHidden) {
    queueOverride(key, "hidden", null);
    el.classList.remove("edit-is-hidden");
  } else {
    queueOverride(key, "hidden", "true");
    el.classList.add("edit-is-hidden");
  }
}

function removeProduct(el, key) {
  if (!confirm("Remove this product from the site? This stays staged until you click Save (and you can turn it back on from the Products admin tab afterward).")) return;
  const productId = key.replace("product:", "");
  undoStack.push({ type: "product-removal", productId });
  pendingProductRemovals.add(productId);
  el.classList.add("edit-is-hidden");
  updatePendingDot(key);
  renderSaveBar();
}

/* ===== Keyboard shortcuts (Esc / Delete / arrows / Ctrl+Z) =====
   Only live while edit mode is on, and only when focus isn't in a text
   field — otherwise typing in the search box or a form on the page
   underneath would get hijacked every time something happens to be
   selected. */
function removeSelectedProducts() {
  const productKeys = [...selectedKeys].filter((k) => k.startsWith("product:"));
  if (!productKeys.length) return;
  const label = productKeys.length === 1 ? "this product" : `these ${productKeys.length} products`;
  if (!confirm(`Remove ${label} from the site? This stays staged until you click Save.`)) return;
  productKeys.forEach((key) => {
    const productId = key.slice("product:".length);
    undoStack.push({ type: "product-removal", productId });
    pendingProductRemovals.add(productId);
    const el = document.querySelector(`[data-edit-key="${CSS.escape(key)}"]`);
    if (el) el.classList.add("edit-is-hidden");
    updatePendingDot(key);
  });
  renderSaveBar();
}

/* Keyboard equivalent of dragging a resize/divider handle — arrow keys
   nudge every selected (and unlocked) element by a small step. Up/Right
   is "bigger", Down/Left is "smaller", same clamped ranges as dragging. */
function nudgeSelected(arrowKey) {
  const increasing = arrowKey === "ArrowUp" || arrowKey === "ArrowRight";
  const sign = increasing ? 1 : -1;
  selectedKeys.forEach((key) => {
    const el = document.querySelector(`[data-edit-key="${CSS.escape(key)}"]`);
    if (!el || effectiveValue(key, "locked") === "true") return;
    const type = elementEditType(el);
    if (type === "product" || type === "block") {
      const current = parseFloat(effectiveValue(key, "scale")) || 1;
      const next = Math.max(0.7, Math.min(1.5, current + sign * 0.02));
      recomputeTransform(el, key, { scale: next });
      queueOverride(key, "scale", String(next));
    } else if (type === "text") {
      const currentPx = parseFloat(el.style.fontSize) || parseFloat(getComputedStyle(el).fontSize) || 16;
      const next = Math.max(8, currentPx + sign * 1);
      el.style.fontSize = next + "px";
      queueOverride(key, "font-size", next + "px");
    } else {
      const currentPad = parseFloat(el.style.paddingBottom) || parseFloat(getComputedStyle(el).paddingBottom) || 0;
      const next = Math.max(0, Math.min(280, currentPad + sign * 4));
      el.style.paddingBottom = next + "px";
      queueOverride(key, "padding-bottom", next + "px");
    }
  });
}

function undoLastChange() {
  const last = undoStack.pop();
  if (!last) return;

  if (last.type === "override") {
    if (last.hadPendingEntry) {
      pendingOverrides[last.key][last.property] = last.previous;
    } else if (pendingOverrides[last.key]) {
      delete pendingOverrides[last.key][last.property];
      if (!Object.keys(pendingOverrides[last.key]).length) delete pendingOverrides[last.key];
    }
    const el = document.querySelector(`[data-edit-key="${CSS.escape(last.key)}"]`);
    if (el && last.property !== "locked" && last.property !== "hidden") {
      resetElementStyle(el, last.property, effectiveValue(last.key, last.property));
    }
    updatePendingDot(last.key);
  } else if (last.type === "product-removal") {
    pendingProductRemovals.delete(last.productId);
    const el = document.querySelector(`[data-edit-key="product:${last.productId}"]`);
    if (el) el.classList.remove("edit-is-hidden");
    updatePendingDot("product:" + last.productId);
  }

  revealHiddenForEditing();
  renderEditHandles();
  renderSaveBar();
}

document.addEventListener("keydown", (e) => {
  if (!editModeActive) return;
  const active = document.activeElement;
  const tag = active && active.tagName;
  // isContentEditable catches an in-progress inline text edit (see
  // startTextEdit below) — without this, Backspace while typing a
  // heading would also fire "Delete selected products", and Ctrl+Z would
  // fight the browser's own native undo for the text being typed.
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (active && active.isContentEditable)) return;

  if ((e.key === "z" || e.key === "Z") && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
    e.preventDefault();
    undoLastChange();
  } else if (e.key === "Escape" && selectedKeys.size) {
    e.preventDefault();
    clearSelection();
  } else if ((e.key === "Delete" || e.key === "Backspace") && selectedKeys.size) {
    e.preventDefault();
    removeSelectedProducts();
  } else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) && selectedKeys.size) {
    e.preventDefault();
    nudgeSelected(e.key);
  }
});

// A tab close/refresh/navigation loses anything not yet Saved, same as the
// in-page confirm() when toggling edit mode off — this covers the paths
// that toggle can't (closing the tab, typing a new URL, hitting back).
window.addEventListener("beforeunload", (e) => {
  if (!editModeActive || !hasPendingChanges()) return;
  e.preventDefault();
  e.returnValue = "";
});

function wireSectionDivider(el, key, handle) {
  let startY = 0;
  let startPadding = 0;

  function onMove(e) {
    const delta = Math.max(-200, Math.min(200, e.clientY - startY));
    const next = Math.max(0, Math.min(280, startPadding + delta));
    el.style.paddingBottom = next + "px";
  }
  function onUp() {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    const finalPadding = parseFloat(el.style.paddingBottom) || 0;
    queueOverride(key, "padding-bottom", finalPadding + "px");
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
  let liveScale = 1;

  function onMove(e) {
    const delta = (e.clientX - startX) + (e.clientY - startY);
    if (type === "text") {
      const next = Math.max(0.6, Math.min(1.8, startValue + delta / 150));
      el.style.fontSize = (startFontPx * next) + "px";
    } else {
      liveScale = Math.max(0.7, Math.min(1.5, startValue + delta / 150));
      recomputeTransform(el, key, { scale: liveScale });
    }
  }
  let startFontPx = 16;
  function onUp() {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    if (type === "text") {
      queueOverride(key, "font-size", (parseFloat(getComputedStyle(el).fontSize)) + "px");
    } else {
      queueOverride(key, "scale", String(liveScale));
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
