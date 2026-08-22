/* torrent.js — serverless in-browser torrent client (WebTorrent 3.x browser build).
 *
 * THE HARD CEILING (browser sandbox, not a bug): a browser can only reach WebRTC
 * "web peers" (via wss:// trackers) and HTTP web-seeds (BEP19, magnet ws= or the
 * .torrent's url-list). It CANNOT open TCP/uTP peers or use the DHT. So
 * Torrentio's magnets (infoHash + udp/dht only, no wss, no web-seed) have ZERO
 * browser-reachable sources and can never play here; they still need the node
 * engine on :11470 (full TCP+DHT). This client is browser-first for web-seeded /
 * WebRTC-seeded torrents.
 *
 * THE STALL, DIAGNOSED (2026-08-21, headless Chrome, raw event log):
 *   - client.add(<magnet>) waits for METADATA, which a browser can only get from
 *     WebRTC peers found via wss trackers. When the trackers are unreachable or
 *     the swarm has no web peers, `ready` NEVER fires — that was the stall. The
 *     bundle (WebTorrent 3.0.21) is healthy: adding the raw .torrent BYTES fired
 *     infoHash+metadata+ready in ~1s and the webSeed wire started downloading.
 *   - FIX: when the magnet carries xs=<.torrent url> (ours always do — we control
 *     the catalog), fetch the .torrent in-browser and add the BYTES. Metadata is
 *     then instant and the web-seed (ws= and/or the .torrent url-list) supplies
 *     piece data with no tracker and no peer needed.
 *   - PLAYBACK: 3.x removed getBlobURL; file.streamTo() needs the service-worker
 *     bridge (client.createServer({controller})). ensureServer() registers
 *     /sw.min.js (vendored, root scope) and starts it — see BT.streamTo().
 *
 * State (settings, added torrents) → localStorage; piece DATA stays in the
 * bundle's in-memory store (video bytes cannot live in localStorage). window.BT. */
(function () {
  'use strict';

  var WSS = ['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev', 'wss://tracker.btorrent.xyz'];
  var LS_SET = 'hp.bt.settings';
  var LS_ADD = 'hp.bt.torrents';
  var BUNDLE = '/vendor/webtorrent.min.js';
  var SW_URL = '/sw.min.js';           /* must live at the root so scope:'/' works */
  var DEFAULTS = { maxConns: 55, sequential: true, trackers: WSS.slice() };
  var client = null;
  var lastClientError = '';

  /* The vendored bundle is an ES module (export default WebTorrent), so it must be
     dynamic-import()ed, not <script>-loaded. */
  var _wtPromise = null;
  function WT() { return window.WebTorrent || null; }
  function loadWT() {
    if (window.WebTorrent) return Promise.resolve(window.WebTorrent);
    if (_wtPromise) return _wtPromise;
    _wtPromise = import(BUNDLE).then(function (m) {
      var C = m && (m.default || m.WebTorrent || m);
      if (typeof C !== 'function') throw new Error('bundle-has-no-constructor');
      window.WebTorrent = C;
      return C;
    })['catch'](function (e) { _wtPromise = null; throw e; });
    return _wtPromise;
  }
  function webrtcOK() { var C = WT(); return !!(C && C.WEBRTC_SUPPORT); }
  function supported() { return webrtcOK(); }

  function getJSON(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function setJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function settings() { var s = getJSON(LS_SET, {}); for (var k in DEFAULTS) if (!(k in s)) s[k] = DEFAULTS[k]; return s; }
  function saveSettings(s) { setJSON(LS_SET, s || {}); }

  function ensureClient() {
    if (client) return client;
    var C = WT();
    if (!C) return null;
    var s = settings();
    try {
      client = new C({ maxConns: s.maxConns || 55, tracker: { announce: (s.trackers && s.trackers.length) ? s.trackers : WSS } });
      client.on('error', function (e) {
        var msg = String(e && e.message || e);
        lastClientError = msg;
        /* A "duplicate torrent" error is NOT fatal to the client — destroying the whole
           instance over it would tear down every other in-flight torrent. Record and ignore. */
        if (/duplicate torrent/i.test(msg)) return;
        /* other client errors are fatal to the instance — record and rebuild next time */
        try { client.destroy(); } catch (e2) {}
        client = null; _srvP = null; _srvUp = false;
      });
    } catch (e) { lastClientError = String(e && e.message || e); client = null; }
    return client;
  }

  /* ------------------------------------------------- streaming bridge (SW) --
     3.x streams file→<video> through a service worker: file.streamTo(el) only
     works after client.createServer({controller: <registration>}). The vendored
     worker (vendor/webtorrent-sw.min.js) is copied to /sw.min.js so it can claim
     root scope; it only intercepts <scope>/webtorrent/* URLs, nothing else. */
  var _srvP = null, _srvUp = false;
  function ensureServer() {
    if (_srvUp) return Promise.resolve(true);
    if (_srvP) return _srvP;
    if (!('serviceWorker' in navigator)) return Promise.reject(new Error('no-service-worker'));
    _srvP = navigator.serviceWorker.register(SW_URL, { scope: '/' }).then(function (reg) {
      return new Promise(function (resolve, reject) {
        var w = reg.active || reg.waiting || reg.installing;
        if (!w) return reject(new Error('sw-no-worker'));
        /* GUARD: a worker stuck in 'installing'/'waiting' (never reaching 'activated') would
           leave this Promise unsettled forever — streamTo() would hang and, worse, _srvP would
           cache the dead promise for the whole session with no engine fallback. Bound it: on
           timeout we reject so the caller can fall back. The catch below nulls _srvP so a later
           attempt can retry rather than reuse a poisoned promise. */
        var to = setTimeout(function () { reject(new Error('sw-activate-timeout')); }, 8000);
        function armed() {
          clearTimeout(to);
          try {
            if (!_srvUp) {
              if (!client) throw new Error('client-gone');
              client.createServer({ controller: reg }); _srvUp = true;
            }
            resolve(true);
          } catch (e) { reject(e); }
        }
        if (w.state === 'activated') return armed();
        w.addEventListener('statechange', function onSt() {
          if (w.state === 'activated') { w.removeEventListener('statechange', onSt); armed(); }
        });
      });
    })['catch'](function (e) { _srvP = null; throw e; });
    return _srvP;
  }

  /* stream a ready file into a <video>/<audio> element (SW bridge underneath). */
  function streamTo(file, el) {
    return ensureServer().then(function () { file.streamTo(el); return true; });
  }

  /* the gate the app uses to decide whether to even TRY the browser path: only
     magnets carrying a web-seed (ws=), a fetchable .torrent (xs=http…) or a wss
     tracker have any browser-reachable source. */
  function canPlay(magnet) {
    if (!magnet) return false;
    return /[?&]ws=/.test(magnet) || /[?&]xs=http/i.test(magnet) || /tr=wss(?:%3a|:)/i.test(magnet);
  }

  function paramsOf(magnet, key) {
    var out = [], re = new RegExp('[?&]' + key + '=([^&]+)', 'g'), m;
    while ((m = re.exec(magnet))) { try { out.push(decodeURIComponent(m[1])); } catch (e) { out.push(m[1]); } }
    return out;
  }
  function webSeeds(magnet) { return paramsOf(magnet, 'ws'); }
  function xsOf(magnet) {
    var xs = paramsOf(magnet, 'xs');
    for (var i = 0; i < xs.length; i++) if (/^https?:\/\//i.test(xs[i])) return xs[i];
    return null;
  }

  function pickVideo(torrent, fileIdx) {
    var files = torrent.files || [];
    if (fileIdx != null && files[fileIdx] && /\.(mp4|m4v|mkv|webm|mov|avi|ogv)$/i.test(files[fileIdx].name || '')) return files[fileIdx];
    var vids = files.filter(function (f) { return /\.(mp4|m4v|mkv|webm|mov|avi|ogv)$/i.test(f.name || ''); });
    var pool = vids.length ? vids : files.slice();
    pool.sort(function (a, b) { return (b.length || 0) - (a.length || 0); });
    return pool[0] || null;
  }

  /* wire breakdown: how each byte-carrying connection reaches us. WebRTC peers are
     the direct-P2P swarm (browser↔peer, one hop); webSeed wires are HTTP(S) GETs
     against a static host (ws=). A signaling relay (broker/signal) is NEVER a wire —
     it introduces peers then leaves the byte path, so relayFileBytes is 0 by
     construction. We report it explicitly so the panel can PROVE it. */
  function wireBreakdown(t) {
    var webrtc = 0, webseed = 0, other = 0, otherBytes = 0, wires = (t && t.wires) || [];
    for (var i = 0; i < wires.length; i++) {
      var w = wires[i];
      if (w.type === 'webSeed') webseed++;
      else if (w.type === 'webrtc' || (w._simple_peer || w.peerId)) webrtc++;
      /* Any wire that is NEITHER a WebRTC peer NOR an HTTP web-seed is anomalous: the only
         legitimate byte carriers in the browser are the direct-P2P swarm and web-seeds. A
         signaling relay is never a WebTorrent wire, so this bucket — and the bytes it has
         carried — MUST stay 0. We measure it so a regression that ever routed file bytes
         through a we-run node would show up here instead of being assumed away. */
      else { other++; otherBytes += (w.downloaded || 0); }
    }
    /* WebTorrent counts web-seeds inside numPeers only once connected; url-list
       seeds live on t._servers. Fall back to urlList length when no wire yet. */
    if (!webseed && t && t.urlList && t.urlList.length) webseed = t.urlList.length;
    return { webrtc: webrtc, webseed: webseed, other: other, otherBytes: otherBytes };
  }

  function statsOf(t) {
    if (!t) return null;
    var wb = wireBreakdown(t);
    return {
      peers: t.numPeers || 0, down: t.downloadSpeed || 0, up: t.uploadSpeed || 0,
      progress: t.progress || 0, remaining: t.timeRemaining || 0,
      downloaded: t.downloaded || 0, uploaded: t.uploaded || 0,
      length: t.length || 0, ratio: t.ratio || 0,
      webrtcPeers: wb.webrtc, webSeeds: wb.webseed, otherPeers: wb.other,
      /* LAW: the signaling relay never carries file bytes. MEASURED (not asserted): bytes on
         any wire that is neither a WebRTC peer nor a web-seed. Structurally 0 — a relay is
         never a wire — but computed so a regression can't hide behind a hardcoded constant. */
      relayFileBytes: wb.otherBytes || 0
    };
  }

  function rememberTorrent(magnet, infoHash) {
    if (!infoHash) return;
    var list = getJSON(LS_ADD, []);
    if (!list.some(function (r) { return r.infoHash === infoHash; })) {
      list.unshift({ infoHash: infoHash, magnet: magnet, at: Date.now() });
      if (list.length > 50) list = list.slice(0, 50);
      setJSON(LS_ADD, list);
    }
  }
  function addedTorrents() { return getJSON(LS_ADD, []); }

  /* browser-first play. Resolves { ok:true, torrent, file } once the chosen video
     file is ready to stream, or { ok:false, reason } on timeout / no source /
     error. The caller then streams it: BT.streamTo(file, videoEl). */
  function tryPlay(opts) {
    opts = opts || {};
    var magnet = opts.magnet || '';
    var timeoutMs = opts.timeoutMs || 8000;
    return loadWT().then(function () {
      /* the web-seed path needs no WebRTC; only tracker-peer sourcing does */
      if (!webrtcOK() && !/[?&](ws|xs)=/.test(magnet)) return { ok: false, reason: 'webrtc-unsupported' };
      return runPlay(magnet, opts, timeoutMs);
    })['catch'](function (e) { return { ok: false, reason: 'load-failed:' + (e && e.message) }; });
  }

  function runPlay(magnet, opts, timeoutMs) {
    return new Promise(function (resolve) {
      var c = ensureClient();
      if (!c) return resolve({ ok: false, reason: 'client-init-failed:' + lastClientError });

      /* reject obviously-bad input up front. Some WebTorrent builds report a bad identifier
         via an ASYNC client 'error' (which would tear down the client) rather than a sync
         throw, so we don't want to hand it garbage. Empty magnet with no web-seed is invalid. */
      if (!magnet || (!/^magnet:\?/i.test(magnet) && !/^https?:\/\//i.test(magnet))) {
        if (!/[?&](ws|xs)=/.test(magnet || '')) return resolve({ ok: false, reason: 'bad-magnet' });
      }

      var done = false;
      var timer = null;
      function finish(v) {
        if (done) return; done = true;
        if (timer) { clearTimeout(timer); timer = null; }
        try { if (c && c.removeListener) c.removeListener('error', onClientErr); } catch (e) {}
        resolve(v);
      }
      /* If the shared client errors while THIS run is in flight, ensureClient's handler may
         destroy+null the client — which emits 'close' (not 'error') on our torrent, so wire()'s
         't.on(error)' never fires and we would hang until the timeout. Settle immediately. */
      function onClientErr(e) { finish({ ok: false, reason: 'client-error:' + String(e && e.message || e) }); }
      try { if (c.once) c.once('error', onClientErr); } catch (e) {}

      var s = settings();
      var addOpts = { announce: (s.trackers && s.trackers.length) ? s.trackers : WSS, strategy: (s.sequential !== false) ? 'sequential' : undefined };
      var ws = webSeeds(magnet); if (ws.length) addOpts.urlList = ws;

      var t = null;
      timer = setTimeout(function () {
        /* free the orphaned torrent so it stops announcing to dead trackers and holding memory */
        if (t) { try { t.destroy(); } catch (e) {} }
        finish({ ok: false, reason: 'timeout' + (lastClientError ? ':' + lastClientError : ''), infoHash: t && t.infoHash });
      }, timeoutMs);

      function wire(tt) {
        t = tt;
        function onReady() {
          var file = pickVideo(t, opts.fileIdx);
          if (!file) { clearTimeout(timer); return finish({ ok: false, reason: 'no-video-file', infoHash: t.infoHash }); }
          /* INSTANT START: the torrent was added with strategy:'sequential' (addOpts above —
             the supported WebTorrent knob; the bundle's picker reads torrent.strategy and
             'sequential' is also its default), so pieces are fetched in file order. file.select()
             raises this file's priority, and BT.streamTo()'s file.streamTo(el) marks the head
             pieces the <video> needs first as CRITICAL — so playback begins the moment the head
             of the file lands, without waiting for the whole torrent. */
          try { if (file.select) file.select(); } catch (e) {}
          clearTimeout(timer);
          rememberTorrent(magnet, t.infoHash);
          finish({ ok: true, torrent: t, file: file, infoHash: t.infoHash });
        }
        if (t.ready) onReady(); else t.on('ready', onReady);
        t.on('error', function (err) { clearTimeout(timer); finish({ ok: false, reason: 'torrent-error:' + (err && err.message), infoHash: t && t.infoHash }); });
      }

      var existing = opts.infoHash && c.get && c.get(opts.infoHash);
      if (existing && existing.then) { existing.then(function (et) { addPath(et); }); } else { addPath(existing); }

      function addPath(et) {
        if (done) return;
        if (et) return wire(et);
        /* THE FIX: metadata over HTTP, not from peers. xs= → fetch the .torrent
           bytes in-browser → add bytes → ready fires immediately; the web-seed
           (ws= / url-list) then feeds piece data server-free. */
        var xs = xsOf(magnet);
        if (xs) {
          /* bound the metadata fetch: a black-hole host must not leave a request pending for
             the whole session. Abort at min(timeout, 6s); the timer still settles the promise. */
          var ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
          var ft = setTimeout(function () { if (ac) try { ac.abort(); } catch (e) {} }, Math.min(timeoutMs, 6000));
          fetch(xs, ac ? { signal: ac.signal } : undefined).then(function (r) {
            clearTimeout(ft);
            if (!r.ok) throw new Error('xs-http-' + r.status);
            return r.arrayBuffer();
          }).then(function (ab) {
            if (done) return;
            try { wire(c.add(new Uint8Array(ab), addOpts)); }
            catch (e) { clearTimeout(timer); finish({ ok: false, reason: 'add-threw:' + (e && e.message) }); }
          })['catch'](function () {
            clearTimeout(ft);
            /* xs fetch failed (offline / CORS / aborted) → fall back to the magnet+tracker path */
            if (done) return;
            addMagnet();
          });
        } else {
          addMagnet();
        }
        function addMagnet() {
          /* dedupe: if this infoHash is already in the client, wire the existing torrent rather
             than calling c.add again — a duplicate add can emit a client 'error' that (absent the
             whitelist above) would destroy the whole shared client and every in-flight torrent. */
          try {
            var ih = (magnet.match(/btih:([a-z0-9]+)/i) || [])[1];
            var pre = ih && c.get && c.get(ih.toLowerCase());
            if (pre && !pre.then) return wire(pre);
          } catch (e) {}
          try { wire(c.add(magnet, addOpts)); }
          catch (e) { finish({ ok: false, reason: 'add-threw:' + (e && e.message) }); }
        }
      }
    });
  }

  function destroy(infoHash) {
    if (!client || !infoHash) return;
    try {
      var t = client.get(infoHash);
      if (t && t.then) t.then(function (tt) { if (tt) try { tt.destroy(); } catch (e) {} });
      else if (t) t.destroy();
    } catch (e) {}
  }

  window.BT = {
    supported: supported,
    canPlay: canPlay,
    webSeeds: webSeeds,
    xsOf: xsOf,
    tryPlay: tryPlay,
    streamTo: streamTo,
    statsOf: statsOf,
    wireBreakdown: wireBreakdown,
    destroy: destroy,
    settings: settings,
    saveSettings: saveSettings,
    added: addedTorrents,
    trackers: WSS.slice()
  };
})();
