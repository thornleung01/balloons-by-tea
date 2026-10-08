/* Delivery-area check (admin side). Renders into #deliveryAreaAdmin on the
   admin "Delivery" tab; js/admin.js calls window.refreshDeliveryAreaAdmin()
   whenever that tab is opened. Uses escapeHtml() / getSupabaseClient()
   from js/admin.js and js/supabase-config.js.

   Rows live in `delivery_areas` (see supabase-setup.sql): one per FSA,
   the first 3 characters of a postal code ("M5V"). Empty list = the
   customer-side check is off and every address is accepted. */
(function () {
  const FSA_RE = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]$/;
  let areasCache = [];
  let rendered = false;

  /* "M5V, m4w m6g\nM5V 3L9" -> { valid: ["M5V","M4W","M6G"], invalid: [...], repeated: [...] }
     A full postal code ("M5V 3L9" / "M5V3L9") counts as its first 3 chars. */
  function parseAreaList(text) {
    const collapsed = String(text || "").toUpperCase()
      .replace(/\b([A-Z]\d[A-Z])[\s-]?(\d[A-Z]\d)\b/g, "$1");
    const tokens = collapsed.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
    const valid = [];
    const invalid = [];
    const repeated = [];
    tokens.forEach((t) => {
      if (!FSA_RE.test(t)) { if (!invalid.includes(t)) invalid.push(t); return; }
      if (valid.includes(t)) { if (!repeated.includes(t)) repeated.push(t); return; }
      valid.push(t);
    });
    return { valid, invalid, repeated };
  }

  function isMissingTableError(error) {
    return /relation.*delivery_areas.*does not exist|could not find the table/i.test((error && error.message) || "");
  }

  function renderShell(root) {
    root.innerHTML = `
      <h2>Delivery areas</h2>
      <p class="delivery-area-intro">Customers enter their postal code at checkout and on custom delivery orders, and we check its first three characters (e.g. <strong>M5V</strong>) against this list. While the list is empty, every address is accepted. Pick-up orders are never checked.</p>
      <form id="deliveryAreaForm" novalidate>
        <div class="field">
          <label for="da-areas">Postal areas to add</label>
          <textarea id="da-areas" name="areas" rows="3" placeholder="M5V, M4W, M6G" autocapitalize="characters" spellcheck="false"></textarea>
        </div>
        <div class="field">
          <label for="da-label">Label (optional)</label>
          <input id="da-label" name="label" type="text" maxlength="60" placeholder="e.g. Downtown"/>
        </div>
        <div class="form-status" id="deliveryAreaFormStatus" role="status"></div>
        <div class="modal-actions">
          <button type="submit" class="btn btn-primary btn-block" id="addDeliveryAreasBtn">Add areas</button>
        </div>
      </form>
      <h3 class="delivery-area-list-title">Current areas <span id="deliveryAreaCount"></span></h3>
      <div id="deliveryAreaList"><p class="empty-note">Loading...</p></div>
    `;
    root.querySelector("#deliveryAreaForm").addEventListener("submit", handleAdd);
    rendered = true;
  }

  function setStatus(message, kind) {
    const el = document.getElementById("deliveryAreaFormStatus");
    if (!el) return;
    el.textContent = message;
    el.className = `form-status${kind ? " " + kind : ""}`;
  }

  function renderList() {
    const listEl = document.getElementById("deliveryAreaList");
    const countEl = document.getElementById("deliveryAreaCount");
    if (!listEl) return;
    if (countEl) countEl.textContent = areasCache.length ? `(${areasCache.length})` : "";
    if (!areasCache.length) {
      listEl.innerHTML = `<p class="empty-note">No areas yet — the delivery check is off and all addresses are accepted.</p>`;
      return;
    }
    listEl.innerHTML = areasCache.map((a) => `
      <div class="admin-item-row" data-fsa="${escapeHtml(a.fsa)}">
        <div class="admin-item-body">
          <div class="name">${escapeHtml(a.fsa)}</div>
          ${a.label ? `<div class="meta">${escapeHtml(a.label)}</div>` : ""}
        </div>
        <div class="admin-item-actions">
          <button type="button" class="danger delivery-area-remove" data-fsa="${escapeHtml(a.fsa)}" aria-label="Remove ${escapeHtml(a.fsa)}">Remove</button>
        </div>
      </div>
    `).join("");
    listEl.querySelectorAll(".delivery-area-remove").forEach((btn) => {
      btn.addEventListener("click", () => handleRemove(btn.dataset.fsa, btn));
    });
  }

  function showLoadError(error) {
    const listEl = document.getElementById("deliveryAreaList");
    const form = document.getElementById("deliveryAreaForm");
    const missing = isMissingTableError(error);
    if (form) form.hidden = missing;
    if (listEl) {
      listEl.innerHTML = `<p class="form-status error">${missing
        ? "The delivery_areas table doesn't exist yet — run the latest supabase-setup.sql in your Supabase SQL Editor to turn on the delivery-area check. Until then, every address is accepted."
        : "Couldn't load delivery areas: " + escapeHtml(error.message || String(error))}</p>`;
    }
  }

  async function loadList() {
    const client = getSupabaseClient();
    if (!client) {
      showLoadError({ message: "Supabase isn't configured." });
      return false;
    }
    const { data, error } = await client.from("delivery_areas").select("fsa,label,created_at").order("fsa", { ascending: true });
    if (error) {
      showLoadError(error);
      return false;
    }
    const form = document.getElementById("deliveryAreaForm");
    if (form) form.hidden = false;
    areasCache = data || [];
    renderList();
    return true;
  }

  async function handleAdd(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const btn = document.getElementById("addDeliveryAreasBtn");
    const { valid, invalid, repeated } = parseAreaList(form.areas.value);
    const label = form.label.value.trim();
    const existing = new Set(areasCache.map((a) => a.fsa));
    const already = valid.filter((f) => existing.has(f));
    const toAdd = valid.filter((f) => !existing.has(f));

    const notes = [];
    if (already.length) notes.push(`already listed: ${already.join(", ")}`);
    if (invalid.length) notes.push(`not a valid area (use letter-number-letter, like M5V): ${invalid.join(", ")}`);
    const notesText = notes.length ? ` Skipped — ${notes.join("; ")}.` : "";

    if (!toAdd.length) {
      setStatus(valid.length || invalid.length
        ? `Nothing new to add.${notesText}`
        : "Enter one or more postal areas, like M5V, M4W.", "error");
      form.areas.focus();
      return;
    }

    btn.disabled = true;
    setStatus("Saving...", "");
    const client = getSupabaseClient();
    const { error } = await client
      .from("delivery_areas")
      .upsert(toAdd.map((fsa) => ({ fsa, label })), { onConflict: "fsa", ignoreDuplicates: true });
    btn.disabled = false;

    if (error) {
      setStatus(isMissingTableError(error)
        ? "The delivery_areas table doesn't exist yet — run the latest supabase-setup.sql first."
        : `Couldn't add areas: ${error.message}`, "error");
      return;
    }
    // Leave the invalid ones in the box so they can be fixed and re-added.
    form.areas.value = invalid.join(", ");
    if (!invalid.length) form.label.value = "";
    setStatus(`Added ${toAdd.join(", ")}.${notesText}`, "success");
    await loadList();
  }

  async function handleRemove(fsa, btn) {
    if (!fsa) return;
    if (!confirm(`Remove ${fsa} from your delivery areas?`)) return;
    btn.disabled = true;
    const client = getSupabaseClient();
    const { error } = await mustAffect(client.from("delivery_areas").delete().eq("fsa", fsa));
    if (error) {
      btn.disabled = false;
      setStatus(`Couldn't remove ${fsa}: ${error.message}`, "error");
      return;
    }
    setStatus(areasCache.length === 1
      ? `Removed ${fsa}. The list is now empty, so the delivery check is off.`
      : `Removed ${fsa}.`, "success");
    await loadList();
  }

  window.refreshDeliveryAreaAdmin = async function () {
    const root = document.getElementById("deliveryAreaAdmin");
    if (!root) return;
    if (!rendered) renderShell(root);
    try {
      await loadList();
    } catch (err) {
      showLoadError(err || { message: "Unknown error" });
    }
  };

  // For tests.
  window.parseDeliveryAreaList = parseAreaList;
})();
