/* engine.mjs — optional local streaming engine for CoolStremio.
 *
 * Generic infrastructure: it streams whatever infoHash it is handed, over HTTP,
 * with range support so a browser <video> can seek. It bundles NO content
 * sources, no indexers and no trackers of its own — peers come only from the
 * magnet the caller supplies plus webtorrent's built-in DHT/defaults.
 *
 * The app works fully without this process running; player.js probes /status
 * with a 1s timeout and falls back to a copyable magnet link when nothing
 * answers.
 *
 *   cd server && npm i && node engine.mjs
 *
 * Routes (all send Access-Control-Allow-Origin: *):
 *   GET    /status                     -> {ok,engine,torrents}
 *   GET    /torrents                   -> [{infoHash,name,progress,peers,...}]
 *   GET    /stream/<infoHash>[/<idx>]  -> 200/206 byte stream of one file
 *   DELETE /torrent/<infoHash>         -> remove from the client + destroy its store
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebTorrent from 'webtorrent';
import MemoryChunkStore from 'memory-chunk-store';
import { spawn, execFile } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, '.cache');
const HOST = process.env.HOST || '127.0.0.1';
// Stremio Desktop also listens on 11470; PORT lets you dodge that collision.
const PORT = Number(process.env.PORT) || 11470;
/* Runner mode (HP_INMEM=1): pure-RAM, ZERO disk-at-rest — for the hosted GHA runner.
   Torrent data → memory-chunk-store (RAM); HLS segments → /dev/shm tmpfs (RAM-backed)
   with a bounded sliding window. Localhost (HP_INMEM unset) keeps the disk cache. */
const INMEM = process.env.HP_INMEM === '1';
const HLS_WINDOW = Number(process.env.HLS_WINDOW) || 20;             // .m4s segments kept in RAM when INMEM (wider = more seek-back)
const HP_MAX_BYTES = Number(process.env.HP_MAX_BYTES) || 6 * 1024 * 1024 * 1024;  // refuse a file bigger than this (OOM guard)
const MAX_TORRENTS = Number(process.env.HP_MAX_TORRENTS) || 4;       // LRU: evict oldest IDLE torrent+RAM store past this
const METADATA_TIMEOUT = 30000;
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
/* Browsers decode H.264/HEVC video fine but have NO decoder for Dolby (AC-3/E-AC-3), DTS or
   TrueHD audio — a DDP5.1 MKV plays as a silent movie. Those files are transcoded on the
   fly (audio → AAC stereo, video copied) into fMP4 HLS segments under .cache/hls/. */
const DIRECT_EXT = new Set(['mp4', 'm4v', 'webm']);   // served as-is with Range
const BROWSER_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

const VIDEO_EXT = new Set([
  'mp4', 'mkv', 'avi', 'webm', 'mov', 'm4v', 'mpg', 'mpeg',
  'wmv', 'flv', 'ts', 'm2ts', 'ogv', '3gp'
]);

const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
  mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo',
  ogv: 'video/ogg', ts: 'video/mp2t', m2ts: 'video/mp2t',
  mpg: 'video/mpeg', mpeg: 'video/mpeg', wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac',
  flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus', wav: 'audio/wav',
  srt: 'application/x-subrip', vtt: 'text/vtt', ass: 'text/plain',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  m3u8: 'application/vnd.apple.mpegurl'
};

const extOf = (name) => (name.split('.').pop() || '').toLowerCase();
const mimeOf = (name) => MIME[extOf(name)] || 'application/octet-stream';
const isVideo = (file) => VIDEO_EXT.has(extOf(file.name));

// ---------------------------------------------------------------- client --

const client = new WebTorrent();
// A torrent-level failure (bad magnet, dead swarm) must never kill the engine.
client.on('error', (err) => console.error('[client]', err?.message || err));

/** infoHash -> Promise<Torrent>, so N concurrent requests add the torrent once. */
const adding = new Map();

/** INMEM only: bound how many torrents (and their RAM stores) stay resident, oldest-out. */
const lru = [];
const active = new Map();   // infoHash -> live stream count; an active torrent is NEVER evicted
function evictLRU(next) {
  const i = lru.indexOf(next);
  if (i >= 0) lru.splice(i, 1);
  lru.push(next);
  if (lru.length <= MAX_TORRENTS) return;
  // evict OLDEST IDLE torrents only — never `next`, never one a viewer is streaming.
  for (let k = 0; lru.length > MAX_TORRENTS && k < lru.length; ) {
    const old = lru[k];
    if (old === next || (active.get(old) || 0) > 0) { k++; continue; }
    lru.splice(k, 1);
    stopJobs(old);
    try { client.remove(old, { destroyStore: true }, () => {}); } catch { /* gone */ }
  }
}

/** Token bucket: blunt abusive bursts of NEW torrent adds (INMEM/runner only). */
const bucket = { tokens: 3, at: Date.now() };
function allowAdd() {
  if (!INMEM) return true;
  const now = Date.now();
  bucket.tokens = Math.min(5, bucket.tokens + (now - bucket.at) / 2000);  // refill ~1 / 2s, cap 5
  bucket.at = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/** Absolute base for URLs the engine hands back. Behind cloudflared the public host/proto
    arrive as Host / X-Forwarded-* — honor them so /play emits reachable https URLs. */
function baseUrl(req) {
  const h = req.headers;
  const host = (h['x-forwarded-host'] || h.host || (HOST + ':' + PORT)).split(',')[0].trim();
  let proto = (h['x-forwarded-proto'] || '').split(',')[0].trim();
  if (!proto) proto = /^(127\.|localhost|0\.0\.0\.0)/.test(host) ? 'http' : 'https';
  return proto + '://' + host;
}

const findTorrent = (infoHash) =>
  client.torrents.find((t) => t.infoHash === infoHash) || null;

const torrentFilePath = (infoHash) => path.join(CACHE, infoHash + '.torrent');

/** The .torrent for an infoHash we have seen before, or null. */
function readCachedTorrent(infoHash) {
  try {
    return fs.readFileSync(torrentFilePath(infoHash));
  } catch {
    return null;
  }
}

function cacheTorrentFile(infoHash, torrent) {
  try {
    if (!torrent.torrentFile) return;
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(torrentFilePath(infoHash), torrent.torrentFile);
  } catch (err) {
    console.error('[cache]', err.message); // non-fatal: only costs a slower restart
  }
}

/** Resolve once the torrent has metadata (i.e. knows its file list), or reject on timeout. */
function waitForMetadata(torrent, infoHash) {
  return new Promise((resolve, reject) => {
    if (torrent.files.length) return resolve(torrent);

    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      torrent.removeListener('metadata', onMeta);
      torrent.removeListener('error', onErr);
    };
    const done = (fn, arg) => { if (!settled) { settled = true; cleanup(); fn(arg); } };
    const onMeta = () => done(resolve, torrent);
    const onErr = (err) => done(reject, err);

    const timer = setTimeout(
      () => done(reject, new Error('timed out fetching metadata for ' + infoHash)),
      METADATA_TIMEOUT
    );
    torrent.on('metadata', onMeta);
    torrent.on('error', onErr);
  });
}

/* Fetch the .torrent BYTES from an HTTP cache so metadata is INSTANT and needs no
   peer (the browser-sandbox lesson applied server-side: a bare magnet on a restricted
   network — e.g. a CI runner — may never get ut_metadata; a .torrent gives the file
   list immediately, and a webseeded .torrent even serves data with zero peers). */
const DOT_TORRENT_CACHES = (process.env.HP_TORRENT_CACHES ||
  'https://itorrents.org/torrent/{IH}.torrent').split(',').map((s) => s.trim()).filter(Boolean);
async function fetchDotTorrent(infoHash) {
  const IH = infoHash.toUpperCase(), ih = infoHash.toLowerCase();
  for (const tpl of DOT_TORRENT_CACHES) {
    try {
      const url = tpl.replace('{IH}', IH).replace('{ih}', ih);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 8000);
      const r = await fetch(url, { signal: ac.signal, redirect: 'follow' });
      clearTimeout(timer);
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      // a real .torrent is a bencoded dict ('d' ...) carrying an 'info' key
      if (buf.length > 100 && buf[0] === 0x64 && buf.includes(Buffer.from('4:infod'))) {
        console.error('[torrent] metadata via cache (' + buf.length + 'B) ' + ih);
        return buf;
      }
    } catch { /* try next cache */ }
  }
  return null;
}

function addTorrent(infoHash) {
  const have = findTorrent(infoHash);
  if (have && have.files.length) return Promise.resolve(have);

  const pending = adding.get(infoHash);
  if (pending) return pending;

  // A torrent whose metadata never arrived is still registered with the client.
  // Re-adding it would throw "Cannot add duplicate torrent" and poison every
  // later retry, so attach to the existing one instead.
  const p = have
    ? waitForMetadata(have, infoHash)
    : Promise.resolve().then(() => {
      // Metadata (the file list) normally has to be fetched from peers, so a
      // restart would make already-downloaded content unplayable whenever the
      // swarm is unreachable. Reuse the cached .torrent when we have one.
      // No trackers added here on purpose - only what the magnet carries + DHT.
      // INMEM: keep the store in RAM (memory-chunk-store) and touch no disk — no
      // cached .torrent read/write. Localhost: FSChunkStore under .cache, as before.
      const addOpts = INMEM ? { store: MemoryChunkStore } : { path: CACHE };
      if (INMEM) evictLRU(infoHash);
      // .torrent bytes (instant metadata, peerless) -> cached .torrent -> bare magnet
      return fetchDotTorrent(infoHash).then((dot) => {
        const src = dot || (!INMEM && readCachedTorrent(infoHash)) || ('magnet:?xt=urn:btih:' + infoHash);
        const torrent = client.add(src, addOpts);
        return waitForMetadata(torrent, infoHash).then((t) => {
          if (!INMEM) cacheTorrentFile(infoHash, t);
          return t;
        });
      });
    });

  adding.set(infoHash, p);
  // Clear the slot either way so a failed add can be retried later.
  p.catch(() => {}).finally(() => adding.delete(infoHash));
  return p;
}

/**
 * Choose which file to stream.
 *
 * player.js always sends an index (it defaults to 0), and index 0 of a release
 * torrent is very often a readme/sample rather than the feature. So: honour an
 * explicit index when it points at a video, otherwise fall back to the largest
 * video file — and only fall back to the raw index when the torrent holds no
 * video at all.
 */
function pickFile(torrent, idx) {
  const files = torrent.files || [];
  if (!files.length) return null;

  const videos = files.filter(isVideo);
  const biggest = videos.slice().sort((a, b) => b.length - a.length)[0];
  const wanted = Number.isInteger(idx) && idx >= 0 && idx < files.length ? files[idx] : null;

  if (wanted && (isVideo(wanted) || !biggest)) return wanted;
  return biggest || wanted || files[0];
}

// ------------------------------------------------------------ transcode --

const jobs = new Map();   // "ih:idx" -> { dir, proc, probe }
/* INMEM: HLS segments go to /dev/shm (RAM tmpfs on ubuntu runners) — zero disk-at-rest.
   If /dev/shm is unavailable (macOS/dev), fall back to a bounded .cache/hls. */
function pickHlsDir() {
  if (!INMEM) return path.join(CACHE, 'hls');
  const want = process.env.HLS_DIR || '/dev/shm/hp-hls';
  try { fs.mkdirSync(want, { recursive: true }); return want; }
  catch { return path.join(CACHE, 'hls'); }
}
const HLS_DIR = pickHlsDir();
const jobKey = (ih, idx, startT = 0) => ih + ':' + idx + ':' + startT;

/** ffprobe the head of a torrent file (first ~6 MB via the torrent's own read stream, so
    undownloaded regions are waited for, never read as zeros). */
function probeHead(file) {
  return new Promise((resolve) => {
    const rs = file.createReadStream({ start: 0, end: Math.min(file.length - 1, 6 * 1024 * 1024) });
    const pr = execFile(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name', '-of', 'json', 'pipe:0'],
      { maxBuffer: 1 << 20 }, (err, out) => {
        rs.destroy();
        if (err) return resolve(null);
        try {
          const j = JSON.parse(out);
          const streams = j.streams || [];
          /* total film length so the player can label the seek bar with the WHOLE movie,
             not just the transcoded-so-far window (mkv/webm carry it in the header, which
             is inside the 6 MB head we probe). null when the head lacks it → player falls
             back to <video>.duration. */
          const dur = j.format && Number.parseFloat(j.format.duration);
          resolve({ video: (streams.find((x) => x.codec_type === 'video') || {}).codec_name || null,
                    audio: (streams.find((x) => x.codec_type === 'audio') || {}).codec_name || null,
                    dur: (Number.isFinite(dur) && dur > 0) ? dur : null });
        } catch { resolve(null); }
      });
    rs.on('error', () => {}); rs.pipe(pr.stdin).on('error', () => {});
  });
}

/** Whole-film duration, robust to a trailing moov. Non-faststart mp4/mov keep their duration
    in a `moov` atom at the END of the file, which the 6 MB head probe (a non-seekable pipe)
    can never reach — so probeHead returns dur:null and the player would fall back to
    <video>.duration (only the transcoded-so-far window). ffprobe our OWN Range-seekable
    /stream URL instead: it issues a suffix range for the moov wherever it sits and reports the
    real length for every container. Runs in the BACKGROUND (never blocks first-frame) and only
    fetches the file tail, which the client picks up on its next /play poll. */
function probeDurationURL(streamUrl) {
  return new Promise((resolve) => {
    execFile(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', streamUrl],
      { timeout: 45000, maxBuffer: 1 << 16 }, (err, out) => {
        if (err) return resolve(null);
        const d = Number.parseFloat(String(out).trim());
        resolve(Number.isFinite(d) && d > 0 ? d : null);
      });
  });
}

/** Start (or reuse) the ffmpeg HLS job for one torrent file, optionally seeked to startT
    seconds. This is what makes SEEKING work on an INMEM runner: the transcode reads our own
    Range-seekable /stream URL (backed by the torrent's random access) so `-ss` can jump to
    any offset — a pipe cannot seek. localhost pipes the file into one full VOD playlist
    (already seekable), so it never needs an offset job. Resolves when index.m3u8 has its
    first segment, so the player never fetches an empty playlist. */
async function ensureHls(torrent, file, ih, idx, startT = 0) {
  startT = Math.max(0, Math.floor(Number(startT) || 0));
  const key = jobKey(ih, idx, startT);
  let job = jobs.get(key);
  if (job) return job.ready;
  const dir = path.join(HLS_DIR, ih + '-' + idx + '-' + startT);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  job = { dir, proc: null, probe: null, ready: null, startT };
  jobs.set(key, job);
  /* FIRST-FRAME SPEED (cold start only): with -c:v copy the first HLS segment cannot appear
     until the first source GOP has arrived over the swarm — that piece-wait, not the
     transcode, dominates a cold start. Mark the head of the file CRITICAL (highest priority,
     fetched in order NOW) so the swarm races the opening ~16 MB in instead of spreading
     bandwidth across the whole film. Seeks (startT>0) read deep in the file via -ss and are
     left to the normal streaming prioritisation. */
  if (startT === 0) try {
    const pieceLen = torrent.pieceLength || (1 << 18);
    const p0 = Math.floor(file.offset / pieceLen);
    const pN = Math.floor((file.offset + file.length - 1) / pieceLen);
    torrent.select(p0, Math.min(pN, p0 + Math.ceil((16 * 1024 * 1024) / pieceLen)), 1);
    torrent.critical(p0, Math.min(pN, p0 + Math.ceil((4 * 1024 * 1024) / pieceLen)));
  } catch { /* prioritisation is an optimisation, never fatal */ }
  job.ready = (async () => {
    const probe = (job.probe = (await probeHead(file)) || { video: null, audio: null });
    /* If the head lacked the duration (trailing-moov mp4/mov), fetch the WHOLE-film length in
       the background over the seekable /stream URL and patch it in. Never awaited — first-frame
       must not wait on a file-tail fetch; the client re-polls /play until dur lands. Only for
       t=0: an offset job shares the same film, so its dur is discovered by the t=0 job. */
    if (startT === 0 && !probe.dur) {
      const durUrl = `http://127.0.0.1:${PORT}/stream/${encodeURIComponent(ih)}/${idx}`;
      probeDurationURL(durUrl).then((d) => { if (d && job.probe) job.probe.dur = d; }).catch(() => {});
    }
    const copyAudio = probe.audio && BROWSER_AUDIO.has(probe.audio);
    const hevcTag = probe.video === 'hevc' ? ['-tag:v', 'hvc1'] : [];
    /* pad explicit silence so audio starts at pts 0 like the video (MKVs often start audio
       ~1s late as a timestamp hole) and resample async so it can never drift from the video */
    const audioArgs = copyAudio ? ['-c:a', 'copy']
      : ['-af', 'aresample=async=1:first_pts=0', '-c:a', 'aac', '-ac', '2', '-b:a', '192k'];
    let args, useStdin;
    /* shared HLS output: fmp4 segments; the window flags bound RAM (INMEM) / disk to the
       last HLS_WINDOW segments regardless of film length. */
    const hlsOut = ['-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
      '-c:v', 'copy', ...hevcTag, ...audioArgs,
      '-f', 'hls', '-hls_time', '4', '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', path.join(dir, 'seg%05d.m4s'), path.join(dir, 'index.m3u8')];
    const windowFlags = ['-hls_list_size', String(HLS_WINDOW), '-hls_flags', 'delete_segments+independent_segments'];
    if (INMEM) {
      /* read our OWN Range-backed /stream so -ss can jump to any offset (a pipe cannot seek,
         and cannot read an mp4 whose moov index sits at the end). Auto-reconnect hardens the
         HTTP input so a transient piece-fetch stall/reset on a fresh or slow swarm reconnects
         instead of killing the whole transcode — this is what keeps a cold-torrent start from
         collapsing into the client's reconnect loop. Burst ~30s for a snappy start/seek, then
         pace to ~1x so the bounded sliding window tracks the playhead, not the credits. */
      const src = `http://127.0.0.1:${PORT}/stream/${encodeURIComponent(ih)}/${idx}`;
      args = ['-hide_banner', '-loglevel', 'error', '-nostdin',
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '30',
        ...(startT > 0 ? ['-ss', String(startT)] : []),
        '-readrate', '1', '-readrate_initial_burst', '30',
        '-i', src, ...windowFlags, ...hlsOut];
      useStdin = false;
    } else {
      /* localhost + disk: pipe → one full VOD (event) playlist, already seekable */
      args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', 'pipe:0',
        '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments', ...hlsOut];
      useStdin = true;
    }
    const proc = (job.proc = spawn(FFMPEG, args, { stdio: [useStdin ? 'pipe' : 'ignore', 'ignore', 'pipe'] }));
    let errTail = '';
    // spawn failure (ffmpeg not on PATH → ENOENT) emits 'error' on the child; with NO
    // listener Node throws it as an uncaught exception and the whole engine dies. Capture it
    // so this one torrent rejects cleanly and /play falls back to the raw stream instead.
    let spawnErr = null;
    proc.on('error', (e) => { spawnErr = e; jobs.delete(key); });
    proc.stderr.on('data', (d) => { errTail = (errTail + d).slice(-600); });
    proc.on('exit', (code) => {
      if (code) { console.error('[hls]', key, 'ffmpeg exit', code, errTail.trim().split('\n').pop()); jobs.delete(key); }
    });
    let rs = null;
    if (useStdin) {
      rs = file.createReadStream();
      rs.on('error', () => {}); rs.pipe(proc.stdin).on('error', () => {});
      proc.on('exit', () => rs.destroy());
    }
    // wait for the first segment (ffmpeg needs ~hls_time seconds of input first)
    const m3u8 = path.join(dir, 'index.m3u8');
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      if (spawnErr) throw new Error('ffmpeg unavailable: ' + spawnErr.message);
      if (proc.exitCode !== null && proc.exitCode !== 0) throw new Error('ffmpeg failed: ' + errTail.trim());
      try { if (fs.readFileSync(m3u8, 'utf8').includes('#EXTINF')) { evictOtherOffsets(ih, idx, key); return job; } } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('transcode produced no segment in 60s');
  })();
  job.ready.catch(() => jobs.delete(key));
  return job.ready;
}

/** Once a new offset job for (ih,idx) is ready, kill the sibling offset jobs: the client has
    switched its HLS source to this one, so the old ffmpeg + its RAM segments are dead weight.
    Keeps at most one active transcode per file, so seeking never leaks processes or memory. */
function evictOtherOffsets(ih, idx, keepKey) {
  const prefix = ih + ':' + idx + ':';
  for (const [k, j] of jobs) {
    if (k === keepKey || !k.startsWith(prefix)) continue;
    try { j.proc?.kill('SIGKILL'); } catch { /* gone */ }
    try { fs.rmSync(j.dir, { recursive: true, force: true }); } catch { /* */ }
    jobs.delete(k);
  }
}

function stopJobs(ih) {
  for (const [key, job] of jobs) {
    if (!key.startsWith(ih + ':')) continue;
    try { job.proc?.kill('SIGKILL'); } catch { /* gone */ }
    fs.rmSync(job.dir, { recursive: true, force: true });
    jobs.delete(key);
  }
}

const HLS_MIME = { m3u8: 'application/vnd.apple.mpegurl', m4s: 'video/iso.segment', mp4: 'video/mp4' };

// ------------------------------------------------------------------ http --

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(payload);
}

/** Parse a single `bytes=start-end` range. null = no/unsupported range, -1 = unsatisfiable. */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return -1;

  let start, end;
  if (rawStart === '') {
    // suffix range: last N bytes
    const n = Number(rawEnd);
    if (!n) return -1;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return -1;
  return { start, end };
}

function streamFile(req, res, torrent, file) {
  // Prioritise this file; stop wasting bandwidth on the rest of the torrent.
  try {
    torrent.files.forEach((f) => { if (f !== file) f.deselect(); });
    file.select();
  } catch { /* selection is an optimisation, never fatal */ }

  const size = file.length;
  const range = parseRange(req.headers.range, size);

  if (range === -1) {
    return send(res, 416, 'Range Not Satisfiable', { 'Content-Range': `bytes */${size}` });
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': mimeOf(file.name),
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;

  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD') return res.end();

  const ih = torrent.infoHash;
  active.set(ih, (active.get(ih) || 0) + 1);   // pin this torrent while a viewer streams it
  let released = false;
  const release = () => { if (released) return; released = true;
    const c = (active.get(ih) || 1) - 1; if (c <= 0) active.delete(ih); else active.set(ih, c); };

  const stream = file.createReadStream({ start, end });
  stream.on('error', (err) => {
    console.error('[stream]', file.name, err?.message || err);
    release(); res.destroy();
  });
  stream.on('end', release);
  // Client seeked away or closed the tab - tear the read down or it leaks.
  res.on('close', () => { release(); stream.destroy(); });
  stream.pipe(res);
}

const summarise = (t) => ({
  infoHash: t.infoHash,
  name: t.name || null,
  progress: Number((t.progress || 0).toFixed(4)),
  peers: t.numPeers || 0,
  length: t.length || 0,
  downloadSpeed: Math.round(t.downloadSpeed || 0),
  files: (t.files || []).map((f, i) => ({
    idx: i, name: f.name, length: f.length, video: isVideo(f)
  }))
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const method = req.method || 'GET';

  if (method === 'OPTIONS') {
    return send(res, 204, '', {
      'Access-Control-Allow-Methods': 'GET, HEAD, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Content-Type',
      'Access-Control-Max-Age': '86400'
    });
  }

  // GET /status
  if (parts[0] === 'status' && parts.length === 1) {
    return send(res, 200, {
      ok: true,
      engine: 'coolstremio',
      torrents: client.torrents.length,
      uptime: Math.round(process.uptime())
    });
  }

  // GET /torrents
  if (parts[0] === 'torrents' && parts.length === 1) {
    return send(res, 200, client.torrents.map(summarise));
  }

  // DELETE /torrent/<infoHash>
  if (parts[0] === 'torrent' && parts.length === 2) {
    if (method !== 'DELETE') return send(res, 405, 'Method Not Allowed', { Allow: 'DELETE' });
    const infoHash = normaliseHash(parts[1]);
    if (!infoHash) return send(res, 400, { ok: false, error: 'invalid infoHash' });
    const t = findTorrent(infoHash);
    if (!t) return send(res, 404, { ok: false, error: 'not found' });
    const dir = t.name ? path.join(CACHE, t.name) : null;
    // destroyStore wipes the downloaded data from .cache as well.
    stopJobs(infoHash);
    client.remove(infoHash, { destroyStore: true }, (err) => {
      if (err) console.error('[remove]', err.message);
      // rmdir only succeeds on an empty dir, so this can never eat live data.
      if (dir) { try { fs.rmdirSync(dir); } catch { /* not empty or not there */ } }
    });
    try { fs.unlinkSync(torrentFilePath(infoHash)); } catch { /* may not exist */ }
    return send(res, 200, { ok: true, removed: infoHash });
  }

  // GET /prime/<infoHash>[/<fileIdx>]  -> 202 immediately; warms metadata + starts the
  // transcode in the BACKGROUND so a later /play returns near-instantly. The client fires
  // this while the user is still browsing/previewing a title, so playback feels instant on
  // click. Non-blocking by design — never awaits ensureHls. Same rate-limit gate as /play.
  if (parts[0] === 'prime' && (parts.length === 2 || parts.length === 3)) {
    const infoHash = normaliseHash(parts[1]);
    if (!infoHash) return send(res, 400, { ok: false, error: 'invalid infoHash' });
    const idx = parts.length === 3 ? Number.parseInt(parts[2], 10) : NaN;
    if (!findTorrent(infoHash) && !allowAdd()) return send(res, 429, { ok: false, error: 'rate limited' });
    addTorrent(infoHash).then((torrent) => {
      const file = pickFile(torrent, Number.isNaN(idx) ? null : idx);
      if (!file || file.length > HP_MAX_BYTES) return;
      if (DIRECT_EXT.has(extOf(file.name))) return;   // browser-native: direct Range, no warmup needed
      ensureHls(torrent, file, infoHash, torrent.files.indexOf(file), 0).catch(() => {});
    }).catch(() => {});
    return send(res, 202, { ok: true, priming: infoHash });
  }

  // GET /play/<infoHash>[/<fileIdx>]  -> {kind:'url'|'hls', url, file, probe}
  // The player asks here first: direct Range streaming for browser-native containers,
  // the ffmpeg HLS path for everything else (MKV with Dolby/DTS audio = silent otherwise).
  if (parts[0] === 'play' && (parts.length === 2 || parts.length === 3)) {
    const infoHash = normaliseHash(parts[1]);
    if (!infoHash) return send(res, 400, { ok: false, error: 'invalid infoHash' });
    const idx = parts.length === 3 ? Number.parseInt(parts[2], 10) : NaN;
    if (!findTorrent(infoHash) && !allowAdd()) return send(res, 429, { ok: false, error: 'rate limited: too many new torrent adds' });
    return addTorrent(infoHash).then(async (torrent) => {
      const file = pickFile(torrent, Number.isNaN(idx) ? null : idx);
      if (!file) return send(res, 404, { ok: false, error: 'no streamable file' });
      if (file.length > HP_MAX_BYTES)
        return send(res, 413, { ok: false, error: 'file exceeds runner size cap', bytes: file.length, cap: HP_MAX_BYTES });
      const fi = torrent.files.indexOf(file);
      const base = baseUrl(req);
      if (DIRECT_EXT.has(extOf(file.name))) {
        return send(res, 200, { ok: true, kind: 'url', url: `${base}/stream/${infoHash}/${fi}`, file: file.name, reason: 'browser-native container' });
      }
      try {
        /* ?t=<seconds> seeks the transcode to that offset (INMEM) so the player can jump
           anywhere; the offset is embedded in the HLS path so its segments stay separate. */
        const startT = Math.max(0, Math.floor(Number(url.searchParams.get('t')) || 0));
        const job = await ensureHls(torrent, file, infoHash, fi, startT);
        return send(res, 200, { ok: true, kind: 'hls', url: `${base}/hls/${infoHash}/${fi}/${startT}/index.m3u8`, file: file.name,
          offset: startT, probe: job.probe, reason: 'transcoded: audio→AAC, video copied (browser cannot decode ' + (job.probe?.audio || extOf(file.name)) + ')' });
      } catch (e) {
        console.error('[play]', infoHash, e.message);
        return send(res, 200, { ok: true, kind: 'url', url: `${base}/stream/${infoHash}/${fi}`, file: file.name, reason: 'transcode unavailable: ' + e.message });
      }
    }, (err) => send(res, 504, { ok: false, error: 'metadata: ' + (err?.message || 'unknown') }));
  }

  // GET /hls/<infoHash>/<fileIdx>/<startT>/<segment>
  if (parts[0] === 'hls' && parts.length === 5) {
    const infoHash = normaliseHash(parts[1]);
    const fi = Number.parseInt(parts[2], 10);
    const startT = Math.max(0, Math.floor(Number(parts[3]) || 0));
    const name = path.basename(parts[4]);
    if (!/^(index\.m3u8|init\.mp4|seg\d+\.m4s)$/.test(name)) return send(res, 404, 'no such stream');
    let job = infoHash && jobs.get(jobKey(infoHash, fi, startT));
    if (!job) {
      /* SELF-HEAL: the transcode job died (ffmpeg exit) or was evicted, but the torrent is
         still resident. Restart it at the same offset so the client's next poll gets a live
         playlist instead of a permanent 404 — the browser retries the manifest on a 503. */
      const tor = infoHash && findTorrent(infoHash);
      const file = tor && !Number.isNaN(fi) && tor.files[fi];
      if (tor && file) { ensureHls(tor, file, infoHash, fi, startT).catch(() => {}); return send(res, 503, 'stream restarting'); }
      return send(res, 404, 'no such stream');
    }
    const fp = path.join(job.dir, name);
    return fs.readFile(fp, (err, data) => {
      if (err) return send(res, 404, 'segment not ready');
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': HLS_MIME[extOf(name)] || 'application/octet-stream',
        'Content-Length': data.length, 'Cache-Control': 'no-store' });
      res.end(method === 'HEAD' ? undefined : data);
    });
  }

  // GET /stream/<infoHash>[/<fileIdx>]
  if (parts[0] === 'stream' && (parts.length === 2 || parts.length === 3)) {
    if (method !== 'GET' && method !== 'HEAD') {
      return send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    }
    const infoHash = normaliseHash(parts[1]);
    if (!infoHash) return send(res, 400, 'Invalid infoHash');

    const idx = parts.length === 3 ? Number.parseInt(parts[2], 10) : NaN;
    if (!findTorrent(infoHash) && !allowAdd()) return send(res, 429, 'Rate limited: too many new torrent adds');

    return addTorrent(infoHash).then(
      (torrent) => {
        if (res.writableEnded || res.destroyed) return;
        const file = pickFile(torrent, Number.isNaN(idx) ? null : idx);
        if (!file) return send(res, 404, 'Torrent contains no streamable file');
        if (file.length > HP_MAX_BYTES) return send(res, 413, 'File exceeds runner size cap (' + file.length + ' > ' + HP_MAX_BYTES + ')');
        streamFile(req, res, torrent, file);
      },
      (err) => {
        console.error('[stream]', infoHash, err?.message || err);
        if (!res.headersSent) send(res, 504, 'Could not fetch torrent metadata: ' + (err?.message || 'unknown'));
      }
    );
  }

  send(res, 404, { ok: false, error: 'not found' });
});

/** Accept a 40-char hex v1 infoHash (what Stremio addons emit). Everything else is rejected. */
function normaliseHash(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(s) ? s : null;
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use (Stremio Desktop uses 11470 too).`);
    console.error(`  Stop that process, or run:  PORT=11471 node engine.mjs\n`);
  } else {
    console.error('[server]', err.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`CoolStremio engine on http://${HOST}:${PORT}` + (INMEM ? '  [INMEM: RAM store, HLS→' + HLS_DIR + ']' : ''));
  console.log(`  cache: ${INMEM ? '(in-memory — no disk cache)' : CACHE}`);
  console.log(`  GET /status · GET /torrents · GET /stream/<infoHash>/<fileIdx> · DELETE /torrent/<infoHash>`);
});

// Durability: a single client's bad request (a codec ffmpeg chokes on, a torrent that
// stalls, an async 'error' event we missed) must never take down an engine serving many
// clients. Log and stay up — the offending request already fails on its own path.
process.on('uncaughtException', (e) => console.error('[uncaught]', e?.stack || e?.message || e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e?.stack || e?.message || e));

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (closing) process.exit(0);
    closing = true;
    console.log('\nshutting down…');
    server.close();
    client.destroy(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
