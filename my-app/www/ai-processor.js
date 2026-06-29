// ai-processor.js — per-chunk chapter state machine (AI v2 plan §6 + §12,
// docs/ai-reading-companion-plan.md). Consumes the chunk map ai-chunks.js
// builds, runs ONE structured-output chapter call per finished chunk —
// sequential by idx, the character DB is cumulative — and fans the result
// out: AICHAP_V1 artifact, character patch (aiCharacters.applyChapterOutput),
// synopsis/unresolved back into the chunk map.
//
// SOLE writer of chunk `state`/`attempts`/`error`/`processedTs` and of the
// AICHAP_V1 artifact; every map write is a fresh read-modify-write because
// ai-chunks owns the other fields (furthest, cue bounds). Foreground-only,
// single inflight call, never touches any position/restore key.
(function () {
  'use strict';

  const MAP_PREFIX  = 'AICHUNKS_V1_';
  const CHAP_PREFIX = 'AICHAP_V1_';
  const AUTO_PREF   = 'AI_AUTO_PROCESS';    // localStorage; default ON
  const TICK_MS     = 15 * 1000;
  const MAX_ATTEMPTS = 3;
  const RETRY_BASE_MS = 30 * 1000;          // ×2 per failed attempt (in-session)
  const CONFIRM_USD = 0.50;                 // catch-up confirm threshold (§12)
  const INPUT_CAP   = 60000;                // per-chunk text cap, tail-kept
  const OVERHEAD_CHARS = 5000;              // ≈6k tokens of prompt state (§12)
  const OUT_TOKENS  = 3000;                 // §12 per-chunk COST estimate (incl. 3-4 scene prompts)
  // Hard output cap. Summaries are short, but a character-heavy chapter (e.g.
  // the first one, where the whole cast is introduced) can emit a big
  // characters[] array — too low a cap truncates the JSON → unparseable →
  // permanent 失敗. Keep generous; it only caps, it doesn't force usage.
  const MAX_TOKENS  = 12000;   // headroom for the scene-prompts array (truncated JSON = a failed chapter)
  const SYNOPSIS_CAP = 4000;

  // ---- structured-output schema (§6, verbatim shape) -------------------------
  const REL_ITEM = {
    type: 'object',
    properties: { to: { type: 'string' }, rel: { type: 'string' } },
    required: ['to', 'rel'], additionalProperties: false,
  };
  const NEW_CHAR = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      surface: { type: 'string' },
      rubyReading: { type: 'string' },
      standardReading: { type: 'string' },
      aliases: { type: 'array', items: { type: 'string' } },
      isCommonWord: { type: 'boolean' },
      role: { type: 'string' },
      description: { type: 'string' },
      personality: { type: 'string' },
      appearance: { type: 'string' },
      motivations: { type: 'string' },
      secrets: { type: 'string' },
      relationships: { type: 'array', items: REL_ITEM },
      mergedInto: { type: 'string' },
    },
    required: ['id', 'surface', 'standardReading', 'aliases', 'description'],
    additionalProperties: false,
  };
  const UPDATE_ITEM = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      newDevelopments: { type: 'array', items: { type: 'string' } },
      set: {
        type: 'object',
        properties: {
          role: { type: 'string' }, personality: { type: 'string' },
          appearance: { type: 'string' }, motivations: { type: 'string' },
          secrets: { type: 'string' }, description: { type: 'string' },
        },
        additionalProperties: false,
      },
      relationshipChanges: { type: 'array', items: REL_ITEM },
    },
    required: ['id'], additionalProperties: false,
  };
  const PRESENCE_ITEM = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      importance: { type: 'integer' },
      reveal: { type: 'boolean' },
    },
    required: ['id', 'importance'], additionalProperties: false,
  };
  const CHAPTER_SCHEMA = {
    type: 'object',
    properties: {
      label: { type: 'string' },
      shortSummary: { type: 'string' },
      longSummary: { type: 'string' },
      events: {
        type: 'array',
        items: {
          type: 'object',
          properties: { title: { type: 'string' }, description: { type: 'string' } },
          required: ['title', 'description'], additionalProperties: false,
        },
      },
      keyPassages: {
        type: 'array',
        items: {
          type: 'object',
          properties: { quote: { type: 'string' }, why: { type: 'string' } },
          required: ['quote', 'why'], additionalProperties: false,
        },
      },
      characters: {
        type: 'object',
        properties: {
          'new': { type: 'array', items: NEW_CHAR },
          updates: { type: 'array', items: UPDATE_ITEM },
          presence: { type: 'array', items: PRESENCE_ITEM },
        },
        required: ['new', 'updates', 'presence'], additionalProperties: false,
      },
      unresolved: { type: 'array', items: { type: 'string' } },
    },
    required: ['label', 'shortSummary', 'longSummary', 'events',
               'keyPassages', 'characters', 'unresolved'],
    additionalProperties: false,
  };

  const SYSTEM_PROMPT =
    'あなたは長編作品の読書記録を管理するアシスタントです。読者が読み終えたばかりの章の本文と、' +
    'これまでの蓄積状態(あらすじ・登場人物データベース・未解決の話題)が与えられます。' +
    'この章の記録を指定のJSON形式で出力してください。\n' +
    '厳守事項:\n' +
    '- 与えられた本文と蓄積状態に書かれている事実のみを使う。この作品に関する外部知識' +
    '(学習データに含まれる原作・アニメ・映画などの知識を含む)は一切使用禁止。\n' +
    '- 今後の展開の予測・伏線の解釈・憶測を書かない(「怪しい」などの示唆も禁止)。\n' +
    '- すべて日本語で、本文の文体・語彙にできるだけ忠実に書く。マークダウン記法は使わない。\n' +
    '- label: この章の内容を表す12字以内の章タイトル。\n' +
    '- shortSummary: ざっと振り返るための短い要約(2〜3文)。\n' +
    '- longSummary: この章の要約(最大2〜3段落、合計400字程度まで)。本文からの短い正確な' +
    '引用を「」で交えてよい。2〜3文ごとに段落を分け、段落の間に空行を入れる。冗長にしない。\n' +
    '- events: この章の主な出来事を起きた順に。title は短い見出し、description は1〜2文。\n' +
    '- keyPassages: 印象的・重要な場面を2〜5件。quote は本文からの一字一句正確な抜粋' +
    '(40〜120字)。改変・省略・繋ぎ合わせは絶対に禁止(後で本文検索に使うため)。' +
    'why はその場面が重要な理由(一文)。\n' +
    '- characters.new: この章で初登場した人物のみ。id は既存と重複しない c始まりの連番' +
    '(既存が c05 までなら c06 から)。description は150字以内・2〜3文で「誰なのか」を優先。' +
    '人間関係は description ではなく relationships に入れる。\n' +
    '- characters.updates: 既存人物に変化があった場合のみ。既存の id を絶対に変更しない。' +
    'newDevelopments はこの章での新しい動き(各1文)。set には変化したフィールドだけを入れる。' +
    'relationshipChanges は変化・新規の関係のみ。\n' +
    '- motivations / secrets は本文中に根拠のあるものに限る。推測や深読みで補わない。\n' +
    '- 本文中で同一人物だと明かされた場合のみ、統合される側の mergedInto に統合先の id を設定する。\n' +
    '- aliases には本文で実際に使われた呼び方のみを含める(愛称・呼び捨て・二つ名など)。' +
    '動詞・形容詞・一般名詞・代名詞(彼、私など)を aliases に入れることは絶対に禁止。\n' +
    '- 一般名詞と紛らわしい名前は isCommonWord を true にする。\n' +
    '- standardReading は全ての登場人物に必須。漢字でもカタカナでも、その名前の' +
    '標準的な読みを必ずひらがなで入れる(例: 杉村→すぎむら)。読みが不明でも「なし」「不明」' +
    '等とは絶対に書かず、最も妥当な読みを必ず推定して入れる。別途「本文中のルビ」一覧が' +
    '与えられた場合、その人物名(またはその一部)の読みがそこにあれば、rubyReading に必ず' +
    'そのルビをそのまま記録する(rubyReading が最優先で表示される)。\n' +
    '- characters.presence: この章に登場・言及された人物全員(新規含む)。importance は' +
    'この章での重要度(0=言及のみ、1=登場、2=重要な役割、3=中心人物)。正体の判明など' +
    '重大な転換があった場合のみ reveal を true にする。\n' +
    '- unresolved: この章の終了時点で未解決の伏線・進行中の話題を短文で列挙' +
    '(リスト全体を置き換える。解決済みは外し、新規を加え、継続中は残す)。';

  // ---- scene-prompt generation (挿絵) — rides on the same chapter call ---------
  // Claude also authors 3-4 illustratable scenes per chapter (it picks the style),
  // each an English image prompt + a Japanese caption. Gated by AISCENE_IDEAS
  // (default on). The 'scenes' schema field is OPTIONAL (never in `required`) so a
  // missing/short array can never fail-validate the whole chapter JSON.
  const SCENE_STYLES = ['photoreal', 'hand-drawn', 'painted', 'abstract', 'cinematic', 'watercolor', 'ink', 'comic'];
  const SCENE_SCHEMA_PROP = {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        prompt: { type: 'string' },
        style: { type: 'string', enum: SCENE_STYLES },
        caption: { type: 'string' },
        anchorQuote: { type: 'string' },
      },
      // anchorQuote REQUIRED: it's the only thing that links a scene to the audio /
      // book text (cueRangeForQuote resolves it to a cue range). Optional → the
      // model often omitted it → scenes with no audio link. Forcing it (here +
      // the rule below) guarantees every new scene can resolve to its audio quote.
      required: ['prompt', 'style', 'caption', 'anchorQuote'], additionalProperties: false,
    },
  };
  // Scene frequency is char-based: ~1 scene per AISCENE_CHARS_PER chars (default
  // 2000), so long chapters get more scenes and short ones fewer — chapters vary a
  // lot in length, so a flat "3-4" was a poor fit.
  function charsPerScene() { try { const v = parseInt(localStorage.getItem('AISCENE_CHARS_PER') || '2000', 10); return (Number.isFinite(v) && v >= 200) ? v : 2000; } catch (_) { return 2000; } }
  function sceneCountFor(text) {
    let chars = 0;
    try { chars = (typeof window.jpCharCount === 'function') ? window.jpCharCount(text || '') : (text || '').length; } catch (_) { chars = (text || '').length; }
    const n = Math.round(chars / charsPerScene());
    return Math.max(1, Math.min(12, n || 1));   // clamp 1..12
  }
  const SCENE_RULES =
    '\n- scenes: この章を象徴する視覚的な場面を{COUNT}、挿絵用に作成する。各 prompt は完全に自己完結させる（画像モデルは本文も登場人物DBも見ない）。劇的な場面だけでなく静かな場面も含め、章を代表する多様な場面を選ぶ。\n' +
    '  ・prompt: 画像生成用の英語プロンプト（1段落・カンマ区切りの描写句、文章ではない）。本文に書かれた場面のみ描き、未読部分や他章・外部知識は使わない。\n' +
    '  ・画風（最重要・全挿絵で統一）: 上に［この作品の画風］があれば全 prompt をその画風で統一し、prompt の冒頭に英語で明記する。基調は「2Dの手描きアニメ映画の一枚絵」— 手描きのセル画/絵画調で、映画的なライティングと奥行きのある構図・空気感、表情豊かな顔を持つ。3D・CG・Pixar調のレンダリングや、つやつや/プラスチック的な質感は避ける（あくまで2Dの手描きイラスト, "flat 2D hand-drawn illustration, not 3D/CGI" のように英語でも明記）。\n' +
    '  ・登場人物: 各人物の容姿・年齢・髪型/髪色・体型・服装・持ち物を［登場人物の容姿］と本文に基づき英語で具体的に書き、挿絵全体で同じ人物が同じ姿に見えるようにする。民族・国籍を必ず明示（舞台と名前から判断。本文が日本語でも日本人とは限らない。例 "a Russian woman in her 20s", "a Japanese man"）。\n' +
    '  ・表情と感情: 顔は無表情・量産的にせず、その場面の感情（孤独・緊張・安らぎ・悲しみ等）を目線・口元・姿勢で具体的に描く。視線と体の向きを場面の行動に合わせる（会話なら相手に顔を向ける、寂しい別れなら俯く等）。\n' +
    '  ・構図と遠近: 同じ場面に複数人いる場合、各人物の大きさ・遠近を正しく（不自然な大小差を作らない）。一つの明確な瞬間に焦点を当てる。手は最小限に（動かすのは片手、もう片方は下ろす/隠す）。顔や体に血・赤い液体・赤い筋を描かない。\n' +
    '  ・舞台と雰囲気: 場所・建物・風景・時代・季節・時間帯・天候・光を本文とあらすじから具体的に書き、その場所だと正しく伝わる十分な背景を入れる（例：室内なのに船に見えない等）。\n' +
    '  ・caption: 場面を説明する自然な日本語（1〜2文・本文の事実のみ・登場人物の名前を含む）。 style/title は任意。\n' +
    '  ・anchorQuote（必須）: その場面に最も対応する本文の一節を、本文から一字一句正確に抜き出して必ず入れる（要約・言い換え・原文に無い文字の追加は不可）。15〜40字程度の特徴的な一文・一節を選ぶ。音声と原文へのリンクに使うため、本文と完全一致しなければならない。\n' +
    '- styleDirective: ［この作品の画風］が未指定のときのみ、作品全体の挿絵の画風を英語で1〜2文定義する。必ず「2Dの手描き/絵画調イラスト」とし（手描きアニメ・水彩・油彩・インク等から作品の雰囲気・ジャンル・時代に合うものを選ぶ）、映画的でドラマチックなライティングと色調を指定する。3D・CG・Pixar調・写実的な3Dレンダリングは禁止（"flat 2D hand-drawn illustration, not 3D/CGI" を含める）。すでに与えられていれば同じ内容を返すだけでよい。';
  const sceneCountLabel = (n) => (n <= 1 ? '1件' : ('約' + n + '件'));
  const sceneRules = (n) => SCENE_RULES.replace('{COUNT}', sceneCountLabel(n));
  // Standalone system prompt for the on-demand "scene ideas" backfill (scenes only).
  const sceneOnlySystem = (n) =>
    'あなたは小説の挿絵のアートディレクターです。与えられた章の本文だけを使い（外部知識・他章・今後の展開は使用禁止）、' +
    'この章を象徴する視覚的な場面を' + sceneCountLabel(n) + '選び、指定のJSON形式(scenes配列)で出力してください。各場面:' + sceneRules(n) +
    '\nマークダウン記法は使わない。';
  function withScenes(schema) {
    return Object.assign({}, schema, { properties: Object.assign({}, schema.properties, { scenes: SCENE_SCHEMA_PROP, styleDirective: { type: 'string' } }) });
  }
  function sceneIdeasOn() { try { return localStorage.getItem('AISCENE_IDEAS') !== '0'; } catch (_) { return true; } }   // default on
  // A "[登場人物の容姿]" block with the FULL appearances of the characters present in
  // this chapter, so scene prompts can render people consistently (the compact DB
  // only carries 1-line descriptions). Reuses aiImages.presentCharacters (name-scan
  // of the chapter text against the known DB → {surface,reading,appearance,relationships}).
  // Empty when nothing matches (e.g. a brand-new book whose DB is still empty).
  async function sceneCharContext(titleId, idx, text) {
    try {
      if (!window.aiImages || !window.aiImages.presentCharacters) return '';
      const present = await window.aiImages.presentCharacters(titleId, idx, text || null);
      if (!present || !present.length) return '';
      const lines = [];
      for (const c of present) {
        const nm = (c && (c.surface || c.name)) || '';
        if (!nm) continue;
        const rd = (c.reading && c.reading !== nm) ? ('（' + c.reading + '）') : '';
        const ap = c.appearance ? ('：' + String(c.appearance).slice(0, 400)) : '';
        const rel = c.relationships ? ('  ［関係: ' + String(c.relationships).slice(0, 200) + '］') : '';
        lines.push('- ' + nm + rd + ap + rel);
        if (lines.length >= 12) break;
      }
      return lines.length ? ('\n\n［登場人物の容姿（既知・挿絵で姿を一致させる）］\n' + lines.join('\n')) : '';
    } catch (_) { return ''; }
  }
  // Per-title art-style directive (decided ONCE by Claude from the book's mood) so all
  // illustrations stay consistent. Read by the renderer (ai-image-openai) too. Seed-once.
  const STYLE_PREFIX = 'AISTYLE_V1_';
  async function getStyleDirective(titleId) {
    try { const v = window.blobStore ? await window.blobStore.get(STYLE_PREFIX + titleId) : null; return (typeof v === 'string' && v.trim()) ? v.trim() : ''; } catch (_) { return ''; }
  }
  async function setStyleDirectiveIfEmpty(titleId, d) {
    try { if (!d || !String(d).trim()) return; if (await getStyleDirective(titleId)) return; await window.blobStore.set(STYLE_PREFIX + titleId, String(d).trim().slice(0, 400)); } catch (_) {}
  }

  // ---- session state ----------------------------------------------------------
  let _inflight = false;
  let _cur = null;            // {titleId, idx} while a call is in flight
  let _openedFor = null;      // title whose open-sweep ran against a real map
  const _declined = {};       // titleId → true (catch-up confirm declined this session)
  const _retryAt = {};        // 'titleId:idx' → earliest auto-retry ts
  const _forced = new Set();  // 'titleId:idx' user-targeted chapters that bypass the in-order pump
  function rk(t, i) { return t + ':' + i; }

  // ---- gates / ai.js doc-contract guards ---------------------------------------
  function autoOn() {
    try { const v = localStorage.getItem(AUTO_PREF); return v === null || v === '1'; }
    catch (_) { return false; }
  }
  async function aiReady() {
    try { if (window.ai && window.ai.ready) await window.ai.ready; } catch (_) {}
    try { return !!(window.ai && window.ai.isEnabled()); } catch (_) { return false; }
  }
  function chapterModel() {
    try {
      if (window.ai && typeof window.ai.modelFor === 'function') {
        const m = window.ai.modelFor('chapter');
        if (m) return m;
      }
    } catch (_) {}
    try { if (window.ai && window.ai.MODELS && window.ai.MODELS.default) return window.ai.MODELS.default; } catch (_) {}
    return 'claude-sonnet-4-6';
  }
  function estCostUsd(model, inChars, outTokens) {
    try {
      if (window.ai && typeof window.ai.estimateCostUsd === 'function') {
        const v = window.ai.estimateCostUsd(model, inChars, outTokens);
        if (Number.isFinite(v)) return v;
      }
    } catch (_) {}
    // §12 fallback math (mirrors ai.js PRICES; ~1.2 tok/char Japanese)
    const m = String(model || '').toLowerCase();
    const p = m.includes('haiku') ? { i: 1, o: 5 }
            : m.includes('opus')  ? { i: 5, o: 25 } : { i: 3, o: 15 };
    return (inChars * 1.2 * p.i + outTokens * p.o) / 1e6;
  }
  function emitChanged(titleId, kind) {
    try {
      if (window.ai && typeof window.ai.emitDataChanged === 'function') {
        window.ai.emitDataChanged(titleId, kind);
      }
    } catch (_) {}
  }

  // ---- chunk map IO -------------------------------------------------------------
  // Always go through ai-chunks' canonical cached instance when available:
  // it is the single map object all writers share, so its persists can never
  // roll back our state writes (and ours never roll back its furthest).
  // The store-level fallback exists only for the pathological no-aiChunks case.
  async function readMap(titleId) {
    try {
      if (window.aiChunks && typeof window.aiChunks.getMap === 'function') {
        const m = await window.aiChunks.getMap(titleId);
        if (m && Array.isArray(m.chunks)) return m;
        return null;
      }
    } catch (_) {}
    try {
      const raw = window.blobStore ? await window.blobStore.get(MAP_PREFIX + titleId) : null;
      const p = raw ? JSON.parse(raw) : null;
      return (p && Array.isArray(p.chunks)) ? p : null;
    } catch (_) { return null; }
  }
  async function mutateMap(titleId, fn) {
    try {
      if (window.aiChunks && typeof window.aiChunks.mutate === 'function') {
        return await window.aiChunks.mutate(titleId, fn);
      }
    } catch (_) { return null; }
    if (!window.blobStore) return null;
    const map = await readMap(titleId);
    if (!map) return null;
    let keep = true;
    try { keep = fn(map) !== false; } catch (_) { return null; }
    if (keep) {
      try { await window.blobStore.set(MAP_PREFIX + titleId, JSON.stringify(map)); } catch (_) {}
    }
    return map;
  }
  function chunkOf(map, idx) {
    try {
      const c = map.chunks[idx];
      if (c && c.idx === idx) return c;
      for (const k of map.chunks) if (k && k.idx === idx) return k;
    } catch (_) {}
    return null;
  }
  function isComplete(map, idx) {
    try {
      if (window.aiChunks && typeof window.aiChunks.isComplete === 'function') {
        return !!window.aiChunks.isComplete(map, idx);
      }
    } catch (_) {}
    // fallback: compare within ONE space only (§13)
    try {
      const c = chunkOf(map, idx);
      const f = map.furthest || {};
      if (c && Number.isFinite(c.jpEnd) && c.jpEnd > 0 &&
          Number.isFinite(f.jp) && f.jp >= c.jpEnd) return true;
      if (c && c.cueEnd >= 0 && Number.isFinite(f.cue) && f.cue >= c.cueEnd) return true;
    } catch (_) {}
    return false;
  }

  // ---- cost model (§12) -----------------------------------------------------------
  function chunkChars(c) {
    const n = ((c && c.rawEnd) | 0) - ((c && c.rawStart) | 0);
    return Math.max(0, Math.min(n, INPUT_CAP));
  }
  function estimateChunks(model, chunks) {
    // When the OpenRouter backend is active, price with the SELECTED OpenRouter
    // model (its inUsd/outUsd are per-1M-token, same as ai.js text models) — NOT
    // the Claude chapter model. Otherwise a fraction-of-a-cent DeepSeek run showed
    // a Claude-priced "~$0.11" estimate (the reported relic).
    let or = null;
    try {
      if (window.ai && window.ai.backend && window.ai.backend() === 'openrouter' && window.ai.openrouterModel) {
        or = window.ai.openrouterModel();
      }
    } catch (_) {}
    let usd = 0;
    for (const c of chunks) {
      const inChars = chunkChars(c) + OVERHEAD_CHARS;
      if (or) usd += (inChars * 1.2 * (Number(or.inUsd) || 0) + OUT_TOKENS * (Number(or.outUsd) || 0)) / 1e6;
      else usd += estCostUsd(model, inChars, OUT_TOKENS);
    }
    return usd;
  }
  // Complete-but-unready chunks, idx ascending. Chunk 0 is exempt from the
  // completion gate (first-chapter carve-out).
  function owedChunks(map, opts) {
    const incFailedFinal = !!(opts && opts.failedFinal);
    const incQueued = !!(opts && opts.queued);
    const out = [];
    for (const c of map.chunks) {
      if (!c) continue;
      const st = c.state;
      if (st === 'ready' || st === 'processing') continue;
      if (st === 'queued' && !incQueued) continue;
      if (st === 'failed' && (c.attempts | 0) >= MAX_ATTEMPTS && !incFailedFinal) continue;
      // idx 0 is carve-out exempt — except single-chunk titles (whole book)
      if ((c.idx !== 0 || map.chunks.length === 1) && !isComplete(map, c.idx)) continue;
      out.push(c);
    }
    return out;
  }

  // ---- triggers --------------------------------------------------------------------
  // Title open: ensure the map, normalize states stranded by a dead session,
  // queue chunk 0 (no confirm — carve-out), then the catch-up check.
  function isActivated(titleId) {
    try { return !!(window.ai && window.ai.activatedSync && window.ai.activatedSync(titleId)); }
    catch (_) { return false; }
  }
  async function titleOpenSweep(titleId) {
    if (!titleId || !(await aiReady())) return;
    if (!isActivated(titleId)) return;       // per-book opt-in: nothing runs until activated
    let map = null;
    try {
      if (window.aiChunks && typeof window.aiChunks.ensure === 'function') {
        map = await window.aiChunks.ensure(titleId);
      }
    } catch (_) {}
    if (!map) map = await readMap(titleId);
    if (!map) return;                      // not buildable yet — the tick retries
    _openedFor = titleId;

    const auto = autoOn();
    await mutateMap(titleId, (m) => {
      let hit = false;
      for (const c of m.chunks) {
        if (!c) continue;
        if (c.state === 'processing') { c.state = auto ? 'queued' : 'none'; hit = true; }
        else if (c.state === 'queued' && !auto) { c.state = 'none'; hit = true; }
      }
      return hit;
    });
    if (!auto) return;                     // OFF → only updateNow processes
    await runCatchUp(titleId, { manual: false, confirmAllowed: !_declined[titleId] });
    pump(titleId);
  }

  // Re-trigger processing after a Drive sync PULL overwrote this title's AI
  // blobs (AICHUNKS/characters): the in-memory map was invalidated, so force the
  // open-sweep to re-queue any chapters that are read-complete-but-unprocessed
  // (e.g. the other device read past them but didn't generate). Without this the
  // processor would idle until the 15s tick / a title-change, or never resume.
  async function resync(titleId) {
    try {
      if (!titleId) return;
      if (titleId === window._activeTitleId) _openedFor = null;   // force titleOpenSweep
      await titleOpenSweep(titleId);   // re-checks activated + aiReady; queues owed chapters
    } catch (_) {}
  }

  // Catch-up (§6): queue chunk 0 unconditionally, then all owed chunks —
  // silently when cheap, behind ONE Japanese confirm above the §12 threshold.
  async function runCatchUp(titleId, opts) {
    const manual = !!(opts && opts.manual);
    const map = await readMap(titleId);
    if (!map || !map.chunks.length) return { queued: 0 };
    const model = chapterModel();
    const toQueue = [];

    const c0 = chunkOf(map, 0);
    if (c0 && c0.state !== 'ready' && c0.state !== 'processing' && c0.state !== 'queued') {
      // Single-chunk titles: chunk 0 IS the whole book, so the first-chapter
      // carve-out would summarize the ending unread — require completion.
      const carveOutOk = map.chunks.length > 1 || isComplete(map, 0);
      if (carveOutOk && (manual || c0.state === 'none' ||
          (c0.state === 'failed' && (c0.attempts | 0) < MAX_ATTEMPTS))) {
        toQueue.push(0);
      }
    }

    const owed = owedChunks(map, { failedFinal: manual }).filter(c => c.idx !== 0);
    if (owed.length) {
      const usd = estimateChunks(model, owed);
      let ok = true;
      if (usd > CONFIRM_USD) {
        ok = false;
        if (opts && opts.confirmAllowed) {
          try {
            ok = window.confirm(
              '読み終えた範囲に未処理の章が' + owed.length + '章あります。AIで処理しますか?\n' +
              '推定コスト: 約$' + usd.toFixed(2) + ' (' + model + ')');
          } catch (_) { ok = false; }
          if (ok) delete _declined[titleId];
          else _declined[titleId] = true;  // re-offered only via Update / next open
        }
      }
      if (ok) for (const c of owed) toQueue.push(c.idx);
    }

    if (toQueue.length) {
      await mutateMap(titleId, (m) => {
        let hit = false;
        for (const i of toQueue) {
          const c = chunkOf(m, i);
          if (!c || c.state === 'ready' || c.state === 'processing' || c.state === 'queued') continue;
          c.state = 'queued';
          if (manual) { c.attempts = 0; c.error = null; delete _retryAt[rk(titleId, i)]; }
          hit = true;
        }
        return hit;
      });
    }
    return { queued: toQueue.length };
  }

  // Chunk completed: queue it when its predecessors are done or already on the
  // queue. A jump-ahead leaves unready predecessors at `none` — those only go
  // through the catch-up confirm (title open / Update), never silent billing.
  async function onChunkCompleted(titleId, idx) {
    if (!titleId || !Number.isFinite(idx)) return;
    if (!isActivated(titleId)) return;       // only activated books auto-process new chapters
    if (!autoOn() || !(await aiReady())) return;
    const map = await readMap(titleId);
    if (!map) return;
    const c = chunkOf(map, idx);
    if (!c || c.state === 'ready' || c.state === 'queued' || c.state === 'processing') return;
    if (c.state === 'failed' && (c.attempts | 0) >= MAX_ATTEMPTS) return;   // manual only

    const pendingPreds = [];
    for (const p of map.chunks) {
      if (!p || p.idx >= idx) break;
      if (p.state === 'ready' || p.state === 'processing') continue;
      if (p.state === 'queued') { pendingPreds.push(p); continue; }
      return;   // a none/failed predecessor blocks — catch-up handles it
    }
    if (pendingPreds.length) {
      // burst guard: this chunk + queued-but-unprocessed predecessors must
      // stay under the confirm threshold to auto-queue mid-session
      const usd = estimateChunks(chapterModel(), pendingPreds.concat([c]));
      if (usd > CONFIRM_USD) return;
    }
    await mutateMap(titleId, (m) => {
      const cc = chunkOf(m, idx);
      if (!cc || cc.state === 'ready' || cc.state === 'processing' || cc.state === 'queued') return false;
      cc.state = 'queued';
      return true;
    });
    pump(titleId);
  }

  // ---- the pump (single-flight, sequential by idx) ----------------------------------
  // UI-contention gate: the chapter call's JSON.parse + blobStore/IndexedDB
  // writes visibly jank scrolling and dict lookups (which share IndexedDB).
  // Defer while the user is actively reading AI output (#aiSummaryOverlay /
  // #kchapterView) or has the dict popup open; the 15s tick re-pumps once
  // they close. Deliberately NOT deferred: #bookmarksOverlay (Dynamic
  // Timeline) and #kcharsScreen — the user watches progress there.
  function uiBusy() {
    try {
      if (document.getElementById('aiSummaryOverlay')) return true;
      if (document.getElementById('kchapterView')) return true;
      const dp = document.getElementById('dictPopup');
      if (dp && dp.style.display === 'block') return true;
    } catch (_) {}
    return false;
  }
  const PACE_MS = 2500;     // idle between chapters — UI thread + IndexedDB breathing room

  // Processing-status broadcast for spinners (shell menu rows, timeline
  // footer, characters header). Latest detail mirrored on window._kaiProcStatus.
  function emitProcStatus(titleId, busy, idx, map) {
    try {
      let done = 0, total = 0;
      if (map && Array.isArray(map.chunks)) {
        total = map.chunks.length;
        for (const c of map.chunks) if (c && c.state === 'ready') done++;
      }
      const detail = {
        titleId: titleId || null,
        busy: !!busy,
        idx: Number.isFinite(idx) ? idx : null,
        done, total,
      };
      window._kaiProcStatus = detail;
      window.dispatchEvent(new CustomEvent('kai:proc-status', { detail }));
    } catch (_) {}
  }

  // The first non-ready chunk is the only candidate (never process K until all
  // <K are ready); it runs when queued, or failed(<3) past its backoff.
  function nextRunnable(map, titleId) {
    for (const c of map.chunks) {
      if (!c) continue;
      if (c.state === 'ready') continue;
      if (c.state === 'queued') {
        if (c.idx !== 0 && !isComplete(map, c.idx)) return null;   // spoiler guard
        return c;
      }
      if (c.state === 'failed' && (c.attempts | 0) < MAX_ATTEMPTS) {
        if (Date.now() >= (_retryAt[rk(titleId, c.idx)] || 0)) return c;
      }
      return null;
    }
    return null;
  }

  // User-targeted chapters (processChapter) run OUT of order — bypassing the
  // strict in-order block above — but KEEP the spoiler / attempts / backoff
  // guards. Returns the lowest-idx runnable forced chunk, or null. Ready /
  // perma-failed forced entries self-prune so the set can't grow unbounded.
  function nextForced(map, titleId) {
    if (!_forced.size) return null;
    let best = null;
    for (const c of map.chunks) {
      if (!c) continue;
      const k = rk(titleId, c.idx);
      if (!_forced.has(k)) continue;
      if (c.state === 'ready') { _forced.delete(k); continue; }
      if (!isComplete(map, c.idx) && (c.idx !== 0 || map.chunks.length === 1)) continue;   // spoiler guard kept
      if (c.state === 'queued') { if (!best || c.idx < best.idx) best = c; continue; }
      if (c.state === 'failed') {
        if ((c.attempts | 0) >= MAX_ATTEMPTS) { _forced.delete(k); continue; }
        if (Date.now() >= (_retryAt[k] || 0) && (!best || c.idx < best.idx)) best = c;
      }
    }
    return best;
  }

  async function pump(titleId) {
    if (_inflight) return;
    _inflight = true;
    let lastId = titleId || window._activeTitleId || null;
    let lastMap = null;
    try {
      for (;;) {
        if (window._kaiAiPaused) break;       // perf-probe kill switch
        if (document.hidden || uiBusy()) break;   // the 15s tick re-pumps
        if (!(await aiReady())) break;
        const id = titleId || window._activeTitleId;
        if (!id) break;
        lastId = id;
        const map = await readMap(id);
        if (!map) break;
        lastMap = map;
        const cand = nextForced(map, id) || nextRunnable(map, id);
        if (!cand) break;
        const idx = cand.idx;
        _cur = { titleId: id, idx };
        await mutateMap(id, (m) => {
          const c = chunkOf(m, idx);
          if (!c) return false;
          c.state = 'processing'; c.error = null;
          return true;
        });
        emitProcStatus(id, true, idx, map);
        let ok = false;
        try {
          await processChunk(id, idx);
          ok = true;
        } catch (e) {
          await mutateMap(id, (m) => {
            const c = chunkOf(m, idx);
            if (!c) return false;
            c.attempts = (c.attempts | 0) + 1;
            c.state = 'failed';
            c.error = String((e && e.message) || e || 'error').slice(0, 300);
            _retryAt[rk(id, idx)] =
              Date.now() + RETRY_BASE_MS * Math.pow(2, Math.max(0, c.attempts - 1));
            return true;
          });
          try { console.log('[ai-proc] chunk ' + idx + ' failed: ' + (e && e.message)); } catch (_) {}
        }
        _cur = null;
        lastMap = (await readMap(id)) || lastMap;
        emitProcStatus(id, true, null, lastMap);
        if (!ok) break;        // backoff via the 15s tick, no hot-loop
        await new Promise((r) => setTimeout(r, PACE_MS));
      }
    } catch (_) {} finally {
      _inflight = false; _cur = null;
      emitProcStatus(lastId, false, null, lastMap);
    }
  }

  // ---- per-chunk call + post-processing (§6) -----------------------------------------
  function s(v, cap) { return (typeof v === 'string') ? (cap ? v.slice(0, cap) : v) : ''; }
  function sanitizeEvents(a) {
    const out = [];
    if (Array.isArray(a)) {
      for (const e of a) {
        if (!e || !e.title) continue;
        out.push({ title: s(e.title, 80), description: s(e.description, 400) });
        if (out.length >= 12) break;
      }
    }
    return out;
  }
  function sanitizePresence(a) {
    const out = [];
    if (Array.isArray(a)) {
      for (const p of a) {
        if (!p || typeof p.id !== 'string' || !p.id) continue;
        let imp = Math.round(Number(p.importance));
        if (!Number.isFinite(imp)) imp = 1;
        out.push({ id: p.id, importance: Math.max(0, Math.min(3, imp)), reveal: !!p.reveal });
      }
    }
    return out;
  }
  function sanitizeUnresolved(a) {
    if (!Array.isArray(a)) return [];
    return a.filter(x => typeof x === 'string' && x.trim())
      .map(x => x.trim().slice(0, 200)).slice(0, 15);
  }
  // Order scenes chronologically (earliest first, latest last) by where each one's
  // anchorQuote falls in the chapter text. MUST run BEFORE sanitizeScenes assigns the
  // contiguous slot ids (scene_<idx>_<slot>) so a scene's picture stays bound to it.
  // Stable: ties and quotes not found verbatim keep their original relative order
  // (sorted to the end) rather than scrambling.
  function sortScenesByAnchor(a, text) {
    if (!Array.isArray(a) || a.length < 2 || !text) return a;
    try {
      const flat = String(text).replace(/\s+/g, '');
      const posOf = (sc) => {
        const q = (sc && typeof sc.anchorQuote === 'string') ? sc.anchorQuote.replace(/\s+/g, '') : '';
        if (!q) return Number.MAX_SAFE_INTEGER;
        const i = flat.indexOf(q);
        return i >= 0 ? i : Number.MAX_SAFE_INTEGER;
      };
      return a.map((sc, i) => ({ sc, i, p: posOf(sc) }))
              .sort((x, y) => (x.p - y.p) || (x.i - y.i))
              .map((e) => e.sc);
    } catch (_) { return a; }
  }

  // Non-stripped char offset of a quote within the chapter text (the SAME space
  // cueRangeForQuote matches in). MONOTONIC: prefers the first occurrence at/after
  // `fromOff` — because scenes are chronological, a phrase that repeats in the
  // chapter resolves to ITS in-order occurrence instead of always the first one.
  // That (not a static first-occurrence offset) is what fixes "scene audio bounds
  // far off though the subtitles are accurate" — the anchor was matching an earlier
  // identical/similar passage, so it mapped to the wrong (but correctly-timed) cue.
  function quoteOffsetIn(text, quote, fromOff) {
    try {
      const q = String(quote || '');
      if (!text || !q) return undefined;
      const start = (Number.isFinite(fromOff) && fromOff > 0) ? fromOff : 0;
      let off = text.indexOf(q, start);                 // exact, at/after the previous scene
      if (off < 0 && start > 0) off = text.indexOf(q);  // else exact anywhere
      if (off >= 0) return off;
      // paraphrase fallback: whitespace-insensitive (recover the real offset)
      const qS = q.replace(/\s+/g, '');
      if (!qS) return undefined;
      const idxMap = []; let flat = '';
      for (let k = 0; k < text.length; k++) { if (!/\s/.test(text[k])) { flat += text[k]; idxMap.push(k); } }
      const j = flat.indexOf(qS);
      return j >= 0 ? idxMap[j] : undefined;
    } catch (_) { return undefined; }
  }

  function sanitizeScenes(a, max, text, requireAudio) {
    const cap = Math.max(1, Math.min(12, max || 12));   // char-based count drives this; cap guards runaway
    const out = [];
    let prevOff = 0;   // monotonic cursor: each scene's anchor is resolved at/after the previous
    if (Array.isArray(a)) {
      for (let i = 0; i < a.length; i++) {
        const sc = a[i];
        if (!sc || typeof sc.prompt !== 'string' || !sc.prompt.trim()) continue;
        const aq = s(sc.anchorQuote, 120);
        const off = quoteOffsetIn(text, aq, prevOff);
        // REQUIRE audio (audiobook+SRT titles): a scene whose verbatim anchor can't
        // be located in the chapter text can't be tied to a cue, so it would have
        // wrong/no audio — drop it rather than ship a broken scene. Text-only titles
        // (no cues) keep all scenes (no audio is expected there).
        if (requireAudio && !Number.isFinite(off)) continue;
        if (Number.isFinite(off)) prevOff = off + 1;
        out.push({
          id: 's' + out.length,                         // contiguous id = output slot (matches scene_<idx>_<slot>)
          title: s(sc.title, 40),
          prompt: s(sc.prompt, 1200).trim(),
          style: (SCENE_STYLES.indexOf(sc.style) >= 0) ? sc.style : 'photoreal',
          caption: s(sc.caption, 300),
          anchorQuote: aq,
          ...(Number.isFinite(off) ? { anchorOff: off } : {}),   // monotonic offset → read-time picks the right cue window
        });
        if (out.length >= cap) break;
      }
    }
    return out;
  }

  async function readArtifact(titleId) {
    try {
      const raw = window.blobStore ? await window.blobStore.get(CHAP_PREFIX + titleId) : null;
      const p = raw ? JSON.parse(raw) : null;
      return (p && typeof p === 'object' && !Array.isArray(p)) ? p : {};
    } catch (_) { return {}; }
  }
  // Persist a user edit to one scene's image-generation prompt (read-modify-write the
  // artifact). slot = the scene's array position (matches scene_<idx>_<slot>). The
  // edited prompt then drives this scene's future regenerations.
  async function setScenePrompt(titleId, idx, slot, prompt) {
    try {
      const p = String(prompt == null ? '' : prompt).trim();
      if (!titleId || !Number.isFinite(idx) || !Number.isFinite(slot) || !p) return false;
      const art = await readArtifact(titleId);
      const a = art[idx];
      if (!a || !Array.isArray(a.scenes) || !a.scenes[slot]) return false;
      a.scenes[slot].prompt = p;
      await window.blobStore.set(CHAP_PREFIX + titleId, JSON.stringify(art));
      emitChanged(titleId, 'timeline');
      return true;
    } catch (_) { return false; }
  }
  // Synopsis is client-side + deterministic (§6): shortSummaries of every
  // processed chunk in idx order, tail-capped. Entries from a different
  // boundary generation (fp mismatch) are excluded from the model context.
  function buildSynopsis(art, fp) {
    try {
      const idxs = Object.keys(art).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
      let syn = '';
      for (const i of idxs) {
        const e = art[i];
        if (!e || !e.shortSummary) continue;
        if (e.fp && fp && e.fp !== fp) continue;
        syn += (syn ? '\n' : '') + e.shortSummary;
      }
      if (syn.length > SYNOPSIS_CAP) syn = syn.slice(syn.length - SYNOPSIS_CAP);
      return syn;
    } catch (_) { return ''; }
  }

  // First cue overlapping [rawStart,rawEnd) in CUE_ALIGN ranges (matched cue
  // ranges are forward-ordered, unmatched are -1).
  function cueForRange(align, rawStart, rawEnd, lo, hi) {
    try {
      const n = align.cueCount | 0;
      const a = (Number.isFinite(lo) && lo >= 0) ? lo : 0;
      const b = (Number.isFinite(hi) && hi >= 0 && hi < n) ? hi : n - 1;
      for (let i = a; i <= b; i++) {
        const s0 = align.ranges[2 * i], e0 = align.ranges[2 * i + 1];
        if (s0 < 0 || e0 < 0) continue;
        if (e0 <= rawStart) continue;
        if (s0 >= rawEnd) return -1;
        return i;
      }
    } catch (_) {}
    return -1;
  }
  // SRT-only titles: the chunk lives in cue space — find the quote's cue by a
  // whitespace-stripped scan across the chunk's cue range.
  function cueFromCueSpace(cues, chunk, quote) {
    try {
      const a = Math.max(0, chunk.cueStart | 0);
      const b = Math.min(cues.length - 1, (chunk.cueEnd >= 0 ? chunk.cueEnd : cues.length - 1));
      const q = quote.replace(/\s+/g, '');
      if (!q || b < a) return -1;
      let st = '';
      const im = [];
      for (let i = a; i <= b; i++) {
        const t = (cues[i] && cues[i].text) ? cues[i].text : '';
        for (const ch of t) { if (/\s/.test(ch)) continue; st += ch; im.push(i); }
      }
      const j = st.indexOf(q);
      return j >= 0 ? im[j] : -1;
    } catch (_) { return -1; }
  }

  // Quote → offsets (exact indexOf, then whitespace-stripped fallback mapped
  // back to real offsets) → cue/ms anchors when this title's SRT is live.
  async function locatePassages(titleId, map, chunk, rawText, list) {
    const out = [];
    if (!Array.isArray(list)) return out;
    const cueSpace = map.source === 'cues';
    const cues = (window._activeTitleId === titleId && Array.isArray(window._srtCues) && window._srtCues.length)
      ? window._srtCues : null;
    let align = null;
    if (!cueSpace && cues && window.cueAlignment &&
        typeof window.cueAlignment.loadAlignment === 'function') {
      try { align = await window.cueAlignment.loadAlignment(titleId); } catch (_) {}
      if (align && (align.cueCount | 0) !== cues.length) align = null;
    }
    let stripped = '', smap = null;
    const ensureStripped = () => {
      if (smap) return;
      smap = [];
      for (let k = 0; k < rawText.length; k++) {
        const ch = rawText[k];
        if (/\s/.test(ch)) continue;
        smap.push(k); stripped += ch;
      }
    };
    for (const kp of list) {
      if (!kp || typeof kp.quote !== 'string' || !kp.quote.trim()) continue;
      const quote = kp.quote.trim().slice(0, 200);
      const rec = { quote, why: s(kp.why, 300),
                    rawStart: null, rawEnd: null, cueIdx: null, startMs: null, endMs: null };
      let local = null;
      const i = rawText.indexOf(quote);
      if (i >= 0) local = { start: i, end: i + quote.length };
      else {
        ensureStripped();
        const q = quote.replace(/\s+/g, '');
        if (q) {
          const j = stripped.indexOf(q);
          if (j >= 0) local = { start: smap[j], end: smap[j + q.length - 1] + 1 };
        }
      }
      if (local) {
        if (cueSpace) {
          const ci = cues ? cueFromCueSpace(cues, chunk, quote) : -1;
          if (ci >= 0) {
            rec.cueIdx = ci; rec.startMs = cues[ci].startMs; rec.endMs = cues[ci].endMs;
          }
        } else {
          rec.rawStart = (chunk.rawStart | 0) + local.start;
          rec.rawEnd = (chunk.rawStart | 0) + local.end;
          if (align) {
            const ci = cueForRange(align, rec.rawStart, rec.rawEnd, chunk.cueStart, chunk.cueEnd);
            if (ci >= 0) {
              rec.cueIdx = ci;
              if (cues && ci < cues.length) {
                rec.startMs = cues[ci].startMs; rec.endMs = cues[ci].endMs;
              }
            }
          }
        }
      }
      out.push(rec);
      if (out.length >= 8) break;
    }
    return out;
  }

  async function processChunk(titleId, idx) {
    const map = await readMap(titleId);
    if (!map) throw new Error('no chunk map');
    const chunk = chunkOf(map, idx);
    if (!chunk) throw new Error('no chunk ' + idx);

    // Billing backstop: a matching artifact already exists (state was lost,
    // not the work) — adopt it instead of paying for the chapter again. Gate on
    // shortSummary (the canonical "has a summary" field used by the timeline +
    // buildSynopsis): a longSummary-only / summary-less artifact must NOT be
    // adopted, or the chapter goes 'ready' while the card still shows "tap to
    // generate" — so the AUTO path now regenerates it instead of re-stranding it.
    try {
      const prior = await readArtifact(titleId);
      const pa = prior && prior[idx];
      if (pa && pa.shortSummary &&
          (!pa.fp || !map.fingerprint || pa.fp === map.fingerprint)) {
        await mutateMap(titleId, (m) => {
          const c = chunkOf(m, idx);
          if (c) {
            c.state = 'ready'; c.error = null; c.processedTs = pa.ts || Date.now();
            if (!c.label && pa.label) c.label = pa.label;
          }
          m.synopsis = buildSynopsis(prior, m.fingerprint);
          return true;
        });
        delete _retryAt[rk(titleId, idx)];
        emitChanged(titleId, 'timeline');
        return;
      }
    } catch (_) {}

    let text = '';
    try {
      if (window.aiChunks && typeof window.aiChunks.chunkText === 'function') {
        text = (await window.aiChunks.chunkText(titleId, idx)) || '';
      }
    } catch (_) {}
    if (!text || text.length < 50) throw new Error('chunk text unavailable');

    let sendText = text, capNote = '';
    if (sendText.length > INPUT_CAP) {
      sendText = sendText.slice(sendText.length - INPUT_CAP);
      capNote = '(注: この章は非常に長いため、末尾の' +
        INPUT_CAP.toLocaleString() + '字のみを掲載)\n';
    }

    let compact = '';
    try {
      if (window.aiCharacters && typeof window.aiCharacters.compactForPrompt === 'function') {
        compact = (await window.aiCharacters.compactForPrompt(titleId)) || '';
      }
    } catch (_) {}

    // Author-given ruby for kanji that appear in THIS chunk. The body has ruby
    // stripped, so without this the model can't know unusual name readings
    // (藻奈美→もなみ) and falls back to writing "なし". Scoped to the chunk to
    // stay small.
    let rubyNote = '';
    try {
      if (window.aiChunks && typeof window.aiChunks.rubyGlossary === 'function') {
        const gloss = await window.aiChunks.rubyGlossary(titleId);
        if (gloss) {
          const lines = [];
          for (const base of Object.keys(gloss)) {
            if (sendText.indexOf(base) !== -1) {
              lines.push(base + '=' + gloss[base]);
              if (lines.length >= 300) break;
            }
          }
          if (lines.length) {
            rubyNote = '\n\n本文中のルビ(漢字=読み、原作者が振った正式な読み):\n' + lines.join('、');
          }
        }
      }
    } catch (_) {}
    const synopsis = (typeof map.synopsis === 'string') ? map.synopsis : '';
    const unresolvedIn = Array.isArray(map.unresolved) ? map.unresolved : [];

    // Stable context order for prompt caching (§6): synopsis → character DB →
    // unresolved → chunk text → instruction.
    const wantScenes = sceneIdeasOn();
    const sceneTargetN = wantScenes ? sceneCountFor(text) : 0;   // ~1 scene per AISCENE_CHARS_PER chars
    // Scene illustration needs the FULL appearances of the people present (the compact
    // DB only has 1-line descriptions) + the book's unified art style so every scene
    // renders consistent people in a consistent look.
    const styleDir = wantScenes ? await getStyleDirective(titleId) : '';
    const sceneCtx = wantScenes ? ((styleDir ? ('\n\n［この作品の画風（全挿絵で統一）］\n' + styleDir) : '') + await sceneCharContext(titleId, idx, text)) : '';
    const user =
      'これまでのあらすじ:\n' + (synopsis || '(まだ無し — 物語の冒頭)') +
      '\n\n登場人物データベース(JSON):\n' + (compact || '(まだ無し)') + sceneCtx +
      '\n\n未解決の伏線・進行中の話題:\n' +
      (unresolvedIn.length ? unresolvedIn.map(u => '- ' + u).join('\n') : '(まだ無し)') +
      '\n\n今回読み終えた章の本文:\n' + capNote + sendText + rubyNote +
      '\n\n上記の「今回読み終えた章の本文」のみを対象に、厳守事項に従ってJSONを出力してください。';

    let r = await window.ai.request({
      feature: 'chapter',
      titleId,
      model: chapterModel(),
      // Prompt caching: SYSTEM_PROMPT is byte-identical on every chapter, so mark it
      // ephemeral — chapters processed within Anthropic's ~5-min cache window read it
      // back at ~10% input cost instead of re-billing the full system prompt each time.
      // sceneRules carries the per-chapter scene count (varies), so it stays a separate,
      // uncached block AFTER the cached one.
      system: wantScenes
        ? [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
           { type: 'text', text: sceneRules(sceneTargetN) }]
        : [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      maxTokens: MAX_TOKENS,
      retryable: true,
      outputSchema: wantScenes ? withScenes(CHAPTER_SCHEMA) : CHAPTER_SCHEMA,
      messages: [{ role: 'user', content: user }],
    });
    let parsed;
    try { parsed = JSON.parse(r.text); }
    catch (pe) {
      // The scenes array can push the JSON past the output cap → truncated + unparseable.
      // Scenes must NEVER fail the CORE chapter: retry once WITHOUT scenes so summary +
      // characters always land (the user can add scene ideas later via「シーンをAIで考える」).
      if (!wantScenes) throw pe;
      r = await window.ai.request({
        feature: 'chapter', titleId, model: chapterModel(), system: SYSTEM_PROMPT,
        maxTokens: MAX_TOKENS, retryable: true, outputSchema: CHAPTER_SCHEMA,
        messages: [{ role: 'user', content: user }],
      });
      parsed = JSON.parse(r.text);
    }
    if (!parsed || typeof parsed !== 'object') throw new Error('unparseable chapter output');
    if (wantScenes) { try { await setStyleDirectiveIfEmpty(titleId, parsed.styleDirective); } catch (_) {} }   // seed the book's art style once

    const label = s(parsed.label, 24).trim();
    const shortSummary = s(parsed.shortSummary, 400);
    const longSummary = s(parsed.longSummary, 1600);
    const events = sanitizeEvents(parsed.events);
    const unresolvedOut = sanitizeUnresolved(parsed.unresolved);
    const ch = (parsed.characters && typeof parsed.characters === 'object') ? parsed.characters : {};
    const presence = sanitizePresence(ch.presence);
    const charactersPayload = {
      'new': Array.isArray(ch['new']) ? ch['new'] : [],
      updates: Array.isArray(ch.updates) ? ch.updates : [],
      presence,
    };
    const keyPassages = await locatePassages(titleId, map, chunk, text, parsed.keyPassages);
    const relatedCharIds = presence.filter(p => (p.importance | 0) >= 2).map(p => p.id);

    // 1) artifact (object keyed by idx — read-modify-write, we are sole writer).
    // fp stamps the boundary generation: a later map rebuild must not render
    // old-boundary summaries on new chapters.
    const sceneList = sanitizeScenes(sortScenesByAnchor(parsed.scenes, text), sceneTargetN, text, (map && map.space === 'cue'));   // chronological; require a locatable anchor on audiobook+SRT titles
    const art = await readArtifact(titleId);
    art[idx] = {
      label, shortSummary, longSummary, events, keyPassages, relatedCharIds,
      scenes: sceneList,
      model: r.model, costUsd: r.costUsd, ts: Date.now(), fp: map.fingerprint || null,
    };
    try { await window.blobStore.set(CHAP_PREFIX + titleId, JSON.stringify(art)); } catch (_) {}

    // 2) character merge (delegated; a local merge bug must not burn paid
    // retries — but the gap must be visible for a future repair pass)
    let merged = false;
    try {
      if (window.aiCharacters && typeof window.aiCharacters.applyChapterOutput === 'function') {
        merged = (await window.aiCharacters.applyChapterOutput(titleId, idx, charactersPayload)) !== false;
      }
    } catch (e) {
      try { console.log('[ai-proc] character merge failed: ' + (e && e.message)); } catch (_) {}
    }
    if (!merged) {
      try {
        art[idx].charMergeFailed = true;
        await window.blobStore.set(CHAP_PREFIX + titleId, JSON.stringify(art));
      } catch (_) {}
    }

    // 3) synopsis + unresolved + ready (fresh read-modify-write)
    const syn = buildSynopsis(art, map.fingerprint);
    await mutateMap(titleId, (m) => {
      const c = chunkOf(m, idx);
      if (c) {
        c.state = 'ready'; c.error = null; c.processedTs = Date.now();
        if (!c.label && label) c.label = label;
      }
      m.synopsis = syn;
      m.unresolved = unresolvedOut;
      return true;
    });
    delete _retryAt[rk(titleId, idx)];
    emitChanged(titleId, 'timeline');
    emitChanged(titleId, 'characters');

    // Auto-backfill scenes: scene-ideas is ON but this chapter landed with NONE —
    // the combined summary+scenes call overflowed the output cap and was retried
    // WITHOUT scenes (so the summary always lands), or the model returned none.
    // Run the separate, overflow-safe scenes-only pass so scenes appear without the
    // user tapping ＋シーンを作る. AWAITED (not fire-and-forget) so a multi-chapter
    // catch-up stays sequential and doesn't burst the API into a rate-limit; the
    // chapter is already 'ready', so a failure here leaves the summary intact.
    if (wantScenes && sceneList.length === 0) {
      try { await generateSceneIdeas(titleId, idx); } catch (_) {}   // generateSceneIdeas auto-queues the images itself (if the pref is on)
    } else if (sceneList.length > 0) {
      try { await _autoQueueSceneImages(titleId, idx, sceneList); } catch (_) {}   // pref-gated; renders the scene pictures, paced ~20s
    }
  }

  // Auto-generate scene PICTURES when scene ideas are created (Preferences →
  // AISCENE_AUTO_IMG, default off — it costs). Cloud: render each authored scene by
  // its prompt, skipping slots that already have an image (no re-spend on re-process);
  // syncCloud paces them ~20s so the API isn't overloaded. Local: one chapter scene
  // job (the server picks scenes). Fire-and-forget kick of sync at the end.
  function autoSceneImagesOn() { try { return localStorage.getItem('AISCENE_AUTO_IMG') === '1'; } catch (_) { return false; } }
  async function _autoQueueSceneImages(titleId, idx, scenes) {
    try {
      if (!autoSceneImagesOn() || !window.aiImages || !Array.isArray(scenes) || !scenes.length) return;
      const be = (window.aiImages.backend && window.aiImages.backend()) || 'local';
      if (be === 'local') {
        if (window.aiImages.queueScene) await window.aiImages.queueScene(titleId, idx, { multi: true, scenes: scenes.length, label: '第' + ((idx | 0) + 1) + '章', auto: true });
      } else if (window.aiImages.queueSceneFromPrompt) {
        for (let s = 0; s < scenes.length; s++) {
          const sc = scenes[s];
          if (!sc || !sc.prompt) continue;
          let have = [];
          try { if (window.aiImages.getImages) have = await window.aiImages.getImages(titleId, 'scene_' + idx + '_' + s); } catch (_) {}
          if (have && have.length) continue;   // already rendered → don't re-spend
          try { await window.aiImages.queueSceneFromPrompt(titleId, idx, s, { prompt: sc.prompt, caption: sc.caption || '', style: sc.style || '', label: '第' + ((idx | 0) + 1) + '章' }); } catch (_) {}
        }
      }
      try { if (window.aiImages.sync) window.aiImages.sync(titleId); } catch (_) {}   // kick the paced drain
    } catch (_) {}
  }

  // ---- per-book activation -------------------------------------------------------------
  // Called from the activation prompt. mode 'new' = first chapter only (then new
  // chapters as they're finished); mode 'retro' = process everything up to the
  // current reading position now. Sets the activation flag, then kicks processing.
  async function activate(titleId, mode) {
    try {
      const id = titleId || window._activeTitleId;
      if (!id || !(await aiReady())) return null;
      if (window.ai && window.ai.setActivated) await window.ai.setActivated(id, mode);
      _openedFor = id;
      delete _declined[id];
      try { if (window.aiChunks && window.aiChunks.ensure) await window.aiChunks.ensure(id); } catch (_) {}
      try { if (window.aiChunks && window.aiChunks._retrySegmentation) await window.aiChunks._retrySegmentation(id); } catch (_) {}
      if (!(await readMap(id))) return null;       // not buildable yet — the tick retries
      if (mode === 'retro') {
        await runCatchUp(id, { manual: true, confirmAllowed: true });
      } else {
        // 'new': chunk 0 only (first-chapter carve-out; single-chunk needs completion)
        await mutateMap(id, (m) => {
          const c0 = chunkOf(m, 0);
          if (!c0 || c0.state === 'ready' || c0.state === 'processing' || c0.state === 'queued') return false;
          if (m.chunks.length > 1 || isComplete(m, 0)) { c0.state = 'queued'; c0.attempts = 0; c0.error = null; return true; }
          return false;
        });
      }
      pump(id);
      return true;
    } catch (_) { return null; }
  }

  // Opt-in: re-segment the book at its OWN chapter markers (standalone numbers
  // / 第N章 the loader detected), replacing the rule/Haiku pseudo-chunks with
  // the real chapters, then re-summarize up to the current position. Destructive
  // (old summaries + character DB are cleared) and paid (re-processes chapters).
  async function reDetectChapters(titleId) {
    try {
      const id = titleId || window._activeTitleId;
      if (!id || !(await aiReady())) return null;
      if (!window.aiChunks || typeof window.aiChunks.reSegment !== 'function') return null;
      const n = (typeof window.aiChunks.markerCount === 'function') ? window.aiChunks.markerCount(id) : 0;
      if (n < 3) {
        try { if (typeof window.showToast === 'function') window.showToast('No chapter numbers detected in this book', 2800); } catch (_) {}
        return null;
      }
      let ok = false;
      try {
        ok = window.confirm(
          '本の章番号から章を再検出します(約' + n + '章)。\n' +
          '現在の章のまとめと登場人物データはすべて作り直されます。\n' +
          '読み終えた範囲を再処理しますか?(コストは次に表示されます)');
      } catch (_) { ok = false; }
      if (!ok) return null;
      const map = await window.aiChunks.reSegment(id);
      if (!map) {
        try { if (typeof window.showToast === 'function') window.showToast('Could not re-detect chapters', 2800); } catch (_) {}
        return null;
      }
      // boundaries changed → old artifacts + character DB are stale; clear them
      try { if (window.blobStore) await window.blobStore.set(CHAP_PREFIX + id, JSON.stringify({})); } catch (_) {}
      try { if (window.aiCharacters && window.aiCharacters.reset) await window.aiCharacters.reset(id); } catch (_) {}
      if (window.ai && window.ai.setActivated) await window.ai.setActivated(id, 'retro');
      _openedFor = id;
      delete _declined[id];
      emitChanged(id, 'timeline');
      emitChanged(id, 'characters');
      await runCatchUp(id, { manual: true, confirmAllowed: true });
      pump(id);
      try { if (typeof window.showToast === 'function') window.showToast(map.chunks.length + '章を再検出 — 処理中', 2800); } catch (_) {}
      return { chapters: map.chunks.length };
    } catch (_) { return null; }
  }

  // Reset ALL AI data for one title: chapter summaries, character DB, chunk
  // map, flat text, session summaries, deep dives — and deactivate it (back to
  // the activation prompt). The spend ledger/cost is left intact (money was
  // actually spent). After this, reopening Timeline/Characters re-prompts.
  async function resetTitle(titleId) {
    try {
      const id = titleId || window._activeTitleId;
      if (!id) return null;
      let ok = false;
      try {
        ok = window.confirm(
          'このタイトルのAIデータ(章のまとめ・登場人物・要約)をすべて削除します。\n' +
          'よろしいですか?(API利用料の記録は残ります)');
      } catch (_) { ok = false; }
      if (!ok) return null;
      try { if (window.blobStore && window.blobStore.remove) {
        await window.blobStore.remove(CHAP_PREFIX + id);
        await window.blobStore.remove('AISUM_V1_' + id);
        await window.blobStore.remove('AIDEEP_V1_' + id);
      } } catch (_) {}
      try { if (window.aiCharacters && window.aiCharacters.reset) await window.aiCharacters.reset(id); } catch (_) {}
      try { if (window.aiChunks && window.aiChunks.clearTitle) await window.aiChunks.clearTitle(id); } catch (_) {}
      try { if (window.ai && window.ai.deactivate) await window.ai.deactivate(id); } catch (_) {}
      _openedFor = null;
      delete _declined[id];
      // refresh open surfaces WITHOUT bumping the unseen revs (no phantom badge)
      try { window.dispatchEvent(new CustomEvent('kai:ai-data', { detail: { titleId: id, kind: 'timeline' } })); } catch (_) {}
      try { window.dispatchEvent(new CustomEvent('kai:ai-data', { detail: { titleId: id, kind: 'characters' } })); } catch (_) {}
      try { if (typeof window.showToast === 'function') window.showToast('このタイトルのAIデータをリセットしました', 2800); } catch (_) {}
      return true;
    } catch (_) { return null; }
  }

  // Ensure the active title is activated before opening Timeline/Characters.
  // Resolves 'activated' (already or just chose to) or 'proceed' (AI off, or
  // "Not now" — caller opens the surface AI-free). Shows the choice modal.
  async function ensureActivated(titleId) {
    try {
      const id = titleId || window._activeTitleId;
      if (!id) return 'proceed';
      if (!(await aiReady())) return 'proceed';
      if (isActivated(id)) return 'activated';
      const choice = await showActivateModal(id);
      if (!choice) return 'proceed';
      activate(id, choice);   // fire-and-forget; surface opens and fills in as it processes
      return 'activated';
    } catch (_) { return 'proceed'; }
  }

  function showActivateModal(titleId) {
    return new Promise((resolve) => {
      try {
        const prev = document.getElementById('kaiActivateModal');
        if (prev) prev.remove();
        let done = false;
        const finish = (v) => { if (done) return; done = true; try { ov.remove(); } catch (_) {} resolve(v); };

        const ov = document.createElement('div');
        ov.id = 'kaiActivateModal';
        ov.style.cssText =
          'position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.66);display:flex;' +
          'align-items:center;justify-content:center;box-sizing:border-box;' +
          'padding:calc(12px + env(safe-area-inset-top,0px)) 16px calc(12px + env(safe-area-inset-bottom,0px));';
        ov.addEventListener('click', (e) => { if (e.target === ov) finish(null); });

        const card = document.createElement('div');
        card.style.cssText =
          'background:#15151c;border:1px solid #2a2a3c;border-radius:16px;width:min(94vw,440px);' +
          'max-height:100%;overflow:auto;padding:20px;color:#e8e8e8;box-sizing:border-box;';

        const h = document.createElement('div');
        h.style.cssText = 'font-size:1.1rem;font-weight:700;color:#cbbfee;margin-bottom:6px;';
        h.textContent = '✦ Activate AI for this book';
        const p = document.createElement('div');
        p.style.cssText = 'font-size:.82rem;color:#aaa;line-height:1.55;margin-bottom:16px;';
        p.textContent = 'AI will build the timeline and character database for this book and ' +
          'keep them updated as you finish chapters. Choose where to begin:';
        card.appendChild(h);
        card.appendChild(p);

        const mkOpt = (title, desc, val, accent) => {
          const b = document.createElement('button');
          b.style.cssText =
            'display:block;width:100%;text-align:left;margin-bottom:10px;background:#1d1830;' +
            'border:1px solid ' + accent + ';border-radius:12px;padding:12px 14px;cursor:pointer;color:#e8e8e8;';
          b.innerHTML =
            '<div style="font-weight:700;font-size:.92rem;color:#e8e8e8;">' + title + '</div>' +
            '<div style="font-size:.76rem;color:#9a93b8;margin-top:3px;line-height:1.45;">' + desc + '</div>';
          b.addEventListener('click', (e) => { e.stopPropagation(); finish(val); });
          return b;
        };
        card.appendChild(mkOpt('Start fresh',
          'Analyze from the first chapter and onward as you read. Cheapest — recommended if you’re near the start.',
          'new', '#6f5fc0'));
        card.appendChild(mkOpt('Catch up to where I am',
          'Analyze every chapter up to your current position now, then keep up as you read. Costs more (you’ll see an estimate).',
          'retro', '#463a6b'));

        const cancel = document.createElement('button');
        cancel.textContent = 'Not now';
        cancel.style.cssText =
          'display:block;width:100%;margin-top:4px;background:transparent;border:none;color:#888;' +
          'font-size:.82rem;padding:8px;cursor:pointer;';
        cancel.addEventListener('click', (e) => { e.stopPropagation(); finish(null); });
        card.appendChild(cancel);

        ov.appendChild(card);
        document.body.appendChild(ov);
      } catch (_) { resolve(null); }
    });
  }

  // ---- public surface -----------------------------------------------------------------
  // Manual Update (timeline footer / tap a chapter to process): re-runs catch-up
  // incl. failed retries (attempts reset), always allowed to re-offer the cost
  // confirm. Tapping Update IS opting in, so it activates the book (retro) —
  // otherwise the user would pay but the book wouldn't glow / auto-process.
  async function updateNow(titleId) {
    try {
      const id = titleId || window._activeTitleId;
      if (!id) return null;
      if (!(await aiReady())) {
        try {
          if (typeof window.showToast === 'function') {
            window.showToast('Enable AI in Preferences → AI Features first', 3000);
          }
        } catch (_) {}
        return null;
      }
      try {
        if (window.ai && window.ai.setActivated && window.ai.activatedSync &&
            !window.ai.activatedSync(id)) {
          await window.ai.setActivated(id, 'retro');
        }
      } catch (_) {}
      delete _declined[id];
      try {
        if (window.aiChunks && typeof window.aiChunks.ensure === 'function') {
          await window.aiChunks.ensure(id);
        }
      } catch (_) {}
      // a failed first-open segmentation is only retryable while the map is
      // pristine — do it before any chunk gets queued/processed below
      try {
        if (window.aiChunks && typeof window.aiChunks._retrySegmentation === 'function') {
          await window.aiChunks._retrySegmentation(id);
        }
      } catch (_) {}
      if (!(await readMap(id))) return null;
      await mutateMap(id, (m) => {
        let hit = false;
        for (const c of m.chunks) {
          if (!c || c.state !== 'processing') continue;
          if (_inflight && _cur && _cur.titleId === id && _cur.idx === c.idx) continue;
          c.state = 'queued'; c.attempts = 0; c.error = null; hit = true;
        }
        return hit;
      });
      const r = await runCatchUp(id, { manual: true, confirmAllowed: true });
      pump(id);
      return { queued: r.queued };
    } catch (_) { return null; }
  }

  async function owedEstimate(titleId) {
    try {
      const id = titleId || window._activeTitleId;
      if (!id) return null;
      const map = await readMap(id);
      if (!map) return null;
      const model = chapterModel();
      const owed = owedChunks(map, { failedFinal: true, queued: true });
      return { chunks: owed.length, usd: estimateChunks(model, owed) };
    } catch (_) { return null; }
  }

  async function status(titleId) {
    try {
      const id = titleId || window._activeTitleId;
      if (!id) return null;
      const map = await readMap(id);
      if (!map) return { titleId: id, hasMap: false };
      const counts = { none: 0, queued: 0, processing: 0, ready: 0, failed: 0 };
      const chunks = map.chunks.filter(Boolean).map(c => {
        if (counts[c.state] !== undefined) counts[c.state]++;
        return { idx: c.idx, state: c.state, attempts: c.attempts | 0,
                 error: c.error || null, label: c.label || null,
                 processedTs: c.processedTs || null };
      });
      return {
        titleId: id, hasMap: true, total: map.chunks.length, counts, chunks,
        owed: owedChunks(map, { failedFinal: true, queued: true }).length,
        inflightIdx: (_cur && _cur.titleId === id) ? _cur.idx : null,
        auto: autoOn(), declined: !!_declined[id],
      };
    } catch (_) { return null; }
  }

  // ---- tick + wiring ---------------------------------------------------------------------
  async function _tick() {
    try {
      if (window._kaiAiPaused) return;        // perf-probe kill switch
      if (document.hidden) return;
      if (!(await aiReady())) return;
      const id = window._activeTitleId;
      if (!id) return;
      if (_openedFor !== id) { await titleOpenSweep(id); return; }   // late-build retry
      if (!_inflight) {
        // recover a 'processing' stranded by an error path that missed its RMW
        await mutateMap(id, (m) => {
          let hit = false;
          for (const c of m.chunks) {
            if (c && c.state === 'processing') { c.state = 'queued'; hit = true; }
          }
          return hit;
        });
      }
      pump(id);
    } catch (_) {}
  }

  try {
    setInterval(() => { _tick(); }, TICK_MS);
    window.addEventListener('shell:title-change', () => {
      try {
        _openedFor = null;
        const id = window._activeTitleId;
        if (id) titleOpenSweep(id).catch(() => {});
      } catch (_) {}
    });
    window.addEventListener('kai:chunk-completed', (e) => {
      try {
        const d = e && e.detail;
        if (d && d.titleId) onChunkCompleted(d.titleId, d.idx).catch(() => {});
      } catch (_) {}
    });
  } catch (_) {}

  // React to activation fired elsewhere (e.g. ai.setActivated): if not already
  // kicked by activate(), run the open-sweep so processing starts.
  try {
    window.addEventListener('kai:ai-activated', (e) => {
      try {
        const d = e && e.detail;
        if (d && d.titleId && d.mode && d.titleId === window._activeTitleId) {
          _openedFor = null;
        }
      } catch (_) {}
    });
  } catch (_) {}

  // On-demand scene ideas for one chapter (backfill for chapters summarized before
  // this feature, or to refresh). One scenes-only Claude call over that chapter's text.
  async function generateSceneIdeas(titleId, idx) {
    try {
      if (!(await aiReady())) return { ok: false, reason: 'ai-off' };
      const map = (window.aiChunks && window.aiChunks.getMap) ? await window.aiChunks.getMap(titleId) : null;
      if (!map) return { ok: false, reason: 'no-map' };
      let text = '';
      try { text = (await window.aiChunks.chunkText(titleId, idx)) || ''; } catch (_) {}
      if (!text.trim()) return { ok: false, reason: 'no-text' };
      const sendText = text.length > INPUT_CAP ? text.slice(-INPUT_CAP) : text;
      const sceneTargetN = sceneCountFor(text);   // ~1 scene per AISCENE_CHARS_PER chars
      // Same rich context as the summary-time path: book art style + character
      // appearances + synopsis, so backfilled scenes render consistently.
      const styleDir = await getStyleDirective(titleId);
      const sceneCtx = await sceneCharContext(titleId, idx, text);
      const synopsis = (typeof map.synopsis === 'string' && map.synopsis) ? ('これまでのあらすじ:\n' + map.synopsis + '\n\n') : '';
      const styleLine = styleDir ? ('［この作品の画風（全挿絵で統一）］\n' + styleDir + '\n\n') : '';
      const schema = { type: 'object', properties: { scenes: SCENE_SCHEMA_PROP, styleDirective: { type: 'string' } }, required: ['scenes'], additionalProperties: false };
      const r = await window.ai.request({
        feature: 'scenes', titleId, model: chapterModel(), system: sceneOnlySystem(sceneTargetN),
        maxTokens: Math.min(12000, 2000 + sceneTargetN * 700), retryable: true, outputSchema: schema,
        messages: [{ role: 'user', content: styleLine + synopsis + (sceneCtx ? (sceneCtx.trim() + '\n\n') : '') + '次の章の本文だけを使い、挿絵にする場面を' + sceneCountLabel(sceneTargetN) + '、scenes配列で出力してください。登場人物を描く場面では上の容姿に合わせ、全 prompt を上の画風で統一すること。本文:\n\n' + sendText }],
      });
      const parsed = JSON.parse(r.text);
      try { await setStyleDirectiveIfEmpty(titleId, parsed && parsed.styleDirective); } catch (_) {}
      const scenes = sanitizeScenes(sortScenesByAnchor(parsed && parsed.scenes, text), sceneTargetN, text, (map && map.space === 'cue'));   // chronological; require a locatable anchor on audiobook+SRT titles
      if (!scenes.length) return { ok: false, reason: 'none' };
      const art = await readArtifact(titleId);
      if (!art[idx] || typeof art[idx] !== 'object') art[idx] = { fp: (map.fingerprint || null), ts: Date.now() };
      art[idx].scenes = scenes;
      try { await window.blobStore.set(CHAP_PREFIX + titleId, JSON.stringify(art)); } catch (_) {}
      emitChanged(titleId, 'timeline');
      try { await _autoQueueSceneImages(titleId, idx, scenes); } catch (_) {}   // pref-gated auto scene pictures
      return { ok: true, count: scenes.length };
    } catch (e) { return { ok: false, reason: (e && e.message) || 'error' }; }
  }

  // Targeted single-chapter (re)generate. Unlike updateNow (global, strictly
  // in-order, cost-confirm gated), this runs ONE chapter even when an EARLIER
  // chunk is wedged (a front-matter chunk 0 that never completes, a 3×-failed
  // chunk, or one still in backoff) — that strict in-order block in nextRunnable
  // was why a stranded mid-book chapter could never be filled by tapping it.
  // The spoiler guard (isComplete) is KEPT so unread text is never summarized.
  // opts.force drops a blank/stale artifact first so processChunk's billing
  // backstop regenerates instead of re-adopting a summary-less one.
  async function processChapter(titleId, idx, opts) {
    opts = opts || {};
    try {
      const id = titleId || window._activeTitleId;
      if (!id || !Number.isFinite(idx)) return { ok: false, reason: 'no-title' };
      if (!(await aiReady())) {
        try { if (typeof window.showToast === 'function') window.showToast('Enable AI in Preferences → AI Features first', 3000); } catch (_) {}
        return { ok: false, reason: 'ai-off' };
      }
      // Tapping a chapter to generate IS opting in → activate (retro), like updateNow.
      try {
        if (window.ai && window.ai.setActivated && window.ai.activatedSync &&
            !window.ai.activatedSync(id)) {
          await window.ai.setActivated(id, 'retro');
        }
      } catch (_) {}
      delete _declined[id];
      try { if (window.aiChunks && typeof window.aiChunks.ensure === 'function') await window.aiChunks.ensure(id); } catch (_) {}
      const map = await readMap(id);
      if (!map) return { ok: false, reason: 'no-map' };
      const chunk = chunkOf(map, idx);
      if (!chunk) return { ok: false, reason: 'no-chunk' };
      // Spoiler guard: never summarize text the user hasn't reached yet. The
      // idx===0 carve-out matches owedChunks/runCatchUp/activate — but only for a
      // MULTI-chunk book; a single-chunk title IS the whole book, so chunk 0 still
      // requires completion (don't summarize the unread ending).
      if (!isComplete(map, idx) && (idx !== 0 || map.chunks.length === 1)) {
        try { if (typeof window.showToast === 'function') window.showToast('まだ読み終えていません', 2500); } catch (_) {}
        return { ok: false, reason: 'unread' };
      }
      // force: discard a summary-less or stale-fp artifact so processChunk's
      // billing backstop regenerates rather than re-adopting a useless one. A
      // good matching-fp summary is left intact (no surprise re-bill).
      if (opts.force) {
        try {
          const art = await readArtifact(id);
          const a = art && art[idx];
          if (a && (!a.shortSummary || !a.fp || (map.fingerprint && a.fp !== map.fingerprint))) {
            delete art[idx];
            await window.blobStore.set(CHAP_PREFIX + id, JSON.stringify(art));
          }
        } catch (_) {}
      }
      // If the pump is mid-flight, queue this chapter and let the pump take it
      // (respect the single-flight lock — never run two chapter calls at once).
      // Mark it FORCED so the pump runs it OUT of order via nextForced — otherwise
      // a chapter queued behind a wedged ('none'/perma-failed) predecessor would
      // never be reached by nextRunnable and the tap would silently do nothing.
      if (_inflight) {
        _forced.add(rk(id, idx));
        await mutateMap(id, (m) => {
          const c = chunkOf(m, idx);
          if (!c) return false;
          c.state = 'queued'; c.attempts = 0; c.error = null;
          return true;
        });
        try { pump(id); } catch (_) {}
        return { ok: true, queued: true };
      }
      // Run it directly under the single-flight guard, bypassing nextRunnable.
      _inflight = true;
      _cur = { titleId: id, idx };
      let ok = false;
      try {
        await mutateMap(id, (m) => {
          const c = chunkOf(m, idx);
          if (!c) return false;
          c.state = 'processing'; c.error = null;
          return true;
        });
        emitProcStatus(id, true, idx, map);
        await processChunk(id, idx);
        ok = true;
      } catch (e) {
        await mutateMap(id, (m) => {
          const c = chunkOf(m, idx);
          if (!c) return false;
          c.attempts = (c.attempts | 0) + 1;
          c.state = 'failed';
          c.error = String((e && e.message) || e || 'error').slice(0, 300);
          _retryAt[rk(id, idx)] = Date.now() + RETRY_BASE_MS * Math.pow(2, Math.max(0, c.attempts - 1));
          return true;
        });
        try { console.log('[ai-proc] chapter ' + idx + ' regen failed: ' + (e && e.message)); } catch (_) {}
      } finally {
        _cur = null;
        _inflight = false;
        const lastMap = (await readMap(id)) || map;
        emitProcStatus(id, false, null, lastMap);
      }
      // After a successful targeted run, pump to pick up any other owed chunks.
      if (ok) { try { pump(id); } catch (_) {} }
      return { ok };
    } catch (e) { return { ok: false, reason: (e && e.message) || 'error' }; }
  }

  window.aiProcessor = { updateNow, owedEstimate, status, activate, ensureActivated, reDetectChapters, resetTitle, resync, generateSceneIdeas, processChapter, setScenePrompt, _tick };
})();
