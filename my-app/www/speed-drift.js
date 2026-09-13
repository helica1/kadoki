// speed-drift.js — optional slow acceleration while reading undisturbed.
//
// With "Speed drift" on (Preferences → Read), read-mode playback creeps up by
// a small amount per minute for as long as the interface is left alone — the
// ear adapts, so the speed you can follow at minute 20 is higher than the one
// you set at minute 0. The drift is TRANSIENT: it rides on top of the saved
// rate (window._rateDrift, applied by applyActivePlaybackRate) and is dropped
// the moment you look a word up, scrub, or change the speed yourself, so the
// next restart begins at the speed you actually chose.
(function () {
  'use strict';
  const PREF = 'READ_SPEED_DRIFT';     // per-minute increment, '0' = off
  const TICK_MS = 10000;
  const DRIFT_MAX = 2.0;               // never drift past this multiplier
  let lastTick = 0, lastTitle = null;

  function perMinute() {
    try { const v = parseFloat(localStorage.getItem(PREF) || '0'); return Number.isFinite(v) && v > 0 ? v : 0; }
    catch (_) { return 0; }
  }
  function enabled() { return perMinute() > 0; }

  function reset(reason) {
    const had = Number(window._rateDrift) > 0;
    window._rateDrift = 0;
    lastTick = Date.now();
    if (!had) return;
    try { console.log('[speed-drift] reset (' + (reason || '?') + ')'); } catch (_) {}
    // Push the base rate to the engine AND repaint the readout. Re-asserted on
    // the next frame too: a reset often lands in the middle of a pause/resume
    // handoff, and the engine can overwrite the rate as it settles.
    try { window.applyActivePlaybackRate?.(); } catch (_) {}
    setTimeout(() => { try { window.applyActivePlaybackRate?.(); } catch (_) {} }, 250);
    try { window._diag?.('[paged-diag] speed drift reset (' + (reason || '?') + ') → ' + (window.effectivePlaybackRate ? window.effectivePlaybackRate().toFixed(2) : '?') + '×'); } catch (_) {}
  }
  function driftMs() { return Number(window._rateDrift) || 0; }

  function tick() {
    const per = perMinute();
    const now = Date.now();
    // A title switch starts a fresh session at the chosen speed. (No event
    // exists for this; the active id is the signal.)
    const tid = window._activeTitleId || null;
    if (tid !== lastTitle) { lastTitle = tid; if (driftMs() > 0) reset('title'); lastTick = now; return; }
    if (!per) { lastTick = now; return; }
    const reading = document.body.classList.contains('mode-read');
    if (!reading || !window._bgPlaying || document.hidden) { lastTick = now; return; }
    if (!lastTick) { lastTick = now; return; }
    const mins = (now - lastTick) / 60000;
    lastTick = now;
    if (!(mins > 0)) return;
    const base = window.getActivePlaybackRate ? window.getActivePlaybackRate() : 1;
    const room = Math.max(0, DRIFT_MAX - base - driftMs());
    if (room <= 0.0001) return;
    const add = Math.min(room, per * mins);
    if (add <= 0.0001) return;
    window._rateDrift = Math.round((driftMs() + add) * 1000) / 1000;
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

  window.speedDrift = { reset, enabled, perMinute, drift: driftMs };
})();
