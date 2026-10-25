// iOS feel for the web interface (styles in ios-feel.css): iPhone / iPad only.
// Vision Pro and the Mac keep their own look.
(function () {
  'use strict';
  const ios = (() => {
    try {
      if (window.KADOKI_MAC) return false;
      if (window.Capacitor?.getPlatform?.() !== 'ios') return false;
      if (/xros|visionos/i.test(navigator.userAgent) || document.body?.classList.contains('kadoki-vision-native')) return false;
      return true;
    } catch (_) { return false; }
  })();
  if (!ios) return;
  document.documentElement.classList.add('kadoki-ios');

  // WebKit applies :active on touch only when a touch listener exists.
  document.addEventListener('touchstart', () => {}, { passive: true });

  // A light tick where iOS gives one: switches, pickers, the mode tabs.
  const tick = () => { try { window.kHaptic?.('LIGHT'); } catch (_) {} };
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t && (t.type === 'checkbox' || t.type === 'radio' || t.tagName === 'SELECT')) tick();
  }, true);
  document.addEventListener('click', (e) => {
    const tab = e.target && e.target.closest && e.target.closest('#shellModeTabs .mode-tab');
    if (tab && tab.dataset.active !== '1') tick();
  }, true);

  // Choosers (libSheet: Move, tab chooser, Print / Sync choices) as real iOS
  // action sheets (KadokiActionSheet). The web sheet is still built, kept out
  // of sight, and a pick clicks its button, so every chooser's own logic runs
  // unchanged. A sheet holding anything but plain choices (a name field) stays
  // the web sheet (styled in ios-feel.css).
  if (!window.KADOKI_NATIVE_SHEETS) return;
  const pending = new Map();
  let seq = 0;
  window.__kadokiSheetDone = (id, index) => {
    const p = pending.get(id);
    pending.delete(id);
    if (!p) return;
    if (index >= 0 && p.opts[index]) { try { p.opts[index].click(); } catch (_) {} }
    // A pick usually closes the sheet itself; Cancel (or a pick that keeps
    // it open, like the tab chooser) closes it here.
    setTimeout(() => { try { p.ov.remove(); } catch (_) {} }, 0);
  };
  const wrapSheets = () => {
    const orig = window.libSheet;
    if (typeof orig !== 'function' || orig._kNative) return;
    const native = function (heading) {
      const sh = orig.apply(this, arguments);
      sh.ov.style.display = 'none';
      const finish = sh.finish;
      sh.finish = function () {
        finish.apply(this, arguments);
        const kids = [...sh.box.children].filter(el => !el.classList.contains('lib-sheet-h') && !el.classList.contains('lib-sheet-cancel'));
        const plain = kids.length && kids.every(el => el.classList.contains('lib-sheet-opt') && !el.disabled);
        if (!plain) { sh.ov.style.display = ''; return; }
        const id = ++seq;
        pending.set(id, { ov: sh.ov, opts: kids });
        try {
          window.webkit.messageHandlers.kadokiActionSheet.postMessage({
            id,
            title: heading || '',
            options: kids.map(el => ({
              label: (el.querySelector('span')?.textContent || el.textContent || '').trim(),
              sub: (el.querySelector('b')?.textContent || '').trim(),
              destructive: el.classList.contains('danger'),
            })),
            cancel: (sh.box.querySelector('.lib-sheet-cancel')?.textContent || '').trim() || undefined,
          });
        } catch (_) { pending.delete(id); sh.ov.style.display = ''; }
      };
      return sh;
    };
    native._kNative = true;
    window.libSheet = native;
  };
  // Toasts as a native capsule at the top (KadokiToast), above the native
  // Preferences / Library too, where web toasts were hidden.
  const wrapToast = () => {
    const orig = window.showToast;
    if (typeof orig !== 'function' || orig._kNative) return;
    const native = function (message, duration) {
      try {
        window.webkit.messageHandlers.kadokiToast.postMessage({ text: String(message == null ? '' : message), ms: Number(duration) || 3000 });
        return;
      } catch (_) {}
      return orig.apply(this, arguments);
    };
    native._kNative = true;
    window.showToast = native;
  };
  // libSheet / showToast are defined after this file runs.
  const wrapAll = () => { wrapSheets(); wrapToast(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wrapAll);
  else wrapAll();
})();
