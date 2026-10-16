/* Settings tab layout and helpers around the form in js/admin-settings.js:
     - sub-nav + one-section-at-a-time pages (left column on desktop, chip
       row on phones)
     - sticky "Unsaved changes · Discard · Save" bar, Ctrl/Cmd+S
     - theme colour hex boxes, mini preview and WCAG contrast check
     - SEO character counters and Google snippet preview
     - Preview button (unsaved settings applied on the public site)

   For other admin scripts:
     window.addSettingsSection(id, title, element[, { show }]) -> section
         adds a page to the Settings tab (inserted before #backupAdmin) with
         its own sub-nav entry and returns the wrapping <section>.
     window.showSettingsSection(id)
         jumps to a page: a form section name ("hero", "contact", "social",
         "about", "theme", "seo") or the id of an added section.
   Cards appended straight into #settingsPanel (e.g. before #backupAdmin)
   are picked up automatically too: they become a "More" page titled from
   their data-settings-title, or else their first h2/h3. */

/* ===== Sub-nav / pages ===== */

const SETTINGS_PAGE_STORAGE_KEY = "admin-settings-page";
let settingsActivePage = null;

function settingsPanelEl() { return document.getElementById("settingsPanel"); }

/* Every page: the form's fieldsets, then any other card in the panel. */
function collectSettingsPages() {
  const panel = settingsPanelEl();
  const form = document.getElementById("settingsForm");
  if (!panel || !form) return [];
  const pages = [];
  form.querySelectorAll(":scope > fieldset[data-settings-section]").forEach((fs) => {
    fs.id = fs.id || `settings-sec-${fs.dataset.settingsSection}`;
    pages.push({ id: fs.dataset.settingsSection, el: fs, title: fs.dataset.settingsTitle || fs.querySelector("legend").textContent, inForm: true });
  });
  let n = 0;
  Array.from(panel.children).forEach((el) => {
    if (el === form || el.hasAttribute("data-settings-own") || el.tagName === "SCRIPT" || el.tagName === "TEMPLATE") return;
    if (!el.id) el.id = `settings-extra-${++n}`;
    const heading = el.querySelector("h2, h3, legend");
    const title = el.dataset.settingsTitle || (heading && heading.textContent.trim()) || "More";
    pages.push({ id: el.id, el, title: title.length > 28 ? title.slice(0, 27) + "…" : title, inForm: false });
  });
  return pages;
}

function renderSettingsSubnav() {
  const nav = document.getElementById("settingsSubnav");
  if (!nav) return;
  const pages = collectSettingsPages();
  const formPages = pages.filter((p) => p.inForm);
  const extraPages = pages.filter((p) => !p.inForm);
  const btn = (p) => `<button type="button" class="settings-subnav-item" data-settings-page="${escapeHtml(p.id)}" aria-controls="${escapeHtml(p.el.id)}"><span class="settings-subnav-label">${escapeHtml(p.title)}</span><span class="settings-subnav-dot" aria-hidden="true"></span></button>`;
  nav.innerHTML = `
    <div class="settings-subnav-group">${formPages.map(btn).join("")}</div>
    ${extraPages.length ? `<p class="settings-subnav-heading">More</p><div class="settings-subnav-group">${extraPages.map(btn).join("")}</div>` : ""}
  `;
  if (!settingsActivePage || !pages.some((p) => p.id === settingsActivePage)) {
    let remembered = null;
    try { remembered = localStorage.getItem(SETTINGS_PAGE_STORAGE_KEY); } catch (e) { /* storage unavailable */ }
    settingsActivePage = pages.some((p) => p.id === remembered) ? remembered : (pages[0] && pages[0].id);
  }
  applySettingsPageVisibility(pages);
  updateSettingsSectionDots();
}

function applySettingsPageVisibility(pages) {
  pages = pages || collectSettingsPages();
  const form = document.getElementById("settingsForm");
  const active = pages.find((p) => p.id === settingsActivePage) || pages[0];
  if (!active) return;
  pages.forEach((p) => p.el.classList.toggle("is-settings-hidden", p !== active));
  if (form) form.classList.toggle("is-settings-hidden", !active.inForm);
  document.querySelectorAll("#settingsSubnav [data-settings-page]").forEach((b) => {
    const on = b.dataset.settingsPage === active.id;
    b.classList.toggle("active", on);
    if (on) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
  });
  const panel = settingsPanelEl();
  if (panel) panel.dataset.activeSettingsPage = active.id;
}

function showSettingsSection(id, { scroll = true } = {}) {
  const pages = collectSettingsPages();
  if (!pages.some((p) => p.id === id)) return false;
  settingsActivePage = id;
  try { localStorage.setItem(SETTINGS_PAGE_STORAGE_KEY, id); } catch (e) { /* per-browser convenience only */ }
  applySettingsPageVisibility(pages);
  const activeBtn = document.querySelector(`#settingsSubnav [data-settings-page="${CSS.escape(id)}"]`);
  if (activeBtn && activeBtn.scrollIntoView && window.matchMedia("(max-width: 860px)").matches) {
    activeBtn.scrollIntoView({ block: "nearest", inline: "center" });
  }
  if (scroll) {
    const panel = settingsPanelEl();
    const top = panel ? panel.getBoundingClientRect().top + window.scrollY - 12 : 0;
    if (window.scrollY > top) window.scrollTo({ top, behavior: "smooth" });
  }
  return true;
}

/* Shows whichever page holds `el` (used to reveal an invalid field). */
function showSettingsSectionFor(el) {
  const page = collectSettingsPages().find((p) => p.el.contains(el));
  if (page) showSettingsSection(page.id, { scroll: false });
  if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "smooth" });
}

function addSettingsSection(id, title, element, options) {
  const panel = settingsPanelEl();
  if (!panel) return null;
  let section = id ? document.getElementById(id) : null;
  if (!section) {
    section = document.createElement("section");
    section.className = "settings-extra";
    if (id) section.id = id;
  }
  section.dataset.settingsTitle = title || section.dataset.settingsTitle || "More";
  if (element && element !== section && element.parentNode !== section) section.appendChild(element);
  const backup = document.getElementById("backupAdmin");
  if (section.parentNode !== panel) {
    if (backup && backup.parentNode === panel) panel.insertBefore(section, backup);
    else panel.appendChild(section);
  }
  renderSettingsSubnav();
  if (options && options.show) showSettingsSection(section.id);
  return section;
}

/* Marks sub-nav entries whose section has unsaved edits or errors. */
function updateSettingsSectionDots() {
  if (typeof changedSettingsKeys !== "function") return;
  const changed = new Set(changedSettingsKeys().map((k) => `s-${k}`));
  if (typeof currentHeroPhotoFile !== "undefined" && (currentHeroPhotoFile || currentLogoPhotoFile)) changed.add("s-hero_image");
  if (typeof currentOgImageFile !== "undefined" && (currentOgImageFile || ogImageCleared)) changed.add("s-seo_og_image_file");
  document.querySelectorAll("#settingsForm > fieldset[data-settings-section]").forEach((fs) => {
    const btn = document.querySelector(`#settingsSubnav [data-settings-page="${fs.dataset.settingsSection}"]`);
    if (!btn) return;
    const dirty = Array.from(fs.querySelectorAll("input[id], textarea[id]")).some((i) => changed.has(i.id));
    const invalid = !!fs.querySelector(".field.has-error");
    btn.classList.toggle("is-dirty", dirty && !invalid);
    btn.classList.toggle("is-invalid", invalid);
  });
}

/* ===== Sticky save bar & keyboard shortcut ===== */

function updateSettingsSaveBar() {
  const bar = document.getElementById("settingsSaveBar");
  if (!bar || typeof settingsFormIsDirty !== "function") return;
  const dirty = settingsFormIsDirty();
  bar.hidden = !dirty;
  const panel = settingsPanelEl();
  if (panel) panel.classList.toggle("has-savebar", dirty);
  const text = bar.querySelector(".settings-savebar-text");
  if (dirty && text) {
    let n = changedSettingsKeys().length;
    if (currentHeroPhotoFile) n++;
    if (currentLogoPhotoFile) n++;
    if (currentOgImageFile || ogImageCleared) n++;
    text.lastChild.textContent = n > 1 ? `${n} unsaved changes` : "Unsaved changes";
  }
  updateSettingsSectionDots();
}

function submitSettingsForm() {
  const form = document.getElementById("settingsForm");
  if (!form) return;
  if (typeof form.requestSubmit === "function") form.requestSubmit();
  else handleSaveSettings(null);
}

function isPanelVisible(id) {
  const el = document.getElementById(id);
  const dash = document.getElementById("dashboardView");
  return !!el && !el.hidden && !!dash && !dash.hidden;
}

/* ===== Theme colours: hex boxes, mini preview, contrast ===== */

const SITE_BACKGROUND = "#fffdf9"; // --background in css/styles.css (not editable)

function parseHexColor(v) {
  let s = String(v || "").trim().toLowerCase();
  if (!s.startsWith("#")) s = "#" + s;
  if (/^#[0-9a-f]{3}$/.test(s)) s = "#" + s.slice(1).split("").map((c) => c + c).join("");
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

function relativeLuminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function themeValue(key) {
  const input = document.getElementById(`s-${key}`);
  return (input && parseHexColor(input.value)) || "#000000";
}

function syncThemeHexBoxes() {
  document.querySelectorAll("#settingsForm .settings-hex").forEach((hex) => {
    const color = document.getElementById(hex.dataset.hexFor);
    if (color && document.activeElement !== hex) {
      hex.value = color.value;
      if (typeof setSettingsFieldMessage === "function") setSettingsFieldMessage(hex, { error: "", warning: "" });
    }
  });
}

function updateThemePreview() {
  const preview = document.getElementById("themePreview");
  const note = document.getElementById("themeContrastNote");
  if (!preview || !note) return;
  const c = {
    coral: themeValue("theme_coral"),
    blush: themeValue("theme_blush"),
    blue: themeValue("theme_baby_blue"),
    yellow: themeValue("theme_soft_yellow"),
    brown: themeValue("theme_brown")
  };
  preview.style.setProperty("--tp-coral", c.coral);
  preview.style.setProperty("--tp-blush", c.blush);
  preview.style.setProperty("--tp-blue", c.blue);
  preview.style.setProperty("--tp-yellow", c.yellow);
  preview.style.setProperty("--tp-brown", c.brown);
  preview.style.setProperty("--tp-bg", SITE_BACKGROUND);

  const checks = [
    { label: "Text on page background", ratio: contrastRatio(c.brown, SITE_BACKGROUND) },
    { label: "Text on blush", ratio: contrastRatio(c.brown, c.blush) },
    { label: "Button text on accent", ratio: contrastRatio(c.brown, c.coral) }
  ];
  const failing = checks.filter((k) => k.ratio < 4.5);
  note.className = `settings-contrast ${failing.length ? "is-warning" : "is-ok"}`;
  note.innerHTML = `
    <p class="settings-contrast-head">${failing.length
      ? `<strong>Hard to read:</strong> ${escapeHtml(failing.map((f) => f.label.toLowerCase()).join(", "))} ${failing.length === 1 ? "is" : "are"} below the recommended 4.5 : 1 contrast.`
      : "Text contrast looks good."}</p>
    <ul>${checks.map((k) => `<li class="${k.ratio < 4.5 ? "fail" : "pass"}"><span>${escapeHtml(k.label)}</span><span>${k.ratio.toFixed(1)} : 1</span></li>`).join("")}</ul>
  `;
}

/* ===== SEO counters + snippet preview ===== */

function updateSeoField(input) {
  const limit = Number(input.dataset.seoCounter) || 0;
  const counter = document.querySelector(`.seo-counter[data-counter-for="${input.id}"]`);
  const len = input.value.trim().length;
  if (counter) {
    counter.textContent = len ? `${len} / ${limit} characters${len > limit ? " (may be cut off)" : ""}` : `Using the built-in text. Aim for up to ${limit} characters.`;
    counter.classList.toggle("is-over", len > limit);
  }
  const page = input.closest("[data-seo-page]");
  if (page) updateSeoSnippet(page);
}

function updateSeoSnippet(page) {
  const key = page.dataset.seoPage;
  const titleInput = document.getElementById(`s-seo_${key}_title`);
  const descInput = document.getElementById(`s-seo_${key}_description`);
  const snippet = page.querySelector(".seo-snippet");
  if (!titleInput || !descInput || !snippet) return;
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
  const title = titleInput.value.trim() || titleInput.placeholder;
  const desc = descInput.value.trim() || descInput.placeholder;
  snippet.querySelector(".seo-snippet-title").textContent = cut(title, SEO_TITLE_LIMIT);
  snippet.querySelector(".seo-snippet-desc").textContent = cut(desc, SEO_DESCRIPTION_LIMIT);
  const state = page.querySelector(".seo-page-state");
  const custom = !!(titleInput.value.trim() || descInput.value.trim());
  if (state) {
    state.textContent = custom ? "Custom" : "Built-in";
    state.classList.toggle("is-custom", custom);
    state.classList.toggle("a-badge--accent", custom);
    state.classList.toggle("a-badge--neutral", !custom);
  }
  const count = page.querySelector(".seo-page-count");
  if (count) {
    const tl = title.length, dl = desc.length;
    count.textContent = `Title ${tl}/${SEO_TITLE_LIMIT} · Description ${dl}/${SEO_DESCRIPTION_LIMIT}`;
    count.classList.toggle("is-over", tl > SEO_TITLE_LIMIT || dl > SEO_DESCRIPTION_LIMIT);
  }
}

function updateAllSeoFields() {
  document.querySelectorAll("#seoPagesContainer [data-seo-counter]").forEach(updateSeoField);
}

/* ===== Preview (unsaved settings on the public site) =====
   The draft goes to localStorage (a new tab doesn't share sessionStorage)
   under SETTINGS_PREVIEW_STORAGE_KEY; js/site-content.js applies it only
   when the page is opened with ?preview=1 and the draft is under 2 hours
   old, and shows a "Preview — not saved" ribbon. */
const SETTINGS_PREVIEW_STORAGE_KEY = "aura-settings-preview";

function previewImageFrom(previewId) {
  const img = document.querySelector(`#${previewId} img`);
  const src = img && img.getAttribute("src");
  return src && src.startsWith("data:") ? src : null;
}

function buildSettingsPreviewDraft() {
  const values = {};
  changedSettingsKeys().forEach((key) => {
    const input = document.getElementById(`s-${key}`);
    values[key] = typeof normalizeSettingValue === "function" ? String(normalizeSettingValue(key, input.value)).trim() : input.value;
  });
  // Staged photos only exist as data: URLs in the previews; include them
  // when they're small enough to fit in storage.
  const images = [
    [currentHeroPhotoFile, "heroPhotoPreview", "hero_image_url"],
    [currentLogoPhotoFile, "logoPhotoPreview", "logo_url"],
    [currentOgImageFile, "ogImagePreview", "seo_og_image"]
  ];
  let skippedImages = 0;
  images.forEach(([file, previewId, key]) => {
    if (!file) return;
    const data = previewImageFrom(previewId);
    if (data && data.length < 2.5 * 1024 * 1024) values[key] = data;
    else skippedImages++;
  });
  if (ogImageCleared) values.seo_og_image = "";
  return { values, skippedImages };
}

function previewTargetPage() {
  const map = { about: "about.html" };
  return map[settingsActivePage] || "index.html";
}

function openSettingsPreview() {
  const status = document.getElementById("settingsFormStatus");
  const page = previewTargetPage();
  if (typeof settingsFormIsDirty !== "function" || !settingsFormIsDirty()) {
    window.open(page, "_blank", "noopener");
    if (status) { status.textContent = "No unsaved changes, so that's the live site."; status.className = "form-status"; }
    return;
  }
  const { values, skippedImages } = buildSettingsPreviewDraft();
  const draft = JSON.stringify({ savedAt: Date.now(), values });
  let stored = false;
  try {
    localStorage.setItem(SETTINGS_PREVIEW_STORAGE_KEY, draft);
    stored = true;
  } catch (e) {
    // Probably over quota because of a big photo: retry without photos.
    try {
      const textOnly = {};
      Object.keys(values).forEach((k) => { if (!String(values[k]).startsWith("data:")) textOnly[k] = values[k]; });
      localStorage.setItem(SETTINGS_PREVIEW_STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), values: textOnly }));
      stored = true;
    } catch (e2) { /* storage blocked */ }
  }
  if (!stored) {
    if (status) { status.textContent = "This browser blocked the preview (storage is turned off). Save to see your changes on the site."; status.className = "form-status error"; }
    return;
  }
  window.open(`${page}?preview=1`, "_blank", "noopener");
  if (status) {
    status.textContent = skippedImages ? "Preview opened in a new tab (new photos are too big to preview, they show after saving)." : "Preview opened in a new tab. Nothing is live until you save.";
    status.className = "form-status";
  }
}

/* ===== Wiring ===== */

onAdminInit(() => {
  const panel = settingsPanelEl();
  const form = document.getElementById("settingsForm");
  if (!panel || !form) return;

  window.addSettingsSection = addSettingsSection;
  window.showSettingsSection = showSettingsSection;

  renderSettingsSubnav();
  document.getElementById("settingsSubnav").addEventListener("click", (e) => {
    const b = e.target.closest("[data-settings-page]");
    if (b) showSettingsSection(b.dataset.settingsPage);
  });
  // Cards other scripts append (now or later) get a sub-nav entry.
  let pending = false;
  new MutationObserver((mutations) => {
    if (!mutations.some((m) => Array.from(m.addedNodes).concat(Array.from(m.removedNodes)).some((n) => n.nodeType === 1 && !n.hasAttribute("data-settings-own")))) return;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; renderSettingsSubnav(); });
  }).observe(panel, { childList: true });

  // Save bar
  document.addEventListener("admin-settings-changed", () => {
    updateSettingsSaveBar();
    syncThemeHexBoxes();
    updateThemePreview();
    updateAllSeoFields();
  });
  document.addEventListener("admin-settings-saving", (e) => {
    const btn = document.getElementById("settingsSaveBarBtn");
    if (!btn) return;
    btn.disabled = !!e.detail.saving;
    btn.textContent = e.detail.saving ? "Saving..." : "Save";
  });
  document.getElementById("settingsSaveBarBtn").addEventListener("click", submitSettingsForm);
  document.getElementById("settingsDiscardBtn").addEventListener("click", async () => {
    if (!(await adminConfirm({ title: "Discard unsaved changes?", message: "Discard all unsaved changes in Settings?", confirmLabel: "Discard changes", danger: true }))) return;
    discardSettingsChanges();
  });
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
  document.getElementById("settingsSaveBarBtn").title = `Save (${isMac ? "⌘" : "Ctrl"}+S)`;

  // Ctrl/Cmd+S on the Settings or FAQ tab.
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || String(e.key).toLowerCase() !== "s") return;
    if (isPanelVisible("settingsPanel")) {
      e.preventDefault();
      if (typeof settingsFormIsDirty === "function" && settingsFormIsDirty()) submitSettingsForm();
    } else if (isPanelVisible("faqPanel")) {
      e.preventDefault();
      const faqForm = document.getElementById("faqForm");
      if (faqForm && typeof faqFormIsDirty === "function" && faqFormIsDirty()) {
        if (typeof faqForm.requestSubmit === "function") faqForm.requestSubmit();
      }
    }
  });

  // Theme colours
  form.querySelectorAll(".settings-hex").forEach((hex) => {
    hex.id = hex.id || `hex-${hex.dataset.hexFor}`;
    hex.addEventListener("input", () => {
      const color = document.getElementById(hex.dataset.hexFor);
      const parsed = parseHexColor(hex.value);
      if (parsed && color) {
        color.value = parsed;
        setSettingsFieldMessage(hex, { error: "", warning: "" });
        notifySettingsChanged();
      } else if (hex.value.trim().length >= 4) {
        setSettingsFieldMessage(hex, { error: "Use a hex colour like #ff7f7f.", warning: "" });
        updateSettingsSectionDots();
      }
    });
    hex.addEventListener("blur", () => {
      const parsed = parseHexColor(hex.value);
      if (parsed) hex.value = parsed;
      else if (!hex.value.trim()) syncThemeHexBoxes();
      else setSettingsFieldMessage(hex, { error: "Use a hex colour like #ff7f7f.", warning: "" });
    });
  });
  syncThemeHexBoxes();
  updateThemePreview();

  // SEO
  updateAllSeoFields();
  const seo = document.getElementById("seoPagesContainer");
  if (seo) seo.addEventListener("input", (e) => { if (e.target.dataset.seoCounter) updateSeoField(e.target); });

  document.getElementById("settingsPreviewBtn").addEventListener("click", openSettingsPreview);
});
