// bookmarks.js — "Bookmarks": the last 3 spots (Card OR Read) where the user
// read for >= 1 minute. Accessed from the hamburger menu; lets the user jump
// back to where they were after the shared playhead runs ahead. Replaces the
// audio-reentry dialog as the divergence-recovery path.
//
// Bookmark = { mode:'card'|'read'|'audio', ts, titleId, titleName, location }
//   read location  = { chunkIdx, jpOff, bookName }   (jpOff = JP char-offset)
//   card location  = { cardIndex }
//   audio location = { audioMs }                     (used by the History view)
// Stored as a GLOBAL rolling array (newest first, max 3) under BOOKMARKS_V1 in
// localStorage (sync read for the menu), mirrored to Capacitor Preferences
// (durable across an OS kill).

(function () {
  'use strict';
  const KEY = 'BOOKMARKS_V1';
  const MAX = 5;
  const SAME_SPOT_CHARS = 400;   // two read spots within ~a page count as "same"
  const SAME_SPOT_MS = 60000;    // two audio spots within ~1 min count as "same"
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
    if (a.mode === 'audio') {
      const aa = a.location && a.location.audioMs, ba = b.location && b.location.audioMs;
      return Number.isFinite(aa) && Number.isFinite(ba) && Math.abs(aa - ba) < SAME_SPOT_MS;
    }
    const da = a.location && a.location.jpOff, db = b.location && b.location.jpOff;
    if (!Number.isFinite(da) || !Number.isFinite(db)) return false;
    return Math.abs(da - db) < SAME_SPOT_CHARS;
  }

  function record(bm) {
    if (!bm || !['card', 'read', 'audio'].includes(bm.mode)) return;
    try { window.eventLog?.noteBookmark(bm); } catch (_) {}
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

  // The current shell mode from the body classes (the surface the user is on).
  function currentMode() {
    try {
      const c = document.body.classList;
      if (c.contains('mode-audio')) return 'audio';
      if (c.contains('mode-read')) return 'read';
      if (c.contains('mode-card')) return 'card';
    } catch (_) {}
    return null;
  }

  // Build a History location for any mode from the live position.
  function buildLocation(mode) {
    if (mode === 'read') {
      let loc = (typeof window.pagedGetReadLocation === 'function') ? window.pagedGetReadLocation() : null;
      // Silent (no-audio) epubs: pagedGetReadLocation is null → use the live chunk.
      if (!loc && typeof window.pagedGetReadChunkLive === 'function') {
        const lc = window.pagedGetReadChunkLive();
        if (lc && Number.isFinite(lc.chunkIdx) && lc.chunkIdx >= 0) loc = { chunkIdx: lc.chunkIdx, jpOff: lc.jpOff || 0, bookName: lc.bookName };
      }
      return loc;
    }
    if (mode === 'card') {
      const ci = window.currentCardIndex;
      return (Number.isFinite(ci) && ci >= 0) ? { cardIndex: ci } : null;   // never record a -1 / pre-load index
    }
    if (mode === 'audio') {
      let ms = null;
      try { if (typeof window.getAudioProgress === 'function') { const ap = window.getAudioProgress(); if (ap && Number.isFinite(ap.ms)) ms = Math.round(ap.ms); } } catch (_) {}
      return (Number.isFinite(ms) && ms > 0) ? { audioMs: ms } : null;
    }
    return null;
  }

  // Record the CURRENT session (any mode, incl. audio) into History — the spot
  // the user is on right now. Used when leaving a mode/title and before a
  // timeline jump so the place is always recoverable. opts.force bypasses the
  // ~1-min throttle (for deliberate saves like a pre-jump capture).
  function captureCurrent(opts) {
    try {
      const mode = (opts && opts.mode) || currentMode();
      if (!mode) return;
      const titleId = window._activeTitleId || null;
      if (!titleId) return;
      if (!(opts && opts.force)) {
        const recent = loadSync()[0];
        if (recent && (Date.now() - recent.ts) < MIN_GAP_MS) return;   // keep uncrowded
      }
      const location = buildLocation(mode);
      if (!location) return;
      const bm = { mode, ts: Date.now(), titleId, titleName: '', location };
      // Attach an audio time so card/read/audio spots share a comparable "% of book".
      if (mode === 'audio') bm.audioMs = location.audioMs;
      else if (mode === 'read' && typeof window._pagedReadCueStartMs === 'function') { const am = window._pagedReadCueStartMs(); if (Number.isFinite(am)) bm.audioMs = am; }
      else if (mode === 'card') { const n = window.allNotes; const ci = location.cardIndex; if (Array.isArray(n) && n[ci] && Number.isFinite(n[ci].audiobookStartMs)) bm.audioMs = n[ci].audiobookStartMs; }
      // Stamp a book-progress % NOW, while this title is active so totalDurationMs()
      // is correct — History is cross-title, so pctOf() can't be trusted at show time.
      try { const _p = pctOf(bm.audioMs); if (_p != null) bm.pct = _p; } catch (_) {}
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
      // Audio: arm the one-shot start target BEFORE switching (openAudiobookMode
      // honors it on entry), then enter audio — same path as jumpToFurthest.
      if (bm.mode === 'audio') {
        const ms = bm.location && bm.location.audioMs;
        if (Number.isFinite(ms)) { window._pendingAudioStartMs = ms; window._pendingAudioStartAt = Date.now(); }
        const inAudio = document.body.classList.contains('mode-audio');
        if (sameTitle && inAudio && typeof window.openAudiobookMode === 'function') await window.openAudiobookMode({});
        else if (typeof window.setShellMode === 'function') await window.setShellMode('audio', { force: true, titleOpen: !sameTitle });
        return;
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

  function whereText(bm) {
    if (bm.mode === 'read') return (Number(bm.location && bm.location.jpOff) || 0).toLocaleString() + ' chars';
    if (bm.mode === 'audio') return fmtMs(bm.location && bm.location.audioMs);
    return 'Card ' + ((Number(bm.location && bm.location.cardIndex) || 0) + 1);
  }
  function rowHtml(bm, nameById) {
    const when = (() => { try { return new Date(bm.ts).toLocaleString(); } catch (_) { return ''; } })();
    const where = whereText(bm);
    const modeLabel = bm.mode === 'read' ? 'Read' : bm.mode === 'audio' ? 'Audio' : 'Card';
    const tName = (nameById && nameById.get(bm.titleId)) || bm.titleName || '';
    const sub = (tName ? (tName + ' · ') : '') + when;
    return `<div style="font-size:.9rem;color:#eee;">${pctTag(bmAudioMs(bm))}${modeLabel} · ${where}</div>` +
           `<div style="color:#888;font-size:.72rem;margin-top:2px;">${sub}</div>`;
  }

  async function openMenu() {
    // The full-screen Dynamic Timeline panel owns this surface; the legacy
    // list below remains as the fallback when no axis can be built yet
    // (no chunk map and no title text loaded) or the timeline module is absent.
    // First: if AI is on but this book isn't activated, prompt to activate
    // (the user opts in per book). 'proceed' still opens the timeline AI-free.
    try {
      if (window.aiProcessor && window.aiProcessor.ensureActivated && window._activeTitleId) {
        await window.aiProcessor.ensureActivated(window._activeTitleId);
      }
    } catch (_) {}
    try {
      if (window.aiTimeline && window.aiTimeline.openPanel && window._activeTitleId) {
        const ok = await window.aiTimeline.openPanel();
        if (ok) return;
      }
    } catch (_) {}
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
    card.style.cssText = 'background:#161616;border:1px solid #2a2a2a;border-radius:12px;min-width:min(92vw,420px);max-width:92vw;max-height:76vh;overflow:auto;padding:14px;';
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

    // AI session summary — shown only once the AI layer is configured
    // (Preferences → AI assistant). Summarizes from this session's start
    // position (event log) to the current spot; never text past it.
    if (window.ai && window.ai.isEnabled && window.ai.isEnabled() && window.aiSummary) {
      const ab = document.createElement('button');
      ab.className = 'menu-item kai-glow';
      ab.style.cssText = 'display:block;width:100%;text-align:left;background:#191425;border:1px solid #463a6b;border-radius:8px;padding:10px 12px;margin-bottom:8px;cursor:pointer;';
      ab.innerHTML =
        '<div style="font-size:.9rem;color:#d6c8ff;">✦ AI summary — this session</div>' +
        '<div style="color:#9a8cc4;font-size:.72rem;margin-top:2px;">いま読んだ・聞いた範囲を要約</div>';
      ab.addEventListener('click', () => {
        overlay.remove();
        try { window.aiSummary.summarizeRecent(); } catch (_) {}
      });
      card.appendChild(ab);

      // Recent saved summaries (free to reopen — no API call).
      let saved = [];
      try {
        if (activeTitleId && window.aiSummary.listSaved) {
          saved = await window.aiSummary.listSaved(activeTitleId);
        }
      } catch (_) {}
      saved.slice(0, 3).forEach((en) => {
        const when = (() => { try { return new Date(en.ts).toLocaleString(); } catch (_) { return ''; } })();
        const sb = document.createElement('button');
        sb.className = 'menu-item';
        sb.style.cssText = 'display:block;width:100%;text-align:left;background:#16131f;border:1px solid #322a4a;border-radius:8px;padding:8px 12px;margin-bottom:8px;cursor:pointer;';
        // en.label is persisted AI output — textContent, never innerHTML
        const sl = document.createElement('div');
        sl.style.cssText = 'font-size:.82rem;color:#b9aee0;';
        sl.textContent = '📝 ' + (en.label || '要約');
        const sw = document.createElement('div');
        sw.style.cssText = 'color:#7d72a3;font-size:.68rem;margin-top:2px;';
        sw.textContent = when;
        sb.appendChild(sl);
        sb.appendChild(sw);
        sb.addEventListener('click', () => {
          overlay.remove();
          try { window.aiSummary.openSaved(en); } catch (_) {}
        });
        card.appendChild(sb);
      });

      // (Range summaries were superseded by the Dynamic Timeline's chapter
      // cards; the saved entries above reopen free.)
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

  // ---- History: the 3 most recent sessions across ALL titles, by modality ----
  // A lightweight "where was I?" list (the old bookmark menu, brought back as its
  // own surface separate from the Dynamic Timeline). Each row is tappable →
  // jumpTo (cross-title open + mode switch + land the spot).
  const BADGE = {
    read:  ['Read',  '#7fd49b', '#15201b', '#2e5a3f'],
    card:  ['Card',  '#ffb784', '#241a12', '#5a3a2a'],
    audio: ['Audio', '#c4aaf6', '#191425', '#463a6b'],
    _:     ['',      '#aaa',    '#1e1e1e', '#2a2a2a'],
  };
  async function openHistory() {
    const prev = document.getElementById('historyOverlay');
    if (prev) prev.remove();
    // Newest first across every title; entries are already deduped per spot.
    const recent = list().slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 10);
    let nameById = new Map();
    try {
      if (window.titleStore && window.titleStore.list) {
        const titles = await window.titleStore.list();
        for (const t of (titles || [])) nameById.set(t.id, t.name);
      }
    } catch (_) {}

    const overlay = document.createElement('div');
    overlay.id = 'historyOverlay';
    overlay.className = 'kai-modal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:100000;display:flex;align-items:center;justify-content:center;touch-action:none;';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const card = document.createElement('div');
    card.style.cssText = 'background:#161616;border:1px solid #2a2a2a;border-radius:12px;min-width:min(92vw,420px);max-width:92vw;max-height:76vh;overflow:auto;padding:14px;';
    const head = document.createElement('div');
    head.style.cssText = 'font-weight:600;font-size:1rem;color:#eee;margin-bottom:4px;';
    head.textContent = 'History';
    card.appendChild(head);
    const subhead = document.createElement('div');
    subhead.style.cssText = 'color:#888;font-size:.74rem;margin-bottom:10px;';
    subhead.textContent = 'Your 10 most recent reading sessions — tap to jump back.';
    card.appendChild(subhead);

    if (!recent.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:#888;font-size:.85rem;padding:6px 2px;';
      empty.textContent = 'No history yet. Read in any mode and your recent spots show up here.';
      card.appendChild(empty);
    } else {
      recent.forEach((bm) => {
        const b = document.createElement('button');
        b.className = 'menu-item';
        b.style.cssText = 'display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:#1e1e1e;border:1px solid #2a2a2a;border-radius:8px;padding:10px 12px;margin-bottom:8px;cursor:pointer;';
        // % of book on the LEFT — stamped at capture against THIS title's own duration
        // (bm.pct), so it's correct even though History spans titles ('—' if unknown).
        const pctCol = document.createElement('div');
        pctCol.style.cssText = 'flex:none;width:44px;text-align:center;color:#bd9;font-weight:700;font-size:1rem;';
        pctCol.textContent = Number.isFinite(bm.pct) ? (bm.pct + '%') : '–';
        b.appendChild(pctCol);
        const contentCol = document.createElement('div');
        contentCol.style.cssText = 'flex:1;min-width:0;';
        const line1 = document.createElement('div');
        line1.style.cssText = 'font-size:.9rem;color:#eee;display:flex;align-items:center;flex-wrap:wrap;gap:2px;';
        const m = BADGE[bm.mode] || BADGE._;
        const bdg = document.createElement('span');
        bdg.style.cssText = 'display:inline-block;font-size:.66rem;font-weight:700;color:' + m[1] + ';background:' + m[2] + ';border:1px solid ' + m[3] + ';border-radius:5px;padding:1px 6px;margin-right:6px;';
        bdg.textContent = m[0];
        line1.appendChild(bdg);
        const whereEl = document.createElement('span');
        whereEl.textContent = whereText(bm);
        line1.appendChild(whereEl);
        const line2 = document.createElement('div');
        line2.style.cssText = 'color:#888;font-size:.72rem;margin-top:3px;';
        const when = (() => { try { return new Date(bm.ts).toLocaleString(); } catch (_) { return ''; } })();
        const tName = (nameById && nameById.get(bm.titleId)) || bm.titleName || 'Untitled';
        line2.textContent = tName + ' · ' + when;   // textContent → XSS-safe title name
        contentCol.appendChild(line1);
        contentCol.appendChild(line2);
        b.appendChild(contentCol);
        b.addEventListener('click', () => { overlay.remove(); jumpTo(bm); });
        card.appendChild(b);
      });
    }
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  window.bookmarks = { record, list, capture, captureCurrent, currentMode, jumpTo, openMenu, openHistory, updateFurthest, getFurthest, jumpToFurthest };

  // Keep History fresh during a long, uninterrupted listen/read: snapshot the
  // current spot whenever the app backgrounds (the live position just before the
  // WebView is suspended). captureCurrent self-throttles (MIN_GAP_MS) + dedups,
  // so this can't crowd the list. Complements the mode-switch capture, which
  // otherwise wouldn't fire during a single continuous session.
  try {
    const onBackground = () => { try { captureCurrent({}); } catch (_) {} };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') onBackground(); });
    window.addEventListener('pagehide', onBackground);
  } catch (_) {}
})();
