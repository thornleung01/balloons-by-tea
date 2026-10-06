/*
  Runtime application of saved layout overrides (section spacing, text
  size, product-card scale, hidden/locked flags) — the "read" half of the
  live visual edit mode. js/edit-mode.js is the "write" half (the admin-
  only UI that creates these rows). Mirrors js/site-content.js's pattern
  exactly: fetch once, apply to [data-edit-key] elements, no-op entirely
  if Supabase isn't configured or nothing's been saved yet, so a page
  with zero override rows renders identically to how it always has.
*/

let LAYOUT_OVERRIDES = {};

/* document.body.dataset.page alone isn't fine-grained enough: the 4 legacy
   category pages and category.html all share data-page="categories", and
   all-products.html/category.html share the generic shop template, so
   keying overrides off data-page would make editing one category's hero
   bleed into every other category. data-collection (already on every
   category-style page for catalog filtering) is unique per real category;
   category.html's "category-template" value needs the ?slug= query param
   appended on top of that to separate one admin-added category from
   another. Every other page has no data-collection and falls back to
   data-page unchanged (e.g. index.html stays "home"). */
function currentLayoutPage() {
  const collection = document.body.dataset.collection;
  if (collection === "category-template") {
    const slug = new URLSearchParams(location.search).get("slug") || "all";
    return "category:" + slug;
  }
  if (collection) return collection;
  return document.body.dataset.page || "";
}

async function loadLayoutOverrides() {
  const client = typeof getSupabaseClient === "function" ? getSupabaseClient() : null;
  if (!client) return false;

  const page = currentLayoutPage();
  try {
    const { data, error } = await client.from("layout_overrides").select("*").eq("page", page);
    if (error) throw error;

    const map = {};
    (data || []).forEach((row) => {
      if (!map[row.element_key]) map[row.element_key] = {};
      map[row.element_key][row.property] = row.value;
    });
    LAYOUT_OVERRIDES = map;
    return true;
  } catch (err) {
    console.warn("[Balloons by Tea] Could not load layout overrides.", err);
    return false;
  }
}

function applyLayoutOverrides() {
  document.querySelectorAll("[data-edit-key]").forEach((el) => {
    const key = el.dataset.editKey;
    if (!key) return;
    const overrides = LAYOUT_OVERRIDES[key];
    if (!overrides) return;

    if (overrides.hidden === "true") {
      el.style.display = "none";
      return;
    }
    if (overrides["padding-bottom"]) el.style.paddingBottom = overrides["padding-bottom"];
    if (overrides["font-size"]) el.style.fontSize = overrides["font-size"];
    if (overrides.scale) el.style.transform = `scale(${overrides.scale})`;
    if (overrides.order) el.style.order = overrides.order;
  });
}

/* Single upsert used by edit-mode.js for every kind of override (resize,
   hide, lock) — one row per (page, element, property), same shape as
   every other admin write in this project. Every call also logs a
   before/after row to layout_overrides_history, which is what the edit-
   mode History panel reads and reverts from. */
async function logLayoutHistory(elementKey, property, oldValue, newValue) {
  const client = getSupabaseClient();
  const page = currentLayoutPage();
  // History is a nice-to-have audit trail, not a reason to block or fail
  // the actual save, so a logging error is swallowed rather than thrown.
  try {
    await client.from("layout_overrides_history").insert({
      page, element_key: elementKey, property,
      old_value: oldValue == null ? null : String(oldValue),
      new_value: newValue == null ? null : String(newValue)
    });
  } catch (err) {
    console.warn("[Balloons by Tea] Could not log layout history.", err);
  }
}

async function saveLayoutOverride(elementKey, property, value) {
  const client = getSupabaseClient();
  const page = currentLayoutPage();
  const oldValue = LAYOUT_OVERRIDES[elementKey] ? LAYOUT_OVERRIDES[elementKey][property] : undefined;

  const { error } = await client
    .from("layout_overrides")
    .upsert({ page, element_key: elementKey, property, value: String(value) }, { onConflict: "page,element_key,property" });
  if (error) throw error;

  if (!LAYOUT_OVERRIDES[elementKey]) LAYOUT_OVERRIDES[elementKey] = {};
  LAYOUT_OVERRIDES[elementKey][property] = String(value);

  await logLayoutHistory(elementKey, property, oldValue, value);
}

async function clearLayoutOverride(elementKey, property) {
  const client = getSupabaseClient();
  const page = currentLayoutPage();
  const oldValue = LAYOUT_OVERRIDES[elementKey] ? LAYOUT_OVERRIDES[elementKey][property] : undefined;

  const { error } = await client
    .from("layout_overrides")
    .delete()
    .eq("page", page)
    .eq("element_key", elementKey)
    .eq("property", property);
  if (error) throw error;

  if (LAYOUT_OVERRIDES[elementKey]) delete LAYOUT_OVERRIDES[elementKey][property];

  await logLayoutHistory(elementKey, property, oldValue, null);
}
