"use strict";
/* =========================================================================
   WallView — reusable canvas-2D wall engine.
   Extracted from cooliris/wall/index.html (variant B) with the FEEL intact:
     tween renderer (critically-damped) + stagger · free drag pan at every
     zoom (no clamp, no resistance) + inertia · cursor-anchored wheel zoom to
     ZOOM_MAX 400 · persAmt() perspective/shear fade above zoom 1.4 ·
     deltaX two-finger scroll · dirty-flag rAF (zero idle cost) ·
     thumb -> hi-res ladder with decode() crossfade · layouts as pure
     functions · reflections · chrome (arrows, scrubber, pills, rows, order).

   Adapted for poster tiles: every item carries its own aspect; the cell
   contains the image, never crops.  Multiple instances per page: all state
   lives on the instance, nothing global except the class itself.

     var wv = new WallView(canvasEl, { brand: "cooliris", cellH: 240 });
     wv.setItems([{ id, title, poster, thumb?, aspect? }, ...]);
     wv.onSelect(function (item, index) { ... });   // fires AFTER the fly-to
     wv.layout("hero"); wv.setRows(2); wv.focusIndex(3); wv.destroy();

   Vanilla JS, no modules, no build step, zero dependencies.
   ========================================================================= */
(function (global) {

/* ---------------------------------------------------------------- consts */
var CHROME_H = 56;
var FOCAL = 1400, PERSP_K = 0.14, SHEAR_K = 0.10;
var MAX_LOADS = 6;
var HIRES_CAP = 8;

var C_TRACK   = "#1b1b1d";
/* one accent, all the way through: honestporn is pink, so no chrome element
   is allowed to keep a stray blue from the CoolStremio lineage */
var C_THUMB_A = "#f5387b", C_THUMB_B = "#a81b52";
var C_ACCENT_ON = "rgba(245,56,123,0.85)";
var C_STROKE  = "#cfd2d6";
var FONT = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif';

var REDUCED = false;
try { REDUCED = global.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function easeOutCubic(t) { var u = 1 - t; return 1 - u * u * u; }
function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
function easeOutQuart(t) { var u = 1 - t; return 1 - u * u * u * u; }

/* ==================================================================== */
/*  LANE BADGES — provenance chrome drawn INSIDE the canvas.            */
/*                                                                      */
/*  honestporn's product IS the trust layer, so an item's lane has to   */
/*  live on the tile itself — not in a DOM overlay that the wall's own  */
/*  zoom/pan/shear would desynchronise, and that a screenshot of the    */
/*  canvas would silently lose.                                         */
/*                                                                      */
/*  Three rules make it free:                                           */
/*   1. Chips are drawn in SCREEN space, anchored to the tile's         */
/*      projected top-left corner — never scaled, never sheared, so a   */
/*      chip reads identically at zoom 0.35 and at zoom 400.            */
/*   2. Each (lane, integer height, dpr, mode) chip is rasterised ONCE  */
/*      into a tiny offscreen canvas and blitted 1:1 device-pixel —     */
/*      crisp at any DPR, and the render loop does zero text shaping.   */
/*   3. Nothing here starts an animation except a visible LIVE chip,    */
/*      which is gated + frame-throttled, so the dirty-flag idle-zero   */
/*      discipline survives intact (and REDUCED kills the pulse dead).  */
/* ==================================================================== */

var LANES = {
  "ai-generated":       { color: "#8b7cff", label: "AI",       glyph: glyphAI },
  "performer-verified": { color: "#2fd18b", label: "VERIFIED", glyph: glyphVerified },
  "demo":               { color: "#f0a83c", label: "DEMO",     glyph: glyphFlask }
};
/* registry.js prefixes titles with these; we read the lane from the data when
   it is there and fall back to the glyph only if it is not. */
var LANE_BY_EMOJI = [
  ["🤖", "ai-generated"],        /* 🤖 */
  ["✅",       "performer-verified"],  /* ✅ */
  ["🧪", "demo"]                 /* 🧪 */
];
var LIVE_COLOR  = "#f5387b";               /* brand pink — live is the loudest state */
var HLS_COLOR   = "#9fb4c7";
var SCRIM       = "rgba(9,9,12,0.74)";     /* legible over bright AND dark posters */
var SCRIM_SOLID = "rgba(9,9,12,0.96)";     /* knockouts inside a chip */

/* chip metrics, all derived from one number: the chip height in CSS px */
var CHIP_MIN = 9;      /* below this a chip is unreadable -> fade out entirely */
var CHIP_FADE = 12;    /* fully opaque at/above this */
var CHIP_MAX = 44;     /* above this it stops growing and becomes a sticker */
var CHIP_LABEL_MIN = 17; /* below this the label drops, glyph-only dot remains */

function laneOf(s) {
  if (!s) return null;
  for (var i = 0; i < LANE_BY_EMOJI.length; i++) if (s.indexOf(LANE_BY_EMOJI[i][0]) === 0) return LANE_BY_EMOJI[i][1];
  return null;
}

/* display-only: the caption should not repeat what the chip already says.
   NEVER written back to the item — the registry's words stay the registry's. */
function stripLanePrefix(s) {
  if (!s) return s;
  for (var i = 0; i < LANE_BY_EMOJI.length; i++) {
    var e = LANE_BY_EMOJI[i][0];
    if (s.indexOf(e) === 0) return s.slice(e.length).replace(/^[\s   ·|:\-–—]+/, "");
  }
  return s;
}

/* Read the badge off an item without app.js having to do anything: registry
   rows carry lane/hls/live flat, a nested {meta:{...}} shape works too, and a
   title that only has the emoji prefix still resolves. */
function badgeOf(it) {
  if (!it) return null;
  var m = (it.meta && typeof it.meta === "object") ? it.meta : it;
  var lane = it.lane || m.lane || laneOf(it.title) || laneOf(it.name) || null;
  if (!LANES[lane]) lane = null;
  var hls  = !!(it.hls  != null ? it.hls  : m.hls);
  var live = !!(it.live != null ? it.live : m.live);
  if (!lane && !hls && !live) return null;
  return { lane: lane, hls: hls, live: live };
}

function rr(g, x, y, w, h, r) {
  if (r > w / 2) r = w / 2;
  if (r > h / 2) r = h / 2;
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/* ---- glyphs: pure recipes in a 0..s box, so one drawing serves every size.
   Vector, not emoji: system emoji go muddy under 14px and change shape per
   platform — the lane mark has to be the same mark everywhere it appears. */

/* AI — a sparkle pair: "made, not filmed". Reads as generation, not as a robot
   face, which turns to mush at 10px. */
function glyphAI(g, s) {
  function star(cx, cy, r) {
    var k = r * 0.17;
    g.beginPath();
    g.moveTo(cx, cy - r);
    g.quadraticCurveTo(cx + k, cy - k, cx + r, cy);
    g.quadraticCurveTo(cx + k, cy + k, cx, cy + r);
    g.quadraticCurveTo(cx - k, cy + k, cx - r, cy);
    g.quadraticCurveTo(cx - k, cy - k, cx, cy - r);
    g.closePath();
    g.fill();
  }
  star(s * 0.40, s * 0.40, s * 0.38);
  star(s * 0.79, s * 0.77, s * 0.20);
}

/* PERFORMER-VERIFIED — a shield with the check knocked out of it. A bare tick
   means "ok"; a shield means someone is protected, which is the actual claim. */
function glyphVerified(g, s) {
  g.beginPath();
  g.moveTo(s * 0.50, s * 0.05);
  g.lineTo(s * 0.91, s * 0.21);
  g.lineTo(s * 0.91, s * 0.52);
  g.quadraticCurveTo(s * 0.91, s * 0.83, s * 0.50, s * 0.97);
  g.quadraticCurveTo(s * 0.09, s * 0.83, s * 0.09, s * 0.52);
  g.lineTo(s * 0.09, s * 0.21);
  g.closePath();
  g.fill();
  var lw = Math.max(1.1, s * 0.15);
  g.save();
  g.strokeStyle = SCRIM_SOLID;
  g.lineWidth = lw; g.lineCap = "round"; g.lineJoin = "round";
  g.beginPath();
  g.moveTo(s * 0.29, s * 0.49);
  g.lineTo(s * 0.44, s * 0.65);
  g.lineTo(s * 0.73, s * 0.33);
  g.stroke();
  g.restore();
}

/* DEMO — a flask. Says "test source, not the real supply lane" in one shape. */
function glyphFlask(g, s) {
  g.save();
  g.lineCap = "round"; g.lineJoin = "round";
  g.beginPath();
  g.moveTo(s * 0.43, s * 0.10);
  g.lineTo(s * 0.43, s * 0.40);
  g.lineTo(s * 0.15, s * 0.82);
  g.quadraticCurveTo(s * 0.08, s * 0.95, s * 0.23, s * 0.95);
  g.lineTo(s * 0.77, s * 0.95);
  g.quadraticCurveTo(s * 0.92, s * 0.95, s * 0.85, s * 0.82);
  g.lineTo(s * 0.57, s * 0.40);
  g.lineTo(s * 0.57, s * 0.10);
  g.closePath();
  g.fill();
  g.strokeStyle = g.fillStyle;
  g.lineWidth = Math.max(1, s * 0.13);
  g.beginPath();
  g.moveTo(s * 0.35, s * 0.08);
  g.lineTo(s * 0.65, s * 0.08);
  g.stroke();
  g.restore();
}

/* HLS — a three-step bitrate ladder. "This is a stream, and it adapts." */
function glyphHls(g, s) {
  var bw = s * 0.20, gap = s * 0.10;
  var hs = [0.44, 0.70, 1.0];
  for (var i = 0; i < 3; i++) {
    var h = s * hs[i] * 0.92;
    rr(g, i * (bw + gap), s * 0.96 - h, bw, h, Math.min(bw / 2, s * 0.08));
    g.fill();
  }
}

/* ---- chip atlas ------------------------------------------------------- */
/* key -> {c: canvas, w, h}. Shared across WallView instances: two walls on one
   page draw the same chips. Bounded LRU so a long zoom sweep can't grow it. */
var chipCache = new Map();
var chipLRU = [];
var CHIP_CACHE_CAP = 96;

function chipPut(key, rec) {
  chipCache.set(key, rec);
  chipLRU.push(key);
  while (chipLRU.length > CHIP_CACHE_CAP) chipCache.delete(chipLRU.shift());
  return rec;
}

function makeChip(dpr, h, opt) {
  /* opt: {glyph, color, label, font} — label omitted => glyph-only dot */
  var padX  = h * 0.30;
  var gs    = Math.round(h * 0.58);           /* glyph box */
  var gap   = h * 0.24;
  var fs    = Math.max(7, Math.round(h * 0.40));
  var track = Math.max(0.4, fs * 0.075);      /* letter-spacing, drawn per char */
  var label = opt.label || "";

  /* measure on a scratch context — cheap, and only on a cache miss */
  var meas = makeChip.meas || (makeChip.meas = document.createElement("canvas").getContext("2d"));
  var lw = 0;
  if (label) {
    meas.font = "600 " + fs + "px " + FONT;
    for (var i = 0; i < label.length; i++) lw += meas.measureText(label[i]).width + track;
  }
  var w = label ? Math.round(padX * 2 + gs + gap + lw) : Math.round(h);

  var c = document.createElement("canvas");
  c.width  = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(h * dpr));
  var g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.textBaseline = "middle";
  g.textAlign = "left";

  /* scrim first so the chip survives a white poster, lane-tinted hairline
     second so it still declares the lane at a glance */
  g.fillStyle = SCRIM;
  rr(g, 0.5, 0.5, w - 1, h - 1, h * 0.34);
  g.fill();
  g.strokeStyle = opt.color;
  g.globalAlpha = 0.60;
  g.lineWidth = 1;
  rr(g, 0.5, 0.5, w - 1, h - 1, h * 0.34);
  g.stroke();
  g.globalAlpha = 1;

  var gx = label ? padX : (w - gs) / 2;
  var gy = (h - gs) / 2;
  g.save();
  g.translate(gx, gy);
  g.fillStyle = opt.color;
  opt.glyph(g, gs);
  g.restore();

  if (label) {
    g.fillStyle = "rgba(255,255,255,0.94)";
    g.font = "600 " + fs + "px " + FONT;
    var x = padX + gs + gap;
    for (var j = 0; j < label.length; j++) {
      g.fillText(label[j], x, h / 2 + 0.5);
      x += g.measureText(label[j]).width + track;
    }
  }
  return { c: c, w: w, h: h };
}

function chipFor(dpr, h, lane, withLabel) {
  var key = "L" + lane + "|" + h + "|" + dpr + "|" + (withLabel ? 1 : 0);
  var rec = chipCache.get(key);
  if (rec) return rec;
  var L = LANES[lane];
  return chipPut(key, makeChip(dpr, h, {
    glyph: L.glyph, color: L.color, label: withLabel ? L.label : ""
  }));
}

function chipHls(dpr, h) {
  var key = "H|" + h + "|" + dpr;
  var rec = chipCache.get(key);
  if (rec) return rec;
  return chipPut(key, makeChip(dpr, h, { glyph: glyphHls, color: HLS_COLOR, label: "" }));
}

/* LIVE is the one chip that pulses: the dot is drawn live (cheap: one arc) on
   top of a cached body, so the pulse costs no re-rasterisation. */
function chipLive(dpr, h, withLabel) {
  var key = "V|" + h + "|" + dpr + "|" + (withLabel ? 1 : 0);
  var rec = chipCache.get(key);
  if (rec) return rec;
  return chipPut(key, makeChip(dpr, h, {
    glyph: function () {},              /* dot is painted per-frame, see drawBadges */
    color: LIVE_COLOR,
    label: withLabel ? "LIVE" : ""
  }));
}

/* ==================================================================== */
/*  LAYOUT ENGINE — pure functions.  Adding a layout costs one function  */
/*  plus one registry entry.  The renderer never learns its name.        */
/* ==================================================================== */
/**
 * layout(items, config, viewport) -> {
 *   targets: [{x,y,z,rotY,scale,alpha,reflect}],
 *   bounds:  {minX,maxX,minY,maxY},
 *   camera:  {x,y,zoom} | null,
 *   pageStep, pageUnit,
 *   flags:   {dimOnSelect, selectRelayouts, pageSelect, springCenter}
 * }
 * config: {rows, order, selected, cellW, cellH, pitchX, pitchY, maxRows}
 * Pure: no DOM, no state, no side effects.
 */

/* Where the camera should sit so the FIRST item lands near the TOP-LEFT of the
   viewport rather than in the middle of it.
   The wall's world origin is the first item, and the camera boots at (0,0) —
   which projects the first item to the centre of the screen and leaves the
   whole left half, and every row above the middle one, off-camera. On a home
   view whose first rows ARE the product, that reads as an empty app.
   Content that already fits the viewport stays centred; only content that
   overflows gets pinned to its own origin. The margins buy room for a row
   label above the first row and a breath of air on the left. */
function homeCam(bounds, config, viewport) {
  /* Always pin to the content origin — never "centre it if it happens to fit".
     Whether it fits depends on how much has loaded at that instant, and on a
     live-watched registry that answer changes seconds later; a home view that
     lands somewhere different depending on network timing is not a home view. */
  return {
    x: bounds.minX + viewport.vw / 2 - config.cellW / 2 - 28,
    y: bounds.minY + viewport.vh / 2 - config.cellH / 2 - 34,
    zoom: 1
  };
}

function layoutWall(items, config, viewport) {
  var N = items.length;
  var PITCH_X = config.pitchX, PITCH_Y = config.pitchY;
  /* Honour the requested row count as-is (1..maxRows). With tall 2:3 poster
     cells, N rows can exceed what the viewport shows at zoom 1 — that is fine
     and expected for a wall: the wall is vertically centred on its origin and
     computeBounds() unlocks vertical pan whenever the content is taller than
     the viewport, so the user pans / zooms out to survey every row and zooms
     in to inspect one. No poster is ever clipped mid-cell; only whole rows sit
     off-screen until panned to. The old no-clip cap — floor((vh+gapY)/pitchY) —
     evaluated to 1 for tall posters at normal viewports, which silently pinned
     the wall to a single 50-wide strip and made the 1..5 row control (dots /
     number keys / setRows) do nothing. */
  var rows = clamp(config.rows | 0, 1, config.maxRows);
  var cols = Math.max(1, Math.ceil(N / rows));
  var ttb = config.order === "ttb";
  var targets = new Array(N);
  for (var i = 0; i < N; i++) {
    var col = ttb ? (i / rows) | 0 : i % cols;
    var row = ttb ? i % rows : (i / cols) | 0;
    targets[i] = {
      x: col * PITCH_X,
      y: (row - (rows - 1) / 2) * PITCH_Y,
      z: 0, rotY: 0, scale: 1, alpha: 1,
      reflect: (row === rows - 1)
    };
  }
  var B = {
    minX: 0, maxX: (cols - 1) * PITCH_X,
    minY: -(rows - 1) / 2 * PITCH_Y, maxY: (rows - 1) / 2 * PITCH_Y
  };
  return {
    targets: targets,
    bounds: B,
    camera: null,              /* keep world x: tiles reflow around the gaze */
    homeCamera: homeCam(B, config, viewport),
    pageStep: PITCH_X,
    pageUnit: PITCH_X,
    flags: { dimOnSelect: true, selectRelayouts: false, pageSelect: false, springCenter: false },
    rows: rows, cols: cols
  };
}

function layoutHero(items, config, viewport) {
  var N = items.length;
  var CELL_W = config.cellW, CELL_H = config.cellH, PITCH_X = config.pitchX;
  var sel = (config.selected != null && config.selected >= 0 && config.selected < N) ? config.selected : 0;
  var RING_N = 12;
  var HERO_SCALE = clamp(Math.min(viewport.vw * 0.55 / CELL_W, viewport.vh * 0.70 / CELL_H), 1.2, 4);
  var targets = new Array(N);
  var maxR = 0, k = 0;
  for (var i = 0; i < N; i++) {
    if (i === sel) {
      targets[i] = { x: 0, y: 0, z: 0, rotY: 0, scale: HERO_SCALE, alpha: 1, reflect: false };
      continue;
    }
    var r = (k / RING_N) | 0;
    var s = k % RING_N;
    var a = -Math.PI / 2 + (s + 0.5 * (r % 2)) * (2 * Math.PI / RING_N);
    var R = HERO_SCALE * CELL_W * 0.78 + r * PITCH_X * 0.92;
    var x = Math.cos(a) * R * 1.35;
    var y = Math.sin(a) * R * 0.78;
    if (Math.abs(x) > maxR) maxR = Math.abs(x);
    targets[i] = {
      x: x, y: y,
      z: 140 + r * 90,
      rotY: clamp(-x / (viewport.vw * 1.1), -0.5, 0.5),
      scale: Math.max(0.34, 0.62 - r * 0.07),
      alpha: Math.max(0.35, 0.85 - r * 0.12),
      reflect: false
    };
    k++;
  }
  return {
    targets: targets,
    bounds: { minX: -maxR, maxX: maxR, minY: -maxR * 0.6, maxY: maxR * 0.6 },
    camera: { x: 0, y: 0, zoom: 1 },
    pageStep: 0, pageUnit: 0,
    flags: { dimOnSelect: false, selectRelayouts: true, pageSelect: true, springCenter: true }
  };
}

/* Third layout — proof that the extension point is real. */
function layoutSpiral(items, config, viewport) {
  var N = items.length, targets = new Array(N), maxR = 0;
  var PITCH_X = config.pitchX;
  var GOLD = Math.PI * (3 - Math.sqrt(5));
  for (var i = 0; i < N; i++) {
    var a = i * GOLD;
    var R = 26 * Math.sqrt(i) * (PITCH_X / 60);
    var x = Math.cos(a) * R * 1.3, y = Math.sin(a) * R * 0.82;
    if (Math.abs(x) > maxR) maxR = Math.abs(x);
    targets[i] = {
      x: x, y: y,
      z: Math.min(600, i * 5),
      rotY: clamp(-x / (viewport.vw * 1.4), -0.4, 0.4),
      scale: clamp(1.15 - i * 0.012, 0.45, 1.15),
      alpha: 1, reflect: false
    };
  }
  return {
    targets: targets,
    bounds: { minX: -maxR, maxX: maxR, minY: -maxR * 0.6, maxY: maxR * 0.6 },
    camera: { x: 0, y: 0, zoom: 1 },
    pageStep: PITCH_X, pageUnit: PITCH_X,
    flags: { dimOnSelect: true, selectRelayouts: false, pageSelect: false, springCenter: true }
  };
}

/* Stremio/Netflix home shape: one horizontal row per group, stacked.
   Items carry an optional `group` (catalog name); ungrouped items land in
   one "Library" row.  Rows are unlimited horizontally; the wall's free pan
   covers both axes, so tall bounds simply mean vertical panning works.
   Returns an optional labels[] the renderer draws in world space — the only
   thing a layout may add beyond targets. */
function layoutCatalogRows(items, config, viewport) {
  var N = items.length;
  var CELL_H = config.cellH, PITCH_X = config.pitchX;
  var ROW_GAP = config.rowGap != null ? config.rowGap : 90;
  var ROW_PITCH = CELL_H + ROW_GAP;
  var FALLBACK = config.fallbackGroup || "Library";

  /* group, first-seen order preserved */
  var names = [], byName = {};
  for (var i = 0; i < N; i++) {
    var g = (items[i] && items[i].group) || FALLBACK;
    if (!byName[g]) { byName[g] = []; names.push(g); }
    byName[g].push(i);
  }
  var G = Math.max(1, names.length);
  /* Row 0 is anchored at the world origin rather than the stack being centred
     on it. Centring makes a row's world position depend on how many rows come
     AFTER it, so a late-arriving catalog silently slides every existing row
     upward and a stationary camera ends up looking at different content —
     which is exactly how the registry rows went off-camera on home. With the
     origin anchored, rows appearing above or below never move the ones
     already on screen. That matters here: the registry is watched live, so
     rows really do arrive after the first paint. */
  var targets = new Array(N), labels = [], maxCols = 1;
  for (var r = 0; r < names.length; r++) {
    var row = byName[names[r]];
    if (row.length > maxCols) maxCols = row.length;
    var ry = r * ROW_PITCH;
    for (var c = 0; c < row.length; c++) {
      targets[row[c]] = {
        x: c * PITCH_X, y: ry,
        z: 0, rotY: 0, scale: 1, alpha: 1, reflect: false
      };
    }
    labels.push({
      text: names[r],
      x: -config.cellW / 2,
      y: ry - CELL_H / 2 - 16
    });
  }

  var B = { minX: 0, maxX: (maxCols - 1) * PITCH_X, minY: 0, maxY: (G - 1) * ROW_PITCH };
  return {
    targets: targets,
    bounds: B,
    labels: labels,
    camera: null,
    /* the first row is the registry — the product. Frame it on entry. */
    homeCamera: homeCam(B, config, viewport),
    pageStep: PITCH_X,
    pageUnit: PITCH_X,
    flags: { dimOnSelect: true, selectRelayouts: false, pageSelect: false, springCenter: false },
    cols: maxCols, groups: names
  };
}

var BUILTIN_LAYOUTS = { wall: layoutWall, hero: layoutHero, spiral: layoutSpiral, catalogRows: layoutCatalogRows };

/* default hi-res URL hook: upgrade known resizable sources, else keep as-is */
function defaultHiResURL(item, need) {
  var u = item.poster || item.url || "";
  var m = /^(https?:\/\/picsum\.photos\/seed\/[^\/]+)\/\d+\/\d+/.exec(u);
  if (m) return m[1] + "/" + need.w + "/" + need.h;
  m = /^(https?:\/\/picsum\.photos)\/\d+\/\d+/.exec(u);
  if (m) return m[1] + "/" + need.w + "/" + need.h;
  /* Stremio metahub: small -> medium/large as the tile grows on screen */
  if (/images\.metahub\.space\/.*\/small\//.test(u)) {
    return u.replace("/small/", need.w > 640 ? "/large/" : "/medium/");
  }
  return u;
}

/* default live-thumbnail hook: the stable URL of a periodically-updated snapshot
   for a live feed, or "" when the item is not live. Reads item.liveThumb if the
   data layer already carries a URL, else derives Chaturbate's public snapshot
   endpoint (CORS ACAO:*) from a room id (item.liveRoom or a "chaturbate:<room>"
   id). Override via opts.liveThumbURL to support other live sources. */
function defaultLiveThumbURL(item) {
  if (!item) return "";
  if (item.liveThumb) return item.liveThumb;
  var room = item.liveRoom || null;
  if (!room && typeof item.id === "string") {
    var m = /^chaturbate:(.+)$/.exec(item.id);
    if (m) room = m[1];
  }
  return room ? "https://thumb.live.mmcdn.com/riw/" + encodeURIComponent(room) + ".jpg" : "";
}

/* ==================================================================== */
/*  CLASS                                                               */
/* ==================================================================== */
function WallView(canvas, opts) {
  if (!(this instanceof WallView)) return new WallView(canvas, opts);
  if (!canvas || !canvas.getContext) throw new Error("WallView: a <canvas> is required");
  opts = opts || {};

  var self = this;
  var container = opts.container || canvas.parentElement || canvas;
  var ctx = canvas.getContext("2d", { alpha: false });
  if (canvas.tabIndex < 0) canvas.tabIndex = 0;
  canvas.style.touchAction = "none";
  canvas.style.outline = "none";
  canvas.style.cursor = "grab";

  /* ---- tunables (opts) ---- */
  var CELL_H = opts.cellH || 240;
  var DEF_ASPECT = opts.aspect || (2 / 3);
  var CELL_W = opts.cellW || Math.round(CELL_H * DEF_ASPECT);
  var GAP_X = opts.gapX != null ? opts.gapX : 40;
  var GAP_Y = opts.gapY != null ? opts.gapY : 46;
  var PITCH_X = CELL_W + GAP_X, PITCH_Y = CELL_H + GAP_Y;
  var ZOOM_MIN = opts.zoomMin || 0.35, ZOOM_MAX = opts.zoomMax || 400;
  var MAX_ROWS = opts.maxRows || 5;
  var REFLECT = opts.reflections !== false;
  var SHOW_CHROME = opts.chrome !== false;
  var SHOW_TITLE = opts.showTitle !== false;
  var BADGES = opts.badges !== false;       /* lane / HLS / LIVE chrome on tiles */
  var brand = opts.brand != null ? opts.brand : (opts.wordmark != null ? opts.wordmark : "");
  var hiResURL = typeof opts.hiResURL === "function" ? opts.hiResURL : defaultHiResURL;
  var liveThumbURL = typeof opts.liveThumbURL === "function" ? opts.liveThumbURL : defaultLiveThumbURL;
  var LIVE_MS = opts.livePreviewMs || 3000;      /* per-tile refresh period */
  var LIVE_TICK = opts.livePreviewTick || 350;   /* driver cadence = stagger unit */
  var ROW_GAP = opts.rowGap != null ? opts.rowGap : 90;
  var FALLBACK_GROUP = opts.fallbackGroup || "Library";
  var PILL_LABELS = { catalogRows: "catalog" };
  if (opts.layoutLabels) for (var pl in opts.layoutLabels) if (opts.layoutLabels.hasOwnProperty(pl)) PILL_LABELS[pl] = opts.layoutLabels[pl];

  var TAU_POS = 0.16, TAU_ROT = 0.20, TAU_ALPHA = 0.12;
  if (REDUCED) { TAU_POS = TAU_ROT = TAU_ALPHA = 0.04; }

  var LAYOUTS = {};
  for (var ln in BUILTIN_LAYOUTS) if (BUILTIN_LAYOUTS.hasOwnProperty(ln)) LAYOUTS[ln] = BUILTIN_LAYOUTS[ln];
  if (opts.layouts) for (var ln2 in opts.layouts) if (opts.layouts.hasOwnProperty(ln2)) LAYOUTS[ln2] = opts.layouts[ln2];
  if (opts.layoutNames) {   /* restrict the pill row without losing the registry */
    var keep = {};
    for (var q = 0; q < opts.layoutNames.length; q++) if (LAYOUTS[opts.layoutNames[q]]) keep[opts.layoutNames[q]] = LAYOUTS[opts.layoutNames[q]];
    if (Object.keys(keep).length) LAYOUTS = keep;
  }

  /* ---- state ---- */
  var destroyed = false;
  var dpr = 1, W = 0, H = 0, vw = 0, vh = 0;
  var items = [], tiles = [];
  var cur = null;
  var layoutName = LAYOUTS[opts.layout] ? opts.layout : "wall";
  var rows = clamp(opts.rows || 3, 1, MAX_ROWS);
  var wallOrder = opts.order === "ttb" ? "ttb" : "ltr";
  var selected = null;
  var cam = { x: 0, y: 0, zoom: 1 };
  var pendingCam = null;   /* a restored camera: wins over the NEXT home-arrival framing */
  var camVel = { x: 0, y: 0 };
  var camTween = null;
  var savedCam = null;
  var panLockedX = true, panLockedY = true;
  var bx = { lo: 0, hi: 0 }, by = { lo: 0, hi: 0 };

  var chromeAlpha = 1, chromeTarget = 1;
  var arrowL = 0, arrowR = 0, arrowLT = 0, arrowRT = 0;
  var titleAlpha = 0, titleTarget = 0;
  var spinnerOn = false, spinT = 0, spinPending = 0;
  var hoverTile = -1, hoverChrome = null, hoverRowDot = 0;
  var emptyText = opts.emptyText || "";
  var cbSelect = typeof opts.onSelect === "function" ? opts.onSelect : null;
  var cbHover = typeof opts.onHover === "function" ? opts.onHover : null;
  var cbDeselect = typeof opts.onDeselect === "function" ? opts.onDeselect : null;
  var cbLayout = typeof opts.onLayout === "function" ? opts.onLayout : null;
  var pendingNotify = null, pendingNotifyAt = 0;
  var idleTimer = 0, arrowTimer = 0, rzTimer = 0;
  var running = false, rafId = 0, lastT = 0, pendingDirty = false, livePulseOnly = false;
  var livePreview = false, liveTimer = 0, liveSeq = 0;   /* cheap-many live thumbs */
  var livePins = null;   /* Set of item.id: when set, ONLY these tiles refresh */
  var order = [];

  /* ---- offscreen caches ---- */
  var vign = document.createElement("canvas");
  var ramp = document.createElement("canvas");
  var refl = document.createElement("canvas");
  var reflCtx = null, rampBuilt = false;

  function buildRamp() {
    ramp.width = 1; ramp.height = 64;
    var g = ramp.getContext("2d");
    var gr = g.createLinearGradient(0, 0, 0, 64);
    gr.addColorStop(0, "rgba(0,0,0,0)");
    gr.addColorStop(1, "rgba(0,0,0,1)");
    g.fillStyle = gr; g.fillRect(0, 0, 1, 64);
    refl.width = 640; refl.height = 660;
    reflCtx = refl.getContext("2d");
    reflCtx.imageSmoothingQuality = "high";
    rampBuilt = true;
  }

  function buildVignette() {
    vign.width = Math.max(1, Math.round(W));
    vign.height = Math.max(1, Math.round(H));
    var g = vign.getContext("2d");
    g.clearRect(0, 0, vign.width, vign.height);
    var lg = g.createLinearGradient(0, 0, 0, H);
    lg.addColorStop(0, "#15151a");
    lg.addColorStop(0.55, "#0a0a0c");
    lg.addColorStop(1, "#050506");
    g.fillStyle = lg; g.fillRect(0, 0, W, H);
    var rg = g.createRadialGradient(W / 2, H * 0.42, 0, W / 2, H * 0.42, Math.max(W, H) * 0.72);
    rg.addColorStop(0, "rgba(0,0,0,0)");
    rg.addColorStop(1, "rgba(0,0,0,0.45)");
    g.fillStyle = rg; g.fillRect(0, 0, W, H);
  }

  /* ==================================================================== */
  /*  IMAGE PIPELINE                                                      */
  /* ==================================================================== */
  var cache = new Map();             /* url -> {img, state, cbs, prio} */
  var inflight = 0;
  var queue = [];
  var hiLRU = [];

  function loadImage(url, prio, cb) {
    if (!url) { cb(null); return; }
    var e = cache.get(url);
    if (e) {
      if (e.state === "ready") { cb(e.img); return; }
      if (e.state === "error") { cb(null); return; }
      e.cbs.push(cb);
      if (prio < e.prio) e.prio = prio;
      return;
    }
    e = { img: null, state: "queued", cbs: [cb], prio: prio, url: url };
    cache.set(url, e);
    queue.push(e);
    pump();
  }

  function pump() {
    if (destroyed) return;
    if (inflight >= MAX_LOADS || queue.length === 0) return;
    var best = 0;
    for (var i = 1; i < queue.length; i++) if (queue[i].prio < queue[best].prio) best = i;
    var e = queue.splice(best, 1)[0];
    if (e.state === "dropped") { pump(); return; }
    e.state = "loading";
    inflight++;
    var img = new Image();
    img.decoding = "async";
    if (opts.crossOrigin) img.crossOrigin = opts.crossOrigin;
    e.el = img;
    img.onload = function () {
      var fin = function () {
        inflight--;
        if (destroyed) return;
        e.img = img; e.state = "ready";
        for (var j = 0; j < e.cbs.length; j++) e.cbs[j](img);
        e.cbs.length = 0;
        pump();
      };
      if (img.decode) img.decode().then(fin, fin); else fin();
    };
    img.onerror = function () {
      inflight--;
      if (destroyed) return;
      e.state = "error";
      for (var j = 0; j < e.cbs.length; j++) e.cbs[j](null);
      e.cbs.length = 0;
      pump();
    };
    img.src = e.url;
    if (inflight < MAX_LOADS) pump();
  }

  function dropQueued(url) {
    var e = cache.get(url);
    if (e && e.state === "queued") {
      e.state = "dropped";
      cache.delete(url);
      var i = queue.indexOf(e);
      if (i >= 0) queue.splice(i, 1);
    }
  }

  function snap256(v) { return Math.min(4096, Math.max(256, Math.ceil(v / 256) * 256)); }

  function touchHi(url) {
    var i = hiLRU.indexOf(url);
    if (i >= 0) hiLRU.splice(i, 1);
    hiLRU.push(url);
    while (hiLRU.length > HIRES_CAP) {
      var old = hiLRU.shift();
      var e = cache.get(old);
      if (e && e.state === "ready") {
        for (var t = 0; t < tiles.length; t++) {
          if (tiles[t].hiURL === old) { tiles[t].hi = null; tiles[t].hiURL = ""; tiles[t].hiState = ""; tiles[t].fade = 0; }
        }
        cache.delete(old);
      }
    }
  }

  function targetZoomFor() {
    if (camTween && camTween.toZoom) return camTween.toZoom;
    return cam.zoom;
  }

  function requestHi(tile, prio) {
    if (!tile) return;
    var screenW = tile.dw * tile.tscale * targetZoomFor() * dpr;
    var nw = snap256(screenW);
    /* height derives from the real aspect — never snapped independently,
       or the request would silently change the image's proportions. */
    var need = { w: nw, h: Math.max(1, Math.round(nw * (tile.ih / tile.iw || 1.5))) };
    var url = hiResURL(tile.item, need);
    if (!url || url === tile.hiURL) return;
    if (tile.hiURL) dropQueued(tile.hiURL);
    tile.hiURL = url;
    tile.hiState = "loading";
    tile.hiT0 = performance.now();
    loadImage(url, prio, function (img) {
      if (destroyed || tile.hiURL !== url) return;
      if (!img) { tile.hiState = "error"; kick(); return; }
      tile.hi = img; tile.hiState = "ready"; tile.fade = 0;
      tile.iw = img.naturalWidth; tile.ih = img.naturalHeight; fitTile(tile);
      touchHi(url);
      kick();
    });
  }

  /* ---- live thumbnail previews (the cheap-many half) -----------------------
     Hundreds of live feeds can't each own a <video> (browsers cap at a few
     dozen and every HLS decode is heavy). The cheap primitive is a small <img>
     per tile, re-pulled periodically — no video decode, scales to hundreds.
     This driver refreshes ONLY on-screen tiles, staggers them over time, and
     rides the SAME concurrency-capped load queue as posters (MAX_LOADS is the
     laundromat: excess pulls just wait their turn). The FOCUSED tile's real
     motion <video> is a separate DOM overlay owned upstream (hp-stream); this
     does only the many small snapshots. Off by default; reduced-motion forces
     it off; when off there is zero added work (idle-zero preserved). */
  function liveThumbBase(tile) {
    if (tile.liveBase === undefined) tile.liveBase = liveThumbURL(tile.item) || "";
    return tile.liveBase;
  }

  function refreshLive(tile, now, force) {
    var base = tile.liveBase;
    /* the URL is stable but its bytes change over time, so bust the image cache
       on every pull; the entry is single-use and dropped the moment it decodes,
       so the cache Map never grows. */
    var url = base + (base.indexOf("?") >= 0 ? "&" : "?") + "_lp=" + (++liveSeq);
    tile.liveT0 = now;
    tile.liveInflight = true;
    loadImage(url, 10, function (img) {
      tile.liveInflight = false;
      cache.delete(url);
      /* `force` is the one-shot "update covers" pull, which applies even when the
         continuous driver is off; otherwise only apply while the engine is active. */
      if (destroyed || (!force && !liveActive())) return;
      if (img) {
        /* swap only AFTER decode -> no half-painted flicker. Refit to the
           snapshot's own aspect (contain) so a 16:9 cam feed is not stretched
           into a 2:3 poster cell. ponytail: a cam catalog that wants a wide
           CELL is the data/layout layer's call, not this refresh loop. */
        tile.live = img;
        tile.iw = img.naturalWidth; tile.ih = img.naturalHeight; fitTile(tile);
        kick();
      }
    });
  }

  function liveTick() {
    if (destroyed || !livePreview) return;
    var now = performance.now();
    var due = null;
    for (var i = 0; i < tiles.length; i++) {
      var tl = tiles[i];
      if (!tl.vis || tl.liveInflight) continue;   /* visible tiles only */
      if (!liveThumbBase(tl)) continue;            /* live items only */
      if (livePins && !(tl.item && livePins.has(tl.item.id))) continue;  /* pinned only */
      if (now - (tl.liveT0 || 0) < LIVE_MS) continue;
      (due || (due = [])).push(tl);
    }
    if (!due) return;
    /* stagger: refresh only a slice per tick so one full LIVE_MS sweep spreads
       across ticks and we never burst every visible tile at once. Stalest go
       first; the queue's MAX_LOADS cap absorbs any overflow. */
    due.sort(function (a, b) { return (a.liveT0 || 0) - (b.liveT0 || 0); });
    var perTick = Math.max(1, Math.ceil(due.length * LIVE_TICK / LIVE_MS));
    for (var j = 0; j < due.length && j < perTick; j++) refreshLive(due[j], now);
  }

  /* drop a tile's live snapshot and restore its base image's aspect (the live
     pull refit the cell to the snapshot's shape) so the poster is not left
     letterboxed when previews go off. */
  function clearLive(tile) {
    tile.liveInflight = false; tile.liveT0 = 0;
    if (!tile.live) return;
    tile.live = null;
    var b = tile.img || tile.hi;
    if (b && b.naturalWidth) { tile.iw = b.naturalWidth; tile.ih = b.naturalHeight; }
    else { var asp = tile.item.aspect || DEF_ASPECT; tile.iw = Math.max(1, asp * 1000); tile.ih = 1000; }
    fitTile(tile);
  }

  /* ==================================================================== */
  /*  ITEMS / TILES                                                       */
  /* ==================================================================== */
  function keyOf(it, i) { return it && it.id != null ? "id:" + it.id : "ix:" + i; }

  function makeTile(k, it) {
    var asp = it.aspect || DEF_ASPECT;
    var t = {
      i: k, item: it, key: keyOf(it, k),
      x: 0, y: 0, z: 0, rotY: 0, scale: 0.8, alpha: 0,
      tx: 0, ty: 0, tz: 0, trotY: 0, tscale: 1, talpha: 1,
      reflect: false, t0: 0,
      img: null, imgURL: "", imgState: "",
      live: null, liveBase: undefined, liveT0: 0, liveInflight: false,
      hi: null, hiURL: "", hiState: "", hiT0: 0, fade: 0,
      iw: Math.max(1, asp * 1000), ih: 1000, dw: CELL_W, dh: CELL_H,
      sx: 0, sy: 0, k: 1, shear: 0, vis: false, hover: 0,
      badge: BADGES ? badgeOf(it) : null
    };
    fitTile(t);
    return t;
  }

  function fitTile(t) {
    /* contain: the drawn rect keeps the source aspect, never crops */
    var s = Math.min(CELL_W / t.iw, CELL_H / t.ih);
    t.dw = t.iw * s; t.dh = t.ih * s;
  }

  function thumbOf(it) { return it.thumb || it.poster || it.url || ""; }

  function setItems(list) {
    list = list || [];
    /* An ARRIVAL is a genuinely different set — first population, or a first
       item that changed. A live registry repaint that re-sends the same set
       (registry.js polls every 2.5s) must NOT yank the camera back from
       wherever the user panned to. */
    var wasEmpty = !tiles.length;
    var keyBefore = tiles.length ? tiles[0].key : null;
    var old = new Map();
    for (var i = 0; i < tiles.length; i++) old.set(tiles[i].key, tiles[i]);
    var next = new Array(list.length);
    for (var k = 0; k < list.length; k++) {
      var it = list[k], key = keyOf(it, k);
      var t = old.get(key);
      if (t) {
        old.delete(key);
        t.i = k; t.item = it; t.key = key; t.hover = 0;
        t.badge = BADGES ? badgeOf(it) : null;   /* a live registry edit can change the lane */
        if (t.imgURL && t.imgURL !== thumbOf(it)) { t.img = null; t.imgURL = ""; t.imgState = ""; }
        t.liveBase = undefined;   /* re-derive the live URL: a registry edit may change the source */
        next[k] = t;
      } else {
        next[k] = makeTile(k, it);   /* born at alpha 0 / scale .8 -> flies in */
      }
    }
    old.forEach(function (t) { if (t.imgState === "loading" && !t.img) dropQueued(t.imgURL); });

    items = list;
    tiles = next;
    order = new Array(tiles.length);
    for (var o = 0; o < tiles.length; o++) order[o] = o;
    selected = null;
    titleTarget = 0;
    hoverTile = -1;
    if (!items.length) { cur = null; kick(); return; }
    relayout(false, wasEmpty || keyBefore !== tiles[0].key);
    kick();
  }

  /* ==================================================================== */
  /*  LAYOUT / TWEEN                                                      */
  /* ==================================================================== */
  function layoutConfig() {
    return {
      rows: rows, order: wallOrder, selected: selected,
      cellW: CELL_W, cellH: CELL_H, pitchX: PITCH_X, pitchY: PITCH_Y,
      gapX: GAP_X, gapY: GAP_Y, maxRows: MAX_ROWS,
      rowGap: ROW_GAP, fallbackGroup: FALLBACK_GROUP
    };
  }

  /* `home` = this relayout is an ARRIVAL (new items, or a layout the user just
     picked), so the camera is allowed to frame the content. A resize or a row
     /order tweak is NOT an arrival: it must never yank the camera away from
     wherever the user panned to. */
  function relayout(instant, home) {
    if (!items.length) return;
    var firstEver = !cur;
    var fn = LAYOUTS[layoutName] || LAYOUTS.wall || layoutWall;
    var res = fn(items, layoutConfig(), { vw: vw, vh: vh });
    cur = res;
    if (res.rows) rows = res.rows;

    /* stagger, ordered by distance from viewport centre outward */
    var n = tiles.length;
    var idx = new Array(n);
    for (var i = 0; i < n; i++) idx[i] = i;
    var camx = cam.x, camy = cam.y;
    idx.sort(function (a, b) {
      var ta = res.targets[a], tb = res.targets[b];
      var da = (ta.x - camx) * (ta.x - camx) + (ta.y - camy) * (ta.y - camy) * 2.2;
      var db = (tb.x - camx) * (tb.x - camx) + (tb.y - camy) * (tb.y - camy) * 2.2;
      return da - db;
    });
    var t = performance.now();
    for (var r = 0; r < n; r++) {
      var ti = tiles[idx[r]];
      ti.t0 = (instant || REDUCED) ? 0 : t + Math.min(r, 24) * 8;
    }

    applyTargets();

    if (res.camera) {
      if (instant) { cam.x = res.camera.x; cam.y = res.camera.y; cam.zoom = res.camera.zoom; camTween = null; }
      else flyTo(res.camera.x, res.camera.y, res.camera.zoom, 480, easeInOutCubic);
    } else if (home && res.homeCamera) {
      var hc = pendingCam || res.homeCamera;
      if (pendingCam) pendingCam = null;
      /* the very first paint SNAPS: flying in from a position the user never
         chose is motion that means nothing. Later arrivals ease. */
      if (instant || REDUCED || firstEver) {
        cam.x = hc.x; cam.y = hc.y; cam.zoom = hc.zoom;
        camTween = null; camVel.x = camVel.y = 0;
      } else flyTo(hc.x, hc.y, hc.zoom, 520, easeOutQuart);
    }
    computeBounds();
    if (instant) {
      for (var q = 0; q < n; q++) {
        var tt = tiles[q];
        tt.x = tt.tx; tt.y = tt.ty; tt.z = tt.tz; tt.rotY = tt.trotY;
        tt.scale = tt.tscale; tt.alpha = tt.talpha;
      }
    }
    if (cbLayout) { try { cbLayout({ name: layoutName, rows: rows, order: wallOrder }); } catch (e) {} }
    kick();
  }

  function applyTargets() {
    if (!cur) return;
    var dim = cur.flags.dimOnSelect && selected != null;
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i], g = cur.targets[i];
      if (!g) continue;
      t.tx = g.x; t.ty = g.y; t.tz = g.z; t.trotY = g.rotY;
      t.tscale = g.scale * (1 + t.hover * 0.03);
      t.talpha = g.alpha * (dim && i !== selected ? 0.35 : 1);
      t.reflect = REFLECT && !!g.reflect;
    }
  }

  function computeBounds() {
    if (!cur) return;
    var b = cur.bounds;
    var halfW = vw / (2 * cam.zoom), halfH = vh / (2 * cam.zoom);

    /* Keep the visible window inside the content: pan locks (and the wall
       centres) exactly when vw/zoom exceeds the content width. */
    var lo = b.minX + halfW - CELL_W / 2, hi = b.maxX - halfW + CELL_W / 2;
    if (lo > hi) { var c = (b.minX + b.maxX) / 2; lo = hi = c; panLockedX = true; }
    else {
      panLockedX = false;
      if (selected != null) { lo = Math.min(lo, b.minX); hi = Math.max(hi, b.maxX); }
    }
    bx.lo = lo; bx.hi = hi;

    var loy = b.minY + halfH - CELL_H / 2, hiy = b.maxY - halfH + CELL_H / 2;
    if (loy > hiy) { var cy = (b.minY + b.maxY) / 2; loy = hiy = cy; panLockedY = true; }
    else {
      panLockedY = false;
      if (selected != null) { loy = Math.min(loy, b.minY); hiy = Math.max(hiy, b.maxY); }
    }
    by.lo = loy; by.hi = hiy;
  }

  function flyTo(x, y, zoom, dur, ease) {
    camTween = {
      fx: cam.x, fy: cam.y, fz: cam.zoom,
      tx: x, ty: y, toZoom: zoom,
      t0: performance.now(), dur: REDUCED ? 40 : dur, ease: ease || easeOutCubic
    };
    camVel.x = camVel.y = 0;
    kick();
  }

  /* ==================================================================== */
  /*  PROJECTION                                                          */
  /* ==================================================================== */
  var P = { sx: 0, sy: 0, k: 1, u: 0, p: 1, dz: 1 };

  /* wall-edge perspective/shear reads wrong once a tile fills the screen —
     fade it out between zoom 1.4 and 2.4 so deep zoom is skew-free */
  function persAmt() {
    return cam.zoom <= 1.4 ? 1 : cam.zoom >= 2.4 ? 0 : 2.4 - cam.zoom;
  }

  function project(wx, wy, wz) {
    var dx = (wx - cam.x) * cam.zoom;
    var dy = (wy - cam.y) * cam.zoom;
    var dz = 1 / (1 + wz / FOCAL);
    var u = (dx * dz) / (vw * 0.5);
    var p = 1 / (1 + PERSP_K * persAmt() * Math.abs(u));
    P.dz = dz; P.u = u; P.p = p;
    P.k = cam.zoom * dz * p;
    P.sx = vw / 2 + dx * dz * p;
    P.sy = vh / 2 + dy * dz * p;
    return P;
  }

  /* exact inverse for the z = 0 plane (used by wheel/pinch anchoring) */
  var SW = { x: 0, y: 0 };
  function screenToWorld(px, py) {
    var PK = PERSP_K * persAmt(); /* must mirror project() exactly */
    var Hh = vw * 0.5;
    var X = px - vw / 2;
    var den = 1 - Math.abs(X) * PK / Hh;
    if (den < 0.05) den = 0.05;
    var D = X / den;
    var p = 1 / (1 + PK * Math.abs(D / Hh));
    var Dy = (py - vh / 2) / p;
    SW.x = cam.x + D / cam.zoom;
    SW.y = cam.y + Dy / cam.zoom;
    return SW;
  }

  /* ==================================================================== */
  /*  RENDER                                                              */
  /* ==================================================================== */
  function resize() {
    if (destroyed) return;
    var r = container.getBoundingClientRect();
    var cw = r.width || canvas.clientWidth || 1;
    var ch = r.height || canvas.clientHeight || 1;
    dpr = Math.min(global.devicePixelRatio || 1, 2);
    W = Math.max(1, Math.round(cw));
    H = Math.max(1, Math.round(ch));
    vw = W; vh = Math.max(1, H - (SHOW_CHROME ? CHROME_H : 0));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if (!rampBuilt) buildRamp();
    buildVignette();
    if (items.length) relayout(false);
    computeBounds();
    kick();
  }

  function step(dt) {
    var active = false;
    var t = performance.now();

    /* ---- camera ---- */
    if (camTween) {
      var f = (t - camTween.t0) / camTween.dur;
      if (f >= 1) {
        cam.x = camTween.tx; cam.y = camTween.ty; cam.zoom = camTween.toZoom;
        camTween = null; computeBounds();
      } else {
        var e = camTween.ease(clamp(f, 0, 1));
        cam.x = camTween.fx + (camTween.tx - camTween.fx) * e;
        cam.y = camTween.fy + (camTween.ty - camTween.fy) * e;
        cam.zoom = camTween.fz + (camTween.toZoom - camTween.fz) * e;
        computeBounds();
        active = true;
      }
    } else if (!dragging && !scrubbing) {
      if (Math.abs(camVel.x) > 8 || Math.abs(camVel.y) > 8) {
        var damp = Math.exp(-4.2 * dt);
        cam.x += camVel.x * dt; cam.y += camVel.y * dt;
        camVel.x *= damp; camVel.y *= damp;
        if (Math.abs(camVel.x) < 8) camVel.x = 0;
        if (Math.abs(camVel.y) < 8) camVel.y = 0;
        active = true;
      }
      /* spring back inside bounds — spring layouts only; the wall pans free */
      var cx = clamp(cam.x, bx.lo, bx.hi), cy = clamp(cam.y, by.lo, by.hi);
      if (!cur || !cur.flags.springCenter) { cx = cam.x; cy = cam.y; }
      if (cx !== cam.x || cy !== cam.y) {
        var kk = 1 - Math.exp(-dt / 0.18);
        cam.x += (cx - cam.x) * kk; cam.y += (cy - cam.y) * kk;
        if (Math.abs(cx - cam.x) < 0.2) cam.x = cx;
        if (Math.abs(cy - cam.y) < 0.2) cam.y = cy;
        camVel.x = camVel.y = 0;
        active = true;
      }
    }

    /* ---- tiles ---- */
    var kp = 1 - Math.exp(-dt / TAU_POS);
    var kr = 1 - Math.exp(-dt / TAU_ROT);
    var ka = 1 - Math.exp(-dt / TAU_ALPHA);
    var anyZ = false, d;
    for (var i = 0; i < tiles.length; i++) {
      var tl = tiles[i];
      if (tl.t0 > t) { active = true; continue; }
      d = tl.tx - tl.x;    if (d < -0.25 || d > 0.25) { tl.x += d * kp; active = true; } else tl.x = tl.tx;
      d = tl.ty - tl.y;    if (d < -0.25 || d > 0.25) { tl.y += d * kp; active = true; } else tl.y = tl.ty;
      d = tl.tz - tl.z;    if (d < -0.25 || d > 0.25) { tl.z += d * kp; active = true; } else tl.z = tl.tz;
      d = tl.trotY - tl.rotY;   if (d < -0.001 || d > 0.001) { tl.rotY += d * kr; active = true; } else tl.rotY = tl.trotY;
      d = tl.tscale - tl.scale; if (d < -0.001 || d > 0.001) { tl.scale += d * kp; active = true; } else tl.scale = tl.tscale;
      d = tl.talpha - tl.alpha; if (d < -0.004 || d > 0.004) { tl.alpha += d * ka; active = true; } else tl.alpha = tl.talpha;
      if (tl.z > 0.5) anyZ = true;
      if (tl.hiState === "ready" && tl.fade < 1) { tl.fade = Math.min(1, tl.fade + dt / 0.18); active = true; }
    }

    /* ---- z-sort (insertion sort over previous order: near-sorted, O(n)) ---- */
    if (anyZ) {
      for (var a = 1; a < order.length; a++) {
        var v = order[a], zv = tiles[v].z, b = a - 1;
        while (b >= 0 && tiles[order[b]].z < zv) { order[b + 1] = order[b]; b--; }
        order[b + 1] = v;
      }
    }

    /* ---- chrome fades ---- */
    d = chromeTarget - chromeAlpha;
    if (d < -0.004 || d > 0.004) { chromeAlpha += d * (1 - Math.exp(-dt / 0.15)); active = true; } else chromeAlpha = chromeTarget;
    d = arrowLT - arrowL; if (d < -0.004 || d > 0.004) { arrowL += d * (1 - Math.exp(-dt / 0.15)); active = true; } else arrowL = arrowLT;
    d = arrowRT - arrowR; if (d < -0.004 || d > 0.004) { arrowR += d * (1 - Math.exp(-dt / 0.15)); active = true; } else arrowR = arrowRT;
    d = titleTarget - titleAlpha; if (d < -0.004 || d > 0.004) { titleAlpha += d * (1 - Math.exp(-dt / 0.2)); active = true; } else titleAlpha = titleTarget;

    /* ---- deferred select notification: fires AFTER the fly-to ---- */
    if (pendingNotify != null) {
      if (t >= pendingNotifyAt) {
        var pi = pendingNotify; pendingNotify = null;
        if (cbSelect && items[pi]) { try { cbSelect(items[pi], pi); } catch (e2) {} }
      } else active = true;
    }

    /* ---- spinner ---- */
    var showSpin = spinnerOn ||
      (selected != null && tiles[selected] && tiles[selected].hiState === "loading" && (t - tiles[selected].hiT0) > 250);
    spinPending = showSpin ? 1 : 0;
    if (showSpin) { spinT += dt; active = true; }

    /* ---- image demand ---- */
    demand();
    if (inflight > 0) active = true;

    /* A visible LIVE chip is the ONLY badge that keeps the loop alive, and only
       when motion is allowed. Everything else about the badge layer is static,
       so the dirty-flag idle-zero contract is untouched by this feature. */
    livePulseOnly = false;
    if (liveOnScreen && !REDUCED) { livePulseOnly = !active; active = true; }

    return active;
  }

  var demandTick = 0;
  function demand() {
    var t = performance.now();
    if (t - demandTick < 60) return;
    demandTick = t;
    var mx = PITCH_X;
    for (var i = 0; i < tiles.length; i++) {
      var tl = tiles[i];
      var p = project(tl.x, tl.y, tl.z);
      var half = (tl.dw * tl.scale * p.k) * 0.9 + 8;
      var near = p.sx > -mx - half && p.sx < vw + mx + half && p.sy > -mx && p.sy < vh + mx;
      if (near) {
        if (!tl.imgURL) {
          tl.imgURL = thumbOf(tl.item);
          if (tl.imgURL) {
            tl.imgState = "loading";
            (function (tile) {
              loadImage(tile.imgURL, Math.abs(tile.x - cam.x) + Math.abs(tile.y - cam.y), function (img) {
                if (destroyed) return;
                if (!img) {
                  /* missing thumbnail -> fall back to the full poster, retried next tick */
                  var full = tile.item.poster || tile.item.url || "";
                  if (full && tile.imgURL !== full) { tile.item.thumb = full; tile.imgURL = ""; tile.imgState = ""; }
                  else tile.imgState = "error";
                  kick(); return;
                }
                tile.img = img; tile.imgState = "ready";
                if (!tile.hi) { tile.iw = img.naturalWidth; tile.ih = img.naturalHeight; fitTile(tile); }
                kick();
              });
            })(tl);
          } else tl.imgState = "error";
        }
        /* zoom-driven upgrade: on-screen width beats current source by 1.6x */
        var srcW = tl.hi ? tl.hi.naturalWidth : (tl.img ? tl.img.naturalWidth : 0);
        var screenW = tl.dw * tl.scale * p.k * dpr;
        if (srcW && screenW > srcW * 1.6 && tl.hiState !== "loading" && t - tl.hiT0 > 200) requestHi(tl, 5);
      } else if (tl.imgState === "loading" && !tl.img) {
        dropQueued(tl.imgURL);
        tl.imgURL = ""; tl.imgState = "";
      }
    }
  }

  var badgeQ = [];               /* reused every frame: no per-frame allocation */

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(vign, 0, 0, W, H);
    badgeQ.length = 0;
    liveOnScreen = false;        /* re-proved every frame, incl. the empty path */

    if (!items.length && emptyText) {
      ctx.fillStyle = "#6a6a6e";
      ctx.font = "15px " + FONT;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(emptyText, W / 2, H / 2);
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      if (SHOW_CHROME) drawChrome();
      return;
    }

    var skipRefl = cam.zoom > 2.2 || !!camTween;

    for (var oi = 0; oi < order.length; oi++) {
      var tl = tiles[order[oi]];
      if (!tl || tl.alpha <= 0.01) { if (tl) tl.vis = false; continue; }
      var p = project(tl.x, tl.y, tl.z);
      var k = p.k;
      var hw = tl.dw * tl.scale * k * 0.5;
      var hh = tl.dh * tl.scale * k * 0.5;
      var mgn = hw * 0.6 + 40;
      if (p.sx + hw + mgn < 0 || p.sx - hw - mgn > vw || p.sy + hh * 2.2 < 0 || p.sy - hh > vh) { tl.vis = false; continue; }
      tl.vis = true;
      tl.sx = p.sx; tl.sy = p.sy; tl.k = k;
      var shear = (-Math.sign(p.u) * SHEAR_K * Math.min(Math.abs(p.u), 1.6) + Math.tan(tl.rotY) * 0.55) * persAmt();
      tl.shear = shear;

      var sc = tl.scale;
      var a = k * sc, c = shear * k * sc;
      ctx.setTransform(dpr * a, 0, dpr * c, dpr * a, dpr * p.sx, dpr * p.sy);

      /* a fresh live snapshot wins over poster art; it also feeds the reflection
         below, which draws from `src`. */
      var src = tl.live || (tl.hi && tl.fade >= 1 ? tl.hi : tl.img);
      var dw = tl.dw, dh = tl.dh;

      /* reflection first (under the tile) */
      if (tl.reflect && !skipRefl && tl.alpha >= 0.5 && tl.z < 1 && src) {
        drawReflection(src, dw, dh, tl.alpha);
        ctx.setTransform(dpr * a, 0, dpr * c, dpr * a, dpr * p.sx, dpr * p.sy);
      }

      ctx.globalAlpha = tl.alpha;
      if (!src) {
        ctx.fillStyle = "#1a1a1c";
        ctx.fillRect(-dw / 2, -dh / 2, dw, dh);
        ctx.strokeStyle = "#2a2a2d";
        ctx.lineWidth = 1 / (k * sc);
        ctx.strokeRect(-dw / 2, -dh / 2, dw, dh);
      } else {
        if (tl.hi && tl.fade < 1 && !tl.live) {
          if (tl.img) ctx.drawImage(tl.img, -dw / 2, -dh / 2, dw, dh);
          ctx.globalAlpha = tl.alpha * tl.fade;
          ctx.drawImage(tl.hi, -dw / 2, -dh / 2, dw, dh);
          ctx.globalAlpha = tl.alpha;
        } else {
          ctx.drawImage(src, -dw / 2, -dh / 2, dw, dh);
        }
        if (tl.hover > 0.01 || tl.i === selected) {
          ctx.strokeStyle = "rgba(255,255,255," + (0.12 * Math.max(tl.hover, tl.i === selected ? 0.7 : 0)) + ")";
          ctx.lineWidth = 1 / (k * sc);
          ctx.strokeRect(-dw / 2 + 0.5, -dh / 2 + 0.5, dw - 1, dh - 1);
        }
      }

      /* lane edge — drawn in TILE space so it rides the shear with the poster
         it belongs to.  Widths are divided by the tile's screen scale, so the
         edge stays the same number of SCREEN pixels at zoom 0.35 and at 400. */
      if (BADGES && tl.badge && tl.badge.lane) {
        var px1 = 1 / (k * sc);
        ctx.strokeStyle = LANES[tl.badge.lane].color;
        ctx.globalAlpha = tl.alpha * 0.16;
        ctx.lineWidth = px1;
        ctx.strokeRect(-dw / 2 + px1 / 2, -dh / 2 + px1 / 2, dw - px1, dh - px1);
        ctx.globalAlpha = tl.alpha * 0.82;
        ctx.lineWidth = px1 * 2.5;
        ctx.beginPath();
        ctx.moveTo(-dw / 2, dh / 2 - px1 * 1.25);
        ctx.lineTo(dw / 2, dh / 2 - px1 * 1.25);
        ctx.stroke();
        ctx.globalAlpha = tl.alpha;
      }
      if (BADGES && tl.badge) badgeQ.push(tl);
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    if (cur && cur.labels) drawLabels(cur.labels);
    ctx.globalAlpha = 1;
    if (BADGES) drawBadges(badgeQ);
    ctx.globalAlpha = 1;
    if (SHOW_CHROME) drawChrome();
  }

  /* ==================================================================== */
  /*  BADGES — screen-space pass, after every tile has been placed.       */
  /*  Blits cached chips 1:1 device-pixel, so nothing here is ever        */
  /*  resampled, sheared or re-shaped: a chip is as crisp fully zoomed    */
  /*  out as it is filling the screen.                                    */
  /* ==================================================================== */
  var liveOnScreen = false;      /* gates the pulse — see step()/frame() */

  function drawBadges(q) {
    liveOnScreen = false;
    if (!q.length) return;
    /* one sine drives every LIVE dot on screen, so they breathe together */
    var pulse = REDUCED ? 1 : 0.42 + 0.58 * (0.5 + 0.5 * Math.cos(performance.now() / 1500 * 6.2832));
    var snap = function (v) { return Math.round(v * dpr) / dpr; };

    for (var i = 0; i < q.length; i++) {
      var tl = q[i];
      var a = tl.k * tl.scale;
      if (!(a > 0)) continue;
      var c = tl.shear * a;
      var wpx = tl.dw * a;                       /* tile width, screen px */
      var raw = wpx * 0.115;
      if (raw < CHIP_MIN - 2) continue;          /* smaller than this is lint, not information */
      var h = Math.round(clamp(raw, CHIP_MIN, CHIP_MAX));
      var fade = clamp((raw - (CHIP_MIN - 2)) / (CHIP_FADE - (CHIP_MIN - 2)), 0, 1);

      /* tile corners through the same transform the poster was drawn with */
      var cy = tl.sy + a * (-tl.dh / 2);
      var lx = tl.sx + a * (-tl.dw / 2) + c * (-tl.dh / 2);
      var rx = tl.sx + a * (tl.dw / 2) + c * (-tl.dh / 2);
      if (cy > vh + h * 3 || cy + h * 3 < -h * 3) continue;

      var pad = Math.max(3, h * 0.26);
      var gap = Math.max(2, h * 0.26);
      var lane = tl.badge.lane;
      var wantLabel = h >= CHIP_LABEL_MIN;

      var laneChip = lane ? chipFor(dpr, h, lane, wantLabel) : null;
      var hlsChip  = tl.badge.hls  ? chipHls(dpr, h) : null;
      var liveChip = tl.badge.live ? chipLive(dpr, h, wantLabel) : null;

      /* collision ladder: words go first, then the HLS glyph. The lane chip and
         the LIVE chip are the claims themselves — they never yield. */
      var need = (laneChip ? laneChip.w : 0) + (hlsChip ? hlsChip.w + gap : 0) +
                 (liveChip ? liveChip.w + gap : 0) + pad * 2;
      if (wantLabel && need > wpx) {
        wantLabel = false;
        if (laneChip) laneChip = chipFor(dpr, h, lane, false);
        if (liveChip) liveChip = chipLive(dpr, h, false);
        need = (laneChip ? laneChip.w : 0) + (hlsChip ? hlsChip.w + gap : 0) +
               (liveChip ? liveChip.w + gap : 0) + pad * 2;
      }
      if (hlsChip && need > wpx) hlsChip = null;

      /* the trust layer must not vanish because another tile is selected:
         a dimmed tile keeps its provenance a little brighter than its art */
      ctx.globalAlpha = clamp(tl.alpha * 1.25, 0, 1) * fade;

      var x = snap(lx + pad), y = snap(cy + pad);
      if (laneChip) {
        ctx.drawImage(laneChip.c, x, y, laneChip.w, laneChip.h);
        x += laneChip.w + gap;
      }
      if (hlsChip) {
        ctx.drawImage(hlsChip.c, snap(x), y, hlsChip.w, hlsChip.h);
        x += hlsChip.w + gap;
      }
      if (liveChip) {
        liveOnScreen = true;
        var vx = snap(rx - pad - liveChip.w);
        ctx.drawImage(liveChip.c, vx, y, liveChip.w, liveChip.h);
        /* the dot is painted per frame over the cached body: the pulse costs
           one arc, never a re-rasterised chip */
        var gs = Math.round(h * 0.58);
        var dcx = vx + (wantLabel ? h * 0.30 + gs / 2 : liveChip.w / 2);
        var dcy = y + h / 2;
        var base = ctx.globalAlpha;
        ctx.fillStyle = LIVE_COLOR;
        if (!REDUCED) {
          ctx.globalAlpha = base * 0.30 * pulse;
          ctx.beginPath(); ctx.arc(dcx, dcy, gs * 0.52 * (0.75 + 0.25 * pulse), 0, 6.2832); ctx.fill();
        }
        ctx.globalAlpha = base * (REDUCED ? 1 : 0.65 + 0.35 * pulse);
        ctx.beginPath(); ctx.arc(dcx, dcy, gs * 0.29, 0, 6.2832); ctx.fill();
        ctx.globalAlpha = base;
      }
    }
    ctx.globalAlpha = 1;
  }

  /* world-anchored group labels — the one thing a layout may ask the
     renderer to draw beyond its tiles */
  function drawLabels(labels) {
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    for (var i = 0; i < labels.length; i++) {
      var L = labels[i];
      if (!L || !L.text) continue;
      var p = project(L.x, L.y, 0);
      var size = clamp(13 * p.k, 7, 26);
      if (p.sy < -size || p.sy > vh + size) continue;
      /* a registry lane row header wears the lane's ink and a colour dot, so a
         row and the chips on its tiles read as one statement */
      var lane = BADGES ? laneOf(L.text) : null;
      var text = lane ? stripLanePrefix(L.text) : L.text;
      ctx.font = size + "px " + FONT;
      var w = ctx.measureText(text).width;
      var dotW = lane ? size * 1.05 : 0;
      if (p.sx > vw || p.sx + w + dotW < 0) continue;
      ctx.globalAlpha = selected != null ? 0.45 : 0.9;
      if (lane) {
        ctx.fillStyle = LANES[lane].color;
        ctx.beginPath();
        ctx.arc(p.sx + size * 0.30, p.sy - size * 0.30, size * 0.26, 0, 6.2832);
        ctx.fill();
      }
      ctx.fillStyle = lane ? "#b9b9c0" : "#8a8a8e";
      ctx.fillText(text, p.sx + dotW, p.sy);
    }
    ctx.globalAlpha = 1;
  }

  function drawReflection(src, dw, dh, alpha) {
    var S = Math.min(refl.width / dw, refl.height / dh);
    reflCtx.setTransform(1, 0, 0, 1, 0, 0);
    reflCtx.clearRect(0, 0, refl.width, refl.height);
    reflCtx.setTransform(S, 0, 0, S, 0, 0);
    reflCtx.globalCompositeOperation = "source-over";
    reflCtx.globalAlpha = 1;
    reflCtx.save();
    reflCtx.translate(0, dh);
    reflCtx.scale(1, -1);
    reflCtx.drawImage(src, 0, 0, dw, dh);
    reflCtx.restore();
    reflCtx.globalCompositeOperation = "destination-out";
    reflCtx.drawImage(ramp, 0, 0, 1, 64, 0, 0, dw, dh * 0.62);
    reflCtx.fillStyle = "#000";
    reflCtx.fillRect(0, dh * 0.62, dw, dh * 0.4);
    reflCtx.globalCompositeOperation = "source-over";

    ctx.globalAlpha = 0.30 * alpha;
    ctx.drawImage(refl, 0, 0, Math.ceil(dw * S), Math.ceil(dh * S), -dw / 2, dh / 2 + 2, dw, dh);
    ctx.globalAlpha = 1;
  }

  /* ==================================================================== */
  /*  CHROME                                                              */
  /* ==================================================================== */
  var hit = { arrowL: null, arrowR: null, track: null, thumb: null, pills: [], dots: [], order: [], fs: null };

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function drawChrome() {
    var g = ctx;
    g.textAlign = "left"; g.textBaseline = "alphabetic";

    /* ---- nav arrows ---- */
    hit.arrowL = { cx: 18, cy: vh / 2, r: 43 };
    hit.arrowR = { cx: W - 18, cy: vh / 2, r: 43 };
    drawArrow(hit.arrowL, -1, arrowL);
    drawArrow(hit.arrowR, 1, arrowR);

    var ca = chromeAlpha;

    /* ---- scrubber ---- */
    hit.track = null; hit.thumb = null;
    var contentW = cur ? (cur.bounds.maxX - cur.bounds.minX) : 0;
    if (!panLockedX && cur) {
      var tw = 285, th = 26, tx = W / 2 - tw / 2, ty = H - 32 - th / 2;
      hit.track = { x: tx, y: ty, w: tw, h: th };
      g.globalAlpha = ca;
      g.fillStyle = C_TRACK;
      roundRect(g, tx, ty, tw, th, 13); g.fill();
      g.strokeStyle = "rgba(0,0,0,0.9)"; g.lineWidth = 1;
      roundRect(g, tx + 0.5, ty + 0.5, tw - 1, th - 1, 12.5); g.stroke();
      g.strokeStyle = "rgba(255,255,255,0.08)";
      roundRect(g, tx - 0.5, ty - 0.5, tw + 1, th + 1, 13.5); g.stroke();

      var visW = vw / cam.zoom;
      var worldW = contentW + CELL_W;
      var frac = clamp(visW / Math.max(1, worldW), 0.05, 1);
      var thw = Math.max(56, tw * frac), thh = 20;
      var range = bx.hi - bx.lo;
      var pos = range > 0 ? (cam.x - bx.lo) / range : 0;
      var thx = tx + 3 + clamp(pos, 0, 1) * (tw - 6 - thw);
      var thy = ty + (th - thh) / 2;
      hit.thumb = { x: thx, y: thy, w: thw, h: thh };
      var lg = g.createLinearGradient(0, thy, 0, thy + thh);
      lg.addColorStop(0, C_THUMB_A); lg.addColorStop(1, C_THUMB_B);
      g.fillStyle = lg;
      roundRect(g, thx, thy, thw, thh, 10); g.fill();
      g.strokeStyle = "rgba(255,255,255,0.45)"; g.lineWidth = 1;
      g.beginPath(); g.moveTo(thx + 8, thy + 0.5); g.lineTo(thx + thw - 8, thy + 0.5); g.stroke();
      /* grip: 6x3 dots, 4px pitch */
      g.fillStyle = "rgba(255,255,255,0.65)";
      var gw = 5 * 4 + 2, gh = 2 * 4 + 2;
      var gx = thx + (thw - gw) / 2, gy = thy + (thh - gh) / 2;
      for (var r0 = 0; r0 < 3; r0++) for (var c0 = 0; c0 < 6; c0++) g.fillRect(gx + c0 * 4, gy + r0 * 4, 2, 2);
      g.globalAlpha = 1;
    }

    /* ---- wordmark ---- */
    g.globalAlpha = ca;
    var wmW = 0;
    if (brand) {
      g.font = "26px " + FONT;
      g.fillStyle = "rgba(216,216,216,0.85)";
      g.fillText(brand, 32, H - 24);
      wmW = g.measureText(brand).width;
    }

    /* ---- layout pills (registry-driven: a new layout gets a pill free) ---- */
    hit.pills.length = 0;
    var px = 32 + wmW + (brand ? 22 : 0);
    var py = H - 32;
    var names = Object.keys(LAYOUTS);
    g.font = "11px " + FONT;
    for (var i = 0; i < names.length; i++) {
      var label = (PILL_LABELS[names[i]] || names[i]).toUpperCase();
      var lw = 0;
      for (var ci = 0; ci < label.length; ci++) lw += g.measureText(label[ci]).width + 1;
      var pw = lw + 20, ph = 22;
      var active = names[i] === layoutName;
      g.fillStyle = active ? C_ACCENT_ON : "rgba(255,255,255,0.05)";
      roundRect(g, px, py - ph / 2, pw, ph, 11); g.fill();
      g.fillStyle = active ? "#ffffff" : "#8a8a8e";
      var cx2 = px + 10;
      for (var cj = 0; cj < label.length; cj++) { g.fillText(label[cj], cx2, py + 4); cx2 += g.measureText(label[cj]).width + 1; }
      hit.pills.push({ x: px, y: py - ph / 2, w: pw, h: ph, name: names[i] });
      px += pw + 8;
    }

    /* ---- row stepper (wall only) ---- */
    hit.dots.length = 0;
    hit.order.length = 0;
    if (layoutName === "wall") {
      px += 10;
      for (var d = 1; d <= MAX_ROWS; d++) {
        var dx = px + (d - 1) * 12, dy = py;
        g.fillStyle = rows >= d ? C_THUMB_A : "rgba(255,255,255,0.18)";
        g.beginPath(); g.arc(dx + 4, dy, 4, 0, 6.2832); g.fill();
        hit.dots.push({ x: dx - 2, y: dy - 8, w: 12, h: 16, n: d });
      }
      if (hoverRowDot > 0) {
        g.font = "11px " + FONT;
        g.fillStyle = "#c8c8cc";
        g.fillText(hoverRowDot + " ROWS", px - 2, py - 16);
      }

      /* ---- order toggle (row-major vs column-major) ---- */
      px += MAX_ROWS * 12 + 8;
      g.font = "11px " + FONT;
      var ords = [{ n: "ltr", l: "→" }, { n: "ttb", l: "↓" }];
      for (var oi = 0; oi < ords.length; oi++) {
        var ow = g.measureText(ords[oi].l).width + 20, oh = 22;
        var oact = ords[oi].n === wallOrder;
        g.fillStyle = oact ? C_ACCENT_ON : "rgba(255,255,255,0.05)";
        roundRect(g, px, py - oh / 2, ow, oh, 11); g.fill();
        g.fillStyle = oact ? "#ffffff" : "#8a8a8e";
        g.fillText(ords[oi].l, px + 10, py + 4);
        hit.order.push({ x: px, y: py - oh / 2, w: ow, h: oh, name: ords[oi].n });
        px += ow + 8;
      }
    }

    /* ---- fullscreen glyph ---- */
    var fsx = W - 40, fsy = H - 32;
    hit.fs = { x: fsx - 14, y: fsy - 14, w: 28, h: 28 };
    var isFS = !!(document.fullscreenElement || document.webkitFullscreenElement);
    g.globalAlpha = ca * (hoverChrome === "fs" ? 1 : 0.8);
    g.strokeStyle = "#d0d0d0"; g.lineWidth = 2; g.lineCap = "round"; g.lineJoin = "round";
    drawFsGlyph(g, fsx, fsy, isFS);
    g.globalAlpha = 1;

    /* ---- selection title ---- */
    if (SHOW_TITLE && titleAlpha > 0.01 && selected != null && items[selected]) {
      /* the chip already declares the lane — the caption should not shout it
         twice. Display only: the item's own strings are never rewritten. */
      var txt = stripLanePrefix(items[selected].title || items[selected].name || "");
      var cnt = (selected + 1) + " / " + items.length;
      g.font = "15px " + FONT;
      var w1 = g.measureText(txt).width;
      g.font = "11px " + FONT;
      var w2 = g.measureText(cnt).width;
      var totw = w1 + 10 + w2;
      var bx0 = W / 2 - totw / 2 - 12, by0 = H - 76 - 17;
      g.globalAlpha = titleAlpha;
      g.fillStyle = "rgba(0,0,0,0.55)";
      roundRect(g, bx0, by0, totw + 24, 28, 8); g.fill();
      g.fillStyle = "#f0f0f0"; g.font = "15px " + FONT;
      g.fillText(txt, W / 2 - totw / 2, H - 76);
      g.fillStyle = "#8a8a8a"; g.font = "11px " + FONT;
      g.fillText(cnt, W / 2 - totw / 2 + w1 + 10, H - 76);
      g.globalAlpha = 1;
    }

    /* ---- spinner ---- */
    if (spinPending) {
      g.save();
      g.translate(W / 2, vh / 2);
      g.rotate((spinT / 0.9) * 6.2832);
      g.strokeStyle = "rgba(255,255,255,0.8)";
      g.lineWidth = 3; g.lineCap = "round";
      g.beginPath(); g.arc(0, 0, 14, 0, 4.712);
      g.stroke();
      g.restore();
    }
    g.globalAlpha = 1;
  }

  function drawArrow(a, dir, alpha) {
    if (alpha <= 0.01) return;
    var g = ctx;
    g.globalAlpha = alpha;
    g.fillStyle = hoverChrome === (dir < 0 ? "aL" : "aR") ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.06)";
    g.beginPath(); g.arc(a.cx, a.cy, a.r, 0, 6.2832); g.fill();
    g.strokeStyle = C_STROKE; g.lineWidth = 3; g.lineCap = "round"; g.lineJoin = "round";
    var ox = a.cx + dir * 12, oy = a.cy;
    g.beginPath();
    g.moveTo(ox - dir * 7, oy - 12);
    g.lineTo(ox, oy);
    g.lineTo(ox - dir * 7, oy + 12);
    g.stroke();
    g.globalAlpha = 1;
  }

  function drawFsGlyph(g, x, y, inward) {
    var s = 11;
    function corner(sx, sy) {
      g.beginPath();
      if (!inward) {
        g.moveTo(x + sx * s, y + sy * s);
        g.lineTo(x + sx * s * 0.35, y + sy * s);
        g.moveTo(x + sx * s, y + sy * s);
        g.lineTo(x + sx * s, y + sy * s * 0.35);
        g.moveTo(x + sx * s, y + sy * s);
        g.lineTo(x + sx * s * 0.15, y + sy * s * 0.15);
      } else {
        g.moveTo(x + sx * s * 0.35, y + sy * s * 0.35);
        g.lineTo(x + sx * s * 0.35, y + sy * s);
        g.moveTo(x + sx * s * 0.35, y + sy * s * 0.35);
        g.lineTo(x + sx * s, y + sy * s * 0.35);
        g.moveTo(x + sx * s * 0.35, y + sy * s * 0.35);
        g.lineTo(x + sx * s, y + sy * s);
      }
      g.stroke();
    }
    corner(-1, -1); corner(1, 1);
  }

  /* ==================================================================== */
  /*  LOOP                                                                */
  /* ==================================================================== */
  function kick() {
    if (destroyed) return;
    if (!running) { running = true; lastT = performance.now(); rafId = requestAnimationFrame(frame); }
    else pendingDirty = true;
  }

  function frame(now) {
    if (destroyed) { running = false; return; }
    /* If the wall is otherwise still and the only moving thing is a LIVE pulse,
       cap it at ~24fps. The pulse is a 1.5s sine — nobody can see the
       difference — and the idle cost of a live tile drops by ~60%. */
    if (livePulseOnly && !pendingDirty && !dragging && !scrubbing && now - lastT < 41) {
      rafId = requestAnimationFrame(frame);
      return;
    }
    var dt = (now - lastT) / 1000;
    if (dt > 0.05) dt = 0.05;
    if (dt < 0) dt = 0;
    lastT = now;
    var active = step(dt);
    draw();
    if (active || pendingDirty || dragging || scrubbing) {
      pendingDirty = false;
      rafId = requestAnimationFrame(frame);
    } else {
      running = false;
    }
  }

  /* ==================================================================== */
  /*  INPUT                                                               */
  /* ==================================================================== */
  var dragging = false, scrubbing = false;
  var dragId = -1, dragPX = 0, dragPY = 0, dragMoved = 0, dragT = 0;
  var pointers = new Map();
  var pinchDist = 0;
  var scrubOffset = 0;

  function localPt(e) {
    var r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function inRect(p, r) { return !!r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h; }
  function inCircle(p, c) { if (!c) return false; var dx = p.x - c.cx, dy = p.y - c.cy; return dx * dx + dy * dy <= c.r * c.r; }

  function tileAt(p) {
    for (var oi = order.length - 1; oi >= 0; oi--) {
      var tl = tiles[order[oi]];
      if (!tl || !tl.vis || tl.alpha < 0.15) continue;
      var a = tl.k * tl.scale, c = tl.shear * tl.k * tl.scale;
      if (Math.abs(a) < 1e-6) continue;
      var ly = (p.y - tl.sy) / a;
      var lx = (p.x - tl.sx - c * ly) / a;
      if (Math.abs(lx) <= tl.dw / 2 && Math.abs(ly) <= tl.dh / 2) return tl.i;
    }
    return -1;
  }

  function pumpChromeIdle() {
    chromeTarget = 1;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { chromeTarget = 0.25; kick(); }, 2500);
    kick();
  }

  function onPointerDown(e) {
    canvas.focus({ preventScroll: true });
    var p = localPt(e);
    pointers.set(e.pointerId, p);
    pumpChromeIdle();

    if (pointers.size === 2) {
      var arr = Array.from(pointers.values());
      pinchDist = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
      dragging = false;
      return;
    }

    /* chrome first */
    if (SHOW_CHROME) {
      if (inCircle(p, hit.arrowL) && arrowL > 0.2) { page(-1); return; }
      if (inCircle(p, hit.arrowR) && arrowR > 0.2) { page(1); return; }
      if (inRect(p, hit.fs)) { toggleFullscreen(); return; }
      for (var i = 0; i < hit.pills.length; i++) if (inRect(p, hit.pills[i])) { setLayout(hit.pills[i].name); return; }
      for (var j = 0; j < hit.dots.length; j++) if (inRect(p, hit.dots[j])) { setRows(hit.dots[j].n); return; }
      for (var m = 0; m < hit.order.length; m++) if (inRect(p, hit.order[m])) { setOrder(hit.order[m].name); return; }
      if (inRect(p, hit.track)) {
        scrubbing = true; dragId = e.pointerId;
        try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
        if (inRect(p, hit.thumb)) scrubOffset = p.x - hit.thumb.x - hit.thumb.w / 2;
        else { scrubOffset = 0; scrubTo(p.x, true); }
        kick();
        return;
      }
    }

    dragging = true; dragId = e.pointerId;
    dragPX = p.x; dragPY = p.y; dragMoved = 0; dragT = performance.now();
    camVel.x = camVel.y = 0; camTween = null;
    try { canvas.setPointerCapture(e.pointerId); } catch (err2) {}
    canvas.style.cursor = "grabbing";
    kick();
  }

  function onPointerMove(e) {
    var p = localPt(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    pumpChromeIdle();

    /* pinch */
    if (pointers.size === 2) {
      var arr = Array.from(pointers.values());
      var d = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
      var mx = (arr[0].x + arr[1].x) / 2, my = (arr[0].y + arr[1].y) / 2;
      if (pinchDist > 0) zoomAt(mx, my, d / pinchDist);
      pinchDist = d;
      return;
    }

    if (scrubbing && e.pointerId === dragId) { scrubTo(p.x - scrubOffset, false); return; }

    if (dragging && e.pointerId === dragId) {
      var dx = p.x - dragPX, dy = p.y - dragPY;
      dragPX = p.x; dragPY = p.y;
      dragMoved += Math.abs(dx) + Math.abs(dy);
      var t = performance.now();
      var dt = Math.max(0.001, (t - dragT) / 1000); dragT = t;

      /* free pan: every zoom level, no lock, no rubber-band, no clamp */
      var wdx = -dx / cam.zoom;
      camVel.x = camVel.x * 0.4 + (wdx / dt) * 0.6;
      cam.x += wdx;
      var wdy = -dy / cam.zoom;
      camVel.y = camVel.y * 0.4 + (wdy / dt) * 0.6;
      cam.y += wdy;
      kick();
      return;
    }

    /* hover */
    arrowLT = (!panLockedX && p.x < 96 && cam.x > bx.lo + 1) || (cur && cur.flags.pageSelect && p.x < 96) ? 1 : 0;
    arrowRT = (!panLockedX && p.x > W - 96 && cam.x < bx.hi - 1) || (cur && cur.flags.pageSelect && p.x > W - 96) ? 1 : 0;

    var hc = null;
    if (SHOW_CHROME) {
      if (inCircle(p, hit.arrowL) && arrowLT) hc = "aL";
      else if (inCircle(p, hit.arrowR) && arrowRT) hc = "aR";
      else if (inRect(p, hit.fs)) hc = "fs";
    }
    hoverChrome = hc;
    var hd = 0;
    for (var j = 0; j < hit.dots.length; j++) if (inRect(p, hit.dots[j])) hd = hit.dots[j].n;
    hoverRowDot = hd;

    var ht = hc ? -1 : tileAt(p);
    if (ht !== hoverTile) {
      if (hoverTile >= 0 && tiles[hoverTile]) tiles[hoverTile].hover = 0;
      hoverTile = ht;
      if (ht >= 0) tiles[ht].hover = 1;
      applyTargets();
      if (cbHover) { try { cbHover(ht >= 0 ? items[ht] : null, ht); } catch (err) {} }
    }
    canvas.style.cursor = (ht >= 0 || hc) ? "pointer" : (dragging ? "grabbing" : "grab");
    kick();
  }

  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (e.pointerId !== dragId) return;
    var wasDrag = dragging, moved = dragMoved;
    dragging = false; scrubbing = false; dragId = -1;
    canvas.style.cursor = "grab";
    if (wasDrag && moved <= 6) {
      var p = localPt(e);
      var ti = tileAt(p);
      if (ti >= 0) toggleSelect(ti, true);
      else if (selected != null) deselect();
    }
    kick();
  }

  function onPointerLeave() {
    arrowLT = arrowRT = 0;
    if (hoverTile >= 0 && tiles[hoverTile]) {
      tiles[hoverTile].hover = 0; hoverTile = -1; applyTargets();
      if (cbHover) { try { cbHover(null, -1); } catch (err) {} }
    }
    kick();
  }

  /* ---- wheel zoom, anchored at the cursor ---- */
  function onWheel(e) {
    var p = localPt(e);
    /* two-finger horizontal scroll pans; dominant axis wins; ctrl = pinch zoom */
    if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      camTween = null;
      cam.x += e.deltaX / cam.zoom;
      camVel.x = camVel.y = 0;
      e.preventDefault();
      pumpChromeIdle();
      kick();
      return;
    }
    var f = e.ctrlKey ? Math.exp(-e.deltaY * 0.01) : Math.exp(-e.deltaY * 0.0015);
    var applied = zoomAt(p.x, p.y, f);
    if (applied) e.preventDefault();
    pumpChromeIdle();
  }

  function zoomAt(px, py, factor) {
    var z0 = cam.zoom;
    var z1 = clamp(z0 * factor, ZOOM_MIN, ZOOM_MAX);
    if (Math.abs(z1 - z0) < 1e-6) return false;
    camTween = null;
    var w0 = screenToWorld(px, py); var w0x = w0.x, w0y = w0.y;
    cam.zoom = z1;
    var w1 = screenToWorld(px, py);
    cam.x += w0x - w1.x;
    cam.y += w0y - w1.y;
    computeBounds();
    if (cur && cur.flags.springCenter) {
      cam.x = clamp(cam.x, bx.lo, bx.hi);
      cam.y = clamp(cam.y, by.lo, by.hi);
    }
    camVel.x = camVel.y = 0;
    kick();
    return true;
  }

  /* ---- scrubber ---- */
  function scrubTo(px, tween) {
    if (!hit.track || panLockedX) return;
    var tw = hit.track.w, thw = hit.thumb ? hit.thumb.w : 56;
    var travel = tw - 6 - thw;
    var f = travel > 0 ? clamp((px - hit.track.x - 3 - thw / 2) / travel, 0, 1) : 0;
    var target = bx.lo + f * (bx.hi - bx.lo);
    if (tween) flyTo(target, cam.y, cam.zoom, 250, easeInOutCubic);
    else { camTween = null; cam.x = target; camVel.x = 0; }
    kick();
  }

  /* ---- select / deselect ---- */
  function toggleSelect(i, notify) { if (selected === i) deselect(); else select(i, notify); }

  function select(i, notify) {
    if (i < 0 || i >= items.length) return;
    var relayouts = cur && cur.flags.selectRelayouts;
    if (selected == null) savedCam = { x: cam.x, y: cam.y, zoom: cam.zoom };
    selected = i;
    titleTarget = 1;
    var dur = relayouts ? 480 : 350;
    if (relayouts) {
      relayout(false);
    } else {
      applyTargets();
      var t = tiles[i];
      var z = clamp((0.62 * vh) / Math.max(1, t.dh), 1, ZOOM_MAX);
      flyTo(cur.targets[i].x, cur.targets[i].y, z, dur, easeOutCubic);
    }
    requestHi(tiles[i], 0);
    if (tiles[i - 1]) requestHi(tiles[i - 1], 1);
    if (tiles[i + 1]) requestHi(tiles[i + 1], 1);
    /* the callback fires AFTER the fly-to completes */
    if (notify && cbSelect) { pendingNotify = i; pendingNotifyAt = performance.now() + (REDUCED ? 60 : dur + 30); }
    kick();
  }

  function deselect() {
    if (selected == null) return;
    var was = selected;
    selected = null;
    titleTarget = 0;
    pendingNotify = null;
    if (cur && cur.flags.selectRelayouts) relayout(false);
    else {
      applyTargets();
      if (savedCam) flyTo(savedCam.x, savedCam.y, savedCam.zoom, 320, easeInOutCubic);
    }
    savedCam = null;
    if (cbDeselect) { try { cbDeselect(items[was] || null, was); } catch (e) {} }
    kick();
  }

  /* ---- paging ---- */
  function page(dir) {
    if (!cur) return;
    if (cur.flags.pageSelect) { selectNearby(dir); return; }
    var unit = cur.pageUnit || cur.pageStep || PITCH_X;
    var stepW = Math.max(unit, Math.floor((vw / cam.zoom) / unit) * unit);
    var target = clamp(cam.x + dir * stepW, bx.lo, bx.hi);
    flyTo(target, cam.y, cam.zoom, 420, easeInOutCubic);
    arrowLT = arrowRT = 1;
    clearTimeout(arrowTimer);
    arrowTimer = setTimeout(function () { arrowLT = arrowRT = 0; kick(); }, 900);
  }

  function selectNearby(dir) {
    if (!items.length) return;
    var n = selected == null ? (dir > 0 ? 0 : items.length - 1) : clamp(selected + dir, 0, items.length - 1);
    select(n, false);
  }

  /* ---- keyboard ---- */
  function onKeyDown(e) {
    var k = e.key;
    pumpChromeIdle();
    if (k === "Escape") { deselect(); e.preventDefault(); return; }
    if (k === "Enter") {
      if (selected != null && cbSelect) { try { cbSelect(items[selected], selected); } catch (er) {} }
      e.preventDefault(); return;
    }
    if (k === "ArrowLeft") { selected != null ? selectNearby(-1) : page(-1); e.preventDefault(); return; }
    if (k === "ArrowRight") { selected != null ? selectNearby(1) : page(1); e.preventDefault(); return; }
    if (k === "ArrowUp" || k === "ArrowDown") {
      if (selected != null && layoutName === "wall") {
        var d = k === "ArrowUp" ? -1 : 1;
        var cols = (cur && cur.cols) || 1;
        var ttb = wallOrder === "ttb";
        var col = ttb ? (selected / rows) | 0 : selected % cols;
        var row = ttb ? selected % rows : (selected / cols) | 0;
        var nr = clamp(row + d, 0, rows - 1);
        var ni = ttb ? col * rows + nr : nr * cols + col;
        if (ni < items.length) select(ni, false);
      } else page(k === "ArrowUp" ? -1 : 1);
      e.preventDefault(); return;
    }
    if (k === "Home") { selected != null ? select(0, false) : flyTo(bx.lo, cam.y, cam.zoom, 420, easeInOutCubic); e.preventDefault(); return; }
    if (k === "End") { selected != null ? select(items.length - 1, false) : flyTo(bx.hi, cam.y, cam.zoom, 420, easeInOutCubic); e.preventDefault(); return; }
    if (k === "f" || k === "F") { toggleFullscreen(); e.preventDefault(); return; }
    if (k === "+" || k === "=") { zoomAt(vw / 2, vh / 2, 1.25); e.preventDefault(); return; }
    if (k === "-" || k === "_") { zoomAt(vw / 2, vh / 2, 1 / 1.25); e.preventDefault(); return; }
    if (k >= "1" && k <= String(MAX_ROWS)) { setRows(parseInt(k, 10)); e.preventDefault(); return; }
    if (k === "w" || k === "W") { setLayout("wall"); e.preventDefault(); return; }
    if (k === "h" || k === "H") { setLayout("hero"); e.preventDefault(); return; }
    if (k === "s" || k === "S") { setLayout("spiral"); e.preventDefault(); return; }
    if (k === "c" || k === "C") { setLayout("catalogRows"); e.preventDefault(); return; }
    if (k === "o" || k === "O") { setOrder(wallOrder === "ltr" ? "ttb" : "ltr"); e.preventDefault(); return; }
  }

  /* ---- fullscreen ---- */
  function toggleFullscreen() {
    var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); }
    else {
      var rq = container.requestFullscreen || container.webkitRequestFullscreen;
      if (rq) rq.call(container);
    }
  }
  function onFsChange() { setTimeout(resize, 60); }

  /* ---- resize ---- */
  function onResize() {
    clearTimeout(rzTimer);
    rzTimer = setTimeout(function () {
      resize();
      if (selected != null && tiles[selected]) requestHi(tiles[selected], 0);
    }, 100);
  }

  /* ---- setters ---- */
  function setLayout(name) {
    if (!LAYOUTS[name] || name === layoutName) return;
    layoutName = name;
    /* picking a layout is an arrival: frame the new shape rather than leaving
       the camera pointed at where the old shape used to be */
    relayout(false, true);
  }
  function setRows(n) {
    n = clamp(n | 0, 1, MAX_ROWS);
    if (layoutName !== "wall") { rows = n; return; }
    if (n === rows) return;
    rows = n;
    relayout(false);
  }
  function setOrder(o) {
    if (o !== "ltr" && o !== "ttb") return;
    if (o === wallOrder) return;
    wallOrder = o;
    if (layoutName === "wall") relayout(false); else kick();
  }

  /* ---- listeners ---- */
  var LISTENERS = [
    [canvas, "pointerdown", onPointerDown, undefined],
    [canvas, "pointermove", onPointerMove, undefined],
    [canvas, "pointerup", onPointerUp, undefined],
    [canvas, "pointercancel", onPointerUp, undefined],
    [canvas, "pointerleave", onPointerLeave, undefined],
    [canvas, "wheel", onWheel, { passive: false }],
    [canvas, "keydown", onKeyDown, undefined],
    [document, "fullscreenchange", onFsChange, undefined],
    [document, "webkitfullscreenchange", onFsChange, undefined],
    [global, "resize", onResize, undefined]
  ];
  for (var li = 0; li < LISTENERS.length; li++) {
    LISTENERS[li][0].addEventListener(LISTENERS[li][1], LISTENERS[li][2], LISTENERS[li][3]);
  }
  var ro = null;
  if (global.ResizeObserver) { ro = new ResizeObserver(onResize); ro.observe(container); }

  /* ==================================================================== */
  /*  PUBLIC API                                                          */
  /* ==================================================================== */
  this.setItems = function (list) { setItems(list); return this; };
  this.getItems = function () { return items.slice(); };
  this.layout = function (name) { if (name == null) return layoutName; setLayout(name); return this; };
  this.setRows = function (n) { setRows(n); return this; };
  this.setOrder = function (o) { setOrder(o); return this; };
  this.onSelect = function (cb) { cbSelect = typeof cb === "function" ? cb : null; return this; };
  this.onHover = function (cb) { cbHover = typeof cb === "function" ? cb : null; return this; };
  this.onDeselect = function (cb) { cbDeselect = typeof cb === "function" ? cb : null; return this; };
  this.onLayout = function (cb) { cbLayout = typeof cb === "function" ? cb : null; return this; };
  this.focusIndex = function (i) { select(i | 0, false); return this; };
  this.selectIndex = function (i, notify) { select(i | 0, notify !== false); return this; };
  this.deselect = function () { deselect(); return this; };
  this.getSelected = function () { return selected == null ? null : { item: items[selected], index: selected }; };
  /* Restore a saved camera. Applies NOW and pins itself against the next home-arrival
     framing (content often lands after boot and would otherwise re-home the view). */
  this.setCamera = function (c) {
    if (!c || !isFinite(+c.x) || !isFinite(+c.y) || !(+c.zoom > 0)) return this;
    cam.x = +c.x; cam.y = +c.y; cam.zoom = +c.zoom;
    camTween = null; camVel.x = 0; camVel.y = 0;
    pendingCam = { x: cam.x, y: cam.y, zoom: cam.zoom };
    kick(); return this;
  };
  this.showSpinner = function (on) { spinnerOn = !!on; kick(); return this; };
  this.setEmptyText = function (s) { emptyText = s || ""; kick(); return this; };
  this.setBrand = function (s) { brand = s == null ? "" : s; kick(); return this; };
  this.setHiResURL = function (fn) { if (typeof fn === "function") hiResURL = fn; return this; };
  this.setLiveThumbURL = function (fn) { if (typeof fn === "function") { liveThumbURL = fn; for (var i = 0; i < tiles.length; i++) tiles[i].liveBase = undefined; } return this; };
  function liveActive() { return !REDUCED && (livePreview || (livePins && livePins.size > 0)); }
  function ensureLiveDriver() {
    if (liveActive()) {
      if (!liveTimer) liveTimer = setInterval(liveTick, LIVE_TICK);
    } else {
      if (liveTimer) { clearInterval(liveTimer); liveTimer = 0; }
      for (var i = 0; i < tiles.length; i++) clearLive(tiles[i]);
      kick();                              /* repaint back to the poster art */
    }
  }
  this.setLivePreview = function (on) {
    on = !!on && !REDUCED;                 /* reduced-motion never animates previews */
    if (on !== livePreview) { livePreview = on; ensureLiveDriver(); }
    return this;
  };
  /* selective live previews: only tiles whose item.id is in `ids` keep refreshing
     (the pinned hover set). Passing null/[] reverts to the setLivePreview(all) rule.
     Tiles that just left the set drop their live frame back to the static cover. */
  this.setLivePins = function (ids) {
    livePins = (ids && ids.length) ? (ids instanceof Set ? ids : new Set(ids)) : null;
    if (livePins) {
      for (var i = 0; i < tiles.length; i++) {
        var it = tiles[i].item;
        if (it && !livePins.has(it.id)) clearLive(tiles[i]);
      }
    }
    ensureLiveDriver();
    return this;
  };
  /* one-shot: refresh every visible live cover once, right now — the "update covers"
     button. Independent of the continuous driver; the fresh frame sticks. */
  this.refreshCoversOnce = function () {
    if (REDUCED) return this;
    var now = performance.now();
    for (var i = 0; i < tiles.length; i++) {
      var tl = tiles[i];
      if (tl.vis && liveThumbBase(tl) && !tl.liveInflight) refreshLive(tl, now, true);
    }
    return this;
  };
  this.getLivePreview = function () { return livePreview; };
  this.resize = function () { resize(); return this; };
  this.getState = function () {
    return {
      cam: { x: Math.round(cam.x * 100) / 100, y: Math.round(cam.y * 100) / 100, zoom: Math.round(cam.zoom * 1000) / 1000 },
      layout: layoutName, rows: rows, order: wallOrder, selected: selected,
      groups: cur && cur.groups ? cur.groups : null,
      labels: cur && cur.labels ? cur.labels.map(function (L) { return { text: L.text, x: Math.round(L.x), y: Math.round(L.y) }; }) : null,
      items: items.length, running: running, panLockedX: panLockedX, destroyed: destroyed,
      livePreview: livePreview,
      live: (function () {
        var cap = 0, shown = 0, vis = 0;
        for (var i = 0; i < tiles.length; i++) {
          var t = tiles[i];
          if (t.liveBase) cap++;
          if (t.live) shown++;
          if (t.live && t.vis) vis++;
        }
        return { capable: cap, snapped: shown, visibleSnapped: vis };
      })(),
      cell: { w: CELL_W, h: CELL_H },
      badges: (function () {
        /* BUDGETS row 6 is verifiable from here: every registry item must
           carry its lane. `missing` is the number that do not. */
        var n = 0, lane = 0, live = 0, hls = 0;
        for (var i = 0; i < tiles.length; i++) {
          var b = tiles[i].badge;
          if (!b) continue;
          n++; if (b.lane) lane++; if (b.live) live++; if (b.hls) hls++;
        }
        return { enabled: BADGES, badged: n, withLane: lane, live: live, hls: hls, pulsing: liveOnScreen && !REDUCED };
      })(),
      tiles: tiles.map(function (t) {
        /* `scale` is the tile's own layout scale (0.34–1.15 across layouts);
           a DOM overlay anchored to a tile needs it alongside k, or it drifts */
        return { i: t.i, sx: Math.round(t.sx), sy: Math.round(t.sy), k: Math.round(t.k * 1000) / 1000,
                 scale: Math.round(t.scale * 1000) / 1000,
                 dw: Math.round(t.dw), dh: Math.round(t.dh), vis: t.vis, src: t.hi ? t.hi.naturalWidth : (t.img ? t.img.naturalWidth : 0),
                 badge: t.badge ? { lane: t.badge.lane, hls: t.badge.hls, live: t.badge.live } : null };
      })
    };
  };
  this.destroy = function () {
    if (destroyed) return;
    destroyed = true;
    for (var i = 0; i < LISTENERS.length; i++) {
      LISTENERS[i][0].removeEventListener(LISTENERS[i][1], LISTENERS[i][2], LISTENERS[i][3]);
    }
    if (ro) { try { ro.disconnect(); } catch (e) {} ro = null; }
    clearTimeout(idleTimer); clearTimeout(arrowTimer); clearTimeout(rzTimer);
    if (liveTimer) { clearInterval(liveTimer); liveTimer = 0; }
    if (rafId) cancelAnimationFrame(rafId);
    running = false; rafId = 0;
    cache.forEach(function (e) { if (e.el) { e.el.onload = null; e.el.onerror = null; e.el.src = ""; } });
    cache.clear(); queue.length = 0; hiLRU.length = 0;
    tiles = []; items = []; order = []; cur = null;
    cbSelect = cbHover = cbDeselect = cbLayout = null;
    canvas.style.cursor = "";
  };
  this.layouts = LAYOUTS;

  /* ---- boot ---- */
  resize();
  pumpChromeIdle();
  if (opts.items) setItems(opts.items);
  if (opts.livePreview) self.setLivePreview(true);
  if (opts.autofocus !== false) { try { canvas.focus({ preventScroll: true }); } catch (e) {} }
}

WallView.layouts = BUILTIN_LAYOUTS;
global.WallView = WallView;

})(typeof window !== "undefined" ? window : this);
