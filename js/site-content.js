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

    window.SITE_SETTINGS = settingsMap;
    window.SITE_COLLECTIONS = collectionsRes.error ? [] : (collectionsRes.data || []);
    window.SITE_NAV_ITEMS = navRes.error ? [] : (navRes.data || []);
    window.SITE_FAQ_ITEMS = faqRes.error ? [] : (faqRes.data || []);

    console.info("[Balloons by Tea] Loaded live site content from Supabase.");
    return true;
  } catch (err) {
    console.warn("[Balloons by Tea] Could not load live site content, using the built-in page content instead.", err);
    return false;
  }
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
    if (s.logo_url) document.querySelectorAll(".brand-logo").forEach((img) => { img.src = s.logo_url; });
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
  if (img && s.hero_image_url) img.src = s.hero_image_url;
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
  grid.innerHTML = window.SITE_COLLECTIONS.map((c) => `
    <article class="shop-card">
      <a class="shop-card-media" href="${escapeHtml(collectionHref(c))}">
        <img src="${escapeHtml(c.card_image_url || NO_PHOTO_IMAGE)}" alt="${escapeHtml(c.title)} collection"/>
      </a>
      <h3><a href="${escapeHtml(collectionHref(c))}">${escapeHtml(c.title)}</a></h3>
    </article>
  `).join("");
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
  list.innerHTML = window.SITE_FAQ_ITEMS.map((item) => {
    const paragraphs = String(item.answer || "").split(/\n\n+/).map((p) => `<p>${escapeHtml(p)}</p>`).join("");
    return `<details class="faq-item" ${item.is_open_default ? "open" : ""}>
      <summary>${escapeHtml(item.question)}</summary>
      <div class="faq-answer">${paragraphs}</div>
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
