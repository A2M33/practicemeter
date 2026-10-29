/*
 * practicemeter mic watch: notices when the microphone goes away in the middle of a session.
 *
 * A track fires `ended` when the device is unplugged or the system revokes it. The audio
 * context changes state when another app (often a phone or video call) takes the audio
 * hardware: Safari reports `interrupted`, other browsers `suspended` or `closed`.
 *
 * No DOM access: works on any objects with addEventListener, so the Node tests can feed it
 * fakes. Loads as a plain browser script (window.PracticeMeterMicWatch) and as CommonJS.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.PracticeMeterMicWatch = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * Calls onLost(reason) at most once, where reason is 'ended' | 'interrupted' | 'closed' |
   * 'suspended'. Returns a function that stops watching; call it before closing the
   * context yourself so your own close is not reported as a loss.
   */
  function watch(stream, ctx, onLost) {
    var tracks = stream.getAudioTracks ? stream.getAudioTracks() : stream.getTracks();
    var active = true;

    function lost(reason) {
      if (!active) return;
      unwatch();
      onLost(reason);
    }

    function onEnded() { lost('ended'); }

    function onState() {
      if (!active) return;
      var state = ctx.state;
      if (state === 'closed' || state === 'interrupted') {
        lost(state);
      } else if (state === 'suspended') {
        // Try once to get the audio back; if the browser refuses, the session cannot go on.
        var p;
        try { p = ctx.resume(); } catch (e) { lost('suspended'); return; }
        if (p && p.then) p.then(null, function () { lost('suspended'); });
      }
    }

    function unwatch() {
      if (!active) return;
      active = false;
      tracks.forEach(function (t) { t.removeEventListener('ended', onEnded); });
      ctx.removeEventListener('statechange', onState);
    }

    tracks.forEach(function (t) { t.addEventListener('ended', onEnded); });
    ctx.addEventListener('statechange', onState);
    return unwatch;
  }

  return { watch: watch };
}));
