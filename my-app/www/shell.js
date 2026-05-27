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

    // Source of truth: the Title object's attachments. Falls back to the
    // legacy per-deck pref read only when no Title is active.
    let hasAudio = false, hasEpub = false;
    let source = 'none';
    const idsToCheck = [window._activeTitleId, window._editingTitleId].filter(Boolean);
    try {
      if (window.titleStore?.get) {
        for (const id of idsToCheck) {
          const t = await window.titleStore.get(id);
          if (!t) continue;
          if (t.attachments?.audiobook) hasAudio = true;
          if (t.attachments?.epub) hasEpub = true;
          source = 'title:' + id;
          if (hasAudio && hasEpub) break;
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

    console.log('[shell] refreshTabAvailability source=' + source +
      ' hasAudio=' + hasAudio + ' hasEpub=' + hasEpub);
    const setEmpty = (tab, empty) => {
      if (!tab) return;
      if (empty) tab.dataset.empty = '1';
      else delete tab.dataset.empty;
    };
    setEmpty(audioTab, !hasAudio);
    setEmpty(readTab, !hasEpub);
  }

  // Authoritative "what mode is actually visible right now" — checks the DOM,
  // not just shell's internal state. Catches cases where reading or audiobook
  // was opened via a non-shell entry point (e.g., toolbar button).
  function inferActiveMode() {
    const ab = document.getElementById('audiobookModeView');
    if (ab && ab.style.display !== 'none') return 'audio';
    const rd = document.getElementById('readingModeView');
    if (rd && rd.style.display !== 'none') return 'read';
    return 'card';
  }

  window.setShellMode = async function (mode) {
    // Resync internal state from the DOM in case overlays were opened/closed
    // outside the shell tabs.
    currentMode = inferActiveMode();
    if (mode === currentMode) return;

    // Leaving audio → other: if the audiobook has drifted from the reading
    // cursor, ask the user what to do before tearing down audio.
    if (currentMode === 'audio' && (mode === 'card' || mode === 'read')) {
      if (typeof window.maybeShowAudioReentryDialog === 'function') {
        try { await window.maybeShowAudioReentryDialog(); } catch (e) {}
      }
    }

    // Close whatever is currently visible.
    if (currentMode === 'audio' && typeof window.closeAudiobookMode === 'function') {
      await window.closeAudiobookMode();
    } else if (currentMode === 'read' && typeof window.closeReadingMode === 'function') {
      await window.closeReadingMode();
    }

    // Open new mode.
    if (mode === 'audio' && typeof window.openAudiobookMode === 'function') {
      // Entering audio from card/read: seek to whatever chunk is currently
      // active so the audiobook resumes at the same story position.
      const fromOther = currentMode === 'card' || currentMode === 'read';
      await window.openAudiobookMode({ seekToCurrentPosition: fromOther });
    } else if (mode === 'read' && typeof window.openReadingMode === 'function') {
      await window.openReadingMode();
    } else if (mode === 'card' && currentMode !== 'card') {
      // Card mode is the default underlay (nothing to "open"), but if audio
      // is playing while we enter card mode the card index needs to jump to
      // the currently-playing cue so the rest of card-mode behavior (auto-
      // advance, replay) keys off the audio playhead.
      if (typeof window.syncCardToCurrentCue === 'function') window.syncCardToCurrentCue();
    }
    currentMode = mode;
    updateTabsUI(mode);
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

  // --------- Timer menu ----------

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

    menu.appendChild(mkItem(running ? '⏸  Pause timer' : '▶  Start timer', () => {
      if (typeof window.toggleReadingTimer === 'function') window.toggleReadingTimer();
      refreshTimerLabel();
    }));
    menu.appendChild(mkItem('🔄  Reset timer', () => {
      if (typeof window.resetReadingTimer === 'function') window.resetReadingTimer();
      refreshTimerLabel();
    }));
    menu.appendChild(mkItem('📊  Stats…', () => {
      if (typeof window.openReadingStats === 'function') window.openReadingStats();
    }));
    const divider = document.createElement('div');
    divider.className = 'menu-divider';
    menu.appendChild(divider);
    menu.appendChild(mkItem(timerHidden ? 'Show timer' : 'Hide timer', () => {
      timerHidden = !timerHidden;
      const lbl = el('shellTimerLabel');
      if (lbl) lbl.classList.toggle('hidden', timerHidden);
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

  window.shellTogglePlay = function () {
    if (_shellPlayFiring) return;
    _shellPlayFiring = true;
    setTimeout(() => { _shellPlayFiring = false; }, 300);

    if (currentMode === 'audio') {
      if (typeof window.audiobookTogglePlay === 'function') window.audiobookTogglePlay();
      refreshShellPlayLabel();
      return;
    }
    // Card + Read modes: PLAY = "play and auto-advance through cards".
    // PAUSE = stop continuous play AND disable auto-advance.
    const playing = typeof window.isReadingPlaying === 'function' && window.isReadingPlaying();
    if (playing) {
      window.audioAutoAdvance = false;
      if (typeof window.toggleReadingPlayback === 'function') window.toggleReadingPlayback();
    } else {
      window.audioAutoAdvance = true;
      if (typeof window.toggleReadingPlayback === 'function') window.toggleReadingPlayback();
    }
    refreshShellPlayLabel();
  };

  function refreshShellPlayLabel() {
    const btn = el('shellPlayBtn');
    if (!btn) return;
    let playing = false;
    if (currentMode === 'audio') {
      // Audiobook playing state — best-effort from plugin state poll.
      const bg = window.Capacitor?.Plugins?.BackgroundAudio;
      if (bg && typeof bg.getState === 'function') {
        // Async; debounce by caching last state on a window flag.
        bg.getState().then(s => {
          if (window._lastBgPlaying !== !!s.playing) {
            window._lastBgPlaying = !!s.playing;
            btn.textContent = s.playing ? 'PAUSE' : 'PLAY';
          }
        }).catch(() => {});
        return;
      }
    } else {
      playing = typeof window.isReadingPlaying === 'function' && window.isReadingPlaying();
    }
    btn.textContent = playing ? 'PAUSE' : 'PLAY';
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

    menu.appendChild(mkItem('Library',     () => { if (typeof openLibrary === 'function') openLibrary(); }));
    menu.appendChild(mkItem('Preferences', () => { if (typeof openPreferences === 'function') openPreferences(); }));

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
    wire('shellTimerLabel', 'openShellTimerMenu');
    wire('shellPlayBtn',    'shellTogglePlay');
    wire('shellMoreBtn',    'openShellMoreMenu');
  }

  function init() {
    console.log('[shell] init');
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
    // Restore the last mode the user was in. Wait briefly so the active
    // title finishes loading (otherwise we'd try to enter read/audio
    // before chunks / cues are ready and bounce back to card).
    setTimeout(() => {
      let lastMode = null;
      try { lastMode = localStorage.getItem('LAST_MODE_V1'); } catch (e) {}
      if (lastMode && lastMode !== 'card' && lastMode !== currentMode &&
          typeof window.setShellMode === 'function') {
        window.setShellMode(lastMode);
      }
    }, 1500);
  }

  // Expose so title-load paths can force an immediate refresh.
  window.refreshTabAvailability = refreshTabAvailability;

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
