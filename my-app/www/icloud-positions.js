// icloud-positions.js — window.iCloudPos: reading/listening positions shared
// through the iCloud library (step 3).
//
// Each device writes ONLY its own file, Library/<syncId>/state/<deviceId>.json,
// so two devices never edit the same file and iCloud has no conflicts to
// resolve. Other devices read those files and adopt a position only when it is
// FURTHER ON (user rule: forward-only; never lose the user's place):
//   • a Title that isn't open here → its saved positions move forward silently;
//   • the Title that's open here → nothing moves; if another device is further
//     on, a small "Jump there?" offer appears instead;
//   • opening a Title (loadTitleFromLibrary) pulls its positions first.
//
// What syncs: audio resume (ms), read-mode line (chunk index — content-derived,
// identical across devices for the same EPUB; skipped for auto-generated
// books, whose chunks change while they're transcribed), card index/time, and
// the furthest-listened pin. Positions are keyed by Title/EPUB NAME locally,
// which iCloud titles keep identical on every device.
(function () {
  'use strict';
  const LIB = 'Library';
  const DEV_KEY = 'ICLOUD_DEVICE_ID';
  const SEEN_KEY = 'ICLOUD_POS_SEEN_V1';         // state path → mtime applied
  const OFFERED_KEY = 'ICLOUD_POS_OFFERED_V1';   // offers already shown
  const AUDIO_POS = 'READING_AUDIO_LAST_POS_';
  const AUDIO_CHUNK = 'READING_AUDIO_LAST_CHUNK_';
  const AUDIO_TS = 'READING_AUDIO_LAST_TS_';
  const READ_BM = 'PAGED_BOOKMARK_';
  const PUSH_EVERY_MS = 60000;
  const AHEAD_AUDIO_MS = 30000;    // an open title is "behind" only past these margins
  const AHEAD_READ_CHUNKS = 3;

  const kc = () => window.kCloud;
  const L = () => window.iCloudLib;
  const ts = () => window.titleStore;
  const log = (m) => { try { window.debugLog ? window.debugLog('[iCloudPos] ' + m) : console.log('[iCloudPos] ' + m); } catch (_) {} };
  const T = (k, d) => { try { return window.i18n ? window.i18n.t(k, d) : d; } catch (_) { return d; } };
  function jget(k, d) { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch (_) { return d; } }
  function jset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }

  const CapPrefs = () => window.Capacitor?.Plugins?.Preferences;
  async function prefGet(k) {
    try { if (CapPrefs()) return (await CapPrefs().get({ key: k })).value; } catch (_) {}
    try { return localStorage.getItem(k); } catch (_) { return null; }
  }
  async function prefSet(k, v) {
    try { if (CapPrefs()) await CapPrefs().set({ key: k, value: String(v) }); } catch (_) {}
    try { localStorage.setItem(k, String(v)); } catch (_) {}
  }

  function deviceId() {
    let v = null;
    try { v = localStorage.getItem(DEV_KEY); } catch (_) {}
    if (!v) {
      v = 'd_' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
      try { localStorage.setItem(DEV_KEY, v); } catch (_) {}
    }
    return v;
  }
  function deviceName() {
    if (window.KADOKI_MAC) return 'Mac';
    try { if (localStorage.getItem('KADOKI_IS_VISION') === '1') return 'Vision Pro'; } catch (_) {}
    const ua = navigator.userAgent || '';
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
    return 'iPhone';
  }
  function fmtMs(ms) {
    const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(x).padStart(2, '0');
  }

  // Is this Title live on this device (or mid-switch)? Its place is then the
  // user's own and is never moved underneath them.
  function isOpenHere(id) {
    return id === window._activeTitleId || id === window._loadedContentTitleId;
  }
  const readSyncable = (title) => !!(title?.attachments?.epub && !title.attachments.epub.auto);

  // ---- this device's state -------------------------------------------------
  async function snapshot(title) {
    const ds = window.driveSync;
    if (!ds || typeof ds.readPositions !== 'function') return null;
    const p = await ds.readPositions(title.id, title);
    const a = title.attachments || {};
    const out = {
      audioMs: p.audioResume ? Math.floor(p.audioResume.ms) : 0,
      audioChunk: p.audioResume ? p.audioResume.chunkIdx : -1,
      cardIndex: typeof p.cardIndex === 'number' ? p.cardIndex : 0,
      cardMs: Number.isFinite(p.cardMs) ? p.cardMs : null,
      furthestMs: (p.audioFurthestMs && typeof p.audioFurthestMs === 'object') ? (Number(p.audioFurthestMs.ms) || 0) : (Number(p.audioFurthestMs) || 0),
      readChunk: -1, readJpOff: 0, epubName: '',
      // When it was last opened on this device: the Library's "recent" order,
      // so the book you were just in is on top everywhere.
      lastOpenedAt: title.lastOpenedAt || 0,
      lastMode: title.lastMode || null,
    };
    if (readSyncable(title) && p.readBookmark && p.readBookmark.epubName === a.epub.name) {
      out.readChunk = p.readBookmark.chunkIdx;
      out.epubName = a.epub.name;
      try {
        const lc = window.pagedGetReadChunkLive?.();
        if (lc && lc.bookName === a.epub.name && lc.chunkIdx === out.readChunk) out.readJpOff = lc.jpOff || 0;
      } catch (_) {}
    }
    return out;
  }

  const _lastPushed = {};   // syncId → signature
  async function push(titleId, why) {
    if (!kc()?.supported || !L()) return false;
    const t = await ts()?.get(titleId);
    if (!t || !t.syncId || !L().isPublished(t)) return false;
    const s = await snapshot(t);
    if (!s) return false;
    const sig = JSON.stringify(s);
    if (_lastPushed[t.syncId] === sig) return false;
    try {
      await kc().writeJSON(`${LIB}/${t.syncId}/state/${deviceId()}.json`,
        Object.assign({ v: 1, device: deviceId(), deviceName: deviceName(), ts: Date.now() }, s));
      _lastPushed[t.syncId] = sig;
      log('pushed ' + t.name + ' (' + (why || '') + ') audio=' + s.audioMs + ' read=' + s.readChunk + ' card=' + s.cardIndex);
      return true;
    } catch (e) { log('push failed: ' + (e?.message || e)); return false; }
  }

  // ---- other devices' state --------------------------------------------------
  /** The furthest position across other devices for one Title: {audio, read, card, furthestMs}. */
  async function remoteBest(title, entries) {
    const sid = title.syncId;
    const own = `${LIB}/${sid}/state/${deviceId()}.json`;
    const files = (entries || await kc().list(`${LIB}/${sid}/state`).catch(() => []))
      .filter(e => !e.isDir && /\.json$/.test(e.path) && e.path !== own);
    const best = { audio: null, read: null, card: null, furthestMs: 0, newest: 0, lastOpenedAt: 0, lastMode: null };
    const a = title.attachments || {};
    for (const f of files) {
      let st;
      try { st = await kc().readJSON(f.path, 8000); } catch (_) { continue; }
      if (!st || st.v !== 1) continue;
      best.newest = Math.max(best.newest, f.mtime || 0);
      const who = st.deviceName || 'another device';
      if (st.audioMs > 0 && (!best.audio || st.audioMs > best.audio.ms)) best.audio = { ms: st.audioMs, chunkIdx: st.audioChunk, ts: st.ts || 0, who };
      if (readSyncable(title) && st.epubName === a.epub.name && st.readChunk >= 0 && (!best.read || st.readChunk > best.read.chunkIdx)) {
        best.read = { chunkIdx: st.readChunk, jpOff: st.readJpOff || 0, who };
      }
      if (typeof st.cardIndex === 'number') {
        // Compare by TIME when both have one: auto-transcribed titles' cue
        // indices differ between devices, their times don't.
        const ahead = !best.card || (Number.isFinite(st.cardMs) && Number.isFinite(best.card.ms) ? st.cardMs > best.card.ms : st.cardIndex > best.card.index);
        if (ahead) best.card = { index: st.cardIndex, ms: Number.isFinite(st.cardMs) ? st.cardMs : null, who };
      }
      const fm = (st.furthestMs && typeof st.furthestMs === 'object') ? Number(st.furthestMs.ms) || 0 : Number(st.furthestMs) || 0;
      if (fm > best.furthestMs) best.furthestMs = fm;
      if (st.lastOpenedAt > best.lastOpenedAt) { best.lastOpenedAt = st.lastOpenedAt; best.lastMode = st.lastMode || null; }
    }
    return best;
  }

  /** Newer "last opened" from another device → this Title sorts to the top here too. */
  async function adoptRecency(title, best) {
    if (!(best.lastOpenedAt > (title.lastOpenedAt || 0))) return false;
    if (best.lastOpenedAt > Date.now() + 60000) return false;   // clock skew guard
    const patch = { lastOpenedAt: best.lastOpenedAt };
    // Opens in the mode you were last in on that device (card / read / audio).
    if (best.lastMode && !isOpenHere(title.id)) patch.lastMode = best.lastMode;
    await ts().update(title.id, patch);
    log('recency for ' + title.name + ' ← ' + new Date(best.lastOpenedAt).toLocaleString());
    return true;
  }

  /** Move a closed Title's saved positions forward. Never backward. */
  async function adoptForward(title, best) {
    const changed = [];
    const dn = title.name || '';
    if (best.audio && dn) {
      const localMs = parseInt(await prefGet(AUDIO_POS + dn), 10) || 0;
      if (best.audio.ms > localMs) {
        await prefSet(AUDIO_POS + dn, best.audio.ms);
        if (best.audio.chunkIdx >= 0) await prefSet(AUDIO_CHUNK + dn, best.audio.chunkIdx);
        if (best.audio.ts > 0) await prefSet(AUDIO_TS + dn, best.audio.ts);   // when it was last heard (smart rewind)
        changed.push('audio ' + fmtMs(localMs) + '→' + fmtMs(best.audio.ms));
      }
    }
    const en = title.attachments?.epub?.name;
    if (best.read && en) {
      const localCi = parseInt(await prefGet(READ_BM + en), 10);
      if (best.read.chunkIdx > (Number.isFinite(localCi) ? localCi : -1)) {
        await prefSet(READ_BM + en, String(best.read.chunkIdx));
        changed.push('read ' + localCi + '→' + best.read.chunkIdx);
      }
    }
    if (best.card) {
      const lc = typeof title.lastCardIndex === 'number' ? title.lastCardIndex : 0;
      const lms = Number.isFinite(title.lastCardMs) ? title.lastCardMs : null;
      const ahead = (Number.isFinite(best.card.ms) && lms != null) ? best.card.ms > lms : best.card.index > lc;
      if (ahead) {
        const patch = { lastCardIndex: best.card.index };
        if (Number.isFinite(best.card.ms)) patch.lastCardMs = best.card.ms;
        await ts().update(title.id, patch);
        changed.push('card ' + lc + '→' + best.card.index + (Number.isFinite(best.card.ms) ? ' @' + fmtMs(best.card.ms) : ''));
      }
    }
    if (best.furthestMs && window.bookmarks?.updateFurthest) { try { window.bookmarks.updateFurthest(title.id, best.furthestMs); } catch (_) {} }
    if (changed.length) log('adopted for ' + title.name + ': ' + changed.join(', '));
    return changed.length > 0;
  }

  // ---- the open Title: offer, never move ------------------------------------
  function liveAudioMs(title) {
    try {
      if (title.attachments?.audiobook && window.abEngineOwnsActiveDeck?.()) {
        const ap = window.getAudioProgress?.();
        if (ap && ap.ms > 0) return ap.ms;
      }
    } catch (_) {}
    return null;
  }
  function liveReadChunk(title) {
    try {
      const en = title.attachments?.epub?.name;
      const lc = window.pagedGetReadChunkLive?.() || window.pagedGetReadLocation?.();
      if (lc && en && lc.bookName === en && lc.chunkIdx >= 0) return lc.chunkIdx;
    } catch (_) {}
    return null;
  }
  // Audio time of the card on screen (SRT/auto cards only).
  function liveCardMs() {
    try {
      if (!Number.isFinite(window.currentCardIndex)) return null;
      const cue = window._srtCardToCueAnchor ? window._srtCardToCueAnchor(window.currentCardIndex) : window.currentCardIndex;
      const ms = window._srtAnchorMsFor ? window._srtAnchorMsFor(cue) : null;
      return Number.isFinite(ms) ? ms : null;
    } catch (_) { return null; }
  }
  // Card holding a given audio time, or -1 when this device's subtitles
  // don't reach it yet.
  function cardAtMs(ms) {
    const cues = window._srtCues;
    if (!Array.isArray(cues) || !cues.length) return -1;
    if ((cues[cues.length - 1].endMs || cues[cues.length - 1].startMs) < ms - 60000) return -1;
    let lo = 0, hi = cues.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cues[mid].startMs <= ms) lo = mid; else hi = mid - 1; }
    const map = window._srtCueToCard;
    return map ? (map[lo] ?? -1) : lo;
  }

  async function maybeOffer(title, best) {
    if (best.furthestMs && window.bookmarks?.updateFurthest) { try { window.bookmarks.updateFurthest(title.id, best.furthestMs); } catch (_) {} }
    const readMode = document.body.classList.contains('mode-read');
    const cardMode = document.body.classList.contains('mode-card');
    let offer = null;
    const cms = cardMode ? liveCardMs() : null;
    const ams = liveAudioMs(title);
    const rc = liveReadChunk(title);
    if (cardMode && best.card && Number.isFinite(best.card.ms) && cms != null && best.card.ms >= cms + AHEAD_AUDIO_MS) {
      offer = { kind: 'card', who: best.card.who, key: 'c' + Math.floor(best.card.ms / 10000), label: fmtMs(best.card.ms) + ' (' + T('icloud.here', 'here') + ' ' + fmtMs(cms) + ')' };
    } else if (readMode && best.read && rc != null && best.read.chunkIdx >= rc + AHEAD_READ_CHUNKS) {
      offer = { kind: 'read', who: best.read.who, key: 'r' + best.read.chunkIdx, label: T('icloud.ahead_read', 'Further on in the book') };
    } else if (best.audio && ams != null && best.audio.ms >= ams + AHEAD_AUDIO_MS) {
      offer = { kind: 'audio', who: best.audio.who, key: 'a' + Math.floor(best.audio.ms / 10000), label: fmtMs(best.audio.ms) + ' (' + T('icloud.here', 'here') + ' ' + fmtMs(ams) + ')' };
    }
    if (!offer) return;
    const offered = jget(OFFERED_KEY, {});
    const k = title.syncId + ':' + offer.kind;
    if (offered[k] === offer.key) return;   // already offered this exact spot
    offered[k] = offer.key; jset(OFFERED_KEY, offered);
    showOffer(title, best, offer);
  }

  function showOffer(title, best, offer) {
    document.getElementById('icloudPosOffer')?.remove();
    const ov = document.createElement('div');
    ov.id = 'icloudPosOffer';
    ov.className = 'kai-modal';   // card/reader gestures bail under it (app.js inModal)
    ov.style.cssText = 'position:fixed;inset:0;z-index:9800;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;justify-content:center;padding:20px 16px calc(28px + env(safe-area-inset-bottom));';
    for (const ev of ['touchstart', 'touchmove', 'touchend']) ov.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--panel-elev,#1e1e22);color:var(--text,#eee);border:1px solid var(--border,#333);border-radius:14px;padding:16px;width:min(420px,100%);font-family:var(--font-sans,system-ui);box-shadow:0 10px 30px rgba(0,0,0,.5);';
    const h = document.createElement('div');
    h.style.cssText = 'font-weight:700;margin-bottom:4px;';
    h.textContent = T('icloud.ahead_title', 'Further on, on your {device}').replace('{device}', offer.who);
    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:.85rem;color:var(--text-faint,#aaa);margin-bottom:14px;';
    sub.textContent = offer.label;
    const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';
    const btn = (label, primary, fn) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
      b.style.cssText = 'border-radius:9px;padding:9px 16px;font:600 .9rem var(--font-sans,system-ui);cursor:pointer;border:1px solid var(--border,#444);' +
        (primary ? 'background:var(--accent-read,#4caf50);color:#fff;border-color:transparent;' : 'background:transparent;color:inherit;');
      b.addEventListener('click', (e) => { e.stopPropagation(); ov.remove(); fn && fn(); });
      return b;
    };
    row.append(btn(T('icloud.stay', 'Stay here'), false), btn(T('icloud.jump', 'Jump there'), true, () => jump(title, best, offer)));
    box.append(h, sub, row);
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
    ov.appendChild(box);
    document.body.appendChild(ov);
  }

  async function jump(title, best, offer) {
    // Re-check: the user may have switched titles while the offer was up.
    if (!isOpenHere(title.id)) return;
    try {
      if (offer.kind === 'audio' && best.audio && typeof window.jumpAudioToMs === 'function') {
        await window.jumpAudioToMs(best.audio.ms);
        log('jumped audio to ' + fmtMs(best.audio.ms) + ' (from ' + offer.who + ')');
      } else if (offer.kind === 'card' && best.card) {
        const ci = cardAtMs(best.card.ms);
        if (ci < 0) { try { window.showToast?.(T('icloud.not_transcribed', 'This device hasn’t transcribed that far yet.'), 3000); } catch (_) {} return; }
        try { window.abMarkUserNav?.(); } catch (_) {}
        window.updateCardIndex?.(ci);
        log('jumped card to ' + ci + ' @' + fmtMs(best.card.ms) + ' (from ' + offer.who + ')');
      } else if (offer.kind === 'read' && best.read && typeof window.pagedJumpToBookmark === 'function') {
        await window.pagedJumpToBookmark({ chunkIdx: best.read.chunkIdx, jpOff: best.read.jpOff, bookName: title.attachments.epub.name });
        log('jumped read to chunk ' + best.read.chunkIdx + ' (from ' + offer.who + ')');
      }
    } catch (e) { log('jump failed: ' + (e?.message || e)); }
  }

  // ---- pulls ------------------------------------------------------------------
  let _pulling = null;
  async function pullAll(reason) {
    if (_pulling) return _pulling;
    _pulling = (async () => {
      if (!kc()?.supported || !L() || !(await L().available())) return;
      let entries;
      try { entries = await kc().list(LIB, true); } catch (_) { return; }
      const own = deviceId();
      const bySid = {};
      for (const e of entries) {
        const m = !e.isDir && /^Library\/([^/]+)\/state\/([^/]+)\.json$/.exec(e.path);
        if (!m || m[2] === own) continue;
        (bySid[m[1]] = bySid[m[1]] || []).push(e);
      }
      const seen = jget(SEEN_KEY, {});
      let dirty = false;
      for (const sid of Object.keys(bySid)) {
        const files = bySid[sid];
        const isNew = files.some(f => !seen[f.path] || seen[f.path] < (f.mtime || 0));
        const title = await ts().findBySyncId(sid);
        if (!title || !L().isPublished(title)) continue;
        const open = isOpenHere(title.id) || window._titleSwitchInFlight;
        if (!isNew && !open) continue;
        const best = await remoteBest(title, files);
        if (await adoptRecency(title, best)) dirty = true;
        const t2 = (await ts().get(title.id)) || title;
        if (open) { if (!window._titleSwitchInFlight) await maybeOffer(t2, best); }
        else if (await adoptForward(t2, best)) dirty = true;
        for (const f of files) seen[f.path] = f.mtime || Date.now();
      }
      jset(SEEN_KEY, seen);
      if (dirty) {
        try { if (typeof window.populateLibrary === 'function' && document.getElementById('libraryPage')?.offsetParent) window.populateLibrary(); } catch (_) {}
        try { window.__kadokiLibRefreshNative?.(); } catch (_) {}
      }
      log('pull (' + (reason || '') + ') done');
    })().catch((e) => log('pull failed: ' + (e?.message || e))).finally(() => { _pulling = null; });
    return _pulling;
  }

  /**
   * Called by loadTitleFromLibrary before a Title loads: bring its saved
   * positions up to the furthest device. Bounded — a slow iCloud never holds
   * up the open for more than ~2.5 s.
   */
  async function beforeOpen(title) {
    if (!title || !title.syncId || !kc()?.supported || !L()?.isPublished(title)) return false;
    if (title.id === window._loadedContentTitleId) {
      // Already live: its place is the user's — never moved. Picking it in the
      // Library again is a fresh ask, so check now and allow the offer again.
      const offered = jget(OFFERED_KEY, {});
      for (const k of Object.keys(offered)) if (k.startsWith(title.syncId + ':')) delete offered[k];
      jset(OFFERED_KEY, offered);
      pullSoon('reopen', 2500);
      return false;
    }
    const work = (async () => {
      const best = await remoteBest(title);
      const fresh = (await ts().get(title.id)) || title;
      return adoptForward(fresh, best);
    })();
    const timeout = new Promise(r => setTimeout(() => r(false), 2500));
    try { return await Promise.race([work, timeout]); } catch (_) { return false; }
  }

  // ---- triggers ---------------------------------------------------------------
  let _lastActive = null, _pullTimer = null;
  function pullSoon(reason, ms) {
    clearTimeout(_pullTimer);
    _pullTimer = setTimeout(() => pullAll(reason), ms == null ? 1500 : ms);
  }
  function tick(why) {
    const cur = window._activeTitleId || null;
    if (_lastActive && _lastActive !== cur) push(_lastActive, 'switched away');
    _lastActive = cur;
    if (cur && !window._titleSwitchInFlight) push(cur, why);
  }

  function boot() {
    if (!kc() || !kc().supported) return;   // Android / web: Drive sync instead
    setInterval(() => tick('timer'), PUSH_EVERY_MS);
    // A title just opened: tell the other devices within seconds, so it's on
    // top of their Library by the time you pick one up.
    setInterval(() => {
      const cur = window._activeTitleId || null;
      if (cur !== _lastActive && !window._titleSwitchInFlight) tick('opened');
    }, 5000);
    pullSoon('boot', 6000);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) tick('background');
      else pullSoon('resume', 1500);
    });
    // Mac: switching to another app and back doesn't hide the page.
    window.addEventListener('focus', () => pullSoon('focus', 800));
    kc().onChange((ev) => {
      const paths = (ev && ev.changed || []).map(c => c.path || '');
      if (paths.some(p => /\/state\/[^/]+\.json$/.test(p) && !p.endsWith('/' + deviceId() + '.json'))) pullSoon('change', 1000);
    });
  }

  window.iCloudPos = { push, pullAll, beforeOpen, deviceId, deviceName, _remoteBest: remoteBest };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
