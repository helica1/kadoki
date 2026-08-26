// watch.js — phone-side JS for the Apple Watch companion (plan S1 + S3-lite).
//
// "Send to Apple Watch" (title editor) queues the ACTIVE title's audio + cue
// list through the WatchBridge plugin (WCSession file transfers — background,
// opportunistic, slow for big m4bs). Position checkpoints coming back from
// the watch merge FORWARD-ONLY into the furthest machinery (updateFurthest
// never regresses), so a watch listen surfaces exactly like a background
// listen does — never-lose-place holds across devices.
(function () {
  'use strict';

  const WB = () => window.Capacitor?.Plugins?.WatchBridge;

  // The cue bundle for the watch (times + text + word timings for karaoke).
  function bundleCues() {
    const rawCues = (Array.isArray(window.__abCues) && window.__abCues.length) ? window.__abCues
      : (Array.isArray(window._srtCues) ? window._srtCues : []);
    return rawCues
      .filter((c) => Number.isFinite(c.startMs) && Number.isFinite(c.endMs) && c.text)
      .map((c) => {
        const o = { s: Math.round(c.startMs), e: Math.round(c.endMs), text: String(c.text) };
        if (Array.isArray(c.w) && c.w.length && c.w.length % 4 === 0) o.w = c.w;
        return o;
      });
  }

  window.sendTitleToWatch = async function () {
    const plugin = WB();
    const status = (m) => { const el = document.getElementById('watchSendStatus'); if (el) el.textContent = m; };
    try {
      if (!plugin) { status('Watch bridge unavailable.'); return; }
      const tid = window._editingTitleId;
      if (!tid) return;
      const st = await plugin.getState();
      if (!st.supported) { status('This device has no watch support.'); return; }
      if (!st.paired) { status('No paired Apple Watch.'); return; }
      // isWatchAppInstalled goes STALE-FALSE after watch-app updates until the
      // iPhone app relaunches — while the watch is provably still syncing. Warn
      // instead of blocking; a real missing app surfaces as a transfer failure.
      if (!st.installed) {
        status(st.reachable
          ? 'Watch app flag stale (watch is reachable) — sending anyway.'
          : 'Watch app not detected — sending anyway. If nothing arrives, open Kadoki on the watch and relaunch this app.');
      }
      // Cues live in memory only while the title is OPEN.
      if (window._activeTitleId !== tid) { status('Open this title first, then send.'); return; }
      const title = await window.titleStore.get(tid);
      const ab = title?.attachments?.audiobook;
      const audioPath = ab?.cachePath;
      if (!audioPath) { status('No audiobook file available.'); return; }
      const cues = bundleCues();
      let durMs = 0;
      try { const g = window.getAudioProgress?.(); if (g && Number(g.dur) > 0) durMs = Math.round(g.dur); } catch (_) {}
      if (!durMs) { try { durMs = (await window.autoTranscribe?.durationFor?.(tid)) || 0; } catch (_) {} }
      // Explicit choice every send: a cues-only refresh updates subtitles /
      // word timings in seconds, vs re-shipping the multi-hundred-MB audio.
      // (Deliberately not flag-gated — titles sent before this build have no
      // local record, and a wrong guess costs hours of transfer.)
      let cuesOnly = false;
      try {
        cuesOnly = confirm('Send SUBTITLES ONLY? (fast — choose this when the audio is already on the watch)\n\nOK = subtitles only\nCancel = full send including audio');
      } catch (_) {}
      status('Queueing transfer…');
      const cover = title.attachments?.cover?.dataUri || null;
      await plugin.sendTitle({ titleId: tid, name: title.name || 'Untitled', audioPath, durMs, cues, cuesOnly, cover });
      try { window.kHaptic?.(); } catch (_) {}
      status('Queued (' + cues.length + ' cues' + (cuesOnly ? ', subtitles only' : '') + '). Transfer runs in the background — progress shows here while this sheet is open.');
      try { localStorage.setItem('WATCH_CUES_SENT_' + tid, cuesFingerprint(cues)); } catch (_) {}
      pushPositionsToWatch(true);
    } catch (e) {
      status('Send failed: ' + (e?.message || e));
    }
  };

  // Phone → watch position push (latest-wins; the watch adopts by fresher
  // listen ts, so a deliberate scrub-back on either device is respected).
  // Pushed on app-background, every 60s while playing, and after a send.
  let _lastPosPush = 0;
  async function pushPositionsToWatch(force) {
    try {
      const plugin = WB();
      if (!plugin) return;
      const now = Date.now();
      if (!force && now - _lastPosPush < 30000) return;
      const tid = window._activeTitleId;
      if (!tid) return;
      // LIVE playhead when it's fresh (playing / just paused)…
      let ms = null, ts = 0;
      const fresh = Number.isFinite(window._lastBgPosMs) && window._lastBgPosAt &&
        (now - window._lastBgPosAt) < 120000;
      if (fresh && window._lastBgPosMs > 0) {
        ms = window._lastBgPosMs;
        ts = now;
      } else {
        // …else the DURABLE saved position (flushed on pause) with its REAL
        // last-listen ts. Without this fallback, a paused phone pushed
        // NOTHING and the watch kept adopting whatever stale context existed
        // (the "synced ✓ but way off" bug).
        const sv = await window.abGetSavedPositionForTitle?.(tid);
        if (sv && sv.ms > 0) { ms = sv.ms; ts = sv.ts || 0; }
      }
      if (!(ms > 0)) return;
      _lastPosPush = now;
      await plugin.updateContext({ positions: { [tid]: { ms: Math.round(ms), ts: ts || now } } });
    } catch (_) {}
  }
  window.pushPositionsToWatch = pushPositionsToWatch;
  document.addEventListener('visibilitychange', () => { if (document.hidden) pushPositionsToWatch(true); });
  setInterval(() => { if (window._bgPlaying) pushPositionsToWatch(false); }, 60000);

  // AUTO cue sync (Phase C): any title whose cues exist on the phone gets its
  // cues.json onto the watch automatically — no manual "Send to Watch" for
  // subtitles. Audio stays manual (multi-hundred-MB over Bluetooth is a
  // deliberate user decision), so this NEVER ships cuesOnly:false. Runs on
  // title-open (below) and this 60s poll, which also carries the
  // auto-transcriber's ongoing growth (it has no dedicated finish event).
  //
  // WATCH_CUES_SENT_<tid> holds "count|lastCueEndMs" — a fingerprint, not
  // just a count, so a re-split of the SAME number of cues (auto-transcribe's
  // book-match phrase splitting) still re-syncs. Old numeric-only values
  // parse fine as count-only (lastEndMs defaults to 0, so any growth looks
  // "new" once — harmless, just one extra sync).
  function parseCuesFingerprint(raw) {
    if (!raw) return { count: 0, lastEndMs: 0 };
    const parts = String(raw).split('|');
    return { count: parseInt(parts[0], 10) || 0, lastEndMs: parts.length > 1 ? (parseInt(parts[1], 10) || 0) : 0 };
  }
  function cuesFingerprint(cues) {
    const count = cues.length;
    return count + '|' + (count ? (cues[count - 1].e || 0) : 0);
  }
  let _autoCuesLastAttemptAt = 0;
  async function autoSendCuesIfNeeded(tid) {
    try {
      const plugin = WB();
      if (!plugin || document.hidden) return;
      tid = tid || window._activeTitleId;
      // Cues live in memory only for the OPEN title — same constraint as the
      // manual send.
      if (!tid || tid !== window._activeTitleId) return;
      const cues = bundleCues();
      if (!cues.length) return;

      const key = 'WATCH_CUES_SENT_' + tid;
      const prevRaw = localStorage.getItem(key);
      const prev = parseCuesFingerprint(prevRaw);
      const now = Date.now();
      const isFirst = !prevRaw;
      const grew50 = cues.length >= prev.count + 50;
      const staleWithGrowth = (now - _autoCuesLastAttemptAt > 180000) && cues.length > prev.count;
      // Unconditional daily heartbeat: the phone's "already sent" record has
      // no way to know the watch app was reinstalled/its Library/Titles data
      // wiped (a fresh install has zero local state) — a title whose cue
      // count isn't growing would otherwise never re-sync. This bounds how
      // long that can go unnoticed without adding real cost (cues.json is
      // tiny) for the common unchanged case.
      const hbKey = 'WATCH_CUES_HB_' + tid;
      const heartbeatDue = !isFirst && (now - (parseInt(localStorage.getItem(hbKey) || '0', 10) || 0) > 86400000);
      if (!isFirst && !grew50 && !staleWithGrowth && !heartbeatDue) return;
      // Backstop so a burst of title-open + poll calls can't spam transfers.
      if (now - _autoCuesLastAttemptAt < 15000) return;

      const st = await plugin.getState();
      // Do NOT gate on `installed` — documented stale-false after a watch-app
      // update while transfers still work fine (see sendTitleToWatch above).
      if (!st.supported || !st.paired) return;

      const title = await window.titleStore.get(tid);
      const ab = title?.attachments?.audiobook;
      if (!ab?.cachePath) return;   // sendTitle validates audioPath even for cuesOnly sends
      let durMs = 0;
      try { const g = window.getAudioProgress?.(); if (g && Number(g.dur) > 0) durMs = Math.round(g.dur); } catch (_) {}

      _autoCuesLastAttemptAt = now;
      await plugin.sendTitle({
        titleId: tid, name: title.name || 'Untitled', audioPath: ab.cachePath,
        durMs, cues, cuesOnly: true, cover: null,   // never auto-send cover/audio
      });
      localStorage.setItem(key, cuesFingerprint(cues));
      localStorage.setItem(hbKey, String(now));
      try { window.debugLog?.('[watch] auto cues sync: ' + cues.length + ' cues (was ' + prev.count + ')'); } catch (_) {}
    } catch (_) {}
  }
  setInterval(() => autoSendCuesIfNeeded(), 60000);
  // Prompt initial sync on title open — don't wait for the 60s poll. A short
  // delay lets the just-opened title's cues/audiobook attachment settle.
  window.addEventListener('shell:title-change', () => { setTimeout(() => autoSendCuesIfNeeded(), 1500); });

  // ---- Phase B: live subtitle stream — set which title BackgroundAudio's
  // native position ticks get tagged with on the watch. No JS involvement in
  // the frame stream itself (that path is native-to-native so it survives
  // WebView suspension while the phone is locked) — this just tells
  // WatchBridgePlugin which titleId to attach to each tick.
  window.watchLive = {
    setActive(tid) {
      try { WB()?.setLiveContext?.({ titleId: tid || null }); } catch (_) {}
    },
    clear() {
      try { WB()?.setLiveContext?.({ titleId: null }); } catch (_) {}
    },
  };
  window.addEventListener('shell:title-change', () => { window.watchLive.setActive(window._activeTitleId); });

  // ---- watch listening → chars heard, Timeline coverage, furthest-reached ---
  // The watch reports listen-time deltas with a position checkpoint, but the
  // phone-side cue consumption (which counts audio chars, paints the Timeline
  // coverage spine, and advances chapter-completion's furthest-reached mark)
  // never sees watch playback — so watch sessions showed minutes of listening
  // with ~0 chars, no purple coverage fill, and no chapter progress. Credit
  // the [prev,ms) span between consecutive checkpoints to all three,
  // continuity-gated like the phone's own live counter: an advance far beyond
  // the reported seconds (×2.5 rate headroom) is a seek → anchor only, no
  // credit. A cue counts toward chars when its START falls inside the span,
  // so consecutive deltas never double-count a cue. mode-coverage's ms credit
  // needs no cue list at all; ai-chunks' furthest-ms credit only touches the
  // durable `ms` field (see creditFurthestMs's own comment for why it stops
  // there — jp/completion need the right cue list, which isn't guaranteed
  // available for a title that isn't the one open on the phone right now).
  let _wcCues = { tid: null, cues: null };   // one-slot parse cache
  async function watchCuesFor(tid) {
    if (_wcCues.tid === tid) return _wcCues.cues;
    let cues = null;
    try {
      if (tid === window._activeTitleId && Array.isArray(window._srtCues) && window._srtCues.length) {
        cues = window._srtCues;
      } else {
        const raw = await window.blobStore?.get?.('SRT_CUES_V1_' + tid);
        const obj = raw ? JSON.parse(raw) : null;
        if (obj && Array.isArray(obj.cues) && obj.cues.length) cues = obj.cues;
      }
    } catch (_) {}
    _wcCues = { tid, cues };
    return cues;
  }
  async function creditWatchListen(tid, sec, ms) {
    try {
      if (!tid || !(sec > 0) || !(ms > 0)) return;
      const key = 'WATCH_CHARS_POS_' + tid;
      let prev = 0;
      try { prev = Number(localStorage.getItem(key)) || 0; } catch (_) {}
      try { localStorage.setItem(key, String(Math.round(ms))); } catch (_) {}
      if (!(prev > 0) || ms <= prev) return;              // first checkpoint / backward → anchor only
      const advance = ms - prev;
      if (advance > sec * 1000 * 2.5 + 8000) return;      // seek, not continuous listening

      // Timeline coverage spine + furthest-reached — ms-only, no cue list
      // needed, so these run even if the cue fetch below comes up empty.
      try { window.modeCoverage?.creditRange?.(tid, prev, ms, 'audio', 'ms', true, 'watch'); } catch (_) {}
      try { window.aiChunks?.creditFurthestMs?.(tid, ms); } catch (_) {}

      if (!window.stats?.incrementAudioChars) return;
      const cues = await watchCuesFor(tid);
      if (!cues) return;
      let total = 0;
      for (const c of cues) {
        if (!c || !Number.isFinite(c.startMs) || c.startMs < prev || c.startMs >= ms) continue;
        if (c.text) total += window.jpCharCount ? window.jpCharCount(c.text) : c.text.length;
      }
      if (total > 0) window.stats.incrementAudioChars(total);
    } catch (_) {}
  }

  function wireListeners() {
    const plugin = WB();
    if (!plugin || wireListeners._done) return;
    wireListeners._done = true;
    try {
      plugin.addListener('watchTransfer', (d) => {
        try {
          const el = document.getElementById('watchSendStatus');
          if (!el || !d?.transfers?.length) return;
          const parts = d.transfers.map((t) =>
            (t.role === 'audio' ? 'audio ' : 'cues ') + Math.round((t.fraction || 0) * 100) + '%');
          el.textContent = 'Transferring: ' + parts.join(' · ');
        } catch (_) {}
      });
      plugin.addListener('watchTransferDone', (d) => {
        try {
          const el = document.getElementById('watchSendStatus');
          if (el) el.textContent = d.ok ? ('Sent ' + d.role + ' ✓') : ('Transfer failed: ' + (d.error || 'unknown'));
          if (d.role === 'audio' && d.ok) {
            window.showToast?.('Sent to Apple Watch', 2200);
            try { localStorage.setItem('WATCH_SENT_' + (d.titleId || ''), String(Date.now())); } catch (_) {}
          }
        } catch (_) {}
      });
      // Watch position checkpoints → forward-only furthest merge (also feeds
      // the per-title daily stats via the updateFurthest hook).
      plugin.addListener('watchPosition', (d) => {
        try {
          try { window.debugLog?.('[watch] positions in: ' + (d?.positions || []).map(p => (p.titleId || '?').slice(0, 6) + '@' + Math.round(p.ms || 0) + 'ms ts=' + Math.round(p.ts || 0)).join(' ')); } catch (_) {}
          for (const p of (d?.positions || [])) {
            if (p.titleId && Number(p.furthestMs) > 0 && window.bookmarks?.updateFurthest) {
              window.bookmarks.updateFurthest(String(p.titleId), Number(p.furthestMs));
            }
            // Resume adoption: fresher-listen-wins (guarded inside — never
            // while this phone is actively playing that title).
            if (p.titleId && Number(p.ms) > 0 && Number(p.ts) > 0) {
              window.abAdoptExternalPosition?.(String(p.titleId), Number(p.ms), Number(p.ts));
            }
          }
        } catch (_) {}
      });
      // Listen-time deltas → per-title daily stats (watch category) + the
      // global audio listening total; also carries a position checkpoint.
      plugin.addListener('watchListen', (d) => {
        try {
          try { window.debugLog?.('[watch] listen in: sec=' + Math.round(Number(d?.sec) || 0) + ' ms=' + Math.round(Number(d?.ms) || 0) + ' ts=' + Math.round(Number(d?.ts) || 0)); } catch (_) {}
          const tid = String(d?.titleId || '');
          const sec = Number(d?.sec) || 0;
          if (tid && sec > 0) {
            window.titleStats?.noteTime(tid, 'watch', Math.round(sec));
            window.stats?.addWatchListening?.(sec);
            // chars heard + Timeline coverage + furthest-reached — from the
            // span between checkpoints
            if (Number(d?.ms) > 0) creditWatchListen(tid, sec, Number(d.ms));
          }
          if (tid && Number(d?.furthestMs) > 0) window.bookmarks?.updateFurthest(tid, Number(d.furthestMs));
          if (tid && Number(d?.ms) > 0 && Number(d?.ts) > 0) {
            window.abAdoptExternalPosition?.(tid, Number(d.ms), Number(d.ts));
          }
        } catch (_) {}
      });
      // Word flags from the watch → lookup history (source 'watch', with the
      // cue sentence + time range so Anki gets the right audio slice later).
      plugin.addListener('watchFlag', async (d) => {
        try {
          // word may be EMPTY: the watch flags whole subtitles — the user
          // picks the word to look up later, on the phone, in the viewer.
          if (!d || (!d.word && !d.cueText)) return;
          const tid = String(d.titleId || '');
          let titleName = '';
          try { titleName = (await window.titleStore?.get?.(tid))?.name || ''; } catch (_) {}
          window.lookupLog?.add({
            term: String(d.word || ''), base: String(d.word || ''), source: 'watch',
            titleId: tid, titleName,
            ctx: {
              sentence: String(d.cueText || ''),
              cueStartMs: Number(d.s), cueEndMs: Number(d.e),
              cueAudioPath: null,
            },
          });
          window.showToast?.(d.word ? ('Flagged from watch: ' + d.word) : 'Subtitle flagged from watch', 2000);
        } catch (_) {}
      });
      // Watch tapped its sync button: push FRESH positions immediately.
      plugin.addListener('watchSyncRequest', () => { pushPositionsToWatch(true); });
      // (Phase B cue paging from the watch arrives as a normal BackgroundAudio
      // 'remoteCommand' nextCue/prevCue — the same channel as the lock-screen
      // ⏮⏭ buttons — so no WatchBridge listener is needed for it here.)
      // Replay records the plugin buffered before these listeners existed
      // (queued userInfo replays + activation-time receivedApplicationContext).
      plugin.flushPending?.().catch?.(() => {});
    } catch (_) {}
  }
  // Plugins register at bridge load — wire once the page settles.
  setTimeout(wireListeners, 1200);
})();
