/*
  Aura Balloon Co. — site behavior
  Sections: CONFIG, icons, balloon art, nav, product grid, cart, checkout.
*/

/* ==========================================================================
   CONFIG — Google Form checkout target
   ==========================================================================
   The checkout modal is fully custom-styled, but on submit it quietly posts
   the order to a Google Form's response endpoint so replies land in a Google
   Sheet. Until this is filled in, orders are simulated locally (see
   submitOrder below) so the site is fully clickable right now.

   How to connect your real form — see README.md "Connect the Google Form"
   for the full walkthrough. Short version:
     1. Create a Google Form with one short-answer/paragraph field per entry
        below (Name, Phone, Email, Address, Preferred Date, Notes, Order
        Summary, Order Total).
     2. Use Form menu -> "Get pre-filled link", fill in dummy values, copy
        the generated link.
     3. Each field appears in that link as entry.123456789=value — copy the
        numbers into CONFIG.googleForm.entries below.
     4. Replace actionUrl with the same link, but swap "viewform" for
        "formResponse" and drop everything from "?" onward.
*/
const CONFIG = {
  googleForm: {
    actionUrl: "https://docs.google.com/forms/d/e/YOUR_FORM_ID/formResponse",
    entries: {
      name: "entry.YOUR_NAME_ID",
      phone: "entry.YOUR_PHONE_ID",
      email: "entry.YOUR_EMAIL_ID",
      address: "entry.YOUR_ADDRESS_ID",
      date: "entry.YOUR_DATE_ID",
      notes: "entry.YOUR_NOTES_ID",
      summary: "entry.YOUR_SUMMARY_ID",
      total: "entry.YOUR_TOTAL_ID"
    }
  },
  currencySymbol: "$"
};

const PRODUCTS_PER_PAGE = 9;
let catalogPage = 1;

function isFormConfigured() {
  return !CONFIG.googleForm.actionUrl.includes("YOUR_FORM_ID");
}

/* ==========================================================================
   Icons — inline SVG, no emoji
   ========================================================================== */
const ICONS = {
  cart: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 4h2l2.2 11.2a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 2-1.6L20 8H6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9" cy="20" r="1.4" fill="currentColor" stroke="none"/><circle cx="17" cy="20" r="1.4" fill="currentColor" stroke="none"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 5l14 14M19 5L5 19" stroke-linecap="round"/></svg>',
  menu: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M4 12h16M4 17h16" stroke-linecap="round"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  minus: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14" stroke-linecap="round"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" stroke-linecap="round"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chevronLeft: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 6l-6 6 6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chevronRight: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  images: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="15" height="13" rx="2"/><path d="M3 15l4-4 3 3 5-5 4 4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  zoom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M19 19l-4.3-4.3" stroke-linecap="round"/><path d="M10.5 8v5M8 10.5h5" stroke-linecap="round"/></svg>',
  sparkle: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3v5M12 16v5M3 12h5M16 12h5M6 6l3 3M18 18l-3-3M6 18l3-3M18 6l-3 3" stroke-linecap="round"/></svg>',
  truck: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 7h10v8H3zM13 11h4l3 3v1h-7z" stroke-linejoin="round"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/></svg>',
  heart: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 20s-7-4.4-9.3-8.8C1.3 8 3 5 6.1 5c1.9 0 3.3 1 4 2.4.7-1.4 2.1-2.4 4-2.4 3.1 0 4.8 3 3.4 6.2C19 15.6 12 20 12 20z" stroke-linejoin="round"/></svg>',
  basket: '<svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 9h16l-1.5 9.5a2 2 0 0 1-2 1.5H7.5a2 2 0 0 1-2-1.5L4 9z" stroke-linejoin="round"/><path d="M8 9a4 4 0 0 1 8 0" stroke-linecap="round"/></svg>'
};

/* ==========================================================================
   Nav — mobile toggle + active link
   ========================================================================== */
function initNav() {
  const page = document.body.dataset.page;
  if (page) {
    document.querySelectorAll(`.nav-links a[data-page="${page}"]`).forEach((a) => {
      a.setAttribute("aria-current", "page");
    });
  }

  const toggle = document.querySelector(".nav-toggle");
  const navLinks = document.getElementById("navLinks");
  if (!toggle || !navLinks) return;

  function closeMenu() {
    navLinks.classList.remove("open");
    toggle.setAttribute("aria-expanded", "false");
  }
  function openMenu() {
    navLinks.classList.add("open");
    toggle.setAttribute("aria-expanded", "true");
  }

  toggle.addEventListener("click", () => {
    if (navLinks.classList.contains("open")) closeMenu();
    else openMenu();
  });
  navLinks.querySelectorAll("a").forEach((a) => a.addEventListener("click", closeMenu));
  document.addEventListener("click", (e) => {
    if (!navLinks.classList.contains("open")) return;
    if (navLinks.contains(e.target) || toggle.contains(e.target)) return;
    closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });
  window.addEventListener("resize", () => {
    if (window.innerWidth > 700) closeMenu();
  });
}

/* ==========================================================================
   Toast
   ========================================================================== */
let toastTimer = null;
function showToast(message) {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "status");
    document.body.appendChild(toast);
  }
  toast.innerHTML = `${ICONS.check}<span>${escapeHtml(message)}</span>`;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2200);
}

/* ==========================================================================
   Product grid (collection pages)
   ========================================================================== */
function formatPrice(n) {
  return `${CONFIG.currencySymbol}${n.toFixed(0)}`;
}

/* Item name/description/image come from the editable Google Sheet catalog
   (see js/catalog.js), not just our own code — anything from there must be
   escaped before it lands in innerHTML, same as any other user input. */
const HTML_ESCAPE_MAP = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
};
function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => HTML_ESCAPE_MAP[c]);
}

/* Any product without a real photo uploaded yet (via admin/Sheet/Supabase)
   shows this same placeholder graphic, rather than a generated icon —
   keeps every "no photo yet" item looking consistent across the site. */
const NO_PHOTO_IMAGE = "images/no-picture.png";

/* A product can list several photos via `images: [...]` (array, newest
   format) or a single `image` (legacy, still supported). Falls back to the
   shared placeholder when neither is set. Always returns at least one URL. */
function getItemImages(item) {
  if (Array.isArray(item.images) && item.images.length) return item.images.filter(Boolean);
  if (item.image) return [item.image];
  return [NO_PHOTO_IMAGE];
}

function productArtMarkup(item) {
  const images = getItemImages(item);
  const hasPhoto = images[0] !== NO_PHOTO_IMAGE;
  const cls = hasPhoto ? "has-photo" : "no-photo";
  const multiBadge = images.length > 1
    ? `<span class="product-art-count">${ICONS.images}${images.length}</span>`
    : "";
  return `<div class="product-art ${cls}" role="button" tabindex="0" data-art-id="${escapeHtml(item.id)}" aria-label="View photos of ${escapeHtml(item.name)}">
    <img src="${escapeHtml(images[0])}" alt="${hasPhoto ? escapeHtml(item.name) : "No photo yet"}" loading="lazy"/>
    <div class="product-art-zoom-hint">${ICONS.zoom}</div>
    ${multiBadge}
  </div>`;
}

function getAllItemsFlat() {
  if (!window.COLLECTIONS) return [];
  return Object.keys(window.COLLECTIONS).flatMap((key) =>
    window.COLLECTIONS[key].items.map((item) => ({ ...item, _collection: key }))
  );
}

/* Homepage "Best Sellers" preview — there's no real sales/popularity data
   behind this yet, so it picks round-robin across collections (one item
   from each, then a second from each, etc.) up to `limit`, so the preview
   always shows some variety instead of just the first collection's items.
   Reads live from window.COLLECTIONS, so it stays correct automatically
   if products change via the admin page/Sheet/Supabase. */
function getBestSellers(limit) {
  const collections = window.COLLECTIONS || {};
  const keys = Object.keys(collections);
  const picks = [];
  let round = 0;
  while (picks.length < limit) {
    let addedThisRound = false;
    for (const key of keys) {
      const items = collections[key] && collections[key].items;
      if (items && items[round]) {
        picks.push({ ...items[round], _collection: key });
        addedThisRound = true;
        if (picks.length >= limit) break;
      }
    }
    if (!addedThisRound) break;
    round++;
  }
  return picks;
}

function initBestSellers() {
  const grid = document.getElementById("bestSellersGrid");
  if (!grid) return;
  renderItemCards(getBestSellers(6), "bestSellersGrid");
}

function renderItemCards(items, gridId) {
  const grid = document.getElementById(gridId || "productGrid");
  if (!grid) return;

  if (!items.length) {
    grid.innerHTML = `<p style="grid-column:1/-1;text-align:center;color:var(--color-fg-faint);padding:var(--space-6) 0;">No items match. Try a different search or category.</p>`;
    return;
  }

  grid.innerHTML = items.map((item) => `
    <article class="product-card">
      ${productArtMarkup(item)}
      <div class="product-body">
        <h3>${escapeHtml(item.name)}</h3>
        <div class="product-footer">
          <span class="price">${formatPrice(item.price)}</span>
          <button type="button" class="add-btn" aria-label="Add ${escapeHtml(item.name)} to cart" data-id="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}" data-price="${item.price}" data-collection="${escapeHtml(item._collection)}">
            ${ICONS.cart}
          </button>
        </div>
      </div>
    </article>
  `).join("");

  grid.querySelectorAll(".add-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      addToCart({
        id: btn.dataset.id,
        name: btn.dataset.name,
        price: Number(btn.dataset.price),
        collection: btn.dataset.collection
      });
      btn.classList.add("added");
      btn.innerHTML = ICONS.check;
      showToast(`${btn.dataset.name} added to cart`);
      setTimeout(() => {
        btn.classList.remove("added");
        btn.innerHTML = ICONS.cart;
      }, 1400);
    });
  });

  grid.querySelectorAll(".product-art").forEach((art) => {
    const item = items.find((i) => i.id === art.dataset.artId);
    if (!item) return;
    const open = () => openLightbox(getItemImages(item), item.name);
    art.addEventListener("click", open);
    art.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
  });
}

/* Search + category filter + sort drive every shopping page (home and each
   category page alike) from the same full catalog. A category page's filter
   starts pre-set to its own category (via the "selected" option in its
   HTML), but can be widened to browse everything without leaving the page.
   "Most Popular" has no real popularity data behind it yet — it just keeps
   the catalog's natural order, as a reasonable placeholder until there's
   real order/view data to sort by. */
function applyCatalogFilters(resetPage = true) {
  const grid = document.getElementById("productGrid");
  if (!grid) return;

  const searchInput = document.getElementById("productSearch");
  const filterSelect = document.getElementById("productFilter");
  const sortSelect = document.getElementById("productSort");

  const query = searchInput ? searchInput.value.trim().toLowerCase() : "";
  const category = filterSelect ? filterSelect.value : "all";
  const sort = sortSelect ? sortSelect.value : "popular";

  let items = getAllItemsFlat();
  if (category !== "all") items = items.filter((item) => item._collection === category);
  if (query) items = items.filter((item) => item.name.toLowerCase().includes(query));

  if (sort === "price-asc") items = items.slice().sort((a, b) => a.price - b.price);
  else if (sort === "price-desc") items = items.slice().sort((a, b) => b.price - a.price);
  else if (sort === "alpha") items = items.slice().sort((a, b) => a.name.localeCompare(b.name));

  if (resetPage) catalogPage = 1;
  const totalPages = Math.max(1, Math.ceil(items.length / PRODUCTS_PER_PAGE));
  if (catalogPage > totalPages) catalogPage = totalPages;

  const start = (catalogPage - 1) * PRODUCTS_PER_PAGE;
  renderItemCards(items.slice(start, start + PRODUCTS_PER_PAGE));
  renderPagination(items.length);
}

function renderPagination(totalItems) {
  const el = document.getElementById("productPagination");
  if (!el) return;

  const totalPages = Math.max(1, Math.ceil(totalItems / PRODUCTS_PER_PAGE));
  if (totalPages <= 1) {
    el.innerHTML = "";
    return;
  }

  const pageBtn = (page, label, ariaLabel, extraClass, disabled) =>
    `<button type="button" class="page-btn${extraClass ? " " + extraClass : ""}" data-page="${page}" ${disabled ? "disabled" : ""} aria-label="${ariaLabel}" ${page === catalogPage ? 'aria-current="page"' : ""}>${label}</button>`;

  let html = pageBtn(catalogPage - 1, ICONS.chevronLeft, "Previous page", "page-nav", catalogPage === 1);
  for (let p = 1; p <= totalPages; p++) {
    html += pageBtn(p, String(p), `Page ${p}`, p === catalogPage ? "active" : "", false);
  }
  html += pageBtn(catalogPage + 1, ICONS.chevronRight, "Next page", "page-nav", catalogPage === totalPages);

  el.innerHTML = html;

  el.querySelectorAll(".page-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const p = Number(btn.dataset.page);
      if (!p || p < 1 || p > totalPages || p === catalogPage) return;
      catalogPage = p;
      applyCatalogFilters(false);
      const grid = document.getElementById("productGrid");
      if (grid) grid.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

/* Native <select> dropdown popups can't be styled (rounded corners, custom
   colors, etc.) in any browser — that list is rendered by the OS, not the
   page. To get a rounded dropdown, each select is progressively enhanced
   with a custom button + list built from its <option>s; the original
   <select> stays in the DOM (visually hidden) so existing code that reads
   `select.value` / listens for "change" keeps working unmodified. */
function enhanceSelect(select) {
  if (select.dataset.enhanced) return;
  select.dataset.enhanced = "true";

  const wrapper = document.createElement("div");
  wrapper.className = "custom-select";
  select.parentNode.insertBefore(wrapper, select);
  wrapper.appendChild(select);

  select.classList.add("custom-select-native");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");

  const button = document.createElement("button");
  button.type = "button";
  button.className = "custom-select-btn";
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  button.innerHTML = `<span class="custom-select-label"></span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const label = button.querySelector(".custom-select-label");

  const list = document.createElement("ul");
  list.className = "custom-select-list";
  list.setAttribute("role", "listbox");
  list.hidden = true;

  const options = Array.from(select.options).map((opt) => {
    const li = document.createElement("li");
    li.className = "custom-select-option";
    li.setAttribute("role", "option");
    li.dataset.value = opt.value;
    li.textContent = opt.textContent;
    li.addEventListener("click", () => {
      select.value = opt.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      sync();
      close();
    });
    list.appendChild(li);
    return li;
  });

  function sync() {
    const selected = select.options[select.selectedIndex];
    label.textContent = selected ? selected.textContent : "";
    options.forEach((li) => li.classList.toggle("selected", li.dataset.value === select.value));
  }
  function open() {
    list.hidden = false;
    button.setAttribute("aria-expanded", "true");
    wrapper.classList.add("open");
  }
  function close() {
    list.hidden = true;
    button.setAttribute("aria-expanded", "false");
    wrapper.classList.remove("open");
  }

  button.addEventListener("click", () => (list.hidden ? open() : close()));
  document.addEventListener("click", (e) => {
    if (!wrapper.contains(e.target)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  sync();
  wrapper.appendChild(button);
  wrapper.appendChild(list);
}

function initCustomSelects() {
  document.querySelectorAll("select.filter-select").forEach(enhanceSelect);
}

function initCatalogControls() {
  const grid = document.getElementById("productGrid");
  if (!grid) return;

  const searchInput = document.getElementById("productSearch");
  const filterSelect = document.getElementById("productFilter");
  const sortSelect = document.getElementById("productSort");

  if (searchInput) {
    let searchDebounceTimer = null;
    searchInput.addEventListener("input", () => {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => applyCatalogFilters(true), 180);
    });
  }
  if (filterSelect) filterSelect.addEventListener("change", () => applyCatalogFilters(true));
  if (sortSelect) sortSelect.addEventListener("change", () => applyCatalogFilters(true));

  applyCatalogFilters(true);
}

/* ==========================================================================
   Cart — localStorage-backed
   ========================================================================== */
const CART_KEY = "auraBalloonCart";

function getCart() {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function saveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  updateCartBadge();
}

function addToCart(product) {
  const cart = getCart();
  const existing = cart.find((line) => line.id === product.id);
  if (existing) {
    existing.qty += 1;
  } else {
    cart.push({ ...product, qty: 1 });
  }
  saveCart(cart);
  renderCartDrawer();
}

function setQty(id, qty) {
  let cart = getCart();
  if (qty <= 0) {
    cart = cart.filter((line) => line.id !== id);
  } else {
    const line = cart.find((l) => l.id === id);
    if (line) line.qty = qty;
  }
  saveCart(cart);
  renderCartDrawer();
}

function removeFromCart(id) {
  const cart = getCart().filter((line) => line.id !== id);
  saveCart(cart);
  renderCartDrawer();
}

function cartTotal(cart) {
  return cart.reduce((sum, line) => sum + line.price * line.qty, 0);
}

function cartCount(cart) {
  return cart.reduce((sum, line) => sum + line.qty, 0);
}

function updateCartBadge() {
  const badge = document.querySelector(".cart-count");
  if (!badge) return;
  const count = cartCount(getCart());
  badge.textContent = String(count);
  badge.hidden = count === 0;
}

function collectionLabel(slug) {
  return (window.COLLECTIONS && window.COLLECTIONS[slug] && window.COLLECTIONS[slug].title) || slug;
}

function renderCartDrawer() {
  const list = document.getElementById("cartItems");
  const subtotalEl = document.getElementById("cartSubtotal");
  if (!list) return;
  const cart = getCart();

  if (cart.length === 0) {
    list.innerHTML = `
      <div class="cart-empty">
        <img src="images/cart-empty-icon.png" alt="" aria-hidden="true"/>
        <p>Your cart is empty.</p>
        <p style="font-size:0.85rem;">Browse a collection and add a few favorites.</p>
      </div>`;
  } else {
    list.innerHTML = cart.map((line) => `
      <div class="cart-line" data-id="${escapeHtml(line.id)}">
        <div class="cart-line-art"></div>
        <div class="cart-line-body">
          <h4>${escapeHtml(line.name)}</h4>
          <div class="cart-line-collection">${escapeHtml(collectionLabel(line.collection))}</div>
          <div class="cart-line-row">
            <div class="qty-control">
              <button type="button" class="qty-minus" aria-label="Decrease quantity">${ICONS.minus}</button>
              <span>${line.qty}</span>
              <button type="button" class="qty-plus" aria-label="Increase quantity">${ICONS.plus}</button>
            </div>
            <span class="cart-line-price">${formatPrice(line.price * line.qty)}</span>
          </div>
          <button type="button" class="remove-btn">Remove</button>
        </div>
      </div>
    `).join("");

    // Give each cart line its photo, or the shared "no photo yet" placeholder.
    list.querySelectorAll(".cart-line").forEach((el) => {
      const id = el.dataset.id;
      const item = findItemById(id);
      const art = el.querySelector(".cart-line-art");
      const src = (item && item.image) || NO_PHOTO_IMAGE;
      art.innerHTML = `<img src="${escapeHtml(src)}" alt=""/>`;

      el.querySelector(".qty-minus").addEventListener("click", () => {
        const line = cart.find((l) => l.id === id);
        if (line) setQty(id, line.qty - 1);
      });
      el.querySelector(".qty-plus").addEventListener("click", () => {
        const line = cart.find((l) => l.id === id);
        if (line) setQty(id, line.qty + 1);
      });
      el.querySelector(".remove-btn").addEventListener("click", () => removeFromCart(id));
    });
  }

  if (subtotalEl) subtotalEl.textContent = formatPrice(cartTotal(cart));
  updateCartBadge();
}

/* Cached id -> item lookup, rebuilt whenever window.COLLECTIONS is a
   different object than the one the cache was built from (it gets
   reassigned wholesale after a Supabase/live catalog load — see
   js/catalog.js and js/supabase-catalog.js — so a reference check is
   enough to know the cache is stale, without those files needing to know
   about this cache at all). */
let itemsByIdCache = null;
let itemsByIdCacheSource = null;

function getItemsByIdMap() {
  if (itemsByIdCache && itemsByIdCacheSource === window.COLLECTIONS) return itemsByIdCache;
  const map = new Map();
  if (window.COLLECTIONS) {
    for (const slug in window.COLLECTIONS) {
      for (const item of window.COLLECTIONS[slug].items) map.set(item.id, item);
    }
  }
  itemsByIdCache = map;
  itemsByIdCacheSource = window.COLLECTIONS;
  return map;
}

function findItemById(id) {
  return getItemsByIdMap().get(id) || null;
}

/* ==========================================================================
   Cart drawer + checkout modal open/close
   ========================================================================== */
function initCartUI() {
  const scrim = document.getElementById("scrim");
  const drawer = document.getElementById("cartDrawer");
  const openBtn = document.querySelector(".cart-btn");
  const closeBtn = document.getElementById("closeCart");
  const checkoutBtn = document.getElementById("checkoutBtn");

  function openCart() {
    drawer.classList.add("open");
    scrim.classList.add("visible");
    document.body.style.overflow = "hidden";
  }
  function closeCart() {
    drawer.classList.remove("open");
    if (!document.getElementById("checkoutModal").classList.contains("open")) {
      scrim.classList.remove("visible");
      document.body.style.overflow = "";
    }
  }

  if (openBtn) openBtn.addEventListener("click", () => { renderCartDrawer(); openCart(); });
  if (closeBtn) closeBtn.addEventListener("click", closeCart);
  if (scrim) scrim.addEventListener("click", () => {
    closeCart();
    closeCheckoutModal();
  });
  if (checkoutBtn) checkoutBtn.addEventListener("click", () => {
    if (getCart().length === 0) {
      showToast("Add something to your cart first");
      return;
    }
    openCheckoutModal();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeCart();
      closeCheckoutModal();
    }
  });

  renderCartDrawer();
}

/* ==========================================================================
   Checkout modal
   ========================================================================== */
function buildOrderPayload(form) {
  const cart = getCart();
  const summary = cart.map((l) => `${l.qty} x ${l.name} (${collectionLabel(l.collection)}) - ${formatPrice(l.price * l.qty)}`).join("\n");
  return {
    name: form.name.value.trim(),
    phone: form.phone.value.trim(),
    email: form.email.value.trim(),
    address: form.address.value.trim(),
    date: form.date.value.trim(),
    notes: form.notes.value.trim(),
    summary,
    total: formatPrice(cartTotal(cart))
  };
}

/* Shared by every form's validation (checkout form here, custom-order form
   below) so the email check only lives in one place. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* Shared field-validation loop. `rules` is an array of
   [fieldName, testFn, errorMessage] tuples; for each one, runs testFn
   against the trimmed field value, and on failure sets aria-invalid on the
   input plus fills the textContent of the element at
   `${errorIdPrefix}${fieldName}` — on success clears both. Different forms
   use different error-element id prefixes (checkout uses "error-", the
   custom-order form uses "co-error-"), hence the parameter. Returns true
   only if every rule passed. */
function runFieldValidation(form, rules, errorIdPrefix) {
  let valid = true;
  rules.forEach(([field, test, message]) => {
    const input = form[field];
    const errorEl = document.getElementById(`${errorIdPrefix}${field}`);
    const value = input.value.trim();
    if (!test(value)) {
      if (errorEl) errorEl.textContent = message;
      input.setAttribute("aria-invalid", "true");
      valid = false;
    } else {
      if (errorEl) errorEl.textContent = "";
      input.removeAttribute("aria-invalid");
    }
  });
  return valid;
}

function validateCheckoutForm(form) {
  const rules = [
    ["name", (v) => v.length > 1, "Please enter your name."],
    ["phone", (v) => v.length >= 7, "Please enter a valid phone number."],
    ["email", (v) => EMAIL_RE.test(v), "Please enter a valid email."],
    ["address", (v) => v.length > 4, "Please enter a delivery/event address."]
  ];
  return runFieldValidation(form, rules, "error-");
}

function submitOrder(payload) {
  if (!isFormConfigured()) {
    console.info("[Aura Balloon Co.] Google Form not yet configured — simulating submission.", payload);
    return new Promise((resolve) => setTimeout(resolve, 700));
  }
  const params = new URLSearchParams();
  const entries = CONFIG.googleForm.entries;
  Object.keys(entries).forEach((key) => {
    if (payload[key] !== undefined) params.append(entries[key], payload[key]);
  });
  return fetch(CONFIG.googleForm.actionUrl, {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
}

function renderOrderSummary() {
  const el = document.getElementById("orderSummaryRows");
  if (!el) return;
  const cart = getCart();
  el.innerHTML = cart.map((l) => `
    <div class="order-summary-row"><span>${l.qty} x ${escapeHtml(l.name)}</span><span>${formatPrice(l.price * l.qty)}</span></div>
  `).join("") + `<div class="order-summary-row total"><span>Total</span><span>${formatPrice(cartTotal(cart))}</span></div>`;
}

function openCheckoutModal() {
  const modal = document.getElementById("checkoutModal");
  const scrim = document.getElementById("scrim");
  renderOrderSummary();
  showCheckoutStep("form");
  modal.classList.add("open");
  scrim.classList.add("visible");
  document.body.style.overflow = "hidden";
  const firstField = modal.querySelector("#name");
  if (firstField) firstField.focus();
}

/* Guards against losing a half-filled order on an accidental scrim click,
   Esc, or the X/Back button — only prompts while there's real typed input
   on the form step (never on the success step, never on an empty form). */
function checkoutFormHasInput() {
  const form = document.getElementById("checkoutForm");
  if (!form) return false;
  return Array.from(form.elements).some((el) => {
    if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") return false;
    return el.value.trim() !== "";
  });
}

function closeCheckoutModal() {
  const modal = document.getElementById("checkoutModal");
  if (!modal) return;
  const formStep = document.getElementById("checkoutFormStep");
  const onFormStep = formStep && !formStep.hidden;
  if (onFormStep && checkoutFormHasInput()) {
    const confirmed = window.confirm("Discard your order details? What you've entered so far will be lost.");
    if (!confirmed) return;
    document.getElementById("checkoutForm").reset();
  }
  modal.classList.remove("open");
  const drawer = document.getElementById("cartDrawer");
  if (!drawer.classList.contains("open")) {
    document.getElementById("scrim").classList.remove("visible");
    document.body.style.overflow = "";
  }
}

function showCheckoutStep(step) {
  const formStep = document.getElementById("checkoutFormStep");
  const successStep = document.getElementById("checkoutSuccessStep");
  if (step === "form") {
    formStep.hidden = false;
    successStep.hidden = true;
  } else {
    formStep.hidden = true;
    successStep.hidden = false;
  }
}

function wireLocationButton(buttonId, inputId) {
  const btn = document.getElementById(buttonId);
  const input = document.getElementById(inputId);
  if (!btn || !input) return;

  btn.addEventListener("click", () => {
    if (!navigator.geolocation) {
      showToast("Location isn't available in this browser.");
      return;
    }
    btn.classList.add("is-loading");
    btn.disabled = true;

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}`,
            { headers: { Accept: "application/json" } }
          );
          if (!res.ok) throw new Error("reverse geocode failed");
          const data = await res.json();
          input.value = data.display_name || `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
        } catch (err) {
          input.value = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
          showToast("Found your location, but couldn't look up the address.");
        } finally {
          btn.classList.remove("is-loading");
          btn.disabled = false;
          input.focus();
        }
      },
      () => {
        btn.classList.remove("is-loading");
        btn.disabled = false;
        showToast("Couldn't access your location. Please enter your address manually.");
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

function initAddressLocation() {
  wireLocationButton("useMyLocationBtn", "address");
}

function initCheckoutForm() {
  const form = document.getElementById("checkoutForm");
  if (!form) return;
  const submitBtn = document.getElementById("placeOrderBtn");
  const closeButtons = document.querySelectorAll("[data-close-checkout]");

  closeButtons.forEach((btn) => btn.addEventListener("click", closeCheckoutModal));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!validateCheckoutForm(form)) return;

    submitBtn.disabled = true;
    const originalLabel = submitBtn.innerHTML;
    submitBtn.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>Sending order...</span>`;

    const payload = buildOrderPayload(form);

    try {
      await submitOrder(payload);
      const ref = "AUR-" + Date.now().toString().slice(-6);
      document.getElementById("orderRef").textContent = ref;
      saveCart([]);
      renderCartDrawer();
      showCheckoutStep("success");
      form.reset();
    } catch (err) {
      console.error("Order submission failed", err);
      const errorEl = document.getElementById("checkoutFormError");
      if (errorEl) errorEl.textContent = "Something went wrong sending your order. Please check your connection and try again, or reach us directly.";
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalLabel;
    }
  });
}

/* ==========================================================================
   Review carousel (homepage) — one review at a time, prev/next + dots,
   gentle auto-advance. Placeholder reviews — swap in real ones any time.
   ========================================================================== */
const REVIEWS = [
  { name: "Sarah M.", rating: 5, text: "Absolutely stunning balloon arch for our anniversary! Every guest was asking who did it.", tag: "Anniversary Collection" },
  { name: "James T.", rating: 5, text: "Ordered a custom balloon set for my son's birthday and it exceeded expectations.", tag: "Birthday Collection" },
  { name: "Priya K.", rating: 5, text: "The kids loved their balloon bouquet! Great quality and fast delivery.", tag: "Kids Collection" },
  { name: "David L.", rating: 4, text: "Professional service for our corporate event. The backdrop was a huge hit with clients.", tag: "Other Occasions" },
  { name: "Megan R.", rating: 5, text: "Beautiful arrangement, exactly what we asked for. Will definitely order again!", tag: "Anniversary Collection" },
  { name: "Alex W.", rating: 5, text: "Quick response on WhatsApp and the custom order process was so easy from start to finish.", tag: "Custom Order" }
];

function reviewStarSVG(filled) {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="${filled ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.5"><path d="M12 2.5l2.9 6.1 6.6.9-4.8 4.7 1.1 6.6L12 17.6l-5.8 3.2 1.1-6.6-4.8-4.7 6.6-.9z" stroke-linejoin="round"/></svg>`;
}

let reviewIndex = 0;
let reviewAutoTimer = null;

function renderReview(index) {
  const track = document.getElementById("reviewTrack");
  if (!track) return;
  const r = REVIEWS[index];
  track.innerHTML = `
    <p class="review-text">"${escapeHtml(r.text)}"</p>
    <p class="review-author">${escapeHtml(r.name)}</p>
    <p class="review-tag">${escapeHtml(r.tag)}</p>
  `;
  document.querySelectorAll(".carousel-dot").forEach((dot, i) => {
    dot.classList.toggle("active", i === index);
    dot.setAttribute("aria-current", i === index ? "true" : "false");
  });
}

function goToReview(index) {
  reviewIndex = (index + REVIEWS.length) % REVIEWS.length;
  renderReview(reviewIndex);
}

function resetReviewAutoAdvance() {
  clearInterval(reviewAutoTimer);
  reviewAutoTimer = setInterval(() => goToReview(reviewIndex + 1), 6000);
}

async function initReviewCarousel() {
  const track = document.getElementById("reviewTrack");
  if (!track) return;

  if (typeof fetchGoogleReviews === "function") {
    const liveReviews = await fetchGoogleReviews();
    if (liveReviews && liveReviews.length) {
      REVIEWS.length = 0;
      REVIEWS.push(...liveReviews);
      const attribution = document.getElementById("reviewsAttribution");
      if (attribution) attribution.hidden = false;
    }
  }

  const dotsWrap = document.getElementById("reviewDots");
  dotsWrap.innerHTML = REVIEWS.map((_, i) => `<button type="button" class="carousel-dot" aria-label="Go to review ${i + 1}"></button>`).join("");
  dotsWrap.querySelectorAll(".carousel-dot").forEach((dot, i) => {
    dot.addEventListener("click", () => {
      goToReview(i);
      resetReviewAutoAdvance();
    });
  });

  document.getElementById("reviewPrev").addEventListener("click", () => {
    goToReview(reviewIndex - 1);
    resetReviewAutoAdvance();
  });
  document.getElementById("reviewNext").addEventListener("click", () => {
    goToReview(reviewIndex + 1);
    resetReviewAutoAdvance();
  });

  renderReview(0);
  resetReviewAutoAdvance();
}

/* ==========================================================================
   Custom order form (custom-order.html) — reuses the same submitOrder()
   target as checkout (same Google Form/Supabase setup), just with a
   different payload shape. Quietly does nothing on pages without this form.
   ========================================================================== */
function initCustomOrderForm() {
  const form = document.getElementById("customOrderForm");
  if (!form) return;
  const submitBtn = document.getElementById("customOrderSubmitBtn");

  function isDelivery() {
    return form.fulfillment.value === "delivery";
  }

  function validate() {
    const rules = [
      ["name", (v) => v.length > 1, "Please enter your name."],
      ["phone", (v) => v.length >= 7, "Please enter a valid phone number."],
      ["email", (v) => EMAIL_RE.test(v), "Please enter a valid email."],
      ["details", (v) => v.length > 5, "Please tell us a bit about what you're picturing."]
    ];
    return runFieldValidation(form, rules, "co-error-");
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!validate()) return;

    submitBtn.disabled = true;
    const originalLabel = submitBtn.innerHTML;
    submitBtn.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>Sending request...</span>`;

    const budget = form.budget.value.trim();
    const delivery = isDelivery();
    const payload = {
      name: form.name.value.trim(),
      phone: form.phone.value.trim(),
      email: form.email.value.trim(),
      address: delivery ? "Delivery (address to be coordinated)" : "Pick-up (no delivery)",
      date: form.date.value.trim(),
      notes: `Fulfillment: ${delivery ? "Delivery" : "Pick-up"}\n\n${form.details.value.trim()}`,
      summary: "Custom order request",
      total: budget ? `Budget: ${budget}` : "Budget not specified"
    };

    try {
      await submitOrder(payload);
      const ref = "AUR-" + Date.now().toString().slice(-6);
      document.getElementById("customOrderRef").textContent = ref;
      document.getElementById("customOrderFormWrap").hidden = true;
      document.getElementById("customOrderSuccess").hidden = false;
      form.reset();
    } catch (err) {
      console.error("Custom order submission failed", err);
      const errorEl = document.getElementById("customOrderFormError");
      if (errorEl) errorEl.textContent = "Something went wrong sending your request. Please check your connection and try again, or message us on WhatsApp instead.";
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalLabel;
    }
  });
}

/* ==========================================================================
   Product photo lightbox — opened by clicking a product-art thumbnail.
   Built once (lazily) and reused for every card; shows prev/next + dots
   only when an item has more than one photo via `images: [...]`.
   ========================================================================== */
let lightboxImages = [];
let lightboxIndex = 0;

function ensureLightbox() {
  let modal = document.getElementById("imageLightbox");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.className = "modal lightbox-modal";
  modal.id = "imageLightbox";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.innerHTML = `
    <div class="modal-scrim" data-close-lightbox></div>
    <div class="lightbox-panel">
      <button type="button" class="icon-btn lightbox-close" data-close-lightbox aria-label="Close">${ICONS.close}</button>
      <div class="lightbox-img-wrap">
        <button type="button" class="carousel-nav lightbox-nav lightbox-prev" aria-label="Previous photo">${ICONS.chevronLeft}</button>
        <img class="lightbox-img" src="" alt=""/>
        <button type="button" class="carousel-nav lightbox-nav lightbox-next" aria-label="Next photo">${ICONS.chevronRight}</button>
      </div>
      <div class="carousel-dots lightbox-dots"></div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelectorAll("[data-close-lightbox]").forEach((el) => el.addEventListener("click", closeLightbox));
  modal.querySelector(".lightbox-prev").addEventListener("click", () => stepLightbox(-1));
  modal.querySelector(".lightbox-next").addEventListener("click", () => stepLightbox(1));

  document.addEventListener("keydown", (e) => {
    if (!modal.classList.contains("open")) return;
    if (e.key === "Escape") closeLightbox();
    if (e.key === "ArrowLeft") stepLightbox(-1);
    if (e.key === "ArrowRight") stepLightbox(1);
  });

  return modal;
}

function renderLightboxFrame() {
  const modal = document.getElementById("imageLightbox");
  if (!modal) return;
  modal.querySelector(".lightbox-img").src = lightboxImages[lightboxIndex];
  const multi = lightboxImages.length > 1;
  modal.querySelector(".lightbox-prev").hidden = !multi;
  modal.querySelector(".lightbox-next").hidden = !multi;

  const dots = modal.querySelector(".lightbox-dots");
  dots.innerHTML = multi
    ? lightboxImages.map((_, i) => `<button type="button" class="carousel-dot${i === lightboxIndex ? " active" : ""}" data-dot-index="${i}" aria-label="Photo ${i + 1}"></button>`).join("")
    : "";
  dots.querySelectorAll("[data-dot-index]").forEach((dot) => {
    dot.addEventListener("click", () => {
      lightboxIndex = Number(dot.dataset.dotIndex);
      renderLightboxFrame();
    });
  });
}

function stepLightbox(delta) {
  if (lightboxImages.length < 2) return;
  lightboxIndex = (lightboxIndex + delta + lightboxImages.length) % lightboxImages.length;
  renderLightboxFrame();
}

function openLightbox(images, name) {
  const modal = ensureLightbox();
  lightboxImages = images && images.length ? images : [NO_PHOTO_IMAGE];
  lightboxIndex = 0;
  modal.setAttribute("aria-label", `${name} photos`);
  renderLightboxFrame();
  modal.classList.add("open");
  document.body.style.overflow = "hidden";
}

function closeLightbox() {
  const modal = document.getElementById("imageLightbox");
  if (!modal) return;
  modal.classList.remove("open");
  const cartOpen = document.getElementById("cartDrawer")?.classList.contains("open");
  const checkoutOpen = document.getElementById("checkoutModal")?.classList.contains("open");
  if (!cartOpen && !checkoutOpen) document.body.style.overflow = "";
}

/* ==========================================================================
   Init
   ========================================================================== */
document.addEventListener("DOMContentLoaded", async () => {
  // Catalog loading and the review carousel's fetch are independent (reviews
  // don't depend on catalog data), so kick both off up front and let their
  // network requests overlap instead of running strictly back-to-back. Only
  // the catalog load needs to finish before the catalog-dependent init calls
  // below; the review carousel manages its own DOM once its fetch resolves.
  const catalogLoadPromise = (async () => {
    let liveCatalogLoaded = false;
    if (typeof loadSupabaseCatalog === "function") {
      liveCatalogLoaded = await loadSupabaseCatalog();
    }
    if (!liveCatalogLoaded && typeof loadLiveCatalog === "function") {
      await loadLiveCatalog();
    }
  })();
  const reviewCarouselPromise = initReviewCarousel();

  await catalogLoadPromise;
  initNav();
  initCustomSelects();
  initCatalogControls();
  initBestSellers();
  initCartUI();
  initCheckoutForm();
  initAddressLocation();
  initCustomOrderForm();
  await reviewCarouselPromise;
  updateCartBadge();
});
