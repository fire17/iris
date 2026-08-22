/* =============================================================================
 * subs-autosync.js  —  window.SubsAutoSync
 *
 * The INTELLIGENCE layer on top of the subtitle baseline (subs-standard owns
 * fetch + render + UI; subs-research owns the whisper model). This module:
 *
 *   1. COHERENCE MATCH  — per candidate sub / language: take the sub's FIRST
 *      sentence time (t0), LAST sentence time (tN) and the delta pattern; ask the
 *      whisper engine for WORD timestamps on a few SPARSE audio windows; fuzzy-
 *      find the first sentence (first instance) and last sentence (last instance)
 *      in the audio; if (t0,tN,deltas) closely match -> mark the sub "coherent".
 *      LAZY: stop at the first good match per language.
 *   2. ONE-SHOT SYNC    — from the matched anchor times, recover a linear map
 *      audioTime = scale*subTime + offset and apply it to every cue. Automatic.
 *   3. UX FLOW          — user picks a language -> instantly gets subs:
 *      (a) show whatever is available + fast autosync, (b) hotswap to a better
 *      COHERENT one if found, (c) autosync again + hotswap. Background, automatic.
 *   4. HARVEST + QUEUE  — start fetching subs when the user opens an item's
 *      detail (poster click), before streaming. Series: prioritise the SELECTED
 *      season/episode; if the user navigates, PAUSE the in-flight fetch INSTANTLY
 *      and switch to the newest selection.
 *   5. PERSIST          — subtitle config (off|language) in localStorage; auto-
 *      apply last used until changed.
 *
 * Observable (onState + the Subs Lab panel), adjustable, decoupled. ES5.
 * Integration contract agreed with subs-standard:
 *   - Renderer is theirs. When window.__subsRendererPresent is truthy we DO NOT
 *     self-attach a <track>; we return synced cues via sync() for them to paint.
 *   - Fetch source is theirs: window.SubsSource.list(type,id,extra). We reuse it.
 *   - Config key hp.subs.cfg, read-modify-write MERGE (we only own {mode,lang}).
 * ==========================================================================*/
(function (root, document) {
  'use strict';

  var HAS_DOM = typeof document !== 'undefined' && !!document;

  // ---- tunables (adjustable at runtime via SubsAutoSync.opts) -------------
  var OPTS = {
    matchThresh: 0.5,     // fuzzy phrase-match acceptance
    scaleTol: 0.06,       // |scale-1| tolerance (covers 23.976<->25 framerate)
    residTol: 1.2,        // seconds: mid-anchor residual tolerance (delta pattern)
    frontPad: 8, frontLen: 20,    // whisper window around the first sentence
    backPad: 10, backLen: 22,     // around the last sentence
    midPad: 7, midLen: 16,        // around the predicted mid sentence
    wideLen: 90,          // widened flexible-scan span when the sub is far off
    anchorTokens: 7,      // target token count per anchor phrase
    anchorMaxCues: 3,     // cues to merge into one anchor phrase
    wideScan: true,       // if expected window misses, widen the search
    timingBoundScore: 0.7,// confidence assigned to a speech-boundary (timing mode)
    defaultSubUrl: 'https://opensubtitles-v3.strem.io',
    // STREAM BUDGET: when the audio comes from a COSTLY window provider (a torrent
    // whose end-of-film pieces still have to be fetched, or an HLS segment over the
    // network) every extra whisper window costs real bytes and seconds. So we spend
    // fewer of them: no wide rescans, one back window, one candidate. That is
    // fire17's explicit "lazy good-enough" — a confident front-anchor offset beats a
    // perfect sync that arrives after the scene is over.
    costlyBudget: { wideScan: false, backWins: 1, maxCandidates: 1 }
  };

  var CFG_KEY = 'hp.subs.cfg';

  /* =========================================================================
   * PURE ALGORITHM  (no DOM, no network — unit-testable in Node)
   * =======================================================================*/

  // --- normalisation -------------------------------------------------------
  function stripTags(s) { return String(s == null ? '' : s).replace(/<[^>]*>/g, ' ').replace(/\{[^}]*\}/g, ' '); }

  function normTokens(s) {
    s = stripTags(s).toLowerCase();
    // strip bracketed stage directions: [music], (sighs)
    s = s.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');
    // keep letters/numbers/apostrophes across unicode; split on the rest
    var toks;
    try { toks = s.replace(/[^\p{L}\p{N}'\s]/gu, ' ').split(/\s+/); }
    catch (e) { toks = s.replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/); }
    var out = [];
    for (var i = 0; i < toks.length; i++) { var t = toks[i].replace(/^'+|'+$/g, ''); if (t) out.push(t); }
    // CJK / scriptio-continua fallback: shingle a space-less run into character
    // bigrams so matching still works. GUARD: only for genuinely non-Latin scripts.
    // A lone Latin word ("good") or number must stay intact — matchPhrase feeds
    // this ONE whisper word at a time, so shingling English here silently broke
    // every fuzzy match (fixed 2026-08-21).
    if (out.length < 2) {
      var chars;
      try { chars = s.replace(/[^\p{L}\p{N}]/gu, ''); } catch (e) { chars = s.replace(/[^a-z0-9]/g, ''); }
      if (chars.length >= 2 && !/[a-z0-9]/i.test(chars)) {
        out = []; for (var c = 0; c < chars.length - 1; c++) out.push(chars.substr(c, 2));
      }
    }
    return out;
  }

  var JUNK_RE = /(opensubtitles|subscene|addic7ed|subtitle|sub[\- ]?title|encoded|ripped|resync|re-?sync|corrected by|sync by|synced by|www\.|https?:|\.com|\.org|\.net|@|©|advertise|support us|download.*free|watch online|api\s*key|subs by|traduzione|translat(ed|ion) by|uploaded by)/i;
  function isJunk(text) {
    var t = stripTags(text).trim();
    if (!t) return true;
    if (JUNK_RE.test(t)) return true;
    // pure digits / timecodes / all-symbol
    if (/^[\d\s:.,\-]+$/.test(t)) return true;
    return false;
  }

  // --- cue parsing ---------------------------------------------------------
  function tc(h, m, s, ms) { return (+h) * 3600 + (+m) * 60 + (+s) + (+ms) / 1000; }

  function parseSRT(text) {
    var out = [];
    var s = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    var blocks = s.split(/\n\s*\n/);
    var re = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;
    for (var i = 0; i < blocks.length; i++) {
      var lines = blocks[i].split('\n'), m = null, ti = -1;
      for (var j = 0; j < lines.length; j++) { m = re.exec(lines[j]); if (m) { ti = j; break; } }
      if (!m) continue;
      var start = tc(m[1], m[2], m[3], m[4]), end = tc(m[5], m[6], m[7], m[8]);
      var body = lines.slice(ti + 1).join('\n').trim();
      if (body) out.push({ start: start, end: end, text: body });
    }
    return out;
  }

  function parseVTT(text) {
    var s = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    s = s.replace(/^WEBVTT[^\n]*\n/, '');
    var out = [];
    var blocks = s.split(/\n\s*\n/);
    var re = /(\d{1,2}:)?(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}:)?(\d{2}):(\d{2})[.,](\d{1,3})/;
    for (var i = 0; i < blocks.length; i++) {
      var lines = blocks[i].split('\n'), m = null, ti = -1;
      for (var j = 0; j < lines.length; j++) { m = re.exec(lines[j]); if (m) { ti = j; break; } }
      if (!m) continue;
      var sh = m[1] ? parseInt(m[1], 10) : 0, eh = m[5] ? parseInt(m[5], 10) : 0;
      var start = tc(sh, m[2], m[3], m[4]), end = tc(eh, m[6], m[7], m[8]);
      var body = lines.slice(ti + 1).join('\n').trim();
      if (body) out.push({ start: start, end: end, text: body });
    }
    return out;
  }

  function parseCues(text) {
    var t = String(text || '');
    return /^﻿?WEBVTT/.test(t) ? parseVTT(t) : parseSRT(t);
  }

  function toVTT(cues) {
    var s = 'WEBVTT\n\n';
    function fmt(x) {
      if (x < 0) x = 0;
      var h = Math.floor(x / 3600), m = Math.floor((x % 3600) / 60), sec = Math.floor(x % 60), ms = Math.round((x - Math.floor(x)) * 1000);
      function p(n, w) { n = '' + n; while (n.length < w) n = '0' + n; return n; }
      return p(h, 2) + ':' + p(m, 2) + ':' + p(sec, 2) + '.' + p(ms, 3);
    }
    for (var i = 0; i < cues.length; i++) {
      s += (i + 1) + '\n' + fmt(cues[i].start) + ' --> ' + fmt(cues[i].end) + '\n' + cues[i].text + '\n\n';
    }
    return s;
  }

  // --- fuzzy phrase similarity (bigram Dice blended with unigram recall) ----
  function bigrams(tokens) {
    var b = {};
    for (var i = 0; i < tokens.length - 1; i++) { var k = tokens[i] + '' + tokens[i + 1]; b[k] = (b[k] || 0) + 1; }
    if (tokens.length === 1) b[tokens[0]] = 1;
    return b;
  }
  function unis(tokens) { var u = {}; for (var i = 0; i < tokens.length; i++) u[tokens[i]] = (u[tokens[i]] || 0) + 1; return u; }
  function multisetOverlap(a, b) { var n = 0; for (var k in a) if (b[k]) n += Math.min(a[k], b[k]); return n; }
  function count(a) { var n = 0; for (var k in a) n += a[k]; return n; }

  function similarity(pTokens, wTokens) {
    if (!pTokens.length || !wTokens.length) return 0;
    var pb = bigrams(pTokens), wb = bigrams(wTokens);
    var interB = multisetOverlap(pb, wb), sumB = count(pb) + count(wb);
    var dice = sumB ? (2 * interB) / sumB : 0;
    var pu = unis(pTokens), wu = unis(wTokens);
    var recall = count(pu) ? multisetOverlap(pu, wu) / count(pu) : 0;
    return 0.55 * dice + 0.45 * recall;
  }

  // Slide the phrase across the whisper word stream; return best-matching span.
  // instance: 'first' -> earliest span above thresh; 'last' -> latest; else best.
  function matchPhrase(words, phraseTokens, instance, thresh) {
    thresh = thresh == null ? OPTS.matchThresh : thresh;
    var W = [], T = [];
    for (var i = 0; i < words.length; i++) {
      var toks = normTokens(words[i].text);
      for (var k = 0; k < toks.length; k++) { W.push(toks[k]); T.push(words[i].start); }
    }
    var m = phraseTokens.length;
    if (!m || !W.length) return { score: 0, time: null, index: -1 };
    var best = { score: -1, time: null, index: -1 };
    var chosen = null;
    var minL = Math.max(2, m - 2), maxL = m + 3;
    for (var s = 0; s + minL <= W.length; s++) {
      for (var L = minL; L <= maxL && s + L <= W.length; L++) {
        var win = W.slice(s, s + L);
        var sc = similarity(phraseTokens, win);
        if (sc > best.score) best = { score: sc, time: T[s], index: s, len: L };
        if (sc >= thresh) {
          if (instance === 'first') { if (!chosen) { chosen = { score: sc, time: T[s], index: s, len: L }; } }
          else if (instance === 'last') { chosen = { score: sc, time: T[s], index: s, len: L }; }
        }
      }
      // 'first' can stop scanning once locked in (lazy)
      if (instance === 'first' && chosen && s > chosen.index + 40) break;
    }
    return chosen || best;
  }

  // --- anchors -------------------------------------------------------------
  // Build first/mid/last anchor phrases from real dialogue cues (skip junk).
  function buildAnchors(cues) {
    var real = [];
    for (var i = 0; i < cues.length; i++) if (!isJunk(cues[i].text)) real.push(cues[i]);
    if (real.length < 2) real = cues.slice();
    function group(startIdx, dir) {
      var toks = [], time = null, used = 0;
      var idx = startIdx;
      while (idx >= 0 && idx < real.length && used < OPTS.anchorMaxCues && toks.length < OPTS.anchorTokens) {
        var t = normTokens(real[idx].text);
        if (t.length) {
          if (dir > 0) { if (time == null) time = real[idx].start; toks = toks.concat(t); }
          else { toks = t.concat(toks); time = real[idx].start; }
          used++;
        }
        idx += dir;
      }
      return { tokens: toks.slice(0, Math.max(OPTS.anchorTokens, 4)), time: time };
    }
    var front = group(0, +1);
    var back = group(real.length - 1, -1);
    var midI = Math.floor(real.length / 2);
    var mid = { tokens: normTokens(real[midI].text).slice(0, OPTS.anchorTokens), time: real[midI].start };
    var duration = cues.length ? cues[cues.length - 1].end : 0;
    return { front: front, back: back, mid: mid, duration: duration };
  }

  // --- coherence (async: needs transcribeWindows([{start,dur}])->Promise<[{words}]>)
  // Two modes:
  //   'text'   — sub-lang == audio-lang: fuzzy-match the sub's first/last
  //              sentences in the audio transcript -> precise offset+scale.
  //   'timing' — any other sub-lang: align the sub's first/last real-cue times
  //              + delta pattern to the audio's detected speech envelope (first/
  //              last spoken-word times). Language-agnostic off one audio pass.
  function firstWordStart(words) { return (words && words.length) ? words[0].start : null; }
  function lastWordEnd(words) { return (words && words.length) ? words[words.length - 1].end : null; }
  function nearestWordTime(words, t) {
    var best = null, bd = Infinity;
    for (var i = 0; i < (words || []).length; i++) { var d = Math.abs(words[i].start - t); if (d < bd) { bd = d; best = words[i].start; } }
    return best;
  }

  function locate(transcribeWindows, cues, opts) {
    opts = opts || {};
    var A = buildAnchors(cues);
    if (A.front.time == null || A.back.time == null || A.back.time <= A.front.time) {
      return Promise.resolve({ coherent: false, score: 0, reason: 'degenerate-anchors', anchors: A });
    }
    // audio/media duration lets us anchor the last-sentence search to the AUDIO
    // END — drift-proof (framerate mismatch shifts tN by minutes, but the last
    // line stays near the film's end regardless of scale).
    var duration = (opts.duration && opts.duration > A.front.time + 30) ? opts.duration : A.duration;

    // A costly audio source (torrent / HLS window provider) shrinks the search:
    // fewer, cheaper windows — see OPTS.costlyBudget.
    var budget = opts.budget || {};
    var wide = (budget.wideScan === false) ? false : OPTS.wideScan;

    var frontWins = [{ start: Math.max(0, A.front.time - OPTS.frontPad), dur: OPTS.frontLen }];
    if (wide) frontWins.push({ start: 0, dur: OPTS.wideLen });

    var backWins;
    if (duration && duration > A.front.time + 30) {
      // walk back from the end, absorbing end-credits silence
      backWins = [
        { start: Math.max(0, duration - 50), dur: 50 },
        { start: Math.max(0, duration - 150), dur: 105 },
        { start: Math.max(0, duration - 300), dur: 160 }
      ];
    } else {
      backWins = [{ start: Math.max(0, A.back.time - OPTS.backPad), dur: OPTS.backLen }];
      if (wide) backWins.push({ start: Math.max(0, (A.duration || 0) - OPTS.wideLen), dur: OPTS.wideLen });
    }
    if (budget.backWins > 0 && backWins.length > budget.backWins) backWins = backWins.slice(0, budget.backWins);

    // Try windows in order. FAST PATH: a STRONG match (>= strongThresh) in an
    // early window short-circuits — a roughly-aligned sub locks instantly and we
    // never pay for the wide scan. Otherwise keep scanning and return the BEST
    // match across ALL windows, so a badly-shifted sub whose cue-centred window
    // lands on the WRONG line (a weak false-positive) is corrected by the wide
    // window's stronger true match instead of locking onto the first >=thresh.
    var strongThresh = Math.min(0.95, OPTS.matchThresh + 0.2);
    function seek(wins, tokens, instance) {
      var i = 0, best = { score: -1, time: null, words: [] }, boundWords = null;
      function step() {
        if (i >= wins.length) return Promise.resolve({ time: best.time, score: best.score, words: (best.words && best.words.length) ? best.words : (boundWords || []), found: best.score >= OPTS.matchThresh });
        var wi = i++;
        return transcribeWindows([wins[wi]]).then(function (r) {
          var words = r[0] ? r[0].words : [];
          if (words.length && !boundWords) boundWords = words;
          var m = matchPhrase(words, tokens, instance);
          if (m.score > best.score) best = { score: m.score, time: m.time, words: words };
          if (m.score >= strongThresh) return { time: m.time, score: m.score, words: words, found: true };
          return step();
        });
      }
      return step();
    }

    function finalize(mode, A0, scoreF, AN, scoreN) {
      var scale = (AN - A0) / (A.back.time - A.front.time);
      var offset = A0 - scale * A.front.time;
      var pMid = scale * A.mid.time + offset;
      var midWin = { start: Math.max(0, pMid - OPTS.midPad), dur: OPTS.midLen };
      return transcribeWindows([midWin]).then(function (mres) {
        var mWords = mres[0] ? mres[0].words : [];
        var mm = matchPhrase(mWords, A.mid.tokens, null);
        var nt = nearestWordTime(mWords, pMid);
        var textResid = (mm.time == null) ? Infinity : Math.abs(mm.time - pMid);
        var timeResid = (nt == null) ? Infinity : Math.abs(nt - pMid);
        var residual, scoreM, midTime;
        if (mode === 'text' && mm.score >= OPTS.matchThresh * 0.8 && textResid <= OPTS.residTol) {
          residual = textResid; scoreM = mm.score; midTime = mm.time;       // precise text mid
        } else {
          residual = timeResid; scoreM = (timeResid <= OPTS.residTol) ? OPTS.timingBoundScore : 0; midTime = nt;  // speech present near predicted mid
        }
        var base = (scoreF + scoreN + Math.max(0, scoreM)) / 3;
        var scPen = 1 - Math.min(1, Math.abs(scale - 1) / OPTS.scaleTol) * 0.3;
        var rsPen = 1 - Math.min(1, residual / OPTS.residTol) * 0.3;
        var score = Math.max(0, Math.min(1, base * scPen * rsPen));
        var thr = (mode === 'text') ? OPTS.matchThresh : OPTS.timingBoundScore * 0.9;
        var coherent = scoreF >= thr && scoreN >= thr &&
          Math.abs(scale - 1) <= OPTS.scaleTol && residual <= OPTS.residTol && scoreM > 0;
        return {
          coherent: coherent, score: score, mode: mode, offset: offset, scale: scale, residual: residual,
          duration: duration, anchors: A,
          matches: { front: { time: A0, score: scoreF }, back: { time: AN, score: scoreN }, mid: { time: midTime, predicted: pMid, score: scoreM } }
        };
      });
    }

    return seek(frontWins, A.front.tokens, 'first').then(function (fr) {
      return seek(backWins, A.back.tokens, 'last').then(function (br) {
        // front text-match is the same-language signal; pick precise times where
        // text matched, speech-boundary times otherwise (cross-language).
        var textLang = fr.found;
        var A0 = fr.found ? fr.time : firstWordStart(fr.words);
        var AN = br.found ? br.time : lastWordEnd(br.words);
        var sf = fr.found ? fr.score : OPTS.timingBoundScore;
        var sn = br.found ? br.score : OPTS.timingBoundScore;
        if (A0 == null || AN == null || AN <= A0) {
          return { coherent: false, score: Math.max(0, (fr.score + br.score) / 2 * 0.4), mode: 'none', reason: 'no-audio-speech', offset: 0, scale: 1, anchors: A, matches: { front: { time: fr.time, score: fr.score }, back: { time: br.time, score: br.score } } };
        }
        return finalize(textLang ? 'text' : 'timing', A0, sf, AN, sn);
      });
    });
  }

  function applySync(cues, t) {
    var scale = t.scale || 1, offset = t.offset || 0;
    var out = [];
    for (var i = 0; i < cues.length; i++) out.push({ start: scale * cues[i].start + offset, end: scale * cues[i].end + offset, text: cues[i].text });
    return out;
  }

  /* =========================================================================
   * WHISPER BINDING  — bind the pluggable engine to an audio source.
   * Returns transcribeWindows([{start,dur}]) -> Promise<[{words}]>.
   * =======================================================================*/
  function bindWhisper(ctx) {
    var W = root.WhisperEngine;
    var source = ctx && ctx.audioSource;
    // media element -> only usable if the engine can tap/decode it; prefer explicit source.
    return function (windows) {
      if (!W) return Promise.resolve(windows.map(function (w) { return { start: w.start, dur: w.dur, words: [] }; }));
      var src = source || (ctx && ctx.video) || null;
      return W.transcribeWindows(src, windows, ctx && ctx.whisperOpts || {});
    };
  }

  /* =========================================================================
   * CANDIDATE SOURCE  — reuse subs-standard's window.SubsSource when present,
   * else direct-fetch a Stremio subtitles addon.
   * =======================================================================*/
  function listCandidates(type, id, extra) {
    if (root.SubsSource && typeof root.SubsSource.list === 'function') {
      return Promise.resolve(root.SubsSource.list(type, id, extra)).then(function (a) { return a || []; });
    }
    // direct fetch: Stremio subtitles resource
    var base = OPTS.defaultSubUrl.replace(/\/$/, '');
    var url = base + '/subtitles/' + encodeURIComponent(type || 'movie') + '/' + encodeURIComponent(id) +
      (extra ? '/' + extra : '') + '.json';
    return fetchJSON(url).then(function (j) {
      var subs = (j && j.subtitles) || [];
      return subs.map(function (s) { return { id: s.id, url: s.url, lang: (s.lang || s.language || '').toLowerCase(), label: s.label }; });
    })['catch'](function () { return []; });
  }

  function fetchJSON(url, signal) {
    return fetch(url, { signal: signal }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }
  function fetchText(url, signal) {
    return fetch(url, { signal: signal, cache: 'force-cache' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });
  }

  // in-memory cache: itemKey -> { candidates, byLang:{lang:{text,cues}} }
  var CACHE = {};
  function itemKey(type, id, season, episode) {
    return (type || 'movie') + ':' + id + (season != null ? ':s' + season : '') + (episode != null ? ':e' + episode : '');
  }
  function seriesExtra(id, season, episode) {
    // Stremio series id form: <imdb>:<season>:<episode>
    if (season != null && episode != null && String(id).indexOf(':') < 0) return id + ':' + season + ':' + episode;
    return id;
  }

  /* =========================================================================
   * STATE / OBSERVABILITY
   * =======================================================================*/
  var STATE = { phase: 'idle', lang: null, item: null, candidates: [], active: null, queue: [], whisper: null, log: [] };
  var STATE_LISTENERS = [];
  function onState(cb) { if (typeof cb === 'function') { STATE_LISTENERS.push(cb); try { cb(snapshot()); } catch (e) {} } }
  function snapshot() {
    return {
      phase: STATE.phase, lang: STATE.lang, item: STATE.item,
      candidates: STATE.candidates.slice(), active: STATE.active,
      queue: QUEUE.list(), whisper: (root.WhisperEngine ? root.WhisperEngine.stats() : null),
      /* where the audio came from and how many windows we let ourselves spend —
         the two numbers that explain WHY a sync did or did not happen */
      audioSource: STATE.audioSource || null, budget: STATE.budget || null,
      log: STATE.log.slice(-40)
    };
  }
  function pushState(patch) {
    if (patch) for (var k in patch) STATE[k] = patch[k];
    var snap = snapshot();
    for (var i = 0; i < STATE_LISTENERS.length; i++) { try { STATE_LISTENERS[i](snap); } catch (e) {} }
    if (HAS_DOM) Panel.render(snap);
  }
  function logLine(s) { STATE.log.push({ t: Date.now(), s: s }); if (STATE.log.length > 200) STATE.log.shift(); }

  /* =========================================================================
   * HARVEST QUEUE  — one active fetch, priority front, instant pause+switch.
   * =======================================================================*/
  var QUEUE = (function () {
    var items = [];        // [{key, task, priority}]
    var active = null;     // {key, controller}
    var running = false;

    function list() { return items.map(function (x) { return { key: x.key, priority: x.priority }; }).concat(active ? [{ key: active.key, priority: 'active' }] : []); }

    function enqueue(key, task, priority) {
      for (var i = 0; i < items.length; i++) if (items[i].key === key) { items[i].priority = Math.max(items[i].priority, priority || 0); return pump(); }
      items.push({ key: key, task: task, priority: priority || 0 });
      pump();
    }

    function pump() {
      if (running || !items.length) { pushState(); return; }
      items.sort(function (a, b) { return b.priority - a.priority; });
      var it = items.shift();
      running = true;
      var controller = (typeof AbortController !== 'undefined') ? new AbortController() : { signal: undefined, abort: function () {} };
      active = { key: it.key, controller: controller };
      pushState({});
      Promise.resolve(it.task(controller.signal)).then(function () {}, function () {})['then'](function () {
        running = false; active = null; pump();
      });
    }

    function pauseAndSwitch(key, task, priority) {
      // abort the in-flight fetch instantly and jump to the new selection
      if (active && active.key !== key) { try { active.controller.abort(); } catch (e) {} active = null; running = false; }
      // drop stale queued items of lower priority (keep other high items)
      enqueue(key, task, (priority || 100));
    }

    function clear() { for (var i = 0; i < items.length; i++) {} items = []; if (active) { try { active.controller.abort(); } catch (e) {} active = null; } running = false; }

    return { enqueue: enqueue, pauseAndSwitch: pauseAndSwitch, list: list, clear: clear, activeKey: function () { return active && active.key; } };
  })();

  // Fetch + cache the candidate list, and prefetch the preferred lang's text.
  function harvestTask(type, id, season, episode, preferLang) {
    var key = itemKey(type, id, season, episode);
    var xid = seriesExtra(id, season, episode);
    return function (signal) {
      logLine('harvest ' + key);
      var slot = CACHE[key] || (CACHE[key] = { candidates: null, byLang: {} });
      var p = slot.candidates ? Promise.resolve(slot.candidates) : listCandidates(type, xid).then(function (c) { slot.candidates = c; return c; });
      return p.then(function (cands) {
        if (signal && signal.aborted) return;
        pushState({ item: key });
        var lang = preferLang || (getConfig().lang) || 'eng';
        var forLang = cands.filter(function (c) { return c.lang === lang; });
        var first = forLang[0] || cands[0];
        if (!first || slot.byLang[first.lang]) return;
        return fetchText(first.url, signal).then(function (txt) {
          if (signal && signal.aborted) return;
          slot.byLang[first.lang] = { text: txt, cues: parseCues(txt), from: first };
          logLine('prefetched ' + first.lang + ' ' + (slot.byLang[first.lang].cues.length) + ' cues');
          pushState();
        })['catch'](function () {});
      });
    };
  }

  var Harvest = {
    // Called when an item detail opens (poster click). Movies: harvest now.
    // Series: harvest the CURRENTLY selected season/episode first.
    start: function (type, id, season, episode) {
      var key = itemKey(type, id, season, episode);
      QUEUE.enqueue(key, harvestTask(type, id, season, episode), 50);
      pushState({ item: key });
    },
    // Season/episode navigation: instantly pause current + switch to the new one.
    focus: function (type, id, season, episode) {
      var key = itemKey(type, id, season, episode);
      if (QUEUE.activeKey() === key) return;
      QUEUE.pauseAndSwitch(key, harvestTask(type, id, season, episode), 100);
      logLine('focus->' + key + ' (pause+switch)');
      pushState({ item: key });
    },
    cache: function () { return CACHE; },
    get: function (type, id, season, episode) { return CACHE[itemKey(type, id, season, episode)]; }
  };

  /* =========================================================================
   * SYNC ORCHESTRATION  — the UX flow (available -> coherent hotswap -> resync)
   * =======================================================================*/
  // sync(video, candidates, ctx) -> Promise<result>
  // ctx = {type,id,season,episode,lang?,mode?,audioSource?,onUpdate?}
  function sync(video, candidates, ctx) {
    ctx = ctx || {};
    var lang = ctx.lang || getConfig().lang || 'eng';
    var onUpdate = typeof ctx.onUpdate === 'function' ? ctx.onUpdate : function () {};
    var transcribe = bindWhisper({ audioSource: ctx.audioSource, video: video, whisperOpts: ctx.whisperOpts });
    // Window providers (torrent / HLS) declare their own cost; ctx.budget can override.
    var budget = ctx.budget ||
      ((ctx.audioSource && ctx.audioSource.cost === 'costly') ? OPTS.costlyBudget : {});
    STATE.budget = budget;
    STATE.audioSource = (ctx.audioSource && (ctx.audioSource.name || (ctx.audioSource.url ? 'url' : 'source'))) || (video ? 'media-element' : null);
    var slot = null;
    if (ctx.type != null) slot = CACHE[itemKey(ctx.type, ctx.id, ctx.season, ctx.episode)];

    pushState({ phase: 'resolving', lang: lang });

    // 1) resolve candidate list
    var listP;
    if (candidates && candidates.length) listP = Promise.resolve(candidates);
    else if (slot && slot.candidates) listP = Promise.resolve(slot.candidates);
    else listP = listCandidates(ctx.type || 'movie', seriesExtra(ctx.id, ctx.season, ctx.episode));

    return listP.then(function (all) {
      all = all || [];
      var forLang = all.filter(function (c) { return (c.lang || '').toLowerCase() === lang; });
      if (!forLang.length) forLang = all.slice(0, 1);   // graceful: something over nothing
      STATE.candidates = forLang.map(function (c) { return { id: c.id, lang: c.lang, score: null, coherent: null }; });
      pushState({ phase: 'available' });

      if (!forLang.length) return { ok: false, reason: 'no-candidates', cues: [] };

      // 2) STEP (a): show whatever is available IMMEDIATELY (raw), no wait.
      return loadCues(forLang[0], slot, lang).then(function (firstCues) {
        var available = { ok: true, phase: 'available', coherent: false, score: null, offset: 0, offsetMs: 0, scale: 1, candidate: forLang[0], cues: firstCues, url: vttURL(firstCues) };
        STATE.active = { id: forLang[0].id, lang: lang, phase: 'available', offset: 0, scale: 1 };
        pushState();
        onUpdate(available);

        // 2b) fast autosync on the shown candidate (front-anchor offset), then
        //     full lazy coherence across candidates -> hotswap the best coherent.
        var quick = null;   // the front-anchor-only result, kept as the fallback
        var quickP = quickSync(transcribe, firstCues).then(function (q) {
          if (q) {
            var qc = applySync(firstCues, q);
            var qr = { ok: true, phase: 'quick-synced', coherent: false, score: q.score, offset: q.offset, offsetMs: Math.round(q.offset * 1000), scale: 1, candidate: forLang[0], cues: qc, url: vttURL(qc) };
            quick = qr;
            STATE.active = { id: forLang[0].id, lang: lang, phase: 'quick-synced', offset: q.offset, scale: 1 };
            pushState(); onUpdate(qr);
          }
        })['catch'](function () {});

        return quickP.then(function () {
          return selectCoherent(transcribe, forLang, slot, lang, budget).then(function (winner) {
            if (!winner) {
              // Nothing coherent. The QUICK front-anchor offset is still a real,
              // measured result — return it rather than the unsynced cues, so a
              // costly stream source (torrent/HLS) that only affords one window
              // still delivers a usable sync. Falls back to raw when there is none.
              pushState({ phase: quick ? 'quick-synced' : 'available' });
              return quick || available;
            }
            var synced = applySync(winner.cues, { offset: winner.offset, scale: winner.scale });
            var result = {
              ok: true, phase: 'coherent', coherent: winner.coherent, score: winner.score,
              offset: winner.offset, offsetMs: Math.round(winner.offset * 1000), scale: winner.scale,
              candidate: winner.cand, cues: synced, url: vttURL(synced),
              meta: { anchors: winner.res.anchors, matches: winner.res.matches, perCandidate: STATE.candidates.slice() }
            };
            STATE.active = { id: winner.cand.id, lang: lang, phase: 'coherent', offset: winner.offset, scale: winner.scale, score: winner.score, coherent: winner.coherent };
            pushState({ phase: 'coherent' });
            onUpdate(result);              // (c) hotswap to coherent + fine-synced
            maybeSelfAttach(video, result);
            return result;
          });
        });
      });
    })['catch'](function (e) {
      logLine('sync error ' + (e && e.message)); pushState({ phase: 'error' });
      return { ok: false, reason: (e && e.message) || 'error', cues: [] };
    });
  }

  function loadCues(cand, slot, lang) {
    if (slot && slot.byLang[lang] && slot.byLang[lang].from && slot.byLang[lang].from.id === cand.id) return Promise.resolve(slot.byLang[lang].cues);
    if (cand._cues) return Promise.resolve(cand._cues);
    return fetchText(cand.url).then(function (txt) { var c = parseCues(txt); cand._cues = c; return c; });
  }

  // front-anchor-only offset estimate (one whisper window) — fast + cheap.
  function quickSync(transcribe, cues) {
    var A = buildAnchors(cues);
    if (A.front.time == null) return Promise.resolve(null);
    var win = { start: Math.max(0, A.front.time - OPTS.frontPad), dur: OPTS.frontLen };
    return transcribe([win]).then(function (res) {
      var w = res[0] ? res[0].words : [];
      var f = matchPhrase(w, A.front.tokens, 'first');
      if (f.time == null || f.score < OPTS.matchThresh) return null;
      return { offset: f.time - A.front.time, scale: 1, score: f.score };
    });
  }

  // LAZY: first coherent candidate wins; else best-scoring as graceful fallback.
  function selectCoherent(transcribe, cands, slot, lang, budget) {
    var best = null;
    var idx = 0;
    budget = budget || {};
    if (budget.maxCandidates > 0 && cands.length > budget.maxCandidates) cands = cands.slice(0, budget.maxCandidates);
    function step() {
      if (idx >= cands.length) return Promise.resolve(best);
      var cand = cands[idx++];
      return loadCues(cand, slot, lang).then(function (cues) {
        return locate(transcribe, cues, { budget: budget }).then(function (res) {
          var entry = { id: cand.id, lang: cand.lang, score: +res.score.toFixed ? +res.score.toFixed(3) : res.score, coherent: res.coherent, offset: res.offset, scale: res.scale };
          // update observability row
          for (var s = 0; s < STATE.candidates.length; s++) if (STATE.candidates[s].id === cand.id) STATE.candidates[s] = entry;
          pushState();
          var w = { cand: cand, cues: cues, offset: res.offset, scale: res.scale, score: res.score, coherent: res.coherent, res: res };
          if (res.coherent) { logLine('COHERENT ' + cand.lang + ' #' + cand.id + ' score=' + res.score.toFixed(2)); return w; }  // lazy stop
          if (!best || res.score > best.score) best = w;
          return step();
        });
      })['catch'](function () { return step(); });
    }
    return step();
  }

  // Blob VTT URL (kept small; revoked opportunistically)
  var BLOBS = [];
  function vttURL(cues) {
    if (!HAS_DOM || typeof URL === 'undefined' || !URL.createObjectURL) return null;
    try {
      var u = URL.createObjectURL(new Blob([toVTT(cues)], { type: 'text/vtt' }));
      BLOBS.push(u); if (BLOBS.length > 12) { try { URL.revokeObjectURL(BLOBS.shift()); } catch (e) {} }
      return u;
    } catch (e) { return null; }
  }

  /* =========================================================================
   * SELF-ATTACH FALLBACK  — only when subs-standard's renderer is absent.
   * =======================================================================*/
  function maybeSelfAttach(video, result) {
    if (!HAS_DOM || !video) return;
    if (root.__subsRendererPresent) return;              // their renderer owns it
    if (!result || !result.url) return;
    try {
      // remove our previous track
      if (video.__sasTrack && video.__sasTrack.parentNode) video.__sasTrack.parentNode.removeChild(video.__sasTrack);
      var tr = document.createElement('track');
      tr.kind = 'subtitles'; tr.srclang = (result.candidate && result.candidate.lang || 'en').slice(0, 8);
      tr.label = 'Auto-sync ' + (result.candidate && result.candidate.lang || '');
      tr.src = result.url; tr['default'] = true;
      video.appendChild(tr);
      video.__sasTrack = tr;
      var show = function () { try { var tt = video.textTracks; for (var i = 0; i < tt.length; i++) tt[i].mode = (tt[i] === tr.track) ? 'showing' : 'disabled'; } catch (e) {} };
      tr.addEventListener('load', show); setTimeout(show, 120);
    } catch (e) { logLine('selfattach fail ' + e.message); }
  }

  /* =========================================================================
   * CONFIG  (localStorage, MERGE — we only own {mode,lang})
   * =======================================================================*/
  function getConfig() {
    var d = { mode: 'off', lang: 'eng' };
    if (!HAS_DOM || typeof localStorage === 'undefined') return d;
    try { var raw = localStorage.getItem(CFG_KEY); if (!raw) return d; var o = JSON.parse(raw); return { mode: o.mode || 'off', lang: o.lang || 'eng', _all: o }; }
    catch (e) { return d; }
  }
  function setConfig(patch) {
    if (!HAS_DOM || typeof localStorage === 'undefined') return;
    var cur = {};
    try { cur = JSON.parse(localStorage.getItem(CFG_KEY) || '{}') || {}; } catch (e) { cur = {}; }
    if (patch) for (var k in patch) cur[k] = patch[k];   // MERGE — never clobber style fields
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cur)); } catch (e) {}
    pushState({ lang: cur.lang || STATE.lang });
    return cur;
  }

  /* =========================================================================
   * PLAYER + DETAIL INTEGRATION  (decoupled: wrap Player.play, watch the hash)
   * =======================================================================*/
  function integrate() {
    if (!HAS_DOM) return;

    // (4) Harvest on poster click: the detail route opens on poster select.
    function onHash() {
      var h = (location.hash || '').replace(/^#/, '');
      var m = /^detail\/([^/]+)\/(.+)$/.exec(h);
      if (m) {
        var type = decodeURIComponent(m[1]), id = decodeURIComponent(m[2]);
        // series ids may already carry :season:episode
        var parts = id.split(':');
        if (parts.length >= 3) Harvest.start(type, parts[0], parts[1], parts[2]);
        else Harvest.start(type, id);
      }
    }
    try { window.addEventListener('hashchange', onHash); onHash(); } catch (e) {}

    // Season/episode navigation -> instant pause+switch. Detect selection in the
    // detail DOM without editing app.js: listen for clicks on the pickers.
    function wireDetailNav() {
      var seasons = document.getElementById('d-seasons');
      var eps = document.getElementById('d-episodes');
      var curType = null, curId = null, curSeason = null;
      function ctxFromHash() {
        var h = (location.hash || '').replace(/^#/, ''); var m = /^detail\/([^/]+)\/(.+)$/.exec(h);
        if (!m) return null; var id = decodeURIComponent(m[2]).split(':')[0]; return { type: decodeURIComponent(m[1]), id: id };
      }
      // Season pills are `<button class="pill" role="tab">Season N</button>` /
      // "Specials" (season 0) — no data-attr, so read the label. "Specials" -> 0.
      if (seasons) seasons.addEventListener('click', function (e) {
        var b = e.target.closest && e.target.closest('.pill,[role=tab],button'); if (!b) return;
        var c = ctxFromHash(); if (!c) return; curType = c.type; curId = c.id;
        var label = (b.getAttribute('data-season') || b.textContent || '');
        curSeason = /special/i.test(label) ? '0' : ((label.replace(/[^\d]/g, '')) || curSeason || '1');
        // switch harvest to the newly selected season (episode 1 as best-guess imminent play)
        Harvest.focus(curType, curId, curSeason, 1);
      });
      // Episode rows are `<button class="ep"><span class="ep-n">S×EE</span>…</button>`
      // — the "2×01" label in .ep-n carries BOTH season and episode; no data-attr.
      if (eps) eps.addEventListener('click', function (e) {
        var b = e.target.closest && e.target.closest('.ep,.ep-item,button,li,a'); if (!b) return;
        var c = ctxFromHash(); if (!c) return; curType = c.type; curId = c.id;
        var se = '', ep = '';
        var enEl = b.querySelector && b.querySelector('.ep-n');
        var enTxt = (enEl && enEl.textContent) || '';
        var mm = /(\d+)\s*[x×*]\s*(\d+)/i.exec(enTxt);       // "2×01"
        if (mm) { se = mm[1]; ep = mm[2].replace(/^0+(?=\d)/, ''); }
        if (!ep) ep = (b.getAttribute('data-episode') || b.getAttribute('data-ep') || '').replace(/[^\d]/g, '');
        if (!se) se = (b.getAttribute('data-season') || curSeason || '1').replace(/[^\d]/g, '');
        if (ep) Harvest.focus(curType, curId, se || '1', ep);
      });
    }
    if (document.readyState !== 'loading') wireDetailNav();
    else document.addEventListener('DOMContentLoaded', wireDetailNav);

    // Wrap Player.play so that when a real stream opens we can auto-apply the
    // last-used language (config), feeding synced cues to whoever renders.
    function wrapPlayer() {
      if (!root.Player || root.Player.__sasWrapped) return false;
      var orig = root.Player.play;
      root.Player.play = function (opts) {
        var r = orig.apply(this, arguments);
        try { onPlay(opts); } catch (e) { logLine('onPlay err ' + e.message); }
        return r;
      };
      root.Player.__sasWrapped = true;
      return true;
    }
    if (!wrapPlayer()) {
      var tries = 0, iv = setInterval(function () { if (wrapPlayer() || ++tries > 40) clearInterval(iv); }, 150);
    }
  }

  function findMainVideo() {
    if (!HAS_DOM) return null;
    var roots = document.querySelectorAll('.plr-root');
    for (var i = roots.length - 1; i >= 0; i--) { var v = roots[i].querySelector(':scope > video') || roots[i].querySelector('video'); if (v) return v; }
    return null;
  }

  function onPlay(opts) {
    // If a HOST (e.g. player.js) drives auto-sync itself and delivers cues to its
    // own renderer, we must NOT also fire a sync here — that would run whisper
    // twice per play. The host owns it; we only keep the harvest/queue + panel.
    if (root.__subsHostDriven) return;
    var cfg = getConfig();
    STATE.active = null; STATE.candidates = [];
    pushState({ phase: 'play', lang: cfg.lang });
    if (cfg.mode === 'off') { pushState({ phase: 'idle' }); return; }   // respect "off"
    var meta = (opts && opts.meta) || {};
    var type = meta.type || 'movie';
    var id = meta.id || (opts && opts.stream && opts.stream.imdb) || null;
    if (!id) { logLine('onPlay: no id, skip autosync'); return; }
    var video = (opts && opts.video && opts.video.nodeName === 'VIDEO') ? opts.video : null;
    // give the overlay a beat to create its <video>, then locate + sync
    setTimeout(function () {
      var v = video || findMainVideo();
      var audioSource = (opts && opts.stream && opts.stream.audioSource) || (opts && opts.audioSource) || null;
      // If the stream carries a decodable file URL, use it for whisper audio.
      if (!audioSource && opts && opts.stream && opts.stream.url && !/^magnet:/i.test(opts.stream.url)) audioSource = { url: opts.stream.url };
      sync(v, null, { type: type, id: id, lang: cfg.lang, mode: cfg.mode, audioSource: audioSource, video: v });
    }, 250);
  }

  /* =========================================================================
   * SUBS LAB PANEL  — compact, observable, adjustable (Shift+L to toggle)
   * =======================================================================*/
  var Panel = (function () {
    var el = null, body = null, open = false, last = null;
    function ensure() {
      if (el || !HAS_DOM) return;
      el = document.createElement('div');
      el.id = 'subs-lab';
      el.setAttribute('style', 'position:fixed;right:12px;bottom:12px;z-index:99999;width:340px;max-height:70vh;overflow:auto;background:rgba(12,12,16,.94);color:#e8e8ee;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid #c21860;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.5);display:none');
      el.innerHTML = '<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #2a2a33;position:sticky;top:0;background:inherit">'
        + '<b style="color:#f5387b">SUBS&nbsp;LAB</b><span id="sl-phase" style="opacity:.8"></span>'
        + '<span style="flex:1"></span>'
        + '<button id="sl-resync" title="force resync" style="background:#c21860;color:#fff;border:0;border-radius:5px;padding:2px 7px;cursor:pointer">resync</button>'
        + '<button id="sl-x" style="background:#2a2a33;color:#ccc;border:0;border-radius:5px;padding:2px 7px;cursor:pointer">×</button></div>'
        + '<div id="sl-body" style="padding:8px 10px"></div>';
      document.body.appendChild(el);
      body = el.querySelector('#sl-body');
      el.querySelector('#sl-x').addEventListener('click', function () { toggle(false); });
      el.querySelector('#sl-resync').addEventListener('click', function () {
        var v = findMainVideo(); var cfg = getConfig();
        if (v) sync(v, null, { type: (STATE.item || '').split(':')[0] || 'movie', id: (STATE.item || '').split(':')[1], lang: cfg.lang, mode: 'lang' });
      });
      try {
        window.addEventListener('keydown', function (e) { if (e.shiftKey && (e.key === 'L' || e.key === 'l')) { e.preventDefault(); toggle(); } });
      } catch (e) {}
    }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
    function bar(v) { var p = Math.max(0, Math.min(1, v || 0)); return '<span style="display:inline-block;width:46px;height:6px;background:#2a2a33;border-radius:3px;vertical-align:middle;overflow:hidden"><span style="display:block;height:100%;width:' + (p * 100).toFixed(0) + '%;background:' + (p >= 0.5 ? '#38d17a' : '#d1a238') + '"></span></span>'; }
    function render(snap) {
      last = snap; if (!open || !body) return;
      var w = snap.whisper || {};
      var h = '';
      h += '<div style="margin-bottom:6px">whisper: <b>' + esc(w.name || '—') + '</b> <span style="opacity:.6">[' + esc(w.backend || '?') + ']</span> · calls ' + (w.calls || 0) + ' · ' + (w.ms || 0) + 'ms · words ' + (w.words || 0) + '</div>';
      h += '<div style="margin-bottom:6px">item: <b>' + esc(snap.item || '—') + '</b> · lang <b>' + esc(snap.lang || '—') + '</b> · phase <b style="color:#f5387b">' + esc(snap.phase) + '</b></div>';
      if (snap.active) h += '<div style="margin-bottom:6px;padding:5px 7px;background:#181820;border-radius:6px">active #' + esc(snap.active.id) + ' · ' + esc(snap.active.phase) + '<br>offset <b>' + fmtMs(snap.active.offset) + '</b> · scale <b>' + (snap.active.scale != null ? snap.active.scale.toFixed(4) : '—') + '</b>' + (snap.active.coherent != null ? ' · ' + (snap.active.coherent ? '<span style="color:#38d17a">COHERENT</span>' : '<span style="color:#d1a238">best-effort</span>') : '') + '</div>';
      h += '<div style="opacity:.7;margin:8px 0 3px">candidates</div>';
      if (!snap.candidates.length) h += '<div style="opacity:.5">—</div>';
      for (var i = 0; i < snap.candidates.length; i++) {
        var c = snap.candidates[i];
        h += '<div style="display:flex;gap:6px;align-items:center;padding:2px 0">' + bar(c.score) + '<span style="width:40px">' + (c.score == null ? '·' : (c.score * 100).toFixed(0) + '%') + '</span><span style="opacity:.8">' + esc(c.lang) + '</span><span style="opacity:.5">#' + esc(c.id) + '</span>' + (c.coherent ? '<span style="color:#38d17a">✓</span>' : (c.coherent === false ? '<span style="opacity:.4">·</span>' : '')) + '</div>';
      }
      h += '<div style="opacity:.7;margin:8px 0 3px">queue</div><div style="opacity:.8">' + (snap.queue.length ? snap.queue.map(function (q) { return esc(q.key) + (q.priority === 'active' ? ' <span style="color:#f5387b">▶</span>' : ''); }).join('<br>') : '—') + '</div>';
      h += '<div style="opacity:.7;margin:8px 0 3px">log</div><div style="opacity:.6;font-size:10px">' + snap.log.slice(-8).map(function (l) { return esc(l.s); }).join('<br>') + '</div>';
      body.innerHTML = h;
      var ph = el.querySelector('#sl-phase'); if (ph) ph.textContent = snap.phase;
    }
    function fmtMs(x) { if (x == null) return '—'; return (x >= 0 ? '+' : '') + (x * 1000).toFixed(0) + 'ms'; }
    function toggle(force) { ensure(); open = (force == null ? !open : !!force); if (el) el.style.display = open ? 'block' : 'none'; if (open) render(last || snapshot()); }
    return { render: render, toggle: toggle, ensure: ensure };
  })();

  /* =========================================================================
   * PUBLIC API
   * =======================================================================*/
  var SubsAutoSync = {
    // pure algorithm (testable)
    parseSRT: parseSRT, parseVTT: parseVTT, parseCues: parseCues, toVTT: toVTT,
    normTokens: normTokens, isJunk: isJunk, similarity: similarity, matchPhrase: matchPhrase,
    buildAnchors: buildAnchors, locate: locate, applySync: applySync,
    // orchestration
    sync: sync, selectCoherent: selectCoherent, quickSync: quickSync,
    listCandidates: listCandidates,
    harvest: Harvest, queue: QUEUE,
    // config
    config: { get: getConfig, set: setConfig, key: CFG_KEY },
    // observability
    onState: onState, state: snapshot, panel: Panel, opts: OPTS,
    // manual controls
    setLang: function (lang) { setConfig({ mode: 'lang', lang: lang }); },
    off: function () { setConfig({ mode: 'off' }); },
    version: '1.0.0'
  };

  root.SubsAutoSync = SubsAutoSync;
  if (typeof module !== 'undefined' && module.exports) module.exports = SubsAutoSync;
  if (HAS_DOM) integrate();

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this),
   typeof document !== 'undefined' ? document : null);
