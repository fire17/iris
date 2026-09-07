/* runner.mjs — the hosted-runner bootstrap (TRACK A).
 *
 * Sequence: pick a free port -> spawn the engine in INMEM (pure-RAM) mode -> open an
 * OUTBOUND cloudflared quick-tunnel (public https URL, no account, no inbound port) ->
 * health-check the PUBLIC url end-to-end -> announce the url on the discovery floor.
 * Honors RUN_SECONDS / HANDOFF_AT so it is a drop-in for the relay-baton pool: it stops
 * announcing at HANDOFF_AT, drains, and exits at RUN_SECONDS (a fresh pool run is already
 * overlapping, so there is no dark window).
 *
 * EXPERIMENTAL / AT-OWN-RISK: serving media from GitHub Actions runners violates GitHub's
 * Acceptable Use Policy (Actions = CI/CD). Kept OPT-IN, in-memory, rate-limited. See RUNNER.md.
 *
 *   HP_ROOM=iris-hp-runner-v1 node server/runner.mjs
 * Prints machine-parseable RUNNER_URL=<url> and RUNNER_READY on success.
 */
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { announce } from './announce.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* Fork-aware default room. Every repo gets its OWN floor room, derived from
   GITHUB_REPOSITORY (a plain Actions env var — no token, no secret), so a fork's pool
   never collides with the official one or with other forks, with ZERO configuration.
   The official repo keeps the legacy v1 name (live clients already listen there).
   FNV-1a via Math.imul — bit-identical to the browser's derivation in torrent-runner.js. */
const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); };
const REPO = (process.env.GITHUB_REPOSITORY || '').toLowerCase();
const ROOM = process.env.HP_ROOM ||
  ((!REPO || REPO === 'fire17/iris') ? 'iris-hp-runner-v1' : 'iris-hp-' + fnv(REPO));
const RUN_SECONDS = Number(process.env.RUN_SECONDS) || 0;       // 0 = run until killed
const HANDOFF_AT = Number(process.env.HANDOFF_AT) || 0;         // stop announcing this many s in
const CF_BIN = process.env.CLOUDFLARED || 'cloudflared';
const READY_BUDGET_MS = Number(process.env.READY_BUDGET_MS) || 45000;   // wait this long for the tunnel URL line
const PUBLIC_BUDGET_MS = Number(process.env.PUBLIC_BUDGET_MS) || 40000;  // wait this long for the public URL to health-check
/* Local-sim escape hatch: on a box whose resolver blocks the *.trycloudflare.com wildcard
   (e.g. Tailscale MagicDNS → NXDOMAIN) the runner cannot health-check its OWN public URL
   even though the tunnel is live. Set this to announce anyway. On a real GHA runner DNS
   works and this stays 0. */
const SKIP_PUB = process.env.SKIP_PUBLIC_HEALTHCHECK === '1';

const log = (...a) => console.error('[runner]', ...a);

// mutable handles + a single shutdown, defined up front so any early-exit path is TDZ-safe.
let engine = null, cf = null, stopAnnounce = null, stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  try { stopAnnounce && stopAnnounce(); } catch { /* */ }
  try { cf && cf.kill('SIGTERM'); } catch { /* */ }
  try { engine && engine.kill('SIGTERM'); } catch { /* */ }
  setTimeout(() => process.exit(code), 1500).unref();
}
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/** GET a URL (http or https), resolve {status,body} or reject. */
function get(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

async function pollJson(url, budgetMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    try {
      const r = await get(url);
      if (r.status === 200 && JSON.parse(r.body).ok) return true;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** wait until a binary is runnable (PATH or absolute) — boot steps run CONCURRENTLY with
    the workflow's background installs, so the tunnel spawn waits for cloudflared here
    instead of the workflow serializing on its download. */
async function waitForBin(bin, budgetMs) {
  const t0 = Date.now();
  const present = () => {
    try {
      if (bin.includes('/')) return fs.existsSync(bin);
      return (process.env.PATH || '').split(':').some((d) => { try { return d && fs.existsSync(path.join(d, bin)); } catch { return false; } });
    } catch { return false; }
  };
  while (!present() && Date.now() - t0 < budgetMs) await new Promise((r) => setTimeout(r, 300));
  return present();
}

async function main() {
  const PORT = process.env.PORT || String(await freePort());

  // 1) engine, INMEM (pure RAM). Child spawn: the engine auto-listens on import.
  //    Prefer the committed single-file BUNDLE (zero npm install — fast even on a fresh
  //    fork's first run ever); fall back to the raw source + node_modules.
  const enginePath = ['engine.bundle.mjs', 'engine.mjs']
    .map((f) => path.join(HERE, f)).find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  log('engine entry: ' + path.basename(enginePath));
  engine = spawn(process.execPath, [enginePath], {
    env: { ...process.env, PORT, HP_INMEM: '1', HOST: '127.0.0.1' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  engine.on('exit', (c) => { log('engine exited', c); shutdown(1); });

  // 2) cloudflared quick-tunnel, CONCURRENT with the engine boot (the tunnel proxies to
  //    the port on demand, so it need not wait for a listener). FIRST-HELLO SPEED: the
  //    client shows "Engine ready" only after it hears an announce, so every second here
  //    is user-visible.
  let url = null;
  const tunnelP = (async () => {
    if (!(await waitForBin(CF_BIN, 45000))) { log('cloudflared never appeared'); return shutdown(1); }
    cf = spawn(CF_BIN, ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const onData = (d) => {
      const m = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i.exec(String(d));
      if (m && !url) { url = m[1]; log('tunnel url ' + url); }
    };
    cf.stdout.on('data', onData);
    cf.stderr.on('data', onData);
    cf.on('exit', (c) => { log('cloudflared exited', c); shutdown(1); });
    const t0 = Date.now();
    while (!url && Date.now() - t0 < READY_BUDGET_MS) await new Promise((r) => setTimeout(r, 150));
  })();
  const engineP = pollJson(`http://127.0.0.1:${PORT}/status`, 15000)
    .then((ok) => { if (ok) log('engine ready on 127.0.0.1:' + PORT); return ok; });

  const [engOk] = await Promise.all([engineP, tunnelP]);
  if (!engOk) { log('engine not ready'); return shutdown(1); }
  if (!url) { log('no tunnel url in time'); return shutdown(1); }

  // 3) ANNOUNCE IMMEDIATELY — the client verifies every announced URL itself (/status
  //    probe + repo echo) before trusting it, so gating the announce on our own public
  //    health-check only delayed the first hello. The check still runs, demoted to a
  //    background WATCHDOG: a tunnel that never comes up kills this runner so the pool
  //    replaces it, but a healthy one costs the user zero wait.
  console.log('RUNNER_URL=' + url);
  stopAnnounce = await announce({ room: ROOM, url, caps: { hls: true, range: true } });
  console.log('RUNNER_READY');
  pollJson(url + '/status', PUBLIC_BUDGET_MS).then((ok) => {
    if (ok) { log('public health-check passed'); return; }
    if (SKIP_PUB) { log('WARNING: public health-check failed but SKIP_PUBLIC_HEALTHCHECK=1 (local-sim / broken resolver)'); return; }
    log('public url never health-checked — retiring so the pool replaces this runner');
    shutdown(1);
  });

  // 5) lifetime: baton-pool compatible.
  if (HANDOFF_AT > 0) setTimeout(() => { log('handoff: stop announcing'); try { stopAnnounce(); } catch {} }, HANDOFF_AT * 1000).unref();
  if (RUN_SECONDS > 0) setTimeout(() => { log('run window elapsed; draining'); shutdown(0); }, RUN_SECONDS * 1000).unref();
}

main().catch((e) => { console.error('[runner] fatal', e); shutdown(1); });
