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
    const rate = window.audioPlaybackRate || 1;
    const dt = performance.now() - (state.playheadLastTs || 0);
    // Stale-event guard: when dt is huge (paused tab, slow first event),
    // don't extrapolate ahead — wait for a fresh position event.
    if (dt > 300) {
      state.playheadInterpMs = state.playheadMs;
    } else {
      state.playheadInterpMs = state.playheadMs + dt * rate;
    }
    render();
    // Stop the loop once playback has passed the selection end. The line
    // is already invisible (render() clips to [startMs, endMs]); no need
    // to keep burning rAF frames.
    if (state.playheadInterpMs >= state.endMs) {
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

    // ---- selection frame ----
    ctx.strokeStyle = rgba(accent, 0.6);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0 + 0.5, wfTop + 0.5, (x1 - x0), wfHeight - 1);

    // Soft selection glow background.
    ctx.fillStyle = rgba(accent, 0.06);
    ctx.fillRect(x0, wfTop, x1 - x0, wfHeight);

    // ---- playhead (driven by bg position events, smoothed via rAF) ----
    // Only paint within the SELECTED region (startMs..endMs). Audio that
    // continues playing past the selection end — common when the user
    // opens the editor mid-playback in audiobook mode — would otherwise
    // drag the line through the whole context window, which is visually
    // wrong: the line represents progress through the cue, not the file.
    const phMs = Number.isFinite(state.playheadInterpMs)
      ? state.playheadInterpMs : state.playheadMs;
    if (Number.isFinite(phMs) && phMs >= state.startMs && phMs <= state.endMs) {
      const px = Math.round(((phMs - wfStartMs) / wfRange) * cssW) + 0.5;
      ctx.strokeStyle = '#ffffff';
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, wfTop);
      ctx.lineTo(px, wfBottom);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

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

  function hitTestHandle(xPx) {
    if (!state) return null;
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
    try {
      const r = await slicer.getWaveform({ srcPath, startMs, endMs, samples: 200 });
      const arr = Array.isArray(r.samples) ? r.samples : [];
      console.log('[waveform] decoded ' + arr.length + ' buckets, peak=' +
        (arr.length ? Math.max(...arr).toFixed(3) : 'n/a'));
      return arr;
    } catch (e) {
      console.warn('[waveform] decode failed:', e?.message || e);
      return [];
    }
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

  window.waveform = {
    async show({ container, srcPath, startMs, endMs, onChange }) {
      if (!container) return;
      this.hide();
      const wfStartMs = Math.max(0, startMs - VIEWPORT_PAD_MS);
      const wfEndMs = endMs + VIEWPORT_PAD_MS;

      container.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;font-size:.78rem;color:#888;margin-bottom:6px;font-variant-numeric:tabular-nums;letter-spacing:.04em;">
          <span data-role="start">–:––</span>
          <span style="flex:1;text-align:center;color:var(--text-muted,#888);font-weight:600;letter-spacing:.1em;">
            <span data-role="len">–:––</span>
          </span>
          <span data-role="end">–:––</span>
        </div>
        <canvas data-role="canvas" style="width:100%;height:96px;display:block;background:#0c0c0c;border:1px solid #1f1f1f;border-radius:8px;touch-action:none;"></canvas>
        <div style="display:flex;gap:8px;margin-top:8px;justify-content:center;">
          <button data-role="preview" style="background:transparent;color:var(--text,#e8e8e8);border:1px solid #333;padding:6px 16px;border-radius:999px;font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;font-weight:600;">Preview</button>
          <button data-role="reset" style="background:transparent;color:#666;border:1px solid #2a2a2a;padding:6px 14px;border-radius:999px;font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;">Reset</button>
        </div>
      `;
      state = {
        canvas: container.querySelector('[data-role="canvas"]'),
        startLabel: container.querySelector('[data-role="start"]'),
        endLabel:   container.querySelector('[data-role="end"]'),
        lenLabel:   container.querySelector('[data-role="len"]'),
        srcPath,
        buckets: [],
        wfStartMs,
        wfEndMs,
        startMs,
        endMs,
        origStartMs: startMs,
        origEndMs: endMs,
        onChange
      };
      container.querySelector('[data-role="preview"]').addEventListener('click', () => this.preview());
      container.querySelector('[data-role="reset"]').addEventListener('click', () => {
        state.startMs = state.origStartMs;
        state.endMs = state.origEndMs;
        render();
        if (state.onChange) state.onChange({ startMs: state.startMs, endMs: state.endMs });
      });
      attachInteractions();
      requestAnimationFrame(render);
      // Kick off the actual waveform decode in the background.
      loadWaveform(srcPath, wfStartMs, wfEndMs).then(buckets => {
        if (!state || state.srcPath !== srcPath) return;
        state.buckets = buckets;
        state.bucketsStartMs = wfStartMs;
        state.bucketsEndMs = wfEndMs;
        render();
      });
      // Playhead: subscribe to bg position so the white tick line tracks
      // playback in real time. The rAF loop interpolates between position
      // events so the line glides at 60 Hz instead of stepping at 150 ms.
      const bg = window.Capacitor?.Plugins?.BackgroundAudio;
      if (bg) {
        bg.addListener('position', (d) => {
          if (!state) return;
          const prevPos = state.playheadMs;
          const prevInterp = state.playheadInterpMs;
          // Reject minor backward steps (the native poll occasionally
          // reports an older position right after play starts — caused
          // visible jitter at the beginning of a preview).
          const isMinorBackstep = Number.isFinite(prevInterp) &&
                                  d.positionMs < prevInterp &&
                                  prevInterp - d.positionMs < 250;
          if (!isMinorBackstep) {
            state.playheadMs = d.positionMs;
            state.playheadInterpMs = d.positionMs;
          }
          state.playheadLastTs = performance.now();
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
          if (d.playing && state.playheadWarmed) startPlayheadAnim();
          else if (!d.playing) { stopPlayheadAnim(); render(); }
          else render();
        }).then(h => { if (state) state.playheadHandle = h; }).catch(() => {});
        // Also listen for state changes — pause should freeze the playhead
        // immediately rather than waiting for the next stale position event.
        // A fresh play (e.g. tapping Preview again) resets the warmup gate
        // so the next prepare cycle doesn't visibly jitter.
        bg.addListener('state', (d) => {
          if (!state) return;
          state.playheadPlaying = !!d.playing;
          if (!d.playing) { stopPlayheadAnim(); render(); }
          else {
            state.playheadWarmed = false;
            state.playheadLastTs = performance.now();
          }
        }).then(h => { if (state) state.stateHandle = h; }).catch(() => {});
      }
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
        await bg.play({ url, startMs: startMsInt, rate: window.audioPlaybackRate || 1 });
      } catch (e) {
        console.warn('preview play:', e);
        return;
      }
      // Attach a position listener tied to THIS preview, then remove it as
      // soon as the segment ends (or after a safety timeout).
      try {
        previewHandle = await bg.addListener('position', (d) => {
          if ((d.positionMs || 0) >= targetEnd - 30) {
            try { bg.pause(); } catch (_) {}
            cancelPreview();
          }
        });
      } catch (e) {
        console.warn('preview addListener:', e);
      }
      // Safety: cap the preview at the segment duration + 2 s.
      previewTimer = setTimeout(cancelPreview, Math.max(1000, (targetEnd - startMs) + 2000));
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
     * Returns a Promise that resolves to { startMs, endMs, text } when the
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
          border-radius:12px; width:min(640px,94vw); padding:16px;
        `;
        // Text picker: three cues across (prev, current, next). The middle
        // chunk is "selected" by default and rendered in mode color, the
        // others are dimmed context. ± buttons on each end expand or
        // contract the selection one cue at a time; whenever the selection
        // changes, the audio bounds snap to the matching cue boundaries.
        const textRowHtml = useTextHandles ? `
          <div data-role="text-row" style="display:flex;align-items:stretch;gap:6px;margin-bottom:10px;">
            <div style="display:flex;flex-direction:column;gap:4px;flex:0 0 28px;">
              <button data-role="left-plus" class="tr-btn">+</button>
              <button data-role="left-minus" class="tr-btn">−</button>
            </div>
            <div data-role="cues-row" style="
              flex:1; display:flex; gap:4px; align-items:stretch;
              min-height:3em; overflow-x:auto; overflow-y:hidden;
              -webkit-overflow-scrolling:touch; touch-action:pan-x;
              scrollbar-width:thin;"></div>
            <div style="display:flex;flex-direction:column;gap:4px;flex:0 0 28px;">
              <button data-role="right-plus" class="tr-btn">+</button>
              <button data-role="right-minus" class="tr-btn">−</button>
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
              flex:1; padding:0; background:#1a1a1a; color:${modeColor};
              border:1px solid ${rgba(modeColor, 0.5)}; border-radius:6px;
              font-size:1rem; font-weight:700; cursor:pointer; touch-action:manipulation;
              transition: transform .12s ease, background .12s ease;
            }
            #waveformEditorOverlay .tr-btn:active { transform: scale(0.92); }
            #waveformEditorOverlay .tr-btn:disabled {
              color:#444; border-color:#1f1f1f; cursor:default;
            }
            #waveformEditorOverlay .cue-chip {
              padding:8px 10px; border-radius:6px; font-size:.85rem;
              font-family:var(--font-family-card,serif); line-height:1.35;
              max-height:5em; overflow-y:auto;
              flex:0 0 auto; min-width:120px; max-width:240px;
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
            #waveformEditorOverlay .btn-send-mode {
              background:${modeColor} !important; color:#000 !important;
              border:none !important; font-weight:700;
            }
          </style>
          ${textRowHtml}
          <div data-role="wf-host"></div>
          <div style="font-size:.7rem;color:#666;text-align:center;margin-top:6px;">
            ${useTextHandles
              ? 'Use + and − to grow or trim the selection · drag waveform handles for fine audio bounds'
              : 'Drag vertically to zoom · drag horizontally to pan · drag handles to set bounds'}
          </div>
          <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px;">
            <button data-role="cancel" class="btn">Cancel</button>
            <button data-role="send" class="btn btn-send-mode">Send to Anki</button>
          </div>
        `;
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        document.body.classList.add('prefs-open');

        const host = panel.querySelector('[data-role="wf-host"]');
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
          // Bounce the chip that just changed selection state.
          if (Number.isFinite(bounceIdx)) {
            const target = row.querySelector(`[data-cue-idx="${bounceIdx}"]`);
            if (target) {
              target.classList.add('bounce');
              setTimeout(() => target.classList.remove('bounce'), 160);
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
          // Wire the four ± buttons. Each click changes the selection by one
          // cue and bounces the newly-affected cue chip.
          panel.querySelector('[data-role="left-plus"]').addEventListener('click', () => {
            if (textRangeState.leftIdx <= 0) return;
            textRangeState.leftIdx--;
            applyTextRange(textRangeState.leftIdx);
          });
          panel.querySelector('[data-role="left-minus"]').addEventListener('click', () => {
            if (textRangeState.leftIdx >= textRangeState.rightIdx) return;
            const dropped = textRangeState.leftIdx;
            textRangeState.leftIdx++;
            applyTextRange(dropped);
          });
          panel.querySelector('[data-role="right-plus"]').addEventListener('click', () => {
            if (textRangeState.rightIdx >= cues.length - 1) return;
            textRangeState.rightIdx++;
            applyTextRange(textRangeState.rightIdx);
          });
          panel.querySelector('[data-role="right-minus"]').addEventListener('click', () => {
            if (textRangeState.rightIdx <= textRangeState.leftIdx) return;
            const dropped = textRangeState.rightIdx;
            textRangeState.rightIdx--;
            applyTextRange(dropped);
          });
        }

        const close = (result) => {
          try { this.hide(); } catch (e) {}
          overlay.remove();
          document.body.classList.remove('prefs-open');
          resolve(result);
        };

        panel.querySelector('[data-role="cancel"]').addEventListener('click', () => close(null));
        panel.querySelector('[data-role="send"]').addEventListener('click', () => {
          const cur = this.current();
          if (!cur) return close(null);
          let text = null;
          if (textRangeState) {
            text = '';
            for (let i = textRangeState.leftIdx; i <= textRangeState.rightIdx; i++) {
              if (i > textRangeState.leftIdx) text += ' ';
              text += cues[i].text;
            }
          }
          close({ startMs: cur.startMs, endMs: cur.endMs, text });
        });
      });
    }
  };
})();
