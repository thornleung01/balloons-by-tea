/* Admin UI helpers: toasts and accessible dialogs.
   Loaded right after js/admin-core.js (see admin.html). Classic script, no deps.

   window.adminToast(message, {kind, duration, actionLabel, onAction}) -> dismiss()
   window.adminConfirm({title, message, confirmLabel, cancelLabel, danger, requireText}) -> Promise<boolean>
   window.adminConfirm.input({title, message, label, value, placeholder, confirmLabel}) -> Promise<string|null>
   window.adminAlert(message, {title}) -> Promise<void>

   All text is set with textContent (never innerHTML), so it is safe to pass
   user data (names, error messages). Styles: css/admin-ui.css.
   If this file fails to load, admin.html defines native-dialog fallbacks. */
(function () {
  "use strict";

  var doc = document;
  var uid = 0;

  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  /* ================= Toasts ================= */
  var MAX_TOASTS = 5;
  var toastHost = null;

  function getToastHost() {
    if (toastHost && toastHost.parentNode) return toastHost;
    toastHost = el("div", "aui-toasts");
    (doc.body || doc.documentElement).appendChild(toastHost);
    return toastHost;
  }

  function adminToast(message, opts) {
    opts = opts || {};
    var kind = opts.kind === "error" || opts.kind === "success" ? opts.kind : "info";
    var duration = typeof opts.duration === "number" ? opts.duration : (kind === "error" ? 8000 : 4500);
    if (opts.actionLabel && typeof opts.duration !== "number") duration = Math.max(duration, 8000);

    var host = getToastHost();
    while (host.children.length >= MAX_TOASTS) host.removeChild(host.firstChild);

    var t = el("div", "aui-toast aui-toast-" + kind);
    t.setAttribute("role", kind === "error" ? "alert" : "status");
    t.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
    t.appendChild(el("div", "aui-toast-msg", message == null ? "" : message));

    var gone = false, timer = null, remaining = duration, startedAt = 0;
    function dismiss() {
      if (gone) return;
      gone = true;
      if (timer) clearTimeout(timer);
      if (t.parentNode) t.parentNode.removeChild(t);
    }
    function start() {
      if (!(duration > 0) || gone || timer) return;
      startedAt = Date.now();
      timer = setTimeout(dismiss, remaining);
    }
    function pause() {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      remaining = Math.max(1500, remaining - (Date.now() - startedAt));
    }

    if (opts.actionLabel) {
      var act = el("button", "aui-toast-action", opts.actionLabel);
      act.type = "button";
      act.addEventListener("click", function () {
        dismiss();
        if (typeof opts.onAction === "function") {
          try { opts.onAction(); } catch (e) { if (window.console) console.error(e); }
        }
      });
      t.appendChild(act);
    }
    var x = el("button", "aui-toast-close", "×");
    x.type = "button";
    x.setAttribute("aria-label", "Dismiss notification");
    x.addEventListener("click", dismiss);
    t.appendChild(x);

    t.addEventListener("mouseenter", pause);
    t.addEventListener("mouseleave", start);
    t.addEventListener("focusin", pause);
    t.addEventListener("focusout", start);

    host.appendChild(t);
    start();
    return dismiss;
  }

  /* ================= Modal dialogs ================= */
  var queue = [];
  var busy = false;
  var lockCount = 0, savedOverflow = "";

  function lockScroll() {
    if (lockCount++ === 0) {
      savedOverflow = doc.documentElement.style.overflow;
      doc.documentElement.style.overflow = "hidden";
    }
  }
  function unlockScroll() {
    if (lockCount > 0 && --lockCount === 0) doc.documentElement.style.overflow = savedOverflow;
  }

  var FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /* cfg: {title, message, confirmLabel, cancelLabel (null = no cancel button), danger,
           requireText, input:{label,value,placeholder}}  ->  resolves {ok, value}
     Dialogs are shown one at a time; extra calls wait their turn. */
  function openDialog(cfg) {
    return new Promise(function (resolve) {
      queue.push({ cfg: cfg, resolve: resolve });
      pump();
    });
  }
  function pump() {
    if (busy || !queue.length) return;
    busy = true;
    var job = queue.shift();
    show(job.cfg, function (res) {
      busy = false;
      job.resolve(res);
      pump();
    });
  }

  function show(cfg, done) {
    var id = "aui" + (++uid);
    var opener = doc.activeElement;
    var backdrop = el("div", "aui-backdrop");
    var dlg = el("div", "aui-dialog" + (cfg.danger ? " aui-danger" : ""));
    dlg.setAttribute("role", cfg.cancelLabel === null ? "dialog" : "alertdialog");
    dlg.setAttribute("aria-modal", "true");
    dlg.setAttribute("tabindex", "-1");

    var title = el("h2", "aui-title", cfg.title);
    title.id = id + "t";
    dlg.setAttribute("aria-labelledby", title.id);
    dlg.appendChild(title);
    if (cfg.message) {
      var msg = el("p", "aui-message", cfg.message);
      msg.id = id + "m";
      dlg.setAttribute("aria-describedby", msg.id);
      dlg.appendChild(msg);
    }

    var input = null;
    var needText = cfg.requireText ? String(cfg.requireText) : "";
    if (needText || cfg.input) {
      var wrap = el("label", "aui-field");
      if (needText) {
        wrap.appendChild(doc.createTextNode("Type "));
        wrap.appendChild(el("strong", null, needText));
        wrap.appendChild(doc.createTextNode(" to confirm"));
      } else {
        wrap.appendChild(el("span", null, cfg.input.label || ""));
      }
      input = el("input", "aui-input");
      input.type = "text";
      input.autocomplete = "off";
      input.setAttribute("autocapitalize", "off");
      input.spellcheck = false;
      if (cfg.input) {
        if (cfg.input.value != null) input.value = cfg.input.value;
        if (cfg.input.placeholder) input.placeholder = cfg.input.placeholder;
      }
      wrap.appendChild(input);
      dlg.appendChild(wrap);
    }

    var actions = el("div", "aui-actions");
    var cancelBtn = null;
    if (cfg.cancelLabel !== null) {
      cancelBtn = el("button", "btn btn-outline aui-cancel", cfg.cancelLabel || "Cancel");
      cancelBtn.type = "button";
      actions.appendChild(cancelBtn);
    }
    var okBtn = el("button", "btn btn-primary aui-ok" + (cfg.danger ? " btn-delete-danger" : ""), cfg.confirmLabel || (cfg.danger ? "Delete" : "OK"));
    okBtn.type = "button";
    actions.appendChild(okBtn);
    dlg.appendChild(actions);

    function textOk() { return !needText || input.value.trim() === needText; }
    function sync() { okBtn.disabled = !textOk(); }
    if (needText) { input.addEventListener("input", sync); sync(); }

    var closed = false;
    function close(ok) {
      if (closed) return;
      closed = true;
      doc.removeEventListener("keydown", onKey, true);
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      unlockScroll();
      if (opener && opener.focus && doc.contains(opener)) {
        try { opener.focus(); } catch (e) { /* ignore */ }
      }
      done({ ok: ok, value: input ? input.value : "" });
    }
    function accept() {
      if (needText && !textOk()) return;
      close(true);
    }

    function onKey(e) {
      if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        close(false);
        return;
      }
      if (e.key === "Enter") {
        var tag = e.target && e.target.tagName;
        if (tag === "BUTTON" || tag === "A") return; /* native click handles it */
        e.preventDefault(); e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        accept();
        return;
      }
      if (e.key === "Tab") {
        var items = Array.prototype.filter.call(dlg.querySelectorAll(FOCUSABLE), function (n) { return !n.disabled; });
        if (!items.length) { e.preventDefault(); dlg.focus(); return; }
        var first = items[0], last = items[items.length - 1], active = doc.activeElement;
        if (!dlg.contains(active)) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && (active === first || active === dlg)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
      }
    }

    if (cancelBtn) cancelBtn.addEventListener("click", function () { close(false); });
    okBtn.addEventListener("click", accept);
    /* Backdrop click cancels. The press must also start on the backdrop, so
       dragging a text selection out of the input doesn't dismiss the dialog. */
    var downOnBackdrop = false;
    backdrop.addEventListener("mousedown", function (e) { downOnBackdrop = e.target === backdrop; });
    backdrop.addEventListener("touchstart", function (e) { downOnBackdrop = e.target === backdrop; }, { passive: true });
    backdrop.addEventListener("click", function (e) {
      if (e.target === backdrop && downOnBackdrop) close(false);
      downOnBackdrop = false;
    });

    backdrop.appendChild(dlg);
    (doc.body || doc.documentElement).appendChild(backdrop);
    lockScroll();
    doc.addEventListener("keydown", onKey, true);

    /* Safest default focus: the text field if there is one, else Cancel for
       destructive confirms (a stray Enter won't delete), else the OK button. */
    var target = input || (cfg.danger && cancelBtn) || okBtn;
    try { target.focus(); } catch (e) { /* ignore */ }
    if (input && input.select) input.select();
  }

  function adminConfirm(opts) {
    opts = opts || {};
    return openDialog({
      title: opts.title || (opts.danger ? "Are you sure?" : "Please confirm"),
      message: opts.message,
      confirmLabel: opts.confirmLabel,
      cancelLabel: opts.cancelLabel,
      danger: !!opts.danger,
      requireText: opts.requireText
    }).then(function (r) { return r.ok; });
  }

  adminConfirm.input = function (opts) {
    opts = opts || {};
    return openDialog({
      title: opts.title || "Enter a value",
      message: opts.message,
      confirmLabel: opts.confirmLabel || "OK",
      cancelLabel: opts.cancelLabel,
      input: { label: opts.label || "", value: opts.value, placeholder: opts.placeholder }
    }).then(function (r) { return r.ok ? r.value : null; });
  };

  function adminAlert(message, opts) {
    opts = opts || {};
    return openDialog({
      title: opts.title || "Heads up",
      message: message,
      confirmLabel: opts.confirmLabel || "OK",
      cancelLabel: null
    }).then(function () { /* resolves undefined */ });
  }

  window.adminToast = adminToast;
  window.adminConfirm = adminConfirm;
  window.adminAlert = adminAlert;
})();
