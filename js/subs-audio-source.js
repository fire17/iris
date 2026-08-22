/* =============================================================================
 * subs-audio-source.js  —  window.SubsAudioSource
 *
 * WINDOW-SCOPED AUDIO for the whisper auto-sync engine, on sources that can
 * never be whole-decoded: a streaming TORRENT, an HLS stream, or a direct file
 * that is simply too big.
 *
 * THE PROBLEM IT SOLVES
 *   js/whisper-engine.js used to need a whole-file AudioBuffer. A 2-hour film
 *   decodes to GBs of PCM, so auto-sync had to NO-OP on torrent/HLS playback and
 *   the subtitles stayed raw. But the coherence matcher only ever listens around
 *   the FIRST-sentence and LAST-sentence timestamps — about two 20-second
 *   windows, a few hundred KB of audio. So we never needed the film: we needed
 *   the ability to cut a small window out of it.
 *
 * WHAT THIS MODULE IS
 *   A factory for WINDOW PROVIDERS, the contract js/whisper-engine.js accepts:
 *
 *       { audioWindow(startSec, durSec) -> Promise<{buffer, mime, startSec}>,
 *         name, cost: 'cheap'|'costly' }
 *
 *   Three of them:
 *     forTorrentFile(file)  — random byte ranges out of a WebTorrent file, MP4
 *                             sample tables mapped to a time window, AAC re-framed
 *                             as ADTS. Reads a few hundred KB, never the film.
 *     forHls(hls, url)      — hls.js's own fragment list (READ-ONLY: we never
 *                             touch the user's playback) maps time -> segment
 *                             URLs; segments are fetched separately and demuxed.
 *     forUrl(url)           — the same MP4 window trick over plain HTTP Range,
 *                             which also lifts the old 80 MB whole-decode ceiling
 *                             for big direct files.
 *
 * WHY NOT TAP THE <video>
 *   createMediaElementSource() re-routes the element's audio through WebAudio and
 *   would MUTE the user's playback (and only ever yields audio at 1x, live). The
 *   AUDIO-LEAK LAW here is absolute: this module NEVER touches the media element,
 *   never plays anything, never changes volume. It only reads bytes.
 *
 * HONEST LIMITS (see .grand/reports/subs-stream-audio.html)
 *   - AAC-LC (mp4a.40.2) is the supported audio codec; AC-3/EC-3/Opus tracks
 *     return a typed error and auto-sync degrades to raw subtitles rather than
 *     guessing. MKV/WebM containers are not parsed here.
 *   - A torrent window near the END of a film needs those pieces; if the swarm
 *     cannot supply them the window resolves empty and the sync stays lazy
 *     (front-anchor only), which is exactly the intended fallback.
 *
 * No external deps, no CDN. ES5-compatible to match the codebase.
 * ==========================================================================*/
(function (window) {
  'use strict';

  var HAS_WIN = typeof window !== 'undefined' && !!window;

  /* ------------------------------------------------------------------ utils */
  function u8(x) {
    if (!x) return new Uint8Array(0);
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (x.buffer instanceof ArrayBuffer) return new Uint8Array(x.buffer, x.byteOffset || 0, x.byteLength);
    return new Uint8Array(0);
  }
  function abOf(x) {
    var a = u8(x);
    return a.buffer.byteLength === a.byteLength && a.byteOffset === 0 ? a.buffer : a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength);
  }
  function concat(chunks) {
    var n = 0, i;
    for (i = 0; i < chunks.length; i++) n += chunks[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < chunks.length; i++) { out.set(chunks[i], o); o += chunks[i].length; }
    return out;
  }
  function dep(name) { return HAS_WIN ? window[name] : null; }

  /* ==========================================================================
   * READERS — "give me bytes [start,end) of this thing"
   * ========================================================================*/

  /* HTTP Range reader. Works for any static host that honours Range (all CDNs
     and web-seeds do). Returns null-ish on failure so callers can degrade. */
  function httpReader(url) {
    return function (start, end) {
      return fetch(url, { headers: { Range: 'bytes=' + start + '-' + (end - 1) } })
        .then(function (r) {
          if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
          return r.arrayBuffer();
        });
    };
  }

  function httpSize(url) {
    return fetch(url, { method: 'HEAD' }).then(function (r) {
      var cl = r && r.headers && r.headers.get && r.headers.get('content-length');
      return cl ? parseInt(cl, 10) : null;
    })['catch'](function () { return null; });
  }

  /* WebTorrent File reader. WebTorrent 3.x exposes file.stream({start,end})
     (a WHATWG ReadableStream over that byte range) — requesting a range also
     selects the covering pieces, so we never pull the whole film. Older shapes
     (createReadStream) are handled too. Whatever the shape, the caller only ever
     sees "bytes in, promise of an ArrayBuffer out". */
  function torrentReader(file) {
    return function (start, end) {
      return new Promise(function (resolve, reject) {
        var opts = { start: start, end: end - 1 };   // WebTorrent ranges are INCLUSIVE
        var s;
        try {
          if (typeof file.stream === 'function') s = file.stream(opts);
          else if (typeof file.createReadStream === 'function') s = file.createReadStream(opts);
          else return reject(new Error('torrent-file-has-no-range-api'));
        } catch (e) { return reject(e); }

        // WHATWG ReadableStream (3.x)
        if (s && typeof s.getReader === 'function') {
          var rd = s.getReader(), parts = [];
          (function pump() {
            rd.read().then(function (res) {
              if (res.done) return resolve(abOf(concat(parts)));
              parts.push(u8(res.value));
              pump();
            }, reject);
          })();
          return;
        }
        // node-style EventEmitter stream (older builds)
        if (s && typeof s.on === 'function') {
          var acc = [];
          s.on('data', function (d) { acc.push(u8(d)); });
          s.on('end', function () { resolve(abOf(concat(acc))); });
          s.on('error', reject);
          return;
        }
        reject(new Error('torrent-stream-shape-unknown'));
      });
    };
  }

  /* ==========================================================================
   * PROVIDERS
   * ========================================================================*/

  /* Shared MP4-over-random-reads provider body. `read` is any of the readers
     above; `size` is the file length. Lazily opens the MP4 sample tables ONCE
     (a few reads of box headers + the moov), then each window is a couple of
     coalesced range reads. */
  function mp4Provider(name, read, size, cost) {
    var MP4 = dep('MP4AudioWindow');
    if (!MP4 || typeof MP4.open !== 'function') return null;
    var openP = null, failed = false;

    function ex() {
      if (failed) return Promise.resolve(null);
      if (!openP) {
        openP = Promise.resolve(MP4.open(read, size))['catch'](function () { failed = true; return null; });
      }
      return openP;
    }

    return {
      name: name,
      cost: cost || 'costly',
      // let callers (and the debug panel) see what we parsed, once known
      info: function () { return ex().then(function (x) { return x ? x.info : null; }); },
      audioWindow: function (startSec, durSec) {
        return ex().then(function (x) {
          if (!x) return null;
          return x.window(startSec, durSec);
        }).then(function (w) {
          if (!w || w.error || !w.buffer) return null;
          return { buffer: w.buffer, mime: w.mime || 'audio/aac', startSec: (typeof w.startSec === 'number') ? w.startSec : startSec };
        })['catch'](function () { return null; });
      }
    };
  }

  /* --- torrent ------------------------------------------------------------ */
  /* A WebTorrent file that window.BT is streaming. The bytes are already coming
     to the browser peer-to-peer; we just ask for a different small slice of them.
     No server, no extra transport, no new law surface. */
  function forTorrentFile(file) {
    if (!file || !(file.length > 0)) return null;
    if (!/\.(mp4|m4v|mov|m4a)$/i.test(String(file.name || ''))) {
      // MKV/AVI hold their audio in a container we do not parse. Say so by
      // returning null: auto-sync then simply stays lazy instead of guessing.
      if (!/\.(mp4|m4v|mov|m4a)$/i.test(String(file.path || ''))) return null;
    }
    return mp4Provider('torrent:' + (file.name || 'file'), torrentReader(file), file.length, 'costly');
  }

  /* --- direct URL --------------------------------------------------------- */
  /* Also the fix for big DIRECT files: the old whole-file decode refused
     anything over 80 MB, so long direct-URL films silently lost auto-sync too.
     A ranged MP4 window has no such ceiling. */
  function forUrl(url, knownSize) {
    if (!url || !/^https?:/i.test(url)) return null;
    var read = httpReader(url);
    var sizeP = (knownSize > 0) ? Promise.resolve(knownSize) : httpSize(url);
    var inner = null;
    return {
      name: 'url:' + String(url).split('/').pop().slice(0, 40),
      cost: 'cheap',
      audioWindow: function (startSec, durSec) {
        return sizeP.then(function (size) {
          if (!inner) inner = mp4Provider('url', read, size || 0, 'cheap');
          return inner ? inner.audioWindow(startSec, durSec) : null;
        })['catch'](function () { return null; });
      }
    };
  }

  /* --- HLS ---------------------------------------------------------------- */
  /* READ-ONLY against the user's hls.js instance: we read its fragment list to
     turn a time window into segment URLs, then fetch those segments OURSELVES.
     We never call loadSource/attachMedia/startLoad/stopLoad, never change the
     level, never seek — the user's playback is untouched and unmuted. */
  function forHls(hls, manifestUrl) {
    var MAP = dep('HlsSegmentMap'), TS = dep('TSAudioWindow');
    if (!MAP || !TS) return null;

    var mapP = null;
    function map() {
      if (!mapP) {
        var live = (hls && typeof MAP.fromInstance === 'function') ? MAP.fromInstance(hls) : null;
        if (live) mapP = Promise.resolve(live);
        else if (manifestUrl && typeof MAP.fromManifest === 'function') mapP = Promise.resolve(MAP.fromManifest(manifestUrl))['catch'](function () { return null; });
        else mapP = Promise.resolve(null);
      }
      return mapP;
    }

    var initCache = {};
    function initBytes(url) {
      if (!url) return Promise.resolve(null);
      if (!initCache[url]) initCache[url] = fetch(url).then(function (r) { return r.arrayBuffer(); })['catch'](function () { return null; });
      return initCache[url];
    }

    function fetchSeg(seg) {
      var opts = {};
      if (seg.byteRange && seg.byteRange.length === 2) {
        opts.headers = { Range: 'bytes=' + seg.byteRange[0] + '-' + (seg.byteRange[0] + seg.byteRange[1] - 1) };
      }
      return fetch(seg.url, opts).then(function (r) {
        if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      });
    }

    return {
      name: 'hls',
      cost: 'costly',
      audioWindow: function (startSec, durSec) {
        return map().then(function (m) {
          if (!m || typeof m.segmentsFor !== 'function') return null;
          var segs = m.segmentsFor(startSec, durSec) || [];
          if (!segs.length) return null;
          var firstStart = segs[0].start;
          return Promise.all(segs.map(function (s) {
            return fetchSeg(s)['catch'](function () { return null; });
          })).then(function (bufs) {
            var got = [], i;
            for (i = 0; i < bufs.length; i++) if (bufs[i]) got.push(u8(bufs[i]));
            if (!got.length) return null;

            var kind = TS.sniff(got[0]);
            if (kind === 'ts') {
              var r = TS.audioFromTS(concat(got));
              if (!r || r.error || !r.buffer) return null;
              /* Playlist start times can drift from the real PTS. When the demuxer
                 recovered a segment-relative start, trust the playlist for the
                 absolute anchor and keep the media timeline honest. */
              return { buffer: r.buffer, mime: r.mime || 'audio/aac', startSec: firstStart };
            }
            if (kind === 'mp4') {
              return initBytes(segs[0].initUrl).then(function (init) {
                var r2 = TS.audioFromFMP4(init, abOf(concat(got)));
                if (!r2 || r2.error || !r2.buffer) return null;
                return { buffer: r2.buffer, mime: r2.mime || 'audio/mp4', startSec: firstStart };
              });
            }
            if (kind === 'aac') return { buffer: abOf(concat(got)), mime: 'audio/aac', startSec: firstStart };
            return null;
          });
        })['catch'](function () { return null; });
      }
    };
  }

  /* ==========================================================================
   * PICK — one call the player makes; returns the best provider or null.
   * Order matters: the most DIRECT byte path first.
   * ========================================================================*/
  function pick(o) {
    o = o || {};
    var p = null;
    if (o.torrentFile) p = forTorrentFile(o.torrentFile);
    if (!p && o.hls) p = forHls(o.hls, o.hlsUrl || o.url);
    if (!p && o.url && /^https?:/i.test(o.url)) p = forUrl(o.url, o.size);
    return p;
  }

  var SubsAudioSource = {
    pick: pick,
    forTorrentFile: forTorrentFile,
    forHls: forHls,
    forUrl: forUrl,
    // exposed for tests + the debug panel
    httpReader: httpReader,
    torrentReader: torrentReader,
    version: '1.0.0'
  };

  if (HAS_WIN) window.SubsAudioSource = SubsAudioSource;
  if (typeof module !== 'undefined' && module.exports) module.exports = SubsAudioSource;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
