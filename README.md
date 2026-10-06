# Aura Balloon Co. — website

A plain HTML/CSS/JS site (no build step, no framework). Everything in this
README is written for someone who isn't a developer — follow it top to
bottom and you'll have a fully working, deployable site.

**Everything here is placeholder content** — business name "Aura Balloon
Co.", collection names, item names/prices/descriptions, contact details,
and the balloon illustrations (drawn with code, not real photos). Replace
all of it with your own before sharing the site publicly.

## 1. View it locally

Double-click `index.html` to open it in your browser — the whole site
works this way (browsing, cart, checkout form, all of it).

If you want the Google Form submission step to be 100% reliable, serve the
folder instead of opening the file directly (some browsers restrict
background requests from `file://` pages). Easiest way, if you have
Node installed:

```
npx serve .
```

Then open the URL it prints (usually `http://localhost:3000`).

## 2. Managing your products

There are three ways to edit the catalog (items, prices, descriptions,
photos). Use whichever fits who's maintaining the site day to day — they
don't combine (the site checks Supabase first, then the Sheet, then falls
back to the bundled catalog, so turn on at most one).

### 2a. The best way — a live admin page (`admin.html`), backed by Supabase

This gives whoever runs the site day to day their own private page on the
site itself — `yoursite.com/admin.html` — where they log in and add,
edit, hide, or delete products with a real form, including uploading
actual photos by picking a file (no spreadsheet, no Imgur/Drive link
workaround). Changes appear on the site immediately, no few-minutes delay.

The same page also has an **Orders** tab: every checkout and custom-order
submission from the public site is saved straight into Supabase (instead
of the Google Form from 2b, which you no longer need once this is set
up), and shows up here with the customer's contact details, what they
asked for, and a status you can set to New / Contacted / Fulfilled. The
"Orders" tab badge shows how many are still marked New.

Four more tabs cover everything else that used to require editing code:

- **Collections** — rename, reorder, or change the tagline/card photo of
  Anniversary/Birthday/Kids/Other Occasions, or add a brand-new category
  from scratch. A new category can't get a clean `its-name.html` file
  automatically (the site has no build step), so it lives at
  `category.html?slug=its-name` instead — the 4 original categories keep
  their existing clean URLs. A category can't be deleted while products
  are still assigned to it.
- **Nav** — rename, reorder, hide, or add a link in the top navigation.
  The 5 built-in links (Home/Shop/Custom Order/About/FAQ) can be edited
  but not deleted, since the site's core structure depends on them; links
  you add yourself can be deleted freely.
- **FAQ** — add, edit, reorder, or delete questions, and choose which one
  (if any) is expanded by default. Separate paragraphs in an answer with
  a blank line.
- **Settings** — hero text, the hero image and logo, contact info
  (phone/email/WhatsApp), social links, the About page copy, and the 5
  brand colors, all in one form.

Everything on this page is additive: if Supabase isn't configured yet, or
a particular piece of content hasn't been saved there, the site just
shows its original built-in content instead — nothing can break from an
empty or half-filled-in admin page.

**One-time developer setup** (do this once, probably not the same person
who'll use the admin page day to day):

1. Go to [supabase.com](https://supabase.com) → sign up (free) → **New
   project**. Pick any name/password/region — the password here is your
   *database* password, not anyone's login, you won't need it day to day.
2. Once the project's ready, open the **SQL Editor** (left sidebar) → **New
   query** → paste in the entire contents of `supabase-setup.sql` from
   this project → **Run**. This creates the products table, the orders
   table, the photo storage bucket, and the security rules (anyone can
   view products and submit an order; only a logged-in user can change
   products or read/manage orders).
3. Create the one login the admin page will use: **Authentication** (left
   sidebar) → **Users** → **Add user** → enter an email and password. This
   is the login for whoever manages products — share it only with them.
   (There's no public sign-up page — this is the only way an account gets
   created, which keeps strangers from registering their own access.)
4. Get your connection details: **Project Settings** (gear icon) → **Data
   API**. Copy the **Project URL**, and the **anon public** key (not the
   `service_role` one).
5. Open `js/supabase-config.js` and paste those two values into
   `SUPABASE_CONFIG.url` and `SUPABASE_CONFIG.anonKey`.
6. Save, redeploy/reload. Visit `admin.html`, log in with the account from
   step 3, and you're managing live products.

**Why it's safe to put the anon key directly in the JS file:** that key
is meant to be public — it's how every Supabase site works. The actual
protection is the security rules from step 2 (`supabase-setup.sql`),
which only let a *logged-in* user change anything. Reading `js/admin.js`
confirms it never trusts anything the page itself claims — every field is
escaped before being shown, the same way the Google Sheet catalog is
(see 2b below).

**Safety net:** if Supabase isn't configured yet, isn't reachable, or
`admin.html` is visited before setup, nothing breaks — the public site
just shows the bundled catalog instead, and `admin.html` shows a plain
"not connected yet" message instead of a broken login form.

### 2b. The spreadsheet way — a Google Sheet (good if you'd rather not set up Supabase)

The site can read its product list from a Google Sheet instead of code.
Once set up, adding a balloon bouquet, changing a price, or temporarily
hiding a sold-out item is just editing a spreadsheet — no code, no
redeploying, no asking a developer.

**One-time setup:**

1. Go to [sheets.google.com](https://sheets.google.com) → **Blank
   spreadsheet** → **File → Import → Upload**, and upload
   `catalog-starter.csv` from this project (choose **Replace current
   sheet** or **Insert new sheet** when asked). This pre-fills all 24
   current items in the right format — no typing from scratch. (If you'd
   rather start empty, just set up these column headers in row 1
   yourself instead:)

   | Collection | Item Name | Price | Description | Style | Image URL | Show? |
   |---|---|---|---|---|---|---|

   - **Collection** — must be one of: `Anniversary`, `Birthday`, `Kids`,
     `Other Occasions` (this is what routes the item to the right page —
     anything else is skipped). Tip: select the column, then **Data →
     Data validation → Dropdown**, and list those 4 options, so it's a
     click instead of typing.
   - **Item Name** — anything, e.g. `Golden Hour Bouquet`.
   - **Price** — just the number, e.g. `58` (a `$` is fine too, it's
     ignored).
   - **Description** — a short sentence shown on the card.
   - **Style** — optional. Leave blank to use a sensible default per
     collection, or pick one of: `Golden Classic`, `Ivory Romance`,
     `Sage Whisper`, `Charcoal Noir`, `Blush Luxe` (these control the
     color of the small generated balloon graphic shown when there's no
     **Image URL** — see "Uploading photos" below).
   - **Image URL** — optional. A real photo of that item. Leave blank to
     keep showing the generated balloon graphic. See "Uploading photos
     for an item" below for how to get this link.
   - **Show?** — optional. Leave blank (shown) or type `No` to hide an
     item without deleting its row — handy for sold-out or seasonal
     items you'll bring back later.

   Example row: `Birthday | Golden Hour Bouquet | 58 | Champagne, cream & gold latex bouquet with trailing ribbon. | Golden Classic | | `

2. Add, edit, or delete rows as needed — the imported 24 rows are just
   a starting point (today's `js/products.js` catalog in spreadsheet
   form), not fixed content.
3. **File → Share → Publish to web.** Under "Link", choose the specific
   sheet/tab, and under the format dropdown choose **Comma-separated
   values (.csv)**, then click **Publish**.
4. Copy the link it gives you.
5. Open `js/catalog.js`, find `CATALOG_CONFIG` near the top, and paste
   that link as `sheetCsvUrl`.
6. Save, reload the site. Done — from now on, editing the sheet and
   waiting a few minutes (Google's publish cache refreshes every ~5
   minutes) is all it takes to update what's for sale.

**Safety net:** if the sheet is unreachable (no internet, link broken,
sheet unpublished) the site automatically falls back to the built-in
catalog below instead of breaking, so visitors are never shown an error.

Note: this manages *items within* the 4 existing collections. Renaming
one of the 4 collections themselves, or adding a 5th, is a bigger
structural change (new page, new nav link) and still needs a code edit —
ask a developer (or Claude) for that one.

### Uploading photos for an item

The site can't pull a photo directly out of a spreadsheet cell — the
**Image URL** column needs a *link* to a photo that's already hosted
somewhere online. Two ways to get that link, easiest first:

**Option A — imgur.com (no account needed):**
1. Go to [imgur.com/upload](https://imgur.com/upload) and drag your photo
   in (or click to choose a file).
2. Once it's uploaded, right-click the image and choose **Copy image
   address** (or open the image in its own tab and copy the address bar
   link — it should end in `.jpg` or `.png`).
3. Paste that link into the **Image URL** column for that item.

   *(A free imgur account, instead of uploading anonymously, keeps the
   photo from ever being cleaned up for inactivity — worth it for photos
   you're relying on long-term.)*

**Option B — Google Drive (stay in the Google account you already use):**
1. Upload the photo to [drive.google.com](https://drive.google.com).
2. Right-click it → **Share** → change access to **Anyone with the
   link** → make sure it's set to **Viewer** → **Copy link**. It'll look
   like `https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing`.
3. Copy just the ID part out of that link — the long string between
   `/d/` and `/view` (in the example above, that's `1AbCdEfGhIjKlMnOp`).
4. Build this link, swapping in that ID, and paste **that** (not the
   original share link) into the **Image URL** column:
   `https://drive.google.com/uc?export=view&id=PASTE_THE_ID_HERE`

Either way: leave **Image URL** blank for an item and it'll just keep
showing the generated balloon graphic — there's no requirement to have a
photo for every item.

The big homepage photos (the hero banner and the 4 collection cover
photos) are separate image files, not part of the spreadsheet — see
section 3 below for how to swap those.

### 2c. The code way — `js/products.js`

Open `js/products.js`. Each collection is a list of items with a name,
price, description, and 2–3 colors used to tint the placeholder balloon
illustration. Add, remove, or edit items freely — just keep each `id`
unique and don't reuse an `id` for a different item once the site is live
(it's the key the cart uses). This file is also what both live options
above fall back to if Supabase/the Sheet are ever unreachable, so it's
worth keeping reasonably up to date even if the sheet is the main way
items get managed.

## 3. Using real photos instead of placeholder art

The homepage (hero banner + the 4 "Shop Our Collections" photos) uses
**generated placeholder photography** in `images/` — soft gold/charcoal
bokeh images, not real product photos. They exist so the layout has
real images to work with; swap them out as soon as you have real
photography:

- `images/hero-bg.jpg` — homepage hero background
- `images/card-anniversary.jpg`, `card-birthday.jpg`, `card-kids.jpg`,
  `card-other-occasions.jpg` — the 4 collection cards

Just replace these files with real photos **of the same filename** and
nothing else needs to change. (If you use a different filename, update
the `src=` in `index.html`.)

Individual product cards on the collection pages (e.g. "Golden Hour
Bouquet") still use a small generated balloon illustration, not a photo,
since there's no per-item photography yet. To swap in a real photo for
one item:

1. Add your image file under `images/`.
2. In `js/app.js`, find `productArtMarkup()` and point it at your image
   instead of the generated art for that item.

### Regenerating the placeholder images

`scripts/generate_placeholder_art.py` is a dev-only utility (not needed
to run or deploy the site) that produced the files in `images/`. Re-run
it if you want a different random arrangement:

```
pip install pillow numpy
python scripts/generate_placeholder_art.py
```

## 4. Business details to update

- Business name/logo: search for "Aura Balloon Co." across all `.html`
  files and replace it (also update the small SVG mark in the nav/footer
  if you design a real logo).
- Colors/fonts: `css/styles.css`, top `:root` block — swap the hex values
  or Google Fonts import if you want a different palette/typeface. Headings
  and the logo currently use a custom font file (`fonts/BlueWinter.otf`/`.ttf`,
  loaded via `@font-face` near the top of the file) — to swap it for a
  different custom font, replace those files and update the `@font-face`
  `src` and the `--font-display` variable to match.
- Contact details: the footer block (repeated in every page) has your
  email, phone, Instagram and WhatsApp links — update all of them.
- **WhatsApp number**: search for `10000000000` across the `.html` files
  (it appears in the floating WhatsApp button on every page, plus the
  footer "WhatsApp" link) and replace it with your real number in
  international format, digits only, no `+`/spaces/dashes — e.g. a US
  number `+1 (555) 123-4567` becomes `15551234567`.

## 5. Connect the Google Form checkout

The checkout form on the site is fully custom-styled — customers never see
Google's own form page. When they click "Place order", the site quietly
sends the data straight to your Google Form's response endpoint, which
still lands in the same Google Sheet a normal form would produce.

**Until you do this setup, checkout still works** — it simulates a
successful submission locally (logged to the browser console) so you can
test the full flow today.

Steps:

1. Create a Google Form with one field for each of these (short answer
   unless noted):
   - Name
   - Phone
   - Email
   - Address
   - Preferred Date
   - Notes (paragraph)
   - Order Summary (paragraph) — this will receive the itemized list
   - Order Total
2. In the Form editor, click the **⋮** menu → **Get pre-filled link**.
3. Fill in any dummy text in every field, click **Get link**, then
   **Copy link**.
4. Paste that link somewhere you can read it — it looks like:
   `https://docs.google.com/forms/d/e/1FAIpQL.../viewform?entry.111111111=x&entry.222222222=y...`
   Each `entry.NUMBERS` right before `=` is that field's ID.
5. Open `js/app.js` and find the `CONFIG` object near the top. Replace:
   - `actionUrl`: same link as above, but change `viewform` to
     `formResponse`, and delete everything from the `?` onward.
   - Each `entry.YOUR_..._ID` placeholder with the matching real
     `entry.NUMBERS` id from step 4 (match by which field you put the
     dummy text in).
6. Save, reload the site, and place a test order — check your Form's
   linked Google Sheet for the response.

**The "Custom Order" page (`custom-order.html`) reuses this same setup** —
no second Google Form needed. It sends to the same `actionUrl`/entries,
just with different content in two fields: "Order Summary" always reads
"Custom order request" (so you can tell these apart from cart checkouts
in the sheet), and "Order Total" holds whatever budget they typed, or
"Budget not specified" if they left it blank. Its "Notes" field carries
the actual custom request description.

## 6. Connect real Google Reviews

The homepage review carousel ("What Customers Are Saying") ships with 6
placeholder reviews (`REVIEWS` array in `js/app.js`). To show your actual
Google reviews instead, you need a **Google Business Profile for this
business with real reviews on it already** — if that doesn't exist yet,
skip this section until it does; the carousel keeps working fine on the
placeholders in the meantime.

**This connects through Google Cloud, which is a paid platform** — Google
gives $200/month in free credit across all Maps/Places usage, which
comfortably covers a small business site, but it does require a credit
card on file, and you're responsible for watching usage if traffic ever
spikes. If that's not something you want to deal with, it's fine to just
update the `REVIEWS` array by hand with real review text copied from your
Google listing instead — ask a developer (or Claude) to help if you'd
rather switch to that simpler approach later.

**One-time setup:**

1. Go to [console.cloud.google.com](https://console.cloud.google.com) →
   create a project (or use an existing one) → **Billing** → attach a
   billing account (required even though you likely stay in the free
   credit).
2. **APIs & Services → Library** → enable both **"Maps JavaScript API"**
   and **"Places API (New)"** for that project.
3. **APIs & Services → Credentials → Create Credentials → API key.**
   Copy the key it gives you.
4. Click into that new key's settings and **restrict** it:
   - **Application restrictions** → **Websites** → add your real domain
     (e.g. `yourdomain.com/*`). This stops other sites from using your
     key and running up your bill — it does **not** hide the key, which
     will still be visible in your page's source. That's normal for this
     Google product; see the note in `js/google-reviews-config.js`.
   - **API restrictions** → restrict to just the two APIs you enabled
     in step 2.
5. Find your **Place ID**: go to
   [Google's Place ID Finder](https://developers.google.com/maps/documentation/places/web-service/place-id)
   tool, search for your business by name, and copy the Place ID it
   shows (starts with `ChIJ...`). This only works once your business
   has an actual Google Maps listing.
6. Open `js/google-reviews-config.js` and paste the API key and Place ID
   into `GOOGLE_PLACES_CONFIG`.
7. Save, reload the homepage. If it worked, you'll see your real reviews
   and a small "Reviews from Google" line under the carousel. If
   something's off, open the browser console (F12) — the site logs a
   clear warning explaining what went wrong and falls back to the
   placeholder reviews rather than breaking the page.

**Things worth knowing:**
- Google only ever returns up to **5** reviews through this API — that's
  a Google-side limit, not something this site controls.
- This was built against Google's current documented API shape, but
  **couldn't be tested against a real API key** (creating a Google Cloud
  project isn't something that can be done without you). It was tested
  against the real Google Maps endpoint with an intentionally invalid
  key — confirming the request itself is built correctly — and against a
  simulated successful response to confirm the review data displays
  correctly. If Google's actual field names have shifted by the time you
  connect a real key, check
  [their current Place class reference](https://developers.google.com/maps/documentation/javascript/reference/place)
  and adjust `js/google-reviews.js` — the comments at the top of that
  file point to exactly which lines to look at.

## 7. Deploying

Any static host works, since there's no server/build step. Easiest
options:

- **Netlify**: drag the whole project folder onto
  [app.netlify.com/drop](https://app.netlify.com/drop).
- **GitHub Pages**: push this folder to a GitHub repo, then enable Pages
  in the repo settings.
- **Cloudflare Pages / Vercel**: similarly, just point at this folder with
  no build command.

## File map

```
index.html              Home — hero + "shop our collections" grid
anniversary.html         Collection page
birthday.html            Collection page
kids.html                Collection page
other-occasions.html     Collection page
category.html            Collection page template for categories added via admin (2a)
custom-order.html        Custom order request form (shares the checkout's Google Form setup)
faq.html                 FAQ page (collapsible questions)
admin.html               Live product admin page (section 2a) — password-protected
css/styles.css           All styling (design tokens at the top)
css/admin.css            Admin page styling
fonts/                   Blue Winter display font (headings/logo) — see section 4
js/products.js           Built-in/fallback product catalog data
js/catalog.js            Optional live catalog — loads products from a Google Sheet (2b)
js/supabase-config.js    Paste your Supabase project URL + anon key here (2a)
js/supabase-catalog.js   Loads products from Supabase for the public site (2a)
js/admin.js              Admin page logic: login, products, orders, collections, nav, FAQ, settings (2a)
js/site-content.js       Loads hero/about/footer/nav/FAQ/theme content from Supabase for the public site (2a)
js/google-reviews-config.js  Paste your Google Maps API key + Place ID here (section 6)
js/google-reviews.js     Loads real reviews from Google for the homepage carousel (section 6)
js/app.js                Cart, checkout modal, Google Form submission, review carousel, nav
images/                  Hero + collection photos (placeholder — see section 3)
scripts/                 Dev-only: regenerates the placeholder photos
catalog-starter.csv      Import this into Google Sheets to pre-fill the live catalog (2b)
supabase-setup.sql       Run this once in Supabase's SQL editor (section 2a)
```
