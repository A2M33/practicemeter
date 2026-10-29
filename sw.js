/*
 * practicemeter service worker: keeps a copy of the static files so the page reloads
 * without a network connection.
 *
 * Network first: when online you always get the latest deploy (and never a new index.html
 * with an old app.js); the cache is refreshed on every successful fetch and only answers
 * when the network fails. Bump CACHE when the file list changes.
 */
'use strict';

var CACHE = 'practicemeter-v1';
var FILES = [
  './',
  'index.html',
  'style.css',
  'detector.js',
  'micwatch.js',
  'history.js',
  'app.js',
  'manifest.webmanifest',
  'icon.svg',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(FILES); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE && k.indexOf('practicemeter-') === 0) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // One cached copy per file: ?demo and other queries share the plain page.
  var key = req.url.split('#')[0].split('?')[0];
  event.respondWith(
    fetch(req).then(function (res) {
      if (res.ok && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE).then(function (cache) { return cache.put(key, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(key).then(function (hit) {
        return hit || (req.mode === 'navigate' ? caches.match('./') : undefined) || Response.error();
      });
    })
  );
});
