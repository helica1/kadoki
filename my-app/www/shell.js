// shell.js — Persistent app shell controller.
//
// Owns:
//   - mode tabs (Card / Read / Audio) routing into existing open*/close* APIs
//   - the unified session timer label in the header
//   - the timer menu (Hide / Reset / Stats)
//   - footer play button delegation
//   - chrome-hide on tap-on-content-margin
//
// Does NOT yet hide the legacy toolbars in the three modes — that's a
// follow-up cleanup once the shell is verified on device.

(function () {
  let currentMode = 'card';
  let timerPollHandle = null;
  let timerHidden = false;

  function el(id) { return document.getElementById(id); }

  // Continuous mode (Preferences → Playback). When on, Card / Read / Audio
  // all track ONE playhead: audio never pauses on a mode switch and the
  // audio→card/read reentry dialog is suppressed — each mode just follows
  // the live audio position. Read synchronously (mode switches can run
  // before preferences.js has set the cached global) with a localStorage
  // fallback so the default is exactly today's behavior when unset.
  // Continuous mode is now the ONLY mode — always on. (Kept as a function so the
  // many existing call sites don't need to change; the non-continuous branches
  // they gate are now dead.)
  function isContinuousMode() { return true; }
  // Single writer for the flag — keeps localStorage, the cached global, and
  // the Preferences checkbox (if mounted) all in agreement, so the hamburger
  // quick-toggle and the Preferences checkbox never disagree.
  function setContinuousMode(on) {
    on = !!on;
    try { localStorage.setItem('CONTINUOUS_MODE_V1', on ? 'true' : 'false'); } catch (_) {}
    window._continuousMode = on;
    const cb = document.getElementById('continuousModeToggle');
    if (cb) cb.checked = on;
  }
  window.setContinuousMode = setContinuousMode;
  window.isContinuousMode = isContinuousMode;

  function fmtSec(total) {
    total = Math.floor(total);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  }

  // --------- Mode tab ----------

  function updateTabsUI(mode) {
    const tabs = document.querySelectorAll('#shellModeTabs .mode-tab');
    tabs.forEach(t => {
      if (t.dataset.mode === mode) t.dataset.active = '1';
      else delete t.dataset.active;
    });
    const play = el('shellPlayBtn');
    if (play) {
      play.classList.remove('mode-card', 'mode-read', 'mode-audio');
      play.classList.add('mode-' + mode);
    }
    // Body class so mode-specific chrome (e.g. card-mode bottom bar) can show.
    document.body.classList.remove('mode-card', 'mode-read', 'mode-audio');
    document.body.classList.add('mode-' + mode);
    // Broadcast so anything mode-color-aware (waveform, etc.) can repaint.
    try { window.dispatchEvent(new CustomEvent('shell:mode-change', { detail: { mode } })); } catch (e) {}
    // Persist so the next launch opens in the same mode.
    try { localStorage.setItem('LAST_MODE_V1', mode); } catch (e) {}
  }

  // ---------- Chrome hide-on-content-tap ----------

  let chromeHidden = false;
  function showChrome() {
    document.body.classList.remove('chrome-hidden');
    chromeHidden = false;
  }
  function hideChrome() {
    document.body.classList.add('chrome-hidden');
    chromeHidden = true;
  }
  function toggleChrome() {
    chromeHidden ? showChrome() : hideChrome();
  }
  window.shellToggleChrome = toggleChrome;

  // Tap on a content area (anywhere outside the shell header + popups) toggles
  // chrome visibility. Skip if the tap was on an interactive element.
  //
  // IMPORTANT: use capture phase. Child elements (e.g. dict-frag spans in
  // subtitle text) call stopPropagation on touchend, so a bubble-phase
  // listener on document never sees those taps. Capture fires before child
  // bubble handlers, so it always sees the touch.
  function installChromeTapHandler() {
    let tStart = 0, x0 = 0, y0 = 0, moved = false, started = false;
    document.addEventListener('touchstart', (e) => {
      if (!e.touches?.[0]) return;
      started = true;
      tStart = Date.now();
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
      moved = false;
    }, { passive: true, capture: true });
    document.addEventListener('touchmove', (e) => {
      if (!e.touches?.[0]) return;
      if (Math.abs(e.touches[0].clientX - x0) > 10 || Math.abs(e.touches[0].clientY - y0) > 10) {
        moved = true;
      }
    }, { passive: true, capture: true });
    document.addEventListener('touchend', (e) => {
      if (!started) return;   // skip very first event if we haven't recorded a start
      if (moved) return;
      if (Date.now() - tStart > 350) return;
      // If a dict-popup outside-tap dismissed the popup in the same gesture,
      // the user's intent was "close the popup," not "toggle chrome." Skip.
      if (window._dictPopupDismissedTs && Date.now() - window._dictPopupDismissedTs < 500) return;
      const t = e.target;
      if (!t || !t.closest) return;
      // Skip shell + interactive + popups/modals.
      if (t.closest('#appHeader') ||
          t.closest('button, a, input, select, textarea, label[for]') ||
          t.closest('#dictPopup') ||
          t.closest('.shell-menu') ||
          t.closest('#preferencesModal') ||
          t.closest('#readingSettingsModal') ||
          t.closest('#readingStatsModal') ||
          t.closest('#audiobookReentryModal')) return;
      if (t.closest('.reading-chunk')) return;
      if (t.closest('.dict-frag')) return;
      // Reading mode owns its own content-area tap logic (chunks, margins,
      // bottom-bar toggle). Skip here so we don't double-fire.
      if (t.closest('#readingModeContent')) return;
      // Bottom progress bar + COPY pill have their own click handlers
      // (jump-to-position / copy-text). Don't steal those taps for chrome.
      if (t.closest('#progressBar') || t.closest('#cardCopyBtn')) return;
      // Otherwise: tap on empty content area → toggle chrome.
      toggleChrome();
    }, { passive: true, capture: true });
  }

  // Visual hint: tabs whose mode isn't "enabled" for the current title get a
  // data-empty="1" marker (theme.css fades them). Still tappable — the mode
  // view shows its own empty-state picker if attachments are missing.
  async function refreshTabAvailability() {
    const audioTab = document.querySelector('#shellModeTabs .mode-tab[data-mode="audio"]');
    const readTab  = document.querySelector('#shellModeTabs .mode-tab[data-mode="read"]');
    const cardTab  = document.querySelector('#shellModeTabs .mode-tab[data-mode="card"]');

    // Source of truth: the Title object's attachments. Falls back to the
    // legacy per-deck pref read only when no Title is active.
    let hasAudio = false, hasEpub = false, hasDeck = false, hasSrt = false;
    let source = 'none';
    const idsToCheck = [window._activeTitleId, window._editingTitleId].filter(Boolean);
    try {
      if (window.titleStore?.get) {
        for (const id of idsToCheck) {
          const t = await window.titleStore.get(id);
          if (!t) continue;
          if (t.attachments?.audiobook) hasAudio = true;
          if (t.attachments?.epub) hasEpub = true;
          if (t.attachments?.deck) hasDeck = true;
          if (t.attachments?.srt) hasSrt = true;
          source = 'title:' + id;
          if (hasAudio && hasEpub && hasDeck) break;
        }
      }
    } catch (e) {}

    // Legacy fallback: no Title resolved → consult per-deck prefs by
    // whatever name #deckName is showing.
    if (!hasAudio && !hasEpub) {
      const deckEl = el('deckName');
      const deck = (deckEl?.textContent || '')
        .replace(/\s*\((Tap to reopen|Auto-restoring\.\.\.)\)\s*$/i, '').trim();
      if (deck) {
        try {
          if (typeof window.getAudiobookPairingForDeck === 'function') {
            hasAudio = !!(await window.getAudiobookPairingForDeck(deck));
          }
          if (typeof window.getEpubPairingForDeck === 'function') {
            hasEpub = !!(await window.getEpubPairingForDeck(deck));
          }
          source = 'legacy:' + deck;
        } catch (e) {}
      }
    }

    // CARD mode is available when there's an Anki deck OR a synthetic
    // SRT-cards source (audiobook + SRT). When a Title resolved, trust its
    // attachments exclusively. Only when no Title is active (legacy / raw
    // deck) do we fall back to "are cards actually loaded in memory."
    const titleResolved = source.indexOf('title:') === 0;
    let hasCards = hasDeck || (hasAudio && hasSrt);
    if (!titleResolved && !hasCards) {
      hasCards = !!(window.allNotes && window.allNotes.length > 0);
    }

    console.log('[shell] refreshTabAvailability source=' + source +
      ' hasAudio=' + hasAudio + ' hasEpub=' + hasEpub + ' hasCards=' + hasCards);
    const setEmpty = (tab, empty) => {
      if (!tab) return;
      if (empty) tab.dataset.empty = '1';
      else delete tab.dataset.empty;
    };
    setEmpty(audioTab, !hasAudio);
    setEmpty(readTab, !hasEpub);
    setEmpty(cardTab, !hasCards);

    // Play/pause button only makes sense when there's something to play — an
    // audiobook (read-along / audio mode) or cards (card audio). An EPUB-only
    // title has no transport at all, so hide the button entirely. (The timer
    // pill stays — it still tracks reading time.)
    const playBtn = document.getElementById('shellPlayBtn');
    if (playBtn) playBtn.style.display = (hasAudio || hasCards) ? '' : 'none';
  }

  // Authoritative "what mode is actually visible right now" — checks the DOM,
  // not just shell's internal state. Catches cases where reading or audiobook
  // was opened via a non-shell entry point (e.g., toolbar button).
  function inferActiveMode() {
    const ab = document.getElementById('audiobookModeView');
    if (ab && ab.style.display !== 'none') return 'audio';
    const rdPaged = document.getElementById('readingPagedView');
    // The paged view is display:flex always now; visibility is the show/hide toggle.
    if (rdPaged && rdPaged.style.display !== 'none' && rdPaged.style.visibility !== 'hidden') return 'read';
    const rd = document.getElementById('readingModeView');
    if (rd && rd.style.display !== 'none') return 'read';
    return 'card';
  }

  // True while a mode-switch is in flight. Tab taps that arrive during
  // this window are ignored so a double-tap can't race the first call
  // (which used to produce the "tap twice to switch" UX).
  let _switchInFlight = false;
  // Generation counter so a tab tap during the audio-reentry dialog
  // can SUPERSEDE the prior switch's async block. Without this the
  // old block would resume after the dialog dismiss and override the
  // new tab's view flips — the user reported "tap audio while dialog
  // open shows read viewport instead of audio." Each setShellMode
  // bumps the counter; the async block captures the gen at start and
  // bails out if it no longer matches.
  let _switchGen = 0;

  // Short-circuit Read / Audio switches when the active title doesn't
  // have the corresponding attachment. Without this, tapping Read with
  // no EPUB opened the paged reader on an empty inner element (the
  // "blank reader" symptom) and tapping Audio with no audiobook
  // attached fired the "audiobook not paired" toast — both readable
  // as "the button is broken" rather than "this mode isn't available
  // for this title." Read tab availability comes from the data-empty
  // attribute that refreshTabAvailability already maintains.
  function _maybeRefuseSwitch(mode) {
    const tab = document.querySelector('#shellModeTabs .mode-tab[data-mode="' + mode + '"]');
    if (!tab || tab.dataset.empty !== '1') return false;
    if (mode === 'read') {
      try { window.showToast?.('No EPUB attached to this title', 2000); } catch (_) {}
      return true;
    }
    if (mode === 'audio') {
      try { window.showToast?.('No audiobook attached to this title', 2000); } catch (_) {}
      return true;
    }
    if (mode === 'card') {
      try { window.showToast?.('No cards in this title', 2000); } catch (_) {}
      return true;
    }
    return false;
  }

  window.setShellMode = function (mode, opts) {
    // Block USER switches into modes whose backing content isn't loaded.
    // Programmatic callers that just loaded the right content pass
    // {force:true} to skip the gate — at that instant the data-empty
    // attribute still reflects the PREVIOUS title (refreshTabAvailability
    // is async), so without the bypass the switch would wrongly refuse.
    const force = !!(opts && opts.force);
    if (!force && (mode === 'read' || mode === 'audio' || mode === 'card') &&
        _maybeRefuseSwitch(mode)) return;
    // If the audio→other reentry modal is up, treat a tab tap as
    // "dismiss without changing position" AND supersede the prior
    // switch's async block (its closeAudio/openRead steps would
    // otherwise undo this new switch). Also set a flag so the NEXT
    // openAudiobookMode (if user is heading back to audio) RESUMES
    // playback from where it was paused rather than restarting from
    // the card/cursor position — user explicitly didn't choose a
    // position, so audio should continue where it left off.
    const reentry = document.getElementById('audiobookReentryModal');
    if (reentry && reentry.style.display === 'flex' &&
        typeof window.reentryChoose === 'function') {
      _switchGen++;  // invalidate the prior switch's async tail
      // Pass unresolved:true so the divergence flag stays set —
      // the next mode switch into card/read re-shows the dialog in
      // the appropriate target-mode flavor (Card Number vs Reading
      // Position) until the user explicitly picks a button.
      try { window.reentryChoose('cursor', { unresolved: true }); } catch (_) {}
      _switchInFlight = false;
      window._reentryDismissedByTab = true;
    }
    if (_switchInFlight) return;
    currentMode = inferActiveMode();
    if (mode === currentMode) {
      // Same mode — normally a no-op. BUT a TITLE OPEN can swap the underlying
      // content while the mode stays the same: opening title B while already
      // in read mode on title A would otherwise keep showing A's EPUB (the
      // open function never re-runs). Re-invoke just the target mode's
      // open/load so it picks up the new active title. No close/visibility
      // flip — the view is already correct, only its content is stale. Card
      // content is loaded by the caller (loadDeckFromLibrary /
      // loadTitleAsSrtCards), so only read/audio need this.
      if (opts && opts.titleOpen) {
        if (mode === 'read' && typeof window.openReadingMode === 'function') {
          try { window.openReadingMode(); } catch (e) {}
        } else if (mode === 'audio' && typeof window.openAudiobookMode === 'function') {
          try { window.openAudiobookMode(); } catch (e) {}
        } else if (mode === 'card' && typeof window.ensureCardRenderedForActiveTitle === 'function') {
          // Card content is normally rendered by the loader, but force a flush in
          // case the prior title's card is still showing (stale-card-on-switch fix).
          try { window.ensureCardRenderedForActiveTitle(); } catch (e) {}
        }
      }
      return;
    }
    _switchInFlight = true;
    _switchGen++;
    const myGen = _switchGen;

    // Bookmarks: a switch INTO audio from card/read auto-saves where the user
    // was reading, so they can jump back after the playhead runs ahead. Capture
    // NOW (before the view teardown below, while the reader is still laid out);
    // skip title-opens/restores (no prior in-session reading spot).
    if (mode === 'audio' && (currentMode === 'card' || currentMode === 'read') &&
        !(opts && opts.titleOpen) && window.bookmarks && window.bookmarks.capture) {
      try { window.bookmarks.capture(currentMode); } catch (_) {}
    }

    // === SYNCHRONOUS visibility flip ===
    // Flip views + tab UI THIS frame, before any await. That makes tab
    // taps feel instant: the user sees the new tab go active and the
    // new view appear immediately, even if mode-open setup hasn't
    // finished yet. The async setup runs in the background.
    //
    // CRITICAL: for read mode, show the PAGED reader view, not the
    // legacy #readingModeView. The legacy reader is deprecated but its
    // DOM element still exists. Previously this code unhid it briefly
    // before openReadingMode (paged) hid it again — visible behind the
    // audio→read modal as a "faint legacy reader" the user reported.
    // Hide the legacy view defensively each switch.
    const legacyReaderView = document.getElementById('readingModeView');
    if (legacyReaderView) legacyReaderView.style.display = 'none';
    if (mode === 'read') {
      // Cover the reader BEFORE revealing it so the entry load + scroll-to-
      // position happen behind an opaque panel — no visible scroll on entry.
      try { window.showReaderCover && window.showReaderCover(); } catch (_) {}
      const pv = document.getElementById('readingPagedView');
      // Reveal via visibility (display stays flex) so the vertical-rl layout is
      // NOT re-run on every read-entry — the Android mode-switch "settling" lag.
      if (pv) { pv.style.display = 'flex'; pv.style.visibility = 'visible'; pv.style.pointerEvents = 'auto'; }
    } else if (mode === 'audio') {
      const av = document.getElementById('audiobookModeView');
      if (av) av.style.display = 'flex';
    }
    if (currentMode === 'audio') {
      const av = document.getElementById('audiobookModeView');
      if (av && mode !== 'audio') av.style.display = 'none';
    } else if (currentMode === 'read') {
      const pv = document.getElementById('readingPagedView');
      // Hide via visibility (KEEP layout) so returning to read is a reveal, not a
      // full vertical-rl re-layout.
      if (pv && mode !== 'read') { pv.style.visibility = 'hidden'; pv.style.pointerEvents = 'none'; }
    }
    const prevMode = currentMode;
    currentMode = mode;
    updateTabsUI(mode);
    // Remember this mode PER-TITLE so opening the title (or restoring it on
    // launch) reopens in the mode the user last left it in. Only on a real
    // switch (we're past the same-mode early return above), never on refresh
    // ticks. localStorage LAST_MODE_V1 (in updateTabsUI) stays as the global
    // fallback for the very first launch before any title has a stored mode.
    try {
      if (window._activeTitleId && window.titleStore?.setMode) {
        window.titleStore.setMode(window._activeTitleId, mode);
      }
    } catch (_) {}

    // Save the reader cursor BEFORE audio mode takes over and starts
    // auto-scrolling the reader along with playback. The audio→read
    // reentry modal uses this saved value as the "prior reading
    // position" so the two displayed positions actually differ —
    // without this capture, both ended up identical because
    // lastMatchedIdx had advanced with audio-driven setActive calls.
    //
    // Capture on ANY transition INTO audio so the next return-from-audio has a
    // meaningful prior read position. Snapshot the PAGED read CUE cursor (the
    // line the user actually read) — NOT the legacy lastMatchedIdx, which the
    // active paged reader never advances (it was stale, so "return to prior
    // reading position" landed at an old spot). The reentry dialog reads the
    // live paged cursor first and uses this as the fallback; both are CUE indices.
    if (mode === 'audio' && prevMode !== 'audio') {
      try {
        const rc = (typeof window._pagedReadCueIdx === 'function') ? window._pagedReadCueIdx() : -1;
        if (Number.isFinite(rc) && rc >= 0) {
          window._priorReaderCursorIdx = rc;
          window._priorReaderCursorAtMs = Date.now();
        }
        // Card-mode snapshot for SRT-cards titles where the modal
        // shows card numbers instead of character positions.
        const ci = window.currentCardIndex;
        if (Number.isFinite(ci) && ci >= 0) {
          window._priorCardIdx = ci;
          window._priorCardIdxAtMs = Date.now();
          console.log('[shell] saved _priorCardIdx=' + ci + ' (display ' + (ci+1) + ')' +
                      ' from prevMode=' + prevMode);
        }
      } catch (_) {}
    }

    // === ASYNCHRONOUS setup (background) ===
    // Run open/close + position sync without blocking the switch. Errors
    // here only affect mode-specific behavior, not the visible state.
    //
    // Generation check after each await: if a tab tap during the
    // reentry dialog superseded this switch, _switchGen has advanced
    // past myGen and we bail out — the new switch's async block owns
    // the view-flip + position-sync from this point on.
    (async () => {
      try {
        // Reentry dialog appears ONLY on audio→card/read AND only
        // when audio is AHEAD of the card/reader cursor. Rationale
        // (per user clarification):
        //   - card and read share one logical cursor — they're
        //     always in sync. Transitioning between them never
        //     needs a "where to go" dialog.
        //   - audio is a separate, optional cursor that can run
        //     ahead of the user's position. The user might let
        //     audio play past where they read; coming back to
        //     read/card, they want to know "audio went further,
        //     do you want to follow?"
        //   - audio behind (user seeked back to review): no dialog.
        //     The user explicitly didn't want to be there; don't
        //     pester them about it.
        // Trigger the reentry dialog when:
        //   - Coming from audio mode (classic case), OR
        //   - The unresolved-divergence flag is set because the user
        //     dismissed a prior dialog via tab tap without picking
        //     a button. The flag persists across mode switches
        //     until they explicitly choose; the dialog re-appears
        //     in the target mode's flavor each time.
        // Suppress on a TITLE OPEN / launch-restore (opts.titleOpen): a fresh
        // title has no audio↔cursor divergence, so the "prior card N vs new
        // card M" dialog must never appear there — it was comparing the
        // previous title's stale position. The dialog is only for in-session
        // audio→card/read transitions.
        // Continuous mode: all three views track ONE playhead and audio
        // never pauses on a switch — so the reentry dialog is suppressed and
        // each target mode simply follows the live audio position. Mirror the
        // playing state into audioAutoAdvance so CARD mode advances with the
        // playhead (read mode already follows via the position listener).
        const continuous = isContinuousMode();
        if (continuous && window._bgPlaying) window.audioAutoAdvance = true;
        const triggerDialog = !continuous &&
                              !(opts && opts.titleOpen) &&
                              (mode === 'card' || mode === 'read') &&
                              (prevMode === 'audio' || window._audioPositionUnresolved);
        if (triggerDialog) {
          try {
            const bg = window.Capacitor?.Plugins?.BackgroundAudio;
            if (bg?.pause && window._bgPlaying) await bg.pause();
          } catch (_) {}
          if (typeof window.maybeShowAudioReentryDialog === 'function') {
            try { await window.maybeShowAudioReentryDialog(mode); } catch (e) {}
          }
          if (myGen !== _switchGen) return;
        }
        if (prevMode === 'audio' && typeof window.closeAudiobookMode === 'function') {
          await window.closeAudiobookMode({ keepPlaying: continuous });
          if (myGen !== _switchGen) return;
        } else if (prevMode === 'read' && typeof window.closeReadingMode === 'function') {
          await window.closeReadingMode();
          if (myGen !== _switchGen) return;
        }
        if (mode === 'audio' && typeof window.openAudiobookMode === 'function') {
          // resumeOnly: continue from wherever the BG plugin is paused/playing
          // instead of seeking back to the card/cursor position. True when (a)
          // the prior reentry dialog was dismissed by a tab tap (one-shot flag),
          // OR (b) the CALLER asked for it explicitly via opts.resumeOnly — the
          // lock-screen "play" path needs this so it attaches to the audio the
          // native side ALREADY resumed instead of restarting it (double-play).
          // Continuous mode with audio already playing also resumes in place
          // so entering audio never rewinds the playhead to the cue's start.
          const resumeOnly = !!window._reentryDismissedByTab || !!(opts && opts.resumeOnly) ||
                             (continuous && !!window._bgPlaying);
          // On a COLD RESTORE / title-open (opts.titleOpen), the prior mode is
          // just the boot default ('card'), so seekToCurrentPosition would seek
          // to the READ cursor and rewind the audiobook back to your reading
          // spot — losing where you were actually listening. A restore must
          // instead resume the SAVED audio playhead (startMs falls through to
          // getAudiobookLastPosition when seekToCurrentPosition is false).
          const isRestore = !!(opts && opts.titleOpen);
          await window.openAudiobookMode({
            seekToCurrentPosition: (prevMode === 'card' || prevMode === 'read') && !resumeOnly && !isRestore,
            resumeOnly
          });
          window._reentryDismissedByTab = false;
        } else if (mode === 'read' && typeof window.openReadingMode === 'function') {
          // Continuous mode: center the reader on the live audio cue so it
          // opens already aligned with the playhead (the position listener
          // keeps it synced from there).
          if (continuous && prevMode === 'audio' &&
              Number.isFinite(window._lastAudioCueIdx) && window._lastAudioCueIdx >= 0) {
            window._reentryAudioJumpCueIdx = window._lastAudioCueIdx;
          }
          // CARD → READ: signal the reader to land the green EXACTLY on the card's
          // line. centerOnActiveCard resolves the card's chunk for BOTH SRT-cards
          // (cue-map) AND deck-cards (text search); without this signal,
          // ensureGreenOnEnter(bmCue = the sparse-collapsed BOOKMARK cue, 1-2 lines
          // off the card) runs after it and overwrites + fights it (the card↔read
          // drift + oscillation). NOT set on titleOpen (handled above, untouched),
          // so a plain title-open still lands on the M1 bookmark.
          if (prevMode === 'card' && Number.isFinite(window.currentCardIndex) && window.currentCardIndex >= 0) {
            window._reentryCardCueIdx = window.currentCardIndex;
          }
          await window.openReadingMode();
        } else if (mode === 'card' && (prevMode === 'read' ||
                   (continuous && prevMode === 'audio'))) {
          // read → card: re-sync the card index to the reader cursor
          // (read and card share the same logical position). For
          // audio → card we normally DON'T sync — the reentry dialog
          // handles "follow audio" vs "stay". In CONTINUOUS mode there
          // is no dialog, so audio → card snaps the card to the live
          // playhead instead (syncCardToCurrentCue reads abCurrentCueIdx).
          if (typeof window.syncCardToCurrentCue === 'function') window.syncCardToCurrentCue();
        }
        // Entering card mode: guarantee the card view reflects the ACTIVE title.
        // syncCardToCurrentCue / the reentry dialog only re-render when the card
        // INDEX changes, so a title switch where the new index coincides with the
        // old one would otherwise leave the previous book's card on screen.
        if (mode === 'card' && typeof window.ensureCardRenderedForActiveTitle === 'function') {
          try { window.ensureCardRenderedForActiveTitle(); } catch (e) {}
        }
      } finally {
        if (myGen === _switchGen) _switchInFlight = false;
      }
    })();
  };

  // --------- Timer (reads state from reading-mode.js via window.getReadingTimerState) ----------

  function pullTimerState() {
    if (typeof window.getReadingTimerState !== 'function') return null;
    try { return window.getReadingTimerState(); } catch (e) { return null; }
  }

  function refreshTimerLabel() {
    const lbl = el('shellTimerLabel');
    if (!lbl) return;
    const state = pullTimerState();
    if (!state) { lbl.textContent = '0:00'; lbl.classList.add('paused'); return; }
    lbl.textContent = fmtSec(state.totalSec);
    lbl.classList.toggle('paused', !state.running);
  }

  function startTimerPoll() {
    if (timerPollHandle) return;
    refreshTimerLabel();
    timerPollHandle = setInterval(refreshTimerLabel, 1000);
  }

  // Tap the timer pill = pause / unpause the current mode's timer. Debounced
  // because the pill has BOTH an inline onclick and a JS-attached click
  // listener (Android WebView reliability) — without the guard a single tap
  // would toggle twice and cancel out.
  let _shellTimerFiring = false;
  window.shellToggleTimer = function (ev) {
    try { ev?.stopPropagation?.(); } catch (_) {}
    if (_shellTimerFiring) return;
    _shellTimerFiring = true;
    setTimeout(() => { _shellTimerFiring = false; }, 300);
    if (typeof window.toggleReadingTimer === 'function') window.toggleReadingTimer();
    refreshTimerLabel();
  };

  // --------- Timer menu (legacy; tap now toggles, Stats moved to ⋯) ----------

  function dismissShellMenu() {
    const m = document.getElementById('shellFloatingMenu');
    if (m) m.remove();
  }

  window.openShellTimerMenu = function (ev) {
    ev?.stopPropagation();
    dismissShellMenu();
    const menu = document.createElement('div');
    menu.id = 'shellFloatingMenu';
    menu.className = 'shell-menu';

    const mkItem = (label, fn) => {
      const b = document.createElement('button');
      b.className = 'menu-item';
      b.textContent = label;
      // Fire on BOTH touchend (with preventDefault to suppress the synthetic
      // click) AND click (desktop / fallback). On Android WebView the
      // synthetic click after touchend sometimes never arrives — explicit
      // touchend ensures the action runs.
      let firing = false;
      const fire = (e) => {
        if (firing) return;
        firing = true;
        try { e.stopPropagation(); } catch (_) {}
        try { if (e.cancelable) e.preventDefault(); } catch (_) {}
        console.log('[shell-menu] item:', label);
        dismissShellMenu();
        try { fn(); } catch (err) { console.warn('menu action:', err); }
        setTimeout(() => { firing = false; }, 600);
      };
      b.addEventListener('click', fire);
      b.addEventListener('touchend', fire, { passive: false });
      return b;
    };

    const state = pullTimerState();
    const running = state && state.running;
    // Trimmed: removed Hide/Show timer (no way to recover once hidden was
    // confusing) and Reset timer (moved into the Stats popup so it can't
    // be tapped by mistake).
    const mkDivider = () => {
      const d = document.createElement('div');
      d.className = 'menu-divider';
      d.style.cssText = 'height:1px;background:#2a2a2a;margin:6px 8px;pointer-events:none;';
      return d;
    };
    menu.appendChild(mkItem(running ? 'Pause Timer' : 'Start Timer', () => {
      if (typeof window.toggleReadingTimer === 'function') window.toggleReadingTimer();
      refreshTimerLabel();
    }));
    menu.appendChild(mkDivider());
    menu.appendChild(mkItem('Stats…', () => {
      if (typeof window.openReadingStats === 'function') window.openReadingStats();
    }));

    document.body.appendChild(menu);
    // Position near the trigger.
    const trigger = ev?.currentTarget || el('shellTimerMenuBtn');
    const tr = trigger?.getBoundingClientRect?.();
    const rect = menu.getBoundingClientRect();
    let left = tr ? tr.right - rect.width : window.innerWidth - rect.width - 8;
    let top  = tr ? tr.bottom + 4 : 56;
    left = Math.max(8, Math.min(left, window.innerWidth - rect.width - 8));
    top  = Math.max(56, Math.min(top, window.innerHeight - rect.height - 8));
    menu.style.left = left + 'px';
    menu.style.top  = top + 'px';

    setTimeout(() => {
      const dismiss = (e) => {
        if (menu.contains(e.target)) return;
        dismissShellMenu();
        document.removeEventListener('touchstart', dismiss, true);
        document.removeEventListener('mousedown', dismiss, true);
      };
      document.addEventListener('touchstart', dismiss, true);
      document.addEventListener('mousedown', dismiss, true);
    }, 0);
  };

  // --------- Play button ----------
  //
  // Two click handlers (inline onclick + JS-attached) BOTH fire on the same
  // tap → toggle then untoggle → looks like nothing happened. Debounce.
  let _shellPlayFiring = false;
  // Optimistic-state pin. When the user taps PLAY/PAUSE we predict
  // the post-toggle state and flip the label immediately. But audio
  // start-up (especially the FIRST play, before the source is loaded)
  // can take 200-800 ms, during which refreshShellPlayLabel reads
  // the "still not playing" actual state and would revert the label
  // — producing the PLAY → PAUSE → PLAY → PAUSE flicker on first
  // press. While `_shellPlayOptimistic.until` hasn't expired we hold
  // the predicted state and ignore disagreeing refreshes. Once the
  // actual state matches the prediction (audio finally started), we
  // clear the pin so subsequent refreshes flow normally.
  let _shellPlayOptimistic = null;
  // 2 s should cover even slow first-play audio prepare. After that
  // the actual state takes over so a genuinely-failed play eventually
  // reverts.
  const SHELL_PLAY_OPTIMISTIC_MS = 2000;

  // -------- Two-finger horizontal swipe → cycle modes (card → read → audio) --
  // Circular both directions; coarser threshold than one-finger gestures since
  // two-finger swipes are less precise. Fires once per gesture (latched).
  (function installTwoFingerModeSwitch() {
    const ORDER = ['card', 'read', 'audio'];
    const curMode = () => document.body.classList.contains('mode-audio') ? 'audio'
                        : document.body.classList.contains('mode-read')  ? 'read' : 'card';
    const cycle = (dir) => {
      const i = ORDER.indexOf(curMode());
      const next = ORDER[(i + dir + ORDER.length) % ORDER.length];
      if (typeof window.setShellMode === 'function') { try { window.setShellMode(next); } catch (_) {} }
    };
    let sx = 0, sy = 0, active = false, fired = false;
    const cx = (t) => (t[0].clientX + t[1].clientX) / 2;
    const cy = (t) => (t[0].clientY + t[1].clientY) / 2;
    document.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) { active = true; fired = false; sx = cx(e.touches); sy = cy(e.touches); }
      else if (e.touches.length > 2) { active = false; }
    }, { passive: true, capture: true });
    document.addEventListener('touchmove', (e) => {
      if (!active || fired || e.touches.length !== 2) return;
      const dx = cx(e.touches) - sx, dy = cy(e.touches) - sy;
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        fired = true;
        cycle(dx < 0 ? 1 : -1);   // swipe LEFT → next mode, RIGHT → previous
      }
    }, { passive: true, capture: true });
    document.addEventListener('touchend', (e) => { if (e.touches.length < 2) active = false; }, { passive: true, capture: true });
  })();

  window.shellTogglePlay = function () {
    if (_shellPlayFiring) return;
    _shellPlayFiring = true;
    setTimeout(() => { _shellPlayFiring = false; }, 300);

    // Optimistic label flip: compute the predicted post-toggle state
    // and update the button NOW, before firing the async toggle. The
    // 800 ms refresh interval and the bg state listener correct it
    // back if the actual playback disagrees (e.g., play failed
    // silently). Without this the label lagged the action by ~50 ms
    // because refreshShellPlayLabel waits on bg.getState() / the
    // listener to roundtrip — the audio itself responds instantly,
    // but the user perceived "press → wait → label updates" as the
    // play button being laggy.
    const btn = el('shellPlayBtn');

    if (currentMode === 'audio') {
      const willPlay = !window._lastBgPlaying;
      window._lastBgPlaying = willPlay;
      _shellPlayOptimistic = { playing: willPlay, until: Date.now() + SHELL_PLAY_OPTIMISTIC_MS };
      if (btn) setPlayBtnState(btn, willPlay);
      // Freeze/resume the waveform cursor SYNCHRONOUSLY (like swipe-down) so it
      // doesn't lag waiting on the native 'state' round-trip.
      try { window.waveform?.setPlaying?.(willPlay); } catch (_) {}
      if (typeof window.audiobookTogglePlay === 'function') window.audiobookTogglePlay();
      return;
    }
    // Card + Read modes: PLAY = "play and auto-advance through cards".
    // PAUSE = stop continuous play AND disable auto-advance.
    const wasPlaying = typeof window.isReadingPlaying === 'function' && window.isReadingPlaying();
    const willPlay = !wasPlaying;
    _shellPlayOptimistic = { playing: willPlay, until: Date.now() + SHELL_PLAY_OPTIMISTIC_MS };
    if (btn) setPlayBtnState(btn, willPlay);
    // Freeze/resume the waveform cursor SYNCHRONOUSLY (matches swipe-down) so the
    // card-mode playhead reacts instantly instead of lagging on the native
    // 'state' round-trip.
    try { window.waveform?.setPlaying?.(willPlay); } catch (_) {}
    window.audioAutoAdvance = willPlay;
    if (typeof window.toggleReadingPlayback === 'function') window.toggleReadingPlayback();
  };

  function setPlayBtnState(btn, playing) {
    const playSvg = btn.querySelector('svg[data-role="play"]');
    const pauseSvg = btn.querySelector('svg[data-role="pause"]');
    if (!playSvg || !pauseSvg) { btn.textContent = playing ? 'PAUSE' : 'PLAY'; return; }
    playSvg.style.display  = playing ? 'none' : 'block';
    pauseSvg.style.display = playing ? 'block' : 'none';
  }

  // Helper: decide whether to honor an actual-state report given the
  // current optimistic pin. Returns true if the caller should apply
  // the actual state; false if the pin is still active and disagrees
  // (caller should leave the label alone).
  function _shouldApplyActualState(actualPlaying) {
    if (!_shellPlayOptimistic) return true;
    if (Date.now() > _shellPlayOptimistic.until) {
      _shellPlayOptimistic = null; // grace expired
      return true;
    }
    if (actualPlaying === _shellPlayOptimistic.playing) {
      // Actual state caught up — clear pin and let normal flow resume.
      _shellPlayOptimistic = null;
      return true;
    }
    // Within grace window and actual disagrees with prediction —
    // keep the optimistic label.
    return false;
  }

  function refreshShellPlayLabel() {
    const btn = el('shellPlayBtn');
    if (!btn) return;
    if (currentMode === 'audio') {
      // Read the cached play state kept fresh by the bg 'state' event listener
      // (app.js:3994 sets window._bgPlaying on every play/pause) instead of a
      // bg.getState() native bridge round-trip every 800ms while in audio mode
      // (incl. while paused/idle) — the event is authoritative, the poll was
      // redundant native IPC.
      const actual = !!window._bgPlaying;
      if (!_shouldApplyActualState(actual)) return;
      if (window._lastBgPlaying !== actual) {
        window._lastBgPlaying = actual;
        setPlayBtnState(btn, actual);
      }
      return;
    }
    const playing = typeof window.isReadingPlaying === 'function' && window.isReadingPlaying();
    if (!_shouldApplyActualState(playing)) return;
    setPlayBtnState(btn, playing);
  }

  // --------- MORE menu (preferences, library, etc.) ----------

  window.openShellMoreMenu = function (ev) {
    ev?.stopPropagation();
    dismissShellMenu();
    const menu = document.createElement('div');
    menu.id = 'shellFloatingMenu';
    menu.className = 'shell-menu';

    const mkItem = (label, fn) => {
      const b = document.createElement('button');
      b.className = 'menu-item';
      b.textContent = label;
      let firing = false;
      const fire = (e) => {
        if (firing) return;
        firing = true;
        try { e.stopPropagation(); } catch (_) {}
        try { if (e.cancelable) e.preventDefault(); } catch (_) {}
        console.log('[shell-menu] item:', label);
        dismissShellMenu();
        try { fn(); } catch (err) { console.warn('menu action:', err); }
        setTimeout(() => { firing = false; }, 600);
      };
      b.addEventListener('click', fire);
      b.addEventListener('touchend', fire, { passive: false });
      return b;
    };

    // Visual separator between menu groups — keeps the items
    // physically separated so they're easier to pick on a small
    // touch target.
    const mkDivider = () => {
      const d = document.createElement('div');
      d.className = 'menu-divider';
      d.style.cssText = 'height:1px;background:#2a2a2a;margin:6px 8px;pointer-events:none;';
      return d;
    };

    menu.appendChild(mkItem('Library…',        () => { if (typeof openLibrary === 'function') openLibrary(); }));
    menu.appendChild(mkDivider());
    menu.appendChild(mkItem('Bookmarks…',      () => { if (window.bookmarks?.openMenu) window.bookmarks.openMenu(); }));
    menu.appendChild(mkDivider());
    menu.appendChild(mkItem('Stats…',          () => { if (typeof window.openReadingStats === 'function') window.openReadingStats(); }));
    menu.appendChild(mkDivider());
    menu.appendChild(mkItem('Playback Speed…', () => { if (typeof window.openPlaybackSpeedDialog === 'function') window.openPlaybackSpeedDialog(); }));
    menu.appendChild(mkDivider());
    menu.appendChild(mkItem('Print…', () => { if (typeof window.openPrintDialog === 'function') window.openPrintDialog(); }));
    // "Log printed reading…" only appears once a print is pending (set by the
    // print flow, cleared after logging).
    if (typeof window.hasPendingPrintedReading === 'function' && window.hasPendingPrintedReading()) {
      menu.appendChild(mkItem('Log printed reading…', () => { if (typeof window.openLogPrintedReadingDialog === 'function') window.openLogPrintedReadingDialog(); }));
    }
    menu.appendChild(mkDivider());
    menu.appendChild(mkItem('Preferences…',    () => { if (typeof openPreferences === 'function') openPreferences(); }));

    document.body.appendChild(menu);
    const trigger = ev?.currentTarget || el('shellMoreBtn');
    const tr = trigger?.getBoundingClientRect?.();
    const rect = menu.getBoundingClientRect();
    let left = tr ? tr.right - rect.width : window.innerWidth - rect.width - 8;
    let top  = tr ? tr.bottom + 4 : 56;
    left = Math.max(8, Math.min(left, window.innerWidth - rect.width - 8));
    top  = Math.max(56, Math.min(top, window.innerHeight - rect.height - 8));
    menu.style.left = left + 'px';
    menu.style.top  = top + 'px';

    setTimeout(() => {
      const dismiss = (e) => {
        if (menu.contains(e.target)) return;
        dismissShellMenu();
        document.removeEventListener('touchstart', dismiss, true);
        document.removeEventListener('mousedown', dismiss, true);
      };
      document.addEventListener('touchstart', dismiss, true);
      document.addEventListener('mousedown', dismiss, true);
    }, 0);
  };

  // --------- Init ----------

  function resyncTabsFromDom() {
    const real = inferActiveMode();
    if (real !== currentMode) {
      currentMode = real;
      updateTabsUI(currentMode);
    }
  }

  // Defensive: attach explicit click listeners to shell buttons in addition
  // to the inline onclick attributes. Some Capacitor WebView setups have been
  // observed eating inline onclick events; the explicit listener path is
  // robust to that.
  function attachShellButtonListeners() {
    const wire = (id, handlerName) => {
      const btn = document.getElementById(id);
      if (!btn) { console.log('[shell] missing button:', id); return; }
      btn.addEventListener('click', (e) => {
        console.log('[shell] click:', id);
        try {
          const fn = window[handlerName];
          if (typeof fn === 'function') fn(e);
          else console.warn('[shell] handler missing:', handlerName);
        } catch (err) { console.warn('[shell] handler error:', err); }
      });
    };
    wire('shellTimerLabel', 'shellToggleTimer');
    wire('shellPlayBtn',    'shellTogglePlay');
    wire('shellMoreBtn',    'openShellMoreMenu');
  }

  function init() {
    console.log('[shell] init');
    // Platform class on <body> so CSS can scope tweaks per-OS. Used by the
    // narrow-header button sizing, which is Android-only (iOS is left as-is).
    try {
      document.body.classList.add('platform-' + (window.Capacitor?.getPlatform?.() || 'web'));
    } catch (_) {}
    installChromeTapHandler();
    attachShellButtonListeners();
    startTimerPoll();
    setInterval(refreshShellPlayLabel, 800);
    setInterval(resyncTabsFromDom, 800);
    refreshTabAvailability();
    setInterval(refreshTabAvailability, 3000);
    updateTabsUI(currentMode);
    setInterval(() => {
      if (typeof window.updateProgressBar === 'function') window.updateProgressBar();
    }, 500);
    // Ensure the top-left progress strip exists from app boot — needed
    // for Anki-only titles where the reader never opens, so the strip's
    // lazy creation inside openView() never fired and the card counter
    // simply didn't render. Retry briefly in case the paged-reader IIFE
    // hasn't installed the hook yet.
    const tryStrip = () => {
      if (typeof window.pagedEnsureProgressStrip === 'function') {
        window.pagedEnsureProgressStrip();
        // Keep the card counter live as the user swipes through cards.
        setInterval(() => {
          if (document.body.classList.contains('mode-card')) {
            window.pagedEnsureProgressStrip();
          }
        }, 500);
        return true;
      }
      return false;
    };
    if (!tryStrip()) {
      setTimeout(tryStrip, 100);
      setTimeout(tryStrip, 500);
      setTimeout(tryStrip, 1500);
    }

    // ----- Card-mode cover-image background + active-title watcher -----
    // The watcher does two things on every detected title change:
    //   1) Re-fires the silent reader prewarm so a fresh title's EPUB
    //      gets laid out before the user switches to read (matches
    //      "play a card through then switch" reliability).
    //   2) Repaints the card-mode background with the new title's
    //      cover image at low opacity — purely decorative, lives
    //      behind cardContainer.
    function ensureCardBackground() {
      let bg = document.getElementById('cardBackgroundImage');
      if (bg) return bg;
      bg = document.createElement('div');
      bg.id = 'cardBackgroundImage';
      bg.style.cssText =
        'position:fixed;top:0;left:0;right:0;bottom:0;' +
        'background-size:cover;background-position:center;background-repeat:no-repeat;' +
        // Slight blur softens the cover so it reads as ambient texture
        // rather than a competing focal element. `scale(1.05)` masks the
        // hard edges that filter:blur leaves at the viewport rim.
        'filter:blur(6px);-webkit-filter:blur(6px);transform:scale(1.05);' +
        // z-index 0 lets cardContainer (no z-index, painted later in
        // source order) appear ABOVE the background without explicit
        // z-index gymnastics on every card element.
        'opacity:0;z-index:0;pointer-events:none;' +
        'transition:opacity .25s ease, background-image .25s ease;';
      // First child of body so source order puts it behind everything.
      document.body.insertBefore(bg, document.body.firstChild);
      return bg;
    }
    // Pull the current card's image data URI (Anki deck-only mode has
    // no Title cover, but each card usually carries its own image —
    // expanding that as a faded background gives users the same
    // ambient effect for plain decks). Cheap: a regex against the
    // card.imageHtml field that displayCard already populates.
    function currentCardImageDataUri() {
      try {
        const card = window.allNotes?.[window.currentCardIndex ?? 0];
        if (!card?.imageHtml) return null;
        const m = card.imageHtml.match(/src="([^"]+)"/);
        return m ? m[1] : null;
      } catch (_) { return null; }
    }

    async function paintCardBackground() {
      const bg = ensureCardBackground();
      const isCard = document.body.classList.contains('mode-card');
      if (!isCard) { bg.style.opacity = '0'; return; }

      // Priority 1 — active Title's cover image (works for any Title
      // with a saved cover attachment).
      let dataUri = null;
      let cacheKey = '';
      const id = window._activeTitleId;
      if (id && window.titleStore?.list) {
        try {
          const titles = await window.titleStore.list();
          const t = titles.find(x => x.id === id);
          if (t?.attachments?.cover?.dataUri) {
            dataUri = t.attachments.cover.dataUri;
            cacheKey = 'title:' + id;
          }
        } catch (_) {}
      }
      // Priority 2 — Anki-deck-only mode: use the CURRENT card's
      // image. Key on the card index so swiping advances the
      // background to match.
      if (!dataUri) {
        const cardImg = currentCardImageDataUri();
        if (cardImg) {
          dataUri = cardImg;
          cacheKey = 'card:' + (window.currentCardIndex ?? 0);
        }
      }

      if (dataUri) {
        if (bg.dataset.cacheKey !== cacheKey) {
          bg.style.backgroundImage = 'url("' + dataUri + '")';
          bg.dataset.cacheKey = cacheKey;
        }
        bg.style.opacity = '0.10';
      } else {
        bg.style.opacity = '0';
        bg.style.backgroundImage = '';
        delete bg.dataset.cacheKey;
      }
    }
    // Active-title watcher. Poll-based because there's no central
    // assignment event; whatever sets window._activeTitleId can be in
    // app.js, library, autoRestoreFromTitles, etc.
    let _lastSeenTitleId = window._activeTitleId || null;
    function checkTitleChange() {
      const cur = window._activeTitleId || null;
      if (cur !== _lastSeenTitleId) {
        _lastSeenTitleId = cur;
        // Re-arm the paged-reader prewarm. Clearing _pagedPrewarmDone
        // lets the next pagedPrewarm() call actually run.
        window._pagedPrewarmDone = false;
        if (typeof window.pagedPrewarm === 'function') {
          // Small delay so attachment writes from the title-load path
          // (titleStore.attach etc.) settle before tryLoadFromActiveTitle.
          setTimeout(() => window.pagedPrewarm(), 250);
        }
        paintCardBackground();
      }
    }
    // Initial paint + watcher tick. 500 ms is fine — title changes are
    // user-driven (library tap) so there's no race-sensitive deadline.
    paintCardBackground();
    setInterval(() => {
      checkTitleChange();
      paintCardBackground();
    }, 500);
    // Repaint on mode-change too so the background appears/disappears
    // immediately when the user switches in/out of card mode.
    window.addEventListener('shell:mode-change', () => paintCardBackground());
    // Restore the last mode the user was in. Wait briefly so the active
    // title finishes loading (otherwise we'd try to enter read/audio
    // before chunks / cues are ready and bounce back to card).
    // Restore the last mode the user was in — DETERMINISTICALLY, but only once
    // the boot content has SETTLED. app.js init sets _bootContentReady AFTER
    // auto-restore + the deck/card render. Firing earlier (on _activeTitleId
    // alone) switched into read before the card painted, and the deck-default
    // render + the 800ms DOM-resync then flipped us back to card. Settle first,
    // then switch once, so it sticks — on slow LMK boots too (no fixed timer).
    let _modeRestoreTries = 0;
    async function restoreActiveTitleMode() {
      if (!window._bootContentReady) {
        if (_modeRestoreTries++ < 120) setTimeout(restoreActiveTitleMode, 150);
        return;
      }
      if (!window._activeTitleId) {
        // Settled, no title → Library; leave mode as-is and lift the boot cover.
        try { window.revealApp && window.revealApp(); } catch (_) {}
        return;
      }
      // Reopen the restored title in the mode it was last viewed in. Prefer the
      // PER-TITLE lastMode (clamped to the modes this title enables); fall back
      // to the global LAST_MODE_V1, then the title's natural first-enabled mode.
      // Force the switch — without {force} the tab gate (data-empty still
      // reflecting the just-loaded title) would refuse and we'd stay in card.
      let targetMode = null, enabled = null;
      try {
        if (window.titleStore?.list) {
          const titles = await window.titleStore.list();
          const t = titles.find(x => x.id === window._activeTitleId);
          enabled = (t && window.titleStore.enabledModes)
            ? window.titleStore.enabledModes(t) : null;
          if (t?.lastMode && (!enabled || enabled[t.lastMode])) targetMode = t.lastMode;
        }
      } catch (e) {}
      if (!targetMode) {
        let g = null; try { g = localStorage.getItem('LAST_MODE_V1'); } catch (e) {}
        if (g && enabled && enabled[g]) targetMode = g;
      }
      if (!targetMode && enabled) {
        targetMode = enabled.card ? 'card' : enabled.read ? 'read' : enabled.audio ? 'audio' : null;
      }
      if (targetMode && targetMode !== currentMode &&
          typeof window.setShellMode === 'function') {
        window.setShellMode(targetMode, { force: true, titleOpen: true });
      }
      // Lift the boot cover once the restored mode has settled. READ lifts
      // itself when the reader entry finishes (revealApp is wired into
      // hideReaderCover). For card/audio — or when targetMode couldn't be
      // resolved — the content is already painted, so reveal after the next
      // paint so the user never stays stuck behind the spinner.
      if (targetMode !== 'read') {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          try { window.revealApp && window.revealApp(); } catch (_) {}
        }));
      }
    }
    restoreActiveTitleMode();
  }

  // Expose so title-load paths can force an immediate refresh.
  window.refreshTabAvailability = refreshTabAvailability;

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
