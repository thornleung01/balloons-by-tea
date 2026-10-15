#!/usr/bin/env node
/* Fails when a table in the schema is forgotten by Backup / Restore.
 *
 *   node scripts/check-backup-coverage.js
 *
 * Reads every `create table` in supabase-all.sql, then checks:
 *   - each table is in TABLES (js/admin-backup.js) or in EXCLUDED below
 *     (with a reason);
 *   - each TABLES entry that is restorable (no `restore: false`) is on the
 *     admin_restore_rows() allowlist in supabase-migrations/30-safety.sql,
 *     and each backup-only entry is NOT on it;
 *   - nothing in TABLES / the allowlist / EXCLUDED names a table that
 *     doesn't exist (e.g. a typo or a renamed table).
 * Adding a table? Put it in TABLES (+ the allowlist unless it holds
 * security data), or add it to EXCLUDED here with a reason. No dependencies. */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

// Tables deliberately not in Backup. Keep the reason honest.
const EXCLUDED = {
  rate_limit_secret: "private salt for hashing IPs; a backup file must not contain it",
  rate_limit_hits: "short-lived anti-spam counters, no client access",
  order_upload_folders: "private, hourly anti-spam bookkeeping, no client access"
};
// Tables that must be backed up but never restored (security / audit data).
const BACKUP_ONLY = ["admin_users", "audit_log"];

const problems = [];
const sql = read("supabase-all.sql");
const created = new Set();
const re = /^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gim;
for (let m; (m = re.exec(sql.replace(/^\s*--.*$/gm, ""))); ) created.add(m[1]);

const backupSrc = read("js/admin-backup.js");
const tablesBlock = /const TABLES = \[([\s\S]*?)\n  \];/.exec(backupSrc);
if (!tablesBlock) { console.error("Could not find `const TABLES = [...]` in js/admin-backup.js"); process.exit(2); }
const inBackup = new Map();
const entryRe = /\{\s*name:\s*"([a-z_][a-z0-9_]*)"([^}]*)\}/g;
for (let m; (m = entryRe.exec(tablesBlock[1])); ) inBackup.set(m[1], !/restore:\s*false/.test(m[2]));

const allowSrc = read("supabase-migrations/30-safety.sql");
const allowBlock = /allowed constant text\[\] := array\[([\s\S]*?)\n  \];/.exec(allowSrc);
if (!allowBlock) { console.error("Could not find the `allowed` list in supabase-migrations/30-safety.sql"); process.exit(2); }
const allowed = new Set([...allowBlock[1].replace(/--.*$/gm, "").matchAll(/'([a-z_][a-z0-9_]*)'/g)].map((m) => m[1]));

for (const t of [...created].sort()) {
  if (!inBackup.has(t) && !(t in EXCLUDED)) problems.push(`table "${t}" is in neither TABLES (js/admin-backup.js) nor EXCLUDED (scripts/check-backup-coverage.js)`);
}
for (const [t, restorable] of inBackup) {
  if (!created.has(t)) problems.push(`TABLES lists "${t}" but supabase-all.sql never creates it`);
  if (t in EXCLUDED) problems.push(`"${t}" is both in TABLES and EXCLUDED`);
  if (restorable && !allowed.has(t)) problems.push(`"${t}" is restorable in js/admin-backup.js but missing from the admin_restore_rows allowlist (30-safety.sql)`);
  if (!restorable && allowed.has(t)) problems.push(`"${t}" is backup-only (restore: false) but IS on the admin_restore_rows allowlist`);
}
for (const t of allowed) {
  if (!created.has(t)) problems.push(`allowlist names "${t}" but supabase-all.sql never creates it`);
  if (!inBackup.has(t)) problems.push(`allowlist has "${t}" which is not in TABLES (js/admin-backup.js)`);
  if (BACKUP_ONLY.includes(t)) problems.push(`"${t}" must never be restorable but is on the allowlist`);
}
for (const t of BACKUP_ONLY) {
  if (inBackup.get(t) !== false) problems.push(`"${t}" must be in TABLES with restore: false`);
}
for (const t of Object.keys(EXCLUDED)) {
  if (!created.has(t)) problems.push(`EXCLUDED lists "${t}" but supabase-all.sql never creates it`);
}

console.log(`Schema tables (${created.size}): ${[...created].sort().join(", ")}`);
console.log(`Backed up (${inBackup.size}); restorable (${allowed.size}); excluded (${Object.keys(EXCLUDED).length}): ${Object.keys(EXCLUDED).join(", ")}`);
if (problems.length) {
  console.error("\nBackup coverage problems:\n  - " + problems.join("\n  - "));
  process.exit(1);
}
console.log("Backup coverage OK.");
