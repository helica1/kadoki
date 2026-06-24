// i18n-strings-char-ui.js — UI-chrome strings for ai-characters-ui.js
// (character popup/card: deep-dive, image generate/regenerate, squiggle toggle,
// status/error messages). Content — character names, descriptions, book-grounded
// captions, dictionary entries — is NEVER translated here.
//
// Shape: window.I18N_STRINGS = { 'key': { en, ja } }. Merged into the shared table.
// Shared common.* keys (common.error, etc.) live in i18n-strings.js — do NOT redefine.
window.I18N_STRINGS = Object.assign(window.I18N_STRINGS || {}, {
  // deep-dive (動機・心理)
  'cu.not_enough_text':       { en: 'There is not enough text yet', ja: '本文がまだ十分にありません' },
  'cu.analysis_failed':       { en: 'Analysis failed: {msg}', ja: '分析に失敗しました: {msg}' },
  'cu.motivation_psychology': { en: 'Motivation & Psychology', ja: '動機・心理' },
  'cu.analyze_motivation':    { en: 'Analyze motivation & psychology', ja: '動機・心理を分析' },

  // image generation control + status
  'cu.generate_image':         { en: 'Generate image', ja: '画像を生成' },
  'cu.generate_another_image': { en: 'Generate another image', ja: '別の画像を生成' },
  'cu.regenerate_local':       { en: 'Regenerate locally', ja: 'ローカルで再生成' },
  'cu.sending':                { en: 'Sending…', ja: '送信中…' },
  'cu.sending_local':          { en: 'Sending to local server…', ja: 'ローカルに送信中…' },
  'cu.awaiting_generation':    { en: 'Awaiting generation…', ja: '生成待ち…' },
  'cu.queued_n':               { en: 'In queue… {n} image(s)', ja: '順番待ち… {n}枚' },

  // image generation errors
  'cu.failed':           { en: 'Failed', ja: '失敗' },
  'cu.local_unreachable':{ en: "Can't reach the local server", ja: 'ローカルサーバーに接続できません' },
  'cu.image_refused':    { en: 'The image was rejected', ja: '画像が拒否されました' },
  'cu.set_api_key':      { en: 'Please set an API key (Settings → AI Image)', ja: 'APIキーを設定してください（設定→AI Image）' },

  // squiggle (name wavy-underline) toggle
  'cu.sample_name':       { en: 'Name', ja: '名前' },
  'cu.squiggle_label':    { en: 'Wavy underline on names in the text', ja: '本文の名前に波線' },
  'cu.squiggle_aria_on':  { en: 'Name wavy underline: on', ja: '名前の波線：オン' },
  'cu.squiggle_aria_off': { en: 'Name wavy underline: off', ja: '名前の波線：オフ' },

  // character popup sections + chrome
  'cu.just_appeared':         { en: 'A character who has just appeared', ja: '登場したばかりの人物' },
  'cu.section_profile':       { en: 'Profile', ja: '人物' },
  'cu.section_personality':   { en: 'Personality', ja: '性格' },
  'cu.section_relationships': { en: 'Relationships', ja: '関係' },
  'cu.section_appearance':    { en: 'Appearance', ja: '外見' },
  'cu.up_to_position':        { en: 'Showing only information up to your current reading position', ja: '現在の読書位置までの情報のみ表示しています' },
});
