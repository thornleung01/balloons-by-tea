#!/usr/bin/env node
/* Builds supabase-all.sql: the one-paste installer for a NEW Supabase project.
 *
 *   node scripts/build-sql.js           write supabase-all.sql
 *   node scripts/build-sql.js --check   exit 1 if supabase-all.sql is stale
 *
 * supabase-all.sql = supabase-setup.sql, then every file in
 * supabase-migrations/ in numeric order (10-, 20-, ... 60-), each under a
 * banner comment. Nothing is rewritten: the sections are copied verbatim, so
 * supabase-setup.sql and supabase-migrations/*.sql stay the source of truth
 * (existing projects keep running just the migrations they are missing).
 * Every section is idempotent, so the combined file is safe to run again.
 *
 * Migrations are picked up automatically (any NN-name.sql file), so adding
 * 70-something.sql only needs `node scripts/build-sql.js` afterwards.
 * No dependencies. */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const outPath = path.join(root, "supabase-all.sql");
const migrationsDir = path.join(root, "supabase-migrations");

const read = (file) => fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n").replace(/\s+$/, "") + "\n";

function sections() {
  const migrations = fs.readdirSync(migrationsDir)
    .filter((f) => /^\d+-.+\.sql$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b));
  return [
    { label: "supabase-setup.sql (base schema)", file: path.join(root, "supabase-setup.sql"), rel: "supabase-setup.sql" },
    ...migrations.map((f) => ({ label: `supabase-migrations/${f}`, file: path.join(migrationsDir, f), rel: `supabase-migrations/${f}` }))
  ];
}

function build() {
  const parts = sections();
  const rule = "-- " + "=".repeat(74);
  let out = [
    rule,
    "-- supabase-all.sql: complete, ordered installer for a NEW Supabase project",
    rule,
    "-- GENERATED FILE: do not edit. Rebuild with `node scripts/build-sql.js`",
    "-- (`node scripts/build-sql.js --check` fails when this file is out of date).",
    "--",
    "-- Paste the whole file into Supabase Dashboard -> SQL Editor -> Run, once.",
    "-- It is idempotent, so running it again later is safe: it will not undo",
    "-- team roles / 2-step login, the soft-delete products policy or the",
    "-- 'quoted' order status.",
    "--",
    "-- Contents, in this order (see docs/DATABASE.md):",
    ...parts.map((p, i) => `--   ${i + 1}. ${p.label}`),
    rule,
    ""
  ].join("\n");
  parts.forEach((p, i) => {
    out += `\n${rule}\n-- PART ${i + 1} of ${parts.length}: ${p.label}\n-- (verbatim copy of ${p.rel})\n${rule}\n\n${read(p.file)}`;
  });
  out += `\n${rule}\n-- END of supabase-all.sql\n${rule}\n`;
  return out;
}

const next = build();
if (process.argv.includes("--check")) {
  const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8").replace(/\r\n?/g, "\n") : null;
  if (current !== next) {
    console.error("supabase-all.sql is out of date. Run: node scripts/build-sql.js");
    process.exit(1);
  }
  console.log("supabase-all.sql is up to date.");
} else {
  fs.writeFileSync(outPath, next);
  console.log(`Wrote supabase-all.sql (${next.split("\n").length} lines).`);
}
