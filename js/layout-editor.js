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

async function loadLayoutOverrides() {
  const client = typeof getSupabaseClient === "function" ? getSupabaseClient() : null;
  if (!client) return false;

  const page = document.body.dataset.page || "";
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
   every other admin write in this project. */
async function saveLayoutOverride(elementKey, property, value) {
  const client = getSupabaseClient();
  const page = document.body.dataset.page || "";
  const { error } = await client
    .from("layout_overrides")
    .upsert({ page, element_key: elementKey, property, value: String(value) }, { onConflict: "page,element_key,property" });
  if (error) throw error;

  if (!LAYOUT_OVERRIDES[elementKey]) LAYOUT_OVERRIDES[elementKey] = {};
  LAYOUT_OVERRIDES[elementKey][property] = String(value);
}

async function clearLayoutOverride(elementKey, property) {
  const client = getSupabaseClient();
  const page = document.body.dataset.page || "";
  const { error } = await client
    .from("layout_overrides")
    .delete()
    .eq("page", page)
    .eq("element_key", elementKey)
    .eq("property", property);
  if (error) throw error;

  if (LAYOUT_OVERRIDES[elementKey]) delete LAYOUT_OVERRIDES[elementKey][property];
}
