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

  /* ---- fork identity: which GitHub repo this deployment belongs to ----------------
     A fork works with ZERO configuration: served from <owner>.github.io the repo is
     derived from the hostname + first path segment, and both sides (this file and
     server/runner.mjs) derive the same per-repo floor room from it — so a fork's
     client finds the fork's OWN GitHub-Actions runners automatically. A fork behind a
     custom domain sets window.HP_REPO = "owner/repo" (one line) before this script.
     The official repo keeps the legacy v1 room. */
  var OFFICIAL_REPO = 'fire17/iris';
  function repoId() {
    try {
      if (window.HP_REPO) return String(window.HP_REPO).toLowerCase();
      var m = /^([^.]+)\.github\.io$/i.exec(location.hostname);
      if (m) {
        var seg = (location.pathname.split('/')[1] || '').toLowerCase();
        return (m[1] + '/' + (seg || (m[1] + '.github.io'))).toLowerCase();
      }
    } catch (e) {}
    return OFFICIAL_REPO;
  }
  /* FNV-1a via Math.imul — bit-identical to server/runner.mjs's derivation */
  function fnv(s) { var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }
  function defaultRoom() {
    var r = repoId();
    return r === OFFICIAL_REPO ? 'iris-hp-runner-v1' : 'iris-hp-' + fnv(r);
  }

  var enc = new TextEncoder();
  var dec = new TextDecoder();
  /* KEYLESS TRUST (fire17: "no secrets stored in the repos — both sides derive it").
     Nothing is signed and nothing is pinned; an announced URL is accepted only when:
       1. it is a https *.trycloudflare.com origin (the only tunnel the runner opens),
       2. the frame is fresh (FRESH_MS),
       3. its /status answers ok AND echoes a repo matching OUR derived repo (the engine
          reads GITHUB_REPOSITORY — a plain env var; localhost engines echo none and the
          announced-URL path never carries localhost).
     Honest limit: with no secret anywhere, a determined attacker who derives a room name
     can stand up a hostile tunnel that fakes the echo. This confines accidents and
     cross-fork mixups, not a targeted spoof — the documented no-secrets tradeoff. */
  var URL_OK = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i;
  var _verifying = {};   /* url -> in-flight verdict; announce beats re-arrive every ~1.5s */
  function verify(msg) {
    if (!(msg && typeof msg.url === 'string' && URL_OK.test(msg.url))) return Promise.resolve(false);
    if (_verifying[msg.url]) return _verifying[msg.url];
    return (_verifying[msg.url] = doVerify(msg).then(function (ok) { if (!ok) delete _verifying[msg.url]; return ok; }));
  }
  function doVerify(msg) {
    var ac = ('AbortController' in window) ? new AbortController() : null;
    var opt = { cache: 'no-store', mode: 'cors' }; if (ac) opt.signal = ac.signal;
    var tm = setTimeout(function () { if (ac) { try { ac.abort(); } catch (e) {} } }, 3500);
    return fetch(msg.url + '/status', opt).then(function (r) {
      clearTimeout(tm);
      if (!r.ok) return false;
      return r.json().then(function (j) {
        if (!(j && j.ok && j.engine === 'coolstremio')) return false;
        return !j.repo || j.repo === repoId();   /* echo present -> must be OUR repo */
      });
    })['catch'](function () { clearTimeout(tm); return false; });
  }

  function cache(url) {
    try { localStorage.setItem(BASE_KEY, JSON.stringify({ url: url, ts: Date.now() })); } catch (e) {}
  }

  function discover(opts) {
    opts = opts || {};
    var room = opts.room || defaultRoom();
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
            verify(msg).then(function (ok) { if (ok) finish(msg.url); });   /* keyless: shape + fresh + live repo-echo */
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
    var room = opts.room || defaultRoom();
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

  /* prime(ih, idx): warm the EXACT title on an already-known runner while the user is still
     browsing, so /play is near-instant on click. Fire-and-forget GET /prime (202); only runs
     when a runner base is already cached (never wakes one from a hover — that's what the pill
     + warmRunner do). Deduped per (ih,idx) for this page so repeated hovers cost one request. */
  var _primed = {};
  function prime(ih, idx) {
    if (!ih) return;
    var base = cachedBase();
    if (!base) return;
    var key = ih + ':' + (idx == null ? '' : idx);
    if (_primed[key]) return;
    _primed[key] = 1;
    try {
      fetch(base + '/prime/' + encodeURIComponent(ih) + (idx == null ? '' : '/' + encodeURIComponent(idx)),
        { cache: 'no-store', mode: 'cors' })['catch'](function () { delete _primed[key]; });
    } catch (e) { delete _primed[key]; }
  }

  window.HPRunner = { discover: discover, cachedBase: cachedBase, wake: wake, prime: prime,
                      room: defaultRoom, repo: repoId, BASE_KEY: BASE_KEY };
})(window);
