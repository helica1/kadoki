// iPhone Duo: unfolding while LISTENING opens the reading book.
//
// One title can be flagged as the reading book (title.readingBook, a
// timestamp; Library → expanded row, shown on the Duo only). When the phone
// unfolds while AUDIO mode is showing an audio title, the app switches to the
// reading book in READ mode at its saved place (the reader's normal entry
// paints the current line), with the outgoing title's audio stopped.
// Listening to the reading book itself just switches it to READ mode, so the
// read-along carries on. Card mode, Anki deck titles and video titles never
// switch — they only expand — and nothing happens without a reading book.
(function () {
  'use strict';

  let lastStatus = null;
  let busy = false;
  let lastFireAt = 0;

  async function readingTitle() {
    const list = (await window.titleStore?.list?.()) || [];
    return list.find(t => t.readingBook && t.attachments?.epub) || null;
  }

  async function onUnfold() {
    const now = Date.now();
    // The hinge event and the width change both report one unfold.
    if (busy || now - lastFireAt < 3000) return;
    lastFireAt = now;
    if (!window.KADOKI_DUO || window._titleSwitchInFlight) return;
    if (!document.body.classList.contains('mode-audio')) return;
    const kind = window._activeTitleKind;
    if (kind === 'deck' || kind === 'video') return;
    try { if (window.kadokiVideoMode?.isVideoTitle?.()) return; } catch (_) {}
    busy = true;
    try {
      const rt = await readingTitle();
      if (!rt) return;
      if (rt.id === window._activeTitleId) {
        window.setShellMode?.('read');
        return;
      }
      // The open honours the stored lastMode; store READ first so the open
      // lands there even when rehydration hands back a fresh record.
      try { await window.titleStore.setMode?.(rt.id, 'read'); } catch (_) {}
      const fresh = (await window.titleStore.get?.(rt.id)) || rt;
      await window.loadTitleFromLibrary?.(Object.assign({}, fresh, { lastMode: 'read' }));
    } catch (e) {
      try { window.debugLog?.('[duo-reading] switch failed: ' + (e?.message || e)); } catch (_) {}
    } finally {
      busy = false;
    }
  }

  // Native hinge status: 1 closed, 2 partly open, 3 fully open (relayed by
  // reading-mode-paged.js's __kadokiHinge). The first report has no previous
  // state, so app launch on an open phone never switches.
  window.addEventListener('kadoki:hinge', (e) => {
    const s = e.detail?.status;
    const prev = lastStatus;
    lastStatus = s;
    if (prev === 1 && (s === 2 || s === 3)) onUnfold();
  });
  // Backup: the inner screen is ≥800pt wide (same breakpoint as the Duo
  // layout); catches an unfold whose hinge change arrived while suspended.
  try {
    const mq = window.matchMedia('(min-width: 800px)');
    mq.addEventListener('change', (e) => { if (e.matches && window.KADOKI_DUO) onUnfold(); });
  } catch (_) {}

  async function setReadingBook(id, on) {
    const ts = window.titleStore;
    if (!ts) return;
    if (on) {
      const others = ((await ts.list()) || []).filter(t => t.readingBook && t.id !== id).map(t => t.id);
      if (others.length) await ts.updateMany(others, { readingBook: null });
    }
    await ts.update(id, { readingBook: on ? Date.now() : null });
  }

  window.duoReading = { setReadingBook, readingTitle };
})();
