/*
  Balloons by Tea - product detail view
  A bottom sheet on phones, a centered modal from 768px up. Opened from a
  product card (its linked name, its photo, or anywhere on the card that
  isn't a button), from a deep link, or from "You might also like".

  URL contract (other features link here, keep it exact):
    <any shop page>?product=<encodeURIComponent(item.id)>
    canonical form: all-products.html?product=sb-12

  History: opening from a click pushes a ?product= entry, so the browser's
  Back button closes the view instead of leaving the page. A deep link
  arriving on load is rewritten as "page without ?product=" + a pushed
  entry with it, for the same reason. Swapping to a related product
  replaces the entry, so Back always closes rather than stepping through
  every product looked at.

  Hooks in js/app.js: renderItemCards() calls enhanceProductCards() and
  routes photo clicks to openProductDetail(); the DOMContentLoaded init
  calls initProductDetail() once the catalog has loaded. Everything else
  (cart, toast, lightbox, overlay stack, analytics) is reused from app.js /
  analytics.js as-is.
*/

const PRODUCT_PARAM = "product";
const PRODUCT_QTY_MAX = 20;

let pdRoot = null;
let pdCurrent = null; // { item, collection }
let pdImageIndex = 0;
let pdQty = 1;
let pdSavedScrollY = 0;

const PD_ICONS = {
  share: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M12 15V4M8 8l4-4 4 4" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 12v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* ---------- Catalog lookup ---------- */

/* findItemById() in app.js returns the item without its collection slug,
   which the chip, the cart line and "You might also like" all need. Only
   active products ever make it into window.COLLECTIONS (supabase-catalog.js
   and catalog.js both drop inactive rows), so "not found" covers both an
   unknown id and a product that's been switched off. */
function findProductWithCollection(id) {
  const collections = window.COLLECTIONS || {};
  for (const slug in collections) {
    const item = (collections[slug].items || []).find((i) => i.id === id);
    if (item) return { item, collection: slug };
  }
  return null;
}

/* Up to 3 other products from the same collection, starting just after
   this one and wrapping around, so neighbouring products each suggest a
   different set instead of everyone seeing the collection's first three. */
function getRelatedProducts(current, limit) {
  const items = ((window.COLLECTIONS || {})[current.collection] || {}).items || [];
  const start = items.findIndex((i) => i.id === current.item.id);
  const picks = [];
  for (let step = 1; step < items.length && picks.length < limit; step++) {
    picks.push(items[(start + step) % items.length]);
  }
  return picks;
}

/* ---------- URLs ---------- */

function readProductParam() {
  return new URLSearchParams(location.search).get(PRODUCT_PARAM);
}

// Current page + its other query params, without ?product=.
function urlWithoutProduct() {
  const params = new URLSearchParams(location.search);
  params.delete(PRODUCT_PARAM);
  const rest = params.toString();
  return location.pathname + (rest ? "?" + rest : "") + location.hash;
}

// Current page + its other query params + ?product=<id>, per the URL contract.
function urlWithProduct(id) {
  const params = new URLSearchParams(location.search);
  params.delete(PRODUCT_PARAM);
  const rest = params.toString();
  return location.pathname + "?" + (rest ? rest + "&" : "") + PRODUCT_PARAM + "=" + encodeURIComponent(id) + location.hash;
}

// The link that gets shared: always the canonical all-products form.
function canonicalProductUrl(id) {
  return new URL("all-products.html?" + PRODUCT_PARAM + "=" + encodeURIComponent(id), location.href).href;
}

/* ---------- DOM ---------- */

/* Built once, lazily. Only static markup goes through innerHTML here;
   every piece of product data is set later with textContent/attributes. */
function ensureProductDetail() {
  if (pdRoot) return pdRoot;

  pdRoot = document.createElement("div");
  pdRoot.className = "pd";
  pdRoot.id = "productDetail";
  pdRoot.innerHTML = `
    <div class="pd-scrim" data-pd-close></div>
    <div class="pd-panel" role="dialog" aria-modal="true" aria-labelledby="pdTitle">
      <span class="pd-grabber" aria-hidden="true"></span>
      <button type="button" class="icon-btn pd-close" data-pd-close aria-label="Close">${ICONS.close}</button>
      <div class="pd-scroll">
        <div class="pd-media">
          <div class="pd-stage" role="group" aria-roledescription="carousel" aria-label="Photos">
            <div class="pd-track"></div>
            <button type="button" class="carousel-nav pd-nav pd-prev" aria-label="Previous photo">${ICONS.chevronLeft}</button>
            <button type="button" class="carousel-nav pd-nav pd-next" aria-label="Next photo">${ICONS.chevronRight}</button>
            <span class="pd-counter" aria-hidden="true"></span>
          </div>
          <div class="pd-thumbs" role="group" aria-label="Choose a photo"></div>
        </div>
        <div class="pd-main">
          <div class="pd-info">
            <span class="pd-chip"></span>
            <h2 class="pd-title" id="pdTitle" tabindex="-1"></h2>
            <p class="pd-price"></p>
            <p class="pd-desc"></p>
            <button type="button" class="pd-share">${PD_ICONS.share}<span>Share</span></button>
          </div>
          <section class="pd-related" aria-labelledby="pdRelatedTitle">
            <h3 id="pdRelatedTitle">You might also like</h3>
            <ul class="pd-related-list"></ul>
          </section>
        </div>
      </div>
      <div class="pd-actions">
        <div class="pd-qty" role="group" aria-label="Quantity">
          <button type="button" class="pd-qty-minus" aria-label="Decrease quantity">${ICONS.minus}</button>
          <input type="number" class="pd-qty-input" inputmode="numeric" min="1" max="${PRODUCT_QTY_MAX}" value="1" aria-label="Quantity"/>
          <button type="button" class="pd-qty-plus" aria-label="Increase quantity">${ICONS.plus}</button>
        </div>
        <button type="button" class="btn btn-primary pd-add">${ICONS.cart}<span class="pd-add-label">Add to cart</span></button>
      </div>
    </div>
  `;
  document.body.appendChild(pdRoot);

  pdRoot.querySelectorAll("[data-pd-close]").forEach((el) => el.addEventListener("click", requestCloseProductDetail));
  pdRoot.querySelector(".pd-prev").addEventListener("click", () => goToImage(pdImageIndex - 1));
  pdRoot.querySelector(".pd-next").addEventListener("click", () => goToImage(pdImageIndex + 1));

  // Swipe is the track's own native scroll-snap; this just keeps the
  // index (counter, thumbnails, arrows) in step with wherever it settled.
  const track = pdRoot.querySelector(".pd-track");
  let scrollTimer = null;
  track.addEventListener("scroll", () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const width = track.clientWidth || 1;
      const index = Math.round(track.scrollLeft / width);
      if (index !== pdImageIndex) {
        pdImageIndex = index;
        syncImageUI();
      }
    }, 60);
  });

  pdRoot.querySelector(".pd-stage").addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { e.preventDefault(); goToImage(pdImageIndex - 1); }
    if (e.key === "ArrowRight") { e.preventDefault(); goToImage(pdImageIndex + 1); }
  });

  const qtyInput = pdRoot.querySelector(".pd-qty-input");
  pdRoot.querySelector(".pd-qty-minus").addEventListener("click", () => setDetailQty(pdQty - 1));
  pdRoot.querySelector(".pd-qty-plus").addEventListener("click", () => setDetailQty(pdQty + 1));
  qtyInput.addEventListener("change", () => setDetailQty(Number(qtyInput.value)));
  qtyInput.addEventListener("blur", () => setDetailQty(Number(qtyInput.value)));

  pdRoot.querySelector(".pd-add").addEventListener("click", addDetailToCart);
  pdRoot.querySelector(".pd-share").addEventListener("click", shareCurrentProduct);

  return pdRoot;
}

/* ---------- Rendering ---------- */

function renderProductDetail() {
  const { item, collection } = pdCurrent;
  const root = pdRoot;
  const images = getItemImages(item);
  const hasPhoto = images[0] !== NO_PHOTO_IMAGE;

  root.querySelector(".pd-title").textContent = item.name;
  root.querySelector(".pd-price").textContent = formatPrice(item.price);
  root.querySelector(".pd-chip").textContent = collectionLabel(collection);

  const desc = root.querySelector(".pd-desc");
  desc.textContent = String(item.description || "").trim(); // CSS pre-line keeps its line breaks
  desc.hidden = !desc.textContent;

  // Photos: one slide per image; tapping a slide zooms it in the lightbox.
  const track = root.querySelector(".pd-track");
  track.replaceChildren();
  images.forEach((src, i) => {
    const slide = document.createElement("button");
    slide.type = "button";
    slide.className = "pd-slide";
    slide.setAttribute("aria-label", images.length > 1 ? `Zoom photo ${i + 1} of ${images.length}` : "Zoom photo");
    const img = document.createElement("img");
    img.src = src;
    img.alt = hasPhoto ? (images.length > 1 ? `${item.name}, photo ${i + 1} of ${images.length}` : item.name) : "No photo yet";
    img.decoding = "async";
    if (i > 0) img.loading = "lazy";
    slide.appendChild(img);
    slide.addEventListener("click", () => zoomImage(i, slide));
    track.appendChild(slide);
  });
  track.scrollLeft = 0;

  const thumbs = root.querySelector(".pd-thumbs");
  thumbs.replaceChildren();
  thumbs.hidden = images.length < 2;
  if (images.length > 1) {
    images.forEach((src, i) => {
      const thumb = document.createElement("button");
      thumb.type = "button";
      thumb.className = "pd-thumb";
      thumb.setAttribute("aria-label", `Show photo ${i + 1}`);
      const img = document.createElement("img");
      img.src = src;
      img.alt = "";
      img.loading = "lazy";
      thumb.appendChild(img);
      thumb.addEventListener("click", () => goToImage(i));
      thumbs.appendChild(thumb);
    });
  }
  pdImageIndex = 0;
  syncImageUI();

  setDetailQty(1);
  root.querySelector(".pd-add").classList.remove("added");
  renderRelated();
  root.querySelector(".pd-scroll").scrollTop = 0;
}

function syncImageUI() {
  const images = getItemImages(pdCurrent.item);
  const multi = images.length > 1;
  pdRoot.querySelector(".pd-prev").hidden = !multi;
  pdRoot.querySelector(".pd-next").hidden = !multi;
  const counter = pdRoot.querySelector(".pd-counter");
  counter.hidden = !multi;
  counter.textContent = `${pdImageIndex + 1} / ${images.length}`;
  // Only the visible slide is tabbable, so Tab never lands on (and
  // scrolls the track to) a photo that's off to the side.
  pdRoot.querySelectorAll(".pd-slide").forEach((slide, i) => {
    slide.tabIndex = i === pdImageIndex ? 0 : -1;
  });
  pdRoot.querySelectorAll(".pd-thumb").forEach((thumb, i) => {
    const active = i === pdImageIndex;
    thumb.classList.toggle("active", active);
    if (active) thumb.setAttribute("aria-current", "true");
    else thumb.removeAttribute("aria-current");
  });
}

function goToImage(index) {
  const images = getItemImages(pdCurrent.item);
  if (images.length < 2) return;
  pdImageIndex = (index + images.length) % images.length;
  const track = pdRoot.querySelector(".pd-track");
  track.scrollTo({ left: pdImageIndex * track.clientWidth, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  syncImageUI();
}

/* Reuses app.js's lightbox for zoom. openLightbox() always starts at the
   first photo, so jump it to the one that was tapped — lightboxIndex and
   renderLightboxFrame are top-level in app.js, shared across classic
   scripts. The lightbox sits above this view (z-index), and its Esc/Tab
   handling comes from the same overlay stack, so Esc closes just it. */
function zoomImage(index, trigger) {
  const images = getItemImages(pdCurrent.item);
  openLightbox(images, pdCurrent.item.name, trigger);
  if (index > 0 && typeof renderLightboxFrame === "function") {
    lightboxIndex = index;
    renderLightboxFrame();
  }
}

function renderRelated() {
  const section = pdRoot.querySelector(".pd-related");
  const list = pdRoot.querySelector(".pd-related-list");
  list.replaceChildren();
  const related = getRelatedProducts(pdCurrent, 3);
  section.hidden = related.length === 0;
  related.forEach((item) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pd-related-card";
    const art = document.createElement("span");
    art.className = "pd-related-art";
    const img = document.createElement("img");
    img.src = getItemImages(item)[0];
    img.alt = "";
    img.loading = "lazy";
    art.appendChild(img);
    const name = document.createElement("span");
    name.className = "pd-related-name";
    name.textContent = item.name;
    const price = document.createElement("span");
    price.className = "pd-related-price";
    price.textContent = formatPrice(item.price);
    btn.append(art, name, price);
    btn.addEventListener("click", () => swapProductDetail(item.id));
    li.appendChild(btn);
    list.appendChild(li);
  });
}

/* ---------- Quantity + cart ---------- */

function setDetailQty(value) {
  const n = Math.floor(Number(value));
  pdQty = Math.min(PRODUCT_QTY_MAX, Math.max(1, Number.isFinite(n) ? n : 1));
  pdRoot.querySelector(".pd-qty-input").value = String(pdQty);
  pdRoot.querySelector(".pd-qty-minus").disabled = pdQty <= 1;
  pdRoot.querySelector(".pd-qty-plus").disabled = pdQty >= PRODUCT_QTY_MAX;
  pdRoot.querySelector(".pd-add-label").textContent = `Add to cart · ${formatPrice(pdCurrent.item.price * pdQty)}`;
}

function addDetailToCart() {
  const { item, collection } = pdCurrent;
  const btn = pdRoot.querySelector(".pd-add");
  addToCart({ id: item.id, name: item.name, price: item.price, collection }, pdQty, "detail");
  showToast(pdQty > 1 ? `${pdQty} x ${item.name} added to cart` : `${item.name} added to cart`);
  btn.classList.add("added");
  setTimeout(() => btn.classList.remove("added"), 1400);
}

/* ---------- Share ---------- */

async function shareCurrentProduct() {
  const { item } = pdCurrent;
  const url = canonicalProductUrl(item.id);
  if (navigator.share) {
    try {
      await navigator.share({ title: item.name, text: `${item.name} from Balloons by Tea`, url });
      trackEvent("product_shared", { productId: item.id, method: "native" });
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return; // they closed the share sheet
      // anything else (e.g. not allowed here): fall through to copying
    }
  }
  if (await copyText(url)) {
    showToast("Link copied");
    trackEvent("product_shared", { productId: item.id, method: "copy" });
  } else {
    showToast("Couldn't copy the link. Copy it from the address bar instead.");
  }
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    // blocked clipboard permission: try the older route below
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    pdRoot.appendChild(area); // inside the dialog, so the focus trap doesn't fight it
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch (err) {
    return false;
  }
}

/* ---------- Open / close ---------- */

function isProductDetailOpen() {
  return !!pdRoot && pdRoot.classList.contains("open");
}

/* Opens product `id`. options.source is "card" | "link" | "related";
   options.trigger is what focus returns to on close; options.history is
   "push" (a click), "none" (already in the URL / from popstate). Returns
   false if it didn't open. */
function openProductDetail(id, options) {
  const opts = options || {};
  const source = opts.source || "card";
  // The page editor uses clicks on cards to select them.
  if (source === "card" && document.body.classList.contains("edit-mode-active")) return false;

  const found = findProductWithCollection(id);
  if (!found) {
    showToast("That product isn't available any more.");
    if (readProductParam() !== null) history.replaceState(history.state, "", urlWithoutProduct());
    return false;
  }

  // A card photo isn't focusable any more (see enhanceProductCards), so
  // hand focus back to that card's name link on close instead.
  let trigger = opts.trigger || null;
  if (trigger && trigger.classList && trigger.classList.contains("product-art")) {
    const card = trigger.closest(".product-card");
    trigger = (card && card.querySelector(".product-card-link")) || trigger;
  }

  ensureProductDetail();
  pdCurrent = found;
  renderProductDetail();

  if (opts.history === "push") {
    history.pushState({ productDetail: id }, "", urlWithProduct(id));
  }

  if (!isProductDetailOpen()) {
    pdSavedScrollY = window.scrollY;
    document.documentElement.classList.add("pd-lock");
    pdRoot.classList.add("open");
    openOverlay(pdRoot, trigger, requestCloseProductDetail);
    pdRoot.querySelector(".pd-close").focus({ preventScroll: true });
  }

  trackEvent("product_viewed", { productId: found.item.id, name: found.item.name, collection: found.collection, source });
  return true;
}

// "You might also like": same dialog, new product, same history entry.
function swapProductDetail(id) {
  const found = findProductWithCollection(id);
  if (!found) return;
  pdCurrent = found;
  renderProductDetail();
  history.replaceState({ productDetail: id }, "", urlWithProduct(id));
  pdRoot.querySelector(".pd-title").focus({ preventScroll: true });
  trackEvent("product_viewed", { productId: found.item.id, name: found.item.name, collection: found.collection, source: "related" });
}

// Just the visual close; URL handling is the caller's job.
function closeProductDetailView() {
  if (!isProductDetailOpen()) return;
  if (typeof closeLightbox === "function") closeLightbox(); // Back while zoomed closes both
  pdRoot.classList.remove("open");
  document.documentElement.classList.remove("pd-lock");
  closeOverlay(pdRoot);
  if (Math.abs(window.scrollY - pdSavedScrollY) > 1) {
    window.scrollTo({ top: pdSavedScrollY, behavior: "instant" });
  }
}

/* X, Esc and the backdrop. If the open view owns the current history
   entry (it pushed it), step back off it, so Forward/Back stay coherent;
   otherwise just strip ?product= from the URL in place. */
function requestCloseProductDetail() {
  if (!isProductDetailOpen()) return;
  closeProductDetailView();
  if (history.state && history.state.productDetail) history.back();
  else if (readProductParam() !== null) history.replaceState(history.state, "", urlWithoutProduct());
}

window.addEventListener("popstate", () => {
  const id = readProductParam();
  if (!id) {
    closeProductDetailView();
    return;
  }
  if (isProductDetailOpen() && pdCurrent && pdCurrent.item.id === id) return;
  openProductDetail(id, { source: "link", history: "none", trigger: findCardTrigger(id) });
});

/* ---------- Product cards ---------- */

function findCardTrigger(id) {
  return Array.from(document.querySelectorAll(".product-card-link")).find((a) => a.dataset.productId === id) || null;
}

/* Called by renderItemCards() after each render. Turns each card's name
   into a real link to its deep link (keyboard, middle-click and "open in
   new tab" all just work), and makes the rest of the card clickable too.
   The photo is still clickable (app.js routes it here), but leaves the
   tab order, so each card is one stop for details + one for the cart. */
function enhanceProductCards(grid, items) {
  grid.querySelectorAll(".product-card").forEach((card) => {
    const art = card.querySelector(".product-art");
    const heading = card.querySelector(".product-body h3");
    const id = art ? art.dataset.artId : null;
    const item = items.find((i) => i.id === id);
    if (!item || !heading) return;

    const link = document.createElement("a");
    link.className = "product-card-link";
    link.href = urlWithProduct(item.id);
    link.dataset.productId = item.id;
    link.textContent = item.name;
    heading.replaceChildren(link);

    art.tabIndex = -1;
    art.removeAttribute("role");
    art.setAttribute("aria-hidden", "true");
    card.classList.add("has-detail");

    link.addEventListener("click", (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // new tab etc.
      e.preventDefault();
      openProductDetail(item.id, { trigger: link, source: "card", history: "push" });
    });
    card.addEventListener("click", (e) => {
      // contains(): the card's cart button swaps its own icon on click, so
      // by the time the click bubbles here its target may be detached.
      if (!card.contains(e.target) || e.target.closest("a, button, .product-art")) return;
      openProductDetail(item.id, { trigger: link, source: "card", history: "push" });
    });
  });
}

/* Called from app.js once the catalog has loaded: opens a deep-linked
   product. The page is first recorded without ?product= and the product
   pushed on top, so Back closes the view instead of leaving the site. */
function initProductDetail() {
  const id = readProductParam();
  if (!id) return;
  const found = findProductWithCollection(id);
  if (!found) {
    openProductDetail(id, { source: "link" }); // shows the toast + cleans the URL
    return;
  }
  history.replaceState(null, "", urlWithoutProduct());
  history.pushState({ productDetail: id }, "", urlWithProduct(id));
  openProductDetail(id, { source: "link", history: "none", trigger: findCardTrigger(id) });
}
