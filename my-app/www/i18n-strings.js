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
  'lib.swipe_hint': { en: 'Swipe left on a title to edit or delete it', ja: 'タイトルを左にスワイプで編集・削除できます' },

  // ---- top mode-switch tabs (Ka·Do·Ki — the app name reads out of the JP labels) ----
  'nav.mode_card': { en: 'CARD', ja: 'カード' },
  'nav.mode_read': { en: 'READ', ja: '読書' },
  'nav.mode_audio': { en: 'AUDIO', ja: '聴く' },

  // ---- audio mode: chapter-repeat bar (static HTML in the audiobook view) ----
  'audio.repeat_chapter': { en: 'Repeat Chapter', ja: '章をリピート' },
  'audio.next_chapter': { en: 'Next Chapter', ja: '次の章へ' },

  // ---- preferences: fal.ai description paragraph (rich, keeps inline <b>) ----
  'ph.falai_desc': {
    en: 'Character & scene images are generated in the cloud via <b>fal.ai</b> with your own API key — fast, uncensored, and no PC required. Images are made <b>on demand</b>: the generate button on each character, and the scene regenerate box to tweak a prompt. The image prompts are written by Claude.',
    ja: 'キャラクターと場面の画像は、自分のAPIキーで<b>fal.ai</b>のクラウドに生成します — 高速・無検閲・PC不要。画像は<b>オンデマンド</b>で作成：各キャラクターの生成ボタン、または場面の再生成ボックスでプロンプトを調整します。画像プロンプトはClaudeが作成します。',
  },
});
