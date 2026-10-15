/* Admin Products tab: bulk tools for the selected products (the existing
   bulk bar): change prices by +/- % or +/- $ with rounding and an
   old -> new preview, set / clear the sale price, add / remove a tag, set
   featured. One dialog, four tabs. Uses selectedProductIds, productsCache,
   refreshItemList() from js/admin-products.js. */

/* ===== Pure price math ===== */

/* Rounds to a "nice" price. mode: "none" (cents), "whole" (.00),
   "99" (nearest x.99), "5" (nearest 5). Never below 0. */
function roundPriceTo(value, mode) {
  let n = Number(value) || 0;
  if (mode === "whole") n = Math.round(n);
  else if (mode === "99") n = Math.max(0, Math.round(n) - 0.01);
  else if (mode === "5") n = Math.round(n / 5) * 5;
  return Math.max(0, roundMoney(n));
}

/* kind "percent" | "amount"; direction +1 | -1. */
function computeBulkPrice(oldPrice, kind, direction, amount, rounding) {
  const base = Number(oldPrice) || 0;
  const delta = kind === "percent" ? base * (Number(amount) || 0) / 100 : Number(amount) || 0;
  return roundPriceTo(base + direction * delta, rounding);
}

/* ===== Dialog ===== */

let bulkTab = "price";

function bulkSelectedProducts() {
  return productsCache.filter((p) => selectedProductIds.has(String(p.id)));
}

function ensureBulkModal() {
  let modal = document.getElementById("bulkToolsModal");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.className = "modal";
  modal.id = "bulkToolsModal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "bulkToolsTitle");
  modal.innerHTML = `
    <div class="modal-scrim" data-close-bulk></div>
    <div class="modal-panel csv-import-panel">
      <div class="modal-head">
        <div><h2 id="bulkToolsTitle">Bulk edit</h2><p id="bulkToolsCount"></p></div>
        <button type="button" class="icon-btn" data-close-bulk aria-label="Close">&times;</button>
      </div>
      <div class="modal-body">
        <div class="orders-filter bulk-tabs" id="bulkTabs" role="tablist">
          <button type="button" class="orders-filter-btn" data-bulk-tab="price">Change price</button>
          <button type="button" class="orders-filter-btn" data-bulk-tab="sale">Sale price</button>
          <button type="button" class="orders-filter-btn" data-bulk-tab="tags">Tags</button>
          <button type="button" class="orders-filter-btn" data-bulk-tab="featured">Featured</button>
        </div>
        <div id="bulkToolsBody"></div>
        <p class="form-status" id="bulkToolsStatus" role="status" aria-live="polite"></p>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelectorAll("[data-close-bulk]").forEach((el) => el.addEventListener("click", closeBulkTools));
  modal.querySelectorAll("[data-bulk-tab]").forEach((b) => b.addEventListener("click", () => { bulkTab = b.dataset.bulkTab; renderBulkTab(); }));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && modal.classList.contains("open")) closeBulkTools(); });
  return modal;
}

function openBulkTools(tab) {
  if (!selectedProductIds.size) return;
  bulkTab = tab || "price";
  ensureBulkModal().classList.add("open");
  renderBulkTab();
}

function closeBulkTools() {
  const m = document.getElementById("bulkToolsModal");
  if (m) m.classList.remove("open");
}

function bulkStatus(msg, kind) {
  const el = document.getElementById("bulkToolsStatus");
  el.textContent = msg || "";
  el.className = "form-status" + (kind ? " " + kind : "");
}

function renderBulkTab() {
  const items = bulkSelectedProducts();
  document.getElementById("bulkToolsCount").textContent = `${items.length} product${items.length === 1 ? "" : "s"} selected`;
  document.querySelectorAll("#bulkTabs [data-bulk-tab]").forEach((b) => {
    b.classList.toggle("active", b.dataset.bulkTab === bulkTab);
    b.setAttribute("aria-selected", String(b.dataset.bulkTab === bulkTab));
  });
  bulkStatus(bulkTab !== "price" && productExtrasAvailable === false ? "This needs the latest database update. " + PRODUCT_MIGRATION_HINT : "", bulkTab !== "price" && productExtrasAvailable === false ? "error" : "");
  const body = document.getElementById("bulkToolsBody");
  if (bulkTab === "price") renderBulkPrice(body, items);
  else if (bulkTab === "sale") renderBulkSale(body, items);
  else if (bulkTab === "tags") renderBulkTags(body, items);
  else renderBulkFeatured(body, items);
}

function bulkPreviewTable(rows) {
  return `<div class="csv-preview-scroll"><table class="csv-preview-table"><thead><tr><th>Item</th><th>Now</th><th></th><th>New</th></tr></thead><tbody>${rows.map((r) =>
    `<tr class="${r.warn ? "is-error" : ""}"><td>${escapeHtml(r.name)}</td><td>${r.before}</td><td>&rarr;</td><td>${r.after}${r.warn ? ` <span class="csv-warning">${escapeHtml(r.warn)}</span>` : ""}</td></tr>`).join("")}</tbody></table></div>`;
}

/* updatesById: { productId: { column: value } }. */
async function bulkApply(button, updatesById) {
  const entries = Object.entries(updatesById);
  if (!entries.length) { bulkStatus("Nothing to change.", "error"); return; }
  button.disabled = true;
  bulkStatus("Saving…");
  const client = getSupabaseClient();
  let failed = 0;
  let firstError = null;
  for (let i = 0; i < entries.length; i += 6) {
    const results = await Promise.all(entries.slice(i, i + 6).map(([id, patch]) => mustAffect(client.from("products").update(patch).eq("id", id))));
    results.forEach((r) => { if (r.error) { failed++; firstError = firstError || r.error; } });
  }
  button.disabled = false;
  if (failed) {
    bulkStatus(isMissingProductColumnError(firstError) ? "This needs the latest database update. " + PRODUCT_MIGRATION_HINT : `${failed} of ${entries.length} couldn't be saved: ${firstError.message}`, "error");
    await refreshItemList();
    return;
  }
  await refreshItemList();
  closeBulkTools();
}

const BULK_ROUND_OPTIONS = `<option value="none">Exact (cents)</option><option value="whole">Whole dollar (.00)</option><option value="99">Nearest .99</option><option value="5">Nearest $5</option>`;
const BULK_ACTIONS = `<div class="modal-actions"><button type="button" class="btn btn-outline" data-close-bulk-cancel>Cancel</button><button type="button" class="btn btn-primary btn-block" data-bulk-apply>Apply</button></div>`;

function renderBulkPrice(body, items) {
  body.innerHTML = `
    <div class="pf-row">
      <div class="field"><label for="bulkDir">Change</label>
        <select id="bulkDir" class="filter-select"><option value="1">Increase (+)</option><option value="-1">Decrease (−)</option></select></div>
      <div class="field"><label for="bulkKind">By</label>
        <select id="bulkKind" class="filter-select"><option value="percent">Percent (%)</option><option value="amount">Dollars ($)</option></select></div>
    </div>
    <div class="pf-row">
      <div class="field"><label for="bulkAmount">Amount</label><input id="bulkAmount" type="number" min="0" step="0.01" value="10" inputmode="decimal"/></div>
      <div class="field"><label for="bulkRound">Round to</label><select id="bulkRound" class="filter-select">${BULK_ROUND_OPTIONS}</select></div>
    </div>
    <p class="field-note">Changes the regular price. A sale price that would end up at or above the new price is cleared.</p>
    <div id="bulkPricePreview"></div>${BULK_ACTIONS}`;
  const compute = () => {
    const dir = Number(document.getElementById("bulkDir").value);
    const kind = document.getElementById("bulkKind").value;
    const amount = Number(document.getElementById("bulkAmount").value);
    const rounding = document.getElementById("bulkRound").value;
    const patches = {};
    const rows = items.map((p) => {
      const next = computeBulkPrice(p.price, kind, dir, amount, rounding);
      const sale = toNumberOrNull(p.sale_price);
      const clearSale = sale !== null && sale >= next;
      if (next !== Number(p.price)) patches[p.id] = clearSale && productExtrasAvailable !== false ? { price: next, sale_price: null } : { price: next };
      return { name: p.name, before: formatCatalogMoney(p.price), after: formatCatalogMoney(next), warn: clearSale ? "sale price cleared" : (next === 0 ? "free" : "") };
    });
    document.getElementById("bulkPricePreview").innerHTML = bulkPreviewTable(rows);
    return patches;
  };
  body.addEventListener("input", compute);
  compute();
  body.querySelector("[data-close-bulk-cancel]").addEventListener("click", closeBulkTools);
  body.querySelector("[data-bulk-apply]").addEventListener("click", (e) => bulkApply(e.target, compute()));
}

function renderBulkSale(body, items) {
  body.innerHTML = `
    <div class="field"><label class="pf-check"><input type="radio" name="bulkSaleMode" value="percent" checked/> Percent off the regular price</label>
      <label class="pf-check"><input type="radio" name="bulkSaleMode" value="amount"/> Dollars off the regular price</label>
      <label class="pf-check"><input type="radio" name="bulkSaleMode" value="clear"/> Clear the sale price (end the sale)</label></div>
    <div class="pf-row">
      <div class="field"><label for="bulkSaleAmount">Amount</label><input id="bulkSaleAmount" type="number" min="0" step="0.01" value="20" inputmode="decimal"/></div>
      <div class="field"><label for="bulkSaleRound">Round to</label><select id="bulkSaleRound" class="filter-select">${BULK_ROUND_OPTIONS}</select></div>
    </div>
    <div id="bulkSalePreview"></div>${BULK_ACTIONS}`;
  const compute = () => {
    const mode = body.querySelector('input[name="bulkSaleMode"]:checked').value;
    const amount = Number(document.getElementById("bulkSaleAmount").value);
    const rounding = document.getElementById("bulkSaleRound").value;
    document.getElementById("bulkSaleAmount").disabled = mode === "clear";
    const patches = {};
    const rows = items.map((p) => {
      const sale = toNumberOrNull(p.sale_price);
      const before = sale !== null && sale < Number(p.price) ? formatCatalogMoney(sale) : "no sale";
      if (mode === "clear") {
        if (sale !== null) patches[p.id] = { sale_price: null };
        return { name: p.name, before, after: "no sale" };
      }
      const next = computeBulkPrice(p.price, mode, -1, amount, rounding);
      if (!(next < Number(p.price)) || !(amount > 0)) return { name: p.name, before, after: "—", warn: "skipped (not lower than the price)" };
      patches[p.id] = { sale_price: next };
      return { name: p.name, before, after: formatCatalogMoney(next) };
    });
    document.getElementById("bulkSalePreview").innerHTML = bulkPreviewTable(rows);
    return patches;
  };
  body.addEventListener("input", compute);
  compute();
  body.querySelector("[data-close-bulk-cancel]").addEventListener("click", closeBulkTools);
  body.querySelector("[data-bulk-apply]").addEventListener("click", (e) => bulkApply(e.target, compute()));
}

function renderBulkTags(body, items) {
  body.innerHTML = `
    <div class="field"><label class="pf-check"><input type="radio" name="bulkTagMode" value="add" checked/> Add this tag</label>
      <label class="pf-check"><input type="radio" name="bulkTagMode" value="remove"/> Remove this tag</label></div>
    <div class="field"><label for="bulkTagName">Tag</label><input id="bulkTagName" type="text" maxlength="40" autocomplete="off" placeholder="e.g. summer"/></div>
    <div id="bulkTagPreview"></div>${BULK_ACTIONS}`;
  const compute = () => {
    const mode = body.querySelector('input[name="bulkTagMode"]:checked').value;
    const tag = document.getElementById("bulkTagName").value.trim();
    const patches = {};
    if (tag) {
      items.forEach((p) => {
        const tags = parseTagList(p.tags);
        const has = tags.some((t) => t.toLowerCase() === tag.toLowerCase());
        if (mode === "add" && !has) patches[p.id] = { tags: [...tags, tag] };
        if (mode === "remove" && has) patches[p.id] = { tags: tags.filter((t) => t.toLowerCase() !== tag.toLowerCase()) };
      });
    }
    document.getElementById("bulkTagPreview").innerHTML = tag
      ? `<p class="field-note">${Object.keys(patches).length} of ${items.length} product${items.length === 1 ? "" : "s"} will change.</p>` : "";
    return patches;
  };
  body.addEventListener("input", compute);
  body.querySelector("[data-close-bulk-cancel]").addEventListener("click", closeBulkTools);
  body.querySelector("[data-bulk-apply]").addEventListener("click", (e) => bulkApply(e.target, compute()));
}

function renderBulkFeatured(body, items) {
  body.innerHTML = `
    <p>Featured products are listed first on the site.</p>
    <div class="modal-actions"><button type="button" class="btn btn-outline" id="bulkUnfeature">Remove featured</button><button type="button" class="btn btn-primary btn-block" id="bulkFeature">Make featured</button></div>`;
  const run = (e, featured) => {
    const patches = {};
    items.forEach((p) => { if ((p.featured === true) !== featured) patches[p.id] = { featured }; });
    bulkApply(e.target, patches);
  };
  document.getElementById("bulkFeature").addEventListener("click", (e) => run(e, true));
  document.getElementById("bulkUnfeature").addEventListener("click", (e) => run(e, false));
}

onAdminInit(() => {
  const bar = document.getElementById("bulkActionBar");
  const del = document.getElementById("bulkDeleteBtn");
  if (!bar || !del) return;
  [["price", "Price…"], ["sale", "Sale…"], ["tags", "Tags…"], ["featured", "Featured…"]].forEach(([tab, label]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", () => openBulkTools(tab));
    bar.insertBefore(b, del);
  });
});
