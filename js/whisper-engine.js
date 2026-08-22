/* =============================================================================
 * whisper-engine.js  —  window.WhisperEngine
 *
 * A CLEAN PLUGGABLE INTERFACE for an in-browser Whisper that returns exact WORD
 * timestamps, plus the audio-anchor CAPTURE layer that feeds it. The heavy model
 * (chosen by the subs-research lane) plugs in via WhisperEngine.register(impl);
 * until then a deterministic MockWhisper drives the coherence algorithm + proofs.
 *
 * The autosync engine (js/subs-autosync.js) only ever asks this module to
 * transcribe a few SPARSE windows of audio (near a sub's first sentence, last
 * sentence, and a mid check) — never the whole film. So an impl only needs:
 *     PCM in  ->  word timestamps out.
 *
 * ---- Impl contract (subs-research registers this) --------------------------
 *   WhisperEngine.register({
 *     name:      'whisper-tiny-onnx',
 *     sampleRate: 16000,                 // required input rate (we resample to it)
 *     ready:     () => Promise<void>,     // lazy-load model/wasm on first use
 *     transcribe:(pcmFloat32, sampleRate, opts) =>
 *                   Promise<{ words:[{text,start,end}], text }>
 *     // start/end are seconds RELATIVE TO THE PCM CLIP. We add the window offset.
 *   });
 *
 * ---- What this module gives the engine ------------------------------------
 *   WhisperEngine.isReady()      -> bool
 *   WhisperEngine.name()         -> string
 *   WhisperEngine.ready()        -> Promise (loads the impl)
 *   WhisperEngine.transcribeWindows(source, windows, opts) -> Promise<[
 *        { start, dur, words:[{text,start,end}], text } ]>   // times ABSOLUTE
 *        source: HTMLMediaElement | {blob} | {arrayBuffer} | {url} | {audioBuffer}
 *        windows: [{start, dur}]  (seconds, absolute into the media timeline)
 *   WhisperEngine.pcmFromAudioBuffer(audioBuffer, start, dur, rate) -> Float32Array
 *   WhisperEngine.decode(source) -> Promise<AudioBuffer>   (cached per source)
 *   WhisperEngine.liveTap(mediaEl) -> tap   (records PCM as the media plays)
 *
 * ---- WINDOW PROVIDERS (the stream path: torrent / HLS / huge direct files) ---
 * A whole-file AudioBuffer is impossible for a full-length film (GBs of PCM) and
 * a live stream has no whole file at all. So a source may instead be a WINDOW
 * PROVIDER — an object that hands back just the ENCODED audio for one small time
 * window, which we decode on the spot and throw away:
 *
 *     { audioWindow: function (startSec, durSec) -> Promise<
 *            ArrayBuffer                        // encoded audio (ADTS AAC / mp4 / wav)
 *          | { buffer, mime?, startSec? }       // startSec = TRUE start of that buffer
 *          | AudioBuffer >,                     // already decoded
 *       name?: string,           // shown in the observability line
 *       cost?: 'cheap'|'costly'  // 'costly' => callers should budget fewer windows
 *     }
 *
 * js/subs-audio-source.js builds these over a WebTorrent file, an hls.js instance,
 * and plain HTTP Range. transcribeWindows() detects them automatically, so the
 * coherence matcher (js/subs-autosync.js) needs no change at all.
 *
 * A window that cannot be sourced (torrent pieces not downloaded, segment 404)
 * resolves to ZERO WORDS instead of rejecting: the sync degrades gracefully, the
 * raw subtitles stay on screen, and nothing ever throws at the user.
 *
 * No external deps, no CDN. ES5-compatible to match the codebase.
 * ==========================================================================*/
(function (window, document) {
  'use strict';

  var IMPL = null;          // the registered heavy impl (or the mock)
  var READY = null;         // memoised ready() promise
  var LISTENERS = [];       // WhisperEngine.onChange listeners
  var STATS = { calls: 0, words: 0, ms: 0, name: null, backend: null,
                windows: 0, windowMisses: 0, bytes: 0, padWords: 0, source: null };

  function emit() { for (var i = 0; i < LISTENERS.length; i++) { try { LISTENERS[i](STATS); } catch (e) {} } }

  // --- registration --------------------------------------------------------
  function register(impl) {
    if (!impl || typeof impl.transcribe !== 'function') throw new Error('WhisperEngine.register: impl.transcribe required');
    IMPL = impl;
    IMPL.sampleRate = impl.sampleRate || 16000;
    READY = null;                      // force a fresh ready() for the new impl
    STATS.name = impl.name || 'whisper';
    STATS.backend = impl.mock ? 'mock' : 'model';
    emit();
    return IMPL;
  }

  function ready() {
    if (!IMPL) IMPL = makeMock();      // never leave the engine without SOMETHING
    if (!READY) {
      READY = Promise.resolve(typeof IMPL.ready === 'function' ? IMPL.ready() : null)
        .then(function () { return IMPL; });
    }
    return READY;
  }

  function isReady() { return !!IMPL && !!READY; }
  function name() { return IMPL ? (IMPL.name || 'whisper') : (STATS.name || null); }

  // --- audio: decode a source to an AudioBuffer (cached) -------------------
  var AC = null;
  function audioCtx() {
    if (!AC) {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) throw new Error('WebAudio unavailable');
      AC = new Ctor();
    }
    return AC;
  }

  var DECODE_CACHE = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
  var URL_DECODE = {};   // url string -> Promise<AudioBuffer>

  function toArrayBuffer(source) {
    if (source instanceof ArrayBuffer) return Promise.resolve(source);
    if (source && source.arrayBuffer instanceof ArrayBuffer) return Promise.resolve(source.arrayBuffer);
    if (typeof Blob !== 'undefined' && source instanceof Blob) return blobToAB(source);
    if (source && source.blob) return blobToAB(source.blob);
    if (source && typeof source.url === 'string') {
      // SAFETY: decode() builds the WHOLE-file AudioBuffer, so a full-length film
      // (GBs of PCM) would OOM the tab. We only ever need a few sparse windows, so
      // refuse to whole-decode anything over MAX_DECODE_BYTES — the caller then
      // keeps the raw (unsynced) subtitles instead of crashing. Window-scoped /
      // range decoding of large streams is the remaining audio-sourcing work.
      var url = source.url;
      return sizeOfURL(url).then(function (bytes) {
        if (bytes != null && bytes > MAX_DECODE_BYTES) {
          throw new Error('WhisperEngine.decode: source too large to whole-decode (' + bytes + ' bytes > ' + MAX_DECODE_BYTES + ') — needs window-scoped decode');
        }
        return fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); });
      });
    }
    return Promise.reject(new Error('WhisperEngine.decode: unsupported source'));
  }

  // ~80MB cap: comfortably covers short/registry clips + typical audio-only
  // sources, well under the memory a whole-file PCM decode would need for a movie.
  var MAX_DECODE_BYTES = 80 * 1024 * 1024;
  function sizeOfURL(url) {
    // blob:/data: URLs are already in memory and small enough to skip the probe.
    if (/^(blob:|data:)/i.test(url)) return Promise.resolve(null);
    return fetch(url, { method: 'HEAD' }).then(function (r) {
      var cl = r && r.headers && r.headers.get && r.headers.get('content-length');
      return cl ? parseInt(cl, 10) : null;
    })['catch'](function () { return null; });   // HEAD unsupported/opaque -> allow, best effort
  }
  function blobToAB(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer();
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(fr.error || new Error('blob read failed')); };
      fr.readAsArrayBuffer(blob);
    });
  }

  function decode(source) {
    // AudioBuffer already
    if (source && typeof source.getChannelData === 'function') return Promise.resolve(source);
    if (source && source.audioBuffer && typeof source.audioBuffer.getChannelData === 'function')
      return Promise.resolve(source.audioBuffer);
    // cache by object or url
    if (source && typeof source.url === 'string' && URL_DECODE[source.url]) return URL_DECODE[source.url];
    if (DECODE_CACHE && typeof source === 'object' && source !== null && DECODE_CACHE.has(source)) return DECODE_CACHE.get(source);

    var p = toArrayBuffer(source).then(function (ab) {
      var ctx = audioCtx();
      return new Promise(function (res, rej) {
        // decodeAudioData: promise form + legacy callback form
        var ret = ctx.decodeAudioData(ab.slice ? ab.slice(0) : ab, res, rej);
        if (ret && typeof ret.then === 'function') ret.then(res, rej);
      });
    });
    if (source && typeof source.url === 'string') URL_DECODE[source.url] = p;
    else if (DECODE_CACHE && typeof source === 'object' && source !== null) DECODE_CACHE.set(source, p);
    return p;
  }

  // --- resample a window of an AudioBuffer to mono Float32 @ rate ----------
  function pcmFromAudioBuffer(buf, start, dur, rate) {
    rate = rate || (IMPL && IMPL.sampleRate) || 16000;
    var sr = buf.sampleRate, ch = buf.numberOfChannels;
    var from = Math.max(0, Math.floor(start * sr));
    var to = Math.min(buf.length, Math.ceil((start + dur) * sr));
    if (to <= from) return new Float32Array(0);
    var n = to - from;
    // downmix to mono
    var mono = new Float32Array(n);
    for (var c = 0; c < ch; c++) {
      var d = buf.getChannelData(c);
      for (var i = 0; i < n; i++) mono[i] += d[from + i] / ch;
    }
    if (sr === rate) return mono;
    // linear resample to target rate
    var outLen = Math.round(n * rate / sr);
    var out = new Float32Array(outLen);
    var ratio = (n - 1) / Math.max(1, outLen - 1);
    for (var j = 0; j < outLen; j++) {
      var x = j * ratio, i0 = Math.floor(x), i1 = Math.min(n - 1, i0 + 1), f = x - i0;
      out[j] = mono[i0] * (1 - f) + mono[i1] * f;
    }
    return out;
  }

  // --- transcribe sparse windows ------------------------------------------
  // source may be a media element (we prefer a decodable file if given), a Blob,
  // an ArrayBuffer, a {url}, or an AudioBuffer. Mock impls can skip audio.
  function transcribeWindows(source, windows, opts) {
    opts = opts || {};
    windows = (windows || []).filter(function (w) { return w && w.dur > 0; });
    return ready().then(function (impl) {
      // A mock impl can synthesize words from windows without any audio.
      if (impl.mock && typeof impl.transcribeWindow === 'function') {
        return Promise.all(windows.map(function (w) {
          return Promise.resolve(impl.transcribeWindow(w.start, w.dur, opts)).then(function (r) {
            return normalizeWindowResult(w, r);
          });
        }));
      }
      // Real impl: need decoded audio. Split each requested window into clips of
      // <= impl.maxWindow seconds (whisper-tiny wants <=10s per call) and merge.
      var rate = impl.sampleRate || 16000;
      var maxW = impl.maxWindow || 30;

      // STREAM PATH: a window provider sources+decodes ONE window at a time, so a
      // full-length torrent/HLS film never gets whole-decoded (that would OOM).
      if (isWindowProvider(source)) {
        STATS.source = source.name || 'window-provider'; emit();
        return windows.reduce(function (chain, w) {
          return chain.then(function (acc) {
            return transcribeProvided(impl, source, w, rate, maxW, opts).then(function (nw) {
              acc.push(nw); return acc;
            });
          });
        }, Promise.resolve([]));
      }

      STATS.source = sourceKind(source); emit();
      return decode(source).then(function (buf) {
        return windows.reduce(function (chain, w) {
          return chain.then(function (acc) {
            return transcribeOneWindow(impl, buf, w, rate, maxW, opts).then(function (nw) {
              acc.push(nw); return acc;
            });
          });
        }, Promise.resolve([]));
      });
    });
  }

  // Transcribe ONE window by chopping it into <=maxW second clips (word times
  // come back clip-relative; we shift each to absolute media time and merge).
  function transcribeOneWindow(impl, buf, w, rate, maxW, opts) {
    var clips = [];
    for (var o = 0; o < w.dur; o += maxW) clips.push({ start: w.start + o, dur: Math.min(maxW, w.dur - o) });
    var words = [];
    return clips.reduce(function (chain, clip) {
      return chain.then(function () {
        var pcm = pcmFromAudioBuffer(buf, clip.start, clip.dur, rate);
        if (!pcm.length) return;
        var t0 = now();
        return Promise.resolve(impl.transcribe(pcm, rate, opts)).then(function (r) {
          STATS.calls++; STATS.ms += now() - t0;
          var ws = (r && r.words) || [];
          STATS.padWords += pushWords(words, ws, clip.start, clip.dur);   // drop padding hallucinations
          STATS.words += ws.length; emit();
        });
      });
    }, Promise.resolve()).then(function () {
      return { start: w.start, dur: w.dur, words: words, text: words.map(function (x) { return x.text; }).join(' ') };
    });
  }

  // --- window providers (torrent / HLS / ranged file) ----------------------
  function isWindowProvider(s) { return !!(s && typeof s.audioWindow === 'function'); }

  function sourceKind(s) {
    if (!s) return null;
    if (isWindowProvider(s)) return s.name || 'window-provider';
    if (typeof s.getChannelData === 'function' || (s.audioBuffer && s.audioBuffer.getChannelData)) return 'audiobuffer';
    if (typeof s.url === 'string') return 'url';
    if (typeof Blob !== 'undefined' && (s instanceof Blob || s.blob)) return 'blob';
    if (s instanceof ArrayBuffer || s.arrayBuffer instanceof ArrayBuffer) return 'arraybuffer';
    if (s.tagName) return 'media-element';
    return 'unknown';
  }

  // Decode a SMALL encoded chunk (one window, ~30s) with no caching — these are
  // transient by design: source it, decode it, use it, let it go.
  function decodeChunk(ab) {
    var ctx = audioCtx();
    return new Promise(function (res, rej) {
      var copy = ab.slice ? ab.slice(0) : ab;   // decodeAudioData detaches its input
      var ret = ctx.decodeAudioData(copy, res, rej);
      if (ret && typeof ret.then === 'function') ret.then(res, rej);
    });
  }

  // Normalise whatever the provider handed back into {buffer:AudioBuffer, startSec}.
  function resolveProvided(out, fallbackStart) {
    if (!out) return Promise.resolve(null);
    if (typeof out.getChannelData === 'function') return Promise.resolve({ buffer: out, startSec: fallbackStart });
    var ab = null, startSec = fallbackStart;
    if (out instanceof ArrayBuffer) ab = out;
    else if (out.buffer instanceof ArrayBuffer) {
      ab = out.buffer;
      if (typeof out.startSec === 'number' && isFinite(out.startSec)) startSec = out.startSec;
    } else if (out.buffer && typeof out.buffer.getChannelData === 'function') {
      return Promise.resolve({ buffer: out.buffer, startSec: (typeof out.startSec === 'number') ? out.startSec : fallbackStart });
    } else if (out.byteLength != null && out.buffer) {          // a TypedArray view
      ab = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    }
    if (!ab || !ab.byteLength) return Promise.resolve(null);
    STATS.bytes += ab.byteLength;
    return decodeChunk(ab).then(function (buf) { return { buffer: buf, startSec: startSec }; });
  }

  // Transcribe ONE window through a provider: pull just that window's encoded
  // audio, decode it alone, chop into <=maxW clips, transcribe, drop the audio.
  // A window we cannot source yields zero words (never a rejection) so the
  // matcher simply scores it low and the raw subtitles stay on screen.
  function transcribeProvided(impl, provider, w, rate, maxW, opts) {
    STATS.windows++;
    return Promise.resolve()
      .then(function () { return provider.audioWindow(w.start, w.dur); })
      .then(function (out) { return resolveProvided(out, w.start); })
      .then(function (got) {
        if (!got || !got.buffer) { STATS.windowMisses++; emit(); return emptyWindow(w); }
        var buf = got.buffer;
        // Times inside the returned buffer are relative to got.startSec, which may
        // sit slightly BEFORE the requested start (codec frames don't split on
        // arbitrary boundaries). Offset into the buffer so clip times stay absolute.
        var lead = Math.max(0, w.start - got.startSec);
        var avail = Math.max(0, buf.duration - lead);
        if (avail <= 0.05) { STATS.windowMisses++; emit(); return emptyWindow(w); }
        var span = Math.min(w.dur, avail);
        var clips = [];
        for (var o = 0; o < span; o += maxW) clips.push({ start: w.start + o, off: lead + o, dur: Math.min(maxW, span - o) });
        var words = [];
        return clips.reduce(function (chain, clip) {
          return chain.then(function () {
            var pcm = pcmFromAudioBuffer(buf, clip.off, clip.dur, rate);
            if (!pcm.length) return;
            var t0 = now();
            return Promise.resolve(impl.transcribe(pcm, rate, opts)).then(function (r) {
              STATS.calls++; STATS.ms += now() - t0;
              var ws = (r && r.words) || [];
              STATS.padWords += pushWords(words, ws, clip.start, clip.dur);
              STATS.words += ws.length; emit();
            });
          });
        }, Promise.resolve()).then(function () {
          return { start: w.start, dur: w.dur, words: words, text: words.map(function (x) { return x.text; }).join(' ') };
        });
      })['catch'](function () { STATS.windowMisses++; emit(); return emptyWindow(w); });
  }

  function emptyWindow(w) { return { start: w.start, dur: w.dur, words: [], text: '' }; }
  function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

  // Collect one clip's words into the window, shifted to ABSOLUTE media time.
  //
  // Whisper always processes a fixed 30-second frame and PADS a shorter clip with
  // silence, so it can (and does) emit timestamps out in the padding — we observed
  // words dated 85s and 99s inside a 60-80s window. Audio does not exist out there,
  // so those are hallucinations on silence, and letting them through would poison
  // the coherence matcher's anchor times. Drop anything starting past the clip's
  // real duration and clamp the ends. Nothing is invented, only impossible times
  // are refused.
  var PAD_TOL = 0.35;    // seconds of slack for boundary rounding
  function pushWords(into, ws, clipStart, clipDur) {
    var dropped = 0;
    for (var i = 0; i < ws.length; i++) {
      var st = +ws[i].start || 0;
      if (st > clipDur + PAD_TOL) { dropped++; continue; }         // in the zero padding
      var en = +ws[i].end || st;
      if (en > clipDur) en = clipDur;
      if (en < st) en = st;
      into.push({ text: String(ws[i].text == null ? ws[i].word : ws[i].text), start: clipStart + st, end: clipStart + en });
    }
    return dropped;
  }

  function normalizeWindowResult(w, r) {
    r = r || {};
    var words = (r.words || []).map(function (x) {
      return { text: String(x.text == null ? x.word : x.text), start: w.start + (+x.start || 0), end: w.start + (+x.end || +x.start || 0) };
    });
    return { start: w.start, dur: w.dur, words: words, text: r.text || words.map(function (x) { return x.text; }).join(' ') };
  }

  // --- live tap: record PCM off a PLAYING media element (no seeking) -------
  // Returns { samples(), stop() }. Useful for sync-as-plays when no file Blob.
  function liveTap(mediaEl, tapRate) {
    var ctx = audioCtx();
    var rate = tapRate || (IMPL && IMPL.sampleRate) || 16000;
    var src;
    try { src = ctx.createMediaElementSource(mediaEl); }
    catch (e) { return { stop: function () {}, error: e, samples: function () { return null; } }; }
    var buf = [];          // ring of {t, data:Float32}
    var maxSec = 90;       // keep ~90s of recent audio
    var proc = ctx.createScriptProcessor ? ctx.createScriptProcessor(4096, 1, 1) : null;
    if (!proc) { try { src.connect(ctx.destination); } catch (e2) {} return { stop: function () {}, samples: function () { return null; } }; }
    proc.onaudioprocess = function (ev) {
      var inp = ev.inputBuffer.getChannelData(0);
      buf.push({ t: mediaEl.currentTime, data: new Float32Array(inp) });
      var total = 0, i;
      for (i = buf.length - 1; i >= 0; i--) { total += buf[i].data.length; if (total / ctx.sampleRate > maxSec) { buf.splice(0, i); break; } }
    };
    src.connect(proc); proc.connect(ctx.destination); src.connect(ctx.destination);
    return {
      stop: function () { try { proc.disconnect(); src.disconnect(); } catch (e) {} },
      samples: function () { return buf.slice(); },
      rate: rate
    };
  }

  // --- MockWhisper: deterministic, audio-free, for algorithm + proofs ------
  // Backed by a "truth" cue set (the correctly-timed dialogue). transcribeWindow
  // returns the words that fall in [start,start+dur], optionally with ASR noise.
  function makeMock(cfg) {
    cfg = cfg || {};
    var truth = [];            // [{start,end,text}]
    var words = [];            // flattened [{text,start,end}] from truth
    var noise = cfg.noise || 0;   // 0..1 fraction of words dropped
    var jitter = cfg.jitter || 0; // +/- seconds random on each word time
    var seed = cfg.seed || 1337;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

    function rebuild() {
      words = [];
      for (var i = 0; i < truth.length; i++) {
        var c = truth[i];
        var toks = String(c.text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
        if (!toks.length) continue;
        var span = Math.max(0.2, (c.end || c.start + 1) - c.start);
        for (var j = 0; j < toks.length; j++) {
          var st = c.start + span * (j / toks.length);
          var en = c.start + span * ((j + 1) / toks.length);
          words.push({ text: toks[j], start: st, end: en });
        }
      }
      words.sort(function (a, b) { return a.start - b.start; });
    }

    return {
      name: cfg.name || 'mock-whisper',
      mock: true,
      sampleRate: 16000,
      ready: function () { return Promise.resolve(); },
      setTruth: function (cues) { truth = (cues || []).slice(); rebuild(); },
      truthWords: function () { return words.slice(); },
      transcribeWindow: function (start, dur, opts) {
        var out = [];
        for (var i = 0; i < words.length; i++) {
          var w = words[i];
          if (w.start >= start - 0.001 && w.start < start + dur) {
            if (noise && rnd() < noise) continue;                 // dropped word
            var js = jitter ? (rnd() * 2 - 1) * jitter : 0;
            out.push({ text: w.text, start: (w.start - start) + js, end: (w.end - start) + js });
          }
        }
        return { words: out, text: out.map(function (x) { return x.text; }).join(' ') };
      },
      // also satisfy the raw transcribe() contract if ever called with pcm
      transcribe: function () { return Promise.resolve({ words: [], text: '' }); }
    };
  }

  var WhisperEngine = {
    register: register,
    ready: ready,
    isReady: isReady,
    name: name,
    stats: function () {
      return { calls: STATS.calls, words: STATS.words, ms: Math.round(STATS.ms), name: STATS.name, backend: STATS.backend,
               windows: STATS.windows, windowMisses: STATS.windowMisses, bytes: STATS.bytes, source: STATS.source };
    },
    onChange: function (cb) { if (typeof cb === 'function') LISTENERS.push(cb); },
    transcribeWindows: transcribeWindows,
    decode: decode,
    decodeChunk: decodeChunk,               // decode ONE small encoded window
    isWindowProvider: isWindowProvider,
    sourceKind: sourceKind,
    pcmFromAudioBuffer: pcmFromAudioBuffer,
    liveTap: liveTap,
    makeMock: makeMock,
    // install a mock as the active impl (used by tests/proof + as safe default)
    useMock: function (cfg) { var m = makeMock(cfg); register(m); return m; },
    version: '1.0.0'
  };

  window.WhisperEngine = WhisperEngine;
  if (typeof module !== 'undefined' && module.exports) module.exports = WhisperEngine;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this),
   typeof document !== 'undefined' ? document : null);
