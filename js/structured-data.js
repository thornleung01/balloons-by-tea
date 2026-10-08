/*
  schema.org structured data (JSON-LD) for search engines.

  Built from what the page actually shows, and rebuilt whenever that
  changes: live site content (js/site-content.js), the live catalog
  (js/supabase-catalog.js) and the FAQ list all arrive after first paint,
  so a debounced MutationObserver re-renders once they land. Each block is
  one <script type="application/ld+json" id="ld-..."> in <head>, reused on
  every re-render, so tags are never duplicated.

    index.html, about.html   Store (a LocalBusiness subtype)
    all-products.html and
    the category pages       ItemList of Products (+ BreadcrumbList on
                             category pages)
    faq.html                 FAQPage

  Deliberately NO AggregateRating/Review from the Google reviews widget:
  Google treats reviews a business shows about itself as self-serving on
  LocalBusiness/Organization markup, which risks a manual action.
*/
(function () {
  const SITE_URL = "https://thornleung01.github.io/balloons-by-tea/";
  const BUSINESS_NAME = "Balloons by Tea";
  const DELIVERY_FETCH_TIMEOUT_MS = 4000;

  function absoluteUrl(url) {
    try { return new URL(url, SITE_URL).href; } catch (e) { return null; }
  }

  /* JSON.stringify, then make "</script" (and "<!--") impossible inside
     the tag: "<" is legal JSON as a unicode escape and parses back to the same text. */
  function toJsonLd(data) {
    return JSON.stringify(data).replace(/</g, "\\u003c");
  }

  function setBlock(id, data) {
    let tag = document.getElementById(id);
    if (!data) {
      if (tag) tag.remove();
      return;
    }
    const json = toJsonLd(data);
    if (!tag) {
      tag = document.createElement("script");
      tag.type = "application/ld+json";
      tag.id = id;
      document.head.appendChild(tag);
    }
    if (tag.textContent !== json) tag.textContent = json;
  }

  function cleanText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  /* Placeholder values still sitting in settings (e.g. "+1 (000) 000-0000",
     "[Replace with ...]") must never be published as real contact data. */
  function isRealValue(value) {
    const v = cleanText(value);
    if (!v || /[\[\]]|replace|placeholder|paste|example|your /i.test(v)) return false;
    const digits = v.replace(/\D/g, "");
    return !(digits && /^1?0+$/.test(digits));
  }

  /* ----- LocalBusiness (index + about) ----- */
  let deliveryAreas = null; // array of names once loaded; stays null if unavailable

  async function loadDeliveryAreas() {
    const configured = typeof isSupabaseConfigured === "function" && isSupabaseConfigured();
    if (!configured) return;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), DELIVERY_FETCH_TIMEOUT_MS) : null;
    try {
      // Same plain public REST read as js/delivery-area.js. A 404 just
      // means the table hasn't been created yet: omit areaServed quietly.
      const res = await fetch(`${SUPABASE_CONFIG.url}/rest/v1/delivery_areas?select=fsa,label`, {
        headers: { apikey: SUPABASE_CONFIG.anonKey, Accept: "application/json" },
        signal: controller ? controller.signal : undefined
      });
      if (!res.ok) return;
      const rows = await res.json();
      const names = (Array.isArray(rows) ? rows : [])
        .map((r) => cleanText(r && (r.label || r.fsa)))
        .filter(Boolean);
      if (names.length) {
        deliveryAreas = [...new Set(names)];
        scheduleRender();
      }
    } catch (err) {
      // Offline/timeout: leave areaServed out.
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function buildBusiness() {
    const s = window.SITE_SETTINGS || {};
    const logo = absoluteUrl(s.logo_url || "images/logo.png");
    const image = absoluteUrl(s.hero_image_url || "images/hero-mascot.png");
    const sameAs = [...new Set(
      [...document.querySelectorAll('a[href*="instagram.com"]')].map((a) => a.href).filter((href) => /^https:\/\//.test(href))
    )];
    const data = {
      "@context": "https://schema.org",
      "@type": "Store",
      "@id": SITE_URL + "#business",
      name: BUSINESS_NAME,
      url: SITE_URL,
      logo,
      image
    };
    const description = document.querySelector('meta[name="description"]');
    if (description && description.content) data.description = description.content;
    if (sameAs.length) data.sameAs = sameAs;
    if (isRealValue(s.contact_phone)) data.telephone = cleanText(s.contact_phone);
    if (deliveryAreas) data.areaServed = deliveryAreas;
    return data;
  }

  /* ----- Products (shop + category pages) ----- */
  function currentCollectionSlug() {
    const slug = document.body.dataset.collection;
    if (slug === "category-template") return new URLSearchParams(location.search).get("slug") || "all";
    return slug || "all";
  }

  function itemImages(item) {
    if (Array.isArray(item.images) && item.images.length) return item.images.filter(Boolean);
    return item.image ? [item.image] : [];
  }

  function buildProduct(item) {
    const product = {
      "@type": "Product",
      name: cleanText(item.name),
      url: `${SITE_URL}all-products.html?product=${encodeURIComponent(item.id)}`,
      offers: {
        "@type": "Offer",
        price: (Number(item.price) || 0).toFixed(2),
        priceCurrency: "CAD",
        availability: "https://schema.org/InStock",
        url: `${SITE_URL}all-products.html?product=${encodeURIComponent(item.id)}`
      }
    };
    // Items without a real photo show a generic placeholder graphic on the
    // site; leave image out rather than publish that as the product photo.
    const images = itemImages(item).map(absoluteUrl).filter(Boolean);
    if (images.length) product.image = images;
    if (item.description) product.description = cleanText(item.description);
    return product;
  }

  function collectionTitle(slug) {
    const live = (window.SITE_COLLECTIONS || []).find((c) => c.slug === slug);
    if (live && live.title) return live.title;
    const bundled = window.COLLECTIONS && window.COLLECTIONS[slug];
    return (bundled && bundled.title) || cleanText((document.querySelector("h1") || {}).textContent) || slug;
  }

  function collectionUrl(slug) {
    const live = (window.SITE_COLLECTIONS || []).find((c) => c.slug === slug);
    const isLegacy = live ? live.is_legacy : document.body.dataset.collection !== "category-template";
    return SITE_URL + (isLegacy ? `${slug}.html` : `category.html?slug=${encodeURIComponent(slug)}`);
  }

  function buildItemList(slug) {
    const collections = window.COLLECTIONS || {};
    const keys = slug === "all" ? Object.keys(collections) : [slug];
    const items = keys.flatMap((key) => (collections[key] && collections[key].items) || []).filter((item) => item && item.name);
    if (!items.length) return null;
    return {
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: slug === "all" ? "All Products" : collectionTitle(slug),
      url: slug === "all" ? SITE_URL + "all-products.html" : collectionUrl(slug),
      numberOfItems: items.length,
      itemListElement: items.map((item, i) => ({ "@type": "ListItem", position: i + 1, item: buildProduct(item) }))
    };
  }

  function buildBreadcrumbs(slug) {
    if (slug === "all") return null;
    const crumbs = [
      ["Home", SITE_URL],
      ["All Products", SITE_URL + "all-products.html"],
      [collectionTitle(slug), collectionUrl(slug)]
    ];
    return {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: crumbs.map(([name, item], i) => ({ "@type": "ListItem", position: i + 1, name, item }))
    };
  }

  /* ----- FAQPage (faq.html), from the questions actually on the page ----- */
  function buildFaq() {
    const entries = [...document.querySelectorAll(".faq-list .faq-item")].map((el) => {
      const question = cleanText((el.querySelector("summary") || {}).textContent);
      const answerEl = el.querySelector(".faq-answer");
      if (!question || !answerEl) return null;
      const paras = [...answerEl.querySelectorAll("p")].map((p) => cleanText(p.textContent)).filter(Boolean);
      const answer = paras.length ? paras.join("\n\n") : cleanText(answerEl.textContent);
      if (!answer) return null;
      return { "@type": "Question", name: question, acceptedAnswer: { "@type": "Answer", text: answer } };
    }).filter(Boolean);
    if (!entries.length) return null;
    return { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: entries };
  }

  /* ----- Render ----- */
  function render() {
    const page = document.body.dataset.page;
    if (page === "home" || page === "about") {
      setBlock("ld-business", buildBusiness());
    } else if (page === "shop" || page === "categories") {
      const slug = currentCollectionSlug();
      setBlock("ld-item-list", buildItemList(slug));
      setBlock("ld-breadcrumbs", buildBreadcrumbs(slug));
    } else if (page === "faq") {
      setBlock("ld-faq", buildFaq());
    }
  }

  let renderTimer = null;
  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 150);
  }

  function start() {
    render();
    // Live content replaces DOM (product grid, FAQ list, footer links)
    // once it loads; re-render after each burst of changes. Mutations in
    // <head> (including this script's own blocks) aren't observed.
    new MutationObserver(scheduleRender).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["href"] });
    const page = document.body.dataset.page;
    if (page === "home" || page === "about") loadDeliveryAreas();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
