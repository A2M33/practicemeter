// Run with: node tests/history.test.mjs
import assert from 'node:assert/strict';
import history from '../history.js';

const { STORAGE_KEY, LEGACY_KEY, load, normalise, totals, toCsv, parseCsv, mergeDays, dayKey, addDays } = history;

const storage = (items) => (key) => (key in items ? items[key] : null);

const V1 = {
  version: 1,
  settings: { sensitivity: 70, graceS: 5, goalMin: 45 },
  days: { '2026-10-01': 1800000, '2026-10-02': 2712345, 'junk': 5, '2026-10-03': -1 },
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('version 1 data migrates without losing days or settings', () => {
  const { data, migrated } = load(storage({ [LEGACY_KEY]: JSON.stringify(V1) }));
  assert.equal(migrated, true);
  assert.equal(data.version, 2);
  assert.deepEqual(data.days, { '2026-10-01': 1800000, '2026-10-02': 2712345 });
  assert.deepEqual(data.settings, { sensitivity: 70, graceS: 5, goalMin: 45, chime: true });
  assert.deepEqual(data.sessions, []);
});

test('version 2 data wins over the old key', () => {
  const v2 = { version: 2, settings: { goalMin: 20, chime: false }, days: { '2026-10-05': 60000 }, sessions: [] };
  const { data, migrated } = load(storage({ [STORAGE_KEY]: JSON.stringify(v2), [LEGACY_KEY]: JSON.stringify(V1) }));
  assert.equal(migrated, false);
  assert.deepEqual(data.days, { '2026-10-05': 60000 });
  assert.equal(data.settings.goalMin, 20);
  assert.equal(data.settings.chime, false);
});

test('missing or corrupt storage gives defaults', () => {
  assert.equal(load(storage({})).data.settings.goalMin, 30);
  const { data, migrated } = load(storage({ [LEGACY_KEY]: '{not json' }));
  assert.equal(migrated, false);
  assert.deepEqual(data.days, {});
});

test('sessions are validated, deduplicated and sorted', () => {
  const d = normalise({
    sessions: [
      { start: 3000, lengthMs: 600000, playedMs: 420000 },
      { start: 1000, lengthMs: 900000, playedMs: 600000 },
      { start: 1000, lengthMs: 900000, playedMs: 600000 }, // duplicate
      { start: 2000, lengthMs: 5000, playedMs: 0 },        // nothing played
      { start: 'x', lengthMs: 1, playedMs: 1 },
      null,
    ],
  });
  assert.deepEqual(d.sessions.map((s) => s.start), [1000, 3000]);
});

test('totals cover the last 7 days, the last 30 days and all time', () => {
  const now = new Date(2026, 9, 29, 12, 0);
  const days = {};
  days[dayKey(now)] = 10;
  days[dayKey(addDays(now, -6))] = 20;   // inside the week
  days[dayKey(addDays(now, -7))] = 40;   // outside the week, inside the month
  days[dayKey(addDays(now, -29))] = 80;  // last day of the month window
  days[dayKey(addDays(now, -30))] = 160; // all time only
  assert.deepEqual(totals(days, now), { week: 30, month: 150, all: 310 });
});

test('exported CSV imports back to the same days', () => {
  const data = normalise(V1);
  const csv = toCsv(data);
  assert.ok(csv.startsWith('date,minutes,goal_minutes,goal_met\n'));
  const parsed = parseCsv(csv);
  assert.equal(parsed.rows, 2);
  assert.equal(parsed.skipped, 0);
  for (const k of Object.keys(data.days)) {
    assert.ok(Math.abs(parsed.days[k] - data.days[k]) <= 3000, `${k} within rounding`);
  }
});

test('CSV import tolerates CRLF, a BOM, blank lines and junk rows', () => {
  const parsed = parseCsv('﻿date,minutes,goal_minutes,goal_met\r\n2026-10-01,30.5,30,yes\r\n\r\nhello,world\r\n2026-13-99x,5\r\n2026-10-02,,30,no\r\n2026-10-03,12,30,no\r\n');
  assert.deepEqual(parsed.days, { '2026-10-01': 1830000, '2026-10-03': 720000 });
  assert.equal(parsed.rows, 2);
  assert.equal(parsed.skipped, 3);
});

test('merging keeps the larger total, so a second import changes nothing', () => {
  const days = { '2026-10-01': 1900000, '2026-10-02': 600000 };
  const imported = { '2026-10-01': 1800000, '2026-10-02': 900000, '2026-10-04': 300000 };
  assert.equal(mergeDays(days, imported), 2);
  assert.deepEqual(days, { '2026-10-01': 1900000, '2026-10-02': 900000, '2026-10-04': 300000 });
  assert.equal(mergeDays(days, imported), 0);
});

test('empty values fall back instead of counting as zero', () => {
  assert.equal(history.clampNum('', 1, 600, 45), 45);
  assert.equal(history.clampNum('  ', 1, 600, 45), 45);
  assert.equal(history.clampNum(null, 0, 100, 50), 50);
  assert.equal(history.clampNum('0', 0, 100, 50), 0);
  assert.equal(normalise({ settings: { sensitivity: null, goalMin: '' } }).settings.sensitivity, 50);
  assert.equal(normalise({ settings: { sensitivity: null, goalMin: '' } }).settings.goalMin, 30);
});

test('saved data that would print as NaN or Invalid Date is dropped', () => {
  const d = normalise({
    settings: { goalMin: 22.5 },
    days: { '2026-02-31': 60000, '2026-13-01': 60000, '2026-10-01': 1e999, '2026-10-02': 60000 },
    sessions: [
      { start: 1e999, lengthMs: 1, playedMs: 1 },
      { start: 9e15, lengthMs: 1, playedMs: 1 },
      { start: 1000, lengthMs: 1, playedMs: 1e999 },
      { start: 2000, lengthMs: 5, playedMs: 4 },
    ],
  });
  assert.deepEqual(d.days, { '2026-10-02': 60000 });
  assert.deepEqual(d.sessions.map((s) => s.start), [2000]);
  assert.equal(d.settings.goalMin, 23);
});

test('CSV import skips dates that do not exist', () => {
  const parsed = parseCsv('2026-02-31,10\n2026-02-28,10\n');
  assert.deepEqual(parsed.days, { '2026-02-28': 600000 });
  assert.equal(parsed.skipped, 1);
});

test('CSV from a German spreadsheet keeps its decimals', () => {
  const parsed = parseCsv('date;minutes;goal_minutes;goal_met\n2026-10-01;30,5;30;yes\n2026-10-02\t12,25\t30\tno\n');
  assert.deepEqual(parsed.days, { '2026-10-01': 1830000, '2026-10-02': 735000 });
  assert.equal(parsed.skipped, 0);
});

test('durations carry over instead of showing 60', () => {
  assert.equal(history.hoursMinutes(119.7), '2 h 0 min');
  assert.equal(history.hoursMinutes(59.6), '1 h 0 min');
  assert.equal(history.hoursMinutes(65), '1 h 5 min');
  assert.equal(history.hoursMinutes(26), '26 min');
  assert.equal(history.shortDuration(59600), '59 s');
  assert.equal(history.shortDuration(0), '0 min');
  assert.equal(history.shortDuration(45000), '45 s');
  assert.equal(history.shortDuration(3900000), '1 h 5 min');
});

test('an idle tab takes what another tab saved', () => {
  const mine = normalise({ days: { '2026-10-01': 1000 } });
  const text = JSON.stringify({ settings: { goalMin: 40 }, days: { '2026-10-02': 2000 } });
  const d = history.adopt(mine, text, null);
  assert.deepEqual(d.days, { '2026-10-02': 2000 });
  assert.equal(d.settings.goalMin, 40);
});

test('a tab in a session keeps its running time when another tab saves', () => {
  const running = { start: 5000, lengthMs: 90000, playedMs: 60000 };
  const mine = normalise({ days: { '2026-10-01': 60000 } });
  mine.sessions.push(running);
  const text = JSON.stringify({
    days: { '2026-10-01': 1000, '2026-09-30': 2000 },
    sessions: [{ start: 1000, lengthMs: 3, playedMs: 2 }, { start: 5000, lengthMs: 3, playedMs: 2 }],
  });
  const d = history.adopt(mine, text, running);
  assert.deepEqual(d.days, { '2026-10-01': 60000, '2026-09-30': 2000 });
  assert.equal(d.sessions.length, 2);
  assert.equal(d.sessions[1], running, 'the same object, so the session keeps updating it');
});

test('a junk storage event changes nothing', () => {
  const mine = normalise({ days: { '2026-10-01': 1000 } });
  assert.equal(history.adopt(mine, '{not json', null), mine);
  assert.equal(history.adopt(mine, null, null), mine);
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
