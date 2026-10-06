#!/usr/bin/env node
/**
 * check-shared-markup.js
 *
 * Dev-time safety net (NOT part of the live site, no runtime cost).
 *
 * This site intentionally has no build step and no runtime include mechanism:
 * the nav, footer, cart drawer, and checkout modal are duplicated byte-for-byte
 * into every top-level HTML page so the browser can paint them immediately
 * (no flash-of-unstyled-nav, no extra fetch/inject round trip, sticky-nav
 * positioning math runs against markup that's already in the DOM on first
 * paint). The tradeoff is that nothing stops the 9 copies from drifting apart
 * when someone edits a nav link, icon, or checkout field on one page and
 * forgets the other 8.
 *
 * This script is that missing guardrail. It extracts the nav / footer /
 * cart-drawer / checkout-modal blocks from every top-level page, hashes each
 * block per page, and reports whether all pages agree. Run it by hand before
 * shipping a change to any of these shared blocks, or wire it into CI.
 *
 * Exit code 0 = all blocks consistent across all pages.
 * Exit code 1 = drift found (or a page/block could not be extracted).
 *
 * Usage: node scripts/check-shared-markup.js
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");

// The 10 top-level pages that are supposed to share this markup.
// (admin.html and 404.html are intentionally excluded: they are not part of
// the public page set that ships the shared nav/footer/cart/checkout chrome.)
const PAGES = [
  "index.html",
  "about.html",
  "faq.html",
  "custom-order.html",
  "all-products.html",
  "anniversary.html",
  "birthday.html",
  "kids.html",
  "other-occasions.html",
  "category.html",
];

/**
 * Extract the first `<START ...>...</END>` block from source, matching START
 * literally (a simple string search, not a regex) and scanning forward for
 * the matching close tag. Works for tags that do not nest inside themselves
 * (nav, footer, aside) where a plain indexOf of the close tag is reliable.
 */
function extractSimple(html, openNeedle, closeTag) {
  const start = html.indexOf(openNeedle);
  if (start === -1) return null;
  const end = html.indexOf(closeTag, start);
  if (end === -1) return null;
  return html.slice(start, end + closeTag.length);
}

/**
 * Extract a block that starts with `openNeedle` and is itself a <div>,
 * possibly containing nested <div> elements (the checkout modal). Scans
 * forward counting div open/close tags so it stops at the DIV that actually
 * balances the opening one, not the first "</div>" encountered.
 */
function extractBalancedDiv(html, openNeedle) {
  const start = html.indexOf(openNeedle);
  if (start === -1) return null;

  const tagRe = /<div[\s>]|<\/div>/gi;
  tagRe.lastIndex = start;

  let depth = 0;
  let match;
  while ((match = tagRe.exec(html)) !== null) {
    if (match[0].toLowerCase().startsWith("</div")) {
      depth -= 1;
      if (depth === 0) {
        const end = match.index + match[0].length;
        return html.slice(start, end);
      }
    } else {
      depth += 1;
    }
  }
  return null;
}

// Block definitions: name -> extractor function.
const BLOCKS = {
  nav: (html) => extractSimple(html, '<nav class="nav">', "</nav>"),
  footer: (html) => extractSimple(html, '<footer class="footer">', "</footer>"),
  "cart-drawer": (html) =>
    extractSimple(html, '<aside class="cart-drawer"', "</aside>"),
  "checkout-modal": (html) =>
    extractBalancedDiv(html, '<div class="modal" id="checkoutModal"'),
};

function hash(text) {
  return crypto.createHash("md5").update(text, "utf8").digest("hex");
}

function main() {
  /** @type {Record<string, Record<string, {hash: string, text: string}|null>>} */
  const results = {};
  for (const blockName of Object.keys(BLOCKS)) {
    results[blockName] = {};
  }

  const missing = [];

  for (const page of PAGES) {
    const filePath = path.join(ROOT, page);
    let html;
    try {
      html = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      console.error(`ERROR: could not read ${page}: ${err.message}`);
      process.exitCode = 1;
      continue;
    }

    for (const [blockName, extractor] of Object.entries(BLOCKS)) {
      const block = extractor(html);
      if (block === null) {
        missing.push(`${page}: could not find/extract "${blockName}" block`);
        results[blockName][page] = null;
      } else {
        results[blockName][page] = { hash: hash(block), text: block };
      }
    }
  }

  let drift = false;
  const lines = [];

  lines.push("Shared markup consistency report");
  lines.push("=================================");
  lines.push(`Pages checked (${PAGES.length}): ${PAGES.join(", ")}`);
  lines.push("");

  for (const blockName of Object.keys(BLOCKS)) {
    const perPage = results[blockName];
    const pagesWithBlock = PAGES.filter((p) => perPage[p] !== null);
    const hashCounts = new Map(); // hash -> [pages]

    for (const page of pagesWithBlock) {
      const h = perPage[page].hash;
      if (!hashCounts.has(h)) hashCounts.set(h, []);
      hashCounts.get(h).push(page);
    }

    const distinctHashes = hashCounts.size;

    if (pagesWithBlock.length !== PAGES.length) {
      drift = true;
      const missingPages = PAGES.filter((p) => perPage[p] === null);
      lines.push(
        `[FAIL] ${blockName}: could not be extracted from: ${missingPages.join(", ")}`
      );
    } else if (distinctHashes === 1) {
      lines.push(
        `[OK]   ${blockName}: identical across all ${PAGES.length} pages (md5 ${[...hashCounts.keys()][0]})`
      );
    } else {
      drift = true;
      lines.push(
        `[FAIL] ${blockName}: DRIFT DETECTED — ${distinctHashes} distinct versions across pages:`
      );
      // Use the most common version as the implicit "majority" baseline for readability.
      const sorted = [...hashCounts.entries()].sort(
        (a, b) => b[1].length - a[1].length
      );
      sorted.forEach(([h, pages], idx) => {
        const label = idx === 0 ? "majority" : `variant ${idx}`;
        lines.push(`         - ${label} (md5 ${h}): ${pages.join(", ")}`);
      });
    }
  }

  if (missing.length) {
    drift = true;
    lines.push("");
    lines.push("Extraction problems:");
    for (const m of missing) lines.push(`  - ${m}`);
  }

  lines.push("");
  lines.push(
    drift
      ? "RESULT: DRIFT FOUND — fix the page(s)/block(s) named above before shipping."
      : "RESULT: All shared blocks are byte-identical across all pages. No drift."
  );

  console.log(lines.join("\n"));

  process.exit(drift ? 1 : 0);
}

main();
