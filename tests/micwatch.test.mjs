// Run with: node tests/micwatch.test.mjs
import assert from 'node:assert/strict';
import micwatch from '../micwatch.js';

const { watch } = micwatch;

// Minimal stand-ins for a MediaStream and an AudioContext.
function fakes({ resume = () => Promise.resolve() } = {}) {
  const track = new EventTarget();
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  const ctx = new EventTarget();
  ctx.state = 'running';
  ctx.resume = resume;
  const setState = (s) => { ctx.state = s; ctx.dispatchEvent(new Event('statechange')); };
  const calls = [];
  const unwatch = watch(stream, ctx, (reason) => calls.push(reason));
  return { track, ctx, setState, calls, unwatch };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('an unplugged microphone (track ended) is reported once', () => {
  const f = fakes();
  f.track.dispatchEvent(new Event('ended'));
  f.track.dispatchEvent(new Event('ended'));
  f.setState('closed');
  assert.deepEqual(f.calls, ['ended']);
});

test('a call taking the audio (interrupted) is reported', () => {
  const f = fakes();
  f.setState('interrupted');
  assert.deepEqual(f.calls, ['interrupted']);
});

test('a context closed by the browser is reported', () => {
  const f = fakes();
  f.setState('closed');
  assert.deepEqual(f.calls, ['closed']);
});

test('a suspended context that resumes is not a loss', async () => {
  const f = fakes();
  f.setState('suspended');
  await tick();
  f.setState('running');
  assert.deepEqual(f.calls, []);
});

test('a suspended context that refuses to resume is reported', async () => {
  const f = fakes({ resume: () => Promise.reject(new Error('busy')) });
  f.setState('suspended');
  await tick();
  assert.deepEqual(f.calls, ['suspended']);
});

test('after unwatch, our own stop and close are not reported', () => {
  const f = fakes();
  f.unwatch();
  f.track.dispatchEvent(new Event('ended'));
  f.setState('closed');
  assert.deepEqual(f.calls, []);
});

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
