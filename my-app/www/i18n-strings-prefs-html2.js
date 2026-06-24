// i18n-strings-prefs-html2.js — remaining Preferences chrome the first pass skipped:
// the long Google-Drive + audio-archive help paragraphs (ph2.*, rich innerHTML) and the
// JS-owned Google Drive connect button/status/toasts (dr.*, in drive-sync-ui.js).
// Loaded after i18n-strings.js. CONTENT is never here. The Licenses body stays English by design.
window.I18N_STRINGS = Object.assign(window.I18N_STRINGS || {}, {
  // ---- Google Drive sync — description paragraph (keeps inline <b>) ----
  'ph2.gdrive_desc': {
    en: 'Sync the <b>currently open title</b> between your devices via your own Google Drive: dynamic timeline, character cards (incl. images), processing progress, AI settings, and your exact position. After connecting here, use <b>Sync</b> in the title menu (⋯) — it’s bidirectional and always fast. The first Sync of a title asks once whether to also move the files (epub/SRT/audiobook); they only transfer once. <b>Browse Drive…</b> lists and deletes synced titles.',
    ja: '<b>現在開いているタイトル</b>を、自分の Google Drive を通じてデバイス間で同期します：ダイナミックタイムライン、キャラクターカード（画像を含む）、処理の進捗、AI設定、そして正確な読書位置。ここで接続したあとは、タイトルメニュー（⋯）の<b>同期</b>を使います — 双方向で常に高速です。タイトルの初回同期時に、ファイル（epub/SRT/オーディオブック）も移動するかを一度だけ確認します。移動は一度きりです。<b>Drive を閲覧…</b>で同期済みタイトルの一覧表示・削除ができます。',
  },
  // ---- Audio archive — import instructions (keeps <code>/<ul>/<li>/<b>) ----
  'ph2.audio_archive_desc': {
    en: 'The per-word audio archive imports as one <code>.tar</code>, <code>.tar.gz</code>, or <code>.tar.xz</code> file (the unpacked form is too many individual files to transfer). Tap Import and pick the file:<ul style="margin:6px 0 0 0;padding-left:18px;"><li><b>Android</b>: any of <code>.tar</code> / <code>.tar.gz</code> / <code>.tar.xz</code>, picked from the system file browser.</li><li><b>iOS</b>: <code>.tar</code> (if yours is <code>.tar.xz</code>, run <code>xz -d local-yomichan.tar.xz</code> on your computer first). Drop it in via Finder’s Files tab, or pick it from the file browser.</li></ul>Extraction takes ~30 s for <code>.tar</code>/<code>.tar.gz</code>, longer for <code>.tar.xz</code> (XZ is CPU-heavy); archives we copied in are freed after success.',
    ja: '1単語ごとの音声アーカイブは、1つの <code>.tar</code>、<code>.tar.gz</code>、または <code>.tar.xz</code> ファイルとして取り込みます（展開後は個別ファイルが多すぎて転送できません）。「インポート」を押してファイルを選んでください：<ul style="margin:6px 0 0 0;padding-left:18px;"><li><b>Android</b>：<code>.tar</code> / <code>.tar.gz</code> / <code>.tar.xz</code> のいずれかを、システムのファイルブラウザから選択。</li><li><b>iOS</b>：<code>.tar</code>（<code>.tar.xz</code> の場合は、まずパソコンで <code>xz -d local-yomichan.tar.xz</code> を実行）。Finder の「ファイル」タブから入れるか、ファイルブラウザから選択。</li></ul>展開は <code>.tar</code>/<code>.tar.gz</code> で約30秒、<code>.tar.xz</code> はさらに時間がかかります（XZはCPU負荷が高い）。取り込んだアーカイブは成功後に解放されます。',
  },
  // ---- Google Drive connect button / status / toasts (drive-sync-ui.js) ----
  'dr.not_configured':   { en: 'Not configured', ja: '未設定' },
  'dr.not_connected':    { en: 'Not connected', ja: '未接続' },
  'dr.connected':        { en: 'Connected', ja: '接続済み' },
  'dr.connected_email':  { en: 'Connected · {email}', ja: '接続済み · {email}' },
  'dr.connect_btn':      { en: 'Connect Google Drive', ja: 'Google Drive に接続' },
  'dr.disconnect_btn':   { en: 'Disconnect', ja: '切断' },
  'dr.disconnected_toast': { en: 'Disconnected from Google Drive', ja: 'Google Drive から切断しました' },
  'dr.opening_signin':   { en: 'Opening Google sign-in…', ja: 'Google サインインを開いています…' },
  'dr.connected_toast':  { en: 'Connected to Google Drive', ja: 'Google Drive に接続しました' },
  'dr.signin_failed':    { en: 'sign-in failed', ja: 'サインインに失敗しました' },
  'dr.access_expired':   { en: 'Google Drive access expired — reconnect in Preferences.', ja: 'Google Drive の認証が切れました — 設定で再接続してください。' },
});
