/* netmon.js — subtle realtime network speed/quality indicator (top-centre pill).
 * Passive + blazing: latency from a light periodic same-origin HEAD; throughput
 * measured from the Resource Timing of the traffic the app already makes (live
 * thumbnails, HLS segments) — no synthetic bandwidth burn. Colour = latency band.
 * ponytail: pure client, zero deps, no backend probe. */
(function () {
  'use strict';
  var el, dot, txt;

  function build() {
    el = document.createElement('div');
    el.id = 'hp-net';
    el.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:9500;' +
      'display:flex;align-items:center;gap:6px;font:11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;' +
      'color:rgba(255,255,255,.72);background:rgba(13,13,15,.5);border:1px solid rgba(255,255,255,.08);' +
      'border-radius:999px;padding:4px 10px;pointer-events:none;-webkit-backdrop-filter:blur(8px);' +
      'backdrop-filter:blur(8px);opacity:0;transition:opacity .5s';
    dot = document.createElement('span');
    dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:#666;transition:background .3s,box-shadow .3s';
    txt = document.createElement('span');
    txt.textContent = 'net…';
    el.appendChild(dot); el.appendChild(txt);
    document.body.appendChild(el);
    setTimeout(function () { if (el) el.style.opacity = '.82'; }, 300);
  }

  /* passive throughput: bytes the app actually pulled in the last window / window */
  var samples = [];
  try {
    new PerformanceObserver(function (list) {
      var now = performance.now();
      list.getEntries().forEach(function (e) {
        var b = e.transferSize || e.encodedBodySize || 0;
        if (b > 0) samples.push({ bytes: b, t: now });
      });
    }).observe({ type: 'resource', buffered: true });
  } catch (e) {}

  function throughputMbps() {
    var now = performance.now(), win = 6000, cut = now - win, tot = 0, i;
    for (i = samples.length - 1; i >= 0; i--) {
      if (samples[i].t < cut) { samples.splice(0, i + 1); break; }
      tot += samples[i].bytes;
    }
    return tot > 0 ? (tot * 8) / (win / 1000) / 1e6 : 0;   /* -> Mbps */
  }

  /* live latency: one lightweight same-origin HEAD, cache-busted */
  var rtt = null, pinging = false;
  function ping() {
    if (pinging) return;
    pinging = true;
    var t0 = performance.now();
    fetch(location.pathname + '?_n=' + Math.floor(t0), { method: 'HEAD', cache: 'no-store' })
      .then(function () { rtt = performance.now() - t0; })
      .catch(function () { rtt = null; })
      .then(function () { pinging = false; });
  }

  function paint() {
    if (!el) return;
    var mb = throughputMbps(), s = '';
    if (rtt != null) s += Math.round(rtt) + 'ms';
    if (mb >= 0.15) s += (s ? ' · ' : '') + (mb >= 10 ? Math.round(mb) : mb.toFixed(1)) + '↓Mb';
    txt.textContent = s || 'net…';
    var c = rtt == null ? '#888' : rtt < 90 ? '#3ad07a' : rtt < 220 ? '#e8b84a' : '#f5387b';
    dot.style.background = c;
    dot.style.boxShadow = '0 0 7px ' + c;
  }

  function start() { build(); ping(); paint(); setInterval(ping, 1500); setInterval(paint, 1000); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
