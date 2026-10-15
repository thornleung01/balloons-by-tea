/*
  Admin page core (admin.html). Talks directly to Supabase from the browser —
  there's no custom backend server. Real security comes from Supabase's Row
  Level Security policies (see supabase-setup.sql): anyone can read products,
  but only a logged-in user can write. The admin scripts just have to not
  trust anything the page itself claims — hence escapeHtml() on every field
  when rendering lists.

  The admin page is split into classic scripts that share one global scope
  (top-level functions and `let`s are visible to every later script), loaded
  in this order by admin.html:
    js/admin-core.js         shared helpers, auth, tab registry, init hooks,
                             image compression, photo preview lightbox
    js/admin-collections.js  Categories tab + collectionsCache
    js/admin-products.js     Products tab (list, form, bulk actions, photos)
    js/admin-library.js      Photo library tab + picker modal + unused scan
    js/admin-nav.js          Nav tab
    js/admin-faq.js          FAQ tab
    js/admin-settings.js     Settings tab
    js/admin-orders.js       Orders tab
    js/admin-analytics.js    Analytics tab
    js/admin-backup.js, js/admin-availability.js,
    js/admin-delivery-areas.js, js/admin-gallery.js  (IIFE modules)

  How a feature file hooks in:
    registerAdminTab(key, { btnId, panelId, onEnter })  — adds a tab
    onAdminInit((client) => { ...addEventListener... }) — wires its DOM,
        run once on DOMContentLoaded, only when Supabase is configured,
        before the login session is checked
    registerAdminDirtyCheck(() => boolean)             — unsaved-changes
        check used by Log out and the beforeunload prompt
*/

/* ===== Registries (tabs, init hooks, unsaved-changes checks) ===== */

/* key -> { btnId, panelId, onEnter }. Each feature file adds its own tab
   with registerAdminTab(); the click wiring happens in the init block at
   the bottom of this file, once every script has loaded. */
const TABS = {};

function registerAdminTab(key, { btnId, panelId, onEnter }) {
  if (TABS[key]) throw new Error(`Admin tab "${key}" is registered twice`);
  TABS[key] = { btnId, panelId, onEnter };
}

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

/* Functions run (in script load order) from the DOMContentLoaded handler at
   the bottom of this file, after the Supabase-configured check and before
   the session check. Each receives the Supabase client. */
const adminInitHooks = [];
function onAdminInit(fn) { adminInitHooks.push(fn); }

/* Each returns true when its form has unsaved edits. Checked (in script
   load order) on Log out and before the page unloads. */
const adminDirtyChecks = [];
function registerAdminDirtyCheck(fn) { adminDirtyChecks.push(fn); }
function anyAdminFormDirty() { return adminDirtyChecks.some((fn) => fn()); }

/* ===== Helpers ===== */

const HTML_ESCAPE_MAP = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
};
function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => HTML_ESCAPE_MAP[c]);
}

/* Row-locking (prevents an accidental drag) is a per-browser UI safety
   net, not business data, so it lives in localStorage rather than a new
   Supabase column — nothing to sync, nothing that breaks if it's empty. */
function lockStorageKey(listName, id) {
  return `admin-row-locked:${listName}:${id}`;
}
function isRowLocked(listName, id) {
  try { return localStorage.getItem(lockStorageKey(listName, id)) === "1"; } catch (e) { return false; }
}
function setRowLocked(listName, id, locked) {
  try {
    if (locked) localStorage.setItem(lockStorageKey(listName, id), "1");
    else localStorage.removeItem(lockStorageKey(listName, id));
  } catch (e) { /* localStorage unavailable (private browsing, etc.) — lock just won't persist */ }
}
function lockHandleMarkup(listName, id) {
  const locked = isRowLocked(listName, id);
  return `<button type="button" class="lock-toggle ${locked ? "is-locked" : ""}" data-lock-list="${listName}" data-lock-id="${id}" title="${locked ? "Locked, click to allow dragging" : "Click to lock in place"}" aria-label="${locked ? "Unlock row" : "Lock row"}">${locked
    ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
    : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>'
  }</button>`;
}
function wireUpLockToggles(listEl, onToggle) {
  listEl.querySelectorAll(".lock-toggle").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const { lockList, lockId } = btn.dataset;
      setRowLocked(lockList, lockId, !isRowLocked(lockList, lockId));
      onToggle();
    });
  });
}

/* ===== Image compression =====
   Every place in the admin scripts that uploads a raw File to Supabase Storage
   runs it through compressImageFile() first. Admin phone/camera photos
   can easily be 4-12MB and 4000+px wide for something that only ever
   displays at a few hundred px on the public site, so this resizes to a
   sane max dimension and re-encodes before upload as WebP (which keeps the
   transparent backgrounds some PNG photos rely on). In a browser that
   can't encode WebP, PNGs are kept as PNG (resized but not otherwise
   degraded) and everything else is re-encoded as JPEG at a reasonable
   quality. Files already small enough that this
   wouldn't meaningfully help are returned unchanged. Any failure here
   (corrupt image, canvas/codec issue, old browser) falls back to
   uploading the ORIGINAL file — a bug in this helper must never block a
   real save the admin is trying to make. */

/* createImageBitmap isn't available in every browser (older Safari in
   particular) — fall back to decoding through an <img> element, which
   works everywhere a <canvas> does. */
async function loadDrawableImageSource(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch (e) {
      // Fall through to the <img> fallback below (e.g. an unsupported
      // format for createImageBitmap in this browser).
    }
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Couldn't read file"));
    reader.readAsDataURL(file);
  });
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't decode image"));
    img.src = dataUrl;
  });
}

async function compressImageFile(file, { maxDimension = 1600, webpQuality = 0.82, jpegQuality = 0.82, skipBelowBytes = 200 * 1024 } = {}) {
  if (!file || typeof file.type !== "string" || !file.type.startsWith("image/")) return file; // never touch non-images
  if (file.size <= skipBelowBytes) return file; // already small — not worth the processing

  let source = null;
  try {
    source = await loadDrawableImageSource(file);
    const width = source.width || source.naturalWidth || 0;
    const height = source.height || source.naturalHeight || 0;
    if (!width || !height) return file;

    const scale = Math.min(1, maxDimension / Math.max(width, height));
    const keepPng = file.type === "image/png";
    // Always redraw through canvas, even at scale 1 — a large-but-already-
    // right-sized JPEG might just be poorly compressed (e.g. quality 100
    // straight off a camera), and re-encoding at jpegQuality can still
    // shrink it meaningfully. The size check below guarantees this never
    // ships something bigger than what was uploaded.
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

    const encode = (type, quality) => new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))),
        type,
        quality
      );
    });
    // WebP keeps PNG transparency and is far smaller than PNG or JPEG.
    // Browsers that can't encode WebP silently hand back a PNG instead, so
    // check the real type and fall back to the PNG/JPEG path in that case.
    let outputType = "image/webp";
    let blob = await encode(outputType, webpQuality);
    if (!blob || blob.type !== "image/webp") {
      outputType = keepPng ? "image/png" : "image/jpeg";
      blob = await encode(outputType, keepPng ? undefined : jpegQuality);
    }
    if (!blob || blob.size >= file.size) return file; // never ship something bigger than the original

    const ext = { "image/webp": ".webp", "image/jpeg": ".jpg" }[outputType];
    const newName = ext ? file.name.replace(/\.[a-zA-Z0-9]+$/, "") + ext : file.name;
    return new File([blob], newName, { type: outputType, lastModified: Date.now() });
  } catch (err) {
    // Corrupt image, canvas/codec failure, etc. — upload the original
    // rather than let a processing bug block a real upload.
    return file;
  } finally {
    // Release the ImageBitmap's backing memory promptly on every exit
    // path (early returns included), not just the success path.
    if (source && typeof source.close === "function") source.close();
  }
}

/* Runs an update/delete/upsert and treats "no rows changed" as a failure.
   When Row Level Security blocks a write (most often because the login
   session has expired or been lost), Supabase doesn't return an error —
   it returns success with zero rows. Without this check every save button
   would report "updated"/"deleted" while nothing actually changed.
   Callers keep using { error } exactly as before. */
async function mustAffect(query) {
  const { data, error } = await query.select();
  if (error) return { data, error };
  if (!data || data.length === 0) {
    return {
      data,
      // Either the row no longer exists (deleted elsewhere) or RLS blocked
      // the write (login expired) — the response can't tell which.
      error: { message: "Nothing was changed — it may already have been deleted, or your login may have expired. Refresh the page and try again." }
    };
  }
  return { data, error: null };
}

function show(el) { el.hidden = false; }
function hide(el) { el.hidden = true; }

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

let loggingOutOnPurpose = false;

async function handleLogout() {
  if (anyAdminFormDirty() && !confirm("You have unsaved changes. Log out anyway?")) return;
  const client = getSupabaseClient();
  loggingOutOnPurpose = true;
  try {
    await client.auth.signOut();
  } finally {
    // Always reset, even if signOut throws (e.g. offline) — otherwise the
    // lost-session watcher would stay switched off for the rest of the page.
    loggingOutOnPurpose = false;
  }
  showLoginView();
}

/* If the session ends on its own (token refresh failed, signed out in
   another tab), return to the login screen with an explanation instead of
   leaving a dashboard up whose saves can no longer succeed. The forms are
   only hidden, not cleared, so unsaved work is still there after logging
   back in. */
function watchForLostSession(client) {
  client.auth.onAuthStateChange((event) => {
    if (event !== "SIGNED_OUT" || loggingOutOnPurpose) return;
    if (document.getElementById("dashboardView").hidden) return;
    showLoginView();
    document.getElementById("loginError").textContent =
      "Your login expired — please log in again. Anything you hadn't saved is still in the form.";
  });
}

async function enterDashboard() {
  const client = getSupabaseClient();
  const { data: { session } } = await client.auth.getSession();
  if (!session) {
    showLoginView();
    return;
  }
  // Extra login steps from js/admin-auth-extras.js (set-new-password after
  // a reset link, the 2-step login code). A gate that returns false has
  // shown its own screen and calls enterDashboard() again when it's done.
  for (const gate of (window.adminLoginGates || [])) {
    if (!(await gate(client, session))) return;
  }
  // Per-login setup that must finish before the dashboard shows (e.g. the
  // team role, so staff never see owner-only buttons flash up). A failing
  // hook never blocks the login.
  await Promise.allSettled((window.adminSessionHooks || []).map((fn) => Promise.resolve().then(() => fn(client, session))));
  const who = document.getElementById("whoAmI");
  who.textContent = session.user.email;
  show(who);
  show(document.getElementById("logoutBtn"));
  hide(document.getElementById("loginView"));
  show(document.getElementById("dashboardView"));
  // Cross-feature on purpose: the order matters (categories must be loaded
  // before the product list renders its folders), so it stays explicit
  // rather than going through a hook list.
  await loadCollectionsCache();
  await refreshItemList();
  await refreshOrderList();
  // First clean snapshot of the item form, taken only once the category
  // dropdown has its real options (filling it changes the form's value).
  if (itemFormSnapshot === null) markItemFormClean();
}

function showLoginView() {
  hide(document.getElementById("dashboardView"));
  hide(document.getElementById("logoutBtn"));
  hide(document.getElementById("whoAmI"));
  show(document.getElementById("loginView"));
  // Lets js/admin-auth-extras.js reset its extra login screens.
  (window.adminLoginViewHooks || []).forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
}

/* ===== Photo preview modal — reuses the public site's lightbox CSS
   classes (loaded via css/styles.css) without needing js/app.js, which
   wires up unrelated cart/checkout/nav behavior admin.html doesn't want. */
let previewUrls = [];
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
  modal.querySelector(".lightbox-img").src = previewUrls[previewIndex];
  const multi = previewUrls.length > 1;
  modal.querySelector(".lightbox-prev").hidden = !multi;
  modal.querySelector(".lightbox-next").hidden = !multi;
}

function stepPhotoPreview(delta) {
  if (previewUrls.length < 2) return;
  previewIndex = (previewIndex + delta + previewUrls.length) % previewUrls.length;
  renderPhotoPreviewFrame();
}

/* Opens the shared lightbox on an arbitrary set of URLs — nav arrows
   auto-hide via renderPhotoPreviewFrame() whenever there's only one. */
function openImagePreviewSet(urls, index) {
  previewUrls = urls;
  previewIndex = index || 0;
  const modal = ensurePhotoPreviewModal();
  renderPhotoPreviewFrame();
  modal.classList.add("open");
}

/* Single-image preview (hero/logo/category card photo). */
function openImagePreview(url) {
  openImagePreviewSet([url], 0);
}

function closePhotoPreview() {
  const modal = document.getElementById("adminPhotoPreview");
  if (modal) modal.classList.remove("open");
}

/* Wires a static .photo-preview container (its innerHTML is replaced
   on every render, so delegation beats re-binding per-render) to open
   the lightbox when it currently holds an <img>. */
function wireClickablePhotoPreview(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.addEventListener("click", () => {
    const img = container.querySelector("img");
    if (img) openImagePreview(img.src);
  });
}

/* Same idea as wireClickablePhotoPreview(), but for a list container
   (#itemList/#collectionList) whose rows are rebuilt wholesale on every
   render — one delegated listener on the stable container outlives every
   re-render, instead of needing to be rebound per row each time. Each
   row's .admin-item-thumb opens the shared lightbox; getPreviewSet(id)
   resolves that row's own id to {urls, index}. */
function wireClickableThumbList(containerId, getPreviewSet) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.addEventListener("click", (e) => {
    const thumb = e.target.closest(".admin-item-thumb");
    if (!thumb || !thumb.querySelector("img")) return;
    const row = thumb.closest("[data-id]");
    if (!row) return;
    const set = getPreviewSet(row.dataset.id);
    if (set && set.urls.length) openImagePreviewSet(set.urls, set.index || 0);
  });
}

/* Shared native-HTML5-drag reordering for a list of .draggable-row
   elements. `cache` is the array backing the rendered rows (mutated in
   place to match the new order); `onDrop` persists the new order and
   should itself trigger a re-render when it resolves. */
let draggedRowIndex = null;

function wireUpRowReorder(listEl, selector, cache, onDrop) {
  listEl.querySelectorAll(selector).forEach((row) => {
    row.addEventListener("dragstart", () => {
      draggedRowIndex = Number(row.dataset.index);
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      draggedRowIndex = null;
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("drag-over");
      const targetIndex = Number(row.dataset.index);
      if (draggedRowIndex === null || draggedRowIndex === targetIndex) return;
      const [moved] = cache.splice(draggedRowIndex, 1);
      cache.splice(targetIndex, 0, moved);
      onDrop(cache);
    });
  });
}

/* Shared by the Collections, Nav and FAQ drag-to-reorder lists. Every
   row's write is checked; if any fail the admin is told, and the list is
   re-read from the database either way so it shows what was really saved
   rather than a half-applied order. */
async function persistSortOrder(table, cache, refresh) {
  const client = getSupabaseClient();
  const results = await Promise.all(cache.map((row, i) => mustAffect(client.from(table).update({ sort_order: i }).eq("id", row.id))));
  const failed = results.filter((r) => r.error);
  if (failed.length) alert(`Couldn't save the new order (${failed.length} of ${cache.length} rows failed): ${failed[0].error.message}`);
  await refresh();
}

/* `folder` is optional (the Gallery tab passes "gallery"); without it the
   file goes in the bucket root as before. */
async function uploadSiteImage(client, file, compressOptions, folder) {
  const compressed = await compressImageFile(file, compressOptions);
  const safeName = compressed.name.replace(/[^a-zA-Z0-9.-]/g, "_");
  const path = `${folder ? folder + "/" : ""}${Date.now()}-${safeName}`;
  const { error } = await client.storage.from("site-images").upload(path, compressed, { upsert: true });
  if (error) throw new Error("Image upload failed: " + error.message);
  const { data: pub } = client.storage.from("site-images").getPublicUrl(path);
  return pub.publicUrl;
}

/* ===== Tabs owned by the IIFE modules =====
   Two independent features share the Delivery tab, each in its own file
   (js/admin-availability.js, js/admin-delivery-areas.js). Past events
   gallery — lives in js/admin-gallery.js. Those files are loaded after
   this one, so the window.* functions are looked up when the tab opens. */
registerAdminTab("delivery", { btnId: "tabDeliveryBtn", panelId: "deliveryPanel", onEnter: () => {
  window.refreshAvailabilityAdmin();
  window.refreshDeliveryAreaAdmin();
} });
registerAdminTab("gallery", { btnId: "tabGalleryBtn", panelId: "galleryPanel", onEnter: () => window.refreshGalleryAdmin() });

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
  watchForLostSession(client);
  document.getElementById("logoutBtn").addEventListener("click", handleLogout);
  // Closing/reloading the page with unsaved item or settings edits.
  window.addEventListener("beforeunload", (e) => {
    if (anyAdminFormDirty()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  Object.keys(TABS).forEach((key) => {
    document.getElementById(TABS[key].btnId).addEventListener("click", () => switchTab(key));
  });

  // Every feature file's own DOM wiring (see onAdminInit()).
  adminInitHooks.forEach((fn) => fn(client));

  const { data: { session } } = await client.auth.getSession();
  if (session) {
    await enterDashboard();
  } else {
    showLoginView();
  }
});
