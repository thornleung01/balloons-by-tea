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
}

function setEditMode(on) {
  editModeActive = on;
  const btn = document.getElementById("editModeToggle");
  btn.classList.toggle("active", on);
  btn.setAttribute("aria-pressed", String(on));
  document.body.classList.toggle("edit-mode-active", on);

  if (on) {
    revealHiddenForEditing();
    renderEditHandles();
  } else {
    removeEditHandles();
    applyLayoutOverrides();
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
  document.querySelectorAll("[data-edit-key]").forEach((el) => el.classList.remove("edit-is-hidden", "edit-is-locked"));
}

function renderEditHandles() {
  removeEditHandles();
  document.querySelectorAll("[data-edit-key]").forEach((el) => {
    const key = el.dataset.editKey;
    if (!key) return;
    const type = elementEditType(el);
    const locked = !!(LAYOUT_OVERRIDES[key] && LAYOUT_OVERRIDES[key].locked === "true");
    el.classList.toggle("edit-is-locked", locked);

    const controls = document.createElement("div");
    controls.className = "edit-controls";
    controls.innerHTML = `
      <button type="button" class="edit-icon-btn lock-btn ${locked ? "is-locked" : ""}" title="${locked ? "Locked, click to unlock" : "Lock in place"}" aria-label="${locked ? "Unlock" : "Lock"}">${locked
        ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
        : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>'
      }</button>
      ${type === "section" ? `<button type="button" class="edit-icon-btn hide-btn" title="Hide this section" aria-label="Hide section"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12s3.5-7 9-7 9 7 9 7-3.5 7-9 7-9-7-9-7Z"/><circle cx="12" cy="12" r="2.5"/></svg></button>` : ""}
      ${type === "product" ? `<button type="button" class="edit-icon-btn remove-btn" title="Remove from site" aria-label="Remove product"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 5l14 14M19 5L5 19" stroke-linecap="round"/></svg></button>` : ""}
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
