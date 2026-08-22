# verified_sources.md — the honest registry

The app watches this file live: add a row below, save, and the source appears in the
running app within ~3 seconds — no reload. Delete a row and it leaves. The app NEVER
writes this file; it is yours.

NEW - integrate fully so its ready now (rev up): (needs integration, full catalog, search, filters, categories, flexible views) 
- stremio://chaturbate.stremio.homes/f/manifest.json
- https://torrentio.strem.fun

**Row format** (markdown table, one source per row):

- **Title** — display name.
- **Lane** — `ai-generated` (no human performed) · `performer-verified` (consent,
  fair pay, pull-anytime) · `demo` (SFW test source).
- **URL** — direct `.mp4` file or `.m3u8` HLS stream (streaming supported; HLS
  streams need CORS headers on their host — see ORACLE.md playbooks).
- **Poster** — optional image URL; blank is fine.
- **Notes** — optional; the word `live` marks a live stream.

All seed rows below are SFW public test videos — placeholders proving each lane's
badge and the live-watch loop. Real sources are curated locally and never committed.

| Title | Lane | URL | Poster | Notes |
|---|---|---|---|---|
| Big Buck Bunny | demo | https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_5MB.mp4 | https://picsum.photos/seed/hp-bbb/480/720 | mp4 placeholder |
| Sintel 10s | ai-generated | https://test-videos.co.uk/vids/sintel/mp4/h264/720/Sintel_720_10s_5MB.mp4 | https://picsum.photos/seed/hp-sintel/480/720 | SFW placeholder in the AI lane |
| Sintel Trailer | performer-verified | https://media.w3.org/2010/05/sintel/trailer.mp4 | https://picsum.photos/seed/hp-trailer/480/720 | SFW placeholder in the verified lane |
| Jellyfish | performer-verified | https://test-videos.co.uk/vids/jellyfish/mp4/h264/720/Jellyfish_720_10s_5MB.mp4 | https://picsum.photos/seed/hp-jelly/480/720 | SFW placeholder in the verified lane |
| Mux HLS test stream | demo | https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8 |  | HLS streaming |
| Mux HLS (pts-shift) | demo | https://test-streams.mux.dev/pts_shift/master.m3u8 |  | live HLS streaming |
| Sintel (torrent — no server) | demo | magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fsintel.torrent | https://picsum.photos/seed/hp-torrent/480/720 | web-seeded magnet: plays fully in-browser via window.BT (ws=/xs=), zero servers |
| PERF PROBE SW 2 | demo | https://test-videos.co.uk/vids/sintel/mp4/h264/720/Sintel_720_10s_5MB.mp4 | SFW perf probe row 2 |
