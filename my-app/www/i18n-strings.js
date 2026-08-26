// i18n-strings.js — UI chrome string table for i18n.js. window.I18N_STRINGS[key] = {en, ja}.
//
// Keys are namespaced by area: common.*, lang.*, menu.*, prefs.*, tl.* (timeline),
// char.* (characters), img.* (images), dict.*, read.*, audio.*, card.*, app.*.
// CONTENT (book text, summaries, dictionary entries, captions, names) is NOT in here.
// Missing JA falls back to EN automatically (see i18n.js t()).
window.I18N_STRINGS = Object.assign(window.I18N_STRINGS || {}, {
  // ---- common / shared ----
  'common.cancel': { en: 'Cancel', ja: 'キャンセル' },
  'common.save': { en: 'Save', ja: '保存' },
  'common.close': { en: 'Close', ja: '閉じる' },
  'common.delete': { en: 'Delete', ja: '削除' },
  'common.done': { en: 'Done', ja: '完了' },
  'common.ok': { en: 'OK', ja: 'OK' },
  'common.loading': { en: 'Loading…', ja: '読み込み中…' },
  'common.generate': { en: 'Generate', ja: '生成' },
  'common.regenerate': { en: 'Regenerate', ja: '再生成' },
  'common.error': { en: 'Error', ja: 'エラー' },

  // ---- language preference ----
  'lang.heading': { en: 'Language', ja: '言語' },
  'lang.label': { en: 'App language', ja: 'アプリの言語' },
  'lang.help': { en: 'Switches the interface (menus, buttons, settings). Book text, dictionary, and AI summaries stay in their original language.', ja: 'インターフェイス（メニュー・ボタン・設定）の言語を切り替えます。本文・辞書・AI要約は元の言語のままです。' },
  'lang.en': { en: 'English', ja: 'English' },
  'lang.ja': { en: '日本語', ja: '日本語' },

  // ---- Library screen header + hint ----
  'lib.library': { en: 'Library', ja: 'ライブラリ' },
  'lib.import_folder': { en: 'Import folder', ja: 'フォルダを取り込む' },
  'lib.new_title': { en: '+ New title', ja: '＋ 新規タイトル' },
  'lib.swipe_hint': { en: 'Swipe left on a title for stats, edit, or delete', ja: 'タイトルを左にスワイプで統計・編集・削除できます' },
  'lib.stats': { en: 'Stats', ja: '統計' },
  // ---- per-title stats card (library swipe → Stats) ----
  'ts.title': { en: 'Title stats', ja: 'タイトル統計' },
  'ts.started': { en: 'Started', ja: '開始日' },
  'ts.active_days': { en: 'Active days', ja: '活動日数' },
  'ts.audio_progress': { en: 'Audio progress', ja: '音声の進捗' },
  'ts.read_progress': { en: 'Read progress', ja: '読書の進捗' },
  'ts.pace_audio': { en: 'Pace (audio)', ja: 'ペース（音声）' },
  'ts.pace_read': { en: 'Pace (read)', ja: 'ペース（読書）' },
  'ts.chars': { en: ' chars', ja: '字' },
  'ts.per_day': { en: ' / day', ja: ' / 日' },
  'ts.time_card': { en: 'Time (cards)', ja: '時間（カード）' },
  'ts.time_read': { en: 'Time (reading)', ja: '時間（読書）' },
  'ts.time_audio': { en: 'Time (audio)', ja: '時間（音声）' },
  'ts.time_watch': { en: 'Time (watch)', ja: '時間（ウォッチ）' },
  'ts.eta': { en: 'Est. finish', ja: '完了予測' },
  'ts.eta_val': { en: '~{d} days ({date})', ja: 'あと約{d}日（{date}）' },
  'ts.last14': { en: 'Last 14 days', ja: '過去14日間' },
  'ts.legend_audio': { en: 'audio', ja: '音声' },
  'ts.legend_read': { en: 'read', ja: '読書' },
  'ts.no_data': { en: 'No progress recorded yet — stats build up as you listen and read.', ja: 'まだ記録がありません。読書・リスニングすると統計が貯まります。' },
  // ---- dictionary lookup history (lookup-log.js) ----
  'lh.title': { en: 'Lookup history', ja: '辞書履歴' },
  'lh.clear': { en: 'Clear', ja: '消去' },
  'lh.clear_confirm': { en: 'Clear all lookup history?', ja: '辞書履歴をすべて消去しますか？' },
  'lh.empty': { en: 'No lookups yet — words you look up appear here with their sentence, ready to send to Anki.', ja: 'まだ履歴がありません。調べた単語が文脈つきでここに表示され、Ankiに送れます。' },
  'lh.now': { en: 'now', ja: 'たった今' },
  'lh.min': { en: 'm', ja: '分前' },
  'lh.hour': { en: 'h', ja: '時間前' },
  'lh.tap_hint': { en: 'Flagged subtitle — tap any word below to look it up', ja: 'フラグ付き字幕 — 下の文中の単語をタップして検索' },

  // ---- top mode-switch tabs (Ka·Do·Ki — the app name reads out of the JP labels) ----
  'nav.mode_card': { en: 'CARD', ja: 'カード' },
  'nav.mode_read': { en: 'READ', ja: '読書' },
  'nav.mode_audio': { en: 'AUDIO', ja: '聴く' },

  // ---- audio mode: chapter-repeat bar (static HTML in the audiobook view) ----
  'audio.repeat_chapter': { en: 'Repeat Chapter', ja: '章をリピート' },
  'audio.next_chapter': { en: 'Next Chapter', ja: '次の章へ' },
  'audio.chapter_summary_btn': { en: 'Chapter summary ›', ja: '章の要約 ›' },
  'audio.new_summary_toast': { en: '{label} summary available', ja: '{label}の要約が利用可能です' },

  // ---- preferences: fal.ai description paragraph (rich, keeps inline <b>) ----
  'ph.falai_desc': {
    en: 'Character & scene images are generated in the cloud via <b>fal.ai</b> with your own API key — fast, uncensored, and no PC required. Images are made <b>on demand</b>: the generate button on each character, and the scene regenerate box to tweak a prompt. The image prompts are written by Claude.',
    ja: 'キャラクターと場面の画像は、自分のAPIキーで<b>fal.ai</b>のクラウドに生成します — 高速・無検閲・PC不要。画像は<b>オンデマンド</b>で作成：各キャラクターの生成ボタン、または場面の再生成ボックスでプロンプトを調整します。画像プロンプトはClaudeが作成します。',
  },
});
