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

  const themeBtn = document.createElement("button");
  themeBtn.type = "button";
  themeBtn.id = "editThemeToggle";
  themeBtn.className = "edit-mode-toggle edit-theme-toggle";
  themeBtn.title = "Theme colors";
  themeBtn.hidden = true;
  themeBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.9 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.7-1.6 1.6-1.6h1.6a3.5 3.5 0 0 0 3.5-3.5C19.5 6.6 16.1 3 12 3Z" stroke-linejoin="round"/><circle cx="7.5" cy="10.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="10.5" cy="7" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="7.5" r="1.1" fill="currentColor" stroke="none"/></svg>`;
  document.body.appendChild(themeBtn);
  themeBtn.addEventListener("click", () => toggleThemePanel());

  const previewBtn = document.createElement("button");
  previewBtn.type = "button";
  previewBtn.id = "editPreviewToggle";
  previewBtn.className = "edit-mode-toggle edit-preview-toggle";
  previewBtn.setAttribute("aria-pressed", "false");
  previewBtn.title = "Preview as a visitor";
  previewBtn.hidden = true;
  previewBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="3"/></svg>`;
  document.body.appendChild(previewBtn);
  previewBtn.addEventListener("click", () => togglePreviewMode());

  const layersBtn = document.createElement("button");
  layersBtn.type = "button";
  layersBtn.id = "editLayersToggle";
  layersBtn.className = "edit-mode-toggle edit-layers-toggle";
  layersBtn.title = "Layers";
  layersBtn.hidden = true;
  layersBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3 3 8l9 5 9-5-9-5Z" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 12l9 5 9-5" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 16l9 5 9-5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  document.body.appendChild(layersBtn);
  layersBtn.addEventListener("click", () => toggleLayersPanel());

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
  document.getElementById("editThemeToggle").hidden = !on;
  document.getElementById("editPreviewToggle").hidden = !on;
  document.getElementById("editLayersToggle").hidden = !on;

  if (on) {
    revealHiddenForEditing();
    renderEditHandles();
  } else {
    selectedKeys.clear();
    renderSelectionToolbar();
    removeEditHandles();
    applyLayoutOverrides();
    closeHistoryPanel();
    closeThemePanel();
    closeLayersPanel();
    // Preview mode is edit-mode-only chrome, same as the panels above —
    // leaving it on across an edit-mode exit would strand the body class
    // and the toggle's "active" visual with no way back to turn it off
    // (the eye button itself is about to be hidden on the line above).
    if (previewModeActive) togglePreviewMode();
  }
}

/* ===== Preview mode =====
   Pure visual toggle: hides every bit of editing chrome (toolbar, resize/
   move/divider handles, selection outlines, save bar, the other toggle
   buttons) via the body.edit-preview-active CSS hook in styles.css, so the
   admin can see exactly what a visitor would see — crucially, WITHOUT
   touching pendingOverrides/selectedKeys. Staged changes already render
   through effectiveValue() regardless of this flag, so nothing needs to
   be reapplied here; this only ever flips a class and re-renders the
   (still-hidden-by-CSS, but kept in sync) chrome on the way back out. */
let previewModeActive = false;

function togglePreviewMode() {
  previewModeActive = !previewModeActive;
  document.body.classList.toggle("edit-preview-active", previewModeActive);

  const btn = document.getElementById("editPreviewToggle");
  if (btn) {
    btn.classList.toggle("active", previewModeActive);
    btn.setAttribute("aria-pressed", String(previewModeActive));
    btn.title = previewModeActive ? "Exit preview" : "Preview as a visitor";
  }

  if (previewModeActive) {
    closeFontPopover();
    hideAlignGuides();
    closeHistoryPanel();
    closeThemePanel();
    closeLayersPanel();
  } else {
    // Nothing above ever mutated selectedKeys/pendingOverrides, so this
    // just rebuilds the same chrome that was there before — restoring it
    // "exactly as it was" for whatever is still selected.
    renderEditHandles();
    renderSelectionToolbar();
  }
}

// A drag that starts on a toolbar handle (move/resize) and ends outside
// the toolbar's small bounds — easy to do, the bar is a short pill — gets
// a native "click" synthesized on release at wherever the cursor ended
// up, outside .edit-selection-bar. Without this flag that reads as a
// background click and wipes the selection (destroying the toolbar)
// right after every drag. Set synchronously in each drag handler's
// pointerup, which always fires before the browser's own synthesized
// click for that same interaction.
let suppressNextBackgroundClick = false;

document.addEventListener("click", (e) => {
  if (!editModeActive || !selectedKeys.size) return;
  if (document.body.classList.contains("edit-preview-active")) return;
  if (suppressNextBackgroundClick) { suppressNextBackgroundClick = false; return; }
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
  if (document.body.classList.contains("edit-preview-active")) return;
  const el = e.target.closest("[data-edit-key]");
  if (!el) return;
  const key = el.dataset.editKey;
  if (!key) return;
  if (el.isContentEditable) return; // mid text-edit — let the click place the cursor normally
  if (e.target.closest(".edit-divider-handle, .edit-font-popover")) return;
  e.preventDefault();
  e.stopPropagation();
  toggleSelect(key, e.shiftKey);
}, true);

document.addEventListener("dblclick", (e) => {
  if (!editModeActive) return;
  if (document.body.classList.contains("edit-preview-active")) return;
  const el = e.target.closest("[data-edit-key]");
  if (!el) return;
  const key = el.dataset.editKey;
  if (!key || elementEditType(el) !== "text") return;
  if (effectiveValue(key, "locked") === "true") return;
  if (e.target.closest(".edit-divider-handle, .edit-font-popover")) return;
  e.preventDefault();
  e.stopPropagation();
  startTextEdit(el, key);
}, true);

/* ===== Marquee (drag-to-select) =====
   Shift-click already adds one element at a time to selectedKeys; this
   adds the other half of "grab more than one with the mouse" — a
   Figma-style rubber-band box. Pointerdown on empty canvas (not on an
   editable element or any edit-mode chrome) starts tracking; a small
   movement threshold keeps a plain background click (which the listener
   above already uses to clear selection) from being swallowed as a
   zero-size drag. On release, every [data-edit-key] element whose rect
   intersects the box becomes the selection — unioned with whatever was
   already selected if shift was held when the drag started, replacing it
   otherwise. */
const MARQUEE_THRESHOLD = 4;
let marqueeStart = null;
let marqueeMoved = false;
let marqueeBaseSelection = null;

function ensureMarqueeBox() {
  let box = document.getElementById("editMarqueeBox");
  if (!box) {
    box = document.createElement("div");
    box.id = "editMarqueeBox";
    document.body.appendChild(box);
  }
  return box;
}

function rectsIntersect(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function marqueeRectFrom(e) {
  const x1 = Math.min(marqueeStart.x, e.clientX);
  const y1 = Math.min(marqueeStart.y, e.clientY);
  const x2 = Math.max(marqueeStart.x, e.clientX);
  const y2 = Math.max(marqueeStart.y, e.clientY);
  return { left: x1, top: y1, right: x2, bottom: y2, width: x2 - x1, height: y2 - y1 };
}

function onMarqueeMove(e) {
  if (!marqueeStart) return;
  if (!marqueeMoved) {
    const dx = Math.abs(e.clientX - marqueeStart.x);
    const dy = Math.abs(e.clientY - marqueeStart.y);
    if (Math.hypot(dx, dy) < MARQUEE_THRESHOLD) return;
    marqueeMoved = true;
  }

  const rect = marqueeRectFrom(e);
  const box = ensureMarqueeBox();
  box.style.left = `${rect.left}px`;
  box.style.top = `${rect.top}px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
  box.classList.add("active");

  document.querySelectorAll("[data-edit-key]").forEach((el) => {
    if (el.offsetParent === null) { el.classList.remove("edit-marquee-hover"); return; }
    el.classList.toggle("edit-marquee-hover", rectsIntersect(rect, el.getBoundingClientRect()));
  });
}

function onMarqueeUp(e) {
  document.removeEventListener("pointermove", onMarqueeMove);
  const box = document.getElementById("editMarqueeBox");

  if (marqueeMoved) {
    const rect = marqueeRectFrom(e);
    const hitKeys = marqueeBaseSelection || [];
    selectedKeys.clear();
    hitKeys.forEach((k) => selectedKeys.add(k));
    document.querySelectorAll("[data-edit-key]").forEach((el) => {
      el.classList.remove("edit-marquee-hover");
      if (el.offsetParent === null) return;
      if (rectsIntersect(rect, el.getBoundingClientRect())) selectedKeys.add(el.dataset.editKey);
    });
    renderEditHandles();
    renderSelectionToolbar();
    suppressNextBackgroundClick = true;
  }

  if (box) box.classList.remove("active");
  marqueeStart = null;
  marqueeMoved = false;
  marqueeBaseSelection = null;
}

document.addEventListener("pointerdown", (e) => {
  if (!editModeActive || e.button !== 0) return;
  // Only edit-mode chrome and genuine form/interactive controls block a
  // marquee from starting — NOT [data-edit-key] itself. Now that nearly
  // every element on the page carries that attribute (sections, text,
  // images, buttons), excluding it entirely would mean a marquee could
  // almost never start. Starting the gesture on top of a tagged element
  // is safe: the MARQUEE_THRESHOLD check in onMarqueeMove means a plain
  // click (no real movement) still falls through to the normal click-
  // to-select listener untouched, and only an actual drag turns it into
  // a marquee.
  if (e.target.closest(".edit-selection-bar, .edit-history-panel, .edit-mode-toggle, .edit-divider-handle, .edit-font-popover, input, textarea, select, button, a, [contenteditable='true']")) return;
  marqueeStart = { x: e.clientX, y: e.clientY };
  marqueeMoved = false;
  marqueeBaseSelection = e.shiftKey ? Array.from(selectedKeys) : null;
  document.addEventListener("pointermove", onMarqueeMove);
  document.addEventListener("pointerup", onMarqueeUp, { once: true });
});

// Starting a marquee drag on top of an <img> would otherwise trigger the
// browser's native "drag this image out" ghost instead of (or alongside)
// the pointermove-based marquee tracking above — suppress it specifically
// while a marquee might be in progress, never outside edit mode.
document.addEventListener("dragstart", (e) => {
  if (editModeActive && marqueeStart) e.preventDefault();
});

/* ===== Change history / revert ===== */

async function toggleHistoryPanel() {
  const existing = document.getElementById("editHistoryPanel");
  if (existing) { closeHistoryPanel(); return; }
  closeThemePanel(); // same corner, avoid the two overlapping
  closeLayersPanel();

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
  const labels = { "padding-bottom": "spacing", "font-size": "text size", "font-family": "font", "text-color": "text color", "bg-color": "background color", text: "wording", scale: "size", hidden: "visibility", locked: "lock", "translate-x": "horizontal position", "translate-y": "vertical position" };
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
  else if (property === "text-color") el.style.color = value || "";
  else if (property === "bg-color") el.style.backgroundColor = value || "";
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
  // Any other wording site-wide (FAQ questions/answers, card captions,
  // footer labels, etc.) opts into the same retext/font/color controls
  // H1s and the hero subtext get, via data-edit-type="text" in markup,
  // instead of only ever being inferred from a hardcoded tag/class check.
  if (el.dataset.editType === "text") return "text";
  if (el.classList.contains("product-card")) return "product";
  if (el.tagName === "H1" || el.classList.contains("hero-sub")) return "text";
  return "section";
}

function removeEditHandles() {
  document.querySelectorAll(".edit-divider-handle, .edit-pending-dot, .edit-font-popover").forEach((el) => el.remove());
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
  renderEditHandles();
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
  renderEditHandles();
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
// Mirror of undoStack, consumed by Ctrl+Shift+Z/Ctrl+Y. Every entry
// undoLastChange() pops gets pushed here instead of discarded, and every
// entry redoLastChange() pops gets pushed back onto undoStack — same LIFO
// shape on both sides, so redo-then-undo always lands back where redo
// started. Any brand-new staged action (not undo/redo replaying history)
// clears this, since replaying forward through an action that's since
// been superseded by something else wouldn't make sense.
let redoStack = [];
// Keys that exist ONLY as an unsaved duplicate — i.e. the DOM node itself
// was created at runtime by duplicateSelectedElement() and has no backing
// row in LAYOUT_OVERRIDES yet. discardPendingChanges() can't "revert" such
// a key to its last-saved value the way it does for every other pending
// override (there is no last-saved value, there's no saved element at
// all) — it has to tear the cloned node out of the DOM instead. Cleared
// once the key is actually saved (commitPendingChanges) or discarded.
let pendingNewKeys = new Set();

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
  return Object.keys(pendingOverrides).length > 0 || pendingProductRemovals.size > 0 || Object.keys(pendingThemeColors).length > 0;
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
  // `value` is carried on the entry too (not just `previous`) so
  // redoLastChange() can reapply this exact change forward without having
  // to re-derive what it originally set — see redoLastChange() below.
  undoStack.push({ type: "override", key, property, hadPendingEntry, previous, value });
  redoStack = []; // a fresh action invalidates whatever redo branch existed

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
    pendingNewKeys.clear(); // now backed by real saved rows, like any other key
    undoStack = [];
    redoStack = [];
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
  // Keys that only ever existed as a staged duplicate have no saved row to
  // revert to — resetElementStyle above already ran for them with
  // savedValue === undefined (harmless), but the cloned node itself still
  // needs to be torn back out of the DOM, or it keeps sitting there
  // looking like a real element even though nothing was ever saved.
  pendingNewKeys.forEach((key) => {
    selectedKeys.delete(key);
    const el = document.querySelector(`[data-edit-key="${CSS.escape(key)}"]`);
    if (el) el.remove();
  });
  pendingNewKeys.clear();
  pendingProductRemovals.forEach((productId) => {
    const el = document.querySelector(`[data-edit-key="product:${productId}"]`);
    if (el) el.classList.remove("edit-is-hidden");
  });
  pendingOverrides = {};
  pendingProductRemovals.clear();
  undoStack = [];
  redoStack = [];
  discardThemeColors();
  revealHiddenForEditing();
  renderEditHandles();
  renderSaveBar();
  renderSelectionToolbar();
}

function selectRow(el) {
  const parent = el.parentElement;
  const top = Math.round(el.getBoundingClientRect().top);
  const rowSiblings = Array.from(parent.children).filter(
    (sib) => sib.dataset && sib.dataset.editKey && Math.round(sib.getBoundingClientRect().top) === top
  );
  selectedKeys = new Set(rowSiblings.map((sib) => sib.dataset.editKey));
  renderEditHandles();
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

// text elements get a text-color swatch, everything else (section/
// product/block) gets a background-color one — a single "color" button
// with type-dependent meaning, same pattern as the font/resize buttons
// already having different effects depending on what's selected.
function colorPropertyFor(type) {
  return type === "text" ? "text-color" : "bg-color";
}

// <input type="color"> only accepts #rrggbb — getComputedStyle returns
// rgb(...)/rgba(...), so this is needed just to seed the swatch with
// whatever color is actually currently showing when nothing's staged yet.
function rgbToHex(rgbStr) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgbStr || "");
  if (!m) return "#000000";
  const toHex = (v) => Number(v).toString(16).padStart(2, "0");
  return `#${toHex(m[1])}${toHex(m[2])}${toHex(m[3])}`;
}

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
      e.preventDefault();
      e.stopPropagation();
      const choice = EDIT_FONT_CHOICES[i];
      el.style.fontFamily = choice.value || "";
      queueOverride(key, "font-family", choice.value);
      popover.remove();
      renderSelectionToolbar(); // so "Reset to default" appears once this font change lands
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

/* ===== Theme colors (site-wide, not per-element) =====
   Everything else in this file writes to layout_overrides (one page,
   one element, one property). Theme colors are different — they're
   site_settings rows, shared across every page, the same table and
   upsert pattern admin.html's own Settings tab already uses. Kept as
   its own small self-contained panel (with its own Save/Discard) rather
   than folded into the per-element pendingOverrides/Save bar, since
   mixing "one page section" and "the whole site" into one counter would
   be confusing. hasPendingChanges()/discardPendingChanges() still cover
   it for the "unsaved changes, discard and exit?" guard. */
const THEME_COLOR_FIELDS = [
  { key: "theme_coral", label: "Accent", fallback: "#FF7F7F" },
  { key: "theme_blush", label: "Blush", fallback: "#F8C4C4" },
  { key: "theme_baby_blue", label: "Baby blue", fallback: "#B9DCF3" },
  { key: "theme_soft_yellow", label: "Soft yellow", fallback: "#FFD66B" },
  { key: "theme_brown", label: "Text", fallback: "#4A3028" }
];
let pendingThemeColors = {};

/* applyThemeColors() (js/site-content.js) reads window.SITE_SETTINGS at
   the moment it's called and writes a snapshot into the #dynamicTheme
   style tag — it isn't reactively bound to that object. So a live
   preview can build a merged view, point SITE_SETTINGS at it just long
   enough to generate the preview, then restore the real object; the
   style tag keeps the preview without the real settings ever having
   been mutated. */
function previewThemeColors() {
  if (typeof applyThemeColors !== "function") return;
  const real = window.SITE_SETTINGS;
  window.SITE_SETTINGS = Object.assign({}, real, pendingThemeColors);
  applyThemeColors();
  window.SITE_SETTINGS = real;
}

function closeThemePanel() {
  const panel = document.getElementById("editThemePanel");
  if (panel) panel.remove();
}

function toggleThemePanel() {
  const existing = document.getElementById("editThemePanel");
  if (existing) { closeThemePanel(); return; }
  closeHistoryPanel(); // same corner, avoid the two overlapping
  closeLayersPanel();

  const settings = window.SITE_SETTINGS || {};
  const panel = document.createElement("div");
  panel.id = "editThemePanel";
  panel.className = "edit-history-panel edit-theme-panel";
  panel.innerHTML = `
    <div class="edit-history-head">
      <strong>Theme colors</strong>
      <button type="button" class="edit-icon-btn" id="editThemeClose" aria-label="Close">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 5l14 14M19 5L5 19" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="edit-theme-swatches">
      ${THEME_COLOR_FIELDS.map((f) => `
        <label class="edit-theme-field">
          <input type="color" data-theme-key="${f.key}" value="${pendingThemeColors[f.key] || settings[f.key] || f.fallback}"/>
          <span>${f.label}</span>
        </label>
      `).join("")}
    </div>
    <div class="edit-theme-actions">
      <button type="button" class="edit-save-discard-btn" id="editThemeDiscard">Discard</button>
      <button type="button" class="edit-save-commit-btn" id="editThemeSave">Save</button>
    </div>
  `;
  document.body.appendChild(panel);
  document.getElementById("editThemeClose").addEventListener("click", closeThemePanel);
  document.getElementById("editThemeDiscard").addEventListener("click", () => { discardThemeColors(); closeThemePanel(); });
  document.getElementById("editThemeSave").addEventListener("click", saveThemeColors);
  panel.querySelectorAll("input[type=color]").forEach((input) => {
    input.addEventListener("input", () => {
      pendingThemeColors[input.dataset.themeKey] = input.value;
      previewThemeColors();
    });
  });
}

async function saveThemeColors() {
  const entries = Object.entries(pendingThemeColors);
  if (!entries.length) { closeThemePanel(); return; }
  const saveBtn = document.getElementById("editThemeSave");
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }
  try {
    const client = getSupabaseClient();
    for (const [key, value] of entries) {
      const { error } = await client.from("site_settings").upsert({ key, value });
      if (error) throw error;
      if (window.SITE_SETTINGS) window.SITE_SETTINGS[key] = value;
    }
    pendingThemeColors = {};
    closeThemePanel();
  } catch (err) {
    alert("Couldn't save colors: " + err.message);
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save"; }
  }
}

function discardThemeColors() {
  if (!Object.keys(pendingThemeColors).length) return;
  pendingThemeColors = {};
  if (typeof applyThemeColors === "function") applyThemeColors();
}

/* ===== Layers / outline panel =====
   Read-only navigation aid: every [data-edit-key] element on the current
   page, one row each, so an admin can find and select something that's
   small, off-screen, or buried under other elements without having to
   hunt for it on the canvas first. Selecting here is deliberately the
   same two steps as any other selection path — mutate selectedKeys, then
   call the same render functions toggleSelect()/clearSelection() call —
   so the on-canvas toolbar that appears afterwards behaves identically to
   a direct click. No editing happens from this panel itself. */
function closeLayersPanel() {
  const panel = document.getElementById("editLayersPanel");
  if (panel) panel.remove();
}

// Prefers the element's own visible text (trimmed/collapsed/truncated) as
// the human-readable label; icon-only elements and other text-free nodes
// (e.g. a decorative block) fall back to the raw key so the row is never
// blank.
function layerRowLabel(el, key) {
  const text = (el.textContent || "").replace(/\s+/g, " ").trim();
  if (text) return text.length > 44 ? text.slice(0, 44) + "…" : text;
  return key;
}

// escapeHtml() is defined in js/app.js (loaded after this file, but well
// before any user interaction can reach this code) — reused as-is rather
// than duplicated here.
function selectLayerKey(key) {
  selectedKeys.clear();
  selectedKeys.add(key);
  renderEditHandles();
  renderSelectionToolbar();
}

function toggleLayersPanel() {
  const existing = document.getElementById("editLayersPanel");
  if (existing) { closeLayersPanel(); return; }
  closeHistoryPanel();
  closeThemePanel();

  const els = Array.from(document.querySelectorAll("[data-edit-key]")).filter((el) => el.dataset.editKey);

  const panel = document.createElement("div");
  panel.id = "editLayersPanel";
  panel.className = "edit-history-panel edit-layers-panel";
  panel.innerHTML = `
    <div class="edit-history-head">
      <strong>Layers</strong>
      <button type="button" class="edit-icon-btn" id="editLayersClose" aria-label="Close">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 5l14 14M19 5L5 19" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="edit-layers-list" id="editLayersList">
      ${els.length ? els.map((el) => {
        const key = el.dataset.editKey;
        const type = elementEditType(el);
        const locked = effectiveValue(key, "locked") === "true";
        return `
          <div class="edit-layers-row" data-layer-key="${escapeHtml(key)}" title="${escapeHtml(key)}">
            <span class="edit-layers-label">${escapeHtml(layerRowLabel(el, key))}</span>
            <span class="edit-layers-tags">
              ${locked ? `<svg class="edit-layers-lock" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" aria-label="Locked"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>` : ""}
              <span class="edit-layers-type">${escapeHtml(type)}</span>
            </span>
          </div>
        `;
      }).join("") : `<p class="edit-history-empty">No editable elements on this page.</p>`}
    </div>
  `;
  document.body.appendChild(panel);
  document.getElementById("editLayersClose").addEventListener("click", closeLayersPanel);

  panel.querySelectorAll("[data-layer-key]").forEach((row) => {
    row.addEventListener("click", () => {
      const key = row.dataset.layerKey;
      const el = document.querySelector(`[data-edit-key="${CSS.escape(key)}"]`);
      closeLayersPanel();
      selectLayerKey(key);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
}

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

  // .edit-pending-dot is a DOM child of el, not a sibling — contentEditable
  // treats the whole element as one text region, so leaving it in place
  // means a select-all+type would wipe it out along with the real text.
  // Pull it out for the duration of the edit; renderEditHandles() rebuilds
  // it fresh once editing finishes (via updatePendingDot).
  el.querySelectorAll(":scope > .edit-pending-dot").forEach((n) => n.remove());

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
    const selected = selectedKeys.has(key);
    el.classList.toggle("edit-is-locked", locked);
    el.classList.toggle("edit-selected", selected);
    updatePendingDot(key);

    // Every other control (lock/font/edit-text/hide/remove/select-row/
    // move/resize) now lives in the floating selection toolbar instead of
    // cluttering the element itself — see renderSelectionToolbar(). The
    // section-spacing divider is the one exception that stays inline: it's
    // inherently tied to this specific section's own bottom edge, unlike
    // everything else, which doesn't need to be anchored at the element
    // to make sense.
    if (type === "section" && selected && !locked) {
      const divider = document.createElement("div");
      divider.className = "edit-divider-handle";
      divider.title = "Drag to adjust space below this section";
      el.appendChild(divider);
      wireSectionDivider(el, key, divider);
    }
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

/* ===== Selection toolbar (shown once 1+ elements are selected) =====
   The one control surface for everything — lock, move, resize, and
   (when exactly one element of the right type is selected) font/
   edit-text/hide/remove/select-row. Grows to fit whichever of those
   apply instead of cluttering the element itself; see renderEditHandles()
   for why the section divider is the one thing that stays inline. */
function singleSelection() {
  if (selectedKeys.size !== 1) return null;
  const key = [...selectedKeys][0];
  const el = document.querySelector(`[data-edit-key="${CSS.escape(key)}"]`);
  if (!el) return null;
  return { key, el, type: elementEditType(el), locked: effectiveValue(key, "locked") === "true" };
}

/* ===== Reset to default =====
   Every property an element can be overridden on, EXCEPT "locked" — reset
   is a styling/content undo, not a lock toggle, and the button is only
   ever shown on an already-unlocked element anyway (same gating as most
   per-element buttons), so "locked" never belongs in this list. Checked
   via effectiveValue() (pending-over-saved, same as everywhere else) so
   the button shows/hides correctly whether the override is still staged
   or already committed to Supabase. */
const RESETTABLE_PROPERTIES = ["translate-x", "translate-y", "scale", "font-size", "font-family", "text-color", "bg-color", "padding-bottom", "text", "hidden", "order"];

function hasResettableOverride(key) {
  return RESETTABLE_PROPERTIES.some((property) => effectiveValue(key, property) != null);
}

/* Unlike discardPendingChanges() (which only ever needs to fall back to
   the last SAVED value, because a discard by definition can't touch
   anything already committed), this has to be able to wipe out a saved
   override too. Queuing `null` is exactly what already means "clear this
   on save" to commitPendingChanges() — queueOverride(key, property, null)
   — so no new staging shape is needed; a saved row goes through
   clearLayoutOverride() the same way discarding an unsaved "hidden"/
   "locked" toggle already does on commit. */
function resetElementToDefault(key, el) {
  RESETTABLE_PROPERTIES.forEach((property) => {
    if (effectiveValue(key, property) == null) return;
    queueOverride(key, property, null);
  });
  // Visually land on the true default right away, same idea as
  // resetElementStyle()'s callers elsewhere, but reverting to "no
  // override at all" rather than "whatever was last saved" — every
  // RESETTABLE_PROPERTIES entry was just cleared above, so effectiveValue
  // for each of them is now null and these calls resolve to the element's
  // natural, un-overridden state.
  resetElementStyle(el, "font-size", null);
  resetElementStyle(el, "font-family", null);
  resetElementStyle(el, "text-color", null);
  resetElementStyle(el, "bg-color", null);
  resetElementStyle(el, "padding-bottom", null);
  resetElementStyle(el, "order", null);
  resetElementStyle(el, "text", null);
  recomputeTransform(el, key); // re-derives from the now-cleared translate-x/translate-y/scale
  el.classList.remove("edit-is-hidden");
  el.style.display = "";
  renderEditHandles();
  renderSelectionToolbar();
}

/* ===== Copy / paste style =====
   Position (translate-x/translate-y/scale) is deliberately excluded —
   that's spatial, not a "look", and pasting it onto an unrelated element
   elsewhere on the page would almost never make sense. font-size/
   font-family are only ever meaningful on "text" elements (same gating
   renderSelectionToolbar already uses for the font button), so they're
   only captured from, and only ever applied to, a text-type element;
   color is universal (every type gets a swatch) but the PROPERTY NAME it
   lives under depends on the target's type, hence routing every read/
   write through colorPropertyFor() rather than copying "text-color" or
   "bg-color" verbatim. */
let copiedStyle = null;

function copyStyleFrom(key, el, type) {
  const colorProp = colorPropertyFor(type);
  const color = effectiveValue(key, colorProp) || rgbToHex(getComputedStyle(el)[type === "text" ? "color" : "backgroundColor"]);
  copiedStyle = { key, type, color };
  if (type === "text") {
    copiedStyle.fontSize = effectiveValue(key, "font-size") || (parseFloat(getComputedStyle(el).fontSize) || 16) + "px";
    copiedStyle.fontFamily = effectiveValue(key, "font-family") || null; // null = "Default" font, a real, pasteable choice
  }
  // Re-render so a differently-selected element can immediately show its
  // new "paste style" button — this element's own bar doesn't change
  // (paste never targets the element it was just copied from).
  renderSelectionToolbar();
}

function pasteStyleTo(key, el, type) {
  if (!copiedStyle) return;
  const colorProp = colorPropertyFor(type);
  if (type === "text") el.style.color = copiedStyle.color;
  else el.style.backgroundColor = copiedStyle.color;
  queueOverride(key, colorProp, copiedStyle.color);

  if (type === "text" && copiedStyle.type === "text") {
    el.style.fontSize = copiedStyle.fontSize;
    queueOverride(key, "font-size", copiedStyle.fontSize);
    el.style.fontFamily = copiedStyle.fontFamily || "";
    queueOverride(key, "font-family", copiedStyle.fontFamily);
  }
  renderEditHandles();
  renderSelectionToolbar();
}

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
  const single = singleSelection();
  // Sections never got move/resize even before this toolbar existed —
  // they have their own purpose-built spacing control (the divider
  // handle) and arbitrary scale/translate on an entire page section
  // tends to look broken (overflow, huge gaps). Hide both the moment any
  // selected element is a section, single or mixed into a multi-select.
  const hasSection = [...selectedKeys].some((k) => {
    const el = document.querySelector(`[data-edit-key="${CSS.escape(k)}"]`);
    return el && elementEditType(el) === "section";
  });
  const canReset = single && !single.locked && hasResettableOverride(single.key);
  const canPaste = single && !single.locked && copiedStyle && copiedStyle.key !== single.key;

  bar.innerHTML = `
    <span class="edit-selection-count">${selectedKeys.size} selected</span>
    <button type="button" class="edit-icon-btn ${allLocked ? "is-locked" : ""}" id="selectionLockBtn" title="${allLocked ? "Unlock selected" : "Lock selected"}">${allLocked
      ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
      : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>'
    }</button>
    ${single && single.type === "text" && !single.locked ? `<button type="button" class="edit-icon-btn" id="selectionEditTextBtn" title="Edit the words" aria-label="Edit text"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` : ""}
    ${single && single.type === "text" ? `<button type="button" class="edit-icon-btn font-btn" id="selectionFontBtn" title="Change font" aria-label="Change font">Aa</button>` : ""}
    ${single && !single.locked ? `<input type="color" class="edit-selection-color" id="selectionColorInput" title="${single.type === "text" ? "Change text color" : "Change background color"}" value="${effectiveValue(single.key, colorPropertyFor(single.type)) || rgbToHex(getComputedStyle(single.el)[single.type === "text" ? "color" : "backgroundColor"])}"/>` : ""}
    ${single && single.type === "section" && !single.locked ? `<button type="button" class="edit-icon-btn" id="selectionHideBtn" title="Hide this section" aria-label="Hide section"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12s3.5-7 9-7 9 7 9 7-3.5 7-9 7-9-7-9-7Z"/><circle cx="12" cy="12" r="2.5"/></svg></button>` : ""}
    ${single ? `<button type="button" class="edit-icon-btn" id="selectionCopyStyleBtn" title="Copy style" aria-label="Copy style"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4H5.5A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` : ""}
    ${canPaste ? `<button type="button" class="edit-icon-btn" id="selectionPasteStyleBtn" title="Paste style" aria-label="Paste style"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="12" height="17" rx="1.5"/><path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 12h6M9 16h6" stroke-linecap="round"/></svg></button>` : ""}
    ${canReset ? `<button type="button" class="edit-icon-btn" id="selectionResetBtn" title="Reset to default" aria-label="Reset to default"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 3-6.7" stroke-linecap="round"/><path d="M3 4v4.5h4.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` : ""}
    ${!hasSection ? `<span class="edit-selection-move" id="selectionMoveHandle" title="Drag to reposition all selected">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18M3 12h18M7 7l-4 5 4 5M17 7l4 5-4 5M7 7l5-4 5 4M7 17l5 4 5-4" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </span>` : ""}
    ${!hasSection ? `<span class="edit-selection-resize" id="selectionResizeHandle" title="Drag to resize all selected">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v5a2 2 0 0 1-2 2H1M16 21v-5a2 2 0 0 1 2-2h5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </span>` : ""}
    ${single && single.type === "product" ? `<button type="button" class="edit-icon-btn" id="selectionSelectRowBtn" title="Select this whole row" aria-label="Select row"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="9" width="5" height="6" rx="1"/><rect x="9.5" y="9" width="5" height="6" rx="1"/><rect x="16" y="9" width="5" height="6" rx="1"/></svg></button>` : ""}
    <button type="button" class="edit-icon-btn" id="selectionClearBtn" title="Clear selection" aria-label="Clear selection">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 5l14 14M19 5L5 19" stroke-linecap="round"/></svg>
    </button>
  `;
  // suppressNextBackgroundClick matters here too, not just for drags:
  // groupToggleLock/clearSelection/selectRow below all rebuild this same
  // bar's innerHTML synchronously, which detaches the very button the
  // browser is still mid-dispatch on. By the time that click bubbles to
  // document, e.target is the now-disconnected original button, so
  // closest(".edit-selection-bar") resolves to null (a detached node
  // can't find a connected ancestor) — and the "click outside clears
  // selection" listener fires, wiping out what the click just set up.
  document.getElementById("selectionLockBtn").addEventListener("click", () => {
    suppressNextBackgroundClick = true;
    groupToggleLock(!allLocked);
  });
  document.getElementById("selectionClearBtn").addEventListener("click", () => {
    suppressNextBackgroundClick = true;
    clearSelection();
  });
  const moveHandle = document.getElementById("selectionMoveHandle");
  if (moveHandle) wireGroupMoveHandle(moveHandle);
  const resizeHandle = document.getElementById("selectionResizeHandle");
  if (resizeHandle) wireGroupResizeHandle(resizeHandle);

  if (single) {
    const editTextBtn = document.getElementById("selectionEditTextBtn");
    if (editTextBtn) editTextBtn.addEventListener("click", () => {
      single.el.scrollIntoView({ behavior: "smooth", block: "center" });
      startTextEdit(single.el, single.key);
    });
    const fontBtn = document.getElementById("selectionFontBtn");
    if (fontBtn) fontBtn.addEventListener("click", () => {
      single.el.scrollIntoView({ behavior: "smooth", block: "center" });
      toggleFontPopover(single.el, single.key);
    });
    const colorInput = document.getElementById("selectionColorInput");
    if (colorInput) {
      const property = colorPropertyFor(single.type);
      colorInput.addEventListener("input", () => {
        if (single.type === "text") single.el.style.color = colorInput.value;
        else single.el.style.backgroundColor = colorInput.value;
        queueOverride(single.key, property, colorInput.value);
      });
      // "change" (fires once, when the native picker closes) rather than
      // "input" (fires continuously while dragging inside it) — rebuilding
      // the toolbar's innerHTML mid-drag would detach this very <input>
      // and kill the native color picker popup it owns. Deferring the
      // re-render to "change" is what lets "Reset to default" pick up the
      // new color without disrupting the live picker.
      colorInput.addEventListener("change", () => {
        renderSelectionToolbar();
      });
    }
    const hideBtn = document.getElementById("selectionHideBtn");
    if (hideBtn) hideBtn.addEventListener("click", () => toggleHidden(single.el, single.key));
    const selectRowBtn = document.getElementById("selectionSelectRowBtn");
    if (selectRowBtn) selectRowBtn.addEventListener("click", () => {
      suppressNextBackgroundClick = true;
      selectRow(single.el);
    });
    const copyStyleBtn = document.getElementById("selectionCopyStyleBtn");
    if (copyStyleBtn) copyStyleBtn.addEventListener("click", () => {
      suppressNextBackgroundClick = true;
      copyStyleFrom(single.key, single.el, single.type);
    });
    const pasteStyleBtn = document.getElementById("selectionPasteStyleBtn");
    if (pasteStyleBtn) pasteStyleBtn.addEventListener("click", () => {
      suppressNextBackgroundClick = true;
      pasteStyleTo(single.key, single.el, single.type);
    });
    const resetBtn = document.getElementById("selectionResetBtn");
    if (resetBtn) resetBtn.addEventListener("click", () => {
      suppressNextBackgroundClick = true;
      resetElementToDefault(single.key, single.el);
    });
  }
}

function groupToggleLock(locked) {
  selectedKeys.forEach((key) => queueOverride(key, "locked", locked ? "true" : null));
  renderEditHandles();
  // renderEditHandles() alone leaves the toolbar's lock button bound to
  // its old "allLocked" closure from the last time the bar was built, so
  // without this the button never flips to its "unlock" label/action.
  renderSelectionToolbar();
}

/* Type-aware per selected element: text resizes via font-size (same
   0.6x-1.8x multiplier the old per-element handle used), everything
   else via scale (same 0.7x-1.5x range) — so a single text element
   selected through this one shared toolbar behaves exactly like the
   old dedicated inline resize handle did, and a mixed-type multi-
   selection resizes each member the way that makes sense for it. */
function wireGroupResizeHandle(handle) {
  let startX = 0, startY = 0;
  const startValues = {}; // key -> { type, base } (base = scale multiplier or starting font px)
  const liveValues = {}; // key -> { type, value }

  function onMove(e) {
    const delta = (e.clientX - startX) + (e.clientY - startY);
    selectedKeys.forEach((key) => {
      const el = document.querySelector(`[data-edit-key="${CSS.escape(key)}"]`);
      if (!el || el.classList.contains("edit-is-locked") || !startValues[key]) return;
      const { type, base } = startValues[key];
      if (type === "text") {
        const mult = Math.max(0.6, Math.min(1.8, 1 + delta / 150));
        const next = base * mult;
        liveValues[key] = { type, value: next };
        el.style.fontSize = next + "px";
      } else {
        const next = Math.max(0.7, Math.min(1.5, base + delta / 150));
        liveValues[key] = { type, value: next };
        recomputeTransform(el, key, { scale: next });
      }
    });
  }
  function onUp() {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    suppressNextBackgroundClick = true;
    selectedKeys.forEach((key) => {
      const entry = liveValues[key];
      if (!entry) return;
      if (entry.type === "text") queueOverride(key, "font-size", entry.value + "px");
      else queueOverride(key, "scale", String(entry.value));
    });
    // The gesture (not each in-flight pointermove tick) is the right time
    // to refresh the toolbar — e.g. so "Reset to default" shows up the
    // moment this resize is the selected element's first-ever override.
    renderSelectionToolbar();
  }
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    startX = e.clientX;
    startY = e.clientY;
    selectedKeys.forEach((key) => {
      const el = document.querySelector(`[data-edit-key="${CSS.escape(key)}"]`);
      if (!el) return;
      const type = elementEditType(el);
      if (type === "text") {
        const current = parseFloat(effectiveValue(key, "font-size")) || parseFloat(getComputedStyle(el).fontSize) || 16;
        startValues[key] = { type, base: current };
      } else {
        const current = effectiveValue(key, "scale");
        startValues[key] = { type, base: current ? parseFloat(current) : 1 };
      }
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
    suppressNextBackgroundClick = true;
    hideAlignGuides();
    selectedKeys.forEach((key) => {
      if (!liveTranslates[key]) return;
      queueOverride(key, "translate-x", liveTranslates[key].x ? liveTranslates[key].x + "px" : null);
      queueOverride(key, "translate-y", liveTranslates[key].y ? liveTranslates[key].y + "px" : null);
    });
    // Same reasoning as wireGroupResizeHandle's onUp: refresh once the
    // drag ends, not on every pointermove tick, so "Reset to default"
    // reflects the move that just landed.
    renderSelectionToolbar();
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
  renderSelectionToolbar(); // so "Reset to default" reflects the hidden/shown change
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
    redoStack = []; // a fresh action invalidates whatever redo branch existed
    pendingProductRemovals.add(productId);
    const el = document.querySelector(`[data-edit-key="${CSS.escape(key)}"]`);
    if (el) el.classList.add("edit-is-hidden");
    updatePendingDot(key);
  });
  renderSaveBar();
}

/* Ctrl+D — clone the single selected text/block element as a sibling,
   carry over its current look (every pending/saved override), nudge it
   so it's not sitting exactly on top of the original, and select it.
   Sections and product cards are deliberately NOT supported here: a
   section has page-wide spacing/divider semantics a second copy would
   conflict with, and a product card's "real" source of truth is the
   products table (app.js renders one per active row) — duplicating the
   DOM node wouldn't create a second real product, just a confusing fake.
   Staged as ONE atomic undo/redo entry (type "duplicate") rather than one
   queueOverride() call per copied property: this action both creates a
   DOM node and stages data, and those two facts have to undo/redo
   together as a single unit — spreading them across many separate
   "override" entries would let a partial undo leave an empty, invisible
   clone stranded in the DOM with no pending state and no save/discard
   path back to removing it. (removeSelectedProducts() above follows the
   same already-established pattern: its own dedicated undo entry type,
   not queueOverride, because "stage a removal" isn't a single-property
   change either.) */
function duplicateSelectedElement() {
  const single = singleSelection();
  if (!single || single.locked) return;
  const { key, el, type } = single;
  if (type !== "text" && type !== "block") return; // section/product: skip, see above

  const clone = el.cloneNode(true);
  clone.classList.remove("edit-selected", "edit-is-locked", "edit-is-hidden", "edit-text-active");
  clone.querySelectorAll(":scope > .edit-pending-dot, .edit-divider-handle, .edit-font-popover").forEach((n) => n.remove());
  delete clone.dataset.originalText;

  // short, collision-proof suffix — same "prefix:id" shape as the other
  // dynamically-keyed elements in the codebase (product:<id>, nav-item:<id>)
  const newKey = `${key}:dup-${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
  clone.dataset.editKey = newKey;
  el.insertAdjacentElement("afterend", clone);

  // Carry over the original's current look (pending overrides win over
  // saved ones, same precedence effectiveValue() always uses) — everything
  // except locked/hidden, which a fresh duplicate should never inherit.
  const propertyNames = new Set([
    ...Object.keys(pendingOverrides[key] || {}),
    ...Object.keys(LAYOUT_OVERRIDES[key] || {})
  ]);
  propertyNames.delete("locked");
  propertyNames.delete("hidden");
  const overrides = {};
  propertyNames.forEach((property) => {
    const value = effectiveValue(key, property);
    if (value != null) overrides[property] = value;
  });

  // Offset from the ORIGINAL's current position, not from 0, so duplicating
  // an already-moved element still lands visibly beside it rather than
  // back at the un-moved default spot.
  const baseX = parseFloat(effectiveValue(key, "translate-x")) || 0;
  const baseY = parseFloat(effectiveValue(key, "translate-y")) || 0;
  overrides["translate-x"] = (baseX + 24) + "px";
  overrides["translate-y"] = (baseY + 24) + "px";

  pendingOverrides[newKey] = {};
  Object.keys(overrides).forEach((property) => {
    pendingOverrides[newKey][property] = overrides[property];
    resetElementStyle(clone, property, overrides[property]);
  });
  pendingNewKeys.add(newKey);

  undoStack.push({ type: "duplicate", key: newKey, originalKey: key, overrides, el: clone });
  redoStack = []; // a fresh action invalidates whatever redo branch existed

  updatePendingDot(newKey);
  renderSaveBar();

  selectedKeys = new Set([newKey]);
  renderEditHandles();
  renderSelectionToolbar();
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
  renderSelectionToolbar(); // so "Reset to default" reflects the nudge that just landed
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
  } else if (last.type === "duplicate") {
    delete pendingOverrides[last.key];
    pendingNewKeys.delete(last.key);
    selectedKeys.delete(last.key);
    if (last.el && last.el.parentNode) last.el.remove();
    updatePendingDot(last.key);
  }

  // Pushed onto redoStack (not discarded) so Ctrl+Shift+Z/Ctrl+Y can
  // replay this exact entry forward — see redoLastChange() below.
  redoStack.push(last);

  revealHiddenForEditing();
  renderEditHandles();
  renderSaveBar();
  renderSelectionToolbar();
}

/* Mirror of undoLastChange(): pops the most recently undone entry and
   reapplies it forward. Reaches directly into pendingOverrides/the DOM
   the same way undo does, instead of going through queueOverride() or
   re-pushing to undoStack via the normal staging helpers — both of those
   would misread this as a brand-new user action and immediately wipe the
   very redoStack this function is reading from. Pushing the entry onto
   undoStack directly (once, here) is what keeps undo/redo symmetric: a
   Ctrl+Z right after this Ctrl+Shift+Z undoes exactly the thing that was
   just redone, no more and no less. */
function redoLastChange() {
  const next = redoStack.pop();
  if (!next) return;

  if (next.type === "override") {
    if (!pendingOverrides[next.key]) pendingOverrides[next.key] = {};
    pendingOverrides[next.key][next.property] = next.value;
    const el = document.querySelector(`[data-edit-key="${CSS.escape(next.key)}"]`);
    if (el && next.property !== "locked" && next.property !== "hidden") {
      resetElementStyle(el, next.property, effectiveValue(next.key, next.property));
    }
    updatePendingDot(next.key);
  } else if (next.type === "product-removal") {
    pendingProductRemovals.add(next.productId);
    const el = document.querySelector(`[data-edit-key="product:${next.productId}"]`);
    if (el) el.classList.add("edit-is-hidden");
    updatePendingDot("product:" + next.productId);
  } else if (next.type === "duplicate") {
    const anchorEl = document.querySelector(`[data-edit-key="${CSS.escape(next.originalKey)}"]`);
    if (anchorEl) anchorEl.insertAdjacentElement("afterend", next.el);
    else document.body.appendChild(next.el);
    pendingOverrides[next.key] = Object.assign({}, next.overrides);
    pendingNewKeys.add(next.key);
    Object.keys(next.overrides).forEach((property) => resetElementStyle(next.el, property, next.overrides[property]));
    updatePendingDot(next.key);
  }

  undoStack.push(next);

  revealHiddenForEditing();
  renderEditHandles();
  renderSaveBar();
  renderSelectionToolbar();
}

document.addEventListener("keydown", (e) => {
  if (!editModeActive) return;
  if (document.body.classList.contains("edit-preview-active")) return;
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
  } else if (
    (e.key === "y" || e.key === "Y") && (e.ctrlKey || e.metaKey) ||
    (e.key === "z" || e.key === "Z") && (e.ctrlKey || e.metaKey) && e.shiftKey
  ) {
    e.preventDefault();
    redoLastChange();
  } else if ((e.key === "d" || e.key === "D") && (e.ctrlKey || e.metaKey)) {
    e.preventDefault(); // Ctrl+D is also the browser's "bookmark this page" shortcut
    duplicateSelectedElement();
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
    suppressNextBackgroundClick = true;
    const finalPadding = parseFloat(el.style.paddingBottom) || 0;
    queueOverride(key, "padding-bottom", finalPadding + "px");
    renderSelectionToolbar(); // so "Reset to default" appears once this spacing change lands
  }
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    startY = e.clientY;
    startPadding = parseFloat(getComputedStyle(el).paddingBottom) || 0;
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });
}

