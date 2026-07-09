// i18n-strings-app.js — UI chrome strings for app.js (key prefix: ap.*).
// window.I18N_STRINGS[key] = {en, ja}. Loaded after i18n-strings.js so it
// merges into (does not replace) the shared table. CONTENT — card/subtitle
// text, deck/book names, dictionary entries — is NOT in here. Shared generic
// words (Cancel/Close/…) live in i18n-strings.js as common.* and are reused.
window.I18N_STRINGS = Object.assign(window.I18N_STRINGS || {}, {
  // ---- deck load / auto-restore (toasts + deck-name label) ----
  'ap.loading_file':        { en: 'Loading {name}…', ja: '{name} を読み込み中…' },
  'ap.deck_auto_restoring': { en: '{name} (Auto-restoring…)', ja: '{name}（自動復元中…）' },
  'ap.deck_tap_reopen':     { en: '{name} (Tap to reopen)', ja: '{name}（タップして再度開く）' },
  'ap.last_deck_toast':     { en: 'Last deck: {name}. Tap filename to reopen and continue from card {n}.', ja: '前回のデッキ: {name}。ファイル名をタップして再度開き、カード{n}から続けられます。' },
  'ap.auto_restored':       { en: 'Auto-restored: {name}', ja: '自動復元しました: {name}' },
  'ap.error_loading_deck':  { en: 'Error loading deck: {msg}\n\nCheck the debug console for more details.', ja: 'デッキの読み込みエラー: {msg}\n\n詳細はデバッグコンソールを確認してください。' },

  // ---- bottom progress bar / counters ----
  'ap.notes_count':         { en: '{n} notes', ja: '{n} ノート' },
  'ap.read_progress':       { en: '{cur} / {total} chars · {pct}%', ja: '{cur} / {total} 文字 · {pct}%' },
  'ap.open_epub_prompt':    { en: 'Open an EPUB', ja: 'EPUBを開く' },
  'ap.card_progress_loading': { en: '{cur} / {total} (Loading…)', ja: '{cur} / {total}（読み込み中…）' },
  'ap.select_deck_prompt':  { en: 'Select a deck', ja: 'デッキを選択' },
  'ap.loading_progress':    { en: 'Loading: {pct}% ({done}/{total})', ja: '読み込み中: {pct}% ({done}/{total})' },

  // ---- card-mode resume + pill buttons ----
  'ap.resumed_at_card':     { en: 'Resumed at card {n}', ja: 'カード{n}から再開しました' },
  'ap.auto_on':             { en: 'Auto: ON', ja: '自動: オン' },
  'ap.auto_off':            { en: 'Auto: OFF', ja: '自動: オフ' },
  'ap.copied_flash':        { en: 'COPIED', ja: 'コピー済み' },
  'ap.failed_flash':        { en: 'FAILED', ja: '失敗' },
  'ap.copied_clipboard':    { en: 'Copied to clipboard', ja: 'クリップボードにコピーしました' },
  'ap.invert':              { en: 'Invert', ja: '反転' },
  'ap.play_card_from_start': { en: 'Play card from start', ja: 'カードを最初から再生' },
  'ap.copy_srt':            { en: 'Copy SRT', ja: 'SRTをコピー' },
  'ap.copy_card':           { en: 'Copy Card', ja: 'カードをコピー' },

  // ---- seek dialog ----
  'ap.seek_title':          { en: 'Seek', ja: 'シーク' },
  'ap.seek_go':             { en: 'Go', ja: '移動' },

  // ---- playback speed dialog ----
  'ap.playback_speed':      { en: 'Playback Speed', ja: '再生速度' },
  'ap.speed_permode_on':    { en: 'Per-mode speed enabled. Each mode keeps its own rate.', ja: 'モードごとの速度が有効です。各モードが独自の速度を保持します。' },
  'ap.speed_global_sub':    { en: 'Applies to all three modes (card, read, audio).', ja: 'カード・読書・音声の3モードすべてに適用されます。' },
  'ap.speed_permode_label': { en: 'Playback speed per mode', ja: 'モードごとの再生速度' },
  'ap.mode_card':           { en: 'CARD', ja: 'カード' },
  'ap.mode_read':           { en: 'READ', ja: '読書' },
  'ap.mode_audio':          { en: 'AUDIO', ja: '音声' },
  'ap.speed_label':         { en: 'SPEED', ja: '速度' },

  // ---- audiobook/SRT title load errors ----
  'ap.load_audio_sub_failed': { en: 'Could not load the audio/subtitles for this title.', ja: 'このタイトルの音声・字幕を読み込めませんでした。' },
  'ap.srt_read_failed':     { en: 'Failed to read SRT for this title:', ja: 'このタイトルのSRTを読み込めませんでした:' },
  'ap.srt_zero_cues':       { en: 'SRT parsed but found 0 cues. Check the file format.', ja: 'SRTを解析しましたが字幕が0件でした。ファイル形式を確認してください。' },
});
