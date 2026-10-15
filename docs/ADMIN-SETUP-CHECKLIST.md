# Admin upgrade: your setup checklist

Everything in the admin upgrade is already in the code. The steps below are the ones only you can do, because they happen in your Supabase account, your Resend account and your website host. Do them in this order.

Nothing breaks if you skip a step. Each new feature quietly falls back to how things worked before until its step is done, and the admin tells you what's missing.

---

## Before you start (2 minutes)

1. Open the admin page, go to **Settings** and press **Download backup**. Keep that file somewhere safe.
2. Don't run `supabase-setup.sql` on its own again afterwards unless you also run the update files. The new `supabase-all.sql` is the safe thing to run.

---

## Step 1: Update the database (about 5 minutes)

This one step turns on: itemised orders and payments, the activity log, staff accounts, trash for products, the new analytics charts, version history and photo alt text.

1. Open your project at <https://supabase.com/dashboard>, then **SQL Editor** and **New query**.
2. Open `supabase-all.sql` from this project, copy everything, paste it in and press **Run**.
3. It's safe to run on your existing project, and safe to run again. It adds things and doesn't delete your products, orders or photos.
4. If you get an error about `pg_net`, go to **Database** then **Extensions**, switch on `pg_net`, then run it again.

How to check it worked: refresh the admin page. The Activity tab should now show an empty list instead of a "run the update" notice, and an order should show payment badges.

More detail, including how to run the updates one at a time, is in `docs/DATABASE.md`.

---

## Step 2: Put the new files on your website

The site is plain files, so deploy the same way you do today (drag the folder onto Netlify, or push to GitHub Pages).

The work is on a separate branch called `admin-upgrades`, not on `main`. Merge it into `main` when you're happy, then deploy.

---

## Step 3: Live order updates (1 minute, optional)

If you'd like new orders to appear on their own without reloading:

1. In Supabase go to **Database** then **Replication**.
2. Make sure the `orders` table is switched on.

The update in Step 1 tries to do this for you. If the Orders tab doesn't show a small "Live" dot, do it by hand.

---

## Step 4: Email me when an order arrives (about 20 minutes)

Full instructions are in `docs/admin-notifications.md`. In short:

1. Make a free account at <https://resend.com> and create an API key.
2. Deploy the `notify-new-order` function from `supabase/functions/notify-new-order/` (the dashboard lets you paste it in, or use the Supabase command line). **Turn off "Enforce JWT verification" for this function.**
3. In the function's settings add the secrets: `RESEND_API_KEY`, `NOTIFY_EMAIL_TO`, `NOTIFY_EMAIL_FROM`, `NOTIFY_WEBHOOK_SECRET` (the admin page can generate this one for you), plus `ADMIN_URL` (the address of your admin page).
4. In the admin page go to **Settings**, then **More**, then **Notifications**. Press **Save connection**, then **Send test notification**.

For testing you can send from `onboarding@resend.dev`, but Resend only lets that address send to the email you signed up with. To email customers a confirmation you need to verify your own domain in Resend.

Text messages (Twilio) and customer confirmation emails are optional and described in the same document.

---

## Step 5: Let password reset work (1 minute)

1. In Supabase go to **Authentication**, then **URL Configuration**.
2. Under **Redirect URLs** add the address of your admin page, for example `https://yoursite.com/admin.html`.

Without this, the new "Forgot password?" link can't send you back to the right page.

---

## Step 6: Staff logins (optional)

If someone helps you with orders but shouldn't be able to delete things or change the site:

1. In Supabase go to **Authentication**, then **Users**, then **Add user** and create their login.
2. In the admin page go to **Settings**, then **More**, then **Team**, and add their email as **staff**.

Staff can see orders and products and update order status, notes and payments. They can't delete anything, edit settings, or see the activity log.

---

## Step 7: Two-step login (optional, do this carefully)

1. In the admin page go to **Settings**, then **More**, then **Security**.
2. Scan the QR code with an authenticator app (Google Authenticator, Authy, 1Password and so on).
3. Enter the 6-digit code to switch it on.

Two-step login has only been tested against a local stand-in, never against a real Supabase project. If it misbehaves, it could lock you out of your own admin. So before turning it on for your real account, either try it on a free throwaway Supabase project first, or keep a second owner account that doesn't have it switched on. `docs/admin-safety.md` explains how to recover if you lose your phone.

---

## Check it all works (10 minutes)

On your live site, in order:

1. Place a test order on the site. It should appear in **Orders** within seconds (if live updates are on) and you should get an email.
2. Tap the order. The side panel should show the items, total and a payment editor.
3. Set a deposit, then check the "Due" badge changes.
4. Press **Print work order** and check it looks right.
5. Open the **Overview** tab and check the numbers look sensible.
6. In **Products**, add a test product with a sale price, then delete it. It should land in **Trash** and be restorable.
7. In **Settings**, change something, press **Preview**, then **Discard**.
8. Download a backup, then look at the **Restore** section to see that it reads the file. Don't press Restore on your real data unless you mean to.

---

## Known gaps

- Stock isn't reduced automatically when someone orders. You change it by hand.
- The normal checkout form doesn't ask for a delivery time or pickup, only the custom-order form does.
- A sale price on a product that has several sizes may show a "Sale" badge while the size prices themselves aren't discounted.
- None of this has been run against your real Supabase project yet. It was tested against local stand-ins. If something misbehaves, the admin shows a message saying which update is missing, and `docs/DATABASE.md` tells you which file to run.
