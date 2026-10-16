#!/usr/bin/env node
/* Overview + Analytics visual check with richer fake data.
 *
 * A thin wrapper around scripts/admin-visual-check.js (same flags, same checks):
 * it reads that script, patches the injected fake Supabase client so the two
 * tabs get realistic volumes (46 orders, ~4,000 analytics events over 120 days,
 * upcoming events, a negative revenue delta, blocked dates) and so one of five
 * scenarios can be selected with OVAN_SCEN:
 *
 *   rich     (default) lots of data
 *   empty    no orders, no events, nothing to warn about
 *   onefail  everything loads except the Top products card (its fallback RPC rejects)
 *   fail     orders and analytics_events queries return an error
 *   slow     orders and analytics_events never answer (shows the loading skeletons)
 *
 *   $env:OVAN_SCEN="slow"; node scripts/ovan-visual-check.js --tabs overview,analytics --theme both --out <dir>
 */
"use strict";
const fs = require("fs");
const path = require("path");

const scen = process.env.OVAN_SCEN || "rich";
let src = fs.readFileSync(path.join(__dirname, "admin-visual-check.js"), "utf8").replace(/^#![^\n]*\n/, "");

/* Runs inside the page, after the base `db` is defined and before the client is built.
   Plain string concatenation only (it is embedded in a template literal). */
const FIXTURE = function (SCEN) {
  var now = new Date();
  var rnd = (function () { var s = 20260715; return function () { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; })();
  var day = function (n) { var d = new Date(now); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  var plus = function (n, h) { var d = new Date(now); d.setDate(d.getDate() + n); d.setHours(h == null ? 10 : h, Math.floor(rnd() * 59), 0, 0); return d; };
  var chain = function (fn) {
    var q = {}; q.then = fn;
    ["select", "order", "limit", "range", "eq", "neq", "gte", "lte", "lt", "gt", "in", "is", "not", "or", "ilike"].forEach(function (m) { q[m] = function () { return q; }; });
    return q;
  };
  var failQ = function () { return chain(function (a, b) { return Promise.resolve({ data: null, error: { code: "XX000", message: "Database timeout" } }).then(a, b); }); };
  var hangQ = function () { return chain(function () { return new Promise(function () {}); }); };
  window.__rpc = {};

  if (SCEN === "empty") {
    db.orders = []; db.analytics_events = []; db.blocked_dates = []; db.products = [];
    db.site_settings = [{ key: "business_name", value: "Balloons by Tea" }, { key: "contact_phone", value: "555" }, { key: "contact_email", value: "a@b.c" }, { key: "contact_whatsapp", value: "x" }];
    return;
  }

  var names = ["Ann Lee", "Bo Chen", "Cy Diaz", "Di Park", "Ed Ng", "Fay Okoro", "Gus Alvarez", "Hana Sato", "Ivo Petrov", "Jo Whitaker-Montgomery"];
  var prods = [["Gold Arch Garland", 120, "birthday"], ["Pastel Cloud Set", 80, "kids"], ["Anniversary Heart Wall", 240, "anniversary"], ["Unicorn Party Pack", 150, "kids"], ["Chrome Number Balloons", 45, "birthday"], ["Confetti Bouquet", 60, "other-occasions"]];
  var statuses = ["new", "contacted", "quoted", "fulfilled", "fulfilled", "cancelled"];
  var sources = ["instagram", "google", "direct", "facebook", "referral:blog.example"];
  var orders = [];
  for (var i = 0; i < 46; i++) {
    var p = prods[i % 6], qty = 1 + Math.floor(rnd() * 3), total = p[1] * qty + (i % 5 === 0 ? 35 : 0);
    var ago = i < 12 ? Math.floor(rnd() * 14) : Math.floor(rnd() * 100);
    var st = i < 6 ? "new" : statuses[Math.floor(rnd() * 6)];
    var ps = st === "fulfilled" ? "paid" : st === "cancelled" ? "unpaid" : (i % 3 === 0 ? "deposit_paid" : "unpaid");
    var ev = i < 8 ? [0, 1, 1, 2, 3, 4, 6, 9][i] : Math.floor(rnd() * 120) - 40;
    orders.push({
      id: 100 + i, kind: i % 9 === 4 ? "custom" : "checkout", name: names[i % names.length], phone: "555-01" + (10 + i), email: "c" + i + "@x.com", address: "1 Main",
      event_date: day(ev) + (i % 2 ? " 14:30" : ""), event_on: day(ev), event_time: i % 2 ? "2:30 PM" : "", notes: "", summary: "Ref: AUR-" + (1000 + i),
      total: i % 9 === 4 ? "Budget: $300" : "$" + total + ".00", total_amount: i % 9 === 4 ? null : total, status: st, payment_status: ps,
      amount_paid: ps === "paid" ? total : ps === "deposit_paid" ? Math.round(total / 3) : 0, deposit_amount: Math.round(total / 3),
      items: SCEN === "onefail" ? [] : [{ name: p[0], qty: qty, unit_price: p[1], line_total: p[1] * qty, product_id: "sb-" + (i % 6), collection: p[2] }],
      created_at: plus(-ago).toISOString(), attachments: [], admin_notes: "", source: i % 4 === 3 ? null : sources[i % 5]
    });
  }
  // A big order early last month: makes this month's revenue "down" against the same point last month.
  orders.push({ id: 900, kind: "checkout", name: "Large Venue Ltd", phone: "", email: "l@x.com", address: "", event_date: day(20), event_on: day(20), notes: "", summary: "Ref: AUR-9000", total: "$4,800.00", total_amount: 4800, status: "fulfilled", payment_status: "paid", amount_paid: 4800, items: [], created_at: new Date(now.getFullYear(), now.getMonth() - 1, 2, 11).toISOString(), attachments: [], admin_notes: "", source: "google" });
  db.orders = orders;
  db.blocked_dates = [{ day: day(2), reason: "Public holiday" }, { day: day(5), reason: "" }];
  db.site_settings = [{ key: "business_name", value: "Balloons by Tea" }, { key: "max_orders_per_day", value: "3" }, { key: "contact_phone", value: "555-0100" }];
  window.__rpc.fully_booked_dates = function () { return Promise.resolve({ data: [{ day: day(3) }, { day: day(4) }], error: null }); };
  if (SCEN === "onefail") window.__rpc.analytics_summary = function () { return Promise.reject(new Error("Network request failed")); };

  // ~4,000 analytics events over 120 days.
  var evs = [], id = 1, fields = ["email", "phone", "address", "event date"];
  var src = ["direct", "instagram", "google", "facebook", "referral:blog.example"];
  for (var d = 120; d >= 0; d--) {
    var dow = plus(-d).getDay(), n = 7 + Math.floor(rnd() * 12) + (dow === 0 || dow === 6 ? 6 : 0) + (d < 30 ? 4 : 0);
    for (var s = 0; s < n; s++) {
      var sid = "s" + d + "-" + s, t = plus(-d, 8 + Math.floor(rnd() * 12)), pr = prods[Math.floor(rnd() * 6)];
      var add = function (name, meta) { evs.push({ id: id++, event_name: name, session_id: sid, metadata: meta || {}, created_at: new Date(t.getTime() + id * 1000).toISOString() }); };
      var first = rnd() < 0.5 ? src[0] : src[1 + Math.floor(rnd() * 4)];
      add("page_view", { traffic_source: first });
      if (rnd() < 0.62) add("product_viewed", { productId: "sb-" + prods.indexOf(pr), name: pr[0], collection: pr[2] });
      if (rnd() < 0.2) add("add_to_cart", { productId: "sb-" + prods.indexOf(pr), name: pr[0], collection: pr[2] });
      if (rnd() < 0.12) add("cart_opened");
      if (rnd() < 0.08) add("checkout_started");
      if (rnd() < 0.03) add("checkout_submitted");
      if (rnd() < 0.04) add("checkout_field_error", { field: fields[Math.floor(rnd() * 4)] });
      if (rnd() < 0.03) add("checkout_abandoned", { filledFields: ["name", "email"] });
      if (rnd() < 0.05) add("custom_order_started");
      if (rnd() < 0.015) add("custom_order_submitted");
    }
  }
  db.analytics_events = evs;

  if (SCEN === "fail" || SCEN === "slow") {
    var bad = SCEN === "fail" ? failQ : hangQ;
    window.__FROM = function (table) { return (table === "orders" || table === "analytics_events") ? bad() : null; };
  }
};

/* 1. fixture + scenario, injected just before the client is built */
src = src.replace("  var client = { auth: auth, from: Q,", () =>
  "  (" + FIXTURE.toString() + ")(" + JSON.stringify(scen) + ");\n  var client = { auth: auth, from: function (t) { var o = window.__FROM && window.__FROM(t); return o || Q(t); },");
/* 2. rpc overrides */
src = src.replace("rpc(name){ if (name === \"admin_role\")", () =>
  "rpc(name, args){ if (window.__rpc && window.__rpc[name]) return window.__rpc[name](args); if (name === \"admin_role\")");
/* 3. .range() slices the rows (the analytics code pages until an empty page) */
src = src.replace("return { data: rows.slice(), error: null, count: rows.length };", () =>
  "var r = q.__r; return { data: r ? rows.slice(r[0], r[1] + 1) : rows.slice(), error: null, count: rows.length };");
src = src.replace("q.single = q.maybeSingle", () => "q.range = function (a, b) { q.__r = [a, b]; return q; }; q.single = q.maybeSingle");
/* 4. full-page screenshots, so the cards below the fold are reviewed too */
src = src.replace("page.screenshot({ path:", () => "page.screenshot({ fullPage: true, path:");
if (!/__rpc/.test(src) || !/__FROM/.test(src) || !/q\.__r/.test(src)) { console.error("harness patch did not apply (admin-visual-check.js changed?)"); process.exit(2); }

new Function("require", "__dirname", "process", "console", src)(require, __dirname, process, console);
