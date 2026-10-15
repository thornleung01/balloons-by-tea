# Admin dashboard: Overview, navigation shell, routing

Files: `admin.html` (header, nav containers, Overview panel), `js/admin-core.js`
(tab registry, nav builder, `switchTab`, hash routing, keyboard reorder),
`js/admin-overview.js` (Overview tab), `css/admin-shell.css`.

## Adding a tab

```js
registerAdminTab("activity", {
  panelId: "activityPanel",          // required; your panel element inside #dashboardView, with `hidden`
  btnId: "tabActivityBtn",           // optional (default tab<Key>Btn); created for you
  label: "Activity",                 // optional (default: key capitalised)
  group: "site",                     // "overview" | "sales" | "catalog" | "site" | a new key (new group is appended)
  icon: "list",                      // optional, key of ADMIN_ICONS (add your own: ADMIN_ICONS.trash = '<path .../>')
  order: 50,                         // optional, position inside the group
  badgeId: "activityBadge",          // optional count badge; set with setTabBadge("activity", n)
  onEnter: (params) => refreshActivity(params)
});
```

Don't add tab buttons to `admin.html`. The nav is built from `TABS` by
`renderAdminNav()`. If an element with your `btnId` already exists in the page,
it gets moved into the nav and reused, so a stray hand-written button still
works. A tab with no `group` goes into **Site**. Tabs registered after the nav
is built show up immediately.

Groups: Overview | Sales (Orders, Analytics, Delivery) | Catalog (Products,
Collections, Library) | Site (Gallery, Nav, FAQ, Settings).

- **Desktop (≥800px):** a sticky left sidebar with a heading for each group.
- **Phones (<800px):** a fixed bottom bar with one button per group. Tapping a
  group opens the tab you last used in it, and a sticky chip row under the header
  lists that group's tabs. The chip row is hidden for one-tab groups (Overview).
  Each group button shows the total of its tabs' badges.

## Deep links and routing

- `adminNavigate(tab, params)` (also `window.adminNavigate`) is the same as
  `switchTab(tab, params)`.
- The URL hash follows the tab: `admin.html#orders`, `#orders?status=new`.
  Switching tabs uses `pushState`, so Back/Forward move between tabs. On login the
  hash is read; an unknown or empty hash opens Overview.
- `onEnter(params)` gets the params object, or `undefined` when there are none.
  Values parsed from the hash are strings.
- `registerAdminTabParamHandler(key, fn)` prepares a tab you don't own before its
  `onEnter` runs. The Overview uses it for:
  - **orders:** `{ status, search, sort, upcoming, payment }`. Sets the Orders
    status buttons, search box, sort, and "upcoming only" toggle. `payment` calls
    `window.setOrdersPaymentFilter(value)` if the Orders tab defines one.
  - **products:** `{ action: "new" }` focuses the Add Item form.
  - **delivery:** `{ focus: "block-date" }` focuses the block-date input (handled
    in the delivery `onEnter` in admin-core.js).
- `setTabBadge(key, n)` sets a tab's badge; 0 hides it. Writing to the badge
  element directly (as admin-orders.js does with `#ordersBadge`) also works.

## Overview cards

Each card loads on its own, so one failure only affects that card. The data is
re-fetched every time the tab opens.

| Card | Source | Without the new columns |
|---|---|---|
| New orders waiting | `status = 'new'` → Orders?status=new | same |
| Unpaid balances | `payment_status` in unpaid/deposit_paid; balance = total − (`amount_paid` ?? deposit if deposit_paid). Quotes and cancelled orders are excluded | card hidden |
| Revenue this month vs last | `total_amount`, else the `total` text parsed ("$120"; "Budget: …" is ignored). Orders by `created_at`, excluding cancelled orders and quotes. % change compares with the same day of last month | parsed `total` |
| Events in the next 7 days | `event_on` + `event_time`, else the `event_date` text (`YYYY-MM-DD[ HH:MM]`); excludes cancelled | `event_date` |
| Heads-up | `blocked_dates` and `fully_booked_dates()` for the next 14 days; hidden products; missing contact_phone / email / whatsapp | each check is skipped if it fails |
| Top products (30 days) | `orders.items` (`[{id/product_id, name, qty/quantity}]`), else `analytics_summary().top_products` (add-to-cart) | analytics |

Quick actions: Add product, Block a date, View site.

## Accessibility

- `#adminTabList` is the `role=tablist` and each button is a `role=tab` with
  `aria-controls`. Panels get `role=tabpanel` and `aria-labelledby`.
- Roving tabindex. Arrow keys, Home and End move between the visible tabs; Enter
  or Space opens a tab (manual activation, because several tabs fetch data when
  they open).
- There is a skip link to the main content and visible `:focus-visible` outlines.
- **Keyboard reordering:** `wireUpRowReorder()` adds Move up / Move down buttons
  to any row that has a `.drag-handle` and no move buttons of its own. Alt+↑ and
  Alt+↓ inside any reorderable row do the same. Both use the same cache mutation
  and `onDrop` persistence as drag and drop. Locked rows can't be moved. Focus
  returns to the moved row and its new position is announced. This applies to
  Collections, Nav, FAQ, Gallery and product photos.

## UI helpers: toasts and dialogs

`js/admin-ui.js` (+ `css/admin-ui.css`) loads right after `js/admin-core.js` and
replaces the browser's `alert()`, `confirm()` and `prompt()`. **Don't call the
native ones in admin code**; use these. All text is shown with `textContent`, so
passing a product name or an error message is safe.

```js
adminToast("Saved.", { kind: "success" });             // 'success' | 'error' | 'info'
adminToast("Couldn't delete: " + error.message, { kind: "error" });
adminToast("Item removed", { actionLabel: "Undo", onAction: () => restore() });

if (!(await adminConfirm({
  title: `Delete "${row.title}"?`,        // name what is being deleted
  message: "This can't be undone.",
  confirmLabel: "Delete category",         // say what the button does
  danger: true,                            // red button, Cancel focused first
  requireText: count >= 5 ? "DELETE" : undefined, // type-to-confirm for big permanent deletes
}))) return;

await adminAlert("Something the user must read.", { title: "Heads up" });
const name = await adminConfirm.input({ title: "New folder", label: "New folder name" }); // string, or null if cancelled
```

- **Toasts** are for transient results and errors. They stack (max 5), pause
  while hovered or focused, have a dismiss button, and error toasts use
  `role="alert"` (others `role="status"`). Default time is 4.5 s (8 s for errors
  or when there is an action button); `duration: 0` keeps it until dismissed.
  Returns a function that dismisses it.
- **`adminConfirm`** returns `Promise<boolean>`, so the calling function must be
  `async` and use `await`. Writing `if (!adminConfirm(...))` without `await` is
  always false and would skip the check. Esc, the Cancel button and a click on
  the backdrop all resolve `false`. Enter confirms, except when `requireText` is
  set (the button stays disabled until the text matches exactly). Focus is
  trapped in the dialog and returned to the button that opened it. Dialogs queue
  one at a time.
- **`adminAlert`** is for messages that need acknowledging (for example a list of
  failures). Use a toast for anything that doesn't.
- If `js/admin-ui.js` ever fails to load, a small inline script in `admin.html`
  defines the same four functions on top of the native dialogs, so nothing
  breaks.
- **Unsaved changes:** forms register with `registerAdminDirtyCheck(fn)` (see
  `js/admin-faq.js`, `js/admin-collections.js`, `js/admin-nav.js`): take a
  snapshot whenever the form is loaded, reset or saved, report dirty when the
  current values differ, and ask via `adminConfirm` before Edit on another row or
  Cancel throws the changes away. `anyAdminFormDirty()` also guards Log out and
  closing the tab. Switching tabs deliberately does not prompt, because hidden
  forms keep what was typed.

## Branding

The public pages use **"Balloons by Tea"** (titles, logo alt text,
`og:site_name`), so the admin uses the same name. `Aura Balloon Co` is only the
repo name. If `site_settings` has `business_name` (or `site_name`), the admin
title and logo alt text use it. If it has `logo_url`, the header logo uses it.
