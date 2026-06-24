// i18n-strings-images.js — UI-chrome strings for ai-images.js (image strip / lightbox /
// scene gallery / cropper / connection-test). Loaded after i18n-strings.js so the shared
// common.* keys stay intact. CONTENT (captions, scene/character text, prompts, model IDs)
// is never translated and lives in the source/data, not here.
window.I18N_STRINGS = Object.assign(window.I18N_STRINGS || {}, {
  'im.regen_open':              { en: 'Regenerate…', ja: '再生成…' },   // scene button that OPENS the editable-prompt box
  'im.err_claude_prompt_key':   { en: 'Claude API key required (image prompt generation)', ja: 'Claudeのキーが必要です（画像プロンプト生成）' },
  'im.gen_failed':              { en: 'Could not generate the image', ja: '画像を生成できませんでした' },
  'im.image_caption_label':     { en: 'Image caption', ja: '画像キャプション' },
  'im.crop_to_view':            { en: 'Crop to this view', ja: 'この範囲で切り抜き' },
  'im.hint_pinch_swipe':        { en: 'Pinch to zoom → "Crop" · Swipe for next image', ja: 'ピンチで拡大 →「切り抜き」 ・ スワイプで次の画像' },
  'im.hint_swipe_next':         { en: 'Swipe for next image', ja: 'スワイプで次の画像' },
  'im.edit_text_variation':     { en: 'Edit with text — leave blank for a different variation', ja: 'テキストで編集 — 空欄なら別バリエーション' },
  'im.change_optional_variation': { en: 'What to change (optional) — leave blank for a different variation', ja: '変更したい点（任意）— 空欄なら別バリエーション' },
  'im.regen_placeholder':       { en: 'e.g. longer hair / add glasses / darker background / smiling', ja: '例: 髪をもっと長く / 眼鏡を追加 / 背景を暗く / 笑顔に' },
  'im.sending':                 { en: 'Sending…', ja: '送信中…' },
  'im.cannot_connect_server':   { en: 'Cannot connect to the server', ja: 'サーバーに接続できません' },
  'im.openai_key_needed':       { en: 'OpenAI API key required (Settings)', ja: 'OpenAIキーが必要です（設定）' },
  'im.busy_queued_retry':       { en: 'Busy — queued (will retry automatically)', ja: '混雑のため順番待ち（自動で再試行します）' },
  'im.failed_reason':           { en: 'Failed: {reason}', ja: '失敗: {reason}' },
  'im.openai_declined':         { en: 'OpenAI declined the request', ja: 'OpenAIが拒否しました' },
  'im.send_failed':             { en: 'Send failed', ja: '送信に失敗' },
  'im.edited':                  { en: 'Edited', ja: '編集しました' },
  'im.images_received':         { en: '{n} images received', ja: '{n}枚 受信' },
  'im.queued_in_order':         { en: 'Queued… (generating in order)', ja: '順番待ち…（順次生成します）' },
  'im.waiting_to_generate':     { en: 'Waiting to generate… (shown when ready)', ja: '生成待ち…（できたら表示されます）' },
  'im.edit_prompt_regen':       { en: 'Edit prompt & regenerate', ja: 'プロンプトを編集して再生成' },
  'im.enter_prompt':            { en: 'Please enter a prompt', ja: 'プロンプトを入力してください' },
  'im.update_picture':          { en: 'Update picture', ja: '画像を更新' },
  'im.generate_caption':        { en: 'Generate caption', ja: 'キャプションを生成' },
  'im.generating':              { en: 'Generating…', ja: '生成中…' },
  'im.enable_ai':               { en: 'Please enable AI', ja: 'AIを有効にしてください' },
  'im.failed':                  { en: 'Failed', ja: '失敗' },
  'im.crop':                    { en: 'Crop', ja: '切り抜き' },
  'im.connecting':              { en: 'Connecting…', ja: '接続中…' },
  'im.conn_ok':                 { en: 'Connected — models: {models} · queued: {n}', ja: '接続OK — モデル: {models} · 待ち: {n}' },
  'im.conn_fail':               { en: 'Cannot connect (check the server is running and on the same Wi‑Fi)', ja: '接続できません（サーバーが起動して同じWi‑Fiにあるか確認）' },
});
