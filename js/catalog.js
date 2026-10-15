/*
  Balloons by Tea — live catalog (Google Sheet)

  Lets a non-technical person manage products (add/edit/remove items,
  change prices, hide an item) by editing a Google Sheet instead of code.

  Until CATALOG_CONFIG.sheetCsvUrl below is set, the site just uses the
  built-in catalog from js/products.js — nothing breaks if this is never
  configured. Full step-by-step setup is in README.md, "Managing products
  with a Google Sheet".
*/

const CATALOG_CONFIG = {
  sheetCsvUrl: "PASTE_YOUR_PUBLISHED_SHEET_CSV_LINK_HERE"
};

// Friendly named looks she can type into the "Style" column instead of
// picking colors. Each maps to the same colors used to tint the small
// generated balloon illustration on product cards.
const STYLE_PRESETS = {
  "golden classic": ["#D4A94A", "#F3EEE6", "#1C1917"],
  "ivory romance": ["#F3EEE6", "#D4A94A", "#FFFFFF"],
  "sage whisper": ["#9CAF88", "#F3EEE6", "#E7C5C1"],
  "charcoal noir": ["#1C1917", "#57534E", "#D4A94A"],
  "blush luxe": ["#E7C5C1", "#D4A94A", "#F3EEE6"]
};

// Used when the "Style" cell is left blank, so every collection still
// looks intentional without her having to pick a style for every row.
const STYLE_DEFAULT_BY_COLLECTION = {
  "anniversary": "ivory romance",
  "birthday": "golden classic",
  "kids": "blush luxe",
  "other-occasions": "sage whisper"
};

// Accepted spellings in the "Collection" column -> the site's internal
// page slug. Anything else is skipped (see buildCollectionsFromRows) so a
// typo can't silently create an orphaned collection with no page to show it.
// Old category names (weddings/baby showers/corporate) still map somewhere
// sensible in case a habit slips in, rather than silently dropping the row.
const COLLECTION_NAME_TO_SLUG = {
  "birthday": "birthday",
  "birthdays": "birthday",
  "anniversary": "anniversary",
  "anniversaries": "anniversary",
  "wedding": "anniversary",
  "weddings": "anniversary",
  "kids": "kids",
  "kid": "kids",
  "children": "kids",
  "child": "kids",
  "other occasions": "other-occasions",
  "other occasion": "other-occasions",
  "other": "other-occasions",
  "misc": "other-occasions",
  "miscellaneous": "other-occasions",
  "baby shower": "other-occasions",
  "baby showers": "other-occasions",
  "corporate & events": "other-occasions",
  "corporate and events": "other-occasions",
  "corporate events": "other-occasions",
  "corporate": "other-occasions"
};

function isCatalogConfigured() {
  return !!CATALOG_CONFIG.sheetCsvUrl && !CATALOG_CONFIG.sheetCsvUrl.includes("PASTE_YOUR");
}

function slugifyId(str) {
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/* Handles quoted fields, commas inside quotes, and escaped "" quotes —
   needed because Google's CSV export quotes any description with a comma. */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((f) => f.trim() !== "")) rows.push(row);
  }
  return rows;
}

function parsePrice(raw) {
  const cleaned = String(raw || "").replace(/[^0-9.]/g, "");
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

/* Accepts plain http(s) links, or a relative path into this site's own
   images/ folder (used by a handful of bundled product photos, e.g. the
   Sanrio Bouquet migrated in with its original products.js path). Guards
   against someone pasting a javascript:/data: URI into the sheet and
   having it end up in an src. */
function sanitizeImageUrl(raw) {
  const trimmed = String(raw || "").trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Bundled PNGs have WebP versions (see optimizedImage() in js/site-content.js).
  if (/^images\//i.test(trimmed)) return typeof optimizedImage === "function" ? optimizedImage(trimmed).src : trimmed;
  return "";
}

function isRowActive(raw) {
  const v = String(raw || "").trim().toLowerCase();
  return !["no", "n", "false", "0", "hide", "hidden"].includes(v);
}

function isTruthyCell(raw) {
  return ["yes", "y", "true", "1", "x", "featured"].includes(String(raw || "").trim().toLowerCase());
}

function buildCollectionsFromRows(rows) {
  if (!rows.length) return null;
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const colIndex = (name) => header.indexOf(name);
  const idx = {
    collection: colIndex("collection"),
    name: colIndex("item name") > -1 ? colIndex("item name") : colIndex("name"),
    price: colIndex("price"),
    description: colIndex("description"),
    style: colIndex("style"),
    image: colIndex("image url") > -1 ? colIndex("image url") : colIndex("image"),
    active: colIndex("show?") > -1 ? colIndex("show?") : colIndex("active")
  };
  // Optional extra columns (same headers the admin "Export products CSV"
  // writes). Any that are missing are simply skipped.
  const firstCol = (...names) => names.map(colIndex).find((i) => i > -1);
  const extraIdx = {
    sale_price: firstCol("sale price"),
    stock: firstCol("stock"),
    featured: firstCol("featured"),
    sort_order: firstCol("sort order"),
    tags: firstCol("tags"),
    sku: firstCol("sku"),
    variants: firstCol("variants", "sizes", "options"),
    addons: firstCol("add-ons", "addons"),
    available_from: firstCol("available from"),
    available_until: firstCol("available until"),
    seo_title: firstCol("seo title"),
    seo_description: firstCol("seo description")
  };
  if (idx.collection === -1 || idx.name === -1 || idx.price === -1) {
    console.warn("[Balloons by Tea] Sheet is missing a required column (Collection, Item Name, Price). Using bundled catalog instead.");
    return null;
  }

  const result = {};
  // Seed every known collection (title/tagline) so a page never ends up
  // with no data, even if the sheet currently has zero rows for it.
  Object.keys(window.COLLECTIONS || {}).forEach((slug) => {
    result[slug] = {
      title: window.COLLECTIONS[slug].title,
      tagline: window.COLLECTIONS[slug].tagline,
      items: []
    };
  });

  let skipped = 0;
  rows.slice(1).forEach((r) => {
    const name = (r[idx.name] || "").trim();
    if (!name) return;

    if (idx.active > -1 && !isRowActive(r[idx.active])) return;

    const collectionRaw = (r[idx.collection] || "").trim().toLowerCase();
    const slug = COLLECTION_NAME_TO_SLUG[collectionRaw];
    if (!slug || !result[slug]) {
      skipped++;
      return;
    }

    const price = parsePrice(r[idx.price]);
    const description = idx.description > -1 ? (r[idx.description] || "").trim() : "";
    const styleKey = idx.style > -1 ? (r[idx.style] || "").trim().toLowerCase() : "";
    const colors = STYLE_PRESETS[styleKey] || STYLE_PRESETS[STYLE_DEFAULT_BY_COLLECTION[slug]];
    const image = idx.image > -1 ? sanitizeImageUrl(r[idx.image]) : "";

    const extras = {};
    Object.keys(extraIdx).forEach((key) => {
      if (extraIdx[key] !== undefined) extras[key] = (r[extraIdx[key]] || "").trim();
    });
    if (!isWithinAvailability(extras.available_from, extras.available_until)) return;
    if ("featured" in extras) extras.featured = isTruthyCell(extras.featured);

    result[slug].items.push(applyProductExtras({
      id: slug + "--" + slugifyId(name),
      name,
      price,
      description,
      colors,
      image
    }, extras));
  });
  Object.keys(result).forEach((key) => { result[key].items = sortCatalogItems(result[key].items); });

  if (skipped > 0) {
    console.warn(`[Balloons by Tea] Skipped ${skipped} row(s) with an unrecognized Collection value. Expected one of: Birthdays, Weddings, Baby Showers, Corporate & Events.`);
  }

  return result;
}

/* ==========================================================================
   Product extras — sale price, stock, options (sizes + add-ons), featured,
   manual order, scheduling, SEO. Shared by the public site (Supabase and
   Google Sheet catalogs, cart, product detail, structured data) and the
   admin page (live card preview, CSV import/export), which is why they
   live here: this file is the one script every page, admin.html included,
   loads. Pure functions only — no DOM, no network.

   Every extra is optional. A product with none of them set (or a database
   that hasn't run supabase-migrations/40-products.sql) gets exactly the
   same item object as before: applyProductExtras() only ever ADDS keys.
   ========================================================================== */

function toNumberOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.\-]/g, "");
    if (!cleaned || cleaned === "-" || cleaned === ".") return null;
    value = cleaned;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/* Cents-safe rounding (0.1 + 0.2 style float noise never reaches a total). */
function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/* "Small: 120; Large: 180; Gift card" -> [{name, price}] (price null when
   left out). Also accepts "Name=Price", "Name $180", "Name +15", "|"
   separators and newlines. A bare trailing number ("Size 5") is part of
   the name, not a price — a price needs ":", "=", "$" or "+". */
function parseOptionListText(text) {
  return String(text || "")
    .split(/[;|\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = part.match(/^(.*?)\s*(?:[:=]\s*\+?\s*\$?|\s\+?\s*\$|\s\+)\s*(-?\d+(?:\.\d+)?)\s*$/);
      if (m && m[1].trim()) return { name: m[1].trim(), price: Number(m[2]) };
      return { name: part.replace(/[:=]\s*$/, "").trim(), price: null };
    })
    .filter((o) => o.name);
}

function formatOptionListText(list) {
  return normalizeProductOptions(list)
    .map((o) => (o.price === null ? o.name : `${o.name}: ${o.price}`))
    .join("; ");
}

/* Accepts a jsonb array, a JSON string of one, or the "Name: Price; ..."
   text form. Always returns [{ name: string, price: number|null }] with
   blank names dropped — never throws on odd input. */
function normalizeProductOptions(raw) {
  let list = raw;
  if (typeof list === "string") {
    const trimmed = list.trim();
    if (!trimmed) return [];
    if (trimmed[0] === "[") {
      try { list = JSON.parse(trimmed); } catch (e) { list = parseOptionListText(trimmed); }
    } else {
      list = parseOptionListText(trimmed);
    }
  }
  if (!Array.isArray(list)) return [];
  return list
    .map((o) => {
      if (!o || typeof o !== "object") return null;
      const name = String(o.name == null ? "" : o.name).trim().slice(0, 80);
      if (!name) return null;
      const price = toNumberOrNull(o.price);
      return { name, price: price === null ? null : roundMoney(Math.max(0, price)) };
    })
    .filter(Boolean);
}

function parseTagList(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || "").split(/[,;|]+/);
  const seen = new Set();
  return list
    .map((t) => String(t == null ? "" : t).trim())
    .filter((t) => {
      const key = t.toLowerCase();
      if (!t || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/* Is a product inside its availability window right now? Either end may
   be blank. Unparseable dates are ignored rather than hiding a product. */
function isWithinAvailability(from, until, now) {
  const t = now instanceof Date ? now.getTime() : (typeof now === "number" ? now : Date.now());
  const start = from ? Date.parse(from) : NaN;
  const end = until ? Date.parse(until) : NaN;
  if (!Number.isNaN(start) && t < start) return false;
  if (!Number.isNaN(end) && t >= end) return false;
  return true;
}

/* "live" | "scheduled" (not started yet) | "expired" (ended). */
function productAvailabilityState(from, until, now) {
  const t = now instanceof Date ? now.getTime() : (typeof now === "number" ? now : Date.now());
  const start = from ? Date.parse(from) : NaN;
  const end = until ? Date.parse(until) : NaN;
  if (!Number.isNaN(end) && t >= end) return "expired";
  if (!Number.isNaN(start) && t < start) return "scheduled";
  return "live";
}

/* Copies the optional extras from a database-shaped row (snake_case
   columns, as Supabase returns them and as the admin form builds them)
   onto a public catalog item that already has its regular `price`.
   After this, item.price is what the customer pays (the sale price when
   on sale) and item.regularPrice is the struck-through original — so
   every existing reader of item.price (sorting, cart, structured data)
   is automatically right. Keys are only added when they mean something. */
function applyProductExtras(item, row) {
  if (!row) return item;
  const regular = Number(item.price) || 0;
  const sale = toNumberOrNull(row.sale_price);
  if (sale !== null && sale >= 0 && sale < regular) {
    item.regularPrice = regular;
    item.price = roundMoney(sale);
  }
  const stock = toNumberOrNull(row.stock);
  if (stock !== null) item.stock = Math.max(0, Math.floor(stock));
  if (row.featured === true) item.featured = true;
  const sortOrder = toNumberOrNull(row.sort_order);
  if (sortOrder !== null && sortOrder !== 0) item.sortOrder = sortOrder;
  const variants = normalizeProductOptions(row.variants);
  if (variants.length) item.variants = variants;
  const addons = normalizeProductOptions(row.addons);
  if (addons.length) item.addons = addons.map((a) => ({ name: a.name, price: a.price || 0 }));
  const tags = parseTagList(row.tags);
  if (tags.length) item.tags = tags;
  if (row.sku && String(row.sku).trim()) item.sku = String(row.sku).trim();
  if (row.seo_title && String(row.seo_title).trim()) item.seoTitle = String(row.seo_title).trim();
  if (row.seo_description && String(row.seo_description).trim()) item.seoDescription = String(row.seo_description).trim();
  return item;
}

function isProductSoldOut(item) {
  return !!item && item.stock === 0;
}

/* A variant's price is what that option costs; a blank one means "the
   product's own (current, sale-aware) price". */
function variantUnitPrice(item, variant) {
  if (variant && variant.price !== null && variant.price !== undefined) return Number(variant.price) || 0;
  return Number(item.price) || 0;
}

/* Lowest/highest price a customer can pay for the product itself (before
   add-ons), for "From $X" on cards and structured-data AggregateOffers. */
function productPriceRange(item) {
  const prices = Array.isArray(item.variants) && item.variants.length
    ? item.variants.map((v) => variantUnitPrice(item, v))
    : [Number(item.price) || 0];
  return { low: Math.min(...prices), high: Math.max(...prices) };
}

/* Resolves a customer's choice into what goes in the cart: the chosen
   variant (first one by default), the ticked add-ons, and the unit price
   (variant/base price + every add-on). Unknown names are ignored. */
function resolveProductOptions(item, variantName, addonNames) {
  const variants = Array.isArray(item.variants) ? item.variants : [];
  const addons = Array.isArray(item.addons) ? item.addons : [];
  let variant = null;
  if (variants.length) {
    const picked = variants.find((v) => v.name === variantName) || variants[0];
    variant = { name: picked.name, price: roundMoney(variantUnitPrice(item, picked)) };
  }
  const wanted = new Set(addonNames || []);
  const chosenAddons = addons
    .filter((a) => wanted.has(a.name))
    .map((a) => ({ name: a.name, price: roundMoney(a.price || 0) }));
  const base = variant ? variant.price : Number(item.price) || 0;
  const unitPrice = roundMoney(base + chosenAddons.reduce((sum, a) => sum + a.price, 0));
  return { variant, addons: chosenAddons, unitPrice };
}

/* "$58" for whole amounts (exactly what the site always showed), "$49.99"
   otherwise — sale prices and rounding to .99 need the cents. */
function formatCatalogMoney(n, symbol) {
  const value = roundMoney(n);
  const sym = symbol == null ? "$" : symbol;
  return `${sym}${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2)}`;
}

/* The price on a product card. Without a sale or a price range this is
   byte-for-byte the markup cards always had. `fmt` formats a number,
   `esc` escapes HTML (each page passes its own). */
function productPriceHtml(item, fmt, esc) {
  const range = productPriceRange(item);
  if (Array.isArray(item.variants) && item.variants.length && range.low !== range.high) {
    return `<span class="price">From ${esc(fmt(range.low))}</span>`;
  }
  const price = Array.isArray(item.variants) && item.variants.length ? range.low : Number(item.price) || 0;
  if (item.regularPrice && item.regularPrice > price) {
    return `<span class="price price-on-sale"><s class="price-was" aria-label="Was ${esc(fmt(item.regularPrice))}">${esc(fmt(item.regularPrice))}</s> <span class="price-now">${esc(fmt(price))}</span></span>`;
  }
  return `<span class="price">${esc(fmt(price))}</span>`;
}

/* Default ("Most popular") order within a collection: featured first,
   then the admin's manual sort_order, then the original order. Stable. */
function sortCatalogItems(items) {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) =>
      (b.item.featured === true) - (a.item.featured === true) ||
      (a.item.sortOrder || 0) - (b.item.sortOrder || 0) ||
      a.i - b.i)
    .map((x) => x.item);
}

async function loadLiveCatalog() {
  if (!isCatalogConfigured()) return;
  try {
    const res = await fetch(CATALOG_CONFIG.sheetCsvUrl, { cache: "no-store" });
    if (!res.ok) throw new Error("Sheet responded with " + res.status);
    const text = await res.text();
    const rows = parseCSV(text);
    const collections = buildCollectionsFromRows(rows);
    if (collections) {
      window.COLLECTIONS = collections;
      console.info("[Balloons by Tea] Loaded live product catalog from Google Sheet.");
    }
  } catch (err) {
    console.warn("[Balloons by Tea] Could not load the live Google Sheet catalog — showing the built-in catalog instead.", err);
  }
}
