// i18n-strings-char-screen.js — UI chrome strings for ai-characters-screen.js (Characters list screen).
// Prefix: cs.*  window.I18N_STRINGS[key] = {en, ja}. Missing JA falls back to EN (see i18n.js).
// CONTENT — character names, descriptions, developments, relationships — is NOT translated here.
window.I18N_STRINGS = Object.assign(window.I18N_STRINGS || {}, {
  // header / footer / status
  'cs.characters_title': { en: 'Characters', ja: '登場人物' },
  'cs.processing': { en: 'Processing…', ja: '処理中…' },
  'cs.footer_note': { en: 'Showing only information up to your current reading position', ja: '現在の読書位置までの情報のみ表示しています' },

  // sort control
  'cs.sort_order': { en: 'Sort order', ja: '並び順' },
  'cs.sort_recent': { en: 'Recent', ja: '最近' },
  'cs.sort_freq': { en: 'Frequency', ja: '頻度順' },
  'cs.sort_chrono': { en: 'Appearance', ja: '登場順' },

  // image / "new" pill
  'cs.new_label': { en: 'New', ja: '新着' },
  'cs.new_count': { en: 'New {n}', ja: '新着 {n}' },

  // card controls
  'cs.copy_desc_title': { en: 'Copy character description', ja: 'キャラクター説明をコピー' },
  'cs.copied': { en: 'Copied', ja: 'コピーしました' },
  'cs.copy_failed': { en: 'Copy failed', ja: 'コピーに失敗しました' },
  'cs.collapse_expand': { en: 'collapse / expand', ja: '折りたたみ／展開' },
  'cs.background': { en: 'Background', ja: '背景' },

  // chapter links / tags
  'cs.chapter_n': { en: 'Ch. {n}', ja: '第{n}章' },
  'cs.first_appearance': { en: 'First seen', ja: '初登場' },
  'cs.latest': { en: 'Latest', ja: '直近' },

  // section labels
  'cs.latest_developments': { en: 'Recent developments', ja: '最新の動き' },
  'cs.history': { en: 'History', ja: 'これまでの動き' },
  'cs.field_profile': { en: 'Profile', ja: '人物' },
  'cs.field_personality': { en: 'Personality', ja: '性格' },
  'cs.field_appearance': { en: 'Appearance', ja: '外見' },
  'cs.field_motivations': { en: 'Motivations', ja: '動機' },
  'cs.field_secrets': { en: 'Secrets', ja: '秘密' },
  'cs.field_relationships': { en: 'Relationships', ja: '関係' },

  // empty state
  'cs.empty_title': { en: 'No character information yet.', ja: 'まだ登場人物の情報がありません。' },
  'cs.empty_hint_default': { en: 'Characters are analyzed automatically as you finish each chapter, and will appear here.', ja: '章を読み終えるごとに自動で分析され、登場人物がここに追加されていきます。' },
  'cs.empty_hint_ai_off': { en: 'Turn on "AI assistant" in Settings to analyze characters in each chapter.', ja: '設定の「AI assistant」を有効にすると、章ごとに登場人物が分析されます。' },
  'cs.empty_hint_auto_off': { en: 'Auto-processing is off. You can analyze from "Update timeline" in the timeline.', ja: '自動処理がオフです。タイムラインの「タイムラインを更新」から分析できます。' },
});
