/*
  Admin page core (admin.html). Talks directly to Supabase from the browser —
  there's no custom backend server. Real security comes from Supabase's Row
  Level Security policies (see supabase-setup.sql): anyone can read products,
  but only a logged-in user can write. The admin scripts just have to not
  trust anything the page itself claims — hence escapeHtml() on every field
  when rendering lists.

  The admin page is split into classic scripts that share one global scope
  (top-level functions and `let`s are visible to every later script), loaded
  in this order by admin.html:
    js/admin-core.js         shared helpers, auth, tab registry, init hooks,
                             image compression, photo preview lightbox
    js/admin-collections.js  Categories tab + collectionsCache
    js/admin-products.js     Products tab (list, form, bulk actions, photos)
    js/admin-library.js      Photo library tab + picker modal + unused scan
    js/admin-nav.js          Nav tab
    js/admin-faq.js          FAQ tab
    js/admin-settings.js     Settings tab
    js/admin-orders.js       Orders tab
    js/admin-analytics.js    Analytics tab
    js/admin-backup.js, js/admin-availability.js,
    js/admin-delivery-areas.js, js/admin-gallery.js  (IIFE modules)
    js/admin-overview.js     Overview (default landing) tab

  How a feature file hooks in:
    registerAdminTab(key, { btnId, panelId, onEnter, label, group, icon,
        order, badgeId })                              — adds a tab; the
        grouped nav is built from the registry (see "Tab registry" below
        and docs/admin-dashboard.md)
    adminNavigate(tab, params) / switchTab(tab, params) — deep link;
        params reach the tab's onEnter(params) and the URL hash
    registerAdminTabParamHandler(key, fn(params))      — prepare a tab for
        deep-link params before its onEnter runs
    setTabBadge(key, n)                                — tab count badge
    onAdminInit((client) => { ...addEventListener... }) — wires its DOM,
        run once on DOMContentLoaded, only when Supabase is configured,
        before the login session is checked
    registerAdminDirtyCheck(() => boolean)             — unsaved-changes
        check used by Log out and the beforeunload prompt
*/

/* ===== Registries (tabs, init hooks, unsaved-changes checks) ===== */

/* ===== Tab registry + navigation shell =====
   key -> { btnId, panelId, onEnter, label, group, icon, order, badgeId }.
   Each feature file adds its own tab with registerAdminTab(); the nav
   (desktop sidebar / mobile group bar + chips, see css/admin-shell.css) is
   BUILT FROM THIS REGISTRY by renderAdminNav(), so a new tab only needs
   registerAdminTab() + its panel element — no nav markup to edit.

   Options (all optional except panelId):
     btnId    id for the tab button. Reused if an element with that id is
              already in the page (it is moved into the nav), otherwise
              created. Default `tab<Key>Btn`.
     panelId  id of the panel element (role=tabpanel is added to it).
     onEnter  (params) => void, run every time the tab is shown. `params`
              is the object passed to switchTab/adminNavigate, or parsed
              from the URL hash (#orders?status=new), or undefined.
     label    button text. Default: ADMIN_TAB_DEFAULTS, else the existing
              button's text, else the key capitalised.
     group    "overview" | "sales" | "catalog" | "site" | any new key (a
              new group is appended to the nav). Unknown tabs go to "site".
     icon     a key of ADMIN_ICONS (default "dot").
     order    sort position inside the group (lower first).
     badgeId  id of a count badge <span> in the button — set it with
              setTabBadge(key, n) (or write to the element directly, as
              js/admin-orders.js does with #ordersBadge); group totals in
              the mobile bar follow automatically. */
const TABS = {};

const ADMIN_NAV_GROUPS = [
  { key: "overview", label: "Overview", icon: "home" },
  { key: "sales", label: "Sales", icon: "receipt" },
  { key: "catalog", label: "Catalog", icon: "tag" },
  { key: "site", label: "Site", icon: "globe" }
];

/* Labels/groups for the tabs registered by files that predate the grouped
   nav (their registerAdminTab calls only pass btnId/panelId/onEnter). */
const ADMIN_TAB_DEFAULTS = {
  overview:    { label: "Overview",    group: "overview", icon: "home",    order: 0 },
  orders:      { label: "Orders",      group: "sales",    icon: "receipt", order: 10, badgeId: "ordersBadge" },
  analytics:   { label: "Analytics",   group: "sales",    icon: "chart",   order: 20 },
  delivery:    { label: "Delivery",    group: "sales",    icon: "truck",   order: 30 },
  products:    { label: "Products",    group: "catalog",  icon: "box",     order: 10 },
  collections: { label: "Collections", group: "catalog",  icon: "folder",  order: 20 },
  library:     { label: "Library",     group: "catalog",  icon: "image",   order: 30 },
  gallery:     { label: "Gallery",     group: "site",     icon: "camera",  order: 10 },
  nav:         { label: "Nav",         group: "site",     icon: "list",    order: 20 },
  faq:         { label: "FAQ",         group: "site",     icon: "help",    order: 30 },
  settings:    { label: "Settings",    group: "site",     icon: "gear",    order: 40 }
};

/* 24x24 stroke icons (currentColor). Feature files may add their own:
   ADMIN_ICONS.trash = '<path .../>' before DOMContentLoaded. */
const ADMIN_ICONS = {
  home: '<path d="M4 11l8-7 8 7"/><path d="M6 10v9h12v-9"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  truck: '<path d="M2 6h12v10H2zM14 10h4l3 3v3h-7"/><circle cx="6" cy="18" r="1.8"/><circle cx="17" cy="18" r="1.8"/>',
  box: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
  folder: '<path d="M3 6h6l2 2h10v11H3z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-9 9"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  list: '<path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  dot: '<circle cx="12" cy="12" r="3"/>'
};

function adminIconSvg(name, size) {
  const s = size || 18;
  return `<svg class="admin-icon" viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ADMIN_ICONS[name] || ADMIN_ICONS.dot}</svg>`;
}

let adminTabRegisterCount = 0;
let adminNavBuilt = false;
let currentAdminTab = null;
const adminLastTabInGroup = {};
const adminTabParamHandlers = {};
let adminLastRoutedHash = null;

function registerAdminTab(key, opts) {
  if (TABS[key]) throw new Error(`Admin tab "${key}" is registered twice`);
  const o = opts || {};
  const d = ADMIN_TAB_DEFAULTS[key] || {};
  const pick = (name, fallback) => (o[name] != null ? o[name] : d[name] != null ? d[name] : fallback);
  TABS[key] = {
    btnId: o.btnId || `tab${key.charAt(0).toUpperCase()}${key.slice(1)}Btn`,
    panelId: o.panelId,
    onEnter: o.onEnter,
    label: pick("label", null),
    group: pick("group", "site"),
    icon: pick("icon", "dot"),
    order: pick("order", 100 + adminTabRegisterCount),
    badgeId: pick("badgeId", null),
    seq: adminTabRegisterCount++
  };
  if (adminNavBuilt) renderAdminNav();
}

/* Lets a file prepare a tab for deep-link params before its onEnter runs,
   without having to own that tab's registerAdminTab() call (e.g. the
   Overview sets the Orders status filter). fn(params) runs only when
   params is a non-empty object. */
function registerAdminTabParamHandler(key, fn) {
  (adminTabParamHandlers[key] || (adminTabParamHandlers[key] = [])).push(fn);
}

function adminDefaultTab() {
  if (TABS.overview) return "overview";
  return adminSortedTabKeys()[0] || null;
}

function adminGroupList() {
  const groups = ADMIN_NAV_GROUPS.slice();
  Object.keys(TABS).forEach((key) => {
    const g = TABS[key].group;
    if (!groups.some((x) => x.key === g)) groups.push({ key: g, label: g.charAt(0).toUpperCase() + g.slice(1), icon: "dot" });
  });
  return groups.filter((g) => Object.keys(TABS).some((k) => TABS[k].group === g.key));
}

function adminTabsInGroup(groupKey) {
  return Object.keys(TABS)
    .filter((k) => TABS[k].group === groupKey)
    .sort((a, b) => (TABS[a].order - TABS[b].order) || (TABS[a].seq - TABS[b].seq));
}

function adminSortedTabKeys() {
  return adminGroupList().flatMap((g) => adminTabsInGroup(g.key));
}

/* Builds (or rebuilds, idempotently) the tab buttons inside #adminTabList
   and the group buttons inside #adminBottomBar from TABS. */
function renderAdminNav() {
  const list = document.getElementById("adminTabList");
  if (!list) return;
  adminNavBuilt = true;
  const groups = adminGroupList();
  const bottom = document.getElementById("adminBottomBar");

  const frag = document.createDocumentFragment();
  groups.forEach((g) => {
    const wrap = document.createElement("div");
    wrap.className = "admin-nav-group";
    wrap.dataset.group = g.key;
    wrap.setAttribute("role", "presentation");
    const tabs = adminTabsInGroup(g.key);
    if (tabs.length === 1) wrap.classList.add("is-single");
    const heading = document.createElement("div");
    heading.className = "admin-nav-heading";
    heading.setAttribute("aria-hidden", "true");
    heading.textContent = g.label;
    wrap.appendChild(heading);
    tabs.forEach((key) => wrap.appendChild(adminTabButton(key)));
    frag.appendChild(wrap);
  });
  list.innerHTML = "";
  list.appendChild(frag);

  if (bottom) {
    bottom.innerHTML = groups.map((g) => `
      <button type="button" class="admin-bottom-btn" data-group="${escapeHtml(g.key)}">
        <span class="admin-bottom-icon">${adminIconSvg(g.icon, 22)}<span class="a-badge a-badge--count admin-tab-badge admin-group-badge" hidden></span></span>
        <span class="admin-bottom-label">${escapeHtml(g.label)}</span>
      </button>`).join("");
    bottom.querySelectorAll(".admin-bottom-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const g = btn.dataset.group;
        const keys = adminTabsInGroup(g);
        const target = keys.includes(adminLastTabInGroup[g]) ? adminLastTabInGroup[g] : keys[0];
        if (target && target !== currentAdminTab) switchTab(target);
      });
    });
  }

  Object.keys(TABS).forEach((key) => {
    const panel = document.getElementById(TABS[key].panelId);
    if (!panel) return;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", TABS[key].btnId);
    if (!panel.hasAttribute("tabindex")) panel.setAttribute("tabindex", "-1");
  });
  adminSyncNavState();
  adminSyncGroupBadges();
}

function adminTabButton(key) {
  const t = TABS[key];
  let btn = document.getElementById(t.btnId);
  if (!btn) {
    btn = document.createElement("button");
    btn.type = "button";
    btn.id = t.btnId;
    const label = t.label || key.charAt(0).toUpperCase() + key.slice(1);
    const hasBadgeEl = t.badgeId && document.getElementById(t.badgeId);
    btn.innerHTML = `${adminIconSvg(t.icon)}<span class="admin-tab-label">${escapeHtml(label)}</span>${t.badgeId && !hasBadgeEl ? `<span class="a-badge a-badge--count admin-tab-badge" id="${escapeHtml(t.badgeId)}" hidden>0</span>` : ""}`;
  } else if (!t.label) {
    t.label = btn.textContent.trim();
  }
  btn.classList.add("admin-tab");
  btn.dataset.tab = key;
  btn.setAttribute("role", "tab");
  if (t.panelId) btn.setAttribute("aria-controls", t.panelId);
  if (!btn.dataset.navWired) {
    btn.dataset.navWired = "1";
    btn.addEventListener("click", () => switchTab(key));
  }
  if (t.badgeId) adminObserveBadge(t.badgeId);
  return btn;
}

/* Group badge in the mobile bar = sum of its tabs' visible badges. Badges
   are watched rather than routed through an API so files that write to
   their badge element directly (js/admin-orders.js) keep working. */
const adminObservedBadges = new Set();
let adminBadgeObserver = null;
function adminObserveBadge(id) {
  const el = document.getElementById(id);
  if (!el || adminObservedBadges.has(el) || typeof MutationObserver !== "function") return;
  if (!adminBadgeObserver) adminBadgeObserver = new MutationObserver(adminSyncGroupBadges);
  adminObservedBadges.add(el);
  adminBadgeObserver.observe(el, { attributes: true, attributeFilter: ["hidden"], childList: true, characterData: true, subtree: true });
}

function adminSyncGroupBadges() {
  document.querySelectorAll("#adminBottomBar .admin-bottom-btn").forEach((btn) => {
    const total = adminTabsInGroup(btn.dataset.group).reduce((sum, key) => {
      const el = TABS[key].badgeId && document.getElementById(TABS[key].badgeId);
      const n = el && !el.hidden ? parseInt(el.textContent, 10) : 0;
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0);
    const badge = btn.querySelector(".admin-group-badge");
    badge.textContent = total > 99 ? "99+" : String(total);
    badge.hidden = total <= 0;
    const label = btn.querySelector(".admin-bottom-label").textContent;
    btn.setAttribute("aria-label", total > 0 ? `${label} (${total} new)` : label);
  });
}

/* Sets a tab's count badge; 0/null hides it. */
function setTabBadge(key, n) {
  const t = TABS[key];
  if (!t || !t.badgeId) return;
  let el = document.getElementById(t.badgeId);
  if (!el) {
    const btn = document.getElementById(t.btnId);
    if (!btn) return;
    el = document.createElement("span");
    el.className = "a-badge a-badge--count admin-tab-badge";
    el.id = t.badgeId;
    btn.appendChild(el);
    adminObserveBadge(t.badgeId);
  }
  const count = Number(n) || 0;
  el.textContent = String(count);
  el.hidden = count <= 0;
  adminSyncGroupBadges();
}

function adminSyncNavState() {
  const activeGroup = currentAdminTab && TABS[currentAdminTab] ? TABS[currentAdminTab].group : null;
  Object.keys(TABS).forEach((key) => {
    const { btnId, panelId } = TABS[key];
    const active = key === currentAdminTab;
    const btn = document.getElementById(btnId);
    if (btn) {
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", String(active));
      btn.tabIndex = active ? 0 : -1;
    }
    const panel = document.getElementById(panelId);
    if (panel && currentAdminTab) panel.hidden = !active;
  });
  // Nothing selected yet (before the first switchTab): keep the first
  // tab reachable with Tab.
  if (!currentAdminTab) {
    const first = document.querySelector("#adminTabList [role=tab]");
    if (first) first.tabIndex = 0;
  }
  document.querySelectorAll("#adminTabList .admin-nav-group").forEach((g) => {
    g.classList.toggle("is-active-group", g.dataset.group === activeGroup);
  });
  document.querySelectorAll("#adminBottomBar .admin-bottom-btn").forEach((b) => {
    const on = b.dataset.group === activeGroup;
    b.classList.toggle("active", on);
    if (on) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  const nav = document.getElementById("adminNav");
  if (nav) nav.classList.toggle("is-single-group", adminTabsInGroup(activeGroup).length <= 1);
}

/* ----- Hash routing: admin.html#orders, #orders?status=new ----- */
function adminHashFor(tab, params) {
  let q = "";
  if (params && typeof params === "object") {
    const sp = new URLSearchParams();
    Object.keys(params).forEach((k) => {
      const v = params[k];
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") sp.set(k, String(v));
    });
    q = sp.toString();
  }
  return `#${tab}${q ? "?" + q : ""}`;
}

function parseAdminHash(hash) {
  const raw = String(hash || "").replace(/^#/, "");
  const qi = raw.indexOf("?");
  const tab = decodeURIComponent(qi === -1 ? raw : raw.slice(0, qi));
  let params;
  if (qi !== -1) {
    params = {};
    new URLSearchParams(raw.slice(qi + 1)).forEach((v, k) => { params[k] = v; });
    if (!Object.keys(params).length) params = undefined;
  }
  return { tab, params };
}

/* Shows one tab. `params` (optional) goes to the tab's param handlers and
   onEnter. opts.history: "push" (default) | "replace" | false — how the
   URL hash is updated. Unknown tab -> the default tab (Overview). */
function switchTab(tab, params, opts) {
  const o = opts || {};
  if (!TABS[tab]) tab = adminDefaultTab();
  if (!tab) return;
  const changed = tab !== currentAdminTab;
  currentAdminTab = tab;
  adminLastTabInGroup[TABS[tab].group] = tab;
  adminSyncNavState();

  if (o.history !== false && typeof history !== "undefined" && history.pushState) {
    const hash = adminHashFor(tab, params);
    if (location.hash !== hash) {
      try {
        if (o.history === "replace") history.replaceState(null, "", hash);
        else history.pushState(null, "", hash);
      } catch (e) { /* file:// or sandboxed — routing just won't persist */ }
    }
  }
  adminLastRoutedHash = typeof location !== "undefined" ? location.hash : "";
  if (changed && o.scroll !== false && typeof window.scrollTo === "function") {
    const dash = document.getElementById("dashboardView");
    if (dash && dash.getBoundingClientRect().top < 0) window.scrollTo(0, 0);
  }

  const hasParams = params && typeof params === "object" && Object.keys(params).length > 0;
  if (hasParams) {
    (adminTabParamHandlers[tab] || []).forEach((fn) => {
      try { fn(params); } catch (err) { console.error(err); }
    });
  }
  const entry = TABS[tab];
  if (entry && entry.onEnter) entry.onEnter(hasParams ? params : undefined);
}

/* Deep link from anywhere: adminNavigate("orders", { status: "new" }). */
function adminNavigate(tab, params) {
  switchTab(tab, params);
}
window.adminNavigate = adminNavigate;

/* Opens the tab named by the URL hash (falls back to Overview). Called
   by enterDashboard() once the dashboard is visible, and on Back/Forward. */
function adminRouteFromHash(opts) {
  const { tab, params } = parseAdminHash(location.hash);
  const target = TABS[tab] ? tab : adminDefaultTab();
  switchTab(target, TABS[tab] ? params : undefined, { history: (opts && opts.history) != null ? opts.history : "replace" });
}

function adminOnHistoryNav() {
  const dash = document.getElementById("dashboardView");
  if (!dash || dash.hidden) return;
  // popstate and hashchange both fire for one manual hash edit.
  if (location.hash === adminLastRoutedHash) return;
  const { tab } = parseAdminHash(location.hash);
  adminRouteFromHash({ history: TABS[tab] ? false : "replace" });
}

/* Roving tabindex + Arrow/Home/End over the VISIBLE tabs (on phones only
   the current group's chips are visible). Manual activation: arrows move
   focus, Enter/Space opens the tab (several tabs fetch on open). */
function adminTabListKeydown(e) {
  const tabs = [...document.querySelectorAll("#adminTabList [role=tab]")].filter((t) => t.offsetParent !== null || t.getClientRects().length);
  const i = tabs.indexOf(document.activeElement);
  if (i === -1) return;
  let next = null;
  if (e.key === "ArrowDown" || e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
  else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
  else if (e.key === "Home") next = tabs[0];
  else if (e.key === "End") next = tabs[tabs.length - 1];
  if (!next) return;
  e.preventDefault();
  tabs.forEach((t) => { t.tabIndex = t === next ? 0 : -1; });
  next.focus();
}

/* Sidebar + bottom bar follow #dashboardView's visibility (the auth code
   shows/hides only that element). */
function adminSyncShellVisibility() {
  const dash = document.getElementById("dashboardView");
  const on = !!dash && !dash.hidden;
  ["adminNav", "adminBottomBar"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.hidden = !on;
  });
  document.body.classList.toggle("admin-signed-in", on);
}

function initAdminShell() {
  renderAdminNav();
  const list = document.getElementById("adminTabList");
  if (list) list.addEventListener("keydown", adminTabListKeydown);
  window.addEventListener("popstate", adminOnHistoryNav);
  window.addEventListener("hashchange", adminOnHistoryNav);
  const skip = document.getElementById("adminSkipLink");
  if (skip) {
    // Never let the skip link write "#adminMain" into the hash router.
    skip.addEventListener("click", (e) => {
      e.preventDefault();
      const dash = document.getElementById("dashboardView");
      const panel = currentAdminTab && dash && !dash.hidden ? document.getElementById(TABS[currentAdminTab].panelId) : null;
      const target = panel || document.getElementById("adminMain");
      if (target) target.focus();
    });
  }
  const dash = document.getElementById("dashboardView");
  if (dash && typeof MutationObserver === "function") {
    new MutationObserver(adminSyncShellVisibility).observe(dash, { attributes: true, attributeFilter: ["hidden"] });
  }
  adminSyncShellVisibility();
}

/* Functions run (in script load order) from the DOMContentLoaded handler at
   the bottom of this file, after the Supabase-configured check and before
   the session check. Each receives the Supabase client. */
const adminInitHooks = [];
function onAdminInit(fn) { adminInitHooks.push(fn); }

/* Each returns true when its form has unsaved edits. Checked (in script
   load order) on Log out and before the page unloads. */
const adminDirtyChecks = [];
function registerAdminDirtyCheck(fn) { adminDirtyChecks.push(fn); }
function anyAdminFormDirty() { return adminDirtyChecks.some((fn) => fn()); }

/* ===== Helpers ===== */

const HTML_ESCAPE_MAP = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
};
function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => HTML_ESCAPE_MAP[c]);
}

/* Row-locking (prevents an accidental drag) is a per-browser UI safety
   net, not business data, so it lives in localStorage rather than a new
   Supabase column — nothing to sync, nothing that breaks if it's empty. */
function lockStorageKey(listName, id) {
  return `admin-row-locked:${listName}:${id}`;
}
function isRowLocked(listName, id) {
  try { return localStorage.getItem(lockStorageKey(listName, id)) === "1"; } catch (e) { return false; }
}
function setRowLocked(listName, id, locked) {
  try {
    if (locked) localStorage.setItem(lockStorageKey(listName, id), "1");
    else localStorage.removeItem(lockStorageKey(listName, id));
  } catch (e) { /* localStorage unavailable (private browsing, etc.) — lock just won't persist */ }
}
function lockHandleMarkup(listName, id) {
  const locked = isRowLocked(listName, id);
  return `<button type="button" class="lock-toggle ${locked ? "is-locked" : ""}" data-lock-list="${listName}" data-lock-id="${id}" title="${locked ? "Locked, click to allow dragging" : "Click to lock in place"}" aria-label="${locked ? "Unlock row" : "Lock row"}">${locked
    ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
    : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>'
  }</button>`;
}
function wireUpLockToggles(listEl, onToggle) {
  listEl.querySelectorAll(".lock-toggle").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const { lockList, lockId } = btn.dataset;
      setRowLocked(lockList, lockId, !isRowLocked(lockList, lockId));
      onToggle();
    });
  });
}

/* ===== Image compression =====
   Every place in the admin scripts that uploads a raw File to Supabase Storage
   runs it through compressImageFile() first. Admin phone/camera photos
   can easily be 4-12MB and 4000+px wide for something that only ever
   displays at a few hundred px on the public site, so this resizes to a
   sane max dimension and re-encodes before upload as WebP (which keeps the
   transparent backgrounds some PNG photos rely on). In a browser that
   can't encode WebP, PNGs are kept as PNG (resized but not otherwise
   degraded) and everything else is re-encoded as JPEG at a reasonable
   quality. Files already small enough that this
   wouldn't meaningfully help are returned unchanged. Any failure here
   (corrupt image, canvas/codec issue, old browser) falls back to
   uploading the ORIGINAL file — a bug in this helper must never block a
   real save the admin is trying to make. */

/* createImageBitmap isn't available in every browser (older Safari in
   particular) — fall back to decoding through an <img> element, which
   works everywhere a <canvas> does. */
async function loadDrawableImageSource(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch (e) {
      // Fall through to the <img> fallback below (e.g. an unsupported
      // format for createImageBitmap in this browser).
    }
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Couldn't read file"));
    reader.readAsDataURL(file);
  });
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't decode image"));
    img.src = dataUrl;
  });
}

async function compressImageFile(file, { maxDimension = 1600, webpQuality = 0.82, jpegQuality = 0.82, skipBelowBytes = 200 * 1024 } = {}) {
  if (!file || typeof file.type !== "string" || !file.type.startsWith("image/")) return file; // never touch non-images
  if (file.size <= skipBelowBytes) return file; // already small — not worth the processing

  let source = null;
  try {
    source = await loadDrawableImageSource(file);
    const width = source.width || source.naturalWidth || 0;
    const height = source.height || source.naturalHeight || 0;
    if (!width || !height) return file;

    const scale = Math.min(1, maxDimension / Math.max(width, height));
    const keepPng = file.type === "image/png";
    // Always redraw through canvas, even at scale 1 — a large-but-already-
    // right-sized JPEG might just be poorly compressed (e.g. quality 100
    // straight off a camera), and re-encoding at jpegQuality can still
    // shrink it meaningfully. The size check below guarantees this never
    // ships something bigger than what was uploaded.
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

    const encode = (type, quality) => new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))),
        type,
        quality
      );
    });
    // WebP keeps PNG transparency and is far smaller than PNG or JPEG.
    // Browsers that can't encode WebP silently hand back a PNG instead, so
    // check the real type and fall back to the PNG/JPEG path in that case.
    let outputType = "image/webp";
    let blob = await encode(outputType, webpQuality);
    if (!blob || blob.type !== "image/webp") {
      outputType = keepPng ? "image/png" : "image/jpeg";
      blob = await encode(outputType, keepPng ? undefined : jpegQuality);
    }
    if (!blob || blob.size >= file.size) return file; // never ship something bigger than the original

    const ext = { "image/webp": ".webp", "image/jpeg": ".jpg" }[outputType];
    const newName = ext ? file.name.replace(/\.[a-zA-Z0-9]+$/, "") + ext : file.name;
    return new File([blob], newName, { type: outputType, lastModified: Date.now() });
  } catch (err) {
    // Corrupt image, canvas/codec failure, etc. — upload the original
    // rather than let a processing bug block a real upload.
    return file;
  } finally {
    // Release the ImageBitmap's backing memory promptly on every exit
    // path (early returns included), not just the success path.
    if (source && typeof source.close === "function") source.close();
  }
}

/* Runs an update/delete/upsert and treats "no rows changed" as a failure.
   When Row Level Security blocks a write (most often because the login
   session has expired or been lost), Supabase doesn't return an error —
   it returns success with zero rows. Without this check every save button
   would report "updated"/"deleted" while nothing actually changed.
   Callers keep using { error } exactly as before. */
async function mustAffect(query) {
  const { data, error } = await query.select();
  if (error) return { data, error };
  if (!data || data.length === 0) {
    return {
      data,
      // Either the row no longer exists (deleted elsewhere) or RLS blocked
      // the write (login expired) — the response can't tell which.
      error: { message: "Nothing was changed — it may already have been deleted, or your login may have expired. Refresh the page and try again." }
    };
  }
  return { data, error: null };
}

function show(el) { el.hidden = false; }
function hide(el) { el.hidden = true; }

/* ===== Auth ===== */

async function handleLogin(e) {
  e.preventDefault();
  const client = getSupabaseClient();
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errorEl = document.getElementById("loginError");
  errorEl.textContent = "";

  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    errorEl.textContent = "Couldn't log in. Check your email and password.";
    return;
  }
  await enterDashboard();
}

let loggingOutOnPurpose = false;

async function handleLogout() {
  if (anyAdminFormDirty() && !(await adminConfirm({ title: "Log out with unsaved changes?", message: "You have unsaved changes that will be lost if you log out.", confirmLabel: "Log out anyway", danger: true }))) return;
  const client = getSupabaseClient();
  loggingOutOnPurpose = true;
  try {
    await client.auth.signOut();
  } finally {
    // Always reset, even if signOut throws (e.g. offline) — otherwise the
    // lost-session watcher would stay switched off for the rest of the page.
    loggingOutOnPurpose = false;
  }
  showLoginView();
}

/* If the session ends on its own (token refresh failed, signed out in
   another tab), return to the login screen with an explanation instead of
   leaving a dashboard up whose saves can no longer succeed. The forms are
   only hidden, not cleared, so unsaved work is still there after logging
   back in. */
function watchForLostSession(client) {
  client.auth.onAuthStateChange((event) => {
    if (event !== "SIGNED_OUT" || loggingOutOnPurpose) return;
    if (document.getElementById("dashboardView").hidden) return;
    showLoginView();
    document.getElementById("loginError").textContent =
      "Your login expired — please log in again. Anything you hadn't saved is still in the form.";
  });
}

async function enterDashboard() {
  const client = getSupabaseClient();
  const { data: { session } } = await client.auth.getSession();
  if (!session) {
    showLoginView();
    return;
  }
  // Extra login steps from js/admin-auth-extras.js (set-new-password after
  // a reset link, the 2-step login code). A gate that returns false has
  // shown its own screen and calls enterDashboard() again when it's done.
  for (const gate of (window.adminLoginGates || [])) {
    if (!(await gate(client, session))) return;
  }
  // Per-login setup that must finish before the dashboard shows (e.g. the
  // team role, so staff never see owner-only buttons flash up). A failing
  // hook never blocks the login.
  await Promise.allSettled((window.adminSessionHooks || []).map((fn) => Promise.resolve().then(() => fn(client, session))));
  const who = document.getElementById("whoAmI");
  who.textContent = session.user.email;
  show(who);
  show(document.getElementById("logoutBtn"));
  hide(document.getElementById("loginView"));
  show(document.getElementById("dashboardView"));
  // Cross-feature on purpose: the order matters (categories must be loaded
  // before the product list renders its folders), so it stays explicit
  // rather than going through a hook list.
  await loadCollectionsCache();
  await refreshItemList();
  await refreshOrderList();
  // First clean snapshot of the item form, taken only once the category
  // dropdown has its real options (filling it changes the form's value).
  if (itemFormSnapshot === null) markItemFormClean();
  // Open the tab named in the URL (#orders etc.), else Overview.
  adminRouteFromHash();
}

function showLoginView() {
  hide(document.getElementById("dashboardView"));
  hide(document.getElementById("logoutBtn"));
  hide(document.getElementById("whoAmI"));
  show(document.getElementById("loginView"));
  // Lets js/admin-auth-extras.js reset its extra login screens.
  (window.adminLoginViewHooks || []).forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
}

/* ===== Photo preview modal — reuses the public site's lightbox CSS
   classes (loaded via css/styles.css) without needing js/app.js, which
   wires up unrelated cart/checkout/nav behavior admin.html doesn't want. */
let previewUrls = [];
let previewIndex = 0;

function ensurePhotoPreviewModal() {
  let modal = document.getElementById("adminPhotoPreview");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.className = "modal lightbox-modal";
  modal.id = "adminPhotoPreview";
  modal.innerHTML = `
    <div class="modal-scrim" data-close-preview></div>
    <div class="lightbox-panel">
      <button type="button" class="icon-btn lightbox-close" data-close-preview aria-label="Close">&times;</button>
      <div class="lightbox-img-wrap">
        <button type="button" class="carousel-nav lightbox-nav lightbox-prev" aria-label="Previous photo">&lsaquo;</button>
        <img class="lightbox-img" src="" alt=""/>
        <button type="button" class="carousel-nav lightbox-nav lightbox-next" aria-label="Next photo">&rsaquo;</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelectorAll("[data-close-preview]").forEach((el) => el.addEventListener("click", closePhotoPreview));
  modal.querySelector(".lightbox-prev").addEventListener("click", () => stepPhotoPreview(-1));
  modal.querySelector(".lightbox-next").addEventListener("click", () => stepPhotoPreview(1));
  document.addEventListener("keydown", (e) => {
    if (!modal.classList.contains("open")) return;
    if (e.key === "Escape") closePhotoPreview();
    if (e.key === "ArrowLeft") stepPhotoPreview(-1);
    if (e.key === "ArrowRight") stepPhotoPreview(1);
  });
  return modal;
}

function renderPhotoPreviewFrame() {
  const modal = document.getElementById("adminPhotoPreview");
  if (!modal) return;
  modal.querySelector(".lightbox-img").src = previewUrls[previewIndex];
  const multi = previewUrls.length > 1;
  modal.querySelector(".lightbox-prev").hidden = !multi;
  modal.querySelector(".lightbox-next").hidden = !multi;
}

function stepPhotoPreview(delta) {
  if (previewUrls.length < 2) return;
  previewIndex = (previewIndex + delta + previewUrls.length) % previewUrls.length;
  renderPhotoPreviewFrame();
}

/* Opens the shared lightbox on an arbitrary set of URLs — nav arrows
   auto-hide via renderPhotoPreviewFrame() whenever there's only one. */
function openImagePreviewSet(urls, index) {
  previewUrls = urls;
  previewIndex = index || 0;
  const modal = ensurePhotoPreviewModal();
  renderPhotoPreviewFrame();
  modal.classList.add("open");
}

/* Single-image preview (hero/logo/category card photo). */
function openImagePreview(url) {
  openImagePreviewSet([url], 0);
}

function closePhotoPreview() {
  const modal = document.getElementById("adminPhotoPreview");
  if (modal) modal.classList.remove("open");
}

/* Wires a static .photo-preview container (its innerHTML is replaced
   on every render, so delegation beats re-binding per-render) to open
   the lightbox when it currently holds an <img>. */
function wireClickablePhotoPreview(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.addEventListener("click", () => {
    const img = container.querySelector("img");
    if (img) openImagePreview(img.src);
  });
}

/* Same idea as wireClickablePhotoPreview(), but for a list container
   (#itemList/#collectionList) whose rows are rebuilt wholesale on every
   render — one delegated listener on the stable container outlives every
   re-render, instead of needing to be rebound per row each time. Each
   row's .admin-item-thumb opens the shared lightbox; getPreviewSet(id)
   resolves that row's own id to {urls, index}. */
function wireClickableThumbList(containerId, getPreviewSet) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.addEventListener("click", (e) => {
    const thumb = e.target.closest(".admin-item-thumb");
    if (!thumb || !thumb.querySelector("img")) return;
    const row = thumb.closest("[data-id]");
    if (!row) return;
    const set = getPreviewSet(row.dataset.id);
    if (set && set.urls.length) openImagePreviewSet(set.urls, set.index || 0);
  });
}

/* Shared native-HTML5-drag reordering for a list of .draggable-row
   elements. `cache` is the array backing the rendered rows (mutated in
   place to match the new order); `onDrop` persists the new order and
   should itself trigger a re-render when it resolves.

   Keyboard alternative (same cache mutation + onDrop path):
   - rows that have a .drag-handle but no move buttons of their own get
     "Move up"/"Move down" buttons injected next to the handle;
   - Alt+ArrowUp / Alt+ArrowDown anywhere inside a row moves it.
   Locked rows (lock toggle on) can't be moved either way. After the
   re-render, focus returns to the same control on the moved row and the
   new position is announced. */
let draggedRowIndex = null;
let pendingRowMoveFocus = null;

function adminAnnounce(text) {
  let el = document.getElementById("adminLiveRegion");
  if (!el) {
    el = document.createElement("div");
    el.id = "adminLiveRegion";
    el.className = "visually-hidden";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  el.textContent = "";
  setTimeout(() => { el.textContent = text; }, 30);
}

function rowIsLocked(row) {
  return !!row.querySelector(".lock-toggle.is-locked");
}

function moveReorderRow(listEl, row, cache, onDrop, delta, focusKind) {
  const from = Number(row.dataset.index);
  const to = from + delta;
  if (!Number.isInteger(from) || to < 0 || to >= cache.length) return;
  if (rowIsLocked(row)) {
    adminAnnounce("This row is locked. Unlock it to move it.");
    return;
  }
  // The rendered rows' data-index values are stale until onDrop's
  // re-render lands, so ignore further moves on this list until then.
  if (listEl.dataset.reorderBusy === "1") return;
  const [moved] = cache.splice(from, 1);
  cache.splice(to, 0, moved);
  pendingRowMoveFocus = { listEl, id: row.dataset.id, origRow: row, focusKind, delta };
  adminAnnounce(`Moved to position ${to + 1} of ${cache.length}.`);
  listEl.dataset.reorderBusy = "1";
  let result;
  try { result = onDrop(cache); } catch (err) { console.error(err); }
  Promise.resolve(result).catch((err) => console.error(err)).finally(() => {
    delete listEl.dataset.reorderBusy;
    restoreRowMoveFocus(listEl);
  });
  // Lists that re-render synchronously restore focus right away.
  restoreRowMoveFocus(listEl);
}

function restoreRowMoveFocus(listEl) {
  const p = pendingRowMoveFocus;
  if (!p || p.listEl !== listEl || p.id == null) return;
  const row = [...listEl.querySelectorAll("[data-id]")].find((r) => r.dataset.id === String(p.id));
  // Still the pre-move element: the re-render hasn't happened yet.
  if (!row || row === p.origRow) return;
  let target = null;
  if (p.focusKind === "button") {
    target = row.querySelector(`.row-move-btn[data-row-move="${p.delta}"]:not(:disabled)`) || row.querySelector(".row-move-btn:not(:disabled)");
  }
  if (!target) target = row.querySelector(".row-move-btn, button, [tabindex]");
  if (!target || target === document.activeElement) return;
  pendingRowMoveFocus = null;
  target.focus();
}

function wireUpRowReorder(listEl, selector, cache, onDrop) {
  const rows = listEl.querySelectorAll(selector);
  rows.forEach((row) => {
    const handle = row.querySelector(".drag-handle");
    if (handle && !row.querySelector("[data-move], .row-move-btn")) {
      const i = Number(row.dataset.index);
      const locked = rowIsLocked(row);
      const wrap = document.createElement("span");
      wrap.className = "row-move";
      wrap.innerHTML = `
        <button type="button" class="row-move-btn" data-row-move="-1" aria-label="Move up" title="Move up (Alt+Up)" ${i === 0 || locked ? "disabled" : ""}>&uarr;</button>
        <button type="button" class="row-move-btn" data-row-move="1" aria-label="Move down" title="Move down (Alt+Down)" ${i === cache.length - 1 || locked ? "disabled" : ""}>&darr;</button>`;
      handle.insertAdjacentElement("afterend", wrap);
      wrap.querySelectorAll(".row-move-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          moveReorderRow(listEl, row, cache, onDrop, Number(btn.dataset.rowMove), "button");
        });
      });
    }
    row.addEventListener("keydown", (e) => {
      if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      // Only the innermost reorderable row reacts (nested lists).
      if (e.target.closest(selector) !== row) return;
      // Leave Alt+Arrow alone inside text fields/selects.
      if (e.target.matches("input[type=text], input:not([type]), textarea, select")) return;
      e.preventDefault();
      moveReorderRow(listEl, row, cache, onDrop, e.key === "ArrowUp" ? -1 : 1, "button");
    });
    row.addEventListener("dragstart", () => {
      draggedRowIndex = Number(row.dataset.index);
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      draggedRowIndex = null;
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("drag-over");
      const targetIndex = Number(row.dataset.index);
      if (draggedRowIndex === null || draggedRowIndex === targetIndex) return;
      const [moved] = cache.splice(draggedRowIndex, 1);
      cache.splice(targetIndex, 0, moved);
      onDrop(cache);
    });
  });
}

/* Shared by the Collections, Nav and FAQ drag-to-reorder lists. Every
   row's write is checked; if any fail the admin is told, and the list is
   re-read from the database either way so it shows what was really saved
   rather than a half-applied order. */
async function persistSortOrder(table, cache, refresh) {
  const client = getSupabaseClient();
  const results = await Promise.all(cache.map((row, i) => mustAffect(client.from(table).update({ sort_order: i }).eq("id", row.id))));
  const failed = results.filter((r) => r.error);
  if (failed.length) adminToast(`Couldn't save the new order (${failed.length} of ${cache.length} rows failed): ${failed[0].error.message}`, { kind: "error" });
  await refresh();
}

/* `folder` is optional (the Gallery tab passes "gallery"); without it the
   file goes in the bucket root as before. */
async function uploadSiteImage(client, file, compressOptions, folder) {
  const compressed = await compressImageFile(file, compressOptions);
  const safeName = compressed.name.replace(/[^a-zA-Z0-9.-]/g, "_");
  const path = `${folder ? folder + "/" : ""}${Date.now()}-${safeName}`;
  const { error } = await client.storage.from("site-images").upload(path, compressed, { upsert: true });
  if (error) throw new Error("Image upload failed: " + error.message);
  const { data: pub } = client.storage.from("site-images").getPublicUrl(path);
  return pub.publicUrl;
}

/* ===== Tabs owned by the IIFE modules =====
   Two independent features share the Delivery tab, each in its own file
   (js/admin-availability.js, js/admin-delivery-areas.js). Past events
   gallery — lives in js/admin-gallery.js. Those files are loaded after
   this one, so the window.* functions are looked up when the tab opens. */
registerAdminTab("delivery", { btnId: "tabDeliveryBtn", panelId: "deliveryPanel", onEnter: async (params) => {
  const availability = window.refreshAvailabilityAdmin();
  window.refreshDeliveryAreaAdmin();
  // adminNavigate("delivery", { focus: "block-date" }) — Overview's
  // "Block a date" quick action.
  if (params && params.focus === "block-date") {
    await availability;
    const input = document.getElementById("bd-from");
    if (input) {
      input.scrollIntoView({ block: "center" });
      input.focus();
    }
  }
} });
registerAdminTab("gallery", { btnId: "tabGalleryBtn", panelId: "galleryPanel", onEnter: () => window.refreshGalleryAdmin() });

/* ===== Init ===== */

document.addEventListener("DOMContentLoaded", async () => {
  if (!isSupabaseConfigured()) {
    show(document.getElementById("notConfiguredView"));
    return;
  }

  const client = getSupabaseClient();
  if (!client) {
    show(document.getElementById("notConfiguredView"));
    return;
  }

  document.getElementById("loginForm").addEventListener("submit", handleLogin);
  watchForLostSession(client);
  document.getElementById("logoutBtn").addEventListener("click", handleLogout);
  // Closing/reloading the page with unsaved item or settings edits.
  window.addEventListener("beforeunload", (e) => {
    if (anyAdminFormDirty()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  // Builds the grouped nav from TABS and wires its clicks/keys/routing.
  initAdminShell();

  // Every feature file's own DOM wiring (see onAdminInit()).
  adminInitHooks.forEach((fn) => fn(client));

  const { data: { session } } = await client.auth.getSession();
  if (session) {
    await enterDashboard();
  } else {
    showLoginView();
  }
});
