# The hosted runner-engine (TRACK A) — experimental, at-own-risk

Make Torrentio-class magnets play on the **live https site** by running the existing
`engine.mjs` on a public runner and reaching it from the browser over https — without the
browser ever touching a torrent (it can't: no TCP/uTP/DHT).

```
browser (https)  ──HTTP Range / HLS──▶  cloudflared quick-tunnel  ──▶  engine.mjs (INMEM, RAM only)
      ▲                                                                        │  webtorrent TCP+DHT
      └────── discovers the runner URL on the floor (handshake only) ──────────┘  ffmpeg → AAC/HLS
                         (public MQTT-over-WSS, AES-GCM sealed)
```

The floor carries ONLY the runner's URL. **Media bytes never cross the floor** — they flow
`browser ⇄ cloudflared ⇄ runner` over https. This honors the standing law: *the node relays
the handshake, never the bytes.*

## The AUP reality (read this)

Serving media from GitHub Actions runners **violates GitHub's Acceptable Use Policy** —
Actions is CI/CD, not a streaming/media service. Repeated pool runs can get the repo or
account flagged and Actions disabled. This path is therefore:

- **OPT-IN** — the browser only uses it behind `localStorage['hp.torrent.runnerEngine']='1'`
  (default OFF, mirrors the existing `hp.torrent.localEngine`).
- **In-memory** — no data at rest (`HP_INMEM=1`: torrent store in RAM, HLS on `/dev/shm`).
- **Low-footprint** — `POOL=2`, per-file size cap, new-add rate limit.
- **Short-lived / rotating** — runs self-terminate at `RUN_SECONDS`.

It is a **knowing tradeoff, not a solved problem.** Do not enable the workflow on a
repo/account you are unwilling to risk.

## In-memory footprint

- Torrent data → `memory-chunk-store` (webtorrent's own dep). It **never evicts**, so a
  fully-watched file ends up entirely in RAM. Guards:
  - `HP_MAX_BYTES` (default 6 GiB; workflow sets 4 GiB) → `/play` and `/stream` refuse a
    bigger file with **413** so a ~16 GiB runner never OOMs.
  - `HP_MAX_TORRENTS` (default 2) → an LRU `client.remove(old,{destroyStore:true})` frees
    the RAM of the oldest torrent when a new infoHash is added.
  - a token bucket (~1 new add / 2 s) blunts abusive bursts (429 when exhausted).
  - the engine already `select()`s only the streamed file and `deselect()`s the rest.
- HLS segments → `/dev/shm/hp-hls` (tmpfs = RAM, **zero disk-at-rest**), with a **bounded
  sliding window** (`-hls_list_size N -hls_flags delete_segments`) so RAM ≈ `HLS_WINDOW`×
  segsize (~6 × 4 s). If `/dev/shm` is absent (macOS/dev) it falls back to a bounded
  `.cache/hls`. **Tradeoff:** seeking *backward past the window* re-transcodes from 0 — fine
  for forward playback, a stall for hard back-scrubbing. This applies to `INMEM` only;
  localhost keeps the unbounded `event` playlist (seek anywhere).

Fully-pipe-only HLS (no segment files) is impractical: fMP4 segments must be individually
URL-addressable and the player seeks. `/dev/shm` tmpfs is the honest "in-memory, no disk"
answer with zero change to the `/hls` read route.

## Run it locally (the sim)

```bash
# 1) in-memory engine only
HP_INMEM=1 PORT=11480 node server/engine.mjs
curl -s localhost:11480/status                                   # {ok:true}
curl -s localhost:11480/play/08ada5a7a6183aae1e09d831df6748d566095a10 | jq   # kind:"url", Sintel.mp4
curl -sI -r 0-1023 localhost:11480/stream/<ih>/<idx>            # 206 + Content-Range
# zero disk-at-rest: no server/.cache dir is created in INMEM mode.

# 2) full bootstrap: engine + cloudflared tunnel + floor announce
HP_ROOM=hp-sim-$RANDOM node server/runner.mjs                    # prints RUNNER_URL=… then RUNNER_READY
curl -s <RUNNER_URL>/status                                      # {ok:true} through the public https tunnel

# 3) discovery round-trip (another shell, same room)
node -e '<join the floor via vendor/hp-floor.mjs, send {t:"who"}, expect {t:"runner",url}>'
```

`SKIP_PUBLIC_HEALTHCHECK=1` lets step 2 announce even when *this box* cannot resolve the
`*.trycloudflare.com` wildcard (e.g. Tailscale MagicDNS returns NXDOMAIN) — the tunnel is
still live; only the runner's self-check is blocked. Real GHA runners resolve normally.

## The pool (`.github/workflows/runner-engine.yml`)

relay-baton's admission-gated pool, adapted: `workflow_dispatch` + `cron */5`, `POOL=2`
overlapping ~55 min runs staggered ~`STAGGER` apart, the gate counting `in_progress` runs
with the **read-only** `GITHUB_TOKEN` (no PAT). Each run installs cloudflared, `npm ci`s the
engine, and runs `node server/runner.mjs` with `HP_INMEM=1`. **Not committed/pushed by the
build pass — delivered as a file only. Enabling it is a human decision (see AUP above).**

## Verification status (honest)

**Verified locally this session:**
- INMEM engine: `/status` ok, `/play` → `kind:'url'` Sintel.mp4, `/stream` **206 Range** with
  valid ISO-MP4 bytes, **zero `.cache`** created. Direct-play NOT broken.
- Size cap: a 129 MB file with `HP_MAX_BYTES=1 MiB` → **413** JSON.
- Floor round-trip over the real public brokers: announce → discover **3/3 PASS**, ~2 s.
- Full bootstrap: `runner.mjs` → real cloudflared tunnel → `RUNNER_READY`; a discover client
  found the **exact** announced `trycloudflare.com` URL over the floor.
- Public path: through the Cloudflare edge, `GET <tunnel>/status` → `{ok:true}` **HTTP/2 200**
  with `access-control-allow-origin: *` (proved via a DNS-pinned `curl --resolve`, because
  this box's Tailscale resolver NXDOMAINs the wildcard).

**NOT yet live-verified (needs real infra):**
- The GHA pool actually running on Actions (no dispatch performed — leaves the machine).
- A real browser on `https://iris.akeyo.io` discovering a runner and playing a Torrentio
  title end-to-end (HLS/mp4) with no mixed-content error.
- Sustained multi-client 1080p through a free quick-tunnel (rate-limited/best-effort; not
  throughput-tested) and the RAM/OOM behavior under concurrent streams (not load-tested).

## Fork it — run your own baton servers (zero config)

The client and the baton server live in ONE repo on purpose: a fork is self-contained.

1. **Fork** this repo on GitHub.
2. **Enable Actions** on your fork (Actions tab → enable workflows). The `runner-engine`
   workflow's cron keeps a small pool of runners warm; `Run workflow` starts one now.
3. **Enable Pages** (Settings → Pages → deploy from branch, `main` root). Delete the
   `CNAME` file (it pins the official custom domain) — your site serves at
   `https://<you>.github.io/<repo>/`.

That's it. No tokens, no secrets, no config: both sides derive a **per-repo floor room**
from the repo's identity (server: `GITHUB_REPOSITORY`; client: the `github.io` hostname),
so your deployed client automatically discovers your fork's own runners — never the
official pool, never another fork's. A fork behind a custom domain sets
`window.HP_REPO = "you/repo"` before `js/torrent-runner.js` loads (one line).

**Trust model (keyless by design — no secrets stored in any repo):** nothing is signed
and nothing is pinned. The client accepts an announced URL only if it is a
`https://*.trycloudflare.com` origin, the announce is fresh, and the URL's `/status`
answers `ok` while echoing a `repo` equal to the client's own derived repo (the engine
reads `GITHUB_REPOSITORY`, a plain env var). Honest limit: with no secret anywhere, a
determined attacker who derives your room name can stand up a hostile tunnel that fakes
the echo — this design confines accidents and cross-fork mixups, not a targeted spoof.
That is the tradeoff "no tokens, no secrets" buys; streams are TLS-end-to-end either way.

Same AUP warning as above applies to YOUR fork and YOUR account.
