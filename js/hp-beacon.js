/* hp-beacon.js — the client-side BETA TELEMETRY beacon for iris.akeyo.io.
 *
 * WHAT IT DOES: while the beta pill is ON, every visiting client emits a small event
 * stream — join/leave, view changes, play requests and resolutions, first frame, heals,
 * seeks, failures, errors — plus a 30s heartbeat, over the existing discovery floor
 * (vendor/hp-floor.mjs, MQTT-over-WSS) in room 'iris-beta-v1'. A local collector on
 * fire17's machine subscribes and writes them down.
 *
 * WHY SEALED: the floor's room key is derived from the room NAME, and the name ships in
 * this public JS — so floor sealing alone means anyone could read what strangers are
 * watching. Every event is therefore sealed a SECOND time to the collector's public key
 * (ECDH P-256 + AES-GCM via vendor/hp-seal.mjs), exactly the pinned-key discipline
 * js/torrent-runner.js already uses for runner announces.
 *
 * WHAT NEVER CROSSES: no IP (the floor is outbound-only, the collector never listens),
 * no precise geo, no UA string, no PII, no media bytes. `where` is timezone / language /
 * platform / mobile / screen / connection class — coarse by construction.
 *
 * OFF MEANS OFF: with the pill off, emit() is a no-op, no floor is joined, nothing is
 * queued and nothing is sent.
 *
 * API (non-module IIFE, same shape as the rest of the app):
 *   window.HPBeacon.emit(t, data)   — record one event (no-op when disabled)
 *   window.HPBeacon.on() / .off()   — flip the beta opt-in (persisted)
 *   window.HPBeacon.enabled()       — is telemetry on for this browser?
 *   window.HPBeacon.ready()         — {key, relays, outbox} — can we actually send?
 *   window.HPBeacon.probe(fn)       — register a heartbeat-field provider (app/player)
 *   window.HPBeacon.onChange(fn)    — notified when the opt-in flips (the pill listens)
 *
 * FULL-DUPLEX C2 (uplink, collector -> this client): so Claude can verify a fix on a REAL
 * live browser instead of guessing. Every inbound `cmd` frame must clear FOUR gates before
 * anything happens: (1) it decrypts with THIS tab's ephemeral private key (published as
 * `cpk` in our own join, never stored, dies with the tab), (2) its ECDSA-P256 signature
 * verifies against the pinned CTRL_PUB_JWK, (3) its `nonce` is unseen and its `ts` is
 * fresh, (4) its `cmd` is a key of the FIXED handler map below. There is NO eval, NO
 * Function(), NO dynamic dispatch — an unknown `cmd` is dropped and reported, never run.
 * The pill gates the uplink exactly like the downlink: off means every cmd frame is
 * ignored. And a visible "remote test in progress" chip appears whenever a command runs,
 * so the human sitting at that browser always knows Claude is driving.
 */
(function (window) {
  'use strict';

  /* ---- contract ---------------------------------------------------------- */
  var ROOM = 'iris-beta-v1';
  var FLOOR = '../vendor/hp-floor.mjs';   /* relative to js/ — same as torrent-runner.js */
  var SEAL  = '../vendor/hp-seal.mjs';    /* sealTo(pubJwk, bytes) -> Uint8Array */
  var BETA_DEFAULT_ON = true;             /* ON during the beta; the pill turns it off */
  var LS_ON = 'hp.beta';                  /* '1' | '0' */
  var LS_CID = 'hp.beta.cid';             /* per-browser id */
  var LS_OUT = 'hp.beta.outbox';          /* queued events across reloads */

  /* Collector public key (ECDH P-256, JWK). REPLACE with the real one:
     pinned 2026-08-23 from: node beta/keygen.mjs --print-pub  (private half never leaves
     fire17's machine: ~/.iris-beta/priv.jwk, 0600). Rotation = redeploy this file. If this
     is ever reset to a PASTE_ placeholder, the beacon queues events and sends NOTHING
     rather than feeding the collector decrypt_fail. */
  var PUB_JWK = { "kty": "EC", "crv": "P-256", "x": "jhnf4vcqnKtwu_eX7loaPesmiUroZYHnpLtybTyo-00", "y": "iH9RUScV0f_jUoB_1JOewuRKdxAtIEP0fBRMP_OmjR0" };

  /* Collector CONTROL key (ECDSA P-256, JWK) — the only key whose signature lets a `cmd`
     frame run here. REPLACE with the real one:
     pinned 2026-08-23 from: node beta/keygen.mjs --print-ctrl-pub  (private half:
     ~/.iris-beta/ctrl_priv.jwk, 0600). If this is ever reset to a PASTE_ placeholder,
     EVERY inbound command is rejected. */
  var CTRL_PUB_JWK = { "kty": "EC", "crv": "P-256", "x": "rXqKvCN2OpCAe4_EwXSqWq5sRkA5-2aI6ypzaCMaf-Q", "y": "_RyGjZi3A_QeJmiX3UMfm_5nbQLDsuq83iRyIWTbVzU" };

  var CMD_FRESH_MS = 120000;  /* a cmd whose ts is older/newer than this is refused */
  var NONCE_MAX = 400;        /* replay guard ring */
  var HB_MS = 30000;          /* heartbeat period */
  var CAP_N = 20, CAP_MS = 10000;   /* per-client rate cap: 20 events / 10s */
  var COLLAPSE_MS = 60000;    /* identical `error` inside this window collapses to one +n */
  var OUTBOX_MAX = 200;       /* oldest dropped first */
  var EVENT_MAX = 8192;       /* the collector drops anything bigger */
  var MAJOR = { join: 1, leave: 1, play_req: 1, play_resolved: 1, playing: 1, heal: 1, fail: 1, error: 1 };

  /* ---- identity ---------------------------------------------------------- */
  function ls(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function hex(n) {
    var u = new Uint8Array(n), i;
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(u);
    else for (i = 0; i < n; i++) u[i] = (Math.random() * 256) | 0;
    return Array.prototype.map.call(u, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  var CID = ls(LS_CID, '');
  if (!/^[0-9a-f]{16}$/.test(CID)) { CID = hex(8); lsSet(LS_CID, CID); }
  var SID = hex(8);           /* per tab, never persisted */

  function enabled() {
    var v = ls(LS_ON, null);
    return v === '1' ? true : v === '0' ? false : !!BETA_DEFAULT_ON;
  }

  /* Coarse "where" — timezone / language / platform / mobile / screen / connection.
     Deliberately no IP, no geolocation, no UA string. */
  function where() {
    var uad = navigator.userAgentData || null, c = navigator.connection || null, w = {};
    try { w.tz = (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone || ''; } catch (e) { w.tz = ''; }
    w.lang = (navigator.language || '').slice(0, 12);
    w.platform = String((uad && uad.platform) || navigator.platform || '').slice(0, 24);
    w.mobile = uad && typeof uad.mobile === 'boolean' ? uad.mobile : /Mobi|Android|iPhone|iPad/.test(navigator.userAgent || '');
    try { w.screen = screen.width + 'x' + screen.height + '@' + (window.devicePixelRatio || 1); } catch (e) { w.screen = ''; }
    w.conn = (c && (c.effectiveType || c.type)) || '';
    return w;
  }

  /* ---- outbox ------------------------------------------------------------ */
  var outbox = [];
  try { var pre = JSON.parse(ls(LS_OUT, '[]')); if (pre && pre.length) outbox = pre.slice(-OUTBOX_MAX); } catch (e) {}
  var saveT = null;
  function persist() {
    if (saveT) return;
    saveT = setTimeout(function () {
      saveT = null;
      try { localStorage.setItem(LS_OUT, JSON.stringify(outbox)); } catch (e) { /* quota — memory still holds it */ }
    }, 400);
  }
  function persistNow() { if (saveT) { clearTimeout(saveT); saveT = null; } try { localStorage.setItem(LS_OUT, JSON.stringify(outbox)); } catch (e) {} }

  /* ---- rate cap + error collapse ---------------------------------------- */
  var stamps = [], dropped = 0;
  function overCap() {
    var now = Date.now(), i = 0;
    while (i < stamps.length && now - stamps[i] > CAP_MS) i++;
    if (i) stamps = stamps.slice(i);
    if (stamps.length >= CAP_N) { dropped++; return true; }
    stamps.push(now);
    return false;
  }
  var collapse = {};   /* key -> {n, first, timer} */
  function collapsed(ev) {
    if (ev.t !== 'error') return false;
    var k = (ev.tag || '') + '|' + (ev.msg || ''), c = collapse[k];
    if (c) { c.n++; return true; }                     /* suppressed; reported as +n later */
    c = collapse[k] = { n: 1, ev: ev };
    c.timer = setTimeout(function () {
      delete collapse[k];
      if (c.n > 1) queue({ t: 'error', tag: ev.tag, msg: ev.msg, ctx: ev.ctx, n: c.n });
    }, COLLAPSE_MS);
    return false;                                       /* first one goes out immediately */
  }

  /* ---- emit -------------------------------------------------------------- */
  function queue(body) {
    var ev = { id: hex(8), cid: CID, sid: SID, ts: Date.now() };
    for (var k in body) if (Object.prototype.hasOwnProperty.call(body, k)) ev[k] = body[k];
    if (JSON.stringify(ev).length > EVENT_MAX) {        /* trim rather than lose the event */
      if (ev.ctx) ev.ctx = String(ev.ctx).slice(0, 400);
      if (ev.msg) ev.msg = String(ev.msg).slice(0, 400);
      if (JSON.stringify(ev).length > EVENT_MAX) { dropped++; return null; }
    }
    outbox.push(ev);
    while (outbox.length > OUTBOX_MAX) { outbox.shift(); dropped++; }   /* oldest first */
    persist();
    try { API._onEmit && API._onEmit(ev); } catch (e) {}
    schedule(MAJOR[ev.t] ? 60 : 1500);
    return ev;
  }

  function emit(t, data) {
    if (!enabled() || !t) return null;
    var body = { t: String(t) };
    if (data) for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) body[k] = data[k];
    if (collapsed(body)) return null;
    if (overCap()) return null;
    return queue(body);
  }

  /* ---- transport ---------------------------------------------------------- */
  var floor = null, floorPending = null, sealer = null, sealPending = null, keyBad = false, warned = false;
  var relays = 0, flushT = null, backoff = 2000, sending = false;
  var enc = new TextEncoder();

  function keyLooksReal(j) { return !!(j && j.kty === 'EC' && j.crv === 'P-256' && j.x && j.y && j.x.indexOf('PASTE_') !== 0); }

  function getSealer() {
    if (sealer) return Promise.resolve(sealer);
    if (sealPending) return sealPending;
    sealPending = import(SEAL).then(function (m) {
      if (!m || typeof m.sealTo !== 'function') throw new Error('hp-seal.mjs has no sealTo');
      sealer = m; return m;
    })['catch'](function (e) {
      sealPending = null;
      if (!warned) { warned = true; try { console.warn('[hp-beacon] seal module unavailable — events stay queued:', e && e.message); } catch (x) {} }
      throw e;
    });
    return sealPending;
  }

  function getFloor() {
    if (floor) return Promise.resolve(floor);
    if (floorPending) return floorPending;
    floorPending = import(FLOOR).then(function (mod) {
      return mod.joinFloor({
        room: ROOM,
        onFrame: function (from, bytes) { handleFrame(bytes); },   /* C2: sealed commands land here */
        onStatus: function (s) { relays = (s && s.relays) || 0; if (relays > 0) schedule(60); }
      });
    }).then(function (f) { floor = f; return f; })['catch'](function (e) {
      floorPending = null;
      if (!warned) { warned = true; try { console.warn('[hp-beacon] floor join failed — events stay queued:', e && e.message); } catch (x) {} }
      throw e;
    });
    return floorPending;
  }

  function schedule(ms) {
    if (!enabled() || flushT || !outbox.length) return;
    flushT = setTimeout(function () { flushT = null; flush(); }, ms);
  }

  function flush() {
    if (!enabled() || sending || !outbox.length) return;
    if (keyBad || !keyLooksReal(PUB_JWK)) {
      if (!keyBad) {
        keyBad = true;
        try { console.warn('[hp-beacon] collector PUB_JWK is a placeholder — telemetry is queued, not sent. Paste `node beta/keygen.mjs --print-pub` into js/hp-beacon.js.'); } catch (e) {}
      }
      return;   /* nothing to retry until a real key is deployed */
    }
    sending = true;
    Promise.all([getFloor(), getSealer()]).then(function (r) {
      var f = r[0], s = r[1];
      /* drain in order; a send failure leaves the rest queued for the next tick */
      var next = function () {
        if (!enabled() || !outbox.length) return Promise.resolve();
        var ev = outbox[0];
        var bytes = enc.encode(JSON.stringify(ev));
        if (bytes.length > EVENT_MAX) { outbox.shift(); dropped++; return next(); }
        return s.sealTo(PUB_JWK, bytes).then(function (sealed) {
          return f.send(sealed).then(function () {
            if (outbox[0] === ev) outbox.shift();
            try { API._onSend && API._onSend(sealed, ev); } catch (e) {}
            return next();
          });
        });
      };
      return next();
    }).then(function () {
      sending = false; backoff = 2000; persistNow();
      if (outbox.length) schedule(3000);
    })['catch'](function () {
      sending = false; persistNow();
      backoff = Math.min(60000, Math.round(backoff * 1.8));
      if (outbox.length) schedule(backoff);   /* broker outage / key import failure — hold the evidence */
    });
  }

  /* ---- heartbeat --------------------------------------------------------- */
  var probes = [], hbT = null;
  function snapshot(keep) {
    var out = {};
    for (var i = 0; i < probes.length; i++) {
      try {
        var p = probes[i]();
        if (p) for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k)) out[k] = p[k];
      } catch (e) { /* a broken probe must never stop the heartbeat */ }
    }
    out.dropped = dropped;
    if (!keep) dropped = 0;               /* the heartbeat consumes the counter; C2 only peeks */
    return out;
  }
  function startHb() {
    if (hbT) return;
    hbT = setInterval(function () { if (enabled()) emit('hb', snapshot()); else stopHb(); }, HB_MS);
  }
  function stopHb() { if (hbT) { clearInterval(hbT); hbT = null; } }

  /* ---- C2: the uplink (collector -> this client) -------------------------
     Four gates, in this order, before any handler runs: sealed to us, signed by the pinned
     control key, fresh + unreplayed, and present in the FIXED allowlist. Nothing here can
     execute data as code — `cmd` only ever indexes HANDLERS.
     Wire contract is COMMON.md "RULING 2026-08-23" and is byte-exact on purpose:
       signed bytes = UTF-8(JSON.stringify({v, to, nonce, cmd, data, ts}))  -- that key order,
       no `sig` present. ECDSA P-256 / SHA-256, raw r||s, base64url in `sig`. The collector
       signs that object, then adds `sig` and seals the whole frame to this client's `cpk`.
       We REBUILD the object in that same order rather than trusting the received key order,
       so sign and verify cannot disagree. `data` defaults to {} on both sides. */
  var EPH = null, ephPending = null;          /* our ephemeral ECDH keypair (in-memory only) */
  var ctrlKey = null, seen = [], seenSet = {};
  var indEl = null, indT = null;

  /* The canonical allowlist — byte-identical to the collector's const. The handler map below
     is checked against it at load, so the two can never silently drift apart. */
  var C2_ALLOWLIST = 'ping snapshot collectlog reload play pause resume seek goview setbeacon toast heal';

  function ensureKeys() {
    if (EPH) return Promise.resolve(EPH);
    if (ephPending) return ephPending;
    ephPending = getSealer().then(function (m) {
      if (typeof m.keygen !== 'function') throw new Error('hp-seal.mjs has no keygen');
      return m.keygen();
    }).then(function (kp) { EPH = kp; return kp; })['catch'](function () {
      ephPending = null; return null;   /* no C2 this session; telemetry still works */
    });
    return ephPending;
  }

  function ctrlLooksReal() { return !!(CTRL_PUB_JWK && CTRL_PUB_JWK.x && CTRL_PUB_JWK.x.indexOf('PASTE_') !== 0); }
  function getCtrlKey() {
    if (ctrlKey) return ctrlKey;
    ctrlKey = crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: CTRL_PUB_JWK.x, y: CTRL_PUB_JWK.y },
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return ctrlKey;
  }
  /* base64url (the ruling's encoding) as well as plain base64 */
  function b64ToU8(b) {
    try {
      var t = String(b).replace(/-/g, '+').replace(/_/g, '/');
      while (t.length % 4) t += '=';
      var bin = atob(t), u = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return u;
    } catch (e) { return new Uint8Array(0); }
  }
  /* rebuild {v,to,nonce,cmd,data,ts} in exactly that order — never trust received key order */
  function signBytes(m) {
    return enc.encode(JSON.stringify({ v: m.v, to: m.to, nonce: m.nonce, cmd: m.cmd, data: m.data || {}, ts: m.ts }));
  }
  function verifyCmd(m) {
    if (!ctrlLooksReal() || !m || !m.sig) return Promise.resolve(false);
    return getCtrlKey().then(function (k) {
      return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, b64ToU8(m.sig), signBytes(m));
    })['catch'](function () { return false; });
  }
  /* RULING (a): `to` is this client's cid, or '*'. Plain string compare — never a JWK compare.
     Sealing still uses the full cpk; matching and sealing are deliberately decoupled. */
  function addressed(to) { return to === '*' || to === CID; }
  function fresh(m) {
    var d = Math.abs(Date.now() - (+m.ts || 0));
    if (!(d < CMD_FRESH_MS)) return false;
    if (seenSet[m.nonce]) return false;
    seenSet[m.nonce] = 1; seen.push(m.nonce);
    while (seen.length > NONCE_MAX) delete seenSet[seen.shift()];
    return true;
  }

  /* Visible consent surface: the human at this browser always sees when Claude is driving. */
  function indicate(text) {
    if (!document.body) return;
    if (!indEl) {
      indEl = document.createElement('div');
      indEl.id = 'hp-c2ind';
      document.body.appendChild(indEl);
    }
    indEl.textContent = text || '\u{1F6F0} remote test in progress';
    indEl.classList.add('on');
    if (indT) clearTimeout(indT);
    indT = setTimeout(function () { if (indEl) indEl.classList.remove('on'); }, 3000);
  }

  /* ---- the FIXED allowlist. A cmd string can only ever index THIS map. ---- */
  var HANDLERS = {
    ping: function (d, m) { emit('pong', { nonce: m.nonce, rtt: Date.now() - (+m.ts || Date.now()) }); return 'pong'; },
    snapshot: function (d, m) {
      var st = snapshot(true);
      st.nonce = m.nonce;
      st.ua = String(navigator.userAgent || '').slice(0, 200);
      st.cid = CID;
      emit('state', st);
      return 'state sent';
    },
    collectlog: function (d, m) {
      if (!window.ErrLog) return false;
      var n = Math.max(1, Math.min(40, +d.n || 15));
      var lines = ErrLog.all().slice(-n).map(function (e) {
        return { t: e.t, tag: e.tag, msg: String(e.msg || '').slice(0, 200), ctx: String(e.detail || '').slice(0, 160) };
      });
      /* the collector drops anything over 8 KB — shed oldest until it fits */
      while (lines.length > 1 && JSON.stringify(lines).length > 6000) lines.shift();
      emit('log', { nonce: m.nonce, n: lines.length, lines: lines });
      return lines.length + ' lines';
    },
    reload: function () { setTimeout(function () { location.reload(); }, 400); return 'reloading'; },
    play: function (d) {
      if (!window.Player || typeof Player.play !== 'function') return false;
      var st = d.ih ? { infoHash: String(d.ih) } : d.magnet ? { url: String(d.magnet) } : null;
      if (!st) return false;
      Player.play({ stream: st, meta: { name: String(d.name || 'remote test') } });
      return 'playing ' + String(d.ih || d.magnet).slice(0, 48);
    },
    pause: function () { return (window.Player && Player.pause) ? (Player.pause() ? 'paused' : false) : false; },
    resume: function () { return (window.Player && Player.resume) ? (Player.resume() ? 'resumed' : false) : false; },
    seek: function (d) { return (window.Player && Player.seek) ? (Player.seek(+d.t || 0) ? 'seek ' + Math.round(+d.t || 0) : false) : false; },
    goview: function (d) {
      var n = String(d.name || '').replace(/[^a-z0-9/_-]/gi, '').slice(0, 60);
      if (!n) return false;
      location.hash = '#' + n; return 'view ' + n;
    },
    setbeacon: function (d) {
      var want = !!d.on;
      if (want === enabled()) return 'already ' + (want ? 'on' : 'off');
      /* turning OFF clears the outbox, so let the ack leave first */
      if (!want) { setTimeout(function () { off(); }, 600); return 'turning off'; }
      on(); return 'turned on';
    },
    toast: function (d) { indicate('\u{1F6F0} ' + String(d.msg || '').slice(0, 160)); return 'shown'; },
    /* the reason C2 exists: force the reconnect path on a REAL live client */
    heal: function (d) { return (window.Player && Player.heal) ? (Player.heal(String(d.reason || 'c2-test')) ? 'healing' : false) : false; }
  };
  /* the map and the canonical const must agree — a drift here is a silent interop failure */
  (function () {
    var want = C2_ALLOWLIST.split(' ').sort().join(' ');
    var have = Object.keys(HANDLERS).sort().join(' ');
    if (want !== have && window.console) console.warn('[hp-beacon] C2 allowlist drift: ' + have + ' != ' + want);
  })();

  function handleFrame(bytes) {
    if (!enabled() || !EPH || !bytes || !sealer) return;                 /* uplink obeys the pill */
    sealer.openWith(EPH.priv, bytes).then(function (plain) {
      if (!plain) return;                                                /* not for us — another client's telemetry */
      var m; try { m = JSON.parse(new TextDecoder().decode(plain)); } catch (e) { return; }
      if (!m || typeof m.cmd !== 'string' || (m.t != null && m.t !== 'cmd')) return;
      if (!addressed(m.to)) return;
      verifyCmd(m).then(function (ok) {
        if (!ok) return;                                                 /* unsigned/forged: silent, no ack */
        if (!fresh(m)) return;                                           /* replay or stale */
        try { API._onCmd && API._onCmd(m); } catch (e) {}
        if (!Object.prototype.hasOwnProperty.call(HANDLERS, m.cmd)) {
          if (window.ErrLog) ErrLog.push('beacon', 'C2 command not in allowlist: ' + String(m.cmd).slice(0, 40), '');
          emit('cmd_drop', { cmd: String(m.cmd).slice(0, 40), why: 'not in allowlist', nonce: m.nonce });
          return;
        }
        indicate();
        var out = false;
        try { out = HANDLERS[m.cmd](m.data || {}, m); } catch (e) { out = false; if (window.ErrLog) ErrLog.push('beacon', 'C2 ' + m.cmd + ' threw: ' + (e && e.message), ''); }
        emit('ack', { nonce: m.nonce, cmd: m.cmd, ok: out !== false, detail: out === false ? 'failed' : String(out).slice(0, 160) });
        schedule(60);
      });
    })['catch'](function () { /* openWith never throws, but never let a frame kill the ear */ });
  }

  /* ---- opt-in ------------------------------------------------------------ */
  var watchers = [];
  function announce() { for (var i = 0; i < watchers.length; i++) { try { watchers[i](enabled()); } catch (e) {} } }
  function on() {
    if (enabled()) { announce(); return; }
    lsSet(LS_ON, '1');
    ensureKeys().then(function (kp) {
      emit('join', kp ? { where: where(), cpk: kp.pub, resumed: true } : { where: where(), resumed: true });
      startHb(); schedule(60); getFloor()['catch'](function () {});
    });
    announce();
  }
  function off() {
    lsSet(LS_ON, '0');
    stopHb();
    if (flushT) { clearTimeout(flushT); flushT = null; }
    outbox.length = 0; persistNow();               /* off means off: nothing left to send */
    for (var k in collapse) { try { clearTimeout(collapse[k].timer); } catch (e) {} delete collapse[k]; }
    try { floor && floor.close(); } catch (e) {}
    floor = null; floorPending = null; relays = 0;
    announce();
  }

  /* ---- lifecycle --------------------------------------------------------- */
  function boot() {
    if (!enabled()) {
      /* the pill is off: don't just stay quiet, don't HOARD either. A stale outbox from an
         earlier opted-in session must not sit in this browser's storage forever. */
      if (outbox.length) { outbox.length = 0; persistNow(); }
      return;
    }
    /* the ephemeral keypair must exist BEFORE join, because join is what publishes `cpk` */
    ensureKeys().then(function (kp) {
      emit('join', kp ? { where: where(), cpk: kp.pub } : { where: where() });
      startHb();
      schedule(60);
      getFloor()['catch'](function () {});   /* also opens the C2 downstream ear */
    });
  }
  /* pagehide is the only reliable "tab is going away" on mobile Safari; beforeunload is not */
  window.addEventListener('pagehide', function () {
    if (!enabled()) return;
    emit('leave', {});
    persistNow();
    flush();   /* best effort — QoS0, so the outbox is the real guarantee */
  });
  window.addEventListener('online', function () { schedule(60); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) schedule(200); });

  var API = {
    emit: emit,
    on: on,
    off: off,
    enabled: enabled,
    ready: function () { return { key: keyLooksReal(PUB_JWK), relays: relays, outbox: outbox.length, cid: CID, sid: SID }; },
    probe: function (fn) { if (typeof fn === 'function') probes.push(fn); },
    onChange: function (fn) { if (typeof fn === 'function') watchers.push(fn); },
    where: where,
    cpk: function () { return (EPH && EPH.pub) || null; },
    /* test hooks — used by test/beta/*, never by the app */
    _onEmit: null,
    _onSend: null,
    _onCmd: null,
    _flush: flush,
    _frame: handleFrame,
    _setKey: function (jwk) { PUB_JWK = jwk; keyBad = false; },
    _setCtrl: function (jwk) { CTRL_PUB_JWK = jwk; ctrlKey = null; },
    _keys: ensureKeys
  };
  window.HPBeacon = API;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
