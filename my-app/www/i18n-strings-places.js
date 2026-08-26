// i18n-strings-places.js — UI-chrome strings for ai-places-ui.js (real-world
// place-name popup: geocoding status + errors + the map-app escape hatch).
// Place names/readings themselves are book content and are NEVER translated.
//
// Shape: window.I18N_STRINGS = { 'key': { en, ja } }. Merged into the shared table.
window.I18N_STRINGS = Object.assign(window.I18N_STRINGS || {}, {
  'pl.locating':      { en: 'Locating…', ja: '場所を検索中…' },
  'pl.not_found':     { en: 'Could not find this place', ja: '場所が見つかりませんでした' },
  'pl.lookup_failed': { en: 'Lookup failed', ja: '検索に失敗しました' },
  'pl.open_in_maps':  { en: 'Open in Maps', ja: '地図アプリで開く' },
  'pl.open_google_maps': { en: 'Open in Google Maps', ja: 'Googleマップで開く' },
  'pl.open_wikipedia':{ en: 'View on Wikipedia', ja: 'Wikipediaで見る' },
});
