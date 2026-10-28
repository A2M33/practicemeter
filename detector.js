/*
 * practicemeter detector: decides, frame by frame, whether an instrument is sounding
 * and how much practice time that adds up to.
 *
 * Pure logic. No DOM, no Web Audio, no timers: the caller feeds it a level in dB and a
 * timestamp in milliseconds. Loads as a plain browser script (window.PracticeMeterDetector)
 * and as a CommonJS module for the Node tests.
 *
 * Model:
 *  - Noise floor: set from the first ~2 s after start (calibration), then tracked as a low
 *    percentile of the last 30 s of levels. It falls quickly when the room gets quieter and
 *    rises slowly (rate-limited) when the room gets louder, so a fan or traffic hum that
 *    never stops is eventually treated as background.
 *  - Sounding: level above floor + threshold. Once playing, a few dB of hysteresis keeps
 *    soft notes from flickering the state.
 *  - Onset: the level must stay above the trigger for minOnMs (150 ms) before the clock
 *    starts, so a single knock or click is ignored. That onset time is then credited.
 *  - Grace: after the sound stops the clock holds. If playing resumes within graceMs the
 *    gap is credited as practice; if not, the gap is dropped and the state becomes paused.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.PracticeMeterDetector = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MIN_DB = -100;

  var DEFAULTS = {
    thresholdDb: 15,        // how far above the noise floor counts as sounding
    graceMs: 3000,          // pauses up to this long still count
    minOnMs: 150,           // sound must last this long to start the clock
    calibrationMs: 2000,    // initial room measurement
    hysteresisDb: 3,        // trigger is this much lower while already playing
    floorWindowMs: 30000,   // history used for the low-percentile floor estimate
    floorBucketMs: 250,     // levels are averaged into buckets of this length
    floorPercentile: 0.05,  // low percentile of the window that defines the floor
    floorRiseDbPerSec: 2,   // max speed the floor can climb in a louder room
    floorFallTauMs: 500,    // time constant for the floor dropping in a quieter room
    maxStepMs: 2000         // longest single frame gap that is credited (tab throttling)
  };

  function clampDb(db) {
    if (!(db > MIN_DB)) return MIN_DB; // also catches NaN and -Infinity
    return db > 0 ? 0 : db;
  }

  /** RMS level of a block of float samples (-1..1), in dBFS, clamped to [-100, 0]. */
  function rmsDb(samples) {
    var n = samples.length;
    if (!n) return MIN_DB;
    var sum = 0;
    for (var i = 0; i < n; i++) sum += samples[i] * samples[i];
    return clampDb(20 * Math.log10(Math.sqrt(sum / n)));
  }

  /** Sensitivity slider 0..100 to a threshold in dB above the floor (24 dB .. 6 dB). */
  function sensitivityToThreshold(sensitivity) {
    var s = Math.max(0, Math.min(100, Number(sensitivity)));
    if (isNaN(s)) s = 50;
    return Math.round((24 - 0.18 * s) * 10) / 10;
  }

  function percentile(values, p) {
    if (!values.length) return MIN_DB;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    return sorted[Math.floor(p * (sorted.length - 1))];
  }

  function Detector(options) {
    this.opts = {};
    var k;
    for (k in DEFAULTS) this.opts[k] = DEFAULTS[k];
    this.configure(options);
    this.reset();
  }

  Detector.prototype.configure = function (options) {
    if (!options) return;
    for (var k in options) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, k) && typeof options[k] === 'number' && !isNaN(options[k])) {
        this.opts[k] = options[k];
      }
    }
  };

  Detector.prototype.reset = function () {
    this.started = false;
    this.startMs = 0;
    this.lastMs = 0;
    this.status = 'idle';
    this.practicedMs = 0;
    this.sessionMs = 0;
    this.levelDb = MIN_DB;
    this.floorDb = MIN_DB;
    this.floorTargetDb = MIN_DB;
    this.calibrated = false;
    this.calSamples = [];
    this.buckets = [];
    this.bucketStart = 0;
    this.bucketSum = 0;
    this.bucketN = 0;
    this.aboveSince = null;
    this.lastAboveMs = 0;
  };

  Detector.prototype.start = function (nowMs) {
    this.reset();
    this.started = true;
    this.startMs = nowMs;
    this.lastMs = nowMs;
    this.bucketStart = nowMs;
    this.status = 'calibrating';
    return this.snapshot();
  };

  Detector.prototype._pushBucket = function (nowMs) {
    var o = this.opts;
    if (this.bucketN) {
      this.buckets.push({ t: nowMs, db: this.bucketSum / this.bucketN });
    }
    this.bucketStart = nowMs;
    this.bucketSum = 0;
    this.bucketN = 0;
    var cutoff = nowMs - o.floorWindowMs;
    while (this.buckets.length && this.buckets[0].t < cutoff) this.buckets.shift();
    this.floorTargetDb = percentile(this.buckets.map(function (b) { return b.db; }), o.floorPercentile);
  };

  Detector.prototype._trackFloor = function (level, nowMs, dt) {
    var o = this.opts;
    this.bucketSum += level;
    this.bucketN++;
    if (nowMs - this.bucketStart >= o.floorBucketMs) this._pushBucket(nowMs);

    if (level < this.floorDb) {
      // Quieter room: follow down quickly (smoothed, so one dropout frame does little).
      this.floorDb += (level - this.floorDb) * (1 - Math.exp(-dt / o.floorFallTauMs));
    } else {
      // Louder room: only once a full window of history exists, and only slowly.
      var fullWindow = this.buckets.length >= 0.9 * (o.floorWindowMs / o.floorBucketMs);
      if (fullWindow && this.floorTargetDb > this.floorDb) {
        this.floorDb = Math.min(this.floorTargetDb, this.floorDb + o.floorRiseDbPerSec * dt / 1000);
      }
    }
    if (this.floorDb > -10) this.floorDb = -10;
  };

  /**
   * Feed one analysis frame.
   * @param {number} levelDb  RMS level of the frame in dBFS
   * @param {number} nowMs    monotonic timestamp in ms
   * @returns {{status:string, playing:boolean, holding:boolean, calibrating:boolean,
   *            practicedMs:number, sessionMs:number, levelDb:number, floorDb:number, triggerDb:number}}
   *   status is 'calibrating' | 'playing' | 'holding' (inside the grace period) | 'paused'.
   *   playing is true while playing or holding, i.e. while the clock is not paused.
   */
  Detector.prototype.update = function (levelDb, nowMs) {
    var o = this.opts;
    if (!this.started) this.start(nowMs);

    var dt = nowMs - this.lastMs;
    if (!(dt > 0)) dt = 0;
    this.lastMs = nowMs;
    var step = Math.min(dt, o.maxStepMs);
    var level = clampDb(levelDb);
    this.levelDb = level;
    this.sessionMs = Math.max(0, nowMs - this.startMs);

    if (!this.calibrated) {
      this.calSamples.push(level);
      this.bucketSum += level;
      this.bucketN++;
      if (nowMs - this.bucketStart >= o.floorBucketMs) this._pushBucket(nowMs);
      if (this.sessionMs < o.calibrationMs) {
        this.status = 'calibrating';
        return this.snapshot();
      }
      this.calibrated = true;
      this.floorDb = percentile(this.calSamples, 0.2);
      this.calSamples = [];
      this.status = 'paused';
      return this.snapshot();
    }

    this._trackFloor(level, nowMs, dt);

    var active = this.status === 'playing' || this.status === 'holding';
    var trigger = this.floorDb + o.thresholdDb - (active ? o.hysteresisDb : 0);
    var above = level > trigger;

    if (this.status === 'holding' && nowMs - this.lastAboveMs > o.graceMs) {
      this.status = 'paused';
      this.aboveSince = null;
      // Re-evaluate against the non-hysteresis trigger.
      above = level > this.floorDb + o.thresholdDb;
    }

    switch (this.status) {
      case 'paused':
        if (above) {
          if (this.aboveSince === null) this.aboveSince = nowMs;
          if (nowMs - this.aboveSince >= o.minOnMs) {
            this.status = 'playing';
            this.practicedMs += nowMs - this.aboveSince;
            this.lastAboveMs = nowMs;
          }
        } else {
          this.aboveSince = null;
        }
        break;
      case 'playing':
        if (above) {
          this.practicedMs += step;
          this.lastAboveMs = nowMs;
        } else {
          this.status = 'holding';
        }
        break;
      case 'holding':
        if (above) {
          // Back within the grace period: the gap counts.
          this.practicedMs += Math.min(nowMs - this.lastAboveMs, o.graceMs);
          this.lastAboveMs = nowMs;
          this.status = 'playing';
        }
        break;
    }
    return this.snapshot();
  };

  /** Final snapshot; time held in an unfinished grace period is not credited. */
  Detector.prototype.stop = function (nowMs) {
    if (this.started && typeof nowMs === 'number') this.sessionMs = Math.max(0, nowMs - this.startMs);
    this.started = false;
    this.status = 'idle';
    return this.snapshot();
  };

  Detector.prototype.snapshot = function () {
    var active = this.status === 'playing' || this.status === 'holding';
    return {
      status: this.status,
      playing: active,
      holding: this.status === 'holding',
      calibrating: this.status === 'calibrating',
      practicedMs: this.practicedMs,
      sessionMs: this.sessionMs,
      levelDb: this.levelDb,
      floorDb: this.floorDb,
      triggerDb: this.calibrated
        ? this.floorDb + this.opts.thresholdDb - (active ? this.opts.hysteresisDb : 0)
        : null
    };
  };

  return {
    Detector: Detector,
    DEFAULTS: DEFAULTS,
    MIN_DB: MIN_DB,
    rmsDb: rmsDb,
    sensitivityToThreshold: sensitivityToThreshold
  };
}));
