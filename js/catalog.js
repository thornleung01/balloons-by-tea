/*
  Aura Balloon Co. — live catalog (Google Sheet)

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

/* Only accept plain http(s) links — guards against someone pasting a
   javascript:/data: URI into the sheet and having it end up in an src. */
function sanitizeImageUrl(raw) {
  const trimmed = String(raw || "").trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : "";
}

function isRowActive(raw) {
  const v = String(raw || "").trim().toLowerCase();
  return !["no", "n", "false", "0", "hide", "hidden"].includes(v);
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
  if (idx.collection === -1 || idx.name === -1 || idx.price === -1) {
    console.warn("[Aura Balloon Co.] Sheet is missing a required column (Collection, Item Name, Price). Using bundled catalog instead.");
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

    result[slug].items.push({
      id: slug + "--" + slugifyId(name),
      name,
      price,
      description,
      colors,
      image
    });
  });

  if (skipped > 0) {
    console.warn(`[Aura Balloon Co.] Skipped ${skipped} row(s) with an unrecognized Collection value. Expected one of: Birthdays, Weddings, Baby Showers, Corporate & Events.`);
  }

  return result;
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
      console.info("[Aura Balloon Co.] Loaded live product catalog from Google Sheet.");
    }
  } catch (err) {
    console.warn("[Aura Balloon Co.] Could not load the live Google Sheet catalog — showing the built-in catalog instead.", err);
  }
}
