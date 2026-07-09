// i18n-strings-timeline.js — UI-chrome strings for ai-timeline.js (Timeline & Scenes).
// window.I18N_STRINGS[key] = {en, ja}. Loaded after i18n-strings.js (shared common.*).
// CONTENT (chapter summaries, scene captions, anchorQuote book text, character names,
// chapter labels derived from the book) is NOT here. Missing JA falls back to EN.
window.I18N_STRINGS = Object.assign(window.I18N_STRINGS || {}, {
  // ---- chapter / count labels (generated; book/AI labels are kept untranslated) ----
  'tl.chapter_n': { en: 'Chapter {n}', ja: '第{n}章' },
  'tl.chars': { en: '{n} chars', ja: '{n}字' },
  'tl.chars_from': { en: 'from {n} chars', ja: '{n}字〜' },
  'tl.chapters_count': { en: '{n} ch.', ja: '{n}章' },
  'tl.pct_read': { en: '{n}% read', ja: '{n}% 読了' },
  'tl.unread': { en: 'Unread', ja: '未読' },
  'tl.now': { en: 'Now', ja: 'いま' },

  // ---- panel header / footer ----
  'tl.title': { en: 'Timeline & Scenes', ja: 'タイムラインと場面' },
  'tl.update_timeline': { en: 'Update timeline', ja: 'タイムラインを更新' },
  'tl.redetect_chapters': { en: "Re-detect chapters (match the book's numbering)", ja: '章を再検出（本の章番号に合わせる）' },
  'tl.ai_summary_session': { en: '✦ AI summary — this session', ja: '✦ AI要約 — 今回のセッション' },
  'tl.no_chapters_yet': { en: 'No chapters yet. Chapter cards appear as you read.', ja: 'チャプターはまだありません。読み進めると章ごとのカードが表示されます。' },
  'tl.empty_help': { en: 'Reading sessions paint the spine as you read and listen. Chapter cards appear once the book has been processed (AI assistant).', ja: '読書・リスニングの記録が背表紙を彩ります。本がAIで処理されると章カードが表示されます。' },

  // ---- chapter list / states ----
  'tl.go_to_chapter': { en: 'Go to this chapter in the book', ja: '本のこの章へ移動' },
  'tl.summarize_to_here': { en: 'Summarize to here', ja: 'ここまで要約' },
  'tl.summarize_to_here_title': { en: 'Summarize this chapter up to your current position', ja: '現在位置までこの章を要約します' },
  'tl.processing': { en: 'Processing…', ja: '処理中…' },
  'tl.processing_chapter': { en: 'Processing chapter {n}…', ja: '第{n}章を処理中…' },
  'tl.processing_toast': { en: 'Processing — chapter cards appear when ready', ja: '処理中 — 準備ができ次第、章カードが表示されます' },
  'tl.generating_summary': { en: 'Generating summary…', ja: '要約を生成中…' },
  'tl.creating_ai_summary': { en: 'Creating AI summary…', ja: 'AI要約を作成中…' },
  'tl.queued_waiting': { en: 'Waiting…', ja: '待機中…' },
  'tl.tap_to_generate': { en: 'Tap to generate a summary', ja: 'タップして要約を生成' },
  'tl.failed_tap_retry': { en: 'Failed — tap to retry', ja: '失敗 — タップで再試行' },
  'tl.failed_reason_tap_retry': { en: 'Failed ({why}) — tap to retry', ja: '失敗（{why}）— タップで再試行' },
  'tl.failed_retrying': { en: 'Failed — retrying automatically', ja: '失敗 — 自動再試行中' },
  'tl.enable_ai_first': { en: 'Enable AI in Preferences → AI assistant first', ja: '設定 → AIアシスタント でAIを有効にしてください' },

  // ---- failure reasons (chapter summary) ----
  'tl.fail_rate_limit': { en: 'Busy (429)', ja: '混雑（429）' },
  'tl.fail_overload': { en: 'Server overloaded', ja: 'サーバー混雑' },
  'tl.fail_network': { en: 'Connection error', ja: '接続エラー' },
  'tl.fail_api_key': { en: 'Check API key', ja: 'APIキー要確認' },
  'tl.fail_credit': { en: 'Insufficient credit', ja: 'クレジット不足' },
  'tl.fail_refused': { en: 'Model refused', ja: 'モデルが拒否' },

  // ---- scene feed + create ----
  'tl.scene_n': { en: 'Scene {n}', ja: 'シーン {n}' },
  'tl.scene_label': { en: 'Scene', ja: 'シーン' },
  'tl.scene_marker_title': { en: "This chapter's scenes (tap to view)", ja: 'この章の場面（タップで表示）' },
  'tl.create_scenes': { en: '＋ Create scenes', ja: '＋ シーンを作る' },
  'tl.thinking': { en: 'Thinking…', ja: '考え中…' },
  'tl.enable_ai_short': { en: 'Enable AI', ja: 'AIを有効に' },
  'tl.failed_retry': { en: 'Failed — retry', ja: '失敗 — 再試行' },
  'tl.error_retry': { en: 'Error — retry', ja: 'エラー — 再試行' },
  'tl.generating': { en: 'Generating', ja: '生成中' },

  // ---- chapter view ----
  'tl.copy_chapter_summary': { en: 'Copy chapter summary', ja: '章の要約をコピー' },
  'tl.copied': { en: 'Copied', ja: 'コピーしました' },
  'tl.copy_failed': { en: 'Copy failed', ja: 'コピーに失敗' },
  'tl.show_full_text': { en: 'Show full text', ja: '全文を表示' },
  'tl.hide_full_text': { en: 'Hide full text', ja: '全文を閉じる' },
  'tl.chapter_no_summary': { en: "This chapter's summary hasn't been generated yet. Scene images are shown below.", ja: 'この章の要約はまだ生成されていません。下に場面画像を表示します。' },
  'tl.view_scenes': { en: 'View scenes ({n}) ›', ja: 'シーンを見る（{n}）›' },
  'tl.scenes_heading': { en: 'Scenes', ja: '場面' },
  'tl.key_events': { en: 'Key events', ja: '主な出来事' },
  'tl.characters': { en: 'Characters', ja: '登場人物' },
  'tl.memorable_scenes': { en: 'Memorable scenes', ja: '印象的な場面' },
  'tl.listen_scene': { en: '▶ Listen to this scene', ja: '▶ この場面を聴く' },
  'tl.stop': { en: '■ Stop', ja: '■ 停止' },

  // ---- scene card ----
  'tl.generate_this_scene': { en: 'Generate this scene', ja: 'この場面を生成' },
  'tl.need_cloud_backend': { en: 'ChatGPT/fal backend required', ja: 'ChatGPT/falバックエンドが必要です' },
  'tl.sending': { en: 'Sending…', ja: '送信中…' },
  'tl.no_prompt': { en: 'No prompt', ja: 'プロンプトがありません' },
  'tl.generation_failed': { en: 'Generation failed', ja: '生成に失敗' },
  'tl.refused': { en: 'Refused', ja: '拒否されました' },
  'tl.set_key': { en: 'Set an API key', ja: 'キーを設定してください' },
  'tl.failed': { en: 'Failed', ja: '失敗' },
  'tl.waiting_generation': { en: 'Waiting for generation…', ja: '生成待ち…' },
  'tl.play_pause': { en: 'Play / Pause', ja: '再生 / 一時停止' },
  'tl.book_text': { en: 'Original text', ja: '本文' },
  'tl.matching_book_text': { en: 'Matching book text…', ja: '本文を照合中…' },
  'tl.book_text_not_found': { en: 'Book text not found.', ja: '本文が見つかりませんでした。' },
  'tl.scene_no_quote': { en: 'This scene has no book-text quote (regenerate the scene idea to add one).', ja: 'この場面には本文の引用がありません（シーン案を作り直すと付きます）。' },
  'tl.send_to_anki': { en: 'Send to Anki', ja: 'Ankiに送る' },
  'tl.anki_preparing': { en: 'Preparing for Anki…', ja: 'Anki準備中…' },
  'tl.generate_image_first': { en: 'Generate an image first', ja: 'まず画像を生成してください' },
  'tl.composite_failed': { en: 'Image compositing failed', ja: '画像の合成に失敗' },
  'tl.no_audio': { en: 'No audio', ja: '音声なし' },
  'tl.anki_unsupported': { en: 'Anki not supported', ja: 'Anki未対応' },
  'tl.anki_sent_with_audio': { en: 'Sent to Anki (with audio)', ja: 'Ankiに送信しました（音声付）' },
  'tl.anki_sent': { en: 'Sent to Anki', ja: 'Ankiに送信しました' },
  'tl.anki_send_failed': { en: 'Failed to send to Anki', ja: 'Anki送信に失敗' },
  'tl.prev_scene': { en: '‹ Previous scene', ja: '‹ 前のシーン' },
  'tl.next_scene': { en: 'Next scene ›', ja: '次のシーン ›' },

  // ---- audio clip / slice diagnostics ----
  'tl.cannot_play_audio': { en: 'Could not play this audio', ja: 'この音声を再生できませんでした' },
  'tl.cannot_play_preview': { en: 'Cannot play preview', ja: 'プレビューを再生できません' },
  'tl.slice_no_plugin': { en: 'AudioSlicer plugin missing', ja: 'AudioSlicerプラグインなし' },
  'tl.slice_no_src': { en: 'No audio source path', ja: '音源パスなし' },
  'tl.slice_no_cachefn': { en: 'cacheFileToDataUri missing', ja: 'cacheFileToDataUriなし' },
  'tl.slice_no_result_path': { en: 'Slice result has no path', ja: 'スライス結果にパスなし' },
  'tl.slice_empty': { en: 'File read was empty (size {size}B, mime {mime})', ja: 'ファイル読込が空（サイズ {size}B, mime {mime}）' },
  'tl.slice_exception': { en: 'Slice exception', ja: 'スライス例外' },

  // ---- legacy fallback view (bookmark cards) ----
  'tl.read_bookmark': { en: 'Read bookmark', ja: '読書のしおり' },
  'tl.card_bookmark': { en: 'Card bookmark', ja: 'カードのしおり' },
  'tl.tap_to_jump': { en: 'tap to jump', ja: 'タップで移動' },
});
