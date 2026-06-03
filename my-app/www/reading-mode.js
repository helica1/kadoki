(function () {
  const KEYS = {
    EPUB_URI: 'READING_EPUB_URI',
    EPUB_NAME: 'READING_EPUB_NAME',
    FONT: 'READING_FONT',
    FONT_SIZE: 'READING_FONT_SIZE',
    VERTICAL: 'READING_VERTICAL',
    HIGHLIGHT: 'READING_HIGHLIGHT_COLOR',
    AUTO_ADVANCE: 'READING_AUTO_ADVANCE',
    TIME_SEC: 'READING_TIME_SEC',
    CHARS: 'READING_CHARS_TOTAL',
    PROGRESS_MODE: 'READING_PROGRESS_MODE',
    MODE_OPEN: 'READING_MODE_OPEN',
    AUDIOBOOK_OPEN: 'READING_AUDIOBOOK_OPEN',
    PAIRING_PREFIX: 'READING_PAIRING_',
    CURSOR_PREFIX: 'READING_CURSOR_',
    AUDIO_PAIR_PREFIX: 'READING_AUDIO_PAIR_',     // <deck> → audio cache file path
    AUDIO_NAME_PREFIX: 'READING_AUDIO_NAME_',     // <deck> → audio display name
    SRT_PAIR_PREFIX: 'READING_SRT_PAIR_',         // <deck> → srt cache file path
    SRT_NAME_PREFIX: 'READING_SRT_NAME_',         // <deck> → srt display name
    AUDIO_LAST_POS_PREFIX: 'READING_AUDIO_LAST_POS_', // <deck> → ms position
    AUDIO_LAST_CHUNK_PREFIX: 'READING_AUDIO_LAST_CHUNK_' // <deck> → chunk idx
  };

  const DEFAULT_HIGHLIGHT = '#4caf50'; // green — matches the read-mode accent

  let timerStart = null;
  let timerInterval = null;
  let cumulativeSec = 0;
  let cumulativeChars = 0;
  let currentEpubName = null;
  let currentEpubUri = null;   // uri of the loaded book — identifies it even when two books share a filename
  let chunks = [];
  let lastMatchedIdx = -1;
  let firstSyncForBook = true;
  let toolbarShown = true;
  let playStatePollInterval = null;

  function rlog(msg) {
    if (window.debugLog) window.debugLog('[READ] ' + msg);
    else console.log('[READ] ' + msg);
  }

  function isCap() {
    return typeof window.isCapacitorEnvironment === 'function' && window.isCapacitorEnvironment();
  }

  async function setPref(key, value) {
    if (isCap() && window.Capacitor?.Plugins?.Preferences) {
      await window.Capacitor.Plugins.Preferences.set({ key, value: String(value) });
    } else {
      localStorage.setItem(key, String(value));
    }
  }

  async function getPref(key) {
    if (isCap() && window.Capacitor?.Plugins?.Preferences) {
      const res = await window.Capacitor.Plugins.Preferences.get({ key });
      return res.value;
    }
    return localStorage.getItem(key);
  }

  function currentDeckName() {
    const el = document.getElementById('deckName');
    const raw = (el?.textContent || '').trim();
    if (!raw) return null;
    return raw.replace(/\s*\((Tap to reopen|Auto-restoring\.\.\.)\)\s*$/i, '').trim() || null;
  }

  function pairingKey(deckName) {
    return KEYS.PAIRING_PREFIX + deckName;
  }
  function cursorKey(deckName, epubName) {
    return KEYS.CURSOR_PREFIX + deckName + '__' + epubName;
  }

  async function savePairing(deckName, epubName) {
    if (!deckName || !epubName) return;
    await setPref(pairingKey(deckName), epubName);
  }
  async function getPairedEpub(deckName) {
    if (!deckName) return null;
    return await getPref(pairingKey(deckName));
  }
  async function saveCursor(deckName, epubName, idx) {
    if (!deckName || !epubName || idx < 0) return;
    await setPref(cursorKey(deckName, epubName), idx);
  }
  async function getCursor(deckName, epubName) {
    if (!deckName || !epubName) return -1;
    const v = await getPref(cursorKey(deckName, epubName));
    const n = parseInt(v);
    return Number.isFinite(n) ? n : -1;
  }

  // -------- Audiobook + SRT deck-pairing helpers --------

  async function saveAudiobookPairing(deckName, cachePath, displayName) {
    if (!deckName || !cachePath) return;
    await setPref(KEYS.AUDIO_PAIR_PREFIX + deckName, cachePath);
    if (displayName) await setPref(KEYS.AUDIO_NAME_PREFIX + deckName, displayName);
  }
  async function getAudiobookPairing(deckName) {
    if (!deckName) return null;
    let path = await getPref(KEYS.AUDIO_PAIR_PREFIX + deckName);
    let name = await getPref(KEYS.AUDIO_NAME_PREFIX + deckName);
    // Fallback: when legacy prefs are missing (older title, or post-rehydrate
    // edge case), read straight from the active title's attachment.
    if (!path && window._activeTitleId && window.titleStore) {
      try {
        const titles = await window.titleStore.list();
        const t = titles.find(x => x.id === window._activeTitleId);
        const ab = t?.attachments?.audiobook;
        if (ab?.cachePath) { path = ab.cachePath; name = name || ab.name; }
      } catch (e) {}
    }
    if (!path) return null;
    return { path, name: name || 'audiobook' };
  }
  async function saveSrtPairing(deckName, cachePath, displayName) {
    if (!deckName || !cachePath) return;
    await setPref(KEYS.SRT_PAIR_PREFIX + deckName, cachePath);
    if (displayName) await setPref(KEYS.SRT_NAME_PREFIX + deckName, displayName);
  }
  async function getSrtPairing(deckName) {
    if (!deckName) return null;
    let path = await getPref(KEYS.SRT_PAIR_PREFIX + deckName);
    let name = await getPref(KEYS.SRT_NAME_PREFIX + deckName);
    if (!path && window._activeTitleId && window.titleStore) {
      try {
        const titles = await window.titleStore.list();
        const t = titles.find(x => x.id === window._activeTitleId);
        const sr = t?.attachments?.srt;
        if (sr?.cachePath) { path = sr.cachePath; name = name || sr.name; }
      } catch (e) {}
    }
    if (!path) return null;
    return { path, name: name || 'subtitles' };
  }
  async function saveAudiobookLastPosition(deckName, ms, chunkIdx) {
    if (!deckName) return;
    if (Number.isFinite(ms) && ms >= 0) {
      await setPref(KEYS.AUDIO_LAST_POS_PREFIX + deckName, Math.floor(ms));
    }
    if (Number.isFinite(chunkIdx) && chunkIdx >= 0) {
      await setPref(KEYS.AUDIO_LAST_CHUNK_PREFIX + deckName, chunkIdx);
    }
  }
  // Expose deck-pairing getters to the shell so it can grey out tabs for
  // modes the current title doesn't enable.
  window.getEpubPairingForDeck = async (deck) => deck ? await getPairedEpub(deck) : null;
  window.getAudiobookPairingForDeck = async (deck) => deck ? await getAudiobookPairing(deck) : null;
  window.getSrtPairingForDeck = async (deck) => deck ? await getSrtPairing(deck) : null;

  async function getAudiobookLastPosition(deckName) {
    if (!deckName) return { ms: 0, chunkIdx: -1 };
    const ms = parseInt(await getPref(KEYS.AUDIO_LAST_POS_PREFIX + deckName));
    const chunkIdx = parseInt(await getPref(KEYS.AUDIO_LAST_CHUNK_PREFIX + deckName));
    return {
      ms: Number.isFinite(ms) ? ms : 0,
      chunkIdx: Number.isFinite(chunkIdx) ? chunkIdx : -1
    };
  }

  function formatSec(total) {
    total = Math.floor(total);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  }

  function startTimer() {
    if (timerStart !== null) return;
    timerStart = Date.now();
    const label = document.getElementById('readingTimerLabel');
    timerInterval = setInterval(() => {
      const sessionSec = (Date.now() - timerStart) / 1000;
      if (label) label.textContent = formatSec(cumulativeSec + sessionSec);
    }, 1000);
  }

  async function stopTimer() {
    if (timerStart === null) return;
    const sessionSec = (Date.now() - timerStart) / 1000;
    cumulativeSec += sessionSec;
    timerStart = null;
    clearInterval(timerInterval);
    timerInterval = null;
    await setPref(KEYS.TIME_SEC, Math.floor(cumulativeSec));
    rlog(`Timer stopped: session ${sessionSec.toFixed(1)}s, cumulative ${cumulativeSec.toFixed(0)}s`);
  }

  function ensureFontOverrideStyle() {
    if (document.getElementById('readingFontOverride')) return;
    const style = document.createElement('style');
    style.id = 'readingFontOverride';
    style.textContent = `
      #readingModeContent, #readingModeContent * {
        font-family: var(--reader-font, serif) !important;
      }
      #readingModeContent {
        font-size: var(--reader-font-size, 1.1rem);
        background: #000000;
      }
      #readingModeContent .reading-chunk {
        transition: background-color 0.25s ease;
        border-radius: 3px;
      }
      /* Active chunk: text-color recolor (matches Android shadowing flow).
         No box / no background — Japanese text stays readable, and the
         mode-color text is enough signal that this is the active line. */
      #readingModeContent .reading-chunk.active {
        color: color-mix(in srgb, var(--accent-read, #4caf50) 75%, white 25%);
      }
      /* Up-swipe selection: paint the chunk in mode color so the user
         sees that the swipe registered. The cue-precise highlight (CSS
         Custom Highlight API) draws on top for the exact cue range when
         abChunkToCue has a mapping. This chunk-level style is the fallback
         when the cue map is missing OR when CSS.highlights isn't supported. */
      #readingModeContent .reading-chunk.long-press-armed { /* no-op */ }
      #readingModeContent .reading-chunk.pending {
        background-color: color-mix(in srgb, var(--accent-read, #4caf50) 14%, transparent);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-read, #4caf50) 50%, transparent);
        border-radius: 4px;
      }
      /* When a cue-precise highlight IS active, drop the chunk-level tint
         so the cue underline isn't competing with a colored box. */
      body.has-cue-highlight #readingModeContent .reading-chunk.pending {
        background-color: transparent;
        box-shadow: none;
      }
      #readingModeContent, #readingModeContent .reading-chunk {
        -webkit-user-select: none;
        user-select: none;
        -webkit-touch-callout: none;
        -webkit-tap-highlight-color: transparent;
      }
      /* In reading mode, dict-frags should be invisible until highlighted.
         Override the global rgba(0,0,0,0.1) background applied by enhanced-dictionary.js. */
      #readingModeContent .dict-frag {
        background-color: transparent !important;
      }
      #readingModeContent .dict-frag.highlight {
        background-color: var(--reader-highlight-bg, rgba(0,255,204,0.22)) !important;
        color: inherit !important;
      }
      #readingTimerLabel.paused { color: #ff5555 !important; }
      #readingFloatingControls {
        position: fixed; z-index: 2900;
        display: flex; gap: 4px; padding: 4px;
        background: rgba(34,34,34,0.95);
        border: 1px solid #555; border-radius: 999px;
        box-shadow: 0 6px 24px rgba(0,0,0,0.6);
      }
      #readingFloatingControls button {
        background: transparent; color: #fff; border: none;
        padding: 8px 12px; font-size: 16px; border-radius: 999px;
        min-width: 36px;
      }
      #readingFloatingControls button:active {
        background: rgba(255,255,255,0.15);
      }
      #readingModeToolbar.hidden {
        transform: translateY(-110%) !important;
      }
      #readingModeContent.vertical {
        writing-mode: vertical-rl;
        -webkit-writing-mode: vertical-rl;
        text-orientation: mixed;
        -webkit-text-orientation: mixed;
        overflow-x: auto !important;
        overflow-y: hidden !important;
        height: 100%;
        /* Lock the scroll origin in vertical-rl so the start-of-text edge
           stays fixed — iOS WebKit sometimes "snaps back" to scrollLeft=0
           after a layout change (dict popup, font resize, etc.). */
        overscroll-behavior: contain;
        -webkit-overflow-scrolling: touch;
      }
      /* Lock horizontal scrolling in horizontal mode — chunks that overflow
         their inline-axis should clip, never become a hidden scrollable. */
      #readingModeContent:not(.vertical) {
        overscroll-behavior: contain;
      }
      #readingModeContent.vertical hr {
        border: 0 !important;
        border-right: 1px solid #333 !important;
        margin: 0 32px !important;
        height: auto !important;
        width: 0 !important;
        align-self: stretch;
      }
    `;
    document.head.appendChild(style);
  }

  async function applyFontPrefs() {
   try {
    ensureFontOverrideStyle();
    // Parallelize the 5 prefs reads. Capacitor's Preferences plugin does a
    // JNI hop per call (~50–100 ms on Android), so sequencing 5 of them
    // was eating 250–500 ms on every reader open. Promise.all collapses
    // that to roughly the cost of the slowest single call.
    const [font, size, vertical, hi, auto] = await Promise.all([
      getPref(KEYS.FONT),
      getPref(KEYS.FONT_SIZE),
      getPref(KEYS.VERTICAL),
      getPref(KEYS.HIGHLIGHT),
      getPref(KEYS.AUTO_ADVANCE)
    ]);
    document.documentElement.style.setProperty('--reader-font', font || 'serif');
    document.documentElement.style.setProperty('--reader-font-size', (size || '1.875') + 'rem');
    // Writing mode: vertical-rl on Android (Chromium WebView has solid
    // support), horizontal on iOS. iOS WKWebView has chronic vertical-rl
    // layout bugs — the chunk's backing store gets corrupted whenever a
    // popup opens / a CSS var changes / any reflow happens, producing
    // the "screen goes black after dict opens" report. Going horizontal
    // sidesteps the entire bug class. The gesture map still works:
    // up/down scroll = page advance, FAST up/down swipe (thresholded by
    // SWIPE_MIN_DELTA + SWIPE_MAX_TIME) = Anki / play.
    const isIOS = window.Capacitor?.getPlatform?.() === 'ios';
    applyVertical(!isIOS);
    applyHighlightColor(hi || DEFAULT_HIGHLIGHT);
    // Default to STOP at cue end. User must explicitly enable
    // auto-advance via the Preferences toggle (auto === 'true').
    window.readingAutoAdvance = auto === 'true';
   } catch (e) {
    // Never let font-pref application bubble an unhandled rejection — under
    // extreme memory pressure (e.g. a huge deck loading) this path has thrown
    // "Maximum call stack size exceeded", which would otherwise brick boot.
    try { rlog && rlog('applyFontPrefs failed: ' + (e?.message || e)); } catch (_) {}
   }
  }

  function hexToRgba(hex, alpha) {
    let h = (hex || '').replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
      return `rgba(0,255,204,${alpha})`;
    }
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function applyHighlightColor(hex) {
    document.documentElement.style.setProperty('--reader-highlight-bg', hexToRgba(hex, 0.22));
    document.documentElement.style.setProperty('--reader-highlight-ring', hexToRgba(hex, 0.45));
  }
  // Derive the reading highlight color from the current read-mode accent.
  // Called on startup and whenever mode colors change so the highlight
  // tracks the user's chosen read accent automatically.
  function applyHighlightFromAccent() {
    const cs = getComputedStyle(document.body);
    const hex = (cs.getPropertyValue('--accent-read').trim()) || '#4caf50';
    applyHighlightColor(hex);
  }
  // Re-derive when mode colors update (Preferences → Mode accent colors).
  window.addEventListener('shell:mode-change', applyHighlightFromAccent);
  // Also poll once after each storage write — mode-colors.js writes the
  // CSS var on every picker change. We catch up on next render tick.
  document.addEventListener('DOMContentLoaded', applyHighlightFromAccent);
  if (document.readyState !== 'loading') queueMicrotask(applyHighlightFromAccent);

  function applyVertical(vertical) {
    const content = document.getElementById('readingModeContent');
    if (!content) return;
    // Remember the current chunk so we can scroll it back into view after
    // WebKit recomputes layout for the new writing-mode (otherwise the
    // viewport snaps to origin, which in vertical-rl looks like "back
    // to the beginning of the book").
    const targetIdx = lastMatchedIdx >= 0 ? lastMatchedIdx : -1;
    content.classList.toggle('vertical', !!vertical);
    if (targetIdx >= 0 && chunks[targetIdx]) {
      // Two-frame restore covers both the immediate reflow and any deferred
      // layer-tree work iOS WebKit kicks off after writing-mode changes.
      const recenter = () => {
        try {
          const el = chunks[targetIdx];
          if (el && typeof el.scrollIntoView === 'function') {
            el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
          }
        } catch (e) {}
      };
      requestAnimationFrame(() => { recenter(); requestAnimationFrame(recenter); });
    }
  }
  window.applyReaderVerticalNow = applyVertical;

  function showToolbar() {
    const tb = document.getElementById('readingModeToolbar');
    if (!tb) return;
    tb.classList.remove('hidden');
    toolbarShown = true;
  }
  function hideToolbar() {
    const tb = document.getElementById('readingModeToolbar');
    if (!tb) return;
    tb.classList.add('hidden');
    toolbarShown = false;
  }
  function toggleToolbar() {
    if (toolbarShown) hideToolbar();
    else showToolbar();
  }

  function refreshPlayPauseButton() {
    const btn = document.getElementById('readingPlayPauseBtn');
    if (!btn) return;
    const playing = typeof window.isReadingPlaying === 'function' && window.isReadingPlaying();
    btn.textContent = playing ? '⏸' : '▶';
  }

  function startPlayStatePoll() {
    if (playStatePollInterval) return;
    playStatePollInterval = setInterval(refreshPlayPauseButton, 600);
  }
  function stopPlayStatePoll() {
    if (!playStatePollInterval) return;
    clearInterval(playStatePollInterval);
    playStatePollInterval = null;
  }

  window.toggleReadingPlaybackUI = function () {
    if (typeof window.toggleReadingPlayback === 'function') {
      window.toggleReadingPlayback();
    }
    refreshPlayPauseButton();
  };

  const LONG_PRESS_MS = 500;
  // Looser thresholds — the user reported having to swipe 2-3 times before
  // down-swipe-to-play registered. 60px / 400ms missed slow swipes on
  // vertical-rl content. 36px / 700ms catches the natural finger motion
  // without producing false positives against actual scroll (which still
  // sets the `moved` flag and short-circuits at touchend).
  const SWIPE_MIN_DELTA = 36;     // px
  const SWIPE_MAX_TIME = 700;     // ms
  let longPressTimer = null;
  let longPressFired = false;
  let floatingControlsTimer = null;
  let pendingChunk = null;
  let totalBookChars = 0;     // RAW char total — flat-text coordinate (cue align / highlight)
  let totalBookJpChars = 0;   // Japanese-only total (ttu standard) — what we DISPLAY
  let progressMode = 0; // 0=percent, 1=current/total, 2=remaining
  let progressBarShown = false;

  function clearPendingChunk() {
    // Sweep all .pending chunks, not just the tracked one. Same race
    // protection as clearActiveHighlight — pendingChunk can fall out of
    // sync with the DOM during fast scroll on iOS, leaving green-tinted
    // chunks stranded across the page (the smear the user keeps seeing).
    const content = document.getElementById('readingModeContent');
    if (content) {
      content.querySelectorAll('.reading-chunk.pending').forEach(el =>
        el.classList.remove('pending'));
    }
    pendingChunk = null;
    try { if (window.CSS?.highlights) CSS.highlights.delete('cue-pending'); } catch (e) {}
  }

  function setPendingChunk(chunk) {
    if (!chunk) return;
    if (pendingChunk && pendingChunk !== chunk) {
      pendingChunk.classList.remove('pending');
    }
    pendingChunk = chunk;
    chunk.classList.add('pending');
    // Set cue-precise pending highlight: dashed underline on the chunk's
    // matched SRT cue text only (never on surrounding sentence chars).
    const cIdx = chunks.indexOf(chunk);
    if (abChunkToCue && cIdx >= 0) {
      const cueIdx = abChunkToCue[cIdx];
      const cueText = (cueIdx >= 0 && abCues[cueIdx]) ? abCues[cueIdx].text : '';
      if (cueText) setCueHighlightFor('cue-pending', cIdx, cueText);
      else { try { CSS.highlights.delete('cue-pending'); } catch (e) {} }
    }
  }

  function handleDownSwipe() {
    if (pendingChunk) {
      const target = pendingChunk;
      clearPendingChunk();
      seekToChunk(target);
      // seekToChunk → updateCardIndex → displayCard plays the new card.
      // If audio happened to be paused before, ensure it's playing now.
      if (typeof window.isReadingPlaying === 'function' && !window.isReadingPlaying() &&
          typeof window.toggleReadingPlayback === 'function') {
        window.toggleReadingPlayback();
      }
      refreshPlayPauseButton();
      return;
    }
    if (typeof window.toggleReadingPlayback === 'function') {
      window.toggleReadingPlayback();
      refreshPlayPauseButton();
    }
  }

  function handleUpSwipe(chunk) {
    if (!chunk) return;
    setPendingChunk(chunk);
    showSelectionActionPopup(chunk);
  }

  // Small floating popup with two actions — COPY (cue text only) and
  // ADD TO ANKI (which itself opens the waveform editor for audio).
  // Position is clamped to a safe viewport area so the user can always
  // reach the buttons, regardless of where the chunk landed.
  function showSelectionActionPopup(chunk) {
    hideSelectionActionPopup();
    if (!chunk) return;
    // Prefer the matched SRT cue's text (so the selection is precisely the
    // subtitle the user heard); fall back to the chunk text if no map.
    let text = '';
    const cIdx = chunks.indexOf(chunk);
    if (abChunkToCue && cIdx >= 0) {
      const cueIdx = abChunkToCue[cIdx];
      if (cueIdx >= 0 && abCues?.[cueIdx]) text = abCues[cueIdx].text;
    }
    if (!text) text = textWithoutRuby(chunk).trim();
    if (!text) return;
    const rect = chunk.getBoundingClientRect();
    const pop = document.createElement('div');
    pop.id = 'readSelectionPopup';
    pop.style.cssText = `
      position:fixed; z-index:2800;
      background:var(--panel,#161616); color:var(--text,#e8e8e8);
      border:1px solid var(--border,#2a2a2a); border-radius:8px;
      padding:6px; display:flex; gap:6px; font-size:.78rem;
      box-shadow:0 8px 24px rgba(0,0,0,0.6);
      max-width:92vw;
    `;
    const mkBtn = (label, fn) => {
      const b = document.createElement('button');
      b.className = 'btn';
      b.style.cssText = 'padding:8px 14px;font-size:.74rem;letter-spacing:.1em;text-transform:uppercase;font-weight:700;';
      b.textContent = label;
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    pop.appendChild(mkBtn('Copy', () => {
      try { navigator.clipboard.writeText(text); } catch (e) {}
      hideSelectionActionPopup();
    }));
    pop.appendChild(mkBtn('Add to Anki', async () => {
      hideSelectionActionPopup();
      await sendChunkToAnki(chunk, text);
    }));
    document.body.appendChild(pop);
    // Position: above the chunk if room, below if not, else clamped to a
    // safe band that stays clear of the top header (~48px) and bottom bar
    // (~36px) so it's always reachable.
    const popRect = pop.getBoundingClientRect();
    const TOP_MARGIN = 64;
    const BOTTOM_MARGIN = 72;
    let top = rect.top - popRect.height - 10;
    if (top < TOP_MARGIN) top = rect.bottom + 8;
    const maxTop = window.innerHeight - popRect.height - BOTTOM_MARGIN;
    if (top > maxTop) top = maxTop;
    top = Math.max(TOP_MARGIN, top);
    let left = rect.left + (rect.width - popRect.width) / 2;
    left = Math.max(8, Math.min(window.innerWidth - popRect.width - 8, left));
    pop.style.left = Math.round(left) + 'px';
    pop.style.top  = Math.round(top) + 'px';
    setTimeout(() => {
      const dismiss = (e) => {
        if (pop.contains(e.target)) return;
        hideSelectionActionPopup();
        document.removeEventListener('touchstart', dismiss, true);
        document.removeEventListener('mousedown', dismiss, true);
      };
      document.addEventListener('touchstart', dismiss, true);
      document.addEventListener('mousedown', dismiss, true);
    }, 0);
  }
  function hideSelectionActionPopup() {
    const p = document.getElementById('readSelectionPopup');
    if (p) p.remove();
  }

  // Resolve the audiobook range a chunk corresponds to (via chunkToCue map).
  function chunkCueRange(chunk) {
    if (!abChunkToCue || !abAudioPath || !chunk) return null;
    const i = chunks.indexOf(chunk);
    if (i < 0) return null;
    const cueIdx = abChunkToCue[i];
    if (cueIdx < 0 || !abCues?.[cueIdx]) return null;
    return { srcPath: abAudioPath, startMs: abCues[cueIdx].startMs, endMs: abCues[cueIdx].endMs };
  }

  async function adjustAudioForChunk(chunk) {
    const r = chunkCueRange(chunk);
    if (!r) { alert('This sentence has no matched audiobook cue.'); return; }
    if (!window.waveform?.edit) return;
    const text = textWithoutRuby(chunk).trim();
    // Locate the anchor cue so the editor can expose text-range handles.
    const chunkIdx = chunks.indexOf(chunk);
    const cueIdx = (chunkIdx >= 0 && abChunkToCue) ? abChunkToCue[chunkIdx] : -1;
    const adjusted = await window.waveform.edit({
      srcPath: r.srcPath,
      startMs: Math.round(r.startMs),
      endMs:   Math.round(r.endMs),
      title: text,
      cues: abCues,
      cueIndex: cueIdx
    });
    if (!adjusted) return;
    // Persist override on the chunk's dataset so a subsequent Add-to-Anki
    // (or Adjust) uses the new bounds.
    chunk.dataset.audioStartMs = Math.round(adjusted.startMs);
    chunk.dataset.audioEndMs   = Math.round(adjusted.endMs);
  }

  async function sendChunkToAnki(chunk, text) {
    if (!window.sendToAnki) { alert('Anki integration not loaded'); return; }
    // Bounds: chunk-level override (set by Adjust audio) wins; else cue range.
    let startMs = chunk.dataset.audioStartMs ? parseInt(chunk.dataset.audioStartMs) : NaN;
    let endMs   = chunk.dataset.audioEndMs   ? parseInt(chunk.dataset.audioEndMs)   : NaN;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      const r = chunkCueRange(chunk);
      if (r) { startMs = Math.round(r.startMs); endMs = Math.round(r.endMs); }
    }
    let audioData = '';
    let finalText = text;
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && abAudioPath &&
        window.Capacitor?.Plugins?.AudioSlicer) {
      // Let user fine-tune before send. Cancel = abort.
      const chunkIdx = chunks.indexOf(chunk);
      const cueIdx = (chunkIdx >= 0 && abChunkToCue) ? abChunkToCue[chunkIdx] : -1;
      const adjusted = await window.waveform.edit({
        srcPath: abAudioPath, startMs, endMs, title: text,
        cues: abCues, cueIndex: cueIdx
      });
      if (!adjusted) return;
      if (adjusted.text) finalText = adjusted.text;
      try {
        // Anki audio export contract: ALWAYS 1.0x. AudioSlicer.slice does
        // raw frame copy (MP3) or MediaMuxer remux (M4A) from the source
        // file at native speed — it ignores window.audioPlaybackRate by
        // design. The user's listening speed only affects in-app playback
        // (bg.play({rate})), never the file written for Anki.
        const slice = await window.Capacitor.Plugins.AudioSlicer.slice({
          srcPath: abAudioPath,
          startMs: Math.round(adjusted.startMs),
          endMs:   Math.round(adjusted.endMs)
        });
        if (slice?.path && typeof window.cacheFileToDataUri === 'function') {
          audioData = await window.cacheFileToDataUri(slice.path, slice.mime || 'audio/mp4');
          console.log('[read-anki] slice bytes=' + (audioData?.length || 0) + ' mime=' + (slice.mime || ''));
        }
      } catch (e) { console.warn('slice for Anki:', e); }
    }
    // Image: prefer Title cover for non-deck titles.
    let imageData = '';
    try {
      if (window._activeTitleId && window.titleStore?.list) {
        const titles = await window.titleStore.list();
        const tit = titles.find(t => t.id === window._activeTitleId);
        if (tit?.attachments?.cover?.dataUri) imageData = tit.attachments.cover.dataUri;
      }
    } catch (e) {}
    await window.sendToAnki({ expression: finalText, imageData, audioData });
  }

  // NO-OP placeholder for backward compatibility — the reader no longer
  // wraps chunks into per-char spans. caretRangeFromPoint + CSS Custom
  // Highlight API replaced the wrap path so iOS WKWebView never has to
  // relayout the chunk's render tree in vertical-rl (the source of the
  // "screen goes black after dictionary opens" crash).
  function wrapChunkForLookup() { /* deprecated */ }

  // Walk the chunk's text nodes in display order, skipping rt/rp (ruby
  // readings). Returns { textNodes, flatText } where flatText is the
  // concatenation of nodeValues — used to compute char-level offsets.
  function flattenChunkText(chunk) {
    const walker = document.createTreeWalker(chunk, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let cur = node.parentNode;
        while (cur && cur !== chunk) {
          if (cur.tagName === 'RT' || cur.tagName === 'RP') return NodeFilter.FILTER_REJECT;
          cur = cur.parentNode;
        }
        return node.nodeValue && node.nodeValue.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const textNodes = [];
    let flatText = '';
    let n;
    while ((n = walker.nextNode())) { textNodes.push(n); flatText += n.nodeValue; }
    return { textNodes, flatText };
  }

  // Paint the lookup highlight via CSS Custom Highlight API. No DOM
  // mutation — the chunk's render tree is untouched.
  function setReaderDictHighlight(chunk, textNodes, charStart, length) {
    if (!window.CSS?.highlights || typeof Highlight === 'undefined') return;
    if (!textNodes.length) { CSS.highlights.delete('reader-dict-lookup'); return; }
    let acc = 0, sNode = null, sOff = 0, eNode = null, eOff = 0;
    const charEnd = charStart + length;
    for (const node of textNodes) {
      const next = acc + node.nodeValue.length;
      if (sNode === null && charStart < next) {
        sNode = node; sOff = charStart - acc;
      }
      if (charEnd <= next) {
        eNode = node; eOff = charEnd - acc; break;
      }
      acc = next;
    }
    if (!sNode) { CSS.highlights.delete('reader-dict-lookup'); return; }
    if (!eNode) {
      eNode = textNodes[textNodes.length - 1];
      eOff = eNode.nodeValue.length;
    }
    try {
      const range = new Range();
      range.setStart(sNode, sOff);
      range.setEnd(eNode, Math.min(eOff, eNode.nodeValue.length));
      CSS.highlights.set('reader-dict-lookup', new Highlight(range));
    } catch (e) {
      try { CSS.highlights.delete('reader-dict-lookup'); } catch (er) {}
    }
  }
  function clearReaderDictHighlight() {
    try { window._dictLookupHl?.clear?.(); } catch (e) {}
    try { CSS.highlights?.delete?.('reader-dict-lookup'); } catch (e) {}
  }
  // Expose so dict popup-close can clear it.
  window._clearReaderDictHighlight = clearReaderDictHighlight;

  async function lookupAtPoint(chunk, x, y) {
    if (typeof window.performDictLookupAtPosition !== 'function') {
      rlog('Dictionary not available (performDictLookupAtPosition missing)');
      return;
    }
    rlog(`lookupAtPoint x=${x} y=${y} chunk=${chunks.indexOf(chunk)}`);
    // Flatten the chunk's text upfront — we'll use this either as the
    // direct source of truth, or as the fallback if caretRangeFromPoint
    // can't resolve cleanly on iOS.
    const { textNodes, flatText } = flattenChunkText(chunk);
    if (!textNodes.length || !flatText) {
      rlog('lookupAtPoint: chunk has no text nodes');
      return;
    }

    // Try caretRangeFromPoint. iOS WKWebView sometimes returns a Range
    // whose startContainer is an element (e.g. a wrapping <ruby> base
    // span); when that happens, walk into the first text descendant.
    const caret = (document.caretRangeFromPoint?.(x, y)) ||
                  (document.caretPositionFromPoint?.(x, y));
    let node = caret ? (caret.startContainer || caret.offsetNode) : null;
    let offset = caret ? ((caret.startContainer ? caret.startOffset : caret.offset) | 0) : 0;
    if (node && node.nodeType !== 3) {
      // Walk down to first text node, prefer one in our chunk.
      const tw = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      const t = tw.nextNode();
      if (t && chunk.contains(t)) { node = t; offset = 0; }
      else { node = null; }
    }

    // If caret didn't land cleanly inside our chunk, fall back to a
    // bounding-rect search: walk every text node in the chunk and find
    // the character whose client rect contains (x, y).
    let charIndex = -1;
    if (node && chunk.contains(node)) {
      // Skip if on rt/rp.
      let p = node.parentNode, skip = false;
      while (p && p !== chunk) {
        if (p.tagName === 'RT' || p.tagName === 'RP') { skip = true; break; }
        p = p.parentNode;
      }
      if (!skip) {
        let acc = 0;
        for (const tn of textNodes) {
          if (tn === node) { charIndex = acc + offset; break; }
          acc += tn.nodeValue.length;
        }
      }
    }
    if (charIndex < 0 || charIndex >= flatText.length) {
      // Fallback: use Range bounding rects to find the char under (x,y).
      const r = new Range();
      let acc = 0;
      outer:
      for (const tn of textNodes) {
        for (let i = 0; i < tn.nodeValue.length; i++) {
          r.setStart(tn, i);
          r.setEnd(tn, i + 1);
          const rect = r.getBoundingClientRect();
          if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
            charIndex = acc + i;
            break outer;
          }
        }
        acc += tn.nodeValue.length;
      }
      // Last resort: tap was on a chunk but no exact char — use chunk start.
      if (charIndex < 0) {
        rlog(`lookupAtPoint: caret + bounding-rect both failed, using chunk start`);
        charIndex = 0;
      } else {
        rlog(`lookupAtPoint: bounding-rect fallback found char ${charIndex}`);
      }
    } else {
      rlog(`lookupAtPoint: caret resolved char ${charIndex}`);
    }
    if (charIndex >= flatText.length) charIndex = flatText.length - 1;

    // Establish Anki context: sentence, card AND audiobook cue range
    // come from the TAPPED chunk — not from whatever cue happens to be
    // currently playing. (Bug: previously the Anki "Add" used the
    // playing cue, sending the wrong audio + sentence for the word.)
    const cardIdx = findCardForChunk(chunk);
    const card = (cardIdx >= 0 && Array.isArray(window.allNotes)) ? window.allNotes[cardIdx] : null;
    const chunkIdxLocal = chunks.indexOf(chunk);
    let cueAudioPath = null, cueStartMs = null, cueEndMs = null, cueText = '', cueIdxOut = -1;
    if (abChunkToCue && chunkIdxLocal >= 0) {
      let cueIdx = abChunkToCue[chunkIdxLocal];
      // Fallback when this chunk has no directly mapped cue: walk neighbor
      // chunks outward looking for one with a cue. Without this, dict
      // lookups in unmapped sentences fell back to the currently-playing
      // cue's audio — which sent the wrong sentence to Anki (user's bug
      // report: "if a word is looked up in a sentence that is NOT
      // selected it should use the SRT including the looked up word").
      if (cueIdx < 0) {
        for (let i = 1; i < 8 && (chunkIdxLocal - i >= 0 || chunkIdxLocal + i < chunks.length); i++) {
          if (chunkIdxLocal - i >= 0 && abChunkToCue[chunkIdxLocal - i] >= 0) {
            cueIdx = abChunkToCue[chunkIdxLocal - i];
            rlog(`lookupAtPoint: chunk ${chunkIdxLocal} unmapped, using prev cue from chunk ${chunkIdxLocal - i}`);
            break;
          }
          if (chunkIdxLocal + i < chunks.length && abChunkToCue[chunkIdxLocal + i] >= 0) {
            cueIdx = abChunkToCue[chunkIdxLocal + i];
            rlog(`lookupAtPoint: chunk ${chunkIdxLocal} unmapped, using next cue from chunk ${chunkIdxLocal + i}`);
            break;
          }
        }
      }
      if (cueIdx >= 0 && abCues[cueIdx]) {
        cueAudioPath = abAudioPath;
        cueStartMs = abCues[cueIdx].startMs;
        cueEndMs   = abCues[cueIdx].endMs;
        cueText    = abCues[cueIdx].text;
        cueIdxOut  = cueIdx;
      }
    }
    window.lookupContext = {
      source: 'reading',
      card,
      cardIdx,
      sentence: cueText || textWithoutRuby(chunk),
      cueAudioPath,
      cueStartMs,
      cueEndMs,
      cueIndex: cueIdxOut,
      cues: abCues
    };

    try {
      await window.performDictLookupAtPosition(chunk, textNodes, flatText, charIndex, setReaderDictHighlight);
    } catch (e) {
      rlog(`Dictionary error: ${e.message}`);
    }
  }

  // Locate which card (in window.allNotes) corresponds to a chunk.
  // Prefer the cached cardIdx if syncReadingToCard already matched this chunk;
  // otherwise scan allNotes forward from currentCardIndex.
  function findCardForChunk(chunk) {
    if (!chunk) return -1;
    if (chunk.dataset.cardIdx) {
      const i = parseInt(chunk.dataset.cardIdx);
      if (Number.isFinite(i) && Array.isArray(window.allNotes) && i >= 0 && i < window.allNotes.length) {
        return i;
      }
    }
    const notes = window.allNotes;
    if (!Array.isArray(notes) || !notes.length) return -1;
    const chunkNorm = chunk.dataset.norm || '';
    if (!chunkNorm) return -1;
    const cur = Math.max(0, window.currentCardIndex | 0);
    // Search outward from current index.
    for (let dist = 0; dist < notes.length; dist++) {
      for (const dir of [+1, -1]) {
        const i = cur + dir * dist;
        if (i < 0 || i >= notes.length) continue;
        const exp = notes[i] && notes[i].expression;
        if (!exp) continue;
        const expNorm = normalizeText(textWithoutRubyFromHtml(exp));
        if (!expNorm) continue;
        if (chunkNorm === expNorm || chunkNorm.includes(expNorm) || expNorm.includes(chunkNorm)) {
          return i;
        }
      }
    }
    return -1;
  }

  function hideFloatingControls() {
    const m = document.getElementById('readingFloatingControls');
    if (m) m.remove();
    if (floatingControlsTimer) {
      clearTimeout(floatingControlsTimer);
      floatingControlsTimer = null;
    }
  }

  function showFloatingControls(x, y) {
    hideFloatingControls();
    const wrap = document.createElement('div');
    wrap.id = 'readingFloatingControls';

    const mkBtn = (label, onTap) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      const fire = (e) => {
        e.stopPropagation();
        e.preventDefault();
        onTap();
        refreshPlayPauseButton();
        // Refresh local play/pause label.
        const playBtn = wrap.querySelector('[data-action="play"]');
        if (playBtn) {
          const playing = typeof window.isReadingPlaying === 'function' && window.isReadingPlaying();
          playBtn.textContent = playing ? '⏸' : '▶';
        }
      };
      b.addEventListener('click', fire);
      b.addEventListener('touchend', fire, { passive: false });
      return b;
    };

    const prevBtn = mkBtn('⏮', () => { if (window.goToPreviousCard) window.goToPreviousCard(); });
    const playing = typeof window.isReadingPlaying === 'function' && window.isReadingPlaying();
    const playBtn = mkBtn(playing ? '⏸' : '▶', () => {
      if (typeof window.toggleReadingPlayback === 'function') window.toggleReadingPlayback();
    });
    playBtn.dataset.action = 'play';
    const nextBtn = mkBtn('⏭', () => { if (window.goToNextCard) window.goToNextCard(); });

    wrap.appendChild(prevBtn);
    wrap.appendChild(playBtn);
    wrap.appendChild(nextBtn);
    document.body.appendChild(wrap);

    // Position near tap; clamp to viewport. Prefer above the tap when possible.
    const rect = wrap.getBoundingClientRect();
    let px = x - rect.width / 2;
    let py = y - rect.height - 14; // above the tap
    if (py < 8) py = y + 14;        // not enough room above → below
    px = Math.min(Math.max(8, px), window.innerWidth - rect.width - 8);
    py = Math.min(Math.max(8, py), window.innerHeight - rect.height - 8);
    wrap.style.left = px + 'px';
    wrap.style.top = py + 'px';

    // Auto-dismiss after 4s.
    floatingControlsTimer = setTimeout(hideFloatingControls, 4000);

    // Dismiss on outside tap.
    setTimeout(() => {
      const dismiss = (e) => {
        if (wrap.contains(e.target)) return;
        hideFloatingControls();
        document.removeEventListener('touchstart', dismiss, true);
        document.removeEventListener('mousedown', dismiss, true);
      };
      document.addEventListener('touchstart', dismiss, true);
      document.addEventListener('mousedown', dismiss, true);
    }, 0);
  }

  function seekToChunk(chunk) {
    if (!chunk) return;
    // Resolve target card BEFORE any visual change. setActive used to tag
    // chunk.dataset.cardIdx with the current (old) index, which then made
    // findCardForChunk return the old card and updateCardIndex no-op.
    const cardIdx = findCardForChunk(chunk);
    const chunkIdx = chunks.indexOf(chunk);

    if (cardIdx >= 0) {
      const oldCardIdx = window.currentCardIndex;
      if (typeof window.updateCardIndex === 'function') {
        window.updateCardIndex(cardIdx);
      } else if (Array.isArray(window.allNotes)) {
        window.currentCardIndex = cardIdx;
        if (typeof window.displayCard === 'function') window.displayCard();
      }
      // If the card didn't change, displayCard wasn't called and the highlight
      // didn't move. Force it to land on the chunk the user picked.
      if (cardIdx === oldCardIdx && chunkIdx >= 0) {
        setActive(chunkIdx);
        tagChunkWithCard(chunkIdx, cardIdx);
      }
    } else if (chunkIdx >= 0) {
      // No matching card; just highlight visually.
      setActive(chunkIdx);
    }
  }

  function handleLongPressOnChunk(chunk /* , x, y */) {
    if (!chunk) return;
    chunk.classList.remove('long-press-armed');
    // Long press = seek playback to this sentence ("region selection").
    seekToChunk(chunk);
  }

  function installContentTapHandler() {
    const content = document.getElementById('readingModeContent');
    if (!content || content.dataset.tapInstalled === '1') return;
    content.dataset.tapInstalled = '1';
    let tStart = 0, xStart = 0, yStart = 0, moved = false;
    let pressedChunk = null;
    let pressedX = 0, pressedY = 0;
    let startScrollTop = 0, startScrollLeft = 0;

    const clearLongPress = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      if (pressedChunk) pressedChunk.classList.remove('long-press-armed');
    };

    content.addEventListener('touchstart', (e) => {
      if (!e.touches?.[0]) return;
      markInteraction();
      // Clear any stale pending-chunk selection from a prior swipe — it
      // shouldn't linger across a fresh scroll. Without this, the user
      // saw green-tinted chunks accumulating as they scrolled through
      // the book after even one accidental up-swipe.
      if (typeof clearPendingChunk === 'function') clearPendingChunk();
      hideSelectionActionPopup();
      // If the dictionary popup is open, any tap inside the EPUB content area
      // should close it (and NOT trigger a new lookup or any other gesture).
      const popup = document.getElementById('dictPopup');
      if (popup && popup.style.display !== 'none' && !popup.contains(e.target)) {
        popup.style.display = 'none';
        popup.innerHTML = '';
        tStart = -1; // mark this touch sequence as "consumed"
        return;
      }
      tStart = Date.now();
      xStart = e.touches[0].clientX;
      yStart = e.touches[0].clientY;
      pressedX = xStart;
      pressedY = yStart;
      moved = false;
      longPressFired = false;
      startScrollTop = content.scrollTop;
      startScrollLeft = content.scrollLeft;
      hideFloatingControls();
      pressedChunk = e.target && e.target.closest ? e.target.closest('.reading-chunk') : null;
      if (pressedChunk) {
        pressedChunk.classList.add('long-press-armed');
        longPressTimer = setTimeout(() => {
          longPressFired = true;
          handleLongPressOnChunk(pressedChunk, pressedX, pressedY);
        }, LONG_PRESS_MS);
      }
    }, { passive: true });

    content.addEventListener('touchmove', (e) => {
      if (!e.touches?.[0]) return;
      const dx = Math.abs(e.touches[0].clientX - xStart);
      const dy = Math.abs(e.touches[0].clientY - yStart);
      // 16px threshold (was 10) — iOS touch reports a few px of jitter on
      // a stationary finger, and the 10px gate was killing dict lookups
      // in horizontal mode (any pre-touchend movement turned tap → scroll
      // and bailed before reaching lookupAtPoint).
      if (dx > 16 || dy > 16) {
        moved = true;
        clearLongPress();
      }
    }, { passive: true });

    content.addEventListener('touchend', (e) => {
      // Touch that was consumed by outside-tap-to-close on the dict popup.
      if (tStart < 0) {
        tStart = 0;
        return;
      }
      const touch = e.changedTouches && e.changedTouches[0];
      const targetChunk = e.target && e.target.closest ? e.target.closest('.reading-chunk') : null;
      const wasLongPress = longPressFired;
      clearLongPress();

      if (wasLongPress) return; // long-press already handled (seek)
      if (e.target && e.target.closest('button, a, input, select, textarea')) return;

      const dt = Date.now() - tStart;
      const dx = touch ? (touch.clientX - xStart) : 0;
      const dy = touch ? (touch.clientY - yStart) : 0;
      const adx = Math.abs(dx), ady = Math.abs(dy);

      // Gesture axis depends on writing mode:
      //   vertical-rl (Android): page advance is horizontal scroll, so a
      //     fast VERTICAL swipe is a free gesture. Up = select-to-Anki,
      //     down = play/pause.
      //   horizontal (iOS): page advance is vertical scroll, so a fast
      //     HORIZONTAL swipe is the free gesture. Left = select-to-Anki,
      //     right = play/pause. (Up/down swipes would collide with scroll
      //     intent.)
      const isVertical = content.classList.contains('vertical');
      if (isVertical) {
        // Skip vertical swipes that began in the OS edge zones (notification
        // shade up top / app switcher at the bottom).
        if (dt < SWIPE_MAX_TIME && ady > SWIPE_MIN_DELTA && ady > adx * 2 && adx < 24
            && !window._inSystemGestureZone?.(yStart)) {
          if (dy < 0) { if (targetChunk) handleUpSwipe(targetChunk); }
          else        { handleDownSwipe(); }
          return;
        }
      } else {
        if (dt < SWIPE_MAX_TIME && adx > SWIPE_MIN_DELTA && adx > ady * 2 && ady < 24) {
          if (dx < 0) { if (targetChunk) handleUpSwipe(targetChunk); }
          else        { handleDownSwipe(); }
          return;
        }
      }

      if (moved) return; // ordinary scroll/drag
      if (dt > LONG_PRESS_MS - 20) return;

      if (targetChunk) {
        // Short tap on a chunk → dictionary lookup at the touched character.
        lookupAtPoint(targetChunk, pressedX, pressedY);
        return;
      }
      // Empty / margin tap. Bottom 90 px toggles the inside-reading progress
      // bar (book %). Other margins toggle the shell chrome (full-screen).
      const bottomZone = 90; // px
      if (pressedY > window.innerHeight - bottomZone) {
        toggleProgressBar();
      } else if (typeof window.shellToggleChrome === 'function') {
        window.shellToggleChrome();
      }
    }, { passive: true });

    content.addEventListener('touchcancel', clearLongPress, { passive: true });
  }

  function refreshTimerUI() {
    const label = document.getElementById('readingTimerLabel');
    const bigBtn = document.getElementById('readerTimerBigBtn');
    const running = timerStart !== null;
    if (label) {
      label.classList.toggle('paused', !running);
      if (!running) label.textContent = formatSec(cumulativeSec);
    }
    if (bigBtn) {
      bigBtn.textContent = running ? 'Pause Timer' : 'Start Timer';
      bigBtn.style.background = running ? '#4caf50' : '#f44336';
    }
  }

  function refreshStatsModal() {
    // Pull live values from the per-mode stats module. The modal lays out
    // three side-by-side sections (CARD / READ / AUDIO).
    const s = window.stats;
    if (!s) return;
    const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    const setRunning = (id, running) => {
      const el = document.getElementById(id);
      if (el) el.dataset.running = running ? '1' : '0';
    };

    const cardSec  = s.getCardSec();
    const readSec  = s.getReadSec();
    const audioSec = s.getAudioSec();

    setText('statsCardTime',  formatSec(cardSec));
    setText('statsCardCount', s.getCardCount().toLocaleString());
    const cardChars = (typeof s.getCardChars === 'function') ? s.getCardChars() : 0;
    setText('statsCardChars', cardChars.toLocaleString());
    if (cardSec < 1 || cardChars === 0) {
      setText('statsCardRate', '—');
    } else {
      setText('statsCardRate', Math.round(cardChars / (cardSec / 3600)).toLocaleString());
    }
    setRunning('statsCard', s.isRunning('card'));

    setText('statsReadTime',  formatSec(readSec));
    // Live chars from stats.js (chunk-based, persisted across orientations).
    // Falls back to the legacy cumulativeChars only if the new tracker
    // isn't exposed yet.
    const readChars = (typeof s.getReadChars === 'function')
      ? s.getReadChars()
      : cumulativeChars;
    setText('statsReadChars', readChars.toLocaleString());
    if (readSec < 1 || readChars === 0) {
      setText('statsReadRate', '—');
    } else {
      setText('statsReadRate', Math.round(readChars / (readSec / 3600)).toLocaleString());
    }
    setRunning('statsRead', s.isRunning('read'));

    setText('statsAudioTime', formatSec(audioSec));
    const audioChars = (typeof s.getAudioChars === 'function') ? s.getAudioChars() : 0;
    setText('statsAudioChars', audioChars.toLocaleString());
    if (audioSec < 1 || audioChars === 0) {
      setText('statsAudioRate', '—');
    } else {
      setText('statsAudioRate', Math.round(audioChars / (audioSec / 3600)).toLocaleString());
    }
    setRunning('statsAudio', s.isRunning('audio'));
  }

  let statsRefreshTimer = null;

  // ---- Inactivity auto-pause ------------------------------------------------
  const INACTIVITY_MS = 60000;
  let lastInteractionMs = Date.now();
  let inactivityInterval = null;
  let autoStoppedByInactivity = false;

  function markInteraction() {
    lastInteractionMs = Date.now();
    if (autoStoppedByInactivity && timerStart === null) {
      autoStoppedByInactivity = false;
      startTimer();
      refreshTimerUI();
    }
  }
  window.markReadingInteraction = markInteraction;

  function startInactivityWatcher() {
    if (inactivityInterval) return;
    lastInteractionMs = Date.now();
    inactivityInterval = setInterval(() => {
      if (timerStart === null) return; // already paused (manually or auto)
      const playing = typeof window.isReadingPlaying === 'function' && window.isReadingPlaying();
      if (playing) {
        lastInteractionMs = Date.now(); // playback counts as active
        return;
      }
      if (Date.now() - lastInteractionMs >= INACTIVITY_MS) {
        autoStoppedByInactivity = true;
        stopTimer();
        refreshTimerUI();
        rlog('Timer auto-paused (1 min idle, no audio)');
      }
    }, 5000);
  }
  function stopInactivityWatcher() {
    if (!inactivityInterval) return;
    clearInterval(inactivityInterval);
    inactivityInterval = null;
  }

  // Snapshot for the shell's persistent timer label (shell polls this).
  // Returns the timer of the currently active mode.
  window.getReadingTimerState = function () {
    const s = window.stats;
    if (!s) return { running: false, totalSec: 0 };
    const mode = document.body.classList.contains('mode-audio') ? 'audio'
               : document.body.classList.contains('mode-read')  ? 'read'
               : 'card';
    return { running: s.isRunning(mode), totalSec: s.liveTotal(mode) };
  };

  // Snapshot of reading-mode progress for the unified bottom bar.
  window.getReadProgress = function () {
    const p = progressForIdx(lastMatchedIdx);
    return { current: p.current, total: p.total, pct: p.pct };
  };
  // Jump reading mode to a target character offset (resolves to nearest chunk).
  window.jumpReadingToChars = function (targetChars) {
    // targetChars is in JP-only units (the value the progress bar / jump
    // prompt show), so resolve it through the parallel jpOff/jpLen table.
    if (!chunks || !chunks.length || !totalBookJpChars) return;
    const target = Math.max(0, Math.min(totalBookJpChars, Math.floor(targetChars)));
    // Pick the chunk whose [off, off+len) contains the target.
    let best = 0;
    for (let i = 0; i < chunks.length; i++) {
      const off = parseInt(chunks[i].dataset.jpOff) || 0;
      const len = parseInt(chunks[i].dataset.jpLen) || 0;
      if (target < off + len) { best = i; break; }
      best = i;
    }
    setActive(best);
    const el = chunks[best];
    const content = document.getElementById('readingModeContent');
    if (el && content) content.scrollTop = el.offsetTop - 100;
    refreshProgressBar();
  };

  // Cross-mode sync: when switching INTO card mode, jump the card index
  // to wherever the user was — audio cue if playing, otherwise reader cursor.
  // Sets a global flag so displayCard skips its bg.play() (audio is already
  // running at the right position; restarting would cause a back-jump).
  window.syncCardToCurrentCue = function () {
    if (!Array.isArray(window.allNotes)) return;
    const isSrt = !!window.allNotes[0]?.isSrtCard;

    // Pick the most reliable source-of-truth for "where the user is".
    // Order: audio cue → reader cursor (lastMatchedIdx → chunk → cue).
    let cueIdx = abCurrentCueIdx;
    if (cueIdx < 0 && abChunkToCue && lastMatchedIdx >= 0) {
      const mapped = abChunkToCue[lastMatchedIdx];
      if (mapped >= 0) cueIdx = mapped;
    }

    let target = -1;
    if (isSrt) {
      // SRT-cards mode: cue index == card index.
      target = cueIdx;
    } else if (abCueToChunk && cueIdx >= 0) {
      // Deck-card mode: cue → chunk → card via tagged dataset.
      const chunkIdx = abCueToChunk[cueIdx];
      if (chunkIdx >= 0 && chunks[chunkIdx]) {
        const tagged = parseInt(chunks[chunkIdx].dataset.cardIdx);
        if (Number.isFinite(tagged)) target = tagged;
      }
    }
    if (target < 0 || target === window.currentCardIndex) return;
    window._skipNextCardAudioRestart = true;
    if (typeof window.updateCardIndex === 'function') window.updateCardIndex(target);
  };

  // Audio-mode progress (mm:ss / mm:ss + percent) for the unified bar.
  window.getAudioProgress = function () {
    const ms = abPositionRef.ms || 0;
    const dur = abPositionRef.durMs || 0;
    return { ms, dur, pct: dur ? (ms / dur) * 100 : 0 };
  };
  window.jumpAudioToMs = async function (targetMs) {
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (!bg) return;
    try { await bg.seek({ ms: Math.max(0, Math.round(targetMs)) }); } catch (e) {}
  };

  window.toggleReadingTimer = function () {
    // Toggle the CURRENT mode's stats timer — which is what the shell
    // pill + timer menu read from. Legacy `timerStart` is kept in sync
    // (used by some refresh helpers + the legacy stats fields).
    const s = window.stats;
    const mode = s ? s.currentMode() : 'card';
    if (s && s.isRunning(mode)) {
      s.stopMode(mode);
      if (timerStart !== null) stopTimer();
    } else {
      if (s) s.startMode(mode);
      if (timerStart === null && mode === 'read') startTimer();
    }
    refreshTimerUI();
    refreshStatsModal();
  };

  window.openReadingStats = async function () {
    const modal = document.getElementById('readingStatsModal');
    if (!modal) return;
    // Auto-pause playback when stats opens — user is reviewing stats,
    // not using the app actively.
    if (typeof window.isReadingPlaying === 'function' && window.isReadingPlaying() &&
        typeof window.toggleReadingPlayback === 'function') {
      window.toggleReadingPlayback();
      refreshPlayPauseButton();
    }
    if (timerStart !== null) await stopTimer();
    // Per-mode timers (stats.js): stop whichever is running.
    if (window.stats?.stopAll) window.stats.stopAll();
    modal.style.display = 'flex';
    refreshTimerUI();
    refreshStatsModal();
    if (statsRefreshTimer) clearInterval(statsRefreshTimer);
    statsRefreshTimer = setInterval(refreshStatsModal, 1000);
  };

  window.closeReadingStats = function () {
    const modal = document.getElementById('readingStatsModal');
    if (modal) modal.style.display = 'none';
    if (statsRefreshTimer) {
      clearInterval(statsRefreshTimer);
      statsRefreshTimer = null;
    }
  };

  window.resetReadingTimer = async function () {
    cumulativeSec = 0;
    cumulativeChars = 0;
    if (timerStart !== null) {
      timerStart = Date.now();
    }
    chunks.forEach(c => { delete c.dataset.counted; });
    await setPref(KEYS.TIME_SEC, 0);
    await setPref(KEYS.CHARS, 0);
    // Reset all per-mode stats counters.
    if (window.stats?.resetAll) window.stats.resetAll();
    refreshTimerUI();
    refreshStatsModal();
    const label = document.getElementById('readingTimerLabel');
    if (label && timerStart !== null) label.textContent = formatSec(0);
  };

  // Reset a single mode's stats (card / read / audio). Wired to the
  // per-section "Reset" buttons in the stats modal.
  window.resetReadingTimerFor = function (mode) {
    if (!mode) return;
    if (mode === 'read') { cumulativeChars = 0; cumulativeSec = 0; }
    if (window.stats?.resetMode) window.stats.resetMode(mode);
    refreshStatsModal();
  };

  window.readingAnkiCount = window.readingAnkiCount || 0;

  // Strip ruby annotations (furigana) so the normalized text matches the SRT/deck text.
  function textWithoutRuby(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('rt, rp').forEach(n => n.remove());
    return clone.textContent || '';
  }

  // Normalize for matching: strip whitespace and common JP/EN punctuation, lowercase.
  function normalizeText(s) {
    if (!s) return '';
    return s
      .replace(/[\s　]+/g, '')
      .replace(/[「」『』、。・…！？!?,.;:""'']/g, '')
      .toLowerCase();
  }

  // Split a block's innerHTML into per-sentence pieces. Honors:
  //   - sentence terminators 。！？
  //   - trailing closing quotes 」』")】 stick to the preceding sentence
  //   - never split inside HTML tags
  //   - never split inside <rt> or <rp> (furigana)
  //   - if the boundary lands inside open inline tags (em, span, b...),
  //     close them in the preceding sentence and reopen them in the next.
  function splitHtmlIntoSentences(html) {
    const out = [];
    let buf = '';
    let i = 0;
    let inTag = false;
    const tagStack = [];
    const closing = (n) => /^<\/([a-zA-Z][a-zA-Z0-9]*)/.exec(n);
    const opening = (n) => /^<([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/.exec(n);
    const isRtOpen = (s) => /^<rt[\s>]/.test(s) || /^<rp[\s>]/.test(s);
    const isRtClose = (s) => /^<\/(rt|rp)>/.test(s);
    const inRuby = () => tagStack.some(t => t === 'rt' || t === 'rp');

    while (i < html.length) {
      const ch = html[i];
      if (ch === '<' && !inTag) {
        const rest = html.slice(i);
        if (isRtOpen(rest)) {
          tagStack.push(/^<(rt|rp)/.exec(rest)[1]);
        } else if (isRtClose(rest)) {
          // pop matching rt/rp
          for (let k = tagStack.length - 1; k >= 0; k--) {
            if (tagStack[k] === 'rt' || tagStack[k] === 'rp') {
              tagStack.splice(k, 1);
              break;
            }
          }
        } else {
          const c = closing(rest);
          const o = c ? null : opening(rest);
          if (c) {
            const name = c[1].toLowerCase();
            for (let k = tagStack.length - 1; k >= 0; k--) {
              if (tagStack[k] === name) {
                tagStack.splice(k, 1);
                break;
              }
            }
          } else if (o) {
            const name = o[1].toLowerCase();
            const attrs = o[2] || '';
            const selfClosing = /\/\s*$/.test(attrs) ||
              /^(br|img|hr|input|meta|link|source|wbr)$/i.test(name);
            if (!selfClosing) tagStack.push(name);
          }
        }
        inTag = true;
      }
      buf += ch;
      if (ch === '>') {
        inTag = false;
      } else if (!inTag && !inRuby() && (ch === '。' || ch === '！' || ch === '？')) {
        // Absorb trailing closing punctuation into this chunk.
        let j = i + 1;
        while (j < html.length && /[」』""''\)）\]】]/.test(html[j])) {
          buf += html[j];
          j++;
        }
        // If we are inside open inline tags at this point, close them in the
        // current chunk and reopen at the start of the next chunk.
        const open = tagStack.slice();
        if (open.length) {
          const close = open.slice().reverse().map(t => `</${t}>`).join('');
          const reopen = open.map(t => `<${t}>`).join('');
          out.push(buf + close);
          buf = reopen;
        } else {
          out.push(buf);
          buf = '';
        }
        i = j;
        continue;
      }
      i++;
    }
    if (buf.trim()) out.push(buf);
    return out;
  }

  function chunkRenderedContent(root) {
    const blocks = root.querySelectorAll('p, li, blockquote, h1, h2, h3, h4, h5, h6');
    const result = [];
    blocks.forEach(block => {
      const totalNorm = normalizeText(textWithoutRuby(block));
      if (!totalNorm) return;
      const parts = splitHtmlIntoSentences(block.innerHTML);
      if (parts.length <= 1) {
        block.classList.add('reading-chunk');
        block.dataset.norm = totalNorm;
        result.push(block);
        return;
      }
      block.innerHTML = parts.map(p => `<span class="reading-chunk">${p}</span>`).join('');
      block.querySelectorAll(':scope > .reading-chunk').forEach(span => {
        const norm = normalizeText(textWithoutRuby(span));
        if (!norm) {
          // empty after stripping ruby/punct — unwrap
          while (span.firstChild) span.parentNode.insertBefore(span.firstChild, span);
          span.parentNode.removeChild(span);
          return;
        }
        span.dataset.norm = norm;
        result.push(span);
      });
    });
    return result;
  }

  function computeChunkCharOffsets() {
    let acc = 0, jpAcc = 0;
    chunks.forEach(c => {
      const base = textWithoutRuby(c);
      const len = base.length;                                    // RAW: flat-text coordinate
      const jpLen = window.jpCharCount ? window.jpCharCount(base) : len; // JP-only: display/stats
      c.dataset.charOffset = String(acc);
      c.dataset.charLen = String(len);
      c.dataset.jpOff = String(jpAcc);
      c.dataset.jpLen = String(jpLen);
      acc += len;
      jpAcc += jpLen;
    });
    totalBookChars = acc;       // raw coordinate space (cue alignment / highlight)
    totalBookJpChars = jpAcc;   // displayed total — matches ttu / desktop reader
    // Persist for the library's progress display. Namespaced by deck +
    // epub name so each (book,deck) pair tracks separately. Use plain
    // localStorage so the sync library render can read it without a
    // Capacitor Preferences round-trip. Store the JP-only total so the
    // library % uses the same unit as the position written below.
    try {
      const deck = currentDeckName();
      if (deck && currentEpubName) {
        localStorage.setItem('READING_TOTAL_CHARS_' + deck + '_' + currentEpubName, String(jpAcc));
      }
    } catch (e) {}
  }

  function progressForIdx(idx) {
    // Reported in JP-only chars (ttu unit) so the bottom bar / library match
    // the desktop reader. Uses the parallel jpOff/jpLen table, NOT the raw
    // charOffset coordinate space.
    if (idx < 0 || !chunks[idx] || !totalBookJpChars) {
      return { current: 0, total: totalBookJpChars, pct: 0 };
    }
    const c = chunks[idx];
    const off = parseInt(c.dataset.jpOff) || 0;
    const len = parseInt(c.dataset.jpLen) || 0;
    const current = off + len;
    const pct = totalBookJpChars ? (current / totalBookJpChars) * 100 : 0;
    return { current, total: totalBookJpChars, pct };
  }

  function formatProgressLabel(p) {
    if (!p.total) return '—';
    switch (progressMode) {
      case 1:
        return `${p.current.toLocaleString()} / ${p.total.toLocaleString()}`;
      case 2:
        return `${(p.total - p.current).toLocaleString()} left`;
      default:
        return `${p.pct.toFixed(1)}%`;
    }
  }

  function refreshProgressBar() {
    const p = progressForIdx(lastMatchedIdx);
    const fill = document.getElementById('readingProgressFill');
    const label = document.getElementById('readingProgressLabel');
    if (fill) fill.style.width = `${Math.max(0, Math.min(100, p.pct))}%`;
    if (label) label.textContent = formatProgressLabel(p);
  }

  function showProgressBar() {
    const bar = document.getElementById('readingProgressBar');
    if (!bar) return;
    bar.style.transform = 'translateY(0)';
    progressBarShown = true;
    refreshProgressBar();
  }
  function hideProgressBar() {
    const bar = document.getElementById('readingProgressBar');
    if (!bar) return;
    bar.style.transform = 'translateY(110%)';
    progressBarShown = false;
  }
  function toggleProgressBar() {
    if (progressBarShown) hideProgressBar();
    else showProgressBar();
  }

  window.cycleReadingProgressMode = function () {
    progressMode = (progressMode + 1) % 3;
    setPref(KEYS.PROGRESS_MODE, String(progressMode));
    refreshProgressBar();
  };

  function clearActiveHighlight() {
    // Belt-and-suspenders: the "green smear" the user has been seeing
    // through every iteration is multiple chunks carrying the .active
    // class simultaneously — `lastMatchedIdx` gets out of sync with the
    // DOM during fast iOS scroll, and the old single-index cleanup leaves
    // orphaned green chunks behind. Sweep the whole tree so the invariant
    // ("at most one .active chunk") is guaranteed regardless of any race.
    const content = document.getElementById('readingModeContent');
    if (content) {
      content.querySelectorAll('.reading-chunk.active').forEach(el =>
        el.classList.remove('active'));
    }
  }

  // Cue-precise highlight. Uses CSS Custom Highlight API to mark just the
  // characters of the currently-playing SRT cue inside a chunk (without
  // mutating the DOM). Falls back silently if the API is unavailable.
  function clearCueHighlight() {
    try { if (window.CSS?.highlights) CSS.highlights.delete('cue-active'); } catch (e) {}
    document.body.classList.remove('has-cue-highlight');
  }
  function setCueHighlight(chunkIdx, cueText) {
    setCueHighlightFor('cue-active', chunkIdx, cueText);
    if (document.body && CSS.highlights?.has?.('cue-active')) {
      document.body.classList.add('has-cue-highlight');
    } else {
      document.body.classList.remove('has-cue-highlight');
    }
  }
  function setCueHighlightFor(name, chunkIdx, cueText) {
    if (!window.CSS?.highlights || typeof Highlight === 'undefined' || !cueText) {
      try { CSS.highlights?.delete?.(name); } catch (e) {}
      return;
    }
    const chunk = chunks[chunkIdx];
    if (!chunk) { try { CSS.highlights.delete(name); } catch (e) {} return; }
    // Collect visible text nodes (skip ruby readings inside <rt>/<rp>).
    const flat = [];
    const walker = document.createTreeWalker(chunk, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let cur = node.parentNode;
        while (cur && cur !== chunk) {
          if (cur.tagName === 'RT' || cur.tagName === 'RP') return NodeFilter.FILTER_REJECT;
          cur = cur.parentNode;
        }
        return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    let n;
    while ((n = walker.nextNode())) flat.push({ node: n, text: n.nodeValue });
    const flatStr = flat.map(f => f.text).join('');
    const normFlat = normalizeText(flatStr);
    const normCue  = normalizeText(cueText);
    if (!normCue) { clearCueHighlight(); return; }
    const startInNorm = normFlat.indexOf(normCue);
    if (startInNorm < 0) { clearCueHighlight(); return; }
    const endInNorm = startInNorm + normCue.length;
    // Map raw → normalized index by walking once.
    const STRIP = /[\s　「」『』、。・…！？!?,.;:""'']/;
    let rawStart = -1, rawEnd = flatStr.length, rawNormPos = 0;
    for (let i = 0; i < flatStr.length; i++) {
      if (rawStart < 0 && rawNormPos >= startInNorm) rawStart = i;
      if (rawNormPos >= endInNorm) { rawEnd = i; break; }
      if (!STRIP.test(flatStr[i])) rawNormPos++;
    }
    if (rawStart < 0) { clearCueHighlight(); return; }
    // Map raw position back to (node, offset).
    let acc = 0, sNode = null, sOff = 0, eNode = null, eOff = 0;
    for (const f of flat) {
      const next = acc + f.text.length;
      if (sNode === null && rawStart < next) { sNode = f.node; sOff = rawStart - acc; }
      if (eNode === null && rawEnd <= next) { eNode = f.node; eOff = rawEnd - acc; break; }
      acc = next;
    }
    if (sNode === null) { try { CSS.highlights.delete(name); } catch (e) {} return; }
    if (eNode === null) {
      eNode = flat[flat.length - 1].node;
      eOff = flat[flat.length - 1].text.length;
    }
    try {
      const range = new Range();
      range.setStart(sNode, sOff);
      range.setEnd(eNode, Math.min(eOff, eNode.nodeValue.length));
      CSS.highlights.set(name, new Highlight(range));
    } catch (e) {
      try { CSS.highlights.delete(name); } catch (er) {}
    }
  }

  // Publishes the audiobook range that corresponds to a chunk (via the
  // chunkToCue map). The dictionary uses these to open the waveform editor
  // for "Add word with sentence audio" flows.
  function publishChunkCueRange(idx) {
    try {
      window._currentReadingAudiobookPath = null;
      window._currentReadingCueStartMs = null;
      window._currentReadingCueEndMs   = null;
      if (!abChunkToCue || idx < 0 || !abAudioPath) return;
      const cueIdx = abChunkToCue[idx];
      if (cueIdx < 0 || !abCues?.[cueIdx]) return;
      window._currentReadingAudiobookPath = abAudioPath;
      window._currentReadingCueStartMs    = abCues[cueIdx].startMs;
      window._currentReadingCueEndMs      = abCues[cueIdx].endMs;
    } catch (e) {}
  }

  function setActive(idx, opts) {
    clearActiveHighlight();
    lastMatchedIdx = idx;
    // Mirror to a global so shell.js can capture this snapshot when
    // the user enters audio mode (used by the audio→read reentry
    // modal's "prior reading position" display). Module-local var
    // would otherwise be invisible.
    try { window._readingLastMatchedIdx = idx; } catch (_) {}
    publishChunkCueRange(idx);
    const el = chunks[idx];
    if (!el) return;
    el.classList.add('active');
    if (opts && opts.instantScroll) el.dataset._instantScroll = '1';
    if (opts && opts.center) el.dataset._scrollCenter = '1';
    if (!el.dataset.counted) {
      // Credit the "characters read" stat in JP-only chars so it's the same
      // unit as the card / audio counters (cross-mode consistency).
      const len = window.jpCharCount ? window.jpCharCount(textWithoutRuby(el))
                                      : textWithoutRuby(el).length;
      if (len > 0) {
        // Only credit cumulativeChars when the user is actually in
        // reader mode. setActive is called by the audio cue listener
        // (abUpdateCueDisplay) on every cue advance regardless of
        // which mode is active — so without this gate, pure audio-
        // mode listening with no reader visible would inflate the
        // "characters read" stat. Reading-while-listening (mode-read
        // + audio playing) IS counted, which is the intended
        // definition of reading.
        //
        // We mark dataset.counted regardless so the chunk isn't
        // re-evaluated later. That handles the "user listened in
        // audio mode, switched to reader, the catchup-scroll lands
        // on these same chunks" giant-swoop case — those chunks
        // are already marked from their original audio-mode pass,
        // so the swoop doesn't retroactively credit them.
        if (document.body.classList.contains('mode-read')) {
          cumulativeChars += len;
          setPref(KEYS.CHARS, Math.floor(cumulativeChars));
        }
        el.dataset.counted = '1';
      }
    }
    // Mirror the CURRENT POSITION (chunk's char offset + length) to
    // localStorage so the library card can show actual reading progress —
    // not the cumulative chars-ever-read counter, which would only go up
    // and never reflect where the user is. The position is the END of the
    // active chunk so a freshly-opened book reads 0% and a fully-read
    // book reads 100%.
    try {
      const deck = currentDeckName();
      if (deck && currentEpubName) {
        // JP-only position so the library % matches the JP total stored above.
        const off = parseInt(el.dataset.jpOff) || 0;
        const len = parseInt(el.dataset.jpLen) || 0;
        localStorage.setItem('READING_POS_' + deck + '_' + currentEpubName,
                             String(off + len));
      }
    } catch (e) {}
    const view = document.getElementById('readingModeView');
    if (view && view.style.display !== 'none') {
      paginatedScrollToChunk(el);
    }
    // Always update the progress bar DOM — the bar's fill width has to be
    // correct whether it's currently visible or not, because the user can
    // toggle it on without us re-running setActive. The DOM write is cheap.
    refreshProgressBar();
  }

  // Pseudo-pagination: if the chunk is fully inside the scrollable viewport,
  // do nothing (the highlight just moves within the visible page). If it's
  // not fully visible (advanced past the page edge), smooth-scroll so the
  // chunk lands at the reading-start edge of the viewport.
  //   horizontal mode → top edge
  //   vertical-rl     → right edge (start of inline-flow direction)
  function paginatedScrollToChunk(el) {
    const container = document.getElementById('readingModeContent');
    if (!container) return;
    const isVertical = container.classList.contains('vertical');
    // In vertical-rl, iOS WebKit's scrollIntoView blanks the viewport
    // catastrophically — even with explicit instantScroll/scrollCenter
    // hints we couldn't get a working centered position. SKIP scrolling
    // entirely in vertical-rl; the .active class + text-color recolor
    // make the chunk findable, and the user manually scrolls.
    // (We still do the early-return for non-explicit updates in
    // horizontal mode for parity with the user's Android workflow.)
    if (isVertical) {
      // Clear the dataset flags so they don't pile up.
      delete el.dataset._instantScroll;
      delete el.dataset._scrollCenter;
      return;
    }
    const explicitScroll = !!(el.dataset._instantScroll || el.dataset._scrollCenter);
    const cRect = container.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const tol = 2; // px tolerance for "fully visible"

    const fullyVisible =
      eRect.top    >= cRect.top    - tol &&
      eRect.bottom <= cRect.bottom + tol &&
      eRect.left   >= cRect.left   - tol &&
      eRect.right  <= cRect.right  + tol;
    if (fullyVisible && !el.dataset._scrollCenter) return;

    const behavior = el.dataset._instantScroll ? 'instant' : 'smooth';
    const block    = el.dataset._scrollCenter  ? 'center'  : 'start';
    delete el.dataset._instantScroll;
    delete el.dataset._scrollCenter;
    try {
      el.scrollIntoView({ behavior, block, inline: 'start' });
    } catch (e) {
      el.scrollIntoView(true);
    }
  }

  // Tag a chunk with the card index it matches. Only called from
  // syncReadingToCard (audio-driven), where we know the mapping is correct.
  function tagChunkWithCard(idx, cardIdx) {
    const el = chunks[idx];
    if (!el || !Number.isFinite(cardIdx) || cardIdx < 0) return;
    el.dataset.cardIdx = String(cardIdx);
  }

  // Find the first chunk index whose normalized text contains the normalized target.
  function findContainsFrom(targetNorm, startIdx) {
    if (!targetNorm) return -1;
    for (let i = Math.max(0, startIdx); i < chunks.length; i++) {
      if (chunks[i].dataset.norm.includes(targetNorm)) return i;
    }
    return -1;
  }

  // Fuzzy initial alignment: find the first chunk where a substantial prefix of
  // the card text appears. Handles minor edition differences at the start.
  function findInitialAlignment(targetNorm) {
    if (!targetNorm) return -1;
    const minLen = Math.max(6, Math.floor(targetNorm.length * 0.6));
    for (let i = 0; i < chunks.length; i++) {
      const chunkNorm = chunks[i].dataset.norm;
      if (chunkNorm.includes(targetNorm)) return i;
      // Try shrinking prefix from the end down to minLen
      for (let len = targetNorm.length - 1; len >= minLen; len--) {
        if (chunkNorm.includes(targetNorm.slice(0, len))) return i;
      }
    }
    return -1;
  }

  async function syncReadingToCard(expression) {
    if (!chunks.length || !expression) return;
    const target = normalizeText(textWithoutRubyFromHtml(expression));
    if (!target) return;

    let idx = -1;
    if (firstSyncForBook || lastMatchedIdx < 0) {
      idx = findInitialAlignment(target);
      firstSyncForBook = false;
    } else {
      // Steady state: search forward from cursor, then wrap to start.
      idx = findContainsFrom(target, lastMatchedIdx);
      if (idx < 0) idx = findContainsFrom(target, 0);
    }

    if (idx < 0) {
      rlog(`No EPUB chunk matches: "${target.slice(0, 40)}"`);
      return;
    }

    setActive(idx);
    if (typeof window.currentCardIndex === 'number') {
      tagChunkWithCard(idx, window.currentCardIndex);
    }
    const deck = currentDeckName();
    if (deck && currentEpubName) {
      await saveCursor(deck, currentEpubName, idx);
      await savePairing(deck, currentEpubName);
    }
  }

  // card.expression may itself contain HTML (e.g. <ruby>) when sourced from
  // richer fields. Strip tags before normalizing.
  function textWithoutRubyFromHtml(html) {
    if (typeof html !== 'string' || html.indexOf('<') < 0) return html || '';
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return textWithoutRuby(tmp);
  }

  async function pickReadingEpub() {
    if (!isCap() || !window.Capacitor?.Plugins?.FileAccess) {
      alert('Reading mode requires the native FileAccess plugin.');
      return;
    }
    try {
      const { uri, name } = await window.Capacitor.Plugins.FileAccess.pickFileWithUri();
      rlog(`EPUB picked: ${name}`);
      await setPref(KEYS.EPUB_URI, uri);
      await setPref(KEYS.EPUB_NAME, name);
      await loadEpubFromUri(uri, name);
    } catch (e) {
      const msg = String(e?.message || e);
      if (!msg.toLowerCase().includes('cancel')) rlog(`Pick failed: ${msg}`);
    }
  }

  // -------- Audiobook + SRT picking (paired with the loaded deck) --------

  // After picking either file, if the audio view is open AND both files are
  // now paired, kick off playback automatically.
  async function maybeAutoStartAudio(deck) {
    const view = document.getElementById('audiobookModeView');
    if (!view || view.style.display === 'none') return;
    const audio = await getAudiobookPairing(deck);
    const srt = await getSrtPairing(deck);
    if (audio && srt && typeof window.openAudiobookMode === 'function') {
      window.openAudiobookMode({ seekToCurrentPosition: false });
    } else {
      // Still missing one — re-render the inline picker with updated checkmarks.
      renderInlineAudiobookPicker(!audio, !srt);
    }
  }

  async function pickAudiobookFile() {
    const fa = window.Capacitor?.Plugins?.FileAccess;
    if (!fa) { alert('FileAccess plugin not loaded.'); return; }
    const deck = currentDeckName();
    if (!deck) { alert('Load a deck first so the audiobook can be paired with it.'); return; }
    try {
      const picked = await fa.pickFileWithUri({ kind: 'audio' });
      if (!picked || !picked.uri) return;
      const mat = await fa.materializeToCache({ uri: picked.uri });
      if (!mat || !mat.path) { alert('Audiobook materialize failed.'); return; }
      await saveAudiobookPairing(deck, mat.path, picked.name || 'audiobook');
      rlog(`Audiobook paired with "${deck}": ${picked.name}`);
      await maybeAutoStartAudio(deck);
    } catch (e) {
      const msg = String(e?.message || e);
      if (!msg.toLowerCase().includes('cancel')) alert('Audiobook pick failed: ' + msg);
    }
  }

  async function pickSrtFile() {
    const fa = window.Capacitor?.Plugins?.FileAccess;
    if (!fa) { alert('FileAccess plugin not loaded.'); return; }
    const deck = currentDeckName();
    if (!deck) { alert('Load a deck first so the SRT can be paired with it.'); return; }
    try {
      // 'any' since SRT mime is typically application/x-subrip and not in
      // most picker filters by default.
      const picked = await fa.pickFileWithUri({ kind: 'any' });
      if (!picked || !picked.uri) return;
      const mat = await fa.materializeToCache({ uri: picked.uri });
      if (!mat || !mat.path) { alert('SRT materialize failed.'); return; }
      await saveSrtPairing(deck, mat.path, picked.name || 'subtitles');
      rlog(`SRT paired with "${deck}": ${picked.name}`);
      await maybeAutoStartAudio(deck);
    } catch (e) {
      const msg = String(e?.message || e);
      if (!msg.toLowerCase().includes('cancel')) alert('SRT pick failed: ' + msg);
    }
  }

  window.pickAudiobookFile = pickAudiobookFile;
  window.pickSrtFile = pickSrtFile;

  // -------- Audiobook mode --------

  let abCues = [];
  let abCueToChunk = null;
  let abChunkToCue = null;
  let abCurrentCueIdx = -1;
  // Let the paged reader's Set-Playhead jump force the NEXT position event to
  // re-render and re-fire __onPagedCueUpdate, even when the audio lands on the
  // SAME cue index that was already current. Without this, abUpdateCueDisplay's
  // `idx === abCurrentCueIdx` early return swallows the update upstream of the
  // paged green-paint hook — the "Set Playhead → line not highlighted green" bug.
  window._resetAbCueGate = function () { abCurrentCueIdx = -2; };
  let abAudioPath = null;
  let abAudioName = '';
  let abLastSrtName = ''; // name of the SRT used to build the current maps — fingerprint input for cue-alignment cache
  let abListenersAttached = false;
  let abScrubbing = false;
  let abPositionRef = { ms: 0, durMs: 0 };

  // Expose abCues + abAudioPath to the paged reader as a fallback —
  // its own loadAudiobookCues can fail silently (title-store missing
  // SRT attachment, deck-pairing miss), leaving pagedCues=0 and
  // breaking Anki audio. The legacy reader, which loads SRT via
  // audio-mode pairing, is the source of truth in those cases.
  Object.defineProperty(window, '__abCues', { get() { return abCues; }, configurable: true });
  Object.defineProperty(window, '__abAudioPath', { get() { return abAudioPath; }, configurable: true });

  // Clear the legacy audiobook context so a title WITHOUT audio (EPUB-only)
  // can't leak the PREVIOUS audio title's cues into the paged reader. The paged
  // reader's cue lookups fall back to window.__abCues when its own pagedCues is
  // empty (`pagedCues?.length ? pagedCues : window.__abCues`), so without this a
  // stale __abCues made findNearestChunkCue bind a phantom "Set playhead" that
  // played the old title's audio, and made ensureGreenOnEnter scroll to a stale
  // cue — clobbering the restored EPUB scroll position. Called by the paged
  // reader's loadAudiobookCues the moment it confirms the title has no audio/SRT.
  window._clearLegacyAudioContext = function () {
    abCues = [];
    abCueToChunk = null;
    abChunkToCue = null;
    abCurrentCueIdx = -1;
    abAudioPath = null;
    abAudioName = '';
    abLastSrtName = '';
    abContextLoadedForDeck = null;
  };

  function abFmtMs(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '–:––';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const ss = String(s % 60).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  }

  // Render an inline picker UI inside the audiobook view's cue text area —
  // used when the user opens AUDIO mode but no pairing is set for the deck.
  function renderInlineAudiobookPicker(missingAudio, missingSrt) {
    const cueEl = document.getElementById('audiobookCueText');
    if (!cueEl) return;
    const deck = currentDeckName() || 'this title';
    const missingList = [missingAudio ? 'audiobook' : null, missingSrt ? 'subtitles' : null]
      .filter(Boolean).join(' and ');
    // Pigments-styled card matching the rest of the app: dark panel, thin
    // border, uppercase mode-color heading, outlined buttons that go
    // accent-color when an action is needed and muted-grey when satisfied.
    cueEl.innerHTML = `
      <div style="max-width:420px;margin:32px auto;text-align:left;
                  font-family:var(--font-sans);font-size:.9rem;line-height:1.55;
                  background:var(--panel,#161616);
                  border:1px solid var(--border,#2a2a2a);
                  border-radius:12px;
                  padding:22px 22px 18px 22px;">
        <div style="font-size:.7rem;letter-spacing:.18em;text-transform:uppercase;
                    color:var(--accent-audio,#b794f6);font-weight:700;
                    margin-bottom:10px;">Audiobook not paired</div>
        <div style="color:var(--text,#e8e8e8);margin-bottom:18px;">
          Missing ${missingList} for <span style="color:var(--accent-audio,#b794f6);font-weight:600;">${deck}</span>. Pick the file${missingAudio && missingSrt ? 's' : ''} below, then tap AUDIO again.
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${pickerButtonHtml('window.pickAudiobookFile', 'Audiobook',  '.mp3 · .m4b · .m4a', missingAudio)}
          ${pickerButtonHtml('window.pickSrtFile',       'Subtitles',  '.srt',                missingSrt)}
        </div>
      </div>
    `;
  }

  // Single picker button — outlined when the file is missing (accent
  // border + accent text), filled+muted when already paired.
  function pickerButtonHtml(handlerExpr, label, hint, missing) {
    const stateStyles = missing
      ? 'background:transparent;color:var(--accent-audio,#b794f6);' +
        'border:1px solid var(--accent-audio,#b794f6);'
      : 'background:var(--panel-elev,#1f1f1f);color:var(--text-muted,#888);' +
        'border:1px solid var(--border,#2a2a2a);';
    const check = missing ? '' :
      '<span style="color:var(--accent-read,#4caf50);font-weight:700;margin-left:6px;">✓</span>';
    return `
      <button onclick="${handlerExpr} && ${handlerExpr}()"
              style="${stateStyles}padding:12px 14px;border-radius:8px;
                     font-family:var(--font-sans);font-size:.85rem;font-weight:600;
                     letter-spacing:.04em;cursor:pointer;
                     display:flex;align-items:center;justify-content:space-between;
                     transition:background .15s ease;">
        <span>${label}${check}</span>
        <span style="font-size:.7rem;letter-spacing:.08em;text-transform:uppercase;
                     color:${missing ? 'var(--text-muted,#888)' : 'var(--text-faint,#555)'};
                     font-weight:500;">${missing ? hint : 'Re-pick'}</span>
      </button>
    `;
  }

  // Public setter for SRT-card titles (deck-less, no EPUB). app.js's
  // loadTitleAsSrtCards already parsed the SRT; we just plumb it into
  // the closure state so abUpdateCueDisplay works and the position
  // listener gets attached.
  window.setAudiobookContextForSrtCards = function ({ audioPath, audioName, cues }) {
    if (!Array.isArray(cues) || !cues.length || !audioPath) return;
    abAudioPath = audioPath;
    abAudioName = audioName || 'Audiobook';
    abCues = cues;
    // Expose path globally so reader-mode PLAY can route through bg even
    // when no chunk-cue is bound yet (publishChunkCueRange only fires
    // after a setActive call).
    window._audiobookSrcPath = audioPath;
    abAttachListenersOnce();
  };

  // Build cue↔chunk maps via the preprocessing module (cue-alignment.js)
  // when available, with the legacy srtParser.buildCueChunkMaps as fallback.
  // Returns the matched count for logging.
  async function _buildAbCueMaps(srtName) {
    if (!chunks.length || !abCues.length) {
      abCueToChunk = null;
      abChunkToCue = null;
      return 0;
    }
    // Try the new preprocessing first.
    if (window.cueAlignment?.loadOrBuild) {
      let progress = null;
      try {
        const titleId = window._activeTitleId || null;
        const epubName = currentEpubName || '';
        // Peek for cache hit so the overlay only appears on fresh builds.
        const peekFp = window.cueAlignment.computeFingerprint({
          epubName, srtName: srtName || '',
          cueCount: abCues.length,
          totalChars: window.cueAlignment.extractFlatText(chunks).length
        });
        const peekHit = titleId
          ? await window.cueAlignment.loadAlignment(titleId, peekFp)
          : null;
        if (!peekHit && window.cueAlignment.showProgress) {
          progress = window.cueAlignment.showProgress({
            title: 'Preparing book',
            sub:   'Aligning subtitles to text…'
          });
        }
        const t0 = performance.now();
        const { alignment, cached } = await window.cueAlignment.loadOrBuild({
          titleId, epubName, srtName: srtName || '', chunks, cues: abCues,
          onProgress: progress ? (p) => progress.update(p) : null
        });
        const dt = Math.round(performance.now() - t0);
        const ratio = alignment.matchedRatio;
        rlog(`Legacy alignment: ${alignment.matched}/${alignment.cueCount}` +
             ` (ratio=${ratio.toFixed(2)}, ${cached ? 'cache' : 'fresh'}, ${dt}ms)`);
        if (ratio >= window.cueAlignment.MIN_MATCHED_RATIO) {
          const maps = window.cueAlignment.buildCueToChunk(alignment, chunks);
          abCueToChunk = maps.cueToChunk;
          abChunkToCue = maps.chunkToCue;
          return alignment.matched;
        }
        rlog(`Legacy alignment ratio too low; falling back to legacy matcher`);
        try { await window.cueAlignment.clearAlignment(titleId); } catch (e) {}
      } catch (e) {
        rlog('Legacy alignment error; falling back:', e.message);
      } finally {
        if (progress) { try { progress.close(); } catch (e) {} }
      }
    }
    // Legacy fallback path.
    const maps = window.srtParser.buildCueChunkMaps(abCues, chunks, (s) => normalizeText(s));
    abCueToChunk = maps.cueToChunk;
    abChunkToCue = maps.chunkToCue;
    let matched = 0;
    for (let i = 0; i < abCueToChunk.length; i++) if (abCueToChunk[i] >= 0) matched++;
    return matched;
  }

  // Data-only cue context loader — pulls the SRT into abCues and builds
  // cue↔chunk maps without showing any UI. Used by loadEpubFromUri so the
  // reading-mode highlight can follow audio even when the user never opens
  // the audio mode view.
  async function ensureCueContextLoaded() {
    // Cues already loaded — but maps may not be built yet if cues were
    // loaded BEFORE chunks (e.g. user opened audio mode before reader).
    // Rebuild if needed; otherwise we're done.
    if (abCues.length) {
      const needsMaps = chunks.length &&
        (!abCueToChunk || abCueToChunk.length !== abCues.length);
      if (needsMaps) {
        const matched = await _buildAbCueMaps(abLastSrtName);
        rlog(`Rebuilt cue maps post-chunks: ${matched}/${abCues.length} cues mapped`);
      }
      return true;
    }
    const deck = currentDeckName();
    if (!deck) return false;
    const audio = await getAudiobookPairing(deck);
    const srt   = await getSrtPairing(deck);
    if (!audio || !srt) return false;
    abAudioPath = audio.path;
    abAudioName = audio.name;
    window._audiobookSrcPath = audio.path;
    try {
      const url = window.Capacitor?.convertFileSrc
        ? window.Capacitor.convertFileSrc(srt.path) : 'file://' + srt.path;
      const res = await fetch(url);
      if (!res.ok) return false;
      const text = await res.text();
      abCues = window.srtParser.parseSrt(text);
      abLastSrtName = srt.name || '';
    } catch (e) { return false; }
    await _buildAbCueMaps(abLastSrtName);
    // Mark pre-warm successful so a later openAudiobookMode skips re-loading.
    abContextLoadedForDeck = deck;
    return true;
  }

  // Pre-warm: if we've already loaded the cue context for the current deck,
  // openAudiobookMode can skip the "Loading audiobook…" placeholder. Tracks
  // by deck name; null if a fresh load is needed.
  let abContextLoadedForDeck = null;

  function invalidateAbContext() {
    abContextLoadedForDeck = null;
  }
  window.invalidateAbContext = invalidateAbContext;

  async function abLoadContextForCurrentDeck() {
    const deck = currentDeckName();
    if (!deck) {
      // Show inline message instead of an alert.
      const cueEl = document.getElementById('audiobookCueText');
      if (cueEl) cueEl.textContent = 'Load a deck first, then return to the AUDIO tab.';
      return false;
    }
    const audio = await getAudiobookPairing(deck);
    const srt = await getSrtPairing(deck);
    if (!audio || !srt) {
      renderInlineAudiobookPicker(!audio, !srt);
      // Also make sure the audiobook view is visible so the user sees the picker.
      const view = document.getElementById('audiobookModeView');
      if (view) view.style.display = 'flex';
      return false;
    }
    // Fast path: pre-warmed for this deck, paths unchanged. Skip the
    // ~500 ms SRT fetch+parse+map. Caller hides "Loading audiobook…".
    if (abContextLoadedForDeck === deck && abCues?.length && abAudioPath === audio.path) {
      return true;
    }
    abAudioPath = audio.path;
    abAudioName = audio.name;
    window._audiobookSrcPath = audio.path;
    // Read + parse SRT from cache file. Use convertFileSrc so the WebView's
    // local server serves the file via its allowed origin (raw file:// won't
    // work for arbitrary paths inside the WebView fetch sandbox).
    try {
      const url = (window.Capacitor && typeof window.Capacitor.convertFileSrc === 'function')
        ? window.Capacitor.convertFileSrc(srt.path)
        : 'file://' + srt.path;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch status ${res.status}`);
      const text = await res.text();
      abCues = window.srtParser.parseSrt(text);
      abLastSrtName = srt.name || '';
      rlog(`SRT: ${abCues.length} cues from ${srt.name}`);
    } catch (e) {
      alert('Failed to read SRT: ' + (e?.message || e));
      return false;
    }
    // Build cue↔chunk maps (uses already-loaded EPUB chunks).
    if (chunks.length && abCues.length) {
      const matched = await _buildAbCueMaps(abLastSrtName);
      rlog(`Cue↔chunk: ${matched}/${abCues.length} cues mapped`);
    } else {
      abCueToChunk = null;
      abChunkToCue = null;
      rlog('No EPUB chunks yet — cue↔chunk mapping skipped');
    }
    abContextLoadedForDeck = deck;
    return true;
  }

  // Render an audiobook cue with per-char dict-frag spans so each character
  // is individually tappable for dictionary lookup. Only re-tokenizes when
  // the cue actually changes (gated by the idx === abCurrentCueIdx check
  // in the caller), so the cost is paid once every 2–10 s, not every poll.
  function renderAudiobookCueTokens(host, text, cueIdx) {
    host.innerHTML = '';
    host.dataset.cueIdx = String(cueIdx);
    for (const ch of text) {
      if (ch === '\n') { host.appendChild(document.createElement('br')); continue; }
      const sp = document.createElement('span');
      sp.className = 'dict-frag';
      sp.textContent = ch;
      host.appendChild(sp);
    }
  }
  // Swipe-down on the audiobook view toggles bg play/pause, matching
  // the reader's behavior. Attached once. Skip swipes that originate
  // inside the cue text (dict tap area) or on the transport / scrub
  // controls so taps on those still fire normally.
  function installAudiobookSwipeHandler() {
    const view = document.getElementById('audiobookModeView');
    if (!view || view.dataset.swipeWired === '1') return;
    view.dataset.swipeWired = '1';
    let startX = 0, startY = 0, startT = 0, started = false, fired = false;
    // Advance/rewind ONE subtitle. Steps from the SAME (array,index) pair that
    // drives the on-screen subtitle — abCues + abCurrentCueIdx, kept live every
    // position tick by abUpdateCueDisplay — then SEEKS the playhead and repaints
    // immediately. Earlier this stepped from window._lastAudioCueIdx indexed
    // into pagedCues, a different pair the audio view doesn't maintain, so a
    // swipe landed on the wrong cue ("moves an unclear second or two"). In a gap
    // between cues, derive prev/next from the live position. swipe-RIGHT (dx>0)
    // → previous, swipe-LEFT (dx<0) → next.
    const navByDx = (dx) => {
      const cues = abCues;
      const bg = window.Capacitor?.Plugins?.BackgroundAudio;
      if (!cues.length || !bg) return;                    // can't resolve → stay put
      const posMs = (abPositionRef && Number.isFinite(abPositionRef.ms)) ? abPositionRef.ms : 0;
      let cur = (Number.isFinite(abCurrentCueIdx) && abCurrentCueIdx >= 0)
        ? abCurrentCueIdx                                  // the cue the view is showing
        : (window.srtParser?.findCueAtTime ? window.srtParser.findCueAtTime(cues, posMs) : -1);
      let target;
      if (Number.isFinite(cur) && cur >= 0) {
        target = cur + (dx > 0 ? -1 : 1);                 // RIGHT = prev, LEFT = next
      } else if (dx < 0) {                                // in a gap, going forward → next cue after pos
        target = cues.findIndex(c => c.startMs > posMs);
      } else {                                            // in a gap, going back → last cue before pos
        target = -1;
        for (let i = cues.length - 1; i >= 0; i--) { if (cues[i].startMs < posMs) { target = i; break; } }
      }
      if (!Number.isFinite(target) || target < 0 || target > cues.length - 1) return; // edge → no wrap, no clamp-to-0
      const cue = cues[target];
      if (!cue || !Number.isFinite(cue.startMs)) return;
      window._lastAudioCueIdx = target;
      const ms = Math.max(0, Math.round(cue.startMs) - (window.AUDIO_START_OFFSET_MS || 0));
      try { bg.seek({ ms, fadeMs: 40 }); } catch (_) {}   // brief fade so the jump doesn't click
      // Repaint the cue display + advance abCurrentCueIdx now, so the jump is
      // visible immediately (incl. when paused) and a quick second swipe steps
      // from the new line. The next live position event no-ops on the gate.
      try { abUpdateCueDisplay(Math.round(cue.startMs)); } catch (_) {}
    };
    view.addEventListener('touchstart', (e) => {
      if (!e.touches?.[0]) return;
      fired = false;
      // Bail only on interactive controls that own their own gestures
      // (transport buttons + scrub bar). We DON'T bail on #audiobookCueText
      // anymore: a horizontal swipe that starts on the subtitle text must
      // still navigate cues. The dict-frag lookup fires on `click`, which
      // iOS only synthesizes for a tap (minimal movement) — a swipe/drag
      // never produces a click — so tracking swipes over the text can't
      // trigger a stray lookup. (Bug: swipes only worked over the cover art
      // because the text was excluded here.)
      const t = e.target;
      if (t?.closest?.('.transport-row, button, input, [data-role="scrub"]')) {
        started = false;
        return;
      }
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      startT = Date.now();
      started = true;
    }, { passive: true });
    // Responsiveness: fire the cue jump the INSTANT a horizontal swipe is
    // recognized mid-gesture, rather than waiting for the finger to lift. The
    // touchend delay (plus iOS's gesture disambiguation) was the perceived
    // lag/choppiness. `fired` latches so one swipe = one cue and touchend
    // doesn't double-fire.
    view.addEventListener('touchmove', (e) => {
      if (!started || fired || !e.touches?.[0]) return;
      const t = e.touches[0];
      const dx = t.clientX - startX, dy = t.clientY - startY;
      const ax = Math.abs(dx), ay = Math.abs(dy);
      if (ax > 30 && ax > ay * 1.5) { fired = true; navByDx(dx); }
    }, { passive: true });
    // iOS WKWebView: when a gesture starts inside a scrollable element
    // (#audiobookContent has overflow:auto), the native scroll engine can
    // claim a horizontal swipe and fire `touchcancel` INSTEAD OF `touchend`
    // — so the left/right swipe was silently lost on iOS while it worked on
    // Android (which always delivers touchend). The `touch-action:pan-y` now
    // set on the audiobook containers keeps horizontal gestures in JS; binding
    // `touchcancel` to the same handler is the belt-and-suspenders so a swipe
    // is still acted on even if iOS ends the sequence with cancel.
    const onAudiobookSwipeEnd = (e) => {
      if (!started) return;
      started = false;
      if (fired) return; // horizontal cue jump already handled live in touchmove
      const dt = Date.now() - startT;
      if (dt > 600) return; // not a quick swipe
      const t = e.changedTouches?.[0];
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      const ax = Math.abs(dx), ay = Math.abs(dy);
      // Fallback horizontal detection — a quick flick that lifted before the
      // touchmove threshold tripped. swipe-LEFT advances, swipe-RIGHT goes back.
      if (ax > 30 && ax > ay * 1.5) { navByDx(dx); return; }
      // Down-swipe (> 50 px vertical, mostly vertical) → play/pause toggle.
      // Skip if it began in the OS notification-shade / app-switcher edge zone.
      if (dy > 50 && ay > ax * 1.5 && !window._inSystemGestureZone?.(startY)) {
        const bg = window.Capacitor?.Plugins?.BackgroundAudio;
        if (!bg) return;
        bg.getState().then(s => {
          if (s?.playing) bg.pause();
          else if (s?.ready) bg.resume();
        }).catch(() => {});
      }
    };
    view.addEventListener('touchend', onAudiobookSwipeEnd, { passive: true });
    view.addEventListener('touchcancel', onAudiobookSwipeEnd, { passive: true });
  }

  // Tap handler for the audiobook subtitle: on dict-frag tap, set up
  // lookupContext with the tapped cue's audio range so a subsequent
  // "Add to Anki" pulls the right sentence/audio.
  function installAudiobookCueTapHandler() {
    const cueEl = document.getElementById('audiobookCueText');
    if (!cueEl || cueEl.dataset.dictBound === '1') return;
    cueEl.dataset.dictBound = '1';
    cueEl.style.cursor = 'pointer';
    cueEl.addEventListener('click', async (e) => {
      const target = e.target;
      if (!target || !target.classList || !target.classList.contains('dict-frag')) return;
      if (typeof window.performDictLookup !== 'function') return;
      const spans = Array.from(cueEl.querySelectorAll('.dict-frag'));
      const idx = spans.indexOf(target);
      if (idx < 0) return;
      const cueIdx = parseInt(cueEl.dataset.cueIdx);
      const cue = Number.isFinite(cueIdx) ? abCues[cueIdx] : null;
      window.lookupContext = {
        source: 'audiobook',
        card: null,
        cardIdx: -1,
        sentence: cue ? cue.text : '',
        cueAudioPath: abAudioPath,
        cueStartMs: cue ? cue.startMs : null,
        cueEndMs:   cue ? cue.endMs   : null,
        cueIndex:   Number.isFinite(cueIdx) ? cueIdx : -1,
        cues:       abCues
      };
      try { await window.performDictLookup(spans, idx); }
      catch (err) { rlog('Audiobook dict error: ' + (err?.message || err)); }
    });
  }

  // ---- Lock-screen subtitle artwork --------------------------------------
  // Render the current subtitle into a square image and push it as the Now
  // Playing artwork, so the sentence is BIG and readable on the lock screen /
  // Always-On Display (the artist-slot text is tiny). Driven from the cue-
  // change path below, so it only re-renders when the subtitle changes.
  // Toggle off with localStorage.LOCKSCREEN_SUBTITLE_ART = '0' (uses cover art).
  let _subArtCanvas = null;
  function _subtitleArtEnabled() {
    try { return localStorage.getItem('LOCKSCREEN_SUBTITLE_ART') !== '0'; } catch (_) { return true; }
  }
  function _wrapToWidth(ctx, text, maxW) {
    // Character-based wrap — correct for Japanese (no spaces) and fine for
    // romaji. Each line is grown until the next char would overflow maxW.
    const lines = [];
    let line = '';
    for (const ch of text) {
      const test = line + ch;
      if (line && ctx.measureText(test).width > maxW) { lines.push(line); line = ch; }
      else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }
  function renderSubtitleArtwork(rawText) {
    try {
      const text = String(rawText || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (!text) return '';
      const S = 600, PAD = 48, maxW = S - PAD * 2, maxH = S - PAD * 2;
      let cv = _subArtCanvas;
      if (!cv) { cv = _subArtCanvas = document.createElement('canvas'); cv.width = S; cv.height = S; }
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, S, S);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const font = (px) => `600 ${px}px "Hiragino Mincho ProN", "YuMincho", Georgia, serif`;
      // Largest font (80→24px) at which every wrapped line fits the box.
      let lines = [], fontPx = 24;
      for (let px = 80; px >= 24; px -= 2) {
        ctx.font = font(px);
        const wrapped = _wrapToWidth(ctx, text, maxW);
        lines = wrapped; fontPx = px;
        if (wrapped.length * (px * 1.35) <= maxH) break;
      }
      ctx.font = font(fontPx);
      const lineH = fontPx * 1.35;
      let y = (S - lines.length * lineH) / 2 + lineH / 2;
      for (const ln of lines) { ctx.fillText(ln, S / 2, y); y += lineH; }
      return cv.toDataURL('image/jpeg', 0.9);
    } catch (_) { return ''; }
  }

  // Synchronous path: cue idx → text, chunk highlight, cue-precise paint.
  // Runs every position event. Nothing here can await — that was the bug
  // where a hung await on titleStore.list() (Preferences plugin slowness)
  // would block the highlight sync forever after the first cue painted.
  function abUpdateCueDisplay(positionMs) {
    if (!abCues.length) {
      console.log('[abUpdate] abCues empty; pos=' + positionMs);
      return;
    }
    const idx = window.srtParser.findCueAtTime(abCues, positionMs);
    if (idx === abCurrentCueIdx) return;
    abCurrentCueIdx = idx;
    const cueEl = document.getElementById('audiobookCueText');
    if (cueEl) {
      if (idx >= 0) {
        renderAudiobookCueTokens(cueEl, abCues[idx].text, idx);
      } else {
        cueEl.textContent = '…';
      }
    }
    console.log('[abUpdate] cue=' + idx + ' pos=' + positionMs +
      ' mapsReady=' + !!abCueToChunk + ' chunks=' + chunks.length);

    // Reading-mode highlight sync: chunk active class + cue-precise CSS
    // highlight. Done FIRST (synchronously) so it stays reliable.
    //
    // When the PAGED reader is the active view, skip our own highlight
    // paint — both readers write to the same `cue-active` CSS highlight
    // key, so painting onto the (hidden) legacy chunks would overwrite
    // the paged reader's range and freeze its visible highlight mid-play.
    // Instead, hand the cue off to the paged reader via a global hook so
    // it can paint onto its own chunks. The legacy active-class tagging
    // still runs above so cross-mode sync (chunk→card lookups) stays
    // consistent.
    const pagedView = document.getElementById('readingPagedView');
    const pagedActive = !!(pagedView && pagedView.style.display !== 'none');
    if (abCueToChunk && idx >= 0) {
      let chunkIdx = abCueToChunk[idx];
      if (chunkIdx < 0) {
        let prevCue = -1, prevChunk = -1;
        for (let i = idx - 1; i >= 0; i--) {
          if (abCueToChunk[i] >= 0) { prevCue = i; prevChunk = abCueToChunk[i]; break; }
        }
        let nextCue = -1, nextChunk = -1;
        for (let i = idx + 1; i < abCueToChunk.length; i++) {
          if (abCueToChunk[i] >= 0) { nextCue = i; nextChunk = abCueToChunk[i]; break; }
        }
        if (prevChunk >= 0 && nextChunk >= 0 && nextCue > prevCue) {
          const ratio = (idx - prevCue) / (nextCue - prevCue);
          chunkIdx = Math.round(prevChunk + ratio * (nextChunk - prevChunk));
        } else if (prevChunk >= 0) chunkIdx = prevChunk;
        else if (nextChunk >= 0) chunkIdx = nextChunk;
      }
      if (chunkIdx >= 0 && chunkIdx !== lastMatchedIdx) {
        setActive(chunkIdx);
        if (typeof window.currentCardIndex === 'number') tagChunkWithCard(chunkIdx, window.currentCardIndex);
      }
      if (!pagedActive) {
        if (chunkIdx >= 0 && idx >= 0 && abCues[idx]) {
          setCueHighlight(chunkIdx, abCues[idx].text);
        } else {
          clearCueHighlight();
        }
      }
    }
    // Call __onPagedCueUpdate REGARDLESS of paged-reader visibility —
    // even when the paged reader view is hidden (audio mode, card mode),
    // the hook still needs to fire so the top-left progress strip
    // updates. The hook itself early-returns from the highlight-paint
    // path when viewEl is hidden; the progress update happens before
    // that return.
    if (typeof window.__onPagedCueUpdate === 'function') {
      // Pass positionMs so the hook can tell a CONTINUOUS listen from a
      // SEEK by comparing playhead advance to wall-clock (rate-aware),
      // instead of the old cue-start-time gap which dropped every cue
      // longer than 3 s and under-counted listening by ~half.
      try { window.__onPagedCueUpdate(idx, idx >= 0 ? abCues[idx] : null, positionMs); } catch (e) {}
    }

    // Lock screen + audio view image — fire-and-forget. Any latency on
    // the Preferences plugin (titleStore.list) is isolated from the
    // highlight path above.
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (bg && idx >= 0) {
      const cueText = abCues[idx].text;
      const meta = { title: abAudioName || 'Audiobook', subtitle: cueText };
      // Sentence in the lock-screen ARTWORK space, big + serif. Cue-gated by the
      // early-return at the top of this function, so it only renders when the
      // subtitle changes (not every 150ms tick).
      if (_subtitleArtEnabled()) {
        if (bg.setSubtitleArt) {
          // Preferred: NATIVE renders serif text over the dimmed cover — robust
          // in the background, tiny bridge payload (just the text). The cover
          // was handed to native via setMetadata's artwork at play-start.
          bg.setSubtitleArt({ text: cueText }).catch(() => {});
        } else {
          // Fallback (older native build): JS-canvas serif on black.
          const art = renderSubtitleArtwork(cueText);
          if (art) meta.artwork = art;
        }
      }
      bg.setMetadata(meta).catch(() => {});
    }
    updateAudiobookCardImage(idx);
  }

  // Image-resolution side-effect — runs async, isolated from cue sync.
  async function updateAudiobookCardImage(idx) {
    const imgEl = document.getElementById('audiobookCardImage');
    if (!imgEl) return;
    let src = '';
    try {
      if (window._activeTitleId && window.titleStore?.list) {
        const titles = await window.titleStore.list();
        const tit = titles.find(t => t.id === window._activeTitleId);
        if (tit?.attachments?.cover?.dataUri) src = tit.attachments.cover.dataUri;
      }
    } catch (e) {}
    if (!src && abCueToChunk && idx >= 0) {
      const chunkIdx = abCueToChunk[idx];
      if (chunkIdx >= 0 && Array.isArray(window.allNotes)) {
        const card = window.allNotes[chunkIdx];
        const m = card?.imageHtml?.match(/src="([^"]+)"/);
        if (m) src = m[1];
      }
    }
    if (src && imgEl.src !== src) imgEl.src = src;
    imgEl.style.display = src ? '' : 'none';
  }

  function abAttachListenersOnce() {
    if (abListenersAttached) return;
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (!bg) return;
    abListenersAttached = true;
    bg.addListener('position', (d) => {
      abPositionRef.ms = d.positionMs || 0;
      abPositionRef.durMs = d.durationMs || 0;
      const label = document.getElementById('audiobookTimeLabel');
      if (label) label.textContent = `${abFmtMs(abPositionRef.ms)} / ${abFmtMs(abPositionRef.durMs)}`;
      if (!abScrubbing) {
        const scrub = document.getElementById('audiobookScrub');
        if (scrub && abPositionRef.durMs > 0) {
          scrub.value = String(Math.round((abPositionRef.ms / abPositionRef.durMs) * 1000));
        }
      }
      abUpdateCueDisplay(abPositionRef.ms);
      // Drive the top-left progress strip from the audiobook position
      // events too. Listener attaches the moment audio mode opens so
      // the strip updates immediately on first audio-mode entry —
      // without this, the strip stayed at "—" until a mode switch
      // round-trip re-fired the cue-update path.
      try { window.pagedUpdateProgressForCue?.(window._lastAudioCueIdx ?? -1); } catch (_) {}
    });
    bg.addListener('state', (d) => {
      const btn = document.getElementById('audiobookPlayPause');
      if (btn) btn.textContent = d.playing ? 'PAUSE' : 'PLAY';
    });
    bg.addListener('ended', () => {
      const btn = document.getElementById('audiobookPlayPause');
      if (btn) btn.textContent = 'PLAY';
    });
    bg.addListener('error', (d) => {
      alert('Audiobook playback error: ' + (d?.message || 'unknown'));
    });
  }

  function abAttachScrubControl() {
    const scrub = document.getElementById('audiobookScrub');
    if (!scrub || scrub.dataset.wired === '1') return;
    scrub.dataset.wired = '1';
    scrub.addEventListener('touchstart', () => { abScrubbing = true; });
    scrub.addEventListener('mousedown', () => { abScrubbing = true; });
    scrub.addEventListener('change', async () => {
      const bg = window.Capacitor?.Plugins?.BackgroundAudio;
      const v = parseInt(scrub.value);
      if (bg && abPositionRef.durMs > 0 && Number.isFinite(v)) {
        const targetMs = Math.round((v / 1000) * abPositionRef.durMs);
        await bg.seek({ ms: targetMs });
      }
      abScrubbing = false;
    });
  }

  window.openAudiobookMode = async function (opts) {
    opts = opts || {};
    // Show the audiobook view IMMEDIATELY (before any awaits) so the user
    // doesn't see card mode flashing through during async context loading.
    const view = document.getElementById('audiobookModeView');
    if (view) {
      view.style.display = 'flex';
      // Only show the "Loading audiobook…" placeholder when we actually have
      // to load. If the reader already pre-warmed the cue context for this
      // deck, skip the message — it'd flash visibly for ~0 ms.
      const deck = currentDeckName();
      const isPreWarmed = abContextLoadedForDeck === deck && abCues?.length;
      if (!isPreWarmed) {
        const cueEl = document.getElementById('audiobookCueText');
        if (cueEl) {
          // Three-dot pulsing spinner. Replaces the bare "Loading audiobook…"
          // text the user found dated. Self-contained CSS keyframes so we
          // don't pollute theme.css.
          cueEl.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:center;gap:8px;padding:24px 0;">
              <span class="ab-loading-dot"></span>
              <span class="ab-loading-dot"></span>
              <span class="ab-loading-dot"></span>
            </div>
            <style>
              .ab-loading-dot {
                width: 10px; height: 10px; border-radius: 50%;
                background: var(--accent-audio, #b794f6);
                opacity: 0.35;
                animation: ab-loading-pulse 1.1s ease-in-out infinite;
              }
              .ab-loading-dot:nth-child(2) { animation-delay: 0.15s; }
              .ab-loading-dot:nth-child(3) { animation-delay: 0.3s; }
              @keyframes ab-loading-pulse {
                0%, 80%, 100% { opacity: 0.25; transform: scale(0.85); }
                40%           { opacity: 1;    transform: scale(1.1);  }
              }
            </style>
          `;
        }
      }
    }
    const ok = await abLoadContextForCurrentDeck();
    if (!ok) return;
    if (!view) return;
    setPref(KEYS.AUDIOBOOK_OPEN, 'true');
    const titleEl = document.getElementById('audiobookTitle');
    if (titleEl) titleEl.textContent = abAudioName || 'Audiobook';
    abAttachListenersOnce();
    abAttachScrubControl();
    installAudiobookCueTapHandler();
    installAudiobookSwipeHandler();
    window.audiobookActive = true;
    // Fresh audio-chars baseline for this listening session, so re-entering at
    // an earlier position credits cleanly (and the first cue is never dumped).
    window._lastAudioCueIdxForStats = -1;
    window._audioStatsLastWallMs = 0;   // continuity baseline (see __onPagedCueUpdate)
    window._audioStatsLastPosMs = -1;
    if (typeof window.stopCardAudio === 'function') window.stopCardAudio();
    const cueEl = document.getElementById('audiobookCueText');
    if (cueEl) cueEl.textContent = '…';
    // Decide startMs. Default: resume from last saved position for this deck.
    // If opts.seekToCurrentPosition (shell tab switch): derive from
    //   (a) SRT-card mode → current card's audiobookStartMs (most direct)
    //   (b) Read-mode chunk → chunkToCue[lastMatchedIdx] → cue.startMs
    const deck = currentDeckName();
    let startMs = 0;
    const card = Array.isArray(window.allNotes) ? window.allNotes[window.currentCardIndex] : null;
    if (opts.seekToCurrentPosition) {
      if (card?.isSrtCard && Number.isFinite(card.audiobookStartMs)) {
        startMs = card.audiobookStartMs;
      } else if (abChunkToCue && lastMatchedIdx >= 0) {
        const cueIdx = abChunkToCue[lastMatchedIdx];
        if (cueIdx >= 0 && abCues[cueIdx]) startMs = abCues[cueIdx].startMs;
      }
    }
    if (!startMs) {
      const last = await getAudiobookLastPosition(deck);
      startMs = last.ms || 0;
    }
    console.log('[ab] openAudiobookMode seek=' + !!opts.seekToCurrentPosition +
      ' isSrt=' + !!card?.isSrtCard +
      ' cardStart=' + (card?.audiobookStartMs ?? 'n/a') +
      ' chunkIdx=' + lastMatchedIdx +
      ' → startMs=' + startMs);
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (bg) {
      const url = abAudioPath.startsWith('file://') ? abAudioPath : 'file://' + abAudioPath;
      const rate = parseFloat(window.audioPlaybackRate) || 1.0;
      const adjStart = Math.max(0, Math.round(startMs) - (window.AUDIO_START_OFFSET_MS || 0));
      // Remember where this audiobook session started — used by the
      // mode-switch dialog (Forward to audiobook vs Stay) and later
      // by an AI summary feature that summarizes everything from
      // startMs → current bg position.
      window._audiobookSessionStartMs = adjStart;
      window._audiobookSessionStartedAt = Date.now();
      // resumeOnly path: user came back to audio after dismissing the
      // reentry dialog via tab tap (no position choice). Don't reset
      // startMs — just resume from wherever the BG plugin paused. If
      // BG has no current position (cold start), fall through to a
      // regular bg.play() so playback still happens.
      let didResume = false;
      if (opts.resumeOnly) {
        try {
          const s = await bg.getState();
          if (s && (s.ready || s.positionMs > 0)) {
            await bg.resume();
            didResume = true;
          }
        } catch (_) {}
      }
      if (!didResume) {
        await bg.play({ url, startMs: adjStart, rate });
      }
      // Lock-screen / Control Center metadata, now with cover art pulled from
      // the active title (data URI → native decodes to MPMediaItemArtwork).
      let coverArt = '';
      try {
        if (window.titleStore && window._activeTitleId) {
          const t = await window.titleStore.get(window._activeTitleId);
          coverArt = t?.attachments?.cover?.dataUri || '';
        }
      } catch (_) {}
      bg.setMetadata({ title: abAudioName || 'Audiobook', subtitle: '', artwork: coverArt }).catch(() => {});
      // Force an immediate cue update so the subtitle appears before the
      // first periodic position event arrives (saves user a play/pause toggle).
      const initialPoll = async (delay) => {
        try {
          const s = await bg.getState();
          if (s && (s.ready || s.positionMs > 0)) {
            // Reset abCurrentCueIdx so abUpdateCueDisplay forces a re-render.
            abCurrentCueIdx = -2;
            abUpdateCueDisplay(s.positionMs || startMs);
          }
        } catch (e) {}
      };
      setTimeout(() => initialPoll(300), 300);
      setTimeout(() => initialPoll(900), 900);
    }
  };

  window.closeAudiobookMode = async function (opts) {
    opts = opts || {};
    const view = document.getElementById('audiobookModeView');
    if (view) view.style.display = 'none';
    await setPref(KEYS.AUDIOBOOK_OPEN, 'false');
    // Pause + save position so re-entry into reading mode can show the dialog.
    // Continuous mode (opts.keepPlaying) leaves playback running so audio
    // flows uninterrupted as the user switches into card/read.
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (bg && !opts.keepPlaying) {
      try { await bg.pause(); } catch (e) {}
    }
    const deck = currentDeckName();
    if (deck) {
      const chunkIdx = (abCueToChunk && abCurrentCueIdx >= 0) ? abCueToChunk[abCurrentCueIdx] : -1;
      await saveAudiobookLastPosition(deck, abPositionRef.ms, chunkIdx);
    }
    // Card mode can resume normal audio playback now.
    window.audiobookActive = false;
  };

  window.audiobookTogglePlay = async function () {
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (!bg) return;
    const s = await bg.getState();
    if (s.playing) await bg.pause();
    else await bg.resume();
  };

  window.audiobookSkip = async function (deltaMs) {
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (!bg) return;
    const s = await bg.getState();
    const target = Math.max(0, (s.positionMs || 0) + deltaMs);
    await bg.seek({ ms: target });
  };

  // -------- Audiobook → other-mode re-entry dialog --------
  //
  // Triggered when the user switches OUT of audio to card/read mode. If the
  // audiobook drifted far from the reading cursor (>2 chunks), ask whether to
  // keep the cursor, jump to where audio is, or jump + summarize.

  // Master playhead threshold: prompt only when positions differ by
  // at least 1 cue. Smaller drifts (audio just started, cursor is
  // already there) auto-resolve as "Stay" silently.
  const REENTRY_THRESHOLD_MS = 1500;
  let reentryPendingAudioChunk = -1;
  let _reentryResolve = null;

  // Format ms → "m:ss" for the modal position labels.
  function _fmtMmss(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + s;
    return m + ':' + s;
  }

  // Returns a promise that resolves to 'cursor' | 'audio' | null.
  // The prompt fires on every audio → card/read switch when audio
  // and cursor have meaningfully diverged. Both positions are shown
  // on the buttons in the format appropriate to the destination
  // mode (card numbers for card mode, character positions for
  // read mode).
  window.maybeShowAudioReentryDialog = function (targetMode) {
    return new Promise((resolve) => {
      let audioChunk = -1, cursor = -1;
      let audioMs = abPositionRef.ms || 0;
      let cursorMs = 0;
      // SRT-cards titles take PRIORITY over the EPUB-chunks branch
      // (which runs only for deck-card titles that have a paired
      // EPUB but cards-via-deck not cards-via-SRT). For SRT-cards,
      // cue index = card index = chunk index in 1:1 alignment, but
      // the data we want to surface in the modal — and pass to
      // updateCardIndex on user choice — is the CUE INDEX. Going
      // through abCueToChunk would have remapped to chunk index
      // and then updateCardIndex(chunkIdx) would have planted the
      // user on the wrong card (the chunk-index ≠ cue-index for
      // many alignments).
      const isSrtCardsTitle = Array.isArray(window.allNotes) &&
                              window.allNotes[0]?.isSrtCard;
      if (isSrtCardsTitle && abCurrentCueIdx >= 0) {
        audioChunk = abCurrentCueIdx;
        // For SRT-cards titles: read currentCardIndex LIVE rather
        // than from a saved snapshot. With syncCardToCurrentCue no
        // longer running on audio→card (only on read→card),
        // currentCardIndex stays stable through audio playback and
        // is the same value the card-view bottom bar displays. Using
        // it here guarantees the dialog's "prior card N" line
        // matches the visible card-view exactly.
        cursor = (typeof window.currentCardIndex === 'number' && window.currentCardIndex >= 0)
          ? window.currentCardIndex
          : -1;
        if (cursor >= 0 && abCues[cursor]) cursorMs = abCues[cursor].startMs;
      } else if (abCueToChunk && abCurrentCueIdx >= 0) {
        // Deck-card titles with paired EPUB: cards come from the
        // deck, but the reader/audio cursor maps via cue→chunk.
        audioChunk = abCueToChunk[abCurrentCueIdx];
        // Snapshot from shell on audio entry (where the reader was
        // before audio).
        const priorCursor = window._priorReaderCursorIdx;
        const hasPrior = Number.isFinite(priorCursor) && priorCursor >= 0;
        cursor = hasPrior ? priorCursor : lastMatchedIdx;
        if (cursor >= 0 && abChunkToCue) {
          const cueIdxForCursor = abChunkToCue[cursor];
          if (cueIdxForCursor >= 0 && abCues[cueIdxForCursor]) {
            cursorMs = abCues[cueIdxForCursor].startMs;
          }
        }
      }
      // No audio context at all (audio mode never opened, audiobook
      // not paired) → no prompt needed.
      if (audioChunk < 0 || cursor < 0) {
        window._audioPositionUnresolved = false;
        resolve(null); return;
      }
      // ONLY prompt when audio is AHEAD of the user's cursor. If
      // audio caught up or user moved, the divergence is resolved
      // implicitly — clear the unresolved flag so future mode
      // switches don't re-prompt.
      if (audioChunk <= cursor) {
        window._audioPositionUnresolved = false;
        resolve(null); return;
      }
      // Belt-and-suspenders: also require a meaningful time delta
      // so a "1 cue ahead" by 100 ms doesn't pop a dialog.
      const deltaMs = audioMs - cursorMs;
      if (deltaMs < REENTRY_THRESHOLD_MS) {
        window._audioPositionUnresolved = false;
        resolve(null); return;
      }
      // Mark divergence as unresolved so subsequent mode switches
      // re-show the dialog (in the appropriate target-mode flavor)
      // until the user explicitly picks one of the two positions.
      window._audioPositionUnresolved = true;
      reentryPendingAudioChunk = audioChunk;
      const modal = document.getElementById('audiobookReentryModal');
      const cursorPosEl = document.getElementById('reentryCursorPos');
      const audioPosEl  = document.getElementById('reentryAudioPos');
      const titleEl     = document.getElementById('reentryTitle');
      const stayLabelEl = document.getElementById('reentryStayBtnLabel');
      const jumpLabelEl = document.getElementById('reentryJumpBtnLabel');
      // Title + primary button text + title COLOR varies by
      // destination mode. Title color matches the mode's highlight
      // color (orange for card, green for read) so the dialog
      // immediately reads as "this is about your CARD/READ
      // position." For read mode we use the exact tinted-green
      // formula from the cue-active highlight in theme.css so the
      // visual match is precise, not "near".
      if (targetMode === 'card') {
        if (titleEl) {
          titleEl.textContent = 'Card Number';
          titleEl.style.color = 'var(--accent-card, #ff9550)';
          titleEl.style.letterSpacing = '0';
          titleEl.style.textTransform = 'none';
        }
        if (stayLabelEl) stayLabelEl.textContent = 'Return to prior card';
        if (jumpLabelEl) jumpLabelEl.textContent = 'Jump to audiobook card';
      } else if (targetMode === 'read') {
        if (titleEl) {
          titleEl.textContent = 'Reading Position';
          // Same tinted-green as ::highlight(cue-active) in theme.css.
          titleEl.style.color =
            'color-mix(in srgb, var(--accent-read, #4caf50) 70%, white 30%)';
          titleEl.style.letterSpacing = '0';
          titleEl.style.textTransform = 'none';
        }
        if (stayLabelEl) stayLabelEl.textContent = 'Return to prior reading position';
        if (jumpLabelEl) jumpLabelEl.textContent = 'Jump to audiobook position';
      } else {
        if (titleEl) {
          titleEl.textContent = 'Position';
          titleEl.style.color = '#00ffcc';
          titleEl.style.letterSpacing = '0';
          titleEl.style.textTransform = 'none';
        }
        if (stayLabelEl) stayLabelEl.textContent = 'Return to prior position';
        if (jumpLabelEl) jumpLabelEl.textContent = 'Keep audiobook position';
      }
      // Format per destination mode:
      //   card mode → "current card 532, audio card 598"
      //   read mode → "current character position 45,092, audio position 48,201"
      // Falls back to mm:ss when neither dataset is available (e.g.,
      // tap was on a freshly-loaded title before chunk metadata
      // settled).
      if (cursorPosEl && audioPosEl) {
        if (targetMode === 'card') {
          // The cursor field sits under the "Return to prior reading
          // position" button — label it "prior" so the data line
          // matches the button text. (Previously labeled "current"
          // which read as confusingly contradictory.)
          const curCardNum = (cursor + 1).toLocaleString();
          const audCardNum = (audioChunk + 1).toLocaleString();
          cursorPosEl.textContent = 'prior card ' + curCardNum;
          audioPosEl.textContent  = 'audio card ' + audCardNum;
        } else if (targetMode === 'read') {
          const charAt = (idx) => {
            if (!chunks[idx]) return null;
            // JP-only units so this matches the bottom-bar character position.
            const off = parseInt(chunks[idx].dataset.jpOff) || 0;
            const len = parseInt(chunks[idx].dataset.jpLen) || 0;
            return off + len;
          };
          const curChar = charAt(cursor);
          const audChar = charAt(audioChunk);
          if (Number.isFinite(curChar) && Number.isFinite(audChar)) {
            cursorPosEl.textContent = 'prior character position ' +
              curChar.toLocaleString();
            audioPosEl.textContent  = 'audio position ' +
              audChar.toLocaleString();
          } else {
            cursorPosEl.textContent = 'prior position @ ' + _fmtMmss(cursorMs);
            audioPosEl.textContent  = 'audio position @ ' + _fmtMmss(audioMs);
          }
        } else {
          cursorPosEl.textContent = 'prior position @ ' + _fmtMmss(cursorMs);
          audioPosEl.textContent  = 'audio position @ ' + _fmtMmss(audioMs);
        }
      }
      if (!modal) { resolve(null); return; }
      _reentryResolve = resolve;
      modal.style.display = 'flex';
    });
  };

  window.reentryChoose = function (choice, opts) {
    const modal = document.getElementById('audiobookReentryModal');
    if (modal) modal.style.display = 'none';
    const target = reentryPendingAudioChunk;
    // Tab-tap dismiss passes { unresolved: true } — modal hides and
    // promise resolves so shell's await can continue, BUT the
    // divergence stays "unresolved" so the dialog re-shows on the
    // next mode switch into card/read. Button clicks pass no opts
    // and fully resolve.
    const unresolved = !!opts?.unresolved;
    if (choice === 'audio') {
      const isSrtCardsMode = Array.isArray(window.allNotes) && window.allNotes[0]?.isSrtCard;
      if (isSrtCardsMode && typeof window.updateCardIndex === 'function' && target >= 0) {
        // In SRT-cards mode the chunk index IS the card index.
        window.updateCardIndex(target);
      } else if (target >= 0 && chunks[target]) {
        // EPUB chunk-based: highlight the matching chunk in reading mode.
        setActive(target);
      }
      // Stash the audio cue index so the paged reader's openView can
      // CENTER on the matching chunk once it's mounted. Without this
      // the user picks "Keep current audiobook position" and sees the
      // chunk highlighted but off-screen — autoScrollForRange
      // right-justifies the cue at the viewport edge, not the center.
      // pagedCenterOnCue in reading-mode-paged.js consumes this flag.
      try {
        if (Number.isFinite(abCurrentCueIdx) && abCurrentCueIdx >= 0) {
          window._reentryAudioJumpCueIdx = abCurrentCueIdx;
        }
      } catch (_) {}
    }
    if (choice === 'cursor') {
      // Capture the CURRENT read position as a one-shot "stay" anchor NOW,
      // while it is still valid: openReadingMode (which shell calls right after
      // this) runs loadAudiobookCues, which wipes the paged reader's
      // lastReadCueIdx to -1 BEFORE it paints. Without this, "stay" fell
      // through to the audio-ahead _lastAudioCueIdx and jumped mid-book.
      // Only ever store a validated read anchor (>=0); never 0/-1 as a guess.
      try {
        let stayCue = -1;
        if (typeof window._pagedReadCueIdx === 'function') {
          const c = window._pagedReadCueIdx();
          if (Number.isFinite(c) && c >= 0) stayCue = c;
        }
        if (stayCue < 0 && Array.isArray(window.allNotes) && window.allNotes[0]?.isSrtCard) {
          const ci = window.currentCardIndex;
          if (Number.isFinite(ci) && ci >= 0) stayCue = ci;
        }
        if (stayCue >= 0) window._reentryStayCueIdx = stayCue;
      } catch (_) {}
    }
    // 'cursor' → no-op (user wants to stay where reader currently is)
    // Resolve the unresolved-flag + clear prior snapshots ONLY when
    // the user explicitly picked a button (no `unresolved` flag).
    // Tab-tap dismiss leaves the flag set so the next mode switch
    // re-shows the dialog.
    if (!unresolved && (choice === 'cursor' || choice === 'audio')) {
      try {
        window._audioPositionUnresolved = false;
        window._priorCardIdx = null;
        window._priorCardIdxAtMs = 0;
        window._priorReaderCursorIdx = null;
        window._priorReaderCursorAtMs = 0;
      } catch (_) {}
    }
    const r = _reentryResolve;
    _reentryResolve = null;
    reentryPendingAudioChunk = -1;
    if (r) r(choice);
  };

  async function loadEpubFromUri(uri, name) {
    const content = document.getElementById('readingModeContent');
    const title = document.getElementById('readingModeTitle');
    title.textContent = `Loading ${name}…`;
    content.innerHTML = `<p style="color:#888;text-align:center;margin-top:40vh;">Loading ${name}…</p>`;

    const { path } = await window.Capacitor.Plugins.FileAccess.materializeToCache({ uri });
    const response = await fetch(window.Capacitor.convertFileSrc(path));
    if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
    const blob = await response.blob();

    const zip = await JSZip.loadAsync(blob);

    const containerXml = await zip.file('META-INF/container.xml')?.async('string');
    if (!containerXml) throw new Error('Not a valid EPUB (no META-INF/container.xml)');
    const opfPath = new DOMParser()
      .parseFromString(containerXml, 'application/xml')
      .querySelector('rootfile')?.getAttribute('full-path');
    if (!opfPath) throw new Error('No OPF rootfile in container.xml');

    const opfXml = await zip.file(opfPath).async('string');
    const opfDoc = new DOMParser().parseFromString(opfXml, 'application/xml');
    const opfDir = opfPath.includes('/') ? opfPath.replace(/[^/]+$/, '') : '';

    const manifest = {};
    opfDoc.querySelectorAll('manifest > item').forEach(item => {
      manifest[item.getAttribute('id')] = item.getAttribute('href');
    });
    const spineOrder = [...opfDoc.querySelectorAll('spine > itemref')]
      .map(ref => manifest[ref.getAttribute('idref')])
      .filter(Boolean);

    rlog(`EPUB has ${spineOrder.length} spine items`);

    const sections = [];
    for (const href of spineOrder) {
      const fullPath = (opfDir + href).replace(/^\//, '');
      const file = zip.file(fullPath);
      if (!file) continue;
      const html = await file.async('string');
      const doc = new DOMParser().parseFromString(html, 'text/html');
      doc.querySelectorAll('script, style, link').forEach(el => el.remove());
      doc.querySelectorAll('img, image').forEach(el => el.remove());
      const body = doc.body;
      if (body) sections.push(body.innerHTML);
    }

    content.innerHTML = sections.join('\n<hr style="border:0;border-top:1px solid #333;margin:32px 0;">\n');
    content.scrollTop = 0;
    title.textContent = name;
    currentEpubName = name;
    currentEpubUri = uri;
    rlog(`EPUB rendered: ${sections.length} sections`);

    chunks = chunkRenderedContent(content);
    computeChunkCharOffsets();
    lastMatchedIdx = -1;
    firstSyncForBook = true;
    rlog(`Indexed ${chunks.length} reading chunks (${totalBookJpChars.toLocaleString()} JP chars, ${totalBookChars.toLocaleString()} raw)`);
    refreshProgressBar();
    // Load SRT cues + build cue↔chunk maps so read-mode highlight follows
    // audio even when the user never opened the audio-mode view. Quiet:
    // no UI side-effects. Also attach the BG-audio position listener that
    // drives abUpdateCueDisplay (normally attached by openAudiobookMode).
    if (await ensureCueContextLoaded()) {
      let matched = 0;
      if (abCueToChunk) {
        for (let i = 0; i < abCueToChunk.length; i++) if (abCueToChunk[i] >= 0) matched++;
      }
      rlog(`Cue↔chunk ready: ${matched}/${abCues.length} cues mapped`);
      abAttachListenersOnce();
    }

    // Restore cursor if we have a saved one for this (deck, epub) pair.
    const deck = currentDeckName();
    if (deck) {
      const savedIdx = await getCursor(deck, name);
      if (savedIdx >= 0 && savedIdx < chunks.length) {
        setActive(savedIdx);
        firstSyncForBook = false;
        rlog(`Restored cursor to chunk ${savedIdx}`);
      }
      await savePairing(deck, name);
    }

    // If a card is already current, sync right away.
    if (window.currentCardIndex != null && Array.isArray(window.allNotes) && window.allNotes.length) {
      const card = window.allNotes[window.currentCardIndex];
      if (card?.expression) syncReadingToCard(card.expression);
    }
  }

  // Render empty-state UI in the reading view when no EPUB is paired with
  // the current deck (or no deck loaded). Also wipes any stale chunks from
  // a previously-loaded EPUB so the user doesn't see the wrong book.
  function renderReadingEmptyState(message) {
    const content = document.getElementById('readingModeContent');
    const title = document.getElementById('readingModeTitle');
    if (content) {
      content.innerHTML = `
        <div style="max-width:340px;margin:25vh auto 0 auto;text-align:center;font-family:var(--font-sans);padding:0 24px;">
          <div style="font-size:.7rem;letter-spacing:.18em;text-transform:uppercase;color:var(--accent-read,#4caf50);font-weight:700;margin-bottom:10px;">Reader</div>
          <div style="font-size:1rem;color:var(--text,#e8e8e8);line-height:1.5;margin-bottom:18px;">${message}</div>
          <div style="font-size:.85rem;color:var(--text-muted,#888);line-height:1.5;">Tap the <span style="color:var(--text,#e8e8e8);font-weight:600;">≡ menu</span> → <span style="color:var(--text,#e8e8e8);font-weight:600;">Open EPUB</span>.</div>
        </div>`;
    }
    if (title) title.textContent = 'No EPUB loaded';
    chunks = [];
    lastMatchedIdx = -1;
    currentEpubName = null;
    currentEpubUri = null;
    totalBookChars = 0;
    totalBookJpChars = 0;
  }

  // Background-prewarm hook called from app.js right after a title loads.
  // Parses the paired EPUB and builds chunks silently, so by the time the
  // user taps READ for the first time, restoreLastEpub is a no-op and
  // openReadingMode's cold path is essentially as fast as the warm path.
  let _prewarmInFlight = null;
  window.prewarmReader = async function () {
    if (_prewarmInFlight) return _prewarmInFlight;
    // Already loaded — but ONLY skip when it's the SAME book as the active
    // title. Opening a different title must reload; otherwise the previous
    // book lingers at its old scroll position and the new title appears to
    // "open in the middle" (the chunks-loaded guard was book-agnostic).
    if (chunks.length) {
      let targetUri = null;
      try {
        if (window.titleStore && window._activeTitleId) {
          const titles = await window.titleStore.list();
          const t = titles.find(x => x.id === window._activeTitleId);
          targetUri = t?.attachments?.epub?.uri || null;
        }
      } catch (e) {}
      // Compare by URI so two books that share a filename still reload.
      if (!targetUri || targetUri === currentEpubUri) return Promise.resolve(true);
    }
    _prewarmInFlight = (async () => {
      try {
        await restoreLastEpub();
        return true;
      } catch (e) {
        rlog('prewarm failed: ' + (e?.message || e));
        return false;
      } finally {
        _prewarmInFlight = null;
      }
    })();
    return _prewarmInFlight;
  };

  // Try the active title's EPUB attachment when the deck-pairing path fails
  // (deck-less titles, or first-launch where the legacy prefs haven't been
  // written yet). Returns true if a load was kicked off.
  async function tryLoadFromActiveTitle() {
    try {
      if (!window.titleStore || !window._activeTitleId) return false;
      const titles = await window.titleStore.list();
      const t = titles.find(x => x.id === window._activeTitleId);
      const ep = t?.attachments?.epub;
      if (!ep?.uri || !ep?.name) return false;
      rlog(`Active-title fallback: loading ${ep.name}`);
      await loadEpubFromUri(ep.uri, ep.name);
      return true;
    } catch (e) {
      rlog(`Active-title fallback failed: ${e.message}`);
      const content = document.getElementById('readingModeContent');
      if (content) content.innerHTML =
        `<p style="color:#f66;text-align:center;margin-top:40vh;padding:0 20px;">Could not open EPUB: ${e.message}</p>`;
      return true;
    }
  }

  async function restoreLastEpub() {
    const deck = currentDeckName();
    if (!deck) {
      if (await tryLoadFromActiveTitle()) return;
      renderReadingEmptyState('No deck loaded.');
      return;
    }
    const name = await getPairedEpub(deck);
    if (!name) {
      if (await tryLoadFromActiveTitle()) return;
      renderReadingEmptyState(`No EPUB paired with <b>${deck}</b>.`);
      return;
    }
    let uri = null;
    const lastName = await getPref(KEYS.EPUB_NAME);
    if (lastName === name) {
      uri = await getPref(KEYS.EPUB_URI);
    }
    if (!uri) {
      if (await tryLoadFromActiveTitle()) return;
      renderReadingEmptyState(`The paired EPUB (<b>${name}</b>) is no longer accessible.`);
      return;
    }
    try {
      await loadEpubFromUri(uri, name);
    } catch (e) {
      rlog(`Restore failed: ${e.message}`);
      const content = document.getElementById('readingModeContent');
      content.innerHTML = `<p style="color:#f66;text-align:center;margin-top:40vh;padding:0 20px;">Could not reopen ${name}: ${e.message}<br>Use MORE → Library to pick again.</p>`;
    }
  }

  // Wire a one-time scroll listener on the content area: any non-trivial
  // scroll counts as "actively reading" and starts/refreshes the read
  // timer. Casual background taps are intentionally NOT enough.
  // ALSO drives the scroll-based char counter (for no-audio reading).
  function installReadActivityHooks() {
    const content = document.getElementById('readingModeContent');
    if (!content || content.dataset.statsHooked === '1') return;
    content.dataset.statsHooked = '1';
    let lastScrollTop  = content.scrollTop;
    let lastScrollLeft = content.scrollLeft;
    const tickCharCounter = () => {
      // Vertical mode scrolls horizontally; pick the relevant axis.
      const isVertical = content.classList.contains('vertical');
      const cRect = content.getBoundingClientRect();
      // "Past the 60% reading line" = chunk has been read.
      //   horizontal: chunk.bottom <= viewport.top + 60% of height
      //               (chunk's bottom edge is above the reading line)
      //   vertical-rl: chunk.left >= viewport.left + 40% of width
      //               (chunk's left edge is in the right 60% of viewport,
      //               i.e., already past the leftward reading flow)
      let furthestPastIdx = -1;
      for (let i = 0; i < chunks.length; i++) {
        const ch = chunks[i];
        const r = ch.getBoundingClientRect();
        const past = isVertical
          ? r.left >= cRect.left + cRect.width * 0.4
          : r.bottom <= cRect.top + cRect.height * 0.6;
        if (past) {
          furthestPastIdx = i;
          if (!ch.dataset.counted) {
            // JP-only credit (cross-mode consistency — see setActive).
            const len = window.jpCharCount ? window.jpCharCount(textWithoutRuby(ch))
                                           : textWithoutRuby(ch).length;
            if (len > 0) {
              // Same gating as setActive — credit only when actually
              // in reader mode. Mark counted regardless so audio-mode
              // pre-passes don't get retroactively credited if the
              // user later scrolls past them in reader.
              if (document.body.classList.contains('mode-read')) {
                cumulativeChars += len;
              }
              ch.dataset.counted = '1';
            }
          }
        }
      }
      // Use the furthest-past chunk as the reading-position cursor for
      // progress / position-save purposes only — do NOT paint a visible
      // .active class during scroll. iOS WKWebView race conditions
      // between scroll events and class toggles produce a "green smear"
      // where every chunk swiped past stays green. The audio-driven
      // setActive() still paints a cursor when audio is playing; pure
      // scroll without audio just doesn't get a visible marker, which
      // is the right trade — readers don't want their text recolored
      // as they read.
      if (furthestPastIdx >= 0) {
        if (furthestPastIdx !== lastMatchedIdx) {
          // Belt-and-suspenders: still sweep stale .active classes so any
          // residue from a prior code path can't strand green text.
          clearActiveHighlight();
          clearCueHighlight();
          lastMatchedIdx = furthestPastIdx;
          publishChunkCueRange(furthestPastIdx);
        }
        try {
          const deck = currentDeckName();
          if (deck && currentEpubName && chunks[furthestPastIdx]) {
            const el = chunks[furthestPastIdx];
            const off = parseInt(el.dataset.jpOff) || 0;
            const len = parseInt(el.dataset.jpLen) || 0;
            localStorage.setItem('READING_POS_' + deck + '_' + currentEpubName,
                                 String(off + len));
          }
        } catch (e) {}
        refreshProgressBar();
      }
      setPref(KEYS.CHARS, Math.floor(cumulativeChars));
      // Refresh the live label if the stats panel is open.
      const label = document.getElementById('statsReadChars');
      if (label) label.textContent = cumulativeChars.toLocaleString();
    };
    let pending = false;
    content.addEventListener('scroll', () => {
      // In vertical-rl, content scrolls HORIZONTALLY — scrollTop is always 0.
      // Check both axes so the listener fires in either writing mode.
      const dx = Math.abs(content.scrollLeft - lastScrollLeft);
      const dy = Math.abs(content.scrollTop  - lastScrollTop);
      if (dx < 8 && dy < 8) return;
      lastScrollLeft = content.scrollLeft;
      lastScrollTop  = content.scrollTop;
      if (window.stats?.bumpRead) window.stats.bumpRead();
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; tickCharCounter(); });
    }, { passive: true });
    // Also run once immediately so the first chunk on screen gets counted
    // even before any scroll.
    requestAnimationFrame(tickCharCounter);
  }

  // Session-level "warm" flag. The first openReadingMode does the heavy
  // setup (font prefs, hooks, prefs reads). Subsequent calls within the
  // session skip all of it — chunks + DOM are already in memory, hooks
  // are already attached, prefs values are still valid. This keeps tab
  // switches into READ snappy (sub-100 ms) instead of paying ~500 ms of
  // sequential Capacitor Preferences round-trips every time.
  let readerWarmed = false;

  window.openReadingMode = async function () {
    rlog('Opening reading mode');
    const view = document.getElementById('readingModeView');
    view.style.display = 'flex';
    const content = document.getElementById('readingModeContent');
    // Always keep content visible — the previous opacity:0 → 1 transition
    // could strand the reader blank if any await in the cold path stalled
    // or threw silently. A brief flash of unsynced scroll is better than
    // a permanently blank screen.
    if (content) {
      content.style.opacity = '1';
      content.style.transition = '';
    }

    // Warm path: just sync the highlight + scroll position and return.
    if (readerWarmed) {
      setPref(KEYS.MODE_OPEN, 'true');
      startTimer();
      try { syncReaderToCurrentPosition(); } catch (e) {}
      return;
    }
    // Run every awaitable piece concurrently. Each Capacitor Preferences
    // call hops the bridge; running them sequentially burned ~500 ms.
    const deck = currentDeckName();
    const [, storedSec, storedChars, storedMode, pairedName] = await Promise.all([
      applyFontPrefs(),
      getPref(KEYS.TIME_SEC),
      getPref(KEYS.CHARS),
      getPref(KEYS.PROGRESS_MODE),
      deck ? getPairedEpub(deck) : Promise.resolve(null)
    ]);
    cumulativeSec = parseInt(storedSec) || 0;
    cumulativeChars = parseInt(storedChars) || 0;
    const m = parseInt(storedMode);
    if (Number.isFinite(m) && m >= 0 && m < 3) progressMode = m;
    const label = document.getElementById('readingTimerLabel');
    if (label) label.textContent = formatSec(cumulativeSec);

    installReadActivityHooks();
    installContentTapHandler();
    startInactivityWatcher();
    refreshPlayPauseButton();
    startPlayStatePoll();
    setPref(KEYS.MODE_OPEN, 'true');
    startTimer();
    // If app.js fired prewarmReader at title load and it's still parsing,
    // wait on the same promise instead of starting a duplicate load.
    if (_prewarmInFlight) {
      try { await _prewarmInFlight; } catch (e) { rlog(`prewarm wait failed: ${e.message}`); }
    } else if (pairedName !== currentEpubName) {
      await restoreLastEpub();
    }
    // Belt-and-suspenders: if after all that we STILL have no chunks
    // loaded, force a load from the active title's EPUB attachment.
    // Without this the reader could land on a permanently-blank screen
    // when the pairedName/currentEpubName/_prewarm dance silently no-ops.
    if (!chunks?.length) {
      rlog('cold path produced no chunks — forcing tryLoadFromActiveTitle');
      try { await tryLoadFromActiveTitle(); } catch (e) { rlog(`forced load failed: ${e.message}`); }
    }
    // Last-resort visible recovery: if we STILL have no chunks, render an
    // explicit "Reload EPUB" button so the user isn't staring at a blank
    // screen with no way to recover.
    if (!chunks?.length && content) {
      content.innerHTML = `
        <div style="max-width:380px;margin:30vh auto 0 auto;text-align:center;
                    font-family:var(--font-sans);padding:0 24px;">
          <div style="font-size:.7rem;letter-spacing:.18em;text-transform:uppercase;
                      color:var(--accent-read,#4caf50);font-weight:700;margin-bottom:10px;">Reader</div>
          <div style="font-size:1rem;color:var(--text,#e8e8e8);line-height:1.5;margin-bottom:18px;">
            Couldn't load the EPUB. The cache may be gone — re-pick the file.
          </div>
          <button onclick="window.pickReadingEpub && window.pickReadingEpub()"
                  style="background:transparent;color:var(--accent-read,#4caf50);
                         border:1px solid var(--accent-read,#4caf50);
                         padding:10px 18px;border-radius:8px;font-weight:700;
                         font-family:var(--font-sans);font-size:.95rem;">
            📂 Pick EPUB
          </button>
        </div>`;
    }
    await syncReaderToCurrentPosition();
    readerWarmed = true;
  };

  // Title swap invalidates the warm flag — new title may have different
  // font/highlight prefs, and EPUB pairing has to be re-resolved.
  window.addEventListener('shell:title-change', () => { readerWarmed = false; });

  // Open-reader and tab-switch sync: locate the chunk that matches the
  // current playhead (audio cue → mapped chunk, else the current card's
  // expression text, else the last-matched cursor), highlight it, and
  // center it on screen — no smooth animation.
  async function syncReaderToCurrentPosition() {
    try {
      rlog(`syncReader start: chunks=${chunks?.length || 0} cues=${abCues?.length || 0} ` +
           `mapsReady=${!!abCueToChunk} cardIdx=${window.currentCardIndex} ` +
           `audioMs=${abPositionRef?.ms || 0} lastMatched=${lastMatchedIdx}`);
      if (!chunks?.length) return;
      let cueIdx = -1;
      let chunkIdx = -1;
      let how = '';

      // 1) Audio position → cue → chunk.
      if (abCues?.length && Number.isFinite(abPositionRef?.ms) && abPositionRef.ms > 0) {
        cueIdx = window.srtParser.findCueAtTime(abCues, abPositionRef.ms);
        if (cueIdx >= 0 && abCueToChunk && abCueToChunk[cueIdx] >= 0) {
          chunkIdx = abCueToChunk[cueIdx];
          how = 'audio-position';
        }
      }

      // 2) SRT-card titles: card index IS cue index. Use map directly with
      //    neighbor-walk fallback for unmapped cues.
      if (chunkIdx < 0 && Array.isArray(window.allNotes) &&
          window.allNotes[0]?.isSrtCard && abCueToChunk) {
        const ci = window.currentCardIndex;
        if (Number.isFinite(ci) && ci >= 0 && ci < abCueToChunk.length) {
          cueIdx = ci;
          chunkIdx = abCueToChunk[ci];
          how = 'srt-card-index';
          if (chunkIdx < 0) {
            let prev = -1, next = -1;
            for (let i = ci - 1; i >= 0; i--) if (abCueToChunk[i] >= 0) { prev = abCueToChunk[i]; break; }
            for (let i = ci + 1; i < abCueToChunk.length; i++) if (abCueToChunk[i] >= 0) { next = abCueToChunk[i]; break; }
            if (prev >= 0 && next >= 0) chunkIdx = Math.round((prev + next) / 2);
            else if (prev >= 0) chunkIdx = prev;
            else if (next >= 0) chunkIdx = next;
            if (chunkIdx >= 0) how = 'srt-card-neighbor';
          }
        }
      }

      // 3) Deck card → matched cue (via SRT text) → chunk. Walks abCues
      //    looking for one whose text contains the card's expression;
      //    then uses abCueToChunk for the chunk. More reliable than
      //    matching card.expression directly against chunks (cue text
      //    is closer to chunk text than card text is).
      if (chunkIdx < 0 && abCues?.length && abCueToChunk &&
          Array.isArray(window.allNotes)) {
        const card = window.allNotes[window.currentCardIndex];
        const cardText = card?.expression
          ? normalizeText(textWithoutRubyFromHtml(card.expression)) : '';
        if (cardText) {
          for (let i = 0; i < abCues.length; i++) {
            if (normalizeText(abCues[i].text).includes(cardText)) {
              if (abCueToChunk[i] >= 0) {
                cueIdx = i;
                chunkIdx = abCueToChunk[i];
                how = 'card-text→cue→chunk';
              }
              break;
            }
          }
        }
      }

      // 4) Direct chunk text match (existing path).
      if (chunkIdx < 0 && Array.isArray(window.allNotes)) {
        const card = window.allNotes[window.currentCardIndex];
        if (card?.expression) {
          const target = normalizeText(textWithoutRubyFromHtml(card.expression));
          if (target) {
            const idx = findContainsFrom(target, 0);
            if (idx >= 0) {
              chunkIdx = idx;
              how = 'card-text→chunk';
              if (abChunkToCue && abChunkToCue[idx] >= 0) cueIdx = abChunkToCue[idx];
            }
          }
        }
      }

      // 5) Last-matched cursor.
      if (chunkIdx < 0 && lastMatchedIdx >= 0) {
        chunkIdx = lastMatchedIdx;
        how = 'last-cursor';
      }

      if (chunkIdx < 0 || !chunks[chunkIdx]) {
        rlog(`syncReader → NO MATCH (chunks=${chunks?.length} cues=${abCues?.length} cardIdx=${window.currentCardIndex})`);
        return;
      }
      // Always try to derive cueIdx from the chunk if the path didn't set
      // one (path 5 in particular). Cue text gives a much more precise
      // Range search than card.expression, so the CSS Custom Highlight
      // lands reliably on warm reopens.
      if (cueIdx < 0 && abChunkToCue && abChunkToCue[chunkIdx] >= 0) {
        cueIdx = abChunkToCue[chunkIdx];
      }
      rlog(`syncReader → chunk ${chunkIdx} (cue ${cueIdx}) via ${how}`);

      setActive(chunkIdx, { instantScroll: true, center: true });

      let highlightText = '';
      if (cueIdx >= 0 && abCues?.[cueIdx]) highlightText = abCues[cueIdx].text;
      else if (Array.isArray(window.allNotes)) {
        const card = window.allNotes[window.currentCardIndex];
        if (card?.expression) highlightText = textWithoutRubyFromHtml(card.expression);
      }
      if (highlightText) setCueHighlight(chunkIdx, highlightText);
    } catch (e) {
      rlog('syncReader error: ' + (e?.message || e));
    }
  }
  window.syncReaderToCurrentPosition = syncReaderToCurrentPosition;

  // Hook from app.js whenever the user moves through cards. We keep
  // lastMatchedIdx in sync with the new card so the reader is always
  // ready to display the right chunk on a tab switch — even if audio
  // isn't playing and the syncReader heuristics can't otherwise nail
  // down the right chunk.
  window.notifyCardIndexChanged = function (cardIdx) {
    if (!chunks?.length || !Number.isFinite(cardIdx)) return;
    let chunkIdx = -1;
    // SRT-cards: card index IS cue index. Walk neighbors if unmapped.
    if (Array.isArray(window.allNotes) && window.allNotes[0]?.isSrtCard && abCueToChunk) {
      if (cardIdx >= 0 && cardIdx < abCueToChunk.length) {
        chunkIdx = abCueToChunk[cardIdx];
        if (chunkIdx < 0) {
          for (let i = cardIdx - 1; i >= 0; i--) if (abCueToChunk[i] >= 0) { chunkIdx = abCueToChunk[i]; break; }
          if (chunkIdx < 0) {
            for (let i = cardIdx + 1; i < abCueToChunk.length; i++) if (abCueToChunk[i] >= 0) { chunkIdx = abCueToChunk[i]; break; }
          }
        }
      }
    }
    // Deck-based card: search by card text.
    if (chunkIdx < 0 && Array.isArray(window.allNotes)) {
      const card = window.allNotes[cardIdx];
      if (card?.expression) {
        const target = normalizeText(textWithoutRubyFromHtml(card.expression));
        if (target) chunkIdx = findContainsFrom(target, 0);
      }
    }
    if (chunkIdx >= 0) {
      lastMatchedIdx = chunkIdx;
      // Mirror current position to localStorage so the library card
      // progress % updates as the user swipes through cards — same
      // metric setActive() writes when scrolling the reader.
      try {
        const el = chunks[chunkIdx];
        const deck = currentDeckName();
        if (el && deck && currentEpubName) {
          const off = parseInt(el.dataset.jpOff) || 0;
          const len = parseInt(el.dataset.jpLen) || 0;
          localStorage.setItem('READING_POS_' + deck + '_' + currentEpubName,
                               String(off + len));
        }
      } catch (e) {}
    }
  };

  window.closeReadingMode = async function () {
    rlog('Closing reading mode');
    await stopTimer();
    stopPlayStatePoll();
    stopInactivityWatcher();
    await setPref(KEYS.MODE_OPEN, 'false');
    document.getElementById('readingModeView').style.display = 'none';
  };

  window.pickReadingEpub = pickReadingEpub;
  window.syncReadingToCard = syncReadingToCard;

  window.openReadingSettings = async function () {
    const modal = document.getElementById('readingSettingsModal');
    modal.style.display = 'flex';
    const fontSelect = document.getElementById('readerFontSelect');
    const sizeSlider = document.getElementById('readerFontSizeSlider');
    const sizeLabel = document.getElementById('readerFontSizeLabel');
    const verticalToggle = document.getElementById('readerVerticalToggle');
    const autoToggle = document.getElementById('readerAutoAdvanceToggle');
    const hiInput = document.getElementById('readerHighlightColor');
    const savedFont = (await getPref(KEYS.FONT)) || 'serif';
    // Font size now comes from the appearance system (the paged reader
    // reads --font-size-read which appearance.js writes), not the
    // legacy KEYS.FONT_SIZE pref. Slider oninput writes back through
    // window.appearance.set('read', {fontSize: ...}).
    let savedSize = 1.875; // matches appearance.js DEFAULTS.read.fontSize
    try {
      const appearanceRead = window.appearance?.get?.('read');
      const remStr = appearanceRead?.fontSize || '';
      const parsed = parseFloat(remStr);
      if (Number.isFinite(parsed) && parsed > 0) savedSize = parsed;
    } catch (_) {}
    fontSelect.value = savedFont;
    if (fontSelect.value !== savedFont) {
      const opt = document.createElement('option');
      opt.value = savedFont;
      opt.textContent = savedFont;
      fontSelect.appendChild(opt);
      fontSelect.value = savedFont;
    }
    sizeSlider.value = savedSize;
    sizeLabel.textContent = savedSize.toFixed(2) + 'rem';
    if (verticalToggle) {
      verticalToggle.checked = (await getPref(KEYS.VERTICAL)) === 'true';
    }
    const speedSlider = document.getElementById('readerSpeedSlider');
    const speedLabel = document.getElementById('readerSpeedLabel');
    if (speedSlider) {
      // Reuse the main AUDIO_SPEED pref so deck-view + reading stay in sync.
      let saved = parseFloat(await (async () => {
        if (isCap() && window.Capacitor?.Plugins?.Preferences) {
          const r = await window.Capacitor.Plugins.Preferences.get({ key: 'AUDIO_SPEED' });
          return r.value;
        }
        return localStorage.getItem('AUDIO_SPEED');
      })());
      if (!Number.isFinite(saved) || saved <= 0) saved = 1;
      if (saved > 2) saved = 2; // slider max
      speedSlider.value = saved;
      if (speedLabel) speedLabel.textContent = saved.toFixed(2) + '×';
    }
    if (autoToggle) {
      const auto = await getPref(KEYS.AUTO_ADVANCE);
      autoToggle.checked = auto !== 'false';
    }
    // Audiobook + SRT pairing button labels — show paired filename if any.
    const deckNow = currentDeckName();
    const audioBtn = document.getElementById('readerPickAudiobookBtn');
    if (audioBtn) {
      const ab = deckNow ? await getAudiobookPairing(deckNow) : null;
      audioBtn.textContent = ab ? ab.name : 'Pick Audiobook';
    }
    const srtBtn = document.getElementById('readerPickSrtBtn');
    if (srtBtn) {
      const sr = deckNow ? await getSrtPairing(deckNow) : null;
      srtBtn.textContent = sr ? `📄 ${sr.name}` : '📄 Pick SRT';
    }
    if (hiInput) {
      const saved = (await getPref(KEYS.HIGHLIGHT)) || DEFAULT_HIGHLIGHT;
      hiInput.value = saved;
      // Wire preset swatches once.
      if (!modal.dataset.presetsWired) {
        modal.querySelectorAll('.hl-preset').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            const c = btn.getAttribute('data-color');
            hiInput.value = c;
            applyHighlightColor(c);
          });
        });
        hiInput.addEventListener('input', () => applyHighlightColor(hiInput.value));
        modal.dataset.presetsWired = '1';
      }
    }
  };

  // Live update from the slider oninput — applies immediately to current audio
  // but does NOT persist until Save is pressed.
  window.setReadingPlaybackRateLive = function (rate) {
    const label = document.getElementById('readerSpeedLabel');
    if (label) label.textContent = rate.toFixed(2) + '×';
    if (typeof window.setReadingPlaybackRate === 'function') {
      window.setReadingPlaybackRate(rate);
    }
  };

  window.closeReadingSettings = function () {
    document.getElementById('readingSettingsModal').style.display = 'none';
  };

  window.saveReadingSettings = async function () {
    const font = document.getElementById('readerFontSelect').value;
    const size = document.getElementById('readerFontSizeSlider').value;
    const verticalToggle = document.getElementById('readerVerticalToggle');
    const autoToggle = document.getElementById('readerAutoAdvanceToggle');
    const hiInput = document.getElementById('readerHighlightColor');
    const speedSlider = document.getElementById('readerSpeedSlider');
    const vertical = !!(verticalToggle && verticalToggle.checked);
    const auto = autoToggle ? !!autoToggle.checked : true;
    const hi = (hiInput && hiInput.value) || DEFAULT_HIGHLIGHT;
    await setPref(KEYS.FONT, font);
    await setPref(KEYS.FONT_SIZE, size);
    await setPref(KEYS.VERTICAL, vertical ? 'true' : 'false');
    await setPref(KEYS.AUTO_ADVANCE, auto ? 'true' : 'false');
    await setPref(KEYS.HIGHLIGHT, hi);
    if (speedSlider) {
      const r = parseFloat(speedSlider.value) || 1;
      await setPref('AUDIO_SPEED', String(r));
      if (typeof window.setReadingPlaybackRate === 'function') {
        window.setReadingPlaybackRate(r);
      }
    }
    document.documentElement.style.setProperty('--reader-font', font);
    document.documentElement.style.setProperty('--reader-font-size', size + 'rem');
    applyVertical(vertical);
    applyHighlightColor(hi);
    window.readingAutoAdvance = auto;
    if (lastMatchedIdx >= 0 && chunks[lastMatchedIdx]) {
      chunks[lastMatchedIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    window.closeReadingSettings();
  };

  applyFontPrefs();

  // Auto-restore reading mode if it was open when the app was last closed.
  // Wait briefly for the deck to be restored so syncReadingToCard has data.
  (async function maybeRestoreReadingMode() {
    try {
      const wasOpen = (await getPref(KEYS.MODE_OPEN)) === 'true';
      if (!wasOpen) return;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (Array.isArray(window.allNotes) && window.allNotes.length > 0) break;
        await new Promise(r => setTimeout(r, 200));
      }
      if (typeof window.openReadingMode === 'function') {
        rlog('Auto-restoring reading mode');
        window.openReadingMode();
      }
    } catch (e) {
      console.warn('Reading-mode restore failed:', e);
    }
  })();
})();
