/*
  Loads site-wide content (hero text, about copy, contact info, social
  links, theme colors, nav links, shop categories, FAQ) from Supabase, if
  configured — see js/supabase-config.js. Every render*() function below
  only touches the DOM on success and is a no-op otherwise, so the existing
  hardcoded HTML/CSS is always the safe fallback, exactly like
  js/supabase-catalog.js does for products.
*/

async function loadSiteContent() {
  const client = typeof getSupabaseClient === "function" ? getSupabaseClient() : null;
  if (!client) return false;

  try {
    const [settingsRes, collectionsRes, navRes, faqRes] = await Promise.all([
      client.from("site_settings").select("*"),
      client.from("collections").select("*").order("sort_order", { ascending: true }),
      client.from("nav_items").select("*").eq("visible", true).order("sort_order", { ascending: true }),
      client.from("faq_items").select("*").order("sort_order", { ascending: true })
    ]);

    if (settingsRes.error) throw settingsRes.error;

    const settingsMap = {};
    (settingsRes.data || []).forEach((row) => { settingsMap[row.key] = row.value; });

    // Admin "Preview" (unsaved settings) — only with ?preview=1.
    const previewDraft = readSettingsPreviewDraft();
    if (previewDraft) Object.assign(settingsMap, previewDraft);

    window.SITE_SETTINGS = settingsMap;
    window.SITE_COLLECTIONS = collectionsRes.error ? [] : (collectionsRes.data || []);
    window.SITE_NAV_ITEMS = navRes.error ? [] : (navRes.data || []);
    window.SITE_FAQ_ITEMS = faqRes.error ? [] : (faqRes.data || []);

    applySeoMeta(settingsMap);
    if (previewDraft) showSettingsPreviewRibbon();

    console.info("[Balloons by Tea] Loaded live site content from Supabase.");
    return true;
  } catch (err) {
    console.warn("[Balloons by Tea] Could not load live site content, using the built-in page content instead.", err);
    return false;
  } finally {
    // Independent of the settings result: alt text and the ?edit=1 entry
    // point each degrade to "do nothing" on their own.
    initPhotoAlt(client);
    startEditModeFromUrl();
  }
}

/* ===== Admin preview of unsaved settings =====
   admin.html's Settings "Preview" button (js/admin-content-ui.js) writes
   { savedAt, values } to localStorage under this key and opens a page with
   ?preview=1. Without that parameter, or with a draft older than 2 hours,
   nothing changes. */
const SETTINGS_PREVIEW_STORAGE_KEY_PUBLIC = "aura-settings-preview";

function isSettingsPreviewRequested() {
  try { return new URLSearchParams(location.search).get("preview") === "1"; } catch (e) { return false; }
}

function readSettingsPreviewDraft() {
  if (!isSettingsPreviewRequested()) return null;
  try {
    const raw = localStorage.getItem(SETTINGS_PREVIEW_STORAGE_KEY_PUBLIC);
    if (!raw) return null;
    const draft = JSON.parse(raw);
    if (!draft || typeof draft.values !== "object" || !draft.savedAt || Date.now() - draft.savedAt > 2 * 60 * 60 * 1000) return null;
    const values = {};
    Object.keys(draft.values).forEach((k) => {
      if (typeof draft.values[k] === "string") values[k] = draft.values[k];
    });
    return values;
  } catch (e) {
    return null;
  }
}

function showSettingsPreviewRibbon() {
  if (document.getElementById("settingsPreviewRibbon")) return;
  const ribbon = document.createElement("div");
  ribbon.id = "settingsPreviewRibbon";
  ribbon.className = "settings-preview-ribbon";
  ribbon.setAttribute("role", "status");
  const label = document.createElement("strong");
  label.textContent = "Preview — not saved";
  const exit = document.createElement("a");
  const url = new URL(location.href);
  url.searchParams.delete("preview");
  exit.href = url.pathname + url.search + url.hash;
  exit.textContent = "Exit preview";
  ribbon.append(label, exit);
  document.body.appendChild(ribbon);
}

/* ===== Page-level SEO (admin Settings → SEO & sharing) =====
   site_settings keys seo_<page>_title / seo_<page>_description and
   seo_og_image override the static <title>/<meta> tags when set. The
   static tags in each HTML file stay as the fallback, and are all a
   crawler that doesn't run JavaScript will ever see. */
const SEO_PAGE_KEYS = {
  "index": "index", "all-products": "all_products", "anniversary": "anniversary", "birthday": "birthday",
  "kids": "kids", "other-occasions": "other_occasions", "category": "category", "gallery": "gallery",
  "custom-order": "custom_order", "about": "about", "faq": "faq"
};

function currentSeoPageKey() {
  const file = decodeURIComponent(location.pathname.split("/").pop() || "");
  const base = file.replace(/\.html?$/i, "") || "index";
  return SEO_PAGE_KEYS[base] || null;
}

function setMetaTag(attr, name, content) {
  let tag = document.head.querySelector(`meta[${attr}="${name}"]`);
  if (!tag) {
    tag = document.createElement("meta");
    tag.setAttribute(attr, name);
    document.head.appendChild(tag);
  }
  tag.setAttribute("content", content);
}

function applySeoMeta(s) {
  if (!s) return;
  const key = currentSeoPageKey();
  const title = key ? String(s[`seo_${key}_title`] || "").trim() : "";
  const description = key ? String(s[`seo_${key}_description`] || "").trim() : "";
  const ogImage = String(s.seo_og_image || "").trim();
  if (title) {
    document.title = title;
    setMetaTag("property", "og:title", title);
    setMetaTag("name", "twitter:title", title);
  }
  if (description) {
    setMetaTag("name", "description", description);
    setMetaTag("property", "og:description", description);
    setMetaTag("name", "twitter:description", description);
  }
  if (ogImage && !ogImage.startsWith("data:")) {
    let abs = ogImage;
    try { abs = new URL(ogImage, location.href).href; } catch (e) { /* keep as-is */ }
    setMetaTag("property", "og:image", abs);
    setMetaTag("name", "twitter:image", abs);
  }
}

/* ===== Photo alt text (photo_meta table) =====
   window.photoAlt(url, fallback) returns the owner's alt text for a photo
   URL, or `fallback`. Fetched once per tab and cached in sessionStorage
   for 10 minutes. Images already on the page, and any rendered later
   (product cards, product detail, gallery, hero, lightbox), get their alt
   filled in automatically; with no row for a photo — or no photo_meta
   table at all — the existing alt stays exactly as it is. */
const PHOTO_ALT_CACHE_KEY = "photoAltMap:v1";
const PHOTO_ALT_CACHE_MS = 10 * 60 * 1000;
let photoAltMap = null;

function photoAltUrlKey(url) {
  const raw = String(url || "").trim();
  if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) return "";
  try {
    const u = new URL(raw, location.href);
    return u.origin + u.pathname;
  } catch (e) {
    return raw.split("#")[0].split("?")[0];
  }
}

window.photoAlt = function photoAlt(url, fallback) {
  const key = photoAltUrlKey(url);
  const alt = key && photoAltMap ? photoAltMap.get(key) : "";
  return alt || (fallback == null ? "" : fallback);
};

/* Purely decorative images (thumbnail strips, related-product art) keep
   alt="" on purpose; everything else gets the owner's alt when it has one. */
const PHOTO_ALT_SKIP = ".pd-thumb, .pd-related-art, [aria-hidden='true']";

function applyPhotoAltTo(img) {
  if (!photoAltMap || !photoAltMap.size || img.closest(PHOTO_ALT_SKIP)) return;
  const alt = photoAltMap.get(photoAltUrlKey(img.getAttribute("src")));
  if (alt && img.getAttribute("alt") !== alt) img.setAttribute("alt", alt);
}

function applyPhotoAltWithin(root) {
  if (root.tagName === "IMG") applyPhotoAltTo(root);
  else if (root.querySelectorAll) root.querySelectorAll("img").forEach(applyPhotoAltTo);
}

let photoAltStarted = false;
async function initPhotoAlt(client) {
  if (photoAltStarted) return;
  photoAltStarted = true;
  let rows = null;
  try {
    const cached = JSON.parse(sessionStorage.getItem(PHOTO_ALT_CACHE_KEY) || "null");
    if (cached && Array.isArray(cached.rows) && Date.now() - cached.at < PHOTO_ALT_CACHE_MS) rows = cached.rows;
  } catch (e) { /* storage unavailable or corrupt: fetch instead */ }
  if (!rows && client) {
    try {
      const { data, error } = await client.from("photo_meta").select("url,alt").not("alt", "is", null).limit(5000);
      rows = error ? [] : (data || []).filter((r) => r.alt && String(r.alt).trim()).map((r) => [r.url, String(r.alt).trim()]);
      try { sessionStorage.setItem(PHOTO_ALT_CACHE_KEY, JSON.stringify({ at: Date.now(), rows })); } catch (e) { /* ignore */ }
    } catch (e) {
      rows = [];
    }
  }
  photoAltMap = new Map();
  (rows || []).forEach(([url, alt]) => { const k = photoAltUrlKey(url); if (k) photoAltMap.set(k, alt); });
  if (!photoAltMap.size) return;
  applyPhotoAltWithin(document.body);
  new MutationObserver((mutations) => {
    mutations.forEach((m) => {
      if (m.type === "attributes") applyPhotoAltTo(m.target);
      else m.addedNodes.forEach((n) => { if (n.nodeType === 1) applyPhotoAltWithin(n); });
    });
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
}

/* ===== "Edit on page" entry point =====
   admin.html links to e.g. index.html?edit=1. js/edit-mode.js only builds
   its toggle button once it has confirmed an admin session, so wait for
   that button and switch edit mode on; for anyone else nothing appears
   and this gives up quietly. */
function startEditModeFromUrl() {
  let wanted = false;
  try { wanted = new URLSearchParams(location.search).get("edit") === "1"; } catch (e) { return; }
  if (!wanted) return;
  let tries = 0;
  const timer = setInterval(() => {
    const btn = document.getElementById("editModeToggle");
    if (btn) {
      clearInterval(timer);
      if (btn.getAttribute("aria-pressed") !== "true") btn.click();
    } else if (++tries > 40) {
      clearInterval(timer);
    }
  }, 250);
}

/* ===== Optimized built-in artwork =====
   The bundled images ship as resized WebP (scripts/optimize_images.py), but
   saved settings/collections rows can still hold the ORIGINAL paths (e.g.
   hero_image_url = "images/hero-mascot.png"), which are kept on disk for
   exactly that reason. Map those known defaults to their WebP versions so a
   saved default doesn't swap the 1MB+ PNG back in; any other URL (an
   uploaded photo) passes through unchanged. */
const SHOP_CARD_SIZES = "(max-width: 560px) calc(100vw - 42px), (max-width: 960px) calc(50vw - 40px), 300px";
const OPTIMIZED_IMAGES = {
  "images/hero-mascot.png": { src: "images/hero-mascot.webp" },
  "images/logo.png": { src: "images/logo.webp" },
  "images/no-picture.png": { src: "images/no-picture.webp" },
  "images/sanrio-bouquet.png": { src: "images/sanrio-bouquet.webp" }
};
["anniversary", "birthday", "kids", "other-occasions"].forEach((slug) => {
  OPTIMIZED_IMAGES[`images/card-${slug}.png`] = {
    src: `images/card-${slug}-600w.webp`,
    srcset: `images/card-${slug}-600w.webp 600w, images/card-${slug}-1044w.webp 1044w`
  };
});
function optimizedImage(url) {
  const key = String(url || "").replace(/^(?:\.\/|\/balloons-by-tea\/|https:\/\/thornleung01\.github\.io\/balloons-by-tea\/)/, "");
  return OPTIMIZED_IMAGES[key] || { src: url };
}

/* ===== Nav icons — matches the 5 hand-drawn icons already in the HTML.
   New admin-added nav items (no matching key) get the generic star. ===== */
const NAV_ICONS = {
  home: `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 11 12 4l8 7v1.2l-8-6.6-8 6.6z" fill="var(--coral)" stroke="var(--brown)" stroke-width="1.4" stroke-linejoin="round"/><path d="M6 10.6V20a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9.4" fill="#fff" stroke="var(--brown)" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 14.6a1.8 1.8 0 0 1 3.3-1c.5.8.2 1.8-.9 2.6L12 18l-2.4-1.8c-1.1-.8-1.4-1.8-.9-2.6a1.8 1.8 0 0 1 3.3 1z" fill="var(--coral)" stroke="var(--brown)" stroke-width="1" stroke-linejoin="round"/></svg>`,
  shop: `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="4" y="10" width="16" height="10.5" rx="1.2" fill="#fff" stroke="var(--brown)" stroke-width="1.6"/><rect x="10.7" y="10" width="2.6" height="10.5" fill="var(--coral)"/><path d="M4 14.2h16" stroke="var(--brown)" stroke-width="1"/><path d="M12 10c-1.8 0-3.4-1-3.4-2.5C8.6 6.2 10 5.8 12 7.5c2-1.7 3.4-1.3 3.4.1C15.4 9 13.8 10 12 10z" fill="var(--coral)" stroke="var(--brown)" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
  "custom-order": `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="5" y="4" width="14" height="17" rx="1.6" fill="#fff" stroke="var(--brown)" stroke-width="1.6"/><path d="M9 4.3a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 4.3V6H9z" fill="var(--blush)" stroke="var(--brown)" stroke-width="1.1"/><path d="M8 11h8M8 14h8M8 17h5" stroke="var(--brown)" stroke-width="1.1" stroke-linecap="round" opacity="0.55"/><circle cx="16.2" cy="16.6" r="3.1" fill="var(--coral)" stroke="var(--brown)" stroke-width="1.1"/><path d="M14.8 16.6l1 1 1.9-2.1" stroke="#fff" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`,
  about: `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 21s-7-4.4-9.5-8.7C.8 8.8 2.6 5 6.3 5c2 0 3.5 1.1 4.2 2.6C11.2 6.1 12.7 5 14.7 5c3.7 0 5.5 3.8 3.8 7.3C16 16.6 12 21 12 21z" fill="var(--coral)" stroke="var(--brown)" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
  faq: `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M10.5 11.5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v3.3a2 2 0 0 1-2 2h-.8v2.1l-2.3-2.1h-1.9a2 2 0 0 1-2-2z" fill="var(--baby-blue)" stroke="var(--brown)" stroke-width="1.2" stroke-linejoin="round"/><path d="M3 6.8A2.3 2.3 0 0 1 5.3 4.5h9.4A2.3 2.3 0 0 1 17 6.8v5.4a2.3 2.3 0 0 1-2.3 2.3H11l-3.4 2.8v-2.8H5.3A2.3 2.3 0 0 1 3 12.2z" fill="var(--blush)" stroke="var(--brown)" stroke-width="1.4" stroke-linejoin="round"/><path d="M8.3 9c0-1 .8-1.7 1.9-1.7s1.9.6 1.9 1.5c0 1.3-1.9 1.2-1.9 2.7" stroke="var(--brown)" stroke-width="1.4" stroke-linecap="round" fill="none"/><circle cx="10.2" cy="13.2" r="0.85" fill="var(--brown)"/></svg>`,
  none: `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 2l1.9 5.9H20l-5 3.6 1.9 5.9L12 13.8l-5 3.6 1.9-5.9-5-3.6h6.1z" fill="var(--coral)" stroke="var(--brown)" stroke-width="1.2" stroke-linejoin="round"/></svg>`
};

function renderNav() {
  const navLinks = document.getElementById("navLinks");
  if (!navLinks || !window.SITE_NAV_ITEMS || !window.SITE_NAV_ITEMS.length) return;

  const items = window.SITE_NAV_ITEMS;
  navLinks.innerHTML = items.map((item, i) => {
    const icon = NAV_ICONS[item.icon] || NAV_ICONS.none;
    const pageKey = item.key || "";
    const divider = i < items.length - 1 ? '<li class="nav-divider" aria-hidden="true"></li>' : "";
    // item.id (not item.key, which is empty for admin-added items) is the
    // one identifier guaranteed unique and stable across a label/href
    // edit or a reorder, so edit-mode's per-link move/resize overrides
    // stay attached to the right link even after either kind of change.
    return `<li><a href="${escapeHtml(item.href)}" data-page="${escapeHtml(pageKey)}" aria-label="${escapeHtml(item.label)}" data-edit-key="nav-item:${item.id}" data-edit-type="block">${icon}<span>${escapeHtml(item.label)}</span></a></li>${divider}`;
  }).join("");
}

function renderFooterContactAndCategories() {
  const s = window.SITE_SETTINGS;
  if (s) {
    if (s.contact_whatsapp) {
      document.querySelectorAll('a[href^="https://wa.me/"]').forEach((a) => { a.href = s.contact_whatsapp; });
    }
    if (s.contact_email) {
      document.querySelectorAll('a[href^="mailto:"]').forEach((a) => {
        a.href = `mailto:${s.contact_email}`;
        a.textContent = s.contact_email;
      });
    }
    if (s.contact_phone) {
      const digits = s.contact_phone.replace(/[^\d+]/g, "");
      document.querySelectorAll('a[href^="tel:"]').forEach((a) => {
        a.href = `tel:${digits}`;
        a.textContent = s.contact_phone;
      });
    }
    if (s.social_instagram) document.querySelectorAll('a[href*="instagram.com"]').forEach((a) => { a.href = s.social_instagram; });
    if (s.social_rednote) document.querySelectorAll('a[href*="xiaohongshu.com"]').forEach((a) => { a.href = s.social_rednote; });
    if (s.social_tiktok) document.querySelectorAll('a[href*="tiktok.com"]').forEach((a) => { a.href = s.social_tiktok; });
    if (s.social_youtube) document.querySelectorAll('a[href*="youtube.com"]').forEach((a) => { a.href = s.social_youtube; });
    if (s.logo_url) {
      const logoSrc = optimizedImage(s.logo_url).src;
      document.querySelectorAll(".brand-logo").forEach((img) => { if (img.getAttribute("src") !== logoSrc) img.src = logoSrc; });
    }
  }

  const list = document.getElementById("footerCategoriesList");
  if (list && window.SITE_COLLECTIONS && window.SITE_COLLECTIONS.length) {
    const rows = [`<li><a href="all-products.html">All Products</a></li>`]
      .concat(window.SITE_COLLECTIONS.map((c) => `<li><a href="${escapeHtml(collectionHref(c))}">${escapeHtml(c.title)}</a></li>`));
    list.innerHTML = rows.join("");
  }
}

function renderHero() {
  const hero = document.querySelector(".hero-photo-inner");
  if (!hero || !window.SITE_SETTINGS) return;
  const s = window.SITE_SETTINGS;
  const h1 = hero.querySelector("h1");
  const sub = hero.querySelector(".hero-sub");
  const cta = hero.querySelector(".hero-actions .btn-primary");
  const img = document.querySelector(".hero-photo-img");
  if (h1 && s.hero_heading) h1.textContent = s.hero_heading;
  if (sub && s.hero_subtext) sub.textContent = s.hero_subtext;
  if (cta && s.hero_cta_text) cta.textContent = s.hero_cta_text;
  if (img && s.hero_image_url) {
    const heroSrc = optimizedImage(s.hero_image_url).src;
    if (img.getAttribute("src") !== heroSrc) img.src = heroSrc;
  }
}

function renderAboutContent() {
  const highlights = document.querySelectorAll(".about-highlight");
  if (!highlights.length || !window.SITE_SETTINGS) return;
  const s = window.SITE_SETTINGS;

  const paras = document.querySelectorAll(".section > .container > p");
  if (paras[0] && s.about_intro_1) paras[0].textContent = s.about_intro_1;
  if (paras[1] && s.about_intro_2) paras[1].textContent = s.about_intro_2;

  highlights.forEach((card, i) => {
    const n = i + 1;
    const heading = card.querySelector("h3");
    const body = card.querySelector("p");
    if (heading && s[`about_highlight_${n}_heading`]) heading.textContent = s[`about_highlight_${n}_heading`];
    if (body && s[`about_highlight_${n}_body`]) body.textContent = s[`about_highlight_${n}_body`];
  });
}

/* Legacy (static-file) categories keep their existing clean URL; anything
   else (added via admin) routes through the shared category.html template
   since there's no build step to generate it a real file. */
function collectionHref(c) {
  return c.is_legacy ? `${c.slug}.html` : `category.html?slug=${encodeURIComponent(c.slug)}`;
}

function renderShopGrid() {
  const grid = document.querySelector(".shop-grid");
  if (!grid || !window.SITE_COLLECTIONS || !window.SITE_COLLECTIONS.length) return;
  // Keyed by slug (the table's natural unique key, already used elsewhere
  // in this codebase) so a saved per-card override stays attached to the
  // right collection — same reasoning as renderFaqItems()'s id-keying.
  grid.innerHTML = window.SITE_COLLECTIONS.map((c) => {
    const pic = optimizedImage(c.card_image_url || NO_PHOTO_IMAGE);
    const srcset = pic.srcset ? ` srcset="${escapeHtml(pic.srcset)}" sizes="${SHOP_CARD_SIZES}"` : "";
    return `
    <article class="shop-card">
      <a class="shop-card-media" href="${escapeHtml(collectionHref(c))}" data-edit-key="shop-card-img:${escapeHtml(c.slug)}" data-edit-type="block">
        <img src="${escapeHtml(pic.src)}"${srcset} width="600" height="600" alt="${escapeHtml(c.title)} collection" loading="lazy" decoding="async"/>
      </a>
      <h3><a href="${escapeHtml(collectionHref(c))}" data-edit-key="shop-card-title:${escapeHtml(c.slug)}" data-edit-type="text">${escapeHtml(c.title)}</a></h3>
    </article>
  `;
  }).join("");
}

/* Runs on all-products.html, the 4 legacy category pages, and the new
   category.html template — rebuilds the filter dropdown from live
   collections data and selects the right one for this page, then sets the
   page title/tagline. Must run before initCatalogControls() reads the
   select's value. */
function renderCategoryFilterAndTitle() {
  const filterSelect = document.getElementById("productFilter");
  const collections = window.SITE_COLLECTIONS;
  if (!filterSelect || !collections || !collections.length) return;

  let targetSlug = document.body.dataset.collection;
  if (targetSlug === "category-template") {
    targetSlug = new URLSearchParams(location.search).get("slug") || "all";
  }

  filterSelect.innerHTML = `<option value="all">All Products</option>` +
    collections.map((c) => `<option value="${escapeHtml(c.slug)}">${escapeHtml(c.title)}</option>`).join("");
  if ([...filterSelect.options].some((o) => o.value === targetSlug)) {
    filterSelect.value = targetSlug;
  }

  const titleEl = document.querySelector(".collection-title-badge h1");
  const match = collections.find((c) => c.slug === targetSlug);
  if (titleEl && match) {
    titleEl.textContent = match.title;
    let tagline = document.querySelector(".collection-tagline");
    if (match.tagline) {
      if (!tagline) {
        tagline = document.createElement("p");
        tagline.className = "collection-tagline";
        titleEl.closest(".collection-hero").querySelector(".container").appendChild(tagline);
      }
      tagline.textContent = match.tagline;
    }
  }
}

function renderFaqItems() {
  const list = document.querySelector(".faq-list");
  if (!list || !window.SITE_FAQ_ITEMS || !window.SITE_FAQ_ITEMS.length) return;
  // Keyed by the FAQ row's own id (not array index) so a saved per-item
  // layout_overrides row (color/retext) stays attached to the right
  // question even if items get reordered later — same convention as
  // renderNav()'s nav-item:${item.id} keys.
  list.innerHTML = window.SITE_FAQ_ITEMS.map((item) => {
    const paragraphs = String(item.answer || "").split(/\n\n+/).map((p) => `<p>${escapeHtml(p)}</p>`).join("");
    return `<details class="faq-item" ${item.is_open_default ? "open" : ""}>
      <summary data-edit-key="faq-q:${item.id}" data-edit-type="text">${escapeHtml(item.question)}</summary>
      <div class="faq-answer" data-edit-key="faq-a:${item.id}" data-edit-type="text">${paragraphs}</div>
    </details>`;
  }).join("");
}

/* --coral-hover and --color-accent-tint aren't color-mix()-derived in
   css/styles.css today, so overriding just --coral would leave hover
   states and tinted backgrounds mismatched. Compute both here instead. */
function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
}
function darken(hex, amount) {
  const c = hexToRgb(hex);
  if (!c) return hex;
  const f = (v) => Math.max(0, Math.round(v * (1 - amount)));
  return `rgb(${f(c.r)}, ${f(c.g)}, ${f(c.b)})`;
}
function toRgba(hex, alpha) {
  const c = hexToRgb(hex);
  if (!c) return null;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;
}

function applyThemeColors() {
  const s = window.SITE_SETTINGS;
  if (!s) return;
  const vars = [];
  if (s.theme_coral) {
    vars.push(`--coral: ${s.theme_coral};`);
    vars.push(`--color-accent: ${s.theme_coral};`);
    vars.push(`--coral-hover: ${darken(s.theme_coral, 0.08)};`);
    vars.push(`--color-accent-hover: ${darken(s.theme_coral, 0.08)};`);
    const tint = toRgba(s.theme_coral, 0.1);
    if (tint) vars.push(`--color-accent-tint: ${tint};`);
  }
  if (s.theme_blush) { vars.push(`--blush: ${s.theme_blush};`); vars.push(`--color-accent-soft: ${s.theme_blush};`); }
  if (s.theme_baby_blue) vars.push(`--baby-blue: ${s.theme_baby_blue};`);
  if (s.theme_soft_yellow) vars.push(`--soft-yellow: ${s.theme_soft_yellow};`);
  if (s.theme_brown) {
    vars.push(`--brown: ${s.theme_brown};`);
    vars.push(`--color-fg: ${s.theme_brown};`);
  }
  if (!vars.length) return;

  let styleTag = document.getElementById("dynamicTheme");
  if (!styleTag) {
    styleTag = document.createElement("style");
    styleTag.id = "dynamicTheme";
    document.head.appendChild(styleTag);
  }
  styleTag.textContent = `:root { ${vars.join(" ")} }`;
}
