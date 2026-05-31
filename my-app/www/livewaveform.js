// livewaveform.js — flowing, scrolling waveform at the bottom of audio mode.
//
// Shows a window that spans ~3 subtitles (prev / current / next). As the
// current cue ends, the visible window EASES to the next triplet, so the whole
// strip glides left and reveals the upcoming line — continuous, never blanking
// between phrases. Audio comes from a wide, occasionally-rebuilt "film"
// (one AudioSlicer extraction over many seconds); each frame just blits the
// visible sub-region (scaled to the canvas) + a flowing sheen + a subtle
// glowing sub-pixel playhead. No per-frame path rebuild and no per-cue reset,
// so it stays smooth at any playback speed.
(function () {
  'use strict';

  const STRIP_HEIGHT_PX = 80;
  const FILM_BACK_MS = 8000;          // film covers this far behind current…
  const FILM_FWD_MS  = 16000;         // …and this far ahead
  const FILM_REBUILD_EDGE_MS = 5000;  // rebuild as current nears the film edge
  const FILM_PX_PER_SEC = 70;         // internal film horizontal resolution
  const FILM_MAX_SAMPLES = 4096;
  const VIEW_EASE = 0.16;             // how fast the visible window chases target
  const NOCUE_BACK_MS = 4000;         // window when there are no SRT cues
  const NOCUE_FWD_MS  = 9000;

  let canvas = null, ctx = null;
  let currentSrcPath = null;
  let durationMs = 0;

  // Playback clock — velocity-measured + low-pass smoothed so the cursor glides
  // at ANY speed (extrapolating with a configured rate drifts and jitters when
  // the real rate differs).
  let lastPositionMs = 0, lastPositionAt = 0, measuredRate = 1, playing = false;
  let dispMs = 0, dispInit = false;

  // Film = wide offscreen waveform image.
  let film = null;
  let filmStartMs = 0, filmEndMs = 0, filmReady = false, filmBuilding = false, filmReqId = 0;
  let filmAccent = '';

  // Animating visible window (ms range), eased toward the triplet target.
  let viewStart = -1, viewEnd = -1;

  let running = false, rafHandle = null;

  function log(...a) { try { console.log('[livewf]', ...a); } catch (_) {} }
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

  // ---------- color ----------
  function getAccent() {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--accent-audio').trim();
    return v || '#b794f6';
  }
  function toRgba(color, alpha) {
    let r = 183, g = 148, b = 246;
    const m6 = color.match(/^#([0-9a-f]{6})$/i);
    const m3 = color.match(/^#([0-9a-f]{3})$/i);
    if (m6) { r = parseInt(m6[1].slice(0, 2), 16); g = parseInt(m6[1].slice(2, 4), 16); b = parseInt(m6[1].slice(4, 6), 16); }
    else if (m3) { r = parseInt(m3[1][0] + m3[1][0], 16); g = parseInt(m3[1][1] + m3[1][1], 16); b = parseInt(m3[1][2] + m3[1][2], 16); }
    return `rgba(${r},${g},${b},${alpha})`;
  }

  // ---------- canvas ----------
  function resizeCanvas() {
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || window.innerWidth || 360;
    canvas.width  = Math.floor(cssW * dpr);
    canvas.height = Math.floor(STRIP_HEIGHT_PX * dpr);
    ctx.imageSmoothingEnabled = true;
  }
  function ensureCanvas() {
    if (canvas) return canvas;
    const view = document.getElementById('audiobookModeView');
    if (!view) return null;
    canvas = document.createElement('canvas');
    canvas.id = 'liveWaveform';
    canvas.style.cssText =
      'position:absolute;left:0;right:0;width:100%;' +
      'bottom:env(safe-area-inset-bottom, 0px);' +
      `height:${STRIP_HEIGHT_PX}px;display:block;pointer-events:none;z-index:5;`;
    view.appendChild(canvas);
    ctx = canvas.getContext('2d');
    setTimeout(resizeCanvas, 0);
    window.addEventListener('resize', resizeCanvas);
    return canvas;
  }
  function setVisible(v) {
    if (canvas) canvas.style.display = v ? 'block' : 'none';
    if (v) startLoop(); else stopLoop();
  }

  // ---------- cues ----------
  function cuesArr() {
    return (window.pagedCues?.length ? window.pagedCues : window.__abCues) || [];
  }
  function findCueIdxAt(ms) {
    const cues = cuesArr();
    if (!cues.length) return -1;
    const hint = Number.isFinite(window._lastAudioCueIdx) ? window._lastAudioCueIdx : -1;
    if (hint >= 0 && hint < cues.length) {
      const c = cues[hint];
      if (Number.isFinite(c?.startMs) && Number.isFinite(c?.endMs) && ms >= c.startMs && ms <= c.endMs) return hint;
    }
    const start = hint >= 0 ? hint : 0;
    for (let i = start; i < cues.length; i++) {
      const c = cues[i];
      if (Number.isFinite(c?.startMs) && Number.isFinite(c?.endMs) && ms >= c.startMs && ms <= c.endMs) return i;
      if (c?.startMs > ms) break;
    }
    for (let i = start - 1; i >= 0; i--) {
      const c = cues[i];
      if (Number.isFinite(c?.startMs) && Number.isFinite(c?.endMs) && ms >= c.startMs && ms <= c.endMs) return i;
    }
    return -1;
  }

  // ---------- film (wide offscreen waveform) ----------
  function renderFilm(startMs, endMs, samples, accent) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(2, samples.length);
    const h = Math.round(STRIP_HEIGHT_PX * dpr);
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const o = off.getContext('2d');
    const mid = h / 2, halfH = h / 2;
    const N = samples.length;
    const amp = 0.86 * halfH;
    const floor = 0.05 * halfH;
    const xFor = i => (i / (N - 1)) * w;
    const yFor = (i, s) => mid + s * (clamp01(samples[i] || 0) * amp + floor);

    const path = new Path2D();
    path.moveTo(xFor(0), yFor(0, -1));
    for (let i = 1; i < N - 1; i++) {
      const xc = (xFor(i) + xFor(i + 1)) / 2, yc = (yFor(i, -1) + yFor(i + 1, -1)) / 2;
      path.quadraticCurveTo(xFor(i), yFor(i, -1), xc, yc);
    }
    path.lineTo(xFor(N - 1), yFor(N - 1, -1));
    path.lineTo(xFor(N - 1), yFor(N - 1, +1));
    for (let i = N - 2; i > 0; i--) {
      const xc = (xFor(i) + xFor(i - 1)) / 2, yc = (yFor(i, +1) + yFor(i - 1, +1)) / 2;
      path.quadraticCurveTo(xFor(i), yFor(i, +1), xc, yc);
    }
    path.lineTo(xFor(0), yFor(0, +1));
    path.closePath();

    const g = o.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0.00, toRgba(accent, 0.50));
    g.addColorStop(0.50, toRgba(accent, 1.00));
    g.addColorStop(1.00, toRgba(accent, 0.50));
    o.save();
    o.shadowColor = toRgba(accent, 0.7);
    o.shadowBlur = Math.max(4, Math.round(h * 0.12));
    o.fillStyle = g;
    o.fill(path);
    o.restore();
    o.fillStyle = g;
    o.fill(path);

    film = off;
  }

  async function ensureFilm(centerMs) {
    if (filmBuilding) return;
    const accent = getAccent();
    const need = !filmReady ||
      filmAccent !== accent ||
      centerMs < filmStartMs + FILM_REBUILD_EDGE_MS ||
      centerMs > filmEndMs - FILM_REBUILD_EDGE_MS;
    if (!need) return;
    const AudioSlicer = window.Capacitor?.Plugins?.AudioSlicer;
    if (!AudioSlicer?.getWaveform || !currentSrcPath) return;
    let s = Math.max(0, centerMs - FILM_BACK_MS);
    let e = centerMs + FILM_FWD_MS;
    if (durationMs > 0) e = Math.min(durationMs, e);
    if (e - s < 1000) return;
    const reqId = ++filmReqId;
    filmBuilding = true;
    const durSec = (e - s) / 1000;
    const nSamples = Math.min(FILM_MAX_SAMPLES, Math.max(256, Math.round(durSec * FILM_PX_PER_SEC)));
    try {
      const r = await AudioSlicer.getWaveform({ srcPath: currentSrcPath, startMs: s, endMs: e, samples: nSamples });
      if (reqId !== filmReqId) return;  // superseded by a newer request
      if (!r?.samples || r.samples.length < 2) return; // nothing usable → keep ribbon
      renderFilm(s, e, r.samples, accent);
      filmStartMs = s; filmEndMs = e; filmAccent = accent; filmReady = true;
    } catch (err) {
      log('film build failed:', err?.message || err);
    } finally {
      if (reqId === filmReqId) filmBuilding = false;
    }
  }

  function resetFilm() {
    filmReady = false; film = null; filmBuilding = false; filmReqId++;
    viewStart = viewEnd = -1; dispInit = false;
  }

  // ---------- playback clock ----------
  function nowMs() {
    const raw = lastPositionAt
      ? lastPositionMs + (playing ? (performance.now() - lastPositionAt) * measuredRate : 0)
      : lastPositionMs;
    if (!dispInit) { dispMs = raw; dispInit = true; return dispMs; }
    const diff = raw - dispMs;
    if (Math.abs(diff) > 1200) dispMs = raw;     // seek / cue jump → snap
    else dispMs += diff * 0.25;                   // low-pass residual corrections
    return dispMs;
  }

  // ---------- visible-window target (the triplet) ----------
  function targetWindow(ms) {
    const cues = cuesArr();
    if (cues.length) {
      const i = findCueIdxAt(ms);
      if (i >= 0) {
        const prev = cues[i - 1], cur = cues[i], next = cues[i + 1];
        let s = Number.isFinite(prev?.startMs) ? prev.startMs : cur.startMs;
        let e = Number.isFinite(next?.endMs) ? next.endMs : cur.endMs;
        const pad = (e - s) * 0.04;
        s -= pad; e += pad;
        // Cap very long triplets so the window always fits inside the film.
        const MAX_SPAN = FILM_BACK_MS + FILM_FWD_MS - 3000;
        if (e - s > MAX_SPAN) { s = ms - MAX_SPAN * 0.32; e = ms + MAX_SPAN * 0.68; }
        return [s, e];
      }
    }
    return [ms - NOCUE_BACK_MS, ms + NOCUE_FWD_MS];
  }

  // ---------- draw ----------
  function drawPlayhead(px, dw, dh, accent, now) {
    const dpr = window.devicePixelRatio || 1;
    // Very subtle bloom — barely-there halo that gently breathes.
    const bloomR = dh * 0.40;
    const pulse = 0.085 + 0.025 * Math.sin(now / 640);
    const bloom = ctx.createRadialGradient(px, dh / 2, 0, px, dh / 2, bloomR);
    bloom.addColorStop(0, toRgba(accent, pulse));
    bloom.addColorStop(1, toRgba(accent, 0));
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = bloom;
    ctx.fillRect(px - bloomR, 0, bloomR * 2, dh);
    ctx.globalCompositeOperation = 'source-over';
    // Crisp sub-pixel core.
    const coreW = Math.max(2, 1.5 * dpr);
    const cg = ctx.createLinearGradient(0, 0, 0, dh);
    cg.addColorStop(0, toRgba(accent, 0.2));
    cg.addColorStop(0.5, 'rgba(255,255,255,0.9)');
    cg.addColorStop(1, toRgba(accent, 0.2));
    ctx.fillStyle = cg;
    ctx.fillRect(px - coreW / 2, 0, coreW, dh);
  }

  function draw() {
    if (!ctx || !canvas) return;
    const dw = canvas.width, dh = canvas.height, dpr = window.devicePixelRatio || 1;
    if (!dw || !dh) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, dw, dh);

    const now = performance.now();
    const ms = nowMs();
    const accent = getAccent();

    ensureFilm(ms);

    // Ease the visible window toward the triplet target → smooth left-scroll.
    let t = targetWindow(ms);
    let ts = t[0], te = t[1];
    if (te - ts < 800) te = ts + 800;
    if (viewStart < 0) { viewStart = ts; viewEnd = te; }
    else { viewStart += (ts - viewStart) * VIEW_EASE; viewEnd += (te - viewEnd) * VIEW_EASE; }

    const vSpan = Math.max(1, viewEnd - viewStart);
    const phX = clamp01((ms - viewStart) / vSpan) * dw;

    if (filmReady && film && viewEnd > filmStartMs && viewStart < filmEndMs) {
      // Map only the film-covered slice of the view to its dest x-range, so a
      // partially-covered view (e.g. mid film-rebuild) never reads out of bounds.
      const fSpan = Math.max(1, filmEndMs - filmStartMs);
      const coverS = Math.max(viewStart, filmStartMs);
      const coverE = Math.min(viewEnd, filmEndMs);
      const srcX = ((coverS - filmStartMs) / fSpan) * film.width;
      const srcW = Math.max(1, ((coverE - coverS) / fSpan) * film.width);
      const dstX = ((coverS - viewStart) / vSpan) * dw;
      const dstW = Math.max(1, ((coverE - coverS) / vSpan) * dw);
      // Unplayed (future) — dim base across the strip.
      ctx.globalAlpha = 0.30;
      ctx.drawImage(film, srcX, 0, srcW, film.height, dstX, 0, dstW, dh);
      // Played (past) — bright, clipped to [0, playhead], with a flowing sheen.
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, Math.max(0, phX), dh); ctx.clip();
      ctx.globalAlpha = 1;
      ctx.drawImage(film, srcX, 0, srcW, film.height, dstX, 0, dstW, dh);
      const sheenW = dw * 0.20;
      const sheenX = ((now * 0.045 * dpr) % (dw + sheenW * 2)) - sheenW;
      const sg = ctx.createLinearGradient(sheenX - sheenW, 0, sheenX + sheenW, 0);
      sg.addColorStop(0, 'rgba(255,255,255,0)');
      sg.addColorStop(0.5, 'rgba(255,255,255,0.12)');
      sg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = sg;
      ctx.fillRect(0, 0, dw, dh);
      ctx.restore();
    } else {
      // Film not ready yet — a thin ribbon so the strip never fully blanks.
      ctx.globalAlpha = 1;
      ctx.fillStyle = toRgba(accent, 0.16);
      ctx.fillRect(0, dh / 2 - 1, dw, 2);
    }

    ctx.globalAlpha = 1;
    drawPlayhead(phX, dw, dh, accent, now);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ---------- continuous rAF loop (visible only) ----------
  function frame() {
    if (!running) { rafHandle = null; return; }
    if (document.body.classList.contains('mode-audio')) {
      try { draw(); } catch (e) {}
    }
    rafHandle = requestAnimationFrame(frame);
  }
  function startLoop() { if (running) return; running = true; rafHandle = requestAnimationFrame(frame); }
  function stopLoop() { running = false; if (rafHandle) cancelAnimationFrame(rafHandle); rafHandle = null; }
  function scheduleDraw() { startLoop(); }

  // ---------- src path ----------
  function resolveSrcPath() {
    return window._currentReadingAudiobookPath ||
           window._audiobookSrcPath ||
           (window.allNotes?.[window.currentCardIndex ?? 0]?.audiobookPath) ||
           null;
  }
  function watchSrc() {
    setInterval(() => {
      const p = resolveSrcPath();
      if (p === currentSrcPath) return;
      log('audiobook path changed:', p ? p.split('/').pop() : '(none)');
      currentSrcPath = p;
      resetFilm();
      try {
        const a = window.getAudioProgress?.();
        if (a && Number.isFinite(a.dur)) durationMs = a.dur;
      } catch (_) {}
      if (currentSrcPath && document.body.classList.contains('mode-audio')) scheduleDraw();
    }, 800);
  }

  // ---------- bg audio ----------
  function attachBg() {
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (!bg?.addListener) { setTimeout(attachBg, 250); return; }
    bg.addListener('position', (d) => {
      if (Number.isFinite(d?.positionMs)) {
        const t = performance.now();
        if (lastPositionAt) {
          const dv = d.positionMs - lastPositionMs, dt = t - lastPositionAt;
          if (dt > 20 && dv >= 0 && dv < 8000) {
            const inst = dv / dt;                       // ms audio per ms real
            measuredRate = measuredRate * 0.6 + inst * 0.4;
          }
        }
        lastPositionMs = d.positionMs;
        lastPositionAt = t;
      }
      if (Number.isFinite(d?.durationMs)) durationMs = d.durationMs;
      scheduleDraw();
    });
    bg.addListener('state', (d) => {
      playing = !!d?.playing;
      lastPositionAt = performance.now();
      scheduleDraw();
    });
  }

  function refreshFromGlobals() {
    try {
      const a = window.getAudioProgress?.();
      if (a && Number.isFinite(a.dur)) durationMs = a.dur;
      if (a && Number.isFinite(a.ms)) { lastPositionMs = a.ms; lastPositionAt = performance.now(); dispInit = false; }
    } catch (_) {}
  }

  function init() {
    if (window._liveWaveformInited) return;
    if (!ensureCanvas()) { setTimeout(init, 200); return; }
    window._liveWaveformInited = true;
    setVisible(false);
    attachBg();
    watchSrc();
    window.addEventListener('shell:mode-change', (e) => {
      const visible = e?.detail?.mode === 'audio';
      setVisible(visible);
      if (!visible) return;
      const p = resolveSrcPath();
      if (p !== currentSrcPath) { currentSrcPath = p; resetFilm(); }
      refreshFromGlobals();
      resizeCanvas();
      scheduleDraw();
    });
    if (document.body.classList.contains('mode-audio')) {
      currentSrcPath = resolveSrcPath();
      refreshFromGlobals();
      setVisible(true);
      setTimeout(() => { resizeCanvas(); scheduleDraw(); }, 0);
    }
    log('live waveform initialized (scrolling-film mode)');
  }

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
