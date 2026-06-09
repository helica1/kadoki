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
    // Defaults updated 2026-05-30 per user request:
    // card/audio = 30 px (1.875 rem), read = 28 px (1.75 rem).
    card:  { fontSize: '1.875rem', align: 'center', fontFamily: 'serif',
             // imageAlign 'center' (was 'flex-start'): the Anki-deck card image is
             // vertically centered in its area instead of pinned to the top under
             // the subtitle (the dedicated "Image position" pref was removed, so
             // this default is what users get). Matches audio mode.
             imageDisplay: 'block', imageOpacity: 1, imageAlign: 'center',
             // Toggles (default = preserve current behavior): show the SRT-card
             // waveform + the blurred ambient cover backdrop; show the upcoming
             // subtitle (grayed) is opt-in OFF.
             showWaveform: true, showNextSub: false, showBgImage: true },
    read:  { fontSize: '1.75rem', align: 'left',   fontFamily: 'serif',
             imageDisplay: 'none',  imageOpacity: 1, imageAlign: 'flex-start',
             // 'bg' = current behavior (translucent fill + underline);
             // 'text' = recolor the cue text only (less artifact-prone).
             highlightStyle: 'text' },
    audio: { fontSize: '1.875rem', align: 'center', fontFamily: 'serif',
             imageDisplay: 'block', imageOpacity: 0.6, imageAlign: 'center',
             showWaveform: true, showNextSub: false },
    // Dictionary popup — font only (not a reading "mode"). Default 'system'
    // preserves the popup's original look; the picker also offers serif/sans +
    // any imported custom TTF/OTF font.
    dict:  { fontFamily: 'system' }
  };

  // Resolve a stored fontFamily value to a full CSS font-family stack. Handles
  // 'custom:<id>' (an imported TTF/OTF → its registered FontFace, with JP-aware
  // fallbacks used while loading / for missing glyphs) and the built-in
  // FONT_STACKS keys; anything unknown falls back to serif.
  function resolveFontFamily(fontKey) {
    if (typeof fontKey === 'string' && fontKey.indexOf('custom:') === 0) {
      const fam = (window.fonts && window.fonts.familyFor) ? window.fonts.familyFor(fontKey.slice(7)) : null;
      return fam ? `"${fam}", "Noto Sans CJK JP", "Hiragino Kaku Gothic Pro", sans-serif`
                 : FONT_STACKS.serif;
    }
    return FONT_STACKS[fontKey] || FONT_STACKS.serif;
  }

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
      // Resolve the font family. A user-imported font is stored as
      // 'custom:<id>' → use its registered FontFace family name (kfont-<id>)
      // with JP-aware fallbacks (used while the face is still loading, and for
      // any glyphs the imported font lacks). Otherwise the built-in picker
      // exposes serif/sans; any other legacy stored value falls back to serif.
      // (Custom fonts are honoured for ALL modes — read included — so fonts can
      // be set per mode.)
      root.style.setProperty(`--font-family-${mode}`, resolveFontFamily(fontKey));
      root.style.setProperty(`--image-${mode}-display`,  s.imageDisplay || DEFAULTS[mode].imageDisplay);
      root.style.setProperty(`--image-${mode}-opacity`,  s.imageOpacity ?? DEFAULTS[mode].imageOpacity);
      const imgAlign = s.imageAlign || DEFAULTS[mode].imageAlign;
      root.style.setProperty(`--image-${mode}-align`,    imgAlign);
      // Mirror flex-align values to CSS object-position keywords so card-mode
      // can pin the contained image to top / center / bottom in the new
      // flex-driven layout (image fills the available area; the pref decides
      // which edge it sticks to inside that box).
      const objPos = imgAlign === 'flex-start' ? 'top'
                    : imgAlign === 'flex-end'   ? 'bottom'
                    : 'center';
      root.style.setProperty(`--image-${mode}-objpos`, objPos);
    }
    // Dictionary popup font (a single global setting, not a per-mode block).
    root.style.setProperty('--font-family-dict',
      resolveFontFamily((state.dict && state.dict.fontFamily) || DEFAULTS.dict.fontFamily));
    // Reading-mode highlight style: 'bg' (translucent fill + underline)
    // vs 'text' (recolor the cue text). Toggled via a body class so
    // CSS in theme.css can swap the visual.
    const hs = (state.read && state.read.highlightStyle) || DEFAULTS.read.highlightStyle;
    document.body.classList.toggle('highlight-text', hs === 'text');
    document.body.classList.toggle('highlight-bg',   hs !== 'text');

    // Appearance toggles → body classes. Only the NON-default state adds a
    // class (clean profile = no class). CSS keys off these to show/hide the
    // waveforms (overriding JS-set inline display via !important) and the
    // grayed upcoming-subtitle elements. The livewaveform hook re-evaluates
    // its canvas + idles the rAF loop when hidden (so it's not just CSS-hidden
    // while still drawing). Hooks may not exist yet at boot — guarded.
    const cardS = state.card || {}, audioS = state.audio || {};
    document.body.classList.toggle('pref-card-waveform-off',  cardS.showWaveform === false);
    document.body.classList.toggle('pref-card-bgimage-off',   cardS.showBgImage === false);
    document.body.classList.toggle('pref-card-nextsub-on',    cardS.showNextSub === true);
    document.body.classList.toggle('pref-audio-waveform-off', audioS.showWaveform === false);
    document.body.classList.toggle('pref-audio-nextsub-on',   audioS.showNextSub === true);
    try { window._liveWaveformApplyVisibility && window._liveWaveformApplyVisibility(); } catch (_) {}
    // A card font-size change alters how much text fits per screen → re-fit the
    // combined SRT cards to the new line budget (place-safe; debounced).
    try { window.onCardLayoutChanged && window.onCardLayoutChanged(); } catch (_) {}
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
    fontStacks() { return { ...FONT_STACKS }; },
    // Re-apply current state to the CSS vars (e.g. after a custom font finishes
    // registering, or fonts are imported/removed).
    refresh() { applyAll(current); }
  };
})();
