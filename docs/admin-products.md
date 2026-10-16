# Products & catalog (admin)

Everything here lives on the **Products** and **Trash** tabs (Catalog group).

## One-time setup

Run `supabase-migrations/40-products.sql` once in the Supabase SQL editor (after `supabase-setup.sql`). It is safe to run again. Until you do, the site and admin keep working exactly as before; the new fields just can't be saved (the form tells you), and Delete removes a product permanently instead of using the Trash.

## Adding / editing a product

The form has collapsible sections:

- **Pricing & stock**: price, optional **sale price** (shows "20% off" as you type), SKU, stock. Blank stock means made to order; `0` shows "Sold out" and turns off Add to cart. Stock is **not** reduced automatically when an order arrives. Change it by hand.
- **Options**: **Sizes / options** (name + price; customers pick one, the first is pre-selected; blank price = the product's price) and **Add-ons** (name + extra price, customers tick any). The price shown and put in the cart includes the chosen size and add-ons. A sale price applies to the product's own price, so a size with its own price is shown at that price.
- **Visibility**: Show on site, **Featured** (listed first), **Available from / until** (the product appears and disappears by itself; the list shows **Scheduled** / **Expired**).
- **Tags**: comma separated; the Products search looks at tags, SKU and name.
- **SEO**: search title (about 60 characters) and description (about 160) with counters and a Google-style preview. Used for the browser tab title and meta description while that product is open on the site. Blank = the page's normal ones.
- **Preview card**: the product card exactly as shoppers see it, updating as you type. **View on site** appears for saved products.

## The product list

Badges: Sale, Featured, Low stock (2 or fewer), Out of stock, Scheduled, Expired, Hidden. In "By Category" view, **drag a product onto another in the same category** to set the order shoppers see (featured first, then this order). Dragging onto a different category still moves it there. Clear the search box before reordering.

## Trash

Delete (and bulk Delete) moves products to **Trash**. There you can **Restore** or **Delete forever**. Items older than 30 days are marked "Will be purged"; nothing is removed automatically. Use "Delete items older than 30 days" or "Empty trash". Photos stay in the Library.

## CSV import / export

**Export products CSV** downloads every product in the same columns the importer reads, so export, edit in a spreadsheet, import round-trips.

**Import CSV**: choose a file; columns are matched by header (`catalog-starter.csv` works as-is; only Collection, Item Name and Price are required); you can re-pick any column. The preview flags each row (missing name, bad price, unknown collection, bad dates). Unknown collections can be **created** or **mapped** to an existing one. Choose **Add new only** or **Update matching** (same SKU, otherwise same name in the same collection). Imports run in batches with a progress bar and a summary. Image URLs are taken as-is (`https://...` or `images/...`; several separated by `|` in "More Images").

Columns: Collection, Item Name, Price, Description, Style, Image URL, More Images, Show?, SKU, Sale Price, Stock, Tags, Featured, Sort Order, Variants, Add-ons, Available From, Available Until, SEO Title, SEO Description. Variants / Add-ons are written `Small: 120; Large: 180`. Dates are `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`. A blank photo cell never removes an existing product's photos.

## Bulk tools

Tick products, then use the bulk bar: **Price...** (increase/decrease by % or $, rounding to cents / .00 / .99 / nearest $5, old to new preview), **Sale...** (set a % or $ off, or clear sales), **Tags...** (add/remove a tag), **Featured...**, plus Show / Hide / Delete.

## On the public site

Sale prices show the old price crossed out; a "Sale" badge; sold-out products show "Sold out" and can't be added; several sizes show "From $X" and the cart button opens the product so a size can be picked; the product page shows size buttons and add-on checkboxes with a live total; scheduled / expired / trashed products are hidden (also enforced by the database policy); Google data (structured data) carries the sale price, OutOfStock, SKU and a price range for sizes.

Cart lines saved before this still work. A line with options looks like `{id, name, price (unit, includes options), collection, qty, variant: {name, price}, addons: [{name, price}], key}`.

## Design notes (catalog surfaces)

Styles for Products, Trash, Collections and the Photo Library live in `css/admin-products.css` and use only `--a-*` tokens. Local custom properties: `--cat-row-pad`, `--cat-thumb`, `--cat-tile-min` (set on the four panels).

- **Product row**: select, thumbnail, name, price (a sale shows the old price struck through), badges (`.a-badge--status-*`), then an actions line: show/hide switch, Edit, Duplicate, Delete, View, and in "By Category" Move up / Move down plus a drag grip.
- **Bulk bar** (`#bulkActionBar`): sticky, above the phone bottom bar. Groups: Visibility, Edit (buttons added by `js/admin-products-bulk.js` into `#bulkEditGroup`), Delete (separated).
- **Item form**: collapsible `<details class="pf-section">` sections with a summary line when closed. The live preview is pinned at the top of the form on desktop and collapsed above the save bar on phones. `#pfSaveBar` is sticky and shows "Unsaved changes".
- **Tags**: `#f-tags` is a hidden input holding the committed list; `#f-tag-input` is where a tag is typed.
- **CSV import**: four steps (Upload, Map columns, Review, Import), see `csvStepperHtml()`.
- **Library tiles**: each tile has one transparent `.library-tile-open` button (keyboard access and a name). The alt-text chip from `js/admin-content-alt.js` is still appended to the tile root.

## Future work

Stock is not decremented on order; that could be added to the order flow later.
