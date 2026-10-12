// anki-translate.js — translation for the send-to-Anki dialog (waveform.js edit()).
//
// "Translate": the engine the user picks in the dialog —
//   'apple': Apple's on-device Translation (iOS 18+ / macOS 15+; free, private, no
//            key) through the native Translator plugin. Never silently falls back
//            to a paid AI call; failures are reported so the user can switch.
//   'ai':    the AI backend (OpenRouter or Claude, Preferences → AI Features).
// "Translate + explain": always the AI backend — a translation engine can't
// explain grammar. Optionally focused on parts of the passage the user marked.
(function () {
  'use strict';

  const SOURCE = 'ja';
  const TARGET = 'en';
  // Long enough for a first-use Japanese language-pack download prompt.
  const APPLE_TIMEOUT_MS = 90000;

  const SYS_TRANSLATE =
    'Translate the Japanese text the user sends into natural, faithful English. ' +
    'Reply with the English translation only: no notes, no romaji, no quotation marks.';

  // Auto mode: only grammar an intermediate reader may not know.
  const SYS_EXPLAIN =
    'You are a Japanese tutor for an intermediate learner who reads novels and already knows ' +
    'everyday grammar (about JLPT N4). The user sends a Japanese sentence or passage from a book. ' +
    'Reply in plain text only: no markdown, no asterisks, no headings, and no labels such as ' +
    '"Translation:" or "Grammar:". Write one natural English translation, then a blank line, then ' +
    'one line per grammar point in the form:\n' +
    '• <the Japanese form as it appears> — <what it does here, in one short sentence>\n' +
    'Only include grammar such a learner may not know: compound and auxiliary patterns ' +
    '(e.g. 〜てしまう, 〜ようとする, 〜わけではない), formal, literary or archaic forms, causative-passive ' +
    'and other less common conjugations, nuanced sentence endings, and set expressions. Skip the ' +
    'basics entirely: common particles (は が を に で と も の へ から まで), polite and plain forms, ' +
    'simple past and negative, the basic て-form, and ordinary vocabulary. Give at most 4 points. ' +
    'If nothing qualifies, reply with the translation only.';

  // Focus mode: explain exactly the parts the user marked, whatever their level.
  const SYS_EXPLAIN_FOCUS =
    'You are a Japanese tutor. The user sends a Japanese passage from a book and one or more ' +
    'parts of it they found confusing. Reply in plain text only: no markdown, no asterisks, no ' +
    'headings, and no labels such as "Translation:" or "Grammar:". Write one natural English ' +
    'translation of the whole passage, then a blank line, then one line per marked part in the form:\n' +
    '• <the marked part> — <what the grammar is and what it does in this passage, in one or two short sentences>\n' +
    'Explain every marked part, in the order given, and nothing else.';

  async function aiConfigured() {
    const ai = window.ai;
    if (!ai || typeof ai.request !== 'function') return false;
    try { await ai.ready; } catch (_) {}
    try {
      return ai.backend() === 'openrouter'
        ? (!!ai.openrouterKey() && !!ai.openrouterModel())
        : !!ai.hasKey();
    } catch (_) { return false; }
  }

  // Display name of the AI backend for the engine switch and result label.
  async function aiName() {
    const ai = window.ai;
    if (!ai || typeof ai.backend !== 'function') return 'AI';
    try { await ai.ready; } catch (_) {}
    try { return ai.backend() === 'openrouter' ? 'OpenRouter' : 'Claude'; } catch (_) { return 'AI'; }
  }

  function translatorPlugin() {
    const T = window.Capacitor?.Plugins?.Translator;
    return (T && typeof T.translate === 'function' && typeof T.status === 'function') ? T : null;
  }

  async function appleAvailable() {
    const T = translatorPlugin();
    if (!T) return false;
    try {
      const st = await T.status({ source: SOURCE, target: TARGET });
      return !!(st && st.available && st.status !== 'unsupported');
    } catch (_) { return false; }
  }

  function withTimeout(promise, ms, message) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]).finally(() => clearTimeout(timer));
  }

  async function appleTranslate(text) {
    if (!(await appleAvailable())) {
      throw new Error('Apple Translation isn’t available on this device (it needs iOS 18+ or macOS 15+). Choose AI instead.');
    }
    let r;
    try {
      r = await withTimeout(translatorPlugin().translate({ text, source: SOURCE, target: TARGET }),
        APPLE_TIMEOUT_MS, 'timed out');
    } catch (e) {
      throw new Error('Apple Translation failed (' + ((e && e.message) || e) + '). Try again, or choose AI.');
    }
    const out = String((r && r.text) || '').trim();
    if (!out) throw new Error('Apple Translation returned nothing. Try again, or choose AI.');
    return { text: out, engine: 'apple' };
  }

  function cleanAiText(s, mode) {
    let t = String(s || '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#+\s*/gm, '').trim();
    if (mode === 'translate') t = t.replace(/^["“](.*)["”]$/s, '$1').trim();
    if (mode === 'explain') {
      // Models sometimes keep the old labels; the answer should be just the
      // translation followed by the grammar notes.
      t = t.replace(/^\s*Translation\s*[:：]\s*/i, '')
        .replace(/^\s*Grammar\s*[:：][ \t]*$/gim, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
    return t;
  }

  async function aiRun(text, mode, focus) {
    const parts = (focus || []).map((f) => String(f || '').trim()).filter(Boolean);
    let system = SYS_TRANSLATE, content = text, maxTokens = 300;
    if (mode === 'explain') {
      maxTokens = 700;
      if (parts.length) {
        system = SYS_EXPLAIN_FOCUS;
        content = 'Passage:\n' + text + '\n\nExplain these parts:\n' + parts.map((p) => '- ' + p).join('\n');
      } else {
        system = SYS_EXPLAIN;
      }
    }
    const res = await window.ai.request({
      feature: 'anki-translate',
      system,
      messages: [{ role: 'user', content }],
      maxTokens,
    });
    const out = cleanAiText(res && res.text, mode);
    if (!out) throw new Error('The AI returned an empty answer');
    return { text: out, engine: 'ai', name: await aiName(), model: (res && res.model) || '' };
  }

  // mode: 'translate' | 'explain'.
  // opts.engine: 'apple' (default) | 'ai' — Translate only.
  // opts.focus:  marked phrases for Explain; empty → advanced-grammar auto mode.
  // Resolves { text, engine: 'apple' | 'ai', name?, model? }.
  async function run(text, mode, opts) {
    opts = opts || {};
    text = String(text || '').replace(/<[^>]+>/g, '').trim();
    if (!text) throw new Error('Nothing to translate');
    if (mode === 'explain' || opts.engine === 'ai') {
      if (!(await aiConfigured())) {
        throw new Error((mode === 'explain' ? 'Explain' : 'AI translation') +
          ' uses your AI backend. Add an OpenRouter or Claude key in Preferences → AI Features.');
      }
      return await aiRun(text, mode === 'explain' ? 'explain' : 'translate', opts.focus);
    }
    return await appleTranslate(text);
  }

  window.ankiTranslate = { run, appleAvailable, aiName };
})();
