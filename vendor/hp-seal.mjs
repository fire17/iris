/**
 * hp-seal.mjs — ISOMORPHIC sealed envelope for beta telemetry (browser + Node 22+).
 *
 * WHY THIS EXISTS: the floor (vendor/hp-floor.mjs) derives its room key from the room
 * NAME, and the room name ships inside public JS. So floor sealing hides telemetry from
 * the broker, but NOT from anyone who reads the site's source. On an adult-content site
 * that is unacceptable: the beta must never leak what strangers are watching. Every
 * telemetry event is therefore sealed a SECOND time, to the collector's public key, so
 * only the machine holding the private key can read it. Same pinned-public-key pattern
 * as js/torrent-runner.js / server/announce.mjs, one direction further.
 *
 * WIRE FORMAT (exact, shared contract — .grand/lanes/COMMON.md):
 *   [0x01][65 bytes ephemeral P-256 raw public key][12 bytes iv][AES-256-GCM ct+tag]
 * KEY DERIVATION:
 *   HKDF-SHA256( ECDH(ephemeral priv, recipient pub), salt = ephemeral raw pub,
 *                info = "hp-seal-v1" ) -> 32 bytes -> AES-256-GCM key
 *
 * PROPERTIES: fresh ephemeral key per message (no key reuse, forward-secret against later
 * theft of the ephemeral side), the ephemeral public key doubles as the HKDF salt (so
 * every message derives a distinct AES key), and AES-GCM authenticates the whole
 * ciphertext. There is NO sender authentication by design — anyone may send telemetry;
 * the collector trusts nothing in a frame and only ever appends validated JSON.
 *
 * ZERO DEPENDENCIES: WebCrypto globals only (globalThis.crypto.subtle), present in the
 * browser and in Node 22+. No imports at all, so this file drops into either runtime.
 * openWith() NEVER throws — a frame from another sender, another key, or a corrupt relay
 * simply returns null, exactly like hp-floor's open().
 */

const SUBTLE = globalThis.crypto.subtle;
const ENC = new TextEncoder();

const VERSION   = 0x01;   // wire byte 0
const PUB_LEN   = 65;     // uncompressed P-256 point: 0x04 || X(32) || Y(32)
const IV_LEN    = 12;     // AES-GCM standard nonce
const TAG_LEN   = 16;     // AES-GCM tag, appended to the ciphertext by WebCrypto
const HEAD_LEN  = 1 + PUB_LEN + IV_LEN;
const INFO      = ENC.encode('hp-seal-v1');
const CURVE     = { name: 'ECDH', namedCurve: 'P-256' };

/* Rebuild a minimal JWK. Keys travel as JSON constants (pinned in the client, stored in
   priv.jwk on the collector); stripping ext/key_ops/use avoids importKey rejecting a JWK
   whose key_ops disagree with the usages we ask for. */
const pubJwkOf  = (j) => ({ kty: 'EC', crv: 'P-256', x: j.x, y: j.y });
const privJwkOf = (j) => ({ kty: 'EC', crv: 'P-256', x: j.x, y: j.y, d: j.d });

const importPub  = (jwk) => SUBTLE.importKey('jwk', pubJwkOf(jwk),  CURVE, true,  []);
const importPriv = (jwk) => SUBTLE.importKey('jwk', privJwkOf(jwk), CURVE, false, ['deriveBits']);

/** ECDH -> HKDF-SHA256 -> AES-256-GCM key. `salt` is the ephemeral raw public key. */
async function sharedKey(privKey, pubKey, salt) {
  const secret = await SUBTLE.deriveBits({ name: 'ECDH', public: pubKey }, privKey, 256);
  const hkdf   = await SUBTLE.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const bits   = await SUBTLE.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: INFO }, hkdf, 256);
  return SUBTLE.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Generate a collector keypair. Returns plain JWK objects, ready to JSON.stringify. */
export async function keygen() {
  const pair = await SUBTLE.generateKey(CURVE, true, ['deriveBits']);
  const [pub, priv] = await Promise.all([
    SUBTLE.exportKey('jwk', pair.publicKey),
    SUBTLE.exportKey('jwk', pair.privateKey),
  ]);
  return { pub: pubJwkOf(pub), priv: privJwkOf(priv) };
}

/** Seal `bytes` to the recipient's public JWK. Returns the wire frame. */
export async function sealTo(pubJwk, bytes) {
  const recipient = await importPub(pubJwk);
  const eph       = await SUBTLE.generateKey(CURVE, true, ['deriveBits']);
  const ephRaw    = new Uint8Array(await SUBTLE.exportKey('raw', eph.publicKey));
  const key       = await sharedKey(eph.privateKey, recipient, ephRaw);
  const iv        = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ct        = new Uint8Array(await SUBTLE.encrypt({ name: 'AES-GCM', iv }, key, bytes));

  const out = new Uint8Array(HEAD_LEN + ct.length);
  out[0] = VERSION;
  out.set(ephRaw, 1);
  out.set(iv, 1 + PUB_LEN);
  out.set(ct, HEAD_LEN);
  return out;
}

/**
 * Open a wire frame with the collector's private JWK.
 * Returns the plaintext bytes, or null for ANY failure (wrong key, wrong version, short
 * frame, corrupt tag, garbage from a stranger). Never throws — the collector's frame
 * handler must never be able to die on inbound data.
 */
export async function openWith(privJwk, bytes) {
  try {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    if (bytes.length < HEAD_LEN + TAG_LEN) return null;
    if (bytes[0] !== VERSION) return null;

    const ephRaw = bytes.subarray(1, 1 + PUB_LEN);
    if (ephRaw[0] !== 0x04) return null;                       // uncompressed point only
    const iv = bytes.subarray(1 + PUB_LEN, HEAD_LEN);
    const ct = bytes.subarray(HEAD_LEN);

    const ephPub = await SUBTLE.importKey('raw', ephRaw, CURVE, true, []);
    const key    = await sharedKey(await importPriv(privJwk), ephPub, ephRaw);
    return new Uint8Array(await SUBTLE.decrypt({ name: 'AES-GCM', iv }, key, ct));
  } catch {
    return null;                                               // not ours — drop it
  }
}
