// keep-awake.js — optional "keep the screen on while reading", driven by the
// NATIVE keep-screen-on flag (UIApplication.isIdleTimerDisabled on iOS,
// FLAG_KEEP_SCREEN_ON on Android) exposed as BackgroundAudio.setKeepAwake({on}).
//
// (Earlier this used the Web Screen Wake Lock API — navigator.wakeLock — which is
// absent/unreliable in iOS WKWebView and Android System WebView, so it silently
// did nothing. The native flag works on all OS versions.)
//
// localStorage['KEEP_AWAKE_MIN']: '0'/null = OFF (default); a positive N = keep
// the display awake while the user is active, releasing after N minutes with NO
// interaction (every tap / scroll / page-turn / key restarts the countdown). The
// flag is released when the app is backgrounded (so the device can sleep during a
// screen-off listen) and re-asserted on return. preferences.js dual-writes
// Capacitor Preferences; app.js mirrors the value back to localStorage at boot.
// Display-only: never reads/writes/seeks reading or audio position.
(function () {
  'use strict';

  const KEY = 'KEEP_AWAKE_MIN';
  const native = () => (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundAudio) || null;

  let held = false, releaseTimer = 0, lastBump = 0;

  function minutes() { try { return parseInt(localStorage.getItem(KEY), 10) || 0; } catch (_) { return 0; } }
  function enabled() { return !!native() && minutes() > 0; }

  function setNative(on) {
    const p = native();
    if (!p || !p.setKeepAwake) return;   // graceful no-op if the native method isn't present (old build)
    try { const r = p.setKeepAwake({ on: !!on }); if (r && r.catch) r.catch(() => {}); } catch (_) {}
  }
  function acquire() {
    if (!enabled() || held || document.hidden) return;
    held = true; setNative(true);
  }
  function drop() {
    if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = 0; }
    if (held) { held = false; setNative(false); }
  }
  function armTimer() {
    if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = 0; }
    const m = minutes();
    if (m > 0) releaseTimer = setTimeout(drop, m * 60000);
  }
  function refresh() {
    if (enabled()) { acquire(); armTimer(); }
    else { drop(); }
  }
  function onActivity() {
    if (!enabled()) return;
    const now = Date.now();
    if (now - lastBump < 2000) { armTimer(); return; }   // throttle the per-event work; always re-arm the countdown
    lastBump = now; acquire(); armTimer();
  }

  ['pointerdown', 'touchstart', 'keydown'].forEach((ev) =>
    document.addEventListener(ev, onActivity, { passive: true, capture: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (held) { held = false; setNative(false); } }   // let the device sleep while backgrounded
    else refresh();                                                          // re-assert + re-arm on return
  });

  window.keepAwake = { refresh, supported: true };   // capability is now checked per-call via enabled()

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh);
  else refresh();
})();
