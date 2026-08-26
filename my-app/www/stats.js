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
  // Strict post-pause tracking for the read timer (see the tick below).
  let _readWasPlaying = false;
  let _readPlayheadStopAt = 0;
  // AI-material pages (Characters / Timeline / Scenes overlays) accrue time
  // while open + screen-on; 30 s of no interaction stops the timer.
  const TIMEOUT_AI_SEC = 30;
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
    read:  { totalSec: 0, chars: 0, maxCharOffsetSeen: 0, baselineSet: false, lastInteraction: 0, runningSince: 0, lastNoteTs: 0 },
    audio: { totalSec: 0, chars: 0, watchSec: 0,                              runningSince: 0 },
    // ai — time spent on AI-material overlays (Characters / Timeline / Scenes).
    // Time only (no chars). Runs independently of the card/read/audio trio.
    ai:    { totalSec: 0,                                  lastInteraction: 0, runningSince: 0 },
    // srs — time in the vocab review overlay (vocab-srs.js, #kvocabReview).
    // Split out from `ai` per user request: review time is its own stat.
    srs:   { totalSec: 0,                                  lastInteraction: 0, runningSince: 0 },
  };

  function persistableShape(mode) {
    const t = timers[mode];
    const out = { totalSec: t.totalSec };
    if (mode === 'card')  { out.cards = t.cards; out.chars = t.chars; }
    if (mode === 'read')  { out.chars = t.chars; out.maxCharOffsetSeen = t.maxCharOffsetSeen; out.baselineSet = t.baselineSet; }
    if (mode === 'audio') { out.chars = t.chars; out.watchSec = t.watchSec || 0; }
    return out;
  }
  function persist(mode) {
    try { localStorage.setItem(KEY_PREFIX + mode, JSON.stringify(persistableShape(mode))); } catch (e) {}
    mirrorSoon();
  }

  // ---- Native mirror: today's stats survive a WebView storage loss --------
  //
  // localStorage lives in the WebView's storage domain. When that layer goes
  // down mid-session (observed 2026-08: dictionary IndexedDB wedged AND the
  // whole day's audio stats gone after the restart that fixed it), everything
  // written since the wedge began is silently lost. Mirror the four mode
  // payloads + the stats-day stamp into native Preferences (UserDefaults /
  // SharedPreferences — a different, native-side store) at most every
  // MIRROR_MS, and on boot adopt the mirror when it is the SAME stats-day and
  // strictly ahead of what localStorage gave us. Worst case after a storage
  // loss is now ~MIRROR_MS of stats, not the whole day. Web/Mac builds have
  // no Preferences plugin and skip all of this.
  const MIRROR_KEY = 'STATS_MIRROR_V1';
  const MIRROR_MS = 20000;
  let _mirrorLastTs = 0, _mirrorTimer = null;
  function mirrorWrite() {
    try {
      const P = window.Capacitor?.Plugins?.Preferences;
      if (!P || !P.set) return;
      const payload = { day: _dayStamp || statsDay(Date.now()), modes: {} };
      for (const m of ['card', 'read', 'audio', 'ai', 'srs']) payload.modes[m] = persistableShape(m);
      P.set({ key: MIRROR_KEY, value: JSON.stringify(payload) });
    } catch (e) {}
  }
  function mirrorSoon() {
    const now = Date.now();
    if (now - _mirrorLastTs >= MIRROR_MS) { _mirrorLastTs = now; mirrorWrite(); return; }
    if (_mirrorTimer) return;
    _mirrorTimer = setTimeout(() => {
      _mirrorTimer = null; _mirrorLastTs = Date.now(); mirrorWrite();
    }, MIRROR_MS - (now - _mirrorLastTs));
  }
  async function mirrorAdopt() {
    try {
      const P = window.Capacitor?.Plugins?.Preferences;
      if (!P || !P.get) return;
      const res = await P.get({ key: MIRROR_KEY });
      if (!res || !res.value) return;
      const o = JSON.parse(res.value);
      // A mirror from another stats-day is not today's data — never adopt it
      // (the rollover snapshot path owns day boundaries).
      if (!o || !o.modes || o.day !== _dayStamp) return;
      let adopted = false;
      for (const m of ['card', 'read', 'audio', 'ai', 'srs']) {
        const mv = o.modes[m];
        if (!mv || !Number.isFinite(mv.totalSec)) continue;
        // Adopt the whole mode payload only when the mirror is clearly ahead —
        // normal boots (localStorage intact) always have totalSec >= mirror,
        // so this is a no-op outside the storage-loss case. +1s slack covers
        // accrual between module init and this async read.
        if (mv.totalSec > timers[m].totalSec + 1) {
          applyPersisted(m, mv);
          persist(m);
          adopted = true;
        }
      }
      if (adopted) console.log('[stats] adopted native mirror (storage-loss recovery)');
    } catch (e) {}
  }
  function applyPersisted(mode, o) {
    if (Number.isFinite(o.totalSec)) timers[mode].totalSec = o.totalSec;
    if (mode === 'card' && Number.isFinite(o.cards)) timers[mode].cards = o.cards;
    if (mode === 'card' && Number.isFinite(o.chars)) timers[mode].chars = o.chars;
    if (mode === 'read' && Number.isFinite(o.chars)) timers[mode].chars = o.chars;
    if (mode === 'read' && Number.isFinite(o.maxCharOffsetSeen))
      timers[mode].maxCharOffsetSeen = o.maxCharOffsetSeen;
    if (mode === 'read' && typeof o.baselineSet === 'boolean')
      timers[mode].baselineSet = o.baselineSet;
    if (mode === 'audio' && Number.isFinite(o.watchSec)) timers[mode].watchSec = o.watchSec;
    if (mode === 'audio' && Number.isFinite(o.chars)) timers[mode].chars = o.chars;
  }
  function load() {
    for (const mode of ['card', 'read', 'audio', 'ai', 'srs']) {
      try {
        const raw = localStorage.getItem(KEY_PREFIX + mode);
        if (raw) applyPersisted(mode, JSON.parse(raw));
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

  // ---- Audio time truth: the native playhead, NOT the wall clock ----
  //
  // audio is the only timer that deliberately keeps running while the app is
  // backgrounded (that's the entire point of audio mode), which made it the
  // only timer that could credit hours the user never spent. Every wall-clock
  // stop depends on JS hearing that playback ended, and there are several ways
  // it doesn't:
  //   • a 'state' event emitted while the WebView was suspended REPLAYS on
  //     foreground (documented in app.js's remoteCommand/position listeners).
  //     app.js sets `_bgPlaying = !!d.playing` from it with no staleness gate,
  //     so a replayed playing:true pins the mirror true. Native never re-emits
  //     "paused" for an already-paused player, so nothing ever unsticks it —
  //     and reconcileMode restarts the audio timer every tick for as long as
  //     the user sits in audio mode. That alone manufactures hours per day.
  //   • playback ending / being paused from the lock screen while JS is frozen:
  //     the stop isn't processed until foreground, and stopMode has no
  //     inactivity cap for audio (timeoutSec is 0), so the whole frozen gap
  //     lands in the total.
  // Both are the same class of bug — trusting an event that may never arrive.
  //
  // Fix: credit min(wall-clock, playhead advance ÷ playback rate) per sample.
  // The playhead is native truth: it cannot advance faster than real time
  // during honest playback (a bigger jump is a seek, which the wall-clock
  // bound clips), and it stops the instant playback does — which is exactly
  // what the wall clock fails to notice. A stuck mirror now credits ZERO,
  // while a genuine 4-hour pocket listen with JS frozen the whole time still
  // credits in full, because the playhead really did move 4 hours.
  const AUD_PERSIST_MS = 15000;
  let _audAnchorTs = 0, _audAnchorPos = -1;
  let _audLastSampleTs = 0, _audLastPersistTs = 0, _audPollBusy = false;
  let _audTitlePend = 0;

  function audioResetAnchor() { _audAnchorTs = 0; _audAnchorPos = -1; }

  // One (position, time) observation. `tsIn` is the event's OWN timestamp when
  // native supplies one — a burst of events replayed after a suspension then
  // reconstructs the real listening span instead of collapsing into "now".
  function audioSample(posMs, tsIn) {
    if (!Number.isFinite(posMs) || posMs < 0) return;
    const ts = (Number.isFinite(tsIn) && tsIn > 0) ? tsIn : Date.now();
    _audLastSampleTs = Date.now();
    // Not running, or no anchor yet: anchor without crediting.
    if (!timers.audio.runningSince || _audAnchorPos < 0) {
      _audAnchorTs = ts; _audAnchorPos = posMs;
      return;
    }
    // Older than what we've already credited through — drop it entirely
    // WITHOUT re-anchoring. This is the case where the backstop poll closed a
    // suspension gap from native truth and the queued position burst for that
    // same span replays afterwards: re-anchoring backwards would let the burst
    // credit the span a second time.
    if (ts <= _audAnchorTs) return;
    const wallMs = ts - _audAnchorTs;
    let advMs = posMs - _audAnchorPos;
    _audAnchorTs = ts; _audAnchorPos = posMs;
    // Normalise the advance by playback rate so 1.5× listening isn't credited
    // 1.5× the real time (and 0.8× isn't shortchanged).
    let rate = 1;
    try { rate = Number(window.getActivePlaybackRate?.()) || 1; } catch (_) {}
    if (rate > 0.05 && rate !== 1) advMs = advMs / rate;
    const credit = Math.min(wallMs, advMs);
    if (!(credit > 0)) return;
    timers.audio.totalSec += credit / 1000;
    // Per-title time log — same seconds, batched to whole seconds so a 150 ms
    // event cadence doesn't spam blobStore.
    _audTitlePend += credit / 1000;
    if (_audTitlePend >= 1) {
      const whole = Math.floor(_audTitlePend);
      _audTitlePend -= whole;
      try {
        const tid = window._activeTitleId;
        if (tid) window.titleStats?.noteTime?.(tid, 'audio', whole);
      } catch (_) {}
    }
    const nowReal = Date.now();
    if (nowReal - _audLastPersistTs > AUD_PERSIST_MS) {
      _audLastPersistTs = nowReal;
      persist('audio');
    }
  }

  // Backstop for when position events stop arriving (dropped rather than
  // queued, plugin re-attach, etc.): re-anchor from native truth — which also
  // closes any gap a suspension left — and self-heal the `_bgPlaying` mirror,
  // the thing a stale replayed 'state' event used to pin true forever. That
  // heal matters beyond audio: read/card suppress their inactivity timeouts
  // while `_bgPlaying` is true, so a stuck mirror inflated those totals too.
  function audioTruthPoll() {
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (!bg?.getState) return;
    _audPollBusy = true;
    let p;
    try { p = Promise.resolve(bg.getState()); } catch (_) { _audPollBusy = false; return; }
    p.then((s) => {
      _audPollBusy = false;
      _audLastSampleTs = Date.now();
      if (!s || typeof s.playing !== 'boolean') return;
      if (s.playing !== !!window._bgPlaying) {
        window._bgPlaying = s.playing;
        console.log('[stats] audio mirror self-heal → playing=' + s.playing);
      }
      if (s.playing) audioSample(Number(s.positionMs), Date.now());
      else audioResetAnchor();
    }).catch(() => { _audPollBusy = false; });
  }

  // Only one timer at a time: starting one stops the others.
  function startMode(mode) {
    const t = timers[mode];
    if (t.runningSince) return;
    for (const other of ['card', 'read', 'audio']) {
      if (other !== mode && timers[other].runningSince) stopMode(other);
    }
    // Fresh window: the first sample after a start anchors without crediting,
    // so a pause gap never lands in the total.
    if (mode === 'audio') audioResetAnchor();
    t.runningSince = Date.now();
    if ('lastInteraction' in t) t.lastInteraction = Date.now();
    console.log('[stats] start ' + mode);
  }

  // Stop whichever timer is currently running. Used by openReadingStats
  // so opening the stats popup doesn't continue ticking time the user
  // obviously isn't using.
  function stopAll() {
    for (const m of ['card', 'read', 'audio', 'ai', 'srs']) {
      if (timers[m].runningSince) stopMode(m);
    }
  }

  function stopMode(mode, opts) {
    const t = timers[mode];
    if (!t.runningSince) return;
    // audio accrues through audioSample() as the playhead moves, so stopping
    // just closes the window — there is no wall-clock segment to credit here
    // (crediting one is precisely the bug this replaced).
    if (mode === 'audio') {
      t.runningSince = 0;
      audioResetAnchor();
      _audTitlePend = 0;
      persist('audio');
      console.log('[stats] stop audio (total ' + t.totalSec.toFixed(0) + 's)');
      return;
    }
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
                       : (mode === 'ai' || mode === 'srs') ? TIMEOUT_AI_SEC
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

  // ----- AI-material page timer (Characters / Timeline / Scenes) -----
  // These are full-screen overlays tagged `.kai-ai-page`. Time accrues while
  // one is open and the screen is on; closing the page (back to the prior
  // mode), the screen turning off, or 30 s of no interaction stops it. It runs
  // INDEPENDENTLY of the card/read/audio trio: opening a page stops the book
  // (card/read) timer so the time isn't double-counted, but audio is left
  // playing so the user can listen while browsing the summary. The character
  // POPUP (squiggle tap) is deliberately NOT tagged — that's captured by read.
  let _aiPagePrevOpen = false;
  let _srsPagePrevOpen = false;
  function isAiPageVisible() {
    try { return !!document.querySelector('.kai-ai-page'); } catch (_) { return false; }
  }
  // Vocab-review overlay (its own stats bucket). While it is open the AI
  // timer must NOT run — the review often stacks OVER an open Timeline panel
  // (.kai-ai-page), and double-counting the same minute would inflate both.
  function isSrsPageVisible() {
    try { return !!document.querySelector('.kai-srs-page'); } catch (_) { return false; }
  }
  function srsBump() {
    if (_shouldIgnoreBump()) return;
    if (!isSrsPageVisible()) return;
    const t = timers.srs;
    t.lastInteraction = Date.now();
    if (!t.runningSince) {
      if (timers.card.runningSince) stopMode('card');
      if (timers.read.runningSince) stopMode('read');
      if (timers.ai.runningSince) stopMode('ai');
      t.runningSince = Date.now();
      console.log('[stats] start srs');
    }
  }
  // Interaction inside an AI page — starts or keeps alive the ai timer. Gated
  // on the page actually being open and the app visible (same gate as bumpRead).
  function aiBump() {
    if (_shouldIgnoreBump()) return;
    if (!isAiPageVisible()) return;
    const t = timers.ai;
    t.lastInteraction = Date.now();
    if (!t.runningSince) {
      if (timers.card.runningSince) stopMode('card');
      if (timers.read.runningSince) stopMode('read');
      t.runningSince = Date.now();
      console.log('[stats] start ai');
    }
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
    // Visibility gate (mirrors _shouldIgnoreBump): a call-end auto-resume can
    // land while the app is HIDDEN with the body still in card mode (the
    // suppression mirror cleared _bgPlaying before the hide, so the
    // hidden-time audio auto-switch was skipped). Restarting the card timer
    // then accrues phantom card time for the whole pocketed listen — the
    // backgrounded span must never count as card reading.
    if (window._bgPlaying && inCard && !timers.card.runningSince && !window._aiPageOpen &&
        (document.visibilityState === 'visible' || _ankiRoundtripActive)) startMode('card');
  }

  // Periodic check: inactivity timeouts + a mode/audio reconciliation backstop.
  function tick() {
    // Daily 3 AM rollover backstop — cheap stamp compare at most once a
    // minute, so an app left running overnight rolls over in place.
    if (Date.now() - _lastDayCheck >= DAY_CHECK_MS) {
      _lastDayCheck = Date.now();
      try { checkRollover(); } catch (e) {}
    }
    // Per-title time-spent log (library Stats card): 1s per tick to whichever
    // mode timer is currently running (the timers already encode all the
    // active/idle/playback rules — this just attributes their seconds to the
    // active title). audio is deliberately absent: it's credited from playhead
    // samples in audioSample(), since a tick can't tell whether audio is
    // really playing (it was inflating this log the same way it inflated the
    // daily total).
    try {
      const _tid = window._activeTitleId;
      if (_tid && window.titleStats?.noteTime) {
        for (const _m of ['card', 'read']) {
          if (timers[_m] && timers[_m].runningSince) window.titleStats.noteTime(_tid, _m, 1);
        }
      }
    } catch (_) {}
    // Audio truth backstop. Position events are the primary heartbeat
    // (~150 ms–1 s while playing); this only fires when they've gone quiet for
    // 4 s while we still believe audio is live — i.e. exactly the situations
    // that used to accrue phantom time. Costs one bridge call per 4 s in that
    // state and nothing at all in the normal case.
    if (!_audPollBusy && (timers.audio.runningSince || window._bgPlaying) &&
        Date.now() - _audLastSampleTs > 4000) {
      try { audioTruthPoll(); } catch (_) { _audPollBusy = false; }
    }
    const srsOpen = isSrsPageVisible();
    const aiOpen = !srsOpen && isAiPageVisible();   // review stacked over an AI page → srs owns the time
    window._aiPageOpen = aiOpen;
    reconcileMode(currentMode());

    const now = Date.now();
    // AI material (Characters / Timeline / Scenes overlays, class .kai-ai-page):
    // treat opening as the first interaction; stop on close, screen-off, or 30 s idle.
    if (aiOpen && !_aiPagePrevOpen) aiBump();
    _aiPagePrevOpen = aiOpen;
    if (timers.ai.runningSince) {
      if (!aiOpen) stopMode('ai');
      else if (document.visibilityState !== 'visible') stopMode('ai', { byBackground: true });
      else if ((now - timers.ai.lastInteraction) / 1000 > TIMEOUT_AI_SEC) stopMode('ai', { byInactivity: true });
    }
    // Vocab review (.kai-srs-page) — same lifecycle as the ai timer.
    if (srsOpen && !_srsPagePrevOpen) srsBump();
    _srsPagePrevOpen = srsOpen;
    if (timers.srs.runningSince) {
      if (!srsOpen) stopMode('srs');
      else if (document.visibilityState !== 'visible') stopMode('srs', { byBackground: true });
      else if ((now - timers.srs.lastInteraction) / 1000 > TIMEOUT_AI_SEC) stopMode('srs', { byInactivity: true });
    }
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
    // STRICT POST-PAUSE RULE (user, 2026-08-26; supersedes the "audio stop
    // never stops the read timer" decision above): 10 s after the playhead
    // stops with NO interaction since, the read timer stops. An interaction
    // after the pause means silent reading — the normal 120 s rule applies;
    // a later bumpRead restarts the timer as always.
    if (timers.read.runningSince) {
      const idleSec = (now - timers.read.lastInteraction) / 1000;
      const audioPlaying = !!window._bgPlaying;
      if (audioPlaying) { _readWasPlaying = true; _readPlayheadStopAt = 0; }
      else if (_readWasPlaying) { _readWasPlaying = false; _readPlayheadStopAt = now; }
      if (!audioPlaying && _readPlayheadStopAt &&
          timers.read.lastInteraction <= _readPlayheadStopAt &&
          (now - _readPlayheadStopAt) / 1000 >= 10) {
        _readPlayheadStopAt = 0;
        stopMode('read', { byInactivity: true });
      } else if (!audioPlaying && idleSec > TIMEOUT_READ_SEC) {
        stopMode('read', { byInactivity: true });
      }
    }
    // Keep read alive while audio plays so the timeout doesn't fire during
    // long passive-listening stretches with no touch.
    if (window._bgPlaying && timers.read.runningSince) {
      timers.read.lastInteraction = now;
    }
  }
  // READ-ONLY PANEL WINDOW (panel-bridge.js): a second webview on the SAME origin
  // shares this storage, so it must never run a second copy of a writer — that
  // is how the user's place gets lost. The module still loads (the panel reads
  // through its public surface); only the crediting/polling clock stands down.
  if (!window.KADOKI_PANEL) setInterval(tick, 1000);

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
        // Late audio auto-switch: playback can come back while ALREADY hidden
        // with the body still in card/read — a phone call suppressed playback
        // (the mirror cleared _bgPlaying), the user backgrounded (so
        // handleAppHidden skipped its audio auto-switch), then the call ended
        // within the grace window and native auto-resumed. Run the same
        // switch handleAppHidden would have done, so a background listen
        // always lands in audio mode (timer attribution + the "audio is the
        // only mode that plays while hidden" rule).
        // Staleness gate: 'state' events queued while the WebView was
        // suspended replay on foreground — a replayed playing=true must not
        // trigger a mode switch (whose resumeOnly path can issue a transport
        // resume) when the user has since paused. Only a LIVE resume counts.
        const _sts = Number(d?.ts);
        const _liveEvent = !Number.isFinite(_sts) || _sts <= 0 || (Date.now() - _sts <= 5000);
        if (d.playing && _liveEvent && document.visibilityState === 'hidden' &&
            !_ankiRoundtripActive && !window._autoAudioPrevMode &&
            typeof window.setShellMode === 'function') {
          const b = document.body.classList;
          const interactive = b.contains('mode-read') ? 'read' : (b.contains('mode-card') ? 'card' : null);
          if (interactive) {
            window._autoAudioPrevMode = interactive;
            try {
              window.setShellMode('audio', { force: true, resumeOnly: true, autoSwitch: true });
            } catch (_) { window._autoAudioPrevMode = null; }
          }
        }
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
      // Playhead heartbeat — the sole source of audio time (see audioSample).
      // Deliberately NOT staleness-gated, unlike app.js's position listener: a
      // burst replayed after a WebView suspension IS the record of what played
      // while we were frozen, and each event carries its original `ts`, so
      // sampling them reconstructs the real listening span rather than
      // collapsing it into "now".
      bg.addListener('position', (d) => {
        try { audioSample(Number(d?.positionMs), Number(d?.ts)); } catch (_) {}
      });
    } catch (e) {}
  }
  setTimeout(ensureAudioBgHooked, 500);
  setTimeout(ensureAudioBgHooked, 1500); // retry after plugin warms up

  // Capture-phase touch listeners — feed touch() on every interaction.
  // Now harmless for stopped timers (touch is a no-op when not running).
  document.addEventListener('touchstart', () => { if (isSrsPageVisible()) srsBump(); else if (isAiPageVisible()) aiBump(); else touch(); }, { passive: true, capture: true });
  document.addEventListener('mousedown',  () => { if (isSrsPageVisible()) srsBump(); else if (isAiPageVisible()) aiBump(); else touch(); }, { passive: true, capture: true });

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
    for (const m of ['card', 'read', 'ai', 'srs']) {
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
    // Going to background is the last reliable moment before the OS may kill
    // (or wedge) the WebView — flush the native mirror now, bypassing the
    // MIRROR_MS throttle. One Preferences write per hide, negligible.
    try { _mirrorLastTs = Date.now(); mirrorWrite(); } catch (e) {}
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
    // audio's total is already up to date (accrued per playhead sample) —
    // adding the running segment would double-count it.
    if (mode === 'audio') return t.totalSec;
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
    // Per-title daily progress log (library Stats card): jp-position high-water
    // per day. Own daily-max semantics inside — safe at any call cadence.
    try { window.titleStats?.noteRead(window._activeTitleId, charPosition, window._pagedTotalJpChars); } catch (_) {}
    const t = timers.read;
    const nowTs = Date.now();
    const prevNoteTs = t.lastNoteTs || 0;   // in-memory only: a fresh boot re-anchors
    t.lastNoteTs = nowTs;
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
    // An advance that happened OUTSIDE an active read session is not reading:
    // audio/watch listening moves the book while read mode is closed, and the
    // FIRST note after re-entering read landed the whole accumulated gap
    // (whenever it fit under the jump cap) as "chars read" — the 3,389-chars-
    // in-3-seconds bug. Re-anchor silently unless read mode has been running
    // continuously since the previous note (slow single-page dwells stay
    // credited — the gate is session continuity, not a dwell timeout).
    const inReadWholeGap = t.runningSince > 0 && prevNoteTs > 0 && t.runningSince <= prevNoteTs;
    if (!inReadWholeGap && (nowTs - prevNoteTs) > 90000) { persist('read'); return; }
    // …and only CREDIT a plausible continuous-reading advance. A large jump is
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
  // Apple Watch listening (queued deltas via WatchBridge) — credited to the
  // AUDIO listening total (it IS listening; the per-title Stats card keeps its
  // own separate "watch" category for the breakdown).
  function addWatchListening(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return;
    timers.audio.totalSec += sec;                                  // counts toward the audio total…
    timers.audio.watchSec = (timers.audio.watchSec || 0) + sec;    // …AND tracked separately for its own stats row
    persist('audio');
    console.log('[stats] watch listening +' + Math.round(sec) + 's');
  }

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
    // watchSec must reset WITH totalSec (it's a subset) — leaving it out let the
    // watch row carry yesterday's seconds and exceed "time playing".
    if (mode === 'audio') { t.chars = 0; t.watchSec = 0; audioResetAnchor(); _audTitlePend = 0; }
    persist(mode);
  }

  // ---- Daily stats with a 3 AM boundary -----------------------------------
  //
  // A "stats day" runs 03:00 → 02:59:59 local time, so late-night reading
  // counts toward the same day. When the stored day stamp no longer matches,
  // the outgoing day's totals are snapshotted to STATS_PREV_V1 (labelled with
  // the OLD stamp — the day the stats actually belong to, even across a
  // multi-day gap) and every mode is reset through the same resetMode path
  // the per-section Reset buttons use. resetMode('read') clears baselineSet /
  // maxCharOffsetSeen, so the first noteReadPosition after a rollover
  // re-anchors the char baseline without crediting — read-char counting
  // survives the boundary intact.
  const DAY_KEY = 'STATS_DAY_V1';
  const PREV_KEY = 'STATS_PREV_V1';
  const DAY_CHECK_MS = 60000;
  let _dayStamp = null;
  let _lastDayCheck = 0;
  function statsDay(now) {
    const d = new Date((Number.isFinite(now) ? now : Date.now()) - 3 * 3600 * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function checkRollover() {
    const day = statsDay(Date.now());
    if (_dayStamp === null) {
      try { _dayStamp = localStorage.getItem(DAY_KEY); } catch (e) {}
    }
    if (!_dayStamp) {
      // First run: existing totals become today's. No reset.
      _dayStamp = day;
      try { localStorage.setItem(DAY_KEY, day); } catch (e) {}
      return;
    }
    if (_dayStamp === day) return;
    // Day changed — snapshot the outgoing day FIRST (liveTotal so an
    // in-flight running segment is credited to the old day), then reset.
    const prev = {
      day: _dayStamp,
      modes: {
        card:  { sec: Math.round(liveTotal('card')),  chars: timers.card.chars, cards: timers.card.cards },
        read:  { sec: Math.round(liveTotal('read')),  chars: timers.read.chars },
        audio: { sec: Math.round(liveTotal('audio')), chars: timers.audio.chars },
        ai:    { sec: Math.round(liveTotal('ai')) },
        srs:   { sec: Math.round(liveTotal('srs')) },
      },
    };
    try { localStorage.setItem(PREV_KEY, JSON.stringify(prev)); } catch (e) {}
    resetAll();
    // Legacy read-timer counters (reading-mode.js pill + READING_TIME_SEC /
    // READING_CHARS_TOTAL prefs) reset via the hook reading-mode registers.
    // reading-mode.js loads after stats.js, so a boot-time rollover leaves a
    // pending flag the hook consumes when it registers.
    if (typeof window._statsDayRolloverLegacyReset === 'function') {
      try { window._statsDayRolloverLegacyReset(); } catch (e) {}
    } else {
      window._statsLegacyDayResetPending = true;
    }
    _dayStamp = day;
    try { localStorage.setItem(DAY_KEY, day); } catch (e) {}
    // Flip the native mirror to the new day immediately — a crash between the
    // rollover and the next throttled mirror write must not leave a stale
    // yesterday-labelled mirror (mirrorAdopt ignores other-day mirrors, so
    // stale means "no protection", not corruption — but close the gap anyway).
    try { _mirrorLastTs = Date.now(); mirrorWrite(); } catch (e) {}
    console.log('[stats] daily rollover → ' + day + ' (snapshot saved for ' + prev.day + ')');
  }
  // Previous stats-day snapshot, or null. Shape:
  //   { day: 'YYYY-MM-DD', modes: { card:{sec,chars,cards}, read:{sec,chars}, audio:{sec,chars} } }
  function getYesterday() {
    try {
      const o = JSON.parse(localStorage.getItem(PREV_KEY));
      return (o && typeof o === 'object' && o.modes) ? o : null;
    } catch (e) { return null; }
  }
  try { checkRollover(); } catch (e) {}
  // After the day stamp is settled: async-recover today's totals from the
  // native mirror if localStorage came up behind it (storage-loss restart).
  mirrorAdopt();

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
    getAiSec:    () => liveTotal('ai'),
    getSrsSec:   () => liveTotal('srs'),
    getCardCount:  () => timers.card.cards,
    getCardChars:  () => timers.card.chars,
    getReadChars:  () => timers.read.chars,
    getAudioChars: () => timers.audio.chars,
    incrementCardCount,
    incrementCardChars,
    incrementAudioChars,
    addPrintedReading,
    addWatchListening,
    getWatchSec: () => timers.audio.watchSec || 0,
    rebaselineRead,
    noteReadPosition,
    getYesterday,
    touch, bumpCard, bumpRead, aiBump, resetAll, resetMode, persist,
    markAnkiRoundtripActive, markAnkiRoundtripDone,
    stopAll, startMode, stopMode,
    currentMode,
    pauseForModal, resumeFromModal,
  };
})();
