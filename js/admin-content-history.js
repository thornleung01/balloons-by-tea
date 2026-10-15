/* "Revert content" version history for the Settings form and the FAQ list
   (content_history table, supabase-migrations/60-content.sql). This is a
   simple owner-facing undo — separate from any generic audit log.

   API (globals, used by js/admin-settings.js and js/admin-faq.js):
     recordContentHistory(kind, snapshotOrFn, note)   -> Promise<boolean>
         kind is "settings" | "faq". snapshotOrFn is the full state (or an
         async function returning it). Never throws; the newest 50 per kind
         are kept (a trigger in the migration prunes older rows).
     ensureContentHistoryBaseline(kind, snapshotFn)   -> Promise<void>
         if this kind has no versions yet, records snapshotFn() first, so
         the very first tracked edit can be undone too.
     openContentHistory(kind, handlers)               -> opens the modal
         handlers: { title, getCurrent(): Promise<snapshot>,
                     diff(snapshot, current): [{label, from, to, isImage}],
                     beforeRestore(): boolean, restore(snapshot): Promise }

   When the table hasn't been created yet everything here quietly does
   nothing, and the History modal explains how to switch it on. */

const CONTENT_HISTORY_LIMIT = 50;
/* null = unknown, true = table exists, false = migration not run. */
let contentHistoryAvailable = null;

function contentHistoryMissing(error) {
  return typeof isMissingTableError === "function" ? isMissingTableError(error, "content_history") : false;
}

async function recordContentHistory(kind, snapshotOrFn, note) {
  if (contentHistoryAvailable === false) return false;
  try {
    const snapshot = typeof snapshotOrFn === "function" ? await snapshotOrFn() : snapshotOrFn;
    if (snapshot == null) return false;
    const client = getSupabaseClient();
    const { error } = await client.from("content_history").insert({ kind, snapshot, note: note ? String(note).slice(0, 300) : null });
    if (error) {
      if (contentHistoryMissing(error)) contentHistoryAvailable = false;
      else console.warn("[content history] Couldn't record a version:", error.message);
      return false;
    }
    contentHistoryAvailable = true;
    return true;
  } catch (err) {
    console.warn("[content history] Couldn't record a version:", err && err.message);
    return false;
  }
}

async function ensureContentHistoryBaseline(kind, snapshotFn) {
  if (contentHistoryAvailable === false) return;
  try {
    const client = getSupabaseClient();
    const { count, error } = await client.from("content_history").select("id", { count: "exact", head: true }).eq("kind", kind);
    if (error) {
      if (contentHistoryMissing(error)) contentHistoryAvailable = false;
      return;
    }
    contentHistoryAvailable = true;
    if (!count) await recordContentHistory(kind, snapshotFn, "Before the first tracked change");
  } catch (err) {
    /* never block a save */
  }
}

async function listContentHistory(kind) {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from("content_history")
    .select("id,created_at,actor_email,kind,snapshot,note")
    .eq("kind", kind)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(CONTENT_HISTORY_LIMIT);
  if (error) {
    if (contentHistoryMissing(error)) contentHistoryAvailable = false;
    return { rows: [], error };
  }
  contentHistoryAvailable = true;
  return { rows: data || [], error: null };
}

function formatHistoryWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const diffMin = Math.round((Date.now() - d.getTime()) / 60000);
  let rel;
  if (diffMin < 1) rel = "just now";
  else if (diffMin < 60) rel = `${diffMin} min ago`;
  else if (diffMin < 60 * 24) rel = `${Math.round(diffMin / 60)} h ago`;
  else rel = `${Math.round(diffMin / (60 * 24))} days ago`;
  const abs = d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return { rel, abs };
}

function truncateHistoryValue(v, n) {
  const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  if (!s) return "(blank)";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function ensureContentHistoryModal() {
  let modal = document.getElementById("contentHistoryModal");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.className = "modal content-history-modal";
  modal.id = "contentHistoryModal";
  modal.innerHTML = `
    <div class="modal-scrim" data-close-history></div>
    <div class="modal-panel content-history-panel" role="dialog" aria-modal="true" aria-labelledby="contentHistoryTitle">
      <div class="modal-head">
        <div>
          <h2 id="contentHistoryTitle">History</h2>
          <p>Each save is kept as a version (the latest ${CONTENT_HISTORY_LIMIT}). Restoring writes that version back to the live site, and is itself saved as a new version, so you can always undo it.</p>
        </div>
        <button type="button" class="icon-btn" data-close-history aria-label="Close">&times;</button>
      </div>
      <div class="modal-body">
        <div class="content-history-status form-status" id="contentHistoryStatus" role="status" aria-live="polite"></div>
        <ol class="content-history-list" id="contentHistoryList"></ol>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelectorAll("[data-close-history]").forEach((el) => el.addEventListener("click", closeContentHistory));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("open")) closeContentHistory();
  });
  return modal;
}

function closeContentHistory() {
  const modal = document.getElementById("contentHistoryModal");
  if (modal) modal.classList.remove("open");
}

let contentHistoryContext = null;

async function openContentHistory(kind, handlers) {
  const modal = ensureContentHistoryModal();
  contentHistoryContext = { kind, handlers };
  modal.querySelector("#contentHistoryTitle").textContent = handlers.title || "History";
  modal.classList.add("open");
  const closeBtn = modal.querySelector(".icon-btn[data-close-history]");
  if (closeBtn) closeBtn.focus();
  await renderContentHistoryList();
}

async function renderContentHistoryList() {
  const ctx = contentHistoryContext;
  if (!ctx) return;
  const listEl = document.getElementById("contentHistoryList");
  const statusEl = document.getElementById("contentHistoryStatus");
  listEl.innerHTML = "";
  statusEl.className = "content-history-status form-status";
  statusEl.textContent = "Loading versions...";

  const [{ rows, error }, current] = await Promise.all([
    listContentHistory(ctx.kind),
    ctx.handlers.getCurrent().catch(() => null)
  ]);
  if (ctx !== contentHistoryContext) return; // reopened for another kind meanwhile
  if (error) {
    statusEl.className = "content-history-status form-status error";
    statusEl.innerHTML = contentHistoryAvailable === false
      ? `Version history isn't switched on yet. Run <code>supabase-migrations/60-content.sql</code> in the Supabase SQL Editor, then reload this page. Saving works as normal in the meantime.`
      : `Couldn't load the history: ${escapeHtml(error.message)}`;
    return;
  }
  if (!rows.length) {
    statusEl.textContent = "No versions yet. One is kept every time you save.";
    return;
  }
  statusEl.textContent = current ? "" : "Couldn't read the live content, so changes can't be compared right now.";

  listEl.innerHTML = rows.map((row, i) => {
    const when = formatHistoryWhen(row.created_at);
    const changes = current ? ctx.handlers.diff(row.snapshot || {}, current) : null;
    const same = changes && changes.length === 0;
    const summary = !changes
      ? ""
      : same
        ? `<p class="content-history-same">Same as the live site now</p>`
        : `<details class="content-history-diff">
             <summary>Restoring changes ${changes.length} ${changes.length === 1 ? "thing" : "things"}: ${escapeHtml(changes.slice(0, 3).map((c) => c.label).join(", "))}${changes.length > 3 ? "…" : ""}</summary>
             <ul>${changes.slice(0, 40).map((c) => `
               <li><strong>${escapeHtml(c.label)}</strong>${c.isImage
                 ? `<span class="content-history-change">${c.to ? "different photo" : "photo removed"}</span>`
                 : c.from === undefined && c.to === undefined ? "" : `<span class="content-history-change"><span class="from">${escapeHtml(truncateHistoryValue(c.from, 70))}</span> <span aria-hidden="true">→</span><span class="visually-hidden">becomes</span> <span class="to">${escapeHtml(truncateHistoryValue(c.to, 70))}</span></span>`}</li>`).join("")}
               ${changes.length > 40 ? `<li>…and ${changes.length - 40} more</li>` : ""}
             </ul>
           </details>`;
    return `
      <li class="content-history-item" data-history-id="${escapeHtml(row.id)}">
        <div class="content-history-meta">
          <span class="content-history-when" title="${escapeHtml(when.abs || "")}">${escapeHtml(when.rel || "")}<span class="content-history-abs"> · ${escapeHtml(when.abs || "")}</span></span>
          ${i === 0 ? '<span class="content-history-tag">Latest</span>' : ""}
        </div>
        <p class="content-history-note">${escapeHtml(row.note || "Saved")}${row.actor_email ? ` <span class="content-history-who">by ${escapeHtml(row.actor_email)}</span>` : ""}</p>
        ${summary}
        <div class="content-history-actions">
          <button type="button" class="btn btn-outline btn-sm" data-restore-history="${escapeHtml(row.id)}" ${same || !current ? "disabled" : ""}>Restore this version</button>
        </div>
      </li>
    `;
  }).join("");

  listEl.querySelectorAll("[data-restore-history]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = rows.find((r) => String(r.id) === btn.dataset.restoreHistory);
      if (row) restoreContentHistoryVersion(row, btn);
    });
  });
}

async function restoreContentHistoryVersion(row, btn) {
  const ctx = contentHistoryContext;
  if (!ctx) return;
  const when = formatHistoryWhen(row.created_at);
  if (!confirm(`Restore the version from ${when.abs}? This changes the live site straight away. (You can undo it from this list.)`)) return;
  if (ctx.handlers.beforeRestore && ctx.handlers.beforeRestore() === false) return;
  const statusEl = document.getElementById("contentHistoryStatus");
  btn.disabled = true;
  btn.textContent = "Restoring...";
  statusEl.className = "content-history-status form-status";
  statusEl.textContent = "Restoring...";
  try {
    await ctx.handlers.restore(row.snapshot || {});
    await recordContentHistory(ctx.kind, () => ctx.handlers.getCurrent(), `Restored the version from ${when.abs}`);
    await renderContentHistoryList();
    statusEl.className = "content-history-status form-status success";
    statusEl.textContent = "Restored. The live site now shows that version.";
  } catch (err) {
    statusEl.className = "content-history-status form-status error";
    statusEl.textContent = `Couldn't restore: ${(err && err.message) || err}. Some parts may have been written; check the live content.`;
    btn.disabled = false;
    btn.textContent = "Restore this version";
  }
}
