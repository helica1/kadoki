// i18n-strings-dict.js — UI chrome strings for the dictionary popup / lookup flow.
// Loaded into window.I18N_STRINGS (see i18n.js). CONTENT is never here: dictionary
// headwords, readings, definitions, examples, pitch — and proper nouns like
// Anki / AnkiMobile / AnkiDroid / Yomitan / JMDict / deck & note-type names /
// codec ids — are NOT translated (kept verbatim or passed in as {placeholders}).
window.I18N_STRINGS = Object.assign(window.I18N_STRINGS || {}, {
  // ---- startup / dictionary-load progress (status bar) ----
  'dc.loading_dictionaries': { en: 'Loading dictionaries…', ja: '辞書を読み込み中…' },
  'dc.initializing': { en: 'Initializing...', ja: '初期化中...' },
  'dc.scanning_dicts': { en: 'Scanning for dictionaries...', ja: '辞書を検索中...' },
  'dc.no_yomitan_found': { en: 'No Yomitan dictionaries found', ja: 'Yomitan 辞書が見つかりません' },
  'dc.using_jmdict_only': { en: 'Using JMDict only', ja: 'JMDict のみ使用' },
  'dc.found_n_dicts': { en: 'Found {n} dictionaries', ja: '{n} 件の辞書が見つかりました' },
  'dc.beginning_load': { en: 'Beginning dictionary loading...', ja: '辞書の読み込みを開始しています...' },
  'dc.loading_named': { en: 'Loading {name}...', ja: '{name} を読み込み中...' },
  'dc.dict_n_of_m': { en: 'Dictionary {i} of {total}', ja: '辞書 {i} / {total}' },
  'dc.processing_banks': { en: 'Processing term banks...', ja: '用語バンクを処理中...' },
  'dc.failed_load_named': { en: 'Failed to load {name}', ja: '{name} の読み込みに失敗しました' },
  'dc.continuing_others': { en: 'Continuing with other dictionaries...', ja: '他の辞書を続けて読み込みます...' },
  'dc.finalizing': { en: 'Finalizing dictionaries...', ja: '辞書を仕上げ中...' },
  'dc.almost_ready': { en: 'Almost ready!', ja: 'もうすぐ完了します！' },
  'dc.dict_load_failed': { en: 'Dictionary loading failed', ja: '辞書の読み込みに失敗しました' },
  'dc.will_use_jmdict_only': { en: 'Will use JMDict only', ja: 'JMDict のみ使用します' },
  'dc.dicts_ready': { en: 'Dictionaries ready!', ja: '辞書の準備ができました！' },
  'dc.all_loaded': { en: 'All dictionaries loaded successfully', ja: 'すべての辞書を正常に読み込みました' },
  'dc.no_dict_import': { en: 'No dictionary loaded — import one in Preferences → Dictionaries', ja: '辞書が読み込まれていません — 設定 → 辞書 でインポートしてください' },

  // ---- popup chrome ----
  'dc.set_playhead': { en: 'Set playhead', ja: '再生位置を設定' },
  'dc.no_entries_found': { en: 'No dictionary entries found', ja: '辞書に項目が見つかりません' },
  'dc.tap_to_close': { en: 'Tap anywhere to close', ja: 'どこかをタップして閉じる' },
  'dc.audio_prev': { en: 'Previous audio source', ja: '前の音声ソース' },
  'dc.audio_play': { en: 'Play audio', ja: '音声を再生' },
  'dc.audio_next': { en: 'Next audio source', ja: '次の音声ソース' },
  'dc.anki_short': { en: '+ Anki', ja: '+ Anki' },
  'dc.prev': { en: 'Prev', ja: '前へ' },
  'dc.next': { en: 'Next', ja: '次へ' },

  // ---- lookup progress popups ----
  'dc.looking_up': { en: 'Looking up…', ja: '検索中…' },
  'dc.initializing_dicts': { en: 'Initializing Dictionaries…', ja: '辞書を初期化中…' },
  'dc.first_lookup_hint': { en: 'First lookup loads the term index — please wait.', ja: '最初の検索で用語インデックスを読み込みます — しばらくお待ちください。' },
  'dc.looking_up_word': { en: 'Looking up: {word}', ja: '{word} を検索中…' },
  'dc.first_lookup_slow': { en: 'This may take 1-2 minutes for the first lookup...', ja: '最初の検索には1〜2分かかる場合があります...' },
  'dc.dictionaries_loaded': { en: 'Dictionaries loaded', ja: '辞書を読み込みました' },
  'dc.showing_defs_for': { en: 'Showing definitions for: {word}', ja: '{word} の定義を表示中' },
  'dc.lookup_failed': { en: 'Lookup failed', ja: '検索に失敗しました' },
  'dc.could_not_load_defs': { en: 'Could not load dictionary definitions', ja: '辞書の定義を読み込めませんでした' },
  'dc.no_dicts_loaded': { en: 'No dictionaries loaded — add one in Preferences.', ja: '辞書が読み込まれていません — 設定で追加してください。' },
  'dc.no_definition': { en: 'No definition found.', ja: '定義が見つかりませんでした。' },

  // ---- audio ----
  'dc.play_error': { en: 'Play error: {msg}', ja: '再生エラー: {msg}' },
  'dc.no_local_audio': { en: 'No local audio for this word', ja: 'この単語のローカル音声はありません' },

  // ---- Anki button + send status ----
  'dc.adding': { en: 'Adding...', ja: '追加中...' },
  'dc.added': { en: 'Added', ja: '追加しました' },
  'dc.failed': { en: 'Failed', ja: '失敗' },
  'dc.add_to_anki': { en: 'Add to Anki', ja: 'Ankiに送る' },
  'dc.choose_deck_first': { en: 'Choose a deck and note type in Preferences → Anki (dictionary) first.', ja: 'まず「設定 → Anki（辞書）」でデッキとノートタイプを選択してください。' },
  'dc.map_fields_first': { en: 'Map your note type’s fields in Preferences → Anki (dictionary) first.', ja: 'まず「設定 → Anki（辞書）」でノートタイプのフィールドを割り当ててください。' },
  'dc.codec_warning': { en: "⚠ Audio is {codec}; AnkiMobile (iOS) can't play this codec — it will play on Android. Use an MP3 audio source for both.", ja: '⚠ 音声は {codec} です。AnkiMobile（iOS）はこのコーデックを再生できません — Androidでは再生できます。両方とも MP3 音声ソースを使用してください。' },
  'dc.added_to_deck': { en: '✓ Added to {deck}', ja: '✓ {deck} に追加しました' },
  'dc.sending_to_deck': { en: 'Sending to {deck}…', ja: '{deck} に送信中…' },
  'dc.ankimobile_error': { en: '✗ AnkiMobile: {msg}', ja: '✗ AnkiMobile: {msg}' },
  'dc.ankimobile_rejected': { en: '✗ AnkiMobile rejected the note. Check that model "{model}" and its fields exist.', ja: '✗ AnkiMobile がノートを拒否しました。ノートタイプ「{model}」とそのフィールドが存在するか確認してください。' },
  'dc.ankimobile_no_reply': { en: '? No reply from AnkiMobile. Sent model="{model}". Verify it exists in AnkiMobile → Manage note types.', ja: '? AnkiMobile から応答がありません。送信したノートタイプ="{model}"。AnkiMobile → ノートタイプの管理 で存在を確認してください。' },
  'dc.sent_to_deck': { en: '✓ Sent to {deck}', ja: '✓ {deck} に送信しました' },
  'dc.media_server_stuck': { en: '✗ Anki media server stuck — restart the app to recover', ja: '✗ Anki メディアサーバーが応答しません — アプリを再起動して復旧してください' },
  'dc.anki_error': { en: '✗ Anki: {msg}', ja: '✗ Anki: {msg}' },
});
