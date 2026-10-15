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

## Branding

The public pages use **"Balloons by Tea"** (titles, logo alt text,
`og:site_name`), so the admin uses the same name. `Aura Balloon Co` is only the
repo name. If `site_settings` has `business_name` (or `site_name`), the admin
title and logo alt text use it. If it has `logo_url`, the header logo uses it.
