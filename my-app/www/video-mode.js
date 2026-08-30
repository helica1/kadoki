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
  const KV_BUILD = 'kv29';
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
    const cardTab = document.querySelector('#shellModeTabs .mode-tab[data-mode="card"]');
    if (!cardTab || !cardTab.parentNode) return null;
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
    cardTab.parentNode.insertBefore(tab, cardTab);
    return tab;
  }

  function syncTabs() {
    const tab = ensureVideoTab();
    const audioTab = document.querySelector('#shellModeTabs .mode-tab[data-mode="audio"]');
    if (!tab) return;
    // Always visible; faded (data-empty, like the other tabs) when the active
    // title has no video.
    tab.style.display = '';
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
  async function advanceEpisodeTo(targetIdx, autoplay, force) {
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
      // ZERO THE RESUME STATE **AFTER** THE LOAD: the title switch itself
      // saves the outgoing episode's END position under the same per-title
      // pseudo key — zeroing before the load was silently undone, and every
      // new episode opened pegged at 100% (which also re-triggered 'ended').
      const pseudo = t.attachments?.deck?.name || t.name;
      await prefSet('READING_AUDIO_LAST_POS_' + pseudo, '0');
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
            await bg()?.play?.({ url: path, startMs: 0, rate, fadeMs: 150 });
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

  function computeSurface() {
    const active = _isVideoTitle &&
      window.KADOKI_VISION_NATIVE &&
      document.body.classList.contains('mode-audio') &&
      !document.hidden;
    const anchor = ensureAnchor();
    if (anchor) anchor.style.display = (_isVideoTitle && document.body.classList.contains('mode-audio')) ? 'block' : 'none';
    if (!active || !anchor) return { visible: false };
    if (modalOpen()) return { visible: false };
    const r = anchor.getBoundingClientRect();
    if (!(r.width > 40 && r.height > 40)) return { visible: false };
    return {
      visible: true,
      x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
      stereo: stereoOn(),
      epIndex: _seriesInfo.idx, epCount: _seriesInfo.count,
    };
  }

  let _lastSurf = null;
  function positionCuePanel(surf) {
    const cue = document.getElementById('audiobookCueText');
    if (!cue) return;
    if (!surf || !surf.visible) { cue.style.position = ''; cue.style.top = ''; cue.style.left = ''; cue.style.transform = ''; return; }
    // RIGHT under the frame (or, in overlay mode, on its lower edge) — the
    // authoritative contained rect comes back from native with true aspect.
    const f = _nativeFrame;
    if (f && f.h > 1) {
      const ch = cue.getBoundingClientRect().height || 70;
      const overlay = document.body.classList.contains('kv-subplace-overlay');
      const top = overlay ? (f.y + f.h - ch - 20) : (f.y + f.h + 10);
      cue.style.position = 'fixed';
      cue.style.left = '50%';
      cue.style.transform = 'translateX(-50%)';
      cue.style.top = Math.round(Math.min(top, window.innerHeight - 70)) + 'px';
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
  function sync(force) {
    if (!window.KADOKI_VISION_NATIVE) return;
    const p = bg();
    if (!p || typeof p.videoSurface !== 'function') return;
    const s = computeSurface();
    const key = JSON.stringify(s);
    // While visible, re-send every ~3s even when unchanged: the native side
    // re-asserts the cinema chrome and refreshes the authoritative frame.
    if (!force && key === _lastSent && !(s.visible && Date.now() - _lastSendTs > 3000)) return;
    _lastSent = key;
    _lastSendTs = Date.now();
    try {
      Promise.resolve(p.videoSurface(s)).then((r) => {
        if (r && Number.isFinite(r.frameW) && r.frameW > 1) {
          _nativeFrame = { x: r.frameX, y: r.frameY, w: r.frameW, h: r.frameH };
        }
        // Subtitle placement is a native-side pref (set on the ornament's
        // settings card); the DOM lays out to match via a body class.
        if (r && r.subPlacement) {
          document.body.classList.toggle('kv-subplace-overlay', r.subPlacement === 'overlay');
        }
        if (r && Number.isFinite(r.subSize) && r.subSize > 10) {
          const cue = document.getElementById('audiobookCueText');
          if (cue) { cue.style.setProperty('font-size', Math.round(r.subSize) + 'px', 'important'); }
        }
        positionCuePanel(s);
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
  let _kvVideoWords = [];
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
    pushSubs._was = true;
    const r = cue.getBoundingClientRect();
    if (!(r.width > 1 && r.height > 1)) { try { p.videoSubs({ visible: false }); } catch (_) {} return; }
    // Segment the cue for the native panel: [text, kwordIndex] runs in DOM
    // order. Words carry their index; the native panel hover-glows and taps
    // them (glow at the window plane sits BEHIND the popped-out 3D film, so
    // the panel must light itself).
    const segs = [];
    _kvVideoWords = [];
    try {
      const frags = Array.from(cue.querySelectorAll('.dict-frag'));
      const hits = Array.from(cue.querySelectorAll('.kword-hit'));
      let particle = '';
      for (const node of cue.children) {
        if (node.classList && node.classList.contains('kword')) {
          if (particle) { segs.push([particle, '-1']); particle = ''; }
          const k = _kvVideoWords.length;
          const firstFrag = node.querySelector('.dict-frag');
          const fragIdx = firstFrag ? frags.indexOf(firstFrag) : -1;
          const hit = hits.find((h) => h._kwFragStart === fragIdx) || null;
          _kvVideoWords.push(hit || firstFrag || node);
          segs.push([node.textContent || '', String(k)]);
        } else if (node.classList && (node.classList.contains('dict-frag'))) {
          particle += node.textContent || '';
        }
        // absolute helpers (.kword-hit etc.) are skipped
      }
      if (particle) segs.push([particle, '-1']);
    } catch (_) {}
    try { p.videoSubs({ visible: true, x: r.left, y: r.top, w: r.width, h: r.height, text, segs, hsManage: true }); } catch (_) {}
  }

  // Native 3D panel word tap → replay as a click on the word's DOM overlay
  // (the document-level cue handler quantizes .kword-hit targets to the word
  // start and runs the full dictionary flow).
  window.addEventListener('kadokiVideoWordTap', (e) => {
    try {
      let d = e && e.detail;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = null; } }
      const k = Number((d && d.k) != null ? d.k : e.k);
      const el = _kvVideoWords[k];
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
      clearTimeout(t);
      t = setTimeout(pushSubs, 120);   // after layout + a beat for paint
    }).observe(cue, { childList: true, subtree: true, characterData: true, attributes: true });
  }

  async function tick() {
    await refreshTitleFlag();
    sync(false);
    // Reposition every tick (not only on surface re-sends): the cue panel's
    // placement depends on layout that can move without the surface changing.
    try { positionCuePanel(_lastSurf); } catch (_) {}
    try { observeSubs(); pushSubs(); } catch (_) {}
  }

  // ---------- 3D toggle (transport cube, audio mode) ----------

  // Returns true when the toggle was handled here (audio mode + video title),
  // so reading-mode.js's 'spatial' action can fall through to the card-mode
  // spatial-pictures toggle otherwise.
  function maybeToggle3d() {
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

  async function openBrowser() {
    closeBrowser();
    const tid = window._activeTitleId;
    const t = tid && window.titleStore?.get ? await window.titleStore.get(tid) : null;
    const series = t?.attachments?.series;
    const ov = document.createElement('div');
    ov.id = 'kvEpBrowser';
    ov.className = 'kai-modal';
    ov.style.cssText =
      'position:fixed;inset:0;z-index:9400;background:rgba(8,8,8,.92);display:flex;' +
      'flex-direction:column;color:#eee;font-family:var(--font-sans,system-ui);direction:ltr;';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:14px;padding:18px 22px 10px;flex-wrap:wrap;flex-shrink:0;';
    const title = document.createElement('div');
    title.textContent = t?.name || '';
    title.style.cssText = 'font-size:20px;font-weight:600;margin-right:8px;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    head.appendChild(title);
    if (Array.isArray(series) && series.length > 1) {
      const curName = t?.attachments?.audiobook?.name || '';
      series.forEach((ep, i) => {
        const chip = document.createElement('button');
        chip.textContent = String(i + 1);
        const cur = ep?.video?.name === curName;
        chip.style.cssText =
          'min-width:52px;height:52px;border-radius:26px;border:1px solid rgba(255,255,255,.18);' +
          'font-size:19px;color:#eee;background:' + (cur ? 'rgba(147,130,220,.45)' : 'rgba(255,255,255,.07)') + ';';
        chip.addEventListener('click', async () => {
          chip.textContent = '…';
          const ok = await advanceEpisodeTo(i, true, true);
          if (ok) { openBrowser(); } else { chip.textContent = String(i + 1); }
        });
        head.appendChild(chip);
      });
    }
    const close = document.createElement('button');
    close.textContent = '✕';
    close.style.cssText =
      'margin-left:auto;width:52px;height:52px;border-radius:26px;border:1px solid rgba(255,255,255,.18);' +
      'font-size:20px;color:#eee;background:rgba(255,255,255,.07);';
    close.addEventListener('click', closeBrowser);
    head.appendChild(close);
    ov.appendChild(head);

    const list = document.createElement('div');
    list.style.cssText = 'flex:1;overflow-y:auto;padding:6px 22px calc(30px + env(safe-area-inset-bottom,0px));';
    const cues = Array.isArray(window.__abCues) ? window.__abCues : [];
    let st = null;
    try { st = await bg()?.getState?.(); } catch (_) {}
    const nowMs = st?.positionMs || 0;
    let currentRow = null;
    if (!cues.length) {
      const empty = document.createElement('div');
      empty.textContent = 'No subtitles loaded yet.';
      empty.style.cssText = 'padding:40px;text-align:center;color:#999;font-size:17px;';
      list.appendChild(empty);
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
      row.addEventListener('click', async () => {
        try {
          await bg()?.seek?.({ ms: c.startMs, fadeMs: 100 });
          const st2 = await bg()?.getState?.();
          if (st2 && !st2.playing) await bg()?.resume?.({ fadeMs: 120 });
        } catch (_) {}
        closeBrowser();
      });
      if (isCur) currentRow = row;
      list.appendChild(row);
    });
    ov.appendChild(list);
    document.body.appendChild(ov);
    document.body.classList.add('kv-browser-open');
    if (currentRow) { try { currentRow.scrollIntoView({ block: 'center' }); } catch (_) {} }
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
        if (dm.simBrowse) setTimeout(() => { try { openBrowser(); } catch (_) {} }, 9000);
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
    if (window.KADOKI_VISION_NATIVE) { clearInterval(bootPoll); start(); maybeSeedDemo(); }
    else if (boots > 20) clearInterval(bootPoll);
  }, 500);
})();
