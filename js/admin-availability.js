/* Event-date availability (admin side). Renders into #availabilityAdmin on
   the admin "Delivery" tab; js/admin.js calls window.refreshAvailabilityAdmin()
   whenever that tab is opened.

   - Blocked dates: the blocked_dates table (one row per day). The owner can
     block one day or a range with an optional reason, see what's coming up
     (past days are hidden), and unblock. Consecutive days with the same
     reason are shown as one row so a two-week vacation isn't 14 rows.
   - Daily limit: site_settings 'max_orders_per_day'. Dates that reach it
     are reported by the fully_booked_dates() SQL function, which the public
     order forms also use (see js/availability.js).

   Uses escapeHtml() and getSupabaseClient() from js/admin.js /
   js/supabase-config.js (loaded first). */
(function () {
  const MAX_RANGE_DAYS = 366;
  const CAPACITY_KEY = "max_orders_per_day";
  const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  let blockedCache = []; // [{ day, reason }] upcoming, sorted
  let busy = false;

  function pad(n) { return String(n).padStart(2, "0"); }
  function localIsoDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function todayIso() { return localIsoDate(new Date()); }
  function parseIso(iso) {
    const m = ISO_DAY_RE.exec(iso || "");
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  }
  function nextIso(iso) {
    const d = parseIso(iso);
    d.setDate(d.getDate() + 1);
    return localIsoDate(d);
  }
  function friendly(iso, withWeekday = true) {
    const d = parseIso(iso);
    if (!d) return iso;
    const opts = { month: "short", day: "numeric" };
    if (withWeekday) opts.weekday = "short";
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString("en-US", opts);
  }
  function daysBetween(fromIso, toIso) {
    return Math.round((parseIso(toIso) - parseIso(fromIso)) / 86400000);
  }

  function isMissingTableError(error, name) {
    if (!error) return false;
    if (error.code === "42P01" || error.code === "PGRST205" || error.code === "PGRST202") return true;
    const re = new RegExp(`relation.*${name}.*does not exist|could not find the (table|function)`, "i");
    return re.test(error.message || "");
  }

  function root() { return document.getElementById("availabilityAdmin"); }

  function renderShell() {
    const today = todayIso();
    root().innerHTML = `
      <h2>Unavailable dates</h2>
      <p class="panel-subtitle">Customers can't choose these dates on the checkout or custom-order forms.</p>
      <form id="blockDatesForm" novalidate>
        <div class="field">
          <label for="bd-from">Date</label>
          <input id="bd-from" name="from" type="date" min="${today}" required/>
        </div>
        <div class="field">
          <label for="bd-to">Until (optional, to block a range)</label>
          <input id="bd-to" name="to" type="date" min="${today}"/>
        </div>
        <div class="field">
          <label for="bd-reason">Reason (optional)</label>
          <input id="bd-reason" name="reason" type="text" maxlength="200" list="bd-reason-options" placeholder="e.g. Fully booked, Vacation"/>
          <datalist id="bd-reason-options">
            <option value="Fully booked"></option>
            <option value="Vacation"></option>
            <option value="Closed"></option>
          </datalist>
          <p class="field-note">Visible to anyone who looks closely — keep it short, nothing private.</p>
        </div>
        <div class="form-status" id="blockDatesStatus" role="status"></div>
        <button type="submit" class="btn btn-primary btn-block" id="blockDatesBtn">Block date</button>
      </form>

      <div class="availability-section">
        <h3>Coming up</h3>
        <div id="blockedDatesList"><p class="empty-note">Loading...</p></div>
      </div>

      <div class="availability-section">
        <h3>Daily order limit</h3>
        <form id="capacityForm" novalidate>
          <div class="field">
            <label for="bd-capacity">Max orders per day</label>
            <input id="bd-capacity" name="capacity" type="number" min="0" step="1" inputmode="numeric" placeholder="No limit"/>
            <p class="field-note">Once a date has this many orders (checkout + custom), it shows as fully booked. Leave blank for no limit.</p>
          </div>
          <div class="form-status" id="capacityStatus" role="status"></div>
          <button type="submit" class="btn btn-outline btn-block" id="capacitySaveBtn">Save limit</button>
        </form>
        <div id="fullyBookedList"></div>
      </div>
    `;

    const fromInput = document.getElementById("bd-from");
    const toInput = document.getElementById("bd-to");
    const btn = document.getElementById("blockDatesBtn");
    const syncLabel = () => {
      const isRange = toInput.value && fromInput.value && toInput.value > fromInput.value;
      btn.textContent = isRange ? "Block dates" : "Block date";
      if (fromInput.value) toInput.min = fromInput.value;
    };
    fromInput.addEventListener("change", syncLabel);
    toInput.addEventListener("change", syncLabel);
    document.getElementById("blockDatesForm").addEventListener("submit", handleBlock);
    document.getElementById("capacityForm").addEventListener("submit", handleSaveCapacity);
  }

  function setStatus(id, text, kind) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = `form-status${kind ? " " + kind : ""}`;
  }

  // Groups consecutive days that share a reason into { from, to, reason }.
  function groupRanges(rows) {
    const ranges = [];
    rows.forEach((r) => {
      const last = ranges[ranges.length - 1];
      if (last && last.reason === r.reason && nextIso(last.to) === r.day) last.to = r.day;
      else ranges.push({ from: r.day, to: r.day, reason: r.reason });
    });
    return ranges;
  }

  function renderBlockedList() {
    const listEl = document.getElementById("blockedDatesList");
    if (!listEl) return;
    if (!blockedCache.length) {
      listEl.innerHTML = `<p class="empty-note">No upcoming dates blocked.</p>`;
      return;
    }
    const ranges = groupRanges(blockedCache);
    listEl.innerHTML = ranges.map((r, i) => {
      const count = daysBetween(r.from, r.to) + 1;
      const label = count === 1 ? friendly(r.from) : `${friendly(r.from)} – ${friendly(r.to)}`;
      const meta = [r.reason, count > 1 ? `${count} days` : ""].filter(Boolean).join(" · ");
      return `
        <div class="admin-item-row">
          <div class="admin-item-body">
            <div class="name">${escapeHtml(label)}</div>
            ${meta ? `<div class="meta">${escapeHtml(meta)}</div>` : ""}
          </div>
          <div class="admin-item-actions">
            <button type="button" class="danger" data-range-index="${i}">Unblock</button>
          </div>
        </div>`;
    }).join("");
    listEl.querySelectorAll("[data-range-index]").forEach((b) => {
      b.addEventListener("click", () => handleUnblock(ranges[Number(b.dataset.rangeIndex)], b));
    });
  }

  function showMissingTable() {
    root().innerHTML = `
      <h2>Unavailable dates</h2>
      <p class="form-status error">The blocked_dates table doesn't exist yet — run the latest supabase-setup.sql in your Supabase SQL Editor to turn on date blocking and the daily order limit. Until then, customers can order for any future date.</p>`;
  }

  async function loadBlocked() {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("blocked_dates")
      .select("day,reason")
      .gte("day", todayIso())
      .order("day", { ascending: true })
      .limit(2000);
    if (error) return { error };
    blockedCache = (data || []).map((r) => ({ day: String(r.day).slice(0, 10), reason: r.reason || "" }));
    return {};
  }

  async function loadCapacity() {
    const client = getSupabaseClient();
    const input = document.getElementById("bd-capacity");
    const { data, error } = await client.from("site_settings").select("value").eq("key", CAPACITY_KEY).maybeSingle();
    if (error) {
      setStatus("capacityStatus", "Couldn't load the daily limit: " + error.message, "error");
      return;
    }
    const v = data && data.value != null ? String(data.value).trim() : "";
    if (input && document.activeElement !== input) input.value = /^\d+$/.test(v) && Number(v) > 0 ? v : "";
    await loadFullyBooked(Number(v) > 0);
  }

  async function loadFullyBooked(hasLimit) {
    const el = document.getElementById("fullyBookedList");
    if (!el) return;
    if (!hasLimit) { el.innerHTML = ""; return; }
    const client = getSupabaseClient();
    const from = todayIso();
    const toDate = new Date();
    toDate.setDate(toDate.getDate() + 400);
    const { data, error } = await client.rpc("fully_booked_dates", { from_day: from, to_day: localIsoDate(toDate) });
    if (error) {
      el.innerHTML = isMissingTableError(error, "fully_booked_dates")
        ? `<p class="form-status error">The fully_booked_dates function doesn't exist yet — run the latest supabase-setup.sql so the limit takes effect.</p>`
        : `<p class="form-status error">Couldn't check fully booked dates: ${escapeHtml(error.message)}</p>`;
      return;
    }
    const days = (data || [])
      .map((row) => String(row && typeof row === "object" ? (row.day || row.fully_booked_dates) : row).slice(0, 10))
      .filter((d) => ISO_DAY_RE.test(d));
    el.innerHTML = days.length
      ? `<p class="field-note availability-full-note">Fully booked by orders: ${days.map((d) => escapeHtml(friendly(d))).join(", ")}</p>`
      : `<p class="field-note availability-full-note">No upcoming date has reached the limit yet.</p>`;
  }

  async function handleBlock(e) {
    e.preventDefault();
    if (busy) return;
    const from = document.getElementById("bd-from").value;
    let to = document.getElementById("bd-to").value || from;
    const reason = document.getElementById("bd-reason").value.trim().slice(0, 200);

    if (!ISO_DAY_RE.test(from)) return setStatus("blockDatesStatus", "Pick a date to block.", "error");
    if (!ISO_DAY_RE.test(to)) to = from;
    if (from < todayIso()) return setStatus("blockDatesStatus", "That date has already passed.", "error");
    if (to < from) return setStatus("blockDatesStatus", "\"Until\" must be on or after the first date.", "error");
    const span = daysBetween(from, to) + 1;
    if (span > MAX_RANGE_DAYS) return setStatus("blockDatesStatus", `That's ${span} days — block at most ${MAX_RANGE_DAYS} at a time.`, "error");

    const rows = [];
    for (let d = from; d <= to; d = nextIso(d)) rows.push({ day: d, reason });

    busy = true;
    const btn = document.getElementById("blockDatesBtn");
    btn.disabled = true;
    setStatus("blockDatesStatus", "Saving...");
    const { error } = await mustAffect(getSupabaseClient().from("blocked_dates").upsert(rows, { onConflict: "day" }));
    busy = false;
    btn.disabled = false;
    if (error) {
      if (isMissingTableError(error, "blocked_dates")) return showMissingTable();
      return setStatus("blockDatesStatus", "Couldn't block: " + error.message, "error");
    }
    document.getElementById("blockDatesForm").reset();
    document.getElementById("bd-to").min = todayIso();
    btn.textContent = "Block date";
    setStatus("blockDatesStatus", span === 1 ? `Blocked ${friendly(from)}.` : `Blocked ${span} days (${friendly(from)} – ${friendly(to)}).`, "success");
    await refreshList();
  }

  async function handleUnblock(range, btn) {
    if (!range || busy) return;
    const count = daysBetween(range.from, range.to) + 1;
    const label = count === 1 ? friendly(range.from) : `${friendly(range.from)} – ${friendly(range.to)} (${count} days)`;
    if (!confirm(`Unblock ${label}? Customers will be able to order for ${count === 1 ? "it" : "these dates"} again.`)) return;
    busy = true;
    btn.disabled = true;
    const days = blockedCache.filter((r) => r.day >= range.from && r.day <= range.to).map((r) => r.day);
    const { error } = await mustAffect(getSupabaseClient().from("blocked_dates").delete().in("day", days));
    busy = false;
    if (error) {
      btn.disabled = false;
      return setStatus("blockDatesStatus", "Couldn't unblock: " + error.message, "error");
    }
    setStatus("blockDatesStatus", `Unblocked ${label}.`, "success");
    await refreshList();
  }

  async function handleSaveCapacity(e) {
    e.preventDefault();
    const input = document.getElementById("bd-capacity");
    const raw = input.value.trim();
    if (raw && !/^\d{1,6}$/.test(raw)) return setStatus("capacityStatus", "Enter a whole number, or leave it blank for no limit.", "error");
    const value = raw && Number(raw) > 0 ? String(Number(raw)) : "";
    const btn = document.getElementById("capacitySaveBtn");
    btn.disabled = true;
    setStatus("capacityStatus", "Saving...");
    const { error } = await mustAffect(getSupabaseClient().from("site_settings").upsert({ key: CAPACITY_KEY, value }, { onConflict: "key" }));
    btn.disabled = false;
    if (error) return setStatus("capacityStatus", "Couldn't save: " + error.message, "error");
    input.value = value;
    setStatus("capacityStatus", value ? `Limit saved: ${value} order${value === "1" ? "" : "s"} per day.` : "Limit removed — no daily cap.", "success");
    await loadFullyBooked(!!value);
  }

  async function refreshList() {
    const { error } = await loadBlocked();
    if (error) {
      if (isMissingTableError(error, "blocked_dates")) return showMissingTable();
      const listEl = document.getElementById("blockedDatesList");
      if (listEl) listEl.innerHTML = `<p class="form-status error">Couldn't load blocked dates: ${escapeHtml(error.message)}</p>`;
      return;
    }
    renderBlockedList();
  }

  window.refreshAvailabilityAdmin = async function () {
    const el = root();
    if (!el || typeof getSupabaseClient !== "function" || !getSupabaseClient()) return;
    // Keep the form (and anything half-typed) if it's already on screen.
    if (!document.getElementById("blockDatesForm")) renderShell();
    const { error } = await loadBlocked();
    if (error) {
      if (isMissingTableError(error, "blocked_dates")) return showMissingTable();
      document.getElementById("blockedDatesList").innerHTML = `<p class="form-status error">Couldn't load blocked dates: ${escapeHtml(error.message)}</p>`;
    } else {
      renderBlockedList();
    }
    await loadCapacity();
  };
})();
