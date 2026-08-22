/* hls-segment-map.js — "which HLS segment URLs cover media time [t, t+dur]?"
 *
 * Two ways in, one shape out:
 *   HlsSegmentMap.fromInstance(hls)   read-only peek at a LIVE hls.js instance
 *                                     (js/player.js keeps it as S.hls)
 *   HlsSegmentMap.fromManifest(url)   -> Promise<map>, standalone fetch+parse
 *
 * HARD RULE — fromInstance NEVER touches playback. It only reads properties.
 * No loadSource/attachMedia/detachMedia/startLoad/stopLoad, no currentLevel
 * write, no seek, no play/pause, no volume/muted write. Everything it reads is
 * wrapped in try/catch so a getter that throws on a half-loaded level cannot
 * bubble into the caller's playback code.
 *
 * ES5-only on purpose (matches this codebase): var + function, no class /
 * arrow / let / const / template literals / import.
 *
 * Browser: window.HlsSegmentMap.   Node: module.exports.
 */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------- utilities */

  var OVERLAP_EPS = 0.01; /* seconds — see segmentsFor() */

  function num(v, dflt) {
    var n = parseFloat(v);
    return isFinite(n) ? n : dflt;
  }

  /* Absolute-ise a playlist-relative URI. `URL` exists in both browsers and
     node >= 10, so no hand-rolled path joiner is needed. */
  function resolveUrl(uri, base) {
    if (!uri) return uri;
    try { return new URL(uri, base).href; } catch (e) { return uri; }
  }

  /* `#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1,mp4a"` -> attribute map.
     Quoted values may contain commas, so split by hand rather than by /,/. */
  function parseAttrs(line) {
    var out = {};
    var body = line.indexOf(':') >= 0 ? line.slice(line.indexOf(':') + 1) : '';
    var i = 0, key = '', val = '', inKey = true, quoted = false;
    function flush() {
      key = key.trim();
      if (key) out[key.toUpperCase()] = val;
      key = ''; val = ''; inKey = true;
    }
    for (i = 0; i < body.length; i++) {
      var c = body.charAt(i);
      if (inKey) {
        if (c === '=') { inKey = false; } else { key += c; }
      } else if (quoted) {
        if (c === '"') quoted = false; else val += c;
      } else if (c === '"' && val === '') {
        quoted = true;
      } else if (c === ',') {
        flush();
      } else {
        val += c;
      }
    }
    flush();
    return out;
  }

  function containerOf(url, hasMap) {
    if (hasMap) return 'fmp4';
    var clean = String(url || '').split('?')[0].split('#')[0].toLowerCase();
    if (/\.ts$/.test(clean)) return 'ts';
    if (/\.(m4s|mp4|m4a|m4v|cmf[avt]?)$/.test(clean)) return 'fmp4';
    if (/\.aac$/.test(clean)) return 'aac';
    return 'unknown';
  }

  /* ---------------------------------------------------------------- the map */

  /* segs: [{url,start,duration,sn,byteRange,initUrl}] (already absolute) */
  function makeMap(segs, info) {
    var total = 0, i;
    for (i = 0; i < segs.length; i++) total += segs[i].duration || 0;
    /* a playlist that starts at a nonzero PDT/offset still reports real span */
    if (segs.length) total = (segs[segs.length - 1].start + segs[segs.length - 1].duration) - segs[0].start;

    var map = {
      segments: segs,
      info: {
        count: segs.length,
        totalDuration: Math.round(total * 1000) / 1000,
        container: info.container || 'unknown',
        audioOnly: !!info.audioOnly,
        variantUrl: info.variantUrl || null,
        initUrl: info.initUrl || null,
        source: info.source || 'manifest',
        live: !!info.live,
        firstStart: segs.length ? segs[0].start : 0
      },
      /* every segment whose [start, start+duration) overlaps [t, t+dur).
         dur <= 0 degrades to a point query: the one segment containing t.
         EPS: hls.js reports PTS-derived starts, so a neighbouring segment can
         overlap the window by microseconds (observed: 0.0078s on the mux test
         stream). A segment contributing less than EPS seconds of audio is not
         worth a whole extra segment download, so it is dropped. Pass an explicit
         third argument to override (0 = strict IETF overlap). */
      segmentsFor: function (startSec, durSec, epsilon) {
        var t0 = num(startSec, 0);
        var d = num(durSec, 0);
        var eps = num(epsilon, OVERLAP_EPS);
        var t1 = d > 0 ? t0 + d : t0;
        var out = [], j;
        for (j = 0; j < this.segments.length; j++) {
          var s = this.segments[j];
          var a = s.start, b = s.start + s.duration;
          var hit = d > 0 ? (a < t1 - eps && b > t0 + eps) : (a <= t0 && b > t0);
          if (hit) {
            out.push({
              url: s.url,
              start: s.start,
              duration: s.duration,
              sn: typeof s.sn === 'number' ? s.sn : j,
              byteRange: s.byteRange || null,
              initUrl: s.initUrl || null
            });
          }
        }
        return out;
      }
    };
    return map;
  }

  /* ------------------------------------------------------- playlist parsing */

  /* Parse a MEDIA playlist (the one with #EXTINF lines). */
  function parseMediaPlaylist(text, playlistUrl, extra) {
    var lines = String(text).split(/\r?\n/);
    var segs = [];
    var start = 0;
    var pendingDur = 0, pendingRange = null, sn = 0;
    var curInit = null, sawMap = false, live = true, i;

    for (i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line.charAt(0) === '#') {
        if (line.indexOf('#EXTINF:') === 0) {
          pendingDur = num(line.slice(8).split(',')[0], 0);
        } else if (line.indexOf('#EXT-X-BYTERANGE:') === 0) {
          /* n[@o] — omitted offset means "right after the previous sub-range" */
          var br = line.slice(17).split('@');
          var len = num(br[0], 0);
          var off = br.length > 1 ? num(br[1], 0)
            : (segs.length && segs[segs.length - 1].byteRange
              ? segs[segs.length - 1].byteRange.offset + segs[segs.length - 1].byteRange.length : 0);
          pendingRange = { offset: off, length: len, end: off + len - 1,
            header: 'bytes=' + off + '-' + (off + len - 1) };
        } else if (line.indexOf('#EXT-X-MAP:') === 0) {
          var a = parseAttrs(line);
          sawMap = true;
          curInit = resolveUrl(a.URI, playlistUrl);
        } else if (line.indexOf('#EXT-X-MEDIA-SEQUENCE:') === 0) {
          sn = num(line.slice(22), 0);
        } else if (line.indexOf('#EXT-X-ENDLIST') === 0) {
          live = false;
        }
        continue;
      }
      /* a bare URI line closes the pending #EXTINF */
      var url = resolveUrl(line, playlistUrl);
      segs.push({
        url: url, start: Math.round(start * 1e6) / 1e6, duration: pendingDur,
        sn: sn, byteRange: pendingRange, initUrl: curInit
      });
      start += pendingDur;
      sn += 1;
      pendingDur = 0; pendingRange = null;
    }

    extra = extra || {};
    return makeMap(segs, {
      container: containerOf(segs.length ? segs[0].url : '', sawMap),
      audioOnly: !!extra.audioOnly,
      variantUrl: playlistUrl,
      initUrl: curInit,
      source: 'manifest',
      live: live
    });
  }

  /* Master playlist -> the cheapest variant we can use.
     Preference order (cheapest audio bytes first):
       1. #EXT-X-MEDIA:TYPE=AUDIO with its own URI  (audio-only rendition)
       2. the LOWEST-BANDWIDTH #EXT-X-STREAM-INF variant                     */
  function pickVariant(text, masterUrl) {
    var lines = String(text).split(/\r?\n/);
    var audio = null, variants = [], i;
    for (i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf('#EXT-X-MEDIA:') === 0) {
        var a = parseAttrs(line);
        if ((a.TYPE || '').toUpperCase() === 'AUDIO' && a.URI) {
          var isDefault = (a.DEFAULT || '').toUpperCase() === 'YES';
          if (!audio || (isDefault && !audio.isDefault)) {
            audio = { url: resolveUrl(a.URI, masterUrl), name: a.NAME || a['GROUP-ID'] || '',
              lang: a.LANGUAGE || '', isDefault: isDefault, audioOnly: true };
          }
        }
      } else if (line.indexOf('#EXT-X-STREAM-INF:') === 0) {
        var at = parseAttrs(line);
        var uri = '';
        for (var j = i + 1; j < lines.length; j++) {
          var nx = lines[j].trim();
          if (!nx) continue;
          if (nx.charAt(0) === '#') continue;
          uri = nx; break;
        }
        if (uri) {
          variants.push({
            url: resolveUrl(uri, masterUrl),
            bandwidth: num(at.BANDWIDTH, num(at['AVERAGE-BANDWIDTH'], Infinity)),
            resolution: at.RESOLUTION || '',
            codecs: at.CODECS || '',
            audioGroup: at.AUDIO || '',
            audioOnly: !/avc|hvc|hev|vp0?9|av01|dvh/i.test(at.CODECS || '') && !at.RESOLUTION
          });
        }
      }
    }
    variants.sort(function (x, y) { return x.bandwidth - y.bandwidth; });
    return { audio: audio, variants: variants, chosen: audio || variants[0] || null };
  }

  function isMaster(text) {
    return /#EXT-X-STREAM-INF/.test(text) && !/#EXTINF/.test(text);
  }

  function fetchText(url) {
    var f = (typeof fetch === 'function') ? fetch : (root && root.fetch);
    if (typeof f !== 'function') return Promise.reject(new Error('no fetch available'));
    return f(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
      return r.text();
    });
  }

  /* --------------------------------------------------------- public: manifest */

  function fromManifest(masterUrl) {
    var meta = { audioOnlyAvailable: false, master: masterUrl, variants: [] };
    return fetchText(masterUrl).then(function (text) {
      if (!isMaster(text)) {
        var m0 = parseMediaPlaylist(text, masterUrl, {});
        m0.info.masterUrl = null;
        m0.info.audioOnlyAvailable = false;
        m0.info.variantsSeen = [];
        return m0;
      }
      var pick = pickVariant(text, masterUrl);
      meta.audioOnlyAvailable = !!pick.audio;
      meta.variants = pick.variants;
      if (!pick.chosen) throw new Error('master playlist has no usable variant: ' + masterUrl);
      return fetchText(pick.chosen.url).then(function (mtext) {
        var m = parseMediaPlaylist(mtext, pick.chosen.url, { audioOnly: !!pick.chosen.audioOnly });
        m.info.masterUrl = masterUrl;
        m.info.audioOnlyAvailable = meta.audioOnlyAvailable;
        m.info.variantsSeen = pick.variants.map(function (v) {
          return { bandwidth: v.bandwidth, resolution: v.resolution, codecs: v.codecs, url: v.url };
        });
        m.info.audioRendition = pick.audio
          ? { name: pick.audio.name, lang: pick.audio.lang, url: pick.audio.url } : null;
        return m;
      });
    });
  }

  /* --------------------------------------------------------- public: instance */

  function safe(fn, dflt) {
    try {
      var v = fn();
      return (v === undefined || v === null) ? dflt : v;
    } catch (e) { return dflt; }
  }

  /* Pull the byte range off an hls.js Fragment, whichever accessor this build
     exposes. Never throws. */
  function fragByteRange(f) {
    var arr = safe(function () { return f.byteRange; }, null);
    if (arr && arr.length === 2 && isFinite(arr[0]) && isFinite(arr[1]) && arr[1] > arr[0]) {
      return { offset: arr[0], length: arr[1] - arr[0], end: arr[1] - 1,
        header: 'bytes=' + arr[0] + '-' + (arr[1] - 1) };
    }
    var s = safe(function () { return f.byteRangeStartOffset; }, null);
    var e = safe(function () { return f.byteRangeEndOffset; }, null);
    if (isFinite(s) && isFinite(e) && e > s) {
      return { offset: s, length: e - s, end: e - 1, header: 'bytes=' + s + '-' + (e - 1) };
    }
    return null;
  }

  /* READ-ONLY. Returns null when nothing is parsed yet (call again after
     Hls.Events.LEVEL_LOADED). */
  function fromInstance(hls) {
    if (!hls) return null;

    var levels = safe(function () { return hls.levels; }, null);
    if (!levels || !levels.length) return null;

    /* Prefer the level the user is actually playing; fall back to the first
       level that has parsed details. We never WRITE currentLevel. */
    var idx = safe(function () { return hls.currentLevel; }, -1);
    if (!(idx >= 0 && levels[idx] && safe(function () { return levels[idx].details; }, null))) {
      idx = safe(function () { return hls.loadLevel; }, -1);
    }
    if (!(idx >= 0 && levels[idx] && safe(function () { return levels[idx].details; }, null))) {
      idx = -1;
      for (var k = 0; k < levels.length; k++) {
        if (safe(function () { return levels[k].details; }, null)) { idx = k; break; }
      }
    }
    if (idx < 0) return null;

    var level = levels[idx];
    var details = safe(function () { return level.details; }, null);
    var frags = safe(function () { return details.fragments; }, null);
    if (!frags || !frags.length) return null;

    var segs = [], i;
    for (i = 0; i < frags.length; i++) {
      var f = frags[i];
      var url = safe(function () { return f.url; }, null);
      if (!url) continue;
      var init = safe(function () { return f.initSegment; }, null);
      segs.push({
        url: url,
        start: safe(function () { return f.start; }, 0),
        duration: safe(function () { return f.duration; }, 0),
        sn: safe(function () { return f.sn; }, i),
        byteRange: fragByteRange(f),
        initUrl: init ? safe(function () { return init.url; }, null) : null
      });
    }
    if (!segs.length) return null;

    var codecs = (safe(function () { return level.codecSet; }, '') || '') + ' ' +
      (safe(function () { return level.videoCodec; }, '') || '') + ' ' +
      (safe(function () { return level.attrs && level.attrs.CODECS; }, '') || '');
    var hasVideo = !!safe(function () { return level.videoCodec; }, null) ||
      !!safe(function () { return level.width; }, 0) ||
      /avc|hvc|hev|vp0?9|av01|dvh/i.test(codecs);

    var map = makeMap(segs, {
      container: containerOf(segs[0].url, !!segs[0].initUrl),
      audioOnly: !hasVideo,
      variantUrl: safe(function () { return level.url && level.url[0]; }, null) ||
        safe(function () { return level.uri; }, null) ||
        safe(function () { return details.url; }, null),
      initUrl: segs[0].initUrl,
      source: 'instance',
      live: safe(function () { return details.live; }, false)
    });
    map.info.levelIndex = idx;
    map.info.levelCount = levels.length;
    map.info.bitrate = safe(function () { return level.bitrate; }, null);
    map.info.resolution = (safe(function () { return level.width; }, 0) || '?') + 'x' +
      (safe(function () { return level.height; }, 0) || '?');
    map.info.audioTracks = safe(function () {
      return (hls.audioTracks || []).map(function (t) {
        return { name: t.name, lang: t.lang, url: t.url, groupId: t.groupId };
      });
    }, []);
    return map;
  }

  var API = {
    fromInstance: fromInstance,
    fromManifest: fromManifest,
    /* exported for tests / reuse */
    _parseMediaPlaylist: parseMediaPlaylist,
    _pickVariant: pickVariant,
    _parseAttrs: parseAttrs,
    _isMaster: isMaster
  };

  if (typeof module === 'object' && module.exports) module.exports = API;
  if (root) root.HlsSegmentMap = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
