/* honestporn — registry.js
 * window.Registry : live read-only view over verified_sources.md.
 * Fetches + parses the markdown table, polls for changes (GET no-store every
 * 2.5s — the file is ~2KB on localhost; text compare is the change detector,
 * so it works on any static server with zero server code).
 * LAW: this module NEVER writes the registry file. Humans edit it; we watch.
 */
(function (window) {
  'use strict';

  var FILE = 'verified_sources.md';
  var POLL_MS = 2500;

  /* Lane table — the single source of truth for the trust vocabulary.
     `badge` is the CANVAS-side glyph (wallview draws item.name as text, and an
     emoji is the only glyph that survives a fillText call), while `seal`/`mark`
     drive the DOM seals in the ledger dock. Keep the two in sync by lane. */
  var LANES = {
    'ai-generated': {
      ord: 0, badge: '🤖', name: '🤖 AI-Generated · no human performed',
      seal: 'synthetic', label: 'Synthetic',
      title: 'Synthetic · no performer',
      def: 'Generated. No human performed for this, so nobody could be harmed making it.',
      mark: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.4l1.55 5.05L14.6 8l-5.05 1.55L8 14.6l-1.55-5.05L1.4 8l5.05-1.55z" fill="currentColor"/></svg>'
    },
    'performer-verified': {
      ord: 1, badge: '✅', name: '✅ Performer-Verified · consent · fair pay · pull-anytime',
      seal: 'verified', label: 'Verified',
      title: 'Performer-verified',
      def: 'Filed with consent, fair pay, and the right to pull it at any time.',
      mark: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.8 8.7l3.3 3.3L13.2 4.9" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/><circle cx="13.4" cy="2.6" r="1.5" fill="currentColor"/></svg>'
    },
    'demo': {
      ord: 2, badge: '🧪', name: '🧪 Demo · SFW test sources',
      seal: 'demo', label: 'Demo',
      title: 'Demo · SFW test source',
      def: 'A public test video. It proves the lane works. It carries no trust claim.',
      mark: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="2.7 2.5" stroke-linecap="round"/></svg>'
    }
  };
  var LANE_ORDER = ['performer-verified', 'ai-generated', 'demo'];

  var state = {
    text: null,        /* last seen file body — the change detector */
    items: [],
    skipped: 0,
    cbs: [],
    byId: {},
    changedAt: 0,      /* ms epoch of the last observed file change          */
    ok: null,          /* null = never fetched, true = served, false = gone  */
    err: ''
  };

  function hash(s) {           /* tiny stable id from the url */
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  function parse(md) {
    var items = [], skipped = 0, seen = {};
    String(md).split('\n').forEach(function (line) {
      line = line.trim();
      if (line[0] !== '|') return;                       /* not a table row */
      if (/^\|[\s:|-]+\|?$/.test(line)) return;          /* separator row */
      var cells = line.split('|').slice(1, -1).map(function (c) { return c.trim(); });
      var url = cells[2] || '';
      /* http(s) media/streams, plus magnet: URLs — web-seeded (ws=/xs=) magnets
         play fully in-browser via window.BT (see js/torrent.js); others fall to
         the local engine / magnet hand-off inside the player. */
      if (!/^https?:\/\//.test(url) && !/^magnet:\?/i.test(url)) {
        /* header row parses here too — only count rows that LOOK like data */
        if (cells.join(' ').indexOf('http') >= 0) skipped++;
        return;
      }
      if (cells.length < 3 || !cells[0]) { skipped++; return; }
      if (seen[url]) return;                             /* dedupe by URL */
      seen[url] = 1;
      var lane = LANES[(cells[1] || '').toLowerCase()] ? (cells[1] || '').toLowerCase() : 'demo';
      var notes = cells[4] || '';
      items.push({
        id: 'hp:' + hash(url),
        type: 'movie',
        name: LANES[lane].badge + ' ' + cells[0],
        title: cells[0],
        poster: cells[3] || '',
        description: notes,
        hpUrl: url,
        lane: lane,
        hls: /\.m3u8(\?|$)/.test(url),
        live: /\blive\b/i.test(notes)
      });
    });
    return { items: items, skipped: skipped };
  }

  function apply(text, first) {
    state.text = text;
    state.changedAt = Date.now();
    var p = parse(text);
    state.items = p.items;
    state.skipped = p.skipped;
    state.byId = {};
    p.items.forEach(function (m) { state.byId[m.id] = m; });
    state.cbs.forEach(function (cb) {
      try { cb({ first: !!first, count: p.items.length, skipped: p.skipped }); } catch (e) {}
    });
  }

  function poll() {
    fetch(FILE, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.text();
    }).then(function (text) {
      var wasDown = state.ok === false || state.ok === null;
      state.ok = true; state.err = '';
      if (text === state.text) { if (wasDown) notify(); return; }
      apply(text, state.text === null);
    }).catch(function (e) {
      /* transient (mid-save, offline) — next poll heals. But a file that is
         MISSING is not transient noise: say so, that is the honest thing. */
      var was = state.ok;
      state.ok = false; state.err = String(e && e.message || e);
      if (was !== false) notify();
    });
  }

  function notify() {
    state.cbs.forEach(function (cb) {
      try { cb({ first: false, count: state.items.length, skipped: state.skipped, statusOnly: true }); }
      catch (e) {}
    });
  }

  poll();
  setInterval(poll, POLL_MS);

  window.Registry = {
    file: FILE,
    lanes: LANES,
    laneOrder: LANE_ORDER.slice(),
    count: function () { return state.items.length; },
    skipped: function () { return state.skipped; },
    lastChange: function () { return state.changedAt; },
    ok: function () { return state.ok; },
    countByLane: function () {
      var by = { 'performer-verified': 0, 'ai-generated': 0, 'demo': 0 };
      state.items.forEach(function (m) { by[m.lane] = (by[m.lane] || 0) + 1; });
      return by;
    },
    items: function () { return state.items.slice(); },
    get: function (id) { return state.byId[id] || null; },
    groups: function () {
      var by = {};
      state.items.forEach(function (m) { (by[m.lane] = by[m.lane] || []).push(m); });
      return Object.keys(by).sort(function (a, b) { return LANES[a].ord - LANES[b].ord; })
        .map(function (lane) { return { key: '__hp|' + lane, name: LANES[lane].name, items: by[lane] }; });
    },
    onChange: function (cb) { if (typeof cb === 'function') state.cbs.push(cb); }
  };
})(window);


/* =========================================================================
   THE HONEST LEDGER — the trust dock.
   The legend and the registry status are ONE surface, not two widgets: what
   the badges mean and what is actually being watched belong in the same
   breath. Always visible (collapsed), one click for the full definitions.
   Reads window.Registry only — it never writes the registry file.
   ========================================================================= */
(function (window) {
  'use strict';
  var D = window.document, R;

  function el(id) { return D.getElementById(id); }

  /* one seal, as markup. `size` 'xs' gives the corner-stamp scale. */
  function seal(lane, size) {
    var L = R.lanes[lane];
    if (!L) return '';
    return '<span class="seal seal-' + L.seal + (size === 'xs' ? ' seal-xs' : '') + '">' +
             '<span class="seal-in">' + L.mark + '<span>' + L.label + '</span></span>' +
           '</span>';
  }

  function ago(ms) {
    if (!ms) return 'not yet read';
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    return new Date(ms).toLocaleTimeString();
  }

  var FORMAT =
    '| Title | <span class="k">Lane</span> | URL | Poster | Notes |\n' +
    '|---|---|---|---|---|\n' +
    '| Big Buck Bunny | <span class="k">demo</span> | https://…/bbb.mp4 |  | mp4 |';

  function build() {
    var dock = el('trustdock');
    if (!dock || !window.Registry) return null;
    R = window.Registry;

    var toggle = el('td-toggle');
    toggle.addEventListener('click', function () {
      var open = dock.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    /* legend body is static once built — counts are the only live part */
    el('td-lanes').innerHTML = R.laneOrder.map(function (lane) {
      var L = R.lanes[lane];
      return '<li class="td-lane">' + seal(lane) +
               '<div class="td-lane-def">' +
                 '<div class="td-lane-n">' + L.title + ' <b data-lane-n="' + lane + '"></b></div>' +
                 '<div class="td-lane-d">' + L.def + '</div>' +
               '</div>' +
             '</li>';
    }).join('');

    return dock;
  }

  function render(dock) {
    var n = R.count(), skipped = R.skipped(), ok = R.ok(), by = R.countByLane();

    /* head: a seal per lane that actually has sources — the badge system is
       the thing you see first, before any number. */
    el('td-counts').innerHTML = R.laneOrder.filter(function (l) { return by[l]; })
      .map(function (l) { return seal(l, 'xs'); }).join('');

    R.laneOrder.forEach(function (lane) {
      var b = D.querySelector('[data-lane-n="' + lane + '"]');
      if (b) b.textContent = by[lane] ? '· ' + by[lane] : '· none yet';
    });

    var pulse = el('td-pulse');
    pulse.className = 'td-pulse' + (ok === false ? ' down' : ok === null ? ' stale' : '');

    var watch = el('td-watch');
    if (ok === false) {
      watch.innerHTML = 'Cannot read <code>' + R.file + '</code>. It may have been moved or ' +
                        'renamed. Watching anyway — it will appear the moment it is back.';
    } else if (ok === null) {
      watch.innerHTML = 'Opening <code>' + R.file + '</code>…';
    } else {
      watch.innerHTML = 'Watching <code>' + R.file + '</code> · <b>' + n + '</b> source' +
                        (n === 1 ? '' : 's') + ' · last change <b>' + ago(R.lastChange()) + '</b>';
    }

    var warn = el('td-warn');
    if (skipped > 0) {
      warn.hidden = false;
      warn.innerHTML = '<span>⚠</span><span><b>' + skipped + ' row' + (skipped === 1 ? '' : 's') +
        '</b> could not be read and ' + (skipped === 1 ? 'was' : 'were') + ' left out. ' +
        'A row needs at least a title, a lane, and an http URL.</span>';
    } else {
      warn.hidden = true;
    }

    /* empty registry → the dock becomes the invitation, and opens itself once */
    var old = D.getElementById('td-invite');
    if (n === 0 && ok !== null) {
      if (!old) {
        var inv = D.createElement('div');
        inv.id = 'td-invite'; inv.className = 'td-invite';
        inv.innerHTML =
          '<p>' + (skipped > 0
            ? 'The file is there, but none of its rows could be read yet.'
            : '<b>No sources filed yet.</b> <code>' + R.file + '</code> is yours — the app only reads it.') +
          ' Add a row, save, and it appears here in about three seconds. No reload.</p>' +
          '<pre class="td-fmt">' + FORMAT + '</pre>' +
          '<p>Lane must be one of <code>performer-verified</code>, <code>ai-generated</code> or ' +
          '<code>demo</code>. Poster and Notes may be blank.</p>';
        el('td-lanes').insertAdjacentElement('afterend', inv);
        if (!dock.classList.contains('open')) el('td-toggle').click();
      }
    } else if (old) {
      old.remove();
    }
  }

  function boot() {
    var dock = build();
    if (!dock) return;
    render(dock);
    window.Registry.onChange(function () { render(dock); });
    /* the "last change" clock has to tick on its own or it lies */
    setInterval(function () { if (dock.classList.contains('open')) render(dock); }, 5000);
  }

  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
