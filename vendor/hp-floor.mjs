/**
 * hp-floor.mjs — the ISOMORPHIC discovery floor (Node 22+ AND browser).
 *
 * Vendored, self-contained, ZERO @fire17/p2p dependency. Adapted almost verbatim from
 * EchoCollab's src/p2p/floor.js (its MQTT-3.1.1-QoS0 packer, roomKey/seal/open, the
 * multi-relay connect() with jittered backoff + 30s keepalive, the sender-id echo drop) —
 * the ONLY p2p imports it had (topicFor / epochStr / encodeKey) are replaced by two local
 * helpers below, so this file stands alone. Runs in the browser (global WebSocket +
 * crypto.subtle) and in Node 22+ (both are globals there too).
 *
 * WHAT CROSSES IT: small AES-GCM-sealed control frames only — the runner PUBLISHES
 * {t:'runner', url, ts, caps}; a browser SUBSCRIBES and discovers the live https URL. The
 * broker is a BLIND PIPE (opaque topic + ciphertext). Media bytes NEVER touch this floor —
 * they flow browser <-> cloudflared <-> runner over https. This honors fire17's standing
 * law: "the node relays the handshakes, never the bytes."
 *
 * WHY VENDOR, NOT DEP: @fire17/p2p pulls a large tree (node transport, Noise IK, group,
 * rendezvous) for two trivial helpers; the browser app is a non-module IIFE that cannot
 * cheaply take an npm dep. One ~150-LOC file honors ponytail and the mission's
 * "vendor the floor transport into honestporn" option.
 */

const enc = new TextEncoder();
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (str) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(str)));

// Public MQTT-over-WSS brokers. Same pair EchoCollab / @fire17/p2p use. Best-effort,
// "do not rely on this" services — we fan out across both and back off on failure.
const RELAYS = ['wss://broker.emqx.io:8084/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];

// UTC-day epoch, identical shape to p2p's epochStr — rotate topic daily.
const epochStr = (ms) => new Date(ms).toISOString().slice(0, 10);
// Local topicFor: hp1/<hex(SHA-256(room|epoch))>. Replaces p2p's deriveRid(S,'wss',epoch,20).
const topicFor = async (room, epoch) => 'hp1/' + hex(await sha256(room + '|' + epoch));

/* MQTT 3.1.1 QoS 0, the subset a browser needs — mirrors p2p's own packer. */
const remlen = (n) => {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 128; out.push(b); } while (n > 0);
  return out;
};
const packet = (type, flags, body) => Uint8Array.from([(type << 4) | flags, ...remlen(body.length), ...body]);
const mstr = (s) => { const b = enc.encode(s); return [b.length >> 8, b.length & 255, ...b]; };

const parse = (buf) => {
  if (buf.length < 2) return null;
  const type = buf[0] >> 4;
  let multiplier = 1, value = 0, i = 1, digit;
  do {
    if (i >= buf.length) return null;
    digit = buf[i++];
    value += (digit & 127) * multiplier;
    multiplier *= 128;
  } while ((digit & 128) !== 0);
  return { type, body: buf.subarray(i, i + value) };
};

/* Room key: the room name is the shared secret, so the broker never sees plaintext. */
const roomKey = async (room) => {
  const material = await crypto.subtle.digest('SHA-256', enc.encode(`hp:floor:${room}`));
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
};

const seal = async (key, bytes) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(12 + body.length);
  out.set(iv); out.set(body, 12);
  return out;
};

const open = async (key, bytes) => {
  if (bytes.length <= 12) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12));
    return new Uint8Array(plain);
  } catch { return null; } // another room, or a corrupt frame — ignore
};

/**
 * Join a room's floor. `onFrame(from, bytes)` receives decrypted payloads from other
 * members; the returned `send(bytes)` publishes to everyone on the room's topic.
 * selfId is a random uint32 so the broker's echo of our own frames can be dropped.
 */
export const joinFloor = async ({ room, selfId, onFrame, onStatus }) => {
  if (selfId == null) selfId = (crypto.getRandomValues(new Uint32Array(1))[0]) >>> 0;
  const key = await roomKey(room);
  // Subscribe neighbouring epochs so a session open across UTC midnight stays in-room.
  const now = Date.now();
  const DAY = 86_400_000;
  const topics = [...new Set(await Promise.all(
    [epochStr(now - DAY), epochStr(now), epochStr(now + DAY)].map((e) => topicFor(room, e))
  ))];
  const publishTopic = topics[1] ?? topics[0];

  const sockets = [];
  let closed = false, live = 0;

  const connect = (url, attempt = 0) => {
    if (closed) return;
    let ws, ping;
    try { ws = new WebSocket(url, 'mqtt'); } catch { return; }
    ws.binaryType = 'arraybuffer';
    sockets.push(ws);

    ws.onopen = () => {
      attempt = 0;
      const clientId = `hp${selfId}${Math.random().toString(36).slice(2, 8)}`.slice(0, 22);
      ws.send(packet(1, 0, [...mstr('MQTT'), 4, 2, 0, 60, ...mstr(clientId)]));
      let id = 1;
      for (const topic of topics) ws.send(packet(8, 2, [0, id++, ...mstr(topic), 0]));
      live += 1;
      onStatus?.({ relays: live });
      ping = setInterval(() => { try { ws.send(packet(12, 0, [])); } catch { /* gone */ } }, 30_000);
    };

    ws.onmessage = async (event) => {
      const frame = parse(new Uint8Array(event.data));
      if (!frame || frame.type !== 3) return; // PUBLISH only
      const topicLen = (frame.body[0] << 8) | frame.body[1];
      const payload = frame.body.subarray(2 + topicLen);
      const plain = await open(key, payload);
      if (!plain || plain.length < 4) return;
      const from = new DataView(plain.buffer, plain.byteOffset).getUint32(0);
      if (from === selfId) return; // our own frame, echoed by the broker
      onFrame?.(from, plain.subarray(4));
    };

    const down = () => {
      clearInterval(ping);
      live = Math.max(0, live - 1);
      onStatus?.({ relays: live });
      const wait = Math.min(120_000, 3000 * 2 ** Math.min(attempt, 5));
      if (!closed) setTimeout(() => connect(url, attempt + 1), wait * (0.7 + Math.random() * 0.6));
    };
    ws.onclose = down;
    ws.onerror = () => { try { ws.close(); } catch { /* gone */ } };
  };

  RELAYS.forEach((u) => connect(u));

  return {
    get relays() { return live; },
    selfId,
    send: async (bytes) => {
      const stamped = new Uint8Array(4 + bytes.length);
      new DataView(stamped.buffer).setUint32(0, selfId);
      stamped.set(bytes, 4);
      const sealed = await seal(key, stamped);
      const body = Uint8Array.from([...mstr(publishTopic), ...sealed]);
      for (const ws of sockets) {
        if (ws.readyState === 1 /* OPEN */) { try { ws.send(packet(3, 0, body)); } catch { /* gone */ } }
      }
    },
    close: () => {
      closed = true;
      for (const ws of sockets) { try { ws.close(); } catch { /* gone */ } }
    },
  };
};
