// mode-colors.js — persist + apply user-chosen mode accents.
//
// Modes: card / read / audio. Each maps to the CSS custom property
// --accent-{mode} on :root. Defaults match theme.css.
//
// Persisted as JSON under localStorage["MODE_COLORS_V1"].

(function () {
  const KEY = 'MODE_COLORS_V1';
  const DEFAULTS = { card: '#ff9550', read: '#4caf50', audio: '#b794f6' };

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return { ...DEFAULTS };
      const o = JSON.parse(raw);
      return {
        card:  o.card  || DEFAULTS.card,
        read:  o.read  || DEFAULTS.read,
        audio: o.audio || DEFAULTS.audio,
      };
    } catch (e) {
      return { ...DEFAULTS };
    }
  }

  function persist(colors) {
    try { localStorage.setItem(KEY, JSON.stringify(colors)); } catch (e) {}
  }

  function applyAll(colors) {
    const root = document.documentElement;
    root.style.setProperty('--accent-card',  colors.card);
    root.style.setProperty('--accent-read',  colors.read);
    root.style.setProperty('--accent-audio', colors.audio);
    // accent-green tracks the read color so the running-timer dot stays in
    // family if the user picks a different read accent.
    root.style.setProperty('--accent-green', colors.read);
    // Reading-mode highlight derives from --accent-read; let the read module
    // re-derive its rgba shades.
    try { window.dispatchEvent(new CustomEvent('shell:mode-change')); } catch (e) {}
  }

  const current = load();
  // Apply ASAP so first paint uses persisted colors.
  if (document.readyState !== 'loading') applyAll(current);
  else document.addEventListener('DOMContentLoaded', () => applyAll(current));

  // Live-apply when a picker changes; also write through to storage so the
  // next page-load uses it. Don't wait for Save (Save just closes the modal).
  window.applyModeColor = function (mode, hex) {
    if (!mode || !hex) return;
    if (!(mode in current)) return;
    current[mode] = hex;
    applyAll(current);
    persist(current);
  };

  // Sync the pickers in the preferences modal to current values whenever
  // the modal opens (savePreferences may have other side effects, so we
  // observe via a small helper instead of monkey-patching).
  window.syncModeColorPickers = function () {
    const ids = { card: 'modeColorCard', read: 'modeColorRead', audio: 'modeColorAudio' };
    for (const mode of Object.keys(ids)) {
      const el = document.getElementById(ids[mode]);
      if (el) el.value = current[mode];
    }
  };

  window.getModeColors = function () { return { ...current }; };
})();
