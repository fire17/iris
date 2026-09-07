/* honestporn — dev.js : hot-reload devmode. localhost only, zero deps.
 * Polls core files every 1.2s (GET no-store, text compare — same trick as
 * registry.js). style.css change → hot-swap the <link> (no reload, wall state
 * survives). html/js change → full reload. A tiny 🔥 badge shows devmode is on.
 * ponytail: static-server-only by design; remove this tag for production. */
(function () {
  'use strict';
  if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;

  var WATCH = ['index.html', 'style.css', 'js/app.js', 'js/registry.js',
               'js/player.js', 'js/wallview.js', 'js/addons.js',
               'js/errlog.js', 'js/dev.js'];
  var seen = {};

  /* Forward every ErrLog-captured error to the local dev server (POST /dev-err) so the
     maintainer's monitor sees failures the moment they happen — fixes then hot-reload
     back into this page. sendBeacon: fire-and-forget, never blocks, never throws far. */
  window.HPDevErr = function (e) {
    try {
      var body = JSON.stringify({ t: e.t, tag: e.tag, msg: e.msg, detail: e.detail, page: location.hash });
      if (navigator.sendBeacon) navigator.sendBeacon('/dev-err', body);
      else fetch('/dev-err', { method: 'POST', body: body, keepalive: true })['catch'](function () {});
    } catch (x) {}
  };

  var badge = document.createElement('div');
  badge.textContent = '🔥 dev';
  badge.style.cssText = 'position:fixed;right:10px;bottom:10px;z-index:999999;' +
    'font:11px/1 -apple-system,sans-serif;color:#f5387b;background:rgba(13,13,15,.85);' +
    'border:1px solid rgba(245,56,123,.35);border-radius:999px;padding:5px 10px;' +
    'pointer-events:none;opacity:.8';
  document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(badge); });

  function flash(txt) {
    badge.textContent = txt;
    setTimeout(function () { badge.textContent = '🔥 dev'; }, 1500);
  }

  function swapCss() {
    var link = document.querySelector('link[rel="stylesheet"]');
    if (!link) { location.reload(); return; }
    var fresh = link.cloneNode();
    fresh.href = 'style.css?t=' + Date.now();
    fresh.onload = function () { link.remove(); };
    link.parentNode.insertBefore(fresh, link.nextSibling);
    flash('🎨 css');
  }

  /* A full reload can resurrect a stale-cached style.css (http.server sends no
     cache-control; If-Modified-Since has 1s mtime granularity), and tick() then
     seeds `seen` with the FRESH text so the swap never fires. So: always
     cache-bust the stylesheet once at startup. Devmode-only cost, one fetch. */
  document.addEventListener('DOMContentLoaded', swapCss);

  function tick() {
    WATCH.forEach(function (f) {
      fetch(f, { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : null; })
        .then(function (text) {
          if (text === null) return;
          if (seen[f] === undefined) { seen[f] = text; return; }
          if (text === seen[f]) return;
          seen[f] = text;
          if (f === 'style.css') swapCss();
          else { flash('♻️ reload'); setTimeout(function () { location.reload(); }, 120); }
        }).catch(function () {});
    });
  }
  tick();
  setInterval(tick, 1200);
})();
