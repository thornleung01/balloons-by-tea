/* Admin item form extras (Products tab): the collapsible "Pricing & stock",
   "Options", "Visibility", "Tags" and "SEO" sections, plus a live "Preview
   card" that renders the product the way the public site's product grid
   does. The sections are added to #itemForm from here at init (the
   existing Price and "Show on site" fields are moved into them), so
   admin.html's form markup stays as it was.

   Hooks used by js/admin-products.js (all looked up with typeof, so the
   form still works without this file):
     loadProductExtrasIntoForm(row | null)   fill / clear the sections
     productExtrasFormState()                for the unsaved-changes check
     collectProductExtrasPayload(payload)    -> { error } | { values }
     productExtrasInUse(values)              any extra actually set?
     scheduleProductPreview()                re-render the preview card

   Pure pricing/option helpers (applyProductExtras, productPriceHtml,
   normalizeProductOptions, ...) come from js/catalog.js, the same code
   the public site uses — so the preview's price is the real thing. */

let pfVariantRows = [];  // [{ name, price }] — price kept as the raw input string
let pfAddonRows = [];
let pfPreviewTimer = null;
const pfPreviewObjectUrls = new WeakMap(); // File -> object URL, so typing doesn't leak one per keystroke

const PF_SEO_TITLE_LIMIT = 60;
const PF_SEO_DESCRIPTION_LIMIT = 160;
const PF_SITE_HOST = "thornleung01.github.io › balloons-by-tea";

/* Same SVGs as ICONS in js/app.js (not loaded on admin.html). */
const PF_ICONS = {
  cart: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 4h2l2.2 11.2a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 2-1.6L20 8H6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9" cy="20" r="1.4" fill="currentColor" stroke="none"/><circle cx="17" cy="20" r="1.4" fill="currentColor" stroke="none"/></svg>',
  images: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="15" height="13" rx="2"/><path d="M3 15l4-4 3 3 5-5 4 4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  zoom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M19 19l-4.3-4.3" stroke-linecap="round"/><path d="M10.5 8v5M8 10.5h5" stroke-linecap="round"/></svg>'
};

function pfEl(id) { return document.getElementById(id); }

/* ===== Building the sections ===== */

function pfSectionsMarkup() {
  return {
    pricing: `
      <details class="pf-section" id="pfPricing" open>
        <summary>Pricing &amp; stock</summary>
        <div class="pf-body" id="pfPricingBody">
          <div class="field">
            <label for="f-sale-price">Sale price <span class="pf-optional">(optional)</span></label>
            <input id="f-sale-price" type="number" min="0" step="0.01" placeholder="Blank = not on sale" inputmode="decimal"/>
            <p class="field-note" id="pfSaleNote" aria-live="polite"></p>
          </div>
          <div class="pf-row">
            <div class="field">
              <label for="f-sku">SKU / product code</label>
              <input id="f-sku" type="text" maxlength="64" autocomplete="off" placeholder="e.g. BDAY-014"/>
            </div>
            <div class="field">
              <label for="f-stock">Stock</label>
              <input id="f-stock" type="number" min="0" step="1" placeholder="Unlimited" inputmode="numeric"/>
            </div>
          </div>
          <p class="field-note">Blank stock = made to order (no limit). 0 shows "Sold out" and turns off Add to cart. Stock isn't reduced automatically when an order comes in, so update it here.</p>
        </div>
      </details>`,
    rest: `
      <p class="pf-migration-note" id="pfMigrationNote" hidden></p>
      <details class="pf-section" id="pfOptions">
        <summary>Options <span class="pf-summary-meta" id="pfOptionsSummary"></span></summary>
        <div class="pf-body">
          <h4 class="pf-subhead">Sizes / options</h4>
          <p class="field-note">Customers pick one (the first is pre-selected). The price is what that option costs; leave it blank to use the product's price.</p>
          <div class="pf-option-rows" id="pfVariantRows"></div>
          <button type="button" class="btn btn-outline btn-sm pf-add-row" id="pfAddVariantBtn">+ Add size / option</button>
          <h4 class="pf-subhead">Add-ons</h4>
          <p class="field-note">Optional extras customers can tick. Their price is added on top.</p>
          <div class="pf-option-rows" id="pfAddonRows"></div>
          <button type="button" class="btn btn-outline btn-sm pf-add-row" id="pfAddAddonBtn">+ Add add-on</button>
        </div>
      </details>
      <details class="pf-section" id="pfVisibility">
        <summary>Visibility <span class="pf-summary-meta" id="pfVisibilitySummary"></span></summary>
        <div class="pf-body" id="pfVisibilityBody">
          <div class="field">
            <label for="f-featured" class="pf-check">
              <input id="f-featured" type="checkbox"/>
              Featured (shown first on the site)
            </label>
          </div>
          <div class="pf-row">
            <div class="field">
              <label for="f-available-from">Available from</label>
              <input id="f-available-from" type="datetime-local"/>
            </div>
            <div class="field">
              <label for="f-available-until">Available until</label>
              <input id="f-available-until" type="datetime-local"/>
            </div>
          </div>
          <p class="field-note" id="pfScheduleNote" aria-live="polite">Leave both blank to show it all the time (while "Show on site" is on).</p>
        </div>
      </details>
      <details class="pf-section" id="pfTags">
        <summary>Tags <span class="pf-summary-meta" id="pfTagsSummary"></span></summary>
        <div class="pf-body">
          <div class="field">
            <label for="f-tags">Tags</label>
            <input id="f-tags" type="text" maxlength="400" placeholder="e.g. pastel, helium, number balloon" autocomplete="off"/>
            <p class="field-note">Separate with commas. Handy for finding products in this list (the search box looks at tags) and in CSV files.</p>
            <div class="pf-tag-suggestions" id="pfTagSuggestions"></div>
          </div>
        </div>
      </details>
      <details class="pf-section" id="pfSeo">
        <summary>SEO (Google) <span class="pf-summary-meta" id="pfSeoSummary"></span></summary>
        <div class="pf-body">
          <div class="field">
            <label for="f-seo-title">Search title</label>
            <input id="f-seo-title" type="text" maxlength="120" autocomplete="off"/>
            <p class="pf-counter" id="pfSeoTitleCounter"></p>
          </div>
          <div class="field">
            <label for="f-seo-description">Search description</label>
            <textarea id="f-seo-description" maxlength="320"></textarea>
            <p class="pf-counter" id="pfSeoDescriptionCounter"></p>
          </div>
          <p class="field-note">Used for the browser tab title and the Google result when someone opens this product's link. Leave blank to keep the page's own.</p>
          <div class="pf-snippet" aria-label="Google search result preview">
            <div class="pf-snippet-site">${escapeHtml(PF_SITE_HOST)} › all-products</div>
            <div class="pf-snippet-title" id="pfSnippetTitle"></div>
            <div class="pf-snippet-desc" id="pfSnippetDesc"></div>
          </div>
        </div>
      </details>
      <details class="pf-section" id="pfPreview" open>
        <summary>Preview card</summary>
        <div class="pf-body">
          <div class="pf-preview-stage"><div class="pf-preview-card" id="pfPreviewCard"></div></div>
          <p class="field-note" id="pfPreviewNote"></p>
          <a id="pfViewOnSite" class="btn btn-outline btn-sm pf-view-on-site" target="_blank" rel="noopener" hidden>View on site</a>
        </div>
      </details>`
  };
}

function injectProductExtrasSections() {
  const form = pfEl("itemForm");
  if (!form || pfEl("pfPricing")) return;
  const markup = pfSectionsMarkup();

  // Pricing & stock takes the Price field's place in the form.
  const priceField = pfEl("f-price").closest(".field");
  priceField.insertAdjacentHTML("beforebegin", markup.pricing);
  pfEl("pfPricingBody").prepend(priceField);

  // Everything else goes just above the save status / buttons.
  pfEl("formStatus").insertAdjacentHTML("beforebegin", markup.rest);
  // "Show on site" moves into Visibility.
  const activeField = pfEl("f-active").closest(".field");
  pfEl("pfVisibilityBody").prepend(activeField);
}

/* ===== Option row editors (sizes + add-ons) ===== */

function pfRenderOptionRows(kind) {
  const rows = kind === "variant" ? pfVariantRows : pfAddonRows;
  const box = pfEl(kind === "variant" ? "pfVariantRows" : "pfAddonRows");
  const namePlaceholder = kind === "variant" ? "e.g. Large (6 ft)" : "e.g. Helium top-up";
  const pricePlaceholder = kind === "variant" ? "Product price" : "0";
  box.innerHTML = rows.map((row, i) => `
    <div class="pf-option-row" data-index="${i}">
      <input type="text" class="pf-opt-name" maxlength="80" value="${escapeHtml(row.name)}" placeholder="${namePlaceholder}" aria-label="${kind === "variant" ? "Option" : "Add-on"} ${i + 1} name"/>
      <div class="pf-opt-price-wrap"><span aria-hidden="true">${kind === "variant" ? "$" : "+$"}</span><input type="number" class="pf-opt-price" min="0" step="0.01" inputmode="decimal" value="${escapeHtml(row.price)}" placeholder="${pricePlaceholder}" aria-label="${kind === "variant" ? "Option" : "Add-on"} ${i + 1} price"/></div>
      <button type="button" class="pf-opt-move" data-move="-1" ${i === 0 ? "disabled" : ""} aria-label="Move up" title="Move up">&uarr;</button>
      <button type="button" class="pf-opt-remove" aria-label="Remove" title="Remove">&times;</button>
    </div>`).join("");
  pfUpdateSummaries();
}

function pfWireOptionEditor(kind) {
  const box = pfEl(kind === "variant" ? "pfVariantRows" : "pfAddonRows");
  const rowsOf = () => (kind === "variant" ? pfVariantRows : pfAddonRows);
  box.addEventListener("input", (e) => {
    const rowEl = e.target.closest(".pf-option-row");
    if (!rowEl) return;
    const row = rowsOf()[Number(rowEl.dataset.index)];
    if (!row) return;
    if (e.target.classList.contains("pf-opt-name")) row.name = e.target.value;
    if (e.target.classList.contains("pf-opt-price")) row.price = e.target.value;
    pfUpdateSummaries();
    scheduleProductPreview();
  });
  box.addEventListener("click", (e) => {
    const rowEl = e.target.closest(".pf-option-row");
    if (!rowEl) return;
    const rows = rowsOf();
    const i = Number(rowEl.dataset.index);
    if (e.target.closest(".pf-opt-remove")) {
      rows.splice(i, 1);
    } else if (e.target.closest(".pf-opt-move") && i > 0) {
      [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]];
    } else {
      return;
    }
    pfRenderOptionRows(kind);
    scheduleProductPreview();
  });
  pfEl(kind === "variant" ? "pfAddVariantBtn" : "pfAddAddonBtn").addEventListener("click", () => {
    rowsOf().push({ name: "", price: "" });
    pfRenderOptionRows(kind);
    const inputs = box.querySelectorAll(".pf-opt-name");
    if (inputs.length) inputs[inputs.length - 1].focus();
  });
}

/* ===== Date helpers (datetime-local <-> timestamptz) ===== */

function pfToLocalInput(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function pfFromLocalInput(value) {
  if (!value) return null;
  const d = new Date(value); // "YYYY-MM-DDTHH:mm" is local time
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/* ===== Reading / writing the form ===== */

/* Reads the sections. `errors` lists everything that would block a save;
   `values` is the database-shaped extras (snake_case columns). */
function pfReadExtras(basePrice) {
  const errors = [];
  const v = (id) => pfEl(id).value.trim();

  const saleRaw = v("f-sale-price");
  let salePrice = null;
  if (saleRaw !== "") {
    salePrice = toNumberOrNull(saleRaw);
    if (salePrice === null || salePrice < 0) errors.push("Sale price must be a number (0 or more), or blank.");
    else if (salePrice >= basePrice) errors.push("The sale price must be lower than the regular price (or leave it blank).");
    else salePrice = roundMoney(salePrice);
  }

  const stockRaw = v("f-stock");
  let stock = null;
  if (stockRaw !== "") {
    stock = Number(stockRaw);
    if (!Number.isInteger(stock) || stock < 0) errors.push("Stock must be a whole number (0 or more), or blank for unlimited.");
  }

  const readRows = (rows, label, priceRequired) => {
    const out = [];
    const seen = new Set();
    rows.forEach((row) => {
      const name = String(row.name || "").trim();
      const priceRaw = String(row.price == null ? "" : row.price).trim();
      if (!name && !priceRaw) return; // empty row: ignore
      if (!name) { errors.push(`Give every ${label} a name (or remove the empty row).`); return; }
      if (seen.has(name.toLowerCase())) { errors.push(`Two ${label}s are both called "${name}".`); return; }
      seen.add(name.toLowerCase());
      let price = null;
      if (priceRaw !== "") {
        price = toNumberOrNull(priceRaw);
        if (price === null || price < 0) { errors.push(`The price for "${name}" must be a number (0 or more).`); return; }
        price = roundMoney(price);
      } else if (priceRequired) {
        price = 0;
      }
      out.push({ name: name.slice(0, 80), price });
    });
    return out;
  };
  const variants = readRows(pfVariantRows, "size/option", false);
  const addons = readRows(pfAddonRows, "add-on", true);

  const from = pfFromLocalInput(pfEl("f-available-from").value);
  const until = pfFromLocalInput(pfEl("f-available-until").value);
  if (from === undefined || until === undefined) errors.push("One of the availability dates isn't a valid date.");
  if (from && until && Date.parse(until) <= Date.parse(from)) errors.push('"Available until" has to be after "Available from".');

  const tags = parseTagList(v("f-tags"));
  if (tags.some((t) => t.length > 40)) errors.push("Keep each tag under 40 characters.");

  return {
    errors,
    values: {
      sku: v("f-sku") || null,
      sale_price: salePrice,
      stock,
      tags,
      featured: pfEl("f-featured").checked,
      variants,
      addons,
      available_from: from || null,
      available_until: until || null,
      seo_title: v("f-seo-title") || null,
      seo_description: v("f-seo-description") || null
    }
  };
}

function collectProductExtrasPayload(payload) {
  const { errors, values } = pfReadExtras(Number(payload.price) || 0);
  if (errors.length) return { error: errors[0] };
  return { values };
}

function productExtrasInUse(values) {
  return !!(values.sku || values.sale_price !== null && values.sale_price !== undefined ||
    values.stock !== null && values.stock !== undefined || (values.tags && values.tags.length) ||
    values.featured || (values.variants && values.variants.length) || (values.addons && values.addons.length) ||
    values.available_from || values.available_until || values.seo_title || values.seo_description);
}

/* Raw field values, for the unsaved-changes snapshot. */
function productExtrasFormState() {
  if (!pfEl("pfPricing")) return null;
  const v = (id) => pfEl(id).value;
  return {
    sale: v("f-sale-price"), sku: v("f-sku"), stock: v("f-stock"),
    featured: pfEl("f-featured").checked, from: v("f-available-from"), until: v("f-available-until"),
    tags: v("f-tags"), seoTitle: v("f-seo-title"), seoDescription: v("f-seo-description"),
    variants: pfVariantRows.map((r) => [r.name, r.price]), addons: pfAddonRows.map((r) => [r.name, r.price])
  };
}

function loadProductExtrasIntoForm(row) {
  if (!pfEl("pfPricing")) return;
  const r = row || {};
  const set = (id, value) => { pfEl(id).value = value == null ? "" : value; };
  set("f-sale-price", r.sale_price);
  set("f-sku", r.sku);
  set("f-stock", r.stock);
  pfEl("f-featured").checked = r.featured === true;
  set("f-available-from", pfToLocalInput(r.available_from));
  set("f-available-until", pfToLocalInput(r.available_until));
  set("f-tags", parseTagList(r.tags).join(", "));
  set("f-seo-title", r.seo_title);
  set("f-seo-description", r.seo_description);
  pfVariantRows = normalizeProductOptions(r.variants).map((o) => ({ name: o.name, price: o.price === null ? "" : String(o.price) }));
  pfAddonRows = normalizeProductOptions(r.addons).map((o) => ({ name: o.name, price: o.price === null ? "" : String(o.price) }));
  pfRenderOptionRows("variant");
  pfRenderOptionRows("addon");
  // Open the sections that have something in them, so nothing set is hidden.
  pfEl("pfOptions").open = pfVariantRows.length + pfAddonRows.length > 0;
  pfEl("pfVisibility").open = !!(r.featured || r.available_from || r.available_until || r.active === false);
  pfEl("pfTags").open = parseTagList(r.tags).length > 0;
  pfEl("pfSeo").open = !!(r.seo_title || r.seo_description);
  pfUpdateAll();
}

/* ===== Live notes, counters, previews ===== */

function pfUpdateSaleNote() {
  const note = pfEl("pfSaleNote");
  const price = toNumberOrNull(pfEl("f-price").value) || 0;
  const sale = toNumberOrNull(pfEl("f-sale-price").value);
  note.classList.remove("is-error");
  if (pfEl("f-sale-price").value.trim() === "" || sale === null) {
    note.textContent = "";
  } else if (sale >= price) {
    note.textContent = "Must be lower than the regular price to show as a sale.";
    note.classList.add("is-error");
  } else {
    const pct = price > 0 ? Math.round((1 - sale / price) * 100) : 0;
    note.textContent = `${pct}% off (saves ${formatCatalogMoney(price - sale)}). Shown as ${formatCatalogMoney(price)} crossed out, then ${formatCatalogMoney(sale)}.`;
  }
}

function pfUpdateScheduleNote() {
  const note = pfEl("pfScheduleNote");
  const from = pfFromLocalInput(pfEl("f-available-from").value);
  const until = pfFromLocalInput(pfEl("f-available-until").value);
  note.classList.remove("is-error");
  if (from && until && Date.parse(until) <= Date.parse(from)) {
    note.textContent = '"Available until" has to be after "Available from".';
    note.classList.add("is-error");
    return;
  }
  const state = productAvailabilityState(from, until);
  if (state === "scheduled") note.textContent = `Scheduled: appears on the site ${formatAdminDateTime(from)}${until ? `, until ${formatAdminDateTime(until)}` : ""}.`;
  else if (state === "expired") note.textContent = `Expired: stopped showing ${formatAdminDateTime(until)}.`;
  else if (until) note.textContent = `Live now, until ${formatAdminDateTime(until)}.`;
  else note.textContent = "Leave both blank to show it all the time (while \"Show on site\" is on).";
}

function pfCounter(el, length, limit) {
  el.textContent = `${length} / ${limit} characters${length > limit ? " — Google will cut it short" : ""}`;
  el.classList.toggle("is-over", length > limit);
}

function pfUpdateSeo() {
  const title = pfEl("f-seo-title").value.trim();
  const desc = pfEl("f-seo-description").value.trim();
  const name = pfEl("f-name").value.trim();
  pfCounter(pfEl("pfSeoTitleCounter"), title.length, PF_SEO_TITLE_LIMIT);
  pfCounter(pfEl("pfSeoDescriptionCounter"), desc.length, PF_SEO_DESCRIPTION_LIMIT);
  pfEl("f-seo-title").placeholder = name ? `e.g. ${name} | Balloons by Tea` : "e.g. Golden Hour Bouquet | Balloons by Tea";
  pfEl("f-seo-description").placeholder = "One or two sentences that make someone want to click.";
  const cut = (text, limit) => (text.length > limit ? text.slice(0, limit - 1).trimEnd() + "…" : text);
  const shownTitle = title || "All Products | Balloons by Tea";
  const shownDesc = desc || pfEl("f-description").value.trim() || "Browse, search and sort every balloon bouquet and installation from Balloons by Tea";
  pfEl("pfSnippetTitle").textContent = cut(shownTitle, PF_SEO_TITLE_LIMIT);
  pfEl("pfSnippetDesc").textContent = cut(shownDesc.replace(/\s+/g, " "), PF_SEO_DESCRIPTION_LIMIT);
  pfEl("pfSnippetTitle").classList.toggle("is-fallback", !title);
  pfEl("pfSnippetDesc").classList.toggle("is-fallback", !desc);
}

function pfUpdateSummaries() {
  if (!pfEl("pfPricing")) return;
  const named = (rows) => rows.filter((r) => String(r.name || "").trim()).length;
  const nv = named(pfVariantRows);
  const na = named(pfAddonRows);
  const parts = [];
  if (nv) parts.push(`${nv} size${nv === 1 ? "" : "s"}`);
  if (na) parts.push(`${na} add-on${na === 1 ? "" : "s"}`);
  pfEl("pfOptionsSummary").textContent = parts.length ? `· ${parts.join(", ")}` : "";

  const from = pfFromLocalInput(pfEl("f-available-from").value);
  const until = pfFromLocalInput(pfEl("f-available-until").value);
  const state = productAvailabilityState(from, until);
  const vis = [];
  if (!pfEl("f-active").checked) vis.push(["hidden", "Hidden"]);
  if (state === "scheduled") vis.push(["scheduled", "Scheduled"]);
  if (state === "expired") vis.push(["expired", "Expired"]);
  if (pfEl("f-featured").checked) vis.push(["featured", "Featured"]);
  pfEl("pfVisibilitySummary").innerHTML = vis.map(([k, label]) => `<span class="product-status-badge is-${k}">${label}</span>`).join("");

  const tags = parseTagList(pfEl("f-tags").value);
  pfEl("pfTagsSummary").textContent = tags.length ? `· ${tags.length}` : "";
  pfEl("pfSeoSummary").textContent = pfEl("f-seo-title").value.trim() || pfEl("f-seo-description").value.trim() ? "· set" : "";
}

/* Clickable chips for tags already used on other products. */
function pfRenderTagSuggestions() {
  const box = pfEl("pfTagSuggestions");
  if (!box) return;
  const current = new Set(parseTagList(pfEl("f-tags").value).map((t) => t.toLowerCase()));
  const counts = new Map();
  (typeof productsCache !== "undefined" ? productsCache : []).forEach((p) => {
    parseTagList(p.tags).forEach((t) => {
      const key = t.toLowerCase();
      if (!counts.has(key)) counts.set(key, { tag: t, n: 0 });
      counts.get(key).n++;
    });
  });
  const suggestions = [...counts.values()]
    .filter((c) => !current.has(c.tag.toLowerCase()))
    .sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag))
    .slice(0, 12);
  box.innerHTML = suggestions.length
    ? `<span class="pf-tag-suggestions-label">Used before:</span>` + suggestions.map((c) => `<button type="button" class="pf-tag-chip" data-tag="${escapeHtml(c.tag)}">+ ${escapeHtml(c.tag)}</button>`).join("")
    : "";
}

function pfPhotoPreviewUrl(entry) {
  if (entry.type === "url") return entry.value;
  if (!pfPreviewObjectUrls.has(entry.value)) pfPreviewObjectUrls.set(entry.value, URL.createObjectURL(entry.value));
  return pfPreviewObjectUrls.get(entry.value);
}

/* The public item object this form would produce — built with the same
   applyProductExtras() the live site uses on Supabase rows. */
function pfPreviewItem() {
  const price = toNumberOrNull(pfEl("f-price").value) || 0;
  const { values } = pfReadExtras(price);
  const images = (typeof currentPhotoEntries !== "undefined" ? currentPhotoEntries : []).map(pfPhotoPreviewUrl);
  const item = {
    id: currentEditId ? "sb-" + currentEditId : "preview",
    name: pfEl("f-name").value.trim() || "Product name",
    price,
    description: pfEl("f-description").value.trim(),
    image: images[0] || "",
    images: images.length ? images : undefined
  };
  return applyProductExtras(item, values);
}

/* Mirrors renderItemCards() + productArtMarkup() in js/app.js (that file
   isn't loaded on admin.html), using the same css/styles.css classes and
   the shared productPriceHtml(). Keep in step with app.js. */
function pfCardMarkup(item) {
  const images = Array.isArray(item.images) && item.images.length ? item.images : (item.image ? [item.image] : []);
  const hasPhoto = images.length > 0;
  const src = hasPhoto ? images[0] : "images/no-picture.webp";
  const soldOut = isProductSoldOut(item);
  const onSale = item.regularPrice && item.regularPrice > item.price;
  const badge = soldOut
    ? `<span class="product-badge product-badge-soldout">Sold out</span>`
    : (onSale ? `<span class="product-badge product-badge-sale">Sale</span>` : "");
  return `
    <article class="product-card${soldOut ? " is-sold-out" : (onSale ? " is-on-sale" : "")}">
      ${badge}<div class="product-art ${hasPhoto ? "has-photo" : "no-photo"}">
        <img src="${escapeHtml(src)}" alt="${hasPhoto ? escapeHtml(item.name) : "No photo yet"}"/>
        <div class="product-art-zoom-hint">${PF_ICONS.zoom}</div>
        ${images.length > 1 ? `<span class="product-art-count">${PF_ICONS.images}${images.length}</span>` : ""}
      </div>
      <div class="product-body">
        <h3>${escapeHtml(item.name)}</h3>
        <div class="product-footer">
          ${productPriceHtml(item, (n) => formatCatalogMoney(n), escapeHtml)}
          <button type="button" class="add-btn${soldOut ? " is-sold-out" : ""}" tabindex="-1" aria-hidden="true"${soldOut ? " disabled" : ""}>${PF_ICONS.cart}</button>
        </div>
      </div>
    </article>`;
}

function pfRenderPreview() {
  const box = pfEl("pfPreviewCard");
  if (!box) return;
  const item = pfPreviewItem();
  box.innerHTML = pfCardMarkup(item);

  const notes = [];
  if (Array.isArray(item.variants) && item.variants.length > 1) notes.push("With several sizes, the cart button opens the product so shoppers can choose.");
  if (item.addons) notes.push(`Add-ons appear on the product page: ${item.addons.map((a) => `${a.name} (+${formatCatalogMoney(a.price)})`).join(", ")}.`);
  if (typeof item.stock === "number" && item.stock > 0 && item.stock <= 3) notes.push(`The product page says "Only ${item.stock} left".`);
  const from = pfFromLocalInput(pfEl("f-available-from").value);
  const until = pfFromLocalInput(pfEl("f-available-until").value);
  const state = productAvailabilityState(from, until);
  const offSite = !pfEl("f-active").checked || state !== "live";
  if (offSite) notes.push(!pfEl("f-active").checked ? "Hidden: shoppers won't see this card." : (state === "scheduled" ? "Scheduled: shoppers won't see this card yet." : "Expired: shoppers no longer see this card."));
  pfEl("pfPreviewNote").textContent = notes.join(" ");

  const link = pfEl("pfViewOnSite");
  if (currentEditId) {
    link.hidden = false;
    link.href = `all-products.html?product=${encodeURIComponent("sb-" + currentEditId)}`;
    link.textContent = offSite ? "View on site (not visible right now)" : "View on site";
    link.title = "Shows the last saved version";
  } else {
    link.hidden = true;
  }
}

function scheduleProductPreview() {
  clearTimeout(pfPreviewTimer);
  pfPreviewTimer = setTimeout(pfRenderPreview, 120);
}

function pfUpdateMigrationNote() {
  const note = pfEl("pfMigrationNote");
  if (!note) return;
  note.hidden = productExtrasAvailable !== false;
  note.textContent = "Options, visibility dates, featured, tags, SEO, sale price, SKU and stock won't save until the database is updated. " + PRODUCT_MIGRATION_HINT;
}

function pfUpdateAll() {
  pfUpdateSaleNote();
  pfUpdateScheduleNote();
  pfUpdateSeo();
  pfUpdateSummaries();
  pfRenderTagSuggestions();
  scheduleProductPreview();
}

onAdminInit(() => {
  injectProductExtrasSections();
  pfWireOptionEditor("variant");
  pfWireOptionEditor("addon");
  pfRenderOptionRows("variant");
  pfRenderOptionRows("addon");

  const form = pfEl("itemForm");
  form.addEventListener("input", pfUpdateAll);
  form.addEventListener("change", pfUpdateAll);
  form.addEventListener("reset", () => setTimeout(pfUpdateAll, 0));
  pfEl("pfTagSuggestions").addEventListener("click", (e) => {
    const chip = e.target.closest(".pf-tag-chip");
    if (!chip) return;
    const tags = parseTagList(pfEl("f-tags").value);
    tags.push(chip.dataset.tag);
    pfEl("f-tags").value = tags.join(", ");
    pfUpdateAll();
  });
  pfUpdateAll();
});

onProductListReloaded(() => {
  pfUpdateMigrationNote();
  pfRenderTagSuggestions();
});
