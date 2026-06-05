// bookmarks.js — "Bookmarks": the last 3 spots (Card OR Read) where the user
// read for >= 1 minute. Accessed from the hamburger menu; lets the user jump
// back to where they were after the shared playhead runs ahead. Replaces the
// audio-reentry dialog as the divergence-recovery path.
//
// Bookmark = { mode:'card'|'read', ts, titleId, titleName, location }
//   read location = { chunkIdx, jpOff, bookName }   (jpOff = JP char-offset)
//   card location = { cardIndex }
// Stored as a GLOBAL rolling array (newest first, max 3) under BOOKMARKS_V1 in
// localStorage (sync read for the menu), mirrored to Capacitor Preferences
// (durable across an OS kill).

(function () {
  'use strict';
  const KEY = 'BOOKMARKS_V1';
  const MAX = 3;
  const SAME_SPOT_CHARS = 400;   // two read spots within ~a page count as "same"
  const MIN_GAP_MS = 55000;      // keep bookmarks ~1 minute apart (prevent crowding)
  const PREF = window.Capacitor?.Plugins?.Preferences;

  function loadSync() {
    try {
      const raw = localStorage.getItem(KEY);
      const a = raw ? JSON.parse(raw) : [];
      return Array.isArray(a) ? a : [];
    } catch (_) { return []; }
  }
  function persist(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (_) {}
    try { PREF?.set?.({ key: KEY, value: JSON.stringify(list) }); } catch (_) {}
  }

  // Same spot = same mode+title AND (same card | within ~a page of read text).
  // Far-apart spots in one title are kept; a fresh minute on the same line is not.
  function sameSpot(a, b) {
    if (!a || !b || a.mode !== b.mode || a.titleId !== b.titleId) return false;
    if (a.mode === 'card') return (a.location && a.location.cardIndex) === (b.location && b.location.cardIndex);
    const da = a.location && a.location.jpOff, db = b.location && b.location.jpOff;
    if (!Number.isFinite(da) || !Number.isFinite(db)) return false;
    return Math.abs(da - db) < SAME_SPOT_CHARS;
  }

  function record(bm) {
    if (!bm || (bm.mode !== 'card' && bm.mode !== 'read')) return;
    const list = loadSync().filter(x => !sameSpot(x, bm));
    list.unshift(bm);
    persist(list.slice(0, MAX));
  }
  function list() { return loadSync(); }

  // Called on a switch INTO audio from card/read — saves the spot the user was
  // reading just before they started listening, silently.
  function capture(mode) {
    try {
      if (mode !== 'card' && mode !== 'read') return;   // audio is excluded
      const titleId = window._activeTitleId || null;
      if (!titleId) return;
      // Throttle: keep the list uncrowded — bookmarks stay ~1 minute apart.
      const recent = loadSync()[0];
      if (recent && (Date.now() - recent.ts) < MIN_GAP_MS) return;
      let location = null;
      if (mode === 'read') {
        location = (typeof window.pagedGetReadLocation === 'function') ? window.pagedGetReadLocation() : null;
      } else {
        const ci = window.currentCardIndex;
        if (Number.isFinite(ci)) location = { cardIndex: ci };
      }
      if (!location) return;            // never record a garbage / not-ready spot
      record({ mode, ts: Date.now(), titleId, titleName: '', location });
    } catch (_) {}
  }

  // Jump to a bookmark: (read) seed the per-book anchor, open its title if it
  // isn't the active one, switch mode, then land the location.
  async function jumpTo(bm) {
    if (!bm) return;
    try {
      const sameTitle = !!bm.titleId && bm.titleId === window._activeTitleId;
      // Seed FIRST so a cross-title open lands at the bookmark, not the book's
      // own last position.
      if (bm.mode === 'read' && typeof window.pagedSeedBookmark === 'function') {
        try { await window.pagedSeedBookmark(bm.location); } catch (_) {}
      }
      if (!sameTitle && bm.titleId && window.titleStore && window.titleStore.get &&
          typeof window.loadTitleFromLibrary === 'function') {
        const title = await window.titleStore.get(bm.titleId);
        if (title) await window.loadTitleFromLibrary(title);
      }
      if (typeof window.setShellMode === 'function') {
        await window.setShellMode(bm.mode, { force: true, titleOpen: !sameTitle });
      }
      if (bm.mode === 'read') {
        if (typeof window.pagedJumpToBookmark === 'function') await window.pagedJumpToBookmark(bm.location);
      } else {
        const ci = bm.location && bm.location.cardIndex;
        if (Number.isFinite(ci)) {
          if (sameTitle && typeof window.updateCardIndex === 'function') window.updateCardIndex(ci);
          else { window.pendingCardIndex = ci; if (typeof window.displayCard === 'function') window.displayCard(); }
        }
      }
    } catch (e) { console.warn('[bookmarks] jumpTo failed', e); }
  }

  // ---- menu UI: a centered list of the last 3 bookmarks ----
  function rowHtml(bm, nameById) {
    const when = (() => { try { return new Date(bm.ts).toLocaleString(); } catch (_) { return ''; } })();
    const where = bm.mode === 'read'
      ? ((Number(bm.location && bm.location.jpOff) || 0).toLocaleString() + ' chars')
      : ('Card ' + ((Number(bm.location && bm.location.cardIndex) || 0) + 1));
    const modeLabel = bm.mode === 'read' ? 'Read' : 'Card';
    const tName = (nameById && nameById.get(bm.titleId)) || bm.titleName || '';
    const sub = (tName ? (tName + ' · ') : '') + when;
    return `<div style="font-size:.9rem;color:#eee;">${modeLabel} · ${where}</div>` +
           `<div style="color:#888;font-size:.72rem;margin-top:2px;">${sub}</div>`;
  }

  async function openMenu() {
    const prev = document.getElementById('bookmarksOverlay');
    if (prev) prev.remove();
    const items = list();
    // Resolve title names for nicer rows (best-effort; menu still works without).
    let nameById = new Map();
    try {
      if (window.titleStore && window.titleStore.list) {
        const titles = await window.titleStore.list();
        for (const t of (titles || [])) nameById.set(t.id, t.name);
      }
    } catch (_) {}

    const overlay = document.createElement('div');
    overlay.id = 'bookmarksOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:100000;display:flex;align-items:center;justify-content:center;';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const card = document.createElement('div');
    card.style.cssText = 'background:#161616;border:1px solid #2a2a2a;border-radius:12px;min-width:min(86vw,380px);max-width:86vw;max-height:70vh;overflow:auto;padding:14px;';
    const head = document.createElement('div');
    head.style.cssText = 'font-weight:600;font-size:1rem;color:#eee;margin-bottom:10px;';
    head.textContent = 'Bookmarks';
    card.appendChild(head);

    if (!items.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:#888;font-size:.85rem;padding:6px 2px;';
      empty.textContent = 'No bookmarks yet. Read for a minute in Card or Read mode and the spot is saved here automatically.';
      card.appendChild(empty);
    } else {
      items.forEach((bm) => {
        const b = document.createElement('button');
        b.className = 'menu-item';
        b.style.cssText = 'display:block;width:100%;text-align:left;background:#1e1e1e;border:1px solid #2a2a2a;border-radius:8px;padding:10px 12px;margin-bottom:8px;cursor:pointer;';
        b.innerHTML = rowHtml(bm, nameById);
        b.addEventListener('click', () => { overlay.remove(); jumpTo(bm); });
        card.appendChild(b);
      });
    }
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  window.bookmarks = { record, list, capture, jumpTo, openMenu };
})();
