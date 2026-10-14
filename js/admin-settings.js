/* Admin "Settings" tab (site_settings table: homepage text, contact
   details, theme colours, hero/logo photos). js/admin-backup.js renders its
   own section at the bottom of this tab. Uses helpers from
   js/admin-core.js. */

/* ===== Settings ===== */

let currentHeroPhotoFile = null;
let currentLogoPhotoFile = null;
const SETTINGS_KEYS = [
  "hero_heading", "hero_subtext", "hero_cta_text",
  "contact_phone", "contact_email", "contact_whatsapp",
  "social_instagram", "social_rednote", "social_tiktok", "social_youtube",
  "about_intro_1", "about_intro_2",
  "about_highlight_1_heading", "about_highlight_1_body",
  "about_highlight_2_heading", "about_highlight_2_body",
  "about_highlight_3_heading", "about_highlight_3_body",
  "theme_coral", "theme_blush", "theme_baby_blue", "theme_soft_yellow", "theme_brown"
];

/* Values as last successfully loaded from the database (key -> value), or
   null if no load has succeeded yet. Save is disabled until it's set, and
   Save only writes fields that differ from it. Both guard the same
   failure: if the settings read failed, the form would be full of blanks
   and black colour-picker defaults, and saving all 23 keys from it would
   wipe the homepage text, contact details and theme across the live site. */
let settingsBaseline = null;

function settingsFormIsDirty() {
  if (!settingsBaseline) return false;
  if (currentHeroPhotoFile || currentLogoPhotoFile) return true;
  return SETTINGS_KEYS.some((key) => {
    const input = document.getElementById(`s-${key}`);
    return input && input.value !== settingsBaseline[key];
  });
}

async function loadSettingsIntoForm() {
  const statusEl = document.getElementById("settingsFormStatus");
  const saveBtn = document.getElementById("saveSettingsBtn");
  // Re-entering the tab with unsaved edits: keep them rather than reload
  // over them.
  if (settingsFormIsDirty()) {
    statusEl.textContent = "You have unsaved changes.";
    statusEl.className = "form-status";
    return;
  }
  saveBtn.disabled = true;
  statusEl.textContent = "Loading settings...";
  statusEl.className = "form-status";
  // Reset staged photos before the fetch, not after — otherwise a photo
  // picked while this request is in flight gets silently thrown away.
  // Clear the file inputs too: if one kept showing a filename after its
  // staged file was dropped, re-picking that same file fires no change
  // event and Save would quietly skip the upload.
  currentHeroPhotoFile = null;
  currentLogoPhotoFile = null;
  ["s-hero_image", "s-logo_image"].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.value = "";
  });
  // Snapshot text fields so anything typed while the request is in flight
  // isn't overwritten by the loaded values.
  const valuesAtStart = {};
  SETTINGS_KEYS.forEach((key) => {
    const input = document.getElementById(`s-${key}`);
    if (input) valuesAtStart[key] = input.value;
  });
  const client = getSupabaseClient();
  const { data, error } = await client.from("site_settings").select("*");
  if (error) {
    statusEl.textContent = `Couldn't load settings (${error.message}). Saving is disabled so blank fields can't overwrite the live site — reload the page to try again.`;
    statusEl.className = "form-status error";
    return; // Save stays disabled
  }
  const map = {};
  (data || []).forEach((row) => { map[row.key] = row.value; });

  // How a value looks once a field of this kind has held it. Browsers
  // normalize: colour inputs lowercase hex (and turn invalid values into
  // #000000), textareas turn CRLF into LF. Comparing against the raw DB
  // value would make such fields look permanently "changed".
  const asFieldValue = (input, value) => {
    const probe = input.cloneNode(false);
    probe.value = value;
    return probe.value;
  };
  const baseline = {};
  SETTINGS_KEYS.forEach((key) => {
    const input = document.getElementById(`s-${key}`);
    if (!input) return;
    const editedMidLoad = input.value !== valuesAtStart[key];
    if (map[key] != null && !editedMidLoad) input.value = map[key];
    // The baseline is what the database holds, as this field would show
    // it. A key the database doesn't have yet gets the input's own default
    // as its baseline, so an untouched default (e.g. the colour picker's
    // black) is never written.
    baseline[key] = map[key] != null
      ? asFieldValue(input, map[key])
      : (editedMidLoad ? valuesAtStart[key] : input.value);
  });
  settingsBaseline = baseline;

  if (!currentHeroPhotoFile) {
    document.getElementById("heroPhotoPreview").innerHTML = map.hero_image_url ? `<img src="${escapeHtml(map.hero_image_url)}" alt=""/>` : "No photo";
  }
  if (!currentLogoPhotoFile) {
    document.getElementById("logoPhotoPreview").innerHTML = map.logo_url ? `<img src="${escapeHtml(map.logo_url)}" alt=""/>` : "No photo";
  }
  statusEl.textContent = "";
  saveBtn.disabled = false;
}

function handleHeroPhotoChange(e) {
  const file = e.target.files[0];
  currentHeroPhotoFile = file || null;
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { document.getElementById("heroPhotoPreview").innerHTML = `<img src="${reader.result}" alt=""/>`; };
  reader.readAsDataURL(file);
}

function handleLogoPhotoChange(e) {
  const file = e.target.files[0];
  currentLogoPhotoFile = file || null;
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { document.getElementById("logoPhotoPreview").innerHTML = `<img src="${reader.result}" alt=""/>`; };
  reader.readAsDataURL(file);
}

async function handleSaveSettings(e) {
  e.preventDefault();
  const client = getSupabaseClient();
  const saveBtn = document.getElementById("saveSettingsBtn");
  const statusEl = document.getElementById("settingsFormStatus");

  saveBtn.disabled = true;
  statusEl.textContent = "Saving...";
  statusEl.className = "form-status";

  try {
    if (!settingsBaseline) throw new Error("Settings haven't loaded, so nothing was saved. Reload the page and try again.");
    // Only write what actually changed since the last successful load.
    const rows = SETTINGS_KEYS
      .map((key) => ({ key, value: document.getElementById(`s-${key}`).value }))
      .filter((row) => row.value !== settingsBaseline[row.key]);

    if (currentHeroPhotoFile) {
      // The hero photo renders full-bleed (.hero-photo-img, width/height:
      // 100% of its section) up to the full viewport width, unlike every
      // other compressed image in the admin which only ever displays at a
      // few hundred px — the generic 1600px cap would visibly soften it on
      // any desktop monitor or retina display. Give it a larger ceiling.
      rows.push({ key: "hero_image_url", value: await uploadSiteImage(client, currentHeroPhotoFile, { maxDimension: 2560 }) });
    }
    if (currentLogoPhotoFile) {
      rows.push({ key: "logo_url", value: await uploadSiteImage(client, currentLogoPhotoFile) });
    }

    if (!rows.length) {
      statusEl.textContent = "Nothing has changed — nothing to save.";
      statusEl.className = "form-status";
      return;
    }
    const { error } = await mustAffect(client.from("site_settings").upsert(rows, { onConflict: "key" }));
    if (error) throw error;

    rows.forEach((row) => { if (row.key in settingsBaseline) settingsBaseline[row.key] = row.value; });
    currentHeroPhotoFile = null;
    currentLogoPhotoFile = null;
    statusEl.textContent = "Settings saved.";
    statusEl.className = "form-status success";
  } catch (err) {
    statusEl.textContent = err.message || "Something went wrong saving settings.";
    statusEl.className = "form-status error";
  } finally {
    saveBtn.disabled = !settingsBaseline;
  }
}

registerAdminTab("settings", { btnId: "tabSettingsBtn", panelId: "settingsPanel", onEnter: loadSettingsIntoForm });

registerAdminDirtyCheck(settingsFormIsDirty);

onAdminInit(() => {
  document.getElementById("settingsForm").addEventListener("submit", handleSaveSettings);
  document.getElementById("s-hero_image").addEventListener("change", handleHeroPhotoChange);
  document.getElementById("s-logo_image").addEventListener("change", handleLogoPhotoChange);
  wireClickablePhotoPreview("heroPhotoPreview");
  wireClickablePhotoPreview("logoPhotoPreview");
});
