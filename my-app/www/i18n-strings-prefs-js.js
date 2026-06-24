// i18n-strings-prefs-js.js — UI chrome strings for preferences.js (dynamically
// built Preferences labels/help/buttons/status). Prefix: pj.*
// window.I18N_STRINGS[key] = {en, ja}. CONTENT (deck/field names, dict headwords,
// model ids, file/folder names, currency values) is NOT translated.
window.I18N_STRINGS = Object.assign(window.I18N_STRINGS || {}, {
  // ---- fonts ----
  'pj.font_import_failed': { en: 'Font import failed: {err}', ja: 'フォントのインポートに失敗しました: {err}' },
  'pj.font_serif': { en: 'Serif', ja: '明朝体' },
  'pj.font_sans': { en: 'Sans-serif', ja: 'ゴシック体' },
  'pj.font_system': { en: 'System', ja: 'システム' },
  'pj.import_ttf': { en: '➕ Import TTF…', ja: '➕ TTFをインポート…' },
  'pj.imported_fonts': { en: 'Imported fonts', ja: 'インポート済みフォント' },

  // ---- appearance: mode section headers ----
  'pj.mode_card': { en: 'card', ja: 'カード' },
  'pj.mode_read': { en: 'read', ja: '読書' },
  'pj.mode_audio': { en: 'audio', ja: '音声' },
  'pj.dictionary_popup': { en: 'Dictionary popup', ja: '辞書ポップアップ' },

  // ---- appearance: per-mode rows ----
  'pj.font_family': { en: 'Font family', ja: 'フォント' },
  'pj.font_size': { en: 'Font size', ja: '文字サイズ' },
  'pj.text_alignment': { en: 'Text alignment', ja: 'テキストの配置' },
  'pj.align_center': { en: 'Center', ja: '中央' },
  'pj.align_left': { en: 'Left', ja: '左' },
  'pj.picture_position': { en: 'Picture position', ja: '画像の位置' },
  'pj.pos_top': { en: 'Top', ja: '上' },
  'pj.pos_centered': { en: 'Centered', ja: '中央' },
  'pj.pos_bottom': { en: 'Bottom', ja: '下' },
  'pj.show_bg_image': { en: 'Show background image', ja: '背景画像を表示' },
  'pj.show_waveform': { en: 'Show waveform', ja: '波形を表示' },
  'pj.show_upcoming_subtitle': { en: 'Show upcoming subtitle', ja: '次の字幕を表示' },
  'pj.invert_line_art': { en: 'Invert line art (dark mode)', ja: '線画を反転（ダークモード）' },
  'pj.lockscreen_subtitle_art': { en: 'Lock screen: subtitle as cover art', ja: 'ロック画面: 字幕をカバーアートに' },
  'pj.subtitle_vertical_offset': { en: 'Subtitle vertical offset', ja: '字幕の垂直オフセット' },
  'pj.stopwatch_timeout': { en: 'Stopwatch inactivity timeout (s)', ja: 'ストップウォッチの無操作タイムアウト（秒）' },

  // ---- Anki dropdowns / placeholders ----
  'pj.anki_empty_ios': { en: '(tap "Fetch from Anki")', ja: '（「Ankiから取得」をタップ）' },
  'pj.anki_empty_android': { en: '(AnkiConnect unreachable)', ja: '（AnkiConnectに接続できません）' },
  'pj.saved_suffix': { en: '{value} (saved)', ja: '{value}（保存済み）' },
  'pj.none': { en: '(none)', ja: '（なし）' },

  // ---- iOS Anki fetch button ----
  'pj.anki_fetch_btn': { en: '⤓ Fetch decks, note types & fields from Anki', ja: '⤓ Ankiからデッキ・ノートタイプ・フィールドを取得' },
  'pj.anki_fetch_note': { en: 'Opens AnkiMobile and returns here. Run once — and again after you add decks/note types in Anki.', ja: 'AnkiMobileを開いてここに戻ります。最初に一度実行し、Ankiでデッキやノートタイプを追加したら再度実行してください。' },
  'pj.anki_bridge_unavailable': { en: 'AnkiMobile bridge unavailable.', ja: 'AnkiMobileブリッジが利用できません。' },
  'pj.opening_ankimobile': { en: 'Opening AnkiMobile…', ja: 'AnkiMobileを開いています…' },
  'pj.anki_fetch_result': { en: '{nd} decks, {nt} note types', ja: 'デッキ{nd}件、ノートタイプ{nt}件' },
  'pj.anki_fetch_failed': { en: 'Could not fetch from AnkiMobile: {err}\n\nMake sure AnkiMobile is installed and up to date, then try again.', ja: 'AnkiMobileから取得できませんでした: {err}\n\nAnkiMobileがインストールされ最新であることを確認して、再度お試しください。' },

  // ---- iOS media folder linker ----
  'pj.media_folder': { en: 'Media folder', ja: 'メディアフォルダ' },
  'pj.media_folder_help': { en: 'Optional fallback. Primary delivery uses the in-app HTTP server — no linking required.', ja: '任意のフォールバックです。主な配信はアプリ内のHTTPサーバーを使用するため、リンクは不要です。' },
  'pj.checking': { en: 'Checking…', ja: '確認中…' },
  'pj.link_folder': { en: 'Link folder', ja: 'フォルダをリンク' },
  'pj.unlink': { en: 'Unlink', ja: 'リンク解除' },
  'pj.send_test_card': { en: 'Send test card', ja: 'テストカードを送信' },
  'pj.media_linked': { en: 'Linked: {name}', ja: 'リンク済み: {name}' },
  'pj.relink': { en: 'Re-link', ja: '再リンク' },
  'pj.not_linked': { en: 'Not linked (fallback only — not required)', ja: 'リンクなし（フォールバックのみ — 不要）' },
  'pj.status_check_failed': { en: 'Status check failed', ja: 'ステータス確認に失敗しました' },
  'pj.link_folder_failed': { en: 'Could not link folder: {err}', ja: 'フォルダをリンクできませんでした: {err}' },

  // ---- Send test card diagnostics ----
  'pj.anki_settings_unavailable': { en: 'Anki settings unavailable', ja: 'Ankiの設定が利用できません' },
  'pj.test_ok': { en: '✓ TEST OK — model/deck names work. If real sends fail, the issue is media-related.', ja: '✓ テスト成功 — ノートタイプ／デッキ名は有効です。実際の送信が失敗する場合は、メディア関連の問題です。' },
  'pj.test_rejected': { en: '✗ TEST REJECTED by AnkiMobile (model "{model}" invalid). Tap OK to copy the URL.', ja: '✗ AnkiMobileに拒否されました（ノートタイプ「{model}」が無効）。OKをタップしてURLをコピーします。' },
  'pj.test_no_reply': { en: '? TEST: no reply from AnkiMobile.\n\nSent: model="{model}" deck="{deck}"\nLast callback URL seen: {url}\n\nTap OK to copy the URL for manual Safari testing.', ja: '? テスト: AnkiMobileから応答がありません。\n\n送信: model="{model}" deck="{deck}"\n最後に確認したコールバックURL: {url}\n\nOKをタップすると、Safariで手動テストするためのURLをコピーします。' },
  'pj.url_header': { en: '— URL —', ja: '— URL —' },
  'pj.url_copied': { en: 'URL copied. Paste in Safari to test AnkiMobile directly.', ja: 'URLをコピーしました。Safariに貼り付けてAnkiMobileを直接テストしてください。' },
  'pj.url_copied_fallback': { en: 'URL copied (fallback). Paste in Safari to test.', ja: 'URLをコピーしました（フォールバック）。Safariに貼り付けてテストしてください。' },
  'pj.test_failed': { en: 'Test failed: {err}', ja: 'テストに失敗しました: {err}' },

  // ---- AI usage / cost ----
  'pj.api_usage_month': { en: 'Estimated API usage this month: ~${usd}', ja: '今月の推定API使用料: 約${usd}' },
  'pj.cloud_img_usage_month': { en: 'Cloud image usage this month: ', ja: '今月のクラウド画像使用料: ' },
  'pj.ai_cost_by_book': { en: 'AI cost by book (cumulative)', ja: '本ごとのAIコスト（累計）' },
  'pj.total': { en: 'Total', ja: '合計' },

  // ---- save ----
  'pj.preferences_saved': { en: 'Preferences saved', ja: '設定を保存しました' },

  // ---- dictionary manager ----
  'pj.import_yomitan_zip': { en: '＋ Import Yomitan zip…', ja: '＋ Yomitan辞書(zip)をインポート…' },
  'pj.no_dicts_loaded': { en: 'No dictionaries loaded yet. Open Preferences again once startup loading completes.', ja: 'まだ辞書が読み込まれていません。起動時の読み込みが完了したら、設定を再度開いてください。' },
  'pj.orphaned_relic': { en: '(orphaned relic)', ja: '（孤立した残存データ）' },
  'pj.imported_tag': { en: '(imported)', ja: '（インポート済み）' },
  'pj.entries': { en: 'entries', ja: '項目' },
  'pj.remove_dictionary': { en: 'Remove dictionary', ja: '辞書を削除' },
  'pj.remove_dict_confirm': { en: 'Remove dictionary "{name}"? Its data will be cleared from device storage.', ja: '辞書「{name}」を削除しますか？データはデバイスのストレージから消去されます。' },
  'pj.removing_dict': { en: 'Removing "{name}"…', ja: '「{name}」を削除中…' },
  'pj.removing_dict_pct': { en: 'Removing "{name}"… {pct}%', ja: '「{name}」を削除中… {pct}%' },

  // ---- dictionary import progress ----
  'pj.phase_unzip': { en: 'Unzipping…', ja: '解凍中…' },
  'pj.phase_parse': { en: 'Parsing entries…', ja: '項目を解析中…' },
  'pj.phase_cache': { en: 'Saving…', ja: '保存中…' },
  'pj.phase_index': { en: 'Indexing…', ja: 'インデックス作成中…' },
  'pj.phase_done': { en: 'Imported', ja: 'インポート完了' },
  'pj.reading_file': { en: 'Reading {name}…', ja: '{name}を読み込み中…' },
  'pj.import_done': { en: 'Imported "{name}". Lookups ready.', ja: '「{name}」をインポートしました。検索の準備ができました。' },
  'pj.import_failed': { en: 'Failed: {err}', ja: '失敗: {err}' },
});
