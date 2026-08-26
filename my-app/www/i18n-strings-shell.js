// i18n-strings-shell.js — UI-chrome strings for the persistent app shell
// (shell.js): the floating Timer / More menus and the mode-switch toasts.
// Loaded into the shared window.I18N_STRINGS table. Keys are namespaced
// under 'menu.'. Shared generic words (Cancel/Save/Close/…) live in the
// common.* keys and are NOT redefined here.
window.I18N_STRINGS = Object.assign(window.I18N_STRINGS || {}, {
  // --- Mode-switch toasts (attachment missing) ---
  'menu.no_epub_attached':      { en: 'No EPUB attached to this title',      ja: 'このタイトルにEPUBが添付されていません' },
  'menu.no_audiobook_attached': { en: 'No audiobook attached to this title', ja: 'このタイトルにオーディオブックが添付されていません' },
  'menu.no_cards':              { en: 'No cards in this title',              ja: 'このタイトルにカードがありません' },

  // --- Timer menu ---
  'menu.pause_timer': { en: 'Pause Timer', ja: 'タイマーを一時停止' },
  'menu.start_timer': { en: 'Start Timer', ja: 'タイマーを開始' },

  // --- More menu ---
  'menu.stats':               { en: 'Stats…',             ja: '統計…' },
  'menu.library':             { en: 'Library…',           ja: 'ライブラリ…' },
  'menu.timeline_scenes':     { en: 'Timeline & Scenes…', ja: 'タイムラインと場面…' },
  'menu.characters':          { en: 'Characters…',        ja: '登場人物…' },
  'menu.history':             { en: 'History…',           ja: '履歴…' },
  'menu.lookup_history':      { en: 'Lookup history…',    ja: '辞書履歴…' },
  'menu.handoff':             { en: 'Sync nearby device',  ja: '近くの端末と同期' },
  'menu.srs':                 { en: 'SRS…',               ja: 'SRS…' },
  'menu.playback_speed':      { en: 'Playback Speed…',    ja: '再生速度…' },
  'menu.print':               { en: 'Print…',             ja: '印刷…' },
  'menu.log_printed_reading': { en: 'Log printed reading…', ja: '紙の読書を記録…' },
  'menu.sync_up':             { en: 'Sync ↑  (push this title)', ja: '同期 ↑  (このタイトルを送信)' },
  'menu.sync_down':           { en: 'Sync ↓  (get latest)',      ja: '同期 ↓  (最新を取得)' },
  'menu.browse_drive':        { en: 'Manage Drive Files…', ja: 'ドライブのファイルを管理…' },
  'menu.preferences':         { en: 'Preferences…',       ja: '設定…' },
});
