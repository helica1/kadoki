// video-mode.js — visionOS video Titles.
//
// A video file is stored as the Title's AUDIOBOOK attachment (a video is "an
// audiobook whose file has pictures"), so every audio-mode path — the cue
// engine, dictionary word overlays, transport ornament, resume floors, SRT
// cards, AudioSlicer clips — works unchanged. Natively, BackgroundAudioPlugin
// sniffs the file extension and plays video files through an AVPlayer engine
// instead of AVAudioPlayer; this module's only job is the PICTURE:
//
//   • detect when the active Title's audiobook attachment is a video
//     (body.kadoki-video-title),
//   • keep a 16:9 anchor element in the audio view's layout and stream its
//     rect to native (BackgroundAudio.videoSurface) so the RealityKit video
//     plane sits exactly there,
//   • hide the plane whenever anything should draw over it (other modes,
//     modal overlays, screen off) — RealityKit content always wins over the
//     webview, so "hide" is the only way to let DOM overlays show,
//   • own the AI-3D (stereo) toggle state (localStorage KADOKI_VIDEO_3D),
//     surfaced on the transport ornament's cube button in audio mode.
//
// Everything here is a no-op off visionOS-native.

(function () {
  // Build stamp — shown once per boot when the video player first appears,
  // so device tests can't silently run a stale binary (installs do NOT
  // restart a running app). Bump on every video-feature change.
  const KV_BUILD = 'kv50';
  let _stamped = false;
  const VIDEO_RE = /\.(mp4|m4v|mov|3gp|mkv)$/i;
  // Keep in sync with app.js's modal marker list (the ".kai-modal is the
  // GENERIC marker" comment there) — while any of these is open, the video
  // plane must yield the screen.
  const MODAL_SEL = '#preferencesModal, #titleEditModal, #audiobookReentryModal, ' +
    '#readingSettingsModal, #readingStatsModal, .shell-menu, #aiSummaryOverlay, ' +
    '#kcharPopup, #bookmarksOverlay, #kchapterView, #kcharsScreen, ' +
    '#waveformEditorOverlay, .kai-modal';

  // A matching element only counts as a blocking modal when it is actually
  // SHOWING — most of these ids exist permanently in index.html with
  // display:none (the bare querySelector-existence check kept the video plane
  // hidden forever: the black-screen bug #2).
  function modalOpen() {
    const els = document.querySelectorAll(MODAL_SEL);
    for (const el of els) {
      try {
        const cs = getComputedStyle(el);
        if (cs.display !== 'none' && cs.visibility !== 'hidden' &&
            (el.offsetWidth > 0 || el.offsetHeight > 0)) return true;
      } catch (_) {}
    }
    return false;
  }

  let _isVideoTitle = false;
  let _checkedTitleId; // undefined → the first tick always runs (null = "no title" is a real state)
  let _lastSent = '';
  let _pollId = 0;

  function bg() {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundAudio) || null;
  }
  // Video now runs on visionOS AND iPhone/iPad (iOS gets the FLAT path:
  // AVPlayerLayer under the webview, no stereo — see KadokiVideoIOS.swift).
  // Vision reports platform 'ios' too, so this is one combined gate; Android
  // stays off (no native video layer there yet).
  // Native picture layer: visionOS (RealityKit plane), iOS (AVPlayerLayer
  // under the WebView) and Android (ExoPlayer TextureView under the WebView).
  function isPhonePlatform() {
    const p = window.Capacitor?.getPlatform?.();
    return p === 'ios' || p === 'android';
  }
  function nativeVideoOk() {
    return !!window.KADOKI_VISION_NATIVE || isPhonePlatform();
  }
  // iPhone (not iPad, not Vision): the header has no room for a permanent
  // VIDEO pill — it appears only while a video Title is active, where it
  // REPLACES the hidden AUDIO tab (zero extra width).
  let _isPhone = false;
  function isVideoName(n) { return VIDEO_RE.test(n || ''); }
  function stereoOn() { try { return localStorage.getItem('KADOKI_VIDEO_3D') === '1'; } catch (_) { return false; } }

  // ---------- active-title detection ----------

  let _seriesInfo = { idx: 0, count: 0 };
  async function refreshTitleFlag() {
    const tid = window._activeTitleId || null;
    if (tid === _checkedTitleId) return;
    _checkedTitleId = tid;
    let vid = false;
    try {
      const t = tid && window.titleStore?.get ? await window.titleStore.get(tid) : null;
      const ab = t?.attachments?.audiobook;
      vid = !!(ab && (ab.isVideo || isVideoName(ab.name) || isVideoName(ab.cachePath)));
      const series = t?.attachments?.series;
      if (vid && Array.isArray(series) && series.length > 1) {
        const i = series.findIndex((e) => e?.video?.name === ab.name);
        _seriesInfo = { idx: (i >= 0 ? i : 0) + 1, count: series.length };
      } else {
        _seriesInfo = { idx: 0, count: 0 };
      }
    } catch (_) {}
    if (vid !== _isVideoTitle) {
      _isVideoTitle = vid;
      document.body.classList.toggle('kadoki-video-title', vid);
      _lastSent = ''; // force a fresh surface push
      if (vid && !_stamped) { _stamped = true; try { window.showToast?.(KV_BUILD, 2000); } catch (_) {} }
    }
    syncTabs();
  }

  // ---------- VIDEO mode pill ----------

  // For a video Title the audio view IS the video player, so the header shows
  // a VIDEO pill (left of CARD) instead of AUDIO. Underlying shell mode stays
  // 'audio' — every existing mode path is untouched; this is presentation only.
  function ensureVideoTab() {
    let tab = document.getElementById('kvVideoTab');
    if (tab) return tab;
    // Sits where AUDIO used to be (which it replaces) — CARD stays leftmost,
    // matching every other Title's tab order instead of jumping to the front.
    const audioTab = document.querySelector('#shellModeTabs .mode-tab[data-mode="audio"]');
    if (!audioTab || !audioTab.parentNode) return null;
    tab = document.createElement('button');
    tab.id = 'kvVideoTab';
    tab.className = 'mode-tab';
    tab.dataset.mode = 'video';
    tab.style.display = 'none';
    tab.textContent = (window.i18n && window.i18n.t) ? window.i18n.t('nav.mode_video', 'VIDEO') : 'VIDEO';
    tab.addEventListener('click', () => {
      try {
        if (_isVideoTitle) { window.setShellMode?.('audio', { force: true }); return; }
        // No video title active: the pill is the entry point for creating one.
        if (confirm('No video loaded.\nImport a folder of videos + subtitles (one Title per movie, one Title per season)?')) {
          window.importFolder?.();
        }
      } catch (_) {}
    });
    audioTab.parentNode.insertBefore(tab, audioTab);
    return tab;
  }

  function syncTabs() {
    const tab = ensureVideoTab();
    const audioTab = document.querySelector('#shellModeTabs .mode-tab[data-mode="audio"]');
    if (!tab) return;
    // Always visible on Vision/iPad; faded (data-empty) when the active title
    // has no video. iPhone: no header room — the pill only exists while a
    // video Title is active (it replaces the hidden AUDIO tab).
    tab.style.display = (_isPhone && !_isVideoTitle) ? 'none' : '';
    if (_isVideoTitle) {
      delete tab.dataset.empty;
      if (audioTab) audioTab.style.display = 'none';
      // shell.js updateTabsUI never matches data-mode="video", so it clears
      // our active marker on every mode switch — reassert from the body class.
      if (document.body.classList.contains('mode-audio')) tab.dataset.active = '1';
      else delete tab.dataset.active;
    } else {
      tab.dataset.empty = '1';
      delete tab.dataset.active;
      if (audioTab) audioTab.style.display = '';
    }
    tab.textContent = (window.i18n && window.i18n.t) ? window.i18n.t('nav.mode_video', 'VIDEO') : 'VIDEO';
    syncReplayBtn();
  }

  // ---------- series (one Title = a folder of episodes) ----------

  let _advancing = false;
  let _lastAdvanceTs = 0;

  async function prefSet(key, value) {
    try {
      if (window.Capacitor?.Plugins?.Preferences) {
        await window.Capacitor.Plugins.Preferences.set({ key, value: String(value) });
      } else localStorage.setItem(key, String(value));
    } catch (_) {}
  }

  // Step to the episode at series[current + step] (step = 1 → next). Points
  // the title's audiobook/srt attachments at it, wipes the finished episode's
  // resume position (the per-title prefs are keyed by NAME, not URL — leaking
  // them into the new file would be a place bug), reloads the title through
  // the proven Library-open path, and autoplays from 0.
  // Per-episode resume position lives on the series entry itself
  // (series[i].lastPosMs), NOT the shared per-title pref key that used to be
  // zeroed on every switch — that key is one slot shared by ALL episodes, so
  // there was never any real "each episode remembers its own place" to begin
  // with. Reading/writing it round-trips through titleStore (durable, travels
  // with Drive sync like the rest of the Title's attachments).
  async function saveCurrentEpisodePosition(tid, series) {
    try {
      const t = await window.titleStore.get(tid);
      const curName = t?.attachments?.audiobook?.name || '';
      const idx = series.findIndex((e) => e?.video?.name === curName);
      if (idx < 0) return;
      const st = await bg()?.getState?.();
      const ms = Math.max(0, Math.round(st?.positionMs || 0));
      // Only overwrite when we have a real, meaningfully-advanced reading —
      // a 0/undefined getState() (engine not ready yet) must not stomp a
      // previously-saved further-along position.
      if (!(ms > 0)) return;
      const next = series.slice();
      next[idx] = Object.assign({}, next[idx], { lastPosMs: ms });
      await window.titleStore.attach(tid, 'series', next);
    } catch (_) {}
  }

  // targetMs: explicit seek target (the user picked a specific subtitle in
  // the browser) — overrides the episode's own saved resume position, which
  // is otherwise the default (so switching away and back lands where you
  // left off, not at 0).
  async function advanceEpisodeTo(targetIdx, autoplay, force, targetMs) {
    if (_advancing) return false;
    if (!force && Date.now() - _lastAdvanceTs < 15000) return false;
    _lastAdvanceTs = Date.now();
    const tid = window._activeTitleId;
    if (!tid || !window.titleStore?.get) return false;
    const t = await window.titleStore.get(tid);
    const series = t?.attachments?.series;
    if (!Array.isArray(series) || series.length < 2) return false;
    const next = series[targetIdx];
    if (!next || !next.video) return false;
    _advancing = true;
    try {
      await saveCurrentEpisodePosition(tid, series);
      try { window.showToast?.(`Episode ${targetIdx + 1}/${series.length}: ${next.video.name}`, 3000); } catch (_) {}
      const abAtt = { uri: next.video.uri, name: next.video.name, isVideo: true };
      if (next.video.cachePath) abAtt.cachePath = next.video.cachePath;
      await window.titleStore.attach(tid, 'audiobook', abAtt);
      if (next.srt) {
        const srtAtt = { uri: next.srt.uri, name: next.srt.name };
        if (next.srt.cachePath) srtAtt.cachePath = next.srt.cachePath;
        await window.titleStore.attach(tid, 'srt', srtAtt);
      } else await window.titleStore.detach(tid, 'srt');
      try { await window.titleStore.setCardIndex(tid, 0, 0); } catch (_) {}
      const fresh = await window.titleStore.get(tid);
      if (fresh) fresh.lastMode = 'audio';
      await window.loadTitleFromLibrary?.(fresh || t);
      // startMs: explicit seek wins; else this episode's own saved place;
      // else 0 (never visited). Persisted under the per-title pseudo key
      // too so the rest of the resume machinery (cold boot, handoff) agrees.
      const startMs = Number.isFinite(targetMs) ? Math.max(0, Math.round(targetMs))
                     : (Number.isFinite(next.lastPosMs) ? next.lastPosMs : 0);
      const pseudo = t.attachments?.deck?.name || t.name;
      await prefSet('READING_AUDIO_LAST_POS_' + pseudo, String(startMs));
      await prefSet('READING_AUDIO_LAST_CHUNK_' + pseudo, '0');
      try { await bg()?.clearSavedPosition?.(); } catch (_) {}
      if (autoplay) {
        const t2 = await window.titleStore.get(tid);
        const path = t2?.attachments?.audiobook?.cachePath;
        if (!path) {
          try { window.showToast?.('Episode file not ready — try again from the browser in a moment.', 4000); } catch (_) {}
        } else {
          const rate = (window.getActivePlaybackRate && window.getActivePlaybackRate()) || 1.0;
          try {
            await bg()?.play?.({ url: path, startMs, rate, fadeMs: 150 });
          } catch (e) {
            try { window.showToast?.('Episode playback failed: ' + (e?.message || e), 4000); } catch (_) {}
          }
        }
      }
      _lastAdvanceTs = Date.now();
      _checkedTitleId = undefined; _lastSent = '';
      return true;
    } catch (e) {
      try { window.showToast?.('Episode switch failed: ' + (e?.message || e), 3500); } catch (_) {}
      return false;
    } finally { _advancing = false; }
  }

  async function advanceEpisode(step, autoplay, force) {
    const tid = window._activeTitleId;
    if (!tid || !window.titleStore?.get) return false;
    const t = await window.titleStore.get(tid);
    const series = t?.attachments?.series;
    if (!Array.isArray(series) || series.length < 2) return false;
    const curName = t.attachments?.audiobook?.name || '';
    let idx = series.findIndex((e) => e?.video?.name === curName);
    if (idx < 0) idx = 0;
    return advanceEpisodeTo(idx + step, autoplay, force);
  }

  // ---------- replay-current-subtitle button ----------

  // Small ⟲ bottom-center (card mode's replay zone, video edition): seeks to
  // the start of the current cue and makes sure playback is running.
  function ensureReplayBtn() {
    let b = document.getElementById('kvVideoReplay');
    if (b) return b;
    const view = document.getElementById('audiobookModeView');
    if (!view) return null;
    b = document.createElement('button');
    b.id = 'kvVideoReplay';
    b.type = 'button';
    b.title = 'この字幕をもう一度';
    b.textContent = '⟲';
    b.style.cssText =
      'display:none;position:absolute;left:50%;transform:translateX(-50%);' +
      'bottom:calc(env(safe-area-inset-bottom, 0px) + 26px);width:56px;height:56px;' +
      'border-radius:50%;border:1px solid rgba(255,255,255,.16);' +
      'background:rgba(30,30,30,.55);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);' +
      'color:#ddd;font-size:26px;line-height:1;z-index:40;';
    b.addEventListener('click', (e) => { e.stopPropagation(); replayCurrentCue(); });
    view.appendChild(b);
    return b;
  }

  function syncReplayBtn() {
    // The in-window ⟲ collided with the subtitle panel — replay now lives on
    // the transport ornament (arrow.counterclockwise, video only).
    const b = document.getElementById('kvVideoReplay');
    if (b) b.style.display = 'none';
  }

  async function replayCurrentCue() {
    const p = bg();
    if (!p) return;
    try {
      const st = await p.getState();
      const cues = window.__abCues || [];
      if (cues.length && window.srtParser) {
        const idx = window.srtParser.findCueAtTime(cues, st.positionMs || 0);
        if (idx >= 0) await p.seek({ ms: cues[idx].startMs, fadeMs: 80 });
      }
      if (!st.playing) await p.resume({ fadeMs: 120 });
    } catch (_) {}
  }

  // ---------- layout anchor ----------

  // The anchor replaces the audio view's cover-image slot for video titles
  // (theme.css hides #audiobookCardImage under body.kadoki-video-title). It is
  // pure layout — transparent, non-interactive — native draws the video plane
  // at its rect.
  function ensureAnchor() {
    let el = document.getElementById('kadokiVideoAnchor');
    if (el) return el;
    const content = document.getElementById('audiobookContent');
    if (!content) return null;
    el = document.createElement('div');
    el.id = 'kadokiVideoAnchor';
    el.style.cssText =
      'display:none;width:100%;flex:1 1 auto;min-height:0;align-self:stretch;' +
      'flex-shrink:0;pointer-events:none;border-radius:10px;';
    const cue = document.getElementById('audiobookCueText');
    if (cue) content.insertBefore(el, cue);
    else content.appendChild(el);
    return el;
  }

  // ---------- surface sync ----------

  // iOS-only (Vision is untouched): landscape keeps the SAME picture-above /
  // subtitle-below layout as portrait (consistency, no bleed-through risk
  // from an overlay) but with a much smaller reserved strip — a landscape
  // subtitle box is far WIDER, so the same text wraps to fewer lines, and
  // the screen itself has less spare height to begin with. `landscape` also
  // rides to native so it can drop the frame's corner rounding (true
  // edge-to-edge cinema look) rather than the small-card rounding used
  // everywhere else.
  function isLandscapeOrientation() {
    try { return window.innerWidth > window.innerHeight; } catch (_) { return false; }
  }
  // Drives `kv-ios-landscape` for BOTH the audio-mode cinema layout AND
  // card-video's subtitle stack (below the video in both, per user request —
  // card mode's stack needs a much smaller landscape allowance than audio's
  // single-line cue, so theme.css keys extra rules off this same class).
  function iosCinemaLandscapeActive() {
    return _isVideoTitle && !window.KADOKI_VISION_NATIVE &&
      isPhonePlatform() &&
      (document.body.classList.contains('mode-audio') || cardVideoActive()) &&
      isLandscapeOrientation();
  }

  function computeSurface() {
    // Apply BEFORE measuring the anchor's rect below — the class flip must
    // land before getBoundingClientRect() so the reduced-reserve CSS is
    // already in effect for this tick's measurement.
    let _iosLandscape = false;
    if (!window.KADOKI_VISION_NATIVE) {
      _iosLandscape = iosCinemaLandscapeActive();
      document.body.classList.toggle('kv-ios-landscape', _iosLandscape);
    }
    const inAudio = document.body.classList.contains('mode-audio');
    const inCardVideo = cardVideoActive();
    // "cinema" = conceptually in the video layout, BEFORE the modal check —
    // native uses this (not `visible`) to decide whether to keep the webview
    // transparent. `visible` additionally gates on modalOpen(): a temporary
    // overlay (the hamburger menu, a dialog) should hide the PICTURE, but
    // must NOT un-transparent the webview — doing that was the "screen turns
    // white behind the menu" bug (it reverted to the page's pre-cinema
    // background, e.g. plain white, instead of staying black).
    const cinema = _isVideoTitle && nativeVideoOk() && (inAudio || inCardVideo) && !document.hidden;
    const audioAnchor = ensureAnchor();
    if (audioAnchor) audioAnchor.style.display = (_isVideoTitle && inAudio) ? 'block' : 'none';
    const anchor = inCardVideo ? document.getElementById('kvCardAnchor') : audioAnchor;
    if (!cinema || !anchor) return { visible: false, cinema: false };
    if (modalOpen()) return { visible: false, cinema: true };
    const r = anchor.getBoundingClientRect();
    if (!(r.width > 40 && r.height > 40)) return { visible: false, cinema: true };
    return {
      visible: true, cinema: true,
      x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
      stereo: stereoOn(),
      landscape: _iosLandscape,
      epIndex: _seriesInfo.idx, epCount: _seriesInfo.count,
    };
  }

  let _lastSurf = null;
  // Previous-cue panel is Vision-only (see reading-mode.js's
  // abUpdateCueDisplay for why it's not on iOS — card mode covers that
  // need there instead).
  function _prevCueOk() { return !!window.KADOKI_VISION_NATIVE; }
  function positionCuePanel(surf) {
    if (!document.body.classList.contains('mode-audio')) return;   // card-video has its own stack
    const cue = document.getElementById('audiobookCueText');
    if (!cue) return;
    if (!surf || !surf.visible) {
      // Only UNPIN when the cinema layout itself is gone. A temporary
      // occlusion (hamburger menu, a dialog → visible:false, cinema:true)
      // used to drop the cue back into flow layout — BELOW the hidden cover
      // slot — and re-pin it a tick (≤600ms) after the overlay closed: the
      // "subtitle starts too low, then jumps up" glitch.
      if (surf && surf.cinema && _nativeFrame) return;
      cue.style.position = ''; cue.style.top = ''; cue.style.bottom = ''; cue.style.left = ''; cue.style.transform = '';
      if (_prevCueOk()) {
        const prev = document.getElementById('audiobookPrevCueText');
        if (prev) { prev.style.position = ''; prev.style.bottom = ''; prev.style.left = ''; prev.style.transform = ''; }
      }
      return;
    }
    // RIGHT under the frame (or, in overlay mode, on its lower edge) — the
    // authoritative contained rect comes back from native with true aspect.
    // iOS landscape (2026-08-30): always overlay — the video fills the
    // whole screen there now, so there's no reserved "below" strip to sit
    // in any more (see the kv-ios-landscape reserve in theme.css).
    // Before native has ever answered for this surface, _nativeFrame is a
    // PREDICTION (sync() aspect-fits the requested rect) so the cue is
    // pinned in the very same frame the layout appears — never a first
    // paint in flow layout followed by a jump.
    const f = _nativeFrame;
    if (f && f.h > 1) {
      const overlay = document.body.classList.contains('kv-subplace-overlay') ||
        (!window.KADOKI_VISION_NATIVE && document.body.classList.contains('kv-ios-landscape'));
      cue.style.position = 'fixed';
      cue.style.left = '50%';
      cue.style.transform = 'translateX(-50%)';
      if (overlay) {
        // Overlay: anchor the panel's BOTTOM edge to the film's lower edge.
        // Height-independent — a taller cue grows UPWARD by construction, so
        // a new line never renders top-anchored-too-low for a tick before
        // being re-measured and moved up.
        const bottom = Math.max(0, Math.round(window.innerHeight - (f.y + f.h) + 20));
        cue.style.top = '';
        cue.style.bottom = bottom + 'px';
      } else {
        const top = f.y + f.h + 10;
        cue.style.bottom = '';
        cue.style.top = Math.round(Math.min(top, window.innerHeight - 70)) + 'px';
      }
      // Previous-cue panel: bottom-anchored just above the current cue's
      // TOP edge, so it grows upward with its own content height instead
      // of needing to be pre-measured.
      if (_prevCueOk()) {
        const prev = document.getElementById('audiobookPrevCueText');
        if (prev && prev.textContent) {
          const cueTop = Math.round(cue.getBoundingClientRect().top);
          prev.style.position = 'fixed';
          prev.style.left = '50%';
          prev.style.transform = 'translateX(-50%)';
          prev.style.bottom = Math.round(window.innerHeight - cueTop + 8) + 'px';
        }
      }
    } else if (_prevCueOk()) {
      const prev = document.getElementById('audiobookPrevCueText');
      if (prev) { prev.style.position = ''; prev.style.bottom = ''; prev.style.left = ''; prev.style.transform = ''; }
    }
    try {
      const cr = cue.getBoundingClientRect();
      const now = Date.now();
      if ((!cr.width || !cr.height || cr.top >= window.innerHeight || cr.bottom <= 0) &&
          (!positionCuePanel._warnAt || now - positionCuePanel._warnAt > 60000)) {
        positionCuePanel._warnAt = now;
        window.showToast?.('subs diag: rect ' + Math.round(cr.left) + ',' + Math.round(cr.top) + ' ' +
          Math.round(cr.width) + 'x' + Math.round(cr.height), 5000);
      }
    } catch (_) {}
  }

  let _lastSendTs = 0;
  let _nativeFrame = null;   // authoritative contained rect from native
  // Last aspect native actually rendered (updated from every frame reply;
  // 16:9 until then). Used to PREDICT where the picture will land inside a
  // freshly requested surface rect — native's AVPlayerLayer is .resizeAspect
  // and centres, so the contained rect is pure geometry.
  let _videoAspect = 16 / 9;
  function predictFrame(s) {
    if (!s || !s.visible || !(s.w > 1 && s.h > 1)) return null;
    let fw = s.w, fh = s.w / _videoAspect;
    if (fh > s.h) { fh = s.h; fw = s.h * _videoAspect; }
    return { x: s.x + (s.w - fw) / 2, y: s.y + (s.h - fh) / 2, w: fw, h: fh, predicted: true };
  }
  // Card mode's #kvCardAnchor is otherwise a flex:1 placeholder — TALLER
  // than the video actually renders, so native's AVPlayerLayer (always
  // .resizeAspect, which CENTERS within whatever frame it's given) put
  // equal-ish blank space above AND below the picture instead of the
  // "video at top" layout. Shrinking the anchor to the video's own
  // aspect-fit height BEFORE it's measured/sent removes the slack that
  // centering had to work with, so the video lands at the top by
  // construction. Starts at a 16:9 guess (true for the near-totality of
  // video Titles) and self-corrects to the real aspect once native's first
  // response reports it.
  let _cardAspect = 16 / 9;
  function sizeCardAnchor() {
    if (!cardVideoActive()) return;
    const anchor = document.getElementById('kvCardAnchor');
    if (!anchor) return;
    if (isLandscapeOrientation()) {
      // Landscape screens are WIDER than 16:9 (e.g. ~19.5:9), so sizing by
      // WIDTH (portrait's fix, below) computes a height TALLER than the
      // screen actually is — the anchor (and the subtitle pinned off its
      // bottom edge) overflowed past the visible area and got clipped
      // ("bottom of the screen and subtitle is cut off"). Landscape wants
      // the OPPOSITE constraint: an unconstrained (CSS flex:1, see
      // theme.css's kv-ios-landscape override) full-height anchor already
      // makes native's video fill the whole vertical extent correctly, so
      // just clear any leftover inline height from portrait.
      anchor.style.height = '';
      return;
    }
    const f = _nativeFrame;
    if (f && !f.predicted && f.w > 1 && f.h > 1) _cardAspect = f.w / f.h;
    const w = anchor.getBoundingClientRect().width || anchor.parentElement?.getBoundingClientRect().width || 0;
    if (w > 1) anchor.style.height = Math.round(w / _cardAspect) + 'px';
  }
  function sync(force) {
    if (!nativeVideoOk()) return;
    const p = bg();
    if (!p || typeof p.videoSurface !== 'function') return;
    sizeCardAnchor();
    const s = computeSurface();
    const key = JSON.stringify(s);
    // Surface rect changed (title open, mode switch, rotation, overlay
    // closed): the old frame is stale and the new one is a round trip away.
    // Pin the cue NOW against a predicted frame so its first paint is
    // already in the right place; native's reply refines it (same numbers
    // whenever the aspect guess holds, so no visible move).
    if (s.visible && key !== _lastSent) {
      const cur = _lastSurf;
      const rectChanged = !cur || !cur.visible || cur.x !== s.x || cur.y !== s.y || cur.w !== s.w || cur.h !== s.h;
      if (!_nativeFrame || rectChanged) {
        const pf = predictFrame(s);
        if (pf) _nativeFrame = pf;
      }
      _lastSurf = s;
      try { positionCuePanel(s); } catch (_) {}
    }
    // While visible, re-send every ~3s even when unchanged: the native side
    // re-asserts the cinema chrome and refreshes the authoritative frame.
    if (!force && key === _lastSent && !(s.visible && Date.now() - _lastSendTs > 3000)) return;
    _lastSent = key;
    _lastSendTs = Date.now();
    try {
      Promise.resolve(p.videoSurface(s)).then((r) => {
        if (r && Number.isFinite(r.frameW) && r.frameW > 1) {
          _nativeFrame = { x: r.frameX, y: r.frameY, w: r.frameW, h: r.frameH };
          if (r.frameH > 1) _videoAspect = r.frameW / r.frameH;
        }
        // Subtitle placement: on Vision it's a native-side USER pref (set on
        // the ornament's settings card) — apply it as-is. On iOS the class
        // was already set by computeSurface() from screen ORIENTATION
        // (landscape = overlay); the plugin's iOS branch always reports the
        // fixed default "below", so applying it here would immediately
        // stomp the orientation-driven choice back off every tick.
        if (window.KADOKI_VISION_NATIVE && r && r.subPlacement) {
          document.body.classList.toggle('kv-subplace-overlay', r.subPlacement === 'overlay');
        }
        // Subtitle size: on Vision, for a VIDEO title, it's the ornament's
        // own native user pref — apply it. Everywhere else the Appearance
        // panel's audio font-size preference (--font-size-audio, theme.css)
        // must rule: iOS's plugin branch resolves a FIXED default (24), and
        // this handshake runs even for plain audiobooks (to keep the video
        // layer hidden), so stamping that inline (!important) silently
        // overrode the preference on every title — the "audio font too
        // small / size setting does nothing" bug. removeProperty also
        // self-heals a size stamped earlier in the session (the cue element
        // is a singleton that survives title switches).
        {
          const cue = document.getElementById('audiobookCueText');
          if (cue) {
            if (window.KADOKI_VISION_NATIVE && _isVideoTitle &&
                r && Number.isFinite(r.subSize) && r.subSize > 10) {
              cue.style.setProperty('font-size', Math.round(r.subSize) + 'px', 'important');
            } else {
              cue.style.removeProperty('font-size');
            }
          }
        }
        positionCuePanel(s);
        positionCardSubs(s);
        pushSubs();
      }).catch(() => {});
    } catch (_) {}
    _lastSurf = s;
    try { if (localStorage.getItem('KADOKI_VIDEO_DIAG') === '1') window.showToast?.('vs ' + key, 2000); } catch (_) {}
    // Cube button on the transport ornament: shown in audio mode only for
    // video titles; filled per the 3D pref.
    try {
      p.tpState?.({ videoOn: _isVideoTitle && document.body.classList.contains('mode-audio') });
      if (s.visible) p.tpState?.({ spatialOn: !!s.stereo });
    } catch (_) {}
  }

  // Subtitle mirror: stream the cue panel's rect to native so it can
  // snapshot the region into the scene attachment (drawn in FRONT of the
  // video plane — structurally un-occludable).
  let _subsObserved = false;
  // Word elements for the native 3D panel's tap-back: index k → the DOM
  // .kword-hit overlay whose click runs the normal dictionary flow.
  // Two SEPARATE arrays (current / previous line) — a tap on the mirrored
  // previous-cue panel must replay onto the PREVIOUS cue's own DOM element,
  // never the current one, or the Anki context would resolve to the wrong
  // cue's audio.
  let _kvVideoWords = [];
  let _kvVideoWordsPrev = [];
  // Segment one cue element into [text, kwordIndex] runs + the word-element
  // list segs[k] points at. Shared by the current and previous cue mirrors.
  function segmentCueEl(cueEl, wordsOut) {
    const segs = [];
    try {
      const frags = Array.from(cueEl.querySelectorAll('.dict-frag'));
      const hits = Array.from(cueEl.querySelectorAll('.kword-hit'));
      let particle = '';
      for (const node of cueEl.children) {
        if (node.classList && node.classList.contains('kword')) {
          if (particle) { segs.push([particle, '-1']); particle = ''; }
          const k = wordsOut.length;
          const firstFrag = node.querySelector('.dict-frag');
          const fragIdx = firstFrag ? frags.indexOf(firstFrag) : -1;
          const hit = hits.find((h) => h._kwFragStart === fragIdx) || null;
          wordsOut.push(hit || firstFrag || node);
          segs.push([node.textContent || '', String(k)]);
        } else if (node.classList && (node.classList.contains('dict-frag'))) {
          particle += node.textContent || '';
        }
        // absolute helpers (.kword-hit etc.) are skipped
      }
      if (particle) segs.push([particle, '-1']);
    } catch (_) {}
    return segs;
  }
  function pushSubs() {
    const p = bg();
    if (!p || typeof p.videoSubs !== 'function') return;
    const cue = document.getElementById('audiobookCueText');
    // The native panel exists only in AI-3D (RealityKit draws over the page).
    // Flat mode — below OR overlay — is pure DOM now: the video renders UNDER
    // the webview, so the subtitle draws on top with native WebKit gaze glow.
    const mirror = !!(_lastSurf && _lastSurf.visible && _lastSurf.stereo);
    document.body.classList.toggle('kv-subs-native', mirror);
    const text = cue ? (cue.textContent || '').trim() : '';
    if (!mirror || !cue || !text) {
      if (pushSubs._was) { pushSubs._was = false; try { p.videoSubs({ visible: false }); } catch (_) {} }
      return;
    }
    // Hold off until this cue's word-chunking has actually finished (and the
    // previous-cue panel's, if it has content) — abApplyWordChunks wraps
    // words into padded chips a beat AFTER the plain-text render this
    // MutationObserver first fires on. Sending that intermediate plain
    // layout to native, then the chip-wrapped one moments later, made the
    // 3D panel visibly resize/reposition ("jumps down"). Skipping this tick
    // is safe — the wrapping mutation re-triggers the observer itself, so a
    // later tick sends the FINAL layout as the first (and only) thing native
    // ever sees for this cue.
    const prevCueGate = document.getElementById('audiobookPrevCueText');
    const prevTextGate = prevCueGate ? (prevCueGate.textContent || '').trim() : '';
    if (cue._kwDone === false) return;
    if (prevTextGate && prevCueGate._kwDone === false) return;
    pushSubs._was = true;
    const r = cue.getBoundingClientRect();
    if (!(r.width > 1 && r.height > 1)) { try { p.videoSubs({ visible: false }); } catch (_) {} return; }
    _kvVideoWords = [];
    const segs = segmentCueEl(cue, _kvVideoWords);
    const payload = { visible: true, x: r.left, y: r.top, w: r.width, h: r.height, text, segs, hsManage: true };
    // Previous cue, mirrored the same way (visionOS only — the DOM element
    // doesn't exist off Vision, and #audiobookPrevCueText stays
    // visibility:hidden here — still laid out, so its rect is real).
    _kvVideoWordsPrev = [];
    const prevCue = document.getElementById('audiobookPrevCueText');
    const prevText = prevCue ? (prevCue.textContent || '').trim() : '';
    if (prevCue && prevText) {
      const pr = prevCue.getBoundingClientRect();
      if (pr.width > 1 && pr.height > 1) {
        payload.prevText = prevText;
        payload.prevSegs = segmentCueEl(prevCue, _kvVideoWordsPrev);
        payload.prevX = pr.left; payload.prevY = pr.top; payload.prevW = pr.width; payload.prevH = pr.height;
      }
    }
    try { p.videoSubs(payload); } catch (_) {}
  }

  // Native 3D panel word tap → replay as a click on the word's DOM overlay
  // (the document-level cue handler quantizes .kword-hit targets to the word
  // start and runs the full dictionary flow). `prev: true` routes to the
  // PREVIOUS cue's own word list/element, so the dictionary lookup — and the
  // Anki audio range it feeds — resolves against that cue, not the one
  // currently playing.
  window.addEventListener('kadokiVideoWordTap', (e) => {
    try {
      let d = e && e.detail;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = null; } }
      const k = Number((d && d.k) != null ? d.k : e.k);
      const isPrev = !!(d && d.prev);
      const el = isPrev ? _kvVideoWordsPrev[k] : _kvVideoWords[k];
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true,
        clientX: Math.round(r.left + Math.min(8, r.width / 3)),
        clientY: Math.round(r.top + r.height / 2),
      }));
    } catch (_) {}
  });
  function observeSubs() {
    if (_subsObserved) return;
    const cue = document.getElementById('audiobookCueText');
    if (!cue) return;
    _subsObserved = true;
    let t = 0;
    new MutationObserver(() => {
      // New cue text: re-pin in the same frame it renders (the 600ms poll
      // alone let a re-measured position land visibly late).
      try { positionCuePanel(_lastSurf); } catch (_) {}
      clearTimeout(t);
      t = setTimeout(pushSubs, 120);   // after layout + a beat for paint
    }).observe(cue, { childList: true, subtree: true, characterData: true, attributes: true });
  }

  // ---------- iOS/iPad video CARD mode: subtitle stack + video split ----------
  // Left column: the current subtitle large, with 2 before / 2 after dimmed
  // (tap any to jump); right column: the video, anchored for the native
  // layer. Gestures stay app.js's card handlers — swipe left/right = cards,
  // swipe up = send to Anki (waveform endpoint dialog first, then send).
  // visionOS keeps its own card mode (spatial pictures); this is iOS-only.
  // Fewer context rows in landscape — a landscape screen has much less
  // spare height, and the full 2-before/2-after stack squeezed the video
  // down to a tiny letterboxed square there.
  // Portrait: full 2-before/2-after context stack, below the video.
  // Landscape (2026-08-30 redesign — "the image should be the WHOLE
  // SCREEN, subtitle overlaid, not below it"): the video now fills the
  // entire screen and the stack becomes a small floating glass panel over
  // its lower edge (positionCardSubs) — only PREVIOUS + current show, no
  // upcoming line, same reasoning as visionOS's previous-subtitle panel
  // (less gaze-shifting, no next-line spoiler floating over the picture).
  function cardStackBefore() { return isLandscapeOrientation() ? 1 : 2; }
  function cardStackAfter() { return isLandscapeOrientation() ? 0 : 2; }
  let _lastStackIdx = -1;
  let _lastStackLandscape = null;
  function cardVideoActive() {
    return _isVideoTitle && !window.KADOKI_VISION_NATIVE &&
      isPhonePlatform() &&
      document.body.classList.contains('mode-card');
  }
  function ensureCardLayout() {
    if (!cardVideoActive()) {
      if (document.body.classList.contains('kv-card-video')) removeCardLayout();
      return null;
    }
    document.body.classList.add('kv-card-video');
    let el = document.getElementById('kvCardLayout');
    if (!el) {
      el = document.createElement('div');
      el.id = 'kvCardLayout';
      const subs = document.createElement('div'); subs.id = 'kvCardSubs';
      const anch = document.createElement('div'); anch.id = 'kvCardAnchor';
      el.appendChild(subs); el.appendChild(anch);
      document.body.appendChild(el);
      _lastStackIdx = -1;
    }
    return el;
  }
  function removeCardLayout() {
    document.body.classList.remove('kv-card-video');
    document.getElementById('kvCardLayout')?.remove();
    _lastStackIdx = -1;
  }
  function stripHtml(s) {
    const d = document.createElement('div'); d.innerHTML = s || ''; return (d.textContent || '').trim();
  }
  function renderCardStack(force) {
    const el = ensureCardLayout();
    if (!el) return;
    const notes = Array.isArray(window.allNotes) ? window.allNotes : [];
    const idx = Number.isFinite(window.currentCardIndex) ? window.currentCardIndex : 0;
    const landscape = isLandscapeOrientation();
    if (!force && idx === _lastStackIdx && landscape === _lastStackLandscape) return;
    _lastStackIdx = idx; _lastStackLandscape = landscape;
    const before = cardStackBefore(), after = cardStackAfter();
    const subs = el.querySelector('#kvCardSubs');
    if (!subs) return;
    subs.textContent = '';
    for (let i = idx - before; i <= idx + after; i++) {
      const n = notes[i];
      const row = document.createElement('button');
      row.className = 'kv-cs-row' + (i === idx ? ' kv-cur' : '');
      if (!n) { row.classList.add('kv-cs-empty'); subs.appendChild(row); continue; }
      // Timestamps removed per user feedback (2026-08-30) — clutter, not
      // useful once the row itself is tappable to jump there.
      const tx = document.createElement('span');
      tx.textContent = stripHtml(n.expression);
      row.appendChild(tx);
      if (i !== idx) {
        const target = i;
        row.addEventListener('click', () => { try { window.updateCardIndex?.(target); } catch (_) {} });
      }
      subs.appendChild(row);
    }
    // The current card's subtitle words get dictionary lookups like the
    // audio-mode cue panel does — and the EXACT SAME window.lookupContext
    // shape the audiobook/video-tab click handler builds (reading-mode.js
    // installAudiobookCueTapHandler), so the shared Anki-send plumbing in
    // enhanced-dictionary.js (waveform-editor gate, audio slice, video-
    // frame screenshot) works identically here. Without this, a tap fell
    // through to performLookup's generic fallback — no cueAudioPath, so
    // the waveform gate silently failed (no audio ever reached Anki) — and
    // its sentence came from `.subtitle-text`, a STALE element left over
    // from normal (non-video) card mode (hidden, not removed, while
    // kv-card-video is active), explaining the wrong/combined text.
    // dictKeepCtx tells dictEnableLookupInLazy's tap handler not to null
    // this out before the lookup runs (same flag the lookup-history viewer
    // uses to pre-bind its own context) — safe here because `cur` is a
    // FRESH element every time currentCardIndex actually changes (the
    // early-return above skips re-render, and thus re-binding, when it
    // hasn't), so the context can never point at the wrong card.
    try {
      const cur = subs.querySelector('.kv-cur');
      const n = notes[idx];
      if (cur && n && n.isSrtCard) {
        window.lookupContext = {
          source: 'card',
          card: null,
          cardIdx: idx,
          sentence: stripHtml(n.expression),
          cueAudioPath: n.audiobookPath || null,
          cueStartMs: Number.isFinite(n.audiobookStartMs) ? n.audiobookStartMs : null,
          cueEndMs:   Number.isFinite(n.audiobookEndMs)   ? n.audiobookEndMs   : null,
          cueIndex:   Number.isFinite(n.cueIndex) ? n.cueIndex : -1,
        };
        cur.dataset.dictKeepCtx = '1';
      }
      if (cur && typeof window.dictEnableLookupIn === 'function') window.dictEnableLookupIn(cur);
    } catch (_) {}
  }

  // Pin #kvCardSubs to the video's TRUE rendered rect (native-reported
  // _nativeFrame), not the oversized #kvCardAnchor box — the anchor is a
  // flex:1 placeholder that claims all leftover height so native has room
  // to letterbox into, but the actual video pixels only fill part of it;
  // stacking the subtitle below the ANCHOR's outer edge (the old approach)
  // left a big dead gap under the picture. Portrait: hug the video's real
  // bottom edge, edge-to-edge width (unchanged look, just correctly
  // positioned). Landscape: full floating glass overlay on the video's own
  // lower edge — the video fills the whole screen there now (theme.css's
  // kv-ios-landscape reserve was cut to ~0), so there's no "below" region
  // left to stack into at all.
  function positionCardSubs(surf) {
    if (!cardVideoActive()) return;
    const subs = document.getElementById('kvCardSubs');
    if (!subs) return;
    if (!surf || !surf.visible) {
      subs.style.position = ''; subs.style.top = ''; subs.style.bottom = '';
      subs.style.left = ''; subs.style.right = ''; subs.style.transform = '';
      return;
    }
    const f = _nativeFrame;
    if (!f || f.h <= 1) return;
    subs.style.position = 'fixed';
    if (isLandscapeOrientation()) {
      subs.style.left = '50%';
      subs.style.right = '';
      subs.style.transform = 'translateX(-50%)';
      subs.style.top = '';
      subs.style.bottom = Math.round(window.innerHeight - (f.y + f.h) + 20) + 'px';
    } else {
      subs.style.left = '14px';
      subs.style.right = '14px';
      subs.style.transform = '';
      subs.style.bottom = '';
      subs.style.top = Math.round(f.y + f.h + 8) + 'px';
    }
  }

  // Episode/subtitle browser entry point (iOS): a "Episodes…" row in the
  // real hamburger menu (shell.js openShellMoreMenu), not a bespoke header
  // button — a second icon next to the real hamburger read as a second,
  // non-functional "hamburger" sitting in an unrelated spot. visionOS still
  // reaches it from the transport ornament's dedicated button.

  // Force the real #appHeader visible the moment a video Title's audio/card
  // layout becomes active (iOS only — Vision's ornament is the equivalent
  // there and is unaffected by chrome-hidden). Fires once per ENTRY (the
  // false→true edge), not every tick, so a user who deliberately hides
  // chrome afterward can still do so — this only guarantees a known-good
  // default so the header/hamburger is never stuck invisible on arrival.
  let _chromeCtxWasActive = false;
  function forceShowChromeIfNeeded() {
    if (window.KADOKI_VISION_NATIVE) return;
    const active = _isVideoTitle && (document.body.classList.contains('mode-audio') || cardVideoActive());
    if (active && !_chromeCtxWasActive) {
      try { window.shellShowChrome?.(); } catch (_) {}
    }
    _chromeCtxWasActive = active;
  }

  async function tick() {
    await refreshTitleFlag();
    sync(false);
    // Reposition every tick (not only on surface re-sends): the cue panel's
    // placement depends on layout that can move without the surface changing.
    try { positionCuePanel(_lastSurf); } catch (_) {}
    try { observeSubs(); pushSubs(); } catch (_) {}
    try { renderCardStack(false); } catch (_) {}
    try { forceShowChromeIfNeeded(); } catch (_) {}
  }

  // ---------- 3D toggle (transport cube, audio mode) ----------

  // Returns true when the toggle was handled here (audio mode + video title),
  // so reading-mode.js's 'spatial' action can fall through to the card-mode
  // spatial-pictures toggle otherwise.
  function maybeToggle3d() {
    if (!window.KADOKI_VISION_NATIVE) return false;   // stereo is Vision-only; iOS is flat
    if (!_isVideoTitle || !document.body.classList.contains('mode-audio')) return false;
    const next = !stereoOn();
    try { localStorage.setItem('KADOKI_VIDEO_3D', next ? '1' : '0'); } catch (_) {}
    try { window.showToast?.(next ? '3D: on' : '3D: off', 1400); } catch (_) {}
    sync(true);
    return true;
  }

  function start() {
    if (_pollId) return;
    // The ornament's 辞書 toggle is gone — dictionary lookups are always on.
    // Clear any previously persisted "off" so old sessions can't boot dark.
    try {
      if (localStorage.getItem('AB_DICT_LOOKUP') === '0') {
        localStorage.setItem('AB_DICT_LOOKUP', '1');
        setTimeout(() => { try { window.tpApplyDict?.(); } catch (_) {} }, 1200);
      }
    } catch (_) {}
    _pollId = setInterval(tick, 600);
    window.addEventListener('resize', () => sync(true));
    document.addEventListener('visibilitychange', () => sync(true));
    // Mode switches: reassert the VIDEO pill's active state immediately
    // (shell's updateTabsUI clears it) and re-aim the surface without waiting
    // for the poll.
    new MutationObserver(() => { syncTabs(); sync(false); })
      .observe(document.body, { attributes: true, attributeFilter: ['class'] });
    // Playback started/stopped: re-push the surface. The native side also
    // recomputes visibility when it adopts a player, so this is belt+braces
    // against the deduped one-shot videoSurface race.
    try { bg()?.addListener?.('state', () => setTimeout(() => sync(true), 80)); } catch (_) {}
    // Series auto-advance: natural end of an episode → next episode + its
    // subtitle, playing. Gated to the video player being on screen so a stale
    // replayed 'ended' from a suspended bridge can't hop episodes silently.
    try {
      bg()?.addListener?.('ended', () => {
        if (!_isVideoTitle) return;
        if (!document.body.classList.contains('mode-audio')) return;
        setTimeout(async () => {
          try {
            // Only a genuine end-of-file advances (a stale replayed 'ended'
            // or an error-path emission must not chain-skip episodes).
            const st = await bg()?.getState?.();
            if (st && st.durationMs > 60000 && st.positionMs < st.durationMs - 8000) return;
          } catch (_) {}
          advanceEpisode(1, true);
        }, 400);
      });
    } catch (_) {}
  }

  // ---------- episode / subtitle browser (DOM overlay) ----------
  //
  // Opened from the transport ornament. A .kai-modal overlay, so the native
  // video plane auto-hides (modalOpen()) and the whole browser is ordinary
  // DOM: episode chips on top, a vertically scrolling subtitle list with
  // timestamps below — tap a line to jump there, tap an episode to switch.

  function fmtMs(ms) {
    const st = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(st / 3600), mn = Math.floor((st % 3600) / 60), sc = st % 60;
    return h > 0 ? `${h}:${String(mn).padStart(2, '0')}:${String(sc).padStart(2, '0')}`
                 : `${mn}:${String(sc).padStart(2, '0')}`;
  }

  // Read + parse an episode's SRT WITHOUT touching playback/titleStore — a
  // pure preview so browsing other episodes' subtitle lists never disturbs
  // what's actually playing. Same materialize→fetch→parse path
  // reading-mode.js uses for the real load, just not wired into it.
  async function loadEpisodeCues(ep) {
    try {
      if (!ep?.srt) return [];
      // Prefer an already-resolved cachePath (no materialize round-trip —
      // also the ONLY thing the simulator demo harness's synthetic series
      // entries carry, they have no real document-picker `uri`). Fall back
      // to materializing from `uri` for a real, never-opened episode.
      let path = ep.srt.cachePath;
      if (!path && ep.srt.uri) {
        const fa = window.Capacitor?.Plugins?.FileAccess;
        if (!fa) return [];
        const mat = await fa.materializeToCache({ uri: ep.srt.uri });
        path = mat?.path;
      }
      if (!path) return [];
      const url = window.Capacitor?.convertFileSrc ? window.Capacitor.convertFileSrc(path) : 'file://' + path;
      const res = await fetch(url);
      if (!res.ok) return [];
      const text = await res.text();
      return window.srtParser?.parseSrt?.(text) || [];
    } catch (_) { return []; }
  }

  async function openBrowser() {
    closeBrowser();
    const tid = window._activeTitleId;
    const t = tid && window.titleStore?.get ? await window.titleStore.get(tid) : null;
    const series = t?.attachments?.series;
    const curName = t?.attachments?.audiobook?.name || '';
    const curIdx = Array.isArray(series) ? series.findIndex((e) => e?.video?.name === curName) : -1;
    // previewIdx: which episode's cue list is SHOWING — starts on the
    // playing one. Tapping a chip only changes THIS (a look, not a switch);
    // only tapping an actual subtitle row commits to a real episode change.
    let previewIdx = curIdx >= 0 ? curIdx : 0;
    const ov = document.createElement('div');
    ov.id = 'kvEpBrowser';
    ov.className = 'kai-modal';
    // FULLY opaque (no alpha) — a translucent backdrop let the live subtitle
    // panel and #appHeader "shine through" behind it. safe-area-top padding
    // on the title row so the notch/status bar never overlaps it.
    ov.style.cssText =
      'position:fixed;inset:0;z-index:9400;background:#0a0a0a;display:flex;' +
      'flex-direction:column;color:#eee;font-family:var(--font-sans,system-ui);direction:ltr;';
    // Title row: name + the app's STANDARD close button (rounded-rect, matches
    // every other overlay's ✕ — a big circle the same size as the episode
    // chips below read as just another chip, not a close control).
    const titleRow = document.createElement('div');
    titleRow.style.cssText =
      'display:flex;align-items:center;gap:14px;flex-shrink:0;' +
      'padding:calc(14px + env(safe-area-inset-top,0px)) 20px 12px;' +
      'border-bottom:1px solid #222;';
    const title = document.createElement('div');
    title.textContent = t?.name || '';
    title.style.cssText = 'font-size:17px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    titleRow.appendChild(title);
    const close = document.createElement('button');
    close.textContent = '✕';
    close.style.cssText =
      'flex-shrink:0;background:none;border:1px solid #333;border-radius:8px;color:#ccc;' +
      'font-size:1.1rem;padding:7px 14px;line-height:1.1;';
    // Closing WITHOUT picking a subtitle is a pure "look" — nothing changes,
    // even if the user previewed a different episode's list on the way out.
    close.addEventListener('click', closeBrowser);
    titleRow.appendChild(close);
    ov.appendChild(titleRow);

    const list = document.createElement('div');
    list.id = 'kvEpBrowserList';
    list.style.cssText = 'flex:1;overflow-y:auto;padding:6px 22px calc(30px + env(safe-area-inset-bottom,0px));';

    // Episode chips: their OWN row, in a proper grid so they line up evenly
    // regardless of count instead of an ad-hoc flex-wrap that left the last
    // row ragged.
    let chipEls = [];
    if (Array.isArray(series) && series.length > 1) {
      const chipRow = document.createElement('div');
      chipRow.id = 'kvEpBrowserChips';
      chipRow.style.cssText =
        'display:grid;grid-template-columns:repeat(auto-fill,minmax(46px,1fr));gap:8px;' +
        'padding:12px 20px;border-bottom:1px solid #222;flex-shrink:0;max-height:33vh;overflow-y:auto;';
      series.forEach((ep, i) => {
        const chip = document.createElement('button');
        chip.textContent = String(i + 1);
        chipEls[i] = chip;
        // First tap on a chip only PREVIEWS its subtitle list (no switch —
        // just looking around must never move the actual playhead). Tapping
        // the SAME chip again — now already the preview — confirms: switch
        // to it and resume wherever it was left off (its own saved place,
        // not episode 1's or a re-seek to 0). Picking a specific subtitle
        // (below) is the other way to commit, landing at that exact line
        // instead of the saved place.
        chip.addEventListener('click', async () => {
          if (i === previewIdx && i !== curIdx) {
            chip.textContent = '…';
            const ok = await advanceEpisodeTo(i, true, true);
            if (ok) closeBrowser(); else chip.textContent = String(i + 1);
            return;
          }
          previewIdx = i; paintChips(); renderList();
        });
        chipRow.appendChild(chip);
      });
      ov.appendChild(chipRow);
    }
    function paintChips() {
      chipEls.forEach((chip, i) => {
        const isPlaying = i === curIdx, isPreview = i === previewIdx;
        chip.style.cssText =
          'aspect-ratio:1;border-radius:10px;font-size:16px;font-variant-numeric:tabular-nums;color:#eee;' +
          (isPreview ? 'border:1px solid rgba(147,130,220,.9);' : 'border:1px solid rgba(255,255,255,.14);') +
          'background:' + (isPlaying ? 'rgba(147,130,220,.45)' : isPreview ? 'rgba(147,130,220,.16)' : 'rgba(255,255,255,.06)') + ';';
      });
    }

    const cueCache = new Map();   // episode idx → cues[] (avoid re-fetching on chip flip-flop)
    async function renderList() {
      const myIdx = previewIdx;
      list.textContent = '';
      const loading = document.createElement('div');
      loading.textContent = '…';
      loading.style.cssText = 'padding:40px;text-align:center;color:#666;font-size:17px;';
      list.appendChild(loading);

      let cues;
      if (myIdx === curIdx) {
        cues = Array.isArray(window.__abCues) ? window.__abCues : [];
      } else if (cueCache.has(myIdx)) {
        cues = cueCache.get(myIdx);
      } else {
        cues = await loadEpisodeCues(series[myIdx]);
        cueCache.set(myIdx, cues);
      }
      if (previewIdx !== myIdx) return;   // user flipped chips again while this was loading

      let nowMs = 0;
      if (myIdx === curIdx) {
        try { nowMs = (await bg()?.getState?.())?.positionMs || 0; } catch (_) {}
      } else {
        // Not the playing episode: highlight where it was last left off.
        nowMs = Number.isFinite(series[myIdx]?.lastPosMs) ? series[myIdx].lastPosMs : -1;
      }

      list.textContent = '';
      if (myIdx !== curIdx) {
        const hint = document.createElement('div');
        hint.textContent = 'Just looking — tap ' + (myIdx + 1) + ' again to switch and resume, or pick a line to jump there.';
        hint.style.cssText = 'padding:2px 4px 14px;color:#7a756a;font-size:12px;line-height:1.5;';
        list.appendChild(hint);
      }
      let currentRow = null;
      if (!cues.length) {
        const empty = document.createElement('div');
        empty.textContent = 'No subtitles loaded yet.';
        empty.style.cssText = 'padding:40px;text-align:center;color:#999;font-size:17px;';
        list.appendChild(empty);
        return;
      }
      cues.forEach((c) => {
        const row = document.createElement('button');
        const isCur = nowMs >= c.startMs && nowMs < (c.endMs || c.startMs + 1);
        row.style.cssText =
          'display:flex;gap:18px;align-items:baseline;width:100%;text-align:left;padding:12px 16px;' +
          'border:none;border-radius:12px;margin:2px 0;background:' + (isCur ? 'rgba(147,130,220,.28)' : 'transparent') + ';' +
          'color:#eee;';
        const tm = document.createElement('span');
        tm.textContent = fmtMs(c.startMs);
        tm.style.cssText = 'color:#9b8fd8;font-size:15px;font-variant-numeric:tabular-nums;flex-shrink:0;min-width:56px;';
        const tx = document.createElement('span');
        tx.textContent = c.text || '';
        tx.style.cssText = 'font-size:19px;line-height:1.5;font-family:var(--reader-font,serif);';
        row.appendChild(tm); row.appendChild(tx);
        // Selecting a subtitle is the ONLY thing that actually changes
        // place — in the CURRENT episode that's just a seek; in a
        // PREVIEWED episode it's a real switch that lands exactly here.
        row.addEventListener('click', async () => {
          if (myIdx === curIdx) {
            try {
              await bg()?.seek?.({ ms: c.startMs, fadeMs: 100 });
              const st2 = await bg()?.getState?.();
              if (st2 && !st2.playing) await bg()?.resume?.({ fadeMs: 120 });
            } catch (_) {}
          } else {
            row.textContent = ''; row.appendChild(document.createTextNode('…'));
            await advanceEpisodeTo(myIdx, true, true, c.startMs);
          }
          closeBrowser();
        });
        if (isCur) currentRow = row;
        list.appendChild(row);
      });
      if (currentRow) { try { currentRow.scrollIntoView({ block: 'center' }); } catch (_) {} }
    }

    ov.appendChild(list);
    document.body.appendChild(ov);
    document.body.classList.add('kv-browser-open');
    paintChips();
    await renderList();
    sync(true);   // hide the native plane immediately
  }

  function closeBrowser() {
    const ov = document.getElementById('kvEpBrowser');
    if (ov) ov.remove();
    document.body.classList.remove('kv-browser-open');
    sync(true);
  }

  // Anki tag for the currently-playing episode, from the Title's ORIGINAL
  // attachment name — the playing URL is the materialized cache copy
  // (deck_<hash>.<ext>), useless as a label. Hierarchical:
  // "kadoki-video::<series>::<episode>" when the Title is a series (levels
  // differ), else "kadoki-video::<name>". Whitespace → _, extension stripped,
  // "::" inside a name neutralized (it's the tag-hierarchy separator).
  function tagPart(s) {
    return String(s || '').replace(/\.[^.]+$/, '').replace(/::/g, '_')
      .replace(/\s+/g, '_').trim();
  }
  async function mediaTag() {
    try {
      const tid = window._activeTitleId;
      const t = (tid && window.titleStore?.get) ? await window.titleStore.get(tid) : null;
      const ep = tagPart(t?.attachments?.audiobook?.name);
      const series = tagPart(t?.name);
      if (ep && series && ep !== series) return 'kadoki-video::' + series + '::' + ep;
      if (ep || series) return 'kadoki-video::' + (ep || series);
      // Last resort: the playing URL's basename (cache name, but never empty).
      const st = await bg()?.getState?.();
      const n = tagPart(decodeURIComponent((st?.url || '').split('/').pop() || ''));
      return n ? ('kadoki-video::' + n) : '';
    } catch (_) { return ''; }
  }

  // Ornament send button: current subtitle → Anki card with a frame grab
  // (native AVAssetImageGenerator at the playhead) + the cue's audio clip
  // (AudioSlicer's AppleM4A export pulls the audio track out of the video
  // file directly). Pauses playback so the user sees what got sent; resume
  // is theirs (never touches the playhead — place-loss invariant).
  let _ankiSending = false;
  async function ankiSend() {
    if (!_isVideoTitle || _ankiSending) return;
    const p = bg();
    if (!p || typeof window.sendToAnki !== 'function') return;
    _ankiSending = true;
    try {
      let st = null;
      try { st = await p.getState(); } catch (_) {}
      const cues = Array.isArray(window.__abCues) ? window.__abCues : [];
      const idx = (st && cues.length && window.srtParser)
        ? window.srtParser.findCueAtTime(cues, st.positionMs || 0) : -1;
      if (idx < 0) {
        window.showToast?.(window.i18n?.t?.('kv.anki_no_cue', 'No subtitle at this spot') || 'No subtitle at this spot', 3000);
        return;
      }
      const cue = cues[idx];
      const expression = (cue.text || '').replace(/<[^>]+>/g, '').trim();
      try { if (st.playing) await p.pause({ fadeMs: 80 }); } catch (_) {}
      window.showToast?.('➤ Anki…', 1200);
      let imageData = '';
      try {
        const r = await p.videoFrame?.({ maxDim: 1280 });
        if (r?.dataUri) imageData = r.dataUri;
      } catch (e) { console.warn('[video-anki] frame grab:', e?.message || e); }
      let audioData = '';
      try {
        const slicer = window.Capacitor?.Plugins?.AudioSlicer;
        const srcPath = (st.url || '').replace(/^file:\/\//, '');
        if (slicer && srcPath) {
          const slice = await slicer.slice({
            srcPath,
            startMs: Math.round(cue.startMs),
            endMs:   Math.round(cue.endMs || (cue.startMs + 1000))
          });
          if (slice?.path && typeof window.cacheFileToDataUri === 'function') {
            audioData = await window.cacheFileToDataUri(slice.path, slice.mime || 'audio/mp4');
          }
        }
      } catch (e) { console.warn('[video-anki] slice:', e?.message || e); }
      await window.sendToAnki({ expression, imageData, audioData });
    } finally {
      _ankiSending = false;
    }
  }

  window.kadokiVideoMode = {
    maybeToggle3d,
    advanceEpisode,
    advanceEpisodeTo,
    openBrowser,
    replayCurrent: replayCurrentCue,
    ankiSend,
    mediaTag,
    sync: () => { _checkedTitleId = undefined; tick(); },
    isVideoTitle: () => _isVideoTitle,
  };

  // Simulator dev harness (KADOKI_SIM_DEMO=1 via SIMCTL_CHILD_ env): native
  // seeds a demo video+SRT into Documents; create/open a Title for it so the
  // whole video player is testable with zero manual imports.
  async function maybeSeedDemo() {
    try {
      const dm = await bg()?.deviceModel?.();
      if (!dm || !dm.simDemo || !dm.demoDir || !window.titleStore) return;
      const list = await window.titleStore.list();
      let t = list.find((x) => x.name === 'Sim Demo Video');
      let atts;
      if (dm.simSeries) {
        const eps = [1, 2, 3].map((n) => ({
          video: { name: `demo-ep${n}.mp4`, cachePath: dm.demoDir + `/demo-ep${n}.mp4` },
          srt:   { name: `demo-ep${n}.srt`, cachePath: dm.demoDir + `/demo-ep${n}.srt` },
        }));
        atts = {
          audiobook: { name: 'demo-ep1.mp4', cachePath: dm.demoDir + '/demo-ep1.mp4', isVideo: true },
          srt:       { name: 'demo-ep1.srt', cachePath: dm.demoDir + '/demo-ep1.srt' },
          series: eps,
        };
      } else {
        atts = {
          audiobook: { name: 'demo-video.mp4', cachePath: dm.demoDir + '/demo-video.mp4', isVideo: true },
          srt:       { name: 'demo-video.srt', cachePath: dm.demoDir + '/demo-video.srt' },
        };
      }
      if (!t) {
        t = await window.titleStore.create({ name: 'Sim Demo Video', attachments: atts });
      } else {
        // Reinstalls rotate the app-container UUID → stored absolute paths go
        // stale. Refresh them to the current container every boot.
        t = (await window.titleStore.update(t.id, { attachments: atts })) || t;
      }
      // Deterministic harness runs: start at 0 every launch (clear the
      // durable floor + per-title resume), and honor the 3D env override.
      try { if (dm.sim3d) localStorage.setItem('KADOKI_VIDEO_3D', '1'); } catch (_) {}
      try { await bg()?.clearSavedPosition?.(); } catch (_) {}
      await prefSet('READING_AUDIO_LAST_POS_' + t.name, '0');
      await prefSet('READING_AUDIO_LAST_CHUNK_' + t.name, '0');
      try { await window.titleStore.setCardIndex(t.id, 0, 0); } catch (_) {}
      if (t) {
        t.lastMode = 'audio';
        setTimeout(() => { try { window.loadTitleFromLibrary?.(t); } catch (_) {} }, 1500);
        // Harness auto-tests: KADOKI_SIM_ADV=1 exercises the episode switch;
        // KADOKI_SIM_BROWSE=1 opens the subtitle browser for a screenshot.
        if (dm.simAdv) setTimeout(() => { try { advanceEpisodeTo(1, true, true); } catch (_) {} }, 9000);
        if (dm.simCard) setTimeout(() => { try { window.setShellMode?.('card', { force: true }); } catch (_) {} }, 9000);
        if (dm.simMenu) setTimeout(() => { try { window.openShellMoreMenu?.(); } catch (_) {} }, 9000);
        if (dm.simBrowse) setTimeout(() => { try { openBrowser(); } catch (_) {} }, 9000);
        // TEMP test hook: open the browser, preview episode 2's chip (must
        // NOT switch playback), for verifying the preview-vs-commit split.
        if (dm.simBrowsePreview) setTimeout(async () => {
          try {
            await openBrowser();
            const ov = document.getElementById('kvEpBrowser');
            const chip = ov?.querySelectorAll('#kvEpBrowserChips > button')?.[1];
            chip?.click();
          } catch (_) {}
        }, 9000);
        // TEMP test hook: preview ep2, then COMMIT by clicking its 4th
        // subtitle row — must land exactly there (not 0) and actually
        // switch (unlike the plain preview test above).
        if (dm.simBrowseCommit) setTimeout(async () => {
          try {
            await openBrowser();
            const ov = document.getElementById('kvEpBrowser');
            ov?.querySelectorAll('#kvEpBrowserChips > button')?.[1]?.click();
            await new Promise((r) => setTimeout(r, 800));
            const rows = ov?.querySelectorAll('#kvEpBrowserList > button');
            rows?.[3]?.click();
          } catch (_) {}
        }, 9000);
        // TEMP test hook: switch to ep2 (as above), let it play a few
        // seconds, then double-tap chip 1 to switch BACK — ep1 must resume
        // near where it was (its saved lastPosMs), NOT reset to 0.
        if (dm.simBrowseResume) setTimeout(async () => {
          try {
            await openBrowser();
            let ov = document.getElementById('kvEpBrowser');
            ov?.querySelectorAll('#kvEpBrowserChips > button')?.[1]?.click();
            await new Promise((r) => setTimeout(r, 800));
            ov?.querySelectorAll('#kvEpBrowserList > button')?.[3]?.click();
            await new Promise((r) => setTimeout(r, 4000));   // let ep2 play a bit
            await openBrowser();
            ov = document.getElementById('kvEpBrowser');
            ov?.querySelectorAll('#kvEpBrowserChips > button')?.[0]?.click();   // preview ep1
            await new Promise((r) => setTimeout(r, 400));
            ov?.querySelectorAll('#kvEpBrowserChips > button')?.[0]?.click();   // confirm → resume
          } catch (_) {}
        }, 9000);
        // KADOKI_SIM_ANKI=1: exercise the full send pipeline (frame grab +
        // audio slice + AnkiConnect addNote to the Mac) once playback is live.
        // Prefs are injected HERE, in-process — simctl `defaults write` can't
        // reach the app's named domain reliably (cfprefsd cache).
        if (dm.simAnki) setTimeout(async () => {
          try {
            const host = dm.simAnkiHost || '127.0.0.1';
            const cfg = [
              ['ANKICONNECT_HOST', host],
              ['ANKI_SWIPE_DECK', 'Default'], ['SELECTED_DECK', 'Default'],
              ['ANKI_SWIPE_MODEL', 'Basic'],
              ['ANKI_SWIPE_F_EXPRESSION', 'Front'],
              ['ANKI_SWIPE_F_IMAGE', 'Back'], ['ANKI_SWIPE_F_AUDIO', 'Back'],
            ];
            // BOTH stores: on visionOS preferences.js falls back to
            // localStorage (Filesystem plugin is excluded from the xros build,
            // which flips isCapacitorEnvironment() false).
            for (const [k, v] of cfg) {
              try { localStorage.setItem(k, v); } catch (_) {}
              await prefSet(k, v);
            }
            ankiSend();
          } catch (e) { console.warn('[sim-anki]', e?.message || e); }
        }, 9000);
      }
    } catch (_) {}
  }

  // Idle until the platform is known; KADOKI_VISION_NATIVE is set by
  // detectVisionDevice at boot (700ms/2.5s retries), so poll briefly.
  let boots = 0;
  const bootPoll = setInterval(() => {
    boots++;
    if (nativeVideoOk()) {
      clearInterval(bootPoll);
      (async () => {
        try {
          const dm = await bg()?.deviceModel?.();
          _isPhone = !!(dm && (/iPhone/i.test(dm.model || '') || dm.phone === true) && !dm.visionClass);
        } catch (_) {}
        start(); maybeSeedDemo();
      })();
    }
    else if (boots > 20) clearInterval(bootPoll);
  }, 500);
})();
