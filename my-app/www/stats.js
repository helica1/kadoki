// stats.js — independent per-mode session timers.
//
//   card  — counts time + # cards advanced. Stops after 20 s of no touch.
//   read  — counts time + chars (chars pulled from reading-mode). Stops
//           after 2 min of no touch, UNLESS audio is currently playing
//           (because passive listening while reading is normal).
//   audio — tied to BackgroundAudio play state. Running iff audio is
//           playing. No inactivity timeout — screen-off / no-touch is
//           the whole point of audio mode. Time math uses Date.now()
//           around play/pause transitions so it's correct even when the
//           WebView was suspended during a screen-off interval.
//
// Mode switch behaviour: stop the prior mode's timer immediately. The
// new mode's timer starts on the NEXT interaction in that mode (so just
// glancing at a tab doesn't accrue time). audio doesn't follow this
// rule — its timer is bg-state-driven regardless of the active mode.
//
// Stopping a timer by inactivity also pauses any audio that mode owns.

(function () {
  const KEY_PREFIX = 'STATS_V1_';
  const TIMEOUT_CARD_SEC = 20;
  const TIMEOUT_READ_SEC = 120;

  const timers = {
    card:  { totalSec: 0, cards: 0, lastInteraction: 0, runningSince: 0 },
    read:  { totalSec: 0,           lastInteraction: 0, runningSince: 0 },
    audio: { totalSec: 0,                                runningSince: 0 },
  };

  function persistableShape(mode) {
    const t = timers[mode];
    const out = { totalSec: t.totalSec };
    if (mode === 'card') out.cards = t.cards;
    return out;
  }
  function persist(mode) {
    try { localStorage.setItem(KEY_PREFIX + mode, JSON.stringify(persistableShape(mode))); } catch (e) {}
  }
  function load() {
    for (const mode of ['card', 'read', 'audio']) {
      try {
        const raw = localStorage.getItem(KEY_PREFIX + mode);
        if (!raw) continue;
        const o = JSON.parse(raw);
        if (Number.isFinite(o.totalSec)) timers[mode].totalSec = o.totalSec;
        if (mode === 'card' && Number.isFinite(o.cards)) timers[mode].cards = o.cards;
      } catch (e) {}
      timers[mode].runningSince = 0;
    }
  }

  function currentMode() {
    const body = document.body;
    if (body.classList.contains('mode-audio')) return 'audio';
    if (body.classList.contains('mode-read'))  return 'read';
    return 'card';
  }

  function startMode(mode) {
    const t = timers[mode];
    if (t.runningSince) return;
    t.runningSince = Date.now();
    if ('lastInteraction' in t) t.lastInteraction = Date.now();
    console.log('[stats] start ' + mode);
  }

  function stopMode(mode, opts) {
    const t = timers[mode];
    if (!t.runningSince) return;
    const elapsed = (Date.now() - t.runningSince) / 1000;
    t.totalSec += elapsed;
    t.runningSince = 0;
    persist(mode);
    console.log('[stats] stop ' + mode + ' (+' + elapsed.toFixed(1) + 's, total ' + t.totalSec.toFixed(0) + 's)');
    if (opts?.byInactivity) {
      // Inactivity stop also pauses mode-owned audio.
      if (mode === 'card' && typeof window.stopCardAudio === 'function') window.stopCardAudio();
      if (mode === 'read') {
        try { window.Capacitor?.Plugins?.BackgroundAudio?.pause?.(); } catch (e) {}
      }
    }
  }

  // touch — call from any user interaction. Starts the current mode's
  // timer if it wasn't running; refreshes lastInteraction.
  function touch(mode) {
    if (!mode) mode = currentMode();
    if (mode === 'audio') return; // audio is bg-state-driven
    const t = timers[mode];
    t.lastInteraction = Date.now();
    if (!t.runningSince) startMode(mode);
  }

  // Mode switch — stop the prior, queue new (it'll start on first touch).
  let lastMode = null;
  function handleModeChange(newMode) {
    if (newMode === lastMode) return;
    if (lastMode === 'card' || lastMode === 'read') stopMode(lastMode);
    lastMode = newMode;
  }

  // Periodic check: inactivity timeouts + audio-bg-state reconciliation.
  function tick() {
    const mode = currentMode();
    if (lastMode === null) lastMode = mode;
    handleModeChange(mode);

    const now = Date.now();
    // Card inactivity.
    if (timers.card.runningSince) {
      const idleSec = (now - timers.card.lastInteraction) / 1000;
      if (idleSec > TIMEOUT_CARD_SEC) stopMode('card', { byInactivity: true });
    }
    // Read inactivity — skipped while audio is playing.
    if (timers.read.runningSince) {
      const idleSec = (now - timers.read.lastInteraction) / 1000;
      const audioPlaying = !!window._bgPlaying;
      if (!audioPlaying && idleSec > TIMEOUT_READ_SEC) {
        stopMode('read', { byInactivity: true });
      }
    }
    // Audio mode — defensive: only run the audio timer when the user is
    // currently in audio mode AND bg playback is on. Mode switch alone
    // away from audio should stop it even if audio keeps playing.
    const inAudioMode = mode === 'audio';
    if (window._bgPlaying && inAudioMode && !timers.audio.runningSince) startMode('audio');
    if ((!window._bgPlaying || !inAudioMode) && timers.audio.runningSince) stopMode('audio');

    // Mark read mode as "active" while audio is playing — prevents the
    // timeout from firing during long passive-listening stretches even
    // though there's no touch.
    if (window._bgPlaying && timers.read.runningSince) {
      timers.read.lastInteraction = now;
    }
  }
  setInterval(tick, 1000);

  // Hook BackgroundAudio state events so the audio-mode timer follows
  // playback exactly — BUT only count when the user is actively in
  // audio mode. Card-mode SRT playback uses the same plugin and we
  // don't want that time to leak into "audio listening" stats.
  function ensureAudioBgHooked() {
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (!bg || window._statsAudioHooked) return;
    window._statsAudioHooked = true;
    try {
      bg.addListener('state', (d) => {
        const inAudioMode = document.body.classList.contains('mode-audio');
        if (d.playing && inAudioMode) startMode('audio');
        else stopMode('audio');
      });
    } catch (e) {}
  }
  setTimeout(ensureAudioBgHooked, 500);
  setTimeout(ensureAudioBgHooked, 1500); // retry after plugin warms up

  // Capture-phase touch listeners — feed touch() on every interaction.
  document.addEventListener('touchstart', () => touch(), { passive: true, capture: true });
  document.addEventListener('mousedown',  () => touch(), { passive: true, capture: true });

  load();

  // Public API.
  function liveTotal(mode) {
    const t = timers[mode];
    if (t.runningSince) return t.totalSec + (Date.now() - t.runningSince) / 1000;
    return t.totalSec;
  }
  function isRunning(mode) { return !!timers[mode].runningSince; }
  function incrementCardCount() { timers.card.cards++; persist('card'); }
  function resetAll() {
    for (const m of Object.keys(timers)) {
      const t = timers[m];
      t.totalSec = 0;
      t.runningSince = 0;
      if (m === 'card') t.cards = 0;
      persist(m);
    }
  }
  function resetMode(mode) {
    const t = timers[mode];
    if (!t) return;
    t.totalSec = 0;
    t.runningSince = 0;
    if (mode === 'card') t.cards = 0;
    persist(mode);
  }

  window.stats = {
    liveTotal, isRunning,
    getCardSec:  () => liveTotal('card'),
    getReadSec:  () => liveTotal('read'),
    getAudioSec: () => liveTotal('audio'),
    getCardCount: () => timers.card.cards,
    incrementCardCount,
    touch, resetAll, resetMode, persist,
  };
})();
