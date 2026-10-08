/* Inspiration prefill for the custom order form (custom-order.html).
   The gallery's "Order something like this" link on photos without a
   linked product points here as custom-order.html?inspiration=<gallery id>
   (js/gallery.js). This looks that gallery_items row up (plain anon
   select, so only active photos are found; see the "Gallery" section of supabase-setup.sql),
   then:
     - shows a small "Your inspiration" card (thumbnail, caption, remove)
       in #inspirationCard above the form, and
     - appends one line to the "describe your vision" textarea
       (#co-details), after whatever the customer already typed, so it
       reaches the order notes with the rest of the vision text:
         Inspiration: gallery photo #12 — "Pink arch" https://...
   "Remove" takes that exact line back out and hides the card.
   A missing, malformed or unknown id (or no Supabase) does nothing at all.
   Self-contained: doesn't touch initCustomOrderForm() in js/app.js. */
(function () {
  function readId() {
    try {
      const raw = new URLSearchParams(location.search).get("inspiration");
      if (!raw || !/^\d{1,15}$/.test(raw.trim())) return null;
      const id = Number(raw.trim());
      return id > 0 ? id : null;
    } catch (e) {
      return null;
    }
  }

  const esc = (s) => (typeof escapeHtml === "function" ? escapeHtml(s) : String(s == null ? "" : s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`));

  function inspirationLine(item) {
    const caption = String(item.caption || "").trim().replace(/\s+/g, " ");
    return `Inspiration: gallery photo #${item.id}${caption ? ` — "${caption}"` : ""} ${String(item.image_url).trim()}`;
  }

  function appendLine(textarea, line) {
    if (textarea.value.includes(line)) return; // e.g. restored by the browser on Back
    const typed = textarea.value.replace(/\s+$/, "");
    textarea.value = typed ? `${typed}\n${line}` : line;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function removeLine(textarea, line) {
    const lines = textarea.value.split("\n");
    const at = lines.indexOf(line);
    if (at === -1) return;
    lines.splice(at, 1);
    textarea.value = lines.join("\n").replace(/\s+$/, "");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function dropParamFromUrl() {
    try {
      const url = new URL(location.href);
      url.searchParams.delete("inspiration");
      history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    } catch (e) { /* cosmetic only */ }
  }

  async function init() {
    const card = document.getElementById("inspirationCard");
    const textarea = document.getElementById("co-details");
    const id = readId();
    if (!card || !textarea || id === null) return;
    const client = typeof getSupabaseClient === "function" ? getSupabaseClient() : null;
    if (!client) return;

    let item = null;
    try {
      const { data, error } = await client
        .from("gallery_items")
        .select("id,image_url,caption,occasion")
        .eq("id", id)
        .eq("active", true)
        .maybeSingle();
      if (error || !data) return;
      item = data;
    } catch (e) {
      return;
    }
    if (!/^https?:\/\//i.test(String(item.image_url || "").trim())) return;

    const line = inspirationLine(item);
    const caption = String(item.caption || "").trim();
    const occasion = String(item.occasion || "").trim();
    card.innerHTML = `
      <img class="inspiration-thumb" src="${esc(String(item.image_url).trim())}" alt="" width="64" height="64" loading="eager" decoding="async"/>
      <div class="inspiration-body">
        <p class="inspiration-label">Your inspiration</p>
        <p class="inspiration-caption">${caption ? esc(caption) : (occasion ? esc(occasion) : `Gallery photo #${esc(item.id)}`)}</p>
        <p class="inspiration-note">We've added it to your description below.</p>
      </div>
      <button type="button" class="inspiration-remove" aria-label="Remove this inspiration photo">Remove</button>
    `;
    card.hidden = false;
    appendLine(textarea, line);

    card.querySelector(".inspiration-remove").addEventListener("click", () => {
      removeLine(textarea, line);
      card.hidden = true;
      card.innerHTML = "";
      dropParamFromUrl();
      textarea.focus();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
