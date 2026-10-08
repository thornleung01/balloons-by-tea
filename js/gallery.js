/* Past events gallery (gallery.html). Loads the active rows of
   `gallery_items` (the "Gallery" section of supabase-setup.sql) with a plain anon select and
   renders them as a masonry-style photo wall with occasion filter chips.
   Clicking a photo opens the shared product lightbox from js/app.js
   (openLightbox / stepLightbox), stepping through the photos in the
   current filter. Each photo links to "Order something like this":
     - product_id set  -> all-products.html?product=sb-<product_id>
     - otherwise       -> custom-order.html?inspiration=<gallery id>
       (js/inspiration-prefill.js picks that up on the custom order form)

   Degrades quietly: no Supabase, a missing table, an error or zero rows
   all end in the same friendly "photos are on their way" state with links
   to the shop and the custom order form, since the page is reachable from
   the sitemap before any photos exist. Uses escapeHtml() and trackEvent()
   from js/app.js / js/analytics.js. */
(function () {
  const wall = document.getElementById("galleryWall");
  if (!wall) return;
  const filtersEl = document.getElementById("galleryFilters");
  const emptyEl = document.getElementById("galleryEmpty");

  /* Photo dimensions aren't stored, so each tile gets a fixed shape picked
     from this set by its id (stable across filters) and the photo is
     cropped to fill it (the lightbox shows it uncropped). Known shapes mean
     the wall's layout is final before a single image has loaded: no layout
     shift, and lazy loading can't make tiles jump. */
  const RATIOS = [[4, 5], [1, 1], [3, 4], [4, 5], [5, 4], [1, 1], [3, 4]];
  const ALL = "all";

  let items = [];
  let activeOccasion = ALL;
  let columnCount = 0;

  const esc = (s) => (typeof escapeHtml === "function" ? escapeHtml(s) : String(s == null ? "" : s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`));
  const track = (name, meta) => { if (typeof trackEvent === "function") trackEvent(name, meta); };

  // Same text can arrive as "Birthday", "birthday " etc. — group on this.
  const occasionKey = (o) => String(o || "").trim().toLowerCase();

  function ratioFor(item) {
    return RATIOS[Math.abs(Number(item.id) || 0) % RATIOS.length];
  }

  function isSafeImageUrl(url) {
    return typeof url === "string" && /^https?:\/\//i.test(url.trim());
  }

  function orderTarget(item) {
    if (item.product_id !== null && item.product_id !== undefined && item.product_id !== "") {
      return { kind: "product", href: `all-products.html?product=${encodeURIComponent("sb-" + item.product_id)}` };
    }
    return { kind: "custom-order", href: `custom-order.html?inspiration=${encodeURIComponent(item.id)}` };
  }

  function currentColumnCount() {
    if (window.matchMedia("(min-width: 960px)").matches) return 3;
    return 2;
  }

  function visibleItems() {
    if (activeOccasion === ALL) return items;
    return items.filter((it) => occasionKey(it.occasion) === activeOccasion);
  }

  /* Occasions present in the data, first-seen spelling kept for the label,
     sorted A-Z. Untagged photos only show under "All". */
  function occasionList() {
    const seen = new Map();
    items.forEach((it) => {
      const key = occasionKey(it.occasion);
      if (key && !seen.has(key)) seen.set(key, String(it.occasion).trim());
    });
    return Array.from(seen, ([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label));
  }

  function renderFilters() {
    const occasions = occasionList();
    // One occasion (or none) means "All" would show the same thing — skip.
    if (occasions.length < 2) {
      filtersEl.hidden = true;
      filtersEl.innerHTML = "";
      activeOccasion = ALL;
      return;
    }
    if (activeOccasion !== ALL && !occasions.some((o) => o.key === activeOccasion)) activeOccasion = ALL;
    const chips = [{ key: ALL, label: "All" }].concat(occasions);
    filtersEl.innerHTML = chips.map((c) => `
      <button type="button" class="gallery-chip" data-occasion="${esc(c.key)}" aria-pressed="${c.key === activeOccasion}">${esc(c.label)}</button>
    `).join("");
    filtersEl.hidden = false;
  }

  function tileHtml(item, index, eager) {
    const [w, h] = ratioFor(item);
    const caption = String(item.caption || "").trim();
    const occasion = String(item.occasion || "").trim();
    const alt = caption || (occasion ? `${occasion} balloon decor` : "Balloon decor from a past event");
    const target = orderTarget(item);
    return `
      <figure class="gallery-tile" data-gallery-id="${esc(item.id)}">
        <button type="button" class="gallery-photo" data-index="${index}" style="aspect-ratio:${w} / ${h};" aria-label="View larger photo${caption ? ": " + esc(caption) : ""}">
          <img src="${esc(item.image_url.trim())}" alt="${esc(alt)}" width="${w * 200}" height="${h * 200}" loading="${eager ? "eager" : "lazy"}" decoding="async"/>
          <span class="gallery-zoom-hint" aria-hidden="true">${typeof ICONS === "object" && ICONS.zoom ? ICONS.zoom : ""}</span>
        </button>
        <figcaption class="gallery-meta">
          ${occasion ? `<span class="gallery-occasion">${esc(occasion)}</span>` : ""}
          ${caption ? `<p class="gallery-caption">${esc(caption)}</p>` : ""}
          <a class="gallery-order-link" href="${esc(target.href)}" data-target="${target.kind}" data-gallery-id="${esc(item.id)}">Order something like this<span aria-hidden="true"> &rarr;</span></a>
        </figcaption>
      </figure>
    `;
  }

  /* Greedy "shortest column first" placement. Heights are known up front
     (fixed ratios + a flat allowance for the caption block), so this keeps
     reading order roughly left-to-right, top-to-bottom, unlike CSS columns,
     which would run the first several photos down the first column. */
  function renderWall() {
    const list = visibleItems();
    columnCount = currentColumnCount();
    const cols = Array.from({ length: columnCount }, () => ({ height: 0, html: [] }));
    list.forEach((item, i) => {
      const [w, h] = ratioFor(item);
      let target = cols[0];
      cols.forEach((c) => { if (c.height < target.height - 0.001) target = c; });
      target.html.push(tileHtml(item, i, i < columnCount));
      target.height += h / w + 0.32;
    });
    wall.innerHTML = cols.map((c) => `<div class="gallery-col">${c.html.join("")}</div>`).join("");
    wall.style.setProperty("--gallery-cols", String(columnCount));
    wall.setAttribute("aria-busy", "false");

    wall.querySelectorAll(".gallery-photo img").forEach((img) => {
      img.addEventListener("error", () => img.closest(".gallery-photo").classList.add("is-broken"), { once: true });
    });
  }

  function showEmpty(state) {
    wall.innerHTML = "";
    wall.hidden = true;
    wall.setAttribute("aria-busy", "false");
    wall.dataset.state = state;
    filtersEl.hidden = true;
    emptyEl.hidden = false;
  }

  function readOccasionFromUrl() {
    try {
      const v = new URLSearchParams(location.search).get("occasion");
      return v ? occasionKey(v) : ALL;
    } catch (e) {
      return ALL;
    }
  }

  function writeOccasionToUrl() {
    try {
      const url = new URL(location.href);
      if (activeOccasion === ALL) url.searchParams.delete("occasion");
      else url.searchParams.set("occasion", activeOccasion);
      history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    } catch (e) { /* cosmetic only */ }
  }

  function wireEvents() {
    filtersEl.addEventListener("click", (e) => {
      const chip = e.target.closest(".gallery-chip");
      if (!chip || chip.dataset.occasion === activeOccasion) return;
      activeOccasion = chip.dataset.occasion;
      filtersEl.querySelectorAll(".gallery-chip").forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
      writeOccasionToUrl();
      renderWall();
    });

    wall.addEventListener("click", (e) => {
      const link = e.target.closest(".gallery-order-link");
      if (link) {
        track("gallery_order_clicked", { galleryId: Number(link.dataset.galleryId) || link.dataset.galleryId, target: link.dataset.target });
        return; // normal navigation
      }
      const photo = e.target.closest(".gallery-photo");
      if (!photo || typeof openLightbox !== "function") return;
      const list = visibleItems();
      const index = Number(photo.dataset.index) || 0;
      openLightbox(list.map((it) => it.image_url.trim()), "Past events", photo);
      // openLightbox always starts on the first photo; step to the clicked
      // one so prev/next walk through the current filter from there.
      if (index > 0 && typeof stepLightbox === "function") stepLightbox(index);
    });

    // Re-flow only when the column count actually changes.
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (items.length && currentColumnCount() !== columnCount) renderWall();
      }, 120);
    });
  }

  async function load() {
    const client = typeof getSupabaseClient === "function" ? getSupabaseClient() : null;
    if (!client) {
      showEmpty("unavailable");
      track("gallery_viewed", { photos: 0, state: "unavailable" });
      return;
    }
    let data = null;
    let error = null;
    try {
      ({ data, error } = await client
        .from("gallery_items")
        .select("id,image_url,caption,occasion,product_id,sort_order")
        .eq("active", true)
        .order("sort_order", { ascending: true })
        .order("id", { ascending: true }));
    } catch (err) {
      error = err;
    }
    if (error) {
      const missing = typeof isMissingTableError === "function" && isMissingTableError(error, "gallery_items");
      if (!missing) console.warn("[Balloons by Tea] Couldn't load the gallery.", error);
      showEmpty(missing ? "missing-table" : "error");
      track("gallery_viewed", { photos: 0, state: missing ? "missing-table" : "error" });
      return;
    }
    items = (data || []).filter((it) => it && isSafeImageUrl(it.image_url));
    if (!items.length) {
      showEmpty("empty");
      track("gallery_viewed", { photos: 0, state: "empty" });
      return;
    }
    activeOccasion = readOccasionFromUrl();
    renderFilters();
    renderWall();
    wall.dataset.state = "ready";
    track("gallery_viewed", { photos: items.length, state: "ready" });
  }

  function init() {
    wireEvents();
    load();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
