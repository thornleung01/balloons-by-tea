/* Admin "Settings" tab (site_settings table: homepage text, contact
   details, social links, about copy, theme colours, hero/logo photos and
   page-level SEO). This file owns loading, validating and saving the form.
   The layout around it (sub-nav, sticky save bar, Ctrl/Cmd+S, theme
   preview, SEO counters, Preview button) lives in js/admin-content-ui.js;
   version history in js/admin-content-history.js. js/admin-backup.js
   renders its own section at the bottom of this tab. Uses helpers from
   js/admin-core.js. */

/* ===== Settings ===== */

let currentHeroPhotoFile = null;
let currentLogoPhotoFile = null;
let currentOgImageFile = null;
let ogImageCleared = false;

/* Every public page that gets its own SEO title/description. `key` is the
   site_settings key part (seo_<key>_title / seo_<key>_description) and
   must match currentSeoPageKey() in js/site-content.js. The defaults are
   the static <title>/<meta name="description"> in each HTML file — shown
   as placeholders and used by the snippet preview when a field is blank. */
const SEO_PAGES = [
  { key: "index", label: "Homepage", file: "index.html", title: "Balloons by Tea | Balloon Bouquets & Installations", description: "Elegant balloon bouquets and installations for birthdays, anniversaries and every other occasion. Choose your category and add to cart." },
  { key: "all_products", label: "All products", file: "all-products.html", title: "All Products | Balloons by Tea", description: "Browse, search and sort every balloon bouquet and installation from Balloons by Tea" },
  { key: "anniversary", label: "Anniversary", file: "anniversary.html", title: "Anniversary | Balloons by Tea", description: "Anniversary balloon arches, bouquets and romantic accents, hand-styled by Balloons by Tea" },
  { key: "birthday", label: "Birthday", file: "birthday.html", title: "Birthday | Balloons by Tea", description: "Birthday balloon bouquets and number installs, hand-styled by Balloons by Tea" },
  { key: "kids", label: "Kids", file: "kids.html", title: "Kids | Balloons by Tea", description: "Playful balloon bouquets and number installs for kids' birthdays and parties, hand-styled by Balloons by Tea" },
  { key: "other_occasions", label: "Other occasions", file: "other-occasions.html", title: "Other Occasions | Balloons by Tea", description: "Baby showers, corporate events and balloon styling for every other occasion, by Balloons by Tea" },
  { key: "category", label: "Other category pages (default)", file: "category.html", title: "Shop by Category | Balloons by Tea", description: "Browse balloon bouquets and installations by category from Balloons by Tea." },
  { key: "gallery", label: "Gallery", file: "gallery.html", title: "Past Events Gallery | Balloons by Tea", description: "See real balloon garlands, arches and bouquets from past birthdays, anniversaries and events styled by Balloons by Tea, and order something like it." },
  { key: "custom_order", label: "Custom order", file: "custom-order.html", title: "Custom Order | Balloons by Tea", description: "Request a custom balloon order: tell us your colors, theme and event details and we'll put together a quote." },
  { key: "about", label: "About", file: "about.html", title: "About | Balloons by Tea", description: "Learn about Balloons by Tea, hand-styled balloon bouquets and installations made with care for every celebration." },
  { key: "faq", label: "FAQ", file: "faq.html", title: "FAQ | Balloons by Tea", description: "Frequently asked questions about ordering, delivery, customization and payment at Balloons by Tea" }
];
const SEO_TITLE_LIMIT = 60;
const SEO_DESCRIPTION_LIMIT = 160;

const SETTINGS_KEYS = [
  "hero_heading", "hero_subtext", "hero_cta_text",
  "contact_phone", "contact_email", "contact_whatsapp",
  "social_instagram", "social_rednote", "social_tiktok", "social_youtube",
  "about_intro_1", "about_intro_2",
  "about_highlight_1_heading", "about_highlight_1_body",
  "about_highlight_2_heading", "about_highlight_2_body",
  "about_highlight_3_heading", "about_highlight_3_body",
  "theme_coral", "theme_blush", "theme_baby_blue", "theme_soft_yellow", "theme_brown"
].concat(SEO_PAGES.flatMap((p) => [`seo_${p.key}_title`, `seo_${p.key}_description`]));

/* Photo-valued keys, set by the upload fields rather than a text input. */
const SETTINGS_IMAGE_KEYS = ["hero_image_url", "logo_url", "seo_og_image"];

/* Everything this form manages: what a history snapshot holds and what a
   restore may write. Keys owned by other features (e.g. the Orders tab's
   msg_template_* rows) are deliberately not included. */
const SETTINGS_MANAGED_KEYS = SETTINGS_KEYS.concat(SETTINGS_IMAGE_KEYS);

/* Values as last successfully loaded from the database (key -> value), or
   null if no load has succeeded yet. Save is disabled until it's set, and
   Save only writes fields that differ from it. Both guard the same
   failure: if the settings read failed, the form would be full of blanks
   and black colour-picker defaults, and saving every key from it would
   wipe the homepage text, contact details and theme across the live site. */
let settingsBaseline = null;
/* hero_image_url / logo_url / seo_og_image as last loaded or saved. */
let settingsImageValues = {};
/* Keys that have a row in the database (as last loaded or saved), so a
   field still showing its built-in default isn't mistaken for a saved
   value in history snapshots. */
let settingsDbKeys = new Set();

function settingsFormIsDirty() {
  if (!settingsBaseline) return false;
  if (currentHeroPhotoFile || currentLogoPhotoFile || currentOgImageFile || ogImageCleared) return true;
  return SETTINGS_KEYS.some((key) => {
    const input = document.getElementById(`s-${key}`);
    return input && input.value !== settingsBaseline[key];
  });
}

/* Keys whose field differs from what's saved (text keys only). */
function changedSettingsKeys() {
  if (!settingsBaseline) return [];
  return SETTINGS_KEYS.filter((key) => {
    const input = document.getElementById(`s-${key}`);
    return input && input.value !== settingsBaseline[key];
  });
}

function notifySettingsChanged() {
  document.dispatchEvent(new CustomEvent("admin-settings-changed"));
}

/* ----- SEO fields (generated: 11 pages x 2 fields) ----- */
function renderSeoPageFields() {
  const container = document.getElementById("seoPagesContainer");
  if (!container || container.childElementCount) return;
  container.innerHTML = SEO_PAGES.map((p, i) => `
    <details class="seo-page" data-seo-page="${p.key}" ${i === 0 ? "open" : ""}>
      <summary>
        <span class="seo-page-name">${escapeHtml(p.label)}</span>
        <span class="seo-page-file">${escapeHtml(p.file)}</span>
        <span class="seo-page-state" data-seo-state="${p.key}"></span>
      </summary>
      <div class="seo-page-body">
        <div class="field">
          <label for="s-seo_${p.key}_title">Meta title</label>
          <input id="s-seo_${p.key}_title" name="seo_${p.key}_title" type="text" maxlength="120" placeholder="${escapeHtml(p.title)}" data-seo-counter="${SEO_TITLE_LIMIT}"/>
          <p class="field-note seo-counter" data-counter-for="s-seo_${p.key}_title"></p>
        </div>
        <div class="field">
          <label for="s-seo_${p.key}_description">Meta description</label>
          <textarea id="s-seo_${p.key}_description" name="seo_${p.key}_description" maxlength="320" rows="3" placeholder="${escapeHtml(p.description)}" data-seo-counter="${SEO_DESCRIPTION_LIMIT}"></textarea>
          <p class="field-note seo-counter" data-counter-for="s-seo_${p.key}_description"></p>
        </div>
        <div class="seo-snippet" data-seo-snippet="${p.key}" aria-label="Google result preview">
          <span class="seo-snippet-label">Google preview</span>
          <span class="seo-snippet-url">thornleung01.github.io › balloons-by-tea${p.key === "index" ? "" : " › " + escapeHtml(p.file)}</span>
          <span class="seo-snippet-title"></span>
          <span class="seo-snippet-desc"></span>
        </div>
      </div>
    </details>
  `).join("");
}

/* ----- Validation & normalization -----
   Each normalizer turns obvious shorthand into the stored form (an
   @handle into a profile URL, a bare number into a wa.me link). Each
   validator returns an error message, or "" when the value is fine. Blank
   is always allowed: it means "keep the page's built-in value". */
const SOCIAL_PROFILE_BASES = {
  social_instagram: { base: "https://www.instagram.com/", suffix: "/", host: "instagram.com", name: "Instagram" },
  social_tiktok: { base: "https://www.tiktok.com/@", suffix: "", host: "tiktok.com", name: "TikTok" },
  social_youtube: { base: "https://www.youtube.com/@", suffix: "", host: "youtube.com", name: "YouTube" },
  social_rednote: { base: null, host: "xiaohongshu.com", name: "RedNote" }
};

function looksLikeBareUrl(v) {
  return /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(v);
}

function parseHttpUrl(v) {
  try {
    const u = new URL(v);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname.includes(".") ? u : null;
  } catch (e) {
    return null;
  }
}

function normalizeSettingValue(key, raw) {
  const v = String(raw == null ? "" : raw).trim();
  if (!v) return "";
  if (key === "contact_email") return v.replace(/^mailto:/i, "");
  if (key === "contact_whatsapp") {
    if (/^[+\d\s().-]+$/.test(v)) {
      const digits = v.replace(/\D/g, "");
      if (digits.length >= 7 && digits.length <= 15) return `https://wa.me/${digits}`;
      return v;
    }
    if (looksLikeBareUrl(v)) return `https://${v}`;
    return v;
  }
  const social = SOCIAL_PROFILE_BASES[key];
  if (social) {
    if (social.base && /^@?[A-Za-z0-9._-]{1,60}$/.test(v) && !v.includes("..") && !/\.(com|net|org|cn)$/i.test(v)) {
      return social.base + v.replace(/^@/, "") + social.suffix;
    }
    if (looksLikeBareUrl(v)) return `https://${v}`;
    return v;
  }
  if (/^theme_/.test(key)) return v.toLowerCase();
  return raw; // free text: keep exactly what was typed (including inner whitespace)
}

/* Returns { error, warning } for one key's (already normalized) value. */
function validateSettingValue(key, v) {
  if (!v) return { error: "", warning: "" };
  if (key === "contact_email") {
    return { error: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? "" : "Enter an email address like hello@example.com.", warning: "" };
  }
  if (key === "contact_phone") {
    const digits = v.replace(/\D/g, "");
    if (!/^[+\d\s().-]+$/.test(v)) return { error: "Use only digits, spaces, +, -, ( and ).", warning: "" };
    if (digits.length < 7 || digits.length > 15) return { error: "A phone number has 7 to 15 digits.", warning: "" };
    return { error: "", warning: "" };
  }
  if (key === "contact_whatsapp") {
    const u = parseHttpUrl(v);
    if (!u) return { error: "Enter a wa.me link or a phone number with its country code.", warning: "" };
    const ok = /(^|\.)wa\.me$|(^|\.)whatsapp\.com$/i.test(u.hostname);
    return { error: "", warning: ok ? "" : "This doesn't look like a WhatsApp link (wa.me/…)." };
  }
  const social = SOCIAL_PROFILE_BASES[key];
  if (social) {
    const u = parseHttpUrl(v);
    if (!u) return { error: `Enter a full link (https://…)${social.base ? " or an @handle" : ""}.`, warning: "" };
    const ok = u.hostname.toLowerCase().endsWith(social.host);
    return { error: "", warning: ok ? "" : `This doesn't look like a ${social.name} link.` };
  }
  if (/^theme_/.test(key)) {
    return { error: /^#[0-9a-f]{6}$/i.test(v) ? "" : "Use a hex colour like #ff7f7f.", warning: "" };
  }
  if (/^seo_.+_title$/.test(key) && v.length > SEO_TITLE_LIMIT) {
    return { error: "", warning: `Google usually cuts titles off after about ${SEO_TITLE_LIMIT} characters.` };
  }
  if (/^seo_.+_description$/.test(key) && v.length > SEO_DESCRIPTION_LIMIT) {
    return { error: "", warning: `Google usually cuts descriptions off after about ${SEO_DESCRIPTION_LIMIT} characters.` };
  }
  return { error: "", warning: "" };
}

function setSettingsFieldMessage(input, { error, warning }) {
  const field = input.closest(".field");
  if (!field) return;
  let msg = field.querySelector(`.settings-field-msg[data-msg-for="${input.id}"]`);
  const text = error || warning;
  if (!text) {
    if (msg) msg.remove();
    input.removeAttribute("aria-invalid");
    input.removeAttribute("aria-describedby");
    field.classList.remove("has-error", "has-warning");
    return;
  }
  if (!msg) {
    msg = document.createElement("p");
    msg.className = "settings-field-msg";
    msg.dataset.msgFor = input.id;
    msg.id = `msg-${input.id}`;
    // Right after the input (or its colour row), before any help note.
    const anchor = input.closest(".settings-color-row") || input;
    anchor.insertAdjacentElement("afterend", msg);
  }
  msg.textContent = text;
  msg.classList.toggle("is-error", !!error);
  field.classList.toggle("has-error", !!error);
  field.classList.toggle("has-warning", !error && !!warning);
  if (error) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
  input.setAttribute("aria-describedby", msg.id);
}

/* Normalizes (when asked) and validates one field; returns true if valid. */
function checkSettingsField(key, { normalize } = {}) {
  const input = document.getElementById(`s-${key}`);
  if (!input) return true;
  if (normalize && input.type !== "color") {
    const normalized = normalizeSettingValue(key, input.value);
    if (normalized !== input.value) input.value = normalized;
  }
  const result = validateSettingValue(key, String(input.value).trim());
  setSettingsFieldMessage(input, result);
  return !result.error;
}

/* Validates the whole form; returns the first invalid input (or null). */
function validateSettingsForm() {
  let firstInvalid = null;
  SETTINGS_KEYS.forEach((key) => {
    const ok = checkSettingsField(key, { normalize: true });
    if (!ok && !firstInvalid) firstInvalid = document.getElementById(`s-${key}`);
  });
  document.querySelectorAll("#settingsForm .settings-hex").forEach((hex) => {
    if (hex.getAttribute("aria-invalid") === "true" && !firstInvalid) firstInvalid = hex;
  });
  return firstInvalid;
}

function clearSettingsFieldMessages() {
  document.querySelectorAll("#settingsForm .settings-field-msg").forEach((m) => m.remove());
  document.querySelectorAll("#settingsForm [aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
  document.querySelectorAll("#settingsForm .has-error, #settingsForm .has-warning").forEach((el) => el.classList.remove("has-error", "has-warning"));
}

/* ----- Photo previews ----- */
function renderSettingsImagePreviews() {
  if (!currentHeroPhotoFile) {
    const url = settingsImageValues.hero_image_url;
    document.getElementById("heroPhotoPreview").innerHTML = url ? `<img src="${escapeHtml(url)}" alt=""/>` : "No photo";
  }
  if (!currentLogoPhotoFile) {
    const url = settingsImageValues.logo_url;
    document.getElementById("logoPhotoPreview").innerHTML = url ? `<img src="${escapeHtml(url)}" alt=""/>` : "No photo";
  }
  if (!currentOgImageFile) {
    const url = ogImageCleared ? "" : settingsImageValues.seo_og_image;
    document.getElementById("ogImagePreview").innerHTML = url ? `<img src="${escapeHtml(url)}" alt=""/>` : "None, each page uses its built-in image";
  }
  const clearBtn = document.getElementById("ogImageClearBtn");
  if (clearBtn) clearBtn.hidden = !(currentOgImageFile || (!ogImageCleared && settingsImageValues.seo_og_image));
}

function resetStagedSettingsPhotos() {
  currentHeroPhotoFile = null;
  currentLogoPhotoFile = null;
  currentOgImageFile = null;
  ogImageCleared = false;
  // Clear the file inputs too: if one kept showing a filename after its
  // staged file was dropped, re-picking that same file fires no change
  // event and Save would quietly skip the upload.
  ["s-hero_image", "s-logo_image", "s-seo_og_image_file"].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.value = "";
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
    notifySettingsChanged();
    return;
  }
  saveBtn.disabled = true;
  statusEl.textContent = "Loading settings...";
  statusEl.className = "form-status";
  // Reset staged photos before the fetch, not after — otherwise a photo
  // picked while this request is in flight gets silently thrown away.
  resetStagedSettingsPhotos();
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
    statusEl.textContent = `Couldn't load settings (${error.message}). Saving is disabled so blank fields can't overwrite the live site. Reload the page to try again.`;
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
  settingsImageValues = {};
  SETTINGS_IMAGE_KEYS.forEach((key) => { settingsImageValues[key] = map[key] || ""; });
  settingsDbKeys = new Set(Object.keys(map).filter((key) => map[key] != null));

  clearSettingsFieldMessages();
  renderSettingsImagePreviews();
  statusEl.textContent = "";
  saveBtn.disabled = false;
  notifySettingsChanged();
}

/* Puts every field back to what's saved and drops staged photos. */
function discardSettingsChanges() {
  if (!settingsBaseline) return;
  SETTINGS_KEYS.forEach((key) => {
    const input = document.getElementById(`s-${key}`);
    if (input && key in settingsBaseline) input.value = settingsBaseline[key];
  });
  resetStagedSettingsPhotos();
  clearSettingsFieldMessages();
  renderSettingsImagePreviews();
  const statusEl = document.getElementById("settingsFormStatus");
  statusEl.textContent = "Changes discarded.";
  statusEl.className = "form-status";
  notifySettingsChanged();
}

function stageSettingsPhoto(e, previewId, assign) {
  const file = e.target.files[0];
  assign(file || null);
  if (!file) { renderSettingsImagePreviews(); notifySettingsChanged(); return; }
  const reader = new FileReader();
  reader.onload = () => { document.getElementById(previewId).innerHTML = `<img src="${reader.result}" alt=""/>`; };
  reader.readAsDataURL(file);
  renderSettingsImagePreviews();
  notifySettingsChanged();
}

function handleHeroPhotoChange(e) {
  stageSettingsPhoto(e, "heroPhotoPreview", (f) => { currentHeroPhotoFile = f; });
}

function handleLogoPhotoChange(e) {
  stageSettingsPhoto(e, "logoPhotoPreview", (f) => { currentLogoPhotoFile = f; });
}

function handleOgImageChange(e) {
  stageSettingsPhoto(e, "ogImagePreview", (f) => { currentOgImageFile = f; if (f) ogImageCleared = false; });
}

function handleOgImageClear() {
  currentOgImageFile = null;
  const input = document.getElementById("s-seo_og_image_file");
  if (input) input.value = "";
  ogImageCleared = !!settingsImageValues.seo_og_image;
  renderSettingsImagePreviews();
  notifySettingsChanged();
}

/* The managed keys as they are in the database right now (key -> value,
   only keys that have a row). Used for history snapshots. */
async function fetchSettingsSnapshot(client) {
  const { data, error } = await client.from("site_settings").select("key,value").in("key", SETTINGS_MANAGED_KEYS);
  if (error) throw error;
  const snap = {};
  (data || []).forEach((row) => { if (row.value != null) snap[row.key] = row.value; });
  return snap;
}

/* The last-loaded state, as a snapshot (no network). */
function settingsSnapshotFromBaseline() {
  const snap = {};
  if (!settingsBaseline) return snap;
  SETTINGS_KEYS.forEach((key) => {
    if (settingsDbKeys.has(key) && settingsBaseline[key]) snap[key] = settingsBaseline[key];
  });
  SETTINGS_IMAGE_KEYS.forEach((key) => { if (settingsImageValues[key]) snap[key] = settingsImageValues[key]; });
  return snap;
}

async function handleSaveSettings(e) {
  if (e) e.preventDefault();
  const client = getSupabaseClient();
  const saveBtn = document.getElementById("saveSettingsBtn");
  const statusEl = document.getElementById("settingsFormStatus");
  if (saveBtn.dataset.saving === "1") return;

  if (settingsBaseline) {
    const firstInvalid = validateSettingsForm();
    if (firstInvalid) {
      statusEl.textContent = "Some fields need fixing before you can save. See the messages in red.";
      statusEl.className = "form-status error";
      if (typeof showSettingsSectionFor === "function") showSettingsSectionFor(firstInvalid);
      firstInvalid.focus();
      notifySettingsChanged();
      return;
    }
  }

  saveBtn.disabled = true;
  saveBtn.dataset.saving = "1";
  statusEl.textContent = "Saving...";
  statusEl.className = "form-status";
  document.dispatchEvent(new CustomEvent("admin-settings-saving", { detail: { saving: true } }));

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
    if (currentOgImageFile) {
      // Share previews are 1200x630; a little headroom for retina crops.
      rows.push({ key: "seo_og_image", value: await uploadSiteImage(client, currentOgImageFile, { maxDimension: 1600 }) });
    } else if (ogImageCleared) {
      rows.push({ key: "seo_og_image", value: "" });
    }

    if (!rows.length) {
      statusEl.textContent = "Nothing has changed, so there is nothing to save.";
      statusEl.className = "form-status";
      return;
    }

    // Version history: the first time anything is saved, keep the
    // pre-save state as its own version so the very first edit can be
    // undone too. Never blocks the save.
    if (typeof ensureContentHistoryBaseline === "function") {
      await ensureContentHistoryBaseline("settings", async () => settingsSnapshotFromBaseline());
    }

    const { error } = await mustAffect(client.from("site_settings").upsert(rows, { onConflict: "key" }));
    if (error) throw error;

    rows.forEach((row) => {
      settingsDbKeys.add(row.key);
      if (row.key in settingsBaseline) settingsBaseline[row.key] = row.value;
      if (SETTINGS_IMAGE_KEYS.includes(row.key)) settingsImageValues[row.key] = row.value;
    });
    resetStagedSettingsPhotos();
    renderSettingsImagePreviews();
    statusEl.textContent = "Settings saved.";
    statusEl.className = "form-status success";

    if (typeof recordContentHistory === "function") {
      const labels = rows.map((r) => settingsFieldLabel(r.key));
      const note = `Changed ${labels.slice(0, 4).join(", ")}${labels.length > 4 ? ` and ${labels.length - 4} more` : ""}`;
      recordContentHistory("settings", async () => fetchSettingsSnapshot(client), note);
    }
  } catch (err) {
    statusEl.textContent = err.message || "Something went wrong saving settings.";
    statusEl.className = "form-status error";
  } finally {
    saveBtn.disabled = !settingsBaseline;
    delete saveBtn.dataset.saving;
    document.dispatchEvent(new CustomEvent("admin-settings-saving", { detail: { saving: false } }));
    notifySettingsChanged();
  }
}

/* Human label for a settings key ("Headline", "Homepage meta title"…). */
function settingsFieldLabel(key) {
  const seo = /^seo_(.+)_(title|description)$/.exec(key);
  if (seo) {
    const page = SEO_PAGES.find((p) => p.key === seo[1]);
    return `${page ? page.label : seo[1]} meta ${seo[2]}`;
  }
  const fixed = { hero_image_url: "Hero image", logo_url: "Logo", seo_og_image: "Share image" };
  if (fixed[key]) return fixed[key];
  const label = document.querySelector(`label[for="s-${key}"]`);
  if (label) {
    const group = label.closest(".settings-subgroup");
    const groupName = group && group.querySelector("h3") ? group.querySelector("h3").textContent + " " : "";
    return (groupName + label.textContent.trim()).trim();
  }
  return key;
}

/* ----- Version history (js/admin-content-history.js) ----- */

/* Writes a snapshot back: upserts its keys, deletes managed keys it
   doesn't have (they were unset at the time, so the page used its
   built-in value). */
async function restoreSettingsSnapshot(snapshot) {
  const client = getSupabaseClient();
  const current = await fetchSettingsSnapshot(client);
  const upserts = SETTINGS_MANAGED_KEYS
    .filter((key) => typeof snapshot[key] === "string" && snapshot[key] !== current[key])
    .map((key) => ({ key, value: snapshot[key] }));
  const removals = SETTINGS_MANAGED_KEYS.filter((key) => !(key in snapshot) && key in current);
  if (upserts.length) {
    const { error } = await mustAffect(client.from("site_settings").upsert(upserts, { onConflict: "key" }));
    if (error) throw error;
  }
  if (removals.length) {
    const { error } = await mustAffect(client.from("site_settings").delete().in("key", removals));
    if (error) throw error;
  }
  // Reload the form from the database (it was confirmed clean or
  // discarded before restoring).
  settingsBaseline = null;
  resetStagedSettingsPhotos();
  await loadSettingsIntoForm();
}

function describeSettingsDiff(snapshot, current) {
  const changes = [];
  SETTINGS_MANAGED_KEYS.forEach((key) => {
    const a = snapshot[key] || "";
    const b = current[key] || "";
    if (a !== b) changes.push({ label: settingsFieldLabel(key), from: b, to: a, isImage: SETTINGS_IMAGE_KEYS.includes(key) });
  });
  return changes;
}

function openSettingsHistory() {
  if (typeof openContentHistory !== "function") return;
  openContentHistory("settings", {
    title: "Settings history",
    getCurrent: () => fetchSettingsSnapshot(getSupabaseClient()),
    diff: describeSettingsDiff,
    beforeRestore: async () => {
      if (!settingsFormIsDirty()) return true;
      if (!(await adminConfirm({ title: "Discard unsaved changes?", message: "You have unsaved changes in Settings. Restoring will throw them away. Continue?", confirmLabel: "Discard and restore", danger: true }))) return false;
      discardSettingsChanges();
      return true;
    },
    restore: restoreSettingsSnapshot
  });
}

registerAdminTab("settings", { btnId: "tabSettingsBtn", panelId: "settingsPanel", onEnter: loadSettingsIntoForm });

registerAdminDirtyCheck(settingsFormIsDirty);

onAdminInit(() => {
  renderSeoPageFields();
  const form = document.getElementById("settingsForm");
  form.addEventListener("submit", handleSaveSettings);
  document.getElementById("s-hero_image").addEventListener("change", handleHeroPhotoChange);
  document.getElementById("s-logo_image").addEventListener("change", handleLogoPhotoChange);
  document.getElementById("s-seo_og_image_file").addEventListener("change", handleOgImageChange);
  document.getElementById("ogImageClearBtn").addEventListener("click", handleOgImageClear);
  wireClickablePhotoPreview("heroPhotoPreview");
  wireClickablePhotoPreview("logoPhotoPreview");
  wireClickablePhotoPreview("ogImagePreview");
  document.getElementById("settingsHistoryBtn").addEventListener("click", openSettingsHistory);

  // Live feedback: errors clear as soon as the value becomes valid; the
  // shorthand -> URL conversion happens when the field loses focus.
  form.addEventListener("input", (e) => {
    const key = e.target.id && e.target.id.startsWith("s-") ? e.target.id.slice(2) : null;
    if (key && SETTINGS_KEYS.includes(key) && e.target.closest(".field.has-error, .field.has-warning")) checkSettingsField(key);
    notifySettingsChanged();
  });
  form.addEventListener("change", () => notifySettingsChanged());
  form.addEventListener("focusout", (e) => {
    const key = e.target.id && e.target.id.startsWith("s-") ? e.target.id.slice(2) : null;
    if (!key || !SETTINGS_KEYS.includes(key) || !settingsBaseline) return;
    const before = e.target.value;
    checkSettingsField(key, { normalize: true });
    if (e.target.value !== before) notifySettingsChanged();
  });
});
