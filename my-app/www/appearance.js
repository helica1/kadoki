// appearance.js — per-mode typography + image presentation prefs.
//
// Persisted as JSON in localStorage["APPEARANCE_V1"]. Applies to :root as
// CSS custom properties so theme.css / inline styles can react.
//
// Modes: card / read / audio.
//   --font-size-{mode}  (e.g. "1.8rem")
//   --align-{mode}      (left / center / right)
//   --image-{mode}-display (block / none)
//   --image-{mode}-opacity (0..1)
//   --image-{mode}-align   (flex-start / center / flex-end)  — vertical
//
// Default object below is the source of truth for shape + defaults.

(function () {
  const KEY = 'APPEARANCE_V1';

  // Font stacks. Keys appear in the picker; values are full CSS font-family
  // strings with sensible fallbacks (Japanese-aware).
  const FONT_STACKS = {
    system:   '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    sans:     '"Helvetica Neue", "Noto Sans CJK JP", "Noto Sans", sans-serif',
    serif:    'Georgia, "Noto Serif CJK JP", "Hiragino Mincho Pro", serif',
    mono:     'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    jpSans:   '"Noto Sans CJK JP", "Hiragino Kaku Gothic Pro", "Yu Gothic", sans-serif',
    jpSerif:  '"Noto Serif CJK JP", "Hiragino Mincho Pro", "YuMincho", serif'
  };

  const DEFAULTS = {
    card:  { fontSize: '1.8rem', align: 'center', fontFamily: 'serif',
             imageDisplay: 'block', imageOpacity: 1, imageAlign: 'flex-start' },
    read:  { fontSize: '1rem',   align: 'left',   fontFamily: 'serif',
             imageDisplay: 'none',  imageOpacity: 1, imageAlign: 'flex-start',
             // 'bg' = current behavior (translucent fill + underline);
             // 'text' = recolor the cue text only (less artifact-prone).
             highlightStyle: 'text' },
    audio: { fontSize: '1.6rem', align: 'center', fontFamily: 'serif',
             imageDisplay: 'block', imageOpacity: 0.6, imageAlign: 'center' }
  };

  function deepMerge(into, from) {
    for (const k of Object.keys(from)) {
      if (from[k] && typeof from[k] === 'object' && !Array.isArray(from[k])) {
        into[k] = deepMerge(into[k] || {}, from[k]);
      } else {
        into[k] = from[k];
      }
    }
    return into;
  }

  function load() {
    const base = JSON.parse(JSON.stringify(DEFAULTS));
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return base;
      return deepMerge(base, JSON.parse(raw));
    } catch (e) {
      return base;
    }
  }

  function persist(state) {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }

  function applyAll(state) {
    const root = document.documentElement;
    for (const mode of ['card', 'read', 'audio']) {
      const s = state[mode] || {};
      const fontKey = s.fontFamily || DEFAULTS[mode].fontFamily;
      root.style.setProperty(`--font-size-${mode}`,      s.fontSize     || DEFAULTS[mode].fontSize);
      root.style.setProperty(`--align-${mode}`,          s.align        || DEFAULTS[mode].align);
      root.style.setProperty(`--font-family-${mode}`,    FONT_STACKS[fontKey] || FONT_STACKS.serif);
      root.style.setProperty(`--image-${mode}-display`,  s.imageDisplay || DEFAULTS[mode].imageDisplay);
      root.style.setProperty(`--image-${mode}-opacity`,  s.imageOpacity ?? DEFAULTS[mode].imageOpacity);
      root.style.setProperty(`--image-${mode}-align`,    s.imageAlign   || DEFAULTS[mode].imageAlign);
    }
    // Reading-mode highlight style: 'bg' (translucent fill + underline)
    // vs 'text' (recolor the cue text). Toggled via a body class so
    // CSS in theme.css can swap the visual.
    const hs = (state.read && state.read.highlightStyle) || DEFAULTS.read.highlightStyle;
    document.body.classList.toggle('highlight-text', hs === 'text');
    document.body.classList.toggle('highlight-bg',   hs !== 'text');
  }

  const current = load();
  if (document.readyState !== 'loading') applyAll(current);
  else document.addEventListener('DOMContentLoaded', () => applyAll(current));

  // Public API: read/update/reset.
  window.appearance = {
    get(mode)        { return current[mode] ? { ...current[mode] } : null; },
    set(mode, patch) {
      if (!current[mode]) return;
      Object.assign(current[mode], patch);
      applyAll(current);
      persist(current);
    },
    all() { return JSON.parse(JSON.stringify(current)); },
    defaults() { return JSON.parse(JSON.stringify(DEFAULTS)); },
    fontStacks() { return { ...FONT_STACKS }; }
  };
})();
