// The send dialog's translation must reach the mapped Anki field — for dictionary
// cards (enhanced-dictionary.js sendWordToAnki) AND swipe-up cards
// (sendToAnkiConnect.js sendToAnki). Regression for "translation did NOT make it
// into Expanded Meaning" (dictionary path ignored it). Production functions are
// extracted with acorn and run against a fake AnkiConnect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const { parse } = createRequire(import.meta.url)('acorn');

function fnSource(file, name) {
  const source = readFileSync(new URL(`../www/${file}`, import.meta.url), 'utf8');
  let found;
  (function walk(node) {
    if (!node || typeof node !== 'object' || found) return;
    if (node.type === 'FunctionDeclaration' && node.id?.name === name) { found = node; return; }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') walk(v);
    }
  })(parse(source, { ecmaVersion: 'latest', sourceType: 'script' }));
  assert.ok(found, `${name} in ${file}`);
  return source.slice(found.start, found.end);
}

const DICT_FIELDS = { term: 'Term', reading: 'Reading', sentence: 'Sentence', meaning: 'Meaning', image: 'Image',
  sentenceAudio: 'Sentence Audio', termAudio: 'Term Audio', glossary: 'Glossary', termFurigana: 'Furigana',
  translation: 'Expanded Meaning' };

function dictHarness(fields) {
  const sent = [], toasts = [];
  const window = {
    getAnkiSettings: async (t) => (t === 'dict' ? { deck: 'Mining', model: 'Kadoki Kinomoto', fields } : null),
    ankiConnect: { enabled: async () => true, probe: async () => {}, invoke: async (action, p) => { sent.push(p.note); return 1; } },
    ankiOutbox: { flush: async () => {} },
    showToast: (m) => toasts.push(m),
    ankiAudioFilename: (f) => f,
    sniffAudioBase64: () => '',
  };
  const c = vm.createContext({ window, console: { log() {}, warn() {}, error() {} }, Date, String, alert() {},
    dT: (k, f) => f, dF: (k, o, f) => f });
  vm.runInContext(fnSource('enhanced-dictionary.js', 'sendWordToAnki'), c);
  return { send: (args) => c.sendWordToAnki(args), sent, toasts };
}

const WORD = { expression: '懸念', reading: 'けねん', sentence: 'いつもは隠している懸念が、', meaning: 'worry', dictionary: 'Jitendex' };

test('dictionary card: translation lands in the mapped field, escaped, newlines as <br>', async () => {
  const h = dictHarness(DICT_FIELDS);
  await h.send({ ...WORD, translation: 'The worry he always hides.\n\n• 隠している — ongoing state <hidden>' });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].fields['Expanded Meaning'],
    'The worry he always hides.<br><br>• 隠している — ongoing state &lt;hidden&gt;');
  assert.equal(h.sent[0].fields.Term, '懸念');
});

test('dictionary card: no translation leaves the field untouched', async () => {
  const h = dictHarness(DICT_FIELDS);
  await h.send({ ...WORD });
  assert.equal('Expanded Meaning' in h.sent[0].fields, false);
});

test('dictionary card: a translation field that clashes with another mapping is skipped with a warning', async () => {
  const h = dictHarness({ ...DICT_FIELDS, translation: 'Meaning' });
  await h.send({ ...WORD, translation: 'The worry.' });
  assert.equal(h.sent[0].fields.Meaning, 'worry');
  assert.ok(h.toasts.some((m) => /translation not added/.test(m)));
});

test('dictionary card: translation field set to (none) skips it with a warning', async () => {
  const h = dictHarness({ ...DICT_FIELDS, translation: '' });
  await h.send({ ...WORD, translation: 'The worry.' });
  assert.equal('Expanded Meaning' in h.sent[0].fields, false);
  assert.ok(h.toasts.some((m) => /No translation field set/.test(m)));
});

test('swipe-up card: translation lands in the mapped field', async () => {
  const sent = [];
  const window = {
    getAnkiSettings: async () => ({ deck: 'Shadowing9', model: 'jidoujisho Kinomoto BLUE',
      fields: { expression: 'Term', image: 'Image', audio: 'Sentence Audio', translation: 'Expanded Meaning' } }),
    showToast() {},
    kadokiVideoMode: null,
  };
  const c = vm.createContext({ window, console: { log() {}, warn() {}, error() {} }, Date, String, alert() {},
    fetchDeckNames: async () => [],
    ankiConnectEnabled: async () => true,
    getAnkiConnectHost: async () => 'mac.local',
    acInvoke: async (action, p) => { if (action === 'addNote') sent.push(p.note); return 1; },
    ankiOutboxQueueNote: async () => {},
    ankiOutboxFlush: async () => {},
    sniffAudioBase64: () => '', ankiAudioFilename: (f) => f, _replaceExt: (f) => f });
  vm.runInContext(fnSource('sendToAnkiConnect.js', 'sendToAnki'), c);
  await c.sendToAnki({ expression: '警察も近隣住民も須藤の犯行だろうと思っていた。', translation: 'The police assumed it was Sudo.\n• だろう — conjecture' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].fields['Expanded Meaning'], 'The police assumed it was Sudo.<br>• だろう — conjecture');
});
