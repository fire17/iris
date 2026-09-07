/* announce.mjs — the runner's side of the discovery floor.
 *
 * The runner PUBLISHES its live public URL on the room's floor topic every ANNOUNCE_MS,
 * and answers a browser's {t:'who'} ping immediately (so a just-joined browser gets the
 * URL without waiting a full interval). Frames are tiny JSON control messages — NEVER
 * media. Bytes flow browser <-> cloudflared <-> runner over https; the floor only carries
 * the handshake (fire17's law: "the node relays the handshakes, never the bytes").
 */
import { joinFloor } from '../vendor/hp-floor.mjs';

/* KEYLESS BY DESIGN (fire17: "no secrets stored in the repos - both the client and the
   server should derive it correctly"). Nothing is signed: trust comes from the per-repo
   derived room + the client probing the announced URL's /status and requiring the
   engine's repo echo to match its own repo. Honest limit: a determined attacker who
   derives a room name can announce a hostile URL — the no-secrets tradeoff, see RUNNER.md. */

const enc = new TextEncoder();
const dec = new TextDecoder();
const ANNOUNCE_MS = Number(process.env.ANNOUNCE_MS) || 5000;

/** Start announcing {url,caps} on room's floor. Returns stop(). */
export async function announce({ room, url, caps = { hls: true, range: true } }) {
  let floor = null, timer = null, stopped = false;
  const frame = async () => enc.encode(JSON.stringify({ t: 'runner', url, ts: Date.now(), caps }));

  floor = await joinFloor({
    room,
    onFrame: (from, bytes) => {
      // A browser that just joined pings {t:'who'} — reply at once with our URL.
      let msg; try { msg = JSON.parse(dec.decode(bytes)); } catch { return; }
      if (msg && msg.t === 'who') frame().then((f) => floor.send(f)).catch(() => {});
    },
    onStatus: (s) => { if (!stopped) console.error('[announce] relays=' + s.relays); },
  });

  const beat = () => { if (!stopped) frame().then((f) => floor.send(f)).catch(() => {}); };
  beat();
  timer = setInterval(beat, ANNOUNCE_MS);
  console.error('[announce] publishing ' + url + ' on room=' + room + ' every ' + ANNOUNCE_MS + 'ms');

  return function stop() {
    stopped = true;
    clearInterval(timer);
    try { floor.close(); } catch { /* gone */ }
  };
}
