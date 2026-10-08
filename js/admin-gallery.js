/* Past events gallery (admin side). Renders into #galleryAdmin on the admin
   "Gallery" tab; js/admin.js calls window.refreshGalleryAdmin() whenever
   that tab is opened. Rows live in `gallery_items` (sql-parts/gallery.sql)
   and are shown on gallery.html by js/gallery.js.

   Reuses from js/admin.js: escapeHtml(), mustAffect() (around every
   write), persistSortOrder() + wireUpRowReorder() + the row lock toggles
   (reordering), openPhotoLibrary({ onAdd }) (the same Library picker the
   product form uses), uploadSiteImage(..., "gallery") (compressed upload
   into site-images/gallery/), openImagePreviewSet() (thumbnail preview).

   Deleting a gallery row never deletes the photo file: the file stays in
   its bucket, and the Library's "is this photo used?" checks know about
   gallery_items.image_url (see selectGalleryItemsForReferences()). */
(function () {
  const TABLE = "gallery_items";
  const CAPTION_MAX = 300;
  const OCCASION_MAX = 60;
  let galleryCache = [];
  let productOptions = [];
  let rendered = false;
  let busy = false;

  function renderShell(root) {
    root.innerHTML = `
      <div class="gallery-admin-head">
        <div>
          <h2>Past Events Gallery</h2>
          <p class="panel-subtitle">Photos for the public <a href="gallery.html" target="_blank" rel="noopener">Past events page</a>. Each one gets an "Order something like this" link: to the linked product, or to the custom order form with the photo attached. The page isn't in the menu until you add a nav item linking to <code>gallery.html</code> on the Nav tab.</p>
        </div>
      </div>
      <div class="library-toolbar gallery-admin-toolbar" id="galleryAdminToolbar">
        <button type="button" class="btn btn-outline btn-sm" id="galleryAddFromLibraryBtn">Add from library</button>
        <label class="btn btn-outline btn-sm" for="galleryUploadInput">Upload new photos</label>
        <input id="galleryUploadInput" type="file" accept="image/*" multiple hidden/>
      </div>
      <div class="form-status" id="galleryAdminStatus" role="status" aria-live="polite"></div>
      <datalist id="galleryOccasionOptions"></datalist>
      <div id="galleryAdminList"><p class="empty-note">Loading...</p></div>
    `;
    root.querySelector("#galleryAddFromLibraryBtn").addEventListener("click", () => {
      openPhotoLibrary({
        subtitle: "Pick the photos to add to the Past events gallery. They're added at the end, switched on.",
        onAdd: (urls) => addPhotos(urls)
      });
    });
    root.querySelector("#galleryUploadInput").addEventListener("change", handleUpload);
    const listEl = root.querySelector("#galleryAdminList");
    listEl.addEventListener("click", handleListClick);
    listEl.addEventListener("change", handleListChange);
    // Rows are only draggable while the handle is held, so text in the
    // caption/occasion inputs can still be selected with the mouse.
    listEl.addEventListener("pointerdown", (e) => {
      const handle = e.target.closest(".drag-handle");
      const row = e.target.closest(".draggable-row");
      if (handle && row && !row.querySelector(".lock-toggle.is-locked")) row.setAttribute("draggable", "true");
    });
    const undrag = () => listEl.querySelectorAll('.draggable-row[draggable="true"]').forEach((r) => r.setAttribute("draggable", "false"));
    listEl.addEventListener("pointerup", undrag);
    listEl.addEventListener("dragend", undrag);
    rendered = true;
  }

  function setStatus(message, kind) {
    const el = document.getElementById("galleryAdminStatus");
    if (!el) return;
    el.textContent = message || "";
    el.className = `form-status${kind ? " " + kind : ""}`;
  }

  function setToolbarEnabled(enabled) {
    const toolbar = document.getElementById("galleryAdminToolbar");
    if (!toolbar) return;
    toolbar.querySelectorAll("button, input").forEach((el) => { el.disabled = !enabled; });
    toolbar.classList.toggle("is-disabled", !enabled);
  }

  function showMissingTable() {
    const listEl = document.getElementById("galleryAdminList");
    const toolbar = document.getElementById("galleryAdminToolbar");
    if (toolbar) toolbar.hidden = true;
    setStatus("", null);
    if (listEl) {
      listEl.innerHTML = `<p class="form-status error gallery-admin-missing">The gallery isn't set up yet. Run the latest supabase-setup.sql (including sql-parts/gallery.sql) in your Supabase SQL Editor, then reopen this tab.</p>`;
    }
  }

  function productLabel(p) {
    return `${p.name}${p.active === false ? " (hidden in shop)" : ""}`;
  }

  function productSelectHtml(row) {
    const current = row.product_id === null || row.product_id === undefined ? "" : String(row.product_id);
    const known = productOptions.some((p) => String(p.id) === current);
    const options = [`<option value="">No product (links to custom order)</option>`]
      .concat(productOptions.map((p) => `<option value="${escapeHtml(p.id)}" ${String(p.id) === current ? "selected" : ""}>${escapeHtml(productLabel(p))}</option>`));
    // A product the list couldn't load (shouldn't happen) still shows as selected.
    if (current && !known) options.push(`<option value="${escapeHtml(current)}" selected>Product #${escapeHtml(current)}</option>`);
    return options.join("");
  }

  function renderOccasionOptions() {
    const list = document.getElementById("galleryOccasionOptions");
    if (!list) return;
    const seen = new Map();
    const addOption = (v) => {
      const label = String(v || "").trim();
      if (label && !seen.has(label.toLowerCase())) seen.set(label.toLowerCase(), label);
    };
    galleryCache.forEach((g) => addOption(g.occasion));
    (typeof collectionsCache !== "undefined" ? collectionsCache : []).forEach((c) => addOption(c.title));
    list.innerHTML = Array.from(seen.values()).sort((a, b) => a.localeCompare(b)).map((v) => `<option value="${escapeHtml(v)}"></option>`).join("");
  }

  function renderList() {
    const listEl = document.getElementById("galleryAdminList");
    if (!listEl) return;
    renderOccasionOptions();
    if (!galleryCache.length) {
      listEl.innerHTML = `<p class="empty-note">No gallery photos yet. Add some from the library or upload new ones. Until then the public page shows a friendly "photos are on their way" message.</p>`;
      return;
    }
    const last = galleryCache.length - 1;
    listEl.innerHTML = galleryCache.map((g, i) => `
      <div class="admin-item-row draggable-row gallery-admin-row ${g.active === false ? "inactive" : ""}" data-id="${escapeHtml(g.id)}" data-index="${i}" draggable="false">
        <div class="gallery-admin-order">
          ${lockHandleMarkup("gallery", g.id)}
          <span class="drag-handle" aria-hidden="true" title="Drag to reorder">&#8942;&#8942;</span>
          <button type="button" class="gallery-admin-move" data-move="-1" ${i === 0 ? "disabled" : ""} aria-label="Move up">&uarr;</button>
          <button type="button" class="gallery-admin-move" data-move="1" ${i === last ? "disabled" : ""} aria-label="Move down">&darr;</button>
        </div>
        <div class="admin-item-thumb gallery-admin-thumb" data-preview-index="${i}"><img src="${escapeHtml(g.image_url)}" alt="" loading="lazy"/></div>
        <div class="gallery-admin-fields">
          <label class="visually-hidden" for="ga-caption-${escapeHtml(g.id)}">Caption</label>
          <input id="ga-caption-${escapeHtml(g.id)}" class="gallery-admin-input" data-field="caption" type="text" maxlength="${CAPTION_MAX}" placeholder="Caption (optional)" value="${escapeHtml(g.caption || "")}"/>
          <div class="gallery-admin-field-row">
            <label class="visually-hidden" for="ga-occasion-${escapeHtml(g.id)}">Occasion</label>
            <input id="ga-occasion-${escapeHtml(g.id)}" class="gallery-admin-input" data-field="occasion" type="text" maxlength="${OCCASION_MAX}" list="galleryOccasionOptions" placeholder="Occasion (filter chip)" value="${escapeHtml(g.occasion || "")}"/>
            <label class="visually-hidden" for="ga-product-${escapeHtml(g.id)}">Linked product</label>
            <select id="ga-product-${escapeHtml(g.id)}" class="gallery-admin-input" data-field="product_id">${productSelectHtml(g)}</select>
          </div>
          <span class="gallery-admin-row-status" aria-live="polite"></span>
        </div>
        <div class="admin-item-actions">
          <label class="toggle-switch" title="${g.active === false ? "Hidden, click to show on the gallery page" : "Showing on the gallery page, click to hide"}">
            <input type="checkbox" class="gallery-active-toggle" data-id="${escapeHtml(g.id)}" aria-label="Show on gallery page" ${g.active !== false ? "checked" : ""}/>
            <span class="toggle-slider"></span>
          </label>
          <button type="button" class="danger gallery-delete-btn" data-id="${escapeHtml(g.id)}">Remove</button>
        </div>
      </div>
    `).join("");
    wireUpRowReorder(listEl, ".draggable-row", galleryCache, persistOrder);
    wireUpLockToggles(listEl, renderList);
  }

  async function persistOrder(cache) {
    await persistSortOrder(TABLE, cache, loadList);
  }

  function rowFor(el) {
    const row = el.closest(".gallery-admin-row");
    if (!row) return null;
    const item = galleryCache.find((g) => String(g.id) === row.dataset.id);
    return item ? { row, item } : null;
  }

  async function handleListClick(e) {
    const thumb = e.target.closest(".gallery-admin-thumb");
    if (thumb) {
      openImagePreviewSet(galleryCache.map((g) => g.image_url), Number(thumb.dataset.previewIndex) || 0);
      return;
    }
    const move = e.target.closest(".gallery-admin-move");
    if (move && !move.disabled) {
      const found = rowFor(move);
      if (!found || busy) return;
      const from = galleryCache.indexOf(found.item);
      const to = from + Number(move.dataset.move);
      if (to < 0 || to >= galleryCache.length) return;
      [galleryCache[from], galleryCache[to]] = [galleryCache[to], galleryCache[from]];
      busy = true;
      try { await persistOrder(galleryCache); } finally { busy = false; }
      return;
    }
    const del = e.target.closest(".gallery-delete-btn");
    if (del) {
      const found = rowFor(del);
      if (!found) return;
      const name = found.item.caption ? `"${found.item.caption}"` : "this photo";
      if (!confirm(`Remove ${name} from the gallery? The photo file itself stays in your Library.`)) return;
      del.disabled = true;
      const { error } = await mustAffect(getSupabaseClient().from(TABLE).delete().eq("id", found.item.id));
      if (error) {
        del.disabled = false;
        setStatus("Couldn't remove: " + error.message, "error");
        return;
      }
      setStatus("Removed from the gallery.", "success");
      await loadList();
    }
  }

  async function handleListChange(e) {
    const toggle = e.target.closest(".gallery-active-toggle");
    if (toggle) {
      const found = rowFor(toggle);
      if (!found) return;
      const active = toggle.checked;
      toggle.disabled = true;
      const { error } = await mustAffect(getSupabaseClient().from(TABLE).update({ active }).eq("id", found.item.id));
      if (error) {
        toggle.checked = !active;
        toggle.disabled = false;
        setStatus("Couldn't update: " + error.message, "error");
        return;
      }
      await loadList();
      return;
    }
    const input = e.target.closest(".gallery-admin-input");
    if (input) await saveField(input);
  }

  /* Inline edit: saved on change (blur / select), without re-rendering the
     list, so tabbing on to the next field keeps focus. */
  async function saveField(input) {
    const found = rowFor(input);
    if (!found) return;
    const field = input.dataset.field;
    let value;
    if (field === "product_id") {
      value = input.value ? Number(input.value) : null;
    } else {
      const max = field === "caption" ? CAPTION_MAX : OCCASION_MAX;
      value = input.value.trim().replace(/\s+/g, " ").slice(0, max);
      input.value = value;
    }
    const before = found.item[field] === undefined ? null : found.item[field];
    if ((before === null ? "" : String(before)) === (value === null ? "" : String(value))) return;

    const statusEl = found.row.querySelector(".gallery-admin-row-status");
    if (statusEl) { statusEl.textContent = "Saving..."; statusEl.className = "gallery-admin-row-status"; }
    input.disabled = true;
    const { error } = await mustAffect(getSupabaseClient().from(TABLE).update({ [field]: value }).eq("id", found.item.id));
    input.disabled = false;
    if (error) {
      if (field === "product_id") input.value = before === null ? "" : String(before);
      else input.value = before || "";
      if (statusEl) { statusEl.textContent = "Couldn't save: " + error.message; statusEl.className = "gallery-admin-row-status error"; }
      return;
    }
    found.item[field] = value;
    if (field === "occasion") renderOccasionOptions();
    if (statusEl) { statusEl.textContent = "Saved"; statusEl.className = "gallery-admin-row-status success"; }
  }

  function nextSortOrder() {
    return galleryCache.reduce((max, g) => Math.max(max, Number(g.sort_order) || 0), -1) + 1;
  }

  async function insertPhotos(urls) {
    const start = nextSortOrder();
    const rows = urls.map((image_url, i) => ({ image_url, sort_order: start + i, active: true }));
    return mustAffect(getSupabaseClient().from(TABLE).insert(rows));
  }

  async function addPhotos(urls) {
    const existing = new Set(galleryCache.map((g) => g.image_url));
    const fresh = urls.filter((u) => u && !existing.has(u));
    const skipped = urls.length - fresh.length;
    if (!fresh.length) {
      setStatus(skipped ? "Those photos are already in the gallery." : "", skipped ? "error" : null);
      return;
    }
    setToolbarEnabled(false);
    setStatus("Adding...", null);
    const { error } = await insertPhotos(fresh);
    setToolbarEnabled(true);
    if (error) {
      setStatus("Couldn't add photos: " + error.message, "error");
      return;
    }
    setStatus(`Added ${fresh.length} photo${fresh.length === 1 ? "" : "s"}.${skipped ? ` Skipped ${skipped} already in the gallery.` : ""}`, "success");
    await loadList();
  }

  async function handleUpload(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    const client = getSupabaseClient();
    setToolbarEnabled(false);
    const urls = [];
    let failure = null;
    for (let i = 0; i < files.length; i++) {
      setStatus(`Uploading ${i + 1} of ${files.length}...`, null);
      try {
        urls.push(await uploadSiteImage(client, files[i], undefined, "gallery"));
      } catch (err) {
        failure = err.message || String(err);
        break;
      }
    }
    setToolbarEnabled(true);
    if (urls.length) await addPhotos(urls);
    if (failure) setStatus(`${urls.length ? `Added ${urls.length}, but the` : "The"} upload stopped: ${failure}`, "error");
  }

  async function loadProducts(client) {
    const { data, error } = await client.from("products").select("id,name,active").order("name", { ascending: true });
    productOptions = error ? [] : (data || []);
  }

  async function loadList() {
    const client = getSupabaseClient();
    if (!client) return;
    const [galleryRes] = await Promise.all([
      client.from(TABLE).select("*").order("sort_order", { ascending: true }).order("id", { ascending: true }),
      loadProducts(client)
    ]);
    if (galleryRes.error) {
      if (isMissingTableError(galleryRes.error, TABLE)) return showMissingTable();
      const listEl = document.getElementById("galleryAdminList");
      if (listEl) listEl.innerHTML = `<p class="form-status error">Couldn't load the gallery: ${escapeHtml(galleryRes.error.message)}</p>`;
      return;
    }
    const toolbar = document.getElementById("galleryAdminToolbar");
    if (toolbar) toolbar.hidden = false;
    galleryCache = galleryRes.data || [];
    renderList();
  }

  window.refreshGalleryAdmin = async function () {
    const root = document.getElementById("galleryAdmin");
    if (!root) return;
    if (!rendered) renderShell(root);
    try {
      await loadList();
    } catch (err) {
      setStatus("Couldn't load the gallery: " + (err.message || err), "error");
    }
  };
})();
