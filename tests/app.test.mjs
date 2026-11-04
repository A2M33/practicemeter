// Runs app.js against a small stand-in for the browser: a fake page built from the real
// index.html, a fake microphone and a clock the test moves by hand.
// Run with: node tests/app.test.mjs
//
// This covers the wiring around the microphone and storage. It has no layout and no real
// audio; the detector's own logic is tested in tests/detector.test.mjs.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = (file) => readFileSync(join(root, file), 'utf8');
const html = source('index.html');
const KEY = 'practicemeter.v2';

class Emitter {
  constructor() { this.listeners = {}; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  emit(type, event = {}) {
    const e = { target: this, preventDefault() { this.defaultPrevented = true; }, ...event };
    for (const fn of this.listeners[type] || []) fn(e);
    return e;
  }
}

class El extends Emitter {
  constructor(tag, attrs = {}) {
    super();
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.kids = [];
    this.text = '';
    this.style = { setProperty() {} };
    this.hidden = 'hidden' in attrs;
    this.disabled = false;
    this.value = attrs.value ?? '';
    this.checked = 'checked' in attrs;
    this.id = attrs.id ?? '';
    this.className = attrs.class ?? '';
    const classes = new Set();
    this.classList = {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    };
  }
  get textContent() { return this.text + this.kids.map((k) => k.textContent).join(''); }
  set textContent(v) { this.text = String(v); this.kids = []; }
  get children() { return this.kids; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(node) { this.kids.push(node); return node; }
  closest(selector) { return selector.split(/,\s*/).includes(this.tagName.toLowerCase()) ? this : null; }
  click() { return this.emit('click'); }
}

function parsePage() {
  const all = [];
  const body = html.slice(html.indexOf('<body'));
  for (const tag of body.matchAll(/<([a-z][a-z0-9]*)\b((?:[^>"]|"[^"]*")*)>/g)) {
    const attrs = {};
    for (const a of tag[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] ?? '';
    all.push(new El(tag[1], attrs));
  }
  return all;
}

class FakeTrack extends Emitter {
  constructor() { super(); this.readyState = 'live'; }
  stop() { this.readyState = 'ended'; }
}

class FakeContext extends Emitter {
  static made = [];
  static failSource = false;
  static failNew = false;
  constructor() {
    super();
    if (FakeContext.failNew) throw Object.assign(new Error('too many contexts'), { name: 'NotSupportedError' });
    this.state = 'running';
    this.currentTime = 0;
    this.level = 0.0001;
    FakeContext.made.push(this);
  }
  createMediaStreamSource() {
    if (FakeContext.failSource) throw Object.assign(new Error('sample rate'), { name: 'NotSupportedError' });
    return { connect() {}, disconnect() {} };
  }
  createAnalyser() {
    const ctx = this;
    return { fftSize: 2048, getFloatTimeDomainData(buf) { buf.fill(ctx.level); } };
  }
  resume() { return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

// Starts the app. stored is the saved data, as an object or raw string. mic decides what
// getUserMedia does: 'grant' (default), 'hold' (the permission prompt stays up) or an error name.
function boot({ stored, search = '', mic = 'grant', now = () => Date.parse('2026-11-04T12:00:00'), store = new Map(), wakeLock } = {}) {
  FakeContext.made = [];
  FakeContext.failSource = false;
  FakeContext.failNew = false;
  if (stored !== undefined) store.set(KEY, typeof stored === 'string' ? stored : JSON.stringify(stored));

  const doc = new Emitter();
  doc.visibilityState = 'visible';
  doc.body = new El('body');
  doc.createElement = (tag) => new El(tag);
  doc.createDocumentFragment = () => new El('fragment');
  const page = parsePage();
  doc.getElementById = (id) => page.find((el) => el.id === id) ?? null;

  const streams = [];
  const pending = [];
  const makeStream = () => {
    const track = new FakeTrack();
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    streams.push(stream);
    return stream;
  };
  const media = {
    calls: 0,
    getUserMedia() {
      media.calls++;
      if (mic === 'grant') return Promise.resolve(makeStream());
      if (mic === 'hold') return new Promise((resolve) => pending.push(() => resolve(makeStream())));
      return Promise.reject(Object.assign(new Error('nope'), { name: mic }));
    },
  };

  const FakeDate = class extends Date {
    constructor(...args) { if (args.length) super(...args); else super(now()); }
    static now() { return now(); }
  };

  let clock = 1000;
  const intervals = new Map();
  let nextTimer = 1;
  const win = new Emitter();
  const sandbox = {
    document: doc,
    navigator: { mediaDevices: media, ...(wakeLock ? { wakeLock } : {}) },
    console,
    Date: FakeDate,
    performance: { now: () => clock },
    setTimeout,
    clearTimeout,
    setInterval: (fn, ms) => { intervals.set(nextTimer, { fn, ms }); return nextTimer++; },
    clearInterval: (id) => intervals.delete(id),
  };
  vm.createContext(sandbox);
  const global = vm.runInContext('this', sandbox);
  Object.assign(sandbox, {
    window: global,
    addEventListener: win.addEventListener.bind(win),
    location: { search, protocol: 'file:', pathname: '/index.html' },
    AudioContext: FakeContext,
    confirm: () => true,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
  });
  for (const file of ['detector.js', 'micwatch.js', 'history.js', 'app.js']) {
    vm.runInContext(source(file), sandbox, { filename: file });
  }

  const $ = (id) => doc.getElementById(id);
  return {
    doc, win, $, store, streams, media, pending,
    saved: () => JSON.parse(store.get(KEY)),
    liveTracks: () => streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length,
    space(extra = {}) {
      return doc.emit('keydown', { code: 'Space', key: ' ', target: doc.body, repeat: false, ...extra });
    },
    // Moves the clock on, firing the 40 ms analysis tick along the way.
    run(ms, level) {
      if (level !== undefined) FakeContext.made.at(-1).level = level;
      const end = clock + ms;
      while (clock < end) {
        clock += 40;
        for (const { fn, ms: every } of [...intervals.values()]) if (every === 40) fn();
      }
    },
    fireIntervals(every) {
      for (const t of [...intervals.values()]) if (t.ms === every) t.fn();
    },
    get contexts() { return FakeContext.made; },
    intervals,
  };
}

const QUIET = 0.0001; // -80 dB
const LOUD = 0.05;    // -26 dB

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('a session counts played time, saves it and lists it', async () => {
  const g = boot();
  g.$('toggle').click();
  await flush();
  assert.equal(g.$('toggle').textContent, 'Stop');
  g.run(2500, QUIET);
  g.run(10000, LOUD);
  g.run(200, QUIET);
  g.$('toggle').click();
  assert.equal(g.$('toggle').textContent, 'Start');
  assert.equal(g.liveTracks(), 0, 'the microphone is released');
  assert.equal(g.contexts[0].state, 'closed');
  const saved = g.saved();
  assert.equal(saved.sessions.length, 1);
  assert.ok(saved.sessions[0].playedMs >= 9500, `played ${saved.sessions[0].playedMs}`);
  assert.equal(saved.days['2026-11-04'], saved.sessions[0].playedMs);
  assert.equal(g.$('session-rows').children.length, 1);
});

test('corrupt saves still give a working page', () => {
  for (const stored of ['{not json', 'null', '7', '[]', { settings: 'x', days: 3, sessions: {} }]) {
    const g = boot({ stored });
    assert.equal(g.$('goal-min').textContent, '30', `defaults for ${JSON.stringify(stored)}`);
  }
});

test('Space pressed again during the permission prompt does not open a second microphone', async () => {
  const g = boot({ mic: 'hold' });
  g.space();
  g.space();
  g.$('toggle').click();
  assert.equal(g.media.calls, 1);
  assert.equal(g.contexts.length, 1);
  assert.equal(g.$('status-label').textContent, 'Waiting for the microphone…');
  g.pending[0]();
  await flush();
  assert.equal(g.$('toggle').textContent, 'Stop');
  g.space();
  assert.equal(g.liveTracks(), 0, 'one Stop releases the only stream');
});

test('the Start button stays focusable while the microphone starts', async () => {
  const g = boot({ mic: 'hold' });
  g.$('toggle').click();
  assert.equal(g.$('toggle').disabled, false);
  assert.equal(g.$('toggle').getAttribute('aria-disabled'), 'true');
  g.pending[0]();
  await flush();
  assert.equal(g.$('toggle').getAttribute('aria-disabled'), null);
});

test('a refused microphone explains itself and can be tried again', async () => {
  for (const [name, text] of [['NotAllowedError', /access was blocked/], ['NotFoundError', /No microphone/], ['NotReadableError', /busy/], ['AbortError', /could not be started/]]) {
    const g = boot({ mic: name });
    g.$('toggle').click();
    await flush();
    assert.match(g.$('notice').textContent, text);
    assert.equal(g.$('notice').hidden, false);
    assert.equal(g.$('toggle').textContent, 'Start');
    assert.equal(g.$('status-label').textContent, 'Ready');
    assert.equal(g.contexts[0].state, 'closed');
    g.$('toggle').click();
    assert.equal(g.media.calls, 2);
  }
});

test('a failure after the microphone was granted still switches it off', async () => {
  const g = boot();
  // Firefox throws here when the microphone and the context use different sample rates.
  const original = FakeContext.prototype.createMediaStreamSource;
  FakeContext.prototype.createMediaStreamSource = () => { throw Object.assign(new Error('sample rate'), { name: 'NotSupportedError' }); };
  g.$('toggle').click();
  await flush();
  FakeContext.prototype.createMediaStreamSource = original;
  assert.equal(g.streams.length, 1);
  assert.equal(g.liveTracks(), 0);
  assert.match(g.$('notice').textContent, /could not be started/);
  assert.equal(g.$('toggle').textContent, 'Start');
});

test('a browser refusing the audio context gets a notice, not a dead button', () => {
  const g = boot();
  FakeContext.failNew = true;
  g.$('toggle').click();
  assert.match(g.$('notice').textContent, /could not be started/);
  assert.equal(g.media.calls, 0);
  assert.equal(g.$('toggle').getAttribute('aria-disabled'), null);
});

test('Stop clears the level meter and keeps the clock', async () => {
  const g = boot();
  g.$('toggle').click();
  await flush();
  g.run(2500, QUIET);
  g.run(3000, LOUD);
  assert.equal(g.$('meter-threshold').hidden, false);
  g.$('toggle').click();
  assert.equal(g.$('meter-fill').style.transform, 'scaleX(0)');
  assert.equal(g.$('meter-threshold').hidden, true);
  assert.equal(g.$('meter').getAttribute('aria-valuetext'), 'No input');
  assert.notEqual(g.$('clock').textContent, '00:00:00');
});

test('clearing the goal field keeps the goal', () => {
  const g = boot({ stored: { settings: { goalMin: 45 } } });
  g.$('goal').value = '';
  g.$('goal').emit('change');
  assert.equal(g.$('goal').value, 45);
  assert.equal(g.saved().settings.goalMin, 45);
});

test('the goal field accepts its own default, so 30 is not a step mismatch', () => {
  const input = /<input[^>]*id="goal"[^>]*>/.exec(html)[0];
  const [min, step, value] = ['min', 'step', 'value'].map((k) => Number(new RegExp(`${k}="(\\d+)"`).exec(input)[1]));
  assert.equal((value - min) % step, 0);
});

test('a stale idle tab does not erase a session from another tab', async () => {
  const store = new Map();
  const idle = boot({ store });
  const playing = boot({ store });
  playing.$('toggle').click();
  await flush();
  playing.run(2500, QUIET);
  playing.run(8000, LOUD);
  playing.$('toggle').click();
  const practised = playing.saved().days['2026-11-04'];
  assert.ok(practised > 0);

  // This tab never saw the storage event, as if it had been frozen in the background.
  idle.doc.visibilityState = 'hidden';
  idle.doc.emit('visibilitychange');
  idle.win.emit('pagehide');
  assert.equal(playing.saved().days['2026-11-04'], practised);
});

test('an idle tab shows what another tab saved and keeps it through its own saves', () => {
  const g = boot({ stored: {} });
  const text = JSON.stringify({ settings: { goalMin: 40 }, days: { '2026-11-04': 600000 } });
  g.store.set(KEY, text);
  g.win.emit('storage', { key: KEY, newValue: text });
  assert.equal(g.$('today-min').textContent, '10');
  assert.equal(g.$('goal').value, 40);
  g.$('chime').checked = false;
  g.$('chime').emit('change');
  assert.equal(g.saved().days['2026-11-04'], 600000);
});

test('a running session still saves when the page hides', async () => {
  const g = boot();
  g.$('toggle').click();
  await flush();
  g.run(2500, QUIET);
  g.run(3000, LOUD);
  g.doc.visibilityState = 'hidden';
  g.doc.emit('visibilitychange');
  assert.ok(g.saved().days['2026-11-04'] > 0);
  assert.equal(g.saved().sessions.length, 1);
});

test('demo mode ignores other tabs', () => {
  const g = boot({ search: '?demo' });
  const before = g.$('total-all').textContent;
  g.win.emit('storage', { key: KEY, newValue: JSON.stringify({ days: {} }) });
  assert.equal(g.$('total-all').textContent, before);
});

test('the demo keeps counting after Reset history', () => {
  const g = boot({ search: '?demo' });
  g.$('reset').click();
  const frame = [...g.intervals.values()].find((t) => t.ms === 40).fn;
  frame();
  g.$('goal').value = '35';
  g.$('goal').emit('change');
  assert.doesNotMatch(g.$('total-all').textContent, /NaN/);
  assert.doesNotMatch(g.$('history-total').textContent, /NaN/);
});

test('a wake lock that arrives after Stop is released', async () => {
  let released = 0;
  let grant;
  const lock = Object.assign(new Emitter(), { release() { released++; return Promise.resolve(); } });
  const g = boot({ wakeLock: { request: () => new Promise((resolve) => { grant = () => resolve(lock); }) } });
  g.$('toggle').click();
  await flush();
  g.$('toggle').click();
  grant();
  await flush();
  assert.equal(released, 1);
});

// ---- tests end ----

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
