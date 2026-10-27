// waveform.js — Pigments-inspired waveform display with drag-to-adjust
// endpoints and preview. Mode-color aware (reads --accent-card/read/audio
// from CSS depending on body.mode-* class).
//
// Public API:
//   window.waveform.show({ container, srcPath, startMs, endMs, onChange })
//   window.waveform.hide()
//   window.waveform.preview()
//   window.waveform.current() → { startMs, endMs }

(function () {
  // How far past the cue's bounds the user can drag.
  const VIEWPORT_PAD_MS = 1500;
  // Tick spacing on the time axis (ms).
  const TICK_MS = 500;

  let state = null;
  let previewHandle = null;
  let previewTimer = null;
  let playheadRAF = null;

  // rAF loop: extrapolate playhead between bg position events. The native
  // position poll fires at 150 ms; without this, the white line steps
  // visibly every poll. Extrapolating at rAF (~60 Hz) using the last
  // known position + timestamp + playback rate makes it glide smoothly,
  // and gets corrected to ground-truth on the next bg event.
  function tickPlayhead() {
    if (!state || !state.playheadPlaying || !Number.isFinite(state.playheadMs)) {
      playheadRAF = null;
      return;
    }
    // Canvas not laid out yet (0-width on the first card before its ancestor is
    // shown): don't paint a blank frame or advance the clock — just keep the loop
    // alive so the cursor resumes the moment layout settles. Refreshing _tickTs
    // avoids a large frameDt jump on the resuming frame.
    if (state.canvas && state.canvas.clientWidth <= 0) {
      // Keep the loop alive so the cursor resumes once layout settles, but CAP
      // the wait so a permanently-0-width / detached canvas (e.g. leaving card
      // mode without pausing, or a #cardContainer innerHTML rebuild) can't spin
      // a no-paint rAF at 60fps forever, pinning the main thread. After ~2s of
      // 0-width give up; the next show()/position event restarts it.
      state._tickWaits = (state._tickWaits || 0) + 1;
      if (state._tickWaits > 120) { state._tickWaits = 0; playheadRAF = null; return; }
      state._tickTs = performance.now();
      playheadRAF = requestAnimationFrame(tickPlayhead);
      return;
    }
    state._tickWaits = 0;
    // SMOOTH playhead: a free-running clock advanced at the CONSTANT requested
    // playback rate (constant velocity ⇒ no frame-to-frame speed wobble), only
    // GENTLY phase-locked to the real position. Measuring the rate from the
    // noisy ~150ms native position events made the velocity jitter every frame —
    // which is invisible in AUDIO mode (the film scrolls, so the cursor is
    // ~stationary) but obvious HERE, where the cursor sweeps across a fixed
    // waveform, so any velocity wobble shows directly as jitter.
    const now = performance.now();
    const frameDt = Math.min(100, now - (state._tickTs || now));
    state._tickTs = now;
    const rate = 1;   // the editor preview always plays at 1× (see preview())
    const sinceEvent = Math.max(0, now - (state.playheadLastTs || now));
    if (!Number.isFinite(state.playheadDispMs)) state.playheadDispMs = state.playheadMs;
    // 1) free-run at constant velocity while position events are flowing (stop
    //    advancing during a real stall so the cursor doesn't run ahead of the
    //    audio). Gate widened 400→1000 ms: Android's native position poll runs
    //    on the WebView UI looper and slips behind the per-frame canvas paints
    //    (often 200–500 ms between events), so at 400 ms the cursor froze then
    //    yanked forward — the Android-only choppiness. iOS polls regularly and
    //    never tripped it. 1000 ms rides through the slip; a true seek still snaps.
    if (sinceEvent < 1000) state.playheadDispMs += frameDt * rate;
    // 2) gently correct toward the authoritative position (extrapolated to now,
    //    capped so a stall can't fling it). The error each event is only a few
    //    ms, so this is smooth; a real seek (>1.2s) snaps.
    const target = state.playheadMs + Math.min(1000, sinceEvent) * rate;
    const err = target - state.playheadDispMs;
    if (Math.abs(err) > 1200) state.playheadDispMs = target;
    else state.playheadDispMs += err * 0.08;
    state.playheadInterpMs = state.playheadDispMs;
    // Card mode: sweep through the window (incl. the silence to the next cue).
    // Editor (not cardMode): stop at the SELECTION end so a Preview never plays
    // past the chosen range.
    const _stopAt = state.cardMode ? state.wfEndMs : state.endMs;
    const _stopping = state.playheadInterpMs >= _stopAt;
    // ~30fps paint cap: the physics above runs every rAF for a smooth glide, but
    // the clear+blit only needs ~30fps — halves the cursor's per-frame canvas
    // cost across a whole card-mode listen. Always paint the final (stop) frame.
    if (_stopping || now - (state._tickPaintTs || 0) >= 33) {
      state._tickPaintTs = now;
      paintFromSnapshot();
    }
    if (_stopping) {
      playheadRAF = null;
      return;
    }
    playheadRAF = requestAnimationFrame(tickPlayhead);
  }
  function startPlayheadAnim() {
    if (playheadRAF || !state) return;
    playheadRAF = requestAnimationFrame(tickPlayhead);
  }
  function stopPlayheadAnim() {
    if (playheadRAF) cancelAnimationFrame(playheadRAF);
    playheadRAF = null;
  }

  // When the shell switches modes, the accent color the waveform pulls
  // from CSS changes. Force a render so handles + fill repaint right
  // away instead of waiting for the next interaction.
  window.addEventListener('shell:mode-change', () => {
    if (state) try { render(); } catch (e) {}
  });

  // Foreground return in card mode: the position handler takes the cheap
  // tracking-only branch while hidden, so the canvas pixels freeze at the
  // screen-off frame — and a PAUSED return gets no position event to heal
  // from. Sync the displayed accumulators to the tracked playhead and paint
  // once (or restart the anim loop if playing). Double-shot so the second
  // pass lands after reading-mode's async native reconcile.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state) return;
    const _wake = () => {
      if (!state || !state.cardMode || !document.body.classList.contains('mode-card')) return;
      try {
        if (Number.isFinite(state.playheadMs)) {
          state.playheadDispMs = state.playheadMs;
          state.playheadInterpMs = state.playheadMs;
        }
        if (state.playheadPlaying && state.playheadWarmed) startPlayheadAnim();
        else render();
      } catch (e) {}
    };
    _wake();
    setTimeout(_wake, 800);
  });

  function fmtMs(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '–:––';
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = String(total % 60).padStart(2, '0');
    return m + ':' + s;
  }

  // Read the accent color for the current mode (from body class), so the
  // waveform automatically retints when modes change.
  function getModeColor() {
    const body = document.body;
    const cs = getComputedStyle(body);
    if (body.classList.contains('mode-card'))
      return (cs.getPropertyValue('--accent-card').trim()) || '#ff9550';
    if (body.classList.contains('mode-read'))
      return (cs.getPropertyValue('--accent-read').trim()) || '#4caf50';
    if (body.classList.contains('mode-audio'))
      return (cs.getPropertyValue('--accent-audio').trim()) || '#b794f6';
    return (cs.getPropertyValue('--accent-cyan').trim()) || '#00ffcc';
  }

  // hex → rgba string at given alpha.
  function rgba(hex, alpha) {
    hex = (hex || '').trim().replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return `rgba(0,255,204,${alpha})`;
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function render() {
    if (!state || !state.canvas) return;

    // Time labels always reflect state, even if the waveform decode is empty.
    if (state.startLabel) state.startLabel.textContent = fmtMs(state.startMs);
    if (state.endLabel)   state.endLabel.textContent   = fmtMs(state.endMs);
    if (state.lenLabel)   state.lenLabel.textContent   = fmtMs(state.endMs - state.startMs);

    const c = state.canvas;
    const dpr = window.devicePixelRatio || 1;
    const cssW = c.clientWidth;
    const cssH = c.clientHeight;
    // On the FIRST card of a title the canvas can have 0 layout width (its
    // ancestor isn't laid out / visible yet at this synchronous render). Painting
    // + snapshotting now would cache a blank 0-width layer that the playhead loop
    // keeps blitting → "waveform doesn't fully draw the first time". Bail without
    // snapshotting and re-render once layout settles (subsequent cards measure
    // fine, so they never hit this).
    if (cssW <= 0 || cssH <= 0) {
      // When PLAYING, tickPlayhead keeps its own rAF loop alive and will drive a
      // re-render once layout settles — so don't start a SECOND loop here. When
      // NOT playing, schedule a BOUNDED retry: a waveform that's permanently
      // 0-width (hidden via pref, or while in read/audio mode) must NOT spin a
      // rAF forever (battery drain) — cap it and give up.
      if (!state.playheadPlaying) {
        state._layoutRetries = (state._layoutRetries || 0) + 1;
        if (state._layoutRetries <= 60 && !state._awaitingLayout) {
          state._awaitingLayout = true;
          requestAnimationFrame(() => {
            if (state) { state._awaitingLayout = false; render(); }
          });
        }
      }
      return;
    }
    state._layoutRetries = 0;   // laid out — reset the retry budget
    if (c.width !== cssW * dpr || c.height !== cssH * dpr) {
      c.width = cssW * dpr;
      c.height = cssH * dpr;
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // Fine-scale tick strip removed — was visual noise without adding
     // useful info for the trim use case. Reclaim that 18px of vertical
     // real estate for the waveform itself.
    const TICK_AREA = 0;
    const wfStartMs = state.wfStartMs;
    const wfEndMs = state.wfEndMs;
    const wfRange = wfEndMs - wfStartMs;

    const accent = getModeColor();
    const mutedFill = '#2a2a2a';
    const wfTop = TICK_AREA;
    const wfBottom = cssH;
    const wfHeight = wfBottom - wfTop;
    const midY = wfTop + wfHeight / 2;

    // ---- background ----
    ctx.fillStyle = '#0c0c0c';
    ctx.fillRect(0, 0, cssW, cssH);
    // Center axis line.
    ctx.strokeStyle = '#1f1f1f';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(cssW, midY);
    ctx.stroke();

    const buckets = state.buckets || [];
    const x0 = ((state.startMs - wfStartMs) / wfRange) * cssW;
    const x1 = ((state.endMs   - wfStartMs) / wfRange) * cssW;

    // ---- waveform fill (mirrored shape) ----
    if (buckets.length) {
      // Buckets were decoded for the *fetched* range stored on state. Render
      // each bucket at its real time position within the *current* viewport
      // (wfStartMs..wfEndMs). This is what makes zoom feel "live" — the
      // existing samples grow/shrink visually with the viewport instead of
      // always filling end-to-end.
      const bStart = state.bucketsStartMs ?? wfStartMs;
      const bEnd   = state.bucketsEndMs   ?? wfEndMs;
      const bSpan  = Math.max(1, bEnd - bStart);
      const bucketMsToX = (ms) => ((ms - wfStartMs) / wfRange) * cssW;
      const bucketX = (i) => bucketMsToX(bStart + (i / (buckets.length - 1)) * bSpan);
      const buildPath = () => {
        ctx.beginPath();
        for (let i = 0; i < buckets.length; i++) {
          const x = bucketX(i);
          const v = Math.min(1, buckets[i]) * (wfHeight / 2) * 0.92;
          if (i === 0) ctx.moveTo(x, midY - v);
          else         ctx.lineTo(x, midY - v);
        }
        for (let i = buckets.length - 1; i >= 0; i--) {
          const x = bucketX(i);
          const v = Math.min(1, buckets[i]) * (wfHeight / 2) * 0.92;
          ctx.lineTo(x, midY + v);
        }
        ctx.closePath();
      };

      // Out-of-range: muted dark fill.
      ctx.save();
      buildPath();
      ctx.fillStyle = mutedFill;
      ctx.fill();
      ctx.restore();

      // In-range: clip to selection rect, fill in mode color.
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, wfTop, x1 - x0, wfHeight);
      ctx.clip();
      buildPath();
      const grad = ctx.createLinearGradient(0, wfTop, 0, wfBottom);
      grad.addColorStop(0, rgba(accent, 0.9));
      grad.addColorStop(0.5, rgba(accent, 1));
      grad.addColorStop(1, rgba(accent, 0.9));
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();
    } else {
      // No data: show a thin horizontal placeholder so the layout is honest.
      ctx.fillStyle = '#222';
      ctx.fillRect(0, midY - 2, cssW, 4);
      ctx.fillStyle = '#444';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('waveform unavailable', cssW / 2, midY - 14);
    }

    // Selection frame + draggable handles — ONLY when STOPPED. During
    // continuous play we show just the waveform + the moving cursor; the bounds
    // "appear" the moment you pause (so you can adjust them), then vanish on
    // play. Gate on the GLOBAL _bgPlaying (set by app.js's persistent listener)
    // — the editor's own state listener attaches async per re-show and can miss
    // a pause that lands right after a card advance, so the bounds wouldn't show.
    // Editor (not cardMode): handles ALWAYS shown so they stay grabbable.
    // Card mode: handles removed entirely (they no longer make sense on the live
    // card waveform) — only the gray out-of-bounds shading + moving cursor show.
    if (!state.cardMode) {
      // ---- selection frame ----
      ctx.strokeStyle = rgba(accent, 0.6);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x0 + 0.5, wfTop + 0.5, (x1 - x0), wfHeight - 1);

      // Soft selection glow background.
      ctx.fillStyle = rgba(accent, 0.06);
      ctx.fillRect(x0, wfTop, x1 - x0, wfHeight);

      // ---- handles (vertical line + circular cap) ----
      const drawHandle = (x) => {
        // Vertical line through the waveform.
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, wfTop);
        ctx.lineTo(x, wfBottom);
        ctx.stroke();
        // Cap at top, just below tick strip.
        const capY = wfTop + 6;
        ctx.beginPath();
        ctx.arc(x, capY, 9, 0, Math.PI * 2);
        ctx.fillStyle = accent;
        ctx.fill();
        ctx.strokeStyle = '#0c0c0c';
        ctx.lineWidth = 2;
        ctx.stroke();
        // Inner dot for grip emphasis.
        ctx.beginPath();
        ctx.arc(x, capY, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = '#0c0c0c';
        ctx.fill();
      };
      drawHandle(x0);
      drawHandle(x1);
    }

    // Cache everything above (sans playhead) so the rAF playhead loop only has
    // to blit + draw the cursor — no per-frame waveform rebuild.
    snapshotStatic();
    drawPlayhead();
  }

  // Snapshot the current canvas (the static waveform + handles, before the
  // playhead) into an offscreen layer keyed to the device-pixel buffer size.
  function snapshotStatic() {
    if (!state || !state.canvas) return;
    const c = state.canvas;
    if (c.width <= 0 || c.height <= 0) return;   // never cache a blank 0-size layer
    let s = state._staticLayer || (state._staticLayer = document.createElement('canvas'));
    if (s.width !== c.width || s.height !== c.height) { s.width = c.width; s.height = c.height; }
    const sctx = s.getContext('2d');
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, s.width, s.height);
    sctx.drawImage(c, 0, 0);
  }

  // A soft glowing, sub-pixel playhead. Drawn on top of the static layer in
  // CSS-pixel space (the main ctx is dpr-transformed at this point).
  function drawPlayhead() {
    if (!state || !state.canvas) return;
    const c = state.canvas;
    const cssW = c.clientWidth, cssH = c.clientHeight;
    const wfRange = state.wfEndMs - state.wfStartMs;
    const phMs = Number.isFinite(state.playheadInterpMs) ? state.playheadInterpMs : state.playheadMs;
    // Draw across the whole VISIBLE WINDOW (cue + the trailing silence to the
    // next cue), not just the cue — so the cursor is seen advancing through the
    // gap between cards (confirmation that playback is moving).
    if (!Number.isFinite(phMs) || phMs < state.wfStartMs || phMs > state.wfEndMs || wfRange <= 0) return;
    const ctx2 = c.getContext('2d');
    const px = ((phMs - state.wfStartMs) / wfRange) * cssW; // sub-pixel, never rounded
    const accent = getModeColor();
    // Very subtle bloom around the cursor — just a hint of glow.
    ctx2.save();
    const bloomR = cssH * 0.38;
    const bloom = ctx2.createRadialGradient(px, cssH / 2, 0, px, cssH / 2, bloomR);
    bloom.addColorStop(0, rgba(accent, 0.10));
    bloom.addColorStop(1, rgba(accent, 0));
    ctx2.globalCompositeOperation = 'lighter';
    ctx2.fillStyle = bloom;
    ctx2.fillRect(px - bloomR, 0, bloomR * 2, cssH);
    ctx2.restore();
    // Crisp bright core.
    const cg = ctx2.createLinearGradient(0, 0, 0, cssH);
    cg.addColorStop(0, rgba(accent, 0.25));
    cg.addColorStop(0.5, 'rgba(255,255,255,0.95)');
    cg.addColorStop(1, rgba(accent, 0.25));
    ctx2.fillStyle = cg;
    ctx2.fillRect(px - 1, 0, 2, cssH);
  }

  // Per-rAF playhead frame: restore the cached static layer + draw the cursor.
  function paintFromSnapshot() {
    if (!state || !state.canvas) return;
    const c = state.canvas;
    const s = state._staticLayer;
    // No cache yet, or the canvas was resized since the snapshot → full redraw.
    if (!s || s.width !== c.width || s.height !== c.height) { render(); return; }
    const ctx2 = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx2.setTransform(1, 0, 0, 1, 0, 0);
    ctx2.clearRect(0, 0, c.width, c.height);
    ctx2.drawImage(state._staticLayer, 0, 0);
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawPlayhead();
  }

  function hitTestHandle(xPx) {
    // No draggable bounds handles in card mode (only the editor has them).
    if (!state || state.cardMode) return null;
    const c = state.canvas;
    const cssW = c.clientWidth;
    const wfRange = state.wfEndMs - state.wfStartMs;
    const xStart = ((state.startMs - state.wfStartMs) / wfRange) * cssW;
    const xEnd   = ((state.endMs   - state.wfStartMs) / wfRange) * cssW;
    const tol = 26;
    if (Math.abs(xPx - xStart) < tol) return 'start';
    if (Math.abs(xPx - xEnd)   < tol) return 'end';
    return null;
  }

  // Zoom around a focus time in milliseconds (kept fixed in viewport).
  // factor < 1 = zoom in (narrower viewport); factor > 1 = zoom out.
  function applyZoom(factor, focusMs) {
    if (!state) return;
    const minRange = 500;                 // never zoom in past 0.5 s of audio
    const maxRange = 30 * 60 * 1000;      // cap at 30 min visible
    const curRange = state.wfEndMs - state.wfStartMs;
    const newRange = Math.max(minRange, Math.min(maxRange, curRange * factor));
    if (newRange === curRange) return;
    // Keep `focusMs` at the same screen fraction it currently occupies.
    const frac = (focusMs - state.wfStartMs) / curRange;
    state.wfStartMs = Math.max(0, focusMs - frac * newRange);
    state.wfEndMs = state.wfStartMs + newRange;
    // Keep the existing buckets visible while we fetch fresh ones at the
    // new resolution. render() uses bucketsStartMs/bucketsEndMs to draw
    // them at their real time positions, so they smoothly grow/shrink
    // until the re-decode lands and replaces them.
    render();
    const reqId = ++state._zoomReqId;
    const rs = state.wfStartMs, re = state.wfEndMs;
    loadWaveform(state.srcPath, rs, re).then(buckets => {
      if (!state || reqId !== state._zoomReqId) return;
      state.buckets = buckets;
      state.bucketsStartMs = rs;
      state.bucketsEndMs = re;
      render();
    });
  }

  function attachInteractions() {
    if (!state || !state.canvas) return;
    state._zoomReqId = 0;
    const c = state.canvas;
    let dragging = null;          // 'start' | 'end' | 'zoom' | 'pan' | 'undecided' | null
    // Gesture state.
    let touchStartX = 0, touchStartY = 0;
    let initialRange = 0;       // wf range at gesture start (for both zoom + pan)
    let initialStartMs = 0;     // wfStartMs at gesture start (for pan)
    let zoomFocusMs = 0;        // anchor point for zoom
    const PX_PER_OCTAVE = 100;  // vertical travel per 2× zoom step
    const COMMIT_PX = 8;        // pixels of motion to lock in pan vs zoom

    const update = (clientX) => {
      const rect = c.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const wfRange = state.wfEndMs - state.wfStartMs;
      const ms = state.wfStartMs + (x / rect.width) * wfRange;
      if (dragging === 'start') state.startMs = Math.min(state.endMs - 100, Math.max(state.wfStartMs, ms));
      else if (dragging === 'end') state.endMs = Math.max(state.startMs + 100, Math.min(state.wfEndMs, ms));
      render();
      if (state.onChange) state.onChange({ startMs: state.startMs, endMs: state.endMs });
    };
    c.addEventListener('touchstart', (e) => {
      if (!e.touches?.[0]) return;
      const rect = c.getBoundingClientRect();
      const t = e.touches[0];
      const x = t.clientX - rect.left;
      const handle = hitTestHandle(x);
      if (handle) {
        dragging = handle;
        e.preventDefault(); e.stopPropagation();
        return;
      }
      // Empty canvas area: defer between zoom (vertical) and pan
      // (horizontal). We pick the gesture after enough motion happens.
      dragging = 'undecided';
      touchStartX = t.clientX;
      touchStartY = t.clientY;
      initialRange = state.wfEndMs - state.wfStartMs;
      initialStartMs = state.wfStartMs;
      const frac = Math.max(0, Math.min(1, x / rect.width));
      zoomFocusMs = state.wfStartMs + frac * initialRange;
      e.preventDefault(); e.stopPropagation();
    }, { passive: false });
    c.addEventListener('touchmove', (e) => {
      if (!dragging || !e.touches?.[0]) return;
      const t = e.touches[0];
      const rect = c.getBoundingClientRect();
      const dx = t.clientX - touchStartX;
      const dy = t.clientY - touchStartY;
      if (dragging === 'undecided') {
        const ax = Math.abs(dx), ay = Math.abs(dy);
        if (ax < COMMIT_PX && ay < COMMIT_PX) return;
        dragging = (ax > ay) ? 'pan' : 'zoom';
      }
      if (dragging === 'zoom') {
        const factor = Math.pow(2, -dy / PX_PER_OCTAVE);
        const minRange = 500, maxRange = 30 * 60 * 1000;
        const newRange = Math.max(minRange, Math.min(maxRange, initialRange * factor));
        const frac = (zoomFocusMs - initialStartMs) / initialRange;
        state.wfStartMs = Math.max(0, zoomFocusMs - frac * newRange);
        state.wfEndMs = state.wfStartMs + newRange;
        render();
        e.preventDefault(); e.stopPropagation();
        return;
      }
      if (dragging === 'pan') {
        // Shift the viewport by the px → ms equivalent of dx.
        const msPerPx = initialRange / rect.width;
        const shift = -dx * msPerPx;
        state.wfStartMs = Math.max(0, initialStartMs + shift);
        state.wfEndMs = state.wfStartMs + initialRange;
        render();
        e.preventDefault(); e.stopPropagation();
        return;
      }
      // Handle drag.
      e.preventDefault();
      e.stopPropagation();
      update(t.clientX);
    }, { passive: false });
    c.addEventListener('touchend', (e) => {
      if (dragging === 'zoom' || dragging === 'pan') {
        // Re-decode at the new viewport so resolution catches up.
        const reqId = ++state._zoomReqId;
        const rs = state.wfStartMs, re = state.wfEndMs;
        loadWaveform(state.srcPath, rs, re).then(buckets => {
          if (!state || reqId !== state._zoomReqId) return;
          state.buckets = buckets;
          state.bucketsStartMs = rs;
          state.bucketsEndMs = re;
          render();
        });
        e.stopPropagation();
      } else if (dragging) {
        e.stopPropagation();
      }
      dragging = null;
    });
    c.addEventListener('mousedown', (e) => {
      const rect = c.getBoundingClientRect();
      dragging = hitTestHandle(e.clientX - rect.left);
    });
    window.addEventListener('mousemove', (e) => {
      if (dragging && dragging !== 'zoom' && dragging !== 'pan' && dragging !== 'undecided') update(e.clientX);
    });
    window.addEventListener('mouseup', () => { dragging = null; });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const frac = Math.max(0, Math.min(1, x / rect.width));
      const focusMs = state.wfStartMs + frac * (state.wfEndMs - state.wfStartMs);
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      applyZoom(factor, focusMs);
    }, { passive: false });
  }

  async function loadWaveform(srcPath, startMs, endMs) {
    const slicer = window.Capacitor?.Plugins?.AudioSlicer;
    if (!slicer) {
      console.warn('[waveform] AudioSlicer plugin not available');
      return [];
    }
    const attempt = async () => {
      try {
        const r = await slicer.getWaveform({ srcPath, startMs, endMs, samples: 200 });
        return Array.isArray(r.samples) ? r.samples : [];
      } catch (e) {
        console.warn('[waveform] decode failed:', e?.message || e);
        return [];
      }
    };
    let arr = await attempt();
    if (!arr.length) {
      // The slicer is sometimes busy right after a rapid re-show (continuous
      // play re-slices per cue). One delayed retry before giving up so a
      // transient miss doesn't surface as "waveform unavailable".
      await new Promise(r => setTimeout(r, 160));
      arr = await attempt();
    }
    console.log('[waveform] decoded ' + arr.length + ' buckets');
    return arr;
  }

  // Cancel any in-flight preview listener.
  function cancelPreview() {
    if (previewHandle) {
      try { previewHandle.remove(); } catch (e) {}
      previewHandle = null;
    }
    if (previewTimer) {
      clearTimeout(previewTimer);
      previewTimer = null;
    }
  }

  // Editor preview is a play/PAUSE toggle (like scene mode): the ▶/❚❚ button plays
  // the selection and flips to ❚❚; tapping again — or reaching the selection end /
  // the safety timeout — pauses and flips back to ▶.
  let _ppBtn = null, _previewing = false;
  function _setPlayIcon(p) { _previewing = !!p; if (_ppBtn) { try { _ppBtn.textContent = p ? '❚❚' : '▶'; } catch (_) {} } }
  function stopPreview() {
    try {
      const bg = window.Capacitor?.Plugins?.BackgroundAudio;
      if (bg) {
        bg.pause();
        // The 1× preview set the plugin's rate; give the book its listening
        // speed back so a later resume doesn't crawl at 1×.
        const r = window.audioPlaybackRate || 1;
        if (r !== 1 && typeof bg.setRate === 'function') { try { bg.setRate({ rate: r }); } catch (_) {} }
      }
    } catch (_) {}
    cancelPreview();
    _setPlayIcon(false);
  }

  // Off-screen pre-render: the previous show() decodes the NEXT card's window
  // into here so this show() can paint it instantly (no decode delay / flash).
  let _preCache = null;

  window.waveform = {
    async show({ container, srcPath, startMs, endMs, onChange, viewStartMs, viewEndMs, cacheKey, preload }) {
      if (!container) return;
      // cardMode = the live card-mode waveform (passes an explicit viewport).
      // The send-to-Anki EDITOR (waveform.edit → show with no viewStartMs) is
      // NOT cardMode: it must always show the draggable handles, never free-run
      // the cursor off the live audio, and stop the playhead at the selection
      // end. The card-mode behaviors are gated on cardMode below.
      const cardMode = Number.isFinite(viewStartMs);
      // Carry the playhead across a same-source re-show (continuous card play
      // re-shows the waveform for each new cue) so the cursor doesn't cold-start.
      // Only in cardMode — the editor must not inherit the live playhead.
      const carry = (cardMode && state && state.srcPath === srcPath && state.playheadPlaying)
        ? { ms: state.playheadMs, disp: state.playheadDispMs }
        : null;
      // Buckets to seed the FIRST paint, best → worst: (a) the off-screen
      // pre-render of THIS card (instant + exact); (b) the prior card's buckets
      // (approximate, refined async); else empty. Never blanks to "unavailable".
      const pre = (cacheKey && _preCache && _preCache.key === cacheKey &&
                   _preCache.buckets && _preCache.buckets.length) ? _preCache : null;
      const carryBuckets = (state && state.srcPath === srcPath && state.buckets && state.buckets.length)
        ? { buckets: state.buckets, s: state.bucketsStartMs, e: state.bucketsEndMs }
        : null;
      const seed = pre || carryBuckets;
      this.hide();
      // Viewport. Continuous card play passes an explicit window spanning the
      // cue PLUS the trailing silence up to the next cue (full width), so the
      // playhead is visibly seen advancing through the gap. Else cue ± pad.
      const wfStartMs = Number.isFinite(viewStartMs) ? Math.max(0, viewStartMs)
                                                     : Math.max(0, startMs - VIEWPORT_PAD_MS);
      const wfEndMs = (Number.isFinite(viewEndMs) && viewEndMs > wfStartMs) ? viewEndMs
                                                                            : (endMs + VIEWPORT_PAD_MS);

      container.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;font-size:.78rem;color:#888;margin-bottom:6px;font-variant-numeric:tabular-nums;letter-spacing:.04em;">
          <span data-role="start">–:––</span>
          <span style="flex:1;text-align:center;color:var(--text-muted,#888);font-weight:600;letter-spacing:.1em;">
            <span data-role="len">–:––</span>
          </span>
          <span data-role="end">–:––</span>
        </div>
        <canvas data-role="canvas" style="width:100%;height:96px;display:block;background:#0c0c0c;border:1px solid #1f1f1f;border-radius:8px;touch-action:none;"></canvas>
        ${cardMode ? '' : `
        <div style="display:flex;gap:8px;margin-top:8px;justify-content:center;">
          <button data-role="playpause" aria-label="Play / pause preview" style="background:transparent;color:var(--text,#e8e8e8);border:1px solid #333;width:46px;height:46px;border-radius:999px;font-size:1.15rem;line-height:1;display:flex;align-items:center;justify-content:center;cursor:pointer;">▶</button>
        </div>`}
      `;
      // Robust playhead seed: start from the CURRENT audio position and free-run
      // IMMEDIATELY when playing — don't depend on `carry` (often null on Android
      // at a card advance, which left the cursor frozen for the first moments
      // until the warmup gate cleared, while iOS's faster events hid it).
      // _bgPlaying is the reliable global play state.
      // The editor (not cardMode) never free-runs: it stays static at the
      // selection start until the user taps Preview (which the bg position
      // listener then animates, bounded to endMs).
      const _playing = cardMode ? (!!window._bgPlaying || !!carry) : false;
      // Seed at the FRESHEST true playhead. The card only advances once a (slow,
      // 200–500ms on Android) position event crosses the new cue's start, so by
      // now the real audio is already some ms into the cue. carry.ms is the prior
      // card's last polled position and carry.disp is its *displayed* value, which
      // lags it via the 8% phase-lock — both can sit behind the cue start. Take
      // the max of carry and the live getAudioProgress() so the cursor seeds at
      // the actual position, never behind it (never goes backward either).
      let _curPos = carry ? carry.ms : startMs;
      if (cardMode && _playing) {
        try { const _a = window.getAudioProgress?.(); if (_a && Number.isFinite(_a.ms)) _curPos = carry ? Math.max(_curPos, _a.ms) : _a.ms; } catch (_) {}
        // Floor at the PRIOR card's DISPLAYED cursor (playheadInterpMs): it
        // free-ran + phase-locked right up to this card advance, so it's the
        // freshest estimate of where the audio actually is NOW. carry.ms and
        // getAudioProgress are the last POLLED spot — up to one slow Android
        // poll-interval (200–500ms) behind — so seeding only from them starts the
        // cursor behind and it visibly STICKS at the cue start until the first
        // fresh event snaps it forward (worst on short cues, where it eats most of
        // the cue). Flooring at the prior displayed position removes the behind-
        // seed without overshooting; _seedSnap still corrects any residual on the
        // first authoritative event. Gated on `carry` so it only applies to a
        // same-source continuous advance (never crosses audio timelines).
        if (carry && state && Number.isFinite(state.playheadInterpMs)) {
          _curPos = Math.max(_curPos, state.playheadInterpMs);
        }
      }
      state = {
        cardMode,
        canvas: container.querySelector('[data-role="canvas"]'),
        startLabel: container.querySelector('[data-role="start"]'),
        endLabel:   container.querySelector('[data-role="end"]'),
        lenLabel:   container.querySelector('[data-role="len"]'),
        srcPath,
        buckets: seed ? seed.buckets : [],
        bucketsStartMs: seed ? seed.s : undefined,
        bucketsEndMs: seed ? seed.e : undefined,
        wfStartMs,
        wfEndMs,
        startMs,
        endMs,
        origStartMs: startMs,
        origEndMs: endMs,
        onChange,
        // Start warmed + playing whenever audio is playing, seeded at the LIVE
        // position, so the cursor free-runs from frame 1 of every card (no
        // Android cold-start freeze). playheadLastTs = now ⇒ sinceEvent starts
        // at 0, so tickPlayhead's free-run isn't gated off before the 1st event.
        playheadWarmed:  _playing,
        playheadPlaying: _playing,
        playheadMs:       _curPos,
        // Seed the DISPLAYED cursor at the same fresh position (not the prior
        // card's lagging carry.disp) so it starts exactly under the real audio.
        playheadDispMs:   _curPos,
        playheadInterpMs: _curPos,
        playheadLastTs:   performance.now(),
        // Reset the per-frame clock so the first tick's frameDt isn't computed
        // against the prior card's _tickTs (and isn't 0 from an unset value).
        _tickTs:          performance.now(),
        // First position-event correction SNAPS instead of easing at 8%/frame:
        // the seed is the last *polled* spot, which on Android can be a poll
        // interval behind the true audio, so the first real event must jump the
        // cursor to truth rather than slowly phase-lock (the start-stick).
        _seedSnap:        true
      };
      // Preview/Reset only exist in the editor (cardMode omits them — the card UI
      // has its own "Play card" pill). Guard the lookups.
      // iOS drops the FIRST synthesized click on a freshly-shown overlay button →
      // forward touchend to the click (preventDefault stops a duplicate click) so
      // the first tap registers. Same first-tap fix as the dict popup.
      const _firstTap = (btn) => { if (btn) btn.addEventListener('touchend', (e) => { try { if (e.cancelable) e.preventDefault(); } catch (_) {} btn.click(); }, { passive: false }); };
      // Play/pause toggle (replaces Preview + Reset; matches scene mode's clip button):
      // tap to play the selection (▶→❚❚), tap again to pause (❚❚→▶). Wire BOTH click
      // and touchend to the SAME handler with a firing guard (the proven first-tap
      // pattern) so the action runs directly on touchend — no btn.click() re-dispatch.
      const _ppBtn0 = container.querySelector('[data-role="playpause"]');
      if (_ppBtn0) {
        _ppBtn = _ppBtn0;
        _setPlayIcon(false);   // ▶ at rest
        let _ppFiring = false;
        const _ppGo = (e) => {
          if (_ppFiring) return; _ppFiring = true;
          try { e.stopPropagation(); } catch (_) {}
          try { if (e.cancelable) e.preventDefault(); } catch (_) {}
          try { if (_previewing) stopPreview(); else this.preview(); } catch (_) {}
          setTimeout(() => { _ppFiring = false; }, 350);
        };
        _ppBtn0.addEventListener('click', _ppGo);
        _ppBtn0.addEventListener('touchend', _ppGo, { passive: false });
      }
      attachInteractions();
      // Render SYNCHRONOUSLY now (not via rAF): forces layout so the freshly
      // created canvas is sized (clientWidth is 0 until laid out) and paints the
      // seeded waveform + playhead from frame 0 — so on Android the cursor is
      // visible/advancing immediately instead of waiting on a delayed rAF.
      render();
      if (_playing) startPlayheadAnim();   // then free-run (skip warmup wait)
      // Decode this card's window — unless the pre-render already gave us EXACT
      // buckets for it (then it's already painted; skip the redundant slice).
      const haveExact = seed && Number.isFinite(seed.s) &&
                        Math.abs(seed.s - wfStartMs) < 1 && Math.abs(seed.e - wfEndMs) < 1;
      if (!haveExact) {
        loadWaveform(srcPath, wfStartMs, wfEndMs).then(buckets => {
          if (!state || state.srcPath !== srcPath) return;
          if (!buckets || !buckets.length) return;  // keep seeded buckets — don't blank
          state.buckets = buckets;
          state.bucketsStartMs = wfStartMs;
          state.bucketsEndMs = wfEndMs;
          render();
        });
      }
      // Off-screen pre-render the NEXT card's window so its show() is instant.
      if (preload && preload.key && Number.isFinite(preload.viewStartMs) &&
          Number.isFinite(preload.viewEndMs) && (!_preCache || _preCache.key !== preload.key)) {
        loadWaveform(srcPath, preload.viewStartMs, preload.viewEndMs).then(buckets => {
          if (buckets && buckets.length) {
            _preCache = { key: preload.key, buckets, s: preload.viewStartMs, e: preload.viewEndMs };
          }
        });
      }
      // Playhead: subscribe to bg position so the white tick line tracks
      // playback in real time. The rAF loop interpolates between position
      // events so the line glides at 60 Hz instead of stepping at 150 ms.
      const bg = window.Capacitor?.Plugins?.BackgroundAudio;
      if (bg) {
        // Store the listener handles synchronously (await) so a racing hide()/re-show
        // can ALWAYS find + remove them. A fire-and-forget .then() can resolve AFTER
        // hide() nulled `state`, orphaning the native listener — it would then fire
        // forever (battery/CPU). If `state` changed during the await (a newer show()
        // ran), remove the just-attached handle instead of binding it to the new one.
        const _myState = state;
        const _posH = await bg.addListener('position', (d) => {
          if (!state) return;
          // Card-mode waveform that's currently OFF-SCREEN (user is in audio or
          // read mode — #cardContainer is never display:none, so without this the
          // listener would repaint an invisible canvas on every ~150ms position
          // event for the whole listen). Track the position cheaply, stop the
          // cursor rAF, and skip all paint/anim. The editor waveform (cardMode
          // false) is unaffected. Nothing is torn down → no re-show needed; the
          // next on-screen position event (or displayCard's show()) re-arms it.
          // document.hidden (screen off in card mode) takes the same cheap
          // branch: track the position, no paint; foreground re-arms it.
          if (state.cardMode && (document.hidden || !document.body.classList.contains('mode-card'))) {
            if (Number.isFinite(d.positionMs)) state.playheadMs = d.positionMs;
            state.playheadPlaying = !!d.playing;
            stopPlayheadAnim();
            return;
          }
          const prevPos = state.playheadMs;
          const prevInterp = state.playheadInterpMs;
          // Measure the ACTUAL playback velocity (ms audio per ms real) from
          // consecutive events. Extrapolating with the configured rate drifts
          // when the real rate differs — the source of the high-speed jitter.
          const nowTs = performance.now();
          if (Number.isFinite(prevPos) && Number.isFinite(state.playheadLastTs)) {
            const dv = d.positionMs - prevPos, dt = nowTs - state.playheadLastTs;
            if (dt > 20 && dv >= 0 && dv < 8000) {
              const inst = dv / dt;
              // Heavier low-pass (was .4) so a single late/early native event
              // can't jolt the speed, then clamp to a band around the requested
              // rate so a noisy delta can't fling the playhead (the jitter).
              state.playheadRate = (state.playheadRate || 1) * 0.85 + inst * 0.15;
              const want = 1;   // preview plays at 1×
              state.playheadRate = Math.max(want * 0.6, Math.min(want * 1.5, state.playheadRate));
            }
          }
          // Reject minor backward steps (the native poll occasionally
          // reports an older position right after play starts — caused
          // visible jitter at the beginning of a preview).
          const isMinorBackstep = Number.isFinite(prevInterp) &&
                                  d.positionMs < prevInterp &&
                                  prevInterp - d.positionMs < 250;
          if (!isMinorBackstep) {
            state.playheadMs = d.positionMs;
          }
          state.playheadLastTs = nowTs;
          state.playheadPlaying = !!d.playing;
          // Warmup gate: don't start the rAF interpolation until we've
          // seen the position actually MOVE between two events. During
          // MediaPlayer prepare the position can be reported as 0 several
          // times before real playback begins; extrapolating from those
          // produces the start-of-preview jitter. Once movement is
          // confirmed, the line streams smoothly.
          if (Number.isFinite(prevPos) && d.positionMs > prevPos + 5) {
            state.playheadWarmed = true;
          }
          if (d.playing && state.playheadWarmed) {
            // First authoritative event after a new-card seed: SNAP the displayed
            // cursor to truth. The seed was the last *polled* position (up to a
            // slow Android poll interval behind the real audio), so easing it in
            // at 8%/frame is the "stick at the cue start, then jump" artifact.
            // One-shot — steady playback below keeps eased/smooth thereafter.
            if (state._seedSnap && !isMinorBackstep) {
              state._seedSnap = false;
              state.playheadDispMs = state.playheadInterpMs = state.playheadMs;
            }
            // Steady playback: the rAF loop (tickPlayhead) owns the displayed
            // position. Do NOT also hard-set playheadInterpMs to d.positionMs
            // here — that jumped the cursor forward on each 150 ms event and
            // the very next frame snapped it back to the lagging smoothed
            // value (playheadDispMs), which was the visible jitter. tick eases
            // playheadDispMs toward playheadMs + dt*measuredRate.
            startPlayheadAnim();
          } else {
            // Pre-warmup or paused: snap the smoothed accumulator to the
            // authoritative position so the static render() is correct and the
            // rAF loop, when it starts, eases from the right value (no snap).
            state.playheadDispMs = state.playheadMs;
            state.playheadInterpMs = state.playheadMs;
            if (!d.playing) { stopPlayheadAnim(); render(); }
            else render();
          }
        }).catch(() => null);
        if (_posH) { if (state === _myState) state.playheadHandle = _posH; else { try { _posH.remove(); } catch (_) {} } }
        // Also listen for state changes — pause should freeze the playhead
        // immediately rather than waiting for the next stale position event.
        // A fresh play (e.g. tapping Preview again) resets the warmup gate
        // so the next prepare cycle doesn't visibly jitter.
        const _stH = await bg.addListener('state', (d) => {
          if (!state) return;
          state.playheadPlaying = !!d.playing;
          if (!d.playing) {
            // Freeze the cursor at the true last position (not the lagging
            // smoothed value) the instant we pause.
            state.playheadInterpMs = state.playheadDispMs = state.playheadMs;
            stopPlayheadAnim(); render();
          }
          else {
            state.playheadWarmed = false;
            state.playheadLastTs = performance.now();
            render();  // redraw without the bounds — they only show when stopped
          }
        }).catch(() => null);
        if (_stH) { if (state === _myState) state.stateHandle = _stH; else { try { _stH.remove(); } catch (_) {} } }
      }
    },

    // Re-paint on demand (app.js calls this from its persistent bg 'state'
    // listener so the bounds reliably appear/vanish on pause/play in card mode).
    renderNow() { if (state) { try { render(); } catch (_) {} } },
    // Drive the playhead cursor from an EXTERNAL clock (the scene card plays its
    // clip through a separate <audio> element, not the bg engine, so it sets the
    // absolute source-ms here each frame). Cheap repaint: restore the cached
    // static layer + draw the cursor.
    setPlayheadMs(ms) {
      if (!state || !Number.isFinite(ms)) return;
      state.playheadMs = ms;
      state.playheadInterpMs = ms;
      state.playheadDispMs = ms;
      try { paintFromSnapshot(); } catch (_) { try { render(); } catch (_) {} }
    },
    // Synchronously freeze / resume the playhead cursor — so a swipe-down PAUSE
    // stops the cursor INSTANTLY instead of free-running until the native 'state'
    // event round-trips back to us.
    setPlaying(playing) {
      if (!state) return;
      state.playheadPlaying = !!playing;
      if (playing) { startPlayheadAnim(); }
      else { stopPlayheadAnim(); try { render(); } catch (_) {} }
    },

    hide() {
      cancelPreview();
      stopPlayheadAnim();
      if (state?.playheadHandle) {
        try { state.playheadHandle.remove(); } catch (e) {}
      }
      if (state?.stateHandle) {
        try { state.stateHandle.remove(); } catch (e) {}
      }
      state = null;
    },

    async preview() {
      if (!state) return;
      const bg = window.Capacitor?.Plugins?.BackgroundAudio;
      if (!bg) return;
      cancelPreview(); // wipe any prior preview window
      const targetEnd = state.endMs;
      const startMs = state.startMs;
      const url = state.srcPath.startsWith('file://') ? state.srcPath : 'file://' + state.srcPath;
      // Round to int: Capacitor's getInt on Android silently returns the
      // default when the JSON Number is fractional (observed: 411000.19 → 0).
      const startMsInt = Math.round(startMs);
      console.log('[wf] preview play startMs=' + startMsInt + ' targetEnd=' + targetEnd);
      try {
        // Always 1× in the Anki editor: the clip is being AUDITIONED for the
        // card, and the listening speed would distort what gets checked.
        await bg.play({ url, startMs: startMsInt, rate: 1 });
      } catch (e) {
        console.warn('preview play:', e);
        return;
      }
      _setPlayIcon(true);   // playing → show ❚❚
      // Attach a position listener tied to THIS preview, then stop (pause + reset
      // the ▶/❚❚ icon) as soon as the segment ends (or after a safety timeout).
      // ARM guard: the FIRST position event after bg.play can still report the
      // STALE pre-seek position (the book's paused spot), which — if it's past
      // this clip's end — would fire stopPreview immediately and kill the preview
      // before it audibly starts (the "press twice" bug). Only allow the end-stop
      // once the playhead has actually been seen inside the clip (seek landed).
      let _armed = false;
      try {
        previewHandle = await bg.addListener('position', (d) => {
          const p = d.positionMs || 0;
          if (p < targetEnd - 100) _armed = true;
          if (_armed && p >= targetEnd - 30) stopPreview();
        });
      } catch (e) {
        console.warn('preview addListener:', e);
      }
      // Safety: cap the preview at the segment duration + 2 s.
      previewTimer = setTimeout(stopPreview, Math.max(1000, (targetEnd - startMs) + 2000));
    },

    current() {
      if (!state) return null;
      return { startMs: state.startMs, endMs: state.endMs };
    },

    // Zoom helpers, for buttons or programmatic use. Focus defaults to the
    // *active boundary*: zoomLeft keeps the left handle centered; zoomRight
    // keeps the right handle centered.
    zoomLeft(factor)  { if (state) applyZoom(factor, state.startMs); },
    zoomRight(factor) { if (state) applyZoom(factor, state.endMs); },
    zoomReset() {
      if (!state) return;
      state.wfStartMs = Math.max(0, state.origStartMs - VIEWPORT_PAD_MS);
      state.wfEndMs = state.origEndMs + VIEWPORT_PAD_MS;
      const reqId = ++state._zoomReqId;
      render();
      const rs = state.wfStartMs, re = state.wfEndMs;
      loadWaveform(state.srcPath, rs, re).then(b => {
        if (!state || reqId !== state._zoomReqId) return;
        state.buckets = b;
        state.bucketsStartMs = rs;
        state.bucketsEndMs = re;
        render();
      });
    },

    /**
     * Open a modal waveform editor.
     *   srcPath  — file path or URI to the audio
     *   startMs/endMs — initial selection
     *   title    — text shown above the waveform (e.g., the cue expression)
     *   cues     — optional array of {startMs, endMs, text}. When provided
     *              along with `cueIndex`, draggable left/right text-range
     *              handles appear and the audio bounds snap to the
     *              corresponding cue boundaries as the range expands or
     *              contracts.
     *   cueIndex — anchor cue (the one currently in focus).
     * Returns a Promise that resolves to { startMs, endMs, text, translation } when the
     * user taps "Send", or null if they Cancel.
     */
    edit({ srcPath, startMs, endMs, title, cues, cueIndex }) {
      return new Promise((resolve) => {
        const useTextHandles = Array.isArray(cues) && Number.isFinite(cueIndex) &&
                               cueIndex >= 0 && cueIndex < cues.length;
        const modeColor = getModeColor();

        const overlay = document.createElement('div');
        overlay.id = 'waveformEditorOverlay';
        overlay.style.cssText = `
          position:fixed; inset:0; background:rgba(0,0,0,0.88);
          display:flex; align-items:center; justify-content:center;
          z-index:12000; touch-action:none;
        `;
        // Block touch passthrough to the reader/audiobook UIs behind the
        // modal. Without this, swipes on the cue chip row would propagate
        // to the reader and scroll/page it underneath.
        const stop = (e) => e.stopPropagation();
        overlay.addEventListener('touchstart', stop, { passive: true });
        overlay.addEventListener('touchmove',  stop, { passive: true });
        overlay.addEventListener('touchend',   stop, { passive: true });
        overlay.addEventListener('wheel',      stop, { passive: true });
        const panel = document.createElement('div');
        panel.style.cssText = `
          background:var(--bg,#0c0c0c); border:1px solid var(--border,#2a2a2a);
          border-radius:12px; width:min(720px,96vw); padding:16px; box-sizing:border-box;
          max-height:92vh; overflow-y:auto; overflow-x:hidden; overscroll-behavior:contain;
        `;
        // Text picker: cues stack vertically inside a scrollable column so
        // long subtitle text can show in full and the user can scroll
        // through a wide selection. ± buttons sit on each side:
        //   left  +  → prepend the previous cue  to the selection
        //   left  −  → drop  the current first   selected cue
        //   right +  → append the next cue       to the selection
        //   right −  → drop  the current last    selected cue
        // Whenever the selection changes, audio bounds snap to the
        // matching cue boundaries and the waveform viewport grows to
        // include the new range.
        const textRowHtml = useTextHandles ? `
          <div data-role="text-row" style="display:flex;align-items:stretch;gap:8px;margin-bottom:10px;">
            <div style="display:flex;flex-direction:column;gap:6px;flex:0 0 32px;justify-content:center;">
              <button data-role="left-plus"  class="tr-btn" title="Add previous subtitle">+</button>
              <button data-role="left-minus" class="tr-btn" title="Drop first selected subtitle">−</button>
            </div>
            <div data-role="cues-row" style="
              flex:1; display:flex; flex-direction:column; gap:6px;
              max-height:240px; min-height:80px;
              overflow-y:auto; overflow-x:hidden;
              -webkit-overflow-scrolling:touch; touch-action:pan-y;
              scrollbar-width:thin;
              padding:2px;"></div>
            <div style="display:flex;flex-direction:column;gap:6px;flex:0 0 32px;justify-content:center;">
              <button data-role="right-minus" class="tr-btn" title="Drop last selected subtitle">−</button>
              <button data-role="right-plus"  class="tr-btn" title="Add next subtitle">+</button>
            </div>
          </div>
        ` : `
          <div style="font-size:.85rem;color:var(--text,#e8e8e8);margin-bottom:10px;
                      max-height:3.5em;overflow:hidden;text-overflow:ellipsis;
                      font-family:var(--font-family-card,serif);line-height:1.4;">
            ${title ? title : '<em style="color:#666;">Adjust bounds</em>'}
          </div>
        `;
        panel.innerHTML = `
          <style>
            #waveformEditorOverlay .tr-btn {
              flex:1; min-height:44px; padding:0; background:#1a1a1a; color:${modeColor};
              border:1px solid ${rgba(modeColor, 0.5)}; border-radius:6px;
              font-size:1.1rem; font-weight:700; cursor:pointer; touch-action:manipulation;
              transition: transform .12s ease, background .12s ease;
            }
            #waveformEditorOverlay .tr-btn:active { transform: scale(0.92); }
            #waveformEditorOverlay .tr-btn:disabled {
              color:#444; border-color:#1f1f1f; cursor:default; opacity:.4;
            }
            #waveformEditorOverlay .cue-chip {
              padding:10px 12px; border-radius:6px; font-size:.9rem;
              font-family:var(--font-family-card,serif); line-height:1.45;
              word-wrap:break-word; overflow-wrap:break-word;
              transition: transform .16s cubic-bezier(0.34, 1.56, 0.64, 1),
                          background .12s ease, border-color .12s ease;
            }
            #waveformEditorOverlay .cue-chip.selected {
              background:${rgba(modeColor, 0.13)};
              border:1px solid ${rgba(modeColor, 0.7)};
              color:var(--text,#e8e8e8);
              box-shadow: 0 0 0 1px ${rgba(modeColor, 0.25)} inset;
            }
            #waveformEditorOverlay .cue-chip.context {
              background:#0f0f0f; border:1px dashed #1f1f1f; color:#666;
            }
            #waveformEditorOverlay .bounce { transform: scale(1.05); }
            /* ── Translation card ── */
            #waveformEditorOverlay [hidden] { display:none !important; }
            #waveformEditorOverlay .tr-card {
              margin-top:16px; padding:12px 14px 14px; border-radius:16px;
              background:linear-gradient(180deg, rgba(255,255,255,0.045), rgba(255,255,255,0.015));
              border:1px solid rgba(255,255,255,0.07);
            }
            #waveformEditorOverlay .tr-head {
              display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:12px;
            }
            #waveformEditorOverlay .tr-title {
              display:flex; align-items:center; gap:9px; font-size:.78rem; font-weight:600;
              letter-spacing:.09em; text-transform:uppercase; color:#a3a3a3;
            }
            #waveformEditorOverlay .tr-engine {
              position:relative; display:inline-flex; align-items:center; gap:7px; min-width:0;
              height:32px; padding:0 30px 0 12px; border-radius:999px;
              background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.09);
              color:#dcdcdc; font-size:.8rem; font-weight:500; white-space:nowrap; cursor:pointer;
            }
            #waveformEditorOverlay .tr-engine:active { background:rgba(255,255,255,0.1); }
            #waveformEditorOverlay .tr-engine-dot {
              flex:0 0 auto; width:6px; height:6px; border-radius:50%;
              background:${modeColor}; box-shadow:0 0 8px ${rgba(modeColor, 0.7)};
            }
            #waveformEditorOverlay .tr-engine::after {
              content:''; position:absolute; right:13px; top:50%; width:6px; height:6px;
              border-right:1.5px solid #a3a3a3; border-bottom:1.5px solid #a3a3a3;
              transform:translateY(-70%) rotate(45deg); pointer-events:none;
            }
            #waveformEditorOverlay .tr-engine select {
              position:absolute; inset:0; width:100%; height:100%; opacity:0; cursor:pointer;
              -webkit-appearance:none; appearance:none; font-size:16px;
            }
            #waveformEditorOverlay .tr-actions { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
            #waveformEditorOverlay .tr-btn {
              display:flex; align-items:center; justify-content:center; gap:9px;
              height:46px; padding:0 14px; border-radius:12px; font-size:.95rem; font-weight:600;
              color:${modeColor}; background:${rgba(modeColor, 0.12)}; border:1px solid ${rgba(modeColor, 0.28)};
              cursor:pointer; touch-action:manipulation;
              transition:background .15s ease, border-color .15s ease, transform .12s ease, opacity .15s ease;
            }
            #waveformEditorOverlay .tr-btn:active { transform:scale(0.97); }
            #waveformEditorOverlay .tr-btn:disabled {
              color:#6e6e6e; background:rgba(255,255,255,0.04); border-color:rgba(255,255,255,0.07);
              cursor:default; transform:none;
            }
            #waveformEditorOverlay .tr-btn.on { background:${rgba(modeColor, 0.2)}; border-color:${rgba(modeColor, 0.5)}; }
            #waveformEditorOverlay .tr-chev {
              width:7px; height:7px; border-right:2px solid currentColor; border-bottom:2px solid currentColor;
              transform:translateY(-2px) rotate(45deg); transition:transform .2s ease;
            }
            #waveformEditorOverlay .tr-btn.on .tr-chev { transform:translateY(2px) rotate(-135deg); }
            #waveformEditorOverlay .tr-status {
              display:flex; align-items:center; gap:9px; margin:11px 2px 0;
              font-size:.8rem; line-height:1.4; color:#a3a3a3;
            }
            #waveformEditorOverlay .tr-status.err { color:#ef8a80; }
            #waveformEditorOverlay .tr-spin {
              flex:0 0 auto; width:14px; height:14px; border-radius:50%;
              border:2px solid ${rgba(modeColor, 0.22)}; border-top-color:${modeColor};
              animation:trSpin .8s linear infinite;
            }
            @keyframes trSpin { to { transform:rotate(360deg); } }
            #waveformEditorOverlay .mk-panel { margin-top:14px; }
            #waveformEditorOverlay .mk-hint { margin:0 2px 8px; font-size:.78rem; line-height:1.45; color:#8e8e8e; }
            #waveformEditorOverlay .mk-text {
              padding:12px 14px; border-radius:12px;
              background:rgba(0,0,0,0.38); border:1px solid rgba(255,255,255,0.07);
              font-family:var(--font-family-card,serif); font-size:1.15rem; line-height:2.1;
              color:var(--text,#e8e8e8); overflow-wrap:anywhere; cursor:text;
              touch-action:none; -webkit-user-select:none; user-select:none; -webkit-touch-callout:none;
            }
            #waveformEditorOverlay .mk-ch { padding:4px 0; transition:background-color .12s ease; }
            #waveformEditorOverlay .mk-ch.wd { box-shadow:inset 0 -1px 0 rgba(255,255,255,0.16); }
            #waveformEditorOverlay .mk-ch.we { padding-right:3px; }
            #waveformEditorOverlay .mk-ch.on {
              background:${rgba(modeColor, 0.3)}; color:#fff; box-shadow:inset 0 -2px 0 ${rgba(modeColor, 0.95)};
            }
            #waveformEditorOverlay .mk-ch.s { border-top-left-radius:5px; border-bottom-left-radius:5px; }
            #waveformEditorOverlay .mk-ch.e { border-top-right-radius:5px; border-bottom-right-radius:5px; }
            #waveformEditorOverlay .mk-ch.anchor {
              background:${rgba(modeColor, 0.14)}; box-shadow:inset 0 -2px 0 ${modeColor}; border-radius:5px;
            }
            #waveformEditorOverlay .mk-foot { display:flex; align-items:center; gap:12px; margin-top:10px; }
            #waveformEditorOverlay .mk-foot .tr-btn { flex:1; }
            #waveformEditorOverlay .tr-link {
              background:none; border:none; padding:8px 6px; color:#a3a3a3;
              font-size:.85rem; font-weight:500; cursor:pointer; touch-action:manipulation;
            }
            #waveformEditorOverlay .tr-link:active { color:#fff; }
            #waveformEditorOverlay .tr-out {
              margin-top:14px; border-radius:12px; overflow:hidden;
              background:rgba(0,0,0,0.38); border:1px solid rgba(255,255,255,0.07);
              transition:border-color .15s ease;
            }
            #waveformEditorOverlay .tr-out:focus-within { border-color:${rgba(modeColor, 0.45)}; }
            #waveformEditorOverlay .tr-out-head {
              display:flex; align-items:center; justify-content:space-between; gap:8px; padding:4px 6px 0 14px;
            }
            #waveformEditorOverlay .tr-chip {
              display:flex; align-items:center; gap:7px; min-width:0; font-size:.72rem;
              letter-spacing:.02em; color:#9a9a9a; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
            }
            #waveformEditorOverlay .tr-chip::before {
              content:''; flex:0 0 auto; width:5px; height:5px; border-radius:50%; background:${modeColor};
            }
            #waveformEditorOverlay [data-role="tr-result"] {
              display:block; width:100%; box-sizing:border-box; min-height:3em; max-height:40vh; resize:none;
              background:transparent; color:var(--text,#e8e8e8); border:none; outline:none;
              padding:4px 14px 14px; font:inherit; font-size:.95rem; line-height:1.55;
              -webkit-user-select:text; user-select:text; touch-action:auto;
            }
            #waveformEditorOverlay .tr-dest { margin:8px 4px 0; font-size:.75rem; line-height:1.4; color:#7f7f7f; }
            #waveformEditorOverlay .tr-dest.stale { color:#e0a040; }
            #waveformEditorOverlay .btn-send-mode {
              background:${modeColor} !important; color:#000 !important;
              border:none !important; font-weight:700;
            }
          </style>
          ${textRowHtml}
          <div data-role="wf-host"></div>
          <div data-role="tr-section" class="tr-card">
            <div class="tr-head">
              <div class="tr-title">Translation</div>
              <label class="tr-engine">
                <span class="tr-engine-dot"></span>
                <span data-role="tr-eng-label">Apple · On-device</span>
                <select data-role="tr-engine" aria-label="Translation engine">
                  <option value="apple">Apple · On-device</option>
                  <option value="ai">OpenRouter</option>
                </select>
              </label>
            </div>
            <div class="tr-actions">
              <button data-role="tr-translate" class="tr-btn">Translate</button>
              <button data-role="tr-explain" class="tr-btn" aria-expanded="false">Explain<span class="tr-chev"></span></button>
            </div>
            <div data-role="mk-panel" class="mk-panel" hidden>
              <div class="mk-hint">Tap words to highlight what’s confusing (words side by side make one phrase), or drag across a phrase. Leave it blank to explain only the advanced grammar.</div>
              <div data-role="mk-text" class="mk-text"></div>
              <div class="mk-foot">
                <button data-role="mk-go" class="tr-btn">Explain advanced grammar</button>
                <button data-role="mk-clear" class="tr-link" hidden>Clear</button>
              </div>
            </div>
            <div data-role="tr-status" class="tr-status" hidden></div>
            <div data-role="tr-wrap" hidden>
              <div class="tr-out">
                <div class="tr-out-head">
                  <span data-role="tr-chip" class="tr-chip"></span>
                  <button data-role="tr-clear" class="tr-link">Remove</button>
                </div>
                <textarea data-role="tr-result" rows="2" spellcheck="false"></textarea>
              </div>
              <div data-role="tr-note" class="tr-dest" hidden></div>
            </div>
          </div>
          <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px;">
            <button data-role="cancel" class="btn">Cancel</button>
            <button data-role="send" class="btn btn-send-mode">Send to Anki</button>
          </div>
        `;
        overlay.appendChild(panel);
        // iPhone / iPad: an iOS-style dialog (ios-feel.css) — a tall rounded
        // card, the subtitles get the extra room, Cancel / Send bottom right.
        const _ios = document.documentElement.classList.contains('kadoki-ios');
        if (_ios) {
          overlay.classList.add('kios');
          overlay.style.setProperty('--kios-accent', modeColor);
          panel.querySelector('[data-role="send"]')?.parentElement?.classList.add('kios-actions');
        }
        document.body.appendChild(overlay);
        document.body.classList.add('prefs-open');

        const host = panel.querySelector('[data-role="wf-host"]');
        // Pause the audiobook while editing so the live playhead doesn't sweep
        // past the selection and the handles stay grabbable (restored on close).
        const _bgEdit = window.Capacitor?.Plugins?.BackgroundAudio;
        const _editWasPlaying = !!window._bgPlaying;
        if (_editWasPlaying) { try { _bgEdit?.pause?.({ fadeMs: 120 }); } catch (_) {} }
        this.show({ container: host, srcPath, startMs, endMs });

        const textRangeState = useTextHandles ? {
          leftIdx: cueIndex,
          rightIdx: cueIndex
        } : null;

        function renderCueChips(bounceIdx) {
          if (!textRangeState) return;
          const row = panel.querySelector('[data-role="cues-row"]');
          if (!row) return;
          // Always show at least one cue of context on each side when available,
          // so the user sees what they're about to absorb. Selection cues use
          // mode color; context cues are dimmed and dashed.
          const lo = Math.max(0, textRangeState.leftIdx - 1);
          const hi = Math.min(cues.length - 1, textRangeState.rightIdx + 1);
          row.innerHTML = '';
          for (let i = lo; i <= hi; i++) {
            const selected = i >= textRangeState.leftIdx && i <= textRangeState.rightIdx;
            const div = document.createElement('div');
            div.className = 'cue-chip ' + (selected ? 'selected' : 'context');
            div.textContent = cues[i].text;
            div.dataset.cueIdx = i;
            row.appendChild(div);
          }
          // Bounce the chip that just changed selection state, and scroll
          // it into view since the chip column is vertically scrollable
          // and a freshly added (or about-to-be-removed) chip on the far
          // end may otherwise sit outside the visible window.
          if (Number.isFinite(bounceIdx)) {
            const target = row.querySelector(`[data-cue-idx="${bounceIdx}"]`);
            if (target) {
              target.classList.add('bounce');
              setTimeout(() => target.classList.remove('bounce'), 160);
              try { target.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {}
            }
          }
          // Button enable/disable state.
          const leftPlus  = panel.querySelector('[data-role="left-plus"]');
          const leftMinus = panel.querySelector('[data-role="left-minus"]');
          const rightPlus = panel.querySelector('[data-role="right-plus"]');
          const rightMinus= panel.querySelector('[data-role="right-minus"]');
          if (leftPlus)  leftPlus.disabled  = textRangeState.leftIdx <= 0;
          if (leftMinus) leftMinus.disabled = textRangeState.leftIdx >= textRangeState.rightIdx;
          if (rightPlus) rightPlus.disabled = textRangeState.rightIdx >= cues.length - 1;
          if (rightMinus)rightMinus.disabled= textRangeState.rightIdx <= textRangeState.leftIdx;
        }
        function applyTextRange(bounceIdx) {
          if (!textRangeState) return;
          renderCueChips(bounceIdx);
          onSelectionChanged();
          const newStart = cues[textRangeState.leftIdx].startMs;
          const newEnd   = cues[textRangeState.rightIdx].endMs;
          if (state) {
            state.startMs = newStart;
            state.endMs   = newEnd;
            let viewportChanged = false;
            if (newStart < state.wfStartMs) {
              state.wfStartMs = Math.max(0, newStart - VIEWPORT_PAD_MS);
              viewportChanged = true;
            }
            if (newEnd > state.wfEndMs) {
              state.wfEndMs = newEnd + VIEWPORT_PAD_MS;
              viewportChanged = true;
            }
            if (viewportChanged) {
              const reqId = ++state._zoomReqId;
              const rs = state.wfStartMs, re = state.wfEndMs;
              loadWaveform(state.srcPath, rs, re).then(b => {
                if (!state || reqId !== state._zoomReqId) return;
                state.buckets = b;
                state.bucketsStartMs = rs;
                state.bucketsEndMs = re;
                render();
              });
            }
            render();
          }
        }
        if (useTextHandles) {
          renderCueChips();
          // Wire the four ± buttons. iOS WKWebView inside a touch-blocking
          // overlay (the modal stops touchstart/move/end at line ~663) eats
          // the synthetic click that normally follows touchend, so a plain
          // 'click' listener never fires here. Per
          // [[reference-paged-reader-button-pitfalls]], the working recipe
          // is: listen for 'click', 'pointerup', AND 'touchend' with capture,
          // dedupe within a tick.
          const wireButton = (role, action) => {
            const el = panel.querySelector(`[data-role="${role}"]`);
            if (!el) return;
            let firingTick = 0;
            const fire = (e) => {
              if (el.disabled) return;
              // Same-event dedupe — touchend then synthetic click then
              // pointerup can all fire for one tap. Run the action once
              // per render-frame.
              const now = performance.now();
              if (now - firingTick < 200) return;
              firingTick = now;
              console.log(`[wf-btn] ${role} ${e?.type} → action`);
              if (e?.stopPropagation) e.stopPropagation();
              if (e?.preventDefault)  e.preventDefault();
              action();
            };
            el.addEventListener('click', fire);
            el.addEventListener('pointerup', fire);
            el.addEventListener('touchend', fire, { capture: true });
          };
          wireButton('left-plus', () => {
            if (textRangeState.leftIdx <= 0) return;
            textRangeState.leftIdx--;
            applyTextRange(textRangeState.leftIdx);
          });
          wireButton('left-minus', () => {
            if (textRangeState.leftIdx >= textRangeState.rightIdx) return;
            const dropped = textRangeState.leftIdx;
            textRangeState.leftIdx++;
            applyTextRange(dropped);
          });
          wireButton('right-plus', () => {
            if (textRangeState.rightIdx >= cues.length - 1) return;
            textRangeState.rightIdx++;
            applyTextRange(textRangeState.rightIdx);
          });
          wireButton('right-minus', () => {
            if (textRangeState.rightIdx <= textRangeState.leftIdx) return;
            const dropped = textRangeState.rightIdx;
            textRangeState.rightIdx--;
            applyTextRange(dropped);
          });
        }

        // ── Translation (Translate / Translate + explain — anki-translate.js) ──
        // The result is shown, and editable, BEFORE sending; Send hands it to the
        // swipe note type's translation field (Preferences → Anki).
        let _trBusy = false, _trReq = 0, _trForText = null, _closed = false;
        const trBtnT   = panel.querySelector('[data-role="tr-translate"]');
        const trBtnX   = panel.querySelector('[data-role="tr-explain"]');
        const trStatus = panel.querySelector('[data-role="tr-status"]');
        const trWrap   = panel.querySelector('[data-role="tr-wrap"]');
        const trBox    = panel.querySelector('[data-role="tr-result"]');
        const trNote   = panel.querySelector('[data-role="tr-note"]');
        const trClear  = panel.querySelector('[data-role="tr-clear"]');
        const trChip   = panel.querySelector('[data-role="tr-chip"]');
        // Translate engine: Apple (free, on-device) or the AI backend — remembered.
        // A native <select> sits invisibly over the pill, so a tap opens the
        // system menu while the pill shows a short label. Explain always uses AI.
        const ENGINE_KEY = 'ANKI_TRANSLATE_ENGINE';
        const trEngSel   = panel.querySelector('[data-role="tr-engine"]');
        const trEngLabel = panel.querySelector('[data-role="tr-eng-label"]');
        let _trEngine = 'apple';
        try { if (localStorage.getItem(ENGINE_KEY) === 'ai') _trEngine = 'ai'; } catch (_) {}
        let _appleOk = true, _aiName = 'OpenRouter';
        // Renders the menu and returns the engine Translate will actually use.
        function renderEngine() {
          const eff = (!_appleOk && _trEngine === 'apple') ? 'ai' : _trEngine;
          if (trEngSel) {
            const optApple = trEngSel.querySelector('option[value="apple"]');
            const optAi = trEngSel.querySelector('option[value="ai"]');
            if (optApple) optApple.disabled = !_appleOk;
            if (optAi) optAi.textContent = _aiName;
            trEngSel.value = eff;
          }
          if (trEngLabel) trEngLabel.textContent = eff === 'apple' ? 'Apple · On-device' : _aiName;
          // Explain needs the AI engine: greyed out on Apple, and its panel closes.
          // (Looked up here rather than via mkPanel/mkGo, which are declared later.)
          const explainOk = eff === 'ai';
          if (trBtnX) {
            trBtnX.disabled = _trBusy || !explainOk;
            if (!explainOk && trBtnX.classList.contains('on')) {
              trBtnX.classList.remove('on');
              trBtnX.setAttribute('aria-expanded', 'false');
              const mp = panel.querySelector('[data-role="mk-panel"]');
              if (mp) mp.hidden = true;
            }
          }
          const go = panel.querySelector('[data-role="mk-go"]');
          if (go) go.disabled = _trBusy || !explainOk;
          return eff;
        }
        renderEngine();
        (async () => {
          try {
            if (!window.ankiTranslate) return;
            _aiName = await window.ankiTranslate.aiName();
            _appleOk = await window.ankiTranslate.appleAvailable();
            if (!_closed) renderEngine();
          } catch (_) {}
        })();
        // ── Highlight-to-explain: mark the confusing parts before Explain ──
        // The passage is laid out as one span per character. Drag paints a range
        // (starting on a highlight erases instead); a tap sets a start character
        // and the next tap highlights through to it; a tap on a highlight clears
        // that phrase. Maximal highlighted runs become the phrases sent to the AI.
        const mkPanel = panel.querySelector('[data-role="mk-panel"]');
        const mkText  = panel.querySelector('[data-role="mk-text"]');
        const mkGo    = panel.querySelector('[data-role="mk-go"]');
        const mkClear = panel.querySelector('[data-role="mk-clear"]');
        let _mkChars = [], _mkOn = [], _mkFor = null, _mkAnchor = -1;
        // Word units from the dictionary's own longest-match (deinflection-
        // aware): _mkWord[i] = [start, end] of the word holding character i.
        // Until segmentation finishes (or without a dictionary) each character
        // is its own unit.
        let _mkWord = [], _mkSegGen = 0;
        const wordOf = (i) => _mkWord[i] || [i, i];
        const PUNCT_RE = /[\s、。，．,.!?！？「」『』（）()…―・〜~"'“”‘’:;：；]/;
        async function segmentMarkText(text) {
          const gen = ++_mkSegGen;
          const chars = Array.from(text);
          const seg = window.dictSegmentWord;
          if (typeof seg !== 'function') return;
          const out = new Array(chars.length);
          // dictSegmentWord indexes UTF-16 code units; map char → offset.
          const off = []; let o = 0; for (const c of chars) { off.push(o); o += c.length; }
          let i = 0;
          while (i < chars.length) {
            if (PUNCT_RE.test(chars[i])) { out[i] = [i, i]; i++; continue; }
            let len = 1;
            try {
              const r = await seg(text, off[i]);
              const units = Math.max(1, Number(r && r.length) || 1);
              // code units → characters
              let n = 0, u = 0;
              while (i + n < chars.length && u < units) { u += chars[i + n].length; n++; }
              len = Math.max(1, n);
            } catch (_) {}
            if (gen !== _mkSegGen) return;          // passage changed meanwhile
            for (let k = i; k < i + len; k++) out[k] = [i, i + len - 1];
            i += len;
          }
          if (gen !== _mkSegGen) return;
          _mkWord = out;
          paintMarks();
        }
        function markPhrases() {
          const out = [];
          let cur = '';
          for (let i = 0; i < _mkChars.length; i++) {
            if (_mkOn[i]) cur += _mkChars[i];
            else if (cur) { if (cur.trim()) out.push(cur.trim()); cur = ''; }
          }
          if (cur.trim()) out.push(cur.trim());
          return out;
        }
        function paintMarks() {
          if (!mkText) return;
          const spans = mkText.children;
          for (let i = 0; i < spans.length; i++) {
            const on = !!_mkOn[i];
            spans[i].classList.toggle('on', on);
            spans[i].classList.toggle('s', on && !_mkOn[i - 1]);   // rounded ends of each highlight
            spans[i].classList.toggle('e', on && !_mkOn[i + 1]);
            spans[i].classList.toggle('anchor', i === _mkAnchor);
            const w = _mkWord[i];
            spans[i].classList.toggle('wd', !!w && !PUNCT_RE.test(_mkChars[i]));
            spans[i].classList.toggle('we', !!w && w[1] === i && i < spans.length - 1);
          }
          const n = markPhrases().length;
          if (mkGo) mkGo.textContent = n ? ('Explain ' + n + ' highlight' + (n > 1 ? 's' : '')) : 'Explain advanced grammar';
          if (mkClear) mkClear.hidden = !n && _mkAnchor < 0;
        }
        function renderMarkText() {
          if (!mkText) return;
          const text = currentSelectionText();
          if (text === _mkFor) return;          // same passage: keep the highlights
          _mkFor = text;
          _mkChars = Array.from(text);
          _mkOn = _mkChars.map(() => false);
          _mkAnchor = -1;
          _mkWord = [];
          segmentMarkText(text);
          mkText.textContent = '';
          _mkChars.forEach((ch, i) => {
            const s = document.createElement('span');
            s.className = 'mk-ch';
            s.dataset.i = String(i);
            s.textContent = ch;
            mkText.appendChild(s);
          });
          paintMarks();
        }
        if (mkText) {
          let drag = null;   // { anchor, value, before, moved, last }
          const idxAt = (x, y) => {
            const el = document.elementFromPoint(x, y);
            const s = el && el.closest ? el.closest('.mk-ch') : null;
            return (s && mkText.contains(s)) ? Number(s.dataset.i) : -1;
          };
          mkText.addEventListener('pointerdown', (e) => {
            const i = idxAt(e.clientX, e.clientY);
            if (i < 0) return;
            e.preventDefault();
            try { mkText.setPointerCapture(e.pointerId); } catch (_) {}
            drag = { anchor: i, value: !_mkOn[i], before: _mkOn.slice(), moved: false, last: i };
          });
          mkText.addEventListener('pointermove', (e) => {
            if (!drag) return;
            const j = idxAt(e.clientX, e.clientY);
            if (j < 0 || j === drag.last) return;
            drag.last = j;
            drag.moved = true;
            const lo = Math.min(wordOf(drag.anchor)[0], wordOf(j)[0]), hi = Math.max(wordOf(drag.anchor)[1], wordOf(j)[1]);
            for (let k = 0; k < _mkOn.length; k++) _mkOn[k] = (k >= lo && k <= hi) ? drag.value : drag.before[k];
            _mkAnchor = -1;
            paintMarks();
          });
          mkText.addEventListener('pointerup', () => {
            if (!drag) return;
            const d = drag;
            drag = null;
            if (d.moved) return;
            const i = d.anchor;
            // A tap toggles the whole word (dictionary segmentation);
            // neighbouring highlighted words read as one phrase.
            const [lo, hi] = wordOf(i);
            const on = !_mkOn[i];
            for (let k = lo; k <= hi; k++) _mkOn[k] = on;
            _mkAnchor = -1;
            try { window.kHaptic?.('LIGHT'); } catch (_) {}
            paintMarks();
          });
          mkText.addEventListener('pointercancel', () => { drag = null; });
        }
        function currentSelectionText() {
          if (textRangeState) {
            let t = '';
            for (let i = textRangeState.leftIdx; i <= textRangeState.rightIdx; i++) {
              if (i > textRangeState.leftIdx) t += ' ';
              t += cues[i].text;
            }
            return t;
          }
          return String(title || '').replace(/<[^>]+>/g, '').trim();
        }
        function renderTrNote() {
          if (!trNote) return;
          const stale = _trForText !== null && _trForText !== currentSelectionText();
          trNote.textContent = stale ? 'The selection changed since this was made. Translate again to update it.' : '';
          trNote.classList.toggle('stale', stale);
          trNote.hidden = !stale;
        }
        function onSelectionChanged() {
          if (trWrap && !trWrap.hidden) renderTrNote();
          if (mkPanel && !mkPanel.hidden) renderMarkText();   // new passage: highlights reset
        }
        // Status line under the buttons: spinner + label while busy, red on error,
        // hidden when there is nothing to say.
        function setTrBusy(busy, label, isError) {
          _trBusy = busy;
          if (trBtnT) trBtnT.disabled = busy;
          renderEngine();                        // Explain buttons: disabled while busy or on Apple
          if (!trStatus) return;
          trStatus.textContent = '';
          trStatus.classList.toggle('err', !!isError);
          if (busy) {
            const spin = document.createElement('span');
            spin.className = 'tr-spin';
            trStatus.appendChild(spin);
          }
          if (label) trStatus.appendChild(document.createTextNode(label));
          trStatus.hidden = !label;
        }
        // The result box grows with its text (up to 40% of the screen, then scrolls).
        function autosizeResult() {
          if (!trBox) return;
          trBox.style.height = 'auto';
          trBox.style.height = Math.min(trBox.scrollHeight, Math.round(window.innerHeight * 0.4)) + 'px';
        }
        if (trBox) trBox.addEventListener('input', autosizeResult);
        // Key of the passage + highlights the current explanation was made for.
        let _mkExplainedKey = null, _trPromise = null, _trMode = null;
        const explainKey = (text, phrases) => text + '\u0000' + phrases.join('\u0001');
        // Highlights the user marked but hasn't had explained yet (or changed since):
        // Send finishes that explanation before the card can go out.
        function explainPendingKey() {
          if (!mkPanel || mkPanel.hidden || renderEngine() !== 'ai') return null;
          const phrases = markPhrases();
          if (!phrases.length) return null;
          const key = explainKey(currentSelectionText(), phrases);
          return key === _mkExplainedKey ? null : key;
        }
        // Resolves true when a result was shown, false otherwise. A request already
        // running is shared, so Send can wait on the same one.
        function runTranslation(mode) {
          if (_trBusy && _trPromise) return _trPromise;
          _trPromise = runTranslationNow(mode);
          return _trPromise;
        }
        async function runTranslationNow(mode) {
          if (_trBusy || !window.ankiTranslate) return false;
          const text = currentSelectionText();
          if (!text) return false;
          _trMode = mode;
          const req = ++_trReq;
          const focus = mode === 'explain' ? markPhrases() : [];
          setTrBusy(true, mode !== 'explain' ? 'Translating…'
            : (focus.length ? 'Explaining the highlighted parts…' : 'Looking for advanced grammar…'));
          try {
            const r = await window.ankiTranslate.run(text, mode, { engine: renderEngine(), focus });
            if (_closed || req !== _trReq) return false;
            trBox.value = r.text;
            _trForText = text;
            _mkExplainedKey = mode === 'explain' ? explainKey(text, focus) : null;
            trWrap.hidden = false;
            if (trChip) {
              const by = r.engine === 'apple' ? 'Apple · on-device'
                : ((r.name || 'AI') + (r.model ? ' · ' + String(r.model).split('/').pop() : ''));
              trChip.textContent = (mode === 'explain' ? 'Explanation' : 'Translation') + ' · ' + by;
            }
            setTrBusy(false, '');
            autosizeResult();
            renderTrNote();
            return true;
          } catch (e) {
            if (_closed || req !== _trReq) return false;
            setTrBusy(false, (e && e.message) || String(e), true);
            return false;
          }
        }
        // Same first-tap-safe wiring as the ± buttons (iOS drops the synthetic click).
        const tapTr = (el, fn) => {
          if (!el) return;
          let last = 0;
          const h = (e) => {
            if (el.disabled) return;
            const now = performance.now();
            if (now - last < 350) return;
            last = now;
            try { if (e && e.cancelable) e.preventDefault(); } catch (_) {}
            fn();
          };
          el.addEventListener('click', h);
          el.addEventListener('touchend', h, { passive: false });
        };
        const chooseEngine = (eng) => {
          if (eng === 'apple' && !_appleOk) return;
          _trEngine = eng;
          try { localStorage.setItem(ENGINE_KEY, eng); } catch (_) {}
          renderEngine();
        };
        if (trEngSel) trEngSel.addEventListener('change', () => chooseEngine(trEngSel.value));
        tapTr(trBtnT, () => runTranslation('translate'));
        // Explain opens (or closes) the highlight panel; its own button runs it.
        tapTr(trBtnX, () => {
          if (!mkPanel) return runTranslation('explain');
          const open = mkPanel.hidden;
          mkPanel.hidden = !open;
          trBtnX.classList.toggle('on', open);
          trBtnX.setAttribute('aria-expanded', open ? 'true' : 'false');
          if (open) {
            renderMarkText();
            try { mkPanel.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {}
          }
        });
        tapTr(mkGo, () => runTranslation('explain'));
        tapTr(mkClear, () => {
          _mkOn = _mkOn.map(() => false);
          _mkAnchor = -1;
          paintMarks();
        });
        tapTr(trClear, () => {
          _trReq++;                    // drop any answer still on its way
          if (trBox) trBox.value = '';
          _trForText = null;
          _mkExplainedKey = null;      // highlights count as unexplained again
          if (trWrap) trWrap.hidden = true;
          setTrBusy(false, '');
        });

        const close = (result) => {
          _closed = true;
          try { this.hide(); } catch (e) {}
          if (_ios) {
            // Fade the dialog away, then remove it.
            overlay.classList.add('kios-out');
            overlay.style.pointerEvents = 'none';
            setTimeout(() => overlay.remove(), 200);
          } else {
            overlay.remove();
          }
          document.body.classList.remove('prefs-open');
          // Resume the audiobook if we paused it on open.
          if (_editWasPlaying) { try { _bgEdit?.resume?.({ fadeMs: 120 }); } catch (_) {} }
          resolve(result);
        };

        // First-tap fix (iOS drops the first synthesized click on a freshly-shown
        // overlay button): forward touchend → click, preventDefault stops a dup.
        const _ft = (btn) => { if (btn) btn.addEventListener('touchend', (e) => { try { if (e.cancelable) e.preventDefault(); } catch (_) {} btn.click(); }, { passive: false }); };
        const _cancelBtn = panel.querySelector('[data-role="cancel"]');
        _cancelBtn.addEventListener('click', () => close(null));
        _ft(_cancelBtn);
        const _sendBtn = panel.querySelector('[data-role="send"]');
        const SEND_LABEL = _sendBtn.textContent;
        let _skipPendingKey = null;
        _sendBtn.addEventListener('click', async () => {
          if (_sendBtn.disabled) return;
          // Unfinished work (user choice, 2026-09-14): highlighted phrases that
          // haven't been explained, or a translation/explanation still running.
          // Finish it, show it, and wait for a second Send, so the card never
          // goes out without the explanation asked for, or before it was seen.
          const pendingKey = explainPendingKey();
          const waitFor = (_trBusy && _trPromise) ? _trPromise
            : ((pendingKey && pendingKey !== _skipPendingKey) ? runTranslation('explain') : null);
          if (waitFor) {
            const kind = _trMode === 'translate' ? 'translation' : 'explanation';
            _sendBtn.disabled = true;
            _sendBtn.textContent = kind === 'translation' ? 'Translating…' : 'Explaining…';
            let ok = false;
            try { ok = await waitFor; } catch (_) {}
            if (_closed) return;
            _sendBtn.disabled = false;
            _sendBtn.textContent = SEND_LABEL;
            if (ok) {
              setTrBusy(false, 'Review the ' + kind + ', then tap Send to Anki.');
              try { trWrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {}
            } else {
              // Don't trap the user behind a failing request (no key, offline):
              // the next Send goes out without it.
              _skipPendingKey = explainPendingKey();
              if (trStatus) {
                trStatus.hidden = false;
                trStatus.appendChild(document.createTextNode(' Tap Send to Anki again to send without it.'));
              }
            }
            return;
          }
          const cur = this.current();
          if (!cur) return close(null);
          const text = textRangeState ? currentSelectionText() : null;
          // The reviewed (possibly edited) translation, when one is showing.
          const translation = (trWrap && !trWrap.hidden && trBox) ? trBox.value.trim() : '';
          close({ startMs: cur.startMs, endMs: cur.endMs, text, translation });
        });
        _ft(_sendBtn);
      });
    }
  };
})();
