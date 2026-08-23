/* errlog.js — central error capture + visible notifier + copy-all.
 *
 * Everything that goes wrong lands in ONE ring buffer with a timestamp and context:
 *   - uncaught errors + resource load failures (capture-phase window 'error')
 *   - unhandled promise rejections
 *   - console.error (mirrored, never swallowed)
 *   - failed fetch() calls (network throw or HTTP >= 400), minus the known pollers
 *   - anything the app reports via ErrLog.push(tag, message, detail)
 *
 * UI: a small ⚠ badge appears bottom-left on the first error; click -> panel with the
 * full list, "Copy all" (clipboard, with build/page/UA header), "Clear", "Close".
 */
(function () {
  'use strict';
  var MAX = 200;
  var buf = [];            /* {t, tag, msg, detail} */
  var seen = 0;
  var badge = null, panel = null, styled = false;

  function now() { return new Date().toISOString(); }
  function push(tag, msg, detail) {
    try {
      buf.push({ t: now(), tag: String(tag || 'error'), msg: String(msg || '').slice(0, 500),
                 detail: detail == null ? '' : String(detail).slice(0, 800) });
      if (buf.length > MAX) buf.shift();
      seen++;
      paint();
    } catch (e) { /* the error logger must never throw */ }
  }

  /* ---- capture ---------------------------------------------------------- */
  window.addEventListener('error', function (e) {
    if (e && e.target && e.target !== window && (e.target.tagName)) {
      var t = e.target;
      var src = t.currentSrc || t.src || t.href || '';
      if (!src) return;
      push('resource', t.tagName.toLowerCase() + ' failed to load', src.slice(0, 300) +
        (t.error && t.error.code ? ' · mediaErr=' + t.error.code : ''));
    } else if (e) {
      push('uncaught', e.message || 'error', (e.filename || '') + ':' + (e.lineno || 0));
    }
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    push('promise', (r && (r.message || r)) || 'unhandled rejection', r && r.stack ? String(r.stack).split('\n')[1] : '');
  });
  var origErr = console.error.bind(console);
  console.error = function () {
    try { push('console', Array.prototype.map.call(arguments, function (a) {
      return (a && a.message) ? a.message : String(a); }).join(' ')); } catch (e) {}
    return origErr.apply(null, arguments);
  };
  /* failed fetches — skip the deliberate pollers and localhost health probes */
  var IGNORE = /verified_sources\.md|\/health$|\/status$|127\.0\.0\.1:114/;
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = String((input && input.url) || input || '');
    return origFetch.apply(this, arguments).then(function (r) {
      if (!r.ok && r.status >= 400 && !IGNORE.test(url)) push('http', 'HTTP ' + r.status, url.slice(0, 300));
      return r;
    }, function (e) {
      if (!IGNORE.test(url)) push('fetch', (e && e.message) || 'network failure', url.slice(0, 300));
      throw e;
    });
  };

  /* ---- UI --------------------------------------------------------------- */
  function styleOnce() {
    if (styled) return; styled = true;
    var css = [
      '#hp-errbadge{position:fixed;left:14px;bottom:14px;z-index:99998;background:#2a0e14;color:#ff5f7a;',
      'border:1px solid rgba(255,95,122,.5);border-radius:20px;padding:6px 12px;font:600 12px system-ui;',
      'cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.5);display:none;align-items:center;gap:6px}',
      '#hp-errbadge.on{display:flex}#hp-errbadge:hover{background:#3a1219}',
      '#hp-errpanel{position:fixed;left:14px;bottom:52px;z-index:99999;width:min(560px,calc(100vw - 28px));',
      'max-height:60vh;background:#14090d;color:#eee;border:1px solid rgba(255,95,122,.35);border-radius:12px;',
      'display:none;flex-direction:column;font:12px/1.45 ui-monospace,Menlo,monospace;box-shadow:0 20px 60px rgba(0,0,0,.7)}',
      '#hp-errpanel.on{display:flex}',
      '#hp-errpanel header{display:flex;gap:8px;align-items:center;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08);font-family:system-ui}',
      '#hp-errpanel header b{flex:1;font-size:13px}',
      '#hp-errpanel header button{background:#2a2a33;color:#eee;border:0;border-radius:8px;padding:6px 10px;cursor:pointer;font:600 12px system-ui}',
      '#hp-errpanel header button:hover{background:#3a3a45}#hp-errpanel header button.pri{background:#e2447a;color:#fff}',
      '#hp-errlist{overflow:auto;padding:8px 12px}',
      '#hp-errlist .row{padding:6px 0;border-bottom:1px dashed rgba(255,255,255,.07);word-break:break-all}',
      '#hp-errlist .row time{color:#8a8f98;margin-right:6px}',
      '#hp-errlist .row .tag{color:#ffb86b;margin-right:6px}',
      '#hp-errlist .row .d{color:#9aa3ad;display:block}'
    ].join('');
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  }
  function fmtAll() {
    var head = ['# honestporn error report', 'time: ' + now(), 'page: ' + location.href,
      'build: ' + (document.querySelector('script[src*="?v="]') ? 'stamped' : 'dev') +
      ' · sw: ' + (navigator.serviceWorker && navigator.serviceWorker.controller ? 'on' : 'off') +
      ' · online: ' + navigator.onLine, 'ua: ' + navigator.userAgent, ''].join('\n');
    return head + buf.map(function (e) {
      return e.t + ' [' + e.tag + '] ' + e.msg + (e.detail ? '\n    ' + e.detail : '');
    }).join('\n');
  }
  function paint() {
    if (!document.body) { document.addEventListener('DOMContentLoaded', paint); return; }
    styleOnce();
    if (!badge) {
      badge = document.createElement('div'); badge.id = 'hp-errbadge';
      badge.addEventListener('click', togglePanel);
      document.body.appendChild(badge);
    }
    badge.textContent = '⚠ ' + buf.length + ' error' + (buf.length === 1 ? '' : 's');
    badge.classList.add('on');
    if (panel && panel.classList.contains('on')) renderList();
  }
  function renderList() {
    var list = panel.querySelector('#hp-errlist');
    list.innerHTML = buf.slice().reverse().map(function (e) {
      return '<div class="row"><time>' + e.t.slice(11, 19) + '</time><span class="tag">' + e.tag +
        '</span>' + e.msg.replace(/</g, '&lt;') + (e.detail ? '<span class="d">' + e.detail.replace(/</g, '&lt;') + '</span>' : '') + '</div>';
    }).join('') || '<div class="row">no errors</div>';
  }
  function togglePanel() {
    styleOnce();
    if (!panel) {
      panel = document.createElement('div'); panel.id = 'hp-errpanel';
      panel.innerHTML = '<header><b>Errors</b><button class="pri" data-a="copy">Copy all</button>' +
        '<button data-a="clear">Clear</button><button data-a="close">Close</button></header><div id="hp-errlist"></div>';
      panel.querySelector('[data-a=copy]').addEventListener('click', function (ev) {
        var b = ev.target, txt = fmtAll();
        var done = function () { b.textContent = 'Copied ✓'; setTimeout(function () { b.textContent = 'Copy all'; }, 1600); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, function () { fallbackCopy(txt); done(); });
        else { fallbackCopy(txt); done(); }
      });
      panel.querySelector('[data-a=clear]').addEventListener('click', function () { buf.length = 0; renderList(); if (badge) badge.classList.remove('on'); });
      panel.querySelector('[data-a=close]').addEventListener('click', function () { panel.classList.remove('on'); });
      document.body.appendChild(panel);
    }
    panel.classList.toggle('on');
    if (panel.classList.contains('on')) renderList();
  }
  function fallbackCopy(txt) {
    var ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta);
    ta.select(); try { document.execCommand('copy'); } catch (e) {} ta.remove();
  }

  window.ErrLog = { push: push, all: function () { return buf.slice(); }, text: fmtAll, open: togglePanel };
})();
