/* torrent-runner.js — browser discovery client for the hosted runner-engine (TRACK A).
 *
 * The app is a non-module IIFE, so this dynamic-imports the ESM floor (same pattern
 * torrent.js already uses for the webtorrent bundle). It joins the room's floor, pings
 * {t:'who'}, and resolves the first fresh {t:'runner'} URL a runner announces, caching it
 * in localStorage (hp.torrent.runnerBase) so player.js's engineBase() can point the engine
 * base at the public https URL. Handshake-only: this carries the URL, never media bytes.
 *
 * window.HPRunner.discover({room, timeoutMs}) -> Promise<string|''>
 */
(function (window) {
  'use strict';
  var BASE_KEY = 'hp.torrent.runnerBase';   // {url,ts}
  var FLOOR = '../vendor/hp-floor.mjs';      // relative to js/ (importmap-free dynamic import)
  var FRESH_MS = 30000;                       // a runner frame older than this is ignored
  var enc = new TextEncoder();
  var dec = new TextDecoder();
  /* pinned runner public key — only frames signed by our runner's private key are trusted */
  var PUB_JWK = {"kty":"EC","crv":"P-256","x":"acDpUAXLRpmTjgC0kyi43XpduNSOpEFRs67-cdBhdiU","y":"Ni5958Yp6FF69Ju0G69GMf54bf7KJDHD4vkYCjJMnAg"};
  var _vk = null;
  function verifyKey() {
    if (_vk) return _vk;
    _vk = crypto.subtle.importKey('jwk', PUB_JWK, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return _vk;
  }
  function b64ToU8(b) { var bin = atob(b); var u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  function verify(msg) {
    if (!msg || !msg.sig) return Promise.resolve(false);
    return verifyKey().then(function (k) {
      return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, b64ToU8(msg.sig), enc.encode('runner|' + msg.url + '|' + msg.ts));
    }).catch(function () { return false; });
  }

  function cache(url) {
    try { localStorage.setItem(BASE_KEY, JSON.stringify({ url: url, ts: Date.now() })); } catch (e) {}
  }

  function discover(opts) {
    opts = opts || {};
    var room = opts.room || 'iris-hp-runner-v1';
    var timeoutMs = opts.timeoutMs || 8000;
    return import(FLOOR).then(function (mod) {
      return new Promise(function (resolve) {
        var done = false, floor = null, timer = null, pinger = null;
        function finish(url) {
          if (done) return; done = true;
          clearTimeout(timer); clearInterval(pinger);
          try { floor && floor.close(); } catch (e) {}
          if (url) cache(url);
          resolve(url || '');
        }
        mod.joinFloor({
          room: room,
          onFrame: function (from, bytes) {
            var msg; try { msg = JSON.parse(dec.decode(bytes)); } catch (e) { return; }
            if (!(msg && msg.t === 'runner' && msg.url && (Date.now() - (msg.ts || 0) < FRESH_MS))) return;
            verify(msg).then(function (ok) { if (ok) finish(msg.url); });   /* reject unsigned/forged/stale */
          },
        }).then(function (f) {
          floor = f;
          /* Public brokers are flaky and the runner + browser may momentarily land on
             different relays, so re-ping every ~1.5s until a runner frame arrives or we
             time out (round-trip sim: 3/3 discovered in ~2s with this cadence). */
          var ping = function () { if (done) return; try { f.send(enc.encode(JSON.stringify({ t: 'who', ts: Date.now() }))); } catch (e) {} };
          ping();
          pinger = setInterval(ping, 1500);
        }, function () { finish(''); });
        timer = setTimeout(function () { finish(''); }, timeoutMs);
      });
    }, function () { return ''; });
  }

  function cachedBase() {
    try {
      var j = JSON.parse(localStorage.getItem(BASE_KEY) || 'null');
      if (j && j.url && (Date.now() - (j.ts || 0) < 60000)) return j.url;
    } catch (e) {}
    return '';
  }

  /* wake(): publish a one-way {t:'wake'} ping on the floor so the isolated dispatcher spins
     up a runner when the pool is momentarily empty. Handshake-only and fire-and-forget — it
     carries no data, expects no reply, and (like discovery) reaches the dispatcher only via
     the neutral broker, so no machine IP is ever exposed. Sent a few times for broker
     flakiness, then the socket closes. */
  function wake(opts) {
    opts = opts || {};
    var room = opts.room || 'iris-hp-runner-v1';
    return import(FLOOR).then(function (mod) {
      return mod.joinFloor({ room: room }).then(function (f) {
        var n = 0;
        var ping = function () { try { f.send(enc.encode(JSON.stringify({ t: 'wake', ts: Date.now() }))); } catch (e) {} };
        ping();
        var iv = setInterval(function () { ping(); if (++n >= 3) { clearInterval(iv); try { f.close(); } catch (e) {} } }, 1200);
        return true;
      }, function () { return false; });
    }, function () { return false; });
  }

  window.HPRunner = { discover: discover, cachedBase: cachedBase, wake: wake, BASE_KEY: BASE_KEY };
})(window);
