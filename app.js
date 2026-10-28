/*
 * practicemeter app: microphone, storage and UI.
 * Plain script (no modules) so the page also works when opened from disk.
 *
 * Demo mode: open index.html?demo to see the app with sample history and a session that
 * looks like it is running. Demo mode never asks for the microphone, never reads the real
 * stored history and never writes to localStorage. It exists for screenshots and for trying
 * the interface without an instrument.
 */
(function () {
  'use strict';

  var D = window.PracticeMeterDetector;
  var STORAGE_KEY = 'practicemeter.v1';
  var TICK_MS = 40;              // ~25 analysis frames per second
  var SAVE_EVERY_MS = 5000;
  var METER_MIN_DB = -90;
  var RING_C = 2 * Math.PI * 52; // circumference of the goal ring
  var DEMO = /[?&]demo(?:[=&]|$)/.test(window.location.search);

  function $(id) { return document.getElementById(id); }

  var el = {
    stage: $('stage'),
    statusLabel: $('status-label'),
    clock: $('clock'),
    sessionTime: $('session-time'),
    efficiency: $('efficiency'),
    todayShort: $('today-short'),
    meter: $('meter'),
    meterFill: $('meter-fill'),
    meterFloor: $('meter-floor'),
    meterThreshold: $('meter-threshold'),
    toggle: $('toggle'),
    notice: $('notice'),
    ringValue: $('ring-value'),
    todayMin: $('today-min'),
    goalMin: $('goal-min'),
    goalProgress: $('goal-progress'),
    streak: $('streak'),
    bars: $('bars'),
    goalLine: $('goal-line'),
    historyTotal: $('history-total'),
    sensitivity: $('sensitivity'),
    sensitivityOut: $('sensitivity-out'),
    grace: $('grace'),
    graceOut: $('grace-out'),
    goal: $('goal'),
    exportBtn: $('export'),
    resetBtn: $('reset')
  };

  /* ---------- dates and formatting ---------- */

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function dayKey(date) {
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  function addDays(date, n) {
    var d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() + n);
    return d;
  }

  function hms(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60);
  }

  function hoursMinutes(min) {
    var h = Math.floor(min / 60);
    var m = Math.round(min % 60);
    return h ? h + ' h ' + m + ' min' : m + ' min';
  }

  /* ---------- storage ---------- */

  function defaultData() {
    return { version: 1, settings: { sensitivity: 50, graceS: 3, goalMin: 30 }, days: {} };
  }

  function clampNum(v, lo, hi, fallback) {
    v = Number(v);
    if (!isFinite(v)) return fallback;
    return Math.min(hi, Math.max(lo, v));
  }

  function normalise(raw) {
    var d = defaultData();
    if (!raw || typeof raw !== 'object') return d;
    var s = raw.settings || {};
    d.settings.sensitivity = clampNum(s.sensitivity, 0, 100, 50);
    d.settings.graceS = clampNum(s.graceS, 1, 10, 3);
    d.settings.goalMin = clampNum(s.goalMin, 1, 600, 30);
    var days = raw.days || {};
    Object.keys(days).forEach(function (k) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && Number(days[k]) > 0) d.days[k] = Number(days[k]);
    });
    return d;
  }

  function load() {
    if (DEMO) return demoData();
    try {
      return normalise(JSON.parse(window.localStorage.getItem(STORAGE_KEY)));
    } catch (e) {
      return defaultData();
    }
  }

  function save() {
    if (DEMO) return; // demo state is in memory only
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) { /* storage full or blocked: keep running */ }
  }

  var data = load();

  /* ---------- notices ---------- */

  function showNotice(text) {
    el.notice.textContent = text;
    el.notice.hidden = false;
  }

  function hideNotice() {
    el.notice.hidden = true;
    el.notice.textContent = '';
  }

  /* ---------- live display ---------- */

  var STATUS_TEXT = {
    idle: 'Ready',
    stopped: 'Stopped',
    calibrating: 'Listening to the room…',
    playing: 'Playing',
    holding: 'Short pause',
    paused: 'Paused, waiting for sound'
  };
  var shownStatus = null;

  function setStatus(status) {
    if (status === shownStatus) return;
    shownStatus = status;
    el.stage.setAttribute('data-status', status === 'stopped' ? 'idle' : status);
    el.statusLabel.textContent = STATUS_TEXT[status] || status;
  }

  function meterPct(db) {
    return Math.max(0, Math.min(1, (db - METER_MIN_DB) / -METER_MIN_DB));
  }

  function renderLive(st) {
    setStatus(st.status);
    el.clock.textContent = hms(st.practicedMs);
    el.sessionTime.textContent = hms(st.sessionMs);
    el.efficiency.textContent = st.sessionMs >= 5000
      ? Math.round(100 * Math.min(1, st.practicedMs / st.sessionMs)) + '%'
      : '–';

    var level = st.levelDb;
    el.meterFill.style.transform = 'scaleX(' + meterPct(level).toFixed(3) + ')';
    el.meter.setAttribute('aria-valuenow', String(Math.round(Math.max(METER_MIN_DB, level))));
    if (st.triggerDb !== null && st.triggerDb !== undefined) {
      el.meterThreshold.hidden = false;
      el.meterFloor.hidden = false;
      el.meterThreshold.style.left = (meterPct(st.triggerDb) * 100).toFixed(2) + '%';
      el.meterFloor.style.left = (meterPct(st.floorDb) * 100).toFixed(2) + '%';
      el.meter.setAttribute('aria-valuetext', Math.round(level) + ' dB, ' +
        (level > st.triggerDb ? 'above' : 'below') + ' the playing threshold');
    } else {
      el.meter.setAttribute('aria-valuetext', Math.round(level) + ' dB');
    }
  }

  /* ---------- daily goal, streak, history ---------- */

  function goalMs() { return data.settings.goalMin * 60000; }
  function msOn(date) { return data.days[dayKey(date)] || 0; }

  function streakInfo() {
    var today = new Date();
    var metToday = msOn(today) >= goalMs();
    var d = metToday ? today : addDays(today, -1);
    var n = 0;
    while (msOn(d) >= goalMs() && n < 3660) { n++; d = addDays(d, -1); }
    return { days: n, metToday: metToday };
  }

  var lastDailyKey = '';

  function renderDaily(force) {
    var todayMs = msOn(new Date());
    var key = dayKey(new Date()) + '|' + Math.floor(todayMs / 60000) + '|' + data.settings.goalMin;
    if (!force && key === lastDailyKey) return;
    lastDailyKey = key;
    renderGoal(todayMs);
    renderHistory();
  }

  function renderGoal(todayMs) {
    var goal = data.settings.goalMin;
    var min = Math.floor(todayMs / 60000);
    var frac = Math.min(1, todayMs / goalMs());
    el.todayMin.textContent = String(min);
    el.goalMin.textContent = String(goal);
    el.todayShort.textContent = min + ' min';
    el.ringValue.style.strokeDashoffset = (RING_C * (1 - frac)).toFixed(2);
    el.goalProgress.textContent = frac >= 1
      ? 'Goal reached for today'
      : Math.floor(frac * 100) + '% of your daily goal';

    var s = streakInfo();
    var left = Math.max(1, Math.ceil(goal - todayMs / 60000));
    if (s.days === 0) {
      el.streak.textContent = 'No streak yet. Reach today’s goal to start one.';
    } else if (s.metToday) {
      el.streak.textContent = s.days + '-day streak';
    } else {
      el.streak.textContent = s.days + '-day streak. ' + left + ' more min today keeps it going.';
    }
  }

  function renderHistory() {
    var today = new Date();
    var goal = data.settings.goalMin;
    var days = [];
    var maxMin = goal * 1.25;
    for (var i = 13; i >= 0; i--) {
      var d = addDays(today, -i);
      var min = msOn(d) / 60000;
      days.push({ date: d, min: min, today: i === 0 });
      if (min > maxMin) maxMin = min;
    }

    var frag = document.createDocumentFragment();
    var total = 0;
    var met = 0;
    days.forEach(function (day) {
      var shown = Math.floor(day.min);
      var isMet = day.min >= goal;
      total += day.min;
      if (isMet) met++;

      var li = document.createElement('li');
      if (isMet) li.className = 'met';
      if (day.today) li.className += ' today';

      var sr = document.createElement('span');
      sr.className = 'visually-hidden';
      sr.textContent = day.date.toLocaleDateString('en', { weekday: 'long', day: 'numeric', month: 'short' }) +
        (day.today ? ' (today)' : '') + ': ' + shown + ' minutes' + (isMet ? ', goal met' : '');

      var value = document.createElement('span');
      value.className = 'bar-value';
      value.setAttribute('aria-hidden', 'true');
      value.textContent = String(shown);

      var bar = document.createElement('span');
      bar.className = 'bar';
      bar.setAttribute('aria-hidden', 'true');
      bar.style.setProperty('--f', (day.min / maxMin).toFixed(4));

      var label = document.createElement('span');
      label.className = 'bar-day';
      label.setAttribute('aria-hidden', 'true');
      label.textContent = day.date.toLocaleDateString('en', { weekday: 'narrow' });

      li.title = sr.textContent;
      li.appendChild(sr);
      li.appendChild(value);
      li.appendChild(bar);
      li.appendChild(label);
      frag.appendChild(li);
    });
    el.bars.textContent = '';
    el.bars.appendChild(frag);
    el.goalLine.style.setProperty('--g', (goal / maxMin).toFixed(4));
    el.historyTotal.textContent = hoursMinutes(total) + ' total, goal met on ' + met + ' of 14 days';
  }

  /* ---------- settings ---------- */

  function renderSettings() {
    el.sensitivity.value = data.settings.sensitivity;
    el.sensitivityOut.textContent = String(data.settings.sensitivity);
    el.grace.value = data.settings.graceS;
    el.graceOut.textContent = data.settings.graceS + ' s';
    el.goal.value = data.settings.goalMin;
  }

  function applyDetectorSettings() {
    if (!session) return;
    session.det.configure({
      thresholdDb: D.sensitivityToThreshold(data.settings.sensitivity),
      graceMs: data.settings.graceS * 1000
    });
  }

  el.sensitivity.addEventListener('input', function () {
    data.settings.sensitivity = clampNum(el.sensitivity.value, 0, 100, 50);
    el.sensitivityOut.textContent = String(data.settings.sensitivity);
    applyDetectorSettings();
    save();
  });

  el.grace.addEventListener('input', function () {
    data.settings.graceS = clampNum(el.grace.value, 1, 10, 3);
    el.graceOut.textContent = data.settings.graceS + ' s';
    applyDetectorSettings();
    save();
  });

  el.goal.addEventListener('change', function () {
    data.settings.goalMin = Math.round(clampNum(el.goal.value, 1, 600, 30));
    el.goal.value = data.settings.goalMin;
    save();
    renderDaily(true);
  });

  /* ---------- export and reset ---------- */

  el.exportBtn.addEventListener('click', function () {
    var keys = Object.keys(data.days).sort();
    if (!keys.length) {
      showNotice('Nothing to export yet. Practice totals appear here after your first session.');
      return;
    }
    var goal = data.settings.goalMin;
    var lines = ['date,minutes,goal_minutes,goal_met'];
    keys.forEach(function (k) {
      var min = data.days[k] / 60000;
      lines.push(k + ',' + min.toFixed(1) + ',' + goal + ',' + (min >= goal ? 'yes' : 'no'));
    });
    var blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'practicemeter-' + dayKey(new Date()) + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  });

  el.resetBtn.addEventListener('click', function () {
    if (!window.confirm('Delete all saved practice history? Your settings stay. This cannot be undone.')) return;
    data.days = {};
    save();
    renderDaily(true);
  });

  /* ---------- wake lock ---------- */

  var wakeLock = null;

  function requestWakeLock() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
      lock.addEventListener('release', function () { if (wakeLock === lock) wakeLock = null; });
    }).catch(function () { /* not allowed (battery saver etc.): carry on without it */ });
  }

  function releaseWakeLock() {
    if (wakeLock) {
      var lock = wakeLock;
      wakeLock = null;
      lock.release().catch(function () {});
    }
  }

  /* ---------- microphone session ---------- */

  var session = null;

  function micErrorMessage(err) {
    var name = err && err.name;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
      return 'practicemeter needs the microphone to hear when you play, and access was blocked. ' +
        'Allow the microphone for this page in your browser’s site settings, then press Start again. ' +
        'Nothing is recorded.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No microphone was found. Plug one in or check your system sound settings, then press Start again.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'The microphone is busy in another app. Close that app or call, then press Start again.';
    }
    return 'The microphone could not be started' + (err && err.message ? ' (' + err.message + ')' : '') + '. Please try again.';
  }

  function setRunningUi(running) {
    el.toggle.textContent = running ? 'Stop' : 'Start';
    el.toggle.classList.toggle('running', running);
    el.toggle.setAttribute('aria-label', running ? 'Stop listening' : 'Start listening');
  }

  function start() {
    hideNotice();
    if (DEMO) {
      showNotice('This is the demo with sample data. Open the page without ?demo to use your microphone.');
      return;
    }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !AC) {
      showNotice('This browser won’t share the microphone with this page. Open practicemeter over https ' +
        '(the GitHub Pages address) or from localhost, in a current version of Chrome, Edge, Firefox or Safari.');
      return;
    }

    // Create the audio context inside the click so mobile browsers allow it to run.
    var ctx = new AC();
    el.toggle.disabled = true;
    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    }).then(function (stream) {
      if (ctx.state === 'suspended') ctx.resume().catch(function () {});
      var source = ctx.createMediaStreamSource(stream);
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0;
      source.connect(analyser); // not connected to the speakers: nothing is played back

      var det = new D.Detector({
        thresholdDb: D.sensitivityToThreshold(data.settings.sensitivity),
        graceMs: data.settings.graceS * 1000
      });
      var now = performance.now();
      det.start(now);

      session = {
        stream: stream,
        ctx: ctx,
        source: source,
        analyser: analyser,
        buf: new Float32Array(analyser.fftSize),
        bytes: null,
        det: det,
        lastPracticed: 0,
        lastSave: now,
        timer: setInterval(tick, TICK_MS)
      };
      setRunningUi(true);
      el.toggle.disabled = false;
      requestWakeLock();
      tick();
    }).catch(function (err) {
      ctx.close().catch(function () {});
      el.toggle.disabled = false;
      setRunningUi(false);
      showNotice(micErrorMessage(err));
    });
  }

  function readLevel(s) {
    if (s.analyser.getFloatTimeDomainData) {
      s.analyser.getFloatTimeDomainData(s.buf);
    } else {
      if (!s.bytes) s.bytes = new Uint8Array(s.analyser.fftSize);
      s.analyser.getByteTimeDomainData(s.bytes);
      for (var i = 0; i < s.bytes.length; i++) s.buf[i] = (s.bytes[i] - 128) / 128;
    }
    return D.rmsDb(s.buf);
  }

  function tick() {
    var s = session;
    if (!s) return;
    var now = performance.now();
    var st = s.det.update(readLevel(s), now);

    var delta = st.practicedMs - s.lastPracticed;
    if (delta > 0) {
      var k = dayKey(new Date());
      data.days[k] = (data.days[k] || 0) + delta;
      s.lastPracticed = st.practicedMs;
    }
    renderLive(st);
    renderDaily(false);
    if (now - s.lastSave >= SAVE_EVERY_MS) {
      s.lastSave = now;
      save();
    }
  }

  function stop() {
    var s = session;
    if (!s) return;
    session = null;
    clearInterval(s.timer);
    var st = s.det.stop(performance.now());
    s.stream.getTracks().forEach(function (t) { t.stop(); });
    try { s.source.disconnect(); } catch (e) { /* already gone */ }
    s.ctx.close().catch(function () {});
    releaseWakeLock();
    save();
    setRunningUi(false);
    renderLive(st);
    setStatus('stopped');
    renderDaily(true);
  }

  function toggle() {
    if (session) stop(); else start();
  }

  el.toggle.addEventListener('click', toggle);

  document.addEventListener('keydown', function (e) {
    if (e.code !== 'Space' && e.key !== ' ') return;
    if (e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
    var t = e.target;
    // Buttons, links and form fields keep their own Space behaviour.
    if (t && t.closest && t.closest('button, a, input, select, textarea, summary, [contenteditable="true"]')) return;
    e.preventDefault();
    toggle();
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      save();
    } else {
      if (session) requestWakeLock();
      renderDaily(false);
    }
  });
  window.addEventListener('pagehide', save);

  // Keep the goal and history current across midnight even when idle.
  setInterval(function () { if (!session) renderDaily(false); }, 60000);

  /* ---------- demo ---------- */

  function demoData() {
    var d = defaultData();
    var today = new Date();
    // Minutes per day, oldest first; the last entry is today so far.
    var mins = [34, 41, 0, 28, 52, 36, 31, 45, 22, 38, 31, 47, 33, 6.2];
    mins.forEach(function (m, i) {
      if (m > 0) d.days[dayKey(addDays(today, i - 13))] = Math.round(m * 60000 + (i * 7919) % 50000);
    });
    return d;
  }

  function runDemo() {
    var practiced = 21 * 60000 + 46000;
    var sessionMs = 26 * 60000 + 10000;
    var todayKey = dayKey(new Date());
    data.days[todayKey] += practiced;
    var t = 0;
    var floor = -66;
    var trigger = floor + D.sensitivityToThreshold(data.settings.sensitivity);
    function frame() {
      t += TICK_MS;
      practiced += TICK_MS;
      sessionMs += TICK_MS;
      data.days[todayKey] += TICK_MS;
      var level = -27 + 5 * Math.sin(t / 310) + 3 * Math.sin(t / 97);
      renderLive({
        status: 'playing', practicedMs: practiced, sessionMs: sessionMs,
        levelDb: level, floorDb: floor, triggerDb: trigger - 3
      });
      renderDaily(false);
    }
    frame();
    setInterval(frame, TICK_MS);
    setRunningUi(true);
  }

  /* ---------- boot ---------- */

  renderSettings();
  renderDaily(true);
  if (DEMO) {
    document.title = 'practicemeter (demo)';
    runDemo();
  } else {
    setStatus('idle');
  }
}());
