// stats.js — independent per-mode session timers.
//
//   card  — counts time + # cards advanced. Started ONLY by a card-mode
//           swipe (bumpCard); stops after 20 s of no swipe, on mode
//           switch, or the instant the app backgrounds / phone locks.
//           Stray taps on chrome / dict frags / etc. do not start or
//           refresh the timer.
//   read  — counts time + chars (chars pulled from reading-mode).
//           Started by an explicit reading signal (bumpRead) — scroll,
//           dict open, playback. Stops after 2 min of no signal, UNLESS
//           audio is playing (passive listening counts as activity),
//           or on background / mode switch.
//   audio — tied to BackgroundAudio play state. Running iff audio is
//           playing AND the user is in mode-audio. No inactivity
//           timeout — screen-off / no-touch is the whole point of audio
//           mode. The audio timer is NOT stopped on backgrounding for
//           the same reason — the foreground service keeps playback
//           alive, the user is still listening.
//
// Mode switch behaviour: stop the prior mode's timer immediately. The
// new mode's timer starts on the NEXT bumpCard / bumpRead in that mode
// (so just glancing at a tab doesn't accrue time). audio doesn't follow
// this rule — its timer is bg-state-driven regardless of the active mode.
//
// Time accrual safety: stopMode caps credited elapsed at
// `lastInteraction + timeout` whenever it stops by inactivity, so an
// edge case where tick fires after a long background gap can't credit
// the gap as active time. Backgrounding stops timers immediately via
// visibilitychange + Capacitor App appStateChange listeners; the cap
// is a backstop if those fire late.
//
// Stopping a timer by inactivity also pauses any audio that mode owns.

(function () {
  const KEY_PREFIX = 'STATS_V1_';
  const TIMEOUT_CARD_SEC = 20;
  const TIMEOUT_READ_SEC = 120;
  // Max chars a single noteReadPosition step may credit. Continuous reading
  // advances a few hundred chars between scroll events; a bigger jump is a
  // seek/jump-to-percent and must NOT credit the skipped gap as read.
  const READ_DELTA_CAP = 4000;

  // Japanese-only character count — the ッツ/ttu-reader standard. Counts kana,
  // kanji, ideographs, and a few fullwidth alphanumerics; drops punctuation,
  // whitespace, and latin. Mirrors ebook-reader-2.0.0's get-character-count.ts
  // so a book's reported total matches ttu (e.g. 秘密 → ~200,9xx, not 223k).
  // Callers pass ruby-free text, so furigana is already excluded.
  const JP_ONLY_RE = /[^0-9A-Z○◯々-〇〻ぁ-ゖゝ-ゞァ-ヺー０-９Ａ-Ｚｦ-ﾝ\p{Radical}\p{Unified_Ideograph}]+/gimu;
  function jpCharCount(s) {
    if (!s) return 0;
    // Spread so surrogate pairs (e.g. 𠮟) count as one character.
    return [...String(s).replace(JP_ONLY_RE, '')].length;
  }
  // HTML/ruby-aware variant: strips <rt>/<rp> (furigana) and all markup first,
  // then counts Japanese chars. Used for card expressions, which carry HTML.
  function jpCharCountHtml(html) {
    if (typeof html !== 'string' || html.indexOf('<') < 0) return jpCharCount(html);
    try {
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      tmp.querySelectorAll('rt, rp').forEach(n => n.remove());
      return jpCharCount(tmp.textContent || '');
    } catch (_) {
      return jpCharCount(html.replace(/<[^>]+>/g, ''));
    }
  }
  window.jpCharCount = jpCharCount;
  window.jpCharCountHtml = jpCharCountHtml;

  const timers = {
    card:  { totalSec: 0, cards: 0, chars: 0, lastInteraction: 0, runningSince: 0 },
    // Read + audio gained `chars` per user request — chars-read was a
    // card-only stat for too long. `maxCharOffsetSeen` is used by the
    // read-mode scroll hook to compute deltas: only NEW territory adds
    // to chars (scrolling back and re-passing already-read text does
    // not double-count). `baselineSet` is the "have we anchored a
    // starting position yet?" flag — the first call after a reset
    // (or fresh session) anchors the baseline without crediting anything,
    // so a user who resets at char 35,000 doesn't immediately get
    // credited with 35k chars on the next scroll.
    read:  { totalSec: 0, chars: 0, maxCharOffsetSeen: 0, baselineSet: false, lastInteraction: 0, runningSince: 0 },
    audio: { totalSec: 0, chars: 0,                                           runningSince: 0 },
  };

  function persistableShape(mode) {
    const t = timers[mode];
    const out = { totalSec: t.totalSec };
    if (mode === 'card')  { out.cards = t.cards; out.chars = t.chars; }
    if (mode === 'read')  { out.chars = t.chars; out.maxCharOffsetSeen = t.maxCharOffsetSeen; out.baselineSet = t.baselineSet; }
    if (mode === 'audio') { out.chars = t.chars; }
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
        if (mode === 'card' && Number.isFinite(o.chars)) timers[mode].chars = o.chars;
        if (mode === 'read' && Number.isFinite(o.chars)) timers[mode].chars = o.chars;
        if (mode === 'read' && Number.isFinite(o.maxCharOffsetSeen))
          timers[mode].maxCharOffsetSeen = o.maxCharOffsetSeen;
        if (mode === 'read' && typeof o.baselineSet === 'boolean')
          timers[mode].baselineSet = o.baselineSet;
        if (mode === 'audio' && Number.isFinite(o.chars)) timers[mode].chars = o.chars;
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

  // Only one timer at a time: starting one stops the others.
  function startMode(mode) {
    const t = timers[mode];
    if (t.runningSince) return;
    for (const other of ['card', 'read', 'audio']) {
      if (other !== mode && timers[other].runningSince) stopMode(other);
    }
    t.runningSince = Date.now();
    if ('lastInteraction' in t) t.lastInteraction = Date.now();
    console.log('[stats] start ' + mode);
  }

  // Stop whichever timer is currently running. Used by openReadingStats
  // so opening the stats popup doesn't continue ticking time the user
  // obviously isn't using.
  function stopAll() {
    for (const m of ['card', 'read', 'audio']) {
      if (timers[m].runningSince) stopMode(m);
    }
  }

  function stopMode(mode, opts) {
    const t = timers[mode];
    if (!t.runningSince) return;
    // Cap credited time when stopping by inactivity. The cap is
    // `lastInteraction + (mode's timeout)`, i.e. the latest moment the
    // timer SHOULD have stopped. Without this, a tick that fires hours
    // after the WebView wakes from background would credit all of that
    // time. With it, we credit at most one full timeout window past
    // the last real interaction.
    let endTs = Date.now();
    if ((opts?.byInactivity || opts?.byBackground) && 'lastInteraction' in t) {
      // byInactivity: cap at the moment the timer should have stopped.
      // byBackground: on iOS the visibilitychange event can fire late
      // (after WebView suspension), so Date.now() may already be far
      // past the real hide moment. Cap at the same bound so a late
      // event can't credit hours of suspended time.
      const timeoutSec = mode === 'card' ? TIMEOUT_CARD_SEC
                       : mode === 'read' ? TIMEOUT_READ_SEC
                       : 0;
      if (timeoutSec > 0) {
        const capTs = t.lastInteraction + timeoutSec * 1000;
        if (capTs < endTs) endTs = capTs;
      }
    }
    const elapsed = Math.max(0, (endTs - t.runningSince) / 1000);
    t.totalSec += elapsed;
    t.runningSince = 0;
    persist(mode);
    console.log('[stats] stop ' + mode + ' (+' + elapsed.toFixed(1) + 's, total ' + t.totalSec.toFixed(0) + 's)' +
      (opts?.byInactivity ? ' [byInactivity]' : '') +
      (opts?.byBackground ? ' [byBackground]' : ''));
    if (opts?.byInactivity) {
      // Inactivity stop also pauses mode-owned audio.
      if (mode === 'card' && typeof window.stopCardAudio === 'function') window.stopCardAudio();
      if (mode === 'read') {
        try { window.Capacitor?.Plugins?.BackgroundAudio?.pause?.(); } catch (e) {}
      }
    }
  }

  // touch — generic "user did something" signal. Refreshes
  // `lastInteraction` ONLY if the relevant mode's timer is already
  // running, so a stray tap on the chrome / status bar / dict frag
  // doesn't restart a stopped timer. Starting the timer is exclusively
  // the job of bumpCard / bumpRead — the explicit "meaningful
  // interaction" signals.
  //
  // Why this is stricter than before: the previous behavior auto-started
  // the card timer on any touchstart, which the user found too generous
  // (any tap restarted the 20s window, so the timer effectively never
  // hit its timeout during a session of light tapping). Per the chosen
  // rule: only a swipe restarts the card timer.
  function touch(mode) {
    if (!mode) mode = currentMode();
    if (mode === 'audio') return;
    const t = timers[mode];
    if (!t.runningSince) return;
    t.lastInteraction = Date.now();
  }

  // Visibility gate: when the WebView is hidden (screen lock, app
  // switcher, etc.) we don't want non-user signals — most notably the
  // BackgroundAudio `state` listener — to restart a timer we just
  // stopped via background-stop. The audiobook foreground service can
  // keep emitting `state` events while the phone is locked; without
  // this gate, a single late event would re-start the read timer and
  // accrue all of the lock time as active reading.
  //
  // Exception: during an Anki round-trip (URL handoff to AnkiMobile +
  // x-callback return) the page IS hidden, but we want timers to keep
  // running because the user is actively engaged in a workflow that
  // happens to background us briefly. The round-trip flag suspends
  // the gate, and the gate auto-resumes when the round-trip clears
  // (either via the appStateChange listener or the safety timeout).
  function _shouldIgnoreBump() {
    return document.visibilityState !== 'visible' && !_ankiRoundtripActive;
  }

  // Explicit read-mode activity signal — called from the read-mode scroll
  // handler, dict popup open, and playback start. Always starts (or
  // keeps alive) the read timer, EXCEPT when the page is hidden and
  // no anki round-trip is in flight (see _shouldIgnoreBump).
  function bumpRead() {
    if (_shouldIgnoreBump()) return;
    const t = timers.read;
    t.lastInteraction = Date.now();
    if (!t.runningSince) startMode('read');
  }

  // Explicit card-mode activity signal — called from the card-mode
  // swipe handlers (next/prev/Anki/replay swipes). Starts the card
  // timer fresh after an inactivity- or background-stop, and refreshes
  // lastInteraction while running. Stray non-swipe taps deliberately
  // don't call this. Same visibility gate as bumpRead.
  function bumpCard() {
    if (_shouldIgnoreBump()) return;
    const t = timers.card;
    t.lastInteraction = Date.now();
    if (!t.runningSince) startMode('card');
  }

  // ----- Anki round-trip suspension -----
  //
  // On iOS, sending to AnkiMobile hands off via `anki://x-callback-url`,
  // which briefly backgrounds us. Without coordination, our
  // background-stop would halt the read timer (the user feels like
  // they were "interrupted reading" rather than "added a card while
  // reading"). Mark the round-trip active before the handoff, and
  // both stopInteractiveTimersForBackground AND _shouldIgnoreBump
  // suspend their checks for the duration. Cleared on the next
  // foreground (appStateChange isActive=true) or after a 30 s safety
  // timeout in case the user never returns to our app.
  //
  // Android: AnkiBridge talks to AnkiDroid's ContentProvider directly,
  // so there's no handoff and no background event. Setting the flag
  // is harmless in that case — it just expires.
  let _ankiRoundtripActive = false;
  let _ankiRoundtripTimeout = null;
  function markAnkiRoundtripActive(timeoutMs) {
    _ankiRoundtripActive = true;
    if (_ankiRoundtripTimeout) clearTimeout(_ankiRoundtripTimeout);
    _ankiRoundtripTimeout = setTimeout(markAnkiRoundtripDone, timeoutMs || 30000);
    console.log('[stats] anki roundtrip START (background-stop suspended)');
  }
  function markAnkiRoundtripDone() {
    if (!_ankiRoundtripActive) return;
    _ankiRoundtripActive = false;
    if (_ankiRoundtripTimeout) clearTimeout(_ankiRoundtripTimeout);
    _ankiRoundtripTimeout = null;
    console.log('[stats] anki roundtrip END (background-stop resumed)');
  }

  // Mode switch — stop the prior interactive (card/read) timer.
  let lastMode = null;
  function handleModeChange(newMode) {
    if (newMode === lastMode) return;
    if (lastMode === 'card' || lastMode === 'read') stopMode(lastMode);
    lastMode = newMode;
  }

  // Reconcile every timer to the active mode. Stops the prior card/read timer
  // the instant the mode changes, and makes the audio timer track "bg playing
  // AND in audio mode" exactly (leaving audio mode stops it even if playback
  // continues — e.g. card-mode SRT clips share the plugin). Called immediately
  // on shell:mode-change AND every tick as a backstop.
  function reconcileMode(newMode) {
    if (!newMode) newMode = currentMode();
    if (lastMode === null) lastMode = newMode;
    handleModeChange(newMode);
    const inAudio = newMode === 'audio';
    if (window._bgPlaying && inAudio && !timers.audio.runningSince) startMode('audio');
    if ((!window._bgPlaying || !inAudio) && timers.audio.runningSince) stopMode('audio');
    // Card mirrors audio: while the playhead is running (continuous-mode SRT /
    // audio playback), entering card should start its timer too. Read already
    // starts via bumpRead on the bg 'state' listener; card had no equivalent,
    // so switching into card with audio playing never started the timer.
    const inCard = newMode === 'card';
    if (window._bgPlaying && inCard && !timers.card.runningSince) startMode('card');
  }

  // Periodic check: inactivity timeouts + a mode/audio reconciliation backstop.
  function tick() {
    reconcileMode(currentMode());

    const now = Date.now();
    // Card inactivity — skipped during CONTINUOUS PLAY (the user pressed play, so
    // cards auto-advance and audio plays continuously; they're actively listening,
    // not idle). Manual one-by-one viewing still times out at 20s of no swipe.
    const cardContinuousPlay = !!window._bgPlaying && !!window.audioAutoAdvance;
    if (timers.card.runningSince) {
      const idleSec = (now - timers.card.lastInteraction) / 1000;
      if (!cardContinuousPlay && idleSec > TIMEOUT_CARD_SEC) stopMode('card', { byInactivity: true });
    }
    // Keep the card timer alive while continuous play runs so a long, touch-free
    // listening stretch doesn't trip the 20s timeout (mirrors the read timer).
    if (cardContinuousPlay && timers.card.runningSince) {
      timers.card.lastInteraction = now;
    }
    // Read inactivity — skipped while audio is playing (passive listening).
    if (timers.read.runningSince) {
      const idleSec = (now - timers.read.lastInteraction) / 1000;
      const audioPlaying = !!window._bgPlaying;
      if (!audioPlaying && idleSec > TIMEOUT_READ_SEC) {
        stopMode('read', { byInactivity: true });
      }
    }
    // Keep read alive while audio plays so the timeout doesn't fire during
    // long passive-listening stretches with no touch.
    if (window._bgPlaying && timers.read.runningSince) {
      timers.read.lastInteraction = now;
    }
  }
  setInterval(tick, 1000);

  // Stop the prior mode's timer IMMEDIATELY on a mode switch — don't wait for
  // the next 1 s tick. E.g. read→audio: the read timer stops the instant the
  // switch happens (audio then starts when playback starts). The shell sets
  // the body mode class before firing this event, so currentMode() is already
  // correct; we prefer the event's explicit mode when present.
  window.addEventListener('shell:mode-change', (e) => {
    try { reconcileMode(e?.detail?.mode || currentMode()); } catch (_) {}
  });

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
        const inReadMode  = document.body.classList.contains('mode-read');
        if (d.playing && inAudioMode) startMode('audio');
        else stopMode('audio');
        // Read-mode: audio start kicks the read timer alive (bumpRead).
        // Audio STOP intentionally does NOT stop the read timer —
        // the user often wants to keep reading silently after pause,
        // and the 120 s inactivity timeout already handles "they
        // walked away" via the periodic tick check below. Previously
        // the listener insta-stopped the read timer the instant
        // audio paused, which felt too tight.
        if (inReadMode && d.playing) bumpRead();
      });
    } catch (e) {}
  }
  setTimeout(ensureAudioBgHooked, 500);
  setTimeout(ensureAudioBgHooked, 1500); // retry after plugin warms up

  // Capture-phase touch listeners — feed touch() on every interaction.
  // Now harmless for stopped timers (touch is a no-op when not running).
  document.addEventListener('touchstart', () => touch(), { passive: true, capture: true });
  document.addEventListener('mousedown',  () => touch(), { passive: true, capture: true });

  // -------- Backgrounding / visibility stop --------
  //
  // When the app backgrounds or the page is hidden (screen lock, app
  // switcher, foreground intent) we IMMEDIATELY stop the running card /
  // read timer. The audio timer is left alone — the foreground service
  // keeps audiobook playback alive even when the screen is locked, and
  // the user is by definition still listening.
  //
  // Why immediate stop: previously, `tick` (setInterval 1s) was the only
  // place that enforced inactivity timeouts. WebKit / WebView suspend
  // setInterval when the app backgrounds, so tick wouldn't fire again
  // until the user re-opened the app — by which point liveTotal had
  // accrued the entire background interval as "active" time. Users saw
  // 2+ hours of phantom card time after a day with the app open
  // intermittently. Stopping on backgrounding makes the timers tight.
  //
  // On foreground, we do NOT auto-resume. The user has to do a real
  // card-mode swipe (bumpCard) or read-mode action (bumpRead) to
  // restart. Glancing at the app shouldn't count as time.
  function stopInteractiveTimersForBackground() {
    if (_ankiRoundtripActive) {
      console.log('[stats] background-stop suppressed: anki roundtrip in progress');
      return;
    }
    let any = false;
    for (const m of ['card', 'read']) {
      if (timers[m].runningSince) { stopMode(m, { byBackground: true }); any = true; }
    }
    if (any) console.log('[stats] stopped interactive timers for background');
  }

  // 10 s grace period before background-stop fires. Brief
  // backgrounding (Anki round-trip, app switcher peek, lock-screen
  // glance, push notification swipe-down) shouldn't kill the
  // session. If the user comes back within 10 s the scheduled stop
  // is cancelled and the timers keep running.
  //
  // If we WERE suspended during the grace window, the cap inside
  // stopMode at `lastInteraction + timeout` ensures we don't credit
  // hours of suspended time even if the timer fires much later.
  const BACKGROUND_GRACE_MS = 10000;
  let _backgroundGraceTimer = null;
  function scheduleBackgroundStop() {
    if (_backgroundGraceTimer) return; // already scheduled
    _backgroundGraceTimer = setTimeout(() => {
      _backgroundGraceTimer = null;
      stopInteractiveTimersForBackground();
    }, BACKGROUND_GRACE_MS);
  }
  function cancelBackgroundStop() {
    if (_backgroundGraceTimer) {
      clearTimeout(_backgroundGraceTimer);
      _backgroundGraceTimer = null;
    }
  }

  // Audio mode is the ONLY mode that should keep playing with the screen off.
  // In card / read mode, pause playback the moment the screen turns off or the
  // app backgrounds. An in-flight anki round-trip is exempt (that's a
  // deliberate hop to AnkiMobile, not the user putting the phone down).
  function pauseAudioForBackgroundIfInteractive() {
    if (_ankiRoundtripActive) return;
    if (document.body.classList.contains('mode-audio')) return;
    if (!window._bgPlaying) return;
    try { window.Capacitor?.Plugins?.BackgroundAudio?.pause?.(); } catch (e) {}
  }

  // ── Background → AUDIO mode auto-switch ──
  // Backgrounding (screen off / home / app switch) while in READ or CARD mode
  // with audio playing seamlessly switches to AUDIO mode instead of pausing:
  // the read/card timer stops at the real hide moment and audio time starts
  // accruing (both happen synchronously via setShellMode → shell:mode-change →
  // reconcileMode, so an iOS WebView freeze right after can't corrupt them —
  // timers are wall-clock based). On foreground we return to the previous mode
  // synced to wherever the audio has reached. An in-flight Anki round-trip
  // (<1s hop to AnkiDroid/AnkiMobile) is exempt and behaves exactly as before.
  function handleAppHidden() {
    const b = document.body.classList;
    const interactive = b.contains('mode-read') ? 'read' : (b.contains('mode-card') ? 'card' : null);
    if (!_ankiRoundtripActive && interactive && window._bgPlaying &&
        typeof window.setShellMode === 'function' && !window._autoAudioPrevMode) {
      window._autoAudioPrevMode = interactive;
      try {
        // autoSwitch: skip the per-title lastMode persist — TITLES_V1 keeps
        // saying read/card, so a process death in background cold-boots into
        // the user's real mode at the position flushed by the leave-read hook.
        window.setShellMode('audio', { force: true, resumeOnly: true, autoSwitch: true });
      } catch (e) { window._autoAudioPrevMode = null; }
      scheduleBackgroundStop();   // backstop only — timers already reconciled
      return;
    }
    pauseAudioForBackgroundIfInteractive();
    scheduleBackgroundStop();
  }
  async function handleAppVisible() {
    cancelBackgroundStop();
    const prev = window._autoAudioPrevMode;
    if (!prev) return;
    window._autoAudioPrevMode = null;
    // Refresh the cue cursors from the live native playhead BEFORE switching
    // back — on iOS they froze at the pre-background value and the read/card
    // sync (ensureGreenOnEnter / syncCardToCurrentCue) reads them.
    try {
      const bg = window.Capacitor?.Plugins?.BackgroundAudio;
      if (bg?.getState) {
        const s = await bg.getState();
        if (s && Number(s.positionMs) > 0 && typeof window.abResyncCueFromMs === 'function') {
          window.abResyncCueFromMs(s.positionMs);
        }
      }
    } catch (_) {}
    // The hidden-time switch's async tail may still be in flight (iOS parks it
    // until thaw) and setShellMode silently drops calls while _switchInFlight —
    // retry until the mode actually flips. Abort (and re-arm) if re-hidden,
    // and DEFER TO THE USER: if the mode is anything other than the
    // auto-switch 'audio' or the target, the user navigated themselves —
    // forcing prev on top of their choice would yank them around.
    for (let i = 0; i < 6; i++) {
      if (document.visibilityState === 'hidden') { window._autoAudioPrevMode = prev; return; }
      const b = document.body.classList;
      if (b.contains('mode-' + prev)) return;                       // arrived
      if (!b.contains('mode-audio')) return;                        // user went elsewhere — leave it
      try { window.setShellMode(prev, { force: true }); } catch (_) {}
      await new Promise(r => setTimeout(r, 120));
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') handleAppHidden();
    else if (document.visibilityState === 'visible') handleAppVisible();
  });
  // Capacitor App plugin gives us authoritative app-active state — fires
  // even when the WebView's visibilitychange is unreliable (e.g., app
  // switcher gestures on iOS that don't always trip the page hidden
  // state immediately). Belt and suspenders (both handlers are idempotent:
  // a duplicate hidden sees mode-audio/_autoAudioPrevMode already set).
  //
  // On isActive=true we ALSO auto-clear an active anki round-trip flag
  // (in addition to the foreground handling) — that's the "we're back from
  // AnkiMobile" signal.
  function hookCapApp() {
    const App = window.Capacitor?.Plugins?.App;
    if (!App?.addListener || window._statsCapAppHooked) return;
    window._statsCapAppHooked = true;
    try {
      App.addListener('appStateChange', (state) => {
        if (!state) return;
        if (state.isActive === false) {
          // iOS fires resign-active for Control Center / notification-shade
          // peeks while the page stays VISIBLE — don't mode-switch on those.
          // visibilitychange is the primary trigger; this is only the
          // belt-and-suspenders for a missed/late hidden event.
          if (document.visibilityState === 'hidden') handleAppHidden();
        } else if (state.isActive === true) {
          if (_ankiRoundtripActive) markAnkiRoundtripDone();
          handleAppVisible();
        }
      });
    } catch (e) {}
  }
  setTimeout(hookCapApp, 500);
  setTimeout(hookCapApp, 1500);

  load();

  // Public API.
  function liveTotal(mode) {
    const t = timers[mode];
    if (t.runningSince) return t.totalSec + (Date.now() - t.runningSince) / 1000;
    return t.totalSec;
  }
  function isRunning(mode) { return !!timers[mode].runningSince; }
  function incrementCardCount() { timers.card.cards++; persist('card'); }
  function incrementCardChars(n) {
    if (!Number.isFinite(n) || n <= 0) return;
    timers.card.chars += n;
    persist('card');
  }

  // Update read.chars based on the highest charOffset+charLen the user
  // has scrolled into view this session. Re-scrolling already-passed
  // text is a no-op; only forward progress accrues. Stable across
  // orientation changes since charOffset is per-chunk metadata, not a
  // pixel calculation.
  function noteReadPosition(charPosition) {
    if (!Number.isFinite(charPosition) || charPosition <= 0) return;
    const t = timers.read;
    // First call after a reset (or first launch): just anchor the
    // baseline. Don't credit chars retroactively — otherwise resetting
    // at char 35,000 and then scrolling one line would jump the count
    // to ~35,000 because the rightmost visible chunk's offset is
    // already deep in the book.
    if (!t.baselineSet) {
      t.maxCharOffsetSeen = charPosition;
      t.baselineSet = true;
      persist('read');
      return;
    }
    if (charPosition <= t.maxCharOffsetSeen) return;
    const delta = charPosition - t.maxCharOffsetSeen;
    // Always advance the high-water mark…
    t.maxCharOffsetSeen = charPosition;
    // …but only CREDIT a plausible continuous-reading advance. A large jump is
    // a seek / jump-to-percent / big flick, NOT reading every character in
    // between — crediting it inflated the count into the hundreds of thousands.
    // A page of vertical-rl text is well under this cap; a seek is far above it.
    if (delta <= READ_DELTA_CAP) {
      t.chars += delta;
    }
    persist('read');
  }
  function incrementAudioChars(n) {
    if (!Number.isFinite(n) || n <= 0) return;
    timers.audio.chars += n;
    persist('audio');
  }
  // Credit an off-screen printed-reading session to the READ bucket: the user
  // read a printed segment for `sec` seconds covering `chars` characters.
  function addPrintedReading(sec, chars) {
    if (Number.isFinite(sec) && sec > 0) timers.read.totalSec += sec;
    if (Number.isFinite(chars) && chars > 0) timers.read.chars += chars;
    persist('read');
    console.log('[stats] printed reading +' + Math.round(sec || 0) + 's +' + Math.round(chars || 0) + ' chars');
  }

  // Re-anchor the read char baseline (called on title change). maxCharOffsetSeen
  // is a per-BOOK char offset; without re-anchoring, switching books credits the
  // inter-book offset jump as "read" (or undercounts) — the "chars jump around"
  // symptom. The next noteReadPosition after this silently re-anchors.
  function rebaselineRead() {
    timers.read.baselineSet = false;
  }

  function resetAll() {
    for (const m of Object.keys(timers)) resetMode(m);
  }
  function resetMode(mode) {
    const t = timers[mode];
    if (!t) return;
    // Stop the timer first so a partial elapsed segment doesn't get
    // credited after the reset.
    if (t.runningSince) stopMode(mode);
    t.totalSec = 0;
    t.runningSince = 0;
    if (mode === 'card')  { t.cards = 0; t.chars = 0; }
    if (mode === 'read')  { t.chars = 0; t.maxCharOffsetSeen = 0; t.baselineSet = false; }
    if (mode === 'audio') { t.chars = 0; }
    persist(mode);
  }

  // Modal pause/resume — Preferences and Library open while a session is
  // active, but they're meta-config, not "active session" time. Pause the
  // running timer for the modal's lifetime, then resume the SAME mode if
  // it was running on open.
  let _modalPausedMode = null;
  function pauseForModal() {
    for (const m of ['card', 'read', 'audio']) {
      if (timers[m].runningSince) {
        _modalPausedMode = m;
        stopMode(m);
        return;
      }
    }
    _modalPausedMode = null;
  }
  function resumeFromModal() {
    if (_modalPausedMode) {
      startMode(_modalPausedMode);
      _modalPausedMode = null;
    }
  }

  window.stats = {
    liveTotal, isRunning,
    getCardSec:  () => liveTotal('card'),
    getReadSec:  () => liveTotal('read'),
    getAudioSec: () => liveTotal('audio'),
    getCardCount:  () => timers.card.cards,
    getCardChars:  () => timers.card.chars,
    getReadChars:  () => timers.read.chars,
    getAudioChars: () => timers.audio.chars,
    incrementCardCount,
    incrementCardChars,
    incrementAudioChars,
    addPrintedReading,
    rebaselineRead,
    noteReadPosition,
    touch, bumpCard, bumpRead, resetAll, resetMode, persist,
    markAnkiRoundtripActive, markAnkiRoundtripDone,
    stopAll, startMode, stopMode,
    currentMode,
    pauseForModal, resumeFromModal,
  };
})();
