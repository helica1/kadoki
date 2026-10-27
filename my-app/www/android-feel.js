// Android feel for the web interface (styles in android-feel.css): Material 3
// on Android only. iOS, the Mac and Vision keep their own look.
(function () {
  'use strict';
  const android = (() => {
    try {
      if (window.KADOKI_MAC || window.KADOKI_VISION) return false;
      return window.Capacitor?.getPlatform?.() === 'android';
    } catch (_) { return false; }
  })();
  if (!android) return;
  document.documentElement.classList.add('kadoki-android');

  // WebView applies :active on touch only when a touch listener exists.
  document.addEventListener('touchstart', () => {}, { passive: true });

  // ── Material ripple ─────────────────────────────────────────────────────
  // A circle that grows from the touch point inside the pressed control and
  // fades out on release.
  const RIPPLE_SEL = 'button, .mode-tab, [role="button"], .lib-sheet-opt, .menu-item, .deck-item-content, .kai-ripple';
  function ripple(e) {
    const el = e.target && e.target.closest && e.target.closest(RIPPLE_SEL);
    if (!el || el.disabled || el.closest('#readingPagedView .reading-chunk, #dictPopup .dict-def')) return;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return;
    const cs = getComputedStyle(el);
    if (cs.position === 'static') el.style.position = 'relative';
    if (cs.overflow !== 'hidden') el.style.overflow = 'hidden';
    const size = Math.max(r.width, r.height) * 2.2;
    const dot = document.createElement('span');
    dot.className = 'k-ripple';
    dot.style.width = dot.style.height = size + 'px';
    dot.style.left = (e.clientX - r.left - size / 2) + 'px';
    dot.style.top = (e.clientY - r.top - size / 2) + 'px';
    el.appendChild(dot);
    const done = () => {
      dot.classList.add('out');
      setTimeout(() => dot.remove(), 380);
      el.removeEventListener('pointerup', done);
      el.removeEventListener('pointercancel', done);
      el.removeEventListener('pointerleave', done);
    };
    el.addEventListener('pointerup', done);
    el.addEventListener('pointercancel', done);
    el.addEventListener('pointerleave', done);
  }
  document.addEventListener('pointerdown', ripple, { passive: true, capture: true });

  // A light tick where Android gives one: switches, the mode tabs.
  const tick = () => { try { window.kHaptic?.('LIGHT'); } catch (_) {} };
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t && (t.type === 'checkbox' || t.type === 'radio')) tick();
  }, true);
  document.addEventListener('click', (e) => {
    const tab = e.target && e.target.closest && e.target.closest('#shellModeTabs .mode-tab');
    if (tab && tab.dataset.active !== '1') tick();
  }, true);

  // ── Snackbar toasts ─────────────────────────────────────────────────────
  // showToast is defined after this file runs: tag each toast so the CSS can
  // draw it as a Material snackbar at the bottom.
  const wrapToast = () => {
    const orig = window.showToast;
    if (typeof orig !== 'function' || orig._kMat) return;
    const mat = function () {
      const r = orig.apply(this, arguments);
      try { document.getElementById('toast')?.classList.add('k-snackbar'); } catch (_) {}
      return r;
    };
    mat._kMat = true;
    window.showToast = mat;
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wrapToast);
  else wrapToast();
  setTimeout(wrapToast, 1500);

  // Choosers (libSheet: Move, tab chooser, Print / Sync choices) as native
  // Material bottom sheets (KadokiChromePlugin.showSheet). The web sheet is
  // still built, kept out of sight, and a pick clicks its button, so every
  // chooser's own logic runs unchanged. A sheet holding anything but plain
  // choices (a name field) stays the web sheet (styled in android-feel.css).
  const chrome = () => window.Capacitor?.Plugins?.KadokiChrome;
  const wrapSheets = () => {
    const orig = window.libSheet;
    if (typeof orig !== 'function' || orig._kMat || !chrome()) return;
    const mat = function (heading) {
      const sh = orig.apply(this, arguments);
      sh.ov.style.display = 'none';
      const finish = sh.finish;
      sh.finish = function () {
        finish.apply(this, arguments);
        const kids = [...sh.box.children].filter(el => !el.classList.contains('lib-sheet-h') && !el.classList.contains('lib-sheet-cancel'));
        const plain = kids.length && kids.every(el => el.classList.contains('lib-sheet-opt') && !el.disabled);
        if (!plain) { sh.ov.style.display = ''; return; }
        chrome().showSheet({
          title: heading || '',
          options: kids.map(el => ({
            label: (el.querySelector('span')?.textContent || el.textContent || '').trim(),
            sub: (el.querySelector('b')?.textContent || '').trim(),
            destructive: el.classList.contains('danger'),
          })),
        }).then((r) => {
          const i = r && Number.isFinite(r.index) ? r.index : -1;
          if (i >= 0 && kids[i]) { try { kids[i].click(); } catch (_) {} }
          setTimeout(() => { try { sh.ov.remove(); } catch (_) {} }, 0);
        }).catch(() => { sh.ov.style.display = ''; });
      };
      return sh;
    };
    mat._kMat = true;
    window.libSheet = mat;
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wrapSheets);
  else wrapSheets();
  setTimeout(wrapSheets, 1500);

  // The Send to Anki dialog: Material dialog styling (android-feel.css).
  // (It is appended straight to <body>; only body's own children are watched.)
  const watchBody = () => new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes) {
      if (n && n.id === 'waveformEditorOverlay') n.classList.add('kmat');
    }
  }).observe(document.body, { childList: true });
  if (document.body) watchBody(); else document.addEventListener('DOMContentLoaded', watchBody);
})();
