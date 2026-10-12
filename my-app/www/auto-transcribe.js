// auto-transcribe.js — on-device subtitle generation for audio-only titles.
//
// Native on both platforms via the AutoTranscribe plugin: iOS 26+ uses
// SpeechAnalyzer/SpeechTranscriber, Android uses whisper.cpp (arm64) with an
// in-app-downloaded ggml model. When a title has an audiobook but no SRT,
// reading-mode's
// abLoadContextForCurrentDeck calls activate() instead of showing the
// "missing subtitles" picker. This module then:
//
//   1. Downloads the ja_JP speech model once (system-managed asset).
//   2. Runs ONE native transcription job at a time, feed-paced to stay
//      ~10 min ahead of the playhead (a job behind the playhead — backfill —
//      naturally runs at full speed because its frontier is below target).
//   3. Streams finalized cues into the live audio-mode display via
//      window.abIngestAutoCues (append-safe: the display re-reads abCues
//      every position tick).
//   4. Persists cues + covered ranges to blobStore (AUTO_CUES_V1_<titleId>,
//      signature = audio file name|size) so partial progress survives
//      restarts and each book is only ever transcribed once.
//   5. When coverage reaches the whole file, writes a real .srt into the
//      app's data dir and attaches it to the title — from then on the title
//      is a normal audio+SRT title (card mode, Anki, sync all unchanged)
//      and this module never re-engages for it.
//
// Position safety: this module NEVER seeks or writes the playhead — it only
// reads position events for pacing. Cue-index anchors are not used while
// transcribing (card mode stays gated until the final SRT exists), so the
// growing cue list can't shift a saved place.
(function () {
  'use strict';

  // Charging / explicit unlimited mode can prepare an hour for the Watch.
  // Battery jobs use AHEAD_HIGH_MS instead; don't enqueue work we will discard.
  const LOOKAHEAD_MS = 60 * 60 * 1000;
  const CACHE_PREFIX = 'AUTO_CUES_V1_';
  const DEDUPE_MS = 300;                 // incoming cue within this of an existing start = duplicate
  const GAP_OK_MS = 2000;                // residual uncovered gap still counting as "complete"
  const SKIP_AHEAD_MIN_MS = 60 * 1000;   // re-entering covered audio ≥ this long → jump the job past it
  const MAX_JOB_RETRIES = 2;
  // ---- power policy (2026-09-12) ----
  //
  // On-device speech recognition is by far the heaviest thing the app runs.
  // Unbounded it transcribed the WHOLE book at full speed for an entire
  // session (LOOKAHEAD_MS is an hour, and reaching EOF wrapped around to
  // backfill every remaining gap from 0) — device profiling put it at the top
  // of the "why is the phone hot" list, well above anything on the JS side.
  //
  // Now the transcriber keeps a bounded BUFFER ahead of the playhead and
  // parks once it's full, so its duty cycle tracks playback instead of racing
  // it; the whole-book backfill runs only while charging; and serious thermal
  // pressure or Low Power Mode stops it outright. The user can opt back into
  // unlimited work (Preferences → Read).
  const AHEAD_HIGH_MS = 10 * 60 * 1000;   // park once this much ahead is covered
  const AHEAD_LOW_MS  =  4 * 60 * 1000;   // un-park once the buffer drains below this
  const POWER_TTL_MS  = 20000;
  let _power = { charging: false, thermal: 'nominal', lowPower: false, level: -1, at: 0 };
  let _powerBusy = false, _parked = false;
  let _nativePowerHold = false, _powerAnchorMs = 0;
  function unlimited() { try { return localStorage.getItem('AT_POWER_UNLIMITED') === '1'; } catch (_) { return false; } }
  function refreshPower(force) {
    const now = Date.now();
    if (_powerBusy || (!force && now - _power.at < POWER_TTL_MS)) return;
    _powerBusy = true;
    Promise.resolve(window.Capacitor?.Plugins?.BackgroundAudio?.powerState?.())
      .then((r) => {
        if (r) {
          _power = { charging: !!r.charging, thermal: String(r.thermal || 'nominal'), lowPower: !!r.lowPower, level: Number(r.level), at: Date.now() };
          _nativePowerHold = false;
        }
        else _power.at = Date.now();
        // Enforce the fresh snapshot even if playback is paused and no
        // position event will arrive. Native iOS has its own backstop too.
        if (active && !active.done) maybeParkForPower(powerPosition());
      })
      .catch(() => { _power.at = Date.now(); })
      .finally(() => { _powerBusy = false; });
  }
  // kind: 'ahead' (keep up with the playhead) | 'backfill' (the rest of the book)
  function powerAllows(kind) {
    if (unlimited()) return true;
    if (_nativePowerHold) return false;
    if (_power.thermal === 'serious' || _power.thermal === 'critical') return false;
    if (_power.lowPower && !_power.charging) return false;
    return kind === 'backfill' ? !!_power.charging : true;
  }
  function aheadCoveredMs(pos) {
    const a = active;
    if (!a || !(pos >= 0)) return 0;
    const r = coveringRange(a.cov || [], pos);
    return r ? Math.max(0, r[1] - pos) : 0;
  }
  function powerPosition() { return lastPosMs >= 0 ? lastPosMs : _powerAnchorMs; }
  // Check running jobs as well as parked ones. This must not depend on
  // position callbacks: recognition can run before PLAY or while paused.
  function powerTick() {
    try {
      const a = active;
      if (!a || a.done) return;
      refreshPower();
      const pos = powerPosition();
      if (job) { maybeParkForPower(pos); return; }
      if (document.hidden && !window._bgPlaying) return;
      if (!_parked) return;
      if (!powerAllows('backfill') && !(aheadCoveredMs(pos) < AHEAD_LOW_MS && powerAllows('ahead'))) return;
      lastEnsureAt = 0;   // bypass the 2 s throttle for this deliberate retry
      ensureJob(pos);
    } catch (_) {}
  }
  setInterval(powerTick, 5000);

  function powerInfo() {
    return { charging: _power.charging, thermal: _power.thermal, lowPower: _power.lowPower, parked: _parked && !job, stopping: !!job?.stopping, unlimited: unlimited(),
             aheadMs: aheadCoveredMs(lastPosMs >= 0 ? lastPosMs : 0) };
  }

  const plugin = () => window.Capacitor?.Plugins?.AutoTranscribe;
  // Native transcription exists on BOTH platforms now: iOS = SpeechAnalyzer,
  // Android = whisper.cpp (AutoTranscribePlugin.java). Same plugin contract.
  // Any other shell (macOS) that installs an AutoTranscribe plugin with this
  // contract qualifies by presence.
  const hasNativeTranscribe = () => {
    const p = window.Capacitor?.getPlatform?.();
    return p === 'ios' || p === 'android' || !!plugin();
  };
  const t = (k, fb, v) => (window.i18n?.t ? window.i18n.t(k, fb, v) : fb);
  const log = (m) => { try { console.log('[autoTrans] ' + m); } catch (_) {} };
  const diag = (m) => { try { window._diag?.('[paged-diag][autoTrans] ' + m); } catch (_) {} };

  const avail = { supported: false, installed: false };
  let availPromise = null;

  let active = null;   // { titleId, audioPath, audioName, sig, durationMs, cues, cov, done, retries }
  let job = null;      // { id, startMs, fedThroughMs }
  let jobSeq = 0;
  let lastPosMs = -1;
  let xcribeRate = 0;   // measured audio-ms per wall-ms of the native transcriber (0 = unknown)
  let lastTargetSentAt = 0;
  let lastEnsureAt = 0;
  let persistTimer = null;
  let listenersAttached = false;
  let pendingRestartMs = null;
  let sweepTimer = null;
  let sweepBusy = false;

  // ── availability ──────────────────────────────────────────────────────────

  function checkAvail() {
    if (availPromise) return availPromise;
    availPromise = (async () => {
      const p = plugin();
      if (!p || !hasNativeTranscribe()) return avail;
      try {
        const r = await p.checkAvailability();
        avail.supported = !!r?.supported;
        avail.installed = !!r?.installed;
        log('availability supported=' + avail.supported + ' installed=' + avail.installed);
      } catch (e) {
        log('checkAvailability failed: ' + (e?.message || e));
      }
      return avail;
    })();
    return availPromise;
  }

  async function available() {
    const a = await checkAvail();
    return !!a.supported;
  }

  // ── coverage ranges (sorted, merged [startMs, endMs] pairs) ───────────────

  function addRange(cov, s, e) {
    if (!(e > s)) return cov;
    cov.push([Math.max(0, Math.floor(s)), Math.floor(e)]);
    cov.sort((a, b) => a[0] - b[0]);
    const out = [cov[0]];
    for (let i = 1; i < cov.length; i++) {
      const last = out[out.length - 1];
      if (cov[i][0] <= last[1] + GAP_OK_MS) last[1] = Math.max(last[1], cov[i][1]);
      else out.push(cov[i]);
    }
    return out;
  }
  function coveringRange(cov, ms) {
    for (const r of cov) if (ms >= r[0] - 1000 && ms < r[1]) return r;
    return null;
  }
  // First uncovered position at/after ms (skips past a covering range).
  function nextUncovered(cov, ms) {
    let p = Math.max(0, ms);
    for (const r of cov) {
      if (p >= r[0] - 1000 && p < r[1]) p = r[1];
    }
    return p;
  }
  // cov minus cuts (both sorted [s,e] lists) — used by the word-timing
  // retrofit to reopen spans transcribed before the karaoke feature.
  function subtractRanges(cov, cuts) {
    let out = cov.map(r => r.slice());
    for (const c of cuts) {
      const next = [];
      for (const r of out) {
        if (c[1] <= r[0] || c[0] >= r[1]) { next.push(r); continue; }
        if (c[0] > r[0]) next.push([r[0], c[0]]);
        if (c[1] < r[1]) next.push([c[1], r[1]]);
      }
      out = next;
    }
    return out;
  }
  // Merged time spans of cues that carry no word timings (pre-karaoke cache).
  function wlessRanges(cues) {
    const out = [];
    for (const c of cues) {
      if (c.w) continue;
      const s = Math.max(0, c.startMs - 500), e = c.endMs + 500;
      if (out.length && s <= out[out.length - 1][1] + 2000) {
        out[out.length - 1][1] = Math.max(out[out.length - 1][1], e);
      } else out.push([s, e]);
    }
    return out;
  }

  function isFullyCovered(cov, durMs) {
    if (!(durMs > 0) || !cov.length) return false;
    if (cov[0][0] > GAP_OK_MS) return false;
    for (let i = 1; i < cov.length; i++) {
      if (cov[i][0] - cov[i - 1][1] > GAP_OK_MS) return false;
    }
    return cov[cov.length - 1][1] >= durMs - GAP_OK_MS - 500;
  }

  // ── status line (audio-mode cue area, only while no cues are rendered) ───

  function setStatus(text) {
    if (!window.audiobookActive) return;
    if (active && active.timingOnly) return;   // timing-only: the SRT owns the display, always
    const cues = active?.cues;
    if (cues && cues.length) return;   // real cues own the display
    const el = document.getElementById('audiobookCueText');
    if (el) el.textContent = text;
  }

  // ── persistence ───────────────────────────────────────────────────────────

  function schedulePersist(immediate) {
    if (!active) return;
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    if (immediate) { persistNow(); return; }
    persistTimer = setTimeout(persistNow, 5000);
  }
  function persistNow() {
    persistTimer = null;
    const a = active;
    if (!a || !a.titleId || !window.blobStore?.set) return;
    // Card-position TIME anchor: cue indices shift when backfill inserts
    // earlier cues, so the restore path re-anchors by audiobookStartMs.
    if (window._srtAutoLive === a.titleId) {
      const n = window.allNotes?.[window.currentCardIndex];
      if (n && Number.isFinite(n.audiobookStartMs)) a.cardAnchorMs = n.audiobookStartMs;
    }
    try {
      window.blobStore.set(CACHE_PREFIX + a.titleId, JSON.stringify({
        sig: a.sig, durMs: a.durationMs || 0, cov: a.cov,
        cardAnchorMs: Number.isFinite(a.cardAnchorMs) ? a.cardAnchorMs : null,
        // b:1 = text is matched book text (auto-align) — never re-matched.
        // w = cue-relative word-timing quads (karaoke highlighting).
        cues: a.cues.map(c => {
          const o = { startMs: c.startMs, endMs: c.endMs, text: c.text };
          if (c.b) o.b = 1;
          if (c.w) o.w = c.w;
          return o;
        })
      }));
    } catch (e) { log('persist failed: ' + (e?.message || e)); }
  }

  // ── shared cache/sig helpers + cold snapshot for the card loader ─────────

  async function computeSig(audioPath, audioName) {
    let sizeBytes = 0;
    try {
      const fs = window.Capacitor?.Plugins?.Filesystem;
      const st = await fs?.stat({ path: audioPath.indexOf('file://') === 0 ? audioPath : 'file://' + audioPath });
      if (st && st.size > 0) sizeBytes = st.size;
    } catch (_) {}
    const nameOnly = (audioName || audioPath).split('/').pop();
    return nameOnly + '|' + sizeBytes;
  }
  async function loadCacheObj(titleId) {
    try {
      const raw = await window.blobStore?.get(CACHE_PREFIX + titleId);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }
  function normalizeCues(arr) {
    const cues = (arr || [])
      .filter(c => Number.isFinite(c.startMs) && Number.isFinite(c.endMs) && c.text)
      .sort((x, y) => x.startMs - y.startMs);
    cues.forEach((c, i) => { c.index = i; });
    return cues;
  }
  // sig match with stat-failure tolerance: when either side carries size 0
  // (Filesystem.stat transiently failed) fall back to name-only matching.
  // A failed stat must never read as "different audio file" — that silently
  // wiped the whole cue cache view (blank card mode).
  function sigMatches(cacheSig, liveSig) {
    if (!cacheSig || !liveSig) return false;
    if (cacheSig === liveSig) return true;
    const [cn, cs] = String(cacheSig).split('|');
    const [ln, ls] = String(liveSig).split('|');
    if (cn === ln) return cs === '0' || ls === '0';
    // Different NAME but the same nonzero byte size: the same audio under a
    // new name (re-import, Drive sync rename, re-materialized cache file).
    // For a multi-hundred-MB audiobook the size is the stronger identity —
    // refusing here is how a full first-pass transcription got discarded
    // (incident 2026-08-26: hours of cues lost to a start-from-scratch).
    return !!(cs && ls && cs !== '0' && cs === ls);
  }

  // Cue snapshot for loadTitleAsSrtCards: the LIVE list when transcribing
  // this title, else the sig-checked persistent cache.
  async function getCuesSnapshot(titleId, audioPath, audioName) {
    if (active && active.titleId === titleId) {
      return { cues: active.cues, cardAnchorMs: Number.isFinite(active.cardAnchorMs) ? active.cardAnchorMs : null };
    }
    const sig = await computeSig(audioPath, audioName);
    const obj = await loadCacheObj(titleId);
    if (obj && sigMatches(obj.sig, sig) && Array.isArray(obj.cues) && obj.cues.length) {
      // Cold load (no live transcription): phrase-split for display. The
      // aligner is not running here, so unmatched cues can split too.
      const view = { cues: normalizeCues(obj.cues), hasBookText: false };
      if (splitLongCues(view)) view.cues.forEach((c, i) => { c.index = i; });
      return { cues: view.cues, cardAnchorMs: Number.isFinite(obj.cardAnchorMs) ? obj.cardAnchorMs : null };
    }
    if (obj) log('snapshot sig mismatch: cache=' + obj.sig + ' live=' + sig);
    return { cues: [], cardAnchorMs: null };
  }
  // Full audio duration for a title (ms) — live value when transcribing,
  // else the persisted cache. 0 when unknown.
  async function durationFor(titleId) {
    let ms = 0;
    if (active && active.titleId === titleId && active.durationMs > 0) ms = active.durationMs;
    else {
      const obj = await loadCacheObj(titleId);
      ms = (obj && obj.durMs > 0) ? obj.durMs : 0;
    }
    // Warm the SYNC duration cache every consumer of the guard reads.
    try { if (ms > 0) window._abKnownDur = { tid: titleId, ms: Math.floor(ms) }; } catch (_) {}
    return ms;
  }

  // Stable AI-map fingerprint for auto-transcribed titles: keyed to the AUDIO
  // file, not the (growing) cue list, so chapter artifacts survive both live
  // growth and the final SRT attach. Null when this title has no auto cache.
  async function stableFp(titleId) {
    if (active && active.titleId === titleId && active.sig) return 'autocues|' + active.sig;
    const obj = await loadCacheObj(titleId);
    return (obj && obj.sig) ? 'autocues|' + obj.sig : null;
  }

  // ── m4b chapter markers (native AVAsset read, cached per title) ──────────

  const chapterCache = {};
  async function getAudioChapters(titleId, audioPath) {
    const key = titleId || ('path:' + audioPath);
    if (key in chapterCache) return chapterCache[key];
    let out = [];
    try {
      const p = plugin();
      let src = audioPath || null;
      if (!src && active && active.titleId === titleId) src = active.audioPath;
      if (!src && titleId && window.titleStore) {
        const t = (await window.titleStore.list()).find(x => x.id === titleId);
        src = t?.attachments?.audiobook?.cachePath || null;
      }
      if (p && src && hasNativeTranscribe()) {
        const r = await p.getChapters({ srcPath: src });
        if (Array.isArray(r?.chapters)) {
          out = r.chapters
            .filter(c => Number.isFinite(c.startMs) && c.startMs >= 0)
            .map(c => ({ startMs: Math.floor(c.startMs), title: String(c.title || '').trim() }))
            .sort((x, y) => x.startMs - y.startMs);
        }
      }
    } catch (e) { log('getChapters failed: ' + (e?.message || e)); }
    chapterCache[key] = out;
    return out;
  }

  // ── live card + AI-map refresh (throttled) ───────────────────────────────

  let cardRefreshTimer = null;
  function scheduleCardRefresh() {
    if (cardRefreshTimer) return;
    cardRefreshTimer = setTimeout(() => {
      cardRefreshTimer = null;
      const a = active;
      if (!a) return;
      if (window._srtAutoLive === a.titleId) {
        try { window._refreshAutoSrtCards?.(a.cues); } catch (_) {}
      } else {
        // Fresh audio-only title: cards weren't built at open (0 cues then).
        try { window._bootstrapAutoSrtCards?.(a.titleId, a.cues, a.audioPath); } catch (_) {}
      }
      try { window.aiChunks?.refreshCueMap?.(a.titleId); } catch (_) {}
      // Growing synthetic book: create it as soon as enough text exists (the
      // READ tab lights up mid-transcription) and rebuild it as the text
      // grows. Append-only, so reader positions stay valid across reloads.
      buildSyntheticEpub(a.titleId, { minCues: 50, minGrowth: 60 }).catch(() => {});
    }, 10000);
  }

  // ── word timings (karaoke highlighting) ──────────────────────────────────
  //
  // Native cues carry `w`: flat [off, len, startMs, endMs] quads per
  // recognizer token (offsets UTF-16 into cue text, times absolute file ms).
  // Stored cue-RELATIVE (times minus cue.startMs) so splitting/persisting
  // never rewrites them. When book-text alignment substitutes the text, the
  // matcher's wmap projects each token's char span onto the new text.

  function normW(raw, cueStartMs) {
    if (!Array.isArray(raw) || !raw.length || raw.length % 4) return null;
    const w = [];
    for (let i = 0; i + 3 < raw.length; i += 4) {
      const len = raw[i + 1] | 0;
      if (len <= 0) continue;
      w.push(raw[i] | 0, len,
        Math.max(0, Math.round(raw[i + 2] - cueStartMs)),
        Math.max(0, Math.round(raw[i + 3] - cueStartMs)));
    }
    return w.length ? w : null;
  }

  // Post-finalize enrichment: SRT-parsed cue lists have no word data, but the
  // AUTO_CUES cache (which generated that SRT) does. Copies `w` onto cues
  // matching by start time + text. Mutates in place; returns count copied.
  async function enrichWordTimes(titleId, cues) {
    if (!titleId || !Array.isArray(cues) || !cues.length) return 0;
    const src = (active && active.titleId === titleId)
      ? { cues: active.cues } : await loadCacheObj(titleId);
    if (!src || !Array.isArray(src.cues) || !src.cues.length) return 0;
    const list = src.cues;
    let j = 0, n = 0;
    for (const c of cues) {
      if (!c || c.w || !Number.isFinite(c.startMs)) continue;
      while (j < list.length && list[j].startMs < c.startMs - 150) j++;
      const s = list[j];
      if (s && Math.abs(s.startMs - c.startMs) <= 150 && s.w && s.text === c.text) { c.w = s.w; n++; }
    }
    if (n) log('word times enriched onto ' + n + ' cues');
    return n;
  }

  // ── phrase splitting (subtitle length) ───────────────────────────────────
  //
  // The native splitter emits sentence-grained cues (soft 42 chars). For
  // follow-along reading, comma-grained phrases are easier — so cues whose
  // TEXT is final (book-matched, or plain ASR on a title with no book text
  // to match) are re-split at 、/。 boundaries with duration allocated by
  // char share. Cues still awaiting alignment stay whole: the matcher works
  // best on the full sentence, and its book text then splits with the
  // book's own punctuation. Preferences toggle KADOKI_AT_PHRASE (default on).

  const PHRASE_TRIGGER = 26;   // only split cues longer than this (raw chars)
  const PHRASE_MIN = 9;        // no piece shorter than this

  const phraseOn = () => {
    try { return localStorage.getItem('KADOKI_AT_PHRASE') !== '0'; } catch (_) { return true; }
  };

  function splitCuePhrases(cue) {
    const text = cue.text || '';
    if (text.length <= PHRASE_TRIGGER) return [cue];
    // Candidate break points AFTER punctuation, keeping closing brackets
    // attached to the piece they end.
    const pts = [];
    for (let i = 0; i < text.length - 1; i++) {
      if ('、，。．！？!?…'.indexOf(text[i]) >= 0) {
        let j = i;
        while (j + 1 < text.length && '」』）"\''.indexOf(text[j + 1]) >= 0) j++;
        if (j + 1 < text.length) pts.push(j + 1);
        i = j;
      }
    }
    const pieces = [];
    let start = 0;
    for (const p of pts) {
      if (p - start >= PHRASE_MIN && text.length - p >= PHRASE_MIN) {
        pieces.push(text.slice(start, p));
        start = p;
      }
    }
    pieces.push(text.slice(start));
    if (pieces.length < 2) return [cue];
    const total = pieces.reduce((s, p) => s + p.length, 0);
    const dur = cue.endMs - cue.startMs;
    const w = (Array.isArray(cue.w) && cue.w.length % 4 === 0) ? cue.w : null;
    const out = [];
    let t = cue.startMs;
    let off = 0;
    for (let k = 0; k < pieces.length; k++) {
      const a = off, b = off + pieces[k].length;
      off = b;
      // Piece bounds: exact word-boundary times when the cue carries word
      // timings (start of first token in the piece, end of the last), else
      // duration split by char share.
      let s = t;
      let e = (k === pieces.length - 1) ? cue.endMs : Math.round(t + dur * (pieces[k].length / total));
      const pw = [];
      if (w) {
        let firstRel = -1, lastRel = -1;
        for (let i = 0; i + 3 < w.length; i += 4) {
          const wa = w[i], wb = w[i] + w[i + 1];
          if (wb <= a || wa >= b) continue;
          const na = Math.max(0, wa - a);
          const nb = Math.min(pieces[k].length, wb - a);
          if (nb <= na) continue;
          pw.push(na, nb, w[i + 2], w[i + 3]);   // nb kept as END for the rebase below
          if (firstRel < 0) firstRel = w[i + 2];
          lastRel = w[i + 3];
        }
        if (firstRel >= 0 && k > 0) s = Math.max(t, cue.startMs + firstRel);
        if (lastRel >= 0 && k < pieces.length - 1) e = Math.max(s + 150, cue.startMs + lastRel);
      }
      if (e <= s) e = s + Math.max(150, Math.round(dur / pieces.length));
      if (k === pieces.length - 1 && cue.endMs > s) e = cue.endMs;
      const piece = { index: 0, startMs: Math.round(s), endMs: Math.round(e), text: pieces[k], b: cue.b ? 1 : 0 };
      if (pw.length) {
        // Rebase quads: [off, END, absRelS, absRelE] → [off, len, relS, relE]
        // relative to the piece's own startMs.
        const shift = piece.startMs - cue.startMs;
        const fw = [];
        for (let i = 0; i + 3 < pw.length; i += 4) {
          fw.push(pw[i], pw[i + 1] - pw[i],
            Math.max(0, pw[i + 2] - shift), Math.max(0, pw[i + 3] - shift));
        }
        piece.w = fw;
      }
      out.push(piece);
      t = e;
    }
    return out;
  }

  // Split every final-text cue in the active list in place. Returns how many
  // cues were split (caller reindexes/refreshes). Idempotent: pieces come out
  // under PHRASE_TRIGGER or without internal break points.
  function splitLongCues(a) {
    if (!phraseOn()) return 0;
    let changed = 0;
    for (let i = 0; i < a.cues.length; i++) {
      const c = a.cues[i];
      if (a.hasBookText && !c.b) continue;   // aligner needs the whole sentence
      const pieces = splitCuePhrases(c);
      if (pieces.length > 1) {
        a.cues.splice(i, 1, ...pieces);
        i += pieces.length - 1;
        changed++;
      }
    }
    if (changed) a.cues.forEach((c, idx) => { c.index = idx; });
    return changed;
  }

  // ── book-text alignment (auto-align.js) ──────────────────────────────────
  //
  // When the title also carries an EPUB/TXT read source, each merged cue's
  // ASR text is replaced with the fuzzy-matched passage from the book
  // (cue.b = 1). Cues that miss (aligner not ready yet, sparse anchors)
  // are re-tried by a debounced sweep — auto-align tightens its windows as
  // anchors accumulate, so late passes recover early misses.

  function scheduleSweep() {
    if (sweepTimer || !active) return;
    sweepTimer = setTimeout(() => { sweepTimer = null; runAlignSweep('periodic'); }, 15000);
  }

  async function runAlignSweep(reason) {
    const a = active;
    if (!a || sweepBusy || !window.autoAlign?.readyFor?.(a.titleId)) return;
    sweepBusy = true;
    try {
      const changed = await window.autoAlign.sweep(a.cues);
      if (changed && active === a) {
        log('align sweep (' + reason + '): ' + changed + ' cues -> book text');
        splitLongCues(a);
        a.cues.forEach((c, i) => { c.index = i; });
        if (typeof window.abIngestAutoCues === 'function' && a.titleId === window._activeTitleId) {
          window.abIngestAutoCues(a.cues);   // -2 sentinel repaints the current cue
        }
        schedulePersist(false);
        scheduleCardRefresh();
      }
      // Anything still unmatched and not attempt-capped gets another chance
      // as anchors land.
      if (active === a && a.cues.some(c => !c.b && (!c._aa || c._aa.n < 5))) scheduleSweep();
    } catch (e) { log('align sweep failed: ' + (e?.message || e)); }
    finally { sweepBusy = false; }
  }

  // ── cue merge + live inject ───────────────────────────────────────────────

  function mergeCues(incoming) {
    const a = active;
    if (!a || !Array.isArray(incoming) || !incoming.length) return 0;
    const align = window.autoAlign?.readyFor?.(a.titleId) ? window.autoAlign : null;
    let added = 0, missed = 0, replaced = 0;
    for (const c of incoming) {
      const s = Math.floor(c.startMs), e = Math.floor(c.endMs);
      let text = String(c.text || '').trim();
      if (!text || !(e > s)) continue;
      // Binary search insert point on startMs.
      let lo = 0, hi = a.cues.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (a.cues[mid].startMs < s) lo = mid + 1; else hi = mid;
      }
      // Word-timing retrofit: a fresh word-timed cue supersedes the stale
      // w-less cues covering the same audio (pre-karaoke spans whose
      // coverage was reopened at adoption). Only w-less cues are ever
      // removed, and only when the incoming cue actually carries w.
      if (Array.isArray(c.w) && c.w.length) {
        while (lo < a.cues.length) {
          const x = a.cues[lo];
          if (!x.w && x.startMs >= s - DEDUPE_MS && x.endMs <= e + DEDUPE_MS) {
            a.cues.splice(lo, 1);
            replaced++;
          } else break;
        }
      }
      const near = (i) => i >= 0 && i < a.cues.length && Math.abs(a.cues[i].startMs - s) < DEDUPE_MS;
      if (near(lo) || near(lo - 1)) continue;   // duplicate from an overlapping re-feed
      let matched = 0;
      let w = normW(c.w, s);
      if (align) {
        try {
          const m = align.matchCue(text, s, { wantMap: !!w });
          if (m && m.text) {
            if (w) w = align.remapW(w, m.wmap, m.text.length);
            text = m.text;
            matched = 1;
          } else missed++;
        } catch (_) {}
      } else { missed++; }
      const cue = { index: 0, startMs: s, endMs: e, text, b: matched };
      if (w) cue.w = w;
      a.cues.splice(lo, 0, cue);
      added++;
    }
    if (added || replaced) {
      splitLongCues(a);
      a.cues.forEach((c, i) => { c.index = i; });
      if (typeof window.abIngestAutoCues === 'function' && a.titleId === window._activeTitleId) {
        window.abIngestAutoCues(a.cues);
      }
      if (missed && a.hasBookText) scheduleSweep();
    }
    return added + replaced;
  }

  // ── native job management ─────────────────────────────────────────────────

  async function startJob(startMs) {
    const a = active;
    const p = plugin();
    if (!a || a.done || !p || job) return;
    const dur = a.durationMs || 0;
    if (dur > 0 && startMs >= dur - 500) {
      // Nothing ahead — try the earliest gap (behind), or finish.
      const s2 = nextUncovered(a.cov, 0);
      if (dur > 0 && s2 >= dur - 500) { await maybeFinalize(); return; }
      startMs = s2;
    }
    // Every entry path (seek/retry/EOF as well as ensureJob) obeys power
    // policy. Previously restartAt could bypass the backfill/thermal gate.
    const pos = lastPosMs >= 0 ? lastPosMs : startMs;
    _powerAnchorMs = pos;
    const kind = startMs < pos - 10000 || startMs > pos + AHEAD_HIGH_MS || aheadCoveredMs(pos) >= AHEAD_HIGH_MS ? 'backfill' : 'ahead';
    if (!powerAllows(kind)) { _parked = true; return; }
    _parked = false;
    const id = 'j' + (++jobSeq);
    job = { id, startMs, fedThroughMs: startMs, startedAt: Date.now(), lastCuesAt: 0 };
    log('start job ' + id + ' at ' + Math.round(startMs / 1000) + 's');
    diag('start job ' + id + ' at ' + Math.round(startMs / 1000) + 's (target ' + Math.round((lastPosMs >= 0 ? lastPosMs : startMs) / 1000) + 's)');
    try {
      const r = await p.start({
        jobId: id, srcPath: a.audioPath, startMs,
        targetMs: lastPosMs >= 0 ? lastPosMs : startMs,
        aheadMs: unlimited() || _power.charging ? LOOKAHEAD_MS : AHEAD_HIGH_MS,
        powerUnlimited: unlimited()
      });
      if (active !== a || job?.id !== id) return;
      if (r?.durationMs > 0 && !(a.durationMs > 0)) a.durationMs = Math.floor(r.durationMs);
      try { if (a.durationMs > 0) window._abKnownDur = { tid: a.titleId, ms: a.durationMs }; } catch (_) {}
    } catch (e) {
      if (active !== a || job?.id !== id) return;
      log('job start failed: ' + (e?.message || e));
      diag('job start FAILED: ' + (e?.message || e) + ' retries=' + ((a.retries || 0) + 1));
      job = null;
      a.retries = (a.retries || 0) + 1;
      if (a.retries > MAX_JOB_RETRIES) {
        setStatus(t('at.failed', 'Subtitle generation failed. Reopen the title to retry.'));
        a.done = true;   // stop trying this session; cache keeps partial progress
      }
    }
  }

  function ensureJob(posMs) {
    const a = active;
    if (!a || a.done || job || a.assetsDownloading) { if (a && a.done) diag('ensureJob: title marked done'); return; }
    const now = Date.now();
    if (now - lastEnsureAt < 2000) return;
    lastEnsureAt = now;
    refreshPower();   // fire-and-forget; the snapshot below is at most POWER_TTL_MS old
    const at = Math.max(0, posMs);
    _powerAnchorMs = at;
    const start = nextUncovered(a.cov, at);
    // Work that isn't keeping the playhead supplied — a gap far ahead, or the
    // fill-the-rest pass — is backfill, and backfill needs power.
    const kind = (aheadCoveredMs(at) >= AHEAD_HIGH_MS || start > at + AHEAD_HIGH_MS) ? 'backfill' : 'ahead';
    if (!powerAllows(kind)) {
      _parked = true;
      diag('ensureJob: held (' + kind + ') thermal=' + _power.thermal + ' charging=' + _power.charging + ' lowPower=' + _power.lowPower);
      return;
    }
    _parked = false;
    startJob(start);
  }
  // Park a RUNNING job once the buffer ahead of the playhead is full (battery
  // only). Keep its identity until native teardown finishes so already
  // finalized results arriving during stop are still cached.
  function maybeParkForPower(pos) {
    if (!job || unlimited()) return false;
    if (job.stopping) return true;
    const ahead = aheadCoveredMs(pos);
    const thermal = _power.thermal === 'serious' || _power.thermal === 'critical' || (_power.lowPower && !_power.charging);
    if (!thermal && (_power.charging || ahead < AHEAD_HIGH_MS)) return false;
    diag('parking transcriber: ' + Math.round(ahead / 1000) + 's buffered, thermal=' + _power.thermal + ' charging=' + _power.charging);
    pendingRestartMs = null; _parked = true;
    requestJobStop('power');
    return true;
  }

  const STOP_TIMEOUT_MS = 20000;
  function requestJobStop(reason) {
    const j = job;
    if (!j || j.stopping) return;
    j.stopping = reason;
    // Waiting for the native 'done' is what lets late results still be kept,
    // but it must never be an unbounded wait: startJob refuses to run while a
    // job slot is occupied, so a 'done' that never arrives would wedge
    // transcription for the rest of the session.
    try { clearTimeout(j.stopTimer); } catch (_) {}
    j.stopTimer = setTimeout(() => {
      if (job !== j) return;
      diag('stop (' + reason + ') never reported done after ' + (STOP_TIMEOUT_MS / 1000) + 's — releasing the job slot');
      job = null;
      if (pendingRestartMs != null) { const t = pendingRestartMs; pendingRestartMs = null; startJob(t); }
    }, STOP_TIMEOUT_MS);
    // stop resolves before the native done event. Do not release job here.
    const failed = (e) => {
      if (job === j) { j.stopping = null; _parked = false; try { clearTimeout(j.stopTimer); } catch (_) {} }
      log('job stop failed: ' + (e?.message || e));
    };
    try { Promise.resolve(plugin().stop({ jobId: j.id })).catch(failed); }
    catch (e) { failed(e); }
  }

  // Reader-page hint (paged reader, after its layout/bookmark settle): before
  // any playback, move the job to where the user is READING if that audio is
  // still untranscribed. Ignored once real position events exist.
  function hintPosition(ms) {
    const a = active;
    if (!a || a.done || a.timingOnly || !Number.isFinite(ms) || ms < 0) return false;
    if (lastPosMs >= 0) return false;
    if (coveringRange(a.cov || [], ms)) return false;
    const j = job;
    if (j && ms >= j.startMs - 10000 && ms <= j.fedThroughMs + 30000) return false;   // already working here
    diag('hintPosition: job → ' + Math.round(ms / 1000) + 's (was ' + (j ? Math.round(j.startMs / 1000) + 's' : 'none') + ')');
    restartAt(Math.max(0, ms - 2000));
    return true;
  }

  function restartAt(ms) {
    const p = plugin();
    if (!p || !active || active.done) return;
    pendingRestartMs = Math.max(0, ms);
    if (job) { requestJobStop('seek'); }
    else { const target = pendingRestartMs; pendingRestartMs = null; startJob(target); }
  }

  // ── native events ─────────────────────────────────────────────────────────

  function onCuesEvent(ev) {
    const a = active;
    if (!a || !job || ev?.jobId !== job.id) return;
    if (Number.isFinite(ev.fedThroughMs)) {
      // Measured transcription speed (audio ms per wall ms) for the progress
      // bar's between-window estimate; whisper windows land every ~15 s.
      const nowW = Date.now();
      const since = job.lastCuesAt || job.startedAt || 0;
      if (since > 0 && nowW - since > 1000 && ev.fedThroughMs > job.fedThroughMs) {
        const r = (ev.fedThroughMs - job.fedThroughMs) / (nowW - since);
        if (r > 0.1 && r < 50) xcribeRate = xcribeRate > 0 ? 0.6 * xcribeRate + 0.4 * r : r;
      }
      job.lastCuesAt = nowW;
      job.fedThroughMs = ev.fedThroughMs;
    }
    const added = mergeCues(ev.cues || []);
    let maxEnd = job.startMs;
    for (const c of (ev.cues || [])) if (c.endMs > maxEnd) maxEnd = c.endMs;
    a.cov = addRange(a.cov, job.startMs, maxEnd);
    if (added) { schedulePersist(false); if (a.timingOnly) enrichLiveSrt(); else scheduleCardRefresh(); }
    if (maybeParkForPower(powerPosition())) return;
    // Frontier ran into a large already-covered region (user seeked back into
    // transcribed audio earlier) — skip the job past it instead of re-feeding.
    const covering = coveringRange(a.cov, job.fedThroughMs + 1500);
    if (covering && covering[1] - job.fedThroughMs > SKIP_AHEAD_MIN_MS && covering[1] > job.startMs) {
      log('frontier inside covered range, skipping to ' + Math.round(covering[1] / 1000) + 's');
      restartAt(covering[1]);
    }
  }

  async function onDoneEvent(ev) {
    const a = active;
    if (!a) return;
    if (!job || ev?.jobId !== job.id) return;
    const j = job;
    try { clearTimeout(j.stopTimer); } catch (_) {}
    job = null;
    log('job ' + j.id + ' done: ' + ev.reason + (ev.error ? ' (' + ev.error + ')' : ''));
    // A native thermal stop is independent of JS timers. Refresh the power
    // snapshot before allowing a retry; never mark unfinished audio covered.
    if (ev.reason === 'parked') {
      _parked = true; _nativePowerHold = true; pendingRestartMs = null; refreshPower(true); schedulePersist(true); return;
    }
    if (pendingRestartMs != null) {
      const target = pendingRestartMs; pendingRestartMs = null;
      startJob(target); return;
    }
    if (j.stopping === 'power') { _parked = true; schedulePersist(true); return; }
    if (ev.reason === 'eof') {
      const end = a.durationMs > 0 ? a.durationMs : (ev.fedThroughMs || j.fedThroughMs);
      a.cov = addRange(a.cov, j.startMs, end);
      if (!(a.durationMs > 0) && ev.fedThroughMs > 0) a.durationMs = Math.floor(ev.fedThroughMs);
      schedulePersist(true);
      if (!(await maybeFinalize())) {
        if (active !== a || job) return;
        const s = nextUncovered(a.cov, 0);
        // Reaching EOF and wrapping back to fill every earlier gap is the
        // whole-book backfill — power-gated.
        if (!isFullyCovered(a.cov, a.durationMs)) {
          if (powerAllows('backfill')) { _parked = false; startJob(s); }
          else { _parked = true; diag('backfill held for power (charging=' + _power.charging + ' thermal=' + _power.thermal + ')'); }
        }
      }
    } else if (ev.reason === 'stopped') {
      if (pendingRestartMs != null) {
        const target = pendingRestartMs; pendingRestartMs = null;
        startJob(target);
      }
    } else { // error
      a.retries = (a.retries || 0) + 1;
      if (a.retries <= MAX_JOB_RETRIES) {
        setTimeout(() => { if (active === a && !job && !a.done) ensureJob(lastPosMs >= 0 ? lastPosMs : j.startMs); }, 3000);
      } else {
        setStatus(t('at.failed', 'Subtitle generation failed. Reopen the title to retry.'));
        a.done = true;
        schedulePersist(true);
      }
    }
  }

  function onAssetProgress(ev) {
    const f = Number(ev?.fraction);
    if (!Number.isFinite(f)) return;
    setStatus(t('at.downloading', 'Downloading speech model…') + ' ' + Math.round(f * 100) + '%');
  }

  // ── playhead pacing ───────────────────────────────────────────────────────

  function onPosition(ev) {
    const a = active;
    if (!a) return;
    // Title switched away (audio-only → some other title) — stop working.
    if (window._activeTitleId && window._activeTitleId !== a.titleId) { deactivate(); return; }
    const pos = ev?.positionMs;
    if (!Number.isFinite(pos)) return;
    lastPosMs = pos;
    if (a.done) return;
    refreshPower();
    if (job?.stopping) {
      if (pendingRestartMs != null) pendingRestartMs = pos;
      return;
    }
    if (maybeParkForPower(pos)) return;
    if (job) {
      const now = Date.now();
      if (now - lastTargetSentAt > 5000) {
        lastTargetSentAt = now;
        try { plugin()?.setTarget({ jobId: job.id, targetMs: pos }); } catch (_) {}
      }
      // Seeked outside the job's reach into uncovered audio → move the job.
      const outsideAhead = pos > job.fedThroughMs + 15000;
      const outsideBehind = pos < job.startMs - 10000;
      if ((outsideAhead || outsideBehind) && !coveringRange(a.cov, pos)) {
        restartAt(Math.max(0, pos - 2000));
      }
    } else if (_parked && aheadCoveredMs(pos) >= AHEAD_LOW_MS && !unlimited() && !_power.charging) {
      // Still well buffered — stay parked (hysteresis; no restart churn).
    } else {
      ensureJob(pos);
    }
  }

  function attachListenersOnce() {
    if (listenersAttached) return;
    const p = plugin();
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (!p || !bg) return;
    listenersAttached = true;
    try { p.addListener('cues', onCuesEvent); } catch (_) {}
    try { p.addListener('done', onDoneEvent); } catch (_) {}
    try { p.addListener('assetProgress', onAssetProgress); } catch (_) {}
    try { bg.addListener('position', onPosition); } catch (_) {}
    // Durability: flush pending cue writes when the app backgrounds.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) schedulePersist(true);
    });
  }

  // ── completion: write a real SRT + attach it to the title ─────────────────

  function msToSrtTime(ms) {
    const x = Math.max(0, Math.floor(ms));
    const h = String(Math.floor(x / 3600000)).padStart(2, '0');
    const m = String(Math.floor(x / 60000) % 60).padStart(2, '0');
    const s = String(Math.floor(x / 1000) % 60).padStart(2, '0');
    const f = String(x % 1000).padStart(3, '0');
    return h + ':' + m + ':' + s + ',' + f;
  }
  function cuesToSrt(cues) {
    let out = '';
    cues.forEach((c, i) => {
      out += (i + 1) + '\n' + msToSrtTime(c.startMs) + ' --> ' + msToSrtTime(c.endMs) +
             '\n' + c.text + '\n\n';
    });
    return out;
  }

  async function maybeFinalize() {
    const a = active;
    if (!a || a.done || a.finalizing) return false;
    if (a.timingOnly) { if (isFullyCovered(a.cov, a.durationMs)) { a.done = true; setStatus(''); } return a.done; }
    if (!isFullyCovered(a.cov, a.durationMs) || !a.cues.length) return false;
    a.finalizing = true;
    try {
      const fs = window.Capacitor?.Plugins?.Filesystem;
      const ts = window.titleStore;
      if (!fs || !ts) return false;
      const title = (await ts.list()).find(x => x.id === a.titleId);
      if (!title) return false;
      const srtText = cuesToSrt(a.cues);
      const relPath = 'autosrt/' + a.titleId + '.srt';
      await fs.writeFile({ path: relPath, data: srtText, directory: 'DATA', encoding: 'utf8', recursive: true });
      const u = await fs.getUri({ path: relPath, directory: 'DATA' });
      const cachePath = String(u?.uri || '').replace(/^file:\/\//, '');
      if (!cachePath) return false;
      const sizeBytes = new Blob([srtText]).size;
      const srtName = (title.name || 'audiobook') + ' (auto).srt';
      await ts.attach(a.titleId, 'srt', { cachePath, name: srtName, size: sizeBytes, auto: true });
      // Legacy per-deck pairing prefs so audio mode finds the SRT immediately.
      const pseudo = title.attachments?.deck?.name || title.name;
      const P = window.Capacitor?.Plugins?.Preferences;
      if (P && pseudo) {
        try {
          await P.set({ key: 'READING_SRT_PAIR_' + pseudo, value: cachePath });
          await P.set({ key: 'READING_SRT_NAME_' + pseudo, value: srtName });
        } catch (_) {}
      }
      // Pre-fill the card-mode cue cache so the first CARD open skips the parse.
      try {
        window.blobStore?.set('SRT_CUES_V1_' + a.titleId,
          JSON.stringify({ sig: srtName + '|' + sizeBytes, cues: a.cues }));
      } catch (_) {}
      a.done = true;
      schedulePersist(true);
      log('transcription complete: ' + a.cues.length + ' cues → ' + relPath);
      // The title is a normal audio+SRT title from here on — stop live card
      // refreshes (the cue list is final).
      if (window._srtAutoLive === a.titleId) window._srtAutoLive = null;
      // Final AI-map range derivation over the COMPLETE cue list. After this
      // the transcriber never runs again for the title, so chapters left with
      // empty ranges mid-transcription would stay frozen (wedging the AI
      // processing pump) until the next title open's refresh.
      try { window.aiChunks?.refreshCueMap?.(a.titleId); } catch (_) {}
      // Package the complete transcription as a readable book (no-op when the
      // title already has one). Fire-and-forget — SRT finalize must not wait.
      buildSyntheticEpub(a.titleId).catch(() => {});
      if (typeof window.refreshTabAvailability === 'function') window.refreshTabAvailability();
      return true;
    } catch (e) {
      log('finalize failed: ' + (e?.message || e));
      return false;
    } finally {
      a.finalizing = false;
    }
  }

  // ── synthetic book: package the transcription as a real EPUB ─────────────
  //
  // An audiobook-only title's full transcription IS a book text — package it
  // as an EPUB (chapters from m4b markers, else 30-min slices; paragraphs at
  // speech gaps + sentence ends) and attach it {auto:true}, and the title
  // gains READ mode with everything wired: dictionary lookups, read-along
  // maps (the SRT and the book share the same text → exact alignment),
  // karaoke. The auto flag keeps ai-chunks on the existing cue-space map so
  // chapter summaries/characters survive the conversion. Runs automatically
  // at finalize; the title editor's "Create book" button covers titles
  // finished before this feature (and partial transcriptions).

  function _xesc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  async function buildSyntheticEpub(titleId, opts) {
    const ts = window.titleStore;
    const fs = window.Capacitor?.Plugins?.Filesystem;
    if (!ts || !fs || typeof JSZip === 'undefined' || !titleId) return { ok: false, reason: 'unsupported' };
    const minCues = (opts && opts.minCues) || 20;
    const minGrowth = (opts && Number.isFinite(opts.minGrowth)) ? opts.minGrowth : 0;
    const title = (await ts.list()).find(x => x.id === titleId);
    if (!title) return { ok: false, reason: 'no-title' };
    const existing = title.attachments?.epub;
    if (existing && !existing.auto) return { ok: false, reason: 'has-epub' };   // a REAL book always wins

    let cues = null;
    if (active && active.titleId === titleId) cues = active.cues;
    else {
      const obj = await loadCacheObj(titleId);
      if (obj && Array.isArray(obj.cues)) cues = normalizeCues(obj.cues);
    }
    if (!cues || cues.length < minCues) return { ok: false, reason: 'no-cues' };
    // Rebuild-of-an-existing synthetic book: only when it actually grew
    // (append-only — the reader relies on the prefix staying identical).
    if (existing && Number.isFinite(existing.cueCount) && cues.length < existing.cueCount + minGrowth) {
      return { ok: false, reason: 'no-growth' };
    }

    // Chapter bounds: m4b markers → 30-min slices → single section.
    let markers = [];
    try { markers = await getAudioChapters(titleId, title.attachments?.audiobook?.cachePath || null); } catch (_) {}
    const durMs = Math.max((await durationFor(titleId)) || 0, cues[cues.length - 1].endMs || 0);
    let bounds = [];
    if (Array.isArray(markers) && markers.length >= 2) {
      for (const m of markers) {
        const last = bounds.length ? bounds[bounds.length - 1].ms : -Infinity;
        if (m.startMs - last < 60000) continue;   // micro-chapter guard
        bounds.push({ ms: m.startMs, title: (m.title || '').trim() || null });
      }
      if (!bounds.length || bounds[0].ms > 60000) bounds.unshift({ ms: 0, title: null });
      else bounds[0].ms = 0;
    } else if (durMs >= 40 * 60 * 1000) {
      for (let ms = 0; ms < durMs - 5 * 60 * 1000; ms += 30 * 60 * 1000) bounds.push({ ms, title: null });
    } else {
      bounds = [{ ms: 0, title: null }];
    }
    const chapters = bounds.map(b => ({ ms: b.ms, title: b.title, cues: [] }));
    let k = 0;
    for (const c of cues) {
      while (k + 1 < chapters.length && c.startMs >= chapters[k + 1].ms) k++;
      chapters[k].cues.push(c);
    }
    const parts = chapters.filter(ch => ch.cues.length);
    if (!parts.length) return { ok: false, reason: 'no-cues' };

    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('META-INF/container.xml',
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
      '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');

    const items = [], refs = [], navLis = [];
    parts.forEach((ch, i) => {
      // Paragraphs: break at sentence ends when the narrator pauses (>2.5s)
      // or the paragraph has grown long. Phrase-split cues concatenate back
      // into the original sentences (the split points carry the punctuation).
      const paras = [];
      let cur = '';
      for (let j = 0; j < ch.cues.length; j++) {
        const c = ch.cues[j];
        cur += (c.text || '');
        const next = ch.cues[j + 1];
        const gap = next ? next.startMs - c.endMs : Infinity;
        const sentEnd = /[。．！？!?」』]$/.test(c.text || '');
        if (!next || (sentEnd && (gap > 2500 || cur.length > 500))) {
          if (cur.trim()) paras.push(cur.trim());
          cur = '';
        }
      }
      if (cur.trim()) paras.push(cur.trim());
      const heading = ch.title || (parts.length > 1 ? String(i + 1) : '');
      let body = (heading ? '<h2>' + _xesc(heading) + '</h2>\n' : '') +
        paras.map(p => '<p>' + _xesc(p) + '</p>').join('\n');
      // Provenance notice on the first page: this text is machine-generated.
      if (i === 0) {
        body = '<p style="font-size:0.72em;color:#888;">' +
          _xesc('音声から自動生成された本文です（認識誤りを含む場合があります）') + '</p>\n' + body;
      }
      const fn = 'ch' + i + '.xhtml';
      zip.file('OEBPS/' + fn,
        '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n' +
        '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>' + _xesc(heading || title.name || '') +
        '</title></head>\n<body>\n' + body + '\n</body></html>');
      items.push('<item id="c' + i + '" href="' + fn + '" media-type="application/xhtml+xml"/>');
      refs.push('<itemref idref="c' + i + '"/>');
      navLis.push('<li><a href="' + fn + '">' + _xesc(heading || String(i + 1)) + '</a></li>');
    });
    zip.file('OEBPS/nav.xhtml',
      '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head>' +
      '<body><nav epub:type="toc"><ol>' + navLis.join('') + '</ol></nav></body></html>');
    zip.file('OEBPS/content.opf',
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">\n' +
      '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      '<dc:identifier id="uid">kadoki-auto-' + _xesc(titleId) + '</dc:identifier>' +
      '<dc:title>' + _xesc(title.name || 'Audiobook') + '</dc:title>' +
      '<dc:language>ja</dc:language>' +
      '<meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>' +
      '</metadata>\n<manifest>' +
      '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' +
      items.join('') + '</manifest>\n<spine>' + refs.join('') + '</spine>\n</package>');

    const b64 = await zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
    const relPath = 'autoepub/' + titleId + '.epub';
    await fs.writeFile({ path: relPath, data: b64, directory: 'DATA', recursive: true });
    const u = await fs.getUri({ path: relPath, directory: 'DATA' });
    const cachePath = String(u?.uri || '').replace(/^file:\/\//, '');
    if (!cachePath) return { ok: false, reason: 'write-failed' };
    await ts.attach(titleId, 'epub', {
      cachePath,
      name: (title.name || 'audiobook') + ' (auto).epub',
      size: Math.floor(b64.length * 3 / 4),
      auto: true,
      cueCount: cues.length   // growth marker for the live-refresh cycle
    });
    if (typeof window.refreshTabAvailability === 'function') window.refreshTabAvailability();
    log('synthetic epub: ' + parts.length + ' sections, ' + cues.length + ' cues → ' + relPath);
    return { ok: true, chapters: parts.length };
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async function activate({ audioPath, audioName, timingOnly }) {
    diag('activate tid=' + window._activeTitleId + ' path=…' + String(audioPath || '').slice(-24) + ' active=' + (active ? (active.titleId + ' done=' + active.done + ' cues=' + active.cues.length + ' job=' + !!job) : 'none'));
    if (!hasNativeTranscribe() || !plugin()) { diag('activate: no native plugin'); return false; }
    const a = await checkAvail();
    if (!a.supported) { diag('activate: unsupported'); return false; }
    const titleId = window._activeTitleId;
    if (!titleId || !audioPath) { log('activate skipped: no titleId/audioPath'); diag('activate: no titleId/audioPath'); return false; }
    if (active && active.titleId === titleId && active.audioPath === audioPath && !active.done) {
      diag('activate: already active, re-ingest ' + active.cues.length + ' cues (job=' + !!job + ')');
      if (active.timingOnly) { enrichLiveSrt(); return true; }
      // Already running for this title — refresh the display context in case
      // reading-mode cleared its cue array on a mode round-trip.
      if (active.cues.length && typeof window.abIngestAutoCues === 'function') {
        window.abIngestAutoCues(active.cues);
      }
      return true;
    }
    deactivate();
    attachListenersOnce();

    // A title that also carries a read source gets book-text alignment:
    // ASR cue text is replaced by the matched passage from the EPUB/TXT.
    let hasEpub = false;
    try {
      const tl = await window.titleStore?.list();
      hasEpub = !!tl?.find(x => x.id === titleId)?.attachments?.epub;
    } catch (_) {}

    // TIMING-ONLY (2026-09-09): the title HAS subtitles (an SRT). Transcribe
    // anyway — purely to harvest WORD TIMINGS, which are then aligned onto
    // the SRT cue text (enrichSrtWordTimes) for karaoke. Never replaces the
    // displayed cues, never attaches an SRT, never runs the book aligner.
    active = {
      titleId, audioPath, audioName: audioName || '',
      sig: '', durationMs: 0, cues: [], cov: [], done: false, retries: 0,
      assetsDownloading: false, cardAnchorMs: null, hasBookText: hasEpub && !timingOnly,
      timingOnly: !!timingOnly
    };
    const me = active;
    const isAndroid = window.Capacitor?.getPlatform?.() === 'android';
    // Book-text index builds in parallel with asset download / job start;
    // the ready-sweep upgrades any cues that merged as plain ASR meanwhile.
    if (hasEpub && window.autoAlign) {
      window.autoAlign.prepare(titleId, {
        getDurMs: () => (active && active.titleId === titleId) ? active.durationMs : 0
      }).then((ok) => {
        if (ok && active === me) {
          // Re-place anchors from cues matched in earlier sessions, then
          // upgrade whatever merged as plain ASR while the index built.
          try { window.autoAlign.seedFromCues(me.cues); } catch (_) {}
          runAlignSweep('ready');
        }
      }).catch((e) => log('autoAlign prepare failed: ' + (e?.message || e)));
    }
    // Warm the m4b chapter-marker cache for the AI chapter builder.
    getAudioChapters(titleId, audioPath);

    // One-time speech-model download. On Android this is a ~190 MB whisper
    // model fetched from the network — never start that silently.
    if (!a.installed) {
      if (isAndroid) {
        const ok = confirm(t('at.dl_confirm',
          'Generating subtitles needs a one-time speech model download (about 190 MB, Wi-Fi recommended). Download now?'));
        if (!ok) {
          setStatus(t('at.dl_declined', 'Subtitle generation needs the speech model. Reopen the title to download it.'));
          if (active === me) active = null;
          return false;
        }
      }
      me.assetsDownloading = true;
      setStatus(t('at.downloading', 'Downloading speech model…'));
      // The status line above lives in the audio-mode cue area — invisible
      // from read mode. Toast so the download is observable from anywhere.
      if (isAndroid) {
        try { window.showToast?.(t('at.dl_started', 'Speech model downloading — progress shows in audio mode'), 3500); } catch (_) {}
      }
      try {
        await plugin().ensureAssets();
        avail.installed = true;
        if (isAndroid) {
          try { window.showToast?.(t('at.dl_done', 'Speech model ready — generating subtitles'), 3000); } catch (_) {}
        }
      } catch (e) {
        setStatus(t('at.download_failed', 'Speech model download failed. Check your connection and reopen the title.'));
        log('ensureAssets failed: ' + (e?.message || e));
        if (active === me) active = null;
        return false;
      }
      if (active !== me) return false;   // title switched during download
      me.assetsDownloading = false;
      setStatus('');
    }

    // Cache signature = audio file name|size (survives cache renames across
    // app updates the same way the SRT cue cache does).
    me.sig = await computeSig(audioPath, audioName);
    if (active !== me) return false;

    // Adopt cached partial progress (stat-failure-tolerant sig match; keep
    // the cache's sig when ours came from a failed stat so future exact
    // matches still work).
    let obj = await loadCacheObj(titleId);
    // A populated store that fails the sig check must NEVER be silently
    // discarded (the fresh run's first persist would overwrite hours of
    // transcription). Park it under _PREV — and conversely, if the main key
    // came back empty/unreadable but a parked copy matches, adopt that.
    if (obj && Array.isArray(obj.cues) && obj.cues.length && !sigMatches(obj.sig, me.sig)) {
      try {
        await window.blobStore?.set(CACHE_PREFIX + titleId + '_PREV', JSON.stringify(obj));
        log('SIG MISMATCH: cache=' + obj.sig + ' live=' + me.sig + ' — ' + obj.cues.length +
            ' cues parked to _PREV, starting fresh');
      } catch (_) {}
    }
    if (!(obj && sigMatches(obj.sig, me.sig) && Array.isArray(obj.cues) && obj.cues.length)) {
      const prev = await loadCacheObj(titleId + '_PREV');
      if (prev && sigMatches(prev.sig, me.sig) && Array.isArray(prev.cues) && prev.cues.length) {
        log('adopting _PREV backup: ' + prev.cues.length + ' cues');
        obj = prev;
      }
    }
    if (obj && sigMatches(obj.sig, me.sig) && Array.isArray(obj.cues)) {
      if (/\|0$/.test(me.sig) && obj.sig && !/\|0$/.test(obj.sig)) me.sig = obj.sig;
      me.cues = normalizeCues(obj.cues);
      me.cov = Array.isArray(obj.cov) ? obj.cov.filter(r => Array.isArray(r) && r.length === 2) : [];
      me.durationMs = obj.durMs > 0 ? obj.durMs : 0;
      me.cardAnchorMs = Number.isFinite(obj.cardAnchorMs) ? obj.cardAnchorMs : null;
      // Cached cues from a sentence-grained session re-split to phrases here.
      if (splitLongCues(me)) me.cues.forEach((c, i) => { c.index = i; });
      // Word-timing retrofit: spans cached BEFORE the karaoke feature carry
      // no `w` and covered audio is never re-fed, so they would stay
      // cue-level forever. Reopen their coverage; the job re-transcribes
      // them and mergeCues swaps the stale cues for fresh word-timed ones
      // (re-aligned to the book on epub titles). One-shot per span: once
      // re-fed, the cache persists cues WITH w and nothing reopens.
      if (me.cues.length && !me.done) {
        const holes = wlessRanges(me.cues);
        const total = holes.reduce((s2, r) => s2 + (r[1] - r[0]), 0);
        if (total > 15000) {
          me.cov = subtractRanges(me.cov, holes);
          log('word-time retrofit: reopened ' + Math.round(total / 60000) + ' min of pre-karaoke coverage');
        }
      }
      log('cache adopted: ' + me.cues.length + ' cues, ' + me.cov.length + ' ranges');
    }
    if (active !== me) return false;

    if (me.timingOnly) { enrichLiveSrt(); }
    else if (me.cues.length && typeof window.abIngestAutoCues === 'function') {
      window.abIngestAutoCues(me.cues);
    }
    // Cache-adopted cues from a pre-alignment session are plain ASR text —
    // queue them for the aligner (no-op until prepare() resolves).
    if (me.hasBookText && me.cues.some(c => !c.b)) scheduleSweep();

    // Kick the first job from the best playhead estimate; position events
    // take over from here. getState covers the paused-on-open case.
    let pos = lastPosMs;
    if (!(pos >= 0)) {
      try {
        const st = await window.Capacitor?.Plugins?.BackgroundAudio?.getState?.();
        if (st && Number.isFinite(st.positionMs) && st.positionMs > 0) pos = st.positionMs;
      } catch (_) {}
    }
    // Still nothing (fresh open into READ mode, no playback yet): the page the
    // reader is showing is the best guess — otherwise the job started at the
    // first gap from 0 s and a reader parked at 105k chars waited on the whole
    // book (Android whisper: "takes some time to settle down and find the
    // subtitles").
    if (!(pos >= 0)) {
      try { const h = window._pagedReadPosHintMs?.(); if (Number.isFinite(h) && h > 0) { pos = Math.max(0, h - 2000); diag('activate: seeding from reader page hint ' + Math.round(h / 1000) + 's'); } } catch (_) {}
    }
    if (active !== me) { diag('activate: superseded before ensureJob'); return false; }
    diag('activate: ' + me.cues.length + ' cues, cov=' + JSON.stringify(me.cov.map(r => r.map(x => Math.round(x / 1000)))) + ' dur=' + me.durationMs + ' pos=' + pos + ' sig=' + me.sig);
    ensureJob(pos >= 0 ? pos : 0);
    return true;
  }

  function deactivate() {
    const p = plugin();
    if (job && p) { try { p.stop({ jobId: job.id }); } catch (_) {} }
    if (active) schedulePersist(true);
    if (sweepTimer) { clearTimeout(sweepTimer); sweepTimer = null; }
    try { window.autoAlign?.release?.(); } catch (_) {}
    job = null;
    pendingRestartMs = null;
    active = null;
    lastPosMs = -1;   // a stale cross-title playhead must not seed the next job
    _powerAnchorMs = 0;
  }

  // Is position `ms` transcribed yet, and if not, how close is the job to
  // it? Drives the audio-mode "syncing subtitles" indicator (reading-mode.js
  // abUpdateCueDisplay) after a seek into untranscribed audio — before this,
  // the view froze on the LAST transcribed cue with no feedback while the job
  // silently restarted at the playhead. Returns null when nothing is owed
  // (no active transcription for the title, finished, or `ms` is covered).
  function syncState(ms) {
    const a = active;
    if (!a || a.done || a.timingOnly || !Number.isFinite(ms)) return null;   // timing-only: never a "syncing" screen
    const cov = a.cov || [];
    if (coveringRange(cov, ms)) return null;
    const j = job;
    let progress = 0;
    if (j && ms >= j.startMs - 1000) {
      const span = Math.max(1, (ms + 1500) - j.startMs);
      progress = Math.max(0, Math.min(0.98, (j.fedThroughMs - j.startMs) / span));
      // Between windows the fed-through frontier stands still for ~15 s; show
      // the expected progress from the measured transcriber speed so the bar
      // moves honestly instead of parking (user: "stuck on 3%").
      const rateEst = xcribeRate > 0 ? xcribeRate : 1.5;
      const expected = Math.max(0, (j.fedThroughMs - j.startMs) + (Date.now() - (j.lastCuesAt || j.startedAt || Date.now())) * rateEst);
      progress = Math.max(progress, Math.min(0.95, expected / span));
    }
    let coveredMs = 0;
    for (const r of cov) coveredMs += Math.max(0, r[1] - r[0]);
    const dur = a.durationMs || 0;
    return {
      covered: false,
      progress,
      jobRunning: !!j,
      frontierMs: j ? j.fedThroughMs : -1,
      coveragePct: dur > 0 ? Math.max(0, Math.min(100, Math.round(100 * coveredMs / dur))) : -1,
    };
  }

  // ── SRT word-timing enrichment by ALIGNMENT ─────────────────────────────
  // For a title that has its own SRT: take the transcriber's cues (with
  // word timings) overlapping each SRT cue in time, lay their characters on
  // a timeline, and align the SRT cue's characters to that timeline with a
  // global DP (match +2 / mismatch −1 / gap −1). Matched characters take the
  // ASR time; unmatched ones are interpolated between neighbours. Human
  // subtitles condense speech, so a ≥45 % match is enough to accept.
  const _STRIP_RE = /[\s　「」『』、。・…！？!?,.;:()（）\-—–~〜]/;
  function _normChars(text) {
    const out = []; const idx = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (_STRIP_RE.test(ch)) continue;
      const code = ch.charCodeAt(0);   // katakana → hiragana: script choice must not break matches
      const n = (code >= 0x30A1 && code <= 0x30F6) ? String.fromCharCode(code - 0x60) : ch;
      out.push(n); idx.push(i);
    }
    return { chars: out, idx };
  }
  function _asrTimeline(autoCues, fromMs, toMs) {
    const chars = [], times = [];
    for (const c of autoCues) {
      if (!c || !Array.isArray(c.w) || !c.w.length) continue;
      if (c.endMs < fromMs || c.startMs > toMs) continue;
      const text = String(c.text || '');
      const tByRaw = new Map();
      for (let q = 0; q + 3 < c.w.length; q += 4) {
        const off = c.w[q] | 0, len = c.w[q + 1] | 0, s0 = c.startMs + c.w[q + 2], e0 = c.startMs + c.w[q + 3];
        for (let k = 0; k < len; k++) tByRaw.set(off + k, s0 + (e0 - s0) * (k + 0.5) / Math.max(1, len));
      }
      const nc = _normChars(text);
      for (let k = 0; k < nc.chars.length; k++) {
        const tm = tByRaw.get(nc.idx[k]);
        if (Number.isFinite(tm)) { chars.push(nc.chars[k]); times.push(tm); }
      }
    }
    return { chars, times };
  }
  function _alignChars(a, b) {   // global alignment → matched pairs [i, j]
    const n = a.length, m = b.length;
    if (!n || !m || n * m > 250000) return [];
    const W = m + 1;
    const S = new Int32Array((n + 1) * W);
    for (let i = 1; i <= n; i++) S[i * W] = -i;
    for (let j = 1; j <= m; j++) S[j] = -j;
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const d = S[(i - 1) * W + (j - 1)] + (a[i - 1] === b[j - 1] ? 2 : -1);
        const u = S[(i - 1) * W + j] - 1, l = S[i * W + (j - 1)] - 1;
        S[i * W + j] = d > u ? (d > l ? d : l) : (u > l ? u : l);
      }
    }
    const pairs = [];
    let i = n, j = m;
    while (i > 0 && j > 0) {
      const cur = S[i * W + j];
      if (cur === S[(i - 1) * W + (j - 1)] + (a[i - 1] === b[j - 1] ? 2 : -1)) {
        if (a[i - 1] === b[j - 1]) pairs.push([i - 1, j - 1]);
        i--; j--;
      } else if (cur === S[(i - 1) * W + j] - 1) i--;
      else j--;
    }
    pairs.reverse();
    return pairs;
  }
  function alignWordTimesOnto(targetCues, autoCues) {
    if (!Array.isArray(targetCues) || !Array.isArray(autoCues) || !autoCues.length) return 0;
    let n = 0;
    for (const c of targetCues) {
      if (!c || (Array.isArray(c.w) && c.w.length && !c._wSynth) || !Number.isFinite(c.startMs)) continue;
      const tl = _asrTimeline(autoCues, c.startMs - 800, c.endMs + 800);
      if (tl.chars.length < 3) continue;
      const nc = _normChars(String(c.text || ''));
      if (nc.chars.length < 2) continue;
      const pairs = _alignChars(nc.chars, tl.chars);
      if (pairs.length < Math.max(2, nc.chars.length * 0.45)) continue;
      const tm = new Array(nc.chars.length).fill(null);
      for (const [i, j] of pairs) tm[i] = tl.times[j];
      let prev = c.startMs;
      for (let i = 0; i < tm.length; i++) {
        if (tm[i] != null) { prev = tm[i]; continue; }
        let k = i; while (k < tm.length && tm[k] == null) k++;
        const next = k < tm.length ? tm[k] : Math.max(prev, c.endMs - 150);
        const span = k - i + 1;
        for (let q = i; q < k; q++) tm[q] = prev + (next - prev) * (q - i + 1) / span;
        i = k - 1;
      }
      const w = [];
      let last = 0;
      for (let i = 0; i < tm.length; i++) {
        let t0 = Math.max(0, Math.round(tm[i] - c.startMs));
        if (t0 < last) t0 = last;
        const t1 = i + 1 < tm.length ? Math.max(t0 + 20, Math.round(tm[i + 1] - c.startMs)) : Math.max(t0 + 60, Math.round(c.endMs - c.startMs));
        w.push(nc.idx[i], 1, t0, t1);
        last = t0;
      }
      c.w = w; c._wAligned = true; delete c._wSynth;
      n++;
    }
    return n;
  }
  function enrichLiveSrt() {
    const a = active;
    if (!a || !a.timingOnly || !a.cues.length) return;
    let n = 0;
    try { if (Array.isArray(window.__abCues) && window.__abCues.length) n += alignWordTimesOnto(window.__abCues, a.cues); } catch (_) {}
    try { if (Array.isArray(window.pagedCues) && window.pagedCues.length && window._pagedCuesTitleId === a.titleId) n += alignWordTimesOnto(window.pagedCues, a.cues); } catch (_) {}
    if (n) {
      log('aligned word times onto ' + n + ' subtitle cues');
      try { window._diag?.('[paged-diag] aligned word times onto ' + n + ' subtitle cues'); } catch (_) {}
      try { window._resetAbCueGate?.(); } catch (_) {}
      try { window.abRefreshSpanTiming?.(); } catch (_) {}   // the line on screen gets real timing NOW
    }
  }
  async function enrichSrtWordTimes(titleId, cues) {
    if (!titleId || !Array.isArray(cues) || !cues.length) return 0;
    const src = (active && active.titleId === titleId) ? { cues: active.cues } : await loadCacheObj(titleId);
    if (!src || !Array.isArray(src.cues) || !src.cues.length) return 0;
    const n = alignWordTimesOnto(cues, src.cues);
    if (n) log('cold-aligned word times onto ' + n + ' subtitle cues');
    return n;
  }
  function srtWordTimingWanted() {
    try { return localStorage.getItem('KADOKI_SRT_WORDTIME') !== '0'; } catch (_) { return true; }
  }

  // Read-mode progress pill: non-null while the ACTIVE title's playhead (or,
  // before any playback, the job's start) still waits on the transcriber.
  function progressState() {
    const a = active;
    if (!a || a.done || a.timingOnly) return null;
    if (window._activeTitleId && a.titleId !== window._activeTitleId) return null;
    const j = job;
    if (lastPosMs < 0) {
      if (!j) return null;
      let coveredMs = 0;
      for (const r of (a.cov || [])) coveredMs += Math.max(0, r[1] - r[0]);
      const dur = a.durationMs || 0;
      return { covered: false, progress: 0, jobRunning: true, frontierMs: j.fedThroughMs,
               coveragePct: dur > 0 ? Math.max(0, Math.min(100, Math.round(100 * coveredMs / dur))) : -1 };
    }
    return syncState(lastPosMs);
  }

  window.autoTranscribe = {
    progressState,      // () → null when nothing to wait on, else {progress, coveragePct, jobRunning}
    powerInfo,          // () → {charging, thermal, lowPower, parked, unlimited, aheadMs}
    refreshPower,
    hintPosition,       // (ms) → before playback: move the job to the reader's page if untranscribed
    enrichSrtWordTimes, // (titleId, cues) → align cached transcription word times onto SRT cues
    srtWordTimingWanted,// () → pref: harvest word timings for SRT titles via transcription
    syncState,          // (ms) → null if transcribed/inactive, else {progress, coveragePct, ...}
    available,          // async: device supports on-device ja transcription
    activate,           // ({audioPath, audioName}) → begin/resume for the active title
    deactivate,
    isActiveFor: (titleId) => !!(active && active.titleId === titleId),
    isSupportedSync: () => avail.supported,   // sync flag for tab/mode gating (warmed at boot)
    getCuesSnapshot,    // (titleId, audioPath, audioName) → {cues, cardAnchorMs}
    getAudioChapters,   // (titleId, audioPath?) → [{startMs, title}] (m4b markers, cached)
    stableFp,           // (titleId) → stable AI-map fingerprint or null
    durationFor,        // (titleId) → full audio duration ms (0 unknown)
    enrichWordTimes,    // (titleId, cues) → copy cached word timings onto SRT-parsed cues
    buildSyntheticEpub, // (titleId) → package the transcription as an EPUB attachment
  };

  // Warm the availability check at boot so the audio-mode gate's await is instant.
  if (hasNativeTranscribe()) setTimeout(checkAvail, 1500);
})();
