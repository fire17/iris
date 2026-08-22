/* =============================================================================
 * whisper-tiny.js  —  the REAL whisper impl, plugged into window.WhisperEngine.
 *
 * Model (chosen + live-verified by the subs-research lane):
 *   onnx-community/whisper-tiny.en_timestamped  via transformers.js (vendored).
 *   16 kHz mono Float32 [-1,1] in -> exact WORD timestamps out.
 *
 * Vendored assets (must live under vendor/, committed beside this file):
 *   vendor/transformers/                    transformers.js dist + ort *.wasm
 *   vendor/whisper-tiny.en_timestamped/     config + tokenizer + onnx/*.onnx
 *
 * Design: PROBE-GATED. We only register with WhisperEngine once the vendored
 * config.json is reachable, so until the ~47MB is present the engine stays on the
 * deterministic MockWhisper and the app never breaks. WebGPU-first, WASM fallback.
 * Decoder dtype: q4f16 on WebGPU, q8 on WASM (q8 on WebGPU = gibberish, #1317).
 * Encoder stays fp16 (quantizing it wrecks alignment).
 * ==========================================================================*/
(function (window, document) {
  'use strict';
  if (!window || !document) return;

  var PATHS = {
    // resolved relative to the document so it works under any base path
    lib: ['vendor/transformers/transformers.min.js', 'vendor/transformers/transformers.js', 'vendor/transformers/transformers.min.mjs'],
    wasmDir: 'vendor/transformers/',
    modelRoot: 'vendor/',                       // env.localModelPath
    modelId: 'whisper-tiny.en_timestamped',
    multilingualId: 'whisper-tiny_timestamped', // for non-English AUDIO titles
    probe: 'vendor/whisper-tiny.en_timestamped/config.json'
  };
  function abs(p) { try { return new URL(p, document.baseURI).href; } catch (e) { return p; } }

  var transcriber = null;      // pipeline instance
  var loadP = null;            // memoised load
  var LIB = null;
  var registered = false;

  function pickLib() {
    // dynamic import the first vendored entry that resolves
    var i = 0;
    function next() {
      if (i >= PATHS.lib.length) return Promise.reject(new Error('transformers.js dist not found in vendor/transformers/'));
      var url = abs(PATHS.lib[i++]);
      return import(/* @vite-ignore */ url).then(function (m) { return m; }, function () { return next(); });
    }
    return next();
  }

  function hasWebGPU() { return !!(navigator && navigator.gpu); }

  function load() {
    if (loadP) return loadP;
    loadP = pickLib().then(function (mod) {
      LIB = mod;
      var env = mod.env || (mod.default && mod.default.env);
      var pipeline = mod.pipeline || (mod.default && mod.default.pipeline);
      if (!pipeline) throw new Error('transformers.js: pipeline export missing');
      if (env) {
        env.allowLocalModels = true;
        env.allowRemoteModels = false;                       // never hit a CDN at runtime
        env.localModelPath = '/' + PATHS.modelRoot;
        if (env.backends && env.backends.onnx && env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = '/' + PATHS.wasmDir;
      }
      // PROVEN RECIPE (live-verified headless Chrome, 2026-08-21):
      //   device=wasm · encoder fp16 (16.5MB) · decoder q8 (30.7MB) = ~47MB.
      //   graphOptimizationLevel:'disabled' is REQUIRED — ort's extended
      //   MatMulNBits fusion throws "Missing required scale …weight_merged_0_scale"
      //   on the q8/int8 whisper decoder exports; disabling opt sidesteps it and
      //   still yields exact word timestamps at RTF ~0.16 on WASM.
      //   (WebGPU q4f16 is a future opt — its onnx files are not vendored, so we
      //   stay on the proven WASM path rather than ship an unverified device.)
      var opts = {
        device: 'wasm',
        dtype: { encoder_model: 'fp16', decoder_model_merged: 'q8' },
        session_options: { graphOptimizationLevel: 'disabled' }
      };
      return pipeline('automatic-speech-recognition', PATHS.modelId, opts)
        .then(function (t) { transcriber = t; return t; });
    });
    return loadP;
  }

  // impl.transcribe: PCM (Float32 @16k mono) -> word timestamps
  function transcribe(pcm, sampleRate, opts) {
    return load().then(function (t) {
      return t(pcm, { return_timestamps: 'word' });   // NO chunk_length_s (bug #1358)
    }).then(function (out) {
      var chunks = (out && out.chunks) || [];
      var words = chunks.map(function (c) {
        var ts = c.timestamp || [0, 0];
        return { text: String(c.text || '').trim(), start: +ts[0] || 0, end: +ts[1] || +ts[0] || 0 };
      });
      return { words: words, text: (out && out.text) || words.map(function (w) { return w.text; }).join(' ') };
    });
  }

  var impl = {
    name: 'whisper-tiny.en_timestamped',
    sampleRate: 16000,
    maxWindow: 10,             // keep every clip <=10s (whisper-tiny sweet spot)
    ready: load,
    transcribe: transcribe
  };

  function register() {
    if (registered || !window.WhisperEngine) return;
    window.WhisperEngine.register(impl);
    registered = true;
  }

  // PROBE: only take over from MockWhisper if the vendored model is actually here.
  function probeAndRegister() {
    return fetch(abs(PATHS.probe), { method: 'GET', cache: 'force-cache' })
      .then(function (r) { if (r.ok) { register(); return true; } return false; })
      ['catch'](function () { return false; });
  }

  // Public control (also lets a settings toggle force-enable / verify)
  window.WhisperTiny = {
    paths: PATHS,
    impl: impl,
    enable: function () { register(); return load(); },     // force register + load
    probe: probeAndRegister,
    isRegistered: function () { return registered; },
    isLoaded: function () { return !!transcriber; },
    // one-shot self-verify: register + load + transcribe 1s of silence
    verify: function () {
      register();
      return load().then(function () { return transcribe(new Float32Array(16000), 16000, {}); })
        .then(function (r) { return { ok: true, words: (r.words || []).length }; }, function (e) { return { ok: false, error: String(e && e.message || e) }; });
    }
  };

  // Auto-probe once the engine exists (non-blocking; stays on mock if assets absent).
  function boot() {
    if (window.WhisperEngine) probeAndRegister();
    else setTimeout(boot, 200);
  }
  if (document.readyState !== 'loading') boot();
  else document.addEventListener('DOMContentLoaded', boot);

})(typeof window !== 'undefined' ? window : null, typeof document !== 'undefined' ? document : null);
