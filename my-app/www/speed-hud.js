// Playback-speed HUD for the vertical speed drag (Read and Audio mode).
// A large readout of the ACTUAL rate while the finger moves: the number, a
// 1.0×–2.0× track with the drag's starting speed marked, and which speed is
// being changed (Read / Audio, or one shared speed). Purely visual — the
// drag code calls show(rate) / hide(); it never touches playback itself.
(function () {
  'use strict';
  const MIN = 1.0, MAX = 2.0;
  let el = null, numEl, fillEl, startEl, capEl, hideTimer = null, startRate = null;

  function build() {
    if (el) return el;
    const css = document.createElement('style');
    css.textContent = `
      #kSpeedHud {
        position: fixed; left: 50%; top: calc(env(safe-area-inset-top, 0px) + 18%);
        transform: translate(-50%, -6px) scale(.96);
        z-index: 2147483000; pointer-events: none;
        min-width: 188px; padding: 16px 22px 18px;
        border-radius: 22px;
        background: rgba(18, 18, 20, .78);
        -webkit-backdrop-filter: blur(18px) saturate(1.4); backdrop-filter: blur(18px) saturate(1.4);
        border: 1px solid rgba(255, 255, 255, .10);
        box-shadow: 0 10px 40px rgba(0, 0, 0, .35);
        color: #f2f2f2; text-align: center;
        font-family: var(--font-sans, -apple-system, system-ui, sans-serif);
        opacity: 0; transition: opacity .16s ease, transform .16s ease;
        --k-hud-accent: #4caf50;
      }
      #kSpeedHud.on { opacity: 1; transform: translate(-50%, 0) scale(1); }
      #kSpeedHud .ksh-cap {
        font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase;
        color: var(--k-hud-accent); opacity: .95; margin-bottom: 4px;
      }
      #kSpeedHud .ksh-num {
        font-size: 54px; line-height: 1.05; font-weight: 600; letter-spacing: -.02em;
        font-variant-numeric: tabular-nums;
      }
      #kSpeedHud .ksh-num small { font-size: 28px; font-weight: 500; opacity: .6; margin-left: 2px; }
      #kSpeedHud .ksh-track {
        position: relative; height: 6px; margin: 12px 2px 6px; border-radius: 3px;
        background: rgba(255, 255, 255, .14);
      }
      #kSpeedHud .ksh-fill {
        position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px;
        background: var(--k-hud-accent); transition: width .08s linear;
      }
      #kSpeedHud .ksh-start {
        position: absolute; top: -4px; width: 2px; height: 14px; margin-left: -1px;
        border-radius: 1px; background: rgba(255, 255, 255, .7);
      }
      #kSpeedHud .ksh-ends {
        display: flex; justify-content: space-between;
        font-size: 10.5px; color: rgba(255, 255, 255, .45); font-variant-numeric: tabular-nums;
      }
      @media (prefers-reduced-motion: reduce) { #kSpeedHud, #kSpeedHud .ksh-fill { transition: none; } }
    `;
    document.head.appendChild(css);
    el = document.createElement('div');
    el.id = 'kSpeedHud';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = '<div class="ksh-cap"></div><div class="ksh-num"></div>' +
      '<div class="ksh-track"><div class="ksh-fill"></div><div class="ksh-start"></div></div>' +
      '<div class="ksh-ends"><span>' + MIN.toFixed(1) + '×</span><span>' + MAX.toFixed(1) + '×</span></div>';
    document.body.appendChild(el);
    capEl = el.querySelector('.ksh-cap');
    numEl = el.querySelector('.ksh-num');
    fillEl = el.querySelector('.ksh-fill');
    startEl = el.querySelector('.ksh-start');
    return el;
  }

  const frac = (r) => Math.max(0, Math.min(1, (r - MIN) / (MAX - MIN)));

  function caption() {
    const b = document.body.classList;
    const mode = window._remoteListen || b.contains('mode-audio') ? 'audio' : b.contains('mode-read') ? 'read' : 'card';
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue(mode === 'audio' ? '--accent-audio' : mode === 'read' ? '--accent-read' : '--accent-card').trim();
    const label = !window._playbackPerMode ? 'Speed' : mode === 'audio' ? 'Audio speed' : mode === 'read' ? 'Reading speed' : 'Card speed';
    return { label, accent };
  }

  function show(rate) {
    const r = Number(rate);
    if (!Number.isFinite(r)) return;
    build();
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (!el.classList.contains('on')) {
      startRate = r;
      const { label, accent } = caption();
      capEl.textContent = label;
      if (accent) el.style.setProperty('--k-hud-accent', accent);
      startEl.style.left = (frac(r) * 100) + '%';
    }
    numEl.innerHTML = r.toFixed(2) + '<small>×</small>';
    fillEl.style.width = (frac(r) * 100) + '%';
    el.classList.add('on');
  }

  function hide(delayMs) {
    if (!el) return;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { hideTimer = null; el.classList.remove('on'); startRate = null; }, Math.max(0, delayMs || 0));
  }

  window.kadokiSpeedHud = { show, hide, MIN, MAX };
})();
