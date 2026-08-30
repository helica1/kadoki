// i18n-strings-prefs-html.js — UI-chrome strings for the Preferences screen (#preferencesModal)
// in index.html. Prefix: ph.*  Merged into window.I18N_STRINGS for i18n.js.
// CONTENT (book text, dictionary, AI summaries, captions, names, model IDs) is NOT here.
// Shared common.* keys (cancel/save/etc.) live in i18n-strings.js and are NOT redefined here.
window.I18N_STRINGS = Object.assign(window.I18N_STRINGS || {}, {
  // ---- dialog title ----
  'ph.prefs_title': { en: 'Preferences', ja: '設定' },

  // ---- section headings (<summary class="prefs-heading">) ----
  'ph.sec_appearance': { en: 'Appearance', ja: '外観' },
  'ph.sec_mode_colors': { en: 'Mode accent colors', ja: 'モードのアクセントカラー' },
  'ph.sec_card_subs': { en: 'Card subtitles', ja: 'カードの字幕' },
  'ph.sec_screen': { en: 'Screen', ja: '画面' },
  'ph.sec_dictionaries': { en: 'Dictionaries', ja: '辞書' },
  'ph.sec_gdrive': { en: 'Google Drive sync', ja: 'Google Drive 同期' },
  'ph.sec_ai': { en: 'AI Features', ja: 'AI機能' },
  'ph.sec_audio_archive': { en: 'Audio archive', ja: '音声アーカイブ' },
  'ph.sec_anki_connect': { en: 'Anki: Desktop Anki (Mac)', ja: 'Anki: デスクトップAnki（Mac）' },
  'ph.ankiconnect_host': { en: 'Mac address (AnkiConnect)', ja: 'Macのアドレス（AnkiConnect）' },
  'ph.ankiconnect_test': { en: 'Test connection', ja: '接続テスト' },
  'ph.ankiconnect_help': { en: 'Sends cards straight to Anki running on your Mac over Wi-Fi (needs the AnkiConnect add-on with webBindAddress 0.0.0.0). When set, this route is used everywhere instead of AnkiMobile/AnkiDroid — leave empty to use the on-device apps. On Vision Pro this is the only way to send.', ja: 'Wi-Fi経由でMac上のAnkiに直接カードを送信します（AnkiConnectアドオン、webBindAddress 0.0.0.0が必要）。設定するとAnkiMobile/AnkiDroidの代わりにこの経路が常に使われます。空欄でデバイス上のアプリを使用。Vision Proではこれが唯一の送信方法です。' },
  'ph.sec_anki_swipe': { en: 'Anki: Swipe-Up and Scene Save', ja: 'Anki: スワイプアップとシーン保存' },
  'ph.sec_anki_dict': { en: 'Anki: dictionary add-word', ja: 'Anki: 辞書からの単語追加' },
  'ph.sec_licenses': { en: 'Licenses & acknowledgements', ja: 'ライセンスと謝辞' },

  // ---- standalone help / notes ----
  'ph.card_autosize_note': {
    en: 'Cards are sized to fit your screen automatically (no scrolling unless a single subtitle is very long). Reopen the title for the on/off change to take effect.',
    ja: 'カードは画面に合わせて自動でサイズ調整されます（1つの字幕が非常に長い場合を除きスクロール不要）。オン/オフの変更はタイトルを開き直すと反映されます。'
  },
  'ph.dict_help': {
    en: 'Toggle dictionaries on/off and drag-reorder. Order is the search priority (top first).',
    ja: '辞書のオン/オフを切り替え、ドラッグで並べ替えできます。並び順が検索の優先順位です（上が先）。'
  },

  // ---- plain labels ----
  'ph.account': { en: 'Account', ja: 'アカウント' },
  'ph.ai_enable': { en: 'Enable AI features', ja: 'AI機能を有効化' },
  'ph.api_key': { en: 'API key', ja: 'APIキー' },
  'ph.falai_section_title': { en: 'AI Image — fal.ai (cloud)', ja: 'AI画像 — fal.ai（クラウド）' },
  'ph.fal_model': { en: 'fal model', ja: 'fal モデル' },
  'ph.fal_custom_endpoint': {
    en: 'Custom endpoint id (only when Custom is selected above)',
    ja: 'カスタム endpoint id（上で「カスタム」選択時のみ）'
  },
  'ph.image_shape': { en: 'Image shape', ja: '画像の形' },

  // ---- select options (chrome only; model IDs / data-units left untouched) ----
  'ph.off': { en: 'Off', ja: 'オフ' },
  'ph.none': { en: 'None', ja: 'なし' },
  'ph.fal_model_custom_opt': { en: 'Custom (enter below)', ja: 'カスタム（下に入力）' },
  'ph.aspect_square': { en: 'Square', ja: '正方形' },
  'ph.aspect_portrait': { en: 'Portrait', ja: '縦長' },
  'ph.aspect_landscape': { en: 'Landscape', ja: '横長' },

  // ---- buttons ----
  'ph.export_ai': { en: 'Export AI record…', ja: 'AI記録をエクスポート…' },
  'ph.reset_ai': { en: 'Reset AI (this book)…', ja: 'AIをリセット（この本）…' },
  'ph.perf_log': { en: 'Perf log', ja: 'パフォーマンスログ' },
  'ph.import_audio_archive': { en: 'Import audio archive', ja: '音声アーカイブをインポート' },

  // ---- Anki field-mapping labels ----
  'ph.deck': { en: 'Deck', ja: 'デッキ' },
  'ph.note_type': { en: 'Note type', ja: 'ノートタイプ' },
  'ph.field_expression': { en: 'Expression → field', ja: '表現 → フィールド' },
  'ph.field_image': { en: 'Image → field', ja: '画像 → フィールド' },
  'ph.field_sentence_audio': { en: 'Sentence audio → field', ja: '文の音声 → フィールド' },
  'ph.field_term': { en: 'Term → field', ja: '単語 → フィールド' },
  'ph.field_reading': { en: 'Reading → field', ja: '読み → フィールド' },
  'ph.field_sentence': { en: 'Sentence → field', ja: '文 → フィールド' },
  'ph.field_meaning': { en: 'Meaning → field', ja: '意味 → フィールド' },
  'ph.field_term_audio': { en: 'Term audio → field', ja: '単語の音声 → フィールド' },
  'ph.field_glossary': { en: 'Glossary (rich, optional) → field', ja: '用語集（リッチ・任意） → フィールド' },
  'ph.field_furigana': { en: 'Furigana ruby (optional) → field', ja: 'ふりがなルビ（任意） → フィールド' },

  // ---- label + help-span rows (data-i18n-html: value is innerHTML = lead text + styled help span) ----
  'ph.combine_subs': {
    en: 'Combine short subtitles<span style="display:block;font-size:.7em;color:var(--text-muted,#888);margin-top:2px;">Merge short subtitle fragments into one card (sentences &amp; quotes stay together); the playing line is highlighted.</span>',
    ja: '短い字幕を結合<span style="display:block;font-size:.7em;color:var(--text-muted,#888);margin-top:2px;">短い字幕の断片を1枚のカードにまとめます（文や引用はひとまとまりのまま）。再生中の行がハイライトされます。</span>'
  },
  'ph.reverse_hswipe': {
    en: 'Reverse horizontal swipe<span style="display:block;font-size:.7em;color:var(--text-muted,#888);margin-top:2px;">Flip prev/next for card, audio, and reader subtitle swipes.</span>',
    ja: '横スワイプを反転<span style="display:block;font-size:.7em;color:var(--text-muted,#888);margin-top:2px;">カード・音声・リーダーの字幕スワイプで前後を入れ替えます。</span>'
  },
  'ph.keep_awake': {
    en: 'Keep screen awake<span style="display:block;font-size:.7em;color:var(--text-muted,#888);margin-top:2px;">Stop the display dimming or sleeping while you read. Releases after this many minutes with no interaction (each tap, scroll, or page-turn restarts the timer).</span>',
    ja: '画面をスリープさせない<span style="display:block;font-size:.7em;color:var(--text-muted,#888);margin-top:2px;">読書中に画面が暗くなったりスリープしたりするのを防ぎます。操作がないまま指定の分数が経過すると解除されます（タップ・スクロール・ページめくりのたびにタイマーがリセットされます）。</span>'
  },
  'ph.ai_quality': {
    en: 'Processing quality<span style="display:block;font-size:.7em;color:var(--text-muted,#888);margin-top:2px;">Rough cost for a full ~20-chapter book is shown per option.</span>',
    ja: '処理品質<span style="display:block;font-size:.7em;color:var(--text-muted,#888);margin-top:2px;">約20章の本1冊あたりのおおよその費用を選択肢ごとに表示します。</span>'
  },
  'ph.ai_split': {
    en: 'Split long chapters over<span style="display:block;font-size:.7em;color:var(--text-muted,#888);margin-top:2px;">A chapter longer than this many <b>thousand</b> characters is divided into roughly-even parts (1/n, 2/n…). 0 = never split. Re-detect/reset a book\'s AI data to apply to it.</span>',
    ja: '長い章を分割する基準<span style="display:block;font-size:.7em;color:var(--text-muted,#888);margin-top:2px;">この<b>千</b>文字数を超える章は、ほぼ均等な複数パートに分割されます（1/n、2/n…）。0 = 分割しない。本のAIデータを再検出/リセットすると反映されます。</span>'
  },
  'ph.ai_autoprocess': {
    en: 'Process chapters automatically<span style="display:block;font-size:.7em;color:var(--text-muted,#888);margin-top:2px;">Finished chapters are processed quietly in the background (timeline + characters). Off: only the manual &ldquo;Update Timeline&rdquo; button sends anything.</span>',
    ja: '章を自動で処理<span style="display:block;font-size:.7em;color:var(--text-muted,#888);margin-top:2px;">読み終えた章はバックグラウンドで静かに処理されます（タイムライン＋キャラクター）。オフの場合は手動の「タイムラインを更新」ボタンを押したときだけ送信されます。</span>'
  },
  'ph.falai_key': {
    en: 'fal.ai API key<span style="display:block;font-size:.7em;color:var(--text-muted,#888);margin-top:2px;">The key from fal.ai/dashboard/keys (no identity verification needed). Character prompts are written by Claude.</span>',
    ja: 'fal.ai API key<span style="display:block;font-size:.7em;color:var(--text-muted,#888);margin-top:2px;">fal.ai/dashboard/keys のキー（本人確認は不要）。キャラクターのプロンプトはClaudeが作成します。</span>'
  },
  'ph.fal_fallback': {
    en: 'Fallback on refusal<span style="display:block;font-size:.7em;color:var(--text-muted,#888);margin-top:2px;">If gpt-image or similar refuses the content, automatically regenerate with this model (uncensored FLUX recommended).</span>',
    ja: '拒否時のフォールバック<span style="display:block;font-size:.7em;color:var(--text-muted,#888);margin-top:2px;">gpt-image等が内容を拒否したら、このモデルで自動再生成（無検閲FLUX推奨）。</span>'
  },
  'ph.scene_ideas': {
    en: 'Generate scene ideas per chapter (AI)<span style="display:block;font-size:.7em;color:var(--text-muted,#888);margin-top:2px;">When summarizing a chapter, the AI proposes scenes that could be illustrated (shown under “Scenes” on the timeline; you pick which to turn into images). The count is set by “Scene frequency” below. Output increases slightly.</span>',
    ja: '章ごとにシーン案を生成（AI）<span style="display:block;font-size:.7em;color:var(--text-muted,#888);margin-top:2px;">章の要約時に、挿絵にできる場面案をAIが作成（タイムラインの「シーン」に表示・どれを画像化するか選べます）。件数は下の「シーンの頻度」で決まります。出力が少し増えます。</span>'
  },
  'ph.scene_freq': {
    en: 'Scene frequency (one per N characters)<span style="display:block;font-size:.7em;color:var(--text-muted,#888);margin-top:2px;">Roughly one illustration scene idea per this many characters. The count varies with chapter length (fewer for short chapters, more for long ones). Default 2000.</span>',
    ja: 'シーンの頻度（文字数ごとに1件）<span style="display:block;font-size:.7em;color:var(--text-muted,#888);margin-top:2px;">この文字数につき挿絵の場面案を1件の目安。章の長さに応じて件数が変わります（短い章は少なく、長い章は多く）。既定 2000。</span>'
  },
  'ph.scene_auto': {
    en: 'Auto-illustrate scenes<span style="display:block;font-size:.7em;color:var(--text-muted,#888);margin-top:2px;">As you read on, scenes for the chapter are generated automatically about every 6,000 characters (shown on the Dynamic Timeline).</span>',
    ja: 'シーンを自動で挿絵化<span style="display:block;font-size:.7em;color:var(--text-muted,#888);margin-top:2px;">読み進むと約6,000字ごとに章の場面を自動生成（ダイナミックタイムラインに表示）。</span>'
  },
  'ph.scene_autoimg': {
    en: 'Auto-generate scene pictures<span style="display:block;font-size:.7em;color:var(--text-muted,#888);margin-top:2px;">When scenes are created during chapter summarization, their images are also generated automatically (queued about every 20 seconds so the server is not overloaded). This costs money.</span>',
    ja: 'シーン画像を自動生成<span style="display:block;font-size:.7em;color:var(--text-muted,#888);margin-top:2px;">章の要約で場面が作られたら、その画像も自動で生成します（順番待ちで約20秒おきに生成しサーバーを過負荷にしません）。コストがかかります。</span>'
  },

  // ---- Backup & transfer settings ----
  'ph.sec_transfer': { en: 'Backup & transfer settings', ja: '設定のバックアップ・引き継ぎ' },
  'ph.transfer_desc': {
    en: 'Move all settings to another device or installation: appearance, playback, AI configuration (including API keys), Anki mappings, and dictionary preferences. Positions, stats, and library content are never included. The exported file contains your API keys - keep it private.',
    ja: '外観・再生・AI設定（APIキーを含む）・Anki設定・辞書設定を別の端末やインストールへ移行します。読書位置・統計・ライブラリは含まれません。エクスポートファイルにはAPIキーが含まれるため、取り扱いに注意してください。'
  },
  'ph.export_settings': { en: 'Export settings…', ja: '設定をエクスポート…' },
  'ph.import_settings': { en: 'Import settings…', ja: '設定をインポート…' },
});
