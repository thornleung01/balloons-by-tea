#!/usr/bin/env node
/* Admin visual + contrast check.
 *
 * Serves the repo on a random local port, injects a fake Supabase client with
 * realistic data, opens admin.html and, for every registered admin tab (plus a
 * few extra views: orders drawer, login, dialog, toast) at 390 / 768 / 1280 px
 * wide in light and dark themes, it:
 *   - saves a screenshot,
 *   - fails on page errors, native dialogs and horizontal scroll,
 *   - runs a contrast audit over every visible text node (WCAG AA: 4.5:1,
 *     3:1 for large text = >= 24px or >= 18.66px bold).
 *
 * Usage:
 *   node scripts/admin-visual-check.js [--theme light|dark|both] [--tabs a,b]
 *        [--widths 390,768,1280] [--out DIR] [--views] [--no-shots] [--verbose]
 *
 *   --tabs   comma list of tab keys, or "none" to skip tabs. Default: all.
 *   --views  also run the extra views (default on; --no-views to skip).
 *
 * Needs Playwright to RUN (not a repo dependency): set PW_PATH to the
 * playwright module folder, or have `playwright` resolvable from Node.
 * Exit code: 0 pass, 1 failures, 2 harness error.
 */
"use strict";
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf("--" + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}
const THEME_ARG = String(arg("theme", "both"));
const THEMES = THEME_ARG === "both" ? ["light", "dark"] : [THEME_ARG];
const WIDTHS = String(arg("widths", "390,768,1280")).split(",").map(Number).filter(Boolean);
const OUT = String(arg("out", path.join(os.tmpdir(), "admin-shots")));
const TAB_ARG = arg("tabs", null);
const NO_SHOTS = argv.includes("--no-shots");
const NO_VIEWS = argv.includes("--no-views");
const VERBOSE = argv.includes("--verbose");
const TEXT_MIN = 4.5, LARGE_MIN = 3;

let playwright;
try { playwright = require(process.env.PW_PATH || "playwright"); }
catch (e) { console.error("Playwright not found. Set PW_PATH to the playwright module folder or install it."); process.exit(2); }

const root = path.resolve(__dirname, "..");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".otf": "font/otf", ".ttf": "font/ttf", ".json": "application/json" };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]); if (p === "/") p = "/index.html";
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": mime[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});

/* Fake Supabase: tables return realistic rows; unknown tables behave like a
   missing table (migration not run). window.__NO_SESSION shows the login view. */
const STUB = `
(function(){
  var now = new Date(), iso = function(d){ return d.toISOString(); };
  var plus = function(n){ var d = new Date(now); d.setDate(d.getDate()+n); return d; };
  var day = function(n){ return plus(n).toISOString().slice(0,10); };
  var db = {
    collections: [{id:1,slug:"birthday",title:"Birthday",tagline:"Party",sort_order:0,is_legacy:false,card_image_url:null},{id:2,slug:"kids",title:"Kids",tagline:"",sort_order:1,is_legacy:false,card_image_url:null}],
    nav_items: [{id:1,label:"Home",href:"index.html",icon:"home",sort_order:0,visible:true,key:"home"}],
    faq_items: [{id:1,question:"How far ahead?",answer:"A week.",sort_order:0,is_open_default:false}],
    products: [
      {id:1,collection:"birthday",name:"Gold Arch",price:120,description:"x",style:"golden classic",image_url:null,images:[],active:true,created_at:iso(plus(-20)),sku:"GA1",sale_price:99,stock:2,tags:[],sort_order:0,featured:true,variants:[],addons:[],deleted_at:null},
      {id:3,collection:"birthday",name:"Pastel Garland",price:80,description:"",style:"",image_url:null,images:[],active:false,created_at:iso(plus(-12)),sku:"PG1",sale_price:null,stock:0,tags:[],sort_order:1,featured:false,variants:[],addons:[],deleted_at:null},
      {id:2,collection:"kids",name:"Unicorn Set",price:90,description:"",style:"",image_url:null,images:[],active:true,created_at:iso(plus(-10)),deleted_at:iso(plus(-2))}],
    orders: [
      {id:1,kind:"checkout",name:"Ann Lee",phone:"555-0100",email:"a@x.com",address:"1 Main",event_date:day(3),event_on:day(3),notes:"",summary:"1 x Gold Arch",total:"$120.00",total_amount:120,status:"new",payment_status:"unpaid",amount_paid:0,items:[{name:"Gold Arch",qty:1,unit_price:120,line_total:120}],created_at:iso(plus(-1)),attachments:[],admin_notes:"",source:"instagram"},
      {id:2,kind:"custom",name:"Bo Chen",phone:"",email:"b@x.com",address:"",event_date:"",event_on:null,notes:"hi",summary:"custom",total:"Budget: $300",status:"contacted",payment_status:"deposit_paid",amount_paid:50,created_at:iso(plus(-5)),attachments:[],admin_notes:""},
      {id:3,kind:"checkout",name:"Cy Diaz",phone:"555-0111",email:"c@x.com",address:"2 Oak",event_date:day(8),event_on:day(8),notes:"",summary:"2 x Garland",total:"$160.00",total_amount:160,status:"quoted",payment_status:"paid",amount_paid:160,items:[{name:"Garland",qty:2,unit_price:80,line_total:160}],created_at:iso(plus(-3)),attachments:[],admin_notes:""},
      {id:4,kind:"checkout",name:"Di Park",phone:"555-0122",email:"d@x.com",address:"",event_date:day(-4),event_on:day(-4),notes:"",summary:"1 x Arch",total:"$120.00",total_amount:120,status:"fulfilled",payment_status:"refunded",amount_paid:0,items:[],created_at:iso(plus(-9)),attachments:[],admin_notes:""},
      {id:5,kind:"checkout",name:"Ed Ng",phone:"",email:"e@x.com",address:"",event_date:"",event_on:null,notes:"",summary:"1 x Arch",total:"$120.00",total_amount:120,status:"cancelled",payment_status:"unpaid",amount_paid:0,items:[],created_at:iso(plus(-7)),attachments:[],admin_notes:""}],
    site_settings: [{key:"business_name",value:"Balloons by Tea"}],
    blocked_dates: [], delivery_areas: [], gallery_items: [], analytics_events: [], layout_overrides: []
  };
  window.__db = db; window.__missing = {};
  function Q(table){
    var q = {};
    var res = function(){
      var rows = db[table];
      if (!rows) { window.__missing[table] = 1; return { data: null, error: { code: "PGRST205", message: "Could not find the table " + table } }; }
      return { data: rows.slice(), error: null, count: rows.length };
    };
    q.then = function(a,b){ return Promise.resolve(res()).then(a,b); };
    ["select","insert","update","delete","upsert","eq","neq","in","is","not","or","ilike","like","gt","gte","lt","lte","order","limit","range","contains","filter","match","textSearch","csv"].forEach(function(m){ q[m]=function(){ return q; }; });
    q.single = q.maybeSingle = function(){ var r = res(); return Promise.resolve({ data: r.data && r.data[0] || null, error: r.error }); };
    return q;
  }
  var auth = {
    getSession(){ return Promise.resolve({ data: { session: window.__NO_SESSION ? null : { user: { email: "owner@test.dev", id: "u1" }, access_token: "x" } } }); },
    onAuthStateChange(){ return { data: { subscription: { unsubscribe(){} } } }; },
    signOut(){ return Promise.resolve({ error: null }); },
    getUser(){ return Promise.resolve({ data: { user: { email: "owner@test.dev", id:"u1" } }, error: null }); },
    mfa: { getAuthenticatorAssuranceLevel(){ return Promise.resolve({ data: { currentLevel: "aal1", nextLevel: "aal1" }, error: null }); }, listFactors(){ return Promise.resolve({ data: { all: [], totp: [] }, error: null }); } }
  };
  var client = { auth: auth, from: Q,
    rpc(name){ if (name === "admin_role") return Promise.resolve({ data: "owner", error: null }); if (name==="is_admin") return Promise.resolve({data:true,error:null}); window.__missing["rpc:"+name]=1; return Promise.resolve({ data: null, error: { code: "PGRST202", message: "Could not find the function " + name } }); },
    storage: { from(){ return { getPublicUrl(){ return { data: { publicUrl: "" } }; }, list(){ return Promise.resolve({ data: [], error: null }); }, remove(){ return Promise.resolve({ data: [], error: null }); }, upload(){ return Promise.resolve({ error: null }); }, createSignedUrls(){ return Promise.resolve({ data: [], error: null }); } }; } },
    functions: { invoke(){ return Promise.resolve({ data: null, error: { message: "not deployed" } }); } },
    channel(){ var c = { on(){ return c; }, subscribe(){ return c; }, unsubscribe(){} }; return c; }, removeChannel(){} };
  window.supabase = { createClient: function(){ return client; } };
})();
`;

/* Runs inside the page. Returns [{sel, text, fg, bg, ratio, need, size}]. */
function contrastAudit(opts) {
  const parse = (s) => {
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(parseFloat);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (top, bot) => {
    const a = top.a + bot.a * (1 - top.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: (top.r * top.a + bot.r * bot.a * (1 - top.a)) / a,
      g: (top.g * top.a + bot.g * bot.a * (1 - top.a)) / a,
      b: (top.b * top.a + bot.b * bot.a * (1 - top.a)) / a, a };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  const short = (el) => {
    const parts = [];
    for (let n = el, i = 0; n && n.nodeType === 1 && i < 3 && n !== document.body; n = n.parentElement, i++) {
      let s = n.tagName.toLowerCase();
      if (n.id) { s += "#" + n.id; parts.unshift(s); break; }
      const cls = (n.getAttribute("class") || "").split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) s += "." + cls.join(".");
      parts.unshift(s);
    }
    return parts.join(" > ");
  };
  const bgOf = (el) => {
    const chain = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) chain.unshift(n);
    const canvas = parse(getComputedStyle(document.documentElement).backgroundColor);
    let base = canvas && canvas.a ? canvas : { r: 255, g: 255, b: 255, a: 1 };
    let unknown = false;
    for (const n of chain) {
      const cs = getComputedStyle(n);
      const c = parse(cs.backgroundColor);
      if (cs.backgroundImage && cs.backgroundImage !== "none") unknown = true;
      if (c && c.a > 0) {
        const op = parseFloat(cs.opacity);
        const comp = over(c, base);
        base = op < 1 ? { r: comp.r * op + base.r * (1 - op), g: comp.g * op + base.g * (1 - op), b: comp.b * op + base.b * (1 - op), a: 1 } : comp;
      }
    }
    return { color: base, unknown };
  };
  const out = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const el = node.parentElement;
    if (!el || /^(SCRIPT|STYLE|OPTION|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
    if (el.closest("[hidden],[aria-hidden='true'],.sr-only,[disabled],[aria-disabled='true'],fieldset:disabled")) continue;
    if (el.closest(":disabled")) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.fontSize) === 0) continue;
    const r = document.createRange(); r.selectNodeContents(node);
    const rect = r.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    // clipped away by an overflow:hidden ancestor / offscreen: skip
    let clipped = false;
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const c = getComputedStyle(n);
      if (/(hidden|clip)/.test(c.overflow + c.overflowX + c.overflowY)) {
        const b = n.getBoundingClientRect();
        if (b.width < 2 || b.height < 2 || rect.right < b.left || rect.left > b.right || rect.bottom < b.top || rect.top > b.bottom) { clipped = true; break; }
      }
      if (c.clip && /rect\(0(px)?, 0(px)?, 0(px)?, 0(px)?\)/.test(c.clip)) { clipped = true; break; }
    }
    if (clipped) continue;
    if (rect.right < 0 || rect.bottom < 0 || rect.left > innerWidth) continue;
    if (opts.scope && !el.closest(opts.scope)) continue;
    // covered by an overlay (drawer, dialog scrim)? then it is not readable text right now
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    if (cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight) {
      const hit = document.elementFromPoint(cx, cy);
      if (hit && !el.contains(hit) && !hit.contains(el)) continue;
    }
    let fg = parse(cs.color);
    if (!fg) continue;
    let opacity = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) opacity *= parseFloat(getComputedStyle(n).opacity);
    const bgInfo = bgOf(el);
    if (bgInfo.unknown && opts.skipGradient) continue;
    const bg = bgInfo.color;
    let fgc = over({ r: fg.r, g: fg.g, b: fg.b, a: fg.a * opacity }, bg);
    const size = parseFloat(cs.fontSize), weight = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? opts.large : opts.text;
    const rt = ratio(fgc, bg);
    if (rt < need) {
      const key = short(el) + "|" + hex(fgc) + "|" + hex(bg);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ sel: short(el), text: text.slice(0, 40), fg: hex(fgc), bg: hex(bg), ratio: Math.round(rt * 100) / 100, need, size: Math.round(size * 10) / 10, grad: bgInfo.unknown });
    }
  }
  return out;
}

let failures = 0, checks = 0, contrastFails = 0;
const fail = (m) => { failures++; console.log("FAIL " + m); };

(async () => {
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + srv.address().port;
  const browser = await playwright.chromium.launch();
  if (!NO_SHOTS) fs.mkdirSync(OUT, { recursive: true });

  for (const theme of THEMES) {
    for (const w of WIDTHS) {
      const label = theme + "-" + w;
      const ctx = await browser.newContext({ viewport: { width: w, height: w < 600 ? 800 : 900 }, colorScheme: theme, reducedMotion: "reduce" });
      await ctx.route(/cdn\.jsdelivr\.net/, (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
      await ctx.route(/fonts\.(googleapis|gstatic)|google|clarity|supabase\.co/, (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
      await ctx.addInitScript(STUB);
      await ctx.addInitScript((t) => { try { localStorage.setItem("adminTheme", t); } catch (e) {} }, theme);

      async function open(extraInit) {
        const page = await ctx.newPage();
        const errs = [];
        page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
        page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|net::ERR|integrity|supabase|404/.test(m.text())) errs.push("console: " + m.text()); });
        page.on("dialog", (d) => { errs.push("NATIVE DIALOG: " + d.message()); d.dismiss(); });
        if (extraInit) await page.addInitScript(extraInit);
        await page.goto(base + "/admin.html", { waitUntil: "load" });
        await page.waitForTimeout(1200);
        return { page, errs };
      }

      async function inspect(page, errs, name, scope) {
        checks++;
        const tag = label + " " + name;
        if (!NO_SHOTS) await page.screenshot({ path: path.join(OUT, label + "-" + name + ".png") });
        const st = await page.evaluate(() => ({
          h: document.documentElement.scrollWidth > window.innerWidth + 2,
          theme: getComputedStyle(document.body).colorScheme,
          dataTheme: document.documentElement.dataset.theme || "" }));
        if (st.h) fail(tag + ": horizontal scroll");
        if (errs.length) { errs.splice(0).forEach((e) => fail(tag + ": " + e)); }
        const res = await page.evaluate(contrastAudit, { text: TEXT_MIN, large: LARGE_MIN, skipGradient: false, scope: scope || "" });
        for (const c of res) {
          contrastFails++; failures++;
          console.log("FAIL " + tag + ": contrast " + c.ratio + " < " + c.need + "  " + c.sel + "  fg " + c.fg + " on " + c.bg + (c.grad ? " (gradient bg)" : "") + "  " + c.size + "px  \"" + c.text + "\"");
        }
        if (VERBOSE && !res.length) console.log("ok   " + tag);
      }

      // ---- tabs
      const { page, errs } = await open();
      const dash = await page.evaluate(() => { const d = document.getElementById("dashboardView"); return !!d && !d.hidden; });
      if (!dash) fail(label + ": dashboard not visible after sign in");
      else {
        let keys = await page.evaluate(() => Object.keys(TABS));
        if (TAB_ARG === "none") keys = [];
        else if (TAB_ARG && TAB_ARG !== true) { const want = String(TAB_ARG).split(","); keys = keys.filter((k) => want.includes(k)); }
        for (const k of keys) {
          await page.evaluate((k) => adminNavigate(k), k).catch((e) => errs.push("nav " + k + ": " + e.message));
          await page.waitForTimeout(350);
          const shown = await page.evaluate((k) => { const t = TABS[k]; const p = t && document.getElementById(t.panelId); return !!p && !p.hidden; }, k);
          if (!shown) { fail(label + " tab " + k + ": panel not shown"); continue; }
          await inspect(page, errs, k);
        }
        if (!NO_VIEWS && !TAB_ARG) {
          await page.evaluate(() => adminNavigate("orders", { orderId: "1" })).catch(() => {});
          await page.waitForTimeout(600);
          await inspect(page, errs, "orders-drawer", "#orderDrawer");
          await page.keyboard.press("Escape");
          await page.evaluate(() => { adminToast("Saved your changes", { kind: "success", duration: 0 }); adminToast("Something went wrong", { kind: "error", duration: 0 }); adminToast("Heads up", { kind: "info", duration: 0 }); });
          await page.evaluate(() => { adminConfirm({ title: "Delete product?", message: "This cannot be undone.", confirmLabel: "Delete", danger: true }); });
          await page.waitForTimeout(300);
          await inspect(page, errs, "dialog-toasts", ".aui-backdrop, .aui-toasts");
        }
      }
      await page.close();

      // ---- login view
      if (!NO_VIEWS && !TAB_ARG) {
        const l = await open(() => { window.__NO_SESSION = true; });
        const shown = await l.page.evaluate(() => { const v = document.getElementById("loginView"); return !!v && !v.hidden; });
        if (!shown) fail(label + " login: login view not shown");
        else await inspect(l.page, l.errs, "login");
        await l.page.close();
      }
      await ctx.close();
    }
  }
  await browser.close(); srv.close();
  console.log("\n" + checks + " view checks, " + contrastFails + " contrast failure(s), " + failures + " failure(s) total" + (NO_SHOTS ? "" : "; screenshots in " + OUT));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(2); });
