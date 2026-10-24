// iPhone Duo: unfolding while LISTENING opens the reading book.
//
// One title can be flagged as the reading book (title.readingBook, a
// timestamp; Library → expanded row, shown on the Duo only). When the phone
// starts to open while AUDIO mode is showing an audio title, the outgoing
// title's audio stops at once and the app switches to the reading book in
// READ mode at its saved place (the reader's normal entry paints the current
// line), so the book is up by the time the phone is open.
// Listening to the reading book itself just switches it to READ mode, so the
// read-along carries on. Card mode, Anki deck titles and video titles never
// switch — they only expand — and nothing happens without a reading book.
(function () {
  'use strict';

  let lastStatus = null;
  let armed = false;        // saw the phone closed; the next opening movement fires
  let busy = false;
  let lastFireAt = 0;
  let cached = null;        // reading-book record, kept ready while closed

  async function readingTitle() {
    const list = (await window.titleStore?.list?.()) || [];
    return list.find(t => t.readingBook && t.attachments?.epub) || null;
  }
  function refreshCache() {
    readingTitle().then(t => { cached = t; }).catch(() => {});
  }

  // Would an unfold right now switch titles? Checked synchronously so the
  // audio can stop in the same tick as the first hinge movement.
  function switchApplies() {
    if (!window.KADOKI_DUO || window._titleSwitchInFlight) return false;
    if (!document.body.classList.contains('mode-audio')) return false;
    const kind = window._activeTitleKind;
    if (kind === 'deck' || kind === 'video') return false;
    try { if (window.kadokiVideoMode?.isVideoTitle?.()) return false; } catch (_) {}
    return true;
  }

  async function onUnfold() {
    const now = Date.now();
    // The hinge event and the width change both report one unfold.
    if (busy || now - lastFireAt < 3000) return;
    if (!switchApplies()) return;
    lastFireAt = now;
    busy = true;
    try {
      let rt = cached;
      const other = rt && rt.id !== window._activeTitleId;
      // Stop the outgoing title's audio first, before any await, so it is
      // silent by the time the phone is open.
      if (other) {
        try { window.Capacitor?.Plugins?.BackgroundAudio?.pause?.({ fadeMs: 60 }); } catch (_) {}
      }
      if (!rt) rt = await readingTitle();
      if (!rt) return;
      if (rt.id === window._activeTitleId) {
        window.setShellMode?.('read');
        return;
      }
      if (!other) { try { window.Capacitor?.Plugins?.BackgroundAudio?.pause?.({ fadeMs: 60 }); } catch (_) {} }
      // The open honours the stored lastMode; store READ first so the open
      // lands there even when rehydration hands back a fresh record.
      const fresh = await Promise.all([
        window.titleStore.setMode?.(rt.id, 'read')?.catch?.(() => {}),
        window.titleStore.get?.(rt.id),
      ]).then(r => r[1]).catch(() => null);
      await window.loadTitleFromLibrary?.(Object.assign({}, fresh || rt, { lastMode: 'read' }));
    } catch (e) {
      try { window.debugLog?.('[duo-reading] switch failed: ' + (e?.message || e)); } catch (_) {}
    } finally {
      busy = false;
      refreshCache();
    }
  }

  // Native hinge status: 1 closed, 2 partly open, 3 fully open, with the angle
  // in radians (relayed by reading-mode-paged.js's __kadokiHinge). Angle
  // updates stream while the hinge moves, so the first few degrees of opening
  // fire the switch, before the hinge even reports partly open. The first
  // report has no previous state, so app launch on an open phone never
  // switches.
  const OPEN_ANGLE = 0.14;   // ~8°
  window.addEventListener('kadoki:hinge', (e) => {
    const s = e.detail?.status;
    const angle = +e.detail?.angle || 0;
    if (s !== lastStatus && s === 1) refreshCache();
    lastStatus = s;
    if (s === 1 && angle < OPEN_ANGLE) { armed = true; return; }
    if (armed && (s === 2 || s === 3 || (s === 1 && angle >= OPEN_ANGLE))) {
      armed = false;
      onUnfold();
    }
  });
  // Backup: the inner screen is ≥800pt wide (same breakpoint as the Duo
  // layout); catches an unfold whose hinge change arrived while suspended.
  try {
    const mq = window.matchMedia('(min-width: 800px)');
    mq.addEventListener('change', (e) => { if (e.matches && window.KADOKI_DUO) onUnfold(); });
  } catch (_) {}
  // Keep the record current (it is also refreshed on every close).
  window.addEventListener('shell:mode-change', () => { if (window.KADOKI_DUO) refreshCache(); });
  setTimeout(refreshCache, 3000);

  async function setReadingBook(id, on) {
    const ts = window.titleStore;
    if (!ts) return;
    if (on) {
      const others = ((await ts.list()) || []).filter(t => t.readingBook && t.id !== id).map(t => t.id);
      if (others.length) await ts.updateMany(others, { readingBook: null });
    }
    await ts.update(id, { readingBook: on ? Date.now() : null });
    refreshCache();
  }

  window.duoReading = { setReadingBook, readingTitle };
})();
