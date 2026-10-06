/*
  Loads the product catalog from Supabase (if configured — see
  js/supabase-config.js). This is the primary live-editing path, managed
  through admin.html. The Google Sheet path in js/catalog.js is an
  alternative/fallback, not used together with this on the same item set.

  Returns true if live data was applied to window.COLLECTIONS, false if it
  fell through (not configured, offline, etc.) so app.js knows whether to
  try the next fallback.
*/
async function loadSupabaseCatalog() {
  const client = getSupabaseClient();
  if (!client) return false;

  try {
    const { data, error } = await client
      .from("products")
      .select("*")
      .order("collection", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) throw error;

    const collections = buildCollectionsFromSupabaseRows(data || []);
    window.COLLECTIONS = collections;
    console.info("[Balloons by Tea] Loaded live catalog from Supabase.");
    return true;
  } catch (err) {
    console.warn("[Balloons by Tea] Could not load the Supabase catalog — trying the next fallback.", err);
    return false;
  }
}

function buildCollectionsFromSupabaseRows(rows) {
  const result = {};
  Object.keys(window.COLLECTIONS || {}).forEach((slug) => {
    result[slug] = {
      title: window.COLLECTIONS[slug].title,
      tagline: window.COLLECTIONS[slug].tagline,
      items: []
    };
  });
  /* Categories added via admin (js/site-content.js's loadSiteContent())
     won't be in the bundled js/products.js COLLECTIONS object above, so
     without this they'd silently drop every product assigned to them.
     Seed from live collections data first, and from the rows themselves
     as a last resort, so no product's collection is ever missing a
     bucket regardless of load order. */
  (window.SITE_COLLECTIONS || []).forEach((c) => {
    if (!result[c.slug]) result[c.slug] = { title: c.title, tagline: c.tagline || "", items: [] };
  });
  rows.forEach((row) => {
    const slug = String(row.collection || "").trim().toLowerCase();
    if (!result[slug]) result[slug] = { title: slug, tagline: "", items: [] };
  });

  rows.forEach((row) => {
    const slug = String(row.collection || "").trim().toLowerCase();
    if (row.active === false) return;

    const styleKey = String(row.style || "").trim().toLowerCase();
    const colors =
      STYLE_PRESETS[styleKey] ||
      STYLE_PRESETS[STYLE_DEFAULT_BY_COLLECTION[slug]] ||
      STYLE_PRESETS["golden classic"];

    result[slug].items.push({
      id: "sb-" + row.id,
      name: row.name || "",
      price: Number(row.price) || 0,
      description: row.description || "",
      colors,
      image: sanitizeImageUrl(row.image_url)
    });
  });

  return result;
}
