// speed-drift.js — optional slow acceleration while reading undisturbed.
//
// With "Speed drift" on (Preferences → Read), read-mode playback creeps up by
// a small amount per minute for as long as the interface is left alone — the
// ear adapts, so the speed you can follow at minute 20 is higher than the one
// you set at minute 0. The drift is TRANSIENT: it rides on top of the saved
// rate (window._rateDrift, applied by applyActivePlaybackRate) and is dropped
// the moment you look a word up, scrub, pause, or change the speed yourself,
// so the next restart begins at the speed you actually chose.
(function () {
  'use strict';
  const PREF = 'READ_SPEED_DRIFT';     // per-minute increment, '0' = off
  const TICK_MS = 2000;                // also the backstop rate for "should have reset by now"
  const VERIFY_EVERY = 5;              // confirm the play flag natively every 5th tick while drifting
  const DRIFT_MAX = 2.0;               // never drift past this multiplier
  let lastTick = 0, lastTitle = null, ticks = 0, verifying = false;

  function perMinute() {
    try { const v = parseFloat(localStorage.getItem(PREF) || '0'); return Number.isFinite(v) && v > 0 ? v : 0; }
    catch (_) { return 0; }
  }
  function enabled() { return perMinute() > 0; }
  function drift() { return Number(window._rateDrift) || 0; }

  // Repaint every speed readout from the single source of truth. Called on its
  // own as well as through applyActivePlaybackRate, because that function only
  // fires 'playback:rate' AFTER awaiting the native setRate call — on a reset
  // the number on screen has to be right immediately, not one bridge round
  // trip later. This is what made the return to base speed look unreliable.
  function repaint() {
    try { window._pagedPaintSpeed?.(); } catch (_) {}
    try {
      const r = window.effectivePlaybackRate ? window.effectivePlaybackRate() : null;
      if (r != null) window.dispatchEvent(new CustomEvent('playback:rate', { detail: { rate: r } }));
    } catch (_) {}
  }

  function reset(reason) {
    const had = drift() > 0;
    window._rateDrift = 0;
    lastTick = Date.now();
    if (!had) return;
    // Order matters: paint first (synchronous, instant), then push the base
    // rate to the engine (asynchronous), then re-assert once the pause/resume
    // handoff has settled — the engine can overwrite the rate as it starts.
    repaint();
    try { window.applyActivePlaybackRate?.(); } catch (_) {}
    setTimeout(() => { try { window.applyActivePlaybackRate?.(); } catch (_) {} repaint(); }, 250);
    try { console.log('[speed-drift] reset (' + (reason || '?') + ')'); } catch (_) {}
    try { window._diag?.('[paged-diag] speed drift reset (' + (reason || '?') + ') → ' + (window.effectivePlaybackRate ? window.effectivePlaybackRate().toFixed(2) : '?') + '×'); } catch (_) {}
  }

  // The play flag is a mirror of native state and has gone stale-true before
  // (lock-screen and background transitions). While drifting that would keep
  // the speed climbing through a pause, which reads exactly like "it never goes
  // back to base". Confirm against the engine now and then, and believe it.
  async function verifyStillPlaying() {
    if (verifying) return;
    verifying = true;
    try {
      const bg = window.Capacitor?.Plugins?.BackgroundAudio;
      if (!bg?.getState) return;
      const s = await bg.getState();
      if (s && !s.playing && drift() > 0) reset('not-playing');
    } catch (_) {} finally { verifying = false; }
  }

  function tick() {
    const per = perMinute();
    const now = Date.now();
    ticks++;
    // A title switch starts a fresh session at the chosen speed. (No event
    // exists for this; the active id is the signal.)
    const tid = window._activeTitleId || null;
    if (tid !== lastTitle) { lastTitle = tid; if (drift() > 0) reset('title'); lastTick = now; return; }
    if (!per) { if (drift() > 0) reset('pref-off'); lastTick = now; return; }
    const reading = document.body.classList.contains('mode-read');
    const playing = !!window._bgPlaying;
    if (!reading || !playing || document.hidden) {
      // BACKSTOP for every stop path that doesn't reach us as an event. Drift
      // only survives while read-mode playback is actually running, so if it
      // isn't, the speed goes back to base here — no matter which pause path
      // (native state event, mode switch, app background) got us here.
      if (drift() > 0 && !(reading && playing)) reset(!reading ? 'left-read' : 'paused');
      lastTick = now;
      return;
    }
    if (drift() > 0 && ticks % VERIFY_EVERY === 0) verifyStillPlaying();
    if (!lastTick) { lastTick = now; return; }
    const mins = (now - lastTick) / 60000;
    lastTick = now;
    if (!(mins > 0)) return;
    const base = window.getActivePlaybackRate ? window.getActivePlaybackRate() : 1;
    const room = Math.max(0, DRIFT_MAX - base - drift());
    if (room <= 0.0001) return;
    const add = Math.min(room, per * mins);
    if (add <= 0.0001) return;
    window._rateDrift = Math.round((drift() + add) * 1000) / 1000;
    // applyActivePlaybackRate pushes the new rate to the engine AND fires
    // 'playback:rate', which repaints the on-screen readout.
    try { window.applyActivePlaybackRate?.(); } catch (_) {}
    try {
      const eff = window.effectivePlaybackRate ? window.effectivePlaybackRate() : null;
      window._diag?.('[paged-diag] speed drift +' + add.toFixed(3) + ' → drift ' + window._rateDrift.toFixed(3) + ' effective ' + (eff != null ? eff.toFixed(2) : '?') + '×');
    } catch (_) {}
  }

  setInterval(tick, TICK_MS);
  document.addEventListener('visibilitychange', () => { lastTick = Date.now(); });

  window.speedDrift = { reset, enabled, perMinute, drift, repaint };
})();
