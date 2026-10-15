# Admin design system

The shared look of the admin panel (`admin.html`, `css/admin*.css`, the admin JS templates). Read this before you restyle a surface. The tokens in `css/admin-tokens.css` are the contract: use them and light mode, dark mode and the checks keep working.

The public storefront is untouched by all of this. Every admin token is scoped to `body.admin-body`, never bare `:root`, and `css/styles.css` is not edited.

## Design read

One owner, phone and desktop, often a quick check between jobs. The panel should be predictable and quiet: the warm brand (cream, coral, brown) carried by color and shape, not by decoration.

| Dial | Value | What it means here |
|---|---|---|
| Variance | 3 | Same card, same row, same pill everywhere. No one-off layouts. |
| Motion | 3 | Short fades and a skeleton shimmer. Nothing that moves for its own sake. Reduced motion is honored. |
| Density | 6 | Compact rows and tables, 44px tap targets on phones, 15px body text. |

## Files and load order

`css/styles.css` (public tokens), then `css/admin-tokens.css`, then `css/admin.css` and the rest. The tokens file is the only admin stylesheet allowed to contain hex colors.

| File | Role |
|---|---|
| `css/admin-tokens.css` | All `--a-*` tokens, light and dark values, `.a-badge`, `.a-skeleton`, `.a-empty`, `.a-inline-error` and friends |
| `css/admin.css` | Admin base (font roles, native controls), cards, forms, photo grids, item rows |
| `css/admin-shell.css` | Header, nav, theme button, Overview |
| `css/admin-orders.css`, `-products`, `-analytics`, `-content`, `-safety`, `-notifications`, `-ui` | One surface each |
| `js/admin-theme.js` | Theme toggle and `window.adminTheme` |

## Rules

1. **One accent.** Coral. Use `--a-accent` for fills, rings and dots. When coral is *text or a link*, use `--a-accent-text` (a deeper coral in light mode, a lighter one in dark). Raw coral on white is only 2.4:1.
2. **The label on a coral fill is brown, never white.** Use `--a-on-accent`. White on coral is 2.4:1.
3. **Shape rule.** Copy what the code already does:

   | Thing | Radius |
   |---|---|
   | Chips, badges, filters, tabs, small action buttons | `--radius-pill` |
   | `.btn` (primary, outline, ghost) | `--radius-md` (14px, inherited from the public `.btn`) |
   | Cards, drawers, dialogs, big panels | `--radius-lg` (18px) |
   | Inputs, selects, thumbnails, list rows, sub-cards | `--radius-sm` (10px) |
   | Tiny controls and chips inside dense tables, progress bars | `--a-radius-xs` (6px) |
   | Avatars, dots, round icon buttons | `50%` (only these) |

   No other radii. The old `3px`, `4px`, `6px` and `8px` literals are gone.
4. **Font roles.** `--a-font-display` (Blue Winter) is for page and panel titles only (`h1`, `h2`, settings legends). Everything else, including buttons, labels, tabs, badges, tables and `h3`/`h4`, uses `--a-font-ui` at weight 600 or 700. Never put the display face on a button.
5. **Theme lock.** Write colors with tokens. Do not branch on dark mode in a component. If a component needs a color that does not exist, add a token to the light block and both dark blocks in `admin-tokens.css`.
6. **Status colors come in pairs.** Foreground plus soft background, both verified at 4.5:1. Use the pair together, never mix a `-fg` with another pair's `-bg`.
7. **Never rely on color alone** for status. Every badge has text.
8. **Focus.** The global ring (`--a-ring-w` solid `--a-focus`, offset `--a-ring-offset`) covers everything. Only override it for a good reason, and keep 3:1.
9. **Touch targets.** Anything tappable on a phone should be at least `--a-tap` (44px) tall, or have 44px of hit area. Some legacy controls are 36 to 40px; grow them when you touch them.

## Token reference

All names are defined on `body.admin-body`. Dark values change under the theme selectors described below.

### Type

| Token | Value | Use |
|---|---|---|
| `--a-text-2xs` | 11px | Micro labels, counts |
| `--a-text-xs` | 12px | Captions, meta, badges |
| `--a-text-sm` | 13px | Secondary text, dense tables, chips |
| `--a-text-base` | 15px | Body text |
| `--a-text-md` | 16px | Inputs, emphasised body |
| `--a-text-lg` | 19px | Card and drawer titles |
| `--a-text-xl` | 22px | Section titles |
| `--a-text-2xl` | 26px | Page title, login |
| `--a-text-3xl` | 32px | Hero stat numbers |
| `--a-leading-tight`, `-snug`, `-normal` | 1.2, 1.35, 1.5 | Line heights |
| `--a-weight-regular`, `-medium`, `-semibold`, `-bold` | 400, 500, 600, 700 | Buttons, labels, tabs use 600 |
| `--a-font-ui`, `--a-font-display`, `--a-font-mono` | | Font roles |

### Radius, spacing, elevation, motion

| Token | Value |
|---|---|
| `--a-radius-xs` | 6px |
| `--a-radius-sm`, `-md`, `-lg`, `-pill` | 10px, 14px, 18px, 999px (aliases of `--radius-*`) |
| `--a-space-1` to `--a-space-8` | 4, 8, 12, 16, 24, 32, 48, 64 px |
| `--a-elev-1` | Cards at rest (tinted soft shadow) |
| `--a-elev-2` | Menus, toasts, popovers |
| `--a-elev-modal`, `--a-elev-drawer`, `--a-elev-bar` | Dialogs, right drawer, phone bottom bar |
| `--a-border-w`, `--a-border-w-strong` | 1px, 1.5px |
| `--a-ring-w`, `--a-ring-offset`, `--a-focus` | 2px, 2px, ring color |
| `--a-tap` | 44px |
| `--a-ease`, `--a-dur-fast`, `--a-dur`, `--a-dur-slow` | Easing, 120, 160, 240 ms |

### Z-index

| Token | Value | What lives there |
|---|---|---|
| `--a-z-raised` | 1 | Overlays inside one component |
| `--a-z-above` | 5 | Tooltips, tiles over neighbours |
| `--a-z-sticky` | 40 | Sticky toolbars, save bar |
| `--a-z-sticky-hi` | 50 | Sticky over sticky |
| `--a-z-header` | 60 | Admin header |
| `--a-z-nav` | 70 | Phone bottom bar |
| `--a-z-skip` | 200 | Skip link |
| `--a-z-drawer` | 400 | Order drawer |
| `--a-z-modal` | 1100 | `adminConfirm` dialogs (above drawers) |
| `--a-z-toast` | 1200 | Toasts (above everything) |

### Surfaces and text

`--a-bg` (page), `--a-surface` (cards), `--a-surface-sunken` (wells), `--a-surface-raised` (dialogs, toasts), `--a-text`, `--a-text-soft`, `--a-text-faint`, `--a-border`, `--a-border-strong`, `--a-scrim`.

The existing public names (`--color-bg`, `--color-bg-alt`, `--color-surface-solid`, `--color-fg`, `--color-fg-soft`, `--color-fg-faint`, `--color-border`, `--color-border-input`, `--color-accent`, `--radius-*`, `--space-*`) keep working and flip with the theme, so old rules need no change. New rules should prefer the `--a-*` names.

Fixed (theme-independent) values: `--a-media-scrim` and `--a-on-media` (controls drawn over photos), `--a-knob`, `--a-plate` (light plate behind QR codes), `--a-serp-*` (Google result preview, always a light plate), `--a-bar-bg` and `--a-bar-fg` (sticky save bar).

### Status pairs

Semantic pairs: `--a-success`, `--a-warning`, `--a-danger`, `--a-info`, `--a-neutral`, `--a-accent`, each with `-fg`, `-bg` and `-line` (border). Solid fills with their label: `--a-danger-solid` with `--a-on-danger`, `--a-success-solid` with `--a-on-success`.

Domain aliases are `--a-status-<name>-fg|bg|line`. They point at the semantic pairs, so you can re-point one without touching the others.

| Group | Names | Maps to |
|---|---|---|
| Order | `new` | accent |
| | `contacted` | warning |
| | `quoted` | info |
| | `fulfilled` | success |
| | `cancelled` | neutral |
| Payment | `unpaid`, `refunded` | neutral |
| | `deposit` | warning |
| | `paid` | success |
| | `balance` (balance due) | danger |
| Product | `sale`, `outofstock` | danger |
| | `featured` | accent |
| | `lowstock` | warning |
| | `scheduled` | info |
| | `expired`, `hidden` | neutral |

### Measured contrast

`node scripts/check-admin-tokens.js --table` prints this table, and the script fails if any row drops below its minimum. Chart colors are measured against the card surface.

| Pair | Min | Light | Dark |
|---|---|---|---|
| success (badge) | 4.5:1 | 5.5:1 | 8.0:1 |
| warning (badge) | 4.5:1 | 5.8:1 | 8.6:1 |
| danger (badge) | 4.5:1 | 6.3:1 | 7.7:1 |
| info (badge) | 4.5:1 | 6.3:1 | 8.1:1 |
| neutral (badge) | 4.5:1 | 6.9:1 | 7.9:1 |
| accent (badge) | 4.5:1 | 4.7:1 | 7.5:1 |
| status-new | 4.5:1 | 4.7:1 | 7.5:1 |
| status-contacted | 4.5:1 | 5.8:1 | 8.6:1 |
| status-quoted | 4.5:1 | 6.3:1 | 8.1:1 |
| status-fulfilled | 4.5:1 | 5.5:1 | 8.0:1 |
| status-cancelled | 4.5:1 | 6.9:1 | 7.9:1 |
| status-unpaid | 4.5:1 | 6.9:1 | 7.9:1 |
| status-deposit | 4.5:1 | 5.8:1 | 8.6:1 |
| status-paid | 4.5:1 | 5.5:1 | 8.0:1 |
| status-refunded | 4.5:1 | 6.9:1 | 7.9:1 |
| status-balance | 4.5:1 | 6.3:1 | 7.7:1 |
| status-sale | 4.5:1 | 6.3:1 | 7.7:1 |
| status-featured | 4.5:1 | 4.7:1 | 7.5:1 |
| status-lowstock | 4.5:1 | 5.8:1 | 8.6:1 |
| status-outofstock | 4.5:1 | 6.3:1 | 7.7:1 |
| status-scheduled | 4.5:1 | 6.3:1 | 8.1:1 |
| status-expired | 4.5:1 | 6.9:1 | 7.9:1 |
| status-hidden | 4.5:1 | 6.9:1 | 7.9:1 |
| label on accent fill | 4.5:1 | 4.9:1 | 7.7:1 |
| label on accent hover | 4.5:1 | 5.4:1 | 8.8:1 |
| label on danger fill | 4.5:1 | 5.3:1 | 5.6:1 |
| label on success fill | 4.5:1 | 5.2:1 | 6.2:1 |
| accent text on page | 4.5:1 | 4.9:1 | 9.7:1 |
| accent text on card | 4.5:1 | 5.3:1 | 8.4:1 |
| accent text on accent tint | 4.5:1 | 4.7:1 | 7.1:1 |
| body text on page | 4.5:1 | 11.1:1 | 15.4:1 |
| body text on card | 4.5:1 | 12.0:1 | 13.3:1 |
| soft text on card | 4.5:1 | 5.0:1 | 8.9:1 |
| faint text on card | 4.5:1 | 4.9:1 | 6.1:1 |
| faint text on page | 4.5:1 | 4.5:1 | 7.0:1 |
| danger text on card | 4.5:1 | 5.3:1 | 7.1:1 |
| success text on card | 4.5:1 | 5.2:1 | 8.1:1 |
| focus ring on card | 3:1 | 4.7:1 | 8.4:1 |
| focus ring on page | 3:1 | 4.3:1 | 9.7:1 |
| chart-1 on card | 3:1 | 4.4:1 | 7.0:1 |
| chart-2 on card | 3:1 | 3.7:1 | 7.1:1 |
| chart-3 on card | 3:1 | 4.0:1 | 8.1:1 |
| chart-4 on card | 3:1 | 3.6:1 | 8.7:1 |
| chart-5 on card | 3:1 | 4.9:1 | 7.3:1 |
| seq-1 on card | 3:1 | 3.5:1 | 3.1:1 |
| seq-1 label | 4.5:1 | 5.2:1 | 5.2:1 |
| seq-2 on card | 3:1 | 4.8:1 | 4.3:1 |
| seq-2 label | 4.5:1 | 4.8:1 | 4.5:1 |
| seq-3 on card | 3:1 | 6.6:1 | 6.1:1 |
| seq-3 label | 4.5:1 | 6.6:1 | 6.4:1 |
| seq-4 on card | 3:1 | 9.8:1 | 8.8:1 |
| seq-4 label | 4.5:1 | 9.8:1 | 9.3:1 |
| chart up on card | 4.5:1 | 5.2:1 | 8.1:1 |
| chart down on card | 4.5:1 | 5.3:1 | 7.1:1 |

### Chart palette

For `css/admin-analytics.css` and `js/admin-charts.js`. The `--ac-*` names the chart code reads are aliases of these. Every categorical color is at least 3:1 on the card in its theme (see the table above). Text, ticks and grid never use series colors.

| Token | Use |
|---|---|
| `--a-chart-1` (blue) | Sessions, traffic |
| `--a-chart-2` (coral) | Orders, revenue |
| `--a-chart-3` (green), `--a-chart-4` (amber), `--a-chart-5` (taupe) | Further series |
| `--a-seq-1` to `--a-seq-4` | Sequential ramp (heat strip), one hue. `--a-seq-N-fg` is the label on each step |
| `--a-chart-grid`, `-axis`, `-track`, `-tip-bg`, `-tip-fg`, `-up`, `-down` | Chart chrome |

Charts take colors as `var(--ac-...)` strings, so a theme change recolors them with no re-render. `adminTheme.set` also fires `admin-theme-changed` on `document`, in case a future chart draws to a canvas.

## Shared components

Adopt these instead of writing new ones.

| Class | What |
|---|---|
| `.a-badge` with `--success`, `--warning`, `--danger`, `--info`, `--neutral`, `--accent` | Pill with text. `--outline` for a transparent fill, `--xs` for dense tables |
| `.a-badge--status-new` (and the other 16 domain names above) | Domain status pills |
| `.a-skeleton` (`--line`, `--pill`, `--block`) | Loading placeholder. Static when reduced motion is on |
| `.a-empty` with `.a-empty-title`, `.a-empty-text` | Empty state: icon, one title, one sentence, one action |
| `.a-inline-error`, `.a-inline-note` | Error and hint text next to a control |
| `.a-visually-hidden`, `.a-truncate`, `.a-inline`, `.a-inline-flex-center`, `.a-width-auto` | Small helpers (they replace inline styles) |

Existing pill classes (`.order-pill`, `.product-status-badge`, `.ov-pill`, `.csv-count`) already read the status tokens, so they are theme-correct. Moving each surface onto `.a-badge` is the next step for the surface owners.

## Dark mode

Light values are the default. Dark values are applied by two selectors with the same content:

```css
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) body.admin-body { /* dark values */ }
}
:root[data-theme="dark"] body.admin-body { /* dark values */ }
```

So: no saved choice follows the OS, `data-theme="light"` forces light, `data-theme="dark"` forces dark. The dark block also re-points the public semantic variables inside the admin, which is why unmodified rules go dark. If you change a dark value, change it in both copies.

Palette: warm brown-charcoal, never pure black. Page `#171210`, header and cards `#262019`, drawer body `#1E1814`, raised `#302821`. Text is warm off-white `#F2E8DE`. Coral text lifts to `#FFA39C`. Status soft backgrounds are re-tuned dark tints with light text. `color-scheme: dark` makes scrollbars, date pickers and native selects follow.

Details:

- The logo keeps its own cream cloud, so it works on dark with no filter.
- Photos in `.admin-main` are dimmed slightly with `--a-photo-filter` (no inversion).
- The Google result previews (`.seo-snippet`, `.pf-snippet`) stay a light plate on purpose.
- Print is always light: an `@media print` block in `admin-tokens.css` restores the light values. `js/admin-orders-print.js` writes its own self-contained light document, so it never depended on the admin CSS.

### Theme toggle

A cycle button in the header (`#adminThemeBtn`, created by `js/admin-theme.js` inside `#adminThemeSlot`): System, then Light, then Dark. It sits in the header, so it also shows on the login screens. The label hides on phones. An inline script in the `admin.html` head applies the saved choice before first paint, so there is no flash.

```js
adminTheme.get();        // "system" | "light" | "dark"  (the saved preference)
adminTheme.set("dark");  // saves to localStorage key "adminTheme", applies, fires admin-theme-changed
document.addEventListener("admin-theme-changed", e => e.detail); // { mode, resolved }
```

## How to add a new surface

1. Put it in the right `css/admin-*.css` file, or add a new file linked after `css/admin-tokens.css` in `admin.html`.
2. Build from cards (`.admin-card`), `.btn` variants, `.a-badge`, `.a-empty`, `.a-skeleton` and `.a-inline-error`. Use `--a-space-*` for new spacing.
3. Colors: tokens only. Sizes: `--a-text-*`. Radius: the scale. Z-index: `--a-z-*`. Shadow: `--a-elev-*`.
4. Register the tab with `registerAdminTab()` (see `js/admin-core.js`). There is no nav markup to edit.
5. Run both scripts below. Look at the screenshots at 390 and 1280, in light and dark.

## Checks

Both scripts live in `scripts/`. Neither is part of the site, and neither adds a dependency (Playwright is only needed to run the visual one).

```
node scripts/check-admin-tokens.js            # no deps; fails on stray hex/rgba, px radii, z-index numbers, !important, inline styles, low-contrast tokens
node scripts/check-admin-tokens.js --table    # also prints the contrast table

# needs Playwright: set PW_PATH to the playwright module folder, or have `playwright` installed
node scripts/admin-visual-check.js                           # every tab, 390/768/1280, light and dark
node scripts/admin-visual-check.js --theme dark --tabs orders,settings --widths 390
node scripts/admin-visual-check.js --out C:\temp\shots       # default: <tmpdir>/admin-shots
```

The visual check serves the repo, injects a fake Supabase client with sample data, and for each registered tab (plus extra views: order drawer, dialog and toasts, two modals, login) saves a screenshot, fails on page errors, native dialogs and horizontal scroll, and audits the contrast of every visible text node (4.5:1, or 3:1 for text at 24px, or 18.66px and bold). It exits non-zero on any failure and reports the counts.

## Do not

- No `style=""` attributes. Use a class. The one allowed use is a data-driven value computed in JS (a bar width in percent, a chart series color).
- No hex, `rgb()` or `rgba()` outside `css/admin-tokens.css`. For an alpha tint use `color-mix(in srgb, var(--token) 20%, transparent)`.
- No new radii, no `px` radii, no `50%` on anything that is not a circle.
- No `!important`. The allowlist in `scripts/check-admin-tokens.js` covers forced-colors, hide utilities and the staff lockdown. Fix everything else with specificity.
- No raw `z-index` numbers.
- No display face on buttons, labels, tabs or badges.
- No white text on coral. No raw coral body text on white.
- No `opacity` to dim text. It breaks contrast in one of the themes. Change the text color instead.
- No pure black or pure white page backgrounds in dark mode.
- Do not edit `css/styles.css` or any public page for admin work.
