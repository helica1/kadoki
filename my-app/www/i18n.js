// i18n.js — minimal UI-chrome localization engine (English / Japanese).
//
// Scope: UI CHROME ONLY (buttons, menus, Preferences, dialogs, status/toasts).
// CONTENT — book text, dictionary entries, AI summaries, scene captions, character
// names — is NEVER translated here.
//
// Usage:
//   window.i18n.t('key')                 → translated string (falls back to key)
//   window.i18n.t('key', 'English text') → with an explicit English fallback
//   window.i18n.fmt('key', {n: 3})       → with {placeholder} substitution
//   window.t('key')                      → shorthand for i18n.t
//   Static HTML: <span data-i18n="key">English text</span>  (applyStatic translates it)
//                <input data-i18n-ph="key" placeholder="…">  (translates placeholder)
//                <div data-i18n-html="key">…</div>           (translates innerHTML)
//
// The strings table lives in i18n-strings.js as window.I18N_STRINGS = { key: {en, ja} }.
// Default language is ENGLISH (per product decision); users switch to 日本語 in Preferences.
(function () {
  'use strict';
  var KEY = 'UI_LANG';

  function detect() {
    try { var v = localStorage.getItem(KEY); if (v === 'en' || v === 'ja') return v; } catch (_) {}
    return 'en';   // default English
  }

  var api = {
    lang: detect(),

    // Look up a key for the current language. Order: requested lang → English → the
    // explicit fallback → the key itself. Never throws.
    t: function (key, fallback) {
      try {
        var tbl = window.I18N_STRINGS;
        var e = tbl && tbl[key];
        if (e) {
          var v = e[api.lang];
          if (typeof v === 'string') return v;
          if (typeof e.en === 'string') return e.en;   // missing JA → show English, not the key
        }
      } catch (_) {}
      return (fallback != null) ? fallback : key;
    },

    // t() with {placeholder} substitution: fmt('x', {deck: 'Foo'}).
    fmt: function (key, vars, fallback) {
      var s = api.t(key, fallback);
      if (vars) { for (var k in vars) { if (Object.prototype.hasOwnProperty.call(vars, k)) s = s.split('{' + k + '}').join(String(vars[k])); } }
      return s;
    },

    get: function () { return api.lang; },

    // Switch language: persist (localStorage + Capacitor Preferences), re-translate any
    // static [data-i18n] DOM, and fire 'kai:lang' so dynamically-built UI can re-render.
    set: async function (lang) {
      if (lang !== 'en' && lang !== 'ja') return;
      if (lang === api.lang) return;
      api.lang = lang;
      try { localStorage.setItem(KEY, lang); } catch (_) {}
      try { if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences) await window.Capacitor.Plugins.Preferences.set({ key: KEY, value: lang }); } catch (_) {}
      try { document.documentElement.setAttribute('lang', lang); } catch (_) {}
      try { api.applyStatic(); } catch (_) {}
      try { window.dispatchEvent(new CustomEvent('kai:lang', { detail: { lang: lang } })); } catch (_) {}
    },

    // Translate static HTML inside `root` (default whole document) marked with
    // data-i18n / data-i18n-ph / data-i18n-html. Idempotent — safe to call repeatedly.
    applyStatic: function (root) {
      root = root || document;
      try {
        root.querySelectorAll('[data-i18n]').forEach(function (el) {
          var v = api.t(el.getAttribute('data-i18n'), null); if (v != null) el.textContent = v;
        });
        root.querySelectorAll('[data-i18n-html]').forEach(function (el) {
          var v = api.t(el.getAttribute('data-i18n-html'), null); if (v != null) el.innerHTML = v;
        });
        root.querySelectorAll('[data-i18n-ph]').forEach(function (el) {
          var v = api.t(el.getAttribute('data-i18n-ph'), null); if (v != null) el.setAttribute('placeholder', v);
        });
      } catch (_) {}
    },
  };

  window.i18n = api;
  window.t = function (k, f) { return api.t(k, f); };
  try { document.documentElement.setAttribute('lang', api.lang); } catch (_) {}
  // Translate any static markup already parsed; also re-run on DOMContentLoaded for
  // markup that loads after this script.
  try { api.applyStatic(); } catch (_) {}
  try { document.addEventListener('DOMContentLoaded', function () { api.applyStatic(); }); } catch (_) {}
})();
