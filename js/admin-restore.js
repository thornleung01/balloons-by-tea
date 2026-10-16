/* "Restore from backup..." (Settings -> Backup card, owners only).
   Loads a .json file made by "Download backup" (js/admin-backup.js), shows
   what restoring it would change, and puts the chosen tables back.

   Safety rails, in order:
     1. the file is validated (format, version, shape) before anything else;
     2. a preview compares every table in the file with the live data;
     3. the owner picks tables and a mode: "merge" (add missing rows and
        overwrite rows that differ, never delete anything) or "replace"
        (merge, then also delete rows that aren't in the backup);
     4. typing RESTORE is required;
     5. a fresh backup of the CURRENT data is downloaded first, and if that
        can't be completed the restore doesn't start;
     6. rows go in through the owner-only RPC public.admin_restore_rows
        (supabase-migrations/30-safety.sql), in batches.
   Photo files aren't inside a backup (only a list), so after restoring the
   page reports which referenced photos are missing from storage.

   window.AdminRestoreLib holds the pure helpers (unit-tested). */
(function () {
  "use strict";

  const BATCH_SIZE = 200;
  const SUPPORTED_VERSION = 2;
  // Unticked by default: large, low-value, or hard to undo.
  const OFF_BY_DEFAULT = new Set(["analytics_events", "layout_overrides_history"]);

  /* ----- Pure helpers ----- */

  /* Checks the shape of a parsed backup. Returns { ok, problems, warnings,
     tables } where tables is [{name, rows}] for every well-formed table. */
  function validateBackup(data, knownKeys) {
    const problems = [];
    const warnings = [];
    const tables = [];
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, problems: ["This isn't a backup file (it should be one JSON object)."], warnings, tables };
    }
    if (data.format !== undefined && data.format !== "balloons-by-tea-backup") {
      problems.push(`This file says it is "${String(data.format).slice(0, 40)}", not a Balloons by Tea backup.`);
    }
    if (data.version !== undefined && (!Number.isInteger(data.version) || data.version > SUPPORTED_VERSION)) {
      problems.push(`This backup is from a newer version of the admin (v${String(data.version).slice(0, 10)}). Update the site before restoring it.`);
    }
    if (!data.tables || typeof data.tables !== "object" || Array.isArray(data.tables)) {
      problems.push("The file has no \"tables\" section, so there's nothing to restore.");
    } else {
      Object.keys(data.tables).forEach((name) => {
        const rows = data.tables[name];
        if (!Array.isArray(rows)) { problems.push(`Table "${name}" is not a list of rows.`); return; }
        const key = knownKeys[name];
        if (!key) { warnings.push(`"${name}" is in the file but this admin doesn't know how to restore it (or it is backup-only, like the team list and activity log). It will be skipped.`); return; }
        const bad = rows.findIndex((r) => !r || typeof r !== "object" || Array.isArray(r) || r[key] === undefined || r[key] === null);
        if (bad !== -1) { problems.push(`Table "${name}": row ${bad + 1} has no "${key}", so the file looks damaged.`); return; }
        const seen = new Set();
        for (const r of rows) {
          const k = String(r[key]);
          if (seen.has(k)) { problems.push(`Table "${name}" lists "${key}" ${k.slice(0, 40)} twice, so the file looks damaged.`); return; }
          seen.add(k);
        }
        tables.push({ name, rows });
      });
      if (!tables.length && !problems.length) problems.push("The file doesn't contain any table this admin can restore.");
    }
    if (data.complete === false) {
      warnings.push("This backup was marked INCOMPLETE when it was made: some tables or rows are missing from it. With \"replace\", anything missing from the file would be deleted from the site. Prefer \"merge\".");
    }
    return { ok: problems.length === 0, problems, warnings, tables };
  }

  /* Value equality that tolerates the ways the same data can be spelled
     (number vs "12.50", two timestamp formats, key order in objects). */
  function sameValue(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return a == null && b == null;
    const ta = typeof a, tb = typeof b;
    if (ta === "number" || tb === "number") {
      if ((ta === "number" || ta === "string") && (tb === "number" || tb === "string")) {
        return String(a).trim() !== "" && String(b).trim() !== "" && Number(a) === Number(b);
      }
      return false;
    }
    if (ta === "string" && tb === "string") {
      const iso = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
      if (iso.test(a) && iso.test(b)) {
        const x = Date.parse(a), y = Date.parse(b);
        return !Number.isNaN(x) && x === y;
      }
      return false;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
      return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
    }
    if (ta === "object" && tb === "object") {
      const ka = Object.keys(a), kb = Object.keys(b);
      return ka.length === kb.length && ka.every((k) => k in b && sameValue(a[k], b[k]));
    }
    return false;
  }

  /* What restoring fileRows would do to nowRows, matched by `key`.
     Only columns present in the file row are compared (a restore never
     touches columns the file doesn't mention). */
  function diffTable(fileRows, nowRows, key) {
    const now = new Map(nowRows.map((r) => [String(r[key]), r]));
    const inFile = new Set();
    let add = 0, change = 0, same = 0;
    for (const row of fileRows) {
      const k = String(row[key]);
      inFile.add(k);
      const cur = now.get(k);
      if (!cur) { add += 1; continue; }
      const differs = Object.keys(row).some((c) => c in cur && !sameValue(row[c], cur[c]));
      if (differs) change += 1; else same += 1;
    }
    let onlyNow = 0;
    now.forEach((_, k) => { if (!inFile.has(k)) onlyNow += 1; });
    return { inFile: fileRows.length, now: nowRows.length, add, change, same, onlyNow };
  }

  function chunk(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  /* Every Supabase Storage public URL mentioned anywhere in the given rows
     (strings and arrays of strings). Returns [{bucket, path, url}] unique. */
  function findStorageRefs(tablesRows, baseUrl) {
    const prefix = `${String(baseUrl || "").replace(/\/+$/, "")}/storage/v1/object/public/`;
    const found = new Map();
    const visit = (value) => {
      if (typeof value === "string") {
        if (value.length > 2000) return;
        let from = 0;
        for (;;) {
          const at = value.indexOf(prefix, from);
          if (at === -1) break;
          const rest = value.slice(at + prefix.length);
          const m = rest.match(/^([A-Za-z0-9_-]+)\/([^\s"'<>?#)]+)/);
          if (m) {
            let path = m[2];
            try { path = decodeURIComponent(path); } catch (e) { /* keep raw */ }
            found.set(`${m[1]}/${path}`, { bucket: m[1], path, url: prefix + m[1] + "/" + m[2] });
          }
          from = at + prefix.length;
        }
      } else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") Object.keys(value).forEach((k) => visit(value[k]));
    };
    Object.keys(tablesRows).forEach((t) => tablesRows[t].forEach((row) => Object.keys(row).forEach((c) => visit(row[c]))));
    return [...found.values()];
  }

  window.AdminRestoreLib = { validateBackup, sameValue, diffTable, chunk, findStorageRefs };

  if (typeof document === "undefined" || !document.getElementById) return;

  /* ----- UI ----- */

  const $ = (id) => document.getElementById(id);
  let loaded = null;       // { fileName, data, tables:[{name, rows}], warnings }
  let preview = null;      // name -> diff (or {error})
  let busy = false;

  function keyMap() {
    const map = {};
    window.AdminBackup.TABLES.forEach((t) => { if (t.restore !== false) map[t.name] = t.orderBy; });
    return map;
  }

  function setStatus(message, kind) {
    const el = $("restoreStatus");
    if (!el) return;
    el.textContent = message || "";
    el.className = `form-status restore-status${kind ? " " + kind : ""}`;
  }

  /* Stepper: 1 Choose file, 2 Review, 3 Confirm. n = 4 marks everything done. */
  function setRestoreStep(n) {
    const steps = document.querySelectorAll("#restoreSteps li");
    steps.forEach((li, i) => {
      li.classList.toggle("is-done", i + 1 < n);
      li.classList.toggle("is-current", i + 1 === n);
      if (i + 1 === n) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
    });
  }

  function mount() {
    const root = $("restoreAdmin");
    if (!root || root.dataset.ready || !window.AdminBackup) return;
    root.dataset.ready = "1";
    root.innerHTML = `
      <h3>Restore from backup</h3>
      <ol class="restore-steps" id="restoreSteps" aria-label="Restore steps">
        <li class="is-current" aria-current="step"><span class="restore-step-n">1</span> Choose file</li>
        <li><span class="restore-step-n">2</span> Review</li>
        <li><span class="restore-step-n">3</span> Confirm</li>
      </ol>
      <p class="backup-intro">Put the site back to how it was in a backup file. You choose what to restore and see exactly what would change first. A fresh backup of what you have now is downloaded automatically before anything is touched. Photos aren't inside the file, so they aren't brought back; you'll be told if any are missing.</p>
      <label class="btn btn-outline" for="restoreFileInput">Choose a backup file</label>
      <input id="restoreFileInput" type="file" accept=".json,application/json" hidden/>
      <div class="form-status restore-status" id="restoreStatus" role="status" aria-live="polite"></div>
      <div id="restorePanel" hidden></div>
    `;
    $("restoreFileInput").addEventListener("change", onFilePicked);
  }

  async function onFilePicked(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file || busy) return;
    $("restorePanel").hidden = true;
    loaded = null;
    preview = null;
    if (file.size > 150 * 1024 * 1024) { setStatus("That file is very large (over 150 MB). It doesn't look like a backup from this site.", "error"); return; }
    setStatus("Reading the file...", "");
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (err) {
      setStatus("Couldn't read that file: it isn't valid JSON. Pick a file made by \"Download backup\".", "error");
      return;
    }
    const check = validateBackup(data, keyMap());
    if (!check.ok) {
      setStatus(`This file can't be restored. ${check.problems.slice(0, 3).join(" ")}`, "error");
      return;
    }
    loaded = { fileName: file.name, data, tables: check.tables, warnings: check.warnings };
    const client = getSupabaseClient();
    if (!client) { setStatus("Supabase isn't configured.", "error"); return; }
    busy = true;
    try {
      preview = {};
      for (const t of loaded.tables) {
        setStatus(`Comparing ${t.name} with what's on the site now...`, "");
        const key = keyMap()[t.name];
        const result = await window.AdminBackup.readTable(client, { name: t.name, orderBy: key });
        if (result.error) {
          preview[t.name] = isMissingTableError(result.error, t.name)
            ? { missing: true }
            : { error: window.AdminBackup.errorMessage(result.error) };
        } else {
          preview[t.name] = diffTable(t.rows, result.rows, key);
        }
      }
      setStatus("", "");
      renderPreview();
    } catch (err) {
      setStatus(`Couldn't compare with the live data: ${err.message || err}`, "error");
    } finally {
      busy = false;
    }
  }

  function renderPreview() {
    const panel = $("restorePanel");
    const when = loaded.data.exported_at ? new Date(loaded.data.exported_at).toLocaleString() : "unknown date";
    const rowsHtml = loaded.tables.map((t) => {
      const d = preview[t.name];
      const usable = d && !d.missing && !d.error;
      const cells = usable
        ? `<td data-label="In file">${d.inFile.toLocaleString()}</td><td data-label="Now">${d.now.toLocaleString()}</td><td data-label="Would add">${d.add.toLocaleString()}</td><td data-label="Would change">${d.change.toLocaleString()}</td><td data-label="Only on site" class="restore-only-now">${d.onlyNow.toLocaleString()}</td>`
        : `<td colspan="5" class="restore-unavailable">${d && d.missing ? "table not set up on this site" : escapeHtml((d && d.error) || "can't be compared")}</td>`;
      return `<tr><td><label><input type="checkbox" class="restore-pick" data-table="${escapeHtml(t.name)}" ${usable && !OFF_BY_DEFAULT.has(t.name) ? "checked" : ""} ${usable ? "" : "disabled"}/> ${escapeHtml(t.name)}</label></td>${cells}</tr>`;
    }).join("");
    panel.innerHTML = `
      <p class="restore-file">File: <code>${escapeHtml(loaded.fileName)}</code>, made ${escapeHtml(when)}.</p>
      ${loaded.warnings.map((w) => `<p class="backup-incomplete-banner">${escapeHtml(w)}</p>`).join("")}
      <table class="backup-table restore-table">
        <thead><tr><th>Table</th><th>In file</th><th>Now</th><th>Would add</th><th>Would change</th><th title="Rows on the site now that aren't in the file">Only on site</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <fieldset class="restore-modes">
        <legend>How should it be restored?</legend>
        <label class="restore-mode"><input type="radio" name="restoreMode" value="merge" checked/><span class="restore-mode-body"><strong>Merge <span class="a-badge a-badge--success">Safer</span></strong><span>Adds what is missing and overwrites rows that differ. Rows that are only on the site now (the "Only on site" column) are kept.</span></span></label>
        <label class="restore-mode"><input type="radio" name="restoreMode" value="replace"/><span class="restore-mode-body"><strong>Replace <span class="a-badge a-badge--danger">Deletes rows</span></strong><span>Does the same, then deletes every "Only on site" row, so the chosen tables end up exactly like the file.</span></span></label>
      </fieldset>
      <div class="restore-danger" id="restoreModeWarn" role="alert" hidden></div>
      <div class="field restore-confirm">
        <label for="restoreConfirm">To go ahead, type <strong>RESTORE</strong></label>
        <input id="restoreConfirm" type="text" autocomplete="off" spellcheck="false" placeholder="RESTORE"/>
      </div>
      <div class="restore-actions">
        <button type="button" class="btn btn-outline" id="restoreCancelBtn">Cancel</button>
        <button type="button" class="btn btn-primary btn-delete-danger" id="restoreGoBtn" disabled>Restore now</button>
      </div>
      <div id="restoreProgress" class="restore-progress" role="status" aria-live="polite"></div>
      <div id="restoreResult" class="restore-result" hidden></div>
    `;
    panel.hidden = false;
    setRestoreStep(2);
    panel.querySelectorAll(".restore-pick, input[name=restoreMode], #restoreConfirm").forEach((el) => {
      el.addEventListener("input", syncRestoreControls);
      el.addEventListener("change", syncRestoreControls);
    });
    $("restoreCancelBtn").addEventListener("click", () => { if (!busy) { panel.hidden = true; loaded = null; preview = null; setRestoreStep(1); } });
    $("restoreGoBtn").addEventListener("click", runRestore);
    syncRestoreControls();
  }

  function selectedTables() {
    return [...document.querySelectorAll(".restore-pick:checked")].map((el) => el.dataset.table);
  }
  function selectedMode() {
    const el = document.querySelector("input[name=restoreMode]:checked");
    return el ? el.value : "merge";
  }

  function syncRestoreControls() {
    const names = selectedTables();
    const mode = selectedMode();
    const warn = $("restoreModeWarn");
    if (mode === "replace") {
      const deleting = names.map((n) => ({ n, c: preview[n] && preview[n].onlyNow })).filter((x) => x.c);
      warn.hidden = false;
      warn.textContent = deleting.length
        ? `Replace will DELETE: ${deleting.map((x) => `${x.c.toLocaleString()} row${x.c === 1 ? "" : "s"} from ${x.n}`).join(", ")}. A backup of the current data is downloaded first, but this can't be undone from the page.`
        : "Replace won't delete anything here: the site has no rows that aren't in the file.";
    } else {
      warn.hidden = true;
    }
    $("restoreGoBtn").disabled = busy || !names.length || $("restoreConfirm").value.trim() !== "RESTORE";
    if (!busy && !$("restoreResult").hidden === false) setRestoreStep($("restoreConfirm").value.trim() ? 3 : 2);
  }

  function progress(message) {
    const el = $("restoreProgress");
    if (el) el.textContent = message;
  }

  async function runRestore() {
    if (busy || !loaded) return;
    const names = selectedTables();
    const mode = selectedMode();
    if (!names.length || $("restoreConfirm").value.trim() !== "RESTORE") return;
    const client = getSupabaseClient();
    const lib = window.AdminBackup;
    busy = true;
    $("restoreGoBtn").disabled = true;
    $("restoreCancelBtn").disabled = true;
    $("restoreResult").hidden = true;
    const results = [];
    try {
      // 1. Safety net.
      progress("Step 1: saving a backup of the current data first...");
      const safety = await lib.buildBackup(client, (m) => progress(`Step 1: ${m}`));
      if (!safety.complete) {
        progress("");
        setStatus(`Stopped before changing anything: the safety backup of the current data was incomplete (${safety.errors.map((e) => e.source).join(", ")}). Try again in a moment.`, "error");
        return;
      }
      lib.downloadJson(safety, lib.backupFilename(safety, "balloons-by-tea-BEFORE-RESTORE"));
      lib.recordBackupTime(client, safety.exported_at);

      // 2. Tables in the order they're listed (products before gallery_items, which points at them).
      const order = lib.TABLES.filter((t) => t.restore !== false).map((t) => t.name).filter((n) => names.includes(n));
      let rpcMissing = false;
      for (const name of order) {
        const rows = loaded.tables.find((t) => t.name === name).rows;
        const outcome = { name, inserted: 0, updated: 0, unchanged: 0, deleted: 0, error: null };
        results.push(outcome);
        const batches = chunk(rows, BATCH_SIZE);
        for (let i = 0; i < batches.length; i += 1) {
          progress(`Step 2: restoring ${name}... batch ${i + 1} of ${batches.length}`);
          const { data, error } = await client.rpc("admin_restore_rows", { p_table: name, p_rows: batches[i], p_mode: "merge", p_note: "restore" });
          if (error) {
            if (isMissingTableError(error)) rpcMissing = true;
            outcome.error = error.message || String(error);
            break;
          }
          outcome.inserted += data.inserted || 0;
          outcome.updated += data.updated || 0;
          outcome.unchanged += data.unchanged || 0;
        }
        if (rpcMissing) break;
        if (!outcome.error && mode === "replace") {
          progress(`Step 2: removing rows from ${name} that aren't in the backup...`);
          const key = keyMap()[name];
          const { data, error } = await client.rpc("admin_restore_rows", { p_table: name, p_rows: rows.map((r) => r[key]), p_mode: "delete_missing", p_note: "restore" });
          if (error) outcome.error = `restored, but couldn't remove the extra rows: ${error.message}`;
          else outcome.deleted = data.deleted || 0;
        }
      }
      if (rpcMissing) {
        setStatus("Restore needs the database update first: run supabase-migrations/30-safety.sql in the Supabase SQL editor (see docs/admin-safety.md). Nothing was changed.", "error");
        results.length = 0;
        return;
      }

      // 3. Which referenced photos are gone?
      progress("Step 3: checking that the photos the restored data points to still exist...");
      const missing = await findMissingPhotos(client, names, safety);

      renderResult(results, missing, mode);
      setRestoreStep(4);
      setStatus(results.some((r) => r.error) ? "Restore finished with problems (see below)." : "Restore finished.", results.some((r) => r.error) ? "error" : "success");
      refreshAfterRestore(names);
    } catch (err) {
      setStatus(`Restore stopped: ${err.message || err}. Whatever was already restored stays; the safety backup was downloaded.`, "error");
      if (results.length) renderResult(results, [], mode);
    } finally {
      progress("");
      busy = false;
      $("restoreCancelBtn").disabled = false;
      syncRestoreControls();
    }
  }

  async function findMissingPhotos(client, names, safetyBackup) {
    const subset = {};
    loaded.tables.filter((t) => names.includes(t.name)).forEach((t) => { subset[t.name] = t.rows; });
    const refs = findStorageRefs(subset, SUPABASE_CONFIG.url);
    if (!refs.length) return [];
    const have = new Set();
    const checked = new Set();
    for (const bucket of window.AdminBackup.BUCKETS) {
      const manifest = safetyBackup.storage && safetyBackup.storage[bucket];
      if (manifest && manifest.files) {
        checked.add(bucket);
        manifest.files.forEach((f) => have.add(`${bucket}/${f.path}`));
      }
    }
    const inFileManifest = new Set();
    const fileStorage = (loaded.data && loaded.data.storage) || {};
    Object.keys(fileStorage).forEach((bucket) => ((fileStorage[bucket] && fileStorage[bucket].files) || []).forEach((f) => inFileManifest.add(`${bucket}/${f.path}`)));
    return refs
      .filter((r) => checked.has(r.bucket) && !have.has(`${r.bucket}/${r.path}`))
      .map((r) => ({ ...r, wasInBackupList: inFileManifest.has(`${r.bucket}/${r.path}`) }));
  }

  function renderResult(results, missing, mode) {
    const el = $("restoreResult");
    const badge = (kind, n, label) => `<span class="a-badge a-badge--${kind}">${n.toLocaleString()} ${label}</span>`;
    const rows = results.map((r) => `<li class="restore-result-row${r.error ? " is-failed" : ""}">
        <span class="restore-result-name">${escapeHtml(r.name)}</span>
        <span class="restore-result-badges">${r.error ? '<span class="a-badge a-badge--danger">Failed</span>' : ""}${badge("success", r.inserted, "added")}${badge("info", r.updated, "changed")}${badge("neutral", r.unchanged, "already right")}${mode === "replace" ? badge(r.deleted ? "danger" : "neutral", r.deleted, "deleted") : ""}</span>
        ${r.error ? `<span class="restore-result-error">${escapeHtml(r.error)}</span>` : ""}
      </li>`).join("");
    el.innerHTML = `
      <h4>Summary</h4>
      <ul class="restore-results">${rows}</ul>
      ${missing.length
        ? `<div class="restore-danger" role="alert"><strong>${missing.length} photo${missing.length === 1 ? " is" : "s are"} missing from storage.</strong> The restored data points to ${missing.length === 1 ? "it" : "them"}, but the file isn't there, so ${missing.length === 1 ? "it" : "they"} will show as broken images. Photo files aren't part of a backup; re-upload them in the Library.
           <ul>${missing.slice(0, 40).map((m) => `<li><code>${escapeHtml(m.bucket)}/${escapeHtml(m.path)}</code>${m.wasInBackupList ? "" : " (wasn't in the backup's photo list either)"}</li>`).join("")}</ul>
           ${missing.length > 40 ? `<p>...and ${missing.length - 40} more.</p>` : ""}</div>`
        : '<p class="restore-ok"><span class="a-badge a-badge--success">Photos OK</span> Every photo the restored data points to is still in storage.</p>'}
      <p class="restore-note">Reload the page to see everything fresh. The activity log shows each restored row.</p>
    `;
    el.hidden = false;
  }

  function refreshAfterRestore(names) {
    try {
      if (names.includes("products") && typeof refreshItemList === "function") refreshItemList();
      if (names.includes("orders") && typeof refreshOrderList === "function") refreshOrderList();
      if (names.includes("collections") && typeof loadCollectionsCache === "function") loadCollectionsCache();
    } catch (e) { /* the page reload note covers it */ }
  }

  if (window.AdminBackup && $("restoreAdmin")) mount();
  else window.addEventListener("admin-backup-ready", mount);
  document.addEventListener("DOMContentLoaded", mount);
})();
