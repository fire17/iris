"use strict";
/* =========================================================================
   CoolStremio — app.js
   Owns: state · hash routing · views (board / search / detail / settings)
         library + continue-watching (localStorage) · toasts · keyboard.

   Depends (all OPTIONAL at load time, feature-detected and polled):
     window.Addons   — data layer            (js/addons.js)
     window.WallView — canvas wall engine    (js/wallview.js)
     window.Player   — video overlay         (js/player.js)

   Contract (ARCHITECTURE.md) is law; nothing here reaches into a sibling
   module's internals. Missing modules degrade to a visible loading state or
   a DOM fallback — never a crash, never a console error.
   ========================================================================= */
(function () {

/* ------------------------------------------------------------------ keys */
var LS_LIB  = "cs.library";
var LS_CONT = "cw";          /* SHARED with player.js — array of records, its shape wins */
var LS_UI   = "cs.ui";

var SEARCH_DEBOUNCE = 250;
var SEARCH_MIN      = 2;
var NEAR_END        = 24;    /* prefetch when hover gets this close to the tail */
var MAX_ITEMS       = 1500;  /* hard stop for infinite scroll */
var HOME_ROWS       = 8;     /* catalog rows on the home view */
var HOME_ROW_ITEMS  = 40;    /* items kept per home row */

/* hover motion preview + live-stream resolver */
var PREVIEW_DEBOUNCE = 180;  /* ms of steady hover before a preview starts */
var PREVIEW_TTL      = 12000;/* re-resolve a live token this often (resolver grace is 30s+,
                                but tokens are single-shot — keep well under it) */
var RESOLVER_BASE    = "http://127.0.0.1:11471";  /* hp-resolver service (optional) */

/* ----------------------------------------------------------------- state */
var S = {
  view: "board",
  ready: false,

  addons: [],
  catalogs: [],
  types: [],
  type: null,
  cat: null,            /* {addonId,type,id,name,extra} */

  items: [],            /* board items */
  skip: 0,
  loading: false,
  exhausted: false,

  q: "",
  results: [],
  searchSeq: 0,
  searching: false,

  detail: null,         /* {type,id,meta,season,video} */
  detailSeq: 0,

  homeGroups: [],       /* [{key,name,cat,items}] in row order */
  homeSeq: 0,

  wallList: [],         /* exactly what was last handed to WallView.setItems */

  library: {},
  cont: [],

  wall: null,
  wallMode: null        /* "canvas" | "grid" */
};

var searchCache = new Map();   /* q -> [meta]   (instant re-render) */
var homeCache   = new Map();   /* catalog key -> [meta]  (instant home revisit) */
var metaCache   = new Map();   /* type:id -> meta */
var searchTimer = null;

/* ------------------------------------------------------------------ dom */
var D = {};
function $(id) { return document.getElementById(id); }

function cacheDom() {
  [ "app","topbar","search-input","search-clear","gate","gate-list",
    "catalogbar","typepills","catpills","catcount","loadmore",
    "continue","cw-row","cw-clear",
    "stage","wall","grid","skeleton","empty","empty-title","empty-body","empty-actions",
    "searchstatus",
    "detail","d-backdrop","d-close","d-scroll","d-poster","d-poster-sk","d-title","d-meta",
    "d-genres","d-desc","d-cast","d-play","d-lib","d-ext","d-series","d-seasons","d-episodes",
    "d-epcount","d-streams","d-streams-body","d-streams-for","d-streams-reload",
    "settings","s-close","s-url","s-preview","s-preview-card","s-list","s-count",
    "s-libcount","s-cwcount","s-reset",
    "toasts"
  ].forEach(function (id) { D[id.replace(/-/g, "_")] = $(id); });
}

/* --------------------------------------------------------------- helpers */
function txt(v) { return v == null ? "" : String(v); }
function esc(v) {
  return txt(v).replace(/[&<>"']/g, function (c) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
  });
}
function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function show(node, on) { if (node) node.hidden = !on; }
function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

function lsGet(key, dflt) {
  try {
    var raw = localStorage.getItem(key);
    if (!raw) return dflt;
    var v = JSON.parse(raw);
    if (v == null || typeof v !== "object") return dflt;
    if (Array.isArray(dflt) !== Array.isArray(v)) return dflt;
    return v;
  } catch (e) { return dflt; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* quota/private mode */ }
}

function key(type, id) { return txt(type) + ":" + txt(id); }
function enc(v) { return encodeURIComponent(txt(v)); }
function dec(v) { try { return decodeURIComponent(txt(v)); } catch (e) { return txt(v); } }

/** Resolve a value that may be a plain value or a promise, never throwing. */
function settle(v) {
  try { return Promise.resolve(v).catch(function () { return null; }); }
  catch (e) { return Promise.resolve(null); }
}
/** Call an optional module method defensively. */
function call(obj, name) {
  if (!obj || typeof obj[name] !== "function") return Promise.resolve(null);
  var args = Array.prototype.slice.call(arguments, 2);
  try { return settle(obj[name].apply(obj, args)); }
  catch (e) { return Promise.resolve(null); }
}
function arr(v) { return Array.isArray(v) ? v : []; }

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(s).padStart(2, "0");
}
function fmtRuntime(r) {
  if (!r) return "";
  if (typeof r === "string") return r;
  return r >= 60 ? Math.floor(r / 60) + "h " + (r % 60) + "m" : r + " min";
}
function year(meta) {
  var y = meta && (meta.year || meta.releaseInfo || meta.released);
  if (!y) return "";
  y = String(y);
  var m = y.match(/\d{4}(\s*[-–]\s*\d{0,4})?/);
  return m ? m[0] : "";
}

/* ---------------------------------------------------------------- toasts */
function toast(msg, kind, title) {
  if (!D.toasts) return;
  var t = el("div", "toast " + (kind || "info"));
  var body = el("div");
  if (title) body.appendChild(el("b", null, title));
  body.appendChild(document.createTextNode(txt(msg)));
  t.appendChild(body);
  var x = el("button", "toast-x", "✕");
  x.type = "button";
  x.addEventListener("click", function () { kill(); });
  t.appendChild(x);
  D.toasts.appendChild(t);

  var timer = setTimeout(kill, kind === "err" ? 7000 : 4200);
  function kill() {
    clearTimeout(timer);
    if (!t.parentNode) return;
    t.classList.add("out");
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 220);
  }
  /* cap the stack */
  while (D.toasts.children.length > 4) D.toasts.removeChild(D.toasts.firstChild);
}

/* ================================================================== boot */
document.addEventListener("DOMContentLoaded", boot);

function boot() {
  cacheDom();
  S.library = lsGet(LS_LIB, {});
  S.cont    = cwList();

  bindChrome();
  bindKeys();
  bindDetail();
  bindSettings();
  bindExternalProgress();

  renderContinue();
  expose();

  if (window.Addons) { start(); }
  else { openGate(); pollModules(); }
}

/* Modules may arrive late (dynamic injection / slow network). */
function pollModules() {
  var n = 0;
  var iv = setInterval(function () {
    n++;
    paintGate();
    if (window.Addons) { clearInterval(iv); start(); return; }
    if (n === 25) {   /* ~10s — tell the user what's wrong, keep waiting */
      var sub = document.querySelector(".gate-sub");
      if (sub) sub.textContent = "The data layer (js/addons.js) has not registered window.Addons yet.";
    }
  }, 400);
}

function openGate() { show(D.gate, true); paintGate(); }
function closeGate() { show(D.gate, false); }

function paintGate() {
  if (!D.gate_list || D.gate.hidden) return;
  var mods = [
    ["js/addons.js",   "Addons",   !!window.Addons],
    ["js/registry.js", "Registry", !!window.Registry],
    ["js/wallview.js", "WallView", !!window.WallView],
    ["js/player.js",   "Player",   !!window.Player]
  ];
  clear(D.gate_list);
  mods.forEach(function (m) {
    var li = el("li", m[2] ? "ok" : "");
    li.appendChild(el("span", "dot"));
    li.appendChild(el("b", null, m[0]));
    li.appendChild(el("span", null, m[2] ? "ready" : "waiting"));
    D.gate_list.appendChild(li);
  });
}

function start() {
  if (S.ready) return;
  S.ready = true;
  closeGate();

  /* the data layer reports {scope, url, message} */
  call(window.Addons, "onerror", function (err) {
    err = err || {};
    var msg = txt(err.message || err.error || err.url) || "An addon request failed.";
    var head = err.scope ? "Addon error · " + err.scope : "Addon error";
    toast(msg, "err", head);
  });

  initWall();
  bindPlayerClose();
  startTailWatch();

  /* verified_sources.md live-watch: repaint home the moment the file changes */
  if (window.Registry) {
    window.Registry.onChange(function (info) {
      if (S.view === "home") viewHome();
      if (!info.first) {
        toast(info.count + " source" + (info.count === 1 ? "" : "s") +
              (info.skipped ? " · " + info.skipped + " row" + (info.skipped === 1 ? "" : "s") + " skipped" : ""),
              info.skipped ? "err" : "info", "verified_sources.md updated");
      }
    });
  }
  window.addEventListener("hashchange", route);
  window.addEventListener("resize", onResize);
  /* a wheel/trackpad zoom/pan keeps the wall live under anchored previews — the
     pin loop reprojects each pooled overlay onto its tile through the transform,
     so DON'T tear the pool; just make sure the follow loop is running. */
  window.addEventListener("wheel", function () { pinStart(); }, { passive: true });

  /* addons.js bootstraps asynchronously (first run auto-installs Cinemeta);
     `Addons.ready` resolves when its installed set is real. */
  var ready = window.Addons.ready;
  settle(typeof ready === "function" ? ready() : ready)
    .then(refreshAddons)
    .then(function () { route(); });
}

/* ================================================================= addons */
function refreshAddons() {
  return call(window.Addons, "list").then(function (list) {
    S.addons = arr(list);
    return call(window.Addons, "catalogs");
  }).then(function (cats) {
    S.catalogs = arr(cats).filter(function (c) { return c && c.type && c.id; });
    S.types = [];
    S.catalogs.forEach(function (c) { if (S.types.indexOf(c.type) < 0) S.types.push(c.type); });
    /* movie/series first, then whatever else the addons expose */
    S.types.sort(function (a, b) {
      var order = { movie: 0, series: 1 };
      var av = (a in order) ? order[a] : 9, bv = (b in order) ? order[b] : 9;
      return av - bv || a.localeCompare(b);
    });
    renderSettingsList();
  });
}

function findCatalog(type, id, addonId) {
  var hit = null;
  S.catalogs.some(function (c) {
    if (c.type !== type || c.id !== id) return false;
    if (addonId && c.addonId !== addonId) return false;
    hit = c; return true;
  });
  return hit;
}
function catHref(c) {
  return "#board/" + enc(c.type) + "/" + enc(c.id) + "/" + enc(c.addonId);
}
function catName(c) {
  return txt(c.name || c.id).replace(/^\w/, function (m) { return m.toUpperCase(); });
}

/* ================================================================ routing */
function route() {
  previewClear();   /* leaving a view drops any anchored hover preview */
  var raw = txt(location.hash).replace(/^#/, "");
  var parts = raw.split("/").map(dec);
  var head = parts[0] || "home";

  if (head === "settings") return viewSettings();
  if (head === "detail" && parts[1] && parts[2]) return viewDetail(parts[1], parts[2]);
  if (head === "search") return viewSearch(parts[1] || "");
  if (head === "board") return viewBoard(parts[1], parts[2], parts[3]);
  return viewHome();
}

function setView(name) {
  S.view = name;
  if (D.app) D.app.dataset.view = name;
  document.querySelectorAll(".navbtn").forEach(function (b) {
    b.classList.toggle("on", b.dataset.nav === name);
  });
}

/* Overlays are routes: leaving one means closing it. */
function closeOverlays() {
  if (D.detail && !D.detail.hidden) {
    show(D.detail, false);
    D.detail.setAttribute("aria-hidden", "true");
    S.detail = null;
    /* the wall flew into the tile that opened this overlay — bring it back */
    call(S.wall, "deselect");
  }
  if (D.settings && !D.settings.hidden) {
    show(D.settings, false);
    D.settings.setAttribute("aria-hidden", "true");
  }
}

function goBack() {
  /* Prefer real history so the browser's back button stays coherent. */
  if (history.length > 1) history.back();
  else location.hash = "#board";
}

/* ================================================================== wall */
function initWall() {
  if (S.wall || !D.wall) return;
  if (window.WallView) {
    try {
      S.wall = new window.WallView(D.wall, { layout: "wall", rows: 3, background: "#050506" });
      S.wallMode = "canvas";
      call(S.wall, "onSelect", onWallSelect);
      call(S.wall, "onHover", onWallHover);
      show(D.wall, true);
      show(D.grid, false);
      return;
    } catch (e) {
      S.wall = null;   /* engine present but unhappy — fall through to the grid */
    }
  }
  S.wallMode = "grid";
  show(D.wall, false);
  show(D.grid, true);
}

function onWallSelect(a) {
  /* resolve against the exact array last handed to setItems — home rows make
     the wall index the only reliable key (ids are namespaced per row) */
  var it = (typeof a === "number") ? S.wallList[a] : a;
  if (!it) return;
  previewClear();   /* a real selection supersedes any hover preview */
  /* registry sources play directly — they ARE the stream, no detail/addon hop */
  if (it.meta && it.meta.hpUrl) { playRegistry(it.meta); return; }
  var id = it.mid || (it.meta && it.meta.id) || it.id;
  var type = it.type || (it.meta && it.meta.type) || S.type || "movie";
  /* a known LIVE cam (chaturbate:<room>) plays its OWN low-latency HLS in our
     player on a single click — resolve FRESH, hand the master to hls.js, live
     edge. It never bounces to chaturbate.com. Only a genuinely offline/private
     room falls through to the detail view (which shows the clean external
     hand-off). This is the "play in-house, never external" path for cams. */
  if (cbRoom(it)) {
    /* the tile may ALREADY be playing this feed as a pinned preview — adopt that media
       into the player: instant, and the feed is never refetched */
    var tKey = txt(it.id), tr = (window.Player && Player.adoptPreview) ? Player.adoptPreview(tKey) : null;
    if (tr && tr.url) { watchResolved({ url: tr.url, hls: true, live: true, meta: addonMeta(it, it.meta) }, tr); return; }
    resolveLiveShared(it).then(function (res) {   /* reuses the hover-time resolve when <8s old */
      if (res && res.url) { watchResolved(res); }
      else if (id) { location.hash = "#detail/" + enc(type) + "/" + enc(id); }
    });
    return;
  }
  if (id) location.hash = "#detail/" + enc(type) + "/" + enc(id);
}
/* Contract: onHover(cb) calls cb(item, index) — the index is the SECOND
   argument; the item has no .index; cb(null, -1) means "nothing hovered". */
function onWallHover(item, index) {
  var idx = (typeof index === "number") ? index
          : (typeof item === "number") ? item : -1;
  /* infinite scroll, unchanged */
  if (idx >= 0 && S.view === "board" && idx >= S.items.length - NEAR_END) loadMore();
  /* focused-tile motion preview */
  var wallItem = (idx >= 0)
    ? ((item && typeof item === "object") ? item : S.wallList[idx])
    : null;
  previewHover(wallItem, idx);
}

/* One meta -> one wall item. `group` feeds the catalogRows layout (one row
   per group); `id` is namespaced by group because the same title legitimately
   appears in several rows and the engine diffs setItems by id. `mid` carries
   the real meta id back to onSelect. */
function toWallItem(m, group) {
  /* live-preview hint for the wall's cheap-many thumbnail engine: it reads
     item.liveThumb / item.liveRoom (else parses a "chaturbate:<room>" id, which
     our namespaced id no longer is). A cam catalog meta supplies liveThumb (a
     snapshot URL) or liveRoom directly; for the Chaturbate addon we derive the
     room from its "chaturbate:<room>" meta id. This is the seam every live
     source rides — a plugin only has to set liveThumb/liveRoom in its meta. */
  var cbRoom = (/^chaturbate:(.+)$/.exec(m.id || "") || [])[1];
  return {
    id: (group ? group + "|" : "") + m.id,
    mid: m.id,
    type: m.type,
    title: m.name || m.title || "",
    poster: m.poster || m.logo || m.background || "",
    thumb: m.poster || "",
    liveThumb: m.liveThumb || undefined,
    liveRoom: m.liveRoom || cbRoom || undefined,
    group: group,
    meta: m
  };
}

function setWallItems(list, home) {
  /* a real view/catalog/search change (not an infinite-scroll append) means the
     tiles are different — drop any persisted preview + live-image pins so nothing
     is left stranded over the new catalog. */
  var ctxKey = (S.view || "") + "|" + (S.cat || "") + "|" + (S.q || "");
  if (ctxKey !== S._wallCtx) { S._wallCtx = ctxKey; previewClear(); clearHoverPins(); }
  if (S.wallMode === "canvas" && S.wall) {
    var group = (S.view === "search")
      ? (S.q ? "Results for “" + S.q + "”" : "Results")
      : (S.cat ? catName(S.cat) : "Catalog");
    S.wallList = list.map(function (m) { return toWallItem(m, m.group || group); });
    call(S.wall, "setItems", S.wallList);
    setCoverBtn(S.wallList.some(function (w) { return w.liveRoom || w.liveThumb; }));
    /* NOTE: no focusIndex() here — in this engine focusIndex is a fly-to that
       zooms the tile, not a camera reset. setItems already re-lays out from
       the wall's home position, so a replaced list starts where it should. */
  } else {
    S.wallList = list.map(function (m) { return toWallItem(m, m.group || ""); });
    renderGrid(list, home);
  }
}

/* Infinite scroll, driven by what the wall is actually showing. The engine
   reports per-tile visibility, so the tail is detected however the user got
   there — pan, wheel, arrows or the scrubber. */
function startTailWatch() {
  setInterval(function () {
    if (S.view !== "board" || S.loading || S.exhausted) return;
    if (S.wallMode !== "canvas" || !S.wall || typeof S.wall.getState !== "function") return;
    var st;
    try { st = S.wall.getState(); } catch (e) { return; }
    if (!st || !st.tiles || st.destroyed) return;
    var last = -1;
    for (var i = 0; i < st.tiles.length; i++) if (st.tiles[i].vis && st.tiles[i].i > last) last = st.tiles[i].i;
    if (last >= 0 && last >= S.items.length - NEAR_END) loadMore();
  }, 600);
}

function onResize() { previewClear(); call(S.wall, "resize"); }

/* ---- DOM fallback grid (only when the canvas engine is unavailable) ---- */
function renderGrid(list, home) {
  if (!D.grid) return;
  clear(D.grid);
  D.grid.classList.remove("grid-rows");
  if (home) D.grid.scrollTop = 0;
  list.forEach(function (m, i) {
    var card = el("div", "gcard");
    card.tabIndex = -1;
    card.dataset.i = i;
    var wrap = el("div", "gcard-img");
    if (m.poster) {
      var img = new Image();
      img.loading = "lazy"; img.decoding = "async"; img.alt = "";
      img.addEventListener("load", function () { img.classList.add("loaded"); });
      img.addEventListener("error", function () { img.remove(); });
      img.src = m.poster;
      wrap.appendChild(img);
    }
    card.appendChild(wrap);
    card.appendChild(el("div", "gcard-cap", m.name || m.title || ""));
    card.addEventListener("click", function () { onWallSelect(m); });
    D.grid.appendChild(card);
  });
  D.grid.onscroll = function () {
    if (S.view !== "board") return;
    if (D.grid.scrollTop + D.grid.clientHeight > D.grid.scrollHeight - 600) loadMore();
  };
}

function gridFocus(delta) {
  if (S.wallMode !== "grid" || !D.grid) return false;
  var cards = D.grid.querySelectorAll(".gcard");
  if (!cards.length) return false;
  var cur = -1;
  cards.forEach(function (c, i) { if (c.classList.contains("on")) cur = i; });
  var perRow = Math.max(1, Math.round(D.grid.clientWidth / (cards[0].offsetWidth + 16)));
  var next = cur < 0 ? 0 : cur + (delta === "left" ? -1 : delta === "right" ? 1 :
                                  delta === "up" ? -perRow : perRow);
  next = Math.max(0, Math.min(cards.length - 1, next));
  cards.forEach(function (c) { c.classList.remove("on"); });
  cards[next].classList.add("on");
  cards[next].scrollIntoView({ block: "nearest", behavior: "smooth" });
  return true;
}
function gridActivate() {
  if (S.wallMode !== "grid" || !D.grid) return false;
  var on = D.grid.querySelector(".gcard.on");
  if (!on) return false;
  on.click();
  return true;
}

/* ============================================================ stage state */
function stage(mode, opts) {
  opts = opts || {};
  show(D.skeleton, mode === "loading");
  show(D.empty, mode === "empty");
  var live = (mode === "ok");
  if (S.wallMode === "canvas") show(D.wall, live);
  else show(D.grid, live);

  if (mode === "loading") renderSkeleton();
  if (mode === "empty") {
    if (D.empty_title) D.empty_title.textContent = opts.title || "Nothing here";
    if (D.empty_body)  D.empty_body.textContent  = opts.body || "";
    clear(D.empty_actions);
    (opts.actions || []).forEach(function (a) {
      var b = el("button", "btn " + (a.primary ? "btn-primary" : ""), a.label);
      b.type = "button";
      b.addEventListener("click", a.onClick);
      D.empty_actions.appendChild(b);
    });
  }
}

var skeletonPainted = false;
function renderSkeleton() {
  if (skeletonPainted || !D.skeleton) return;
  skeletonPainted = true;
  for (var i = 0; i < 24; i++) {
    var c = el("div", "sk-card");
    c.appendChild(el("i"));
    c.appendChild(el("span", "sk-line"));
    c.appendChild(el("span", "sk-line short"));
    D.skeleton.appendChild(c);
  }
}


/* =============================================================== HOME view
   A real Stremio home: several catalogs stacked as labeled horizontal rows
   (the wall's `catalogRows` layout), Continue Watching and Library first.
   Rows are fetched in parallel and painted as each one lands — the view is
   usable after the first catalog resolves, not after the slowest.        */

function typeLabel(t) {
  if (t === "movie") return "Movies";
  if (t === "series") return "Series";
  return txt(t).replace(/^\w/, function (c) { return c.toUpperCase(); });
}
function catKey(c, extra) {
  return c.addonId + "|" + c.type + "|" + c.id +
         (extra ? "|" + JSON.stringify(extra) : "");
}
function rowName(c, optLabel) {
  return catName(c) + (optLabel ? " " + optLabel : "") + " · " + typeLabel(c.type);
}

/** A catalog needs no required extra, or every required extra must offer
    options we can pick a sensible default from (Cinemeta's "New" rows require
    a `genre` that is really a year list). Anything requiring opaque ids
    (last-videos, calendar-videos) is skipped — we cannot synthesise those. */
function homeExtraFor(c) {
  var req = arr(c.required);
  if (!req.length) return { extra: null, label: "" };
  var extra = {}, label = "";
  for (var i = 0; i < req.length; i++) {
    var name = req[i], def = null;
    arr(c.extra).forEach(function (e) { if (e && e.name === name) def = e; });
    var opts = def && arr(def.options);
    if (!opts || !opts.length) return null;      /* unsynthesisable */
    extra[name] = opts[0];
    if (!label) label = String(opts[0]);
  }
  return { extra: extra, label: label };
}

/** Catalogs worth a home row, interleaved across types so movies and series
    both show up near the top. */
function pickHomeCatalogs() {
  var usable = [];
  S.catalogs.forEach(function (c) {
    var x = homeExtraFor(c);
    if (!x) return;
    usable.push({ cat: c, extra: x.extra, label: x.label, type: c.type });
  });
  var byType = {}, order = [];
  usable.forEach(function (u) {
    if (!byType[u.type]) { byType[u.type] = []; order.push(u.type); }
    byType[u.type].push(u);
  });
  var out = [], i = 0, added = true;
  while (out.length < HOME_ROWS && added) {
    added = false;
    for (var t = 0; t < order.length; t++) {
      var bucket = byType[order[t]];
      if (i < bucket.length) { out.push(bucket[i]); added = true; }
      if (out.length >= HOME_ROWS) break;
    }
    i++;
  }
  return out;
}

function playRegistry(m) {
  if (!window.Player) return;
  bindPlayerClose();
  window.Player.play({
    stream: { url: m.hpUrl, title: m.title || m.name, hls: m.hls === true, live: m.live === true },
    meta: { id: m.id, type: "movie", name: m.title || m.name, poster: m.poster || "" }
  });
  call(S.wall, "deselect");
}

/* ======================================================= motion preview ==
   The hybrid preview POOL: the newest ~6 hovered live tiles each play a muted
   <video> SIMULTANEOUSLY, each pinned to its tile; older hovered tiles fall back
   to the cheap live-IMAGE tier (hp-nav's thumbnail refresh); never-hovered tiles
   stay static. This lane resolves streams + orchestrates WHICH tiles are pooled
   and repositions them every frame; the Player owns the leak-safe pool of
   video/hls underneath and evicts the oldest past PV_MAX. Returning to a still-
   pooled tile resumes INSTANTLY (its element is still playing — no re-resolve). */
var PVM = { hoverIdx: -1, activeIdx: -1, startT: null, token: 0, cache: new Map(),
            pool: new Map() };   /* tileId -> { idx } : mirror of the Player pool, drives pinLoop */

/* ---- the live-stream resolver (hp-resolver, optional; graceful when down) - */
var resolverHealth = { at: 0, up: false };
function fetchJSONT(url, ms) {
  var ac = ("AbortController" in window) ? new AbortController() : null;
  var opt = { cache: "no-store" };
  if (ac) opt.signal = ac.signal;
  var timer = setTimeout(function () { if (ac) { try { ac.abort(); } catch (e) {} } }, ms || 1500);
  return fetch(url, opt).then(function (r) {
    clearTimeout(timer);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }, function (e) { clearTimeout(timer); throw e; });
}
function resolverUp() {
  /* On an https origin a fetch to http://127.0.0.1 can NEVER succeed (mixed content +
     private-network blocking) — Chrome just spams "CORS error" to the console on every
     probe. Skip probing entirely there; the resolver is a localhost-app feature. */
  if (location.protocol === 'https:' && RESOLVER_BASE.indexOf('http://127.') === 0)
    return Promise.resolve(false);
  var now = Date.now();
  if (now - resolverHealth.at < 8000) return Promise.resolve(resolverHealth.up);
  return fetchJSONT(RESOLVER_BASE + "/health", 800).then(function (j) {
    resolverHealth = { at: Date.now(), up: !!(j && j.ok) }; return resolverHealth.up;
  }, function () { resolverHealth = { at: Date.now(), up: false }; return false; });
}
function cbRoom(item) {
  var id = txt(item && (item.mid || (item.meta && item.meta.id) || item.id));
  var m = /^chaturbate:(.+)$/i.exec(id);
  return m ? m[1] : "";
}
function liveThumbOf(item) {
  return txt(item && ((item.meta && item.meta.liveThumb) || item.liveThumb || ""));
}
function setLiveThumb(item, url) {
  if (!item || !url) return;
  try { if (item.meta) item.meta.liveThumb = url; item.liveThumb = url; } catch (e) {}
}
/* Ask the resolver for a fresh live master (tokens expire — never cached long). */
function resolveViaResolver(item) {
  return resolverUp().then(function (up) {
    if (!up) return null;
    var room = cbRoom(item), q;
    if (room) q = RESOLVER_BASE + "/resolve?site=chaturbate&room=" + enc(room);
    else return null;   /* generic ?url= path needs a known page url; none at tile level */
    return fetchJSONT(q, 2500).then(function (j) {
      if (j && j.ok && (j.kind === "hls" || j.kind === "mp4") && j.url) {
        if (j.thumb) setLiveThumb(item, j.thumb);
        /* generic sources that aren't CORS-clean come with a proxy path off the
           resolver; CB masters are always corsSafe so this is a no-op for cams */
        var url = (j.corsSafe === false && j.proxyUrl) ? (RESOLVER_BASE + j.proxyUrl) : j.url;
        return { url: url, live: j.live !== false, thumb: j.thumb || "", kind: j.kind };
      }
      return null;   /* ok:false (offline/private/away) -> fall through to addon/external */
    }, function () { return null; });
  });
}

/* ---- stream selection: PREFER a playable in-browser source, external last -- */
function isHlsUrl(u) { return /\.m3u8(\?|#|$)/i.test(txt(u)); }
function isDirectUrl(u) { return !!u && !/^magnet:/i.test(u) && !isHlsUrl(u); }
/* previewable = a real video we can play muted on hover (HLS or direct file);
   torrents need the engine + peers and are never previewed. */
function pickPreviewable(streams) {
  var list = arr(streams), hls = null, direct = null;
  for (var i = 0; i < list.length; i++) {
    var s = list[i]; if (!s) continue;
    if (isHlsUrl(s.url)) { if (!hls) hls = s; }
    else if (isDirectUrl(s.url)) { if (!direct) direct = s; }
  }
  return hls || direct || null;
}
/* playable = anything we can open IN-HOUSE (HLS/direct, or a torrent via the
   engine). externalUrl/ytId are deliberately excluded so they are never chosen
   over a real stream — that is the "prefer playable over external" rule. */
function pickPlayable(streams) {
  var list = arr(streams), hls = null, direct = null, torrent = null;
  for (var i = 0; i < list.length; i++) {
    var s = list[i]; if (!s) continue;
    if (isHlsUrl(s.url)) { if (!hls) hls = s; }
    else if (isDirectUrl(s.url)) { if (!direct) direct = s; }
    else if (s.infoHash || /^magnet:/i.test(txt(s.url))) { if (!torrent) torrent = s; }
  }
  return hls || direct || torrent || null;
}
function isLiveStream(s, m) {
  var hay = txt(s && s.name) + " " + txt(s && s.title) + " " + txt(m && m.name);
  return /\bcam\b|\blive\b|chaturbate/i.test(hay);
}
function addonMeta(item, m) {
  m = m || {};
  return { id: txt(item && (item.mid || m.id || item.id)),
           type: txt(item && (item.type || m.type || "movie")),
           name: m.name || m.title || "", poster: m.poster || m.logo || "",
           external: m.external, externalName: m.externalName };
}

/* Resolve a previewable stream for an item: registry url (instant) ->
   resolver fresh HLS (live cams) -> addon HLS/direct -> null (external-only). */
function resolvePreview(item) {
  var m = item && item.meta;
  if (m && m.hpUrl) {
    return Promise.resolve({
      url: m.hpUrl, hls: m.hls === true, live: m.live === true,
      poster: m.poster || "", title: m.title || m.name || "", source: "registry",
      meta: { id: m.id, type: "movie", name: m.title || m.name || "", poster: m.poster || "" }
    });
  }
  var type = txt(item && (item.type || (m && m.type) || "movie"));
  var id = txt(item && (item.mid || (m && m.id) || item.id));
  if (!id) return Promise.resolve(null);
  return resolveViaResolver(item).then(function (r) {
    if (r && r.url) {
      return { url: r.url, hls: r.kind !== "mp4", live: r.live !== false,
               poster: liveThumbOf(item) || (m && (m.poster || m.logo)) || "",
               title: (m && (m.name || m.title)) || "", source: "resolver", meta: addonMeta(item, m) };
    }
    return call(window.Addons, "streams", type, id).then(function (streams) {
      var s = pickPreviewable(streams);
      if (!s) return null;
      return { url: s.url, hls: isHlsUrl(s.url), live: isLiveStream(s, m),
               poster: liveThumbOf(item) || (m && (m.poster || m.logo)) || "",
               title: (m && (m.name || m.title)) || "", source: "addon", meta: addonMeta(item, m) };
    });
  });
}
var LIVE_RESOLVE = new Map();   /* room-id -> {p, at}: dedupe hover+click resolver hops (~1-2s each) */
function resolveLiveShared(item) {
  var id = txt(item && (item.mid || (item.meta && item.meta.id) || item.id));
  var c = LIVE_RESOLVE.get(id);
  if (c && Date.now() - c.at < 8000) return c.p;      /* token stays fresh well past 8s */
  var p = resolvePreview(item);
  LIVE_RESOLVE.set(id, { p: p, at: Date.now() });
  if (LIVE_RESOLVE.size > 40) LIVE_RESOLVE.delete(LIVE_RESOLVE.keys().next().value);
  return p;
}
function resolvePreviewCached(item) {
  var id = txt(item && (item.mid || (item.meta && item.meta.id) || item.id));
  /* live cams resolve to a token URL that expires in seconds — caching it makes a
     re-hover (A->B->A) replay a DEAD url and hang on the spinner. So never cache a
     live resolve: re-resolve fresh each time (a fast resolver POST). Static VOD /
     registry urls cache normally. (True instant-resume for live comes from the
     video pool keeping the tile's stream alive; this is the evicted-tile path.) */
  var isLive = !!(item && (item.liveRoom || item.liveThumb));
  var now = Date.now(), c = (id && !isLive) ? PVM.cache.get(id) : null;
  if (c && (c.expires === 0 || c.expires > now)) return Promise.resolve(c.val);
  return (isLive ? resolveLiveShared(item) : resolvePreview(item)).then(function (val) {
    if (id && !isLive) {
      var ttl = (val && val.source === "registry") ? 0 : now + PREVIEW_TTL;
      PVM.cache.set(id, { val: val, expires: ttl });
      if (PVM.cache.size > 200) { var k = PVM.cache.keys().next().value; PVM.cache.delete(k); }
    }
    return val;
  });
}

/* ---- geometry: the tile's on-screen rect from the wall's own state -------- */
function tileRect(idx) {
  if (!S.wall || S.wallMode !== "canvas" || typeof S.wall.getState !== "function") return null;
  var st; try { st = S.wall.getState(); } catch (e) { return null; }
  if (!st || !st.tiles) return null;
  var t = null;
  for (var i = 0; i < st.tiles.length; i++) { if (st.tiles[i].i === idx) { t = st.tiles[i]; break; } }
  /* geometry only — do NOT gate on t.vis: the wall toggles vis mid-zoom while the
     tile is still on screen, which used to yank a persisted preview off. pinLoop
     decides visibility from the real viewport rect instead. */
  if (!t) return null;
  var host = (D.wall && D.wall.getBoundingClientRect) ? D.wall.getBoundingClientRect() : { left: 0, top: 0 };
  var w = t.dw * t.scale * t.k, hgt = t.dh * t.scale * t.k;
  if (!(w > 0) || !(hgt > 0)) return null;
  return { left: host.left + t.sx - w / 2, top: host.top + t.sy - hgt / 2, width: w, height: hgt };
}

/* ---- lifecycle ------------------------------------------------------------ */
function previewHover(item, idx) {
  if (idx < 0 || !item) { previewCancelPending(); return; }
  if (S.wallMode !== "canvas") return;
  if (window.Player && typeof window.Player.isOpen === "function" && window.Player.isOpen()) { previewClear(); return; }
  addHoverPin(item);   /* live-image tier: this tile now persists as a live thumbnail */
  PVM.hoverIdx = idx;

  /* already a LIVE pool video -> INSTANT resume: re-mark newest + reposition, no
     rebuild, no re-resolve. This is what makes A->B->A snap back with no loading
     spinner for pooled tiles (the element is still playing). */
  if (item.id && window.Player && typeof window.Player.previewHas === "function" && window.Player.previewHas(item.id)) {
    PVM.pool.set(item.id, { idx: idx });
    PVM.activeIdx = idx;
    if (typeof window.Player.preview === "function") window.Player.preview({ key: item.id, rect: tileRect(idx) || undefined });
    pinStart();
    return;
  }

  clearTimeout(PVM.startT);
  var myToken = ++PVM.token;
  PVM.startT = setTimeout(function () {
    if (myToken !== PVM.token || PVM.hoverIdx !== idx) return;
    startPreviewFor(item, idx, myToken);
  }, PREVIEW_DEBOUNCE);
}
function startPreviewFor(item, idx, token) {
  var rect = tileRect(idx);
  if (!rect) return;
  /* raced into the pool already (a re-hover landed first) -> reposition only */
  if (item.id && window.Player && typeof window.Player.previewHas === "function" && window.Player.previewHas(item.id)) {
    PVM.pool.set(item.id, { idx: idx });
    PVM.activeIdx = idx;
    if (typeof window.Player.preview === "function") window.Player.preview({ key: item.id, rect: rect });
    pinStart();
    return;
  }
  resolvePreviewCached(item).then(function (res) {
    if (token !== PVM.token || PVM.hoverIdx !== idx) return;   /* moved away mid-resolve */
    if (!res || !res.url) return;                              /* external-only: leave tile as-is */
    if (!window.Player || typeof window.Player.preview !== "function") return;
    var r2 = tileRect(idx) || rect;
    PVM.pool.set(item.id, { idx: idx });
    PVM.activeIdx = idx;
    pinStart();
    window.Player.preview({
      key: item.id,
      stream: { url: res.url, live: res.live, hls: res.hls },
      rect: r2, poster: res.poster || "", live: res.live, title: res.title,
      onWatch: function (t) { watchResolved(res, t); }   /* t = the preview's live media, adopted */
    });
    reconcilePool();   /* the Player may have evicted the oldest tile — drop it here too */
  });
}
/* keep PVM.pool in step with the Player's authoritative pool: drop any key the
   Player evicted (oldest past PV_MAX). Cheap key-set diff, called after each add. */
function reconcilePool() {
  if (!window.Player || typeof window.Player.previewKeys !== "function") return;
  var live = window.Player.previewKeys() || [], set = {};
  for (var i = 0; i < live.length; i++) set[live[i]] = 1;
  PVM.pool.forEach(function (v, k) { if (!set[k]) PVM.pool["delete"](k); });
}
function watchResolved(res, adopt) {
  if (!res || !window.Player) return;
  bindPlayerClose();
  window.Player.play({ stream: { url: res.url, hls: res.hls, live: res.live }, meta: res.meta, adopt: adopt || null });
}
function previewClear() {
  PVM.hoverIdx = -1;
  PVM.activeIdx = -1;
  PVM.token++;                    /* cancel any in-flight resolve/debounce */
  clearTimeout(PVM.startT);
  PVM.pool.clear();
  if (window.Player && typeof window.Player.previewStop === "function") window.Player.previewStop();  /* no arg -> tear the WHOLE pool down */
}

/* hover moved OFF a tile (into empty space): cancel any pending/in-flight preview
   start, but DO NOT stop one already playing — it stays pinned to its tile until
   superseded or the view changes. (user: "i hover away and the live one ends —
   change that even before everything else lands") */
function previewCancelPending() {
  PVM.hoverIdx = -1;
  clearTimeout(PVM.startT);
  PVM.token++;                    /* cancel debounce + any in-flight resolve */
}

/* keep EVERY pooled preview glued to its tile as the wall pans/zooms. Runs only
   while the pool is non-empty; self-stops when it drains, so idle-zero holds
   otherwise. ponytail: one rAF drives all <=6 pinned overlays — the Player owns
   the authoritative key list, so a tile the Player evicted stops being pinned. */
var pinRAF = 0;
function pinLoop() {
  pinRAF = 0;
  if (!window.Player || typeof window.Player.previewKeys !== "function") return;
  var keys = window.Player.previewKeys();
  if (!keys || !keys.length) return;   /* pool empty -> self-stop */
  var vw = window.innerWidth || document.documentElement.clientWidth || 0;
  var vh = window.innerHeight || document.documentElement.clientHeight || 0;
  /* follow each tile through zoom/pan; hide only those that truly leave the
     viewport (missing rect, or fully off-screen) — never on the wall's vis flag. */
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var ent = PVM.pool.get(key);
    if (!ent) continue;
    var r = tileRect(ent.idx);
    var onScreen = !!r && (r.left + r.width) > 0 && (r.top + r.height) > 0 && r.left < vw && r.top < vh;
    if (window.Player.previewSetRect) window.Player.previewSetRect(key, onScreen ? r : null);
  }
  pinRAF = requestAnimationFrame(pinLoop);
}
function pinStart() { if (!pinRAF) pinRAF = requestAnimationFrame(pinLoop); }

/* the live-IMAGE tier of the hybrid: every live tile the user has hovered keeps a
   cheap live-refreshing thumbnail (the wall engine handles hundreds), so previews
   persist as you move on and hover more. The current tile also wears the richer
   muted VIDEO on top; when the video moves away this image is what stays live.
   Only cam tiles (liveRoom/liveThumb) pin — static covers never animate. */
var hoverPins = new Set();
function addHoverPin(item) {
  if (!item || !item.id || !S.wall) return;
  if (!item.liveRoom && !item.liveThumb) return;   /* live sources only */
  if (hoverPins.has(item.id)) return;
  hoverPins.add(item.id);
  try { call(S.wall, "setLivePins", Array.from(hoverPins)); } catch (e) {}
}
function clearHoverPins() {
  if (!hoverPins.size) return;
  hoverPins.clear();
  try { call(S.wall, "setLivePins", null); } catch (e) {}
}

/* "Update covers": one manual refresh of every visible live cover. Covers are
   static by default (user: keep the first image) — this is the only thing that
   refreshes them all at once. */
function ensureCoverBtn() {
  if (document.getElementById("hp-covers")) return;
  var b = document.createElement("button");
  b.id = "hp-covers";
  b.type = "button";
  b.textContent = "⟳ Update covers";
  b.title = "Refresh every live cover once";
  b.style.cssText = "position:fixed;left:14px;bottom:14px;z-index:9000;font:12px/1 -apple-system,BlinkMacSystemFont,sans-serif;" +
    "color:#f5387b;background:rgba(13,13,15,.86);border:1px solid rgba(245,56,123,.4);border-radius:999px;" +
    "padding:7px 12px;cursor:pointer;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)";
  b.addEventListener("click", function () {
    if (S.wall && S.wall.refreshCoversOnce) S.wall.refreshCoversOnce();
    var t = b.textContent; b.textContent = "⟳ Refreshing…";
    setTimeout(function () { b.textContent = t; }, 1200);
  });
  document.body.appendChild(b);
}
/* show the Update-covers button only on canvas views that actually have live covers */
function setCoverBtn(on) {
  ensureCoverBtn();
  var b = document.getElementById("hp-covers");
  if (b) b.style.display = on ? "" : "none";
}

/* Read-only introspection seam — verification and darwin rounds use it to find a
   tile's on-screen rect and drive a REAL mouse hover over the exact tile; it only
   reads live state and never changes behaviour. */
window.HP = window.HP || {
  wallState: function () { try { return S.wall && S.wall.getState(); } catch (e) { return null; } },
  wallList: function () { return S.wallList; },
  tileRect: function (idx) { return tileRect(idx); },
  previewStats: function () { return (window.Player && window.Player.inlineStats) ? window.Player.inlineStats() : null; },
  activePreview: function () { return PVM.activeIdx; },
  previewKeys: function () { return (window.Player && window.Player.previewKeys) ? window.Player.previewKeys() : []; },
  previewPool: function () { var o = []; PVM.pool.forEach(function (v, k) { o.push({ key: k, idx: v.idx }); }); return o; },
  resolverUp: resolverUp
};

function buildHomeGroups() {
  var groups = [];

  /* verified_sources.md lanes first — the registry IS the product */
  if (window.Registry) {
    window.Registry.groups().forEach(function (g) { groups.push(g); });
  }

  /* Continue Watching now lives in its own auto-collapsed sidebar (renderContinue
     + ensureCwSidebar) — one consistent surface across every view, hidden until
     the tab is expanded — so it is no longer a home wall lane. */

  var lib = Object.keys(S.library).map(function (k) { return S.library[k]; })
    .sort(function (a, b) { return (b.added || 0) - (a.added || 0); });
  if (lib.length) {
    groups.push({
      key: "__lib", name: "Library",
      items: lib.map(function (r) {
        return { id: r.id, type: r.type, name: r.name || r.id, poster: r.poster || "" };
      })
    });
  }

  pickHomeCatalogs().forEach(function (u) {
    var k = catKey(u.cat, u.extra);
    groups.push({
      key: k, name: rowName(u.cat, u.label), cat: u.cat, extra: u.extra,
      items: homeCache.get(k) || null
    });
  });

  return groups;
}

function viewHome() {
  setView("home");
  closeOverlays();
  show(D.catalogbar, false);
  show(D.continue, false);

  if (!S.catalogs.length && !(window.Registry && window.Registry.count())) {
    stage("empty", {
      title: "No catalogs available",
      body: "None of the installed addons expose a catalog. Install a metadata addon such as " +
            "Cinemeta to browse movies and series.",
      actions: [{ label: "Open settings", primary: true,
                  onClick: function () { location.hash = "#settings"; } }]
    });
    return;
  }

  call(S.wall, "layout", "catalogRows");

  var seq = ++S.homeSeq;
  S.homeGroups = buildHomeGroups();
  paintHome();

  var pending = S.homeGroups.filter(function (g) { return !g.items; }).length;
  setStatus(pending > 0, pending + " more row" + (pending === 1 ? "" : "s") + " loading…");

  S.homeGroups.forEach(function (g) {
    if (g.items) return;
    call(window.Addons, "catalog", g.cat.addonId, g.cat.type, g.cat.id, g.extra).then(function (res) {
      if (seq !== S.homeSeq) return;                 /* left home, or reloaded */
      var items = arr(res).map(function (m) { return normalize(m, g.cat.type); })
                          .filter(Boolean).slice(0, HOME_ROW_ITEMS);
      g.items = items;
      homeCache.set(g.key, items);
      pending--;
      if (S.view === "home") {
        paintHome();
        setStatus(pending > 0, pending + " more row" + (pending === 1 ? "" : "s") + " loading…");
      }
    });
  });
}

/** Rebuild the flat item list in canonical row order, skipping rows that have
    not resolved yet. Row order therefore stays stable no matter what order
    the network answers in. */
function paintHome() {
  var list = [];
  S.homeGroups.forEach(function (g) {
    if (!g.items || !g.items.length) return;
    g.items.forEach(function (m) { list.push(toWallItem(m, g.name)); });
  });

  if (!list.length) { stage("loading"); return; }

  S.wallList = list;
  if (S.wallMode === "canvas" && S.wall) {
    call(S.wall, "setItems", list);
  } else {
    renderHomeGrid();
  }
  stage("ok");
  if (D.catcount) D.catcount.textContent = "";
}

/** DOM fallback for the home view when the wall engine is unavailable. */
function renderHomeGrid() {
  if (!D.grid) return;
  clear(D.grid);
  D.grid.classList.add("grid-rows");
  S.homeGroups.forEach(function (g) {
    if (!g.items || !g.items.length) return;
    D.grid.appendChild(el("h2", "row-label", g.name));
    var row = el("div", "row-strip");
    g.items.forEach(function (m) {
      var card = el("div", "gcard");
      var wrap = el("div", "gcard-img");
      if (m.poster) {
        var img = new Image();
        img.loading = "lazy"; img.decoding = "async"; img.alt = "";
        img.addEventListener("load", function () { img.classList.add("loaded"); });
        img.addEventListener("error", function () { img.remove(); });
        img.src = m.poster;
        wrap.appendChild(img);
      }
      card.appendChild(wrap);
      card.appendChild(el("div", "gcard-cap", m.name || m.title || ""));
      card.addEventListener("click", function () { onWallSelect(toWallItem(m, g.name)); });
      row.appendChild(card);
    });
    D.grid.appendChild(row);
  });
  D.grid.onscroll = null;
}

/* ============================================================== BOARD view */

/* ---------------------------------------------------------------------------
   Addon-catalog board: manifest-driven filters, skip paging, per-catalog layout.

   Everything here is GENERIC. Nothing knows the name of any addon: the filter
   pills are built from whatever option-list extras a catalog's manifest
   declares, paging uses the protocol's `skip` offset, and the layout row is
   the wall engine's own registry. Install a new addon and its filters appear.

   State lives in this block rather than on S so that sibling lanes editing
   other regions of this file never collide with it.
--------------------------------------------------------------------------- */

var LS_BOARD  = "hp.board.v1";   /* { layoutByCat: {token: layoutName} } */
var EXT_BADGE = "🌐";  /* 🌐 — addon-sourced, NOT a registry lane badge */

var BOARD = {
  token: "",        /* which catalog `filters` belongs to */
  filters: {},      /* extraName -> chosen value (user's explicit picks only) */
  layoutBound: false
};

function catToken(c) {
  return c ? c.addonId + "|" + c.type + "|" + c.id : "";
}

/* --- honesty law ---------------------------------------------------------
   Registry rows earn a lane badge (🤖 / ✅ / 🧪) by being in
   verified_sources.md. Addon items never can, so they are marked — once, at
   the seam where they enter the view — with a distinct glyph that means
   "external · unverified source". The board bar spells the words out. The
   marker is idempotent: metas are cached and re-normalised on every repaint. */
function markExternal(m) {
  if (!m || !m.external || m.hpExtMarked) return m;
  m.hpExtMarked = true;
  var n = txt(m.name || m.title);
  if (n.indexOf(EXT_BADGE) !== 0) m.name = EXT_BADGE + " " + n;
  return m;
}

/* --- manifest-driven filter model ---------------------------------------- */

/** First genuinely selectable option (group headers carry no value). */
function firstOption(f) {
  var hit = null;
  arr(f && f.options).some(function (o) {
    if (o.kind === "option") { hit = o.value; return true; }
    return false;
  });
  return hit;
}

/** Extras the addon REQUIRES, defaulted to their first real option. Without
    these a required-extra catalog answers with nothing at all. */
function requiredExtra(cat) {
  var out = {};
  arr(cat && cat.filters).forEach(function (f) {
    if (!f.isRequired) return;
    var v = firstOption(f);
    if (v != null) out[f.name] = v;
  });
  return out;
}

/** The full extra object for one request: required defaults, the user's picks
    on top, then the paging offset. */
function boardExtra(cat, skip) {
  var extra = requiredExtra(cat);
  Object.keys(BOARD.filters).forEach(function (k) {
    if (BOARD.filters[k]) extra[k] = BOARD.filters[k];
  });
  if (skip && cat && cat.supportsSkip !== false) extra.skip = skip;
  return Object.keys(extra).length ? extra : undefined;
}

function activeFilterCount() {
  return Object.keys(BOARD.filters).filter(function (k) { return BOARD.filters[k]; }).length;
}

function setFilter(name, value) {
  if (BOARD.filters[name] === value) delete BOARD.filters[name];   /* click again = off */
  else BOARD.filters[name] = value;
  renderFilterBar();
  loadCatalog(S.cat, true);
}

function clearFilters() {
  if (!activeFilterCount()) return;
  BOARD.filters = {};
  renderFilterBar();
  loadCatalog(S.cat, true);
}

/* --- per-catalog layout persistence --------------------------------------
   The wall engine already renders its own layout pill row from its layout
   registry, so a new layout costs nothing here. What was missing is memory:
   the chosen layout is stored per catalog and restored on return. */

function savedLayout(cat) {
  var m = lsGet(LS_BOARD, {}).layoutByCat || {};
  return m[catToken(cat)] || null;
}

function saveLayout(cat, name) {
  if (!cat || !name) return;
  var st = lsGet(LS_BOARD, {});
  if (!st.layoutByCat) st.layoutByCat = {};
  if (st.layoutByCat[catToken(cat)] === name) return;
  st.layoutByCat[catToken(cat)] = name;
  lsSet(LS_BOARD, st);
}

/** Apply the catalog's remembered layout, and start remembering changes. */
function applyBoardLayout(cat) {
  if (S.wallMode !== "canvas" || !S.wall) return;
  if (!BOARD.layoutBound) {
    BOARD.layoutBound = true;
    call(S.wall, "onLayout", function (info) {
      if (S.view === "board" && info && info.name) saveLayout(S.cat, info.name);
    });
  }
  call(S.wall, "layout", savedLayout(cat) || "wall");
}

/* --- the filter bar ------------------------------------------------------
   Built in JS and appended to #catalogbar so this lane owns no markup in
   index.html. Styles are injected once, scoped to the ids/classes below, so
   this lane owns no rules in style.css either — both are documented handoffs
   for whoever folds them into the static files later. */

function boardStyles() {
  if (document.getElementById("hp-board-css")) return;
  var s = document.createElement("style");
  s.id = "hp-board-css";
  s.textContent =
    "#catalogbar{flex-wrap:wrap}" +
    "#hp-filterbar{flex:1 0 100%;display:flex;align-items:center;gap:8px;" +
      "min-width:0;overflow-x:auto;scrollbar-width:none;padding-top:6px}" +
    "#hp-filterbar::-webkit-scrollbar{display:none}" +
    "#hp-filterbar:empty{display:none}" +
    ".hp-fname{font-size:11px;letter-spacing:.09em;text-transform:uppercase;" +
      "opacity:.5;white-space:nowrap;flex:none}" +
    ".hp-fgroup{font-size:10px;letter-spacing:.1em;text-transform:uppercase;" +
      "opacity:.38;white-space:nowrap;flex:none;padding-left:6px;" +
      "border-left:1px solid rgba(255,255,255,.14);margin-left:2px}" +
    ".hp-ext{font-size:11px;white-space:nowrap;flex:none;opacity:.72;" +
      "border:1px solid rgba(255,255,255,.16);border-radius:999px;padding:2px 9px}" +
    ".hp-clear{flex:none}";
  document.head.appendChild(s);
}

function filterBarBox() {
  if (!D.catalogbar) return null;
  var box = document.getElementById("hp-filterbar");
  if (!box) {
    boardStyles();
    box = el("div", "pills");
    box.id = "hp-filterbar";
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "Catalog filters");
    D.catalogbar.appendChild(box);
  }
  return box;
}

/**
 * One pill row per option-list extra the catalog declares. Pseudo-options that
 * are really section titles ("**AGE**", "**POPULAR TAG**") come back from the
 * data layer classified as groups and render as separators, never as pills —
 * clicking one would send a meaningless value and return an empty catalog.
 */
function renderFilterBar() {
  var box = filterBarBox();
  if (!box) return;
  clear(box);

  var cat = S.cat;
  if (!cat) return;

  if (cat.addonId) {
    var src = el("span", "hp-ext",
      "external · unverified source · " + (cat.addonName || addonName(cat.addonId) || cat.addonId));
    src.title = "Served by an installed addon. Not a verified_sources.md lane — " +
                "this content is not performer-verified.";
    box.appendChild(src);
  }

  arr(cat.filters).forEach(function (f) {
    box.appendChild(el("span", "hp-fname", f.name));
    f.options.forEach(function (o) {
      if (o.kind === "group") {
        box.appendChild(el("span", "hp-fgroup", o.label));
        return;
      }
      var on = BOARD.filters[f.name] === o.value;
      var b = el("button", "pill" + (on ? " on" : ""), o.label);
      b.type = "button";
      b.setAttribute("aria-pressed", String(on));
      b.addEventListener("click", function () { setFilter(f.name, o.value); });
      box.appendChild(b);
    });
  });

  if (activeFilterCount()) {
    var x = el("button", "btn btn-ghost btn-sm hp-clear", "Clear filters");
    x.type = "button";
    x.addEventListener("click", clearFilters);
    box.appendChild(x);
  }
}

function viewBoard(type, catId, addonId) {
  setView("board");
  closeOverlays();
  show(D.catalogbar, true);
  renderContinue();

  if (!S.catalogs.length) {
    renderPills();
    stage("empty", {
      title: "No catalogs available",
      body: "None of the installed addons expose a catalog. Install a metadata addon such as " +
            "Cinemeta to browse movies and series.",
      actions: [{ label: "Open settings", primary: true, onClick: function () { location.hash = "#settings"; } }]
    });
    return;
  }

  var cat = (type && catId) ? findCatalog(type, catId, addonId) : null;
  if (!cat) {
    var pref = lsGet(LS_UI, {}).cat;
    if (pref) cat = findCatalog(pref.type, pref.id, pref.addonId);
  }
  if (!cat) cat = S.catalogs[0];

  var changed = !S.cat || S.cat.addonId !== cat.addonId || S.cat.type !== cat.type || S.cat.id !== cat.id;
  S.cat = cat;
  S.type = cat.type;

  /* filters belong to one catalog — switching catalogs drops them rather than
     carrying a genre from one addon onto another that never declared it */
  if (BOARD.token !== catToken(cat)) { BOARD.token = catToken(cat); BOARD.filters = {}; }

  renderPills();
  renderFilterBar();
  applyBoardLayout(cat);

  if (changed) {
    var ui = lsGet(LS_UI, {});
    ui.cat = { addonId: cat.addonId, type: cat.type, id: cat.id };
    lsSet(LS_UI, ui);
    loadCatalog(cat, true);
  } else {
    setWallItems(S.items, true);
    stage(S.items.length ? "ok" : "empty", emptyCatalogOpts());
  }
}

function emptyCatalogOpts() {
  return {
    title: "This catalog came back empty",
    body: "The addon returned no items for “" + catName(S.cat || {}) + "”. Try another catalog " +
          "or install an addon that serves this type.",
    actions: [{ label: "Retry", primary: true, onClick: function () { loadCatalog(S.cat, true); } },
              { label: "Settings", onClick: function () { location.hash = "#settings"; } }]
  };
}

function renderPills() {
  if (!D.typepills || !D.catpills) return;

  clear(D.typepills);
  S.types.forEach(function (t) {
    var b = el("button", "pill" + (t === S.type ? " on" : ""), t.charAt(0).toUpperCase() + t.slice(1));
    b.type = "button";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(t === S.type));
    b.addEventListener("click", function () {
      var first = null;
      S.catalogs.some(function (c) { if (c.type === t) { first = c; return true; } return false; });
      if (first) location.hash = catHref(first);
    });
    D.typepills.appendChild(b);
  });

  clear(D.catpills);
  S.catalogs.filter(function (c) { return c.type === S.type; }).forEach(function (c) {
    var on = S.cat && c.addonId === S.cat.addonId && c.id === S.cat.id;
    var b = el("button", "pill" + (on ? " on" : ""));
    b.type = "button";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(!!on));
    b.appendChild(document.createTextNode(catName(c)));
    var addon = c.addonName || addonName(c.addonId);
    if (addon && S.addons.length > 1) b.appendChild(el("span", "pill-sub", addon));
    b.addEventListener("click", function () { location.hash = catHref(c); });
    D.catpills.appendChild(b);
  });

  updateCount();
}

function addonName(id) {
  var hit = "";
  S.addons.some(function (a) {
    if (a && (a.id === id || (a.manifest && a.manifest.id === id))) {
      hit = (a.manifest && a.manifest.name) || a.name || "";
      return true;
    }
    return false;
  });
  return hit;
}

function updateCount() {
  if (!D.catcount) return;
  if (S.view === "search") {
    D.catcount.textContent = "";
  } else {
    D.catcount.textContent = S.items.length
      ? S.items.length + " item" + (S.items.length === 1 ? "" : "s") + (S.exhausted ? "" : " …")
      : "";
  }
  show(D.loadmore, S.view === "board" && S.items.length > 0 && !S.exhausted && !S.loading);
}

function loadCatalog(cat, reset) {
  if (!cat) return;
  if (reset) { S.items = []; S.skip = 0; S.exhausted = false; setWallItems([], false); stage("loading"); }
  if (S.loading || S.exhausted) return;
  S.loading = true;
  updateCount();

  var mySkip = S.skip;
  var extra = boardExtra(cat, mySkip);
  /* the token covers the FILTERS too: flipping a genre mid-flight must discard
     the in-flight page instead of appending it under the new pill */
  var token = catToken(cat) + "|" + JSON.stringify(BOARD.filters);

  call(window.Addons, "catalog", cat.addonId, cat.type, cat.id, extra).then(function (res) {
    S.loading = false;
    /* the user may have switched catalogs or filters mid-flight */
    if (!S.cat || (catToken(S.cat) + "|" + JSON.stringify(BOARD.filters)) !== token) return;

    var page = arr(res).map(function (m) { return normalize(m, cat.type); }).filter(Boolean);
    var seen = {};
    S.items.forEach(function (m) { seen[m.id] = 1; });
    var fresh = page.filter(function (m) { return !seen[m.id]; });

    /* The data layer stamps `hasMore` on the result array as the addon stated
       it: true, false, or NULL for "the addon did not say". Null means keep
       paging until a page comes back empty — most addons never send the field,
       and treating that silence as `false` is what used to stop the board at
       one page. */
    var hasMore = (res && res.hasMore !== null && typeof res.hasMore !== "undefined")
      ? !!res.hasMore : null;

    if (!page.length || !fresh.length) S.exhausted = true;
    else {
      S.items = S.items.concat(fresh);
      /* Stremio `skip` is an ITEM OFFSET, not a page number — advance it by the
         size of the page the addon actually returned. */
      S.skip = mySkip + page.length;
      if (hasMore === false) S.exhausted = true;
      if (S.items.length >= MAX_ITEMS) S.exhausted = true;
      /* no `skip` extra means there is no second page to ask for */
      if (!cat.supportsSkip) S.exhausted = true;
    }

    if (S.view === "board") {
      setWallItems(S.items, mySkip === 0);
      stage(S.items.length ? "ok" : "empty", emptyCatalogOpts());
    }
    updateCount();
  });
}

function loadMore() {
  if (S.view !== "board" || S.loading || S.exhausted || !S.cat) return;
  loadCatalog(S.cat, false);
}

function normalize(m, dfltType) {
  if (!m || !m.id) return null;
  m.type = m.type || dfltType;
  return markExternal(m);
}

/* ============================================================= SEARCH view */
function viewSearch(q) {
  setView("search");
  closeOverlays();
  show(D.catalogbar, false);
  show(D.continue, false);
  call(S.wall, "layout", "wall");
  S.q = txt(q);
  if (D.search_input && D.search_input.value !== S.q) D.search_input.value = S.q;
  show(D.search_clear, !!S.q);
  runSearch(S.q, /*fromRoute*/ true);
  if (D.search_input && document.activeElement !== D.search_input) D.search_input.focus();
}

/**
 * Instant search.
 *  - exact cache hit  -> rendered SYNCHRONOUSLY, no network, no flicker
 *  - prefix cache hit -> rendered immediately as a stale preview, refined after
 *  - every in-flight query carries a sequence token; stale replies are dropped
 */
function runSearch(q, fromRoute) {
  q = txt(q).trim();
  S.q = q;
  clearTimeout(searchTimer);

  if (q.length < SEARCH_MIN) {
    S.searchSeq++;                       /* cancel anything in flight */
    S.results = [];
    setWallItems([], false);
    setSearchStatus(false);
    stage("empty", {
      title: q.length ? "Keep typing…" : "Search everything",
      body: "Type at least " + SEARCH_MIN + " characters. Results stream in from every installed " +
            "addon that supports search, merged and deduplicated."
    });
    return;
  }

  if (searchCache.has(q)) {              /* instant path */
    S.searchSeq++;
    paintResults(searchCache.get(q), q);
    setSearchStatus(false);
    return;
  }

  var stale = bestPrefix(q);
  if (stale) { paintResults(searchCache.get(stale), q, /*stale*/ true); setSearchStatus(true, "Refining…"); }
  else {
    /* Registry hits are LOCAL — paint them the instant the query arrives instead
       of waiting on the network, and so that they still show if no addon ever
       answers. When nothing in the registry matches we keep the loading stage,
       so an empty registry never masquerades as "no results" while addons are
       still in flight. */
    if (registryMatches(q).length) paintResults([], q, /*stale*/ true);
    else { setWallItems([], false); stage("loading"); }
    setSearchStatus(true, "Searching…");
  }

  var seq = ++S.searchSeq;
  var delay = fromRoute ? 0 : SEARCH_DEBOUNCE;
  searchTimer = setTimeout(function () {
    call(window.Addons, "search", q).then(function (res) {
      if (seq !== S.searchSeq) return;   /* stale reply — drop */
      var list = arr(res).map(function (m) { return normalize(m, m && m.type); }).filter(Boolean);
      searchCache.set(q, list);
      if (searchCache.size > 120) searchCache.delete(searchCache.keys().next().value);
      setSearchStatus(false);
      paintResults(list, q);
    });
  }, delay);
}

function bestPrefix(q) {
  var best = "";
  searchCache.forEach(function (_v, k) {
    if (q.indexOf(k) === 0 && k.length > best.length) best = k;
  });
  return best || null;
}

/** Rows of verified_sources.md whose title/name/notes contain the query.
    Matching is a plain case-insensitive substring — the registry is a handful of
    curated rows, not a corpus, so anything cleverer would only add surprise. */
function registryMatches(q) {
  if (!window.Registry) return [];
  var needle = txt(q).trim().toLowerCase();
  if (!needle) return [];
  return window.Registry.items().filter(function (m) {
    var hay = (txt(m.title) + " " + txt(m.name) + " " + txt(m.description)).toLowerCase();
    return hay.indexOf(needle) >= 0;
  });
}

/* The registry IS the product, so its hits lead every result set. Merging here
   rather than in runSearch is deliberate: paintResults is the single choke point
   for all three search paths (exact cache hit, stale-prefix preview, and the
   network reply), so registry rows appear on every one of them — and because the
   merge happens at paint time it always reflects the CURRENT registry, even if a
   row was added to verified_sources.md after the addon results were cached.
   Registry ids are `hp:`-prefixed and so cannot collide with addon ids; the
   filter is belt-and-braces against an addon that ever mints the same id. */
function paintResults(list, q, isStale) {
  var reg = registryMatches(q);
  var rest = arr(list).filter(function (m) {
    return !reg.some(function (r) { return r.id === (m && m.id); });
  });
  S.results = reg.concat(rest);
  if (S.view !== "search") return;
  setWallItems(S.results, true);
  if (S.results.length) stage("ok");
  else if (!isStale) {
    stage("empty", {
      title: "No results for “" + q + "”",
      body: "No installed addon returned a match. Check the spelling, or install another catalog " +
            "addon that covers this content.",
      actions: [{ label: "Manage addons", onClick: function () { location.hash = "#settings"; } }]
    });
  }
  updateCount();
}

function setStatus(on, label) {
  if (!D.searchstatus) return;
  show(D.searchstatus, !!on);
  if (on) {
    clear(D.searchstatus);
    D.searchstatus.appendChild(el("span", "spinner sm"));
    D.searchstatus.appendChild(el("span", null, label || "Loading…"));
  }
}
function setSearchStatus(on, label) { setStatus(on, label || "Searching…"); }

/* ============================================================= DETAIL view */
function viewDetail(type, id) {
  /* keep whatever view is underneath; detail is an overlay */
  closeOverlays();
  show(D.detail, true);
  D.detail.setAttribute("aria-hidden", "false");
  if (D.d_scroll) D.d_scroll.scrollTop = 0;

  S.detail = { type: type, id: id, meta: null, season: null, video: null };
  var seq = ++S.detailSeq;

  var cached = metaCache.get(key(type, id));
  if (cached) paintDetail(cached);
  else resetDetailSkeleton();

  call(window.Addons, "meta", type, id).then(function (meta) {
    if (seq !== S.detailSeq) return;
    if (!meta) {
      if (!cached) paintDetail({ id: id, type: type, name: id, description: "" });
      toast("Could not load details for this title.", "err", "Metadata unavailable");
    } else {
      metaCache.set(key(type, id), meta);
      paintDetail(meta);
    }
  });
}

function resetDetailSkeleton() {
  show(D.d_poster_sk, true);
  if (D.d_poster) { D.d_poster.removeAttribute("src"); D.d_poster.classList.remove("loaded"); }
  if (D.d_backdrop) { D.d_backdrop.removeAttribute("src"); D.d_backdrop.classList.remove("loaded"); }
  if (D.d_title) D.d_title.textContent = "Loading…";
  clear(D.d_meta); clear(D.d_genres); clear(D.d_cast);
  if (D.d_desc) D.d_desc.textContent = "";
  show(D.d_series, false);
  clear(D.d_streams_body);
  if (D.d_streams_for) D.d_streams_for.textContent = "";
}

function paintDetail(meta) {
  if (!S.detail) return;
  S.detail.meta = meta;
  var type = meta.type || S.detail.type;

  if (D.d_title) D.d_title.textContent = meta.name || meta.title || S.detail.id;

  if (D.d_poster && meta.poster) {
    D.d_poster.classList.remove("loaded");
    D.d_poster.onload = function () { D.d_poster.classList.add("loaded"); show(D.d_poster_sk, false); };
    D.d_poster.onerror = function () { show(D.d_poster_sk, false); };
    D.d_poster.src = meta.poster;
  } else { show(D.d_poster_sk, false); }

  if (D.d_backdrop) {
    var bg = meta.background || meta.poster;
    if (bg) {
      D.d_backdrop.classList.remove("loaded");
      D.d_backdrop.onload = function () { D.d_backdrop.classList.add("loaded"); };
      D.d_backdrop.src = bg;
    }
  }

  /* meta line ---------------------------------------------------------- */
  clear(D.d_meta);
  var bits = [];
  if (type) bits.push(type === "series" ? "Series" : type.charAt(0).toUpperCase() + type.slice(1));
  var y = year(meta); if (y) bits.push(y);
  var rt = fmtRuntime(meta.runtime); if (rt) bits.push(rt);
  if (meta.country) bits.push(meta.country);
  bits.forEach(function (b, i) {
    if (i) D.d_meta.appendChild(el("span", "dot"));
    D.d_meta.appendChild(el("span", null, b));
  });
  if (meta.imdbRating) {
    if (bits.length) D.d_meta.appendChild(el("span", "dot"));
    D.d_meta.appendChild(el("span", "imdb", "★ " + meta.imdbRating));
  }

  /* genres -------------------------------------------------------------- */
  clear(D.d_genres);
  arr(meta.genres || meta.genre).slice(0, 8).forEach(function (g) {
    D.d_genres.appendChild(el("span", "chip", g));
  });

  if (D.d_desc) D.d_desc.textContent = meta.description || meta.overview || "No description available.";

  clear(D.d_cast);
  var cast = arr(meta.cast).slice(0, 8);
  var dirs = arr(meta.director);
  if (dirs.length) {
    D.d_cast.appendChild(el("b", null, "Director "));
    D.d_cast.appendChild(document.createTextNode(dirs.join(", ") + (cast.length ? "  ·  " : "")));
  }
  if (cast.length) {
    D.d_cast.appendChild(el("b", null, "Cast "));
    D.d_cast.appendChild(document.createTextNode(cast.join(", ")));
  }

  /* external link -------------------------------------------------------- */
  var imdb = (meta.imdb_id || (/^tt\d+/.test(txt(meta.id)) ? txt(meta.id).split(":")[0] : ""));
  if (D.d_ext) {
    if (imdb) { D.d_ext.href = "https://www.imdb.com/title/" + imdb + "/"; show(D.d_ext, true); }
    else show(D.d_ext, false);
  }

  syncLibButton();

  /* series --------------------------------------------------------------- */
  var videos = arr(meta.videos);
  if (type === "series" && videos.length) {
    show(D.d_series, true);
    renderSeasons(videos);
  } else {
    show(D.d_series, false);
    loadStreams(type, meta.id || S.detail.id, null);
  }
}

function renderSeasons(videos) {
  var seasons = [];
  videos.forEach(function (v) {
    var s = (v.season != null ? v.season : 1);
    if (seasons.indexOf(s) < 0) seasons.push(s);
  });
  /* seasons 1..n first (ascending), then Specials (season 0) and any other
     non-standard seasons at the very end (user request) */
  seasons.sort(function (a, b) {
    var ra = a >= 1 ? a : Infinity, rb = b >= 1 ? b : Infinity;
    return ra !== rb ? ra - rb : a - b;
  });
  var pick = S.detail.season != null ? S.detail.season
           : (seasons.indexOf(1) >= 0 ? 1 : seasons[0]);
  S.detail.season = pick;

  clear(D.d_seasons);
  seasons.forEach(function (s) {
    var b = el("button", "pill" + (s === pick ? " on" : ""), s === 0 ? "Specials" : "Season " + s);
    b.type = "button";
    b.setAttribute("role", "tab");
    b.addEventListener("click", function () { S.detail.season = s; renderSeasons(videos); });
    D.d_seasons.appendChild(b);
  });

  var eps = videos.filter(function (v) { return (v.season != null ? v.season : 1) === pick; })
                  .sort(function (a, b) { return (a.episode || 0) - (b.episode || 0); });
  if (D.d_epcount) D.d_epcount.textContent = eps.length + " episode" + (eps.length === 1 ? "" : "s");

  clear(D.d_episodes);
  eps.forEach(function (v, i) {
    var vid = v.id || (S.detail.id + ":" + pick + ":" + (v.episode || i + 1));
    var b = el("button", "ep");
    b.type = "button";
    b.appendChild(el("span", "ep-n", (pick || 0) + "×" + String(v.episode || i + 1).padStart(2, "0")));
    var main = el("div", "ep-main");
    main.appendChild(el("div", "ep-name", v.name || v.title || "Episode " + (v.episode || i + 1)));
    if (v.overview || v.description) main.appendChild(el("div", "ep-desc", v.overview || v.description));
    b.appendChild(main);
    if (v.released || v.firstAired) {
      b.appendChild(el("span", "ep-date", String(v.released || v.firstAired).slice(0, 10)));
    }
    b.addEventListener("click", function () {
      D.d_episodes.querySelectorAll(".ep").forEach(function (n) { n.classList.remove("on"); });
      b.classList.add("on");
      S.detail.video = v;
      loadStreams("series", vid, v);
      /* the auto-selection on open must not yank the page down */
      if (!S.detail.autoSel && D.d_streams) {
        D.d_streams.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
    D.d_episodes.appendChild(b);
  });

  /* auto-select the first episode so a Streams list is always present */
  if (eps.length) {
    var firstBtn = D.d_episodes.querySelector(".ep");
    if (firstBtn) {
      S.detail.autoSel = true;
      firstBtn.click();
      S.detail.autoSel = false;
    }
  } else {
    loadStreams("series", S.detail.id, null);
  }
}

/* ------------------------------------------------------------- streams */
var streamSeq = 0;
function loadStreams(type, id, video) {
  if (!D.d_streams_body) return;
  var seq = ++streamSeq;
  S.detail.streamId = id;

  if (D.d_streams_for) {
    D.d_streams_for.textContent = video
      ? "for " + (video.name || ("episode " + (video.episode || "?")))
      : "";
  }

  clear(D.d_streams_body);
  var load = el("div", "note");
  load.appendChild(el("span", "spinner sm"));
  load.appendChild(document.createTextNode("  Asking every installed addon for streams…"));
  D.d_streams_body.appendChild(load);

  call(window.Addons, "streams", type, id).then(function (res) {
    if (seq !== streamSeq) return;
    renderStreams(arr(res), type, id, video);
  });
}

function renderStreams(list, type, id, video) {
  clear(D.d_streams_body);

  if (!list.length) {
    var n = el("div", "note");
    n.appendChild(el("b", null, "No streams found."));
    n.appendChild(document.createTextNode(
      " No installed addon returned a source for this title. Stream addons (the ones that serve " +
      "the “stream” resource) must be installed separately — add one in Settings."));
    D.d_streams_body.appendChild(n);
    return;
  }

  /* order: best quality first, then most peers/seeders (user request) */
  var ordered = list.slice().sort(function (a, b) {
    var dq = qRank(b) - qRank(a); if (dq) return dq;
    return seeders(b) - seeders(a);
  });

  /* persisted quality filter: a pill per quality present; a stream with no
     detectable quality (direct HLS / live) always shows and is never filtered. */
  var present = [];
  ordered.forEach(function (s) { var q = quality(s); if (q && present.indexOf(q) < 0) present.push(q); });
  present.sort(function (a, b) { return (Q_RANK[b] || 0) - (Q_RANK[a] || 0); });
  var disabled = loadQDisabled();

  if (present.length > 1) {
    var bar = el("div", "qfilter");
    bar.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;margin:0 0 12px";
    var lab = el("span", null, "Quality");
    lab.style.cssText = "font:11px/1 -apple-system,sans-serif;color:rgba(255,255,255,.4);margin:0 8px 6px 0;text-transform:uppercase;letter-spacing:.06em";
    bar.appendChild(lab);
    present.forEach(function (q) {
      var on = !disabled.has(q);
      var pill = el("button", "qpill", q);
      pill.type = "button";
      pill.style.cssText = "cursor:pointer;font:11px/1 -apple-system,sans-serif;padding:5px 11px;border-radius:999px;margin:0 6px 6px 0;transition:background .15s,border-color .15s,color .15s;" +
        "border:1px solid " + (on ? "rgba(245,56,123,.6)" : "rgba(255,255,255,.15)") + ";" +
        "background:" + (on ? "rgba(245,56,123,.18)" : "transparent") + ";color:" + (on ? "#f5387b" : "rgba(255,255,255,.5)");
      pill.addEventListener("click", function () {
        if (disabled.has(q)) disabled.delete(q); else disabled.add(q);
        saveQDisabled(disabled);
        renderStreams(list, type, id, video);
      });
      bar.appendChild(pill);
    });
    D.d_streams_body.appendChild(bar);
  }

  var shown = ordered.filter(function (s) { var q = quality(s); return !q || !disabled.has(q); });
  if (!shown.length) {
    var nn = el("div", "note");
    nn.appendChild(el("b", null, "No streams match the quality filter."));
    nn.appendChild(document.createTextNode(" Re-enable a quality above to see sources."));
    D.d_streams_body.appendChild(nn);
    return;
  }

  shown.forEach(function (s) {
    var b = el("button", "stream");
    b.type = "button";

    b.appendChild(el("span", "stream-addon", s.addonName || s.addon || s.name || "stream"));

    var main = el("div", "stream-main");
    var title = s.title || s.description || s.name || "Play";
    var lines = txt(title).split("\n");
    main.appendChild(el("div", "stream-title", lines[0]));
    if (lines.length > 1) main.appendChild(el("div", "stream-sub", lines.slice(1).join(" · ")));
    else if (s.description && s.description !== title) main.appendChild(el("div", "stream-sub", s.description));
    b.appendChild(main);

    var tags = el("div", "stream-tags");
    var q = quality(s);
    if (q) tags.appendChild(el("span", "chip chip-accent", q));
    var sd = seeders(s);
    if (sd > 0) tags.appendChild(el("span", "chip", "👤 " + sd));
    if (s.infoHash || /^magnet:/i.test(txt(s.url))) tags.appendChild(el("span", "chip", "torrent"));
    else if (s.externalUrl) tags.appendChild(el("span", "chip", "external"));
    else if (/\.m3u8(\?|$)/i.test(txt(s.url))) tags.appendChild(el("span", "chip", "HLS"));
    b.appendChild(tags);

    /* copy-magnet control (torrent streams only). A <span>, not a nested <button>,
       and it stops propagation so copying never triggers playback. */
    var mag = (window.Player && window.Player.magnetOf)
      ? window.Player.magnetOf(s, s.title || s.name)
      : (/^magnet:/i.test(txt(s.url)) ? txt(s.url) : "");
    if (mag) {
      var cp = el("span", "stream-copy", "📋 magnet");
      cp.title = "Copy magnet link";
      cp.setAttribute("role", "button");
      cp.setAttribute("tabindex", "0");
      cp.setAttribute("aria-label", "Copy magnet link");
      cp.addEventListener("click", function (e) { e.stopPropagation(); e.preventDefault(); copyMagnet(mag); });
      b.appendChild(cp);
    }

    var go = el("span", "stream-go", "▶");
    b.appendChild(go);

    b.addEventListener("click", function () { playStream(s, video); });
    D.d_streams_body.appendChild(b);
  });
}

/* copy a magnet link to the clipboard, with a legacy fallback + toast feedback */
function copyMagnet(mag) {
  function ok() { toast("Magnet link copied", "info"); }
  function fail() { toast("Copy failed — long-press to copy manually", "err"); }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(mag).then(ok, function () { legacyCopy(mag) ? ok() : fail(); });
      return;
    }
  } catch (e) {}
  legacyCopy(mag) ? ok() : fail();
}
function legacyCopy(t) {
  try {
    var ta = document.createElement("textarea");
    ta.value = t; ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.top = "-1000px"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, t.length);
    var okc = document.execCommand("copy");
    document.body.removeChild(ta);
    return okc;
  } catch (e) { return false; }
}

function quality(s) {
  var hay = [s.name, s.title, s.description].map(txt).join(" ");
  if (/\b(2160p?|4k|uhd)\b/i.test(hay)) return "4K";
  if (/\b1440p\b/i.test(hay)) return "1440p";
  if (/\b1080p?\b/i.test(hay)) return "1080p";
  if (/\b720p?\b/i.test(hay)) return "720p";
  if (/\b(480p?|sd)\b/i.test(hay)) return "480p";
  if (/\bcam\b/i.test(hay)) return "CAM";
  return "";
}

/* stream ordering + persisted quality filter (user request) */
var Q_KEY = "hp.qfilter";     /* localStorage: JSON array of DISABLED quality labels */
var Q_RANK = { "4K": 6, "1440p": 5, "1080p": 4, "720p": 3, "480p": 2, "CAM": 1 };
function qRank(s) { return Q_RANK[quality(s)] || 0; }
function seeders(s) {
  var hay = [s.name, s.title, s.description].map(txt).join(" ");
  var m = hay.match(/👤\s*(\d+)/) || hay.match(/(\d+)\s*👤/) || hay.match(/seed(?:ers)?[:\s]+(\d+)/i);
  if (m) return parseInt(m[1], 10) || 0;
  var f = parseInt(s.seeders != null ? s.seeders : (s.seed != null ? s.seed : 0), 10);
  return isFinite(f) ? f : 0;
}
function loadQDisabled() { try { return new Set(JSON.parse(localStorage.getItem(Q_KEY) || "[]")); } catch (e) { return new Set(); } }
function saveQDisabled(set) { try { localStorage.setItem(Q_KEY, JSON.stringify(Array.from(set))); } catch (e) {} }

function playStream(stream, video) {
  var meta = S.detail && S.detail.meta;
  if (!window.Player || typeof window.Player.play !== "function") {
    toast("The player module is not loaded yet — js/player.js has not registered window.Player.",
          "err", "Cannot play");
    return;
  }
  try {
    bindPlayerClose();
    window.Player.play({ stream: stream, meta: meta, video: video || null });
  } catch (e) {
    if (window.ErrLog) ErrLog.push('player', 'Player.play threw: ' + (e && e.message), (stream && stream.url || stream && stream.infoHash || '').slice ? String(stream.url || stream.infoHash).slice(0, 200) : '');
    toast("The player refused this stream.", "err", "Playback failed");
  }
}

/* -------------------------------------------------------------- library */
function syncLibButton() {
  if (!D.d_lib || !S.detail) return;
  var k = key(S.detail.type, S.detail.id);
  var on = !!S.library[k];
  D.d_lib.textContent = on ? "✓ In library" : "Add to library";
  D.d_lib.classList.toggle("on", on);
}

function toggleLibrary() {
  if (!S.detail) return;
  var k = key(S.detail.type, S.detail.id);
  var m = S.detail.meta || {};
  if (S.library[k]) { delete S.library[k]; toast("Removed from your library.", "info"); }
  else {
    S.library[k] = {
      type: S.detail.type, id: S.detail.id,
      name: m.name || S.detail.id, poster: m.poster || "", added: Date.now()
    };
    toast("Added to your library.", "ok");
  }
  lsSet(LS_LIB, S.library);
  syncLibButton();
  renderSettingsData();
  homeCache.delete("__lib");
}

/* ------------------------------------------------- continue watching ----
   The player is the writer of record: it persists to localStorage key `cw`
   as an ARRAY of {id, video, position, duration, title, sub, type, poster,
   updated(ISO)}. This shell reads that same store — through Player's helpers
   when they exist, straight from localStorage when the module is missing —
   so a title never appears twice or drifts out of sync. */
function cwList() {
  if (window.Player && typeof window.Player.cw === "function") {
    try { var v = window.Player.cw(); if (Array.isArray(v)) return v; } catch (e) {}
  }
  return lsGet(LS_CONT, []);
}
function cwWrite(list) {
  S.cont = arr(list);
  lsSet(LS_CONT, S.cont);
  renderContinue();
  renderSettingsData();
}
function cwSame(a, b) {
  return txt(a.id) === txt(b.id) && txt(a.video || "") === txt(b.video || "");
}

/** Public: report playback progress from any lane. */
function saveProgress(p) {
  if (!p || !p.id) return;
  var list = cwList().slice();
  var rec = {
    id: p.id, video: p.video || "",
    position: Number(p.position != null ? p.position : (p.time || 0)) || 0,
    duration: Number(p.duration || 0) || 0,
    title: p.title || p.name || p.id,
    sub: p.sub || p.videoName || "",
    type: p.type || null,
    poster: p.poster || null,
    updated: new Date().toISOString()
  };
  var prev = null;
  list = list.filter(function (r) {
    if (cwSame(r, rec)) { prev = r; return false; }
    return true;
  });
  if (prev) {
    if (!rec.poster) rec.poster = prev.poster;
    if (!rec.duration) rec.duration = prev.duration;
    if (!rec.position) rec.position = prev.position;
    if (!rec.sub) rec.sub = prev.sub;
  }
  list.unshift(rec);
  cwWrite(list.slice(0, 120));
}
function getProgress(id, video) {
  if (window.Player && typeof window.Player.cwGet === "function") {
    try { return window.Player.cwGet(id, video || ""); } catch (e) {}
  }
  var hit = null;
  cwList().some(function (r) { if (cwSame(r, { id: id, video: video || "" })) { hit = r; return true; } return false; });
  return hit;
}
function removeProgress(id, video) {
  if (window.Player && typeof window.Player.cwDrop === "function") {
    try { window.Player.cwDrop(id, video || ""); cwWrite(cwList()); return; } catch (e) {}
  }
  cwWrite(cwList().filter(function (r) { return !cwSame(r, { id: id, video: video || "" }); }));
}

function refreshContinue() {
  var fresh = cwList();
  if (JSON.stringify(fresh) === JSON.stringify(S.cont)) return;
  S.cont = fresh;
  renderContinue();
  renderSettingsData();
}

/* Continue-watching as an auto-collapsed right sidebar (user request): the existing
   #continue section is lifted out of the shell grid into a fixed panel that slides
   in from the right, plus a vertical tab to expand/collapse it. Hidden until the
   tab is clicked; open/closed choice persists. Built once, lazily. */
function ensureCwSidebar() {
  if (S._cwSideBuilt || !D.continue) return;
  S._cwSideBuilt = true;
  var side = D.continue;
  side.hidden = false;   /* visibility is now the transform + tab, not [hidden] */
  /* inline display:block beats the stylesheet's `.cw[hidden]{display:none}`, so a
     stray show(D.continue,false) on a view change can't kill the sidebar. */
  side.style.cssText = "display:block;position:fixed;top:0;right:0;height:100vh;width:300px;max-width:86vw;z-index:9200;" +
    "background:rgba(13,13,15,.94);border-left:1px solid rgba(245,56,123,.25);box-shadow:-14px 0 44px rgba(0,0,0,.5);" +
    "padding:18px 14px 24px;overflow-y:auto;transform:translateX(100%);transition:transform .32s cubic-bezier(.4,0,.2,1);" +
    "-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)";
  if (D.cw_row) D.cw_row.style.cssText = "display:flex;flex-direction:column;gap:12px;overflow:visible";
  var tab = document.createElement("button");
  tab.id = "hp-cw-tab"; tab.type = "button";
  tab.textContent = "▶ Continue";
  tab.style.cssText = "position:fixed;top:50%;right:0;transform:translateY(-50%);z-index:9201;display:none;" +
    "writing-mode:vertical-rl;font:12px/1 -apple-system,BlinkMacSystemFont,sans-serif;color:#f5387b;letter-spacing:.08em;" +
    "background:rgba(13,13,15,.86);border:1px solid rgba(245,56,123,.4);border-right:none;border-radius:9px 0 0 9px;" +
    "padding:14px 6px;cursor:pointer;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)";
  tab.addEventListener("click", function () { setCwOpen(!S._cwOpen, true); });
  document.body.appendChild(tab);
  S._cwTab = tab;
  var saved = null; try { saved = localStorage.getItem("hp.cw.open"); } catch (e) {}
  setCwOpen(saved === "1", false);
}
function setCwOpen(open, persist) {
  S._cwOpen = !!open;
  if (D.continue) D.continue.style.transform = open ? "translateX(0)" : "translateX(100%)";
  if (S._cwTab) S._cwTab.textContent = open ? "◀ Continue" : "▶ Continue";
  if (persist) { try { localStorage.setItem("hp.cw.open", open ? "1" : "0"); } catch (e) {} }
}

function renderContinue() {
  if (!D.continue || !D.cw_row) return;
  var list = arr(S.cont).slice().sort(function (a, b) {
    return String(b.updated || "").localeCompare(String(a.updated || ""));
  });
  ensureCwSidebar();
  if (S._cwTab) S._cwTab.style.display = list.length > 0 ? "" : "none";
  if (!list.length) { setCwOpen(false, false); return; }

  clear(D.cw_row);
  list.forEach(function (c) {
    var card = el("div", "cw-card");
    card.tabIndex = 0;

    var thumb = el("div", "cw-thumb");
    var src = c.poster || c.background;
    if (src) {
      var img = new Image();
      img.loading = "lazy"; img.decoding = "async"; img.alt = "";
      img.addEventListener("load", function () { img.classList.add("loaded"); });
      img.addEventListener("error", function () { img.remove(); });
      img.src = src;
      thumb.appendChild(img);
    }
    var play = el("div", "cw-play");
    play.innerHTML = '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M8 5l12 7-12 7z" fill="currentColor"/></svg>';
    thumb.appendChild(play);
    card.appendChild(thumb);

    var bar = el("div", "cw-bar");
    var pct = (c.duration > 0) ? Math.min(100, (c.position / c.duration) * 100) : 0;
    var fill = el("i"); fill.style.width = pct.toFixed(1) + "%";
    bar.appendChild(fill);
    card.appendChild(bar);

    var body = el("div", "cw-body");
    body.appendChild(el("div", "cw-title", c.title || c.id));
    var left = (c.duration > 0)
      ? fmtTime(c.position) + " / " + fmtTime(c.duration)
      : "Not started";
    body.appendChild(el("div", "cw-sub", c.sub ? c.sub + " · " + left : left));
    card.appendChild(body);

    var x = el("button", "cw-x", "✕");
    x.type = "button";
    x.title = "Remove";
    x.addEventListener("click", function (e) { e.stopPropagation(); removeProgress(c.id, c.video); });
    card.appendChild(x);

    function open() {
      var t = c.type || (/^tt/.test(txt(c.id)) && c.video ? "series" : "movie");
      location.hash = "#detail/" + enc(t) + "/" + enc(c.id);
    }
    card.addEventListener("click", open);
    card.addEventListener("keydown", function (e) { if (e.key === "Enter") open(); });

    D.cw_row.appendChild(card);
  });
}

/* The shell re-reads the shared store whenever the player could have written
   to it: on close, on tab focus, and from another tab via the storage event. */
function bindExternalProgress() {
  window.addEventListener("cs:progress", function (e) {
    if (e && e.detail) saveProgress(e.detail);
  });
  window.addEventListener("storage", function (e) {
    if (e.key === LS_CONT) refreshContinue();
    if (e.key === LS_LIB)  { S.library = lsGet(LS_LIB, {}); syncLibButton(); }
  });
  window.addEventListener("focus", refreshContinue);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) refreshContinue();
  });
}

/* Hook the player's close event once it exists (it loads after this file). */
function bindPlayerClose() {
  if (!window.Player) return;
  var prev = window.Player.onclose;
  window.Player.onclose = function () {
    if (typeof prev === "function") { try { prev.apply(this, arguments); } catch (e) {} }
    refreshContinue();
  };
}

/* =========================================================== SETTINGS view */
function viewSettings() {
  setView("settings");
  closeOverlays();
  show(D.settings, true);
  D.settings.setAttribute("aria-hidden", "false");
  renderSettingsList();
  renderSettingsData();
}

function renderSettingsList() {
  if (!D.s_list) return;
  clear(D.s_list);
  if (D.s_count) D.s_count.textContent = S.addons.length + " installed";

  if (!S.addons.length) {
    var n = el("div", "note");
    n.appendChild(el("b", null, "No addons installed."));
    n.appendChild(document.createTextNode(
      " Add a manifest URL above — Cinemeta gives you the movie and series catalogs."));
    D.s_list.appendChild(n);
    return;
  }

  S.addons.forEach(function (a, idx) {
    var m = a.manifest || a || {};
    var row = el("div", "addon");

    if (m.logo || m.icon) {
      var img = new Image();
      img.className = "addon-logo"; img.alt = ""; img.loading = "lazy";
      img.addEventListener("error", function () {
        if (img.parentNode) img.parentNode.replaceChild(el("div", "addon-logo"), img);
      });
      img.src = m.logo || m.icon;
      row.appendChild(img);
    } else {
      row.appendChild(el("div", "addon-logo"));
    }

    var main = el("div", "addon-main");
    var name = el("div", "addon-name");
    name.appendChild(document.createTextNode(m.name || a.id || "Addon"));
    if (m.version) name.appendChild(el("span", "muted", "v" + m.version));
    main.appendChild(name);
    if (m.description) main.appendChild(el("div", "addon-desc", m.description));
    if (a.url) main.appendChild(el("div", "addon-url", a.url));

    var tags = el("div", "addon-tags");
    arr(m.types).slice(0, 5).forEach(function (t) { tags.appendChild(el("span", "chip", t)); });
    arr(m.resources).forEach(function (r) {
      var nm = typeof r === "string" ? r : (r && r.name);
      if (nm) tags.appendChild(el("span", "chip chip-ok", nm));
    });
    var nCat = arr(m.catalogs).length;
    if (nCat) tags.appendChild(el("span", "chip", nCat + " catalog" + (nCat === 1 ? "" : "s")));
    main.appendChild(tags);
    row.appendChild(main);

    /* order decides catalog priority on the board, so it is user-controlled */
    var ord = el("div", "addon-ord");
    [["\u2191", -1, "Move up", idx === 0],
     ["\u2193",  1, "Move down", idx === S.addons.length - 1]].forEach(function (spec) {
      var b = el("button", "ordbtn", spec[0]);
      b.type = "button";
      b.title = spec[2];
      b.setAttribute("aria-label", spec[2]);
      if (spec[3]) b.disabled = true;
      b.addEventListener("click", function () {
        call(window.Addons, "move", a.id || m.id, spec[1])
          .then(refreshAddons)
          .then(function () {
            renderSettingsList();
            S.cat = null;   /* catalog order changed — re-resolve on the board */
          });
      });
      ord.appendChild(b);
    });
    row.appendChild(ord);

    var rm = el("button", "btn btn-danger btn-sm", "Remove");
    rm.type = "button";
    rm.addEventListener("click", function () {
      rm.disabled = true;
      call(window.Addons, "remove", a.id || m.id).then(function () {
        return refreshAddons();
      }).then(function () {
        toast((m.name || "Addon") + " removed.", "info");
        renderSettingsList();
        if (S.view !== "settings") route();
        else { S.cat = null; }
      });
    });
    row.appendChild(rm);

    D.s_list.appendChild(row);
  });
}

function renderSettingsData() {
  if (D.s_libcount) D.s_libcount.textContent = String(Object.keys(S.library).length);
  if (D.s_cwcount)  D.s_cwcount.textContent  = String(arr(S.cont).length);
}

/* ---- add-by-URL: fetch the manifest, SHOW it, install only on confirm --- */
function previewManifest() {
  var url = txt(D.s_url && D.s_url.value).trim();
  if (!url) { toast("Paste a manifest URL first.", "err"); D.s_url.focus(); return; }
  /* HANDOFF NOTE (hp-catalog, outside the board region, authorised): one line,
     replacing two ad-hoc normalisation lines. The data layer's single choke
     point handles bare hosts, missing /manifest.json AND stremio:// share urls,
     so pasting a stremio:// link previews instead of failing. renderPreview
     passes this normalised url straight on to install(). */
  url = (window.Addons && window.Addons.manifestUrl) ? window.Addons.manifestUrl(url) : url;

  D.s_preview.disabled = true;
  D.s_preview.textContent = "Fetching…";

  fetchJSON(url, 8000).then(function (m) {
    D.s_preview.disabled = false;
    D.s_preview.textContent = "Preview";
    if (m && (m.id || m.name)) renderPreview(m, url);
    else renderPreview(null, url);
  });
}

function fetchJSON(url, ms) {
  return new Promise(function (resolve) {
    var done = false;
    var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (done) return;
      done = true;
      if (ctrl) { try { ctrl.abort(); } catch (e) {} }
      resolve(null);
    }, ms || 8000);
    fetch(url, ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (!done) { done = true; clearTimeout(timer); resolve(j); } })
      .catch(function () { if (!done) { done = true; clearTimeout(timer); resolve(null); } });
  });
}

function renderPreview(m, url) {
  var card = D.s_preview_card;
  if (!card) return;
  clear(card);
  show(card, true);

  if (!m) {
    card.appendChild(el("div", "pv-name", "Could not read that manifest"));
    card.appendChild(el("div", "pv-desc",
      "The URL did not return readable JSON — it may be offline, blocked by CORS, or not an " +
      "addon manifest. You can still try installing it; the data layer will report any failure."));
    var act = el("div", "pv-actions");
    var force = el("button", "btn btn-primary", "Install anyway");
    force.type = "button";
    force.addEventListener("click", function () { install(url, force); });
    var cancel = el("button", "btn", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", function () { show(card, false); });
    act.appendChild(force); act.appendChild(cancel);
    card.appendChild(act);
    return;
  }

  var top = el("div", "pv-top");
  if (m.logo || m.icon) {
    var img = new Image();
    img.className = "pv-logo"; img.alt = "";
    img.addEventListener("error", function () { img.remove(); });
    img.src = m.logo || m.icon;
    top.appendChild(img);
  }
  var info = el("div");
  var nm = el("div", "pv-name");
  nm.appendChild(document.createTextNode(m.name || m.id));
  if (m.version) nm.appendChild(el("span", "pv-ver", "  v" + m.version));
  info.appendChild(nm);
  if (m.description) info.appendChild(el("div", "pv-desc", m.description));
  top.appendChild(info);
  card.appendChild(top);

  var rows = el("div", "pv-rows");
  function row(label, chips, plain) {
    if (!chips || !chips.length) return;
    var r = el("div", "pv-row");
    r.appendChild(el("span", null, label));
    var box = el("div", "chips");
    chips.forEach(function (c) { box.appendChild(el("span", "chip" + (plain ? "" : " chip-ok"), c)); });
    r.appendChild(box);
    rows.appendChild(r);
  }
  row("Types", arr(m.types), true);
  row("Resources", arr(m.resources).map(function (r) { return typeof r === "string" ? r : (r && r.name); })
                                   .filter(Boolean));
  var cats = arr(m.catalogs).map(function (c) { return (c.type || "?") + " / " + (c.name || c.id || "?"); });
  row("Catalogs", cats.slice(0, 8), true);
  if (cats.length > 8) rows.appendChild(el("div", "pv-row", "… and " + (cats.length - 8) + " more"));
  card.appendChild(rows);

  var actions = el("div", "pv-actions");
  var ok = el("button", "btn btn-primary", "Install " + (m.name || "addon"));
  ok.type = "button";
  ok.addEventListener("click", function () { install(url, ok); });
  var no = el("button", "btn", "Cancel");
  no.type = "button";
  no.addEventListener("click", function () { show(card, false); });
  actions.appendChild(ok); actions.appendChild(no);
  card.appendChild(actions);
}

function install(url, btn) {
  if (btn) { btn.disabled = true; btn.textContent = "Installing…"; }
  call(window.Addons, "add", url).then(function (manifest) {
    if (btn) { btn.disabled = false; btn.textContent = "Install"; }
    if (!manifest) { toast("The addon could not be installed.", "err", "Install failed"); return; }
    show(D.s_preview_card, false);
    if (D.s_url) D.s_url.value = "";
    toast((manifest.name || "Addon") + " installed.", "ok");
    searchCache.clear();
    refreshAddons().then(function () {
      renderSettingsList();
      S.cat = null;   /* force a reload when the board is next shown */
    });
  });
}

/* ================================================================= chrome */
function bindChrome() {
  if (D.search_input) {
    D.search_input.addEventListener("input", function () {
      var q = D.search_input.value;
      show(D.search_clear, !!q.trim());
      if (S.view !== "search") {
        setView("search");
        closeOverlays();
        show(D.catalogbar, false);
      }
      /* replaceState: live typing must not flood browser history */
      try { history.replaceState(null, "", "#search/" + enc(q.trim())); } catch (e) {}
      runSearch(q, false);
    });
    D.search_input.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (D.search_input.value) { D.search_input.value = ""; D.search_input.dispatchEvent(new Event("input")); }
        else { D.search_input.blur(); location.hash = "#board"; }
      }
      if (e.key === "Enter") { D.search_input.blur(); }
      if (e.key === "ArrowDown") { e.preventDefault(); D.search_input.blur(); focusStage(); }
    });
    D.search_input.addEventListener("focus", function () {
      if (S.view !== "search" && D.search_input.value.trim().length >= SEARCH_MIN) {
        location.hash = "#search/" + enc(D.search_input.value.trim());
      }
    });
  }

  if (D.search_clear) {
    D.search_clear.addEventListener("click", function () {
      D.search_input.value = "";
      show(D.search_clear, false);
      D.search_input.focus();
      D.search_input.dispatchEvent(new Event("input"));
    });
  }

  if (D.loadmore) D.loadmore.addEventListener("click", loadMore);
  if (D.cw_clear) D.cw_clear.addEventListener("click", function () {
    cwWrite([]);
    toast("Continue watching cleared.", "info");
  });
}

function focusStage() {
  if (S.wallMode === "canvas" && D.wall) D.wall.focus();
  else if (D.grid) { D.grid.focus(); gridFocus("right"); }
}

function bindDetail() {
  if (D.d_close) D.d_close.addEventListener("click", goBack);
  if (D.d_lib)   D.d_lib.addEventListener("click", toggleLibrary);
  if (D.d_play)  D.d_play.addEventListener("click", function () {
    if (D.d_streams) D.d_streams.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  if (D.d_streams_reload) D.d_streams_reload.addEventListener("click", function () {
    if (!S.detail) return;
    loadStreams(S.detail.type, S.detail.streamId || S.detail.id, S.detail.video);
  });
}

function bindSettings() {
  if (D.s_close) D.s_close.addEventListener("click", goBack);
  if (D.s_preview) D.s_preview.addEventListener("click", previewManifest);
  if (D.s_url) D.s_url.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); previewManifest(); }
  });
  document.querySelectorAll("[data-fill]").forEach(function (b) {
    b.addEventListener("click", function () {
      if (!D.s_url) return;
      D.s_url.value = b.dataset.fill;
      D.s_url.focus();
      previewManifest();
    });
  });
  if (D.s_reset) D.s_reset.addEventListener("click", function () {
    S.library = {};
    lsSet(LS_LIB, S.library);
    cwWrite([]);
    syncLibButton();
    toast("Local library and history cleared.", "info");
  });
}

/* =============================================================== keyboard */
function isTyping(t) {
  if (!t) return false;
  var tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}

function bindKeys() {
  document.addEventListener("keydown", function (e) {
    /* the player owns the keyboard while it is up */
    if (window.Player && window.Player.isOpen && window.Player.isOpen()) return;

    if (e.key === "/" && !isTyping(e.target)) {
      e.preventDefault();
      if (S.view !== "search") location.hash = "#search/" + enc(txt(D.search_input && D.search_input.value).trim());
      if (D.search_input) { D.search_input.focus(); D.search_input.select(); }
      return;
    }

    if (e.key === "Escape") {
      if (isTyping(e.target)) return;              /* input handles its own Esc */
      if (D.detail && !D.detail.hidden)   { e.preventDefault(); goBack(); return; }
      if (D.settings && !D.settings.hidden) { e.preventDefault(); goBack(); return; }
      if (S.view === "search")            { e.preventDefault(); location.hash = "#board"; return; }
      return;
    }

    if (isTyping(e.target)) return;

    /* arrows: the wall engine owns them when it is the active surface */
    if (S.wallMode === "grid" && (S.view === "board" || S.view === "search") &&
        (!D.detail || D.detail.hidden) && (!D.settings || D.settings.hidden)) {
      var map = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
      if (map[e.key]) { if (gridFocus(map[e.key])) e.preventDefault(); return; }
      if (e.key === "Enter") { if (gridActivate()) e.preventDefault(); return; }
    }
  });
}

/* ============================================================= public API */
/* Sibling lanes (player) can report progress here, or dispatch the
   `cs:progress` CustomEvent on window — both land in the same store. */
function expose() {
  window.App = {
    saveProgress: saveProgress,
    getProgress: getProgress,
    removeProgress: removeProgress,
    library: function () { return S.library; },
    toast: toast,
    openDetail: function (type, id) { location.hash = "#detail/" + enc(type) + "/" + enc(id); },
    refresh: function () { searchCache.clear(); metaCache.clear(); return refreshAddons().then(route); },
    state: function () { return S; }
  };
}

})();
