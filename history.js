/*
 * practicemeter history: the saved data format, migration from older versions, totals and
 * CSV export/import.
 *
 * Pure logic. No DOM and no direct localStorage access: load() takes a getItem function,
 * so the Node tests can feed it anything. Loads as a plain browser script
 * (window.PracticeMeterHistory) and as a CommonJS module.
 *
 * Format (version 2, key practicemeter.v2):
 *   { version: 2,
 *     settings: { sensitivity, graceS, goalMin, chime },
 *     days: { 'YYYY-MM-DD': practicedMs },               // source of truth for daily totals
 *     sessions: [{ start: epochMs, lengthMs, playedMs }] // oldest first
 *   }
 * Version 1 (key practicemeter.v1) had settings and days only. load() reads it when no
 * version 2 data exists yet and leaves the old key alone, so nothing is lost.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.PracticeMeterHistory = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STORAGE_KEY = 'practicemeter.v2';
  var LEGACY_KEY = 'practicemeter.v1';
  var MAX_SESSIONS = 2000;
  var CSV_HEADER = 'date,minutes,goal_minutes,goal_met';
  var DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /** Local calendar day, 'YYYY-MM-DD'. */
  function dayKey(date) {
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  /** Midnight of the day n days from date (local time). */
  function addDays(date, n) {
    var d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() + n);
    return d;
  }

  function clampNum(v, lo, hi, fallback) {
    v = Number(v);
    if (!isFinite(v)) return fallback;
    return Math.min(hi, Math.max(lo, v));
  }

  function defaultData() {
    return {
      version: 2,
      settings: { sensitivity: 50, graceS: 3, goalMin: 30, chime: true },
      days: {},
      sessions: []
    };
  }

  /** Accepts version 1 or 2 data (or junk) and returns valid version 2 data. */
  function normalise(raw) {
    var d = defaultData();
    if (!raw || typeof raw !== 'object') return d;
    var s = raw.settings || {};
    d.settings.sensitivity = clampNum(s.sensitivity, 0, 100, 50);
    d.settings.graceS = clampNum(s.graceS, 1, 10, 3);
    d.settings.goalMin = clampNum(s.goalMin, 1, 600, 30);
    d.settings.chime = s.chime !== false;

    var days = raw.days || {};
    Object.keys(days).forEach(function (k) {
      if (DAY_RE.test(k) && Number(days[k]) > 0) d.days[k] = Number(days[k]);
    });

    var seen = {};
    (Array.isArray(raw.sessions) ? raw.sessions : []).forEach(function (x) {
      if (!x || typeof x !== 'object') return;
      var start = Number(x.start);
      var played = Number(x.playedMs);
      var length = Number(x.lengthMs);
      // Sessions where nothing was played (or a tab closed mid-calibration) are dropped.
      if (!(start > 0) || !(played > 0) || !isFinite(length) || seen[start]) return;
      seen[start] = true;
      d.sessions.push({ start: start, lengthMs: Math.max(length, played), playedMs: played });
    });
    d.sessions.sort(function (a, b) { return a.start - b.start; });
    if (d.sessions.length > MAX_SESSIONS) d.sessions = d.sessions.slice(-MAX_SESSIONS);
    return d;
  }

  function parse(text) {
    if (typeof text !== 'string' || !text) return null;
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  /**
   * Reads saved data. getItem(key) returns the stored string or null.
   * @returns {{data: object, migrated: boolean}} migrated is true when the data came from
   *   the version 1 key and should be saved under the new key.
   */
  function load(getItem) {
    var current = parse(getItem(STORAGE_KEY));
    if (current) return { data: normalise(current), migrated: false };
    var legacy = parse(getItem(LEGACY_KEY));
    if (legacy) return { data: normalise(legacy), migrated: true };
    return { data: defaultData(), migrated: false };
  }

  /** Practice time over the last 7 and 30 days (today included) and all time, in ms. */
  function totals(days, now) {
    var week = 0;
    var month = 0;
    var all = 0;
    var weekFrom = dayKey(addDays(now, -6));
    var monthFrom = dayKey(addDays(now, -29));
    var today = dayKey(now);
    Object.keys(days).forEach(function (k) {
      var ms = days[k];
      all += ms;
      if (k > today) return; // clock changes can leave future days; count them in all time only
      if (k >= monthFrom) month += ms;
      if (k >= weekFrom) week += ms;
    });
    return { week: week, month: month, all: all };
  }

  /** Daily totals as CSV: date,minutes,goal_minutes,goal_met (one line per day). */
  function toCsv(data) {
    var goal = data.settings.goalMin;
    var lines = [CSV_HEADER];
    Object.keys(data.days).sort().forEach(function (k) {
      var min = data.days[k] / 60000;
      lines.push(k + ',' + min.toFixed(1) + ',' + goal + ',' + (min >= goal ? 'yes' : 'no'));
    });
    return lines.join('\n') + '\n';
  }

  /**
   * Reads a CSV written by toCsv. Only the date and minutes columns matter; the header is
   * optional and other lines are skipped.
   * @returns {{days: object, rows: number, skipped: number}}
   */
  function parseCsv(text) {
    var days = {};
    var rows = 0;
    var skipped = 0;
    String(text || '').replace(/^﻿/, '').split(/\r\n|\n|\r/).forEach(function (line, i) {
      line = line.trim();
      if (!line) return;
      var cols = line.split(/[,;\t]/).map(function (c) { return c.trim().replace(/^"|"$/g, ''); });
      if (i === 0 && cols[0].toLowerCase() === 'date') return;
      var min = Number(cols[1]);
      if (!DAY_RE.test(cols[0]) || !isFinite(min) || min < 0 || min > 1440 || cols[1] === '') {
        skipped++;
        return;
      }
      var ms = Math.round(min * 60000);
      days[cols[0]] = Math.max(days[cols[0]] || 0, ms); // a day listed twice is not doubled
      rows++;
    });
    return { days: days, rows: rows, skipped: skipped };
  }

  /**
   * Adds imported daily totals. A day present on both sides keeps the larger total, so
   * importing the same file twice changes nothing. Returns the number of days changed.
   */
  function mergeDays(days, imported) {
    var changed = 0;
    Object.keys(imported).forEach(function (k) {
      var ms = imported[k];
      if (ms > 0 && ms > (days[k] || 0)) {
        days[k] = ms;
        changed++;
      }
    });
    return changed;
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    LEGACY_KEY: LEGACY_KEY,
    dayKey: dayKey,
    addDays: addDays,
    clampNum: clampNum,
    defaultData: defaultData,
    normalise: normalise,
    load: load,
    totals: totals,
    toCsv: toCsv,
    parseCsv: parseCsv,
    mergeDays: mergeDays
  };
}));
