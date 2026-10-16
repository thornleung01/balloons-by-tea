/* Admin "Activity" tab: a readable history of every change made in the
   admin (public.audit_log, filled by a database trigger; see
   supabase-migrations/30-safety.sql). Owners only: staff can't read the
   log, and the tab is hidden for them (css/admin-safety.css).

   Filters (area, kind of change, person, date range), 50 entries a page,
   an expandable before/after for every entry, and Undo for single-row
   edits and deletes, which goes through the same owner-only
   admin_restore_rows() RPC as Restore from backup.

   window.AdminAuditLib holds the pure helpers (unit-tested). */
(function () {
  "use strict";

  const PAGE_SIZE = 50;

  // Key column of each table, for Undo. Must match the trigger arguments in
  // 30-safety.sql. Tables not listed here simply don't offer Undo.
  const PK_COLUMNS = {
    products: "id", collections: "id", nav_items: "id", faq_items: "id",
    site_settings: "key", gallery_items: "id", blocked_dates: "day",
    delivery_areas: "fsa", layout_overrides: "id", orders: "id"
  };

  const TABLE_LABELS = {
    products: "Products", orders: "Orders", collections: "Categories",
    nav_items: "Nav", faq_items: "FAQ", site_settings: "Settings",
    gallery_items: "Gallery", blocked_dates: "Blocked dates",
    delivery_areas: "Delivery areas", layout_overrides: "Page layout"
  };

  const TABLE_NOUNS = {
    products: "product", orders: "order", collections: "category",
    nav_items: "nav link", faq_items: "FAQ question", site_settings: "setting",
    gallery_items: "gallery photo", blocked_dates: "blocked date",
    delivery_areas: "delivery area", layout_overrides: "layout tweak"
  };

  const KIND_LABEL = { insert: "Added", update: "Edited", delete: "Deleted" };
  const KIND_BADGE = { insert: "a-badge--success", update: "a-badge--info", delete: "a-badge--danger" };

  const COLUMN_LABELS = {
    price: "price", name: "name", description: "description", style: "style",
    image_url: "main photo", images: "photos", collection: "category",
    active: "visibility", visible: "visibility", card_image_url: "card image",
    tagline: "tagline", title: "title", slug: "web address", sort_order: "position",
    label: "label", href: "link", icon: "icon", question: "question", answer: "answer",
    is_open_default: "open by default", status: "status", admin_notes: "private notes",
    notes: "customer notes", event_date: "event date", event_on: "event date",
    payment_status: "payment status", total_amount: "total", total: "total",
    address: "address", phone: "phone", email: "email", caption: "caption",
    occasion: "occasion", product_id: "linked product", reason: "reason",
    value: "value", deleted_at: "trash"
  };

  const MONEY_COLUMNS = new Set(["price", "total_amount", "amount", "deposit", "deposit_amount", "amount_paid", "balance"]);

  /* ----- Pure helpers ----- */

  function truncate(text, max) {
    const s = String(text);
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }

  function formatMoney(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return String(n);
    return "$" + (Number.isInteger(num) ? String(num) : num.toFixed(2));
  }

  /* A short, human version of one stored value. */
  function formatValue(column, value) {
    if (value === null || value === undefined || value === "") return "(empty)";
    if (MONEY_COLUMNS.has(column) && (typeof value === "number" || /^-?\d+(\.\d+)?$/.test(String(value)))) return formatMoney(value);
    if (typeof value === "boolean") return value ? "on" : "off";
    if (Array.isArray(value)) {
      if (column === "images" || column === "attachments") return `${value.length} photo${value.length === 1 ? "" : "s"}`;
      return `${value.length} item${value.length === 1 ? "" : "s"}`;
    }
    if (typeof value === "object") return "(details)";
    if (typeof value === "number") return String(value);
    return `"${truncate(value.replace(/\s+/g, " ").trim(), 60)}"`;
  }

  function columnLabel(column) {
    return COLUMN_LABELS[column] || String(column).replace(/_/g, " ");
  }

  /* "'Gold Arch'", "order #12 (Jane)", "the setting hero_heading". */
  function describeTarget(entry, withNoun) {
    const table = entry.table_name;
    const id = entry.row_id == null ? "" : String(entry.row_id);
    const label = entry.row_label == null ? "" : String(entry.row_label);
    if (table === "orders") return `order #${id}${label && label !== id ? ` (${truncate(label, 40)})` : ""}`;
    if (table === "site_settings") return `the setting "${id}"`;
    if (table === "blocked_dates") return id;
    if (table === "delivery_areas") return `delivery area ${id}${label && label !== id ? ` (${truncate(label, 40)})` : ""}`;
    const noun = TABLE_NOUNS[table] || String(table || "row").replace(/_/g, " ");
    const name = label && label !== id ? `'${truncate(label, 60)}'` : `#${id}`;
    return withNoun ? `${noun} ${name}` : name;
  }

  function actorName(entry, team) {
    if (!entry.actor_id && !entry.actor_email) return "Someone without an admin login";
    const member = (team || []).find((m) => m.user_id === entry.actor_id);
    if (member && member.display_name) return member.display_name;
    return entry.actor_email || "An admin";
  }

  /* One-sentence description of an audit_log row. */
  function describeAuditEntry(entry, team) {
    const who = actorName(entry, team);
    const table = entry.table_name;
    const changed = entry.changed && typeof entry.changed === "object" ? entry.changed : {};
    let text;

    if (entry.action === "insert") {
      if (table === "blocked_dates") text = `${who} blocked ${describeTarget(entry)}${changed.reason ? ` (${truncate(changed.reason, 40)})` : ""}`;
      else if (table === "site_settings") text = `${who} set ${describeTarget(entry)} to ${formatValue("value", changed.value)}`;
      else text = `${who} added ${describeTarget(entry, true)}`;
    } else if (entry.action === "delete") {
      if (table === "blocked_dates") text = `${who} unblocked ${describeTarget(entry)}`;
      else if (table === "delivery_areas") text = `${who} removed ${describeTarget(entry)}`;
      else text = `${who} deleted ${describeTarget(entry, true)}`;
    } else {
      const cols = Object.keys(changed);
      const target = describeTarget(entry, table !== "products");
      if (cols.length === 1) {
        const col = cols[0];
        const pair = Array.isArray(changed[col]) ? changed[col] : [undefined, changed[col]];
        const [before, after] = pair;
        if ((col === "active" || col === "visible") && typeof after === "boolean") {
          text = `${who} ${after ? "showed" : "hid"} ${target}`;
        } else if (col === "deleted_at") {
          text = after ? `${who} moved ${target} to the Trash` : `${who} restored ${target} from the Trash`;
        } else if (table === "orders" && col === "status") {
          text = `${who} marked ${target} as ${String(after || "").replace(/^./, (c) => c.toUpperCase())}`;
        } else if (table === "orders" && col === "admin_notes") {
          text = `${who} updated the private notes on ${target}`;
        } else if (col === "sort_order") {
          text = `${who} moved ${target} to position ${after}`;
        } else if (table === "site_settings" && col === "value") {
          text = `${who} changed ${target} from ${formatValue(entry.row_id, before)} to ${formatValue(entry.row_id, after)}`;
        } else {
          text = `${who} changed ${columnLabel(col)} of ${target} from ${formatValue(col, before)} to ${formatValue(col, after)}`;
        }
      } else if (cols.length > 1) {
        const names = cols.map(columnLabel);
        const shown = names.length > 4 ? names.slice(0, 4).join(", ") + ` and ${names.length - 4} more` : names.join(", ");
        text = `${who} edited ${target} (${shown})`;
      } else {
        text = `${who} edited ${target}`;
      }
    }
    if (entry.note === "restore") text += " (restore from backup)";
    else if (entry.note === "undo") text += " (undo)";
    return text;
  }

  /* [{column, before, after}] for an update, [{column, value}] otherwise. */
  function diffRows(entry) {
    const changed = entry.changed && typeof entry.changed === "object" ? entry.changed : {};
    if (entry.action === "update") {
      return Object.keys(changed).map((column) => {
        const pair = Array.isArray(changed[column]) ? changed[column] : [undefined, changed[column]];
        return { column, before: pair[0], after: pair[1] };
      });
    }
    return Object.keys(changed).map((column) => ({ column, value: changed[column] }));
  }

  /* Loose equality for "has this changed again since?": the log stores
     Postgres jsonb, the API returns JSON; numbers, timestamps and arrays can
     differ in spelling but not in meaning. */
  function sameValue(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return a == null && b == null;
    if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
    if (typeof a === "string" && typeof b === "string") {
      const ta = Date.parse(a), tb = Date.parse(b);
      if (/^\d{4}-\d{2}-\d{2}T/.test(a) && /^\d{4}-\d{2}-\d{2}T/.test(b) && !Number.isNaN(ta)) return ta === tb;
      return false;
    }
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /* What Undo would send. null = not undoable. */
  function buildUndo(entry) {
    const pk = PK_COLUMNS[entry.table_name];
    if (!pk || entry.row_id == null) return null;
    const changed = entry.changed && typeof entry.changed === "object" ? entry.changed : null;
    if (!changed) return null;
    if (entry.action === "update") {
      const cols = Object.keys(changed).filter((c) => c !== pk && Array.isArray(changed[c]));
      if (!cols.length) return null;
      const patch = { [pk]: entry.row_id };
      cols.forEach((c) => { patch[c] = changed[c][0]; });
      return { mode: "update_only", row: patch, columns: cols, pk };
    }
    if (entry.action === "delete") {
      if (changed[pk] == null) return null;
      return { mode: "insert_only", row: changed, columns: Object.keys(changed), pk };
    }
    return null;
  }

  /* Date input value (local day) -> ISO bounds. */
  function dayStartIso(dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || "")) return null;
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(y, m - 1, d).toISOString();
  }
  function dayEndExclusiveIso(dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || "")) return null;
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(y, m - 1, d + 1).toISOString();
  }

  function relativeTime(iso, now) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return "";
    const secs = Math.round(((now || Date.now()) - t) / 1000);
    if (secs < 60) return "just now";
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
    return new Date(t).toLocaleDateString();
  }

  window.AdminAuditLib = { describeAuditEntry, diffRows, buildUndo, sameValue, formatValue, describeTarget, dayStartIso, dayEndExclusiveIso, relativeTime, PK_COLUMNS };

  if (typeof document === "undefined" || typeof registerAdminTab !== "function") return;

  /* ----- UI ----- */

  const state = { page: 0, total: 0, entries: [], team: [], loading: false, ready: false, migrationMissing: false };
  const $ = (id) => document.getElementById(id);

  function renderShell(panel) {
    panel.innerHTML = `
      <div class="activity-head">
        <h2>Activity</h2>
        <button type="button" class="btn btn-outline btn-sm" id="activityRefreshBtn">Refresh</button>
      </div>
      <p class="panel-subtitle">Every change made in the admin, newest first, with who made it. Deletes are recorded even when they don't come from the admin page. Select an entry to see exactly what changed.</p>
      <div class="activity-filters" role="group" aria-label="Filter activity">
        <label>Area<select id="activityTable" class="filter-select"><option value="">Everything</option>${Object.keys(TABLE_LABELS).map((t) => `<option value="${t}">${escapeHtml(TABLE_LABELS[t])}</option>`).join("")}</select></label>
        <label>Change<select id="activityAction" class="filter-select"><option value="">Any change</option><option value="insert">Added</option><option value="update">Edited</option><option value="delete">Deleted</option></select></label>
        <label>Person<select id="activityPerson" class="filter-select"><option value="">Anyone</option><option value="__none">No admin login</option></select></label>
        <label>From<input type="date" id="activityFrom"/></label>
        <label>To<input type="date" id="activityTo"/></label>
        <button type="button" class="btn btn-ghost btn-sm activity-clear" id="activityClearBtn" hidden>Clear filters</button>
      </div>
      <div class="form-status" id="activityStatus" role="status" aria-live="polite"></div>
      <div class="activity-notice" id="activityNotice" role="status" hidden></div>
      <div id="activityState"></div>
      <ol class="activity-list" id="activityList"></ol>
      <div class="activity-pager">
        <button type="button" class="btn btn-outline btn-sm" id="activityPrevBtn">Newer</button>
        <span id="activityPageInfo"></span>
        <button type="button" class="btn btn-outline btn-sm" id="activityNextBtn">Older</button>
      </div>
      <div class="activity-retention" data-owner-only>
        <label for="activityPruneDays">Tidy up: delete activity older than</label>
        <select id="activityPruneDays" class="filter-select">
          <option value="90">90 days</option><option value="180" selected>180 days</option><option value="365">1 year</option><option value="730">2 years</option>
        </select>
        <button type="button" class="btn btn-outline btn-sm" id="activityPruneBtn">Delete old activity</button>
        <span class="form-status" id="activityPruneStatus"></span>
      </div>
    `;
    ["activityTable", "activityAction", "activityPerson", "activityFrom", "activityTo"].forEach((id) => {
      $(id).addEventListener("change", () => { state.page = 0; load(); });
    });
    $("activityClearBtn").addEventListener("click", () => {
      ["activityTable", "activityAction", "activityPerson", "activityFrom", "activityTo"].forEach((id) => { $(id).value = ""; });
      state.page = 0;
      load();
    });
    $("activityRefreshBtn").addEventListener("click", () => load());
    $("activityPrevBtn").addEventListener("click", () => { if (state.page > 0) { state.page -= 1; load(); } });
    $("activityNextBtn").addEventListener("click", () => { if ((state.page + 1) * PAGE_SIZE < state.total) { state.page += 1; load(); } });
    $("activityPruneBtn").addEventListener("click", prune);
    $("activityList").addEventListener("click", onListClick);
  }

  function setStatus(id, message, kind) {
    const el = $(id);
    if (!el) return;
    el.textContent = message || "";
    el.className = `form-status${kind ? " " + kind : ""}`;
  }

  async function loadTeam(client) {
    const known = typeof window.getAdminTeam === "function" ? window.getAdminTeam() : [];
    if (known.length) { state.team = known; }
    else {
      const { data, error } = await client.rpc("admin_team_list");
      state.team = error ? [] : (data || []);
    }
    const select = $("activityPerson");
    const current = select.value;
    select.innerHTML = `<option value="">Anyone</option><option value="__none">No admin login</option>` +
      state.team.map((m) => `<option value="${escapeHtml(m.user_id)}">${escapeHtml(m.display_name || m.email)}</option>`).join("");
    select.value = current;
    if (select.value !== current) select.value = "";
  }

  function filtersActive() {
    return ["activityTable", "activityAction", "activityPerson", "activityFrom", "activityTo"].some((id) => $(id) && $(id).value);
  }

  function showState(html) { $("activityState").innerHTML = html || ""; }

  async function load() {
    const client = getSupabaseClient();
    if (!client || state.loading) return;
    if (typeof window.getAdminRole === "function" && window.getAdminRole() === "staff") {
      $("activityList").innerHTML = "";
      showState(adminEmptyHtml("Owners only", "Only owners can see the activity log."));
      return;
    }
    state.loading = true;
    setStatus("activityStatus", "", "");
    $("activityNotice").hidden = true;
    if (!state.entries.length) { $("activityList").innerHTML = ""; showState(adminSkeletonList(5)); }
    $("activityClearBtn").hidden = !filtersActive();
    try {
      let query = client.from("audit_log").select("*", { count: "exact" })
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(state.page * PAGE_SIZE, state.page * PAGE_SIZE + PAGE_SIZE - 1);
      const table = $("activityTable").value;
      const action = $("activityAction").value;
      const person = $("activityPerson").value;
      const from = dayStartIso($("activityFrom").value);
      const to = dayEndExclusiveIso($("activityTo").value);
      if (table) query = query.eq("table_name", table);
      if (action) query = query.eq("action", action);
      if (person === "__none") query = query.is("actor_id", null);
      else if (person) query = query.eq("actor_id", person);
      if (from) query = query.gte("created_at", from);
      if (to) query = query.lt("created_at", to);

      const { data, error, count } = await query;
      if (error) {
        if (isMissingTableError(error, "audit_log")) {
          state.migrationMissing = true;
          $("activityList").innerHTML = "";
          showState("");
          const notice = $("activityNotice");
          notice.innerHTML = "<strong>The activity log is not set up yet.</strong> Run <code>supabase-migrations/30-safety.sql</code> in the Supabase SQL editor, then reload this tab. Steps are in <code>docs/DATABASE.md</code> and <code>docs/admin-safety.md</code>. Everything else in the admin keeps working in the meantime.";
          notice.hidden = false;
          return;
        }
        throw error;
      }
      state.entries = data || [];
      state.total = typeof count === "number" ? count : state.entries.length;
      render();
      if (state.total) showState("");
      else if (filtersActive()) showState(adminEmptyHtml("Nothing matches these filters", "Try a wider date range, or clear the filters to see everything."));
      else showState(adminEmptyHtml("No changes recorded yet", "Edits you make in the admin appear here."));
    } catch (err) {
      state.entries = [];
      $("activityList").innerHTML = "";
      showState(adminErrorHtml(`Couldn't load activity: ${err.message || err}`, "Try again"));
      const retry = $("activityState").querySelector("[data-retry]");
      if (retry) retry.addEventListener("click", () => load());
    } finally {
      state.loading = false;
    }
  }

  function valueCell(value) {
    if (value === undefined) return "";
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return `<code>${escapeHtml(truncate(text, 400))}</code>`;
  }

  function render() {
    const list = $("activityList");
    const isOwner = typeof window.getAdminRole !== "function" || window.getAdminRole() === "owner";
    list.innerHTML = state.entries.map((entry, i) => {
      const rows = diffRows(entry);
      const undo = isOwner ? buildUndo(entry) : null;
      const when = new Date(entry.created_at);
      const table = entry.action === "update"
        ? `<table class="activity-diff"><thead><tr><th>What</th><th>Before</th><th>After</th></tr></thead><tbody>${rows.map((r) => `<tr><th scope="row">${escapeHtml(columnLabel(r.column))}</th><td data-label="Before">${valueCell(r.before)}</td><td data-label="After">${valueCell(r.after)}</td></tr>`).join("")}</tbody></table>`
        : `<table class="activity-diff"><thead><tr><th>What</th><th>${entry.action === "delete" ? "Value before it was deleted" : "Value"}</th></tr></thead><tbody>${rows.map((r) => `<tr><th scope="row">${escapeHtml(columnLabel(r.column))}</th><td data-label="${entry.action === "delete" ? "Before it was deleted" : "Value"}">${valueCell(r.value)}</td></tr>`).join("")}</tbody></table>`;
      return `
        <li class="activity-item activity-${escapeHtml(entry.action)}">
          <details>
            <summary>
              <span class="activity-dot" aria-hidden="true"></span>
              <span class="activity-main">
                <span class="activity-text">${escapeHtml(describeAuditEntry(entry, state.team))}</span>
                <span class="activity-sub">
                  <span class="a-badge ${KIND_BADGE[entry.action] || "a-badge--neutral"}">${escapeHtml(KIND_LABEL[entry.action] || entry.action)}</span>
                  <span class="activity-area">${escapeHtml(TABLE_LABELS[entry.table_name] || entry.table_name)}</span>
                  <time datetime="${escapeHtml(entry.created_at)}" title="${escapeHtml(when.toLocaleString())}">${escapeHtml(relativeTime(entry.created_at))}</time>
                </span>
              </span>
            </summary>
            <div class="activity-body">
              <p class="activity-meta">${escapeHtml(TABLE_LABELS[entry.table_name] || entry.table_name)} · ${escapeHtml(when.toLocaleString())}${entry.actor_email ? ` · ${escapeHtml(entry.actor_email)}` : ""}</p>
              ${table}
              ${undo ? `<button type="button" class="btn btn-outline btn-sm activity-undo-btn" data-index="${i}">${entry.action === "delete" ? "Put it back" : "Undo this change"}</button>` : ""}
              <span class="form-status activity-undo-status" data-undo-status="${i}"></span>
            </div>
          </details>
        </li>`;
    }).join("");
    const pages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    $("activityPageInfo").textContent = state.total ? `Page ${state.page + 1} of ${pages} · ${state.total.toLocaleString()} entries` : "";
    $("activityPrevBtn").disabled = state.page === 0;
    $("activityNextBtn").disabled = (state.page + 1) * PAGE_SIZE >= state.total;
  }

  function onListClick(e) {
    const btn = e.target.closest(".activity-undo-btn");
    if (!btn) return;
    const entry = state.entries[Number(btn.dataset.index)];
    if (entry) undoEntry(entry, btn);
  }

  async function undoEntry(entry, btn) {
    const client = getSupabaseClient();
    const plan = buildUndo(entry);
    const statusEl = document.querySelector(`[data-undo-status="${btn.dataset.index}"]`);
    const say = (msg, kind) => { if (statusEl) { statusEl.textContent = msg; statusEl.className = `form-status activity-undo-status${kind ? " " + kind : ""}`; } };
    if (!plan) return;
    const target = describeTarget(entry, true);

    // What does that row look like now?
    const { data: current, error: readError } = await client.from(entry.table_name).select("*").eq(plan.pk, entry.row_id).maybeSingle();
    if (readError) { say(`Couldn't check the current version: ${readError.message}`, "error"); return; }

    if (plan.mode === "update_only") {
      if (!current) { say("That item doesn't exist any more, so this edit can't be undone. Look for its \"deleted\" entry instead.", "error"); return; }
      const changedSince = plan.columns.filter((c) => !sameValue(current[c], entry.changed[c][1]));
      const list = plan.columns.map((c) => `  ${columnLabel(c)}: back to ${formatValue(c, entry.changed[c][0])}`).join("\n");
      let message = `Undo this change to ${target}?\n\n${list}`;
      if (changedSince.length) message += `\n\nCareful: ${changedSince.map(columnLabel).join(", ")} ${changedSince.length === 1 ? "has" : "have"} been changed again since then. Undoing will overwrite the newer value.`;
      if (!(await adminConfirm({ title: `Undo this change to ${target}?`, message: message.replace(/^Undo this change to [^\n]*\n\n/, ""), confirmLabel: "Undo change", danger: changedSince.length > 0 }))) return;
    } else {
      if (current) { say("Something with the same id exists again, so there's nothing to put back.", "error"); return; }
      if (!(await adminConfirm({ title: `Restore ${target}?`, message: `Put ${target} back exactly as it was before it was deleted?`, confirmLabel: "Put it back" }))) return;
    }

    btn.disabled = true;
    say("Undoing...", "");
    const { data, error } = await client.rpc("admin_restore_rows", { p_table: entry.table_name, p_rows: [plan.row], p_mode: plan.mode, p_note: "undo" });
    btn.disabled = false;
    if (error) {
      say(isMissingTableError(error) ? "Undo needs the database update in supabase-migrations/30-safety.sql." : `Couldn't undo: ${error.message}`, "error");
      return;
    }
    const didSomething = data && (data.updated > 0 || data.inserted > 0);
    say(didSomething ? "Done. Other tabs show it after a refresh." : "Nothing needed changing: it already matches.", didSomething ? "success" : "");
    if (didSomething) {
      if (entry.table_name === "products" && typeof refreshItemList === "function") refreshItemList();
      if (entry.table_name === "orders" && typeof refreshOrderList === "function") refreshOrderList();
      setTimeout(load, 800);
    }
  }

  async function prune() {
    const client = getSupabaseClient();
    const days = Number($("activityPruneDays").value);
    if (!(await adminConfirm({ title: "Delete old activity history?", message: `Delete all activity entries older than ${days} days? This only removes history, not your shop data.`, confirmLabel: "Delete history", danger: true }))) return;
    setStatus("activityPruneStatus", "Deleting...", "");
    const { data, error } = await client.rpc("audit_log_prune", { keep_days: days });
    if (error) {
      setStatus("activityPruneStatus", isMissingTableError(error) ? "Needs supabase-migrations/30-safety.sql." : `Couldn't delete: ${error.message}`, "error");
      return;
    }
    setStatus("activityPruneStatus", `Deleted ${Number(data || 0).toLocaleString()} old entr${data === 1 ? "y" : "ies"}.`, "success");
    state.page = 0;
    load();
  }

  async function enter() {
    const panel = $("activityPanel");
    if (!panel) return;
    if (!state.ready) { renderShell(panel); state.ready = true; }
    const client = getSupabaseClient();
    if (client) await loadTeam(client);
    state.page = 0;
    load();
  }

  if (typeof ADMIN_ICONS === "object" && !ADMIN_ICONS.clock) ADMIN_ICONS.clock = '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>';
  registerAdminTab("activity", { btnId: "tabActivityBtn", panelId: "activityPanel", label: "Activity", group: "site", icon: "clock", order: 50, onEnter: enter });
})();
