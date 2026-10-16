/* Admin Products tab: "Import CSV" and "Export products CSV".

   Import: pick a .csv -> columns are matched to product fields by their
   header names (catalog-starter.csv's headers and the export's headers
   both match automatically; anything else can be picked by hand) -> a
   preview checks every row (missing name, bad price, unknown category ->
   create it or map it to an existing one) -> "Add new only" or "Update
   matching" (same SKU, otherwise same name in the same category) ->
   imported in batches with a progress bar -> summary.

   Export writes the same columns, so export -> edit in a spreadsheet ->
   import round-trips. Image URLs are taken as they are (http(s) links or
   the site's own images/... paths).

   The CSV reader here is separate from parseCSV() in js/catalog.js (which
   the public Google Sheet path uses) on purpose: this one also handles a
   byte-order mark, semicolon/tab-separated files from European Excel, and
   reports the header row separately. */

/* ===== CSV reading / writing (pure) ===== */

/* Returns { headers: string[], rows: string[][] }. Handles quoted fields,
   "" escapes, commas and newlines inside quotes, CRLF/LF/CR line ends, a
   UTF-8 BOM, and ; or tab delimiters (picked from the header line).
   Blank lines are skipped; short rows are padded to the header width. */
function parseProductCsv(text) {
  let src = String(text == null ? "" : text);
  if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);
  const delimiter = detectCsvDelimiter(src);
  const records = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && !fieldStarted) { inQuotes = true; fieldStarted = true; continue; }
    if (c === delimiter) { row.push(field); field = ""; fieldStarted = false; continue; }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim() !== "")) records.push(row);
      row = []; field = ""; fieldStarted = false;
      continue;
    }
    field += c;
    if (c !== " " && c !== "\t") fieldStarted = true;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) records.push(row);

  if (!records.length) return { headers: [], rows: [] };
  const headers = records[0].map((h) => h.trim());
  const rows = records.slice(1).map((r) => {
    const out = r.slice(0, Math.max(headers.length, r.length));
    while (out.length < headers.length) out.push("");
    return out;
  });
  return { headers, rows };
}

/* The delimiter used most in the first line (outside quotes); comma wins ties. */
function detectCsvDelimiter(src) {
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (c === "\n" || c === "\r")) break;
    else if (!inQuotes && c in counts) counts[c]++;
  }
  if (counts[";"] > counts[","] && counts[";"] >= counts["\t"]) return ";";
  if (counts["\t"] > counts[","] && counts["\t"] > counts[";"]) return "\t";
  return ",";
}

/* Spreadsheet apps run a cell starting with = + - @ as a formula. Text
   cells get a leading apostrophe on export (shown as plain text there)
   and the import strips it again. */
const CSV_FORMULA_START = /^[=+\-@\t\r]/;

function csvTextCell(value) {
  const s = value == null ? "" : String(value);
  return CSV_FORMULA_START.test(s) ? "'" + s : s;
}

function csvUnguard(value) {
  const s = String(value == null ? "" : value);
  return s.length > 1 && s[0] === "'" && CSV_FORMULA_START.test(s[1]) ? s.slice(1) : s;
}

function csvEscapeCell(value) {
  const s = value == null ? "" : String(value);
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(rows) {
  return rows.map((r) => r.map(csvEscapeCell).join(",")).join("\r\n") + "\r\n";
}

/* ===== Columns ===== */

/* Product fields, in export order. `header` is what the export writes
   (the first seven are catalog-starter.csv's own headers); `aliases` are
   other header spellings recognised on import. */
const PRODUCT_CSV_FIELDS = [
  { key: "collection", header: "Collection", aliases: ["category", "collection slug", "category slug"], required: true },
  { key: "name", header: "Item Name", aliases: ["name", "product", "product name", "item", "title"], required: true },
  { key: "price", header: "Price", aliases: ["regular price", "price $", "cost"], required: true },
  { key: "description", header: "Description", aliases: ["details", "desc"] },
  { key: "style", header: "Style", aliases: ["look"] },
  { key: "image_url", header: "Image URL", aliases: ["image", "photo", "photo url", "image link", "picture", "thumbnail"] },
  { key: "more_images", header: "More Images", aliases: ["images", "extra images", "additional images", "gallery", "other images"] },
  { key: "active", header: "Show?", aliases: ["show", "active", "visible", "published", "show on site"] },
  { key: "sku", header: "SKU", aliases: ["code", "product code", "item code", "sku code"] },
  { key: "sale_price", header: "Sale Price", aliases: ["sale", "discount price"] },
  { key: "stock", header: "Stock", aliases: ["qty", "quantity", "inventory", "in stock"] },
  { key: "tags", header: "Tags", aliases: ["tag", "keywords", "labels"] },
  { key: "featured", header: "Featured", aliases: ["feature", "highlight"] },
  { key: "sort_order", header: "Sort Order", aliases: ["order", "position", "sort"] },
  { key: "variants", header: "Variants", aliases: ["sizes", "options", "size options", "variant"] },
  { key: "addons", header: "Add-ons", aliases: ["addons", "add ons", "extras", "add-on"] },
  { key: "available_from", header: "Available From", aliases: ["start", "from", "start date", "available"] },
  { key: "available_until", header: "Available Until", aliases: ["end", "until", "end date", "expires"] },
  { key: "seo_title", header: "SEO Title", aliases: ["meta title", "search title"] },
  { key: "seo_description", header: "SEO Description", aliases: ["meta description", "search description"] }
];

/* Fields stored in columns from supabase-migrations/40-products.sql. */
const PRODUCT_CSV_EXTRA_KEYS = ["sku", "sale_price", "stock", "tags", "featured", "sort_order", "variants", "addons", "available_from", "available_until", "seo_title", "seo_description"];

function normalizeCsvHeader(h) {
  return String(h || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/* { fieldKey: columnIndex | -1 } — exact header/alias matches only; each
   column is used at most once. */
function autoMapProductColumns(headers) {
  const normalized = headers.map(normalizeCsvHeader);
  const used = new Set();
  const mapping = {};
  PRODUCT_CSV_FIELDS.forEach((f) => {
    const names = [f.header, f.key, ...f.aliases].map(normalizeCsvHeader);
    const index = normalized.findIndex((h, i) => !used.has(i) && h && names.includes(h));
    mapping[f.key] = index;
    if (index > -1) used.add(index);
  });
  return mapping;
}

/* ===== Values ===== */

/* "2026-11-01", "2026-11-01 10:00", "2026-11-01T10:00" (local time), or
   any full ISO timestamp. Returns an ISO string, null for blank, or
   undefined when unreadable. */
function parseCsvDate(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
    return Number.isNaN(d.getTime()) || d.getDate() !== Number(m[3]) ? undefined : d.toISOString();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function formatCsvDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function splitImageCell(raw) {
  return String(raw || "").split(/\s*[|\n]\s*|\s+(?=https?:\/\/)/).map((s) => s.trim()).filter(Boolean);
}

function isAcceptableImageUrl(url) {
  return /^https?:\/\/\S+$/i.test(url) || /^images\/[^\s"'<>]+$/i.test(url);
}

/* Matches a CSV "Collection" cell to a category slug: by slug, title,
   the Google Sheet aliases (COLLECTION_NAME_TO_SLUG in js/catalog.js), or
   slugified title. null when nothing matches. */
function resolveImportCollection(value, collections) {
  const v = String(value || "").trim();
  if (!v) return null;
  const lower = v.toLowerCase();
  const bySlug = collections.find((c) => c.slug === lower);
  if (bySlug) return bySlug.slug;
  const byTitle = collections.find((c) => String(c.title || "").trim().toLowerCase() === lower);
  if (byTitle) return byTitle.slug;
  const alias = typeof COLLECTION_NAME_TO_SLUG !== "undefined" ? COLLECTION_NAME_TO_SLUG[lower] : null;
  if (alias && collections.some((c) => c.slug === alias)) return alias;
  const slugged = slugify(v);
  const bySlugified = collections.find((c) => c.slug === slugged || slugify(c.title || "") === slugged);
  return bySlugified ? bySlugified.slug : null;
}

function importMatchKey(name, slug) {
  return `${String(name || "").trim().toLowerCase()}\u0000${slug || ""}`;
}

/* Turns the parsed table into checked rows. ctx:
     collections            [{slug, title}]
     collectionChoices      { lowercased CSV value: slug | "__create__" | "" }
     existing               current (non-trashed) product rows
     mode                   "add" | "update"
   Each result: { line, name, collectionValue, slug, action, matchId,
   values (database columns), errors[], warnings[] }. action is "add",
   "update", "skip" (exists, add-only mode) or "error". */
function buildImportRows(table, mapping, ctx) {
  const cell = (r, key) => (mapping[key] > -1 ? csvUnguard(r[mapping[key]] == null ? "" : r[mapping[key]]).trim() : undefined);
  const has = (key) => mapping[key] > -1;
  const bySku = new Map();
  const byName = new Map();
  (ctx.existing || []).forEach((p) => {
    if (p.sku) bySku.set(String(p.sku).trim().toLowerCase(), p);
    byName.set(importMatchKey(p.name, p.collection), p);
  });
  const seenInFile = new Map();

  return table.rows.map((r, i) => {
    const line = i + 2; // spreadsheet row number (header is row 1)
    const errors = [];
    const warnings = [];
    const values = {};

    const name = cell(r, "name") || "";
    if (!name) errors.push("Missing item name");
    else values.name = name.slice(0, 200);

    const collectionValue = cell(r, "collection") || "";
    let slug = null;
    if (!collectionValue) {
      errors.push("Missing collection");
    } else {
      slug = resolveImportCollection(collectionValue, ctx.collections);
      if (!slug) {
        const choice = (ctx.collectionChoices || {})[collectionValue.toLowerCase()];
        if (choice === "__create__") slug = slugify(collectionValue);
        else if (choice) slug = choice;
        else errors.push(`Unknown collection "${collectionValue}"`);
      }
    }
    if (slug) values.collection = slug;

    // Match against existing products: SKU first, then name + collection.
    const sku = has("sku") ? cell(r, "sku") : "";
    let match = null;
    if (sku) match = bySku.get(sku.toLowerCase()) || null;
    if (!match && name && slug) match = byName.get(importMatchKey(name, slug)) || null;
    const willUpdate = !!match && ctx.mode === "update";

    const priceRaw = cell(r, "price");
    if (priceRaw === undefined || priceRaw === "") {
      if (!willUpdate) errors.push("Missing price");
    } else {
      const price = toNumberOrNull(priceRaw);
      if (price === null || !/\d/.test(priceRaw)) errors.push(`Price "${priceRaw}" isn't a number`);
      else if (price < 0) errors.push("Price can't be negative");
      else values.price = roundMoney(price);
    }

    if (has("description")) values.description = cell(r, "description");
    if (has("style")) {
      const style = cell(r, "style").toLowerCase();
      if (style && !STYLE_PRESETS[style]) warnings.push(`Unknown style "${cell(r, "style")}", the collection's default is used`);
      values.style = style && STYLE_PRESETS[style] ? style : null;
    }

    if (has("image_url") || has("more_images")) {
      const urls = [...splitImageCell(cell(r, "image_url")), ...splitImageCell(cell(r, "more_images"))];
      const good = urls.filter(isAcceptableImageUrl);
      if (good.length < urls.length) warnings.push(`${urls.length - good.length} image link(s) skipped (must start with http:// or https://)`);
      // A blank photo cell never removes an existing product's photos.
      if (good.length || !willUpdate) {
        values.images = [...new Set(good)];
        values.image_url = values.images[0] || null;
      }
    }

    if (has("active")) values.active = isRowActive(cell(r, "active"));

    if (has("sku")) values.sku = sku || null;
    if (has("sale_price")) {
      const raw = cell(r, "sale_price");
      if (!raw) values.sale_price = null;
      else {
        const sale = toNumberOrNull(raw);
        const regular = values.price !== undefined ? values.price : (match ? Number(match.price) : 0);
        if (sale === null || sale < 0) errors.push(`Sale price "${raw}" isn't a number`);
        else if (sale >= regular) { warnings.push("Sale price isn't lower than the price, so it's ignored"); values.sale_price = null; }
        else values.sale_price = roundMoney(sale);
      }
    }
    if (has("stock")) {
      const raw = cell(r, "stock");
      if (!raw) values.stock = null;
      else if (!/^\d+$/.test(raw.replace(/\.0+$/, ""))) errors.push(`Stock "${raw}" must be a whole number`);
      else values.stock = parseInt(raw, 10);
    }
    if (has("tags")) values.tags = parseTagList(cell(r, "tags"));
    if (has("featured")) values.featured = isTruthyCell(cell(r, "featured"));
    if (has("sort_order")) {
      const raw = cell(r, "sort_order");
      if (raw) {
        if (!/^-?\d+$/.test(raw)) errors.push(`Sort order "${raw}" must be a whole number`);
        else values.sort_order = Math.max(0, parseInt(raw, 10));
      }
    }
    ["variants", "addons"].forEach((key) => {
      if (!has(key)) return;
      const list = normalizeProductOptions(cell(r, key));
      values[key] = key === "addons" ? list.map((a) => ({ name: a.name, price: a.price || 0 })) : list;
    });
    ["available_from", "available_until"].forEach((key) => {
      if (!has(key)) return;
      const parsed = parseCsvDate(cell(r, key));
      if (parsed === undefined) errors.push(`"${cell(r, key)}" isn't a date (use YYYY-MM-DD or YYYY-MM-DD HH:MM)`);
      else values[key] = parsed;
    });
    if (values.available_from && values.available_until && Date.parse(values.available_until) <= Date.parse(values.available_from)) {
      errors.push("Available Until must be after Available From");
    }
    if (has("seo_title")) values.seo_title = cell(r, "seo_title") || null;
    if (has("seo_description")) values.seo_description = cell(r, "seo_description") || null;

    // The same product twice in one file: only the first one counts.
    const fileKey = sku ? "sku:" + sku.toLowerCase() : "name:" + importMatchKey(name, slug);
    if (name && slug) {
      if (seenInFile.has(fileKey)) errors.push(`Same product as row ${seenInFile.get(fileKey)}`);
      else seenInFile.set(fileKey, line);
    }

    let action;
    if (errors.length) action = "error";
    else if (match && ctx.mode === "update") action = "update";
    else if (match) action = "skip";
    else action = "add";

    return { line, name, collectionValue, slug, action, matchId: match ? match.id : null, values, errors, warnings };
  });
}

/* Collection cells that didn't match any category (lowercased -> as typed). */
function unknownImportCollections(table, mapping, collections) {
  const out = new Map();
  if (!(mapping.collection > -1)) return out;
  table.rows.forEach((r) => {
    const v = csvUnguard(r[mapping.collection] || "").trim();
    if (v && !resolveImportCollection(v, collections) && !out.has(v.toLowerCase())) out.set(v.toLowerCase(), v);
  });
  return out;
}

/* ===== Export ===== */

function productCsvRow(p) {
  const images = Array.isArray(p.images) && p.images.length ? p.images : (p.image_url ? [p.image_url] : []);
  const byKey = {
    collection: collectionTitle(p.collection),
    name: csvTextCell(p.name),
    price: p.price == null ? "" : String(Number(p.price)),
    description: csvTextCell(p.description || ""),
    style: p.style ? p.style.replace(/\b\w/g, (c) => c.toUpperCase()) : "",
    image_url: images[0] || "",
    more_images: images.slice(1).join(" | "),
    active: p.active === false ? "No" : "Yes",
    sku: csvTextCell(p.sku || ""),
    sale_price: p.sale_price == null ? "" : String(Number(p.sale_price)),
    stock: p.stock == null ? "" : String(p.stock),
    tags: parseTagList(p.tags).join(", "),
    featured: p.featured ? "Yes" : "",
    sort_order: p.sort_order == null ? "" : String(p.sort_order),
    variants: csvTextCell(formatOptionListText(p.variants)),
    addons: csvTextCell(formatOptionListText(p.addons)),
    available_from: formatCsvDate(p.available_from),
    available_until: formatCsvDate(p.available_until),
    seo_title: csvTextCell(p.seo_title || ""),
    seo_description: csvTextCell(p.seo_description || "")
  };
  return PRODUCT_CSV_FIELDS.map((f) => byKey[f.key]);
}

function exportProductsCsv() {
  const order = new Map(collectionsCache.map((c, i) => [c.slug, i]));
  const rows = productsCache.slice().sort((a, b) => {
    const ca = order.has(a.collection) ? order.get(a.collection) : 1e6;
    const cb = order.has(b.collection) ? order.get(b.collection) : 1e6;
    return ca - cb || String(a.collection).localeCompare(String(b.collection)) ||
      (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) ||
      new Date(a.created_at) - new Date(b.created_at);
  });
  const csv = "﻿" + buildCsv([PRODUCT_CSV_FIELDS.map((f) => f.header), ...rows.map(productCsvRow)]);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `products-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ===== Import dialog ===== */

let csvImport = null; // { fileName, table, mapping, mode, collectionChoices, rows }

function ensureCsvImportModal() {
  let modal = document.getElementById("csvImportModal");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.className = "modal";
  modal.id = "csvImportModal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "csvImportTitle");
  modal.innerHTML = `
    <div class="modal-scrim" data-close-csv></div>
    <div class="modal-panel csv-import-panel">
      <div class="modal-head">
        <div>
          <h2 id="csvImportTitle">Import products from CSV</h2>
          <p>Columns are matched by their header names. Nothing is saved until you press Import.</p>
        </div>
        <button type="button" class="icon-btn" data-close-csv aria-label="Close">&times;</button>
      </div>
      <div class="modal-body" id="csvImportBody"></div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelectorAll("[data-close-csv]").forEach((el) => el.addEventListener("click", closeCsvImport));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("open")) closeCsvImport();
  });
  return modal;
}

function openCsvImport() {
  const modal = ensureCsvImportModal();
  csvImport = null;
  renderCsvPickStep();
  modal.classList.add("open");
}

function closeCsvImport() {
  const modal = document.getElementById("csvImportModal");
  if (!modal) return;
  if (csvImport && csvImport.running) return; // let the import finish
  modal.classList.remove("open");
}

function renderCsvPickStep(message) {
  const body = document.getElementById("csvImportBody");
  body.innerHTML = `
    <label for="csvImportFile" class="upload-dropzone csv-dropzone" id="csvDropzone">
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 16V4M12 4l-4 4M12 4l4 4" stroke-linecap="round"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" stroke-linecap="round"/></svg>
      <strong>Choose a .csv file</strong>
      <span>or drop it here. Save from Excel / Google Sheets as "CSV".</span>
    </label>
    <input id="csvImportFile" type="file" accept=".csv,text/csv" class="visually-hidden-input"/>
    ${message ? `<p class="form-status error">${escapeHtml(message)}</p>` : ""}
    <p class="field-note">Expected columns: ${PRODUCT_CSV_FIELDS.map((f) => `<code>${escapeHtml(f.header)}</code>`).join(", ")}. Only Collection, Item Name and Price are required. Tip: "Export products CSV" gives you a file in exactly this format.</p>`;
  const input = document.getElementById("csvImportFile");
  input.addEventListener("change", () => { if (input.files[0]) readCsvImportFile(input.files[0]); });
  const zone = document.getElementById("csvDropzone");
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("is-dragover"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("is-dragover"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("is-dragover");
    const file = e.dataTransfer && e.dataTransfer.files[0];
    if (file) readCsvImportFile(file);
  });
}

async function readCsvImportFile(file) {
  if (file.size > 5 * 1024 * 1024) { renderCsvPickStep("That file is over 5 MB, which is far more than a product list should be. Is it the right file?"); return; }
  let text;
  try { text = await file.text(); } catch (e) { renderCsvPickStep("Couldn't read that file."); return; }
  const table = parseProductCsv(text);
  if (!table.headers.length || !table.rows.length) { renderCsvPickStep("That file has no product rows (the first row should be the column headers)."); return; }
  csvImport = {
    fileName: file.name,
    table,
    mapping: autoMapProductColumns(table.headers),
    mode: "add",
    collectionChoices: {},
    rows: []
  };
  renderCsvMapStep();
}

function csvImportValidate() {
  csvImport.rows = buildImportRows(csvImport.table, csvImport.mapping, {
    collections: collectionsCache,
    collectionChoices: csvImport.collectionChoices,
    existing: productsCache,
    mode: csvImport.mode
  });
}

function renderCsvMapStep() {
  const body = document.getElementById("csvImportBody");
  const { table, mapping } = csvImport;
  const options = (key) => `<option value="-1">— not in this file —</option>` +
    table.headers.map((h, i) => `<option value="${i}" ${mapping[key] === i ? "selected" : ""}>${escapeHtml(h || `Column ${i + 1}`)}</option>`).join("");
  const unknown = unknownImportCollections(table, mapping, collectionsCache);
  const extrasMapped = PRODUCT_CSV_EXTRA_KEYS.some((k) => mapping[k] > -1);

  body.innerHTML = `
    <p class="csv-file-line"><strong>${escapeHtml(csvImport.fileName)}</strong> · ${table.rows.length} row${table.rows.length === 1 ? "" : "s"} <button type="button" class="link-btn" id="csvPickAnother">Choose another file</button></p>
    <details class="csv-mapping" ${PRODUCT_CSV_FIELDS.some((f) => f.required && !(mapping[f.key] > -1)) ? "open" : ""}>
      <summary>Columns <span class="pf-summary-meta">· ${PRODUCT_CSV_FIELDS.filter((f) => mapping[f.key] > -1).length} matched</span></summary>
      <div class="csv-mapping-grid">
        ${PRODUCT_CSV_FIELDS.map((f) => `
          <label for="csvMap-${f.key}">${escapeHtml(f.header)}${f.required ? ' <span class="csv-required">*</span>' : ""}</label>
          <select id="csvMap-${f.key}" data-map-key="${f.key}">${options(f.key)}</select>`).join("")}
      </div>
    </details>
    ${extrasMapped && productExtrasAvailable === false ? `<p class="form-status error">This file has SKU / sale price / stock / options / dates / tags / SEO columns; they'll be skipped until the database is updated. ${escapeHtml(PRODUCT_MIGRATION_HINT)}</p>` : ""}
    ${unknown.size ? `
      <div class="csv-unknown-collections">
        <h3>New categories in this file</h3>
        ${[...unknown.entries()].map(([lower, shown]) => `
          <div class="csv-collection-choice">
            <span>"${escapeHtml(shown)}"</span>
            <select data-collection-choice="${escapeHtml(lower)}">
              <option value="">Choose…</option>
              <option value="__create__" ${csvImport.collectionChoices[lower] === "__create__" ? "selected" : ""}>Create a new category "${escapeHtml(shown)}"</option>
              ${collectionsCache.map((c) => `<option value="${escapeHtml(c.slug)}" ${csvImport.collectionChoices[lower] === c.slug ? "selected" : ""}>Put them in ${escapeHtml(c.title)}</option>`).join("")}
            </select>
          </div>`).join("")}
      </div>` : ""}
    <fieldset class="csv-mode">
      <legend>When a product already exists</legend>
      <label><input type="radio" name="csvMode" value="add" ${csvImport.mode === "add" ? "checked" : ""}/> Add new only (skip products that already exist)</label>
      <label><input type="radio" name="csvMode" value="update" ${csvImport.mode === "update" ? "checked" : ""}/> Update matching products (same SKU, otherwise same name in the same category) and add the rest</label>
    </fieldset>
    <div id="csvPreview"></div>`;

  document.getElementById("csvPickAnother").addEventListener("click", () => { csvImport = null; renderCsvPickStep(); });
  body.querySelectorAll("[data-map-key]").forEach((sel) => sel.addEventListener("change", () => {
    const key = sel.dataset.mapKey;
    const index = Number(sel.value);
    // One column feeds one field: un-map it from any other field.
    if (index > -1) Object.keys(csvImport.mapping).forEach((k) => { if (k !== key && csvImport.mapping[k] === index) csvImport.mapping[k] = -1; });
    csvImport.mapping[key] = index;
    renderCsvMapStep();
  }));
  body.querySelectorAll("[data-collection-choice]").forEach((sel) => sel.addEventListener("change", () => {
    csvImport.collectionChoices[sel.dataset.collectionChoice] = sel.value;
    renderCsvPreview();
  }));
  body.querySelectorAll('input[name="csvMode"]').forEach((radio) => radio.addEventListener("change", () => {
    csvImport.mode = radio.value;
    renderCsvPreview();
  }));
  renderCsvPreview();
}

const CSV_PREVIEW_LIMIT = 200;

function renderCsvPreview() {
  csvImportValidate();
  const box = document.getElementById("csvPreview");
  const rows = csvImport.rows;
  const count = (action) => rows.filter((r) => r.action === action).length;
  const adds = count("add");
  const updates = count("update");
  const skips = count("skip");
  const errors = count("error");
  const missingRequired = PRODUCT_CSV_FIELDS.filter((f) => f.required && !(csvImport.mapping[f.key] > -1));
  const total = adds + updates;
  const label = { add: "New", update: "Update", skip: "Skip (exists)", error: "Problem" };

  box.innerHTML = `
    <div class="csv-counts">
      <span class="csv-count is-add">${adds} new</span>
      <span class="csv-count is-update">${updates} to update</span>
      <span class="csv-count is-skip">${skips} skipped</span>
      <span class="csv-count is-error">${errors} with problems</span>
    </div>
    ${missingRequired.length ? `<p class="form-status error">Pick a column for ${missingRequired.map((f) => f.header).join(", ")} above.</p>` : ""}
    <div class="csv-preview-scroll">
      <table class="csv-preview-table">
        <thead><tr><th>Row</th><th>Status</th><th>Item</th><th>Collection</th><th>Price</th><th>Notes</th></tr></thead>
        <tbody>
          ${rows.slice(0, CSV_PREVIEW_LIMIT).map((r) => `
            <tr class="is-${r.action}">
              <td>${r.line}</td>
              <td><span class="csv-status is-${r.action}">${label[r.action]}</span></td>
              <td>${escapeHtml(r.name || "—")}</td>
              <td>${escapeHtml(r.slug ? collectionTitle(r.slug) : r.collectionValue || "—")}</td>
              <td>${r.values.price !== undefined ? escapeHtml(formatCatalogMoney(r.values.price)) : "—"}${r.values.sale_price ? ` <span class="csv-sale">sale ${escapeHtml(formatCatalogMoney(r.values.sale_price))}</span>` : ""}</td>
              <td>${[...r.errors.map((m) => `<span class="csv-error">${escapeHtml(m)}</span>`), ...r.warnings.map((m) => `<span class="csv-warning">${escapeHtml(m)}</span>`)].join("<br>")}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>
    ${rows.length > CSV_PREVIEW_LIMIT ? `<p class="field-note">Showing the first ${CSV_PREVIEW_LIMIT} of ${rows.length} rows; every row is checked.</p>` : ""}
    ${errors ? `<p class="field-note">Rows with problems are left out. Fix them in the file and import again (with "Update matching" so nothing is added twice).</p>` : ""}
    <div class="modal-actions">
      <button type="button" class="btn btn-outline" data-close-csv-cancel>Cancel</button>
      <button type="button" class="btn btn-primary btn-block" id="csvImportGo" ${total && !missingRequired.length ? "" : "disabled"}>Import ${total} product${total === 1 ? "" : "s"}</button>
    </div>`;
  box.querySelector("[data-close-csv-cancel]").addEventListener("click", closeCsvImport);
  document.getElementById("csvImportGo").addEventListener("click", runCsvImport);
}

/* Creates any "Create a new category" choices actually used by rows that
   will be imported. Returns an error message or null. */
async function createImportCollections(client, rows) {
  const toCreate = new Map();
  rows.forEach((r) => {
    const lower = r.collectionValue.toLowerCase();
    if (csvImport.collectionChoices[lower] === "__create__" && !collectionsCache.some((c) => c.slug === r.slug)) {
      toCreate.set(r.slug, r.collectionValue.trim());
    }
  });
  let sortOrder = collectionsCache.reduce((max, c) => Math.max(max, Number(c.sort_order) || 0), 0);
  for (const [slug, title] of toCreate) {
    sortOrder += 1;
    const { error } = await client.from("collections").insert({ title, slug, tagline: "", sort_order: sortOrder, is_legacy: false });
    if (error) return `Couldn't create the category "${title}": ${error.message}`;
  }
  if (toCreate.size) await loadCollectionsCache();
  return null;
}

async function runCsvImport() {
  const rows = csvImport.rows.filter((r) => r.action === "add" || r.action === "update");
  if (!rows.length) return;
  csvImport.running = true;
  const body = document.getElementById("csvImportBody");
  body.innerHTML = `
    <p id="csvProgressText">Starting…</p>
    <progress class="csv-progress" id="csvProgress" max="${rows.length}" value="0"></progress>`;
  const progress = document.getElementById("csvProgress");
  const progressText = document.getElementById("csvProgressText");
  const client = getSupabaseClient();
  const result = { added: 0, updated: 0, failed: [], extrasDropped: false };
  let done = 0;
  const tick = () => {
    done = result.added + result.updated + result.failed.length;
    progress.value = done;
    progressText.textContent = `Imported ${done} of ${rows.length}…`;
  };

  const collectionError = await createImportCollections(client, rows);
  if (collectionError) {
    csvImport.running = false;
    body.innerHTML = `<p class="form-status error">${escapeHtml(collectionError)}</p><p>Nothing was imported.</p><div class="modal-actions"><button type="button" class="btn btn-outline" id="csvBackBtn">Back</button></div>`;
    document.getElementById("csvBackBtn").addEventListener("click", renderCsvMapStep);
    return;
  }

  const strip = (values) => {
    if (productExtrasAvailable !== false) return values;
    const copy = { ...values };
    PRODUCT_CSV_EXTRA_KEYS.forEach((k) => { if (k in copy) { delete copy[k]; result.extrasDropped = true; } });
    return copy;
  };

  // New products: in batches of 25. Each lands at the end of its category.
  const adds = rows.filter((r) => r.action === "add");
  const nextSort = {};
  productsCache.forEach((p) => { nextSort[p.collection] = Math.max(nextSort[p.collection] || 0, (Number(p.sort_order) || 0) + 1); });
  const insertBody = (r) => {
    const v = { description: "", active: true, ...r.values };
    if (v.sort_order === undefined && productExtrasAvailable !== false) {
      v.sort_order = nextSort[v.collection] || 0;
      nextSort[v.collection] = v.sort_order + 1;
    }
    return strip(v);
  };
  for (let i = 0; i < adds.length; i += 25) {
    const batch = adds.slice(i, i + 25);
    let payload = batch.map(insertBody);
    let { error } = await client.from("products").insert(payload);
    if (error && isMissingProductColumnError(error)) {
      productExtrasAvailable = false;
      payload = batch.map(insertBody);
      ({ error } = await client.from("products").insert(payload));
    }
    if (error) batch.forEach((r) => result.failed.push({ line: r.line, name: r.name, message: error.message }));
    else result.added += batch.length;
    tick();
  }

  // Updates: a few at a time (each row has its own values).
  const updates = rows.filter((r) => r.action === "update");
  for (let i = 0; i < updates.length; i += 4) {
    const batch = updates.slice(i, i + 4);
    await Promise.all(batch.map(async (r) => {
      let { error } = await mustAffect(client.from("products").update(strip(r.values)).eq("id", r.matchId));
      if (error && isMissingProductColumnError(error)) {
        productExtrasAvailable = false;
        ({ error } = await mustAffect(client.from("products").update(strip(r.values)).eq("id", r.matchId)));
      }
      if (error) result.failed.push({ line: r.line, name: r.name, message: error.message });
      else result.updated += 1;
    }));
    tick();
  }

  csvImport.running = false;
  await refreshItemList();
  const skipped = csvImport.rows.length - rows.length;
  body.innerHTML = `
    <h3 class="csv-summary-title">${result.failed.length ? "Import finished with some problems" : "Import complete"}</h3>
    <ul class="csv-summary">
      <li><strong>${result.added}</strong> added</li>
      <li><strong>${result.updated}</strong> updated</li>
      <li><strong>${skipped}</strong> skipped (already there, or a problem in the file)</li>
      ${result.failed.length ? `<li><strong>${result.failed.length}</strong> couldn't be saved</li>` : ""}
    </ul>
    ${result.extrasDropped ? `<p class="form-status error">SKU / sale price / stock / options / dates / tags / SEO weren't saved. ${escapeHtml(PRODUCT_MIGRATION_HINT)}</p>` : ""}
    ${result.failed.length ? `<div class="csv-preview-scroll"><table class="csv-preview-table"><thead><tr><th>Row</th><th>Item</th><th>Problem</th></tr></thead><tbody>${result.failed.map((f) => `<tr class="is-error"><td>${f.line}</td><td>${escapeHtml(f.name)}</td><td>${escapeHtml(f.message)}</td></tr>`).join("")}</tbody></table></div>` : ""}
    <div class="modal-actions"><button type="button" class="btn btn-primary btn-block" id="csvDoneBtn">Done</button></div>`;
  document.getElementById("csvDoneBtn").addEventListener("click", closeCsvImport);
}

/* ===== Wiring ===== */

onAdminInit(() => {
  const controls = document.querySelector("#productsPanel .admin-catalog-controls");
  if (!controls || document.getElementById("productCsvTools")) return;
  const toolsHtml = `
      <button type="button" class="btn btn-outline btn-sm" id="importProductsCsvBtn">Import CSV</button>
      <button type="button" class="btn btn-outline btn-sm" id="exportProductsCsvBtn">Export CSV</button>`;
  const slot = document.getElementById("productCsvSlot");
  if (slot) { slot.id = "productCsvTools"; slot.insertAdjacentHTML("beforeend", toolsHtml); }
  else controls.insertAdjacentHTML("afterend", `<div class="product-tools" id="productCsvTools">${toolsHtml}</div>`);
  document.getElementById("importProductsCsvBtn").addEventListener("click", openCsvImport);
  document.getElementById("exportProductsCsvBtn").addEventListener("click", exportProductsCsv);
});
