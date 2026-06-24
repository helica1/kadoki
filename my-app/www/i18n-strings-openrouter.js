// i18n-strings-openrouter.js — UI-chrome strings for the OpenRouter text-AI backend
// (Preferences → AI Features: backend selector, OpenRouter key/model rows, and the
// live searchable model picker). Loaded before i18n.js, alongside the other
// i18n-strings-*.js tables. CONTENT (model ids/names, prices) is data from the
// OpenRouter API and is never translated here.
window.I18N_STRINGS = Object.assign(window.I18N_STRINGS || {}, {
  // ---- backend selector (static HTML) -------------------------------------
  'or.backend_label':     { en: 'Text AI backend',            ja: 'テキストAIの提供元' },
  'or.backend_anthropic': { en: 'Anthropic (Claude)',         ja: 'Anthropic（Claude）' },
  'or.backend_openrouter':{ en: 'OpenRouter',                 ja: 'OpenRouter' },

  // ---- OpenRouter sub-fields (static HTML) --------------------------------
  'or.key_label':         { en: 'OpenRouter API key',         ja: 'OpenRouter APIキー' },
  'or.key_help':          { en: 'Get a key at openrouter.ai/keys',           ja: 'openrouter.ai/keys でキーを取得' },
  'or.model_label':       { en: 'Model',                      ja: 'モデル' },
  'or.choose_model':      { en: 'Choose model…',              ja: 'モデルを選択…' },

  // ---- selected-model line (built in JS) ----------------------------------
  'or.no_model':          { en: 'No model selected — tap "Choose model…"', ja: 'モデル未選択 —「モデルを選択…」をタップ' },
  'or.model_cost':        { en: '{name} — {in} / {out} per 1M',            ja: '{name} — {in} / {out}（100万トークンあたり）' },
  'or.model_free':        { en: '{name} — free',              ja: '{name} — 無料' },
  'or.model_per_image':   { en: '{name} — per-image pricing', ja: '{name} — 画像ごとの料金' },

  // ---- model picker overlay (built in JS) ---------------------------------
  'or.picker_title':      { en: 'Choose an OpenRouter model', ja: 'OpenRouterのモデルを選択' },
  'or.search_ph':         { en: 'Search models…',             ja: 'モデルを検索…' },
  'or.refresh':           { en: 'Refresh',                    ja: '更新' },
  'or.close':             { en: 'Close',                      ja: '閉じる' },
  'or.loading':           { en: 'Loading models…',            ja: 'モデルを読み込み中…' },
  'or.error':             { en: "Couldn't load models. Check your connection and tap Refresh.", ja: 'モデルを読み込めませんでした。接続を確認して「更新」を押してください。' },
  'or.no_results':        { en: 'No models match your search.', ja: '一致するモデルがありません。' },

  // ---- per-row cost / context (built in JS) -------------------------------
  'or.free':              { en: 'free',                       ja: '無料' },
  'or.per_image':         { en: 'per-image pricing',          ja: '画像ごとの料金' },
  'or.cost_inout':        { en: 'in {in}/M · out {out}/M',    ja: '入力 {in}/M ・ 出力 {out}/M' },
  'or.ctx':               { en: '{n}K ctx',                   ja: 'コンテキスト {n}K' },

  // ---- image-generation backend (static HTML + JS) ------------------------
  // The image picker reuses the generic picker strings above (or.picker_title,
  // or.search_ph, or.refresh, or.close, or.loading, or.error, or.no_results,
  // or.no_model, or.model_cost, or.model_free) — only these labels are new.
  'or.image_backend':     { en: 'Image backend',             ja: '画像AIの提供元' },
  'or.backend_fal':       { en: 'fal.ai',                     ja: 'fal.ai' },
  'or.img_model_label':   { en: 'Image model',               ja: '画像モデル' },
  'or.choose_img_model':  { en: 'Choose image model…',       ja: '画像モデルを選択…' },
  'or.key_reused':        { en: 'Uses the OpenRouter API key from the Text AI section above.', ja: '上の「テキストAI」のOpenRouter APIキーを使います。' },

  // ---- model attribution on a chapter summary (built in JS) ---------------
  'or.model_by':          { en: 'model: {id}',                ja: 'モデル: {id}' },
});
