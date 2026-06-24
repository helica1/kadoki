// ai-image-openai.js — the OpenAI image BACKEND adapter (window.aiImageOpenai).
//
// ai-images.js owns the queue / outbox / gallery / sync state machine; this
// module is the pluggable backend that replaces what the LOCAL image server's
// Qwen does (image-pipeline-spec.md):
//   Stage 1 (art-director): Japanese character card / book passage → English
//            image prompt(s) + a Japanese caption, via window.aiOpenai.chat().
//   Stage 2 (render): each English prompt → an image, via window.aiOpenai
//            .generateImage() (the Responses image_generation tool).
// renderEntry() runs both stages SYNCHRONOUSLY for one outbox entry and returns
// a synthetic "done job" in the local server's shape, so ai-images.ingestJob()
// stores it through the exact same downstream path (index, blobStore bytes,
// gallery, crop, delete, drive-merge) used for local renders.
//
// The system prompts below are reproduced VERBATIM from image-pipeline-spec.md
// (§1B character, §1C scene) so OpenAI output matches the local pipeline. The
// content-policy caveat applies: OpenAI may refuse dark/violent/real-person
// scenes the local FLUX server renders — refusals are surfaced, never crash.
(function () {
  'use strict';

  // ===== Stage-1 system prompts (VERBATIM from image-pipeline-spec.md) =======
  const CHAR_SYS = [
    "You are an art director that converts a Japanese character card (appearance, personality, plot, and recent developments) into a SINGLE English image-generation prompt. The image shows THIS character inside ONE concrete, representative moment drawn from the card's most recent or most defining developments — depicted faithfully, never sanitized.",
    "Rules:",
    "- Output ONLY the prompt(s), each wrapped in its OWN <p> and </p> tags, e.g. <p>a Japanese woman, shoulder-length black hair, ...</p>. Each is one paragraph of comma-separated descriptive phrases — no preamble, quotes, labels, or explanation, and NEVER put these instructions or rule text inside the tags.",
    "- Always state each character's apparent ethnicity/nationality explicitly (the image model otherwise drifts to a default or generically Asian face). IMPORTANT: the source text is WRITTEN IN JAPANESE, but that is ONLY the source language — it does NOT mean the character is Japanese or Asian. Do not let the language of the text bias the ethnicity. INFER ethnicity so it is CONCORDANT WITH THE SETTING, weighing (in order): (1) the setting and cultural details — place names, landscape, architecture, food, clothing, religion, era; (2) the NAME — a katakana foreign name like エカチェリーナ/Ekaterina or セラフィマ/Serafima reads Russian/Slavic, a clearly Japanese name reads Japanese, Korean/Chinese/Western names accordingly. EXAMPLE: a story with Slavic names set in a village of hunters and deer is RUSSIAN (white/Slavic), NOT Asian, even though the text is in Japanese; a medieval-European setting is European; an American setting American. Give a concrete descriptor such as 'a Russian woman', 'a white Slavic man', 'a Japanese man', 'a Korean woman'. Only fall back to Japanese when the names, setting, AND cultural cues are genuinely Japanese, or there is truly no signal at all.",
    "- ANCHOR each prompt in ONE specific element or moment actually described in the recent developments / plot: a concrete action the character is taking, the place they are in, an object they hold, the emotional beat of that scene — depict it literally, not a vague neutral pose. Prefer ordinary, quietly telling moments over the single most extreme one; not every scene should be a breakdown. When asked for several prompts, pick a DIFFERENT moment for each (vary setting, action, and mood).",
    "- Keep the character recognizable: carry over their key physical features, age, hair, build, clothing (including notable garments, footwear, accessories) and bearing from the appearance section, and let personality show in their expression and body language.",
    "- Do NOT crop in tight by default. When the appearance, outfit, body, or pose carry meaningful detail, frame WIDE enough to show them — a full-body or three-quarter / head-to-toe shot — and say so explicitly in the prompt (e.g. 'full-body shot', 'three-quarter view, full outfit visible'). Reserve close-ups for moments that are truly about the face.",
    "- Render faithfully and unflinchingly. Grim, violent, bloody, frightening, or distressing content is fine and SHOULD be shown honestly when the text calls for it — do not soften, omit, or swap in a safer image. There are no content restrictions here.",
    "- Keep the POSE anatomically simple and physically possible: ONE clear primary action. Never stack multiple simultaneous hand/arm actions (e.g. 'holding X while gripping Y while bracing Z') — the model renders those as extra or fused limbs. Favor a natural stance.",
    "- HANDS are the model's weak point — minimize them. Describe at most ONE hand doing something; let the other hang at the side, rest in a pocket, or sit out of frame. With a phone/cup/tool/object, ONE hand holds it and the other is idle — never both fussing. Do not call for intricate finger detail or both hands raised; keep hands simple or partly hidden.",
    "- Depict emotion with RESTRAINT — a contained, naturalistic expression, never theatrical. Prefer a tense jaw, downcast or welling eyes, a quiet grimace, a held breath, a tear or two; AVOID operatic extremes (wide-open screaming mouth, contorted face, body wracked in anguish) unless the text truly hinges on it. For sadness or crying: glassy, tired, or slightly puffy eyes, wet lashes, a damp cheek, at most one CLEAR tear track — never 'streaming', 'pouring', or 'torrents'.",
    "- CRITICAL — NO blood or coloured fluid on the face or body. Tears are clear and colourless. Do NOT use the words 'blood', 'bloody', 'bleeding', 'crimson', and do NOT describe red or pink streaks, trails, marks, stains, or 'redness' on or near the eyes, cheeks, nose, or face — the image model turns ANY of these into blood running down the face. Skin stays its natural tone; eyes look normal and clear. Never add wounds, gore, bruises, or injury unless the text EXPLICITLY states this character is physically injured in the depicted moment.",
    "- Favor concrete, specific visual detail (what is in frame, what the character is doing, the lighting of that exact place and time of day) over generic filler. A couple of lighting/quality cues are fine; specificity wins. Compose one coherent image with the subject as the clear focal point.",
    "@@COUNT@@",
    "@@STYLE@@",
    "@@CAPTION@@",
  ];

  const SCENE_SYS = [
    "You are an art director illustrating a novel. You are given the text of ONE passage from a book chapter (the text is in Japanese) plus a list of the characters who may appear in it (with their appearance). Choose the SINGLE most visually compelling, representative moment in THIS passage and turn it into ONE English image-generation prompt depicting that moment faithfully, never sanitized. Use ONLY what is written in this passage and the supplied character descriptions — do NOT invent events and do NOT use any knowledge from other or later parts of the story (no spoilers).",
    "Rules:",
    "- Output ONLY the prompt(s), each wrapped in its OWN <p> and </p> tags, e.g. <p>a Japanese woman, shoulder-length black hair, ...</p>. Each is one paragraph of comma-separated descriptive phrases — no preamble, quotes, labels, or explanation, and NEVER put these instructions or rule text inside the tags.",
    "- Always state each character's apparent ethnicity/nationality explicitly (the image model otherwise drifts to a default or generically Asian face). IMPORTANT: the source text is WRITTEN IN JAPANESE, but that is ONLY the source language — it does NOT mean the character is Japanese or Asian. Do not let the language of the text bias the ethnicity. INFER ethnicity so it is CONCORDANT WITH THE SETTING, weighing (in order): (1) the setting and cultural details — place names, landscape, architecture, food, clothing, religion, era; (2) the NAME — a katakana foreign name like エカチェリーナ/Ekaterina or セラフィマ/Serafima reads Russian/Slavic, a clearly Japanese name reads Japanese, Korean/Chinese/Western names accordingly. EXAMPLE: a story with Slavic names set in a village of hunters and deer is RUSSIAN (white/Slavic), NOT Asian, even though the text is in Japanese; a medieval-European setting is European; an American setting American. Give a concrete descriptor such as 'a Russian woman', 'a white Slavic man', 'a Japanese man', 'a Korean woman'. Only fall back to Japanese when the names, setting, AND cultural cues are genuinely Japanese, or there is truly no signal at all.",
    "- ANCHOR the image in ONE specific, concrete moment that actually occurs in THIS passage: a clear single action, the place it happens, the time of day, the emotional beat — depict it literally, not a vague neutral pose. Pick the moment with the strongest visual payload in the passage; a quiet, telling beat is as valid as a dramatic one.",
    "- Put in frame ONLY the characters actually present in the chosen moment — usually one, sometimes two; avoid crowds. For each character shown, carry over their key physical features, age, hair, build, clothing, and bearing from the supplied character descriptions so they stay consistent with their portraits, and apply the ethnicity rule above to each. When two characters share the frame, keep the composition simple and readable, and keep hands minimal per the rule below.",
    "- Do NOT crop in tight by default. When the appearance, outfit, body, or pose carry meaningful detail, frame WIDE enough to show them — a full-body or three-quarter / head-to-toe shot — and say so explicitly in the prompt (e.g. 'full-body shot', 'three-quarter view, full outfit visible'). Reserve close-ups for moments that are truly about the face.",
    "- Render faithfully and unflinchingly. Grim, violent, bloody, frightening, or distressing content is fine and SHOULD be shown honestly when the text calls for it — do not soften, omit, or swap in a safer image. There are no content restrictions here.",
    "- Keep the POSE anatomically simple and physically possible: ONE clear primary action. Never stack multiple simultaneous hand/arm actions (e.g. 'holding X while gripping Y while bracing Z') — the model renders those as extra or fused limbs. Favor a natural stance.",
    "- HANDS are the model's weak point — minimize them. Describe at most ONE hand doing something; let the other hang at the side, rest in a pocket, or sit out of frame. With a phone/cup/tool/object, ONE hand holds it and the other is idle — never both fussing. Do not call for intricate finger detail or both hands raised; keep hands simple or partly hidden.",
    "- Depict emotion with RESTRAINT — a contained, naturalistic expression, never theatrical. Prefer a tense jaw, downcast or welling eyes, a quiet grimace, a held breath, a tear or two; AVOID operatic extremes (wide-open screaming mouth, contorted face, body wracked in anguish) unless the text truly hinges on it. For sadness or crying: glassy, tired, or slightly puffy eyes, wet lashes, a damp cheek, at most one CLEAR tear track — never 'streaming', 'pouring', or 'torrents'.",
    "- CRITICAL — NO blood or coloured fluid on the face or body. Tears are clear and colourless. Do NOT use the words 'blood', 'bloody', 'bleeding', 'crimson', and do NOT describe red or pink streaks, trails, marks, stains, or 'redness' on or near the eyes, cheeks, nose, or face — the image model turns ANY of these into blood running down the face. Skin stays its natural tone; eyes look normal and clear. Never add wounds, gore, bruises, or injury unless the text EXPLICITLY states this character is physically injured in the depicted moment.",
    "- Favor concrete, specific visual detail (what is in frame, what the character is doing, the lighting of that exact place and time of day) over generic filler. A couple of lighting/quality cues are fine; specificity wins. Compose one coherent image with the subject as the clear focal point.",
    "@@COUNT@@",
    "@@STYLE@@",
    "@@CAPTION@@",
  ];

  const STYLE_PHOTO = "- RENDER STYLE: a real PHOTOGRAPH — a candid shot on a real camera (35mm film or full-frame, a specific lens feel), natural skin texture (visible pores, fine lines, faint blemishes, stray hairs), real ambient light, subtle film grain. Actively avoid the glossy 3D-render / airbrushed / waxy 'plastic' look and words like 'masterpiece', 'flawless', 'perfect skin', or 'CGI'.";
  const STYLE_LN = "- RENDER STYLE: a Japanese LIGHT-NOVEL / ANIME ILLUSTRATION — clean, polished anime artwork with crisp linework and soft cel shading, the look of a modern light-novel cover or anime key visual: expressive stylized anime features and proportions, large expressive eyes, clear bold colors, soft gradient lighting, delicate detail. It is a DRAWN illustration, NOT a photograph — no photographic skin pores, no film grain.";
  const COUNT_ONE = "- Produce EXACTLY ONE prompt, in a single <p>...</p> followed by its <c>...</c> caption.";
  const COUNT_SCENE = "- Produce EXACTLY ONE prompt (the single best moment in this passage), in one <p>...</p> followed by its <c>...</c> caption.";
  const countN = (n) => "- Produce EXACTLY " + n + " prompts, each in its own <p>...</p> followed by its <c>...</c> caption, each anchored to a DIFFERENT moment/scene from the card — vary the setting, action, and emotional mood, and do NOT repeat the same moment or pose. Range across the character's developments (some quiet/ordinary, not all dramatic).";
  const CAPTION = "CAPTION: immediately AFTER each <p>...</p>, output a matching <c>...</c> caption written ENTIRELY IN JAPANESE (日本語) — 1〜2文の自然な日本語で、その画像が描く情景を説明する。内容は 上のカード／本文に書かれた事実（容姿・場所・状況）だけを用い、書かれていないことは創作しない。必ずキャラクターの名前を入れ、カードに読み仮名があれば括弧で添える（例：「古屋暁子（ふるやあきこ）は…」）。キャプションは直前の <p> プロンプトが描く場面と一致させること。NOTE: the <p> image prompt stays in ENGLISH; ONLY the <c> caption is in Japanese.";

  function assemble(lines, count, style, dir) {
    return lines.map(l => {
      if (l === '@@COUNT@@') return count;
      // A per-title art-style directive (dir) overrides the photoreal/light-novel line,
      // so characters AND scenes share ONE book-wide look.
      if (l === '@@STYLE@@') return dir ? ('- RENDER STYLE: ' + dir + '. Render the ENTIRE image in this exact art style.') : (style === 'light_novel' ? STYLE_LN : STYLE_PHOTO);
      if (l === '@@CAPTION@@') return CAPTION;
      return l;
    }).join('\n');
  }
  function buildCharSys(style, n, dir) { return assemble(CHAR_SYS, (n > 1 ? countN(n) : COUNT_ONE), style, dir); }
  function buildSceneSys(style, dir) { return assemble(SCENE_SYS, COUNT_SCENE, style, dir); }

  // ===== Stage-1 output parsing (VERBATIM rules from §1F) ====================
  const ECHO = ['output only', 'render style', 'anchor the image', 'anchor each prompt',
    'appearance section', 'caption:', 'image-generation prompt', 'these instructions',
    'no preamble', 'produce exactly', 'rule text', 'do not invent', 'no spoilers'];
  function looksLikePrompt(s) {
    s = (s || '').trim();
    if (s.length < 40) return false;
    if ((s.match(/,/g) || []).length < 4) return false;
    if (s.indexOf('?') >= 0) return false;
    if (s.indexOf('\n') >= 0) return false;
    if ((s.match(/\.\s/g) || []).length > 3) return false;       // mostly sentences = instruction echo
    const lc = s.toLowerCase();
    if (ECHO.some(e => lc.includes(e))) return false;
    return true;
  }
  function validCaption(s) {
    s = (s || '').trim();
    if (s.length < 12) return false;
    if (s.indexOf('<') >= 0) return false;
    const lc = s.toLowerCase();
    if (ECHO.some(e => lc.includes(e))) return false;
    return true;
  }
  // Returns [{ prompt, caption }]. For multi (n>1) collect all valid <p> deduped
  // by their first ~60 chars; else the LAST valid <p> + the caption after it.
  function parseArtDirector(text, multi) {
    text = String(text || '');
    const pRe = /<p>([\s\S]*?)<\/p>/gi, cRe = /<c>([\s\S]*?)<\/c>/gi;
    const ps = [], cs = [];
    let m;
    while ((m = pRe.exec(text))) ps.push({ text: m[1].trim(), at: m.index });
    while ((m = cRe.exec(text))) cs.push({ text: m[1].trim(), at: m.index });
    const validP = ps.filter(p => looksLikePrompt(p.text));
    const validC = cs.filter(c => validCaption(c.text));
    const captionAfter = (pos) => {
      const after = validC.filter(c => c.at > pos);
      const c = after.length ? after[0] : (validC.length ? validC[validC.length - 1] : null);
      return c ? c.text : '';
    };
    if (!validP.length) return [];
    if (!multi) {
      const p = validP[validP.length - 1];
      return [{ prompt: p.text, caption: captionAfter(p.at) }];
    }
    const out = [], seen = new Set();
    for (const p of validP) {
      const key = p.text.slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ prompt: p.text, caption: captionAfter(p.at) });
    }
    return out;
  }

  // ===== user messages (§1D) =================================================
  const MODIFY_BLOCK = (t) => "\n\n[修正指示] 以下の修正を必ず最優先で反映して画像プロンプトを作成してください: " + t +
    "\n(Apply these modifications when writing the image prompt; they take precedence over other choices.)";
  function charUser(cardText, modify) { return (cardText || '') + (modify ? MODIFY_BLOCK(modify) : ''); }
  function sceneUser(characters, passage) {
    let head = '';
    const list = (characters || []).filter(c => c && (c.surface || c.name));
    if (list.length) {
      head = '[登場人物 / characters who may appear]\n' + list.map(c => {
        const name = c.surface || c.name;
        const reading = c.reading && c.reading !== name ? ('（' + c.reading + '）') : '';
        const app = c.appearance ? (': ' + c.appearance) : '';
        const rel = c.relationships ? ('  [関係: ' + c.relationships + ']') : '';
        return '- ' + name + reading + app + rel;
      }).join('\n') + '\n\n';
    }
    return head + '[本文 / passage]\n' + (passage || '');
  }

  // ===== chunking (§1G) — split chapterText into ≤6000-char passages =========
  const SEG = 6000;
  function chunkBy6k(text) {
    text = String(text || '');
    if (text.length <= SEG) return [text];
    const out = [];
    const paras = text.split(/\n\n+/);
    let buf = '';
    const flush = () => { if (buf.trim()) out.push(buf); buf = ''; };
    for (let para of paras) {
      if (para.length > SEG) {                      // oversize paragraph → split on lines, hard-cut a giant line
        const lines = para.split('\n');
        for (let line of lines) {
          while (line.length > SEG) { flush(); out.push(line.slice(0, SEG)); line = line.slice(SEG); }
          if ((buf + '\n' + line).length > SEG) flush();
          buf = buf ? (buf + '\n' + line) : line;
        }
        continue;
      }
      if ((buf + '\n\n' + para).length > SEG) flush();
      buf = buf ? (buf + '\n\n' + para) : para;
    }
    flush();
    return out.length ? out : [text];
  }

  let _seq = 0;
  function jobId() { _seq = (_seq + 1) % 100000; return 'oai_' + Date.now().toString(36) + _seq.toString(36); }

  // Per-title art-style directive (seeded by ai-processor from the book's mood) so every
  // scene illustration shares a consistent look. Falls back to a strong cinematic default.
  const DEFAULT_STYLE_DIRECTIVE = 'hand-drawn 2D anime illustration in the style of a high-end Japanese animated film, painterly cel-shaded artwork with cinematic lighting, atmospheric depth and expressive faces; flat 2D illustration, NOT 3D, no CGI, no Pixar-style render, no glossy plastic shading';
  async function styleDirectiveFor(titleId) {
    try { const v = window.blobStore ? await window.blobStore.get('AISTYLE_V1_' + titleId) : null; if (typeof v === 'string' && v.trim()) return v.trim(); } catch (_) {}
    return DEFAULT_STYLE_DIRECTIVE;
  }

  // ===== render ONE outbox entry → a synthetic done-job ======================
  // ctx = { cfg:{ textModel, quality, size, style }, titleId }.
  // Resolves { job, produced, refused, refusalMsg }, or throws on a transient
  // (network/auth/rate) error so ai-images leaves the entry pending for retry.
  async function renderEntry(entry, ctx) {
    const client = ctx && ctx.client;
    if (!client || !client.chat || !client.render) throw new Error('image client missing');
    const cfg = (ctx && ctx.cfg) || {};
    const kind = (ctx && ctx.kind) || 'openai';   // backend tag stamped on stored images
    const prog = (t) => { try { if (window._kaiImgProgress) window._kaiImgProgress(t); } catch (_) {} };   // live stage readout
    const style = cfg.style || 'photoreal';
    const dir = await styleDirectiveFor(entry.titleId);   // book-wide art style applied to EVERY render (characters + scenes)
    const isScene = entry.kind === 'scene';
    const meta = { localId: entry.localId, titleId: entry.titleId, charId: entry.charId, charName: entry.charName, attempt: entry.attempt };
    if (entry.charSig) meta.charSig = entry.charSig;
    if (isScene) meta.chapterIdx = entry.chapterIdx;
    const job = { id: jobId(), status: 'done', meta, results: [], request: { model: cfg.modelLabel || 'cloud' } };

    // ---- Stage 1: art-director task list, OR a PRE-BUILT prompt (skip Stage 1) ----
    const tasks = [];
    if (entry.prompt) {
      tasks.push({ prebuilt: { prompt: String(entry.prompt), caption: entry.caption || '' } });   // Claude-authored scene prompt → render directly (dir prepended at render below)
    } else if (isScene) {
      const want = Math.max(1, entry.scenes || 1);
      const full = String(entry.chapterText || '');
      let passages;
      if (want <= 1) passages = [full.length > 16000 ? full.slice(-16000) : full];   // single best moment of what's been read (tail = nearest frontier)
      else passages = chunkBy6k(full).slice(0, Math.min(want, 4));
      for (const p of passages) tasks.push({ sys: buildSceneSys(style, dir), user: sceneUser(entry.characters, p), multi: false });
    } else {
      const n = Math.max(1, Math.min(3, entry.scenes || 1));
      tasks.push({ sys: buildCharSys(style, n, dir), user: charUser(entry.cardText, entry.modify), multi: n > 1 });
    }

    // ---- run Stage 1 (unless prebuilt) then Stage 2 per resulting prompt ----
    let refusalMsg = '', sceneNo = 0, produced = 0, refusedAny = false;
    for (const t of tasks) {
      let pairs;
      if (t.prebuilt) {
        pairs = [t.prebuilt];
      } else {
        let raw = '';
        prog('プロンプトを作成中…');
        try {
          raw = await client.chat({ system: t.sys, user: t.user, titleId: entry.titleId, temperature: t.multi ? 0.8 : 0.7, maxTokens: t.multi ? 5000 : 2600, feature: 'img-prompt' });
        } catch (e) {
          if (e && e._refused) { refusedAny = true; refusalMsg = refusalMsg || e.message; continue; }
          throw e;   // transient → bubble up; ai-images keeps the entry pending
        }
        pairs = parseArtDirector(raw, t.multi);
        if (!pairs.length) { refusalMsg = refusalMsg || '画像プロンプトを生成できませんでした'; continue; }
      }
      for (const pair of pairs) {
        sceneNo++;
        prog(isScene ? '場面を生成中…' : '画像を生成中…');
        try {
          const r = await client.render({ prompt: (dir ? (dir + '. ' + pair.prompt) : pair.prompt), titleId: entry.titleId, feature: isScene ? 'img-scene' : 'img-char' });
          job.results.push({ b64: r.b64, scene: sceneNo, prompt: pair.prompt, caption: pair.caption || '', respId: r.respId || null, backend: kind, sceneId: entry.sceneId || null });
          produced++;
        } catch (e) {
          if (e && e._refused) { refusedAny = true; refusalMsg = refusalMsg || e.message; job.results.push({ scene: sceneNo, error: 'refused', refused: true, prompt: pair.prompt }); continue; }
          throw e;   // transient → bubble up
        }
      }
    }
    return { job, produced, refused: produced === 0 && (refusedAny || !!refusalMsg), refusalMsg };
  }

  // ===== text-edit an existing image → { b64, respId } =======================
  // image = { respId, dataUri }. Chains via previous_response_id; falls back to
  // the stored bytes when the response id is missing/expired (reinstall-safe).
  async function editImage(image, instruction, ctx) {
    const cfg = (ctx && ctx.cfg) || {};
    const common = { instruction, model: cfg.textModel, quality: cfg.quality, size: cfg.size, titleId: ctx && ctx.titleId, feature: 'img-edit' };
    if (image && image.respId) {
      try { return await window.aiOpenai.editImage(Object.assign({ prevRespId: image.respId }, common)); }
      catch (e) { if (!(e && (e._noChain || e._status === 404))) throw e; /* expired chain → fall through to bytes */ }
    }
    if (image && image.dataUri) return await window.aiOpenai.editImageBytes(Object.assign({ pngDataUri: image.dataUri }, common));
    const e = new Error('この画像は編集できません（応答IDも画像データもありません）'); throw e;
  }

  window.aiImageOpenai = { renderEntry, editImage, buildCharSys, buildSceneSys, parseArtDirector, chunkBy6k };
})();
