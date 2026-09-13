// lookup-log.js — dictionary lookup history (Apple-Watch plan S0).
//
// Every successful dictionary lookup is logged WITH its context (the sentence
// it was tapped in + the cue's audio time range), so words can be reviewed
// later and sent to Anki with the exact same sentence + audio slice the
// original tap would have produced. Later, Apple Watch word-flags ingest into
// this same store with source:'watch'.
//
// Store: blobStore LOOKUP_LOG_V1 → { v:1, entries: [ {term, base, sentence,
// titleId, titleName, cueStartMs, cueEndMs, cueAudioPath, ts, source,
// ankiSentTs} ] } newest FIRST, ring-capped. Dedupe: a re-lookup of the same
// term+sentence within 10 min refreshes the existing entry instead of
// stacking duplicates.
(function () {
  'use strict';

  const KEY = 'LOOKUP_LOG_V1';
  const CAP = 500;
  const DEDUPE_MS = 10 * 60 * 1000;

  let data = null;          // { v:1, entries:[] } — newest first
  let loadP = null;
  let saveTimer = null;

  function load() {
    if (data) return Promise.resolve(data);
    if (loadP) return loadP;
    loadP = (async () => {
      let o = null;
      try {
        const raw = await window.blobStore?.get(KEY);
        o = raw ? JSON.parse(raw) : null;
      } catch (_) {}
      if (!o || o.v !== 1 || !Array.isArray(o.entries)) o = { v: 1, entries: [] };
      data = o;
      loadP = null;
      return data;
    })();
    return loadP;
  }
  function persistSoon() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try { if (data) window.blobStore?.set(KEY, JSON.stringify(data)); } catch (_) {}
    }, 2000);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && saveTimer) {
      clearTimeout(saveTimer); saveTimer = null;
      try { if (data) window.blobStore?.set(KEY, JSON.stringify(data)); } catch (_) {}
    }
  });

  // add({term, base, ctx, source}) — ctx = window.lookupContext-shaped (may be null).
  function add(rec) {
    if (!rec || (!rec.term && !(rec.ctx && rec.ctx.sentence))) return;
    rec.term = rec.term || '';
    load().then((o) => {
      const ctx = rec.ctx || {};
      const sentence = (typeof ctx.sentence === 'string' && ctx.sentence.trim()) ? ctx.sentence.trim() : '';
      const now = Date.now();
      // Dedupe against a recent identical lookup.
      const dup = o.entries.findIndex((e) =>
        e.term === rec.term && e.sentence === sentence && now - e.ts < DEDUPE_MS);
      if (dup >= 0) {
        const e = o.entries.splice(dup, 1)[0];
        e.ts = now;
        o.entries.unshift(e);
        persistSoon();
        return;
      }
      // Surrounding context (±2 cues) captured AT LOG TIME — the viewer shows
      // a few sentences around the word, and the entry may be reviewed long
      // after this title is closed, so it must be self-contained.
      let pre = '', post = '';
      try {
        const cues = (Array.isArray(window._srtCues) && window._srtCues.length) ? window._srtCues
          : (Array.isArray(window.__abCues) && window.__abCues.length) ? window.__abCues : null;
        if (cues && Number.isFinite(ctx.cueStartMs)) {
          const i = cues.findIndex((c) => Number.isFinite(c.startMs) && Math.abs(c.startMs - ctx.cueStartMs) < 50);
          if (i >= 0) {
            pre = ((cues[i - 2]?.text || '') + (cues[i - 1]?.text || '')).slice(-120);
            post = ((cues[i + 1]?.text || '') + (cues[i + 2]?.text || '')).slice(0, 120);
          }
        }
      } catch (_) {}
      // Position through the book at lookup time (percent of audio duration).
      let pct = null;
      try {
        const g = window.getAudioProgress?.();
        if (g && Number(g.dur) > 60000 && Number.isFinite(ctx.cueStartMs)) {
          pct = Math.max(0, Math.min(100, Math.round((ctx.cueStartMs / g.dur) * 100)));
        }
      } catch (_) {}
      o.entries.unshift({
        term: rec.term,
        base: rec.base || rec.term,
        sentence,
        pre, post, pct,
        // Watch flags carry their own title identity (the flagged title may
        // not be the phone's active one).
        titleId: rec.titleId || window._activeTitleId || null,
        titleName: rec.titleName || (document.getElementById('deckName')?.textContent || '').trim(),
        cueStartMs: Number.isFinite(ctx.cueStartMs) ? ctx.cueStartMs : null,
        cueEndMs: Number.isFinite(ctx.cueEndMs) ? ctx.cueEndMs : null,
        cueAudioPath: ctx.cueAudioPath || null,
        ts: now,
        source: rec.source || 'phone',
        ankiSentTs: 0,
      });
      if (o.entries.length > CAP) o.entries.length = CAP;
      persistSoon();
    }).catch(() => {});
  }

  // Stamp the most recent entry for this term as sent to Anki.
  function markAnkiSent(term) {
    if (!term) return;
    load().then((o) => {
      const e = o.entries.find((x) => x.term === term || x.base === term);
      if (e && !e.ankiSentTs) { e.ankiSentTs = Date.now(); persistSoon(); }
      // Refresh an open history screen so the ✓ appears live.
      try { if (document.getElementById('lookupLogOverlay')) openScreen(); } catch (_) {}
    }).catch(() => {});
  }

  function relTime(ts) {
    const d = Date.now() - ts;
    const m = Math.round(d / 60000);
    if (m < 1) return window.i18n.t('lh.now', 'now');
    if (m < 60) return m + window.i18n.t('lh.min', 'm');
    const h = Math.round(m / 60);
    if (h < 24) return h + window.i18n.t('lh.hour', 'h');
    return new Date(ts).toLocaleDateString();
  }

  // ── the viewer ────────────────────────────────────────────────────────────
  // Steps through history entries with ◀ ▶ over the REAL dictionary popup:
  // a slim fixed nav bar (above the popup, below the waveform editor) with a
  // counter + close, a context strip showing the sentence with the looked-up
  // word HIGHLIGHTED, and a full-screen shield UNDER the popup so background
  // gestures can never reach the mode beneath (lookups must NEVER change the
  // place — the popup's Set-playhead is also hidden for source:'history').
  // The dict popup's own outside-tap dismiss excludes #lookupNavBar, so this
  // viewer owns the popup lifecycle; ✕ / shield-tap close everything and
  // return to the untouched mode below.
  let _viewList = null, _viewIdx = -1;

  function _bindCtx(e) {
    window.lookupContext = {
      source: 'history',
      sentence: e.sentence || '',
      cueStartMs: Number.isFinite(e.cueStartMs) ? e.cueStartMs : undefined,
      cueEndMs: Number.isFinite(e.cueEndMs) ? e.cueEndMs : undefined,
      cueAudioPath: e.cueAudioPath || null,
      card: null,
    };
  }
  function _bindAndLookup(e) {
    _bindCtx(e);
    if (!e.term) {
      // Whole-subtitle flag (from the watch): nothing pre-looked-up — the
      // user taps a word in the context panel; the popup docks below.
      try { window.hideDictPopup?.(); } catch (_) {}
      return;
    }
    const text = (e.sentence && e.sentence.indexOf(e.term) >= 0) ? e.sentence : e.term;
    const ci = Math.max(0, text.indexOf(e.term));
    try { window.dictLookupFromHistory?.(text, ci); } catch (_) {}
  }

  // ── pane-mode karaoke: horizontal follow while the entry's clip plays ──
  // The sentence is rendered as per-character spans; the clip player's time
  // callback drives a glowing beam + tinted "past" characters from the cue's
  // word timings (the title's live cue list when it matches, else uniform
  // per-character timing). Self-contained — never touches the reader clock.
  function _lhkStyles() {
    if (document.getElementById('lhkStyle')) return;
    const st = document.createElement('style');
    st.id = 'lhkStyle';
    st.textContent =
      '#lhCtx { position:relative; }' +
      '#lhCtx .lhk { transition: color .14s ease, text-shadow .14s ease; }' +
      '#lhCtx .lhk-past { color:#d9f3dc; }' +
      '#lhCtx .lhk-now { color:#fff; text-shadow:0 0 10px rgba(76,175,80,.95), 0 0 24px rgba(76,175,80,.55); }' +
      '#lhCtx .lhk-term { color:var(--accent-read,#4caf50); font-weight:800; }' +
      '#lhCtx .lhk-term.lhk-now { color:#fff; }' +
      '#lhCtx .lhk-beam { position:absolute; width:3px; border-radius:2px; pointer-events:none; opacity:0;' +
        'background:linear-gradient(180deg, rgba(76,175,80,0), #9ff7a8 30%, #9ff7a8 70%, rgba(76,175,80,0));' +
        'box-shadow:0 0 12px 3px rgba(76,175,80,.55), 0 0 30px 6px rgba(76,175,80,.22);' +
        'transition:left .09s linear, top .09s linear, height .09s linear, opacity .25s ease; }' +
      '#lhCtx .lhk-beam.on { opacity:1; }';
    document.head.appendChild(st);
  }
  function _lhkFillPos(w, rel) {   // char offset (float) at cue-relative ms — mirrors word-highlight's fillPosAt
    const n = w.length >> 2;
    let a = -1, lo = 0, hi = n - 1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (w[mid * 4 + 2] <= rel) { a = mid; lo = mid + 1; } else hi = mid - 1; }
    if (a < 0) { const ws = w[2]; return ws > 0 ? Math.max(0, Math.min(1, rel / ws)) * w[0] : 0; }
    const off = w[a * 4], len = w[a * 4 + 1], ws = w[a * 4 + 2], we = w[a * 4 + 3];
    if (rel < we || a === n - 1) { const f = we > ws ? Math.max(0, Math.min(1, (rel - ws) / (we - ws))) : 1; return off + f * len; }
    const ns = w[(a + 1) * 4 + 2];
    const f = ns > we ? Math.max(0, Math.min(1, (rel - we) / (ns - we))) : 1;
    return (off + len) + f * (w[(a + 1) * 4] - (off + len));
  }
  function _lhkWordTimes(e) {
    const sent = e.sentence || '';
    try {   // the active title's live cues carry real word timings for this line
      if (e.titleId === window._activeTitleId && Number.isFinite(e.cueStartMs)) {
        const lists = [window.__abCues, window._srtCues].filter((l) => Array.isArray(l) && l.length);
        for (const cues of lists) {
          const c = cues.find((x) => x && Number.isFinite(x.startMs) && Math.abs(x.startMs - e.cueStartMs) < 80 && x.text === sent);
          if (c && Array.isArray(c.w) && c.w.length) return c.w;
        }
      }
    } catch (_) {}
    const dur = Math.max(300, (e.cueEndMs || 0) - (e.cueStartMs || 0));
    const idxs = [];
    for (let i = 0; i < sent.length; i++) if (!/[\s　「」『』、。・…！？!?,.;:()（）]/.test(sent[i])) idxs.push(i);
    if (!idxs.length) return null;
    const lead = Math.min(120, dur * 0.06), tail = Math.min(200, dur * 0.1), per = (dur - lead - tail) / idxs.length;
    const w = [];
    for (let k = 0; k < idxs.length; k++) w.push(idxs[k], 1, Math.round(lead + k * per), Math.round(lead + (k + 1) * per));
    return w;
  }
  let _lhk = null;   // { e, spans, beam, w, lastIdx }
  function _lhkClear() {
    if (!_lhk) return;
    try { for (const s of _lhk.spans) s.classList.remove('lhk-past', 'lhk-now'); } catch (_) {}
    try { _lhk.beam.classList.remove('on'); } catch (_) {}
    _lhk = null;
  }
  function _lhkTick(ms) {
    const k = _lhk; if (!k) return;
    const ctx = document.getElementById('lhCtx'); if (!ctx) return;
    if (ms == null) {   // clip finished: settle on the fully-heard look
      for (const s of k.spans) { s.classList.remove('lhk-now'); s.classList.add('lhk-past'); }
      k.beam.classList.remove('on');
      return;
    }
    const rel = ms - (k.e.cueStartMs || 0);
    const pos = _lhkFillPos(k.w, rel);
    const cur = Math.max(0, Math.min(k.spans.length - 1, Math.floor(pos)));
    for (let i = 0; i < k.spans.length; i++) {
      const s = k.spans[i];
      if (i < cur) { s.classList.add('lhk-past'); s.classList.remove('lhk-now'); }
      else if (i === cur) { s.classList.add('lhk-now'); s.classList.remove('lhk-past'); }
      else { s.classList.remove('lhk-past', 'lhk-now'); }
    }
    try {
      const sp = k.spans[cur];
      const r = sp.getBoundingClientRect(), cr = ctx.getBoundingClientRect();
      const f = pos - cur;
      k.beam.style.left = Math.round(r.left - cr.left + ctx.scrollLeft + r.width * Math.max(0, Math.min(1, f))) + 'px';
      k.beam.style.top = Math.round(r.top - cr.top + ctx.scrollTop - 2) + 'px';
      k.beam.style.height = Math.round(r.height + 4) + 'px';
      k.beam.classList.add('on');
      if (r.bottom > cr.bottom || r.top < cr.top) sp.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (_) {}
  }
  // Render the sentence as per-char spans (pane mode) and arm the karaoke.
  function _lhkArm(e, midEl) {
    _lhkClear();
    _lhkStyles();
    const sent = e.sentence || e.term || '';
    midEl.textContent = '';
    const spans = [];
    const ti = e.term ? sent.indexOf(e.term) : -1;
    for (let i = 0; i < sent.length; i++) {
      const s = document.createElement('span');
      s.className = 'lhk' + (ti >= 0 && i >= ti && i < ti + e.term.length ? ' lhk-term' : '');
      s.textContent = sent[i];
      midEl.appendChild(s);
      spans.push(s);
    }
    const w = _lhkWordTimes(e);
    if (!w) return;
    const ctx = document.getElementById('lhCtx');
    let beam = ctx && ctx.querySelector('.lhk-beam');
    if (ctx && !beam) { beam = document.createElement('div'); beam.className = 'lhk-beam'; ctx.appendChild(beam); }
    _lhk = { e, spans, beam, w };
  }

  // Audio path for an entry's clip: the ACTIVE title's live path when the
  // entry belongs to it (always current), else the stored path rebased to the
  // current app container (iOS reinstalls change the container UUID — the
  // stale absolute path was the "slice failed" on Play).
  async function resolveClipPath(e) {
    try {
      if (e.titleId && e.titleId === window._activeTitleId) {
        const live = window._pagedAudioPath || window.__abAudioPath;
        if (live) return live;
      }
      let p = e.cueAudioPath || null;
      if (!p && e.titleId) {
        const t = await window.titleStore?.get?.(e.titleId);
        p = t?.attachments?.audiobook?.cachePath || null;
      }
      if (p && window.rebaseContainerPath) { try { p = (await window.rebaseContainerPath(p)) || p; } catch (_) {} }
      return p;
    } catch (_) { return e.cueAudioPath || null; }
  }
  window.lookupLog_resolveClipPath = resolveClipPath;

  function closeViewer() {
    _viewList = null; _viewIdx = -1;
    try { document.getElementById('lookupNavBar')?.remove(); } catch (_) {}
    try { document.getElementById('lookupNavShield')?.remove(); } catch (_) {}
    // Clear the split-layout geometry the viewer forced onto the popup so the
    // next normal lookup repositions from scratch (positionDictPopup's normal
    // path never writes `bottom`/`right` — they would linger).
    try {
      const p = document.getElementById('dictPopup');
      if (p) {
        p.style.top = ''; p.style.bottom = ''; p.style.left = ''; p.style.right = '';
        p.style.width = ''; p.style.maxHeight = ''; p.style.maxWidth = '';
        p.style.margin = ''; p.style.transform = ''; p.style.boxSizing = '';
        // Radius + top border were INLINE at popup creation — restore their
        // original values (clearing to '' would strip them permanently).
        p.style.borderRadius = '14px';
        p.style.borderTop = '1px solid #262a30';
        p.style.zIndex = '';
      }
    } catch (_) {}
    if (_viewOpts && _viewOpts.pane) { window._statsPaneOpen = false; try { window.stats?.resumeFromModal?.(); } catch (_) {} }
    _viewOpts = null;
    _lhkClear();
    try { window.aiTimelineClip?.stop?.(); } catch (_) {}
    // Proper popup teardown (runs the resume-after-lookup path).
    try { window.hideDictPopup?.(); } catch (_) {}
  }

  function fmtClock(ms) {
    const t = Math.max(0, Math.floor((ms || 0) / 1000));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }

  async function _showViewerEntry() {
    const bar = document.getElementById('lookupNavBar');
    const e = _viewList && _viewList[_viewIdx];
    if (!bar || !e) { closeViewer(); return; }
    // Watch-flagged entries carry no audio path (the watch doesn't know the
    // phone's cache paths) — resolve it from the title so Add-to-Anki opens
    // the waveform editor (play/trim) instead of silently sending w/o audio.
    if (!e.cueAudioPath && e.titleId && Number.isFinite(e.cueStartMs)) {
      try {
        const t = await window.titleStore?.get?.(e.titleId);
        const cp = t?.attachments?.audiobook?.cachePath;
        if (cp) { e.cueAudioPath = cp; persistSoon(); }
      } catch (_) {}
    }
    bar.querySelector('#lhCount').textContent = (_viewIdx + 1) + ' / ' + _viewList.length;
    const prev = bar.querySelector('#lhPrev'), next = bar.querySelector('#lhNext');
    prev.disabled = _viewIdx <= 0;
    next.disabled = _viewIdx >= _viewList.length - 1;
    prev.style.opacity = prev.disabled ? '.35' : '1';
    next.style.opacity = next.disabled ? '.35' : '1';
    // Term line.
    const termEl = bar.querySelector('#lhTerm');
    termEl.textContent = '';
    const pane = !!bar.dataset.pane;
    const play = bar.querySelector('#lhPlay');
    if (play) {
      const can = Number.isFinite(e.cueStartMs) && Number.isFinite(e.cueEndMs) && !!e.cueAudioPath;
      play.disabled = !can; play.style.opacity = can ? '1' : '.35';
    }
    const tw = document.createElement('span');
    if (e.term) {
      tw.style.cssText = pane
        ? 'font-size:1.9rem;font-weight:800;color:#fff;letter-spacing:.01em;text-shadow:0 0 22px rgba(76,175,80,.38),0 2px 6px rgba(0,0,0,.6);'
        : 'font-size:1.45rem;font-weight:800;color:#fff;';
      tw.textContent = e.term;
    } else {
      tw.style.cssText = 'font-size:.82rem;font-weight:700;color:#9fcaff;';
      tw.textContent = window.i18n.t('lh.tap_hint', 'Flagged subtitle — tap any word below to look it up');
    }
    termEl.appendChild(tw);
    if (e.term && e.base && e.base !== e.term) {
      const bs = document.createElement('span');
      bs.style.cssText = 'margin-left:10px;color:#8a8a96;font-size:.9rem;';
      bs.textContent = e.base;
      termEl.appendChild(bs);
    }
    // Context: a few sentences — pre (dim) + the sentence with the word
    // highlighted + post (dim). DOM-built, no HTML injection.
    const ctxEl = bar.querySelector('#lhCtx');
    ctxEl.textContent = '';
    const dim = (txt) => {
      const s = document.createElement('span');
      s.style.cssText = 'color:#7c7c88;';
      s.textContent = txt;
      return s;
    };
    if (e.pre) ctxEl.appendChild(dim(e.pre));
    const mid = document.createElement('span');
    mid.style.cssText = 'color:#e8e8f0;';
    const sent = e.sentence || e.term;
    const i = e.term ? sent.indexOf(e.term) : -1;
    if (pane) {
      _lhkArm(e, mid);   // per-char spans + beam, driven by the clip player
    } else if (i >= 0) {
      mid.appendChild(document.createTextNode(sent.slice(0, i)));
      const hl = document.createElement('span');
      hl.style.cssText = 'color:var(--accent-read,#4caf50);font-weight:800;';
      hl.textContent = e.term;
      mid.appendChild(hl);
      mid.appendChild(document.createTextNode(sent.slice(i + e.term.length)));
    } else {
      mid.textContent = sent;
    }
    ctxEl.appendChild(mid);
    if (e.post) ctxEl.appendChild(dim(e.post));
    // Words in the context panel are tappable dictionary lookups (popup docks
    // in the bottom half). Wired HERE — AFTER the content is appended —
    // because dictEnableLookupIn no-ops on an empty container (the earlier
    // creation-time wire never attached, so taps leaked through to the
    // chrome toggle). dictKeepCtx: the lazy tap handler must keep our
    // pre-bound entry context (sentence + cue range) so Add-to-Anki slices
    // the flagged cue's audio.
    ctxEl.dataset.dictKeepCtx = '1';
    try { window.dictEnableLookupIn?.(ctxEl); } catch (_) {}
    // Meta: title · audio timestamp · % through · lookup date.
    const metaEl = bar.querySelector('#lhMeta');
    const bits = [];
    if (e.titleName) bits.push(e.titleName);
    if (Number.isFinite(e.cueStartMs)) bits.push(fmtClock(e.cueStartMs));
    if (Number.isFinite(e.pct)) bits.push(e.pct + '%');
    bits.push(new Date(e.ts).toLocaleString());
    metaEl.textContent = bits.join(' · ');
    // The Anki dialog's waveform + slice use lookupContext.cueAudioPath: make
    // it the LIVE/rebased path (a stored path from an older install container
    // drew "waveform unavailable" and failed the slice).
    try { const src = await resolveClipPath(e); if (src && src !== e.cueAudioPath) { e.cueAudioPath = src; persistSoon(); } } catch (_) {}
    _bindAndLookup(e);
  }

  // opts.pane: PANE layout for the Card-tab Vocabulary view — everything sits
  // BELOW the app header (tabs stay live for navigation), glass styling, a
  // Play button for the sentence's audio, and "Back" returns to the list
  // (opts.onBack). Default (no opts) = the original full-screen split viewer.
  let _viewOpts = null;
  function openViewer(entries, idx, opts) {
    _viewList = entries; _viewIdx = idx; _viewOpts = opts || null;
    const pane = !!(opts && opts.pane);
    if (pane) { window._statsPaneOpen = true; try { window.stats?.pauseForModal?.(); } catch (_) {} }   // no read/audio time while browsing entries
    const HDR = 'calc(env(safe-area-inset-top,0px) + 48px)';
    if (pane) { try { document.getElementById('lookupNavShield')?.remove(); document.getElementById('lookupNavBar')?.remove(); } catch (_) {} }
    if (!document.getElementById('lookupNavShield')) {
      // Shield: below the dict popup (9999), above the app — background
      // swipes/taps land here, never on the mode beneath. Tap = close.
      const sh = document.createElement('div');
      sh.id = 'lookupNavShield';
      sh.className = 'kai-modal';
      sh.style.cssText = pane
        ? 'position:fixed;left:0;right:0;top:' + HDR + ';bottom:0;z-index:8900;touch-action:none;' +
          'background:radial-gradient(120% 70% at 50% -10%, rgba(76,175,80,.14), transparent 60%),linear-gradient(180deg,#13131a,#0a0a0e);'
        : 'position:fixed;inset:0;z-index:9400;background:rgba(0,0,0,.55);touch-action:none;';
      sh.addEventListener('click', (ev) => { ev.stopPropagation(); if (pane) { const cb = _viewOpts && _viewOpts.onBack; closeViewer(); try { cb && cb(); } catch (_) {} } else closeViewer(); });
      sh.addEventListener('touchmove', (ev) => { try { ev.preventDefault(); } catch (_) {} }, { passive: false });
      document.body.appendChild(sh);
    }
    if (!document.getElementById('lookupNavBar')) {
      // SPLIT LAYOUT: this panel owns the TOP HALF of the screen; the dict
      // popup is pinned to the bottom half by positionDictPopup's viewer
      // branch. Above the popup (9999), below the waveform editor (12000).
      const bar = document.createElement('div');
      bar.id = 'lookupNavBar';
      bar.className = 'kai-modal';
      // Rounded card matching the docked dictionary below (same 12px insets,
      // same radius/shadow) — the pair reads as one linked unit with the
      // dimmed background visible around them.
      if (pane) bar.dataset.pane = '1';
      bar.style.cssText = pane
        ? 'position:fixed;left:12px;right:12px;top:calc(env(safe-area-inset-top,0px) + 58px);bottom:50vh;' +
          'z-index:8950;box-sizing:border-box;' +
          'background:linear-gradient(180deg,rgba(36,36,48,.74),rgba(20,20,28,.74));' +
          '-webkit-backdrop-filter:blur(22px) saturate(1.3);backdrop-filter:blur(22px) saturate(1.3);' +
          'border:1px solid rgba(255,255,255,.12);border-bottom:none;border-radius:16px 16px 0 0;' +
          'box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 12px 36px rgba(0,0,0,.5);' +
          'padding:12px 16px 10px;display:flex;flex-direction:column;gap:8px;'
        : 'position:fixed;left:12px;right:12px;top:calc(env(safe-area-inset-top,0px) + 12px);bottom:50vh;' +
          'z-index:11000;box-sizing:border-box;' +
          'background:#15171a;border:1px solid #262a30;border-radius:14px 14px 0 0;' +
          'box-shadow:0 8px 24px rgba(0,0,0,.55);' +
          'padding:12px 16px 10px;' +
          'display:flex;flex-direction:column;gap:8px;';
      const btnCss = pane
        ? 'background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);border-radius:999px;color:#f0f0f2;' +
          'box-shadow:inset 0 1px 0 rgba(255,255,255,.12);font-size:.95rem;font-weight:700;padding:7px 16px;line-height:1;' +
          'transition:transform .32s cubic-bezier(.34,1.56,.64,1);'
        : 'background:#22222b;border:1px solid #33333e;border-radius:9px;color:#dcdce4;' +
          'font-size:1.0rem;font-weight:700;padding:6px 18px;line-height:1;' +
          'transition:transform .32s cubic-bezier(.34,1.56,.64,1);';
      const T = (k, fb) => (window.i18n && window.i18n.t) ? window.i18n.t(k, fb) : fb;
      bar.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;flex:none;">' +
          '<button id="lhPrev" style="' + btnCss + '">' + (pane ? '‹' : '◀') + '</button>' +
          '<span id="lhCount" style="flex:none;color:#8a8a96;font-size:.8rem;font-weight:700;min-width:56px;text-align:center;"></span>' +
          '<button id="lhNext" style="' + btnCss + '">' + (pane ? '›' : '▶') + '</button>' +
          '<button id="lhPlay" style="' + btnCss + 'margin-left:4px;">▶ ' + T('lh.play', 'Play') + '</button>' +
          '<span style="flex:1;"></span>' +
          '<button id="lhClose" style="' + btnCss + 'padding:' + (pane ? '7px 14px' : '6px 14px') + ';">' + (pane ? T('lh.back', 'Back') : '✕') + '</button>' +
        '</div>' +
        '<div id="lhTerm" style="flex:none;"></div>' +
        '<div id="lhCtx" style="flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;' +
          'font-size:1.18rem;line-height:1.9;"></div>' +
        '<div id="lhMeta" style="flex:none;color:#6a6a76;font-size:.72rem;overflow:hidden;' +
          'text-overflow:ellipsis;white-space:nowrap;"></div>';
      const step = (d) => {
        const n = _viewIdx + d;
        if (!_viewList || n < 0 || n >= _viewList.length) return;
        try { window.kHaptic?.(); } catch (_) {}
        _viewIdx = n;
        _showViewerEntry();
      };
      bar.querySelector('#lhPrev').addEventListener('click', (ev) => { ev.stopPropagation(); step(-1); });
      bar.querySelector('#lhNext').addEventListener('click', (ev) => { ev.stopPropagation(); step(1); });
      bar.querySelector('#lhClose').addEventListener('click', (ev) => {
        ev.stopPropagation(); try { window.kHaptic?.(); } catch (_) {}
        const cb = _viewOpts && _viewOpts.onBack;
        closeViewer();
        try { cb && cb(); } catch (_) {}
      });
      bar.querySelector('#lhPlay').addEventListener('click', (ev) => {
        ev.stopPropagation(); try { window.kHaptic?.(); } catch (_) {}
        const e = _viewList && _viewList[_viewIdx];
        if (!e || !Number.isFinite(e.cueStartMs) || !Number.isFinite(e.cueEndMs)) return;
        const btn = ev.currentTarget;
        resolveClipPath(e).then((src) => {
          if (!src) { try { window.showToast?.(window.i18n.t('lh.no_audio', 'No audio for this entry'), 1800); } catch (_) {} return; }
          const onTime = (ms) => { try { _lhkTick(ms); } catch (_) {} };
          try { window.aiTimelineClip?.play?.({ startMs: e.cueStartMs, endMs: e.cueEndMs }, btn, src, onTime); } catch (_) {}
        });
      });
      document.body.appendChild(bar);
    }
    _showViewerEntry();
  }

  async function openScreen() {
    const o = await load();
    const t = (k, fb) => window.i18n.t(k, fb);
    const prev = document.getElementById('lookupLogOverlay');
    if (prev) prev.remove();
    const ov = document.createElement('div');
    ov.id = 'lookupLogOverlay';
    ov.className = 'kai-modal';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px;';
    const card = document.createElement('div');
    card.style.cssText = 'background:#141419;border:1px solid #2a2a33;border-radius:14px;max-width:460px;width:100%;max-height:84vh;display:flex;flex-direction:column;overflow:hidden;';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px;border-bottom:1px solid #22222a;';
    head.innerHTML = '<div style="font-weight:700;font-size:1.0rem;color:#f0f0f4;"></div>';
    head.firstChild.textContent = t('lh.title', 'Lookup history');
    const clr = document.createElement('button');
    clr.textContent = t('lh.clear', 'Clear');
    clr.style.cssText = 'background:transparent;border:1px solid #3a3a44;border-radius:8px;color:#9a9aa6;font-size:.76rem;padding:4px 10px;';
    clr.addEventListener('click', () => {
      if (!confirm(t('lh.clear_confirm', 'Clear all lookup history?'))) return;
      data = { v: 1, entries: [] };
      persistSoon();
      openScreen();
    });
    head.appendChild(clr);
    card.appendChild(head);
    const list = document.createElement('div');
    list.style.cssText = 'flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:6px 10px 12px;';
    if (!o.entries.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:#8a8a96;font-size:.86rem;padding:22px 8px;text-align:center;';
      empty.textContent = t('lh.empty', 'No lookups yet — words you look up appear here with their sentence, ready to send to Anki.');
      list.appendChild(empty);
    }
    o.entries.forEach((e, entryIdx) => {
      const row = document.createElement('div');
      row.style.cssText = 'padding:10px 8px;border-bottom:1px solid #1e1e26;cursor:pointer;';
      const top = document.createElement('div');
      top.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:3px;';
      const w = document.createElement('span');
      w.style.cssText = 'font-weight:800;font-size:1.02rem;color:#e8f1ff;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      w.textContent = e.term || e.sentence || '';
      top.appendChild(w);
      if (e.base && e.base !== e.term) {
        const b = document.createElement('span');
        b.style.cssText = 'color:#8a8a96;font-size:.78rem;';
        b.textContent = e.base;
        top.appendChild(b);
      }
      if (e.ankiSentTs) {
        const ok = document.createElement('span');
        ok.textContent = '✓ Anki';
        ok.style.cssText = 'flex:none;color:#5f8f6a;font-size:.7rem;font-weight:700;border:1px solid #2f4f3a;border-radius:999px;padding:1px 7px;';
        top.appendChild(ok);
      }
      if (e.source === 'watch') {
        const wc = document.createElement('span');
        wc.textContent = 'WATCH';
        wc.style.cssText = 'flex:none;color:#9fcaff;font-size:.62rem;font-weight:700;letter-spacing:.06em;border:1px solid #2f4a6e;border-radius:999px;padding:1px 7px;';
        top.appendChild(wc);
      }
      const spacer = document.createElement('span');
      spacer.style.cssText = 'flex:1;';
      top.appendChild(spacer);
      const tm = document.createElement('span');
      tm.style.cssText = 'flex:none;color:#6a6a76;font-size:.7rem;';
      tm.textContent = relTime(e.ts);
      top.appendChild(tm);
      row.appendChild(top);
      if (e.sentence) {
        // Sentence with the term highlighted — built via DOM (no HTML injection).
        const s = document.createElement('div');
        s.style.cssText = 'color:#b9b9c4;font-size:.84rem;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;';
        const i = e.sentence.indexOf(e.term);
        if (i >= 0) {
          s.appendChild(document.createTextNode(e.sentence.slice(0, i)));
          const hl = document.createElement('span');
          hl.style.cssText = 'color:var(--accent-read,#4caf50);font-weight:700;';
          hl.textContent = e.term;
          s.appendChild(hl);
          s.appendChild(document.createTextNode(e.sentence.slice(i + e.term.length)));
        } else {
          s.textContent = e.sentence;
        }
        row.appendChild(s);
      }
      if (e.titleName) {
        const tn = document.createElement('div');
        tn.style.cssText = 'color:#6a6a76;font-size:.7rem;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        tn.textContent = e.titleName;
        row.appendChild(tn);
      }
      row.addEventListener('click', () => {
        try { window.kHaptic?.(); } catch (_) {}
        try { ov.remove(); } catch (_) {}
        openViewer(o.entries, entryIdx);
      });
      list.appendChild(row);
    });
    card.appendChild(list);
    const close = document.createElement('button');
    close.textContent = t('common.close', 'Close');
    close.style.cssText = 'flex:none;margin:10px 12px 12px;background:#22222b;border:1px solid #33333e;color:#ccccd6;border-radius:8px;padding:9px 0;font-size:.88rem;';
    close.addEventListener('click', () => ov.remove());
    card.appendChild(close);
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
    ov.appendChild(card);
    document.body.appendChild(ov);
  }

  // entries(): the log (newest first); openViewer(entries, idx): the sentence
  // viewer with play + send-to-Anki — both used by the Card-tab Vocabulary view.
  window.lookupLog = { add, markAnkiSent, openScreen, openViewer, closeViewer, entries: async () => (await load()).entries };
})();
