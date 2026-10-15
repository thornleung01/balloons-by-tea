# Orders (admin) — what's new and how to set it up

## One-time setup (2 minutes)

1. Open your Supabase project, then **SQL Editor, New query**.
2. Open the file `supabase-migrations/10-orders-v2.sql`, paste all of it, press **Run**. It's safe to run again, and it never deletes anything.

Until you do this, the site and the Orders tab keep working exactly as before. The Orders tab just shows a small note saying which features need the SQL (payments, the Quoted status, the calendar's real dates and the timeline).

**Live updates (optional):** the SQL also switches on Realtime for orders, so new orders pop up without refreshing. If you see no "Live" dot at the top of the Orders tab, go to Supabase, Database, Replication and turn on `orders`.

## What you can do now

- **Compact order list.** Each row shows the name, event date, status, payment status, balance due and total. Tap a row to open the full order in a panel that slides in from the right. The list loads 50 at a time (Newer / Older buttons at the bottom).
- **Order panel.** Contact details (tap to call, email or WhatsApp), the items, the event date/time and pick-up/delivery, payment tracking, status buttons (New, Contacted, Quoted, Fulfilled, Cancelled), customer photos, your private notes and a timeline of everything that happened.
- **Payments.** Enter the total, deposit and what's been paid so far; the balance is worked out for you. "Deposit received" and "Paid in full" are one-tap shortcuts. Use **Balance due / Unpaid / Deposit paid / Paid** filters above the list to chase money.
- **Calendar.** Switch **List | Calendar** at the top. Each day shows its orders (tap one to open it), days you've blocked in the Delivery tab, and days that hit your daily order limit ("Full"). On a phone it becomes a day-by-day list.
- **Print.** "Print work order" in an order's panel gives a one-page sheet for the day of the event (address, items, notes, photos, tick boxes). "Print day sheet" (under the list, or "Print" on a calendar day) prints every order for one date, in time order.
- **Messages.** In an order's panel, "Send a message" fills in a Quote, Confirmation, Reminder ("your event is tomorrow") or Thank-you note with the customer's name, date, items, total and balance. Edit it if you like, then open WhatsApp, open your email app, or copy it. Each send is recorded in the order's timeline.
- **Edit the wording.** At the bottom of the Orders tab, open **Message templates** to change the templates and your business name. Placeholders: `{name}` `{full_name}` `{date}` `{time}` `{items}` `{total}` `{deposit}` `{balance}` `{ref}` `{business}`. Leave a box empty to use the built-in wording. (They're stored with your site settings, which are public, so don't put anything private in them.)
- **Export CSV.** Exports everything matching your current filters (not just the page you're on). Use the "Event from / to" dates to export a date range. It now includes payment, balance, items, source and fulfilment columns.
- **Where customers came from.** Orders remember whether the customer arrived from Instagram, Google, a link with `?utm_source=...`, and so on. It's shown in the order panel and the CSV.

## For checkout and custom orders (customers)

Checkout now saves a structured item list, a numeric total and the event date; the custom-order form also saves the time and pick-up/delivery choice. If the SQL hasn't been run yet, orders are saved the old way, so customers are never blocked.
