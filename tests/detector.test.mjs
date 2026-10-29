// Run with: node tests/detector.test.mjs
import assert from 'node:assert/strict';
import detector from '../detector.js';

const { Detector, rmsDb, sensitivityToThreshold } = detector;

const FRAME_MS = 40; // 25 Hz, like the app
const ROOM_DB = -70;
const TONE_DB = -30;

// Deterministic jitter so runs are repeatable.
function makeJitter(seed = 12345, amp = 1.5) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return (s / 2147483648 - 0.5) * 2 * amp;
  };
}

// Simulates a session. segments: [{ ms, db }], played back to back after start.
function simulate(segments, opts = {}) {
  const det = new Detector(opts);
  const jitter = makeJitter();
  let t = 1000;
  det.start(t);
  const timeline = [];
  let state = det.snapshot();
  for (const seg of segments) {
    const end = t + seg.ms;
    while (t < end) {
      t += FRAME_MS;
      state = det.update(seg.db + jitter(), t);
      timeline.push({ t, ...state });
    }
  }
  return { det, state, timeline };
}

const calibrate = { ms: 2500, db: ROOM_DB };
const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: expected ~${expected}, got ${actual}`);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('silence never counts', () => {
  const { state, timeline } = simulate([calibrate, { ms: 60000, db: ROOM_DB }]);
  assert.equal(state.practicedMs, 0);
  assert.ok(timeline.every((f) => !f.playing), 'never entered playing');
});

test('steady tone counts', () => {
  const { state } = simulate([calibrate, { ms: 20000, db: TONE_DB }, { ms: 500, db: ROOM_DB }]);
  near(state.practicedMs, 20000, 200, 'practiced');
});

test('pause shorter than the grace period counts', () => {
  const { state } = simulate([
    calibrate,
    { ms: 5000, db: TONE_DB },
    { ms: 2000, db: ROOM_DB },
    { ms: 5000, db: TONE_DB },
    { ms: 200, db: ROOM_DB },
  ]);
  near(state.practicedMs, 12000, 200, 'practiced incl. short pause');
});

test('pause longer than the grace period does not count', () => {
  const { state, timeline } = simulate([
    calibrate,
    { ms: 5000, db: TONE_DB },
    { ms: 6000, db: ROOM_DB },
    { ms: 5000, db: TONE_DB },
    { ms: 200, db: ROOM_DB },
  ]);
  near(state.practicedMs, 10000, 200, 'practiced excl. long pause');
  assert.ok(timeline.some((f) => f.status === 'paused' && f.t > 1000 + 2500 + 5000 + 3000),
    'clock paused during the long silence');
});

test('grace period is adjustable', () => {
  const segs = [calibrate, { ms: 5000, db: TONE_DB }, { ms: 2000, db: ROOM_DB }, { ms: 5000, db: TONE_DB }];
  near(simulate(segs, { graceMs: 1000 }).state.practicedMs, 10000, 200, 'grace 1 s drops a 2 s pause');
  near(simulate(segs, { graceMs: 5000 }).state.practicedMs, 12000, 200, 'grace 5 s keeps a 2 s pause');
});

test('a 50 ms click does not start the clock', () => {
  const segs = [calibrate];
  for (let i = 0; i < 10; i++) segs.push({ ms: 40, db: -15 }, { ms: 1500, db: ROOM_DB });
  // A single 50 ms click spanning two frames.
  segs.push({ ms: 50, db: -15 }, { ms: 4000, db: ROOM_DB });
  const { state, timeline } = simulate(segs);
  assert.equal(state.practicedMs, 0);
  assert.ok(timeline.every((f) => !f.playing), 'clicks never started the clock');
});

test('sound lasting ~150 ms or more does start the clock', () => {
  const { timeline } = simulate([calibrate, { ms: 400, db: TONE_DB }, { ms: 200, db: ROOM_DB }]);
  assert.ok(timeline.some((f) => f.playing), 'started');
});

test('noise floor adapts to a louder room so steady background noise stops counting', () => {
  const NOISE_DB = -45; // a fan switched on right after calibration, 25 dB above the quiet room
  const { state, timeline } = simulate([calibrate, { ms: 90000, db: NOISE_DB }]);
  const tEnd = timeline[timeline.length - 1].t;
  const at = (t) => timeline.find((f) => f.t >= t);
  const lastThirty = state.practicedMs - at(tEnd - 30000).practicedMs;
  assert.equal(lastThirty, 0, 'no practice credited in the last 30 s of steady noise');
  assert.equal(state.status, 'paused');
  assert.ok(state.floorDb > -55, `floor rose towards the noise (floor ${state.floorDb.toFixed(1)} dB)`);
});

test('real practice with short breaths keeps counting for minutes', () => {
  const segs = [calibrate];
  for (let i = 0; i < 26; i++) segs.push({ ms: 6000, db: TONE_DB }, { ms: 1000, db: ROOM_DB });
  const { state } = simulate(segs);
  const played = 26 * 7000 - 1000; // the final breath is not followed by playing
  assert.ok(state.practicedMs >= played * 0.98, `practiced ${state.practicedMs} of ${played}`);
});

test('legato playing whose breaths never reach the room level keeps counting', () => {
  // Regression: the 5th-percentile floor used to climb to the playing level after ~40 s
  // because the short breaths (only 20 dB above the room) were too rare to pull it down.
  const segs = [calibrate];
  for (let i = 0; i < 30; i++) segs.push({ ms: 5700, db: TONE_DB }, { ms: 300, db: -50 });
  const { state, timeline } = simulate(segs);
  const played = 30 * 6000;
  assert.ok(state.practicedMs >= played * 0.98, `practiced ${state.practicedMs} of ${played}`);
  assert.ok(state.floorDb < -60, `floor stayed near the room (floor ${state.floorDb.toFixed(1)} dB)`);
  assert.ok(timeline.filter((f) => f.t > 1000 + 2500 + 1000).every((f) => f.playing), 'never paused');
});

test('steady hum that starts while playing is still rejected', () => {
  // A held drone right after calibration enters "playing" at once; it must still stop counting.
  const { state, timeline } = simulate([calibrate, { ms: 120000, db: -35 }]);
  const tEnd = timeline[timeline.length - 1].t;
  const at = (t) => timeline.find((f) => f.t >= t);
  assert.equal(state.practicedMs - at(tEnd - 30000).practicedMs, 0, 'no practice in the last 30 s');
  assert.equal(state.status, 'paused');
});

test('calibration while already playing recovers once the player pauses', () => {
  const { state } = simulate([
    { ms: 2500, db: TONE_DB },
    { ms: 4000, db: ROOM_DB },
    { ms: 10000, db: TONE_DB },
    { ms: 200, db: ROOM_DB },
  ]);
  near(state.practicedMs, 10000, 300, 'counts after the floor drops');
});

test('rmsDb and sensitivity helpers', () => {
  assert.equal(rmsDb(new Float32Array(1024)), -100);
  const sine = Float32Array.from({ length: 4800 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / 48000));
  near(rmsDb(sine), -3.01, 0.05, 'full-scale sine');
  assert.ok(sensitivityToThreshold(0) > sensitivityToThreshold(50));
  assert.ok(sensitivityToThreshold(50) > sensitivityToThreshold(100));
  assert.equal(sensitivityToThreshold(50), 15);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
