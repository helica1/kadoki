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
  const MAX = 5;
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
    // Bookmarks are PER TITLE: keep the last MAX for EACH title (newest first),
    // so adding one to title B never evicts (and the menu never leaks) title A's.
    const perTitle = {};
    const kept = [];
    for (const b of list) {
      const t = b.titleId || '';
      perTitle[t] = (perTitle[t] || 0) + 1;
      if (perTitle[t] <= MAX) kept.push(b);
    }
    persist(kept);
  }
  function list() { return loadSync(); }

  // ---- "Furthest position listened" — a per-title audio high-water mark ----
  // Separate from the dwell bookmarks above: it's audio-domain, one per title,
  // and only ever ADVANCES. The audio position listener feeds it continuously;
  // it's surfaced (pinned, for the active title) in the Bookmarks menu so the
  // user can recover their place if it's ever lost. Map: { [titleId]: {ms, ts} }.
  const FURTHEST_KEY = 'AUDIO_FURTHEST_V1';
  const FURTHEST_SAVE_GAP_MS = 20000;   // throttle the durable (Capacitor) write
  let _furthestMap = null;              // in-memory cache (authoritative this session)
  let _furthestLastSaveAt = 0;

  function loadFurthestSync() {
    if (_furthestMap) return _furthestMap;
    try {
      const raw = localStorage.getItem(FURTHEST_KEY);
      const m = raw ? JSON.parse(raw) : {};
      _furthestMap = (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
    } catch (_) { _furthestMap = {}; }
    return _furthestMap;
  }

  // High-water update. Called every audio position tick; cheap when not
  // advancing. Persist is throttled (in-memory stays current for the menu).
  function updateFurthest(titleId, ms) {
    if (!titleId || !Number.isFinite(ms) || ms <= 0) return;
    const map = loadFurthestSync();
    const cur = map[titleId];
    if (cur && Number.isFinite(cur.ms) && ms <= cur.ms) return;   // never regress
    map[titleId] = { ms: Math.floor(ms), ts: Date.now() };
    const now = Date.now();
    if (now - _furthestLastSaveAt > FURTHEST_SAVE_GAP_MS) {
      _furthestLastSaveAt = now;
      const s = JSON.stringify(map);
      try { localStorage.setItem(FURTHEST_KEY, s); } catch (_) {}
      try { PREF?.set?.({ key: FURTHEST_KEY, value: s }); } catch (_) {}
    }
  }

  function getFurthest(titleId) {
    if (!titleId) return null;
    const m = loadFurthestSync()[titleId];
    return (m && Number.isFinite(m.ms) && m.ms > 0) ? m : null;
  }

  function fmtMs(ms) {
    const t = Math.max(0, Math.floor((ms || 0) / 1000));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  // Jump audio to the furthest-listened position for the active title. Routes
  // through openAudiobookMode via a one-shot start target (NOT the bottom-bar
  // seek, which is intentionally disabled to avoid losing your spot).
  async function jumpToFurthest(ms) {
    if (!Number.isFinite(ms)) return;
    try {
      // One-shot, freshness-stamped: openAudiobookMode honors it only if recent,
      // so a refused/early-returned switch can't seek to a stale spot later.
      window._pendingAudioStartMs = ms;
      window._pendingAudioStartAt = Date.now();
      const inAudio = document.body.classList.contains('mode-audio');
      if (inAudio && typeof window.openAudiobookMode === 'function') {
        // Already in audio mode → setShellMode('audio') is a no-op, so re-open
        // directly; openAudiobookMode honors the pending start target.
        await window.openAudiobookMode({});
      } else if (typeof window.setShellMode === 'function') {
        await window.setShellMode('audio', { force: true });
      }
    } catch (e) {
      window._pendingAudioStartMs = null;
      window._pendingAudioStartAt = null;
      console.warn('[bookmarks] jumpToFurthest failed', e);
    }
  }

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
      let location = null, audioMs;
      if (mode === 'read') {
        location = (typeof window.pagedGetReadLocation === 'function') ? window.pagedGetReadLocation() : null;
        // Audio time of the read cursor's cue → a comparable "% of book".
        if (typeof window._pagedReadCueStartMs === 'function') audioMs = window._pagedReadCueStartMs();
      } else {
        const ci = window.currentCardIndex;
        if (Number.isFinite(ci)) {
          location = { cardIndex: ci };
          const n = window.allNotes;
          if (Array.isArray(n) && n[ci]) audioMs = n[ci].audiobookStartMs;
        }
      }
      if (!location) return;            // never record a garbage / not-ready spot
      const bm = { mode, ts: Date.now(), titleId, titleName: '', location };
      if (Number.isFinite(audioMs)) bm.audioMs = audioMs;
      record(bm);
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
  // Unified "% of book" so card / read / furthest spots are directly comparable.
  // Every position maps to an audio time; pct = time / total audiobook duration.
  function totalDurationMs() {
    try {
      const n = window.allNotes;
      const last = Array.isArray(n) && n.length ? n[n.length - 1] : null;
      if (last && last.isSrtCard) return last.audiobookEndMs || 0;
    } catch (_) {}
    return 0;
  }
  function pctOf(ms) {
    const d = totalDurationMs();
    if (!d || !Number.isFinite(ms) || ms < 0) return null;
    return Math.max(0, Math.min(100, Math.round((ms / d) * 100)));
  }
  function bmAudioMs(bm) {
    if (bm && Number.isFinite(bm.audioMs)) return bm.audioMs;
    // Fallback for card bookmarks saved before audioMs was stored.
    if (bm && bm.mode === 'card' && bm.location && Number.isFinite(bm.location.cardIndex)) {
      const n = window.allNotes;
      if (Array.isArray(n) && n[bm.location.cardIndex]) return n[bm.location.cardIndex].audiobookStartMs;
    }
    return null;
  }
  function pctTag(ms) {
    const p = pctOf(ms);
    return (p != null) ? `<span style="color:#bd9;font-weight:700;">${p}%</span> · ` : '';
  }

  function rowHtml(bm, nameById) {
    const when = (() => { try { return new Date(bm.ts).toLocaleString(); } catch (_) { return ''; } })();
    const where = bm.mode === 'read'
      ? ((Number(bm.location && bm.location.jpOff) || 0).toLocaleString() + ' chars')
      : ('Card ' + ((Number(bm.location && bm.location.cardIndex) || 0) + 1));
    const modeLabel = bm.mode === 'read' ? 'Read' : 'Card';
    const tName = (nameById && nameById.get(bm.titleId)) || bm.titleName || '';
    const sub = (tName ? (tName + ' · ') : '') + when;
    return `<div style="font-size:.9rem;color:#eee;">${pctTag(bmAudioMs(bm))}${modeLabel} · ${where}</div>` +
           `<div style="color:#888;font-size:.72rem;margin-top:2px;">${sub}</div>`;
  }

  async function openMenu() {
    const prev = document.getElementById('bookmarksOverlay');
    if (prev) prev.remove();
    const activeTitleId = window._activeTitleId || null;
    // Per title: only show bookmarks belonging to the title you're currently in.
    const items = list().filter(b => activeTitleId && b.titleId === activeTitleId);
    const furthest = activeTitleId ? getFurthest(activeTitleId) : null;
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

    // Pinned at top: the furthest audio position for the title you're in — a
    // recovery anchor if you ever lose your spot.
    if (furthest) {
      const fName = (nameById && nameById.get(activeTitleId)) || '';
      const fb = document.createElement('button');
      fb.className = 'menu-item';
      fb.style.cssText = 'display:block;width:100%;text-align:left;background:#15201b;border:1px solid #2e5a3f;border-radius:8px;padding:10px 12px;margin-bottom:8px;cursor:pointer;';
      fb.innerHTML =
        `<div style="font-size:.9rem;color:#bff0cf;">↻ Furthest listened · ${pctTag(furthest.ms)}${fmtMs(furthest.ms)}</div>` +
        `<div style="color:#7fae8e;font-size:.72rem;margin-top:2px;">${fName ? (fName + ' · ') : ''}tap to resume here</div>`;
      fb.addEventListener('click', () => { overlay.remove(); jumpToFurthest(furthest.ms); });
      card.appendChild(fb);
    }

    if (!items.length && !furthest) {
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

  window.bookmarks = { record, list, capture, jumpTo, openMenu, updateFurthest, getFurthest, jumpToFurthest };
})();
