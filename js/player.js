/* CoolStremio — player.js
 * window.Player : fullscreen video overlay.
 *   Player.play({stream, meta, video})  Player.close()  Player.isOpen()
 * Vanilla, no modules. Owns its own CSS (injected once). Charcoal + #f5387b.
 */
(function (window, document) {
  'use strict';

  // ---------------------------------------------------------------- constants
  var ENGINE = 'http://127.0.0.1:11470';
  var CW_KEY = 'cw';
  var VOL_KEY = 'plr.vol';
  var MUTE_KEY = 'plr.muted';   /* persisted mute choice, shared across every video */
  var IDLE_MS = 2500;
  var SAVE_MS = 10000;
  /* subtitles: config is shared (merge-safe) with the subs-autosync lane under
     ONE localStorage key; shape {mode:'off'|'lang', lang, size, color, bg, pos}. */
  var SUB_KEY = 'hp.subs.cfg';
  /* public OpenSubtitles v3 addon — CORS-open, always reachable, verified live:
     GET /subtitles/<type>/<id>.json -> {subtitles:[{id,url,lang,...}]} (UTF-8 SRT). */
  var SUB_DEFAULT_BASE = 'https://opensubtitles-v3.strem.io';
  /* tell the subs-autosync lane WE own on-screen rendering, so it never
     self-attaches a competing <track> (avoids double subtitles). __subsHostDriven
     additionally tells it WE drive auto-sync (via maybeAutoSync on cue-load), so
     its own Player.play wrapper must NOT also fire a second sync (avoids 2x whisper). */
  try { window.__subsRendererPresent = true; window.__subsHostDriven = true; } catch (e) {}
  /* brand pink, single source of truth: the rgb triplet is exported to CSS as
     --accRGB so every rgba() tint below is derived from the accent, never drifts */
  var ACC_RGB = '245,56,123';
  var ACC = 'rgb(' + ACC_RGB + ')';

  // vendor/hls.js resolved relative to THIS script so the app works from any base
  var HLS_URL = (function () {
    try {
      var s = document.currentScript;
      if (s && s.src) return new URL('../vendor/hls.js?v=83b3e31f', s.src).href;
    } catch (e) {}
    return 'vendor/hls.js?v=83b3e31f';
  })();

  // ------------------------------------------------------------------- styles
  var CSS = [
    '.plr-root{position:fixed;inset:0;z-index:99999;background:#08090b;color:#e9edf2;',
    'font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;',
    '-webkit-font-smoothing:antialiased;opacity:0;overflow:hidden;',
    /* one accent + two easings drive the entire sheet, so the chrome moves as one
       system: --e4 ease-out-quart, --e5 ease-out-quint. Durations stay 120-320ms. */
    '--acc:' + ACC + ';--accRGB:' + ACC_RGB + ';--accHi:#ff6fa3;',
    '--e4:cubic-bezier(0.165,0.84,0.44,1);--e5:cubic-bezier(0.23,1,0.32,1);',
    'transition:opacity .22s var(--e5)}',
    '.plr-root.plr-in{opacity:1}',
    '.plr-root video{position:absolute;inset:0;width:100%;height:100%;background:#000;object-fit:contain;outline:none}',
    '.plr-root *{box-sizing:border-box}',
    '.plr-root button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;padding:0}',

    /* top / bottom chrome */
    '.plr-top{position:absolute;top:0;left:0;right:0;padding:16px 18px 56px;display:flex;align-items:flex-start;gap:14px;',
    'background:linear-gradient(180deg,rgba(0,0,0,.86) 0%,rgba(0,0,0,.62) 46%,rgba(0,0,0,0) 100%);',
    'transition:opacity .24s var(--e4),transform .24s var(--e4);z-index:4}',
    '.plr-ttl{flex:1;min-width:0}',
    /* hierarchy: title (loud) -> provenance chips -> secondary line (quiet) */
    '.plr-ttl b{display:block;font-size:17px;font-weight:700;letter-spacing:-.1px;line-height:1.24;',
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.plr-ttl>span{display:block;margin-top:5px;font-size:12px;font-weight:500;color:#8b98a7;letter-spacing:.2px;',
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.plr-ttl>span:empty{display:none}',

    /* provenance chips - one chip language, one colour per lane. The row hides
       itself when the played item carries no lane/hls/live data at all. */
    '.plr-chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:8px}',
    '.plr-chips:empty{display:none}',
    '.plr-chip{--c:#9fb0c0;--cbg:rgba(159,176,192,.12);--cbd:rgba(159,176,192,.3);',
    'display:inline-flex;align-items:center;gap:5px;height:21px;padding:0 9px;border-radius:999px;',
    'font-size:10px;font-weight:700;letter-spacing:.7px;line-height:1;white-space:nowrap;',
    'color:var(--c);background:var(--cbg);border:1px solid var(--cbd);',
    'transition:background .18s var(--e4),border-color .18s var(--e4)}',
    '.plr-chip svg{width:11px;height:11px;fill:currentColor;display:block;flex:0 0 auto}',
    '.plr-chip .plr-gl{font-style:normal;font-size:11px;line-height:1;flex:0 0 auto}',
    '.plr-chip .plr-lb{display:block;line-height:1;flex:0 0 auto}',
    /* lane colours match the canvas wall lane badges exactly */
    '.plr-chip.plr-lane-ai{--c:#8b7cff;--cbg:rgba(139,124,255,.16);--cbd:rgba(139,124,255,.42)}',
    '.plr-chip.plr-lane-pv{--c:#2fd18b;--cbg:rgba(47,209,139,.15);--cbd:rgba(47,209,139,.42)}',
    '.plr-chip.plr-lane-demo{--c:#f0a83c;--cbg:rgba(240,168,60,.15);--cbd:rgba(240,168,60,.42)}',
    '.plr-chip.plr-live{--c:#ff8fb8;--cbg:rgba(var(--accRGB),.2);--cbd:rgba(var(--accRGB),.55)}',
    '.plr-chip .plr-dot{width:6px;height:6px;border-radius:50%;background:var(--acc);flex:0 0 auto;',
    'animation:plr-live 2s var(--e5) infinite}',
    '@keyframes plr-live{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(var(--accRGB),.6)}',
    '55%{opacity:.5;box-shadow:0 0 0 5px rgba(var(--accRGB),0)}}',
    '.plr-bot{position:absolute;left:0;right:0;bottom:0;padding:34px 18px 16px;',
    'background:linear-gradient(0deg,rgba(0,0,0,.94) 0%,rgba(0,0,0,.86) 30%,rgba(0,0,0,.62) 62%,rgba(0,0,0,.24) 84%,rgba(0,0,0,0) 100%);',
    'transition:opacity .24s var(--e4),transform .24s var(--e4);z-index:4}',
    '.plr-hide .plr-top{opacity:0;transform:translateY(-8px);pointer-events:none}',
    '.plr-hide .plr-bot{opacity:0;transform:translateY(8px);pointer-events:none}',
    '.plr-hide{cursor:none}',

    /* buttons */
    '.plr-btn,.plr-x{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;',
    'color:#cfd8e3;flex:0 0 auto;transition:background .16s var(--e4),color .16s var(--e4),transform .16s var(--e4)}',
    '.plr-btn:hover,.plr-x:hover{background:rgba(255,255,255,.11);color:#fff}',
    '.plr-btn:active,.plr-x:active{transform:scale(.9);background:rgba(255,255,255,.17)}',
    '.plr-btn.plr-on{color:var(--acc)}',
    '.plr-btn.plr-on:hover{background:rgba(var(--accRGB),.16);color:var(--accHi)}',
    /* ONE icon weight across the whole chrome (close button included) */
    '.plr-btn svg,.plr-x svg{width:19px;height:19px;fill:currentColor;pointer-events:none;display:block}',
    /* keyboard users get a real ring; pointer users never see it */
    '.plr-btn:focus-visible,.plr-x:focus-visible{outline:2px solid var(--acc);outline-offset:2px;',
    'color:#fff;background:rgba(255,255,255,.09)}',
    '.plr-seek:focus-visible{outline:2px solid var(--acc);outline-offset:5px;border-radius:4px}',
    '.plr-vol input:focus-visible{outline:2px solid var(--acc);outline-offset:3px}',
    '.plr-menu button:focus-visible{outline:2px solid var(--acc);outline-offset:-2px;background:rgba(255,255,255,.07);color:#fff}',
    '.plr-root .plr-a:focus-visible{outline:2px solid var(--acc);outline-offset:2px}',
    '.plr-mag:focus-visible{outline:2px solid var(--acc);outline-offset:2px}',

    /* seek */
    '.plr-seek{position:relative;height:20px;display:flex;align-items:center;cursor:pointer;touch-action:none;user-select:none}',
    '.plr-track{position:relative;height:4px;width:100%;border-radius:99px;background:rgba(255,255,255,.24);',
    'overflow:hidden;transition:height .16s var(--e4),background .16s var(--e4)}',
    '.plr-seek:hover .plr-track,.plr-seek.plr-drag .plr-track,.plr-seek:focus-visible .plr-track{height:7px;background:rgba(255,255,255,.28)}',
    '.plr-buf{position:absolute;inset:0}',
    /* buffered band: pink-tinted white so it reads as the same family as the fill,
       one energy level down - clearly distinct from both track and progress */
    '.plr-buf span{position:absolute;top:0;bottom:0;background:rgba(255,214,229,.38)}',
    '.plr-fill{position:absolute;top:0;bottom:0;left:0;width:0;background:linear-gradient(90deg,var(--accHi),var(--acc))}',
    '.plr-knob{position:absolute;top:50%;left:0;width:13px;height:13px;margin:-6.5px 0 0 -6.5px;border-radius:50%;',
    'background:var(--acc);box-shadow:0 0 0 4px rgba(var(--accRGB),.22),0 2px 6px rgba(0,0,0,.5);',
    'opacity:0;transform:scale(.5);transition:opacity .16s var(--e4),transform .18s var(--e5),box-shadow .16s var(--e4);',
    'pointer-events:none}',
    '.plr-seek:hover .plr-knob,.plr-seek:focus-visible .plr-knob,.plr-seek.plr-drag .plr-knob{opacity:1;transform:scale(1)}',
    '.plr-seek.plr-drag .plr-knob{transform:scale(1.16);box-shadow:0 0 0 6px rgba(var(--accRGB),.26),0 2px 9px rgba(0,0,0,.55)}',
    '.plr-tip{position:absolute;bottom:26px;left:0;transform:translate(-50%,4px);padding:4px 8px;border-radius:7px;',
    'background:rgba(12,15,19,.96);border:1px solid #2c3540;box-shadow:0 8px 22px rgba(0,0,0,.55);',
    'font-size:11px;font-weight:600;color:#e9edf2;font-variant-numeric:tabular-nums;opacity:0;',
    'transition:opacity .16s var(--e4),transform .18s var(--e5);pointer-events:none;white-space:nowrap}',
    '.plr-seek:hover .plr-tip,.plr-seek.plr-drag .plr-tip{opacity:1;transform:translate(-50%,0)}',

    /* control row */
    '.plr-row{display:flex;align-items:center;gap:8px;margin-top:6px}',
    '.plr-time{font-size:12px;color:#9fb0c0;font-variant-numeric:tabular-nums;letter-spacing:.3px;white-space:nowrap;padding:0 4px}',
    '.plr-time b{color:#e9edf2;font-weight:600}',
    '.plr-sp{flex:1}',
    '.plr-vol{display:flex;align-items:center;gap:6px}',
    /* same accent treatment as the seek bar: pink filled portion (painted inline by
       paintVol so it tracks the real volume), pink thumb with a hover/focus ring */
    '.plr-vol input{width:0;opacity:0;transition:width .2s var(--e5),opacity .18s var(--e4);',
    '-webkit-appearance:none;appearance:none;height:4px;border-radius:99px;background:rgba(255,255,255,.2);',
    'outline:none;cursor:pointer}',
    '.plr-vol:hover input,.plr-vol input:focus,.plr-vol:focus-within input{width:78px;opacity:1}',
    '.plr-vol input::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;border-radius:50%;',
    'background:var(--acc);cursor:pointer;box-shadow:0 0 0 0 rgba(var(--accRGB),0);',
    'transition:box-shadow .16s var(--e4),transform .16s var(--e4)}',
    '.plr-vol input:hover::-webkit-slider-thumb,.plr-vol input:focus::-webkit-slider-thumb{',
    'box-shadow:0 0 0 4px rgba(var(--accRGB),.26);transform:scale(1.1)}',
    '.plr-vol input::-moz-range-thumb{width:12px;height:12px;border:0;border-radius:50%;background:var(--acc);cursor:pointer}',

    /* menus */
    '.plr-wrap{position:relative;flex:0 0 auto}',
    '.plr-menu{position:absolute;bottom:44px;right:0;min-width:172px;max-height:280px;overflow:auto;',
    'background:#11161c;border:1px solid #262e38;border-radius:11px;padding:6px;',
    'box-shadow:0 18px 44px rgba(0,0,0,.6);display:none;z-index:6}',
    '.plr-menu.plr-open{display:block;animation:plr-rise .18s var(--e5)}',
    '@keyframes plr-rise{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}',
    '.plr-menu h5{margin:4px 8px 6px;font-size:10.5px;letter-spacing:.9px;text-transform:uppercase;color:#7b8a99;font-weight:600}',
    '.plr-menu button{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:7px 9px;border-radius:7px;',
    'font-size:12.5px;color:#cfd8e3;transition:background .14s var(--e4),color .14s var(--e4)}',
    '.plr-menu button:hover{background:rgba(255,255,255,.07);color:#fff}',
    '.plr-menu button.plr-sel{color:var(--acc)}',
    '.plr-menu button i{width:12px;font-style:normal;flex:0 0 auto}',
    /* subtitle settings block inside the menu */
    '.plr-menu{min-width:220px}',
    '.plr-menu .plr-sub-list{display:block;max-height:190px;overflow:auto;margin:0 -2px}',
    '.plr-menu .plr-sub-sec{border-top:1px solid #222a33;margin-top:6px;padding-top:6px}',
    '.plr-menu .plr-sub-lb{display:block;margin:1px 8px 5px;font-size:9.5px;letter-spacing:.7px;',
    'text-transform:uppercase;color:#7b8a99;font-weight:600}',
    '.plr-menu .plr-sub-row{display:flex;align-items:center;gap:5px;padding:0 6px 4px}',
    '.plr-sub-row .plr-sub-b{flex:1;min-width:0;height:27px;display:flex;align-items:center;justify-content:center;',
    'border-radius:7px;background:#1a212a;color:#cfd8e3;font-size:11.5px;white-space:nowrap;cursor:pointer;',
    'transition:background .14s var(--e4),color .14s var(--e4),transform .12s var(--e4)}',
    '.plr-sub-row .plr-sub-b:hover{background:#232c37;color:#fff}',
    '.plr-sub-row .plr-sub-b:active{transform:scale(.94)}',
    '.plr-sub-row .plr-sub-b.plr-on{background:rgba(var(--accRGB),.22);color:var(--accHi)}',
    '.plr-sub-row .plr-sub-sync{flex:1.6;text-align:center;font-variant-numeric:tabular-nums;',
    'font-size:12px;color:#e9edf2;font-weight:600}',
    '.plr-sub-row .plr-sw{flex:1;height:23px;border-radius:6px;border:2px solid #2c3540;cursor:pointer;padding:0}',
    '.plr-sub-row .plr-sw:hover{border-color:#5a6675}',
    '.plr-sub-row .plr-sw.plr-on{border-color:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.6) inset}',

    /* center overlays */
    '.plr-mid{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:3}',
    '.plr-spin{width:46px;height:46px;border-radius:50%;border:3px solid rgba(255,255,255,.14);border-top-color:var(--acc);',
    'animation:plr-rot .8s linear infinite;display:none}',
    '.plr-spin.plr-show{display:block}',
    '@keyframes plr-rot{to{transform:rotate(360deg)}}',
    '.plr-burst{position:absolute;width:74px;height:74px;border-radius:50%;background:rgba(10,12,15,.62);',
    'display:flex;align-items:center;justify-content:center;opacity:0;transform:scale(.82)}',
    '.plr-burst svg{width:30px;height:30px;fill:#fff}',
    '.plr-burst.plr-go{animation:plr-pop .42s var(--e4)}',
    '@keyframes plr-pop{0%{opacity:.95;transform:scale(.82)}100%{opacity:0;transform:scale(1.35)}}',

    /* cards (resume / magnet / error) */
    '.plr-card{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:26px;z-index:7;',
    'background:radial-gradient(120% 90% at 50% 40%,rgba(15,19,24,.86),rgba(6,7,9,.97));animation:plr-fade .2s var(--e4)}',
    '@keyframes plr-fade{from{opacity:0}to{opacity:1}}',
    '.plr-box{width:min(560px,100%);background:#11161c;border:1px solid #262e38;border-radius:16px;padding:22px;',
    'box-shadow:0 26px 70px rgba(0,0,0,.62);animation:plr-rise .26s var(--e5)}',
    '.plr-box h3{margin:0 0 6px;font-size:16px;font-weight:650;letter-spacing:.2px}',
    '.plr-box p{margin:0 0 14px;font-size:12.5px;color:#93a1b0;line-height:1.55}',
    '.plr-box p.plr-note{margin:12px 0 0;font-size:11.5px;color:#7b8a99}',
    '.plr-acts{display:flex;gap:9px;flex-wrap:wrap}',
    /* `.plr-root button` (0,1,1) would out-rank a bare `.plr-a` (0,1,0) and strip these — keep it scoped */
    '.plr-root .plr-a{display:inline-flex;align-items:center;padding:9px 15px;border-radius:9px;font-size:12.5px;',
    'font-weight:600;border:1px solid #2c3540;color:#cfd8e3;background:#161c23;text-decoration:none;cursor:pointer;',
    'transition:background .16s var(--e4),color .16s var(--e4),border-color .16s var(--e4),transform .16s var(--e4)}',
    '.plr-root .plr-a:hover{background:#1c242d;border-color:#3a4653;color:#fff}',
    '.plr-root .plr-a:active{transform:translateY(1px)}',
    /* near-black on pink reads at ~5.5:1 - the old #04121e was a leftover blue tint */
    '.plr-root .plr-a.plr-pri{background:var(--acc);border-color:var(--acc);color:#20040e}',
    '.plr-root .plr-a.plr-pri:hover{background:var(--accHi);border-color:var(--accHi);color:#20040e}',
    '.plr-mag{width:100%;height:76px;resize:none;background:#0b0f13;border:1px solid #262e38;border-radius:9px;',
    'padding:9px 11px;color:#9fb0c0;font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;margin:0 0 12px}',
    '.plr-mag:focus{outline:none;border-color:var(--acc);color:#cfd8e3}',

    /* toast */
    '.plr-toast{position:absolute;left:50%;bottom:104px;transform:translate(-50%,10px);padding:9px 14px;border-radius:9px;',
    'background:#151a20;border:1px solid #2c3540;font-size:12px;color:#cfd8e3;opacity:0;',
    'transition:opacity .2s var(--e4),transform .24s var(--e5);',
    'pointer-events:none;z-index:8;max-width:70%;text-align:center}',
    '.plr-toast.plr-show{opacity:1;transform:translate(-50%,0)}',
    /* captions: keep cues clear of the control bar and readable on any frame */
    '.plr-root video::cue{background:rgba(0,0,0,.62);color:#fff;font-size:.92em;line-height:1.35;',
    'text-shadow:0 1px 3px rgba(0,0,0,.9)}',
    '.plr-root video::-webkit-media-text-track-container{transform:translateY(-46px)}',
    /* LIVE SUBTITLE OVERLAY — our own renderer. Native <track>s are kept in
       `hidden` mode (parsed but never drawn by the UA) and we paint the active
       cues here, so text size / colour / background / vertical position and the
       manual sync-offset are all fully controllable and identical cross-browser.
       Sits UNDER the chrome (z:3 < the 4 of top/bot) and lifts clear of the
       control bar only while the controls are on screen. */
    '.plr-cue{position:absolute;left:0;right:0;bottom:8%;z-index:3;display:none;pointer-events:none;',
    'text-align:center;padding:0 5%;transition:bottom .2s var(--e4);',
    'font-size:calc(var(--subSize,1) * clamp(15px,2.6vw,30px));line-height:1.32}',
    '.plr-root:not(.plr-hide) .plr-cue{bottom:calc(8% + 58px)}',
    '.plr-cue.plr-p-low{bottom:3.5%}.plr-root:not(.plr-hide) .plr-cue.plr-p-low{bottom:calc(3.5% + 58px)}',
    '.plr-cue.plr-p-high{bottom:20%}.plr-root:not(.plr-hide) .plr-cue.plr-p-high{bottom:calc(20% + 58px)}',
    '.plr-cue-line{display:inline-block;max-width:96%;margin:0 auto;',
    'color:var(--subColor,#fff);background:var(--subBg,rgba(0,0,0,.62));',
    'padding:.06em .5em;border-radius:4px;white-space:pre-wrap;word-wrap:break-word;',
    'text-shadow:var(--subShadow,0 1px 3px rgba(0,0,0,.95));font-weight:500;',
    '-webkit-box-decoration-break:clone;box-decoration-break:clone}',
    '.plr-cue-line + .plr-cue-line{margin-top:.16em}',
    '.plr-cue-line b{font-weight:800}.plr-cue-line i{font-style:italic}.plr-cue-line u{text-decoration:underline}',
    '@media (max-width:640px){.plr-vol input{display:none}.plr-ttl b{font-size:15px}',
    '.plr-chip{height:19px;padding:0 7px;font-size:9.5px;letter-spacing:.5px}}',

    /* ---------------------------------------------------------- inline preview
       The focused hover PREVIEW and the larger GLANCE share one surface, layered
       OVER the canvas wall (never drawn into it, so the wall keeps 60fps). The
       wrap is pointer-events:none so hover/click fall through to the canvas — only
       the action buttons opt back in. It carries its own accent tokens because it
       lives on <body>, outside .plr-root's cascade. */
    '.plr-pv-wrap{position:fixed;z-index:99990;border-radius:12px;overflow:hidden;background:#08090b;',
    '--acc:' + ACC + ';--accRGB:' + ACC_RGB + ';--accHi:#ff6fa3;',
    '--e4:cubic-bezier(0.165,0.84,0.44,1);--e5:cubic-bezier(0.23,1,0.32,1);',
    'box-shadow:0 12px 40px rgba(0,0,0,.55),0 0 0 1px rgba(var(--accRGB),.5),0 0 26px rgba(var(--accRGB),.22);',
    'opacity:0;transform:scale(.94);transition:opacity .18s var(--e5),transform .24s var(--e5);',
    'pointer-events:none;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;',
    'color:#e9edf2;contain:layout paint;will-change:transform,opacity}',
    '.plr-pv-wrap.plr-pv-in{opacity:1;transform:none}',
    '.plr-pv-wrap.plr-pv-glance{pointer-events:auto;box-shadow:0 30px 80px rgba(0,0,0,.7),0 0 0 1px rgba(var(--accRGB),.4)}',
    '.plr-pv-wrap video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000;display:block}',
    '.plr-pv-wrap.plr-pv-glance video{object-fit:contain}',
    '.plr-pv-poster{position:absolute;inset:0;background:#0a0c0f center/cover no-repeat;transition:opacity .3s var(--e4);opacity:1}',
    '.plr-pv-wrap.plr-pv-playing .plr-pv-poster{opacity:0}',
    '.plr-pv-spin{position:absolute;top:50%;left:50%;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;',
    'border:2px solid rgba(255,255,255,.18);border-top-color:var(--acc);animation:plr-rot .8s linear infinite}',
    '.plr-pv-wrap.plr-pv-playing .plr-pv-spin{display:none}',
    '.plr-pv-tag{position:absolute;top:8px;left:8px;display:flex;gap:5px;align-items:center;z-index:2;pointer-events:none}',
    '.plr-pv-live-chip{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:999px;',
    'background:rgba(8,9,11,.72);border:1px solid rgba(var(--accRGB),.55);color:#ff8fb8;',
    'font-size:10px;font-weight:700;letter-spacing:.6px;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}',
    '.plr-pv-dot{width:6px;height:6px;border-radius:50%;background:var(--acc);animation:plr-live 2s var(--e5) infinite}',
    '.plr-pv-btns{position:absolute;bottom:8px;right:8px;display:flex;gap:6px;z-index:3}',
    '.plr-pv-b{pointer-events:auto;width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;',
    'background:rgba(8,9,11,.72);border:1px solid rgba(255,255,255,.14);color:#e9edf2;cursor:pointer;',
    '-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);',
    'transition:background .15s var(--e4),transform .15s var(--e4),border-color .15s var(--e4)}',
    '.plr-pv-b:hover{background:var(--acc);color:#20040e;border-color:transparent;transform:translateY(-1px)}',
    '.plr-pv-b:active{transform:scale(.92)}',
    '.plr-pv-b svg{width:16px;height:16px;fill:currentColor;display:block;pointer-events:none}',
    '.plr-pv-wrap.plr-pv-audible .plr-pv-mute{background:var(--acc);color:#20040e;border-color:transparent}',
    '.plr-pv-hint{position:absolute;bottom:9px;left:10px;padding:4px 9px;border-radius:8px;background:rgba(8,9,11,.72);',
    'font-size:10.5px;color:#c2ccd6;pointer-events:none;z-index:2;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}',
    '.plr-pv-scrim{position:fixed;inset:0;z-index:99989;background:rgba(4,5,7,.55);opacity:0;',
    '-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);transition:opacity .2s var(--e4)}',
    '.plr-pv-scrim.plr-pv-in{opacity:1}',
    '@media (prefers-reduced-motion:reduce){.plr-pv-wrap,.plr-pv-wrap *{',
    'animation-duration:.01ms !important;animation-iteration-count:1 !important;transition-duration:.01ms !important}',
    '.plr-pv-dot{animation:none !important}}',

    /* Reduced motion: collapse every duration and stop the LIVE pulse. Last block
       in the sheet so it wins on order as well as on !important. */
    '@media (prefers-reduced-motion:reduce){',
    '.plr-root,.plr-root *,.plr-root *::before,.plr-root *::after{',
    'animation-duration:.01ms !important;animation-iteration-count:1 !important;',
    'transition-duration:.01ms !important;transition-delay:0ms !important}',
    '.plr-chip .plr-dot{animation:none !important;opacity:1 !important;box-shadow:none !important}',
    '}'
  ].join('');

  var ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.2v13.6c0 .8.9 1.3 1.6.9l10.7-6.8c.6-.4.6-1.4 0-1.8L9.6 4.3C8.9 3.9 8 4.4 8 5.2z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M7 4h3.2v16H7zM13.8 4H17v16h-3.2z"/></svg>',
    vol: '<svg viewBox="0 0 24 24"><path d="M4 9.5v5c0 .6.4 1 1 1h2.9l3.7 3.2c.6.6 1.7.1 1.7-.8V5.1c0-.9-1-1.4-1.7-.8L7.9 8.5H5c-.6 0-1 .4-1 1zm12.5 2.5c0-1.5-.8-2.8-2-3.4v6.8c1.2-.6 2-1.9 2-3.4zm-2 6.9c2.6-.8 4.5-3.2 4.5-6.9s-1.9-6.1-4.5-6.9v1.6c1.8.7 3 2.8 3 5.3s-1.2 4.6-3 5.3z"/></svg>',
    mute: '<svg viewBox="0 0 24 24"><path d="M4 9.5v5c0 .6.4 1 1 1h2.9l3.7 3.2c.6.6 1.7.1 1.7-.8V5.1c0-.9-1-1.4-1.7-.8L7.9 8.5H5c-.6 0-1 .4-1 1zm16.3-.2-1.1-1.1-2.2 2.2-2.2-2.2-1.1 1.1 2.2 2.2-2.2 2.2 1.1 1.1 2.2-2.2 2.2 2.2 1.1-1.1-2.2-2.2z"/></svg>',
    cc: '<svg viewBox="0 0 24 24"><path d="M3 5.5h18c.6 0 1 .4 1 1v11c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1v-11c0-.6.4-1 1-1zm4.6 4.2c-1.6 0-2.6 1-2.6 2.4s1 2.4 2.6 2.4c1 0 1.8-.4 2.2-1.1l-1.2-.6c-.2.3-.5.5-1 .5-.7 0-1.1-.5-1.1-1.2s.4-1.2 1.1-1.2c.5 0 .8.2 1 .5l1.2-.6c-.4-.7-1.2-1.1-2.2-1.1zm7 0c-1.6 0-2.6 1-2.6 2.4s1 2.4 2.6 2.4c1 0 1.8-.4 2.2-1.1l-1.2-.6c-.2.3-.5.5-1 .5-.7 0-1.1-.5-1.1-1.2s.4-1.2 1.1-1.2c.5 0 .8.2 1 .5l1.2-.6c-.4-.7-1.2-1.1-2.2-1.1z"/></svg>',
    pip: '<svg viewBox="0 0 24 24"><path d="M20 3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H4V5h16v14zm-2-7h-6v5h6v-5z"/></svg>',
    fs: '<svg viewBox="0 0 24 24"><path d="M4 9V5c0-.6.4-1 1-1h4v2H6v3H4zm11-5h4c.6 0 1 .4 1 1v4h-2V6h-3V4zM4 15h2v3h3v2H5c-.6 0-1-.4-1-1v-4zm14 0h2v4c0 .6-.4 1-1 1h-4v-2h3v-3z"/></svg>',
    fsx: '<svg viewBox="0 0 24 24"><path d="M9 4h2v4c0 .6-.4 1-1 1H6V7h3V4zm4 0h2v3h3v2h-4c-.6 0-1-.4-1-1V4zM6 15h4c.6 0 1 .4 1 1v4H9v-3H6v-2zm8 0h4v2h-3v3h-2v-4c0-.6.4-1 1-1z"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M18.3 6.7 17 5.4 12 10.4 7 5.4 5.7 6.7l5 5-5 5L7 18l5-5 5 5 1.3-1.3-5-5 5-5z"/></svg>',
    /* diagonal expand arrows - the GLANCE ("bigger look") glyph */
    expand: '<svg viewBox="0 0 24 24"><path d="M14 3h7v7h-2V6.4l-4.3 4.3-1.4-1.4L17.6 5H14V3zM3 14h2v3.6l4.3-4.3 1.4 1.4L6.4 19H10v2H3v-7z"/></svg>',
    /* broadcast arcs - the HLS chip glyph */
    hls: '<svg viewBox="0 0 24 24"><path d="M6.2 4.8 4.8 3.4a12.1 12.1 0 0 0 0 17.2l1.4-1.4a10.1 10.1 0 0 1 0-14.4zm11.6 0a10.1 10.1 0 0 1 0 14.4l1.4 1.4a12.1 12.1 0 0 0 0-17.2l-1.4 1.4zM9 7.6 7.6 6.2a8.2 8.2 0 0 0 0 11.6L9 16.4a6.2 6.2 0 0 1 0-8.8zm6 0a6.2 6.2 0 0 1 0 8.8l1.4 1.4a8.2 8.2 0 0 0 0-11.6L15 7.6zM12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>'
  };

  // -------------------------------------------------------- provenance chips
  /* Rendered ONLY from data that actually exists. An absent or unknown lane
     renders nothing at all - no placeholder, no guess. */
  var LANE_CHIP = {
    'ai-generated':       { cls: 'plr-lane-ai',   glyph: '\uD83E\uDD16', text: 'AI-GENERATED',
                            title: 'AI-generated \u2014 no human performed' },
    'performer-verified': { cls: 'plr-lane-pv',   glyph: '\u2705', text: 'PERFORMER-VERIFIED',
                            title: 'Performer-verified \u2014 consent \u00b7 fair pay \u00b7 pull-anytime' },
    'demo':               { cls: 'plr-lane-demo', glyph: '\uD83E\uDDEA', text: 'DEMO',
                            title: 'Demo \u2014 SFW test source' }
  };

  /* meta wins when the caller forwards lane/hls/live. Otherwise resolve the SAME
     registry row by EXACT id or EXACT url - that is a lookup of the authoritative
     record, not an inference. Registry data is read, never written or mutated. */
  function laneData(meta, stream) {
    var m = meta || {}, s = stream || {}, reg = null;
    try {
      var R = window.Registry;
      if (R) {
        if (m.id && typeof R.get === 'function') reg = R.get(m.id);
        if (!reg && s.url && typeof R.items === 'function') {
          var list = R.items() || [];
          for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].hpUrl === s.url) { reg = list[i]; break; }
          }
        }
      }
    } catch (e) { reg = null; }
    var pick = function (k) { return m[k] !== undefined ? m[k] : (reg ? reg[k] : undefined); };
    var lane = String(pick('lane') || '').toLowerCase();
    return { lane: LANE_CHIP[lane] ? lane : null, hls: pick('hls') === true, live: pick('live') === true };
  }

  /* display-only: the registry prefixes its lane glyph onto `name`; once the chip
     carries that glyph the title should not repeat it. Returns a NEW string - the
     caller's meta object is never touched. */
  function stripGlyph(s, glyph) {
    var t = String(s == null ? '' : s);
    return (glyph && t.slice(0, glyph.length) === glyph)
      ? t.slice(glyph.length).replace(/^[\s\u00b7\u2014-]+/, '') : t;
  }

  function chipEl(cls, html, label, title) {
    var c = h('span', 'plr-chip ' + cls, html);
    var t = h('span', 'plr-lb');           /* real element so flex `gap` applies */
    t.textContent = label;
    c.appendChild(t);
    if (title) c.title = title;
    return c;
  }

  function renderChips(host, ld) {
    if (!host) return;
    host.innerHTML = '';
    var L = ld.lane ? LANE_CHIP[ld.lane] : null;
    if (L) host.appendChild(chipEl(L.cls, '<i class="plr-gl">' + L.glyph + '</i>', L.text, L.title));
    if (ld.hls) host.appendChild(chipEl('plr-hls', ICON.hls, 'HLS', 'HTTP Live Streaming'));
    if (ld.live) host.appendChild(chipEl('plr-live', '<i class="plr-dot"></i>', 'LIVE', 'Live stream'));
  }

  // ------------------------------------------------------------------- helpers
  function h(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function fmt(t) {
    if (!isFinite(t) || t < 0) t = 0;
    t = Math.floor(t);
    var s = t % 60, m = Math.floor(t / 60) % 60, hh = Math.floor(t / 3600);
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return hh ? hh + ':' + p(m) + ':' + p(s) : m + ':' + p(s);
  }
  function ls(k, d) {
    try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; }
  }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function jget(k, d) {
    try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function langName(code) {
    var c = String(code || '').toLowerCase();
    var M = { en: 'English', eng: 'English', es: 'Spanish', spa: 'Spanish', fr: 'French', fre: 'French',
      de: 'German', ger: 'German', it: 'Italian', ita: 'Italian', pt: 'Portuguese', por: 'Portuguese',
      ru: 'Russian', rus: 'Russian', he: 'Hebrew', heb: 'Hebrew', ar: 'Arabic', ara: 'Arabic',
      nl: 'Dutch', dut: 'Dutch', pl: 'Polish', pol: 'Polish', tr: 'Turkish', tur: 'Turkish',
      sv: 'Swedish', da: 'Danish', fi: 'Finnish', no: 'Norwegian', cs: 'Czech', el: 'Greek',
      hi: 'Hindi', ja: 'Japanese', jpn: 'Japanese', ko: 'Korean', kor: 'Korean',
      zh: 'Chinese', chi: 'Chinese', ro: 'Romanian', hu: 'Hungarian', uk: 'Ukrainian' };
    return M[c] || (code ? String(code).toUpperCase() : 'Unknown');
  }
  function fetchT(url, ms, opts) {
    opts = opts || {};
    var ac = ('AbortController' in window) ? new AbortController() : null;
    if (ac) opts.signal = ac.signal;
    var timer = setTimeout(function () { if (ac) try { ac.abort(); } catch (e) {} }, ms);
    return fetch(url, opts).then(function (r) { clearTimeout(timer); return r; },
      function (e) { clearTimeout(timer); throw e; });
  }

  // ------------------------------------------------------- continue-watching
  function cwAll() {
    var v = jget(CW_KEY, []);
    return Object.prototype.toString.call(v) === '[object Array]' ? v : [];
  }
  function cwKey(id, video) { return String(id || '') + '|' + String(video || ''); }
  function cwGet(id, video) {
    var list = cwAll(), k = cwKey(id, video);
    for (var i = 0; i < list.length; i++) if (cwKey(list[i].id, list[i].video) === k) return list[i];
    return null;
  }
  function cwSave(rec) {
    if (!rec || !rec.id) return;
    var list = cwAll(), k = cwKey(rec.id, rec.video), out = [rec];
    for (var i = 0; i < list.length; i++) {
      if (cwKey(list[i].id, list[i].video) !== k) out.push(list[i]);
      if (out.length >= 120) break;
    }
    lsSet(CW_KEY, JSON.stringify(out));
  }
  function cwDrop(id, video) {
    var k = cwKey(id, video);
    lsSet(CW_KEY, JSON.stringify(cwAll().filter(function (r) { return cwKey(r.id, r.video) !== k; })));
  }

  // ------------------------------------------------------------- stream logic
  function isHls(u) { return /\.m3u8(\?|#|$)/i.test(String(u || '')); }

  /* A friendly site name for an external hand-off card: "chaturbate.com" ->
     "Chaturbate". Best-effort and never throws; falls back to "this site". */
  function hostLabel(u) {
    try {
      var host = new URL(String(u)).hostname.replace(/^www\./i, '');
      var parts = host.split('.').filter(Boolean);
      var name = parts.length >= 2 ? parts[parts.length - 2] : (parts[0] || '');
      return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'this site';
    } catch (e) { return 'this site'; }
  }

  /* Chrome/Edge answer "maybe" to canPlayType('application/vnd.apple.mpegurl') and then
     fail to play, so native HLS is trusted only on WebKit (Safari + every iOS browser). */
  function nativeHls(v) {
    var ua = navigator.userAgent || '';
    var webkit = /iPad|iPhone|iPod/.test(ua) ||
      (/Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR|Android|HeadlessChrome/.test(ua));
    return webkit && !!v.canPlayType('application/vnd.apple.mpegurl');
  }

  function magnetOf(stream, title) {
    var ih = String(stream.infoHash || '').toLowerCase();
    if (!ih && /^magnet:/i.test(stream.url || '')) return stream.url;
    if (!ih) return '';
    var m = 'magnet:?xt=urn:btih:' + ih;
    if (title) m += '&dn=' + encodeURIComponent(title);
    var src = stream.sources || [];
    var seen = {};
    for (var i = 0; i < src.length; i++) {
      var s = String(src[i] || '');
      if (s.slice(0, 8) === 'tracker:') {
        var tr = s.slice(8);
        if (tr && !seen[tr]) { seen[tr] = 1; m += '&tr=' + encodeURIComponent(tr); }
      }
    }
    return m;
  }

  var engineCache = { at: 0, up: false };
  function engineUp() {
    var now = (new Date()).getTime();
    if (now - engineCache.at < 5000) return Promise.resolve(engineCache.up);
    return fetchT(ENGINE + '/status', 1000, { cache: 'no-store' }).then(function (r) {
      engineCache = { at: (new Date()).getTime(), up: !!(r && r.ok) };
      return engineCache.up;
    }, function () {
      engineCache = { at: (new Date()).getTime(), up: false };
      return false;
    });
  }

  /* -> {kind:'url'|'hls'|'external'|'torrent', url} */
  function resolve(stream) {
    stream = stream || {};
    if (stream.url && !/^magnet:/i.test(stream.url)) {
      return { kind: isHls(stream.url) ? 'hls' : 'url', url: stream.url };
    }
    if (stream.ytId) return { kind: 'external', url: 'https://www.youtube.com/watch?v=' + encodeURIComponent(stream.ytId) };
    if (stream.externalUrl) return { kind: 'external', url: stream.externalUrl };
    if (stream.infoHash || /^magnet:/i.test(stream.url || '')) return { kind: 'torrent', url: '' };
    return { kind: 'none', url: '' };
  }

  // ------------------------------------------------------------- hls.js loader
  var hlsLoad = null;
  function loadHls() {
    if (window.Hls) return Promise.resolve(window.Hls);
    if (hlsLoad) return hlsLoad;
    hlsLoad = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = HLS_URL;
      s.async = true;
      s.onload = function () { window.Hls ? res(window.Hls) : rej(new Error('hls.js loaded but window.Hls missing')); };
      s.onerror = function () { rej(new Error('could not load ' + HLS_URL)); };
      document.head.appendChild(s);
    })['catch'](function (e) { hlsLoad = null; throw e; });
    return hlsLoad;
  }

  // ================================================================== the player
  var S = null; // live session state, null when closed

  function styleOnce() {
    if (document.getElementById('plr-css')) return;
    var st = h('style'); st.id = 'plr-css'; st.textContent = CSS;
    document.head.appendChild(st);
  }

  function build() {
    var root = h('div', 'plr-root');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Video player');
    root.tabIndex = -1;

    var video = document.createElement('video');
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.preload = 'metadata';
    /* NO crossOrigin here — see applyCORS(). Setting it unconditionally forces a
       CORS-mode media fetch, which kills every source whose host sends no
       Access-Control-Allow-Origin: observed live, 4 of 6 registry seed MP4s
       (all alive, all 206 on curl) died with MEDIA_ERR_SRC_NOT_SUPPORTED. */
    root.appendChild(video);

    var mid = h('div', 'plr-mid');
    var spin = h('div', 'plr-spin');
    var burst = h('div', 'plr-burst', ICON.play);
    mid.appendChild(spin); mid.appendChild(burst);
    root.appendChild(mid);

    /* live subtitle overlay (our own cue renderer — see the subtitles section) */
    var subCue = h('div', 'plr-cue');
    subCue.setAttribute('aria-live', 'off');
    root.appendChild(subCue);

    var top = h('div', 'plr-top');
    var ttl = h('div', 'plr-ttl', '<b></b><div class="plr-chips"></div><span></span>');
    var chips = ttl.querySelector('.plr-chips');
    chips.setAttribute('aria-label', 'Source badges');
    var xbtn = h('button', 'plr-x', ICON.x);
    xbtn.title = 'Close (Esc)';
    xbtn.setAttribute('aria-label', 'Close');
    top.appendChild(ttl); top.appendChild(xbtn);
    root.appendChild(top);

    var bot = h('div', 'plr-bot');
    var seek = h('div', 'plr-seek');
    seek.setAttribute('role', 'slider');
    seek.setAttribute('aria-label', 'Seek');
    /* reachable by keyboard: the global arrow-key handler already seeks, and the
       focus ring + revealed knob now tell a keyboard user where they are */
    seek.tabIndex = 0;
    seek.setAttribute('aria-valuemin', '0');
    seek.setAttribute('aria-valuemax', '100');
    seek.setAttribute('aria-valuenow', '0');
    var track = h('div', 'plr-track');
    var buf = h('div', 'plr-buf');
    var fill = h('div', 'plr-fill');
    track.appendChild(buf); track.appendChild(fill);
    var knob = h('div', 'plr-knob');
    var tip = h('div', 'plr-tip', '0:00');
    seek.appendChild(track); seek.appendChild(knob); seek.appendChild(tip);
    bot.appendChild(seek);

    var row = h('div', 'plr-row');
    var pp = h('button', 'plr-btn', ICON.play); pp.title = 'Play (space)';
    var time = h('div', 'plr-time', '<b>0:00</b> / 0:00');
    var vol = h('div', 'plr-vol');
    var mute = h('button', 'plr-btn', ICON.vol); mute.title = 'Mute (m)';
    var vin = document.createElement('input');
    vin.type = 'range'; vin.min = '0'; vin.max = '1'; vin.step = '0.01'; vin.value = '1';
    vin.setAttribute('aria-label', 'Volume');
    vol.appendChild(mute); vol.appendChild(vin);
    var subWrap = h('div', 'plr-wrap');
    var subBtn = h('button', 'plr-btn', ICON.cc); subBtn.title = 'Subtitles';
    subBtn.style.display = 'none'; /* revealed only when the stream actually carries subtitles */
    var subMenu = h('div', 'plr-menu');
    subWrap.appendChild(subBtn); subWrap.appendChild(subMenu);
    var pip = h('button', 'plr-btn', ICON.pip); pip.title = 'Picture in picture';
    var fs = h('button', 'plr-btn', ICON.fs); fs.title = 'Fullscreen (f)';

    row.appendChild(pp); row.appendChild(time); row.appendChild(h('div', 'plr-sp'));
    row.appendChild(vol); row.appendChild(subWrap); row.appendChild(pip); row.appendChild(fs);
    bot.appendChild(row);
    root.appendChild(bot);

    var toast = h('div', 'plr-toast');
    root.appendChild(toast);

    return { root: root, video: video, spin: spin, burst: burst, top: top, bot: bot,
      ttl: ttl, chips: chips, x: xbtn, seek: seek, track: track, buf: buf, fill: fill, knob: knob, tip: tip,
      pp: pp, time: time, mute: mute, vin: vin, subBtn: subBtn, subMenu: subMenu,
      subCue: subCue, pip: pip, fs: fs, toast: toast };
  }

  // ------------------------------------------------------------------ session
  function open(opts) {
    styleOnce();
    var stream = opts.stream || {};
    var meta = opts.meta || {};
    var video = opts.video || null;

    var lanes = laneData(meta, stream);
    var titleMain = meta.name || meta.title || stream.title || stream.name || 'Playing';
    if (lanes.lane) titleMain = stripGlyph(titleMain, LANE_CHIP[lanes.lane].glyph);
    var epLabel = '';
    if (video) {
      var sn = (video.season != null ? video.season : video.seasonNumber);
      var en = (video.episode != null ? video.episode : (video.number != null ? video.number : video.episodeNumber));
      if (sn != null && en != null) epLabel = 'S' + sn + 'E' + en;
      if (video.title || video.name) epLabel = (epLabel ? epLabel + ' · ' : '') + (video.title || video.name);
    }
    var srcLabel = [stream.name, stream.title].filter(Boolean).join(' · ').replace(/\n+/g, ' ');
    var sub = [epLabel, srcLabel].filter(Boolean).join('  —  ');
    /* registry sources set stream.title to the meta name, so `sub` is often just the
       title again - show it only when it actually adds something. Display-only:
       `sub` itself still feeds the continue-watching record unchanged. */
    var subUI = (sub && sub !== titleMain) ? sub : '';

    var el = build();
    el.ttl.querySelector('b').textContent = titleMain;
    el.ttl.querySelector(':scope > span').textContent = subUI;
    renderChips(el.chips, lanes);

    S = {
      el: el, stream: stream, meta: meta, video: video, live: lanes.live === true,
      hls: null, off: [], timers: [], blobs: [], dragging: false,
      idle: null, saveT: null, seeking: false, destroyed: false, card: null,
      onClose: typeof opts.onClose === 'function' ? opts.onClose : null,
      opts: opts,                       /* opts.crossOrigin opts a source into CORS mode */
      cwId: meta.id || stream.infoHash || stream.url || titleMain,
      cwVid: video ? (video.id || video.videoId || epLabel || '') : '',
      title: titleMain, sub: sub, subUI: subUI, resumed: false, subsReady: false, subTracks: []
    };

    /* sweep any orphan overlay still fading out from a previous session */
    var old = document.querySelectorAll('.plr-root');
    for (var oi = 0; oi < old.length; oi++) { try { old[oi].remove(); } catch (e) {} }
    document.body.appendChild(el.root);
    S.prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    /* force layout then fade in */
    void el.root.offsetWidth;
    el.root.classList.add('plr-in');
    try { el.root.focus(); } catch (e) {}

    wire();
    route();
    return S;
  }

  function on(node, ev, fn, opt) {
    if (!S) return;
    node.addEventListener(ev, fn, opt);
    S.off.push(function () { try { node.removeEventListener(ev, fn, opt); } catch (e) {} });
  }

  function toast(msg, ms) {
    if (!S) return;
    var t = S.el.toast;
    t.textContent = msg;
    t.classList.add('plr-show');
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.classList.remove('plr-show'); }, ms || 3200);
  }

  function spin(on_) { if (S) S.el.spin.classList[on_ ? 'add' : 'remove']('plr-show'); }

  // ------------------------------------------------------------------- wiring
  function wire() {
    var el = S.el, v = el.video;

    // --- volume restore
    var sv = parseFloat(ls(VOL_KEY, '1'));
    if (!isFinite(sv) || sv < 0 || sv > 1) sv = 1;
    v.volume = sv; el.vin.value = String(sv);
    S.wantMuted = ls(MUTE_KEY, '0') === '1';   /* restored once real playback begins */
    paintVol();

    // --- playback state
    on(v, 'play', function () { el.pp.innerHTML = ICON.pause; el.pp.title = 'Pause (space)'; kick(); });
    on(v, 'pause', function () { el.pp.innerHTML = ICON.play; el.pp.title = 'Play (space)'; show(); save(); });
    on(v, 'waiting', function () { spin(true); });
    on(v, 'playing', function () {
      spin(false);
      /* first real frame: undo the muted-autoplay guard and honour the user's saved
         volume/mute. Unmuting a playing element is allowed even outside a gesture,
         so this is where silent-live-autoplay actually gets its sound. */
      if (S && !S.audioRestored) { S.audioRestored = true; v.muted = !!S.wantMuted; if (!v.muted && v.volume === 0) v.volume = 0.5; paintVol(); }
    });
    on(v, 'canplay', function () { spin(false); });
    on(v, 'stalled', function () { spin(true); });
    on(v, 'timeupdate', function () {
      paintTime();
      if (!v.paused && v.currentTime !== S.lastT) { S.lastT = v.currentTime; spin(false); }
    });
    on(v, 'progress', paintBuf);
    on(v, 'durationchange', function () { paintTime(); paintBuf(); });
    on(v, 'loadedmetadata', function () { paintTime(); maybeResume(); });
    on(v, 'volumechange', paintVol);
    on(v, 'ended', function () { save(true); });
    on(v, 'error', function () {
      var e = v.error;
      if (!e) return;
      var m = { 1: 'Playback aborted.', 2: 'Network error while loading the stream.',
        3: 'This stream could not be decoded.', 4: 'This stream format is not supported by the browser.' };
      if (S.viaEngine && S.magnet) {
        magnetPanel(S.magnet, 'The local streaming engine could not serve this file (it may still be ' +
          'looking for peers, or the file index is wrong). Copy the magnet link to watch it in a torrent client.', true);
        return;
      }
      fail(m[e.code] || 'This stream could not be played.');
    });

    // --- controls
    on(el.pp, 'click', toggle);
    on(el.x, 'click', function () { Player.close(); });
    on(v, 'click', function () { toggle(true); });
    on(v, 'dblclick', function () { toggleFs(); });

    on(el.mute, 'click', toggleMute);
    on(el.vin, 'input', function () {
      var x = parseFloat(el.vin.value);
      v.volume = x; v.muted = x === 0; lsSet(VOL_KEY, String(x));
    });

    if (!('pictureInPictureEnabled' in document) || !document.pictureInPictureEnabled || v.disablePictureInPicture) {
      el.pip.style.display = 'none';
    } else {
      on(el.pip, 'click', function () {
        try {
          if (document.pictureInPictureElement) document.exitPictureInPicture()['catch'](noop);
          else v.requestPictureInPicture()['catch'](function () { toast('Picture-in-picture unavailable'); });
        } catch (e) { toast('Picture-in-picture unavailable'); }
      });
    }
    on(el.fs, 'click', function () { toggleFs(); });
    on(document, 'fullscreenchange', paintFs);
    on(document, 'webkitfullscreenchange', paintFs);

    // --- subtitles menu
    on(el.subBtn, 'click', function (e) {
      e.stopPropagation();
      el.subMenu.classList.toggle('plr-open');
      show();
    });
    on(el.root, 'click', function (e) {
      if (!el.subMenu.contains(e.target) && e.target !== el.subBtn) el.subMenu.classList.remove('plr-open');
    });

    // --- seek bar
    var seekAt = function (ev) {
      var r = el.track.getBoundingClientRect();
      var p = r.width ? (ev.clientX - r.left) / r.width : 0;
      return Math.max(0, Math.min(1, p));
    };
    /* hover/drag preview time, clamped so the bubble never bleeds past either end */
    var previewTip = function (ev) {
      var d = v.duration, p = seekAt(ev);
      var r = el.seek.getBoundingClientRect();
      el.tip.textContent = isFinite(d) && d > 0 ? fmt(p * d) : '--:--';
      var w = el.tip.offsetWidth, x = p * r.width;
      if (r.width && w) x = Math.max(w / 2 + 2, Math.min(r.width - w / 2 - 2, x));
      el.tip.style.left = x + 'px';
    };
    on(el.seek, 'pointermove', previewTip);
    on(el.seek, 'pointerdown', function (ev) {
      if (ev.button != null && ev.button !== 0) return;
      S.dragging = true;
      el.seek.classList.add('plr-drag');
      try { el.seek.setPointerCapture(ev.pointerId); } catch (e) {}
      applySeek(seekAt(ev), false);
      previewTip(ev);
      ev.preventDefault();
    });
    on(el.seek, 'pointermove', function (ev) {
      if (!S.dragging) return;
      applySeek(seekAt(ev), false);
    });
    var endDrag = function (ev) {
      if (!S.dragging) return;
      S.dragging = false;
      el.seek.classList.remove('plr-drag');
      applySeek(seekAt(ev), true);
      kick();
    };
    on(el.seek, 'pointerup', endDrag);
    on(el.seek, 'pointercancel', function () { S.dragging = false; el.seek.classList.remove('plr-drag'); });

    // --- idle auto-hide
    on(el.root, 'pointermove', kick);
    on(el.root, 'pointerdown', kick);
    on(el.bot, 'pointerenter', function () { S.overCtl = true; show(); });
    on(el.bot, 'pointerleave', function () { S.overCtl = false; kick(); });
    on(el.top, 'pointerenter', function () { S.overCtl = true; show(); });
    on(el.top, 'pointerleave', function () { S.overCtl = false; kick(); });

    // --- keyboard
    on(document, 'keydown', onKey, true);

    // --- periodic save
    S.saveT = setInterval(function () { save(); }, SAVE_MS);
    S.timers.push(function () { clearInterval(S.saveT); });
    on(window, 'pagehide', function () { save(); });
    on(window, 'beforeunload', function () { save(); });

    kick();
  }

  function noop() {}

  function applySeek(p, commit) {
    var v = S.el.video, d = v.duration;
    if (!isFinite(d) || d <= 0) return;
    var t = p * d;
    S.el.fill.style.width = (p * 100) + '%';
    S.el.knob.style.left = (p * 100) + '%';
    S.el.time.innerHTML = '<b>' + esc(fmt(t)) + '</b> / ' + esc(fmt(d));
    try { v.currentTime = t; } catch (e) {}
    if (commit) save();
  }

  function toggle(burst) {
    var v = S.el.video;
    if (v.paused || v.ended) {
      var p = v.play();
      if (p && p['catch']) p['catch'](function () { /* autoplay/gesture — user can press play */ });
      if (burst) pop(ICON.play);
    } else {
      v.pause();
      if (burst) pop(ICON.pause);
    }
  }
  function pop(icon) {
    var b = S.el.burst;
    b.innerHTML = icon;
    b.classList.remove('plr-go');
    void b.offsetWidth;
    b.classList.add('plr-go');
  }

  function toggleFs() {
    var r = S.el.root;
    try {
      var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (fsEl) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      } else if (r.requestFullscreen) {
        r.requestFullscreen()['catch'](function () { toast('Fullscreen blocked by the browser'); });
      } else if (r.webkitRequestFullscreen) {
        r.webkitRequestFullscreen();
      } else if (S.el.video.webkitEnterFullscreen) {
        S.el.video.webkitEnterFullscreen(); // iOS
      }
    } catch (e) {}
  }
  function paintFs() {
    if (!S) return;
    var isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    S.el.fs.innerHTML = isFs ? ICON.fsx : ICON.fs;
    S.el.fs.classList[isFs ? 'add' : 'remove']('plr-on');
  }

  function paintTime() {
    if (!S || S.dragging) return;
    var v = S.el.video, d = v.duration, t = v.currentTime;
    var p = (isFinite(d) && d > 0) ? Math.max(0, Math.min(1, t / d)) : 0;
    S.el.fill.style.width = (p * 100) + '%';
    S.el.knob.style.left = (p * 100) + '%';
    S.el.time.innerHTML = '<b>' + esc(fmt(t)) + '</b> / ' + esc(isFinite(d) && d > 0 ? fmt(d) : '--:--');
    S.el.seek.setAttribute('aria-valuenow', String(Math.round(p * 100)));
    S.el.seek.setAttribute('aria-valuetext',
      fmt(t) + ' of ' + (isFinite(d) && d > 0 ? fmt(d) : 'unknown duration'));
  }
  function paintBuf() {
    if (!S) return;
    var v = S.el.video, d = v.duration, out = '';
    if (isFinite(d) && d > 0) {
      try {
        for (var i = 0; i < v.buffered.length; i++) {
          var s = v.buffered.start(i), e = v.buffered.end(i);
          out += '<span style="left:' + (s / d * 100).toFixed(3) + '%;width:' + ((e - s) / d * 100).toFixed(3) + '%"></span>';
        }
      } catch (e) {}
    }
    S.el.buf.innerHTML = out;
  }
  /* The button and the `m` key act on the EFFECTIVE state (muted OR volume 0),
     never on v.muted alone: with a persisted volume of 0 the old toggle flipped
     v.muted to TRUE on the first click — the icon stayed muted and the stream stayed
     silent "even after unmuting". Unmute now always ends audible. */
  function toggleMute() {
    if (!S) return;
    var v = S.el.video, eff = v.muted || v.volume === 0;
    if (eff) { v.muted = false; if (v.volume === 0) v.volume = 0.5; lsSet(VOL_KEY, String(v.volume)); }
    else v.muted = true;
    S.audioRestored = true;
    lsSet(MUTE_KEY, v.muted ? '1' : '0');
    paintVol();
  }
  function paintVol() {
    if (!S) return;
    var v = S.el.video, muted = v.muted || v.volume === 0;
    S.el.mute.innerHTML = muted ? ICON.mute : ICON.vol;
    S.el.mute.title = muted ? 'Unmute (m)' : 'Mute (m)';
    S.el.mute.classList[muted ? 'add' : 'remove']('plr-on');
    var x = muted ? 0 : v.volume;
    S.el.vin.value = String(x);
    /* accent-filled track, same language as the seek bar */
    var pc = (Math.max(0, Math.min(1, x)) * 100).toFixed(2) + '%';
    S.el.vin.style.background =
      'linear-gradient(90deg,var(--acc) ' + pc + ',rgba(255,255,255,.2) ' + pc + ')';
  }

  function show() {
    if (!S) return;
    S.el.root.classList.remove('plr-hide');
  }
  function kick() {
    if (!S) return;
    show();
    clearTimeout(S.idle);
    S.idle = setTimeout(function () {
      if (!S) return;
      if (S.overCtl || S.card || S.el.video.paused || S.el.subMenu.classList.contains('plr-open')) return;
      S.el.root.classList.add('plr-hide');
    }, IDLE_MS);
  }

  function onKey(e) {
    if (!S) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
      if (e.key === 'Escape') { Player.close(); e.preventDefault(); }
      return;
    }
    var v = S.el.video, k = e.key;
    if (k === 'Escape') {
      if (document.fullscreenElement || document.webkitFullscreenElement) return; // browser exits fs first
      Player.close(); e.preventDefault(); return;
    }
    if (S.card) return; // modal card owns the rest
    if (k === ' ' || k === 'Spacebar' || k === 'k') { toggle(true); e.preventDefault(); }
    else if (k === 'ArrowLeft') { nudge(-10); e.preventDefault(); }
    else if (k === 'ArrowRight') { nudge(10); e.preventDefault(); }
    else if (k === 'ArrowUp') { setVol(v.volume + 0.1); e.preventDefault(); }
    else if (k === 'ArrowDown') { setVol(v.volume - 0.1); e.preventDefault(); }
    else if (k === 'f' || k === 'F') { toggleFs(); e.preventDefault(); }
    else if (k === 'm' || k === 'M') { toggleMute(); e.preventDefault(); }
    kick();
  }
  function setVol(x) {
    var v = S.el.video;
    x = Math.max(0, Math.min(1, x));
    v.volume = x; v.muted = x === 0; lsSet(VOL_KEY, String(x));
  }
  function nudge(d) {
    var v = S.el.video;
    if (!isFinite(v.duration) || v.duration <= 0) return;
    v.currentTime = Math.max(0, Math.min(v.duration - 0.25, v.currentTime + d));
    toast((d > 0 ? '+' : '') + d + 's', 900);
  }

  // ------------------------------------------------------------------- saving
  function save(ended) {
    if (!S || S.destroyed) return;
    var v = S.el.video, d = v.duration, t = v.currentTime;
    if (!isFinite(d) || d <= 0 || !isFinite(t)) return;
    if (ended || t >= d * 0.95) { cwDrop(S.cwId, S.cwVid); return; }
    /* "far enough in to be worth remembering" is proportional, not a flat 5s:
       on a 10s registry clip a 5s floor throws away the entire first half. */
    if (t < Math.min(5, d * 0.05)) return;
    cwSave({
      id: S.cwId, video: S.cwVid, position: Math.round(t * 10) / 10, duration: Math.round(d * 10) / 10,
      title: S.title, sub: S.sub, type: S.meta.type || null,
      poster: S.meta.poster || null, updated: (new Date()).toISOString()
    });
  }

  function maybeResume() {
    if (!S || S.resumed) return;
    S.resumed = true;
    var v = S.el.video, d = v.duration;
    var rec = cwGet(S.cwId, S.cwVid);
    if (!rec || !isFinite(d) || d <= 0) return;
    var pos = Number(rec.position);
    /* The old gate was a flat `pos > 30`. On a feature film that is a good
       heuristic — nobody wants a resume prompt for the first half-minute. On
       the registry's short demo sources it is unsatisfiable: a 10s clip can
       never have a position above 30s, so the prompt never appeared, the saved
       position was never offered, and playback silently restarted at 0 even
       though continue-watching had recorded it correctly. The floor is now
       proportional as well as absolute, so it still reads as 30s for anything
       10 minutes or longer and scales down for short content. */
    var floor = Math.min(30, d * 0.05);
    if (!(pos > floor) || !(pos < d * 0.9)) return;
    var box = card(
      '<h3>Resume watching?</h3>' +
      '<p>' + esc(S.title) + (S.subUI ? ' — ' + esc(S.subUI) : '') + '<br>You stopped at <b>' + esc(fmt(pos)) + '</b> of ' + esc(fmt(d)) + '.</p>' +
      '<div class="plr-acts">' +
      '<button class="plr-a plr-pri" data-go="resume">Resume from ' + esc(fmt(pos)) + '</button>' +
      '<button class="plr-a" data-go="restart">Start over</button></div>'
    );
    var go = function (what) {
      closeCard();
      if (what === 'resume') { try { v.currentTime = pos; } catch (e) {} }
      var p = v.play(); if (p && p['catch']) p['catch'](noop);
    };
    box.querySelector('[data-go="resume"]').addEventListener('click', function () { go('resume'); });
    box.querySelector('[data-go="restart"]').addEventListener('click', function () { go('restart'); });
    v.pause();
  }

  // -------------------------------------------------------------------- cards
  function card(html) {
    closeCard();
    var wrap = h('div', 'plr-card');
    var box = h('div', 'plr-box', html);
    wrap.appendChild(box);
    S.el.root.appendChild(wrap);
    S.card = wrap;
    show();
    return box;
  }
  function closeCard() {
    if (S && S.card) { try { S.card.remove(); } catch (e) {} S.card = null; }
  }

  /* ---------------------------------------------- direct-P2P observability panel
     A live HUD for the browser-first torrent path (window.BT). Shows, once/second:
       · peers split by transport — WebRTC (direct swarm, one hop peer→browser) vs
         web-seed (HTTP GET against a static ws= host)
       · download / upload rate + total, progress, ETA
       · buffer health (seconds of decoded video ahead of the playhead)
       · THE LAW PROOF: "relay file-bytes: 0" — the signaling relay introduces peers
         then leaves the byte path, so it carries zero file bytes by construction.
     Plus adjustable knobs (max peers, instant-start/sequential) persisted to
     localStorage via BT.settings. Pure client, no deps, torn down with the player. */
  function fmtRate(bps) {
    if (!bps || bps < 1) return '0';
    if (bps < 1024) return Math.round(bps) + ' B/s';
    if (bps < 1048576) return (bps / 1024).toFixed(1) + ' KB/s';
    return (bps / 1048576).toFixed(2) + ' MB/s';
  }
  function fmtSize(b) {
    if (!b) return '0';
    if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }
  function bufferAhead(v) {
    try {
      var t = v.currentTime, br = v.buffered;
      for (var i = 0; i < br.length; i++) if (br.start(i) <= t + 0.25 && t <= br.end(i)) return br.end(i) - t;
    } catch (e) {}
    return 0;
  }

  function mountTorrentPanel(torrent) {
    if (!S || !S.el || !window.BT) return null;
    var LS_UI = 'hp.bt.panel';
    var collapsed = false;
    try { collapsed = localStorage.getItem(LS_UI) === '0'; } catch (e) {}

    var wrap = h('div', 'plr-p2p');
    wrap.style.cssText = 'position:absolute;left:14px;bottom:76px;z-index:40;max-width:300px;' +
      'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:rgba(255,255,255,.86);' +
      'background:rgba(13,13,15,.72);border:1px solid rgba(255,255,255,.10);border-radius:10px;' +
      '-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);box-shadow:0 6px 24px rgba(0,0,0,.4);' +
      'overflow:hidden;transition:opacity .3s;user-select:none';

    var head = h('div', 'plr-p2p-h');
    head.style.cssText = 'display:flex;align-items:center;gap:7px;padding:7px 10px;cursor:pointer;' +
      'background:rgba(255,255,255,.04)';
    head.innerHTML = '<span style="width:7px;height:7px;border-radius:50%;background:#3ad07a;' +
      'box-shadow:0 0 7px #3ad07a;flex:0 0 auto"></span>' +
      '<b style="color:#fff;font-weight:600;letter-spacing:.02em">Direct P2P</b>' +
      '<span style="flex:1"></span><span class="plr-p2p-tog" style="opacity:.6">▾</span>';
    wrap.appendChild(head);

    var body = h('div', 'plr-p2p-b');
    body.style.cssText = 'padding:8px 10px 10px;display:' + (collapsed ? 'none' : 'block');
    body.innerHTML =
      '<div class="r-src" style="margin-bottom:6px;color:#9fe8c0"></div>' +
      '<table style="width:100%;border-collapse:collapse">' +
      row2('WebRTC peers', 'v-rtc') + row2('Web-seeds', 'v-ws') +
      row2('Down', 'v-down') + row2('Up', 'v-up') +
      row2('Progress', 'v-prog') + row2('Buffer', 'v-buf') +
      '</table>' +
      '<div style="margin-top:7px;padding-top:6px;border-top:1px solid rgba(255,255,255,.09);' +
      'color:#3ad07a" class="v-relay">relay file-bytes: 0 ✓</div>' +
      '<div class="plr-p2p-knobs" style="margin-top:8px;padding-top:7px;' +
      'border-top:1px solid rgba(255,255,255,.09)"></div>';
    wrap.appendChild(body);

    function row2(label, cls) {
      return '<tr><td style="padding:1px 0;opacity:.62">' + label +
        '</td><td class="' + cls + '" style="padding:1px 0;text-align:right;color:#fff">–</td></tr>';
    }

    /* knobs — persisted via BT.settings/saveSettings (localStorage hp.bt.settings) */
    var knobs = body.querySelector('.plr-p2p-knobs');
    var cfg = {}; try { cfg = window.BT.settings() || {}; } catch (e) {}
    knobs.innerHTML =
      '<label style="display:flex;align-items:center;gap:6px;margin-bottom:5px;cursor:pointer">' +
      '<input type="checkbox" class="k-seq"' + (cfg.sequential !== false ? ' checked' : '') + '>' +
      '<span style="opacity:.8">Instant start (sequential)</span></label>' +
      '<label style="display:flex;align-items:center;gap:6px">' +
      '<span style="opacity:.8;flex:1">Max peers</span>' +
      '<input type="range" class="k-max" min="10" max="120" step="5" value="' + (cfg.maxConns || 55) +
      '" style="width:96px"><span class="k-max-v" style="width:24px;text-align:right">' +
      (cfg.maxConns || 55) + '</span></label>' +
      '<div class="k-note" style="opacity:.45;margin-top:4px;font-size:10px">max-peers applies to the next stream</div>';

    var kSeq = knobs.querySelector('.k-seq');
    var kMax = knobs.querySelector('.k-max');
    var kMaxV = knobs.querySelector('.k-max-v');
    on(kSeq, 'change', function () {
      var s = window.BT.settings(); s.sequential = kSeq.checked; window.BT.saveSettings(s);
      try { if (torrent) torrent.strategy = kSeq.checked ? 'sequential' : 'rarest'; } catch (e) {}
    });
    on(kMax, 'input', function () { kMaxV.textContent = kMax.value; });
    on(kMax, 'change', function () {
      var s = window.BT.settings(); s.maxConns = +kMax.value; window.BT.saveSettings(s);
    });

    function toggle() {
      collapsed = !collapsed;
      body.style.display = collapsed ? 'none' : 'block';
      head.querySelector('.plr-p2p-tog').textContent = collapsed ? '▸' : '▾';
      try { localStorage.setItem(LS_UI, collapsed ? '0' : '1'); } catch (e) {}
    }
    on(head, 'click', toggle);
    head.querySelector('.plr-p2p-tog').textContent = collapsed ? '▸' : '▾';

    S.el.root.appendChild(wrap);

    var srcEl = body.querySelector('.r-src');
    var q = function (c) { return body.querySelector('.' + c); };
    function tick() {
      var st = null; try { st = window.BT.statsOf(torrent); } catch (e) {}
      if (!st) return;
      var srcs = [];
      if (st.webrtcPeers) srcs.push(st.webrtcPeers + '× WebRTC');
      if (st.webSeeds) srcs.push(st.webSeeds + '× web-seed');
      srcEl.textContent = srcs.length ? ('source: ' + srcs.join(' + ')) : 'connecting…';
      q('v-rtc').textContent = st.webrtcPeers;
      q('v-ws').textContent = st.webSeeds;
      q('v-down').textContent = fmtRate(st.down);
      q('v-up').textContent = fmtRate(st.up);
      var pct = (st.progress * 100);
      q('v-prog').textContent = pct.toFixed(pct >= 100 ? 0 : 1) + '%  (' + fmtSize(st.downloaded) + ')';
      var ba = bufferAhead(S.el.video);
      q('v-buf').textContent = ba.toFixed(1) + 's';
      q('v-buf').style.color = ba < 1.5 ? '#e8b84a' : '#3ad07a';
      var rfb = st.relayFileBytes || 0;                       /* MEASURED, not a literal */
      var rel = q('v-relay');
      if (rel) {
        rel.textContent = 'relay file-bytes: ' + rfb + (rfb ? ' ⚠' : ' ✓');
        rel.style.color = rfb ? '#e8b84a' : '#3ad07a';
      }
    }
    tick();
    var iv = setInterval(tick, 1000);
    return { stop: function () { try { clearInterval(iv); } catch (e) {} try { wrap.remove(); } catch (e) {} } };
  }

  function fail(msg, extraHtml) {
    if (!S) return;
    spin(false);
    var box = card(
      '<h3>Can’t play this stream</h3>' +
      '<p>' + esc(msg) + '</p>' + (extraHtml || '') +
      '<div class="plr-acts">' +
      '<button class="plr-a plr-pri" data-go="retry">Try again</button>' +
      '<button class="plr-a" data-go="close">Close</button></div>'
    );
    box.querySelector('[data-go="retry"]').addEventListener('click', function () { closeCard(); route(); });
    box.querySelector('[data-go="close"]').addEventListener('click', function () { Player.close(); });
  }

  function magnetPanel(magnet, why, engineRunning) {
    var box = card(
      '<h3>' + esc(S.title) + '</h3>' +
      (S.subUI ? '<p>' + esc(S.subUI) + '</p>' : '') +
      '<p>' + esc(why) + '</p>' +
      '<textarea class="plr-mag" readonly spellcheck="false">' + esc(magnet) + '</textarea>' +
      '<div class="plr-acts">' +
      '<button class="plr-a plr-pri" data-go="copy">Copy magnet link</button>' +
      '<a class="plr-a" href="' + esc(magnet) + '">Open in torrent app</a>' +
      '<button class="plr-a" data-go="retry">Try the engine again</button>' +
      '<button class="plr-a" data-go="close">Close</button></div>' +
      (engineRunning
        ? '<p class="plr-note">The local engine is running but has no data for this torrent yet — give it a moment and retry.</p>'
        : '<p class="plr-note plr-engine-note">Optional: run the local streaming engine (<code>server/engine.mjs</code> on ' +
          esc(ENGINE) + ') and this plays in-app, no copy-paste.</p>')
    );
    /* The footnote is only honest when the engine is actually down. If it IS up but the
       opt-in is off, say so and offer the opt-in as one click — an explicit choice, so the
       browser-only-p2p law stays intact (the engine streams bytes through node). */
    var note = box.querySelector('.plr-engine-note');
    var optedIn = false;
    try { optedIn = localStorage.getItem('hp.torrent.localEngine') === '1'; } catch (e) {}
    if (note && !optedIn) engineUp().then(function (up) {
      if (!up || !note.isConnected) return;
      note.innerHTML = 'The local engine <b>is running</b> on <code>' + esc(ENGINE) + '</code> but in-app engine playback is off (browser-only p2p is the default). ' +
        '<button class="plr-a plr-pri" data-go="optin">Use the local engine</button>';
      note.querySelector('[data-go="optin"]').addEventListener('click', function () {
        try { localStorage.setItem('hp.torrent.localEngine', '1'); } catch (e) {}
        closeCard(); route();
      });
    });
    var ta = box.querySelector('textarea');
    var copy = box.querySelector('[data-go="copy"]');
    copy.addEventListener('click', function () {
      var done = function () { copy.textContent = 'Copied ✓'; setTimeout(function () { copy.textContent = 'Copy magnet link'; }, 1800); };
      try {
        ta.focus(); ta.select(); ta.setSelectionRange(0, magnet.length);
      } catch (e) {}
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(magnet).then(done, function () {
          try { document.execCommand('copy'); done(); } catch (e2) { toast('Select the text above and copy manually'); }
        });
      } else {
        try { document.execCommand('copy'); done(); } catch (e) { toast('Select the text above and copy manually'); }
      }
    });
    box.querySelector('[data-go="retry"]').addEventListener('click', function () {
      engineCache.at = 0;               /* force a fresh probe */
      S.viaEngine = false;
      closeCard();
      route();
    });
    box.querySelector('[data-go="close"]').addEventListener('click', function () { Player.close(); });
  }

  // ------------------------------------------------------------------ routing
  function route() {
    if (!S) return;
    var r = resolve(S.stream);
    spin(true);

    if (r.kind === 'external') {
      /* An honest hand-off, not an error. This item has no in-app stream to
         embed (a genuinely external-only link — for a live cam the resolver/addon
         HLS is preferred upstream, so we only land here when nothing plays). No
         pre-emptive window.open + apology: the primary action is a real anchor,
         and a user-gesture click on it is never pop-up-blocked. */
      spin(false);
      var site = hostLabel(r.url);
      var xbox = card(
        '<h3>Watch on ' + esc(site) + ' ↗</h3>' +
        '<p>This one lives on ' + esc(site) + ' — an external site, so we hand you off cleanly instead of pretending it’s ours. It opens in a new tab.</p>' +
        '<div class="plr-acts">' +
        '<a class="plr-a plr-pri" href="' + esc(r.url) + '" target="_blank" rel="noopener noreferrer">Open on ' + esc(site) + ' ↗</a>' +
        '<button class="plr-a" data-go="close">Close</button></div>'
      );
      xbox.querySelector('[data-go="close"]').addEventListener('click', function () { Player.close(); });
      return;
    }

    if (r.kind === 'torrent') {
      var magnet = magnetOf(S.stream, S.title);
      var idx = (S.stream.fileIdx != null ? S.stream.fileIdx : 0);
      var ih = String(S.stream.infoHash || '').toLowerCase();
      if (!ih && magnet) {
        var m = /btih:([a-z0-9]+)/i.exec(magnet);
        if (m) ih = m[1].toLowerCase();
      }
      if (!ih && !(magnet && window.BT && window.BT.canPlay(magnet))) { spin(false); fail('This source has no playable URL.'); return; }

      /* BROWSER-FIRST (no server at all): magnets carrying a web-seed (ws=), a
         fetchable .torrent (xs=) or a wss tracker have browser-reachable sources
         — WebTorrent 3.x streams them via the /sw.min.js service-worker bridge.
         Proven live 2026-08-21 (test-torrent.html headless: Sintel decoding at
         readyState 4 with zero servers). One attempt per session; any failure
         falls through to the engine cascade unchanged, and the user's Retry
         re-probes the engine, not this. Torrentio TCP/DHT-only magnets report
         canPlay:false and skip straight to the engine — the honest ceiling. */
      if (window.BT && !S.btTried && magnet && window.BT.canPlay(magnet)) {
        S.btTried = true;
        window.BT.tryPlay({ magnet: magnet, infoHash: ih || undefined, fileIdx: S.stream.fileIdx, timeoutMs: 12000 }).then(function (res) {
          if (!S || S.destroyed) return;
          if (res && res.ok) {
            return window.BT.streamTo(res.file, S.el.video).then(function () {
              if (!S || S.destroyed) { try { window.BT.destroy(res.infoHash); } catch (e) {} return; }
              S.btIH = res.infoHash;
              S.btTorrent = res.torrent;
              S.btFile = res.file;        /* the byte source subtitle auto-sync cuts audio windows from */
              S.viaBrowser = true;
              S.magnet = magnet;
              armBtStallGuard(res.torrent, magnet);   /* honest exit if the browser swarm stalls */
              S.playUrl = S.el.video.currentSrc || '';
              attachSubs();   /* browser-torrent path never calls start(); wire subs here too */
              try { S.btPanel = mountTorrentPanel(res.torrent); } catch (e) {}
              toast('Playing in-browser — no server needed', 2600);
              if (!S.audioRestored) S.el.video.muted = true;
              var p = S.el.video.play();
              if (p && p['catch']) p['catch'](function () { spin(false); show(); });
            }, function () { routeTorrentEngine(magnet, ih, idx); });
          }
          routeTorrentEngine(magnet, ih, idx);
        });
        return;
      }
      routeTorrentEngine(magnet, ih, idx);
      return;
    }

    if (r.kind === 'none') { spin(false); fail('This source has no playable URL.'); return; }
    start(r.kind, r.url);
  }

  /* Browser-torrent stall guard: tryPlay resolves ok as soon as metadata + the SW
     bridge are up, but a swarm with no reachable peers can then make zero progress and
     the <video> just hangs with no error. Give it an honest exit — a torrent 'error',
     or ~25s with no bytes and no playback, tears the browser torrent down and shows the
     copy-magnet panel (same honest fallback the engine path uses). */
  function armBtStallGuard(torrent, magnet) {
    if (!S || S.destroyed || !torrent) return;
    var done = false;
    function bail(why) {
      if (done || !S || S.destroyed || S.viaEngine) return;
      done = true;
      var adv = S.el.video && S.el.video.currentTime > 0.2;
      if (adv || (torrent.downloaded || 0) > 65536) return;   /* actually playing/progressing — no bail */
      try { if (S.btIH && window.BT) window.BT.destroy(S.btIH); } catch (e) {}
      try { if (S.btPanel) S.btPanel.stop(); } catch (e) {}
      S.viaBrowser = false; S.btIH = null;
      spin(false);
      magnetPanel(magnet, why);
    }
    try { torrent.on('error', function () { bail('This torrent errored in the browser. Copy the magnet into your torrent client to watch it there.'); }); } catch (e) {}
    S.btStallTimer = setTimeout(function () {
      bail('This torrent has no browser-reachable peers right now, so it can’t play peer-to-peer here. Copy the magnet into your torrent client to watch it there.');
    }, 25000);
  }

  /* the pre-existing local-engine cascade for torrent sources, unchanged */
  function routeTorrentEngine(magnet, ih, idx) {
    if (!S || S.destroyed) return;
    var mg = magnet || (ih ? 'magnet:?xt=urn:btih:' + ih : '');
    /* THE LAW (fire17): a node may relay the WebRTC handshake but must NEVER carry the
       bytes — playback is peer-to-peer, straight from peers to the browser. So a browser
       plays a torrent only when the swarm has WebRTC peers: our own seeded catalog, or a
       magnet advertising a wss:// tracker / web-seed (window.BT handles those above,
       before we ever get here). A TCP/uTP-only swarm (most Torrentio magnets) has no
       browser-reachable peer, and no handshake trick conjures one — the browser and a
       vanilla BitTorrent peer share zero common transport. Rather than smuggle bytes
       through a node (which would break the law), we say so honestly and hand over the
       magnet. A local byte-streaming engine stays available ONLY behind an explicit
       opt-in, because using it violates the browser-only-p2p law by design. */
    var engineOptIn = false;
    try { engineOptIn = localStorage.getItem('hp.torrent.localEngine') === '1'; } catch (e) {}
    if (!engineOptIn) {
      spin(false);
      magnetPanel(mg, 'Browsers can only play a torrent peer-to-peer when its swarm has WebRTC peers — our own catalog, or a magnet carrying a wss:// tracker or a web-seed. This swarm is TCP-only, so no browser-reachable peer exists (a relay may punch the handshake, but it must never carry the bytes). Copy the magnet into a torrent client to watch it there.');
      return;
    }
    if (!ih) { spin(false); magnetPanel(mg, 'This torrent has no infoHash for the local engine.'); return; }
    engineUp().then(function (up) {
        if (!S || S.destroyed) return;
        if (up) {
          var u = ENGINE + '/stream/' + encodeURIComponent(ih) + '/' + encodeURIComponent(idx);
          S.viaEngine = true;
          S.magnet = mg;
          /* Ask the engine HOW to play first: browser-native containers stream direct with
             Range; MKVs with Dolby/DTS audio come back as an ffmpeg HLS transcode (audio →
             AAC) — otherwise Chrome plays them as a silent movie. Old engines without
             /play fall through to the direct URL. */
          fetch(ENGINE + '/play/' + encodeURIComponent(ih) + '/' + encodeURIComponent(idx), { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })['catch'](function () { return null; })
            .then(function (j) {
              if (!S || S.destroyed) return;
              if (j && j.ok && j.url) {
                u = j.url;
                S.engineProbe = j.probe || null;
                toast(j.kind === 'hls' ? 'Local engine: audio transcoded to AAC (' + ((j.probe && j.probe.audio) || 'unsupported') + ' → AAC) · not browser-p2p'
                                       : 'Streaming via the local engine (opt-in — not browser-p2p)', 3200);
                start(j.kind === 'hls' ? 'hls' : 'url', u);
              } else {
                toast('Streaming via the local engine (opt-in — not browser-p2p)', 2600);
                start(isHls(u) ? 'hls' : 'url', u);
              }
            });
        } else {
          spin(false);
          magnetPanel(mg, 'Local-engine opt-in is on but the engine is not running. Copy the magnet into your torrent client, or start the engine.');
        }
      })['catch'](function () {
        if (!S || S.destroyed) return;
        spin(false);
        magnetPanel(mg, 'Local engine did not answer. Copy the magnet into your torrent client.');
      });
  }

  /* CORS on a media element is a cost, not a safety feature, and it has to be
     decided BEFORE src is assigned (the attribute is read at load time).
       - direct MP4 / native HLS: a plain <video src> needs no CORS at all, and
         asking for it shrinks the set of playable real-world sources to those
         hosts that happen to send ACAO. Default OFF.
       - hls.js / MSE: the element is fed a blob: URL, so its crossOrigin is
         irrelevant — hls.js does its own CORS-mode XHRs regardless.
     Nothing in this file reads video pixels (no canvas capture, no
     toDataURL/captureStream) and no external <track> is fetched, so no consumer
     here needs a CORS-clean element. Opt in per source when one ever does. */
  function applyCORS(v, want) {
    if (want) v.crossOrigin = 'anonymous';
    else if (v.hasAttribute('crossorigin')) v.removeAttribute('crossorigin');
  }

  /* Chaturbate addon streams hand over a VIDEO-ONLY chunklist (chunklist_N_video_…);
     the AAC audio is an alternate rendition only the (tokened, short-lived) master
     references — so the room played silent. The sibling audio chunklist shares the same
     path, numeric id and session param, and the edge serves it CORS-open. Probe it and
     synthesize a two-line master that binds video + audio. No resolver needed. */
  var CB_VCHUNK = /^(https:\/\/[^/]*\.live\.mmcdn\.com\/.*\/)chunklist_\d+_video_(\d+[^?]*\.m3u8)(\?.*)?$/;
  function cbMasterFor(url) {
    var m = CB_VCHUNK.exec(url);
    if (!m) return Promise.resolve(null);
    var tries = [];
    for (var i = 9; i >= 0; i--) tries.push(m[1] + 'chunklist_' + i + '_audio_' + m[2] + (m[3] || ''));
    var probe = function (k) {
      if (k >= tries.length) return Promise.resolve(null);
      return fetch(tries[k], { cache: 'no-store' }).then(function (r) {
        if (!r.ok) return probe(k + 1);
        return r.text().then(function (t) { return t.slice(0, 7) === '#EXTM3U' ? tries[k] : probe(k + 1); });
      })['catch'](function () { return probe(k + 1); });
    };
    return probe(0).then(function (au) {
      if (!au) return null;
      var txt = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="cb",NAME="audio",DEFAULT=YES,AUTOSELECT=YES,URI="' + au + '"\n' +
                '#EXT-X-STREAM-INF:BANDWIDTH=3000000,AUDIO="cb"\n' + url + '\n';
      return URL.createObjectURL(new Blob([txt], { type: 'application/vnd.apple.mpegurl' }));
    });
  }

  function start(kind, url) {
    if (!S) return;
    var v = S.el.video;
    S.playUrl = url;
    if (kind === 'hls' && !S.cbAudioFixed && CB_VCHUNK.test(url)) {
      S.cbAudioFixed = true;              /* one attempt per open; fall through on failure */
      spin(true);
      cbMasterFor(url).then(function (u2) {
        if (!S || S.destroyed) return;
        if (u2) S.blobs.push(u2);
        start(kind, u2 || url);
      });
      return;
    }
    applyCORS(v, !!(S.opts && S.opts.crossOrigin));
    attachSubs();

    var autoplay = function () {
      /* Start MUTED so playback is never blocked: unmuted autoplay is denied when
         play() fires after async manifest-parse (outside the opening click's gesture
         window), which left live streams silent or paused. The 'playing' handler
         restores the user's real volume/mute the instant the first frame lands. */
      if (!S.audioRestored) v.muted = true;
      var p = v.play();
      if (p && p['catch']) p['catch'](function () { spin(false); show(); });
    };

    if (kind === 'hls') {
      if (nativeHls(v)) { v.src = url; autoplay(); return; }
      loadHls().then(function (Hls) {
        if (!S || S.destroyed) return;
        if (!Hls.isSupported()) {
          if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = url; autoplay(); return; }
          fail('HLS is not supported in this browser.'); return;
        }
        /* live streams (registry `live`, resolver/addon live cams) want the low-
           latency path and the live edge; VOD keeps the deep back-buffer. */
        var hls = new Hls(S.live
          ? { enableWorker: true, lowLatencyMode: true, backBufferLength: 12, liveSyncDurationCount: 3, startPosition: -1 }
          /* an engine transcode is a GROWING event playlist (no ENDLIST yet) — hls.js would
             treat it as live and start at the edge; it is a film, so start at 0 */
          : { enableWorker: true, lowLatencyMode: false, backBufferLength: 90, startPosition: S.viaEngine ? 0 : -1 });
        S.hls = hls;
        hls.on(Hls.Events.ERROR, function (evt, data) {
          if (!data || !data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            try { hls.startLoad(); toast('Network hiccup — reconnecting…', 2000); return; } catch (e) {}
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            try { hls.recoverMediaError(); toast('Recovering the video stream…', 2000); return; } catch (e) {}
          }
          try { hls.destroy(); } catch (e) {}
          S.hls = null;
          fail('The HLS stream failed (' + esc(data.details || data.type || 'fatal error') + ').');
        });
        hls.on(Hls.Events.MANIFEST_PARSED, function () {
          if (S && S.live) {
            try { var lsp = hls.liveSyncPosition; if (isFinite(lsp) && lsp > 0) v.currentTime = lsp; } catch (e) {}
          }
          autoplay();
        });
        hls.loadSource(url);
        hls.attachMedia(v);
      }, function (e) {
        if (!S || S.destroyed) return;
        if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = url; autoplay(); return; }
        fail('Could not load the bundled HLS player: ' + esc(e && e.message ? e.message : 'unknown error'));
      });
      return;
    }
    v.src = url;
    autoplay();
  }

  // --------------------------------------------------------------- subtitles
  /* BASELINE LIVE-SUBTITLES SYSTEM ("known highest standard, fully featured")
     ------------------------------------------------------------------------
     Sources : subs already carried on the stream/meta  +  every installed
               Stremio addon that declares the `subtitles` resource  +  the
               public OpenSubtitles v3 addon (default, CORS-open, verified), all
               merged & deduped and grouped by language (window.SubsSource.list).
     Render  : the browser's native WebVTT parser fills a `hidden` <track>; we
               copy its cues ONCE and paint the active ones into our own overlay
               (S.el.subCue). That gives full control over text size, colour,
               background, vertical position and a live manual sync-offset,
               identically across browsers, and lets the subs-autosync lane feed
               us synced cues without a second renderer.
     Formats : subsToVtt() decodes bytes (charset-sniffed) and converts SRT / SSA
               / VTT to clean WebVTT.
     Persist : hp.subs.cfg (shared, merge-safe with subs-autosync) — last-used
               off|language is auto-applied on open; styling persists too. */

  // -- shared config (merge-safe with the subs-autosync lane) --
  function subCfg() {
    try {
      if (window.SubsAutoSync && SubsAutoSync.config && SubsAutoSync.config.get) {
        var c = SubsAutoSync.config.get();
        if (c && typeof c === 'object') return c;
      }
    } catch (e) {}
    return jget(SUB_KEY, {}) || {};
  }
  function subCfgSet(patch) {
    var cur = subCfg();
    for (var k in patch) if (patch.hasOwnProperty(k)) cur[k] = patch[k];
    try { if (window.SubsAutoSync && SubsAutoSync.config && SubsAutoSync.config.set) SubsAutoSync.config.set(patch); } catch (e) {}
    lsSet(SUB_KEY, JSON.stringify(cur));   /* baseline persists locally too, so it works standalone */
    return cur;
  }

  /* {type,id} for the Stremio subtitles resource. Series compose imdb:season:ep.
     Returns null when the item has no usable id (e.g. adult items with no imdb
     id) — the picker then simply offers whatever subs the stream already had. */
  function subMediaId() {
    var meta = S.meta || {}, stream = S.stream || {}, video = S.video || {};
    var raw = meta.imdb_id || meta.imdbId || meta.id || stream.imdbId || stream.id || '';
    var mm = /tt\d+/i.exec(String(raw));
    var base = mm ? mm[0] : String(raw || '');
    if (!base) return null;
    var type = meta.type || stream.type || 'movie';
    var sn = video ? (video.season != null ? video.season : video.seasonNumber) : null;
    var en = video ? (video.episode != null ? video.episode : (video.number != null ? video.number : video.episodeNumber)) : null;
    if (sn != null && en != null) { type = 'series'; base = base + ':' + sn + ':' + en; }
    return { type: type, id: base };
  }

  /* window.SubsSource.list(type,id,extra) -> Promise<[{id,url,lang,label?}]>.
     Shared fetch layer; the subs-autosync lane capability-detects and reuses it. */
  function subSourceList(type, id, extra) {
    if (!type || !id) return Promise.resolve([]);
    var bases = [];
    try {
      if (window.Addons && Addons.list && Addons.supports) {
        var inst = Addons.list();
        for (var i = 0; i < inst.length; i++) {
          try { if (Addons.supports(inst[i].manifest, 'subtitles', type, id)) bases.push(inst[i].url); } catch (e) {}
        }
      }
    } catch (e) {}
    if (bases.indexOf(SUB_DEFAULT_BASE) === -1) bases.push(SUB_DEFAULT_BASE);
    var exSeg = '';
    if (extra && typeof extra === 'object') {
      var ps = [];
      for (var ek in extra) if (extra.hasOwnProperty(ek) && extra[ek] != null && extra[ek] !== '') {
        ps.push(encodeURIComponent(ek) + '=' + encodeURIComponent(String(extra[ek])));
      }
      exSeg = ps.join('&');
    }
    var seen = {}, out = [];
    var jobs = bases.map(function (base) {
      var url = base + '/subtitles/' + encodeURIComponent(type) + '/' + encodeURIComponent(id) + (exSeg ? '/' + exSeg : '') + '.json';
      return fetchT(url, 8000, { cache: 'force-cache' }).then(function (r) {
        return r && r.ok ? r.json() : null;
      }).then(function (j) {
        var arr = j && j.subtitles;
        if (!arr || !arr.length) return;
        for (var i = 0; i < arr.length; i++) {
          var s = arr[i];
          if (!s || !s.url || seen[s.url]) continue;
          seen[s.url] = 1;
          out.push({ id: s.id || s.url, url: s.url, lang: String(s.lang || s.language || s.srclang || '').toLowerCase(), label: s.label || null });
        }
      })['catch'](function () {});
    });
    return Promise.all(jobs).then(function () { return out; }, function () { return out; });
  }
  try { if (!window.SubsSource) window.SubsSource = { list: subSourceList }; } catch (e) {}

  // -- attach / build the picker --
  function attachSubs() {
    if (!S || S.subsInit) return;
    S.subsInit = true;
    S.subActive = -1;      /* index into S.subLangs, or -1 == off */
    S.subOffsetMs = 0;     /* manual sync offset (ms); not persisted — content-specific */
    S.subCues = null;      /* [{s,e,html}] for the active track */
    S.subCand = [];        /* [{id,url,lang,label}] merged candidates */
    S.subReq = 0;          /* monotonic guard against out-of-order loads */

    var pre = S.stream.subtitles || S.meta.subtitles || [];
    if (Object.prototype.toString.call(pre) === '[object Array]') {
      for (var i = 0; i < pre.length; i++) {
        if (pre[i] && pre[i].url) {
          S.subCand.push({ id: pre[i].id || pre[i].url, url: pre[i].url,
            lang: String(pre[i].lang || pre[i].language || pre[i].id || '').toLowerCase(), label: pre[i].label || null });
        }
      }
    }
    applySubStyleFromCfg();
    rebuildSubMenu();

    var mid = subMediaId();
    if (mid) {
      var extra = {};
      var fn = (S.stream && (S.stream.filename || (S.stream.behaviorHints && S.stream.behaviorHints.filename))) || '';
      if (fn) extra.filename = fn;
      subSourceList(mid.type, mid.id, extra).then(function (list) {
        if (!S || S.destroyed) return;
        if (list && list.length) {
          var seen = {}, k;
          for (k = 0; k < S.subCand.length; k++) seen[S.subCand[k].url] = 1;
          for (k = 0; k < list.length; k++) if (!seen[list[k].url]) { seen[list[k].url] = 1; S.subCand.push(list[k]); }
          rebuildSubMenu();
        }
        maybeAutoApply();
      }, function () { if (S && !S.destroyed) maybeAutoApply(); });
    } else {
      maybeAutoApply();
    }
  }

  /* group candidates by language; English first, then alphabetical */
  function subGroup() {
    var langs = [], byLang = {};
    for (var i = 0; i < S.subCand.length; i++) {
      var c = S.subCand[i], lg = c.lang || 'und';
      if (!byLang[lg]) { byLang[lg] = { lang: lg, label: c.label || langName(lg), cands: [] }; langs.push(byLang[lg]); }
      byLang[lg].cands.push(c);
    }
    langs.sort(function (a, b) {
      var ae = (a.lang === 'eng' || a.lang === 'en') ? 0 : 1, be = (b.lang === 'eng' || b.lang === 'en') ? 0 : 1;
      if (ae !== be) return ae - be;
      return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
    });
    S.subLangs = langs;
    return langs;
  }

  function rebuildSubMenu() {
    var m = S.el.subMenu, langs = subGroup();
    S.el.subBtn.style.display = langs.length ? 'flex' : 'none';
    var html = '<h5>Subtitles</h5><div class="plr-sub-list">';
    html += '<button data-lang="__off" class="plr-sub-track"><i></i>Off</button>';
    for (var i = 0; i < langs.length; i++) {
      var count = langs[i].cands.length > 1 ? ' <span style="opacity:.45">(' + langs[i].cands.length + ')</span>' : '';
      html += '<button data-lang="' + esc(langs[i].lang) + '" class="plr-sub-track"><i></i>' + esc(langs[i].label) + count + '</button>';
    }
    html += '</div>';
    html += '<div class="plr-sub-sec"><span class="plr-sub-lb">Sync offset</span><div class="plr-sub-row">' +
      '<button class="plr-sub-b" data-sync="-250" title="Subtitles earlier">−250</button>' +
      '<button class="plr-sub-b" data-sync="-50">−50</button>' +
      '<span class="plr-sub-sync" data-sync-val>0 ms</span>' +
      '<button class="plr-sub-b" data-sync="50">+50</button>' +
      '<button class="plr-sub-b" data-sync="250" title="Subtitles later">+250</button></div></div>';
    html += '<div class="plr-sub-sec"><span class="plr-sub-lb">Text size</span><div class="plr-sub-row">' +
      '<button class="plr-sub-b" data-size="0.8">Small</button>' +
      '<button class="plr-sub-b" data-size="1">Normal</button>' +
      '<button class="plr-sub-b" data-size="1.35">Large</button></div></div>';
    html += '<div class="plr-sub-sec"><span class="plr-sub-lb">Text colour</span><div class="plr-sub-row">' +
      '<button class="plr-sw" data-color="#ffffff" style="background:#fff" title="White"></button>' +
      '<button class="plr-sw" data-color="#ffe14d" style="background:#ffe14d" title="Yellow"></button>' +
      '<button class="plr-sw" data-color="#8be9fd" style="background:#8be9fd" title="Cyan"></button>' +
      '<button class="plr-sw" data-color="#7CFC7C" style="background:#7cfc7c" title="Green"></button></div></div>';
    html += '<div class="plr-sub-sec"><span class="plr-sub-lb">Background</span><div class="plr-sub-row">' +
      '<button class="plr-sub-b" data-bg="none">None</button>' +
      '<button class="plr-sub-b" data-bg="shadow">Shadow</button>' +
      '<button class="plr-sub-b" data-bg="dim">Dim</button>' +
      '<button class="plr-sub-b" data-bg="solid">Solid</button></div></div>';
    html += '<div class="plr-sub-sec"><span class="plr-sub-lb">Position</span><div class="plr-sub-row">' +
      '<button class="plr-sub-b" data-pos="low">Lower</button>' +
      '<button class="plr-sub-b" data-pos="normal">Normal</button>' +
      '<button class="plr-sub-b" data-pos="high">Higher</button></div></div>';
    if (window.SubsAutoSync && SubsAutoSync.sync) {
      html += '<div class="plr-sub-sec"><div class="plr-sub-row">' +
        '<button class="plr-sub-b" data-autosync="1" style="flex:1">Auto-sync (beta)</button></div></div>';
    }
    m.innerHTML = html;
    wireSubMenu();
    markSubUI();
  }

  function wireSubMenu() {
    var m = S.el.subMenu;
    m.onclick = function (e) {
      var b = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!b || !m.contains(b)) return;
      if (b.hasAttribute('data-lang')) { var lg = b.getAttribute('data-lang'); pickLang(lg === '__off' ? null : lg); }
      else if (b.hasAttribute('data-sync')) nudgeSync(parseInt(b.getAttribute('data-sync'), 10));
      else if (b.hasAttribute('data-size')) setSubStyle({ size: parseFloat(b.getAttribute('data-size')) });
      else if (b.hasAttribute('data-color')) setSubStyle({ color: b.getAttribute('data-color') });
      else if (b.hasAttribute('data-bg')) setSubStyle({ bg: b.getAttribute('data-bg') });
      else if (b.hasAttribute('data-pos')) setSubStyle({ pos: b.getAttribute('data-pos') });
      else if (b.hasAttribute('data-autosync')) runAutoSync(b);
    };
  }

  function markSubUI() {
    if (!S || !S.el) return;
    var m = S.el.subMenu;
    var curLang = (S.subActive >= 0 && S.subLangs && S.subLangs[S.subActive]) ? S.subLangs[S.subActive].lang : '__off';
    var tb = m.querySelectorAll('.plr-sub-track'), i;
    for (i = 0; i < tb.length; i++) {
      var on = tb[i].getAttribute('data-lang') === curLang;
      tb[i].className = 'plr-sub-track' + (on ? ' plr-sel' : '');
      var ic = tb[i].querySelector('i'); if (ic) ic.textContent = on ? '✓' : '';
    }
    var st = S.subStyle || {};
    subHi(m, 'data-size', String(st.size != null ? st.size : 1));
    subHi(m, 'data-color', st.color || '#ffffff');
    subHi(m, 'data-bg', st.bg || 'dim');
    subHi(m, 'data-pos', st.pos || 'normal');
    var sv = m.querySelector('[data-sync-val]');
    if (sv) sv.textContent = (S.subOffsetMs > 0 ? '+' : '') + (S.subOffsetMs || 0) + ' ms';
    S.el.subBtn.classList[S.subActive >= 0 ? 'add' : 'remove']('plr-on');
  }
  function subHi(m, attr, val) {
    var bs = m.querySelectorAll('[' + attr + ']'), i;
    for (i = 0; i < bs.length; i++) {
      var on = bs[i].getAttribute(attr) === val;
      var sw = bs[i].className.indexOf('plr-sw') >= 0;
      bs[i].className = (sw ? 'plr-sw' : 'plr-sub-b') + (on ? ' plr-on' : '');
    }
  }

  // -- styling --
  function applySubStyleFromCfg() {
    var cfg = subCfg();
    S.subStyle = {
      size: cfg.size != null ? cfg.size : 1,
      color: cfg.color || '#ffffff',
      bg: cfg.bg || 'dim',
      pos: cfg.pos || 'normal'
    };
    applySubStyle();
  }
  function setSubStyle(patch) {
    S.subStyle = S.subStyle || {};
    for (var k in patch) if (patch.hasOwnProperty(k)) S.subStyle[k] = patch[k];
    subCfgSet(patch);
    applySubStyle();
    markSubUI();
  }
  function applySubStyle() {
    var box = S.el.subCue; if (!box) return;
    var st = S.subStyle || {};
    var bgMap = { none: 'transparent', shadow: 'transparent', dim: 'rgba(0,0,0,.62)', solid: 'rgba(0,0,0,.92)' };
    box.style.setProperty('--subSize', String(st.size || 1));
    box.style.setProperty('--subColor', st.color || '#fff');
    box.style.setProperty('--subBg', bgMap[st.bg] != null ? bgMap[st.bg] : 'rgba(0,0,0,.62)');
    box.style.setProperty('--subShadow', st.bg === 'none'
      ? '0 1px 2px rgba(0,0,0,.9)'
      : (st.bg === 'shadow' ? '0 1px 4px #000,0 0 5px #000,0 1px 8px rgba(0,0,0,.9)' : '0 1px 3px rgba(0,0,0,.95)'));
    /* preserve display state, only swap the position class */
    var wasOn = box._html ? true : false;
    box.className = 'plr-cue' + (st.pos === 'low' ? ' plr-p-low' : st.pos === 'high' ? ' plr-p-high' : '');
    if (wasOn) box.style.display = 'block';
  }

  // -- manual sync offset (live) --
  function nudgeSync(delta) {
    S.subOffsetMs = (S.subOffsetMs || 0) + delta;
    if (S.subOffsetMs > 600000) S.subOffsetMs = 600000;
    if (S.subOffsetMs < -600000) S.subOffsetMs = -600000;
    markSubUI();
    S._subForce = true;   /* repaint immediately on the next frame */
  }

  // -- track selection --
  function hideAllTracks() {
    try {
      var tt = S.el.video.textTracks;
      for (var i = 0; i < tt.length; i++) tt[i].mode = 'disabled';
    } catch (e) {}
  }
  function clearCueBox() {
    var b = S && S.el && S.el.subCue;
    if (b) { b.innerHTML = ''; b._html = ''; b.style.display = 'none'; }
  }

  function pickLang(lang) {
    if (!S) return;
    S.el.subMenu.classList.remove('plr-open');
    if (lang == null) {
      S.subActive = -1; S.subCues = null;
      subCfgSet({ mode: 'off' });
      stopSubRender(); hideAllTracks(); clearCueBox(); markSubUI();
      return;
    }
    var idx = -1;
    for (var i = 0; i < S.subLangs.length; i++) if (S.subLangs[i].lang === lang) { idx = i; break; }
    if (idx < 0) return;
    S.subActive = idx;
    subCfgSet({ mode: 'lang', lang: lang });
    markSubUI();
    loadCand(S.subLangs[idx].cands[0]);   /* lazy: first candidate for the language */
  }

  function loadCand(cand) {
    if (!cand) return;
    var reqId = ++S.subReq;
    if (cand._cues) { installCues(cand._cues, reqId); maybeAutoSync(cand, reqId); return; }
    toast('Loading subtitles…', 1400);
    fetchT(cand.url, 12000, { cache: 'force-cache' }).then(function (r) {
      if (!r || !r.ok) throw new Error('HTTP ' + (r && r.status));
      return r.arrayBuffer();
    }).then(function (buf) {
      if (!S || S.destroyed || reqId !== S.subReq) return;
      var vtt = subsToVtt(new Uint8Array(buf), { name: cand.url, srclang: cand.lang });
      if (!vtt) throw new Error('empty subtitle');
      parseVtt(vtt, cand, reqId);
    })['catch'](function () {
      if (!S || S.destroyed || reqId !== S.subReq) return;
      toast('Those subtitles could not be loaded');
      S.subActive = -1; markSubUI();
    });
  }

  /* Feed the VTT to a `hidden` <track> so the UA's own parser builds the cues,
     then copy them into a plain array we render ourselves. Reuses the native,
     spec-correct WebVTT parser instead of re-implementing cue parsing. */
  function parseVtt(vtt, cand, reqId) {
    var v = S.el.video;
    if (S.subTrackEl) { try { if (S.subTrackEl.parentNode) S.subTrackEl.parentNode.removeChild(S.subTrackEl); } catch (e) {} S.subTrackEl = null; }
    var blob = new Blob([vtt], { type: 'text/vtt' });
    var url = URL.createObjectURL(blob); S.blobs.push(url);
    var tr = document.createElement('track');
    tr.kind = 'subtitles';
    tr.srclang = String(cand.lang || 'und').slice(0, 8);
    tr.label = cand.label || langName(cand.lang);
    tr.src = url;
    v.appendChild(tr); S.subTrackEl = tr;
    try { tr.track.mode = 'hidden'; } catch (e) {}   /* parse but never let the UA draw it */

    var settled = false;
    var harvest = function () {
      if (settled || !S || S.destroyed || reqId !== S.subReq) return;
      var t = tr.track;
      if (!t) return;
      try { t.mode = 'hidden'; } catch (e) {}
      var cues = t.cues;
      if (!cues || !cues.length) return;   /* not populated yet — poll again */
      settled = true;
      clearInterval(poll);
      var arr = [];
      for (var i = 0; i < cues.length; i++) arr.push({ s: cues[i].startTime, e: cues[i].endTime, html: cueHtml(cues[i]) });
      arr.sort(function (a, b) { return a.s - b.s || a.e - b.e; });
      cand._cues = arr;
      hideAllTracks();   /* cues are copied — free the native track from rendering */
      installCues(arr, reqId);
      maybeAutoSync(cand, reqId);   /* background whisper fine-sync + confident hotswap */
    };
    tr.addEventListener('load', harvest);
    var tries = 0;
    var poll = setInterval(function () {
      if (!S || S.destroyed || reqId !== S.subReq) { clearInterval(poll); return; }
      harvest();
      if (!settled && ++tries > 60) { clearInterval(poll); if (reqId === S.subReq) { toast('Those subtitles could not be loaded'); S.subActive = -1; markSubUI(); } }
    }, 50);
  }

  /* Safe HTML for a cue — getCueAsHTML() returns UA-built nodes (no source
     attributes survive), so its innerHTML is safe to inject. */
  function cueHtml(cue) {
    try {
      if (cue.getCueAsHTML) {
        var d = document.createElement('div');
        d.appendChild(cue.getCueAsHTML());
        return d.innerHTML;
      }
    } catch (e) {}
    return esc(cue.text || '').replace(/\n/g, '<br>');
  }

  function installCues(arr, reqId) {
    if (!S || S.destroyed || reqId !== S.subReq) return;
    S.subCues = arr;
    S._subI = 0;
    S._subForce = true;
    startSubRender();
  }

  // -- custom cue render loop --
  function startSubRender() { if (S && !S._subLoop) { S._subLoop = true; subRenderTick(); } }
  function stopSubRender() {
    if (!S) return;
    S._subLoop = false;
    if (S.subRaf) { try { cancelAnimationFrame(S.subRaf); } catch (e) {} S.subRaf = null; }
  }
  function subRenderTick() {
    if (!S || !S._subLoop) return;
    S.subRaf = requestAnimationFrame(subRenderTick);
    var box = S.el.subCue, cues = S.subCues;
    if (!box) return;
    if (!cues || !cues.length || S.subActive < 0) {
      if (box._html) { box.innerHTML = ''; box._html = ''; box.style.display = 'none'; }
      return;
    }
    var t = S.el.video.currentTime - (S.subOffsetMs || 0) / 1000;
    var html = subActiveHtml(cues, t);
    if (html !== box._html || S._subForce) {
      S._subForce = false;
      box.innerHTML = html;
      box._html = html;
      box.style.display = html ? 'block' : 'none';
    }
  }
  /* O(1)-amortised active-cue scan via a moving cursor; correct on seeks and
     overlapping cues. Cues are start-sorted. */
  function subActiveHtml(cues, t) {
    var i = S._subI || 0;
    if (i > cues.length) i = 0;
    while (i > 0 && cues[i - 1].e > t) i--;
    while (i < cues.length && cues[i].e <= t) i++;
    S._subI = i;
    var out = '';
    for (var j = i; j < cues.length && cues[j].s <= t; j++) {
      if (cues[j].e > t) out += '<div class="plr-cue-line">' + cues[j].html + '</div>';
    }
    return out;
  }

  function maybeAutoApply() {
    if (!S || S.destroyed || S.subActive >= 0) return;
    var cfg = subCfg();
    if (cfg.mode === 'lang' && cfg.lang && S.subLangs) {
      for (var i = 0; i < S.subLangs.length; i++) if (S.subLangs[i].lang === cfg.lang) { pickLang(cfg.lang); return; }
    }
    /* mode 'off' or no persisted/available choice: stay off, don't surprise-enable */
    markSubUI();
  }

  /* Optional consumer of the subs-autosync lane (whisper alignment). Only shown
     when that lane is loaded; my manual offset is the guaranteed baseline. */
  function runAutoSync(btn) {
    if (!S || !window.SubsAutoSync || !SubsAutoSync.sync) return;
    var mid = subMediaId() || {};
    var ctx = { type: mid.type, id: mid.id };
    if (S.video) { if (S.video.season != null) ctx.season = S.video.season; if (S.video.episode != null) ctx.episode = S.video.episode; }
    ctx.lang = (S.subActive >= 0 && S.subLangs[S.subActive]) ? S.subLangs[S.subActive].lang : (subCfg().lang || 'eng');
    ctx.audioSource = subAudioSource();   /* same window-scoped source as the automatic flow */
    var reqId = ++S.subReq;
    btn.textContent = 'Syncing…'; btn.classList.add('plr-on');
    var reset = function () { if (S && !S.destroyed) { btn.textContent = 'Auto-sync (beta)'; btn.classList.remove('plr-on'); } };
    try {
      Promise.resolve(SubsAutoSync.sync(S.el.video, S.subCand, ctx)).then(function (res) {
        if (!S || S.destroyed || reqId !== S.subReq) { reset(); return; }
        reset();
        if (res && res.cues && res.cues.length) {
          var arr = res.cues.map(function (c) { return { s: c.start, e: c.end, html: esc(c.text || '').replace(/\n/g, '<br>') }; });
          arr.sort(function (a, b) { return a.s - b.s || a.e - b.e; });
          S.subOffsetMs = 0; installCues(arr, reqId); markSubUI();
          toast('Auto-synced', 1600);
        } else if (res && typeof res.offsetMs === 'number') {
          S.subOffsetMs = res.offsetMs; markSubUI(); S._subForce = true;
          toast('Auto-synced (' + res.offsetMs + ' ms)', 1600);
        } else { toast('Auto-sync found no confident match'); }
      }, function () { reset(); toast('Auto-sync failed'); });
    } catch (e) { reset(); }
  }

  /* AUTOMATIC autosync (fire17's flow): once the raw AVAILABLE cues for a language
     are on screen, ask the whisper coherence engine to fine-sync in the background
     and HOTSWAP to the synced cues — but only when it is CONFIDENT (coherent match
     or a real offset), so we never surprise-shift good subs. Uses the CURRENT reqId
     (never bumps S.subReq), so a language switch mid-flight silently discards the
     stale result. Opt out via hp.subs.cfg.autosync === false. */
  function maybeAutoSync(cand, reqId) {
    if (!S || S.destroyed || reqId !== S.subReq || !cand) return;
    if (!window.SubsAutoSync || !SubsAutoSync.sync) return;   // engine not loaded
    if (subCfg().autosync === false) return;                  // user opted out
    if (S._autoSyncReq === reqId) return;                     // once per selection
    S._autoSyncReq = reqId;
    var mid = subMediaId() || {};
    var ctx = { type: mid.type, id: mid.id, lang: cand.lang };
    if (S.video) { if (S.video.season != null) ctx.season = S.video.season; if (S.video.episode != null) ctx.episode = S.video.episode; }
    ctx.audioSource = subAudioSource();
    try {
      /* Progressive: the engine reports 'quick-synced' (front anchor only) before
         'coherent'. Hotswap on BOTH, so a stream that can only afford one audio
         window still lands a real sync instead of nothing. */
      ctx.onUpdate = function (res) { applyAutoSync(res, reqId, false); };
      Promise.resolve(SubsAutoSync.sync(S.el.video, S.subCand, ctx)).then(function (res) {
        applyAutoSync(res, reqId, true);
      }, function () {});
    } catch (e) {}
  }

  /* Hotswap to a sync result, but ONLY when it is confident — a coherent match or
     a real (>=250ms) measured offset — so we never surprise-shift good subs. */
  function applyAutoSync(res, reqId, isFinal) {
    if (!S || S.destroyed || reqId !== S.subReq) return;     // selection changed — drop
    if (!res || !res.cues || !res.cues.length) return;
    var confident = res.coherent || (typeof res.offsetMs === 'number' && Math.abs(res.offsetMs) >= 250);
    if (!confident) return;                                  // keep the raw available cues
    if (S._autoSyncPhase === 'coherent' && res.phase !== 'coherent') return;  // never regress
    S._autoSyncPhase = res.phase || (isFinal ? 'final' : 'update');
    var arr = res.cues.map(function (c) { return { s: c.start, e: c.end, html: esc(c.text || '').replace(/\n/g, '<br>') }; });
    arr.sort(function (a, b) { return a.s - b.s || a.e - b.e; });
    S.subOffsetMs = 0; installCues(arr, reqId); markSubUI();
    if (res.coherent) toast('Subtitles auto-synced', 1400);
  }

  /* THE AUDIO SOURCE FOR WHISPER — the piece that makes auto-sync work on streams.
     Whisper needs decodable audio, but a full-length torrent or an HLS stream has
     no whole file to decode, and tapping the playing <video> would MUTE the user.
     js/subs-audio-source.js solves it by cutting only the ~20s windows the matcher
     actually listens to, straight out of the byte source:
       - browser torrent -> byte ranges from the WebTorrent file (S.btFile)
       - HLS             -> the segments covering that window, read from hls.js's
                            fragment list WITHOUT disturbing playback
       - direct URL      -> HTTP Range (also lifts the old 80 MB decode ceiling)
     Returns null when nothing is sourceable; auto-sync then no-ops and the raw
     subtitles simply stay on screen, which is always the safe baseline. */
  function subAudioSource() {
    var su = S.stream && S.stream.url;
    if (window.SubsAudioSource && SubsAudioSource.pick) {
      try {
        var p = SubsAudioSource.pick({
          torrentFile: S.btFile || null,
          hls: S.hls || null,
          hlsUrl: S.playUrl && /\.m3u8/i.test(S.playUrl) ? S.playUrl : (su && /\.m3u8/i.test(su) ? su : null),
          url: (su && !/^(magnet:|blob:)/i.test(su)) ? su : null
        });
        if (p) return p;
      } catch (e) {}
    }
    /* fallback: the pre-existing whole-file decode, size-guarded by the engine */
    if (su && !/^(magnet:|blob:)/i.test(su)) return { url: su };
    return null;
  }

  // -- SRT / SSA / VTT -> clean WebVTT, with charset-sniffed byte decoding --
  function subDecode(input) {
    if (typeof input === 'string') return input.replace(/^﻿/, '');
    var b = input;
    if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return subTdec('utf-8', b.subarray(3));
    if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) return subTdec('utf-16le', b.subarray(2));
    if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) return subTdec('utf-16be', b.subarray(2));
    try { if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (e) {}
    return subTdec(subLooksCyrillic(b) ? 'windows-1251' : 'windows-1252', b);
  }
  function subTdec(enc, b) {
    try { if (typeof TextDecoder !== 'undefined') return new TextDecoder(enc).decode(b); } catch (e) {}
    var s = '', i;
    for (i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
  }
  function subLooksCyrillic(b) {
    var hi = 0, n = Math.min(b.length, 4000), i;
    for (i = 0; i < n; i++) if (b[i] >= 0xC0 && b[i] <= 0xFF) hi++;
    return n > 0 && hi > n * 0.15;
  }
  function subsToVtt(input, hint) {
    var text = subDecode(input);
    if (!text) return '';
    text = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
    if (/^\s*WEBVTT/.test(text)) return text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    if (/^\s*\[Script Info\]/i.test(text) || /\n\s*Dialogue:\s/i.test(text)) return ass2vtt(text);
    return srt2vttFull(text);
  }
  var SUB_TS = '(\\d{1,2}:\\d{1,2}:\\d{1,2}[.,]\\d{1,3}|\\d{1,2}:\\d{1,2}[.,]\\d{1,3})';
  var SUB_TS_RE = new RegExp(SUB_TS + '\\s*-->\\s*' + SUB_TS + '([^\\n]*)');
  function subPadTs(ts) {
    ts = ts.replace(',', '.');
    var mmm = '000', main = ts, dot = ts.indexOf('.');
    if (dot >= 0) { main = ts.slice(0, dot); mmm = (ts.slice(dot + 1) + '000').slice(0, 3); }
    var p = main.split(':');
    while (p.length < 3) p.unshift('0');
    return ('00' + p[0]).slice(-2) + ':' + ('00' + p[1]).slice(-2) + ':' + ('00' + p[2]).slice(-2) + '.' + mmm;
  }
  function subCleanText(s) {
    return String(s).replace(/\{\\[^}]*\}/g, '').replace(/<\/?font[^>]*>/gi, '');
  }
  function srt2vttFull(text) {
    var blocks = text.split(/\n{2,}/), out = ['WEBVTT', ''], i;
    for (i = 0; i < blocks.length; i++) {
      var lines = blocks[i].split('\n');
      if (lines.length && /^\d+\s*$/.test(lines[0])) lines.shift();
      if (!lines.length) continue;
      var m = SUB_TS_RE.exec(lines[0]);
      if (!m) continue;
      var body = subCleanText(lines.slice(1).join('\n')).replace(/\s+$/, '');
      if (!body) continue;
      out.push(subPadTs(m[1]) + ' --> ' + subPadTs(m[2]) + (m[3] || ''));
      out.push(body); out.push('');
    }
    return out.length > 2 ? out.join('\n') : '';
  }
  function ass2vtt(text) {
    var lines = text.split('\n'), fmt = null, out = ['WEBVTT', ''], i;
    for (i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (/^\s*Format:/i.test(ln) && /Start/i.test(ln) && /End/i.test(ln)) {
        fmt = ln.replace(/^\s*Format:\s*/i, '').split(',').map(function (x) { return x.trim().toLowerCase(); });
      } else if (/^\s*Dialogue:/i.test(ln) && fmt) {
        var cols = ln.replace(/^\s*Dialogue:\s*/i, '').split(',');
        var si = fmt.indexOf('start'), ei = fmt.indexOf('end');
        if (si < 0 || ei < 0) continue;
        var st = subAssTime(cols[si]), en = subAssTime(cols[ei]);
        if (!st || !en) continue;
        var body = subCleanText(cols.slice(fmt.length - 1).join(',')).replace(/\\N/gi, '\n').replace(/\\h/gi, ' ').replace(/\s+$/, '');
        if (!body) continue;
        out.push(subPadTs(st) + ' --> ' + subPadTs(en)); out.push(body); out.push('');
      }
    }
    return out.length > 2 ? out.join('\n') : '';
  }
  function subAssTime(t) {
    var m = /^(\d+):(\d{2}):(\d{2})[.,](\d{1,3})$/.exec(String(t || '').trim());
    if (!m) return '';
    return m[1] + ':' + m[2] + ':' + m[3] + '.' + (m[4] + '000').slice(0, 3);
  }

  // -------------------------------------------------------------------- close
  function destroy(immediate) {
    if (!S || S.destroyed) return;
    var s = S;
    save();
    s.destroyed = true;

    try { if (document.pictureInPictureElement) document.exitPictureInPicture()['catch'](noop); } catch (e) {}
    try {
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen()['catch'](noop);
      else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
    } catch (e) {}

    if (s.hls) { try { s.hls.destroy(); } catch (e) {} s.hls = null; }

    /* stop the subtitle render loop + clear the overlay */
    s._subLoop = false;
    if (s.subRaf) { try { cancelAnimationFrame(s.subRaf); } catch (e) {} s.subRaf = null; }
    try { if (s.el && s.el.subCue) { s.el.subCue.innerHTML = ''; s.el.subCue._html = ''; } } catch (e) {}

    /* in-browser torrent session: stop the live panel, downloading + free the store */
    if (s.btStallTimer) { try { clearTimeout(s.btStallTimer); } catch (e) {} s.btStallTimer = null; }
    if (s.btPanel) { try { s.btPanel.stop(); } catch (e) {} s.btPanel = null; }
    s.btTorrent = null;
    s.btFile = null;              /* drop the audio-window byte source with the torrent */
    s._autoSyncPhase = null;
    if (s.btIH && window.BT) { try { window.BT.destroy(s.btIH); } catch (e) {} s.btIH = null; }

    var v = s.el.video;
    try {
      v.pause();
      v.removeAttribute('src');
      while (v.firstChild) v.removeChild(v.firstChild);
      v.load();
    } catch (e) {}

    for (var i = 0; i < s.off.length; i++) { try { s.off[i](); } catch (e) {} }
    for (var j = 0; j < s.timers.length; j++) { try { s.timers[j](); } catch (e) {} }
    clearTimeout(s.idle);
    clearTimeout(s.el.toast._t);
    for (var k = 0; k < s.blobs.length; k++) { try { URL.revokeObjectURL(s.blobs[k]); } catch (e) {} }

    s.el.root.classList.remove('plr-in');
    var node = s.el.root;
    if (immediate) { try { node.remove(); } catch (e) {} }
    else setTimeout(function () { try { node.remove(); } catch (e) {} }, 180);
    document.body.style.overflow = s.prevOverflow || '';

    S = null;
    if (s.onClose) { try { s.onClose(); } catch (e) {} }
    if (typeof Player.onclose === 'function') { try { Player.onclose(); } catch (e) {} }
  }

  // ============================================================ inline preview
  /* The focused hover PREVIEW and the larger GLANCE share ONE surface, so at most
     one preview <video> and one Hls instance are ever alive — the leak invariant
     this lane must hold. It is fully independent of the fullscreen session S:
     previews are muted, never touch continue-watching, never grab the global
     keyboard (except Esc while a glance is open), and tear down completely on
     stop. app.js resolves the playable stream (resolver -> addon HLS -> registry
     url) and hands it in; this module only plays and cleans up. */
  /* THE PREVIEW POOL. Up to PV_MAX muted preview <video>s play at once, each
     pinned to its tile and keyed by tile id. POOL is ordered oldest -> newest
     (front = oldest = first evicted). GLANCE stays a SEPARATE singleton (GL) on
     the same .plr-pv-wrap surface. Leak invariant: DOM .plr-pv-wrap video count
     never exceeds POOL.length (<= PV_MAX) + at most one glance. */
  var PV_MAX = 6;
  var POOL = [];        /* [entry] oldest -> newest; each entry pins one tile */
  var GL = null;        /* the glance singleton, independent of the pool */

  /* live counts, for the leak check. Videos are counted from the DOM (the source
     of truth), so a half-torn preview can never inflate the number. */
  function pvStats() {
    var hlsN = 0;
    for (var i = 0; i < POOL.length; i++) if (POOL[i].hls) hlsN++;
    if (GL && GL.hls) hlsN++;
    return {
      videos: document.querySelectorAll('.plr-pv-wrap video').length,
      hls: hlsN,
      pool: POOL.length,
      max: PV_MAX,
      glance: !!GL,
      mode: GL ? 'glance' : (POOL.length ? 'preview' : null)
    };
  }

  /* Idempotent, synchronous teardown of ONE entry. The <video> and Hls die
     IMMEDIATELY (so the live count drops this tick — no transient extra video
     during a fade); the now-empty wrap fades out and is removed a beat later
     purely for looks. Every entry has this explicit destroy path — no orphans. */
  function destroyEntry(p) {
    if (!p || p.destroyed) return;
    p.destroyed = true;
    for (var i = 0; i < p.timers.length; i++) { try { clearTimeout(p.timers[i]); } catch (e) {} }
    if (p.keyH) { try { document.removeEventListener('keydown', p.keyH, true); } catch (e) {} }
    if (p.hls) { try { p.hls.destroy(); } catch (e) {} p.hls = null; }
    if (p.video) {
      var v = p.video; p.video = null;
      try { v.pause(); } catch (e) {}
      try { v.removeAttribute('src'); while (v.firstChild) v.removeChild(v.firstChild); v.load(); } catch (e) {}
      try { v.remove(); } catch (e) {}          /* out of the DOM NOW — count is exact */
    }
    if (p.scrim) { try { p.scrim.classList.remove('plr-pv-in'); } catch (e) {} }
    try { p.wrap.classList.remove('plr-pv-in'); } catch (e) {}
    setTimeout(function () {
      try { if (p.wrap) p.wrap.remove(); } catch (e) {}
      try { if (p.scrim) p.scrim.remove(); } catch (e) {}
    }, 200);
  }

  function poolFind(key) {
    for (var i = 0; i < POOL.length; i++) if (POOL[i].key === key) return i;
    return -1;
  }
  /* tear the WHOLE pool down (view/catalog/search change) */
  function poolClear() { while (POOL.length) destroyEntry(POOL.pop()); }
  /* stop just the glance singleton */
  function glanceStopFn() { if (GL) { var g = GL; GL = null; destroyEntry(g); } }
  /* stop everything: pool + glance (a full open supersedes both) */
  function pvStopAll() { poolClear(); glanceStopFn(); }
  /* the canvas sound toggle: paint one entry's 🔊 state; mute every entry */
  function paintPvMute(p) {
    if (!p || !p.muteBtn || !p.video) return;
    var m = p.video.muted;
    p.muteBtn.innerHTML = m ? ICON.mute : ICON.vol;
    p.muteBtn.title = m ? 'Unmute here' : 'Mute';
    p.muteBtn.setAttribute('aria-label', m ? 'Unmute preview' : 'Mute preview');
    if (p.wrap) p.wrap.classList[m ? 'remove' : 'add']('plr-pv-audible');
  }
  function pvMuteAll() {
    var all = POOL.slice(); if (GL) all.push(GL);
    for (var i = 0; i < all.length; i++) { var q = all[i]; if (q.video && !q.video.muted) { q.video.muted = true; paintPvMute(q); } }
  }

  function positionPv(wrap, mode, rect) {
    var vw = window.innerWidth || document.documentElement.clientWidth;
    var vh = window.innerHeight || document.documentElement.clientHeight;
    if (mode === 'glance') {
      var gw = Math.min(920, Math.round(vw * 0.74));
      var gh = Math.round(gw * 9 / 16);
      if (gh > vh * 0.82) { gh = Math.round(vh * 0.82); gw = Math.round(gh * 16 / 9); }
      wrap.style.width = gw + 'px'; wrap.style.height = gh + 'px';
      wrap.style.left = Math.round((vw - gw) / 2) + 'px';
      wrap.style.top = Math.round((vh - gh) / 2) + 'px';
      return;
    }
    /* preview: a gentle 6% lift off the tile, re-centred on the tile, then clamped
       into the viewport so an edge tile never renders half off-screen. */
    var r = rect || { left: vw / 2 - 150, top: vh / 2 - 84, width: 300, height: 168 };
    var w = Math.max(140, Math.round(r.width));
    var hh = Math.max(90, Math.round(r.height));
    var cx = Math.round(r.left) + w / 2, cy = Math.round(r.top) + hh / 2;
    w = Math.round(w * 1.06); hh = Math.round(hh * 1.06);
    var m = 6;
    var left = Math.max(m, Math.min(vw - w - m, Math.round(cx - w / 2)));
    var top = Math.max(m, Math.min(vh - hh - m, Math.round(cy - hh / 2)));
    wrap.style.width = w + 'px'; wrap.style.height = hh + 'px';
    wrap.style.left = left + 'px'; wrap.style.top = top + 'px';
  }

  /* Build ONE preview/glance entry: wrap + (muted) video + hls, wired and
     playing. Returns the entry; does NOT register it in POOL/GL — the callers
     (poolPromote / openGlance) own that. Every async closure tests the ENTRY's
     OWN destroyed/video, never a shared global, so pooled entries never
     cross-wire and a torn entry can never touch a live one.
     mode: 'preview' | 'glance'. opts: {key?, stream:{url,live?}, rect, poster,
     title, live, reduced, onWatch}. */
  function makeEntry(mode, opts) {
    styleOnce();
    opts = opts || {};
    var stream = opts.stream || {};
    var url = stream.url || '';
    var live = opts.live === true || stream.live === true;
    var reduced = opts.reduced === true ||
      (window.matchMedia && window.matchMedia('(prefers-reduced-motion:reduce)').matches);

    var wrap = h('div', 'plr-pv-wrap' + (mode === 'glance' ? ' plr-pv-glance' : ''));
    wrap.setAttribute('aria-hidden', 'true');       /* decorative echo of the tile */

    var scrim = null;
    if (mode === 'glance') { scrim = h('div', 'plr-pv-scrim'); document.body.appendChild(scrim); }

    if (opts.poster) {
      var poster = h('div', 'plr-pv-poster');
      poster.style.backgroundImage = 'url("' + String(opts.poster).replace(/["\\]/g, '') + '")';
      wrap.appendChild(poster);
    }
    wrap.appendChild(h('div', 'plr-pv-spin'));

    if (live) {
      var tag = h('div', 'plr-pv-tag');
      tag.appendChild(h('span', 'plr-pv-live-chip', '<i class="plr-pv-dot"></i>LIVE'));
      wrap.appendChild(tag);
    }

    var btns = h('div', 'plr-pv-btns');
    var glanceBtn = null;
    if (mode === 'preview') {
      glanceBtn = h('button', 'plr-pv-b plr-pv-glancebtn', ICON.expand);
      glanceBtn.title = 'Glance — a bigger look';
      glanceBtn.setAttribute('aria-label', 'Glance');
      btns.appendChild(glanceBtn);
    }
    var muteBtn = h('button', 'plr-pv-b plr-pv-mute', ICON.mute);
    muteBtn.title = 'Unmute here'; muteBtn.setAttribute('aria-label', 'Unmute preview');
    btns.appendChild(muteBtn);
    var watchBtn = h('button', 'plr-pv-b plr-pv-watch', ICON.play);
    watchBtn.title = 'Watch — full screen with sound';
    watchBtn.setAttribute('aria-label', 'Watch');
    btns.appendChild(watchBtn);
    wrap.appendChild(btns);

    if (mode === 'glance') {
      wrap.appendChild(h('div', 'plr-pv-hint', 'Muted preview · 🔊 sound here · ▶ full screen · Esc to close'));
    }

    var p = { key: (opts.key != null ? opts.key : null), mode: mode, wrap: wrap, scrim: scrim,
              video: null, hls: null, timers: [], destroyed: false, stream: stream,
              poster: opts.poster || '', live: live, reduced: reduced, rect: opts.rect || null,
              onWatch: (typeof opts.onWatch === 'function' ? opts.onWatch : null), keyH: null,
              muteBtn: muteBtn };

    document.body.appendChild(wrap);
    positionPv(wrap, mode, opts.rect);
    void wrap.offsetWidth;
    if (scrim) scrim.classList.add('plr-pv-in');
    wrap.classList.add('plr-pv-in');

    if (glanceBtn) glanceBtn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      openGlance({ stream: stream, poster: opts.poster, live: live,
                   onWatch: opts.onWatch, reduced: reduced, rect: opts.rect });
    });
    muteBtn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      var vv = p.video; if (!vv) return;
      if (vv.muted) { pvMuteAll(); vv.muted = false; }   /* one audible preview at a time */
      else vv.muted = true;
      paintPvMute(p);
    });
    watchBtn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      var ow = p.onWatch;
      pvStopAll();                 /* full play supersedes the whole pool + glance */
      if (ow) { try { ow(); } catch (e2) {} }
    });
    if (mode === 'glance') {
      p.keyH = function (e) { if (e.key === 'Escape') { e.preventDefault(); glanceStopFn(); } };
      document.addEventListener('keydown', p.keyH, true);
      scrim.addEventListener('click', function () { glanceStopFn(); });
    }

    /* prefers-reduced-motion: honour it literally — no autoplaying video at all,
       just the still poster/first frame. Zero video, zero Hls: also zero leak. */
    if (reduced || !url) return p;

    var v = document.createElement('video');
    v.muted = true; v.defaultMuted = true; v.setAttribute('muted', '');
    v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
    v.preload = 'auto'; v.setAttribute('disablepictureinpicture', '');
    if (!live) v.loop = true;                       /* short VOD clip loops; live never */
    p.video = v;
    wrap.insertBefore(v, wrap.firstChild);          /* under the poster until it plays */

    var markPlaying = function () { if (!p.destroyed && p.wrap) p.wrap.classList.add('plr-pv-playing'); };
    v.addEventListener('playing', markPlaying);
    v.addEventListener('loadeddata', function () { if (v.readyState >= 2) markPlaying(); });
    /* a preview error is not worth a dialog — keep the poster, stay silent */
    v.addEventListener('error', function () {});

    var playMuted = function () { var pr = v.play(); if (pr && pr['catch']) pr['catch'](function () {}); };

    if (isHls(url)) {
      if (nativeHls(v)) { v.src = url; playMuted(); return p; }
      loadHls().then(function (Hls) {
        if (p.destroyed || p.video !== v) return;
        if (!Hls.isSupported()) {
          if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = url; playMuted(); }
          return;
        }
        var hls = new Hls(live
          ? { enableWorker: true, lowLatencyMode: true, backBufferLength: 8, liveSyncDurationCount: 3, startPosition: -1 }
          : { enableWorker: true, lowLatencyMode: false, backBufferLength: 30 });
        p.hls = hls;
        hls.on(Hls.Events.ERROR, function (evt, data) {
          if (!data || !data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) { try { hls.startLoad(); return; } catch (e) {} }
          else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { try { hls.recoverMediaError(); return; } catch (e) {} }
          try { hls.destroy(); } catch (e) {} if (!p.destroyed) p.hls = null;   /* give up quietly */
        });
        hls.on(Hls.Events.MANIFEST_PARSED, function () {
          /* pool previews run CHEAP: pin to the lowest-bitrate rendition (full
             quality is reserved for Player.play). Glance keeps ABR for a real look.
             Single-rendition masters (typical CB low-latency) skip this untouched. */
          if (mode === 'preview') {
            try {
              if (hls.levels && hls.levels.length > 1) {
                var lo = 0;
                for (var li = 1; li < hls.levels.length; li++) {
                  if ((hls.levels[li].bitrate || 0) < (hls.levels[lo].bitrate || 0)) lo = li;
                }
                hls.currentLevel = lo;
              }
            } catch (e) {}
          }
          if (live) { try { var lsp = hls.liveSyncPosition; if (isFinite(lsp) && lsp > 0) v.currentTime = lsp; } catch (e) {} }
          playMuted();
        });
        hls.loadSource(url);
        hls.attachMedia(v);
      }, function () {
        if (p.destroyed || p.video !== v) return;
        if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = url; playMuted(); }
      });
    } else {
      v.src = url; playMuted();
    }
    return p;
  }

  /* Promote a tile into the pool. opts.key (tile id) required for pooling.
     Already pooled -> re-mark newest (move to tail) + reposition, NEVER rebuild
     (instant resume, no re-resolve). New -> evict the OLDEST while at capacity
     (so the DOM video count never exceeds PV_MAX even mid-call), then build. */
  function poolPromote(opts) {
    opts = opts || {};
    var key = (opts.key != null ? opts.key : null);
    var idx = key != null ? poolFind(key) : -1;
    if (idx >= 0) {
      var e = POOL.splice(idx, 1)[0];
      POOL.push(e);                                  /* youngest again -> last to evict */
      if (opts.rect) { e.rect = opts.rect; e.wrap.style.display = ''; positionPv(e.wrap, 'preview', opts.rect); }
      return e;
    }
    while (POOL.length >= PV_MAX) { destroyEntry(POOL.shift()); }   /* evict OLDEST first */
    var ne = makeEntry('preview', opts);
    POOL.push(ne);
    return ne;
  }

  /* Open/replace the glance singleton (a bigger centered look), kept SEPARATE
     from the pool so it never evicts a preview and a preview never evicts it. */
  function openGlance(opts) {
    glanceStopFn();
    GL = makeEntry('glance', opts || {});
    return GL;
  }

  /* Reposition ONE pooled preview onto its tile's current rect; rect=null hides
     it (tile off-screen). app.js calls this per key each frame from pinLoop. */
  function previewSetRectFn(key, rect) {
    var i = poolFind(key);
    if (i < 0) return;
    var e = POOL[i];
    if (!e.wrap) return;
    if (rect) { e.wrap.style.display = ''; e.rect = rect; positionPv(e.wrap, 'preview', rect); }
    else { e.wrap.style.display = 'none'; }
  }

  // ---------------------------------------------------------------- public API
  var Player = {
    play: function (opts) {
      opts = opts || {};
      if (!opts.stream) { return null; }
      pvStopAll();           /* full open supersedes the whole preview pool + glance */
      if (S) destroy(true); /* swap without leaving the old overlay on screen */
      try {
        return open(opts);
      } catch (e) {
        try { if (S) destroy(); } catch (e2) {}
        return null;
      }
    },
    close: function () { destroy(); },
    isOpen: function () { return !!S; },
    /* continue-watching helpers, shared with app.js via localStorage key 'cw' */
    cw: cwAll,
    cwGet: cwGet,
    cwDrop: cwDrop,
    engineUp: engineUp,
    magnetOf: magnetOf,
    /* inline preview POOL / glance — up to PV_MAX (6) muted preview <video>s over
       the wall, each pinned to a tile by key; glance is a SEPARATE singleton.
         Player.preview({key, stream:{url,live?}, rect, poster, live, onWatch})
                          — promote a tile: create, or (if already pooled) re-mark
                            newest + reposition WITHOUT rebuilding (instant resume)
         Player.previewSetRect(key, rect)   — pin one pooled tile (rect=null hides)
         Player.previewStop([key])          — no arg: tear the WHOLE pool down;
                                              key: evict just that one tile
         Player.previewHas(key)             — is this tile a live pool video?
         Player.previewKeys()               — the live pool keys, oldest -> newest
         Player.glance({stream, poster, live, onWatch})
         Player.glanceStop()                — close the glance only
       inlineStats() reports the live video + Hls + pool count for the leak check. */
    preview: function (opts) { try { return poolPromote(opts || {}); } catch (e) { return null; } },
    previewStop: function (key) {
      try {
        if (key == null) { poolClear(); return; }          /* no arg -> whole pool */
        var i = poolFind(key); if (i >= 0) destroyEntry(POOL.splice(i, 1)[0]);
      } catch (e) {}
    },
    previewSetRect: previewSetRectFn,
    previewHas: function (key) { try { return poolFind(key) >= 0; } catch (e) { return false; } },
    previewKeys: function () { try { return POOL.map(function (e) { return e.key; }); } catch (e) { return []; } },
    glance: function (opts) { try { return openGlance(opts || {}); } catch (e) { return null; } },
    glanceStop: glanceStopFn,
    isInline: function () { return POOL.length > 0 || !!GL; },
    inlineStats: pvStats,
    onclose: null,
    version: '1.1.0'
  };

  window.Player = Player;
})(window, document);
