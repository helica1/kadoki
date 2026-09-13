// Runs real production functions in a VM with fake bridge/DOM boundaries.
// Test hooks are injected here only; no debug API is shipped in the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (name) => readFileSync(new URL(`../www/${name}`, import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function transcriber() {
  const calls = { start: [], stop: [], saved: [] }, intervals = [];
  const prefs = new Map();
  const power = { charging: false, thermal: 'nominal', lowPower: false };
  const native = {
    checkAvailability: async () => ({ supported: true, installed: true }),
    start: async (args) => { calls.start.push(args); return { durationMs: 7_200_000 }; },
    stop: async (args) => { calls.stop.push(args); },
    setTarget: async () => {},
  };
  const window = {
    _activeTitleId: 'book',
    Capacitor: { getPlatform: () => 'ios', Plugins: { AutoTranscribe: native, BackgroundAudio: { powerState: async () => power } } },
    blobStore: { set: async (...args) => calls.saved.push(args) },
  };
  const context = vm.createContext({ window, console: { log() {} },
    document: { hidden: false, getElementById: () => null },
    localStorage: { getItem: (key) => prefs.get(key) ?? null },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    setTimeout: () => 1, clearTimeout() {},
  });
  const hook = `window.__test = {
    startJob, ensureJob, restartAt, onDoneEvent, onCuesEvent, onPosition, powerTick, maybeParkForPower,
    state: () => ({active, job, pendingRestartMs, parked: _parked}),
    seed: (a, j = null, pos = 0, p = {}) => {
      active = a; job = j; lastPosMs = pos; _powerAnchorMs = Math.max(0, pos);
      _power = Object.assign({charging:false, thermal:'nominal', lowPower:false, at:Date.now()}, p);
    }
  };`;
  vm.runInContext(read('auto-transcribe.js').replace('  window.autoTranscribe = {', `${hook}\n  window.autoTranscribe = {`), context);
  const active = { titleId: 'book', audioPath: '/book.m4b', sig: 'test', durationMs: 7_200_000, cues: [], cov: [], done: false, retries: 0 };
  const j = { id: 'existing', startMs: 0, fedThroughMs: 0, startedAt: Date.now() };
  window.__test.seed(active);
  return { api: window.__test, publicApi: window.autoTranscribe, calls, active, j, power, prefs, native, window, intervals };
}

test('battery input uses ten minutes; charging and explicit unlimited retain an hour', async () => {
  for (const mode of ['battery', 'charging', 'unlimited']) {
    const h = transcriber();
    if (mode === 'unlimited') h.prefs.set('AT_POWER_UNLIMITED', '1');
    h.api.seed(h.active, null, 0, { charging: mode === 'charging' });
    await h.api.startJob(0);
    assert.equal(h.calls.start[0].aheadMs, mode === 'battery' ? 600_000 : 3_600_000);
    assert.equal(h.calls.start[0].powerUnlimited, mode === 'unlimited');
  }
});

test('a paused timing-only job parks on fresh thermal state without position events', async () => {
  const h = transcriber();
  h.active.timingOnly = true;
  h.api.seed(h.active, h.j, -1, { at: 0 });
  h.power.thermal = 'serious';
  h.api.powerTick();
  await flush();
  assert.equal(h.calls.stop.length, 1);
  assert.equal(h.api.state().job.stopping, 'power');
  assert.equal(h.publicApi.powerInfo().parked, false, 'do not claim native teardown is complete');
  assert.equal(h.publicApi.powerInfo().stopping, true);
});

test('buffer completion parks from cue results before playback and retains in-flight word timings', async () => {
  const h = transcriber();
  h.api.seed(h.active, h.j, -1);
  h.api.onCuesEvent({ jobId: h.j.id, fedThroughMs: 600_000,
    cues: [{ startMs: 599_000, endMs: 600_000, text: '本', w: [0, 1, 599_000, 600_000] }] });
  assert.equal(h.calls.stop.length, 1);
  assert.equal(h.api.state().job.id, h.j.id);
  h.api.onCuesEvent({ jobId: h.j.id, fedThroughMs: 601_000,
    cues: [{ startMs: 600_000, endMs: 601_000, text: '次', w: [0, 1, 600_000, 601_000] }] });
  assert.equal(h.active.cues.length, 2);
  assert.deepEqual(Array.from(h.active.cues[1].w), [0, 1, 0, 1000]);
  await h.api.onDoneEvent({ jobId: h.j.id, reason: 'stopped', fedThroughMs: 3_600_000 });
  assert.equal(h.api.state().job, null);
  assert.equal(h.publicApi.powerInfo().parked, true);
  assert.equal(h.active.cov.at(-1)[1], 601_000, 'do not mark merely fed audio recognized');
  assert.ok(h.calls.saved.length > 0, 'flush accepted timings when parked');
});

test('seeking waits for the matching native done and honors the latest seek', async () => {
  const h = transcriber();
  h.api.seed(h.active, h.j);
  h.api.restartAt(20_000);
  h.api.restartAt(30_000);
  assert.equal(h.calls.stop.length, 1);
  assert.equal(h.calls.start.length, 0);
  await h.api.onDoneEvent({ jobId: 'obsolete', reason: 'stopped' });
  assert.equal(h.calls.start.length, 0);
  await h.api.onDoneEvent({ jobId: h.j.id, reason: 'stopped' });
  assert.equal(h.calls.start.length, 1);
  assert.equal(h.calls.start[0].startMs, 30_000);
});

test('restart paths obey thermal and battery backfill gates', async () => {
  const h = transcriber();
  h.api.seed(h.active, null, 3_000_000, { thermal: 'serious' });
  h.api.restartAt(3_000_000);
  assert.equal(h.calls.start.length, 0);
  h.api.seed(h.active, null, 3_000_000);
  await h.api.startJob(0);
  assert.equal(h.calls.start.length, 0);
});

test('a stale start rejection cannot clear the replacement title job', async () => {
  const h = transcriber();
  let reject;
  h.native.start = () => new Promise((_, no) => { reject = no; });
  const pending = h.api.startJob(0);
  const next = { ...h.active, titleId: 'next' }, nextJob = { id: 'next-job' };
  h.api.seed(next, nextJob);
  reject(new Error('late bridge failure'));
  await pending;
  assert.equal(h.api.state().job, nextJob);
  assert.equal(next.retries, 0);
});

test('a native thermal stop blocks restarts until a fresh power snapshot arrives', async () => {
  const h = transcriber();
  let resolvePower;
  h.window.Capacitor.Plugins.BackgroundAudio.powerState = () => new Promise((yes) => { resolvePower = yes; });
  h.api.seed(h.active, h.j);
  await h.api.onDoneEvent({ jobId: h.j.id, reason: 'parked' });
  await h.api.startJob(0);
  assert.equal(h.calls.start.length, 0);
  resolvePower({ charging: false, thermal: 'nominal', lowPower: false });
  await flush();
  await h.api.startJob(0);
  assert.equal(h.calls.start.length, 1);
});

test('paused mid-book parking resumes at its reading anchor, not book start', async () => {
  const h = transcriber();
  h.api.seed(h.active, null, -1);
  await h.api.startJob(1_000_000);
  const id = h.api.state().job.id;
  h.api.onCuesEvent({ jobId: id, fedThroughMs: 1_600_000,
    cues: [{ startMs: 1_599_000, endMs: 1_600_000, text: '本' }] });
  await h.api.onDoneEvent({ jobId: id, reason: 'stopped' });
  h.api.powerTick();
  assert.equal(h.calls.start.length, 1, 'full buffer stays parked at the mid-book anchor');
});

function geometry() {
  let now = 1000, measurements = 0, left = 10;
  const events = new Map(), observers = [];
  const listen = (name, fn) => events.set(name, fn);
  class Observer {
    constructor(fn) { this.fn = fn; this.targets = []; observers.push(this); }
    observe(el) { this.targets.push(el); }
    disconnect() { this.targets = []; }
  }
  const content = {}, inner = { parentElement: content }, view = {};
  const els = { readingPagedInner: inner, readingPagedContent: content, readingPagedView: view };
  const document = {
    body: { classList: { contains: () => true } }, documentElement: {}, hidden: false,
    getElementById: (id) => els[id] || null,
    addEventListener: listen, fonts: { addEventListener: listen },
    createRange: () => ({ setStart() {}, setEnd() {}, getClientRects() {
      measurements++;
      return [{ left, top: 20, right: left + 10, bottom: 40, width: 10, height: 20 }];
    } }),
  };
  const window = { addEventListener: listen, visualViewport: { addEventListener() {} } };
  const context = vm.createContext({ window, document, MutationObserver: Observer, ResizeObserver: Observer,
    performance: { now: () => now }, requestAnimationFrame: () => 1,
    localStorage: { getItem: () => null }, setTimeout: () => 1,
  });
  const hook = `window.__test = { beginReaderGeometry, _charRect, observeReaderGeometry,
    invalidateReaderGeometry, chunkRect, clearReader,
    scrub: (ms) => { scrubMs = ms; },
  };`;
  vm.runInContext(read('word-highlight.js').replace('  window.wordHighlight = {', `${hook}\n  window.wordHighlight = {`), context);
  const node = { isConnected: true, nodeValue: '本次' };
  const rd = { positions: [{ node, off: 0 }, { node, off: 1 }] };
  return { api: window.__test, rd, node, events, observers, inner, view, content,
    setTime: (t) => { now = t; }, setLeft: (x) => { left = x; }, count: () => measurements };
}

test('stationary frames reuse character geometry while preserving coordinates', () => {
  const h = geometry();
  for (let frame = 0; frame < 60; frame++) {
    h.setTime(1000 + frame * 1000 / 60);
    h.api.beginReaderGeometry(h.rd, false);
    for (let read = 0; read < 5; read++) assert.equal(h.api._charRect(h.rd, read % 2).left, 10);
  }
  assert.ok(h.count() <= 8, `expected at most 8 range measurements, got ${h.count()}`);
});

test('scrolling refreshes each frame but deduplicates reads within a frame', () => {
  const h = geometry();
  for (let frame = 0; frame < 3; frame++) {
    h.setTime(1000 + frame * 16);
    h.events.get('scroll')();
    h.setLeft(10 + frame * 5);
    h.api.beginReaderGeometry(h.rd, false);
    for (let n = 0; n < 5; n++) assert.equal(h.api._charRect(h.rd, 0).left, 10 + frame * 5);
  }
  assert.equal(h.count(), 3);
});

test('text/ancestor mutations, resize, fonts and scrubbing invalidate stale geometry', () => {
  const h = geometry();
  h.api.observeReaderGeometry();
  const mutationObserver = h.observers.find((o) => o.targets.includes(h.inner) && o.targets.includes(h.view));
  assert.ok(mutationObserver, 'observe text plus transformed ancestors');
  const invalidate = [mutationObserver.fn, h.events.get('resize'), h.events.get('loadingdone'),
    () => h.api.scrub(2000)];
  h.api.beginReaderGeometry(h.rd, false);
  h.api._charRect(h.rd, 0);
  for (let i = 0; i < invalidate.length; i++) {
    h.setLeft(100 + i);
    invalidate[i]();
    h.api.beginReaderGeometry(h.rd, false);
    assert.equal(h.api._charRect(h.rd, 0).left, 100 + i);
  }
  h.node.isConnected = false;
  assert.equal(h.api._charRect(h.rd, 0), null, 'never reuse a detached text node');
  h.api.clearReader();
  assert.equal(mutationObserver.targets.length, 0, 'stop observing when reader is cleared');
});
