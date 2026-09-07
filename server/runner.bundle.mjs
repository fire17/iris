import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// server/runner.mjs
import net from "node:net";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// vendor/hp-floor.mjs
var enc = new TextEncoder();
var hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
var sha256 = async (str) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(str)));
var RELAYS = ["wss://broker.emqx.io:8084/mqtt", "wss://test.mosquitto.org:8081/mqtt"];
var epochStr = (ms) => new Date(ms).toISOString().slice(0, 10);
var topicFor = async (room, epoch) => "hp1/" + hex(await sha256(room + "|" + epoch));
var remlen = (n) => {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 128;
    out.push(b);
  } while (n > 0);
  return out;
};
var packet = (type, flags, body) => Uint8Array.from([type << 4 | flags, ...remlen(body.length), ...body]);
var mstr = (s) => {
  const b = enc.encode(s);
  return [b.length >> 8, b.length & 255, ...b];
};
var parse = (buf) => {
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
var roomKey = async (room) => {
  const material = await crypto.subtle.digest("SHA-256", enc.encode(`hp:floor:${room}`));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
};
var seal = async (key, bytes) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
  const out = new Uint8Array(12 + body.length);
  out.set(iv);
  out.set(body, 12);
  return out;
};
var open = async (key, bytes) => {
  if (bytes.length <= 12) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) }, key, bytes.subarray(12));
    return new Uint8Array(plain);
  } catch {
    return null;
  }
};
var joinFloor = async ({ room, selfId, onFrame, onStatus }) => {
  if (selfId == null) selfId = crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;
  const key = await roomKey(room);
  const now = Date.now();
  const DAY = 864e5;
  const topics = [...new Set(await Promise.all(
    [epochStr(now - DAY), epochStr(now), epochStr(now + DAY)].map((e) => topicFor(room, e))
  ))];
  const publishTopic = topics[1] ?? topics[0];
  const sockets = [];
  let closed = false, live = 0;
  const connect = (url, attempt = 0) => {
    if (closed) return;
    let ws, ping, opened = false;
    try {
      ws = new WebSocket(url, "mqtt");
    } catch {
      return;
    }
    ws.binaryType = "arraybuffer";
    sockets.push(ws);
    ws.onopen = () => {
      attempt = 0;
      const clientId = `hp${selfId}${Math.random().toString(36).slice(2, 8)}`.slice(0, 22);
      ws.send(packet(1, 0, [...mstr("MQTT"), 4, 2, 0, 60, ...mstr(clientId)]));
      let id = 1;
      for (const topic of topics) ws.send(packet(8, 2, [0, id++, ...mstr(topic), 0]));
      opened = true;
      live += 1;
      onStatus?.({ relays: live });
      ping = setInterval(() => {
        try {
          ws.send(packet(12, 0, []));
        } catch {
        }
      }, 3e4);
    };
    ws.onmessage = async (event) => {
      const frame = parse(new Uint8Array(event.data));
      if (!frame || frame.type !== 3) return;
      const topicLen = frame.body[0] << 8 | frame.body[1];
      const payload = frame.body.subarray(2 + topicLen);
      const plain = await open(key, payload);
      if (!plain || plain.length < 4) return;
      const from = new DataView(plain.buffer, plain.byteOffset).getUint32(0);
      if (from === selfId) return;
      onFrame?.(from, plain.subarray(4));
    };
    const down = () => {
      clearInterval(ping);
      if (opened) {
        opened = false;
        live = Math.max(0, live - 1);
        onStatus?.({ relays: live });
      }
      const wait = Math.min(12e4, 3e3 * 2 ** Math.min(attempt, 5));
      if (!closed) setTimeout(() => connect(url, attempt + 1), wait * (0.7 + Math.random() * 0.6));
    };
    ws.onclose = down;
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
      }
    };
  };
  RELAYS.forEach((u) => connect(u));
  return {
    get relays() {
      return live;
    },
    selfId,
    send: async (bytes) => {
      const stamped = new Uint8Array(4 + bytes.length);
      new DataView(stamped.buffer).setUint32(0, selfId);
      stamped.set(bytes, 4);
      const sealed = await seal(key, stamped);
      const body = Uint8Array.from([...mstr(publishTopic), ...sealed]);
      for (const ws of sockets) {
        if (ws.readyState === 1) {
          try {
            ws.send(packet(3, 0, body));
          } catch {
          }
        }
      }
    },
    close: () => {
      closed = true;
      for (const ws of sockets) {
        try {
          ws.close();
        } catch {
        }
      }
    }
  };
};

// server/announce.mjs
var enc2 = new TextEncoder();
var dec = new TextDecoder();
var ANNOUNCE_MS = Number(process.env.ANNOUNCE_MS) || 5e3;
async function announce({ room, url, caps = { hls: true, range: true } }) {
  let floor = null, timer = null, stopped = false;
  const frame = async () => enc2.encode(JSON.stringify({ t: "runner", url, ts: Date.now(), caps }));
  floor = await joinFloor({
    room,
    onFrame: (from, bytes) => {
      let msg;
      try {
        msg = JSON.parse(dec.decode(bytes));
      } catch {
        return;
      }
      if (msg && msg.t === "who") frame().then((f) => floor.send(f)).catch(() => {
      });
    },
    onStatus: (s) => {
      if (!stopped) console.error("[announce] relays=" + s.relays);
    }
  });
  const beat = () => {
    if (!stopped) frame().then((f) => floor.send(f)).catch(() => {
    });
  };
  beat();
  timer = setInterval(beat, ANNOUNCE_MS);
  console.error("[announce] publishing " + url + " on room=" + room + " every " + ANNOUNCE_MS + "ms");
  return function stop() {
    stopped = true;
    clearInterval(timer);
    try {
      floor.close();
    } catch {
    }
  };
}

// server/runner.mjs
var HERE = path.dirname(fileURLToPath(import.meta.url));
var fnv = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return ("0000000" + h.toString(16)).slice(-8);
};
var REPO = (process.env.GITHUB_REPOSITORY || "").toLowerCase();
var ROOM = process.env.HP_ROOM || (!REPO || REPO === "fire17/iris" ? "iris-hp-runner-v1" : "iris-hp-" + fnv(REPO));
var RUN_SECONDS = Number(process.env.RUN_SECONDS) || 0;
var HANDOFF_AT = Number(process.env.HANDOFF_AT) || 0;
var CF_BIN = process.env.CLOUDFLARED || "cloudflared";
var READY_BUDGET_MS = Number(process.env.READY_BUDGET_MS) || 45e3;
var PUBLIC_BUDGET_MS = Number(process.env.PUBLIC_BUDGET_MS) || 4e4;
var SKIP_PUB = process.env.SKIP_PUBLIC_HEALTHCHECK === "1";
var log = (...a) => console.error("[runner]", ...a);
var engine = null;
var cf = null;
var stopAnnounce = null;
var stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  try {
    stopAnnounce && stopAnnounce();
  } catch {
  }
  try {
    cf && cf.kill("SIGTERM");
  } catch {
  }
  try {
    engine && engine.kill("SIGTERM");
  } catch {
  }
  setTimeout(() => process.exit(code), 1500).unref();
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}
function get(url, timeoutMs = 4e3) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.get(url, (res) => {
      let b = "";
      res.on("data", (d) => b += d);
      res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
  });
}
async function pollJson(url, budgetMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    try {
      const r = await get(url);
      if (r.status === 200 && JSON.parse(r.body).ok) return true;
    } catch {
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}
async function waitForBin(bin, budgetMs) {
  const t0 = Date.now();
  const present = () => {
    try {
      if (bin.includes("/")) return fs.existsSync(bin);
      return (process.env.PATH || "").split(":").some((d) => {
        try {
          return d && fs.existsSync(path.join(d, bin));
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  };
  while (!present() && Date.now() - t0 < budgetMs) await new Promise((r) => setTimeout(r, 300));
  return present();
}
async function main() {
  const PORT = process.env.PORT || String(await freePort());
  const enginePath = ["engine.bundle.mjs", "engine.mjs"].map((f) => path.join(HERE, f)).find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  log("engine entry: " + path.basename(enginePath));
  engine = spawn(process.execPath, [enginePath], {
    env: { ...process.env, PORT, HP_INMEM: "1", HOST: "127.0.0.1" },
    stdio: ["ignore", "inherit", "inherit"]
  });
  engine.on("exit", (c) => {
    log("engine exited", c);
    shutdown(1);
  });
  if (!await pollJson(`http://127.0.0.1:${PORT}/status`, 15e3)) {
    log("engine not ready");
    return shutdown(1);
  }
  log("engine ready on 127.0.0.1:" + PORT);
  if (!await waitForBin(CF_BIN, 45e3)) {
    log("cloudflared never appeared");
    return shutdown(1);
  }
  cf = spawn(
    CF_BIN,
    ["tunnel", "--url", `http://127.0.0.1:${PORT}`, "--no-autoupdate"],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let url = null;
  const onData = (d) => {
    const m = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i.exec(String(d));
    if (m && !url) {
      url = m[1];
      log("tunnel url " + url);
    }
  };
  cf.stdout.on("data", onData);
  cf.stderr.on("data", onData);
  cf.on("exit", (c) => {
    log("cloudflared exited", c);
    shutdown(1);
  });
  const t0 = Date.now();
  while (!url && Date.now() - t0 < READY_BUDGET_MS) await new Promise((r) => setTimeout(r, 300));
  if (!url) {
    log("no tunnel url in time");
    return shutdown(1);
  }
  if (!await pollJson(url + "/status", PUBLIC_BUDGET_MS)) {
    if (!SKIP_PUB) {
      log("public url did not health-check");
      return shutdown(1);
    }
    log("WARNING: public health-check failed but SKIP_PUBLIC_HEALTHCHECK=1 \u2014 announcing anyway (local-sim / broken resolver)");
  }
  console.log("RUNNER_URL=" + url);
  stopAnnounce = await announce({ room: ROOM, url, caps: { hls: true, range: true } });
  console.log("RUNNER_READY");
  if (HANDOFF_AT > 0) setTimeout(() => {
    log("handoff: stop announcing");
    try {
      stopAnnounce();
    } catch {
    }
  }, HANDOFF_AT * 1e3).unref();
  if (RUN_SECONDS > 0) setTimeout(() => {
    log("run window elapsed; draining");
    shutdown(0);
  }, RUN_SECONDS * 1e3).unref();
}
main().catch((e) => {
  console.error("[runner] fatal", e);
  shutdown(1);
});
