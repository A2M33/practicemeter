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
  var MicWatch = window.PracticeMeterMicWatch;
  var H = window.PracticeMeterHistory;
  var TICK_MS = 40;              // ~25 analysis frames per second
  var SAVE_EVERY_MS = 5000;
  var METER_MIN_DB = -90;
  var RING_C = 2 * Math.PI * 52; // circumference of the goal ring
  var DEMO = /[?&]demo(?:[=&]|$)/.test(window.location.search);

  function $(id) { return document.getElementById(id); }

  var el = {
    stage: $('stage'),
    statusLabel: $('status-label'),
    announce: $('announce'),
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
    chartEmpty: $('chart-empty'),
    demoLink: $('demo-link'),
    historyTotal: $('history-total'),
    sensitivity: $('sensitivity'),
    sensitivityOut: $('sensitivity-out'),
    grace: $('grace'),
    graceOut: $('grace-out'),
    goal: $('goal'),
    chime: $('chime'),
    goalCard: $('goal-card'),
    totalWeek: $('total-week'),
    totalMonth: $('total-month'),
    totalAll: $('total-all'),
    sessionTable: $('session-table'),
    sessionRows: $('session-rows'),
    sessionsEmpty: $('sessions-empty'),
    sessionsMore: $('sessions-more'),
    exportBtn: $('export'),
    importBtn: $('import'),
    importFile: $('import-file'),
    dataStatus: $('data-status'),
    resetBtn: $('reset')
  };

  /* ---------- dates and formatting ---------- */

  var dayKey = H.dayKey;
  var addDays = H.addDays;
  var clampNum = H.clampNum;

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function hms(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60);
  }

  function hoursMinutes(min) {
    var h = Math.floor(min / 60);
    var m = Math.round(min % 60);
    return h ? h + ' h ' + m + ' min' : m + ' min';
  }

  /** "45 s", "26 min", "1 h 5 min". */
  function shortDuration(ms) {
    return ms < 60000 ? Math.round(ms / 1000) + ' s' : hoursMinutes(Math.floor(ms / 60000));
  }

  /* ---------- storage (format and migration live in history.js) ---------- */

  function load() {
    if (DEMO) return demoData();
    var loaded;
    try {
      loaded = H.load(function (key) { return window.localStorage.getItem(key); });
    } catch (e) {
      return H.defaultData(); // storage blocked
    }
    // Data from the old key is copied to the new one. The old key stays as a backup.
    if (loaded.migrated) setTimeout(save, 0);
    return loaded.data;
  }

  function save() {
    if (DEMO) return; // demo state is in memory only
    try {
      window.localStorage.setItem(H.STORAGE_KEY, JSON.stringify(data));
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

  /* ---------- screen reader announcements ---------- */

  var announceTimer = null;

  /** Speaks a lasting change through the polite live region. */
  function announce(text) {
    clearTimeout(announceTimer);
    el.announce.textContent = '';
    // Set the text a moment later so the same message twice in a row is read again.
    announceTimer = setTimeout(function () { el.announce.textContent = text; }, 60);
  }

  function spokenDuration(ms) {
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor(s / 60) % 60;
    var parts = [];
    if (h) parts.push(h + (h === 1 ? ' hour' : ' hours'));
    if (m) parts.push(m + (m === 1 ? ' minute' : ' minutes'));
    if (!h) parts.push((s % 60) + (s % 60 === 1 ? ' second' : ' seconds'));
    return parts.join(' ');
  }

  /* ---------- live display ---------- */

  var STATUS_TEXT = {
    idle: 'Ready',
    stopped: 'Stopped',
    calibrating: 'Stay quiet, measuring the room…',
    playing: 'Playing',
    holding: 'Short pause',
    paused: 'Paused, waiting for sound'
  };
  var shownStatus = null;
  var shownLabel = null;

  function setStatus(status, label) {
    label = label || STATUS_TEXT[status] || status;
    if (status === shownStatus && label === shownLabel) return;
    if (status !== shownStatus) el.stage.setAttribute('data-status', status === 'stopped' ? 'idle' : status);
    shownStatus = status;
    shownLabel = label;
    el.statusLabel.textContent = label;
  }

  /** "Stay quiet, measuring the room… 2", counting down the seconds of calibration. */
  function calibratingLabel(sessionMs) {
    var left = Math.max(1, Math.ceil((D.DEFAULTS.calibrationMs - sessionMs) / 1000));
    return STATUS_TEXT.calibrating + ' ' + left;
  }

  function meterPct(db) {
    return Math.max(0, Math.min(1, (db - METER_MIN_DB) / -METER_MIN_DB));
  }

  function renderLive(st) {
    setStatus(st.status, st.status === 'calibrating' ? calibratingLabel(st.sessionMs) : null);
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
    renderTotals();
    renderSessions();
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
    el.chartEmpty.hidden = total > 0;
    el.historyTotal.textContent = hoursMinutes(total) + ' total, goal met on ' + met + ' of 14 days';
  }

  /* ---------- totals and past sessions ---------- */

  var SESSIONS_SHOWN = 8;
  var showAllSessions = false;

  function renderTotals() {
    var t = H.totals(data.days, new Date());
    el.totalWeek.textContent = shortDuration(t.week);
    el.totalMonth.textContent = shortDuration(t.month);
    el.totalAll.textContent = shortDuration(t.all);
  }

  function sessionStarted(start) {
    var d = new Date(start);
    var today = new Date();
    var day = dayKey(d) === dayKey(today) ? 'Today'
      : dayKey(d) === dayKey(addDays(today, -1)) ? 'Yesterday'
      : d.toLocaleDateString('en', d.getFullYear() === today.getFullYear()
        ? { weekday: 'short', day: 'numeric', month: 'short' }
        : { day: 'numeric', month: 'short', year: 'numeric' });
    return day + ', ' + d.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' });
  }

  function renderSessions() {
    // The running session is in data.sessions too, but only finished ones are listed.
    var running = session && session.entry;
    var list = data.sessions.filter(function (x) { return x !== running && x.playedMs > 0; }).reverse();
    var shown = showAllSessions ? list : list.slice(0, SESSIONS_SHOWN);
    var frag = document.createDocumentFragment();
    shown.forEach(function (x) {
      var tr = document.createElement('tr');
      [
        sessionStarted(x.start),
        shortDuration(x.lengthMs),
        shortDuration(x.playedMs),
        Math.round(100 * Math.min(1, x.playedMs / Math.max(1, x.lengthMs))) + '%'
      ].forEach(function (text, i) {
        var cell = document.createElement(i === 0 ? 'th' : 'td');
        if (i === 0) cell.scope = 'row';
        cell.textContent = text;
        tr.appendChild(cell);
      });
      frag.appendChild(tr);
    });
    el.sessionRows.textContent = '';
    el.sessionRows.appendChild(frag);
    el.sessionTable.hidden = !list.length;
    el.sessionsEmpty.hidden = list.length > 0;
    el.sessionsMore.hidden = list.length <= SESSIONS_SHOWN;
    el.sessionsMore.textContent = showAllSessions ? 'Show fewer' : 'Show all ' + list.length + ' sessions';
    el.sessionsMore.setAttribute('aria-expanded', String(showAllSessions));
  }

  el.sessionsMore.addEventListener('click', function () {
    showAllSessions = !showAllSessions;
    renderSessions();
  });

  /* ---------- settings ---------- */

  function renderSettings() {
    el.sensitivity.value = data.settings.sensitivity;
    el.sensitivityOut.textContent = String(data.settings.sensitivity);
    el.grace.value = data.settings.graceS;
    el.graceOut.textContent = data.settings.graceS + ' s';
    el.goal.value = data.settings.goalMin;
    el.chime.checked = data.settings.chime;
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

  el.chime.addEventListener('change', function () {
    data.settings.chime = el.chime.checked;
    save();
  });

  /* ---------- goal celebration ---------- */

  var reducedMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  /** A short rising arpeggio, synthesized, so there is no sound file to load. */
  function playChime(ctx) {
    var t0 = ctx.currentTime + 0.02;
    var out = ctx.createGain();
    out.gain.value = 0.16;
    out.connect(ctx.destination);
    [784, 988, 1175, 1568].forEach(function (freq, i) { // G5 B5 D6 G6
      var t = t0 + i * 0.11;
      var osc = ctx.createOscillator();
      var env = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(1, t + 0.012);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
      osc.connect(env);
      env.connect(out);
      osc.start(t);
      osc.stop(t + 1.15);
    });
    setTimeout(function () { try { out.disconnect(); } catch (e) { /* context closed */ } }, 2000);
  }

  /** Runs once per session when today's total crosses the goal. ctx may be null (demo). */
  function celebrate(ctx) {
    announce('Daily goal of ' + data.settings.goalMin + ' minutes reached.');
    if (data.settings.chime && ctx && ctx.state === 'running') {
      try { playChime(ctx); } catch (e) { /* audio unavailable: the ring still shows it */ }
    }
    if (!(reducedMotion && reducedMotion.matches)) {
      el.goalCard.classList.remove('celebrate');
      void el.goalCard.offsetWidth; // restart the animation if it ran before
      el.goalCard.classList.add('celebrate');
    }
  }

  el.goalCard.addEventListener('animationend', function (e) {
    if (e.animationName === 'ring-burst') el.goalCard.classList.remove('celebrate');
  });

  /* ---------- export, import and reset ---------- */

  function setDataStatus(text) {
    el.dataStatus.textContent = text;
  }

  el.exportBtn.addEventListener('click', function () {
    if (!Object.keys(data.days).length) {
      setDataStatus('Nothing to export yet. Your daily totals appear after your first session.');
      return;
    }
    setDataStatus('');
    var blob = new Blob([H.toCsv(data)], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'practicemeter-' + dayKey(new Date()) + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  });

  el.importBtn.addEventListener('click', function () {
    el.importFile.value = '';
    el.importFile.click();
  });

  el.importFile.addEventListener('change', function () {
    var file = el.importFile.files && el.importFile.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var parsed = H.parseCsv(String(reader.result));
      if (!parsed.rows) {
        setDataStatus(file.name + ' has no daily totals in it. Import a CSV saved with Export CSV.');
        return;
      }
      var changed = H.mergeDays(data.days, parsed.days);
      save();
      renderDaily(true);
      setDataStatus('Imported ' + file.name + ': ' + changed + (changed === 1 ? ' day' : ' days') + ' updated' +
        (parsed.rows > changed ? ', ' + (parsed.rows - changed) + ' already up to date' : '') +
        (parsed.skipped ? ', ' + parsed.skipped + (parsed.skipped === 1 ? ' line' : ' lines') + ' skipped' : '') + '.');
    };
    reader.onerror = function () {
      setDataStatus('Could not read ' + file.name + '.');
    };
    reader.readAsText(file);
  });

  el.resetBtn.addEventListener('click', function () {
    if (!window.confirm('Delete all saved practice history? Your settings stay. This cannot be undone.')) return;
    data.days = {};
    // A running session keeps its row so it is still recorded when it stops.
    data.sessions = session && session.entry ? [session.entry] : [];
    save();
    setDataStatus('History deleted.');
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

  function micLostMessage(reason, practicedMs) {
    var cause = reason === 'ended'
      ? 'The microphone stopped. It was unplugged, or another app took it.'
      : 'Another app, maybe a call, took over the microphone.';
    return cause + ' The session ended and your ' + hms(practicedMs) +
      ' of playing is saved. Press Start to carry on.';
  }

  function setRunningUi(running) {
    el.toggle.textContent = running ? 'Stop' : 'Start';
    el.toggle.classList.toggle('running', running);
    el.toggle.setAttribute('aria-label', running ? 'Stop listening' : 'Start listening');
  }

  function start() {
    hideNotice();
    if (DEMO) {
      showNotice('This is the demo with sample data. Use “Leave the demo” at the top to practise with your microphone.');
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
        timer: setInterval(tick, TICK_MS),
        celebrated: false,
        roomMeasured: false,
        unwatch: null,
        // Kept in data.sessions and saved with everything else, so closing the tab
        // mid-session still leaves a row with the time played so far.
        entry: { start: Date.now(), lengthMs: 0, playedMs: 0 }
      };
      data.sessions.push(session.entry);
      var thisSession = session;
      session.unwatch = MicWatch.watch(stream, ctx, function (reason) {
        if (session !== thisSession) return;
        tick(); // credit the last frames before closing
        stop(function (st) { return micLostMessage(reason, st.practicedMs); });
      });
      setRunningUi(true);
      el.toggle.disabled = false;
      requestWakeLock();
      announce('Session started. Stay quiet for ' + Math.round(D.DEFAULTS.calibrationMs / 1000) +
        ' seconds while practicemeter measures the room.');
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
    if (!s.roomMeasured && !st.calibrating) {
      s.roomMeasured = true;
      announce('Room measured. The clock runs while you play.');
    }
    s.entry.lengthMs = st.sessionMs;
    s.entry.playedMs = st.practicedMs;

    var delta = st.practicedMs - s.lastPracticed;
    if (delta > 0) {
      var k = dayKey(new Date());
      var before = data.days[k] || 0;
      data.days[k] = before + delta;
      s.lastPracticed = st.practicedMs;
      if (!s.celebrated && before < goalMs() && data.days[k] >= goalMs()) {
        s.celebrated = true;
        celebrate(s.ctx);
      }
    }
    renderLive(st);
    renderDaily(false);
    if (now - s.lastSave >= SAVE_EVERY_MS) {
      s.lastSave = now;
      save();
    }
  }

  /** Ends the session and keeps its time. notice(st), if given, returns text to show. */
  function stop(notice) {
    var s = session;
    if (!s) return;
    session = null;
    clearInterval(s.timer);
    if (s.unwatch) s.unwatch();
    var st = s.det.stop(performance.now());
    s.stream.getTracks().forEach(function (t) { t.stop(); });
    try { s.source.disconnect(); } catch (e) { /* already gone */ }
    s.ctx.close().catch(function () {});
    releaseWakeLock();
    s.entry.lengthMs = st.sessionMs;
    s.entry.playedMs = st.practicedMs;
    if (!(st.practicedMs > 0)) {
      // Nothing played: no row for this session.
      data.sessions = data.sessions.filter(function (x) { return x !== s.entry; });
    }
    save();
    setRunningUi(false);
    renderLive(st);
    setStatus('stopped');
    renderDaily(true);
    if (typeof notice === 'function') {
      showNotice(notice(st)); // the notice is an alert, so it is read out on its own
    } else {
      announce('Session stopped. ' + spokenDuration(st.practicedMs) + ' practiced.');
    }
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
    var d = H.defaultData();
    var today = new Date();
    // Minutes per day, oldest first; the last entry is today so far.
    var mins = [34, 41, 0, 28, 52, 36, 31, 45, 22, 38, 31, 47, 33, 6.2];
    mins.forEach(function (m, i) {
      if (!(m > 0)) return;
      var day = addDays(today, i - 13);
      var total = Math.round(m * 60000 + (i * 7919) % 50000);
      d.days[dayKey(day)] = total;
      // One evening session, plus a morning one on longer days; efficiency 70 to 90%.
      var parts = m > 40 ? [0.4, 0.6] : [1];
      var played = 0;
      parts.forEach(function (share, j) {
        var ms = j === parts.length - 1 ? total - played : Math.round(total * share);
        played += ms;
        var start = new Date(day.getFullYear(), day.getMonth(), day.getDate(),
          parts.length > 1 && j === 0 ? 7 : 18, (i * 17 + j * 23) % 60);
        if (i === 13) start = new Date(Math.min(start.getTime(), Date.now() - 45 * 60000));
        d.sessions.push({ start: start.getTime(), lengthMs: Math.round(ms / (0.7 + ((i * 7 + j * 3) % 21) / 100)), playedMs: ms });
      });
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
    var celebrated = false;
    function frame() {
      t += TICK_MS;
      practiced += TICK_MS;
      sessionMs += TICK_MS;
      data.days[todayKey] += TICK_MS;
      if (!celebrated && data.days[todayKey] >= goalMs() && data.days[todayKey] - TICK_MS < goalMs()) {
        celebrated = true;
        celebrate(null); // no audio context in the demo, so the ring only
      }
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

  // Offline copy of the page (not possible when opened from disk).
  if ('serviceWorker' in navigator && /^https?:$/.test(window.location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* private mode etc.: online only */ });
  }

  renderSettings();
  renderDaily(true);
  if (DEMO) {
    document.title = 'practicemeter (demo)';
    el.demoLink.textContent = 'Leave the demo';
    el.demoLink.href = window.location.pathname;
    runDemo();
  } else {
    setStatus('idle');
  }
}());
