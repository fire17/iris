/* addons.js — Stremio addon-protocol client for CoolStremio.
 *
 * Exposes window.Addons. Vanilla ES2020, no imports/exports, no dependencies.
 *
 * Protocol facts verified live against https://v3-cinemeta.strem.io (2026-08-21):
 *   - GET <base>/manifest.json                                  -> manifest
 *   - GET <base>/catalog/<type>/<id>.json                       -> {metas:[...], hasMore?}
 *   - GET <base>/catalog/<type>/<id>/<k>=<v>&<k>=<v>.json       -> same, filtered
 *   - GET <base>/meta/<type>/<id>.json                          -> {meta:{...}}
 *   - GET <base>/stream/<type>/<id>.json                        -> {streams:[...]}
 *   - Cinemeta 307-redirects plain catalog pages to cinemeta-catalogs.strem.io;
 *     both hops send `Access-Control-Allow-Origin: *`, so fetch's default
 *     redirect:'follow' handles it transparently.
 *   - Series episode ids embed colons ("tt0903747:1:1"); percent-encoding the
 *     path segment (%3A) is accepted.
 *   - Addons that lack a resource answer with an HTML 404 body, so every
 *     response is parsed defensively rather than trusted.
 *
 * Error discipline: nothing here throws at the UI. Failures resolve to []/null
 * and are reported through Addons.onerror(cb).
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- config --

  var STORAGE_KEY = 'coolstremio.addons.v1';
  var CINEMETA_URL = 'https://v3-cinemeta.strem.io/manifest.json';
  var REQUEST_TIMEOUT = 8000;   // ms, per contract
  var CACHE_LIMIT = 200;        // URL-keyed LRU entries
  var UNHEALTHY_COOLDOWN = 60000; // ms an addon is skipped in fan-outs after failing

  // ------------------------------------------------------------ error bus --

  var errorHandlers = [];

  function emit(scope, url, error) {
    var info = {
      scope: scope,
      url: url || null,
      message: (error && error.message) || String(error || 'unknown error'),
      error: error || null
    };
    for (var i = 0; i < errorHandlers.length; i++) {
      try {
        errorHandlers[i](info);
      } catch (e) {
        /* a broken handler must never break the data layer */
      }
    }
  }

  /** Register an error listener. Returns an unsubscribe function. */
  function onerror(cb) {
    if (typeof cb !== 'function') return function () {};
    errorHandlers.push(cb);
    return function () {
      var i = errorHandlers.indexOf(cb);
      if (i >= 0) errorHandlers.splice(i, 1);
    };
  }

  // ------------------------------------------------------------- LRU cache --

  var cache = new Map();      // url -> parsed JSON (insertion order == recency)
  var inflight = new Map();   // url -> Promise, de-dupes concurrent identical GETs
  var unhealthy = new Map();  // base -> timestamp of last failure

  function cacheGet(url) {
    if (!cache.has(url)) return undefined;
    var v = cache.get(url);
    cache.delete(url);
    cache.set(url, v); // bump to most-recent
    return v;
  }

  function cacheSet(url, value) {
    if (cache.has(url)) cache.delete(url);
    cache.set(url, value);
    while (cache.size > CACHE_LIMIT) {
      cache.delete(cache.keys().next().value); // evict least-recent
    }
  }

  function cacheDropBase(base) {
    var doomed = [];
    cache.forEach(function (_v, k) {
      if (k.indexOf(base) === 0) doomed.push(k);
    });
    doomed.forEach(function (k) { cache.delete(k); });
  }

  function markUnhealthy(base) { if (base) unhealthy.set(base, now()); }
  function markHealthy(base) { if (base) unhealthy.delete(base); }

  function isUnhealthy(base) {
    var t = unhealthy.get(base);
    if (t === undefined) return false;
    if (now() - t > UNHEALTHY_COOLDOWN) { unhealthy.delete(base); return false; }
    return true;
  }

  function now() { return Date.now(); }

  // ----------------------------------------------------------------- fetch --

  /**
   * GET + JSON parse with an 8s AbortController timeout, LRU caching and
   * in-flight de-duplication. Resolves null on any failure (never rejects).
   */
  function fetchJSON(url, opts) {
    opts = opts || {};
    var scope = opts.scope || 'fetch';
    var base = opts.base || null;
    var useCache = opts.cache !== false;

    if (useCache) {
      var hit = cacheGet(url);
      if (hit !== undefined) return Promise.resolve(hit);
    }

    var pending = inflight.get(url);
    if (pending) return pending;

    var p = (function () {
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
      }, opts.timeout || REQUEST_TIMEOUT);

      var init = { credentials: 'omit', redirect: 'follow' };
      if (ctrl) init.signal = ctrl.signal;

      return Promise.resolve()
        .then(function () { return fetch(url, init); })
        .then(function (res) {
          if (!res || !res.ok) {
            throw new Error('HTTP ' + ((res && res.status) || '?') + ' for ' + url);
          }
          return res.text();
        })
        .then(function (text) {
          var json;
          try {
            json = JSON.parse(text);
          } catch (e) {
            // Addons missing a resource answer with an HTML error page.
            throw new Error('non-JSON response from ' + url);
          }
          if (!json || typeof json !== 'object') {
            throw new Error('unexpected payload from ' + url);
          }
          if (useCache) cacheSet(url, json);
          markHealthy(base);
          return json;
        })
        .catch(function (e) {
          var err = e;
          if (e && e.name === 'AbortError') {
            err = new Error('timeout after ' + (opts.timeout || REQUEST_TIMEOUT) + 'ms: ' + url);
          }
          markUnhealthy(base);
          emit(scope, url, err);
          return null;
        })
        .then(function (value) {
          clearTimeout(timer);
          inflight.delete(url);
          return value;
        });
    })();

    inflight.set(url, p);
    return p;
  }

  // --------------------------------------------------------- url building --

  var enc = encodeURIComponent;

  /**
   * Accepts a manifest url, a bare base, or a stremio:// url. Returns the base.
   *
   * `stremio://host/path/manifest.json` is the share form Stremio puts on
   * clipboards and in chat; it is the SAME addon over https. Rewriting it here
   * — the single choke point every install path already funnels through — means
   * a stremio:// link works anywhere a url is accepted. The scheme match is
   * case-insensitive and tolerates the `stremio:` (no slashes) variant.
   */
  function toBase(input) {
    var url = String(input || '').trim();
    if (!url) return '';
    url = url.replace(/^stremio:(\/\/)?/i, 'https://');
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    url = url.replace(/[?#].*$/, '');
    url = url.replace(/\/manifest\.json$/i, '');
    return url.replace(/\/+$/, '');
  }

  function manifestUrlOf(base) { return base + '/manifest.json'; }

  /**
   * Serialise `extra` into the single path segment Stremio expects:
   * `key=value&key=value`. Keys/values are percent-encoded individually — the
   * `&` and `=` separators stay literal (verified live).
   */
  function encodeExtra(extra) {
    if (!extra) return '';
    var pairs = [];
    if (typeof extra === 'string') return extra;
    Object.keys(extra).forEach(function (k) {
      var v = extra[k];
      if (v === undefined || v === null || v === '') return;
      pairs.push(enc(k) + '=' + enc(String(v)));
    });
    return pairs.join('&');
  }

  function catalogUrl(base, type, id, extra) {
    var segs = ['catalog', enc(type), enc(id)];
    var ex = encodeExtra(extra);
    if (ex) segs.push(ex);
    return base + '/' + segs.join('/') + '.json';
  }

  function resourceUrl(base, resource, type, id) {
    return base + '/' + resource + '/' + enc(type) + '/' + enc(id) + '.json';
  }

  // ------------------------------------------------------ manifest reading --

  /**
   * Resolve a resource declaration. `resources[]` entries are either a bare
   * string (inheriting the manifest's top-level types/idPrefixes) or an object
   * {name, types, idPrefixes} that overrides them.
   */
  function resourceEntry(manifest, name) {
    var list = (manifest && manifest.resources) || [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (typeof r === 'string') {
        if (r === name) {
          return {
            name: name,
            types: manifest.types || [],
            idPrefixes: manifest.idPrefixes || null
          };
        }
      } else if (r && r.name === name) {
        return {
          name: name,
          types: r.types || manifest.types || [],
          idPrefixes: r.idPrefixes || manifest.idPrefixes || null
        };
      }
    }
    return null;
  }

  /** True if this addon claims it can answer <resource> for <type>/<id>. */
  function supports(manifest, resource, type, id) {
    var entry = resourceEntry(manifest, resource);
    if (!entry) return false;
    if (type && entry.types && entry.types.length && entry.types.indexOf(type) === -1) {
      return false;
    }
    if (id && entry.idPrefixes && entry.idPrefixes.length) {
      var ok = entry.idPrefixes.some(function (p) { return String(id).indexOf(p) === 0; });
      if (!ok) return false;
    }
    return true;
  }

  /**
   * Normalise a catalog's `extra`. Modern manifests use extra:[{name,options,
   * isRequired}]; older ones (Cinemeta still ships both) use extraSupported /
   * extraRequired / genres. Emit one consistent shape.
   */
  function normalizeExtra(cat) {
    var extra = [];
    var seen = Object.create(null);

    function push(e) {
      if (!e || !e.name || seen[e.name]) return;
      seen[e.name] = true;
      extra.push(e);
    }

    if (Array.isArray(cat.extra)) {
      cat.extra.forEach(function (e) {
        if (typeof e === 'string') push({ name: e });
        else if (e && e.name) {
          push({
            name: e.name,
            options: Array.isArray(e.options) ? e.options.slice() : null,
            isRequired: !!e.isRequired,
            optionsLimit: typeof e.optionsLimit === 'number' ? e.optionsLimit : 1
          });
        }
      });
    }
    if (Array.isArray(cat.extraSupported)) {
      cat.extraSupported.forEach(function (n) { push({ name: n, options: null, isRequired: false }); });
    }
    if (Array.isArray(cat.extraRequired)) {
      cat.extraRequired.forEach(function (n) {
        push({ name: n, options: null, isRequired: true });
        for (var i = 0; i < extra.length; i++) {
          if (extra[i].name === n) extra[i].isRequired = true;
        }
      });
    }
    if (Array.isArray(cat.genres)) {
      for (var j = 0; j < extra.length; j++) {
        if (extra[j].name === 'genre' && !extra[j].options) extra[j].options = cat.genres.slice();
      }
      push({ name: 'genre', options: cat.genres.slice(), isRequired: false });
    }
    return extra;
  }

  function extraNames(extra) {
    return extra.map(function (e) { return e.name; });
  }

  /* Extras the protocol gives a dedicated UI to. Everything else that ships an
     options list is a generic, pill-renderable FILTER. */
  var PLUMBING_EXTRA = { search: 1, skip: 1 };

  /**
   * Split an extra's `options` into selectable values and group headers.
   *
   * Addons have no field for "this option is a section title", so the
   * convention in the wild is to smuggle one in as a decorated option —
   * `**AGE**`, `**POPULAR TAG**`, `--- Region ---`, `— Tags —`. Rendering those
   * as clickable pills sends a garbage genre to the addon and returns nothing,
   * so they are classified here, once, for every consumer.
   *
   * Returns [{kind:'group'|'option', label, value}] in the manifest's order;
   * `value` is null for a group (nothing to send).
   */
  function parseOptions(options) {
    var out = [];
    if (!Array.isArray(options)) return out;
    options.forEach(function (o) {
      if (o === undefined || o === null) return;
      var raw = String(o);
      var label = raw.trim();
      if (!label) return;
      var m = label.match(/^(?:\*{2,}|-{2,}|—+|=+)\s*(.+?)\s*(?:\*{2,}|-{2,}|—+|=+)$/);
      if (m && m[1]) {
        out.push({ kind: 'group', label: m[1].trim(), value: null });
        return;
      }
      out.push({ kind: 'option', label: label, value: raw });
    });
    return out;
  }

  /** The option-list extras a UI can offer as filters, in manifest order. */
  function filterExtras(extra) {
    return (extra || []).filter(function (e) {
      if (!e || !e.name || PLUMBING_EXTRA[e.name]) return false;
      return !!(e.options && e.options.length);
    });
  }

  function isValidManifest(m) {
    return !!(m && typeof m === 'object' && typeof m.id === 'string' && m.id &&
      (Array.isArray(m.resources) || Array.isArray(m.catalogs)));
  }

  // --------------------------------------------------------- installed set --

  var installed = []; // [{id, url (base), manifest}] — array order IS install order

  function safeStorage() {
    try {
      var s = global.localStorage;
      // touch it: Safari private mode throws on access/write
      s.getItem(STORAGE_KEY);
      return s;
    } catch (e) {
      return null;
    }
  }

  function loadInstalled() {
    var s = safeStorage();
    if (!s) return [];
    try {
      var raw = s.getItem(STORAGE_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(function (a) {
        return a && typeof a.url === 'string' && isValidManifest(a.manifest);
      }).map(function (a) {
        return { id: a.manifest.id, url: toBase(a.url), manifest: a.manifest };
      });
    } catch (e) {
      emit('storage', null, e);
      return [];
    }
  }

  function persist() {
    var s = safeStorage();
    if (!s) return;
    try {
      s.setItem(STORAGE_KEY, JSON.stringify(installed.map(function (a) {
        return { url: a.url, manifest: a.manifest };
      })));
    } catch (e) {
      emit('storage', null, e);
    }
  }

  function indexOfId(id) {
    for (var i = 0; i < installed.length; i++) {
      if (installed[i].id === id) return i;
    }
    return -1;
  }

  function byId(id) {
    var i = indexOfId(id);
    return i === -1 ? null : installed[i];
  }

  // ------------------------------------------------------------ public API --

  /**
   * Install (or refresh) an addon by manifest url.
   * Resolves the manifest, or null if it could not be fetched/validated.
   */
  function add(manifestUrl) {
    var base = toBase(manifestUrl);
    if (!base) {
      emit('add', manifestUrl, new Error('empty or invalid manifest url'));
      return Promise.resolve(null);
    }
    return fetchJSON(manifestUrlOf(base), { scope: 'add', base: base, cache: false })
      .then(function (manifest) {
        if (!isValidManifest(manifest)) {
          if (manifest) emit('add', manifestUrlOf(base), new Error('not a valid Stremio manifest'));
          return null;
        }
        var entry = { id: manifest.id, url: base, manifest: manifest };
        var at = indexOfId(manifest.id);
        if (at >= 0) installed[at] = entry;  // refresh in place, keep order
        else installed.push(entry);
        cacheDropBase(base);
        markHealthy(base);
        persist();
        return manifest;
      });
  }

  /** Uninstall by addon id. Returns true if something was removed. */
  function remove(id) {
    var at = indexOfId(id);
    if (at === -1) return false;
    var gone = installed.splice(at, 1)[0];
    cacheDropBase(gone.url);
    unhealthy.delete(gone.url);
    persist();
    return true;
  }

  /** Installed addons in install order: [{id, url, manifest, name}]. */
  function list() {
    return installed.map(function (a) {
      return {
        id: a.id,
        url: a.url,
        manifest: a.manifest,
        name: a.manifest.name || a.id
      };
    });
  }

  /** Reorder installed addons to match the given id order. Unlisted ids keep tail order. */
  function reorder(ids) {
    if (!Array.isArray(ids)) return list();
    var next = [];
    ids.forEach(function (id) {
      var a = byId(id);
      if (a && next.indexOf(a) === -1) next.push(a);
    });
    installed.forEach(function (a) { if (next.indexOf(a) === -1) next.push(a); });
    installed = next;
    persist();
    return list();
  }

  /** Move one addon by a relative offset (-1 up, +1 down). */
  function move(id, delta) {
    var at = indexOfId(id);
    if (at === -1) return list();
    var to = Math.max(0, Math.min(installed.length - 1, at + (delta | 0)));
    if (to === at) return list();
    var a = installed.splice(at, 1)[0];
    installed.splice(to, 0, a);
    persist();
    return list();
  }

  /** Every catalog across every installed addon, in install order. */
  function catalogs() {
    var out = [];
    installed.forEach(function (a) {
      var cats = Array.isArray(a.manifest.catalogs) ? a.manifest.catalogs : [];
      cats.forEach(function (c) {
        if (!c || !c.type || !c.id) return;
        var extra = normalizeExtra(c);
        out.push({
          addonId: a.id,
          addonName: a.manifest.name || a.id,
          type: c.type,
          id: c.id,
          name: c.name || c.id,
          extra: extra,
          // convenience flags for the UI
          supportsSearch: extraNames(extra).indexOf('search') !== -1,
          supportsSkip: extraNames(extra).indexOf('skip') !== -1,
          /* every option-list extra the UI can render as filter pills, with the
             group headers already classified — generic, manifest-driven */
          filters: filterExtras(extra).map(function (e) {
            return {
              name: e.name,
              isRequired: !!e.isRequired,
              optionsLimit: e.optionsLimit || 1,
              options: parseOptions(e.options)
            };
          }),
          required: extra.filter(function (e) { return e.isRequired; })
            .map(function (e) { return e.name; })
        });
      });
    });
    return out;
  }

  function metasOf(payload) {
    if (!payload || !Array.isArray(payload.metas)) return [];
    return payload.metas.filter(function (m) { return m && m.id; });
  }

  /**
   * HONESTY LAW. Every item that came out of an addon is stamped with the addon
   * that served it, at the ONE seam where addon data enters the app. The UI
   * reads `external` to render an "external · unverified source" treatment and
   * to refuse it the registry's verified lane badges — addon content must never
   * be able to masquerade as performer-verified. A meta with no `external` is,
   * by construction, first-party registry content.
   */
  function stampOrigin(m, a) {
    if (!m || !a) return m;
    try {
      m.external = a.id;
      m.externalName = (a.manifest && a.manifest.name) || a.id;
    } catch (e) { /* frozen meta — the UI falls back to unverified-by-default */ }
    return m;
  }

  /** hasMore as the addon actually stated it: true, false, or null for "did not say". */
  function statedHasMore(payload) {
    if (!payload || typeof payload.hasMore === 'undefined') return null;
    return !!payload.hasMore;
  }

  /**
   * Fetch one catalog page.
   * `extra` is a plain object, e.g. {search:'matrix', genre:'Action', skip:100}.
   * Resolves an array of metas; `.hasMore` is stamped on it for pagination.
   */
  function catalog(addonId, type, id, extra) {
    var a = byId(addonId);
    if (!a) {
      emit('catalog', null, new Error('addon not installed: ' + addonId));
      return Promise.resolve(withHasMore([], false));
    }
    var url = catalogUrl(a.url, type, id, extra);
    return fetchJSON(url, { scope: 'catalog', base: a.url }).then(function (payload) {
      var metas = metasOf(payload).map(function (m) {
        if (!m.type) m.type = type;
        return stampOrigin(m, a);
      });
      /* `null` (addon said nothing about hasMore) is NOT `false`. Collapsing the
         two made the board declare itself exhausted after page one for every
         addon that simply omits the field — which is most of them. */
      return withHasMore(metas, statedHasMore(payload));
    });
  }

  function withHasMore(arr, hasMore) {
    try {
      Object.defineProperty(arr, 'hasMore', {
        value: hasMore, enumerable: false, configurable: true, writable: true
      });
    } catch (e) { /* frozen/exotic array — pagination hint is optional */ }
    return arr;
  }

  /** Catalogs that can actually answer a free-text search right now. */
  function searchableCatalogs(type) {
    return catalogs().filter(function (c) {
      if (type && c.type !== type) return false;
      if (!c.supportsSearch) return false;
      // Every required extra must be satisfiable by `search` alone.
      return c.required.every(function (n) { return n === 'search'; });
    });
  }

  /**
   * Fan out a query to every search-capable catalog, merge and dedupe by
   * type+id, preserving addon install order then catalog order.
   * `opts`: {type} to restrict to one content type.
   */
  function search(q, opts) {
    opts = opts || {};
    var query = String(q || '').trim();
    if (!query) return Promise.resolve([]);

    var targets = searchableCatalogs(opts.type).filter(function (c) {
      var a = byId(c.addonId);
      return a && !isUnhealthy(a.url);
    });
    if (!targets.length) return Promise.resolve([]);

    return Promise.all(targets.map(function (c) {
      var a = byId(c.addonId);
      var url = catalogUrl(a.url, c.type, c.id, { search: query });
      return fetchJSON(url, { scope: 'search', base: a.url }).then(function (payload) {
        return { cat: c, addon: a, metas: metasOf(payload) };
      });
    })).then(function (results) {
      var seen = Object.create(null);
      var merged = [];
      results.forEach(function (r) {
        r.metas.forEach(function (m) {
          var key = (m.type || r.cat.type) + ' ' + m.id;
          if (seen[key]) return;
          seen[key] = true;
          if (!m.type) m.type = r.cat.type;
          merged.push(stampOrigin(m, r.addon));
        });
      });
      return merged;
    });
  }

  /**
   * Resolve full metadata, asking each addon that declares `meta` for this
   * type/idPrefix in install order; the first real answer wins.
   */
  function meta(type, id) {
    if (!type || !id) return Promise.resolve(null);
    var providers = installed.filter(function (a) {
      return supports(a.manifest, 'meta', type, id);
    });
    if (!providers.length) return Promise.resolve(null);

    var i = 0;
    function next() {
      if (i >= providers.length) return Promise.resolve(null);
      var a = providers[i++];
      if (isUnhealthy(a.url)) return next();
      return fetchJSON(resourceUrl(a.url, 'meta', type, id), { scope: 'meta', base: a.url })
        .then(function (payload) {
          if (payload && payload.meta && payload.meta.id) {
            var m = payload.meta;
            if (!m.type) m.type = type;
            return stampOrigin(m, a);
          }
          return next();
        });
    }
    return next();
  }

  /**
   * Every stream every stream-capable addon offers for type/id.
   * Streams are labelled with addonId/addonName and merged in install order.
   */
  function streams(type, id) {
    if (!type || !id) return Promise.resolve([]);
    var providers = installed.filter(function (a) {
      return supports(a.manifest, 'stream', type, id) && !isUnhealthy(a.url);
    });
    if (!providers.length) return Promise.resolve([]);

    return Promise.all(providers.map(function (a) {
      return fetchJSON(resourceUrl(a.url, 'stream', type, id), { scope: 'streams', base: a.url })
        .then(function (payload) {
          var raw = (payload && Array.isArray(payload.streams)) ? payload.streams : [];
          return raw.filter(isPlayableStream).map(function (s) {
            s.addonId = a.id;
            s.addonName = a.manifest.name || a.id;
            return s;
          });
        });
    })).then(function (groups) {
      var out = [];
      groups.forEach(function (g) { out.push.apply(out, g); });
      return out;
    });
  }

  /** A stream is usable only if it carries one of the protocol's source fields. */
  function isPlayableStream(s) {
    return !!(s && typeof s === 'object' &&
      (s.url || s.externalUrl || s.infoHash || s.ytId));
  }

  // ------------------------------------------------------------------ init --

  installed = loadInstalled();

  /* Out-of-the-box addons — shipped installed on first run, seeded ONCE into existing
   * installs (fire17, 2026-08-23: torrentio + chaturbate ready out of the box). The
   * one-shot flag means a user's later removal is respected forever.
   * (stremio://chaturbate.stremio.homes/f/manifest.json is the deep-link form of the
   *  https URL below.) */
  var SEED_KEY = 'coolstremio.addons.seed.v1';
  var SEED = [
    'https://torrentio.strem.fun/manifest.json',
    'https://chaturbate.stremio.homes/f/manifest.json'
  ];
  (function seedDefaults() {
    var s = safeStorage();
    if (!s) return;
    try { if (s.getItem(SEED_KEY)) return; s.setItem(SEED_KEY, '1'); } catch (e) { return; }
    Promise.all(SEED.map(add)).then(function (ms) {
      /* first-ever seed: if the user is sitting on home already, rebuild it so the
         new rows appear without a manual refresh */
      if (ms.filter(Boolean).length && (!location.hash || /^#(home)?$/.test(location.hash))) {
        try { window.dispatchEvent(new Event('hashchange')); } catch (e) {}
      }
    });
  })();

  var ready = (function () {
    if (installed.length) return Promise.resolve(list());
    return add(CINEMETA_URL).then(function () { return list(); });
  })();

  // ---------------------------------------------------------------- export --

  global.Addons = {
    // installed set
    add: add,
    remove: remove,
    list: list,
    reorder: reorder,
    move: move,
    ready: ready,

    // data
    catalogs: catalogs,
    catalog: catalog,
    search: search,
    meta: meta,
    streams: streams,

    // plumbing
    onerror: onerror,
    clearCache: function () { cache.clear(); unhealthy.clear(); },
    supports: supports,

    /* url normalisation, exported so EVERY entry point that accepts a
       manifest url (settings preview, install, deep links) rewrites
       stremio:// identically instead of each growing its own parser */
    toBase: toBase,
    manifestUrl: function (input) {
      var b = toBase(input);
      return b ? manifestUrlOf(b) : '';
    },

    /* generic manifest-extra helpers for filter UIs */
    parseOptions: parseOptions,
    filterExtras: filterExtras,

    // constants, so other modules never hardcode them
    CINEMETA_URL: CINEMETA_URL,
    REQUEST_TIMEOUT: REQUEST_TIMEOUT,
    CACHE_LIMIT: CACHE_LIMIT,

    // introspection, for the settings view + tests
    _stats: function () {
      return { cache: cache.size, inflight: inflight.size, unhealthy: unhealthy.size };
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
