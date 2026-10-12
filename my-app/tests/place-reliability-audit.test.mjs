// Place / timer reliability audit (PLACE_RELIABILITY_AUDIT.md) — regression tests.
// FIXED tests assert the corrected behaviour. DEFECT tests cover findings that
// were deliberately left as they are (2026-09-13: #2 forward-only cold-start
// floors, #9 playhead-delta listening stats); they still demonstrate the
// current behaviour and should be converted if those are ever changed.
// Executes functions extracted from production ASTs; no application test hooks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const { parse } = createRequire(import.meta.url)('acorn');
function extract(file, predicate) {
  const source = readFileSync(new URL(`../www/${file}`, import.meta.url), 'utf8');
  let found;
  function walk(node) {
    if (!node || typeof node !== 'object' || found) return;
    if (predicate(node)) { found = node; return; }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  }
  walk(parse(source, { ecmaVersion: 'latest', sourceType: 'script' }));
  assert.ok(found, `production node in ${file}`);
  return source.slice(found.start, found.end);
}
const fn = (file, name) => extract(file, n => n.type === 'FunctionDeclaration' && n.id?.name === name);
const quiet = { log() {} };

test('DEFECT (#2, kept): cold-start max ignores a newer backward native seek', async () => {
  const code = extract('reading-mode.js', n => n.type === 'AssignmentExpression' && n.left?.property?.name === 'abBestColdStartMs');
  const window = { Capacitor: { Plugins: { BackgroundAudio: {
    getLastSavedPosition: async () => ({ hasSaved: true, url: '/book.m4b', positionMs: 1_800_000, ts: 2000 })
  } } } };
  const c = vm.createContext({ window, currentDeckName: () => 'book',
    getAudiobookLastPosition: async () => ({ ms: 3_600_000, ts: 1000 }), _abSameAudioFile: (a, b) => a === b });
  vm.runInContext(code, c);
  assert.equal(await window.abBestColdStartMs('/book.m4b', 0), 3_600_000);
});

test('FIXED (#1): remote play resumes in place and never changes the mode', () => {
  const call = extract('app.js', n => n.type === 'CallExpression' && n.callee?.property?.name === 'addListener' && n.arguments[0]?.value === 'remoteCommand');
  let handler, selected;
  const c = vm.createContext({ bg: { addListener: (_, cb) => { handler = cb; } },
    window: { setShellMode: (mode) => { selected = mode; } },
    document: { body: { classList: { contains: name => name === 'mode-read' } } },
    _srtCardEndMs: 100, debugLog() {} });
  vm.runInContext(call, c);
  handler({ action: 'play', ts: Date.now() });
  assert.equal(selected, undefined);
  assert.equal(c._srtCardEndMs, 0);   // card clip boundary still disarmed
});

function audioHarness() {
  const timers = { audio: { totalSec: 0, runningSince: 1000 } };
  let rate = 1;
  const c = vm.createContext({ timers, Date, console: quiet,
    window: { getActivePlaybackRate: () => rate }, audFamilyBucket: () => 'audio', persist() {} });
  vm.runInContext(`let _lastAudBucket='audio', _audAnchorTs=0, _audAnchorPos=-1,
    _audLastSampleTs=0, _audTitlePend=0, _audLastPersistTs=0;
    const AUD_PERSIST_MS=15000;
    ${fn('stats.js', 'audioResetAnchor')}
    ${fn('stats.js', 'audioSample')}`, c);
  return { c, timers, sample: (pos, ts) => c.audioSample(pos, ts), rate: v => { rate = v; } };
}
test('DEFECT (#9, kept): forward seek during an event gap counts skipped audio as listening', () => {
  const h = audioHarness();
  h.sample(0, 1000);
  // 60s heard, 20min paused, seek forward; final sample after 30min.
  h.sample(1_260_000, 1_801_000);
  assert.equal(h.timers.audio.totalSec, 1260); // actual listening: 60s
});
test('DEFECT (#9, kept): backward seek during an event gap erases real listening', () => {
  const h = audioHarness();
  h.sample(60_000, 1000);
  // Hear 60 seconds, then return to the same position before next sample.
  h.sample(60_000, 61_000);
  assert.equal(h.timers.audio.totalSec, 0);
});
test('DEFECT (#9, kept): current rate is applied to the entire sample gap', () => {
  const h = audioHarness();
  h.sample(0, 1000);
  // 30s at 1x + 30s at 2x = 90s media, 60s listened.
  h.rate(2); h.sample(90_000, 61_000);
  assert.equal(h.timers.audio.totalSec, 45);
});

test('FIXED (#11): stats checkpoint includes the running reading session', () => {
  const c = vm.createContext({ Math, Date: { now: () => 61_000 },
    timers: { read: { totalSec: 12, runningSince: 1000, chars: 0 } } });
  vm.runInContext(fn('stats.js', 'persistableShape'), c);
  assert.equal(c.persistableShape('read').totalSec, 72);   // 12 committed + 60 open
});

// Interactive timer lifecycle with the real start/stop/reconcile/background code.
function statsHarness({ mode = 'mode-read', playing = true } = {}) {
  const state = { now: 1000 };
  const timers = {};
  for (const m of ['card', 'read', 'audio', 'video', 'ai', 'srs']) {
    timers[m] = { totalSec: 0, runningSince: 0, lastInteraction: 0, chars: 0 };
  }
  const noted = [];
  const c = vm.createContext({
    timers, console: quiet, Math, Number, Promise, Date: { now: () => state.now },
    window: { _bgPlaying: playing, _activeTitleId: 't1',
      titleStats: { noteTime: (tid, m, s) => noted.push([tid, m, s]) } },
    document: { visibilityState: 'visible', body: { classList: { contains: n => n === mode } } },
    setTimeout: () => 1, clearTimeout() {},
    mirrorWrite() {}, audioTruthPoll() {}, persist() {}, audioResetAnchor() {}, audFamilyBucket: () => 'audio',
  });
  const names = ['currentMode', 'startMode', 'creditTitleTime', 'finishTitleTime', 'stopMode',
    'handleModeChange', 'reconcileMode', '_shouldIgnoreBump', 'bumpRead',
    'stopInteractiveTimersForBackground', 'scheduleBackgroundStop', 'cancelBackgroundStop',
    'pauseAudioForBackgroundIfInteractive', 'handleAppHidden', 'handleAppVisible'];
  vm.runInContext(`let _mirrorLastTs=0, _ankiRoundtripActive=false, _backgroundGraceTimer=null, _hiddenAt=0,
    lastMode=null, _audTitlePend=0;
    const BACKGROUND_GRACE_MS=10000, TIMEOUT_CARD_SEC=20, TIMEOUT_READ_SEC=120, TIMEOUT_AI_SEC=30;
    ${names.map(n => fn('stats.js', n)).join('\n')}`, c);
  const readTitleSec = () => noted.filter(([, m]) => m === 'read').reduce((a, [, , s]) => a + s, 0);
  return { c, timers, state, readTitleSec };
}

test('FIXED (#10): locking during Read listening closes Read at the hide moment', async () => {
  const h = statsHarness({ playing: true });
  h.c.startMode('read');
  h.state.now += 60_000;
  h.c.document.visibilityState = 'hidden';
  h.c.handleAppHidden();
  assert.equal(h.timers.read.runningSince, 0);
  assert.equal(h.timers.read.totalSec, 60);
  assert.ok(h.timers.audio.runningSince > 0);          // listening now accrues as audio
  h.state.now += 1_800_000;                              // WebView suspended for 30 min
  h.c.document.visibilityState = 'visible';
  await h.c.handleAppVisible();
  assert.equal(h.timers.read.totalSec, 60);
  assert.equal(h.readTitleSec(), 60);                    // per-title matches the daily total
});

test('FIXED (#10): a suspended grace stop is settled at the hide moment on return', async () => {
  const h = statsHarness({ playing: false });
  h.c.startMode('read');
  h.state.now += 30_000;
  h.c.document.visibilityState = 'hidden';
  h.c.handleAppHidden();                                  // grace timer armed, never fires
  h.state.now += 1_800_000;
  h.c.document.visibilityState = 'visible';
  await h.c.handleAppVisible();
  assert.equal(h.timers.read.runningSince, 0);
  assert.equal(h.timers.read.totalSec, 30);
});

test('FIXED (#12): per-title Read time is the elapsed interval, not tick count', () => {
  const h = statsHarness({ playing: false });
  h.c.startMode('read');
  h.state.now += 3_700;
  h.c.stopMode('read');
  assert.equal(h.timers.read.totalSec, 3.7);
  assert.equal(h.readTitleSec(), 4);
});

test('FIXED (#13): the raw scroll save refuses to write during a restore', () => {
  const c = vm.createContext({ Math, Array, Date,
    currentName: 'book', viewEl: {}, _readerHidden: () => false, lastUserScrollTime: 0,
    scrollEl: { scrollWidth: 5000, clientWidth: 400, scrollLeft: -1200 },
    window: { allNotes: [] }, suppressScrollSave: true });
  vm.runInContext(fn('reading-mode-paged.js', '_canSaveReadScroll'), c);
  assert.equal(c._canSaveReadScroll(), false);
  c.suppressScrollSave = false;
  assert.equal(c._canSaveReadScroll(), true);
});
