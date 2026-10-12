// anki-translate.js — engine choice, explain prompts and focus for the send-to-Anki dialog.
// Runs the production file in a VM with a fake Translator plugin / AI backend.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../www/anki-translate.js', import.meta.url), 'utf8');

function load({ apple, ai } = {}) {
  const calls = { apple: 0, ai: [] };
  const window = {};
  if (apple) {
    window.Capacitor = { Plugins: { Translator: {
      status: async () => apple.status,
      translate: async ({ text }) => { calls.apple++; if (apple.fail) throw new Error(apple.fail); return { text: apple.text || ('EN:' + text) }; },
    } } };
  }
  if (ai) {
    window.ai = {
      ready: Promise.resolve(),
      backend: () => 'openrouter',
      openrouterKey: () => ai.key || '',
      openrouterModel: () => (ai.key ? { id: 'test/model' } : null),
      hasKey: () => false,
      request: async (opts) => { calls.ai.push(opts); return { text: ai.reply, model: 'test/model' }; },
    };
  }
  const c = vm.createContext({ window, setTimeout, clearTimeout, Promise, Error, String, Array });
  vm.runInContext(source, c);
  return { t: window.ankiTranslate, calls };
}
const APPLE_OK = { status: { available: true, status: 'installed' } };

test('Apple engine translates on-device and never calls the AI', async () => {
  const { t, calls } = load({ apple: { ...APPLE_OK, text: 'I went home.' }, ai: { key: 'k', reply: 'unused' } });
  const r = await t.run('家に帰った。', 'translate', { engine: 'apple' });
  assert.equal(r.engine, 'apple');
  assert.equal(r.text, 'I went home.');
  assert.equal(calls.ai.length, 0);
});

test('Apple is the default engine', async () => {
  const { t, calls } = load({ apple: APPLE_OK, ai: { key: 'k', reply: 'unused' } });
  await t.run('家に帰った。', 'translate');
  assert.equal(calls.apple, 1);
  assert.equal(calls.ai.length, 0);
});

test('AI engine uses the AI backend even when Apple is available', async () => {
  const { t, calls } = load({ apple: APPLE_OK, ai: { key: 'k', reply: '"I went home."' } });
  const r = await t.run('家に帰った。', 'translate', { engine: 'ai' });
  assert.equal(calls.apple, 0);
  assert.equal(r.engine, 'ai');
  assert.equal(r.name, 'OpenRouter');
  assert.equal(r.text, 'I went home.');                 // wrapping quotes stripped
  assert.match(calls.ai[0].system, /translation only/);
});

test('an Apple failure is reported, not silently sent to the paid AI', async () => {
  const { t, calls } = load({ apple: { ...APPLE_OK, fail: 'download declined' }, ai: { key: 'k', reply: 'x' } });
  await assert.rejects(() => t.run('家に帰った。', 'translate', { engine: 'apple' }), /Apple Translation failed .*choose AI/);
  assert.equal(calls.ai.length, 0);
});

test('Apple unavailable (Android / Vision Pro) says to choose AI', async () => {
  const { t, calls } = load({ ai: { key: 'k', reply: 'x' } });
  await assert.rejects(() => t.run('家に帰った。', 'translate', { engine: 'apple' }), /isn’t available.*Choose AI/);
  assert.equal(calls.ai.length, 0);
  assert.equal(await t.appleAvailable(), false);
});

test('an unsupported language pair counts as unavailable', async () => {
  const { t, calls } = load({ apple: { status: { available: true, status: 'unsupported' } } });
  assert.equal(await t.appleAvailable(), false);
  await assert.rejects(() => t.run('家に帰った。', 'translate'));
  assert.equal(calls.apple, 0);
});

test('Explain with nothing highlighted asks for advanced grammar only', async () => {
  const { t, calls } = load({ apple: APPLE_OK,
    ai: { key: 'k', reply: 'Translation: I went home.\nGrammar:\n• **帰ってしまった** — completed, with regret' } });
  const r = await t.run('家に帰ってしまった。', 'explain', { engine: 'apple' });
  assert.equal(calls.apple, 0);                          // explain ignores the translate engine
  assert.equal(r.engine, 'ai');
  assert.equal(r.text, 'I went home.\n\n• 帰ってしまった — completed, with regret');   // labels + markdown stripped
  assert.match(calls.ai[0].system, /Skip the\s+basics/);
  assert.match(calls.ai[0].system, /translation only/);
  assert.equal(calls.ai[0].messages[0].content, '家に帰ってしまった。');
});

test('Explain with highlights explains exactly those parts in context', async () => {
  const { t, calls } = load({ ai: { key: 'k', reply: 'Translation: …\nGrammar:\n• わけではない — …' } });
  await t.run('嫌いなわけではないが、行かない。', 'explain', { focus: ['わけではない', ' 行かない '] });
  const msg = calls.ai[0].messages[0].content;
  assert.match(calls.ai[0].system, /Explain every marked part/);
  assert.match(msg, /^Passage:\n嫌いなわけではないが、行かない。/);
  assert.match(msg, /- わけではない\n- 行かない$/);
});

test('Explain without an AI key explains how to set one up', async () => {
  const { t } = load({ apple: APPLE_OK });
  await assert.rejects(() => t.run('家に帰った。', 'explain'), /AI Features/);
});

test('AI engine without a key explains how to set one up', async () => {
  const { t } = load({ apple: APPLE_OK });
  await assert.rejects(() => t.run('家に帰った。', 'translate', { engine: 'ai' }), /AI Features/);
});

test('HTML in the selection is stripped before translating', async () => {
  const { t, calls } = load({ ai: { key: 'k', reply: 'ok' } });
  await t.run('<ruby>家<rt>いえ</rt></ruby>に帰った', 'translate', { engine: 'ai' });
  assert.equal(calls.ai[0].messages[0].content, '家いえに帰った');
});
