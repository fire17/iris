/* announce.mjs — the runner's side of the discovery floor.
 *
 * The runner PUBLISHES its live public URL on the room's floor topic every ANNOUNCE_MS,
 * and answers a browser's {t:'who'} ping immediately (so a just-joined browser gets the
 * URL without waiting a full interval). Frames are tiny JSON control messages — NEVER
 * media. Bytes flow browser <-> cloudflared <-> runner over https; the floor only carries
 * the handshake (fire17's law: "the node relays the handshakes, never the bytes").
 */
import { joinFloor } from '../vendor/hp-floor.mjs';

/* Sign every announce so a browser trusts ONLY our runner (the room name ships in
   public JS, so confidentiality alone can't stop a hostile announcer). ECDSA P-256
   over `runner|<url>|<ts>`; the browser verifies against a pinned public key. */
let SIGN_KEY = null;
async function signKey() {
  if (SIGN_KEY) return SIGN_KEY;
  const jwk = process.env.HP_ENGINE_PRIV && JSON.parse(process.env.HP_ENGINE_PRIV);
  if (!jwk) return null;
  SIGN_KEY = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return SIGN_KEY;
}
const b64 = (u8) => Buffer.from(u8).toString('base64');
async function signed(url, ts) {
  const k = await signKey();
  if (!k) return '';
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k, enc.encode('runner|' + url + '|' + ts)));
  return b64(sig);
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const ANNOUNCE_MS = Number(process.env.ANNOUNCE_MS) || 5000;

/** Start announcing {url,caps} on room's floor. Returns stop(). */
export async function announce({ room, url, caps = { hls: true, range: true } }) {
  let floor = null, timer = null, stopped = false;
  const frame = async () => { const ts = Date.now(); const sig = await signed(url, ts);
    return enc.encode(JSON.stringify({ t: 'runner', url, ts, caps, sig })); };

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
