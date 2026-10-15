/* Admin theme: Light / Dark / System, with a small cycle button in the header.
   Loaded before js/admin-core.js. Classic script, no deps.

   window.adminTheme = { get, set }
     get()      -> "light" | "dark" | "system"   (the saved preference, default "system")
     set(mode)  -> saves it, applies it, updates the button and fires the
                   "admin-theme-changed" CustomEvent on document
                   (detail: { mode, resolved }) where resolved is "light" or "dark".

   How it applies: "light" and "dark" set data-theme on <html> (css/admin-tokens.css
   reads it); "system" removes the attribute so prefers-color-scheme decides.
   The inline script in admin.html <head> does the same from localStorage before
   first paint so there is no flash of the wrong theme. Storage key: adminTheme. */
(function () {
  "use strict";

  var KEY = "adminTheme";
  var MODES = ["system", "light", "dark"];
  var LABELS = { system: "System", light: "Light", dark: "Dark" };
  var ICONS = {
    light: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
    dark: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    system: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'
  };

  var root = document.documentElement;
  var mql = null;
  try { mql = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null; } catch (e) { mql = null; }
  var button = null;

  function read() {
    try {
      var v = window.localStorage.getItem(KEY);
      return MODES.indexOf(v) !== -1 ? v : "system";
    } catch (e) { return "system"; }
  }
  var current = read();

  function resolved(mode) {
    if (mode === "light" || mode === "dark") return mode;
    return mql && mql.matches ? "dark" : "light";
  }

  function apply(mode) {
    try {
      if (mode === "system") {
        root.removeAttribute("data-theme");
        root.style.colorScheme = "";
      } else {
        root.setAttribute("data-theme", mode);
        root.style.colorScheme = mode;
      }
    } catch (e) { /* non-browser stub */ }
  }

  function nextMode(mode) { return MODES[(MODES.indexOf(mode) + 1) % MODES.length]; }

  function paintButton() {
    if (!button) return;
    var next = nextMode(current);
    var svg = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[current] + "</svg>";
    button.innerHTML = svg + '<span class="admin-theme-label">' + LABELS[current] + "</span>";
    button.setAttribute("aria-label", "Theme: " + LABELS[current] + ". Switch to " + LABELS[next]);
    button.setAttribute("title", "Theme: " + LABELS[current] + " (click for " + LABELS[next] + ")");
    button.setAttribute("data-mode", current);
  }

  function announce() {
    try {
      document.dispatchEvent(new CustomEvent("admin-theme-changed", { detail: { mode: current, resolved: resolved(current) } }));
    } catch (e) { /* old browser */ }
  }

  function get() { return current; }

  function set(mode) {
    if (MODES.indexOf(mode) === -1) mode = "system";
    current = mode;
    try { window.localStorage.setItem(KEY, mode); } catch (e) { /* private mode: still applies for this visit */ }
    apply(mode);
    paintButton();
    announce();
  }

  function mount() {
    var slot = document.getElementById("adminThemeSlot");
    if (!slot || button) return;
    button = document.createElement("button");
    button.type = "button";
    button.id = "adminThemeBtn";
    button.className = "btn btn-ghost admin-theme-btn";
    button.addEventListener("click", function () { set(nextMode(current)); });
    slot.appendChild(button);
    paintButton();
  }

  // Keep the page in sync if the OS theme flips while "system" is selected.
  if (mql) {
    var onChange = function () { if (current === "system") announce(); };
    if (mql.addEventListener) mql.addEventListener("change", onChange);
    else if (mql.addListener) mql.addListener(onChange);
  }

  apply(current);
  mount();

  window.adminTheme = { get: get, set: set };
})();
