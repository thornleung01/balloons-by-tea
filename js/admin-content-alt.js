/* Photo alt text (photo_meta table, supabase-migrations/60-content.sql).

   Adds an "Alt" chip to every photo tile in:
     - the Library tab grid and the "Choose from library" picker
     - the product form's photo gallery (already-uploaded photos only;
       a brand-new photo gets its alt once it's saved and has a URL)
     - the Gallery tab rows (where the caption is the fallback)
   plus a "Missing alt text" filter/count in the Library toolbar.

   Tiles are decorated by watching the admin DOM, so the scripts that
   render those grids (admin-library.js, admin-products.js,
   admin-gallery.js) need no changes. The public site reads the same table
   through window.photoAlt() in js/site-content.js.

   API: openAltTextEditor(url, { fallback, onSaved }) and
        getPhotoAlt(url) -> string ("" when none). */

const PHOTO_ALT_MAX = 300;
const photoAltByUrl = new Map();
/* null = not loaded yet, true = loaded, false = table missing. */
let photoMetaAvailable = null;
let photoMetaLoading = null;
let libraryAltFilterOn = false;

function photoAltKey(url) {
  return String(url || "").trim().split("#")[0].split("?")[0];
}

function getPhotoAlt(url) {
  return photoAltByUrl.get(photoAltKey(url)) || "";
}

async function loadPhotoMeta() {
  if (photoMetaLoading) return photoMetaLoading;
  photoMetaLoading = (async () => {
    const client = getSupabaseClient();
    const rows = [];
    // Page through in case there are a lot of photos.
    for (let from = 0; from < 20000; from += 1000) {
      const { data, error } = await client.from("photo_meta").select("url,alt").range(from, from + 999);
      if (error) {
        photoMetaAvailable = isMissingTableError(error, "photo_meta") ? false : null;
        if (photoMetaAvailable === null) console.warn("[alt text] Couldn't load photo_meta:", error.message);
        photoMetaLoading = null;
        return;
      }
      rows.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    photoAltByUrl.clear();
    rows.forEach((r) => { if (r.alt && r.alt.trim()) photoAltByUrl.set(photoAltKey(r.url), r.alt.trim()); });
    photoMetaAvailable = true;
  })();
  await photoMetaLoading;
  decorateAltTargets();
}

async function savePhotoAlt(url, alt) {
  const client = getSupabaseClient();
  const key = photoAltKey(url);
  const clean = String(alt || "").replace(/\s+/g, " ").trim().slice(0, PHOTO_ALT_MAX);
  if (clean) {
    const { error } = await mustAffect(client.from("photo_meta").upsert({ url: key, alt: clean }, { onConflict: "url" }));
    if (error) throw error;
    photoAltByUrl.set(key, clean);
  } else {
    const { error } = await client.from("photo_meta").delete().eq("url", key);
    if (error) throw error;
    photoAltByUrl.delete(key);
  }
  // The public site caches the alt map for a few minutes per visitor tab;
  // the admin's own tabs pick the change up on their next visit.
  try { sessionStorage.removeItem("photoAltMap:v1"); } catch (e) { /* ignore */ }
  decorateAltTargets(true);
  return clean;
}

/* ----- Editor modal ----- */

function ensureAltTextModal() {
  let modal = document.getElementById("altTextModal");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.className = "modal alt-text-modal";
  modal.id = "altTextModal";
  modal.innerHTML = `
    <div class="modal-scrim" data-close-alt></div>
    <div class="modal-panel alt-text-panel" role="dialog" aria-modal="true" aria-labelledby="altTextTitle">
      <div class="modal-head">
        <div>
          <h2 id="altTextTitle">Alt text</h2>
          <p>Describes the photo for people using screen readers, and helps Google understand it.</p>
        </div>
        <button type="button" class="icon-btn" data-close-alt aria-label="Close">&times;</button>
      </div>
      <form class="modal-body" id="altTextForm" novalidate>
        <div class="alt-text-layout">
          <img class="alt-text-img" id="altTextImg" src="" alt=""/>
          <div class="field">
            <label for="altTextInput">Describe what's in the photo</label>
            <textarea id="altTextInput" maxlength="${PHOTO_ALT_MAX}" rows="3" placeholder="e.g. Pastel pink and white balloon garland over a dessert table"></textarea>
            <p class="field-note" id="altTextCount"></p>
            <p class="field-note" id="altTextFallback"></p>
          </div>
        </div>
        <ul class="alt-text-tips">
          <li>Say what's in it: colours, shapes, the setting. Skip "photo of".</li>
          <li>One sentence is plenty (aim for under 125 characters).</li>
        </ul>
        <div class="form-status" id="altTextStatus" role="status" aria-live="polite"></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="altTextClearBtn">Remove alt text</button>
          <button type="submit" class="btn btn-primary" id="altTextSaveBtn">Save alt text</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelectorAll("[data-close-alt]").forEach((el) => el.addEventListener("click", closeAltTextEditor));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("open")) closeAltTextEditor();
  });
  const input = modal.querySelector("#altTextInput");
  input.addEventListener("input", () => updateAltTextCount());
  return modal;
}

let altEditorContext = null;

function updateAltTextCount() {
  const input = document.getElementById("altTextInput");
  const count = document.getElementById("altTextCount");
  if (!input || !count) return;
  const n = input.value.trim().length;
  count.textContent = `${n} / ${PHOTO_ALT_MAX} characters${n > 125 ? " (shorter is usually better)" : ""}`;
}

function closeAltTextEditor() {
  const modal = document.getElementById("altTextModal");
  if (modal) modal.classList.remove("open");
  const ctx = altEditorContext;
  altEditorContext = null;
  if (ctx && ctx.returnFocus && ctx.returnFocus.focus) ctx.returnFocus.focus();
}

async function openAltTextEditor(url, { fallback = "", onSaved = null, returnFocus = null } = {}) {
  if (photoMetaAvailable === null) await loadPhotoMeta();
  if (photoMetaAvailable === false) {
    alert("Alt text isn't switched on yet. Run supabase-migrations/60-content.sql in the Supabase SQL Editor, then reload this page.");
    return;
  }
  const modal = ensureAltTextModal();
  altEditorContext = { url, onSaved, returnFocus: returnFocus || document.activeElement };
  modal.querySelector("#altTextImg").src = url;
  const input = modal.querySelector("#altTextInput");
  input.value = getPhotoAlt(url);
  modal.querySelector("#altTextFallback").textContent = fallback ? `Without alt text the site uses: "${fallback}"` : "";
  const status = modal.querySelector("#altTextStatus");
  status.textContent = "";
  status.className = "form-status";
  modal.querySelector("#altTextClearBtn").hidden = !getPhotoAlt(url);
  updateAltTextCount();

  const form = modal.querySelector("#altTextForm");
  form.onsubmit = (e) => { e.preventDefault(); commitAltText(input.value); };
  modal.querySelector("#altTextClearBtn").onclick = () => commitAltText("");
  modal.classList.add("open");
  setTimeout(() => input.focus(), 30);
}

async function commitAltText(value) {
  const ctx = altEditorContext;
  if (!ctx) return;
  const status = document.getElementById("altTextStatus");
  const saveBtn = document.getElementById("altTextSaveBtn");
  saveBtn.disabled = true;
  status.textContent = "Saving...";
  status.className = "form-status";
  try {
    const saved = await savePhotoAlt(ctx.url, value);
    if (ctx.onSaved) ctx.onSaved(saved);
    closeAltTextEditor();
  } catch (err) {
    status.textContent = `Couldn't save: ${err.message || err}`;
    status.className = "form-status error";
  } finally {
    saveBtn.disabled = false;
  }
}

/* ----- Decorating photo tiles ----- */

function altChipMarkup(url) {
  const alt = getPhotoAlt(url);
  return { cls: alt ? "has-alt" : "is-missing", title: alt ? `Alt text: ${alt}` : "No alt text yet, click to add", label: alt ? "Alt ✓" : "Add alt" };
}

function setTextIfChanged(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function applyAltChip(btn, url) {
  const m = altChipMarkup(url);
  btn.classList.toggle("has-alt", m.cls === "has-alt");
  btn.classList.toggle("is-missing", m.cls === "is-missing");
  btn.title = m.title;
  btn.setAttribute("aria-label", m.title);
  setTextIfChanged(btn, m.cls === "is-missing" && btn.dataset.missingLabel ? btn.dataset.missingLabel : m.label);
}

function makeAltChip(url, extraClass, getFallback, missingLabel) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `alt-chip ${extraClass || ""}`.trim();
  btn.dataset.altUi = "";
  btn.dataset.altUrl = url;
  if (missingLabel) btn.dataset.missingLabel = missingLabel;
  btn.draggable = false;
  applyAltChip(btn, url);
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openAltTextEditor(btn.dataset.altUrl, { fallback: getFallback ? getFallback() : "", returnFocus: btn });
  });
  // Don't start a tile drag from the chip.
  btn.addEventListener("mousedown", (e) => e.stopPropagation());
  return btn;
}

function isRealPhotoUrl(url) {
  return /^https?:\/\//i.test(String(url || ""));
}

/* `refresh` re-labels existing chips (after an alt was saved). */
function decorateAltTargets(refresh) {
  if (photoMetaAvailable !== true) return;

  // Library tab + picker modal tiles (not the unused-photos review grid).
  document.querySelectorAll("#libraryTabGrid .photo-library-item[data-url], #photoLibraryGrid .photo-library-item[data-url]").forEach((tile) => {
    const url = tile.dataset.url;
    let chip = tile.querySelector(":scope > .alt-chip");
    if (!chip) {
      const name = (tile.dataset.path || "").split("/").pop();
      chip = makeAltChip(url, "alt-chip-tile", () => name);
      tile.appendChild(chip);
    } else if (refresh) applyAltChip(chip, url);
    tile.classList.toggle("has-alt", !!getPhotoAlt(url));
    tile.classList.toggle("missing-alt", !getPhotoAlt(url));
  });

  // Product form photo gallery.
  document.querySelectorAll("#photoGallery .photo-gallery-item").forEach((tile) => {
    const img = tile.querySelector("img");
    const url = img && img.getAttribute("src");
    let chip = tile.querySelector(":scope > .alt-chip");
    if (!isRealPhotoUrl(url)) { if (chip) chip.remove(); return; }
    if (!chip || chip.dataset.altUrl !== url) {
      if (chip) chip.remove();
      chip = makeAltChip(url, "alt-chip-tile", () => {
        const name = document.getElementById("f-name");
        return name && name.value ? name.value : "the product name";
      });
      tile.appendChild(chip);
    } else if (refresh) applyAltChip(chip, url);
  });

  // Gallery tab rows: caption is the public fallback.
  document.querySelectorAll("#galleryAdminList .gallery-admin-row").forEach((row) => {
    const img = row.querySelector(".gallery-admin-thumb img");
    const url = img && img.getAttribute("src");
    if (!isRealPhotoUrl(url)) return;
    let chip = row.querySelector(".alt-chip");
    if (!chip || chip.dataset.altUrl !== url) {
      if (chip) chip.remove();
      chip = makeAltChip(url, "alt-chip-inline", () => {
        const cap = row.querySelector('[data-field="caption"]');
        return cap && cap.value.trim() ? cap.value.trim() : "Balloon decor from a past event";
      }, "Add alt text (caption is used for now)");
      const status = row.querySelector(".gallery-admin-row-status");
      const fields = row.querySelector(".gallery-admin-fields");
      if (status) status.insertAdjacentElement("beforebegin", chip);
      else if (fields) fields.appendChild(chip);
      else row.appendChild(chip);
    } else if (refresh) applyAltChip(chip, url);
  });

  updateLibraryAltFilter();
}

/* "Missing alt text" toggle in the Library tab toolbar: counts the photos
   in the folder being browsed and can hide the ones already described. */
function ensureLibraryAltToggle() {
  let btn = document.getElementById("libraryAltFilterBtn");
  if (btn) return btn;
  const toolbar = document.querySelector("#libraryPanel .library-toolbar");
  if (!toolbar) return null;
  btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn-outline btn-sm library-alt-filter";
  btn.id = "libraryAltFilterBtn";
  btn.dataset.altUi = "";
  btn.setAttribute("aria-pressed", "false");
  btn.textContent = "Missing alt text";
  btn.addEventListener("click", async () => {
    if (photoMetaAvailable === null) await loadPhotoMeta();
    if (photoMetaAvailable === false) {
      alert("Alt text isn't switched on yet. Run supabase-migrations/60-content.sql in the Supabase SQL Editor, then reload this page.");
      return;
    }
    libraryAltFilterOn = !libraryAltFilterOn;
    updateLibraryAltFilter();
  });
  toolbar.appendChild(btn);
  return btn;
}

function updateLibraryAltFilter() {
  const btn = ensureLibraryAltToggle();
  const grid = document.getElementById("libraryTabGrid");
  if (!btn || !grid) return;
  const tiles = grid.querySelectorAll(".photo-library-item[data-url]");
  const missing = Array.from(tiles).filter((t) => !getPhotoAlt(t.dataset.url)).length;
  setTextIfChanged(btn, photoMetaAvailable === true ? `Missing alt text (${missing})` : "Missing alt text");
  btn.classList.toggle("has-missing", photoMetaAvailable === true && missing > 0);
  btn.setAttribute("aria-pressed", String(libraryAltFilterOn));
  btn.classList.toggle("active", libraryAltFilterOn);
  grid.classList.toggle("alt-filter-missing", libraryAltFilterOn);
  let note = document.getElementById("libraryAltFilterNote");
  if (libraryAltFilterOn && tiles.length && !missing) {
    if (!note) {
      note = document.createElement("p");
      note.id = "libraryAltFilterNote";
      note.dataset.altUi = "";
      note.className = "empty-note";
      note.textContent = "Every photo in this folder has alt text.";
      grid.insertAdjacentElement("afterend", note);
    }
  } else if (note) note.remove();
}

onAdminInit(() => {
  ensureLibraryAltToggle();
  const root = document.getElementById("dashboardView") || document.body;
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; decorateAltTargets(false); });
  };
  // The picker modal lives on <body>, outside the dashboard.
  // Our own chips/labels changing must not re-trigger a pass.
  const ownNode = (n) => n.nodeType === 1 && n.hasAttribute("data-alt-ui");
  new MutationObserver((mutations) => {
    const relevant = mutations.some((m) => {
      const target = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      if (target && target.closest("[data-alt-ui]")) return false;
      const nodes = Array.from(m.addedNodes).concat(Array.from(m.removedNodes));
      return nodes.length > 0 && !nodes.every(ownNode);
    });
    if (relevant) schedule();
  }).observe(document.body, { childList: true, subtree: true });
  if (root) loadPhotoMeta();
});
