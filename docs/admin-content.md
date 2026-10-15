# Admin content editing

Covers the Settings tab restructure, preview, version history, page SEO and
photo alt text. Run `supabase-migrations/60-content.sql` once in the Supabase
SQL Editor (after `supabase-setup.sql`) to switch on history and alt text. The
migration is idempotent. Until it runs, the public site looks exactly as
before and the History / Alt buttons say the migration is needed.

## Settings tab

- Sections (left sub-nav on desktop, chip row on phones): Hero & branding,
  Contact, Social, About page, Theme colours, SEO & sharing, plus any cards
  other scripts add (Notifications, Backup...).
- A sticky "Unsaved changes / Discard / Save" bar appears when the form is
  dirty. Ctrl/Cmd+S saves (also works on the FAQ tab).
- Validation: email format, phone (7 to 15 digits), WhatsApp (a `wa.me` link,
  or a bare number is converted), social links (`@handle` becomes a profile URL
  for Instagram, TikTok and YouTube; bare domains get `https://`), hex colours.
  Errors show inline and block saving; "doesn't look like a ... link" is only a
  warning. Blank still means "keep the page's built-in value".
- Theme colours: hex box next to each picker, a mini preview, and a WCAG
  contrast check (text brown against the page background, blush and accent;
  warns below 4.5:1).

### For other admin scripts

```js
window.addSettingsSection("myCardId", "My card", elementOrNull, { show: false });
window.showSettingsSection("seo");
```

A card appended straight into `#settingsPanel` (e.g. before `#backupAdmin`) is
picked up automatically too and listed under "More", titled from its
`data-settings-title` or first heading. `#settingsPanel`, `#settingsForm` and
`#backupAdmin` ids are unchanged. The form dispatches `admin-settings-changed`
on `document` whenever its dirty state may have changed.

## Preview and "Edit on page"

"Preview" writes the unsaved changes to `localStorage` key
`aura-settings-preview` and opens the page with `?preview=1`.
`js/site-content.js` applies the draft only when that parameter is present and
the draft is under 2 hours old, and shows a "Preview - not saved" ribbon.
Large staged photos (over about 2.5 MB as data URLs) are skipped; they appear
after saving. "Edit on page" opens `index.html?edit=1`; site-content.js clicks
the existing edit-mode toggle once it exists (it only exists for a logged-in
admin), so nobody else sees anything.

## Version history (Settings and FAQ)

`content_history (id, created_at, actor_email, kind 'settings'|'faq',
snapshot jsonb, note)`, admin-only. Every successful save writes the full
state (all managed settings keys; the full FAQ list). The first tracked save
also stores the state before it, so the first edit can be undone. A trigger
keeps the newest 50 per kind. The History button lists versions with a
field-level summary of what restoring would change, and "Restore this version"
writes it back and records itself as a new version.

Notes: only keys this form manages are snapshotted or restored (other keys such
as `msg_template_*` are never touched). Restoring a deleted FAQ question
re-creates it with a new id, so any on-page edit-mode tweak attached to the
old id does not come back. This is separate from any audit log.

## SEO per page

Keys in `site_settings`: `seo_<page>_title`, `seo_<page>_description` for
`index`, `all_products`, `anniversary`, `birthday`, `kids`, `other_occasions`,
`category` (default for `category.html`), `gallery`, `custom_order`, `about`,
`faq`, plus `seo_og_image` (site-wide share image). When set,
`js/site-content.js` updates `document.title`, `meta[name=description]`,
`og:title/description/image` and the twitter tags (created if missing).

Important: this runs in the browser. Crawlers and link-preview bots that don't
run JavaScript (many social scrapers) only see the static tags in each HTML
file, which remain as the fallback. For those, edit the HTML files directly.
Google does run JavaScript, so titles and descriptions generally get picked up
there. Product-level SEO is a separate feature.

## Photo alt text

`photo_meta (url primary key, alt, updated_at)`: public read, admin write.
Admin: an "Add alt / Alt" chip appears on photos in the Library tab and picker,
the product form photo gallery (already-uploaded photos) and Gallery tab rows.
The Library toolbar has a "Missing alt text (n)" filter.

Public: `js/site-content.js` fetches the table once per tab, caches it in
`sessionStorage` (`photoAltMap:v1`, 10 minutes), exposes
`window.photoAlt(url, fallback)`, and fills `alt` on matching `<img>` elements
(existing and later-rendered, via a MutationObserver). Decorative images
(thumb strips, related-product art, `aria-hidden`) are skipped. With no row, or
no table, the existing alt (product name, gallery caption, ...) stays.
New alt text can take up to 10 minutes to show for a visitor already browsing.
