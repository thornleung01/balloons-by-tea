/* Admin "Library" tab and the photo-library picker modal (opened from the
   item form and from js/admin-gallery.js), plus the "Find unused photos"
   scan. Uses helpers from js/admin-core.js; the picker adds photos to the
   item form's currentPhotoEntries (js/admin-products.js). */

/* ===== Photo library (folder-aware) =====
   Every photo ever uploaded through the item form already lives in the
   "product-photos" Storage bucket indefinitely (nothing deletes the
   underlying file when a product is edited/deleted, only the DB row's
   reference to it) — so the bucket is already a de facto reusable photo
   library. This gives it real browsing: folders (Storage path prefixes —
   there's no separate "create folder" API, so a folder is materialized
   by uploading an empty <folder>/.keep placeholder into it, same trick
   the bucket itself already relies on implicitly) plus two front ends
   that share the same listing/rendering code:
     - a picker MODAL, opened from the item form, for choosing (possibly
       multiple) existing photos to attach to the product being edited
     - a full Library TAB, for browsing/organizing/uploading independent
       of any one product
   Photos picked via the modal become ordinary {type:"url", value:url}
   entries in currentPhotoEntries — the exact same shape startEdit()
   already produces for a product's existing photos — so handleSaveItem()
   needs no changes at all to support them. */

async function listLibraryPath(path) {
  const client = getSupabaseClient();
  const { data, error } = await client.storage
    .from("product-photos")
    .list(path || "", { limit: 500, sortBy: { column: "name", order: "asc" } });
  // Report the failure instead of returning an empty listing: an outage
  // would otherwise read as "Nothing here yet" and an empty folder check
  // would pass.
  if (error) return { folders: [], files: [], error: error.message };
  const folders = [];
  const files = [];
  (data || []).forEach((entry) => {
    if (!entry.name || entry.name === ".keep") return;
    if (entry.id === null) {
      folders.push(entry.name);
    } else {
      const fullPath = path ? `${path}/${entry.name}` : entry.name;
      files.push({ name: entry.name, path: fullPath, url: client.storage.from("product-photos").getPublicUrl(fullPath).data.publicUrl });
    }
  });
  return { folders, files };
}

/* Recursively walks every folder in the bucket — listLibraryPath() only
   sees one level at a time — and flattens the whole tree into one list
   of files, each with its bucket-relative path and public URL. This is
   the full real inventory "Find unused photos" diffs against whatever's
   actually referenced in the database. */
async function walkLibraryTree(path) {
  const { folders, files, error } = await listLibraryPath(path);
  if (error) throw new Error(error); // a skipped folder would make the scan quietly incomplete
  let all = files.slice();
  for (const folderName of folders) {
    const subPath = path ? `${path}/${folderName}` : folderName;
    const nested = await walkLibraryTree(subPath);
    all = all.concat(nested);
  }
  return all;
}

/* Every place a photo URL can be referenced from the database — checked
   so "Find unused photos" never flags something actually in use:
     - products.image_url and every entry of products.images (the item
       form's photo gallery — see handleSaveItem() in js/admin-products.js)
     - collections.card_image_url (category card photo)
     - site_settings.value for every row. hero_image_url and logo_url are
       the only keys that actually hold a photo today (see
       loadSettingsIntoForm()/handleSaveSettings() in js/admin-settings.js), but every
       row's value is folded in regardless of key — costs nothing and
       can't produce a false "unused" result.
     - layout_overrides.value for every row. The live visual editor
       (js/layout-editor.js applyLayoutOverrides(), js/edit-mode.js
       RESETTABLE_PROPERTIES) only ever stores one of text/padding-bottom/
       font-size/font-family/text-color/bg-color/order/translate-x/
       translate-y/scale/hidden/locked as a property's value — none of
       those is an image URL, so this table can't actually reference a
       photo today. Queried and folded in anyway, defensively, in case
       that ever changes.
     - gallery_items.image_url (the Gallery tab's photos), skipped when
       that table hasn't been created yet.
   Note: collection card photos and the settings hero/logo photo are
   actually uploaded to a different bucket entirely ("site-images", see
   uploadSiteImage() in js/admin-core.js) rather than "product-photos", so in practice
   neither of those two sources will ever match anything in this bucket's
   scan — but their values are still included here since checking them
   costs nothing and guards against any future change in how they're
   stored. */
/* Gallery tab (js/admin-gallery.js): gallery_items.image_url is a photo
   reference too. That table only exists once the "Gallery" section of supabase-setup.sql has been
   run, so a missing table counts as "no gallery photos" here; any other
   read error is returned as-is so the callers below still refuse to guess. */
async function selectGalleryItemsForReferences(client, columns) {
  const res = await client.from("gallery_items").select(columns);
  if (res.error && isMissingTableError(res.error, "gallery_items")) return { data: [], error: null };
  return res;
}

async function gatherReferencedPhotoUrls() {
  const client = getSupabaseClient();
  const urls = new Set();
  const add = (v) => { if (v && typeof v === "string" && v.trim()) urls.add(v.trim()); };

  const [productsRes, collectionsRes, settingsRes, overridesRes, galleryRes] = await Promise.all([
    client.from("products").select("image_url,images"),
    client.from("collections").select("card_image_url"),
    client.from("site_settings").select("key,value"),
    client.from("layout_overrides").select("value"),
    selectGalleryItemsForReferences(client, "image_url") // Gallery tab
  ]);

  const firstError = productsRes.error || collectionsRes.error || settingsRes.error || overridesRes.error || galleryRes.error;
  if (firstError) throw new Error(firstError.message);
  (galleryRes.data || []).forEach((g) => add(g.image_url)); // Gallery tab

  (productsRes.data || []).forEach((p) => {
    add(p.image_url);
    if (Array.isArray(p.images)) p.images.forEach(add);
  });
  (collectionsRes.data || []).forEach((c) => add(c.card_image_url));
  (settingsRes.data || []).forEach((s) => add(s.value));
  (overridesRes.data || []).forEach((o) => add(o.value));

  return urls;
}

/* Diffs the bucket's real contents against every referenced URL gathered
   above. Matches full public URL to full public URL (not path to URL),
   since that's the exact form stored in every DB column checked — each
   Storage file's URL is built the same way (client.storage.from(...)
   .getPublicUrl(path)) that every admin save path already uses
   to produce the URLs that end up in the database. A defensive query/
   hash-stripped comparison is also checked, in case a stored URL ever
   picked up a suffix a freshly-built public URL wouldn't have. When in
   doubt a file counts as "referenced" (excluded), never "unused". */
async function findUnusedLibraryPhotos() {
  const allFiles = await walkLibraryTree("");
  const referenced = await gatherReferencedPhotoUrls();
  const stripSuffix = (u) => u.split("?")[0].split("#")[0];
  const referencedStripped = new Set(Array.from(referenced, stripSuffix));
  return allFiles.filter((f) => !referenced.has(f.url) && !referencedStripped.has(stripSuffix(f.url)));
}

function libraryBreadcrumbSegments(path) {
  const segments = [{ label: "Library", path: "" }];
  if (!path) return segments;
  let acc = "";
  path.split("/").filter(Boolean).forEach((part) => {
    acc = acc ? `${acc}/${part}` : part;
    segments.push({ label: part, path: acc });
  });
  return segments;
}

function libraryBreadcrumbHtml(path, navAttr) {
  const segs = libraryBreadcrumbSegments(path);
  return segs.map((seg, i) => `
    <button type="button" class="library-breadcrumb-item" ${navAttr}="${escapeHtml(seg.path)}" ${i === segs.length - 1 ? "disabled" : ""}>${escapeHtml(seg.label)}</button>
  `).join(`<span class="library-breadcrumb-sep">/</span>`);
}

/* Finds every real, human-readable place a given photo URL is currently
   referenced from — used to warn before a destructive delete. Checks the
   same sources as gatherReferencedPhotoUrls(), just keeping track of
   WHERE each match came from instead of only whether one exists. Throws if
   any lookup fails: "couldn't check" must never be mistaken for "unused". */
async function findReferencesForUrl(url) {
  const client = getSupabaseClient();
  const refs = [];
  const [productsRes, collectionsRes, settingsRes, galleryRes] = await Promise.all([
    client.from("products").select("id,name,image_url,images"),
    client.from("collections").select("id,title,card_image_url"),
    client.from("site_settings").select("key,value"),
    selectGalleryItemsForReferences(client, "id,caption,image_url") // Gallery tab
  ]);
  const readError = productsRes.error || collectionsRes.error || settingsRes.error || galleryRes.error;
  if (readError) throw new Error(readError.message);

  (productsRes.data || []).forEach((p) => {
    const inImages = Array.isArray(p.images) && p.images.includes(url);
    if (p.image_url === url || inImages) refs.push(`product "${p.name}"`);
  });
  (galleryRes.data || []).forEach((g) => {
    if (g.image_url === url) refs.push(g.caption ? `gallery photo "${g.caption}"` : `gallery photo #${g.id}`);
  });
  (collectionsRes.data || []).forEach((c) => {
    if (c.card_image_url === url) refs.push(`category "${c.title}"`);
  });
  (settingsRes.data || []).forEach((s) => {
    if (s.value === url) refs.push(`site setting "${s.key}"`);
  });
  return refs;
}

/* Works out (without writing anything) every DB change needed to repoint
   references from oldUrl to newUrl. Throws if any lookup fails, so a move
   can be refused before anything has changed. Returns a list of functions,
   each performing one checked write. */
async function planReferenceUpdates(oldUrl, newUrl) {
  const client = getSupabaseClient();
  const [productsRes, collectionsRes, settingsRes, galleryRes] = await Promise.all([
    client.from("products").select("id,image_url,images"),
    client.from("collections").select("id,card_image_url"),
    client.from("site_settings").select("key,value"),
    selectGalleryItemsForReferences(client, "id,image_url") // Gallery tab
  ]);
  const readError = productsRes.error || collectionsRes.error || settingsRes.error || galleryRes.error;
  if (readError) throw new Error(readError.message);

  const writes = [];
  (galleryRes.data || []).forEach((g) => {
    if (g.image_url === oldUrl) writes.push(() => mustAffect(client.from("gallery_items").update({ image_url: newUrl }).eq("id", g.id)));
  });
  (productsRes.data || []).forEach((p) => {
    const inImages = Array.isArray(p.images) && p.images.includes(oldUrl);
    if (p.image_url !== oldUrl && !inImages) return;
    const images = Array.isArray(p.images) ? p.images.map((u) => (u === oldUrl ? newUrl : u)) : p.images;
    const image_url = p.image_url === oldUrl ? newUrl : p.image_url;
    writes.push(() => mustAffect(client.from("products").update({ image_url, images }).eq("id", p.id)));
  });
  (collectionsRes.data || []).forEach((c) => {
    if (c.card_image_url === oldUrl) writes.push(() => mustAffect(client.from("collections").update({ card_image_url: newUrl }).eq("id", c.id)));
  });
  (settingsRes.data || []).forEach((s) => {
    if (s.value === oldUrl) writes.push(() => mustAffect(client.from("site_settings").update({ value: newUrl }).eq("key", s.key)));
  });
  return writes;
}

/* Deletes one Library photo. Returns { deleted, error }: a cancelled
   confirm is { deleted: false, error: null }, which callers must NOT treat
   as a successful delete. Pass { skipReferenceCheck: true } only when the
   caller has just verified the photo is unused itself. */
async function deleteLibraryFile(path, { skipReferenceCheck = false } = {}) {
  const client = getSupabaseClient();
  if (!skipReferenceCheck) {
    const url = client.storage.from("product-photos").getPublicUrl(path).data.publicUrl;
    let refs;
    try {
      refs = await findReferencesForUrl(url);
    } catch (err) {
      const proceed = await adminConfirm({ title: "Couldn't check where this photo is used", message: `Couldn't check whether this photo is still used by a product (${err.message}). If it is, deleting it will break that listing. Delete anyway?`, confirmLabel: "Delete anyway", danger: true });
      if (!proceed) return { deleted: false, error: null };
      refs = [];
    }
    if (refs.length) {
      const proceed = await adminConfirm({
        title: "This photo is in use",
        message: `This photo is currently used by ${refs.join(", ")}. Deleting it will break ${refs.length === 1 ? "that listing" : "those listings"}. Delete anyway?`,
        confirmLabel: "Delete anyway",
        danger: true,
      });
      if (!proceed) return { deleted: false, error: null };
    }
  }
  const { error } = await client.storage.from("product-photos").remove([path]);
  return error ? { deleted: false, error: error.message } : { deleted: true, error: null };
}

async function deleteLibraryFolder(path) {
  // No recursive delete — refuse rather than silently nuking contents.
  // The admin can move/delete what's inside first, same as any ordinary
  // file manager would require.
  const { folders, files, error: listError } = await listLibraryPath(path);
  if (listError) return `Couldn't check whether that folder is empty, so it wasn't deleted: ${listError}`;
  if (folders.length || files.length) return "That folder isn't empty — move or delete what's inside it first.";
  const client = getSupabaseClient();
  const { error } = await client.storage.from("product-photos").remove([`${path}/.keep`]);
  return error ? error.message : null;
}

async function moveLibraryFile(fromPath, toFolder) {
  const filename = fromPath.split("/").pop();
  const toPath = toFolder ? `${toFolder}/${filename}` : filename;
  if (toPath === fromPath) return null;
  const client = getSupabaseClient();
  const fromUrl = client.storage.from("product-photos").getPublicUrl(fromPath).data.publicUrl;
  const toUrl = client.storage.from("product-photos").getPublicUrl(toPath).data.publicUrl;

  // Plan the reference updates BEFORE moving: if we can't even read what
  // uses this photo, refuse now while nothing has changed.
  let forward, backward;
  try {
    forward = await planReferenceUpdates(fromUrl, toUrl);
  } catch (err) {
    return `Couldn't check what uses this photo, so it wasn't moved: ${err.message}`;
  }

  const { error } = await client.storage.from("product-photos").move(fromPath, toPath);
  if (error) return error.message;

  // The file's URL just changed — repoint everything that used it, so
  // organizing photos into folders never silently breaks a listing.
  const results = await Promise.all(forward.map((write) => write()));
  const failed = results.filter((r) => r.error);
  if (failed.length) {
    // Roll back so the site stays consistent: put the file back, and undo
    // whichever reference updates did succeed. Report honestly if the
    // rollback itself fails — never claim "nothing changed" when it did.
    const reason = failed[0].error.message;
    const { error: moveBackError } = await client.storage.from("product-photos").move(toPath, fromPath);
    if (moveBackError) {
      return `Photo move failed partway and couldn't be undone: the file is now in "${toFolder || "Library"}" but ${failed.length} listing${failed.length === 1 ? "" : "s"} still point at its old location, so those images may be broken. Move it back manually. (${reason}; move-back: ${moveBackError.message})`;
    }
    let revertProblem = null;
    try {
      backward = await planReferenceUpdates(toUrl, fromUrl);
      const reverted = await Promise.all(backward.map((write) => write()));
      const revertFailed = reverted.filter((r) => r.error);
      if (revertFailed.length) revertProblem = revertFailed[0].error.message;
    } catch (err) {
      revertProblem = err.message;
    }
    if (revertProblem) {
      return `Photo move failed and the file was put back, but some listings couldn't be pointed back at it — check products using "${filename}" for broken images. (${reason}; revert: ${revertProblem})`;
    }
    return `Photo not moved — couldn't update ${failed.length} place${failed.length === 1 ? "" : "s"} that use it (${reason}). Nothing was changed.`;
  }
  if (forward.length > 0) {
    adminToast(`Moved — and updated ${forward.length} place${forward.length === 1 ? "" : "s"} that was using this photo so it keeps working.`, { kind: "success" });
  }
  return null;
}

/* Builds the folders+files markup shared by the Library tab and the item-
   form picker modal. selectedUrls is null outside picker mode (the tab
   has no multi-select — clicking a photo there opens the lightbox). */
function libraryGridHtml(path, entries, selectedUrls) {
  const { folders, files } = entries;
  const upTile = path ? `
    <div class="library-folder-item library-up-item" data-nav-up>
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span>Up one level</span>
    </div>
  ` : "";
  const folderHtml = folders.map((name) => `
    <div class="library-folder-item" data-open-folder="${escapeHtml(name)}">
      <button type="button" class="library-item-delete" data-delete-folder="${escapeHtml(name)}" aria-label="Delete folder ${escapeHtml(name)}">&times;</button>
      <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" stroke-linejoin="round"/></svg>
      <span>${escapeHtml(name)}</span>
    </div>
  `).join("");
  const fileHtml = files.map((f) => `
    <div class="photo-library-item ${selectedUrls && selectedUrls.has(f.url) ? "selected" : ""}" data-url="${escapeHtml(f.url)}" data-path="${escapeHtml(f.path)}" draggable="true">
      <img src="${escapeHtml(f.url)}" alt="${escapeHtml(f.name)}"/>
      <button type="button" class="library-item-delete" data-delete-file="${escapeHtml(f.path)}" aria-label="Delete photo ${escapeHtml(f.name)}">&times;</button>
    </div>
  `).join("");
  if (!upTile && !folderHtml && !fileHtml) return `<p class="empty-note">Nothing here yet — upload a photo or create a folder.</p>`;
  return upTile + folderHtml + fileHtml;
}

/* Wires click/delete/drag-drop behavior onto a freshly-rendered library
   grid. Drag a photo onto a folder tile (or the "up one level" tile) to
   move it there via Storage's own move() — no re-upload needed. */
function wireLibraryGrid(gridEl, { navigate, onFileClick, afterMutate, getPath }) {
  gridEl.querySelectorAll("[data-open-folder]").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".library-item-delete")) return;
      const base = getPath();
      navigate(base ? `${base}/${el.dataset.openFolder}` : el.dataset.openFolder);
    });
  });
  const upTile = gridEl.querySelector("[data-nav-up]");
  if (upTile) {
    upTile.addEventListener("click", () => {
      const parts = getPath().split("/");
      parts.pop();
      navigate(parts.join("/"));
    });
  }
  gridEl.querySelectorAll(".photo-library-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".library-item-delete")) return;
      onFileClick(el.dataset.url, el.dataset.path);
    });
  });
  gridEl.querySelectorAll("[data-delete-file]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const photoName = String(btn.dataset.deleteFile).split("/").pop();
      if (!(await adminConfirm({ title: `Delete photo "${photoName}"?`, message: "This can't be undone.", confirmLabel: "Delete photo", danger: true }))) return;
      const result = await deleteLibraryFile(btn.dataset.deleteFile);
      if (result.error) { adminToast("Couldn't delete: " + result.error, { kind: "error" }); return; }
      if (result.deleted) afterMutate();
    });
  });
  gridEl.querySelectorAll("[data-delete-folder]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const base = getPath();
      const folderPath = base ? `${base}/${btn.dataset.deleteFolder}` : btn.dataset.deleteFolder;
      if (!(await adminConfirm({ title: `Delete the "${btn.dataset.deleteFolder}" folder?`, message: "Only empty folders can be deleted.", confirmLabel: "Delete folder", danger: true }))) return;
      const error = await deleteLibraryFolder(folderPath);
      if (error) { adminToast(error, { kind: "error" }); return; }
      afterMutate();
    });
  });

  gridEl.querySelectorAll(".photo-library-item").forEach((el) => {
    el.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", el.dataset.path);
      e.dataTransfer.effectAllowed = "move";
      el.classList.add("dragging");
    });
    el.addEventListener("dragend", () => el.classList.remove("dragging"));
  });
  gridEl.querySelectorAll("[data-open-folder], [data-nav-up]").forEach((el) => {
    el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("drop-target-active"); });
    el.addEventListener("dragleave", () => el.classList.remove("drop-target-active"));
    el.addEventListener("drop", async (e) => {
      e.preventDefault();
      el.classList.remove("drop-target-active");
      const fromPath = e.dataTransfer.getData("text/plain");
      if (!fromPath) return;
      const base = getPath();
      let toFolder;
      if (el.dataset.openFolder) {
        toFolder = base ? `${base}/${el.dataset.openFolder}` : el.dataset.openFolder;
      } else {
        const parts = base.split("/");
        parts.pop();
        toFolder = parts.join("/");
      }
      const error = await moveLibraryFile(fromPath, toFolder);
      if (error) { adminToast("Couldn't move: " + error, { kind: "error" }); return; }
      afterMutate();
    });
  });
}

async function createFolderAt(basePath, rawName) {
  const name = String(rawName || "").trim().replace(/[\/\\]+/g, "-").replace(/[^a-zA-Z0-9 _-]/g, "").trim();
  if (!name) return { error: "Enter a folder name." };
  const path = basePath ? `${basePath}/${name}/.keep` : `${name}/.keep`;
  const client = getSupabaseClient();
  const { error } = await client.storage.from("product-photos").upload(path, new Blob([""]), { upsert: false });
  if (error) return { error: /exists/i.test(error.message) ? "A folder with that name already exists here." : error.message };
  return { error: null };
}

async function uploadFilesToLibrary(basePath, files) {
  const client = getSupabaseClient();
  for (const file of files) {
    const compressed = await compressImageFile(file);
    const safeName = compressed.name.replace(/[^a-zA-Z0-9.-]/g, "_");
    const path = basePath ? `${basePath}/${Date.now()}-${safeName}` : `${Date.now()}-${safeName}`;
    const { error } = await client.storage.from("product-photos").upload(path, compressed, { upsert: true });
    if (error) return { error: error.message };
  }
  return { error: null };
}

/* ----- Picker modal (used from the item form) ----- */
let pickerPath = "";
let pickerEntries = { folders: [], files: [] };
let photoLibrarySelected = new Set();

function ensurePhotoLibraryModal() {
  let modal = document.getElementById("photoLibraryModal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.className = "modal";
  modal.id = "photoLibraryModal";
  modal.innerHTML = `
    <div class="modal-scrim" data-close-library></div>
    <div class="modal-panel photo-library-panel">
      <div class="modal-head">
        <div>
          <h2>Choose from library</h2>
          <p>Every photo you've uploaded before. Pick as many as you want to add to this item.</p>
        </div>
        <button type="button" class="icon-btn" data-close-library aria-label="Close">&times;</button>
      </div>
      <div class="modal-body">
        <div class="library-breadcrumb" id="pickerBreadcrumb"></div>
        <div class="library-toolbar">
          <button type="button" class="btn btn-outline btn-sm" id="pickerNewFolderBtn">New folder</button>
          <label class="btn btn-outline btn-sm" for="pickerUploadInput">Upload here</label>
          <input id="pickerUploadInput" type="file" accept="image/*" multiple hidden/>
        </div>
        <div class="photo-library-grid" id="photoLibraryGrid"></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-primary" id="photoLibraryAddBtn" disabled>Add selected</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelectorAll("[data-close-library]").forEach((el) => el.addEventListener("click", closePhotoLibrary));
  modal.querySelector("#photoLibraryAddBtn").addEventListener("click", addSelectedLibraryPhotos);
  modal.querySelector("#pickerNewFolderBtn").addEventListener("click", async () => {
    const name = await adminConfirm.input({ title: "New folder", label: "New folder name", confirmLabel: "Create folder" });
    if (!name) return;
    const { error } = await createFolderAt(pickerPath, name);
    if (error) { adminToast(error, { kind: "error" }); return; }
    await navigatePickerTo(pickerPath);
  });
  modal.querySelector("#pickerUploadInput").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    const { error } = await uploadFilesToLibrary(pickerPath, files);
    if (error) { adminToast("Upload failed: " + error, { kind: "error" }); return; }
    await navigatePickerTo(pickerPath);
  });
  modal.querySelector("#pickerBreadcrumb").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-picker-nav]");
    if (btn) navigatePickerTo(btn.dataset.pickerNav);
  });
  return modal;
}

async function navigatePickerTo(path) {
  pickerPath = path || "";
  const grid = document.getElementById("photoLibraryGrid");
  grid.innerHTML = `<p class="empty-note">Loading...</p>`;
  pickerEntries = await listLibraryPath(pickerPath);
  if (pickerEntries.error) {
    grid.innerHTML = `<p class="form-status error">Couldn't load photos: ${escapeHtml(pickerEntries.error)}</p>`;
    return;
  }
  renderPhotoLibraryGrid();
}

function renderPhotoLibraryGrid() {
  const grid = document.getElementById("photoLibraryGrid");
  const breadcrumb = document.getElementById("pickerBreadcrumb");
  if (!grid) return;
  if (breadcrumb) breadcrumb.innerHTML = libraryBreadcrumbHtml(pickerPath, "data-picker-nav");
  grid.innerHTML = libraryGridHtml(pickerPath, pickerEntries, photoLibrarySelected);
  wireLibraryGrid(grid, {
    navigate: navigatePickerTo,
    getPath: () => pickerPath,
    afterMutate: () => navigatePickerTo(pickerPath),
    onFileClick: (url) => {
      if (photoLibrarySelected.has(url)) photoLibrarySelected.delete(url);
      else photoLibrarySelected.add(url);
      renderPhotoLibraryGrid();
    }
  });
  updatePhotoLibraryAddBtn();
}

function updatePhotoLibraryAddBtn() {
  const btn = document.getElementById("photoLibraryAddBtn");
  if (!btn) return;
  const count = photoLibrarySelected.size;
  btn.disabled = count === 0;
  btn.textContent = count > 0 ? `Add selected (${count})` : "Add selected";
}

/* Gallery tab (js/admin-gallery.js) reuses this picker: it passes
   { onAdd(urls), subtitle }. The item form's button passes the click event
   instead, which has no onAdd, so it keeps the original behavior. */
let photoLibraryAddHandler = null;
const PHOTO_LIBRARY_DEFAULT_SUBTITLE = "Every photo you've uploaded before. Pick as many as you want to add to this item.";

async function openPhotoLibrary(options) {
  const modal = ensurePhotoLibraryModal();
  photoLibraryAddHandler = options && typeof options.onAdd === "function" ? options.onAdd : null;
  const subtitle = modal.querySelector(".modal-head p");
  if (subtitle) subtitle.textContent = (photoLibraryAddHandler && options.subtitle) || PHOTO_LIBRARY_DEFAULT_SUBTITLE;
  photoLibrarySelected.clear();
  modal.classList.add("open");
  await navigatePickerTo("");
}

function closePhotoLibrary() {
  const modal = document.getElementById("photoLibraryModal");
  if (modal) modal.classList.remove("open");
}

function addSelectedLibraryPhotos() {
  if (photoLibraryAddHandler) { // opened from the Gallery tab
    const handler = photoLibraryAddHandler;
    const urls = Array.from(photoLibrarySelected);
    photoLibraryAddHandler = null;
    closePhotoLibrary();
    handler(urls);
    return;
  }
  const existingUrls = new Set(currentPhotoEntries.filter((e) => e.type === "url").map((e) => e.value));
  photoLibrarySelected.forEach((url) => {
    if (existingUrls.has(url)) return; // already in this item's gallery, don't duplicate
    currentPhotoEntries.push({ type: "url", value: url });
  });
  renderPhotoGallery();
  closePhotoLibrary();
}

/* ----- Library tab (independent browsing/organizing) ----- */
let libraryTabPath = "";
let libraryTabEntries = { folders: [], files: [] };

async function refreshLibraryPanel() {
  await navigateLibraryTab(libraryTabPath);
}

async function navigateLibraryTab(path) {
  libraryTabPath = path || "";
  const grid = document.getElementById("libraryTabGrid");
  if (!grid) return;
  grid.innerHTML = `<p class="empty-note">Loading...</p>`;
  libraryTabEntries = await listLibraryPath(libraryTabPath);
  if (libraryTabEntries.error) {
    grid.innerHTML = `<p class="form-status error">Couldn't load photos: ${escapeHtml(libraryTabEntries.error)}</p>`;
    return;
  }
  renderLibraryTabGrid();
}

function renderLibraryTabGrid() {
  const grid = document.getElementById("libraryTabGrid");
  const breadcrumb = document.getElementById("libraryTabBreadcrumb");
  if (!grid) return;
  if (breadcrumb) breadcrumb.innerHTML = libraryBreadcrumbHtml(libraryTabPath, "data-library-nav");
  grid.innerHTML = libraryGridHtml(libraryTabPath, libraryTabEntries, null);
  wireLibraryGrid(grid, {
    navigate: navigateLibraryTab,
    getPath: () => libraryTabPath,
    afterMutate: () => navigateLibraryTab(libraryTabPath),
    onFileClick: (url) => openImagePreviewSet([url], 0)
  });
}

/* ----- "Find unused photos" review panel -----
   A one-off scan, shown inline below the ordinary Library grid (not a
   modal — this tool is specific to the Library tab, unlike the picker
   modal which is also opened from the item form). Deliberately
   conservative: nothing is ever auto-selected or auto-deleted. The admin
   has to tick individual photos and press "Delete selected" themselves;
   this is a permanent Storage delete with no undo. */
let unusedPhotosCandidates = [];
let unusedPhotosSelected = new Set();

async function openUnusedPhotosSection() {
  const section = document.getElementById("unusedPhotosSection");
  const status = document.getElementById("unusedPhotosStatus");
  const grid = document.getElementById("unusedPhotosGrid");
  const actions = document.getElementById("unusedPhotosActions");
  const triggerBtn = document.getElementById("findUnusedPhotosBtn");
  if (!section || !status || !grid) return;

  section.hidden = false;
  actions.hidden = true;
  grid.innerHTML = "";
  unusedPhotosSelected = new Set();
  status.textContent = "Scanning the whole photo library and checking it against every product, collection, and setting — this can take a moment...";
  if (triggerBtn) triggerBtn.disabled = true;

  try {
    unusedPhotosCandidates = await findUnusedLibraryPhotos();
    renderUnusedPhotosSection();
  } catch (err) {
    status.textContent = "Couldn't finish the scan (" + (err.message || err) + "). Nothing was checked or deleted — try again.";
  } finally {
    if (triggerBtn) triggerBtn.disabled = false;
  }
}

function closeUnusedPhotosSection() {
  const section = document.getElementById("unusedPhotosSection");
  if (section) section.hidden = true;
  unusedPhotosCandidates = [];
  unusedPhotosSelected = new Set();
}

function renderUnusedPhotosSection() {
  const status = document.getElementById("unusedPhotosStatus");
  const grid = document.getElementById("unusedPhotosGrid");
  const actions = document.getElementById("unusedPhotosActions");
  if (!status || !grid || !actions) return;

  const count = unusedPhotosCandidates.length;
  if (!count) {
    status.textContent = "No unused photos found — every file in Storage is referenced by a product, collection, or setting.";
    grid.innerHTML = "";
    actions.hidden = true;
    return;
  }

  status.textContent = `${count} photo${count === 1 ? "" : "s"} appear${count === 1 ? "s" : ""} unused. Nothing is deleted until you select photos below and click "Delete selected" — this can't be undone.`;
  grid.innerHTML = unusedPhotosCandidates.map((f) => `
    <div class="photo-library-item ${unusedPhotosSelected.has(f.url) ? "selected" : ""}" data-url="${escapeHtml(f.url)}" role="checkbox" aria-checked="${unusedPhotosSelected.has(f.url)}" title="${escapeHtml(f.path)}">
      <img src="${escapeHtml(f.url)}" alt="${escapeHtml(f.name)}"/>
    </div>
  `).join("");
  grid.querySelectorAll(".photo-library-item").forEach((el) => {
    el.addEventListener("click", () => {
      const url = el.dataset.url;
      if (unusedPhotosSelected.has(url)) unusedPhotosSelected.delete(url);
      else unusedPhotosSelected.add(url);
      renderUnusedPhotosSection();
    });
  });
  actions.hidden = false;
  updateDeleteUnusedPhotosBtn();
}

function updateDeleteUnusedPhotosBtn() {
  const btn = document.getElementById("deleteUnusedPhotosBtn");
  if (!btn) return;
  const n = unusedPhotosSelected.size;
  btn.disabled = n === 0;
  btn.textContent = n > 0 ? `Delete selected (${n})` : "Delete selected";
}

async function handleDeleteSelectedUnusedPhotos() {
  const toDelete = unusedPhotosCandidates.filter((f) => unusedPhotosSelected.has(f.url));
  if (!toDelete.length) return;
  if (!(await adminConfirm({
    title: `Permanently delete ${toDelete.length} photo${toDelete.length === 1 ? "" : "s"}?`,
    message: "They will be removed from Storage. This can't be undone.",
    confirmLabel: `Delete ${toDelete.length} photo${toDelete.length === 1 ? "" : "s"}`,
    danger: true,
    requireText: toDelete.length >= 10 ? "DELETE" : undefined,
  }))) return;

  const btn = document.getElementById("deleteUnusedPhotosBtn");
  if (btn) btn.disabled = true;

  // Re-check references once, right before deleting: something may have
  // started using one of these photos since the scan. If the check itself
  // fails, delete nothing rather than guess.
  let referenced;
  try {
    referenced = await gatherReferencedPhotoUrls();
  } catch (err) {
    if (btn) btn.disabled = false;
    adminToast(`Couldn't re-check whether these photos are in use (${err.message}), so nothing was deleted. Try again.`, { kind: "error" });
    return;
  }
  const failures = [];
  const succeededPaths = new Set();
  for (const f of toDelete) {
    if (referenced.has(f.url)) { failures.push(`${f.name}: now used by a listing — skipped`); continue; }
    const result = await deleteLibraryFile(f.path, { skipReferenceCheck: true });
    if (result.deleted) succeededPaths.add(f.path);
    else failures.push(`${f.name}: ${result.error || "not deleted"}`);
  }

  unusedPhotosCandidates = unusedPhotosCandidates.filter((f) => !succeededPaths.has(f.path));
  toDelete.forEach((f) => { if (succeededPaths.has(f.path)) unusedPhotosSelected.delete(f.url); });
  renderUnusedPhotosSection();

  if (failures.length) await adminAlert("Some photos couldn't be deleted:\n" + failures.join("\n"), { title: "Some photos were not deleted" });

  // Refresh the main Library grid too — a deleted file may have lived in
  // (or emptied out) the folder currently being browsed there.
  await navigateLibraryTab(libraryTabPath);
}

registerAdminTab("library", { btnId: "tabLibraryBtn", panelId: "libraryPanel", onEnter: refreshLibraryPanel });

onAdminInit(() => {
  document.getElementById("libraryTabBreadcrumb").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-library-nav]");
    if (btn) navigateLibraryTab(btn.dataset.libraryNav);
  });
  document.getElementById("libraryNewFolderBtn").addEventListener("click", async () => {
    const name = await adminConfirm.input({ title: "New folder", label: "New folder name", confirmLabel: "Create folder" });
    if (!name) return;
    const { error } = await createFolderAt(libraryTabPath, name);
    if (error) { adminToast(error, { kind: "error" }); return; }
    await navigateLibraryTab(libraryTabPath);
  });
  document.getElementById("libraryUploadInput").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    const { error } = await uploadFilesToLibrary(libraryTabPath, files);
    if (error) { adminToast("Upload failed: " + error, { kind: "error" }); return; }
    await navigateLibraryTab(libraryTabPath);
  });
  document.getElementById("findUnusedPhotosBtn").addEventListener("click", openUnusedPhotosSection);
  document.getElementById("closeUnusedPhotosBtn").addEventListener("click", closeUnusedPhotosSection);
  document.getElementById("unusedSelectAllBtn").addEventListener("click", () => {
    unusedPhotosCandidates.forEach((f) => unusedPhotosSelected.add(f.url));
    renderUnusedPhotosSection();
  });
  document.getElementById("unusedSelectNoneBtn").addEventListener("click", () => {
    unusedPhotosSelected = new Set();
    renderUnusedPhotosSection();
  });
  document.getElementById("deleteUnusedPhotosBtn").addEventListener("click", handleDeleteSelectedUnusedPhotos);
});
