#!/usr/bin/env node
/* Guard rails for the admin design system (docs/admin-design-system.md).
 * No dependencies. Run from anywhere:  node scripts/check-admin-tokens.js [--table]
 *
 * Fails (exit 1) when:
 *   - css/admin*.css (other than css/admin-tokens.css) contains a hex colour or an
 *     rgb()/rgba()/hsl() literal  -> use a token from css/admin-tokens.css
 *   - border-radius / border-*-radius uses a px value  -> use --radius-* / --a-radius-*
 *     (0, 50% and var() are fine; 50% is for avatars and dots only)
 *   - z-index uses a number other than 0 / -1 / auto  -> use --a-z-*
 *   - !important appears outside the allowlist below
 *   - admin.html has a style="" attribute, or an admin JS template has one that is
 *     not a data-driven width / fill / stroke
 *   - a status colour pair or chart colour in css/admin-tokens.css misses its
 *     WCAG contrast target (4.5:1 text pairs, 3:1 chart colours on the card)
 *
 * --table prints the contrast table (used in docs/admin-design-system.md).
 */
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const cssDir = path.join(root, "css");
const TOKENS = "admin-tokens.css";
const errors = [];
const fail = (file, line, msg) => errors.push(file + (line ? ":" + line : "") + "  " + msg);

/* !important is only allowed where a hide/lockdown utility or a forced-colors
   override must beat an inline style or a more specific display rule. */
const IMPORTANT_ALLOW = [
  { file: "admin-analytics.css", selector: /\.ac-(path|bar|dot)/, why: "forced-colors override of inline SVG styles" },
  { file: "admin-content.css", selector: /is-settings-hidden/, why: "hide utility" },
  { file: "admin-safety.css", selector: /role-staff/, why: "staff lockdown hides owner-only UI" }
];

/* ---------- helpers ---------- */
function stripComments(css) {
  // keep newlines so line numbers survive
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}
function lineOf(text, index) { return text.slice(0, index).split("\n").length; }
function selectorFor(text, index) {
  const open = text.lastIndexOf("{", index);
  const prevClose = Math.max(text.lastIndexOf("}", open), text.lastIndexOf(";", open));
  return text.slice(prevClose + 1, open).trim();
}

/* ---------- CSS rules ---------- */
const files = fs.readdirSync(cssDir).filter((f) => /^admin.*\.css$/.test(f) && f !== TOKENS);
for (const f of files) {
  const raw = fs.readFileSync(path.join(cssDir, f), "utf8");
  const css = stripComments(raw);
  let m;

  const colour = /#[0-9a-fA-F]{3,8}\b(?![\w-])|\b(?:rgba?|hsla?)\(/g;
  while ((m = colour.exec(css))) {
    // ignore hex-looking tokens inside url(...) and attribute selectors like [href="#x"]
    const before = css.slice(Math.max(0, m.index - 40), m.index);
    if (/url\([^)]*$/.test(before) || /\[[^\]]*$/.test(before)) continue;
    fail(f, lineOf(css, m.index), "colour literal " + m[0] + " (use a token from " + TOKENS + ")");
  }

  const radius = /border(?:-[a-z]+){0,2}-radius\s*:\s*([^;}]*)/g;
  while ((m = radius.exec(css))) {
    if (/\d+(\.\d+)?px/.test(m[1]) && !/var\(/.test(m[1].replace(/\d+px/g, ""))) fail(f, lineOf(css, m.index), "px border-radius '" + m[1].trim() + "' (use --radius-* or --a-radius-xs)");
    else if (/\d+(\.\d+)?px/.test(m[1])) fail(f, lineOf(css, m.index), "px border-radius '" + m[1].trim() + "' (use the radius scale)");
  }

  const z = /z-index\s*:\s*([^;}]*)/g;
  while ((m = z.exec(css))) {
    const v = m[1].trim();
    if (/^-?\d+$/.test(v) && v !== "0" && v !== "-1") fail(f, lineOf(css, m.index), "z-index " + v + " (use --a-z-*)");
  }

  const imp = /!important/g;
  while ((m = imp.exec(css))) {
    const decl = css.slice(css.lastIndexOf(";", m.index) + 1, m.index);
    const sel = selectorFor(css, m.index);
    const ok = IMPORTANT_ALLOW.some((a) => a.file === f && (a.selector.test(sel) || a.selector.test(decl)));
    if (!ok) fail(f, lineOf(css, m.index), "!important in '" + sel.replace(/\s+/g, " ").slice(0, 60) + "' (fix with specificity, or add to the allowlist with a reason)");
  }
}

/* ---------- inline styles ---------- */
const html = fs.readFileSync(path.join(root, "admin.html"), "utf8");
{
  const re = /\sstyle="/g; let m;
  while ((m = re.exec(html))) fail("admin.html", lineOf(html, m.index), 'inline style="" (use a class)');
}
const DYNAMIC_STYLE = /^(width:\s*\$\{|fill:\s*\$\{|stroke:\s*\$\{)/;
for (const f of fs.readdirSync(path.join(root, "js")).filter((n) => /^admin.*\.js$/.test(n))) {
  const js = fs.readFileSync(path.join(root, "js", f), "utf8");
  const re = /style="([^"]*)"/g; let m;
  while ((m = re.exec(js))) {
    if (m[1] === "" || DYNAMIC_STYLE.test(m[1])) continue; // data-driven values (bar width, series colour) are the one allowed use
    fail("js/" + f, lineOf(js, m.index), 'inline style="' + m[1].slice(0, 40) + '" (use a class)');
  }
}

/* ---------- token contrast ---------- */
function hexToRgb(h) {
  h = h.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function lum(c) { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); }
function ratio(a, b) { const x = lum(hexToRgb(a)), y = lum(hexToRgb(b)); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

const tokensCss = stripComments(fs.readFileSync(path.join(cssDir, TOKENS), "utf8"));
function declsOf(startMarker) {
  const i = tokensCss.indexOf(startMarker);
  if (i === -1) return {};
  const end = tokensCss.indexOf("\n}", i);
  const out = {};
  for (const m of tokensCss.slice(i, end).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const light = declsOf("body.admin-body {");
const dark = Object.assign({}, light, declsOf(':root[data-theme="dark"] body.admin-body {'));
const pub = {};
{
  const sc = stripComments(fs.readFileSync(path.join(cssDir, "styles.css"), "utf8"));
  const i = sc.indexOf(":root {");
  for (const m of sc.slice(i, sc.indexOf("\n}", i)).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) pub[m[1]] = m[2].trim();
}
function resolve(theme, name, depth) {
  depth = depth || 0;
  let v = theme[name] != null ? theme[name] : pub[name];
  if (v == null || depth > 8) return null;
  const alias = v.match(/^var\((--[a-z0-9-]+)\)$/);
  if (alias) return resolve(theme, alias[1], depth + 1);
  return /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : null;
}

const SEMANTIC = ["success", "warning", "danger", "info", "neutral", "accent"];
const DOMAIN = ["new", "contacted", "quoted", "fulfilled", "cancelled", "unpaid", "deposit", "paid", "refunded", "balance", "sale", "featured", "lowstock", "outofstock", "scheduled", "expired", "hidden"];
const PAIRS = []; // [label, fgToken, bgToken, min]
for (const s of SEMANTIC) PAIRS.push([s + " (badge)", "--a-" + s + "-fg", "--a-" + s + "-bg", 4.5]);
for (const d of DOMAIN) PAIRS.push(["status-" + d, "--a-status-" + d + "-fg", "--a-status-" + d + "-bg", 4.5]);
PAIRS.push(["label on accent fill", "--a-on-accent", "--color-accent", 4.5]);
PAIRS.push(["label on accent hover", "--a-on-accent", "--color-accent-hover", 4.5]);
PAIRS.push(["label on danger fill", "--a-on-danger", "--a-danger-solid", 4.5]);
PAIRS.push(["label on success fill", "--a-on-success", "--a-success-solid", 4.5]);
PAIRS.push(["accent text on page", "--a-accent-text", "--color-bg-alt", 4.5]);
PAIRS.push(["accent text on card", "--a-accent-text", "--color-surface-solid", 4.5]);
PAIRS.push(["accent text on accent tint", "--a-accent-text", "--a-accent-bg", 4.5]);
PAIRS.push(["body text on page", "--color-fg", "--color-bg-alt", 4.5]);
PAIRS.push(["body text on card", "--color-fg", "--color-surface-solid", 4.5]);
PAIRS.push(["soft text on card", "--color-fg-soft", "--color-surface-solid", 4.5]);
PAIRS.push(["faint text on card", "--color-fg-faint", "--color-surface-solid", 4.5]);
PAIRS.push(["faint text on page", "--color-fg-faint", "--color-bg-alt", 4.5]);
PAIRS.push(["danger text on card", "--color-destructive", "--color-surface-solid", 4.5]);
PAIRS.push(["success text on card", "--color-success", "--color-surface-solid", 4.5]);
PAIRS.push(["focus ring on card", "--a-focus", "--color-surface-solid", 3]);
PAIRS.push(["focus ring on page", "--a-focus", "--color-bg-alt", 3]);
PAIRS.push(["field border on card", "--a-field-border", "--color-surface-solid", 3]);
PAIRS.push(["field border on page", "--a-field-border", "--color-bg-alt", 3]);
for (let i = 1; i <= 5; i++) PAIRS.push(["chart-" + i + " on card", "--a-chart-" + i, "--color-surface-solid", 3]);
for (let i = 1; i <= 4; i++) {
  PAIRS.push(["seq-" + i + " on card", "--a-seq-" + i, "--color-surface-solid", 3]);
  PAIRS.push(["seq-" + i + " label", "--a-seq-" + i + "-fg", "--a-seq-" + i, 4.5]);
}
PAIRS.push(["chart up on card", "--a-chart-up", "--color-surface-solid", 4.5]);
PAIRS.push(["chart down on card", "--a-chart-down", "--color-surface-solid", 4.5]);

const table = [];
for (const [label, fgT, bgT, min] of PAIRS) {
  const row = [label, min];
  for (const [theme, name] of [[light, "light"], [dark, "dark"]]) {
    const fg = resolve(theme, fgT), bg = resolve(theme, bgT);
    if (!fg || !bg) { row.push(null); fail(TOKENS, 0, name + ": cannot resolve " + fgT + " / " + bgT + " for the contrast check"); continue; }
    const r = ratio(fg, bg);
    row.push(r);
    if (r < min) fail(TOKENS, 0, name + ": " + label + " " + r.toFixed(2) + ":1 < " + min + ":1 (" + fgT + " " + fg + " on " + bgT + " " + bg + ")");
  }
  table.push(row);
}
if (process.argv.includes("--table")) {
  console.log("| Pair | Min | Light | Dark |\n|---|---|---|---|");
  for (const r of table) console.log("| " + r[0] + " | " + r[1] + ":1 | " + (r[2] ? r[2].toFixed(1) + ":1" : "n/a") + " | " + (r[3] ? r[3].toFixed(1) + ":1" : "n/a") + " |");
}

if (errors.length) {
  console.error(errors.join("\n"));
  console.error("\ncheck-admin-tokens: " + errors.length + " problem(s)");
  process.exit(1);
}
console.log("check-admin-tokens: ok (" + files.length + " stylesheets, " + PAIRS.length + " token contrast pairs)");
