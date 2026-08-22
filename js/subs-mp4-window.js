/* mp4-audio-window.js — dependency-free MP4 "audio window extractor".
 *
 * Given random-access byte reads over an MP4 (local File, HTTP Range, torrent
 * piece store — anything), pull ONLY the AAC samples covering an arbitrary
 * ~30s time window and emit a raw ADTS elementary stream that Chrome's
 * AudioContext.decodeAudioData() decodes directly. Never whole-decodes the
 * film; a 30s window off a 2h movie costs a few hundred KB.
 *
 * API
 *   MP4AudioWindow.open(read, fileSize) -> Promise<extractor>
 *     read(start, end) -> Promise<ArrayBuffer|Uint8Array>   // end EXCLUSIVE
 *   extractor.info   -> { codec, sampleRate, channels, durationSec, timescale,
 *                         sampleCount, objectType, freqIndex }
 *   extractor.window(startSec, durSec, [opts{gap,concurrency}]) -> Promise<{
 *       buffer: ArrayBuffer, mime: 'audio/aac',
 *       startSec: <actual media time of first returned sample>,
 *       durSec:   <actual covered duration>,
 *       sampleCount, ranges: [[s,e],..], bytesRead }>
 *   extractor.plan(startSec, durSec, [opts]) -> byte ranges only, zero reads
 *   extractor.bytesRead -> cumulative bytes pulled through read()
 *
 * Unsupported tracks REJECT with an Error carrying typed fields, e.g.
 *   e.error === 'unsupported-codec', e.codec === 'ac-3'
 * rather than emitting garbage.
 *
 * ES5 style on purpose (plain var/function) to match this codebase.
 */
(function (root) {
  'use strict';

  var FREQ = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
              16000, 12000, 11025, 8000, 7350];
  var GAP = 16384;        /* default: coalesce sample ranges closer than this
                             (override per-call with window(s,d,{gap:N}) or
                             extractor.gap = N) */
  var MIN_CHUNK = 4096;   /* minimum bytes per physical read (header walking) */
  var CONC = 8;           /* max parallel reads per window() call */

  function fail(code, extra) {
    var e = new Error(code + (extra && extra.codec ? ' (' + extra.codec + ')' : ''));
    e.error = code;
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) e[k] = extra[k];
    return e;
  }

  function u8of(x) {
    if (x instanceof Uint8Array) return x;
    if (x && x.buffer instanceof ArrayBuffer) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    return new Uint8Array(x);
  }
  function rd32(b, p) { return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0; }
  function rd16(b, p) { return (b[p] << 8) | b[p + 1]; }
  function rd64(b, p) { return rd32(b, p) * 4294967296 + rd32(b, p + 4); }
  function typ(b, p) { return String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]); }

  /* ---------- caching random reader ---------- */

  function Reader(read, size) {
    this.read = read;
    this.size = size;
    this.cache = [];
    this.bytesRead = 0;
  }
  Reader.prototype.fetch = function (start, end) {   /* uncached, exact */
    var self = this;
    end = Math.min(end, this.size);
    if (end <= start) return Promise.resolve(new Uint8Array(0));
    return Promise.resolve(this.read(start, end)).then(function (raw) {
      var b = u8of(raw);
      self.bytesRead += b.length;
      return b;
    });
  };
  Reader.prototype.get = function (start, end) {     /* cached, min MIN_CHUNK */
    var self = this, i, c;
    end = Math.min(end, this.size);
    for (i = 0; i < this.cache.length; i++) {
      c = this.cache[i];
      if (start >= c.s && end <= c.e) return Promise.resolve(c.b.subarray(start - c.s, end - c.s));
    }
    var fs = start, fe = Math.min(Math.max(end, start + MIN_CHUNK), this.size);
    return this.fetch(fs, fe).then(function (b) {
      self.cache.unshift({ s: fs, e: fs + b.length, b: b });
      if (self.cache.length > 6) self.cache.pop();
      return b.subarray(start - fs, Math.min(end, fs + b.length) - fs);
    });
  };

  /* ---------- lazy box listing (headers only) ---------- */

  function listBoxes(reader, start, end) {
    var out = [];
    function step(p) {
      if (p + 8 > end) return Promise.resolve(out);
      return reader.get(p, Math.min(p + 16, reader.size)).then(function (h) {
        if (h.length < 8) return out;
        var size = rd32(h, 0), type = typ(h, 4), hdr = 8;
        if (size === 1) {
          if (h.length < 16) return out;
          size = rd64(h, 8); hdr = 16;
        } else if (size === 0) { size = end - p; }
        if (size < hdr) return out;                    /* corrupt: stop */
        out.push({ type: type, start: p, body: p + hdr, end: Math.min(p + size, end) });
        return step(p + size);
      });
    }
    return step(start);
  }
  function pick(list, type) {
    for (var i = 0; i < list.length; i++) if (list[i].type === type) return list[i];
    return null;
  }

  /* ---------- in-memory box helpers (used once the audio trak is loaded) ---------- */

  function boxesIn(b, start, end) {
    var out = [], p = start;
    while (p + 8 <= end) {
      var size = rd32(b, p), hdr = 8, t = typ(b, p + 4);
      if (size === 1) { size = rd64(b, p + 8); hdr = 16; }
      else if (size === 0) { size = end - p; }
      if (size < hdr) break;
      out.push({ type: t, start: p, body: p + hdr, end: Math.min(p + size, end) });
      p += size;
    }
    return out;
  }
  function descend(b, box, names) {   /* descend(b, trak, ['mdia','minf','stbl']) */
    var cur = box, i;
    for (i = 0; i < names.length; i++) {
      cur = pick(boxesIn(b, cur.body, cur.end), names[i]);
      if (!cur) return null;
    }
    return cur;
  }

  /* ---------- esds / AudioSpecificConfig ---------- */

  function descLen(b, p, st) {          /* variable 7-bit length */
    var len = 0, n = 0, byte;
    do { byte = b[p + n]; len = (len << 7) | (byte & 0x7f); n++; } while ((byte & 0x80) && n < 4);
    st.p = p + n;
    return len;
  }
  function parseEsds(b, box) {
    var p = box.body + 4, st = {};                     /* skip version/flags */
    if (b[p] !== 0x03) throw fail('esds-unexpected-tag', { tag: b[p] });
    descLen(b, p + 1, st); p = st.p;
    p += 2;                                            /* ES_ID */
    var flags = b[p]; p += 1;
    if (flags & 0x80) p += 2;                          /* dependsOn */
    if (flags & 0x40) p += 1 + b[p];                   /* URL */
    if (flags & 0x20) p += 2;                          /* OCR */
    if (b[p] !== 0x04) throw fail('esds-no-dcd', { tag: b[p] });
    descLen(b, p + 1, st); p = st.p;
    var oti = b[p];
    p += 1 + 1 + 3 + 4 + 4;                            /* streamType,bufSize,maxBR,avgBR */
    var asc = null;
    if (b[p] === 0x05) {
      var alen = descLen(b, p + 1, st);
      asc = b.subarray(st.p, st.p + alen);
    }
    return { oti: oti, asc: asc };
  }
  function parseASC(asc) {
    /* bit reader over the AudioSpecificConfig */
    var bitPos = 0;
    function bits(n) {
      var v = 0, i;
      for (i = 0; i < n; i++) {
        var byte = asc[bitPos >> 3] || 0;
        v = (v << 1) | ((byte >> (7 - (bitPos & 7))) & 1);
        bitPos++;
      }
      return v;
    }
    var ot = bits(5);
    if (ot === 31) ot = 32 + bits(6);
    var fi = bits(4), rate = 0;
    if (fi === 15) { rate = bits(24); } else { rate = FREQ[fi] || 0; }
    var ch = bits(4);
    return { objectType: ot, freqIndex: fi, sampleRate: rate, channels: ch };
  }

  /* ---------- sample tables ---------- */

  function parseTables(b, stbl) {
    var t = {}, i, p, n;

    var stts = pick(boxesIn(b, stbl.body, stbl.end), 'stts');
    if (!stts) throw fail('no-stts');
    n = rd32(b, stts.body + 4); p = stts.body + 8;
    t.stts = [];
    for (i = 0; i < n; i++, p += 8) t.stts.push([rd32(b, p), rd32(b, p + 4)]);

    var kids = boxesIn(b, stbl.body, stbl.end);
    var stsz = pick(kids, 'stsz'), stz2 = pick(kids, 'stz2');
    if (stsz) {
      var uniform = rd32(b, stsz.body + 4);
      t.sampleCount = rd32(b, stsz.body + 8);
      t.sizes = new Uint32Array(t.sampleCount);
      if (uniform) { for (i = 0; i < t.sampleCount; i++) t.sizes[i] = uniform; }
      else { p = stsz.body + 12; for (i = 0; i < t.sampleCount; i++, p += 4) t.sizes[i] = rd32(b, p); }
    } else if (stz2) {
      var fsz = b[stz2.body + 7];
      t.sampleCount = rd32(b, stz2.body + 8);
      t.sizes = new Uint32Array(t.sampleCount);
      p = stz2.body + 12;
      for (i = 0; i < t.sampleCount; i++) {
        if (fsz === 16) { t.sizes[i] = rd16(b, p); p += 2; }
        else if (fsz === 8) { t.sizes[i] = b[p]; p += 1; }
        else { t.sizes[i] = (i & 1) ? (b[p++] & 0x0f) : ((b[p] >> 4) & 0x0f); }
      }
    } else { throw fail('no-stsz'); }

    var stsc = pick(kids, 'stsc');
    if (!stsc) throw fail('no-stsc');
    n = rd32(b, stsc.body + 4); p = stsc.body + 8;
    var sc = [];
    for (i = 0; i < n; i++, p += 12) sc.push([rd32(b, p), rd32(b, p + 4)]);

    var stco = pick(kids, 'stco'), co64 = pick(kids, 'co64');
    var co = stco || co64;
    if (!co) throw fail('no-stco');
    n = rd32(b, co.body + 4); p = co.body + 8;
    t.chunkOffset = new Float64Array(n);
    for (i = 0; i < n; i++) {
      if (co64 && !stco) { t.chunkOffset[i] = rd64(b, p); p += 8; }
      else { t.chunkOffset[i] = rd32(b, p); p += 4; }
    }

    /* expand stsc -> first sample index per chunk */
    t.chunkFirst = new Float64Array(n);
    t.chunkCount = new Uint32Array(n);
    var si = 0, e = 0;
    for (i = 0; i < n; i++) {
      while (e + 1 < sc.length && sc[e + 1][0] <= i + 1) e++;
      var spc = sc.length ? sc[e][1] : 0;
      t.chunkFirst[i] = si;
      t.chunkCount[i] = spc;
      si += spc;
    }
    return t;
  }

  function chunkOfSample(t, idx) {      /* binary search on chunkFirst */
    var lo = 0, hi = t.chunkFirst.length - 1, mid;
    while (lo < hi) {
      mid = (lo + hi + 1) >> 1;
      if (t.chunkFirst[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  function offsetOfSample(t, idx) {
    var c = chunkOfSample(t, idx), off = t.chunkOffset[c], i;
    for (i = t.chunkFirst[c]; i < idx; i++) off += t.sizes[i];
    return off;
  }
  /* absolute file offsets for a run of samples — chunk-boundary aware */
  function offsetsForRun(t, from, count) {
    var out = new Float64Array(count), c = chunkOfSample(t, from), i, j;
    var off = t.chunkOffset[c];
    for (i = t.chunkFirst[c]; i < from; i++) off += t.sizes[i];
    for (j = 0; j < count; j++) {
      var idx = from + j;
      while (c + 1 < t.chunkOffset.length && idx >= t.chunkFirst[c] + t.chunkCount[c]) {
        c++; off = t.chunkOffset[c];
      }
      out[j] = off;
      off += t.sizes[idx];
    }
    return out;
  }
  function timeToSample(t, ticks) {     /* -> {index, time} */
    var acc = 0, idx = 0, i, c, d, span;
    for (i = 0; i < t.stts.length; i++) {
      c = t.stts[i][0]; d = t.stts[i][1]; span = c * d;
      if (ticks < acc + span || i === t.stts.length - 1) {
        var k = d > 0 ? Math.floor((ticks - acc) / d) : 0;
        if (k < 0) k = 0;
        if (k > c - 1) k = c - 1;
        return { index: idx + k, time: acc + k * d };
      }
      acc += span; idx += c;
    }
    return { index: 0, time: 0 };
  }
  function durationOfRun(t, from, ticks) {   /* samples covering >= ticks */
    var idx = 0, i, c, d, n = 0, got = 0;
    for (i = 0; i < t.stts.length && got < ticks; i++) {
      c = t.stts[i][0]; d = t.stts[i][1];
      if (from >= idx + c) { idx += c; continue; }
      var startIn = Math.max(0, from - idx);
      var avail = c - startIn;
      var need = d > 0 ? Math.ceil((ticks - got) / d) : avail;
      var take = Math.min(avail, need);
      n += take; got += take * d; idx += c;
    }
    if (from + n > t.sampleCount) n = t.sampleCount - from;
    return { count: n, ticks: got };
  }

  /* ---------- ADTS ---------- */

  function adtsHeader(out, o, profile, fi, ch, frameLen) {
    out[o] = 0xff;
    out[o + 1] = 0xf1;                                   /* MPEG-4, no CRC */
    out[o + 2] = ((profile & 3) << 6) | ((fi & 15) << 2) | ((ch >> 2) & 1);
    out[o + 3] = ((ch & 3) << 6) | ((frameLen >> 11) & 3);
    out[o + 4] = (frameLen >> 3) & 0xff;
    out[o + 5] = ((frameLen & 7) << 5) | 0x1f;           /* buffer fullness 0x7ff */
    out[o + 6] = 0xfc;
  }

  /* bounded-concurrency map — a small gap can mean hundreds of ranges and
     servers reset connections when you fire them all at once. */
  function pool(items, limit, fn) {
    var out = new Array(items.length), next = 0, active = 0, done = 0;
    return new Promise(function (resolve, reject) {
      if (!items.length) return resolve(out);
      function pump() {
        while (active < limit && next < items.length) {
          (function (i) {
            active++; next++;
            Promise.resolve(fn(items[i])).then(function (v) {
              out[i] = v; active--; done++;
              if (done === items.length) resolve(out); else pump();
            }, reject);
          })(next);
        }
      }
      pump();
    });
  }

  /* ---------- extractor ---------- */

  function Extractor(reader, t, cfg) {
    this.reader = reader;
    this.t = t;
    this.cfg = cfg;
    this.info = {
      codec: cfg.codec,
      sampleRate: cfg.sampleRate,
      channels: cfg.channels,
      durationSec: cfg.durationSec,
      timescale: cfg.timescale,
      sampleCount: t.sampleCount,
      objectType: cfg.objectType,
      freqIndex: cfg.freqIndex
    };
  }
  Object.defineProperty(Extractor.prototype, 'bytesRead', {
    get: function () { return this.reader.bytesRead; }
  });

  /* plan(): which byte ranges a window needs — no reads, no allocation.
     Useful for budgeting / choosing gap before paying for bytes. */
  Extractor.prototype.plan = function (startSec, durSec, opts) {
    var t = this.t, ts = this.cfg.timescale;
    var gap = (opts && opts.gap != null) ? opts.gap : (this.gap != null ? this.gap : GAP);
    var hit = timeToSample(t, Math.max(0, startSec) * ts);
    var run = durationOfRun(t, hit.index, durSec * ts);
    if (run.count <= 0) throw fail('empty-window', { startSec: startSec });
    var offs = offsetsForRun(t, hit.index, run.count);
    var i, off, end, ranges = [], cur = null, payload = 0, span = 0;
    for (i = 0; i < run.count; i++) {
      off = offs[i];
      payload += t.sizes[hit.index + i];
      end = off + t.sizes[hit.index + i];
      if (cur && off >= cur[1] && off - cur[1] <= gap) { cur[1] = Math.max(cur[1], end); }
      else { cur = [off, end]; ranges.push(cur); }
    }
    for (i = 0; i < ranges.length; i++) span += ranges[i][1] - ranges[i][0];
    return {
      index: hit.index, count: run.count, offsets: offs, ranges: ranges,
      payload: payload, span: span,
      startSec: hit.time / ts, durSec: run.ticks / ts
    };
  };

  Extractor.prototype.window = function (startSec, durSec, opts) {
    var self = this, t = this.t, cfg = this.cfg, p;
    try { p = this.plan(startSec, durSec, opts); } catch (e) { return Promise.reject(e); }
    var before = this.reader.bytesRead;
    var conc = (opts && opts.concurrency) || this.concurrency || CONC;
    return pool(p.ranges, conc, function (r) {
      return self.reader.fetch(r[0], r[1]).then(function (b) { return { s: r[0], b: b }; });
    }).then(function (blobs) {
      var out = new Uint8Array(p.payload + 7 * p.count), o = 0, k = 0, j, sz, off2;
      for (j = 0; j < p.count; j++) {
        sz = t.sizes[p.index + j]; off2 = p.offsets[j];
        while (k < blobs.length && !(off2 >= blobs[k].s && off2 + sz <= blobs[k].s + blobs[k].b.length)) k++;
        if (k >= blobs.length) throw fail('range-miss', { sample: p.index + j, offset: off2 });
        adtsHeader(out, o, cfg.profile, cfg.freqIndex, cfg.channels, sz + 7);
        o += 7;
        out.set(blobs[k].b.subarray(off2 - blobs[k].s, off2 - blobs[k].s + sz), o);
        o += sz;
      }
      return {
        buffer: out.buffer, mime: 'audio/aac',
        startSec: p.startSec, durSec: p.durSec,
        sampleCount: p.count, ranges: p.ranges,
        bytesRead: self.reader.bytesRead - before
      };
    });
  };

  /* ---------- open ---------- */

  function open(read, fileSize) {
    var reader = new Reader(read, fileSize);
    return listBoxes(reader, 0, fileSize).then(function (top) {
      var moov = pick(top, 'moov');
      if (!moov) throw fail('no-moov');
      return listBoxes(reader, moov.body, moov.end).then(function (kids) {
        var traks = [], i;
        for (i = 0; i < kids.length; i++) if (kids[i].type === 'trak') traks.push(kids[i]);
        if (!traks.length) throw fail('no-trak');
        /* locate the 'soun' trak using header reads only */
        function scan(n) {
          if (n >= traks.length) throw fail('no-audio-track');
          var trak = traks[n];
          return listBoxes(reader, trak.body, trak.end).then(function (tk) {
            var mdia = pick(tk, 'mdia');
            if (!mdia) return scan(n + 1);
            return listBoxes(reader, mdia.body, mdia.end).then(function (md) {
              var hdlr = pick(md, 'hdlr');
              if (!hdlr) return scan(n + 1);
              return reader.get(hdlr.body, hdlr.body + 12).then(function (h) {
                if (h.length >= 12 && typ(h, 8) === 'soun') return trak;
                return scan(n + 1);
              });
            });
          });
        }
        return scan(0);
      }).then(function (trak) {
        reader.cache = [];                       /* drop header chunks */
        return reader.fetch(trak.start, trak.end).then(function (raw) {
          var b = raw;
          /* re-root: the buffer starts at the trak box header */
          var trakBox = boxesIn(b, 0, b.length)[0];
          if (!trakBox || trakBox.type !== 'trak') throw fail('bad-trak');

          var mdhd = descend(b, trakBox, ['mdia', 'mdhd']);
          if (!mdhd) throw fail('no-mdhd');
          var ver = b[mdhd.body], timescale, dur;
          if (ver === 1) { timescale = rd32(b, mdhd.body + 20); dur = rd64(b, mdhd.body + 24); }
          else { timescale = rd32(b, mdhd.body + 12); dur = rd32(b, mdhd.body + 16); }

          var stbl = descend(b, trakBox, ['mdia', 'minf', 'stbl']);
          if (!stbl) throw fail('no-stbl');
          var stsd = pick(boxesIn(b, stbl.body, stbl.end), 'stsd');
          if (!stsd) throw fail('no-stsd');

          var ent = stsd.body + 8;                        /* first sample entry */
          var fmt = typ(b, ent + 4);
          if (fmt !== 'mp4a') throw fail('unsupported-codec', { codec: fmt.replace(/\s+$/, '') });
          var sever = rd16(b, ent + 16);
          var stsdChannels = rd16(b, ent + 24);
          var kidsAt = ent + (sever === 2 ? 72 : sever === 1 ? 52 : 36);
          var entEnd = ent + rd32(b, ent);
          var esds = pick(boxesIn(b, kidsAt, entEnd), 'esds');
          if (!esds) throw fail('no-esds');

          var d = parseEsds(b, esds);
          if (d.oti !== 0x40) throw fail('unsupported-codec', { codec: 'oti-0x' + d.oti.toString(16) });
          if (!d.asc || !d.asc.length) throw fail('no-audio-specific-config');
          var a = parseASC(d.asc);
          if (a.freqIndex === 15) throw fail('unsupported-explicit-samplerate', { sampleRate: a.sampleRate });
          if (a.objectType < 1 || a.objectType > 5 && a.objectType !== 29) {
            throw fail('unsupported-codec', { codec: 'mp4a.40.' + a.objectType });
          }
          var profile = (a.objectType >= 1 && a.objectType <= 4) ? a.objectType - 1 : 1; /* SBR -> LC */
          var channels = a.channels || stsdChannels || 2;

          var t = parseTables(b, stbl);
          reader.cache = [];
          return new Extractor(reader, t, {
            codec: 'mp4a.40.' + a.objectType,
            sampleRate: a.sampleRate,
            channels: channels,
            durationSec: timescale ? dur / timescale : 0,
            timescale: timescale,
            objectType: a.objectType,
            freqIndex: a.freqIndex,
            profile: profile
          });
        });
      });
    });
  }

  var API = { open: open };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.MP4AudioWindow = API;
})(typeof window !== 'undefined' ? window : null);
