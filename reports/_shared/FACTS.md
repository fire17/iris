# GROUNDED FACTS — honestporn browser-only mission close-out
# Every number below was READ from a real repo file. Use these VERBATIM.
# Do NOT invent any figure. If you need a number not here, mark it UNVERIFIED.
# Repo root: /Users/magic/Creations/cooliris/honestporn (worktree agent-ad72ed97c844bd02f)
# Date of mission work: 2026-08-21. All media force-muted in every headless proof.

## THE LAW (fire17, verbatim, non-negotiable)
Any node we run may relay handshakes/signaling ONLY. It must NEVER carry file bytes.
Files flow peer→browser directly, or not through us. A bridge/proxy that re-serves
torrent bytes to the browser VIOLATES the law and is a FAILED result — even if it "works".

=====================================================================
## LANE 1 — LAW-COMPLIANT DIRECT-P2P BROWSER TORRENT (torrent-p2p.html)
=====================================================================

### The compliant shape (proven, byte-level, committed evidence)
Proof: test/relay-punch/prove-rtc-killb.mjs → evidence .grand/reports/relay-punch-evidence/rtc-timeline.json
Topology: A (browser, leech) <-> C (browser, WebRTC seed holding the clip) <-> B (server/relay/signal.mjs, pure SDP/ICE relay).
signal.mjs is ~40 lines over the `ws` package; carries NO media bytes; forwards SDP offer/answer + ICE only.

rtc-timeline.json EXACT values:
- clipSize: 68086404 bytes (a WebM clip)
- signal: ws://127.0.0.1:57485
- Timeline events (t = ms):
    t=273  DC-OPEN (A<->C direct wire established via B), bytesRecv:0
    t=276  B-process-exit
    t=430  B-KILLED  pid 18279  alive:false  ps:"NO_SUCH_PROCESS"  bytesRecvAtKill:0
    t=833  signal-sockets-after-kill  A_signalClosed:true  C_signalClosed:true  A_connState:"connected"
    t=4598 A-final  bytesRecv:68086404  total:68086404  progress:1  connState:"connected"  videoTime:4.28  bDeadStill:true
- atKill: bytesRecv 0 / 68086404 (0.0%)  <-- node B carried ZERO file bytes at the moment of kill
- finalA: bytesRecv 68086404 / 68086404 => 100.0%, progress 1, done true, videoTime 4.28s, muted true, error null
- PASS: true
Quote from TRANSPORT-LAW-VERDICT.md §3 (live rerun 2026-08-21):
  bytesRecv at B-kill : 0 / 68086404 ( 0.0% — should be ~0)   <-- node carried ZERO file bytes
  bytesRecv final     : 68086404 / 68086404 => 100.0%
  video currentTime   : 5.21 s (played with B dead)     [NOTE: verdict text quotes 5.21s; rtc-timeline.json final sample videoTime is 4.28s — both are the same run family; use 4.28s from the committed JSON as the authoritative figure and you may mention the verdict's 5.21s as the verdict-doc quote.]

### Self-sustaining swarm proof (committed)
Proof: test/relay-punch/prove-selfsustain.mjs → .grand/reports/relay-punch-evidence/selfsustain-timeline.json
- Same 68086404-byte clip over a local wss tracker (B). C seeds; A gets a full copy; A2 is a
  second fresh leech. B (tracker) SIGKILLed + C closed at progress 0.08735, then A2 finishes
  from A alone (A becomes the only seeder).
- atCut: progress 0.08735, wires 2, downloaded 5947392
- a2final: progress 1, downloaded 68086404, done true, videoTime 0.12, uploaded 92713
- timeline: B-KILLED+C-CLOSED at t=19778 (progressAtCut 0.08735); A2-final t=34527 progress 1 downloaded 68086404;
  A-as-only-seeder uploaded 65405056, wires 2
- PASS: true
- Meaning: once one browser holds the bytes, the swarm survives with NO tracker and NO original seeder — pure browser-to-browser.

### The wss-tracker variant + zero-byte frame accounting (harness present)
Proof: test/relay-punch/prove-wss-killb.mjs; relay node = server/relay/wss-broker.mjs (B).
B writes frame-classification counters to test/relay-punch/.relay-stats.json on EVERY frame (survive SIGKILL).
The harness ASSERTS (its verdict checks, verbatim from the script):
  - 'relay B forwarded ZERO file bytes'   => R.fileBytes === 0 && R.binaryFrames === 0 && R.suspectFrames === 0
  - 'relay B did relay signaling (frames > 0)'
  - 'relay signaling bytes << file bytes' => R.signalingBytes < LENGTH*0.05
  - 'sha256(received) == sha256(source)'  => integrity check
  - prints RELAY_FILE_BYTES=<n> (MUST be 0), P2P_BYTES_DIRECT=<downloaded>
  - ONE CHROMIUM PER PEER (separate OPFS origins) so seed+leech can't read each other off disk (avoids false pass).
HONEST STATUS: the script + its assertion battery are committed; a captured stdout log of a
  wss-killb run is NOT committed to the repo. Mark RELAY_FILE_BYTES=0 for THIS variant as
  "asserted by the committed harness; captured run-output not committed" — UNVERIFIED-in-this-report.
  The byte-level ZERO is committed & verified for the SDP-relay variant via rtc-timeline.json (above).

### Self-seed / no-backend playback proof (harness present)
Proof: tools/proof/self-seed-proof.mjs. Builds a .torrent for the catalog's Big Buck Bunny mp4 with
  url-list -> a static URL on the SAME host serving the app (plain files + HTTP Range 206), magnet
  ws=+xs= with ZERO trackers, plays through the REAL Player headless. Pass string: SELF-SEED-PROOF-PASS
  t=<s> <w>x<h> src=…/webtorrent/<infohash>/… . HONEST: harness committed; captured PASS stdout not
  committed to repo — mark "harness present, author-run; captured output not committed" UNVERIFIED-in-report.
Also tools/proof/panel-proof.mjs, app-proof.mjs, bt-play-proof.mjs, bt-diag.mjs — proof harnesses (README tools/proof/README.md).

### The browser transport ceiling (why arbitrary Torrentio magnets can't play — see also physics verdict)
From js/torrent.js header comment (verbatim): a browser can only reach WebRTC "web peers" (via wss://
trackers) and HTTP web-seeds (BEP19, magnet ws= or the .torrent url-list). It CANNOT open TCP/uTP peers
or use the DHT. Torrentio magnets (infoHash + udp/dht only, no wss, no web-seed) have ZERO browser-reachable
sources and can never play in-browser; they still need the node engine on :11470 (full TCP+DHT).
WebTorrent bundle = 3.0.21 (browser build), vendored.
Metadata-stall fix: when the magnet carries xs=<.torrent url> (the app's own catalog magnets always do),
  fetch the .torrent in-browser and add the BYTES → metadata instant, web-seed supplies pieces, no tracker/peer needed.
Playback bridge: WebTorrent 3.x removed getBlobURL; file.streamTo() needs the service-worker bridge
  (client.createServer({controller})); ensureServer() registers /sw.min.js (vendored, root scope).
canPlay(magnet) returns true only if magnet has ws= OR xs=http OR tr=wss (js/torrent.js:116).

### Honest copy-magnet fallback (shipped)
js/app.js ~1937-1966: torrent stream rows get a "📋 magnet" copy control (a <span>, not nested button).
copyMagnet(mag) uses navigator.clipboard.writeText with a legacyCopy fallback + toast. This is the
honest escape hatch for TCP-only magnets the browser cannot play: hand the user the magnet for their
own client, never route bytes through us.

### The FORBIDDEN thing we must NOT celebrate (honesty)
server/relay/hybrid-seed.mjs (node "C") joins the classic swarm over TCP/uTP/DHT, downloads bytes it did
not hold, and re-serves them to the browser over WebRTC. On the real YTS Spider-Man magnet it held 0 bytes
up front, leeched 99,532,800 B live from 2 classic peers, forwarded them to the browser
(.grand/reports/relay-punch-evidence/torrentio-video-real-timeline.json). Its own comment says it
"re-seeds those exact pieces to browser A". That is a byte-path relay = FORBIDDEN by the law. The prior
prove-torrentio-video.mjs "worked" but by routing file bytes through a we-run node = a FAILED result
mislabeled as a pass. torrentio-video-real-timeline.json: torrentLengthBytes 1427353597, C leeched
99532800 (bounded), kill_B gainedStrictlyAfterBdeadBytes 78233600 (transport persisted past B death),
videoTime 0 (a non-fragmented 1.43GB mp4 can't progressively play in-browser). transportPass true,
playbackAdvanced false. => Report this as the boundary that PROVES the law bites: the bridge is a
law-violation, NOT a browser-first win. Honesty is the aesthetic.

=====================================================================
## LANE 3 — PHYSICS VERDICT: arbitrary TCP-only P2P is IMPOSSIBLE (physics-verdict.html)
=====================================================================
Source: test/novel-path/VERDICT.md + test/TRANSPORT-LAW-VERDICT.md + test/novel-path/PROOF-OUTPUT.txt
Target: Spider-Man: No Way Home (YTS) 2021 720p, infohash a648d96d5b4a163f72edc3574a6370bc41d062d0,
IMDB tt10872600. TCP/uTP swarm, no web-seed, no WSS tracker.

VERDICT: IMPOSSIBLE (for arbitrary TCP-only content the user does not already have). A proof, not a hedge.

### The mechanism (why it cannot work) — 4 transports table
A browser obtains bytes over exactly FOUR transports; there is no fifth (Direct Sockets = IWA/ChromeOS only):
| Browser can open | Mandatory handshake far side MUST perform | Raw TCP/uTP BT peer performs it? |
| WebRTC DataChannel | ICE (STUN) → DTLS → SCTP | NO |
| WebSocket | HTTP/1.1 Upgrade: websocket | NO |
| WebTransport | HTTP/3 = QUIC + TLS 1.3 | NO |
| HTTP fetch/range | HTTP request/response (+CORS) | NO |
A raw BitTorrent peer answers TCP connect with the 19-byte \x13BitTorrent protocol handshake, or uTP
(UDP+LEDBAT). It performs NONE of the four. A signaling relay changes introductions, not the wire protocol.
The only ICE path to a non-STUN host is TURN — which relays media bytes = byte-path node = FORBIDDEN.

### The bootstrap paradox
To seed over WebRTC a browser must FIRST possess the bytes. For content living only in a TCP/uTP swarm,
the genesis browser could only have gotten it from a byte-path node — violating the law even once. No
byte-path node ⇒ no genesis seeder ⇒ no browser WebRTC swarm ever forms.

### The ONE compliant browser-P2P mode (sharp boundary)
If the user ALREADY has the file locally (File System Access / drag-drop), the browser seeds it to other
browsers over WebRTC, zero node in byte path — genuinely law-compliant. But it requires already possessing
the content, so it does NOT play an arbitrary magnet the user lacks.

### Measured evidence (test/novel-path/PROOF-OUTPUT.txt + proof-measure.mjs) — EXACT
TCP/uTP swarm alive: true.
- udp://tracker.opentrackr.org:1337/announce → seeders 54, leechers 301
- udp://open.demonii.com:1337/announce → seeders 3, leechers 204
- tcpPeersHandedOut: 76, maxSeeders 54
Browser-reachable WebRTC seeders: 0 (target realWebrtcSignals 0 vs random-control 0 — equal near-zero = none real).
  wss trackers probed: tracker.openwebtorrent.com (complete 0, incomplete 1, signals 0), tracker.webtorrent.dev
  (complete 0, incomplete 1, signals 0), tracker.files.fm:7073 (ok false).
- DHT lookup found 212 peers; only 1/40 completed a raw-TCP BitTorrent handshake (VERDICT.md) — and a
  browser can speak none of TCP/uTP regardless.
CONCLUSION line (verbatim): content is fully seeded to non-browsers, and ZERO peers the browser can P2P
  with. No node-we-run carried any file byte in this test.

### Fleet verification (5 Opus-5 workflows, ~55 agents) — dead-end tally
Tally across all fleet results: 38 DEAD-END vs 7 BYPASS-POSSIBLE — and every BYPASS-POSSIBLE is one of the
two documented boundaries (user-brings-bytes File API seeding; third-party HTTP mirror). No genuine bypass.
Highlights (all with observed output):
- Direct Sockets (raw TCP from browser): plain https page → TCPSocket/UDPSocket/TCPServerSocket all undefined
  on Chrome 151.0.7922.170. Force-exposed via --enable-features=DirectSockets,IsolatedWebApps → constructors
  appear but first socket.opened kills the renderer: "Frame is not sufficiently isolated to use Direct Sockets"
  (bad_message reason 123), zero bytes flowed. IWAs install only on Chrome-Enterprise-managed ChromeOS.
- WebTransport/RTCQuicTransport: page dialed new WebTransport(...,{serverCertificateHashes}) at a dual
  TCP+UDP listener → browser emitted only QUIC-v1 UDP Initial packets, zero bytes on the TCP socket. Dead-end.
- IPFS/Helia: live bitswap-only pulled real blocks peer→browser over webrtc-direct, 119,776 bytes in 6.3s,
  zero bytes through any node we run — transport half is genuinely law-clean. BUT arbitrary movies are not on
  IPFS (no name→CID index, no infohash→CID mapping, real providers are pinning SERVERS = byte-path). Dead-end
  for arbitrary movies. Trap: default createHelia silently adds trustless-gateway.link/4everland.io HTTP block
  brokers (law-violating byte path unless explicitly disabled).
- Browser-as-WebRTC-DHT-node: libtorrent hybrid peers exchange WebRTC offers ONLY over WebSocket trackers
  (rtc_offer grep: dht_tracker.cpp 0, ut_pex.cpp 0, websocket_tracker_connection.cpp 4). Real magnets carry no
  wss rendezvous (torrentio sample: 0 wss trackers of 25). Dead-end.
- HTTP third-party mirror: <video src=https://mirror/file.mp4> flows mirror→browser, zero node we run =
  LAW-COMPLIANT but does not generalize (4 gates G1 exists-on-plain-mirror, G2 range+hotlink, G3 CORS, G4
  container/codec: MKV isTypeSupported false, AC3/E-AC3/DTS canPlayType '' in Chrome). Repo-accuracy finding:
  the app's own "Sintel (torrent — no server)" row is NOT P2P — it's an HTTP web seed at webtorrent.io
  (Sintel.mp4, access-control-allow-origin:*, HTTP 206).
- Public bridges: webtor.io = server pods join swarm, ffmpeg→HLS, CDN serves bytes (bytePathThroughNode:true).
  instant.io/btorrent.xyz = architecturally law-clean (wss signaling, STUN only, no TURN) but cannot play an
  arbitrary TCP-only magnet; live announce of the exact Spider-Man infohash returned complete:0, zero peer offers.
  Debrid = obvious byte carrier.

### Watch-list (tech that WOULD change the verdict)
- qBittorrent 5.3 (WebTorrent enabled in CI, PR #24564; ~late 2026) — first mainstream desktop seeders speaking
  WebRTC. Then libtorrent 2.1.x adoption (2.1.0 shipped 2026-07-09 with TORRENT_USE_RTC). Real gate after: a
  SOCIAL one — public trackers adding a wss endpoint to standard magnet tracker lists (today 0 of 25).
- Direct Sockets API for regular web pages (today IWA/ChromeOS-only, not planned for open web) — biggest lever.
- libtorrent WebTorrent-protocol becoming default in mainstream clients — would populate swarms with
  WebRTC-capable seeders. Currently not default; measured reach ≈ 0 for this content.

=====================================================================
## LANE 2 — BROWSER-ONLY STANDARD LIVE SUBTITLES (subtitles.html) — [I author this]
=====================================================================
Source: js/player.js. window.SubsSource.list. Baseline "known highest standard, fully featured" system.
- Sources merged & deduped, grouped by language: subs already on the stream/meta + every installed Stremio
  addon declaring the `subtitles` resource + the public OpenSubtitles v3 addon
  (SUB_DEFAULT_BASE = https://opensubtitles-v3.strem.io, CORS-open, "verified live").
- subSourceList(type,id,extra): GETs <base>/subtitles/<type>/<id>[/extra].json → {subtitles:[{id,url,lang}]}.
  8s timeout, cache force-cache. Series compose id as imdb:season:ep (subMediaId).
- Render: native WebVTT parser fills a hidden <track>; cues copied once and painted into our own overlay
  (S.el.subCue) → full control of size/colour/background/vertical position + live manual sync offset,
  identical across browsers. window.__subsRendererPresent=true tells autosync lane not to self-attach.
- Formats: subsToVtt() decodes bytes with charset sniffing (BOM utf-8/utf-16le/utf-16be, else TextDecoder
  utf-8 fatal, else windows-1251 if Cyrillic-looking else windows-1252) and converts SRT / SSA(ASS) / VTT →
  clean WebVTT. srt2vttFull + ass2vtt (parses [Script Info]/Dialogue:), subPadTs normalises timestamps.
- Language picker (rebuildSubMenu): "Off" + one row per language, English first then alphabetical, count
  badge when >1 candidate; Sync-offset row: −250 −50 [0 ms] +50 +250.
- Persist: localStorage key hp.subs.cfg, shape {mode:'off'|'lang',lang,size,color,bg,pos}. Last-used
  off|language auto-applied on open; styling persists. Merge-safe & shared with the subs-autosync lane
  (SubsAutoSync.config get/set if present).
HONEST GAP: SubsAutoSync (the whisper coherence / auto-sync engine from GOAL-subtitles.md) is NOT present as
  shipped JS — player.js only capability-detects it (window.SubsAutoSync guarded, __subsRendererPresent hook).
  So the SHIPPED, live deliverable is the standard fully-featured baseline subtitles system; the whisper
  auto-sync engine is designed-for / interop-ready but not in the shipped js. Report this plainly.

## VERIFICATION POSTURE (apply to every page)
- GREEN / committed & byte-level verified: rtc-timeline.json (0 bytes at kill → 68086404 final),
  selfsustain-timeline.json, PROOF-OUTPUT.txt swarm numbers, the js source behaviour (subtitles, torrent
  ceiling, copy-magnet).
- BLUE / harness present, author-run, captured stdout NOT committed: self-seed-proof PASS string,
  wss-killb RELAY_FILE_BYTES=0. Mark these UNVERIFIED-in-this-report explicitly.
- The mission did NOT publish/push anything. Nothing left the machine.
