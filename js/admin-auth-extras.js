/* Login extras for admin.html: forgot/reset password, 2-step login (TOTP
   authenticator app), "log out other devices", and team roles (owner /
   staff). Database side: supabase-migrations/30-safety.sql. Owner guide:
   docs/admin-safety.md.

   Hooks into js/admin-core.js through three window arrays it reads:
     window.adminLoginGates      async (client, session) => boolean. Run by
                                 enterDashboard() before the dashboard shows;
                                 false = "I've shown my own screen".
     window.adminSessionHooks    async (client, session). Run right before the
                                 dashboard shows (role lookup lives here).
     window.adminLoginViewHooks  () => void. Run by showLoginView().
   Exposes window.getAdminRole() -> 'owner' | 'staff' | null for other files,
   and window.AdminAuthLib (pure helpers, unit-tested).

   Graceful degradation: until 30-safety.sql has been run, admin_role() is
   missing, so every login is treated as an owner (exactly the old
   behaviour) and the Team card says to run the migration. 2-step login
   still works in the page; the database only starts requiring it once the
   migration is in. */
(function () {
  "use strict";

  /* ----- Pure helpers (also used by the unit tests) ----- */

  const COMMON_PASSWORD_PARTS = ["password", "passw0rd", "123456", "12345678", "qwerty", "letmein", "welcome", "admin", "balloon", "iloveyou", "abc123", "111111"];

  /* Rough strength check for a new password. Not a security boundary
     (Supabase enforces its own minimum), just guidance. */
  function scorePassword(pw, email) {
    const value = String(pw || "");
    if (!value) return { score: 0, label: "", hint: "Use at least 10 characters.", ok: false };
    if (value.length < 10) return { score: 0, label: "Too short", hint: `Use at least 10 characters (${value.length} so far).`, ok: false };
    const lower = value.toLowerCase();
    const local = String(email || "").toLowerCase().split("@")[0];
    if (COMMON_PASSWORD_PARTS.some((w) => lower.includes(w)) || (local.length >= 4 && lower.includes(local)) || /^(.)\1+$/.test(value)) {
      return { score: 1, label: "Weak", hint: "Avoid common words, repeated characters and your email name.", ok: false };
    }
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(value)).length;
    let score = 1;
    if (value.length >= 14) score += 1;
    if (classes >= 3) score += 1;
    if (value.length >= 18 || (classes === 4 && value.length >= 12)) score += 1;
    if (value.length >= 24) score += 1;
    score = Math.min(4, score);
    const label = ["", "Weak", "Okay", "Good", "Strong"][score];
    const hint = score >= 3 ? "Nice. Keep it somewhere safe, like a password manager." : "Longer is stronger: try three or four unrelated words.";
    return { score, label, hint, ok: score >= 2 };
  }

  /* True when this login still needs its 6-digit code. */
  function needsMfaStep(aal) {
    return Boolean(aal) && aal.nextLevel === "aal2" && aal.currentLevel !== "aal2";
  }

  /* supabase-js returns the QR as an SVG data URL; older versions gave raw
     SVG markup. Anything else is refused rather than put in an <img>. */
  function qrImageSrc(qr) {
    const value = String(qr || "").trim();
    if (/^data:image\/(svg\+xml|png)[;,]/i.test(value)) return value;
    if (/^<svg[\s>]/i.test(value)) return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(value);
    return "";
  }

  function teamErrorMessage(error) {
    const msg = (error && (error.message || error.hint)) || String(error || "");
    if (typeof isMissingTableError === "function" && isMissingTableError(error)) return "Team roles need the database update: run supabase-migrations/30-safety.sql in the Supabase SQL editor.";
    if (/no_such_user/.test(msg)) return "There's no login for that email yet. Create it first in Supabase: Authentication -> Users -> Add user (or Invite user), then add it here.";
    if (/builtin_owner/.test(msg)) return "The original admin account is always an owner and can't be changed or removed.";
    if (/last_owner/.test(msg)) return "Someone has to stay an owner, so that change wasn't made.";
    if (/owner only|42501/.test(msg)) return "Only an owner can change the team.";
    if (/invalid_role/.test(msg)) return "Pick Owner or Staff.";
    return msg || "Something went wrong.";
  }

  function looksLikeEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
  }

  window.AdminAuthLib = { scorePassword, needsMfaStep, qrImageSrc, teamErrorMessage, looksLikeEmail };

  // Running under the unit tests (no admin page): stop after the helpers.
  if (typeof document === "undefined" || !document.getElementById) return;

  /* ----- State ----- */

  // Read the reset link's details now, before supabase-js tidies the URL.
  const startHash = new URLSearchParams(String(window.location.hash || "").replace(/^#/, ""));
  const startQuery = new URLSearchParams(String(window.location.search || ""));
  let recoveryMode = startHash.get("type") === "recovery";
  const resetLinkError = startHash.get("error_description") || startQuery.get("error_description") || "";

  let currentRole = null;
  let roleFromDatabase = false; // false = migration not run, everyone is treated as owner
  let mfaStepDone = null;       // callback after a successful 6-digit code

  window.getAdminRole = () => currentRole;

  const $ = (id) => document.getElementById(id);
  const LOGIN_CARDS = ["loginCard", "forgotPasswordCard", "mfaStepCard", "newPasswordCard"];

  function setStatus(el, message, kind) {
    if (!el) return;
    el.textContent = message || "";
    el.className = `form-status${kind ? " " + kind : ""}`;
  }

  function showLoginCard(id) {
    LOGIN_CARDS.forEach((cardId) => {
      const el = $(cardId);
      if (el) el.hidden = cardId !== id;
    });
    const focusEl = $(id) && $(id).querySelector("input");
    if (focusEl) setTimeout(() => focusEl.focus(), 0);
  }

  /* The extra screens live inside #loginView, so show that first. */
  function showExtraScreen(id) {
    showLoginView();
    showLoginCard(id);
  }

  function clearUrlAuthBits() {
    if (window.location.hash || /[?&](code|error_description)=/.test(window.location.search)) {
      try { history.replaceState(null, "", window.location.pathname); } catch (e) { /* not important */ }
    }
  }

  function setRoleClasses(role) {
    const body = document.body;
    body.classList.remove("role-owner", "role-staff", "role-none");
    if (role) body.classList.add(`role-${role}`);
  }

  /* ----- Password strength meter ----- */

  function wireMeter(input, meter, getEmail) {
    if (!input || !meter) return;
    const update = () => {
      const result = scorePassword(input.value, getEmail());
      meter.dataset.score = String(result.score);
      meter.innerHTML = input.value
        ? `<span class="password-meter-bar"><span style="width:${result.score * 25}%"></span></span><span class="password-meter-text"><strong>${escapeHtml(result.label)}</strong> ${escapeHtml(result.hint)}</span>`
        : `<span class="password-meter-text">${escapeHtml(result.hint)}</span>`;
    };
    input.addEventListener("input", update);
    update();
  }

  async function currentEmail(client) {
    try {
      const { data } = await client.auth.getSession();
      return (data && data.session && data.session.user.email) || "";
    } catch (e) { return ""; }
  }

  /* Shared by the reset screen and the Security card. */
  async function saveNewPassword(client, pw, confirmPw, statusEl) {
    const email = await currentEmail(client);
    const strength = scorePassword(pw, email);
    if (!strength.ok) { setStatus(statusEl, strength.hint, "error"); return false; }
    if (pw !== confirmPw) { setStatus(statusEl, "The two passwords don't match.", "error"); return false; }
    setStatus(statusEl, "Saving...", "");
    const { error } = await client.auth.updateUser({ password: pw });
    if (error) {
      const msg = error.message || "";
      if (/aal2|assurance/i.test(msg)) setStatus(statusEl, "Enter your 2-step login code first, then try again.", "error");
      else if (/different from the old/i.test(msg)) setStatus(statusEl, "That's your current password. Pick a new one.", "error");
      else setStatus(statusEl, `Couldn't save the password: ${msg}`, "error");
      return false;
    }
    setStatus(statusEl, "Password saved.", "success");
    return true;
  }

  /* ----- Forgot password ----- */

  function wireForgotPassword(client) {
    const btn = $("forgotPasswordBtn");
    const form = $("forgotPasswordForm");
    if (!btn || !form) return;
    btn.addEventListener("click", () => {
      $("forgotEmail").value = $("loginEmail").value.trim();
      setStatus($("forgotStatus"), "", "");
      showLoginCard("forgotPasswordCard");
    });
    document.querySelectorAll("[data-back-to-login]").forEach((el) => el.addEventListener("click", () => showLoginCard("loginCard")));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = $("forgotEmail").value.trim();
      const statusEl = $("forgotStatus");
      if (!looksLikeEmail(email)) { setStatus(statusEl, "Enter the email you log in with.", "error"); return; }
      const sendBtn = $("forgotSendBtn");
      sendBtn.disabled = true;
      setStatus(statusEl, "Sending...", "");
      try {
        const { error } = await client.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin + window.location.pathname
        });
        if (error && /rate|too many|seconds/i.test(error.message || "")) {
          setStatus(statusEl, "Too many reset emails for now. Wait a minute and try again.", "error");
        } else if (error && /redirect/i.test(error.message || "")) {
          setStatus(statusEl, "Supabase refused the link address. Add this page's address under Authentication -> URL Configuration -> Redirect URLs (see docs/admin-safety.md).", "error");
        } else {
          // Same message whether or not the account exists.
          setStatus(statusEl, "If that email has an admin login, a reset link is on its way. It can take a few minutes, so check spam too.", "success");
        }
      } catch (err) {
        setStatus(statusEl, "Couldn't send the email. Check your connection and try again.", "error");
      } finally {
        sendBtn.disabled = false;
      }
    });
  }

  /* ----- Reset link landing: choose a new password ----- */

  function showNewPasswordScreen() {
    $("newPassword").value = "";
    $("newPasswordConfirm").value = "";
    setStatus($("newPasswordStatus"), "", "");
    $("newPassword").dispatchEvent(new Event("input"));
    showExtraScreen("newPasswordCard");
  }

  async function startRecovery(client) {
    // A reset-link session is a fresh, single-factor login. If the account
    // has 2-step login on, ask for the code first (Supabase may refuse the
    // password change otherwise).
    let aal = null;
    try { aal = (await client.auth.mfa.getAuthenticatorAssuranceLevel()).data; } catch (e) { aal = null; }
    if (needsMfaStep(aal)) {
      showMfaStep(showNewPasswordScreen);
      return;
    }
    showNewPasswordScreen();
  }

  function wireNewPassword(client) {
    const form = $("newPasswordForm");
    if (!form) return;
    let email = "";
    currentEmail(client).then((value) => { email = value; });
    wireMeter($("newPassword"), $("newPasswordMeter"), () => email);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = $("newPasswordBtn");
      btn.disabled = true;
      try {
        const saved = await saveNewPassword(client, $("newPassword").value, $("newPasswordConfirm").value, $("newPasswordStatus"));
        if (saved) {
          recoveryMode = false;
          clearUrlAuthBits();
          await enterDashboard();
        }
      } finally {
        btn.disabled = false;
      }
    });
  }

  async function recoveryGate(client) {
    if (!recoveryMode) return true;
    await startRecovery(client);
    return false;
  }

  /* ----- 2-step login at sign-in ----- */

  function showMfaStep(onDone) {
    mfaStepDone = onDone || (() => enterDashboard());
    $("mfaStepCode").value = "";
    setStatus($("mfaStepStatus"), "", "");
    showExtraScreen("mfaStepCard");
  }

  async function verifiedTotpFactor(client) {
    const { data, error } = await client.auth.mfa.listFactors();
    if (error) throw error;
    const all = (data && (data.all || data.totp)) || [];
    return all.find((f) => f.factor_type === "totp" && f.status === "verified") || null;
  }

  function wireMfaStep(client) {
    const form = $("mfaStepForm");
    if (!form) return;
    const input = $("mfaStepCode");
    input.addEventListener("input", () => {
      input.value = input.value.replace(/\D/g, "").slice(0, 6);
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = input.value.trim();
      const statusEl = $("mfaStepStatus");
      if (!/^\d{6}$/.test(code)) { setStatus(statusEl, "Type the 6 digits from your authenticator app.", "error"); return; }
      const btn = $("mfaStepBtn");
      btn.disabled = true;
      setStatus(statusEl, "Checking...", "");
      try {
        const factor = await verifiedTotpFactor(client);
        if (!factor) { setStatus(statusEl, "No authenticator is set up for this login any more. Log in again.", "error"); return; }
        const { error } = await client.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
        if (error) {
          setStatus(statusEl, "That code didn't work. Codes change every 30 seconds, so type the newest one. Check your phone's clock is set automatically.", "error");
          input.select();
          return;
        }
        setStatus(statusEl, "", "");
        const done = mfaStepDone;
        mfaStepDone = null;
        if (done) await done();
      } catch (err) {
        setStatus(statusEl, `Couldn't check the code: ${err.message || err}`, "error");
      } finally {
        btn.disabled = false;
      }
    });
    $("mfaStepCancelBtn").addEventListener("click", async () => {
      recoveryMode = false;
      try { await client.auth.signOut(); } catch (err) { /* offline: the login screen still comes back */ }
      showLoginView();
    });
  }

  async function mfaGate(client) {
    let aal = null;
    try {
      const { data, error } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      if (error) return true; // can't tell; the database still enforces it once 30-safety.sql is in
      aal = data;
    } catch (e) {
      return true;
    }
    if (!needsMfaStep(aal)) return true;
    showMfaStep(() => enterDashboard());
    return false;
  }

  /* ----- Role ----- */

  async function loadRole(client) {
    try {
      const { data, error } = await client.rpc("admin_role");
      if (error) {
        if (isMissingTableError(error, "admin_role")) {
          currentRole = "owner";
          roleFromDatabase = false;
        } else {
          // Unknown failure: don't lock the owner out of their own page;
          // the database still decides what each request may do.
          console.warn("[admin] couldn't read the team role:", error);
          currentRole = "owner";
          roleFromDatabase = false;
        }
      } else {
        currentRole = data === "owner" || data === "staff" ? data : null;
        roleFromDatabase = true;
      }
    } catch (err) {
      currentRole = "owner";
      roleFromDatabase = false;
    }
    setRoleClasses(currentRole || "none");
    renderRoleNotice();
  }

  function renderRoleNotice() {
    const dash = $("dashboardView");
    if (!dash) return;
    let notice = $("roleNotice");
    if (currentRole === "owner") { if (notice) notice.remove(); return; }
    if (!notice) {
      notice = document.createElement("div");
      notice.id = "roleNotice";
      notice.className = "role-notice";
      dash.insertBefore(notice, dash.firstChild);
    }
    notice.innerHTML = currentRole === "staff"
      ? "<strong>Staff login.</strong> You can see products and orders and update order status and notes. Ask an owner for anything else."
      : "<strong>This login doesn't have admin access.</strong> Ask the owner to add you in Settings -> Team, then log out and back in.";
  }

  /* ----- Security card (Settings) ----- */

  function settingsMountPoint() {
    const panel = $("settingsPanel");
    if (!panel) return null;
    return { panel, before: $("backupAdmin") };
  }

  function mountSection(id, className) {
    const spot = settingsMountPoint();
    if (!spot) return null;
    let section = $(id);
    if (!section) {
      section = document.createElement("section");
      section.id = id;
      section.className = className;
      if (spot.before && spot.before.parentNode === spot.panel) spot.panel.insertBefore(section, spot.before);
      else spot.panel.appendChild(section);
    }
    return section;
  }

  let refreshSecurityCard = null;

  function renderSecurityCard(client) {
    const section = mountSection("securityCard", "safety-section");
    if (!section) return;
    if (section.dataset.ready) {
      // Same card, possibly a different login since last time.
      if (refreshSecurityCard) refreshSecurityCard();
      return;
    }
    section.dataset.ready = "1";
    section.innerHTML = `
      <h2>Security</h2>
      <div class="safety-block">
        <h3>2-step login</h3>
        <p class="safety-help">After your password, the login also asks for a 6-digit code from an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, 1Password, Authy...). Someone who learns your password still can't get in.</p>
        <div id="mfaFactorList" class="mfa-factor-list"></div>
        <button type="button" class="btn btn-outline btn-sm" id="mfaEnrollBtn">Turn on 2-step login</button>
        <div class="mfa-enroll" id="mfaEnrollArea" hidden>
          <ol class="mfa-steps">
            <li>Open your authenticator app and add an account by scanning this code:
              <div class="mfa-qr-wrap"><img id="mfaQrImg" alt="QR code for your authenticator app" width="180" height="180"/></div>
              Can't scan? Type this key instead: <code id="mfaSecret" class="mfa-secret"></code>
            </li>
            <li>
              <label for="mfaEnrollCode">Type the 6-digit code the app shows:</label>
              <input id="mfaEnrollCode" type="text" inputmode="numeric" maxlength="6" autocomplete="one-time-code" class="mfa-code-input"/>
            </li>
          </ol>
          <div class="safety-actions">
            <button type="button" class="btn btn-primary btn-sm" id="mfaVerifyBtn">Verify and turn on</button>
            <button type="button" class="btn btn-outline btn-sm" id="mfaCancelBtn">Cancel</button>
          </div>
        </div>
        <div class="form-status" id="mfaStatus" role="status" aria-live="polite"></div>
      </div>
      <div class="safety-block">
        <h3>Change password</h3>
        <div class="field"><label for="secNewPassword">New password</label><input id="secNewPassword" type="password" autocomplete="new-password"/>
          <div class="password-meter" id="secNewPasswordMeter" aria-live="polite"></div></div>
        <div class="field"><label for="secNewPasswordConfirm">Type it again</label><input id="secNewPasswordConfirm" type="password" autocomplete="new-password"/></div>
        <button type="button" class="btn btn-outline btn-sm" id="secPasswordBtn">Change password</button>
        <div class="form-status" id="secPasswordStatus" role="status" aria-live="polite"></div>
      </div>
      <div class="safety-block">
        <h3>Other devices</h3>
        <p class="safety-help">Lost a phone, or logged in on a shared computer? This logs out every other device and browser. You stay logged in here.</p>
        <button type="button" class="btn btn-outline btn-sm" id="signOutOthersBtn">Log out other devices</button>
        <div class="form-status" id="signOutOthersStatus" role="status" aria-live="polite"></div>
      </div>
    `;

    let pendingFactorId = null;
    const statusEl = $("mfaStatus");

    async function refreshFactors() {
      const list = $("mfaFactorList");
      let factors = [];
      try {
        const { data, error } = await client.auth.mfa.listFactors();
        if (error) throw error;
        factors = ((data && data.all) || []).filter((f) => f.factor_type === "totp");
      } catch (err) {
        list.innerHTML = `<p class="form-status error">Couldn't load your 2-step login settings: ${escapeHtml(err.message || String(err))}</p>`;
        return [];
      }
      const verified = factors.filter((f) => f.status === "verified");
      list.innerHTML = verified.length
        ? `<p class="mfa-on">2-step login is <strong>on</strong>.</p><ul class="mfa-factors">${verified.map((f) => `
            <li><span>${escapeHtml(f.friendly_name || "Authenticator app")} <small>added ${escapeHtml(new Date(f.created_at).toLocaleDateString())}</small></span>
            <button type="button" class="btn btn-outline btn-sm" data-unenroll="${escapeHtml(f.id)}">Remove</button></li>`).join("")}</ul>`
        : `<p class="mfa-off">2-step login is <strong>off</strong>.${roleFromDatabase ? "" : " (Once supabase-migrations/30-safety.sql has been run, the database will require the code too, not just this page.)"}</p>`;
      $("mfaEnrollBtn").hidden = verified.length > 0 || pendingFactorId !== null;
      list.querySelectorAll("[data-unenroll]").forEach((btn) => btn.addEventListener("click", () => removeFactor(btn.dataset.unenroll)));
      return factors;
    }

    async function removeFactor(factorId) {
      if (!(await adminConfirm({ title: "Turn off 2-step login?", message: "Your account will be protected by the password alone.", confirmLabel: "Turn off", danger: true }))) return;
      setStatus(statusEl, "Removing...", "");
      const { error } = await client.auth.mfa.unenroll({ factorId });
      if (error) setStatus(statusEl, `Couldn't remove it: ${error.message}`, "error");
      else setStatus(statusEl, "2-step login is off.", "success");
      await refreshFactors();
    }

    $("mfaEnrollBtn").addEventListener("click", async () => {
      setStatus(statusEl, "Setting up...", "");
      try {
        // Clear half-finished attempts so they don't pile up.
        const existing = await refreshFactors();
        for (const f of existing.filter((x) => x.status !== "verified")) {
          await client.auth.mfa.unenroll({ factorId: f.id });
        }
        const { data, error } = await client.auth.mfa.enroll({
          factorType: "totp",
          friendlyName: `Authenticator ${new Date().toISOString().slice(0, 16).replace("T", " ")}`
        });
        if (error) throw error;
        const src = qrImageSrc(data.totp && data.totp.qr_code);
        pendingFactorId = data.id;
        $("mfaQrImg").src = src;
        $("mfaQrImg").hidden = !src;
        $("mfaSecret").textContent = (data.totp && data.totp.secret) || "";
        $("mfaEnrollCode").value = "";
        $("mfaEnrollArea").hidden = false;
        $("mfaEnrollBtn").hidden = true;
        setStatus(statusEl, "", "");
        $("mfaEnrollCode").focus();
      } catch (err) {
        setStatus(statusEl, `Couldn't start 2-step login setup: ${err.message || err}`, "error");
      }
    });

    $("mfaEnrollCode").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6); });

    $("mfaVerifyBtn").addEventListener("click", async () => {
      const code = $("mfaEnrollCode").value.trim();
      if (!/^\d{6}$/.test(code)) { setStatus(statusEl, "Type the 6 digits from your authenticator app.", "error"); return; }
      setStatus(statusEl, "Checking...", "");
      const { error } = await client.auth.mfa.challengeAndVerify({ factorId: pendingFactorId, code });
      if (error) { setStatus(statusEl, "That code didn't work. Type the newest code from the app.", "error"); return; }
      pendingFactorId = null;
      $("mfaEnrollArea").hidden = true;
      setStatus(statusEl, "2-step login is on. Next time you log in you'll be asked for a code.", "success");
      await refreshFactors();
    });

    $("mfaCancelBtn").addEventListener("click", async () => {
      const id = pendingFactorId;
      pendingFactorId = null;
      $("mfaEnrollArea").hidden = true;
      if (id) { try { await client.auth.mfa.unenroll({ factorId: id }); } catch (e) { /* tidied up next time */ } }
      setStatus(statusEl, "", "");
      await refreshFactors();
    });

    let email = "";
    currentEmail(client).then((value) => { email = value; });
    wireMeter($("secNewPassword"), $("secNewPasswordMeter"), () => email);
    $("secPasswordBtn").addEventListener("click", async () => {
      const btn = $("secPasswordBtn");
      btn.disabled = true;
      try {
        const saved = await saveNewPassword(client, $("secNewPassword").value, $("secNewPasswordConfirm").value, $("secPasswordStatus"));
        if (saved) { $("secNewPassword").value = ""; $("secNewPasswordConfirm").value = ""; $("secNewPassword").dispatchEvent(new Event("input")); }
      } finally {
        btn.disabled = false;
      }
    });

    $("signOutOthersBtn").addEventListener("click", async () => {
      if (!(await adminConfirm({ title: "Log out other devices?", message: "Log out every other device and browser? You'll stay logged in here.", confirmLabel: "Log them out" }))) return;
      const s = $("signOutOthersStatus");
      setStatus(s, "Logging out other devices...", "");
      const { error } = await client.auth.signOut({ scope: "others" });
      if (error) setStatus(s, `Couldn't do that: ${error.message}`, "error");
      else setStatus(s, "Done. Other devices will be asked to log in again (within the hour at most).", "success");
    });

    refreshSecurityCard = () => {
      setStatus(statusEl, "", "");
      setStatus($("signOutOthersStatus"), "", "");
      setStatus($("secPasswordStatus"), "", "");
      currentEmail(client).then((value) => { email = value; });
      return refreshFactors();
    };
    refreshFactors();
  }

  /* ----- Team card (Settings, owners only) ----- */

  function renderTeamCard(client) {
    const existing = $("teamCard");
    if (currentRole !== "owner") { if (existing) existing.remove(); return; }
    const section = mountSection("teamCard", "safety-section");
    if (!section) return;
    if (!section.dataset.ready) {
      section.dataset.ready = "1";
      section.innerHTML = `
        <h2>Team</h2>
        <p class="safety-help"><strong>Owner</strong>: everything. <strong>Staff</strong>: can see products and orders and update an order's status, notes and payment, but can't delete anything, change settings, products, categories, nav, FAQ or photos, or see the activity log.</p>
        <div id="teamList" class="team-list"></div>
        <form id="teamAddForm" class="team-add" novalidate>
          <h3>Add someone</h3>
          <p class="safety-help">They need a login first: in Supabase go to <em>Authentication -> Users -> Add user</em> (or <em>Invite user</em>) with their email. Then add the same email here. Full steps: docs/admin-safety.md.</p>
          <div class="team-add-row">
            <div class="field"><label for="teamEmail">Email</label><input id="teamEmail" type="email" autocomplete="off" required/></div>
            <div class="field"><label for="teamName">Name (shown in Activity)</label><input id="teamName" type="text" maxlength="60" autocomplete="off"/></div>
            <div class="field"><label for="teamRole">Role</label><select id="teamRole"><option value="staff">Staff</option><option value="owner">Owner</option></select></div>
          </div>
          <button type="submit" class="btn btn-outline btn-sm" id="teamAddBtn">Add to team</button>
        </form>
        <div class="form-status" id="teamStatus" role="status" aria-live="polite"></div>
      `;
      $("teamAddForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const email = $("teamEmail").value.trim();
        if (!looksLikeEmail(email)) { setStatus($("teamStatus"), "Enter their login email.", "error"); return; }
        const role = $("teamRole").value;
        const name = $("teamName").value.trim();
        if (role === "owner" && !(await adminConfirm({ title: `Make ${email} an owner?`, message: `Make ${email} an OWNER? Owners can do everything, including deleting data and changing the team.`, confirmLabel: "Make owner", danger: true }))) return;
        await setTeamRole(client, email, role, name, `${email} added as ${role}.`);
        $("teamEmail").value = "";
        $("teamName").value = "";
      });
    }
    refreshTeamList(client);
  }

  async function setTeamRole(client, email, role, name, successMessage) {
    const statusEl = $("teamStatus");
    setStatus(statusEl, "Saving...", "");
    const params = { member_email: email, new_role: role };
    if (name !== undefined) params.member_name = name;
    const { error } = await client.rpc("admin_set_team_role", params);
    if (error) { setStatus(statusEl, teamErrorMessage(error), "error"); await refreshTeamList(client); return false; }
    setStatus(statusEl, successMessage, "success");
    await refreshTeamList(client);
    return true;
  }

  let teamCache = [];
  window.getAdminTeam = () => teamCache.slice();

  async function refreshTeamList(client) {
    const listEl = $("teamList");
    if (!listEl) return;
    const { data, error } = await client.rpc("admin_team_list");
    if (error) {
      listEl.innerHTML = `<p class="form-status error">${escapeHtml(teamErrorMessage(error))}</p>`;
      $("teamAddForm").hidden = isMissingTableError(error);
      return;
    }
    $("teamAddForm").hidden = false;
    teamCache = data || [];
    const myEmail = (await currentEmail(client)).toLowerCase();
    listEl.innerHTML = `
      <table class="team-table">
        <thead><tr><th>Who</th><th>Role</th><th>Last login</th><th></th></tr></thead>
        <tbody>${teamCache.map((m) => `
          <tr data-email="${escapeHtml(m.email)}">
            <td><strong>${escapeHtml(m.display_name || m.email)}</strong>${m.display_name ? `<br><small>${escapeHtml(m.email)}</small>` : ""}${m.email === myEmail ? " <small>(you)</small>" : ""}</td>
            <td>${m.builtin
              ? "Owner <small>(original account)</small>"
              : `<select class="team-role-select" aria-label="Role for ${escapeHtml(m.email)}">
                  <option value="owner" ${m.role === "owner" ? "selected" : ""}>Owner</option>
                  <option value="staff" ${m.role === "staff" ? "selected" : ""}>Staff</option>
                </select>`}</td>
            <td>${m.last_sign_in_at ? escapeHtml(new Date(m.last_sign_in_at).toLocaleDateString()) : "never"}</td>
            <td>${m.builtin ? "" : `<button type="button" class="btn btn-outline btn-sm team-remove-btn">Remove</button>`}</td>
          </tr>`).join("")}</tbody>
      </table>`;
    listEl.querySelectorAll("tr[data-email]").forEach((row) => {
      const email = row.dataset.email;
      const select = row.querySelector(".team-role-select");
      if (select) select.addEventListener("change", async () => {
        if (select.value === "owner" && !(await adminConfirm({ title: `Make ${email} an owner?`, message: `Make ${email} an OWNER? Owners can do everything.`, confirmLabel: "Make owner", danger: true }))) { select.value = "staff"; return; }
        await setTeamRole(client, email, select.value, undefined, `${email} is now ${select.value}.`);
      });
      const remove = row.querySelector(".team-remove-btn");
      if (remove) remove.addEventListener("click", async () => {
        if (!(await adminConfirm({ title: `Remove ${email} from the team?`, message: `Their login will still exist in Supabase but won't be able to see or change anything here.`, confirmLabel: "Remove from team", danger: true }))) return;
        await setTeamRole(client, email, "none", undefined, `${email} removed from the team.`);
      });
    });
  }

  /* ----- Wiring ----- */

  window.adminLoginGates = window.adminLoginGates || [];
  window.adminSessionHooks = window.adminSessionHooks || [];
  window.adminLoginViewHooks = window.adminLoginViewHooks || [];

  window.adminLoginGates.push(recoveryGate, mfaGate);
  window.adminSessionHooks.push(async (client) => {
    await loadRole(client);
    renderSecurityCard(client);
    renderTeamCard(client);
  });
  window.adminLoginViewHooks.push(() => {
    showLoginCard("loginCard");
    currentRole = null;
    setRoleClasses(null);
  });

  /* Show/hide button inside each password field (markup in admin.html:
     <button data-pw-toggle="inputId" aria-pressed>). Only flips the input type. */
  function wirePasswordToggles() {
    document.querySelectorAll("[data-pw-toggle]").forEach((btn) => {
      const input = $(btn.getAttribute("data-pw-toggle"));
      if (!input || btn.dataset.pwWired) return;
      btn.dataset.pwWired = "1";
      btn.addEventListener("click", () => {
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        btn.setAttribute("aria-pressed", show ? "true" : "false");
        btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
        btn.classList.toggle("is-on", show);
        input.focus();
      });
    });
  }

  /* A login error should be announced and not leave focus on the button. */
  function wireLoginErrorFocus() {
    const err = $("loginError");
    const pw = $("loginPassword");
    if (!err || !pw || typeof MutationObserver !== "function") return;
    new MutationObserver(() => {
      const bad = err.textContent.trim() !== "";
      pw.setAttribute("aria-invalid", bad ? "true" : "false");
      if (bad && document.activeElement && document.activeElement.type === "submit") pw.focus();
    }).observe(err, { childList: true, characterData: true, subtree: true });
  }

  wirePasswordToggles();
  wireLoginErrorFocus();

  onAdminInit((client) => {
    wireForgotPassword(client);
    wireNewPassword(client);
    wireMfaStep(client);

    // PKCE-style reset links don't say "recovery" in the URL; supabase-js
    // announces them with this event instead. Run outside the callback
    // (supabase-js warns against awaiting its own calls inside it).
    client.auth.onAuthStateChange((event) => {
      if (event !== "PASSWORD_RECOVERY") return;
      recoveryMode = true;
      setTimeout(() => startRecovery(client), 0);
    });

    if (resetLinkError) {
      clearUrlAuthBits();
      setTimeout(() => {
        const el = $("loginError");
        if (el && !recoveryMode) el.textContent = /expired|invalid/i.test(resetLinkError)
          ? "That reset link has expired or was already used. Use \"Forgot password?\" to get a new one."
          : `The link didn't work: ${resetLinkError}`;
      }, 0);
    }
  });
})();
