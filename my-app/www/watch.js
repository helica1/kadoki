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
      if (!st.installed) { status('Install the Kadoki app on your watch first (Watch app on iPhone → Available Apps).'); return; }
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
      try { localStorage.setItem('WATCH_CUES_SENT_' + tid, String(cues.length)); } catch (_) {}
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

  // AUTO cue refresh: the transcriber now runs up to an HOUR ahead of the
  // playhead specifically so the watch stays covered through a walk/run.
  // Whenever this title's audio is already on the watch and the cue list has
  // grown meaningfully, silently re-send the (small) cues bundle — no dialog.
  let _autoCuesLastAt = 0;
  async function autoRefreshWatchCues() {
    try {
      const plugin = WB();
      if (!plugin || document.hidden) return;
      const tid = window._activeTitleId;
      if (!tid) return;
      if (!localStorage.getItem('WATCH_SENT_' + tid)) return;   // audio not on the watch
      const now = Date.now();
      if (now - _autoCuesLastAt < 180000) return;               // ≤ 1 send / 3 min
      const cues = bundleCues();
      const sent = parseInt(localStorage.getItem('WATCH_CUES_SENT_' + tid) || '0', 10) || 0;
      if (cues.length < sent + 150) return;                     // not enough new coverage
      const title = await window.titleStore.get(tid);
      const ab = title?.attachments?.audiobook;
      if (!ab?.cachePath) return;
      let durMs = 0;
      try { const g = window.getAudioProgress?.(); if (g && Number(g.dur) > 0) durMs = Math.round(g.dur); } catch (_) {}
      _autoCuesLastAt = now;
      await plugin.sendTitle({
        titleId: tid, name: title.name || 'Untitled', audioPath: ab.cachePath,
        durMs, cues, cuesOnly: true,
        cover: title.attachments?.cover?.dataUri || null,
      });
      localStorage.setItem('WATCH_CUES_SENT_' + tid, String(cues.length));
      try { window.debugLog?.('[watch] auto cues refresh: ' + cues.length + ' cues (was ' + sent + ')'); } catch (_) {}
    } catch (_) {}
  }
  setInterval(autoRefreshWatchCues, 60000);

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
          const tid = String(d?.titleId || '');
          const sec = Number(d?.sec) || 0;
          if (tid && sec > 0) {
            window.titleStats?.noteTime(tid, 'watch', Math.round(sec));
            window.stats?.addWatchListening?.(sec);
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
      // Replay records the plugin buffered before these listeners existed
      // (queued userInfo replays + activation-time receivedApplicationContext).
      plugin.flushPending?.().catch?.(() => {});
    } catch (_) {}
  }
  // Plugins register at bridge load — wire once the page settles.
  setTimeout(wireListeners, 1200);
})();
