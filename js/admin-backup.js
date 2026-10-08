/* One-click data backup (admin side). Renders into #backupAdmin at the
   bottom of the admin "Settings" tab. Uses getSupabaseClient() /
   isMissingTableError() from js/supabase-config.js and escapeHtml() from
   js/admin.js.

   Strictly read-only: every table is read with select() (GET), and the
   storage buckets are only listed (supabase-js's list() is a POST to
   /storage/v1/object/list/<bucket>, but it is a read). Image bytes are not
   downloaded; the manifest records each file's path, size and public URL.

   The result is ONE JSON file:
     { exported_at, complete, errors, site, tables: {name: rows[]},
       skipped: [...], storage: {...}, counts: {...} }
   A table that doesn't exist yet is listed in `skipped` and is fine. Any
   other read error makes `complete: false`, puts the failure in `errors`,
   adds "-INCOMPLETE" to the filename and shows a red summary, so a
   partial backup can never pass for a complete one. */
(function () {
  // Every table in supabase-setup.sql, with a unique column to page by:
  // .range() paging is only reliable over a stable sort order.
  const TABLES = [
    { name: "products", orderBy: "id" },
    { name: "orders", orderBy: "id" },
    { name: "site_settings", orderBy: "key" },
    { name: "collections", orderBy: "id" },
    { name: "nav_items", orderBy: "id" },
    { name: "faq_items", orderBy: "id" },
    { name: "layout_overrides", orderBy: "id" },
    { name: "layout_overrides_history", orderBy: "id" },
    { name: "analytics_events", orderBy: "id" },
    { name: "blocked_dates", orderBy: "day" },
    { name: "delivery_areas", orderBy: "fsa" },
    { name: "gallery_items", orderBy: "id" }
  ];
  const BUCKETS = ["product-photos", "site-images"];
  // PostgREST's default max-rows. A page shorter than this means "last page".
  const PAGE_SIZE = 1000;
  const STORAGE_PAGE_SIZE = 1000;
  // Guard against a runaway folder loop (e.g. a folder that lists itself).
  const MAX_FOLDER_DEPTH = 20;

  let running = false;

  function renderShell(root) {
    root.innerHTML = `
      <h2>Backup</h2>
      <p class="backup-intro">Download a copy of everything stored for the site: products, orders, settings, categories, nav, FAQ, layout, analytics, delivery dates and areas, plus a list of every uploaded photo (names and links, not the image files themselves). It only reads your data; nothing is changed.</p>
      <p class="backup-warning">Keep this file somewhere safe (e.g. Google Drive). It contains customer contact details.</p>
      <button type="button" class="btn btn-primary" id="downloadBackupBtn">Download backup</button>
      <div class="form-status backup-status" id="backupStatus" role="status" aria-live="polite"></div>
      <div class="backup-summary" id="backupSummary" hidden></div>
    `;
    root.querySelector("#downloadBackupBtn").addEventListener("click", runBackup);
  }

  function setStatus(message, kind) {
    const el = document.getElementById("backupStatus");
    if (!el) return;
    el.textContent = message;
    el.className = `form-status backup-status${kind ? " " + kind : ""}`;
  }

  function errorMessage(error) {
    if (!error) return "Unknown error";
    return error.message || error.error || String(error);
  }

  /* Reads every row of one table, 1000 at a time, until a short page comes
     back. Also asks for the exact row count on the first page, so a server
     configured with a lower max-rows (which would make every page "short"
     and end the loop early) is caught instead of silently truncating. */
  async function readTable(client, table) {
    const rows = [];
    let expected = null;
    for (let from = 0; ; from += PAGE_SIZE) {
      const query = client
        .from(table.name)
        .select("*", from === 0 ? { count: "exact" } : undefined)
        .order(table.orderBy, { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      const { data, error, count } = await query;
      if (error) return { error };
      if (from === 0 && typeof count === "number") expected = count;
      const page = data || [];
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    // Rows added mid-backup (e.g. a new analytics event) only make the
    // result longer; fewer rows than counted means something was cut off.
    if (expected !== null && rows.length < expected) {
      return { error: { message: `read ${rows.length} of ${expected} rows (the server returned fewer rows than it reported)` } };
    }
    return { rows };
  }

  /* Lists one folder level, paging with offset, then recurses into
     subfolders. Folders come back from Supabase Storage with id === null. */
  async function walkBucket(client, bucket, prefix, depth, out) {
    if (depth > MAX_FOLDER_DEPTH) throw new Error(`folders nested deeper than ${MAX_FOLDER_DEPTH} levels at "${prefix}"`);
    const folders = [];
    for (let offset = 0; ; offset += STORAGE_PAGE_SIZE) {
      const { data, error } = await client.storage
        .from(bucket)
        .list(prefix, { limit: STORAGE_PAGE_SIZE, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw error;
      const page = data || [];
      page.forEach((entry) => {
        if (!entry.name) return;
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.id === null) {
          folders.push(path);
          return;
        }
        const meta = entry.metadata || {};
        out.push({
          name: entry.name,
          path,
          size: typeof meta.size === "number" ? meta.size : null,
          mimetype: meta.mimetype || null,
          updated_at: entry.updated_at || entry.created_at || null,
          public_url: client.storage.from(bucket).getPublicUrl(path).data.publicUrl
        });
      });
      if (page.length < STORAGE_PAGE_SIZE) break;
    }
    for (const folder of folders) {
      await walkBucket(client, bucket, folder, depth + 1, out);
    }
  }

  async function listBucket(client, bucket) {
    const files = [];
    try {
      await walkBucket(client, bucket, "", 0, files);
    } catch (error) {
      if (/bucket not found/i.test(errorMessage(error))) return { missing: true };
      return { error };
    }
    const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
    return { manifest: { file_count: files.length, total_bytes: totalBytes, files } };
  }

  function localDateStamp(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function downloadJson(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Give the browser a moment to start the download before revoking.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function formatBytes(n) {
    if (!n) return "0 KB";
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function renderSummary(backup, filename) {
    const el = document.getElementById("backupSummary");
    if (!el) return;
    const rowsHtml = TABLES.map(({ name }) => {
      let value;
      if (Object.prototype.hasOwnProperty.call(backup.tables, name)) value = backup.counts[name].toLocaleString();
      else if (backup.skipped.some((s) => s.table === name)) value = "skipped (table not set up yet)";
      else value = "FAILED";
      const failed = value === "FAILED";
      return `<tr${failed ? ' class="backup-row-failed"' : ""}><td>${escapeHtml(name)}</td><td>${escapeHtml(value)}</td></tr>`;
    }).join("");
    const storageHtml = BUCKETS.map((bucket) => {
      const s = backup.storage[bucket];
      let value;
      if (s && s.files) value = `${s.file_count.toLocaleString()} files (${formatBytes(s.total_bytes)})`;
      else if (s && s.skipped) value = "skipped (bucket not found)";
      else value = "FAILED";
      const failed = value === "FAILED";
      return `<tr${failed ? ' class="backup-row-failed"' : ""}><td>${escapeHtml(bucket)} photos</td><td>${escapeHtml(value)}</td></tr>`;
    }).join("");
    const errorsHtml = backup.errors.length
      ? `<ul class="backup-errors">${backup.errors.map((e) => `<li><strong>${escapeHtml(e.source)}</strong>: ${escapeHtml(e.message)}</li>`).join("")}</ul>`
      : "";
    el.innerHTML = `
      ${backup.complete ? "" : `<p class="backup-incomplete-banner">INCOMPLETE BACKUP: some data could not be read, so this file is missing parts of your data. Don't rely on it; try again.</p>`}
      ${errorsHtml}
      <p class="backup-filename">Saved as <code>${escapeHtml(filename)}</code></p>
      <table class="backup-table">
        <thead><tr><th>Table</th><th>Rows</th></tr></thead>
        <tbody>${rowsHtml}${storageHtml}</tbody>
      </table>
    `;
    el.hidden = false;
  }

  async function runBackup() {
    if (running) return;
    const btn = document.getElementById("downloadBackupBtn");
    const summaryEl = document.getElementById("backupSummary");
    const client = getSupabaseClient();
    if (!client) {
      setStatus("Supabase isn't configured, so there's nothing to back up.", "error");
      return;
    }

    running = true;
    btn.disabled = true;
    if (summaryEl) { summaryEl.hidden = true; summaryEl.innerHTML = ""; }

    const backup = {
      exported_at: new Date().toISOString(),
      complete: true,
      errors: [],
      site: {
        name: "Balloons by Tea",
        page: window.location.origin + window.location.pathname,
        supabase_url: SUPABASE_CONFIG.url
      },
      tables: {},
      skipped: [],
      storage: {},
      counts: {}
    };
    const fail = (source, message) => {
      backup.complete = false;
      backup.errors.push({ source, message });
    };

    try {
      // Orders and analytics are only visible to the admin account (RLS
      // returns zero rows, not an error, to anyone else), so a missing or
      // non-admin session would quietly produce an empty-looking backup.
      setStatus("Checking you're logged in...", "");
      const { data: sessionData } = await client.auth.getSession();
      if (!sessionData || !sessionData.session) {
        setStatus("You're not logged in any more. Log in again, then retry the backup.", "error");
        return;
      }
      const { data: isAdmin, error: adminError } = await client.rpc("is_admin", {}, { get: true });
      if (!adminError && isAdmin === false) {
        fail("account", "This login isn't the admin account, so orders, analytics and layout history can't be read and would be missing.");
      }

      const steps = TABLES.length + BUCKETS.length;
      let step = 0;
      for (const table of TABLES) {
        step += 1;
        setStatus(`Backing up ${table.name}... ${step}/${steps}`, "");
        let result;
        try {
          result = await readTable(client, table);
        } catch (err) {
          result = { error: err };
        }
        if (result.error) {
          if (isMissingTableError(result.error, table.name)) {
            backup.skipped.push({ table: table.name, reason: "table does not exist yet" });
          } else {
            fail(table.name, errorMessage(result.error));
          }
          continue;
        }
        backup.tables[table.name] = result.rows;
        backup.counts[table.name] = result.rows.length;
      }

      for (const bucket of BUCKETS) {
        step += 1;
        setStatus(`Listing ${bucket} photos... ${step}/${steps}`, "");
        const result = await listBucket(client, bucket);
        if (result.missing) {
          backup.storage[bucket] = { skipped: true, reason: "bucket not found" };
          backup.skipped.push({ bucket, reason: "bucket not found" });
        } else if (result.error) {
          backup.storage[bucket] = { error: errorMessage(result.error) };
          fail(`storage: ${bucket}`, errorMessage(result.error));
        } else {
          backup.storage[bucket] = result.manifest;
          backup.counts[`storage:${bucket}`] = result.manifest.file_count;
        }
      }

      const filename = `balloons-by-tea-backup-${localDateStamp(new Date())}${backup.complete ? "" : "-INCOMPLETE"}.json`;
      downloadJson(backup, filename);
      const totalRows = Object.keys(backup.tables).reduce((sum, k) => sum + backup.counts[k], 0);
      if (backup.complete) {
        setStatus(`Backup downloaded: ${totalRows.toLocaleString()} rows from ${Object.keys(backup.tables).length} tables.`, "success");
      } else {
        setStatus(`INCOMPLETE backup downloaded: ${backup.errors.length} part${backup.errors.length === 1 ? "" : "s"} could not be read (see below).`, "error");
      }
      renderSummary(backup, filename);
    } catch (err) {
      setStatus(`Backup failed, nothing was downloaded: ${errorMessage(err)}`, "error");
    } finally {
      running = false;
      btn.disabled = false;
    }
  }

  function init() {
    const root = document.getElementById("backupAdmin");
    if (root) renderShell(root);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
