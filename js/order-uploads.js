/*
  Inspiration photos on the custom-order form (custom-order.html).

  Customers can attach up to 3 photos. Each one is resized in the browser
  (canvas, max 1600px on the long side, JPEG ~0.82) as soon as it's picked,
  which also strips EXIF data such as GPS location. Nothing is uploaded
  until the form is submitted and has passed validation and the order
  guards. Then js/app.js calls OrderUploads.prepareForSubmit(), which:
    1. registers a random upload folder (rpc start_order_upload, rate
       limited per connection on the server);
    2. uploads each photo to the PRIVATE 'order-uploads' bucket at
       pending/<folder>/<n>.jpg (upsert off, so nothing is overwritten);
    3. returns the storage paths, which app.js saves in orders.attachments.
  The server-side rules live in the "Order photo uploads" section of supabase-setup.sql. Only the admin
  can view the files.

  A photo must never cost a customer their order:
    - If uploads aren't set up on the database yet (bucket or function
      missing), the picker is hidden and the order goes through without
      photos (console warning only).
    - If an upload fails, the customer is told and can retry or send
      without the photos that failed. The form keeps everything they typed.
*/
(function () {
  const BUCKET = "order-uploads";
  const MAX_FILES = 3;
  const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024;
  const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
  const MAX_EDGE = 1600;
  const JPEG_QUALITY = 0.82;
  const UPLOAD_TIMEOUT_MS = 60000;
  // The server only accepts a registration for an hour; renew a bit early.
  const REGISTRATION_TTL_MS = 50 * 60 * 1000;
  const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif)$/i;

  let field = null;
  let input = null;
  let dropzone = null;
  let thumbs = null;
  let errorEl = null;
  let countEl = null;
  let failureBox = null;

  let available = false;
  let items = []; // { id, name, ready: Promise, blob, previewUrl, slot, path, failed }
  let nextItemId = 1;
  let folder = null;
  let registeredAt = 0;
  let usedSlots = new Set();
  let folderUploads = 0; // files stored in the current folder, removed ones included
  let sendWithoutFailed = false;

  function newFolder() {
    folder = crypto.randomUUID();
    registeredAt = 0;
    usedSlots = new Set();
    folderUploads = 0;
  }

  /* ----- Image processing ----- */

  function looksLikeImage(file) {
    if (file.type) return file.type.startsWith("image/");
    // Some systems report no type for HEIC etc.; decoding decides.
    return IMAGE_EXT_RE.test(file.name || "");
  }

  // Decodes with EXIF orientation applied. createImageBitmap's
  // imageOrientation option is the reliable route; browsers that reject
  // the option fall back to <img>, which applies EXIF orientation itself.
  async function decodeImage(file) {
    if (typeof createImageBitmap === "function") {
      try {
        return await createImageBitmap(file, { imageOrientation: "from-image" });
      } catch (err) {
        // unsupported option or undecodable: try <img> below
      }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      // decode() has finished, so the pixels no longer need the URL.
      URL.revokeObjectURL(url);
    }
  }

  function canvasToBlob(canvas, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  }

  // Resizes to fit MAX_EDGE and re-encodes as JPEG, stepping quality and
  // size down until it fits MAX_UPLOAD_BYTES. Throws if it can't.
  async function resizeImage(file) {
    const source = await decodeImage(file);
    try {
      const srcW = source.naturalWidth || source.width;
      const srcH = source.naturalHeight || source.height;
      if (!srcW || !srcH) throw new Error("empty image");
      let scale = Math.min(1, MAX_EDGE / Math.max(srcW, srcH));
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      for (let attempt = 0; attempt < 6; attempt++) {
        canvas.width = Math.max(1, Math.round(srcW * scale));
        canvas.height = Math.max(1, Math.round(srcH * scale));
        // White behind transparent PNGs, which JPEG would otherwise turn black.
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
        for (const quality of [JPEG_QUALITY, 0.7]) {
          const blob = await canvasToBlob(canvas, quality);
          if (blob && blob.type === "image/jpeg" && blob.size <= MAX_UPLOAD_BYTES) return blob;
        }
        scale *= 0.75;
      }
      throw new Error("still too large after resizing");
    } finally {
      if (source && typeof source.close === "function") source.close();
    }
  }

  /* ----- Picker UI ----- */

  function setError(message) {
    errorEl.textContent = message || "";
  }

  function updateCount() {
    const n = items.length;
    countEl.textContent = n ? `${n} of ${MAX_FILES} photos added.` : "";
    const full = n >= MAX_FILES;
    input.disabled = full;
    dropzone.classList.toggle("is-full", full);
  }

  function renderThumbs() {
    thumbs.innerHTML = "";
    items.forEach((item, index) => {
      const li = document.createElement("li");
      li.className = "photo-thumb" + (item.blob ? "" : " is-processing");
      li.dataset.itemId = String(item.id);
      if (item.previewUrl) {
        const img = document.createElement("img");
        img.src = item.previewUrl;
        img.alt = `Inspiration photo ${index + 1}`;
        li.appendChild(img);
      } else {
        const wait = document.createElement("span");
        wait.className = "photo-thumb-wait";
        wait.textContent = "Preparing...";
        li.appendChild(wait);
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "photo-thumb-remove";
      remove.setAttribute("aria-label", `Remove photo ${index + 1}${item.name ? ` (${item.name})` : ""}`);
      remove.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg>`;
      remove.addEventListener("click", () => removeItem(item.id));
      li.appendChild(remove);
      thumbs.appendChild(li);
    });
    thumbs.hidden = items.length === 0;
    updateCount();
  }

  function removeItem(id) {
    const index = items.findIndex((i) => i.id === id);
    if (index === -1) return;
    const [item] = items.splice(index, 1);
    item.removed = true;
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    // An already-uploaded file just stays unreferenced; the admin's
    // "Clean up unused photos" removes it after a week.
    setError("");
    hideFailure();
    renderThumbs();
    // Keep keyboard focus somewhere sensible: the next remove button, or
    // the picker once the list is empty.
    const buttons = thumbs.querySelectorAll(".photo-thumb-remove");
    const next = buttons[Math.min(index, buttons.length - 1)];
    (next || input).focus();
  }

  function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const problems = [];
    let skippedForLimit = 0;
    files.forEach((file) => {
      if (!looksLikeImage(file)) {
        problems.push(`"${file.name}" isn't a photo.`);
        return;
      }
      if (file.size > MAX_ORIGINAL_BYTES) {
        problems.push(`"${file.name}" is over 20 MB.`);
        return;
      }
      if (items.length >= MAX_FILES) {
        skippedForLimit++;
        return;
      }
      const item = { id: nextItemId++, name: file.name, blob: null, previewUrl: "", slot: null, path: null };
      item.ready = resizeImage(file).then(
        (blob) => {
          if (item.removed) return;
          item.blob = blob;
          item.previewUrl = URL.createObjectURL(blob);
          renderThumbs();
        },
        (err) => {
          console.warn("[Balloons by Tea] Couldn't prepare photo", file.name, err);
          if (item.removed) return;
          items = items.filter((i) => i !== item);
          renderThumbs();
          setError(`Couldn't read "${file.name}". Please try a JPG or PNG photo.`);
        }
      );
      items.push(item);
    });
    if (skippedForLimit) problems.push(`You can attach up to ${MAX_FILES} photos, so ${skippedForLimit === 1 ? "1 photo was" : `${skippedForLimit} photos were`} left out.`);
    setError(problems.join(" "));
    hideFailure();
    renderThumbs();
  }

  /* ----- Upload failure prompt ----- */

  function hideFailure() {
    if (failureBox) failureBox.hidden = true;
  }

  function showFailure(message) {
    const form = field.closest("form");
    if (!failureBox) {
      failureBox = document.createElement("div");
      failureBox.className = "photo-upload-failure";
      failureBox.id = "orderPhotosFailure";
      failureBox.setAttribute("role", "alert");
      failureBox.innerHTML = `
        <p class="photo-upload-failure-text"></p>
        <div class="photo-upload-failure-actions">
          <button type="button" class="btn btn-outline btn-sm" data-photo-retry>Try again</button>
          <button type="button" class="btn btn-outline btn-sm" data-photo-skip></button>
        </div>`;
      failureBox.querySelector("[data-photo-retry]").addEventListener("click", () => {
        hideFailure();
        resubmit(form);
      });
      failureBox.querySelector("[data-photo-skip]").addEventListener("click", () => {
        hideFailure();
        sendWithoutFailed = true;
        resubmit(form);
      });
      // Right above the submit button, where the customer is looking.
      const formError = document.getElementById("customOrderFormError");
      if (formError) formError.parentNode.insertBefore(failureBox, formError);
      else form.appendChild(failureBox);
    }
    const uploaded = items.filter((i) => i.path).length;
    failureBox.querySelector(".photo-upload-failure-text").textContent = message +
      (uploaded ? ` ${uploaded === 1 ? "1 photo" : `${uploaded} photos`} did upload and will be sent either way.` : "");
    failureBox.querySelector("[data-photo-skip]").textContent = uploaded ? "Send without the others" : "Send without photos";
    failureBox.hidden = false;
    failureBox.querySelector("[data-photo-retry]").focus();
  }

  function resubmit(form) {
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.dispatchEvent(new Event("submit", { cancelable: true }));
  }

  /* ----- Upload ----- */

  // True when the error means the database doesn't have photo uploads set
  // up (the "Order photo uploads" section of supabase-setup.sql not run): missing bucket or function.
  function isSetupMissingError(error) {
    if (!error) return false;
    const msg = String(error.message || error.error || "");
    if (/bucket not found/i.test(msg)) return true;
    return typeof isMissingTableError === "function" && isMissingTableError(error, "start_order_upload");
  }

  function disableUploads(error) {
    console.warn("[Balloons by Tea] Photo uploads aren't set up on the database yet (run the latest supabase-setup.sql); sending the order without photos.", error);
    available = false;
    items.forEach((i) => { if (i.previewUrl) URL.revokeObjectURL(i.previewUrl); });
    items = [];
    renderThumbs();
    hideFailure();
    field.hidden = true;
    return [];
  }

  function withTimeout(promise, ms) {
    let timer;
    return Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ error: { message: "Upload timed out" } }), ms);
      })
    ]).finally(() => clearTimeout(timer));
  }

  function nextSlot() {
    for (let n = 1; n <= 9; n++) {
      if (!usedSlots.has(n)) {
        usedSlots.add(n);
        return n;
      }
    }
    return null;
  }

  function setButtonLabel(btn, text) {
    btn.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${text}</span>`;
  }

  /* Called by js/app.js after validation and order guards pass, right
     before the order insert. Resolves to the array of storage paths to
     save with the order ([] for none), or null when the customer needs to
     choose what to do about a failed upload (the prompt is showing, and
     the form must stay as it is). Never throws. */
  async function prepareForSubmit(submitBtn) {
    hideFailure();
    const skipFailed = sendWithoutFailed;
    sendWithoutFailed = false;
    if (!available || !items.length) return [];
    const client = typeof getSupabaseClient === "function" ? getSupabaseClient() : null;
    if (!client) return [];

    const originalLabel = submitBtn ? submitBtn.innerHTML : "";
    try {
      if (submitBtn) setButtonLabel(submitBtn, "Preparing photos...");
      await Promise.all(items.map((i) => i.ready));
      const ready = items.filter((i) => i.blob);
      if (!ready.length) return [];

      if (skipFailed) {
        return ready.filter((i) => i.path).map((i) => i.path);
      }

      // The server keeps at most 3 files per folder, and names run 1-9.
      // If this upload wouldn't fit (the customer removed an uploaded photo
      // and picked another), start a fresh folder and re-upload them all.
      const toUpload = ready.filter((i) => !i.path).length;
      if (folderUploads + toUpload > MAX_FILES || toUpload > 9 - usedSlots.size) {
        newFolder();
        ready.forEach((i) => { i.path = null; i.slot = null; });
      }

      if (!registeredAt || Date.now() - registeredAt > REGISTRATION_TTL_MS) {
        const { error } = await client.rpc("start_order_upload", { folder });
        if (error) {
          if (isSetupMissingError(error)) return disableUploads(error);
          console.error("Photo upload registration failed", error);
          showFailure(/rate_limited/.test(error.message || "")
            ? "We've received a lot of photos from your connection recently, so we couldn't upload these right now."
            : "We couldn't upload your photos. Please check your connection.");
          return null;
        }
        registeredAt = Date.now();
      }

      let failed = 0;
      for (let k = 0; k < ready.length; k++) {
        const item = ready[k];
        if (item.path) continue;
        if (submitBtn) setButtonLabel(submitBtn, `Uploading photos ${k + 1}/${ready.length}...`);
        if (item.slot === null) item.slot = nextSlot();
        const path = `pending/${folder}/${item.slot}.jpg`;
        let result;
        try {
          result = await withTimeout(
            client.storage.from(BUCKET).upload(path, item.blob, { upsert: false, contentType: "image/jpeg", cacheControl: "3600" }),
            UPLOAD_TIMEOUT_MS
          );
        } catch (err) {
          result = { error: err };
        }
        const error = result && result.error;
        // "Already exists" means an earlier attempt (one that timed out on
        // our side) did land: the name is unique to this browser's folder.
        if (!error || /already exists|duplicate/i.test(String(error.message || "")) || String(error.statusCode) === "409") {
          item.path = path;
          folderUploads++;
          continue;
        }
        if (isSetupMissingError(error)) return disableUploads(error);
        console.error("Photo upload failed", path, error);
        failed++;
      }

      if (failed) {
        showFailure(failed === ready.length
          ? "We couldn't upload your photos. Please check your connection."
          : `${failed === 1 ? "1 photo" : `${failed} photos`} couldn't be uploaded.`);
        return null;
      }
      return ready.map((i) => i.path);
    } catch (err) {
      // Anything unexpected: never block the order over photos.
      console.error("Photo upload step failed; sending without photos", err);
      return items.filter((i) => i.path).map((i) => i.path);
    } finally {
      if (submitBtn) submitBtn.innerHTML = originalLabel;
    }
  }

  /* Called by js/app.js once the order is saved. */
  function onSubmitted(attachments) {
    const count = Array.isArray(attachments) ? attachments.length : 0;
    if (count && typeof trackEvent === "function") trackEvent("photo_attached", { count });
    items.forEach((i) => { if (i.previewUrl) URL.revokeObjectURL(i.previewUrl); });
    items = [];
    newFolder();
    hideFailure();
    setError("");
    if (thumbs) renderThumbs();
  }

  function init() {
    field = document.getElementById("orderPhotosField");
    if (!field) return;
    input = document.getElementById("co-photos");
    dropzone = document.getElementById("orderPhotosDropzone");
    thumbs = document.getElementById("orderPhotoThumbs");
    errorEl = document.getElementById("co-error-photos");
    countEl = document.getElementById("co-photos-count");

    // Uploads need Supabase and a browser that can resize photos. Without
    // either, the picker stays hidden and the form works as before.
    const client = typeof getSupabaseClient === "function" ? getSupabaseClient() : null;
    const canResize = typeof HTMLCanvasElement !== "undefined" && !!HTMLCanvasElement.prototype.toBlob;
    if (!client || !canResize || !window.crypto || typeof crypto.randomUUID !== "function") return;
    available = true;
    newFolder();
    field.hidden = false;

    input.addEventListener("change", () => {
      addFiles(input.files);
      input.value = ""; // so picking the same file again still fires change
    });

    ["dragenter", "dragover"].forEach((type) => dropzone.addEventListener(type, (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = items.length >= MAX_FILES ? "none" : "copy";
      dropzone.classList.add("is-dragover");
    }));
    dropzone.addEventListener("dragleave", (e) => {
      if (!dropzone.contains(e.relatedTarget)) dropzone.classList.remove("is-dragover");
    });
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("is-dragover");
      if (e.dataTransfer) addFiles(e.dataTransfer.files);
    });

    renderThumbs();
  }

  window.OrderUploads = { prepareForSubmit, onSubmitted };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
