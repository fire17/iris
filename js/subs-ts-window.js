/* ts-audio-window.js — dependency-free audio extractor for HLS media segments.
 *
 * Given the raw bytes of one HLS segment, hand back an ArrayBuffer that
 * Chrome's AudioContext.decodeAudioData() will actually decode, so a caller
 * can run whisper over a time window of a live HLS stream.
 *
 * ES5 style on purpose (var / function only) to match this codebase.
 * Browser: window.TSAudioWindow.  Node: module.exports.
 */
(function (root) {
  'use strict';

  var TS_PACKET = 188;

  /* ---------- tiny helpers ---------- */

  function u8(x) {
    if (!x) return new Uint8Array(0);
    if (x instanceof Uint8Array) return x;
    if (typeof ArrayBuffer !== 'undefined' && x instanceof ArrayBuffer) return new Uint8Array(x);
    if (x.buffer) return new Uint8Array(x.buffer, x.byteOffset || 0, x.byteLength);
    return new Uint8Array(x);
  }

  function concat(chunks, total) {
    var out = new Uint8Array(total), o = 0, i;
    for (i = 0; i < chunks.length; i++) { out.set(chunks[i], o); o += chunks[i].length; }
    return out;
  }

  function abOf(arr) {
    /* always hand back a standalone ArrayBuffer — decodeAudioData detaches it */
    if (arr.byteOffset === 0 && arr.byteLength === arr.buffer.byteLength) return arr.buffer;
    return arr.slice().buffer;
  }

  function fourcc(b, o) {
    return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  }

  function u32(b, o) {
    return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  }

  var ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
                    16000, 12000, 11025, 8000, 7350, 0, 0, 0];
  var ADTS_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 8];

  /* ---------- sniff ---------- */

  function sniff(bytes) {
    var b = u8(bytes);
    if (b.length < 4) return 'unknown';

    if (b[0] === 0x47) {
      var hits = 1, i;
      for (i = TS_PACKET; i + 1 <= b.length && i < TS_PACKET * 6; i += TS_PACKET) {
        if (b[i] !== 0x47) { hits = 0; break; }
        hits++;
      }
      if (hits >= 2 || b.length <= TS_PACKET * 2) return 'ts';
    }

    /* walk the box chain; a real fMP4/MP4 starts with a sane box header */
    var off = 0, guard = 0;
    while (off + 8 <= b.length && guard++ < 8) {
      var size = u32(b, off), type = fourcc(b, off + 4);
      if (type === 'ftyp' || type === 'styp' || type === 'moof' || type === 'sidx' ||
          type === 'moov' || type === 'emsg' || type === 'free' || type === 'skip' ||
          type === 'mdat' || type === 'wide') {
        if (type !== 'free' && type !== 'skip' && type !== 'wide') return 'mp4';
      } else break;
      if (size === 1) { off += 16; continue; }
      if (size < 8) break;
      off += size;
    }

    if (b[0] === 0xFF && (b[1] & 0xF0) === 0xF0) return 'aac';
    if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'aac'; /* ID3 then ADTS */
    return 'unknown';
  }

  /* ---------- ADTS scan (frame count + real sampleRate/channels) ---------- */

  function scanADTS(b) {
    var i = 0, frames = 0, rate = 0, ch = 0;
    if (b.length > 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
      i = 10 + ((b[6] & 0x7F) << 21 | (b[7] & 0x7F) << 14 | (b[8] & 0x7F) << 7 | (b[9] & 0x7F));
    }
    while (i + 7 <= b.length) {
      if (b[i] !== 0xFF || (b[i + 1] & 0xF0) !== 0xF0) { i++; continue; }
      var len = ((b[i + 3] & 0x03) << 11) | (b[i + 4] << 3) | (b[i + 5] >> 5);
      if (len < 7) { i++; continue; }
      if (!frames) {
        rate = ADTS_RATES[(b[i + 2] & 0x3C) >> 2];
        ch = ADTS_CHANNELS[((b[i + 2] & 0x01) << 2) | ((b[i + 3] & 0xC0) >> 6)];
      }
      frames++;
      i += len;
    }
    return { frames: frames, sampleRate: rate, channels: ch };
  }

  /* ---------- MPEG-TS ---------- */

  var TS_STREAM_TYPES = {
    0x0F: 'aac',        /* ADTS AAC */
    0x11: 'aac-latm',
    0x03: 'mp3',
    0x04: 'mp3',
    0x81: 'ac3',
    0x87: 'ec3',
    0x06: 'private'     /* usually AC-3/DTS in DVB; treated as unsupported */
  };

  function tsSyncOffset(b) {
    var i;
    for (i = 0; i < TS_PACKET && i + TS_PACKET * 2 < b.length; i++) {
      if (b[i] === 0x47 && b[i + TS_PACKET] === 0x47 && b[i + TS_PACKET * 2] === 0x47) return i;
    }
    return b.length >= TS_PACKET && b[0] === 0x47 ? 0 : -1;
  }

  function readPTS(b, o) {
    /* 33-bit PTS starting at o; avoid 32-bit shift overflow */
    var hi = (b[o] & 0x0E) >> 1;
    var lo = (((b[o + 1] << 22) | ((b[o + 2] & 0xFE) << 14) | (b[o + 3] << 7) | (b[o + 4] >> 1)) >>> 0);
    return hi * 1073741824 + lo;
  }

  function audioFromTS(bytes) {
    var b = u8(bytes);
    var base = tsSyncOffset(b);
    if (base < 0) return { error: 'not-mpeg-ts' };

    var pmtPid = -1, audioPid = -1, kind = null, streamType = -1;
    var chunks = [], total = 0, firstPTS = null, lastPTS = null;
    var pes = null, pesLen = 0, packets = 0;

    function flushPES() {
      if (!pes || !pes.length) { pes = null; pesLen = 0; return; }
      var p = pesLen === 1 ? pes[0] : concat(pes, pesLen);
      pes = null; pesLen = 0;
      if (p.length < 9 || p[0] !== 0 || p[1] !== 0 || p[2] !== 1) return;
      var hdrLen = p[8];
      if ((p[7] & 0x80) && p.length >= 14) {
        var pts = readPTS(p, 9);
        if (firstPTS === null) firstPTS = pts;
        lastPTS = pts;
      }
      var body = p.subarray(9 + hdrLen);
      if (body.length) { chunks.push(body); total += body.length; }
    }

    for (var off = base; off + TS_PACKET <= b.length; off += TS_PACKET) {
      var pk = b.subarray(off, off + TS_PACKET);
      if (pk[0] !== 0x47) { base = tsSyncOffset(b.subarray(off)); if (base < 0) break; off += base - TS_PACKET; continue; }
      packets++;
      var pusi = (pk[1] & 0x40) !== 0;
      var pid = ((pk[1] & 0x1F) << 8) | pk[2];
      var afc = (pk[3] & 0x30) >> 4;
      if (afc === 0 || afc === 2) continue;              /* no payload */
      var pos = 4;
      if (afc === 3) pos += 1 + pk[4];
      if (pos >= TS_PACKET) continue;
      var payload = pk.subarray(pos);

      if (pid === 0 && pmtPid < 0) {
        var pp = pusi ? payload.subarray(1 + payload[0]) : payload;
        if (pp.length > 12 && pp[0] === 0x00) {
          var secLen = ((pp[1] & 0x0F) << 8) | pp[2];
          var end = Math.min(3 + secLen - 4, pp.length);
          for (var q = 8; q + 4 <= end; q += 4) {
            var prog = (pp[q] << 8) | pp[q + 1];
            var mp = ((pp[q + 2] & 0x1F) << 8) | pp[q + 3];
            if (prog !== 0) { pmtPid = mp; break; }
          }
        }
        continue;
      }

      if (pid === pmtPid && audioPid < 0) {
        var mpp = pusi ? payload.subarray(1 + payload[0]) : payload;
        if (mpp.length > 12 && mpp[0] === 0x02) {
          var mLen = ((mpp[1] & 0x0F) << 8) | mpp[2];
          var mEnd = Math.min(3 + mLen - 4, mpp.length);
          var infoLen = ((mpp[10] & 0x0F) << 8) | mpp[11];
          for (var e = 12 + infoLen; e + 5 <= mEnd; ) {
            var st = mpp[e];
            var epid = ((mpp[e + 1] & 0x1F) << 8) | mpp[e + 2];
            var esLen = ((mpp[e + 3] & 0x0F) << 8) | mpp[e + 4];
            var k = TS_STREAM_TYPES[st];
            if (k && audioPid < 0) { audioPid = epid; kind = k; streamType = st; }
            e += 5 + esLen;
          }
        }
        continue;
      }

      if (pid === audioPid) {
        if (pusi) flushPES();
        if (!pes) pes = [];
        pes.push(payload); pesLen += payload.length;
      }
    }
    flushPES();

    if (pmtPid < 0) return { error: 'no-pmt', packets: packets };
    if (audioPid < 0) return { error: 'no-audio-stream', pmtPid: pmtPid, packets: packets };
    if (kind === 'ac3' || kind === 'ec3' || kind === 'private') {
      return { error: 'unsupported-codec:' + kind, pid: audioPid, streamType: streamType };
    }
    if (kind === 'aac-latm') {
      return { error: 'unsupported-codec:aac-latm', pid: audioPid, streamType: streamType };
    }
    if (!total) return { error: 'no-audio-payload', pid: audioPid, streamType: streamType };

    var data = concat(chunks, total);
    var res = {
      container: 'ts', pid: audioPid, streamType: streamType, packets: packets,
      buffer: abOf(data), bytes: data.length,
      ptsFirst: firstPTS, ptsLast: lastPTS,
      startTime: firstPTS === null ? null : firstPTS / 90000
    };
    if (kind === 'mp3') {
      /* ponytail: MP3 payload is already a raw elementary stream — no reframing needed. */
      res.mime = 'audio/mpeg'; res.codec = 'mp3'; res.frames = 0;
      res.sampleRate = 0; res.channels = 0;
      return res;
    }
    var s = scanADTS(data);
    if (!s.frames) return { error: 'no-adts-frames', pid: audioPid, streamType: streamType };
    res.mime = 'audio/aac'; res.codec = 'aac';
    res.frames = s.frames; res.sampleRate = s.sampleRate; res.channels = s.channels;
    res.duration = s.sampleRate ? (s.frames * 1024) / s.sampleRate : null;
    return res;
  }

  /* ---------- ISO BMFF box walking ---------- */

  function boxes(b, start, end, cb) {
    var o = start;
    while (o + 8 <= end) {
      var size = u32(b, o), type = fourcc(b, o + 4), hdr = 8;
      if (size === 1) {
        if (o + 16 > end) break;
        size = u32(b, o + 8) * 4294967296 + u32(b, o + 12); hdr = 16;
      } else if (size === 0) size = end - o;
      if (size < hdr || o + size > end) break;
      if (cb(type, o + hdr, o + size) === false) return;
      o += size;
    }
  }

  function findBox(b, path, start, end) {
    var want = path[0], hit = null;
    boxes(b, start === undefined ? 0 : start, end === undefined ? b.length : end, function (t, s, e) {
      if (t !== want || hit) return;
      hit = path.length === 1 ? { start: s, end: e } : findBox(b, path.slice(1), s, e);
      if (hit) return false;
    });
    return hit;
  }

  /* stsd sample-entry codec + esds AudioSpecificConfig */
  function readAudioConfig(init) {
    var b = u8(init);
    var stsd = findBox(b, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']);
    if (!stsd) return { error: 'no-stsd' };
    var entryOff = stsd.start + 8;               /* version/flags + entry_count */
    if (entryOff + 8 > stsd.end) return { error: 'empty-stsd' };
    var codec = fourcc(b, entryOff + 4);
    if (codec === 'ac-3') return { error: 'unsupported-codec:ac3' };
    if (codec === 'ec-3') return { error: 'unsupported-codec:ec3' };
    if (codec === 'Opus') return { error: 'unsupported-codec:opus' };
    if (codec !== 'mp4a') return { error: 'unsupported-codec:' + codec };

    var entryEnd = entryOff + u32(b, entryOff);
    var channels = (b[entryOff + 8 + 16] << 8) | b[entryOff + 8 + 17];
    var rate = ((b[entryOff + 8 + 22] << 8) | b[entryOff + 8 + 23]);  /* 16.16 integer part */

    var esds = findBox(b, ['esds'], entryOff + 8 + 28, entryEnd);
    if (!esds) return { error: 'no-esds', codec: codec, channels: channels, sampleRate: rate };

    /* ES_Descriptor(0x03) -> DecoderConfigDescriptor(0x04) -> DecoderSpecificInfo(0x05) */
    var o = esds.start + 4, asc = null;
    function len() { var v = 0, n = 0, c; do { c = b[o++]; v = (v << 7) | (c & 0x7F); } while ((c & 0x80) && ++n < 4); return v; }
    if (b[o] === 0x03) { o++; len(); o += 3; }
    if (b[o] === 0x04) { o++; len(); o += 13; }
    if (b[o] === 0x05) { o++; var l = len(); asc = b.subarray(o, o + l); }
    if (!asc || asc.length < 2) return { error: 'no-asc', codec: codec };

    var objType = asc[0] >> 3;
    var freqIdx = ((asc[0] & 0x07) << 1) | (asc[1] >> 7);
    var chCfg = (asc[1] >> 3) & 0x0F;
    if (objType === 31) return { error: 'unsupported-codec:aac-ext' };
    return {
      codec: 'mp4a.40.' + objType, objType: objType, freqIdx: freqIdx,
      channelConfig: chCfg || (channels || 2),
      sampleRate: ADTS_RATES[freqIdx] || rate, channels: chCfg || channels || 2
    };
  }

  function adtsHeader(cfg, frameLen) {
    var full = frameLen + 7;
    var profile = (cfg.objType > 0 ? cfg.objType : 2) - 1;
    return [
      0xFF, 0xF1,
      ((profile & 0x03) << 6) | ((cfg.freqIdx & 0x0F) << 2) | ((cfg.channelConfig >> 2) & 0x01),
      ((cfg.channelConfig & 0x03) << 6) | ((full >> 11) & 0x03),
      (full >> 3) & 0xFF,
      ((full & 0x07) << 5) | 0x1F,
      0xFC
    ];
  }

  /* moof/traf -> per-sample sizes + tfdt base time */
  function trafSamples(b, start, end) {
    var defSize = 0, sizes = [], baseTime = null, dataOffset = null;
    boxes(b, start, end, function (t, s, e) {
      if (t === 'tfhd') {
        var fl = u32(b, s) & 0x00FFFFFF, o = s + 4 + 4; /* flags + track_ID */
        if (fl & 0x01) o += 8;                          /* base-data-offset */
        if (fl & 0x02) o += 4;                          /* sample-description-index */
        if (fl & 0x08) o += 4;                          /* default-sample-duration */
        if (fl & 0x10) { defSize = u32(b, o); o += 4; } /* default-sample-size */
      } else if (t === 'tfdt') {
        var ver = b[s];
        baseTime = ver === 1 ? u32(b, s + 4) * 4294967296 + u32(b, s + 8) : u32(b, s + 4);
      } else if (t === 'trun') {
        var f = u32(b, s) & 0x00FFFFFF, n = u32(b, s + 4), p = s + 8, i;
        if (f & 0x000001) { dataOffset = (u32(b, p) | 0); p += 4; }
        if (f & 0x000004) p += 4;
        for (i = 0; i < n && p <= e; i++) {
          if (f & 0x000100) p += 4;
          if (f & 0x000200) { sizes.push(u32(b, p)); p += 4; } else sizes.push(defSize);
          if (f & 0x000400) p += 4;
          if (f & 0x000800) p += 4;
        }
      }
    });
    return { sizes: sizes, baseTime: baseTime, dataOffset: dataOffset };
  }

  /* Route B: pull AAC samples out of moof/trun+mdat and re-wrap them in ADTS. */
  function fmp4ToADTS(initBytes, mediaBytes) {
    var cfg = readAudioConfig(initBytes);
    if (cfg.error) return cfg;
    var b = u8(mediaBytes);
    var chunks = [], total = 0, frames = 0, baseTime = null;
    var pendingSizes = null;

    boxes(b, 0, b.length, function (t, s, e) {
      if (t === 'moof') {
        var traf = findBox(b, ['traf'], s, e);
        if (traf) {
          var r = trafSamples(b, traf.start, traf.end);
          pendingSizes = r.sizes;
          if (baseTime === null) baseTime = r.baseTime;
        }
      } else if (t === 'mdat' && pendingSizes) {
        /* ponytail: assumes samples are laid out contiguously from the start of
         * mdat — true for every single-traf audio segment seen in the wild.
         * Revisit if a packager ever emits a real base-data-offset gap. */
        var o = s, i;
        for (i = 0; i < pendingSizes.length; i++) {
          var n = pendingSizes[i];
          if (o + n > e) break;
          chunks.push(new Uint8Array(adtsHeader(cfg, n)));
          chunks.push(b.subarray(o, o + n));
          total += 7 + n; frames++; o += n;
        }
        pendingSizes = null;
      }
    });

    if (!frames) return { error: 'no-samples' };
    var data = concat(chunks, total);
    return {
      container: 'fmp4', route: 'adts', mime: 'audio/aac', codec: cfg.codec,
      buffer: abOf(data), bytes: data.length, frames: frames,
      sampleRate: cfg.sampleRate, channels: cfg.channels,
      baseMediaDecodeTime: baseTime,
      duration: cfg.sampleRate ? (frames * 1024) / cfg.sampleRate : null
    };
  }

  /* Route A (default): init segment + media segment concatenated is a valid
   * standalone fMP4 file, which Chrome decodes directly. */
  function audioFromFMP4(initBytes, mediaBytes, opts) {
    var init = u8(initBytes), media = u8(mediaBytes);
    if (!media.length) return { error: 'empty-media-segment' };
    var cfg = readAudioConfig(init);
    if (cfg.error) return cfg;                      /* typed unsupported-codec:* */
    if (opts && opts.route === 'adts') return fmp4ToADTS(init, media);

    var traf = findBox(media, ['moof', 'traf']);
    var meta = traf ? trafSamples(media, traf.start, traf.end) : { sizes: [], baseTime: null };
    var data = concat([init, media], init.length + media.length);
    return {
      container: 'fmp4', route: 'concat', mime: 'audio/mp4', codec: cfg.codec,
      buffer: abOf(data), bytes: data.length, frames: meta.sizes.length,
      sampleRate: cfg.sampleRate, channels: cfg.channels,
      baseMediaDecodeTime: meta.baseTime,
      startTime: meta.baseTime === null || !cfg.sampleRate ? null : meta.baseTime / cfg.sampleRate,
      duration: cfg.sampleRate ? (meta.sizes.length * 1024) / cfg.sampleRate : null
    };
  }

  /* One entry point when you don't know the container yet. */
  function audioFromSegment(bytes, initBytes, opts) {
    var kind = sniff(bytes);
    if (kind === 'ts') return audioFromTS(bytes);
    if (kind === 'mp4') return audioFromFMP4(initBytes || new Uint8Array(0), bytes, opts);
    if (kind === 'aac') {
      var b = u8(bytes), s = scanADTS(b);
      if (!s.frames) return { error: 'no-adts-frames' };
      return { container: 'aac', mime: 'audio/aac', codec: 'aac', buffer: abOf(b),
               bytes: b.length, frames: s.frames, sampleRate: s.sampleRate, channels: s.channels };
    }
    return { error: 'unknown-container' };
  }

  var API = {
    sniff: sniff,
    audioFromTS: audioFromTS,
    audioFromFMP4: audioFromFMP4,
    fmp4ToADTS: fmp4ToADTS,
    audioFromSegment: audioFromSegment,
    readAudioConfig: readAudioConfig
  };

  if (root) root.TSAudioWindow = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : null);
