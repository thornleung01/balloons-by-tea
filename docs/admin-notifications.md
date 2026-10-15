# New-order notifications

Get an email (and, if you want, a text message) the moment a customer places an order or sends a custom request. You can also have the site send the customer a "we got your request" email.

How it works, in plain terms:

1. A customer submits an order, and it's saved in your Supabase database as usual.
2. The database asks a small Supabase program (an "Edge Function" called `notify-new-order`) to send the notifications.
3. That function sends the email through **Resend** (an email service) and, optionally, a text through **Twilio**.

If anything here isn't set up yet, or stops working, **orders are still saved normally**. The only thing you'd lose is the notification.

Setup takes about 15–20 minutes. You'll need:

- your Supabase login (the project the site already uses)
- a free Resend account
- the admin page (`admin.html`), logged in

---

## Step 1: Create a Resend account and get an API key

1. Go to <https://resend.com> and sign up (the free plan is plenty).
2. In Resend, open **API Keys** → **Create API Key**. Name it "Balloon site", permission **Sending access**, then **Create**.
3. Copy the key (it starts with `re_`). Keep it somewhere safe for now; Resend only shows it once.

### Pick the "from" address

- **Quickest (for testing):** use `onboarding@resend.dev` as the sender. Resend only lets this address send to **the email you signed up to Resend with**, so set your notification email (step 3) to that same address.
- **Best (recommended):** verify your own domain so emails come from something like `orders@yourdomain.com`. In Resend open **Domains** → **Add Domain**, type your domain, and add the DNS records it shows you at your domain provider (GoDaddy, Namecheap, Squarespace, etc.). It usually verifies within an hour. **You need this for customer confirmation emails**, because the onboarding sender can't email customers.

---

## Step 2: Put the function on Supabase (deploy it)

The function's code is in this project at `supabase/functions/notify-new-order/index.ts`. Use **one** of these two ways.

### Option A: Supabase website (no installing anything)

1. Open your project at <https://supabase.com/dashboard> → **Edge Functions** (left menu).
2. Click **Deploy a new function** → **Via Editor**.
3. Name it exactly `notify-new-order`.
4. Delete the sample code, then open `supabase/functions/notify-new-order/index.ts` from this project, copy **all** of it, and paste it in.
5. Click **Deploy function**.
6. Open the function's **Settings** (Details) and turn **OFF** "Enforce JWT verification" (it may be called "Verify JWT"). Click **Save**.
   *Why:* the database calls this function without a Supabase login. The function checks a secret password of its own instead (step 3), so turning this off is safe.

### Option B: Supabase command line (if you or a helper prefer it)

```sh
npx supabase login
npx supabase link --project-ref zqtwpkgyvyylhdrreexd
npx supabase functions deploy notify-new-order --no-verify-jwt
```

(`--no-verify-jwt` is the same as switching off "Enforce JWT verification" in Option A.)

---

## Step 3: Set the function's secrets

Secrets are settings the function reads. They're stored by Supabase, never in the website's code.

1. In the admin page, go to **Settings** → **Notifications** → open **Connect the database to the function** → press **Generate**, then **Copy**. That long random text is your *webhook secret*. Keep the page open; you'll use it again in step 5.
2. In Supabase: **Edge Functions** → **Secrets** (sometimes under "Manage secrets"). Add each of these (name on the left, your value on the right):

| Name | What to put | Needed? |
|---|---|---|
| `RESEND_API_KEY` | The `re_...` key from step 1 | Yes |
| `NOTIFY_EMAIL_TO` | Where order emails should go, e.g. `you@gmail.com`. Several addresses: separate them with commas. | Yes |
| `NOTIFY_EMAIL_FROM` | The sender, e.g. `Balloons by Tea <orders@yourdomain.com>`, or `onboarding@resend.dev` while testing | Yes |
| `NOTIFY_WEBHOOK_SECRET` | The secret you just copied from the admin page | Yes |
| `ADMIN_URL` | Your admin page address, e.g. `https://yourdomain.com/admin.html`. Emails get an "Open in admin" button. | Recommended |
| `BUSINESS_NAME` | Your business name as it should appear in emails (default: Balloons by Tea) | Optional |
| `NOTIFY_CUSTOMER` | `true` to email customers a "we got your request" message (needs a verified domain) | Optional |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `NOTIFY_SMS_TO` | For text messages, see "Text messages" below | Optional |

Click **Save** after adding them. You don't need to redeploy the function; it picks them up automatically.

---

## Step 4: Run the database setup (migration)

This makes the database call the function whenever a new order is saved.

1. In Supabase open **SQL Editor** → **New query**.
2. Open `supabase-migrations/20-notifications.sql` from this project, copy all of it, paste it in, and press **Run**.
3. You should see "Success. No rows returned". It's safe to run again any time.

If you get an error mentioning `pg_net`, go to **Database** → **Extensions**, search for **pg_net**, switch it on, then run the file again.

This must run **after** `supabase-setup.sql` (which you've already run when the site was set up).

---

## Step 5: Connect the database to the function

Back on the admin page (**Settings** → **Notifications** → **Connect the database to the function**):

1. **Function URL** is filled in for you (`https://<your project>.supabase.co/functions/v1/notify-new-order`). Leave it.
2. **Shared secret** should still hold the secret you generated in step 3. If you closed the page, press **Generate** again, and update `NOTIFY_WEBHOOK_SECRET` in Supabase to the new value. **The two must match exactly.**
3. Press **Save connection**.

The URL and secret are saved encrypted in Supabase **Vault**. Nobody can read them back, not even from the admin page. Leave the secret box empty if you only want to change the URL.

---

## Step 6: Test it

1. Press **Check setup**. Every line should show a green tick, except optional extras you haven't turned on (grey).
2. Press **Send test notification**. Within a minute you should get an email titled **"[TEST] New order from Test Customer (sample)"**. Check your spam folder too, and mark it "Not spam" if it landed there.
   - If customer emails are on, you'll also get a **preview** of the customer email (the test never emails a real customer).
3. For a full end-to-end check, place a small real order on the website yourself, then delete it in the Orders tab afterwards.

The test button proves the function and Resend work. A real order also proves step 4–5 (the database connection).

---

## Optional extras

### Customer confirmation email

1. Verify your domain in Resend (step 1) and use it in `NOTIFY_EMAIL_FROM`.
2. Set the secret `NOTIFY_CUSTOMER` to `true`.
3. On the admin page, open **Customer confirmation email** to write your own subject and message. You can use these placeholders:
   - `{name}`: the customer's name
   - `{business}`: your business name
   - `{event}`: becomes " for <event date>" (or nothing if there's no date)

   Leave either box empty to use the built-in friendly text. Customers' replies go to your `NOTIFY_EMAIL_TO` address.

### Text messages (Twilio)

1. Sign up at <https://twilio.com>, buy a phone number that can send SMS (a few dollars a month), and find your **Account SID** and **Auth Token** on the Twilio console home page.
2. Add these secrets in Supabase:
   - `TWILIO_ACCOUNT_SID`: starts with `AC`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_FROM`: your Twilio number, like `+15551234567`
   - `NOTIFY_SMS_TO`: your mobile number, like `+15557654321` (comma-separate several)
3. Press **Send test notification** again.

Without these four, texts are simply skipped.

### Browser alerts while the admin page is open

On the admin page under **Browser alerts**, press **Turn on browser alerts** and allow notifications when your browser asks. When a new order comes in while the admin page is open (even in a background tab), you'll get a pop-up, and the tab title shows a count, like **"(2) Admin"**. Opening the Orders tab clears the count. The page checks for new orders once a minute. This works in the browser you turned it on in, and only while the admin page is open, so it's a nice extra, not a replacement for email.

---

## Alternative to step 4–5: a Database Webhook (no SQL)

If you'd rather not run the SQL file, Supabase can call the function for you:

1. Supabase → **Database** → **Webhooks** → **Enable webhooks** (if asked) → **Create a new hook**.
2. Name: `notify-new-order`. Table: `orders`. Events: tick **Insert** only.
3. Type: **Supabase Edge Functions**, function: `notify-new-order`, method `POST`.
4. Under **HTTP Headers**, add a header named `x-notify-secret` with your webhook secret (the same value as `NOTIFY_WEBHOOK_SECRET`).
5. **Create webhook**.

**Use the webhook OR the SQL trigger, not both**, or you'll get every email twice. (If you already ran the SQL file and want to switch, just don't do step 5. Without a saved connection, the trigger does nothing.) The admin page's "Database not connected yet" warning is expected in that case.

---

## Troubleshooting

- **"Function not deployed yet"**: step 2 isn't done, or the function name isn't exactly `notify-new-order`.
- **"JWT verification may be on"**: turn off "Enforce JWT verification" in the function's settings (step 2, Option A, point 6).
- **"Owner email not configured"**: one of `RESEND_API_KEY`, `NOTIFY_EMAIL_TO`, `NOTIFY_EMAIL_FROM` is missing (step 3).
- **Test says "Owner email: FAILED (Resend: 403 ...)"**: with `onboarding@resend.dev` you can only send to your own Resend sign-up email. Use that address, or verify your domain.
- **Test works but real orders don't send anything**: check step 4 and 5, and that `NOTIFY_WEBHOOK_SECRET` matches the secret you saved on the admin page exactly. In Supabase **SQL Editor**, `select status_code, content, created from net._http_response order by created desc limit 5;` shows the last few calls the database made (401 means the secrets don't match).
- **Function logs**: Supabase → **Edge Functions** → `notify-new-order` → **Logs**.
- **"Function refused your login"**: the test button only works for the admin account named in `is_admin()` in `supabase-setup.sql`.
- Spam protection still applies: orders that the site's spam limits reject are never saved, so they never send a notification.

---

## For developers

- Function: `supabase/functions/notify-new-order/index.ts`. It accepts
  - `x-notify-secret: <NOTIFY_WEBHOOK_SECRET>` with a Database-Webhook-shaped body `{ type: "INSERT", table: "orders", record }`, or
  - `Authorization: Bearer <admin JWT>` (checked with `rpc('is_admin')` as the caller) with `{ action: "test" }` (sample order) or `{ action: "status" }` (which secrets are set, booleans only). An admin JWT can't send a real record.
  
  Responses: 200 at least one message sent · 503 nothing configured · 502 every send failed · 401 / 400 / 405 as usual. Each channel's outcome is in `results.{owner,sms,customer}`.
- Reads the newer order columns (`items`, `total_amount`, `event_on`, `event_time`, `fulfillment`, `source`) when present, and falls back to `summary`, `total`, `event_date`.
- Migration: `supabase-migrations/20-notifications.sql` adds `orders_notify_new_order` (AFTER INSERT trigger via `pg_net`, URL and secret from Vault names `notify_new_order_url` / `notify_new_order_secret`, every error swallowed with a warning), `set_notify_config(url, secret)` and `notify_setup_status()` (both admin-only).
- Admin: `js/admin-notifications.js` + `css/admin-notifications.css`. Exposes `window.onAdminNewOrder(order)` for a realtime subscription to call with each inserted row. The first call switches off the 60-second polling fallback.
- `site_settings` keys: `notify_customer_subject`, `notify_customer_body`.
