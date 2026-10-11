// The AI co-commander for the browser game, local mode. The companion (OpenRA-AI services/companion, Python)
// expects to reach the game over gRPC (rl_bridge.proto); in the browser the game runs in a Web Worker, so this
// module bridges the two:
//
//   companion --gRPC (h2c, 127.0.0.1:9988)--> this server --WebSocket /companion/bridge--> worker --> CompanionBridge
//
// Each RPC's protobuf request is relayed to the worker as is and answered by the mod's own CompanionBridge in the
// engine; nothing is translated. The companion's HTTP API (ask, transcribe, speak, confirm/cancel) is proxied at
// /companion/api/ so the page stays same-origin (COOP/COEP). It also starts and stops the companion process, with a
// mock AI gateway (mock-ai.mjs) when no local models are running. Loopback only.

import crypto from "node:crypto";
import { trustedLocalRequest } from "./local-boundary.mjs";
import fs from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import zlib from "node:zlib";
import { startMockGateway } from "./mock-ai.mjs";

export const GRPC_PORT = Number(process.env.RTSAI_WEB_COMPANION_GRPC ?? 9988);
export const CONTROL_PORT = Number(process.env.RTSAI_WEB_COMPANION_PORT ?? 8797);
const MOCK_PORT = Number(process.env.RTSAI_WEB_MOCK_AI_PORT ?? 4010);
// The product's local AI stack (OpenRA-AI ai/: llama.cpp + Qwen3-VL 2B, whisper.cpp base.en, Kokoro), served by its
// own gateway (openra_ai_companion.local_runtime) on ports apart from the desktop game's 4000-4002.
const LOCAL_GATEWAY_PORT = Number(process.env.RTSAI_WEB_LOCAL_AI_PORT ?? 4020);
// Optional: an already running OpenAI-compatible gateway for local mode (e.g. the machine's GPU models) instead of
// the product's CPU runtime. It must serve local-coder, local-whisper and local-kokoro.
const EXTERNAL_GATEWAY = process.env.RTSAI_WEB_AI_GATEWAY ?? "";
// Diagnostics: every companion output line, time-stamped, appended to this file (state polling left out).
const COMPANION_LOG = process.env.RTSAI_WEB_COMPANION_LOG ?? "";
const CALL_TIMEOUT_MS = 10_000;
const GRPC_CODES = { UNAVAILABLE: 14, DEADLINE_EXCEEDED: 4, UNIMPLEMENTED: 12, INTERNAL: 13 };

// ---------------------------------------------------------------- WebSocket (RFC 6455, server side, minimal)

class Socket {
  constructor(raw, onMessage, onClose) {
    this.raw = raw;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.closed = false;
    raw.on("data", (d) => this.data(d));
    raw.on("close", () => { this.closed = true; onClose(); });
    raw.on("error", () => raw.destroy());
    this.onMessage = onMessage;
  }

  data(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      if (this.buf.length < 2) return;
      const fin = (this.buf[0] & 0x80) !== 0, op = this.buf[0] & 0x0f, masked = (this.buf[1] & 0x80) !== 0;
      let len = this.buf[1] & 0x7f, p = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); p = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); p = 10; }
      if (!masked || !Number.isSafeInteger(len) || len > 8 * 1024 * 1024 || this.fragments.reduce((n, f) => n + f.length, 0) + len > 8 * 1024 * 1024) return this.raw.destroy();
      const need = p + (masked ? 4 : 0) + len;
      if (this.buf.length < need) return;
      let payload = this.buf.subarray(p + (masked ? 4 : 0), need);
      if (masked) {
        const key = this.buf.subarray(p, p + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
      }
      this.buf = this.buf.subarray(need);
      if (op === 8) { this.frame(8, Buffer.alloc(0)); this.raw.end(); return; }
      if (op === 9) { this.frame(10, payload); continue; }
      if (op === 10) continue;
      this.fragments.push(payload);
      if (fin) {
        const message = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
        this.fragments = [];
        try { this.onMessage(message); } catch { this.raw.destroy(); return; }
      }
    }
  }

  frame(op, payload) {
    if (this.closed) return;
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    if (n >= 126 && n < 65536) { head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(n, 2); }
    else if (n >= 65536) { head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
    this.raw.write(Buffer.concat([head, payload]));
  }

  send(binary) { this.frame(2, binary); }
}

/** Relay frame: u32 LE header length, the header (JSON), then the protobuf payload. */
function pack(header, payload = Buffer.alloc(0)) {
  const h = Buffer.from(JSON.stringify(header));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(h.length);
  return Buffer.concat([len, h, payload]);
}

function unpack(buf) {
  if (buf.length < 4) throw new Error("Invalid relay frame");
  const n = buf.readUInt32LE(0);
  if (n > 65536 || n > buf.length - 4) throw new Error("Invalid relay header");
  return { header: JSON.parse(buf.subarray(4, 4 + n).toString("utf8")), payload: buf.subarray(4 + n) };
}

// ---------------------------------------------------------------- relay

export function createCompanion({ repo, appData, log = console.log }) {
  let worker = null; // the connected game's worker (one match at a time: the latest connection wins)
  let nextId = 1;
  const pending = new Map();
  const stats = { calls: 0, errors: 0, byMethod: {}, replyBytes: {}, connectedAt: 0, lastCallAt: 0,
    observations: { frames: 0, wireBytes: 0, fullBytes: 0, servedFromCache: 0 } };
  // The latest observation the game pushed (rebuilt in full), and the spatial map it was diffed against.
  let observation = null, spatial = null;

  function relay(method, request) {
    return new Promise((resolve, reject) => {
      if (!worker) return reject(Object.assign(new Error("No browser game with the co-commander is connected."), { code: GRPC_CODES.UNAVAILABLE }));
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error(`${method} timed out (is the game paused?)`), { code: GRPC_CODES.DEADLINE_EXCEEDED }));
      }, CALL_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      worker.send(pack({ t: "call", id, method }, request));
    });
  }

  /**
   * An observation frame from the game: the observation without its spatial map (deflated), then the spatial map as
   * a deflated XOR against the previous one (kind 1) or in full (kind 0). Rebuilt here into the exact GameObservation
   * bytes: the message plus field 10 appended (a protobuf field may come last; it is the only copy).
   */
  function onObservation(payload) {
    const liteLength = payload.readUInt32LE(0);
    const lite = zlib.inflateRawSync(payload.subarray(4, 4 + liteLength));
    const kind = payload[4 + liteLength];
    let map = zlib.inflateRawSync(payload.subarray(5 + liteLength));
    if (kind === 1) {
      if (!spatial || spatial.length !== map.length) return; // out of step: wait for a full one
      for (let i = 0; i < map.length; i++) map[i] ^= spatial[i];
    }
    spatial = map;
    const len = [];
    for (let n = map.length; ; n = Math.floor(n / 128)) { if (n < 128) { len.push(n); break; } len.push((n % 128) | 128); }
    observation = { at: Date.now(), bytes: map.length ? Buffer.concat([lite, Buffer.from([0x52, ...len]), map]) : lite };
    stats.observations.frames++;
    stats.observations.wireBytes += payload.length;
    stats.observations.fullBytes += observation.bytes.length;
  }

  function onWorkerMessage(buf) {
    const { header, payload } = unpack(buf);
    if (header.t === "obs") return onObservation(payload);
    if (header.t !== "reply") return;
    const p = pending.get(header.id);
    if (!p) return;
    pending.delete(header.id);
    clearTimeout(p.timer);
    if (header.code === 0) p.resolve(Buffer.from(payload));
    else p.reject(Object.assign(new Error(header.message || "error"), { code: header.code }));
  }

  /** Upgrade handler for /companion/bridge (the worker's side of the relay). */
  function upgrade(req, raw) {
    if (!trustedLocalRequest(req, req.socket.localPort, { requireOrigin: true })) return raw.destroy();
    const key = req.headers["sec-websocket-key"];
    if (!key) return raw.destroy();
    const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    raw.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    raw.setNoDelay(true);
    worker?.raw?.destroy();
    for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error("The game was replaced."), { code: GRPC_CODES.UNAVAILABLE })); pending.delete(id); }
    const sock = new Socket(raw, buf => { if (worker === sock) onWorkerMessage(buf); }, () => {
      if (worker !== sock) return;
      worker = null;
      for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error("The game disconnected."), { code: GRPC_CODES.UNAVAILABLE })); pending.delete(id); }
    });
    worker = sock;
    observation = null;
    spatial = null;
    stats.connectedAt = Date.now();
    log("co-commander: game connected");
  }

  // gRPC facade (HTTP/2 cleartext, prior knowledge, as grpcio's insecure channel speaks it).
  const grpc = http2.createServer();
  grpc.on("stream", (stream, headers) => {
    const m = /^\/openra\.rl\.RLBridge\/(\w+)$/.exec(headers[":path"] ?? "");
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("error", () => {});
    stream.on("end", async () => {
      const fail = (code, message) => {
        if (stream.destroyed || stream.closed) return;
        stream.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": String(code), "grpc-message": encodeURIComponent(message) }, { endStream: true });
      };
      if (!m) return fail(GRPC_CODES.UNIMPLEMENTED, "unknown method");
      // Observe: answered from the observation the game pushed, when it is recent (no round trip to the game).
      if (m[1] === "Observe" && worker && observation && Date.now() - observation.at < 2000) {
        stats.observations.servedFromCache++;
        stats.calls++;
        stats.byMethod.Observe = (stats.byMethod.Observe ?? 0) + 1;
        stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
        stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
        const prefix = Buffer.alloc(5);
        prefix.writeUInt32BE(observation.bytes.length, 1);
        stream.end(Buffer.concat([prefix, observation.bytes]));
        return;
      }
      const body = Buffer.concat(chunks);
      if (body.length >= 5 && body[0] !== 0) return fail(GRPC_CODES.UNIMPLEMENTED, "compressed messages are not supported");
      const request = body.length >= 5 ? body.subarray(5, 5 + body.readUInt32BE(1)) : Buffer.alloc(0);
      stats.calls++;
      stats.lastCallAt = Date.now();
      stats.byMethod[m[1]] = (stats.byMethod[m[1]] ?? 0) + 1;
      try {
        const reply = await relay(m[1], request);
        stats.replyBytes[m[1]] = reply.length; // the latest size, e.g. one observation
        if (stream.destroyed || stream.closed) return;
        stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
        stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
        const prefix = Buffer.alloc(5);
        prefix.writeUInt32BE(reply.length, 1);
        stream.end(Buffer.concat([prefix, reply]));
      } catch (e) {
        stats.errors++;
        fail(e.code ?? GRPC_CODES.INTERNAL, String(e.message ?? e));
      }
    });
  });
  grpc.on("error", (e) => log(`co-commander: gRPC facade error ${e.message}`));
  grpc.listen(GRPC_PORT, "127.0.0.1", () => log(`co-commander: gRPC facade on 127.0.0.1:${GRPC_PORT}`));

  // ---------------------------------------------------------------- the companion process

  const openraAi = process.env.RTSAI_OPENRA_AI ?? path.resolve(repo, "..", "OpenRA-AI");
  const python = process.env.RTSAI_COMPANION_PYTHON ?? path.join(openraAi, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  let proc = null, mode = "", mock = null, runtime = null;
  let startGeneration = 0, starting = null, startingMode = "";
  const output = [];

  function start(requested) {
    const want = requested === "mock" ? "mock" : "local";
    if (proc && mode === want) return Promise.resolve(status());
    if (starting && startingMode === want) return starting;
    stop();
    const generation = startGeneration; startingMode = want;
    starting = startSession(want, generation).finally(() => { if (generation === startGeneration) { starting = null; startingMode = ""; } });
    return starting;
  }

  async function startSession(want, generation) {
    const current = () => { if (generation !== startGeneration) throw new Error("Cancelled companion start"); };
    if (!fs.existsSync(python)) throw new Error(`companion not installed (${python})`);
    const env = { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", OPENRA_AI_HOSTED_ENABLED: "0", OPENRA_AI_MODEL_PROVIDER: "local", OPENRA_AI_ROOT: openraAi, OPENRA_AI_CATALOG: path.join(openraAi, "catalog", "factions.json"), OPENAI_AGENTS_DISABLE_TRACING: "1" };
    if (want === "mock") {
      // A scripted stand-in for the local AI gateway (no GPU, no model downloads), isolated settings.
      mock ??= await startMockGateway(MOCK_PORT);
      current();
      env.OPENRA_AI_ROUTER_URL = `http://127.0.0.1:${MOCK_PORT}`;
      env.OPENRA_AI_LOCAL_ROUTER_URL = env.OPENRA_AI_ROUTER_URL;
      env.OPENRA_AI_DATA_DIR = path.join(appData, "companion-mock");
    } else {
      // The local models: the product's runtime gateway, started here with its own settings and ports.
      env.OPENRA_AI_DATA_DIR = process.env.OPENRA_AI_DATA_DIR ?? path.join(appData, "companion-local");
      fs.mkdirSync(env.OPENRA_AI_DATA_DIR, { recursive: true });
      Object.assign(env, {
        OPENRA_AI_MODEL_PROVIDER: "local", OPENRA_AI_TEXT_MODEL: "local-coder", OPENRA_AI_VISION_MODEL: "local-coder",
        OPENRA_AI_TRANSCRIBE_MODEL: "local-whisper", OPENRA_AI_TTS_MODEL: "local-kokoro",
        OPENRA_AI_ROUTER_URL: EXTERNAL_GATEWAY || `http://127.0.0.1:${LOCAL_GATEWAY_PORT}`,
        OPENRA_AI_LOCAL_ROUTER_URL: EXTERNAL_GATEWAY || `http://127.0.0.1:${LOCAL_GATEWAY_PORT}`,
        OPENRA_AI_LOCAL_CHAT_PORT: String(LOCAL_GATEWAY_PORT + 1), OPENRA_AI_LOCAL_TRANSCRIBE_PORT: String(LOCAL_GATEWAY_PORT + 2),
        // Local models answer slower than the hosted route: allow them time.
        OPENRA_AI_ROUTER_TIMEOUT_SECONDS: process.env.OPENRA_AI_ROUTER_TIMEOUT_SECONDS ?? "60",
      });
      if (!EXTERNAL_GATEWAY && (!runtime || runtime.exitCode !== null)) {
        runtime = spawn(python, ["-m", "openra_ai_companion.local_runtime", "serve", "--root", openraAi, "--mode", "local",
          "--port", String(LOCAL_GATEWAY_PORT), "--parent-pid", String(process.pid)], { cwd: openraAi, env, windowsHide: true });
        const keepRt = (d) => { for (const line of String(d).split(/\r?\n/)) if (line.trim()) { output.push("[runtime] " + line); if (output.length > 200) output.shift(); } };
        runtime.stdout.on("data", keepRt);
        runtime.stderr.on("data", keepRt);
        log(`co-commander: local AI runtime started on :${LOCAL_GATEWAY_PORT}, pid ${runtime.pid}`);
        // llama.cpp and whisper.cpp load their models first (up to a few minutes on a cold disk).
        for (let i = 0; i < 360; i++) {
          current();
          if (runtime.exitCode !== null) throw new Error("the local AI runtime exited: " + output.slice(-5).join(" | "));
          if (await healthy(LOCAL_GATEWAY_PORT)) break;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }
    current();
    fs.mkdirSync(env.OPENRA_AI_DATA_DIR, { recursive: true });
    const args = ["watch", "--no-speak", "--bridge", `127.0.0.1:${GRPC_PORT}`, "--control-port", String(CONTROL_PORT),
      "--worldgen-port", String(CONTROL_PORT + 1), "--parent-pid", String(process.pid), "--interval", "0.5"];
    const child = spawn(python, ["-m", "openra_ai_companion.cli", ...args], { cwd: openraAi, env, windowsHide: true });
    proc = child;
    mode = want;
    output.length = 0;
    const keep = (d) => {
      for (const line of String(d).split(/\r?\n/)) {
        if (!line.trim()) continue;
        output.push(line);
        if (output.length > 200) output.shift();
        if (COMPANION_LOG && !line.includes("GET /v1/state")) fs.appendFileSync(COMPANION_LOG, `${new Date().toISOString()} ${line}\n`);
      }
    };
    proc.stdout.on("data", keep);
    proc.stderr.on("data", keep);
    proc.on("exit", (code) => { keep(`(companion exited with ${code})`); if (proc === child) proc = null; });
    log(`co-commander: companion started (${want}), pid ${proc.pid}`);
    // The control API answers once the companion has loaded (a few seconds).
    for (let i = 0; i < 60 && proc; i++) {
      if (await ping()) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    return status();
  }

  /** Stops the companion; `all` also stops the local AI runtime (its models stay loaded between games otherwise). */
  function stop(all = false) {
    startGeneration++; starting = null; startingMode = "";
    // With their children: the runtime's llama-server and whisper-server, the companion's tool server (on Windows
    // killing the parent alone leaves them running, with the models in memory).
    if (all && runtime) { killTree(runtime); runtime = null; }
    if (proc) killTree(proc);
    proc = null;
    mode = "";
  }

  function killTree(child) {
    if (!child || child.exitCode !== null) return;
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    else try { child.kill(); } catch { /* gone */ }
  }

  function healthy(port) {
    return new Promise((resolve) => {
      const r = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 1000 }, (res) => { res.resume(); resolve(res.statusCode < 500); });
      r.on("error", () => resolve(false));
      r.on("timeout", () => { r.destroy(); resolve(false); });
    });
  }

  function ping() {
    return new Promise((resolve) => {
      const r = http.get({ host: "127.0.0.1", port: CONTROL_PORT, path: "/health", timeout: 1000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
      r.on("error", () => resolve(false));
      r.on("timeout", () => { r.destroy(); resolve(false); });
    });
  }

  function status() {
    return { running: !!proc, mode, pid: proc?.pid ?? 0, localRuntime: runtime && runtime.exitCode === null ? runtime.pid : 0, gameConnected: !!worker, grpcPort: GRPC_PORT, controlPort: CONTROL_PORT, relay: stats, log: output.slice(-20) };
  }

  /** /companion/api/<path> -> the companion's HTTP API (ask, transcribe, speak, actions, control, state). */
  async function proxy(req, res, rest) {
    // Python's http.server reads Content-Length bodies only (no chunked encoding): buffer the request.
    const chunks = [];
    let length = 0;
    for await (const c of req) { length += c.length; if (length > 8 * 1024 * 1024) { res.writeHead(413); res.end(JSON.stringify({ error: "Request too large" })); return; } chunks.push(c); }
    const body = Buffer.concat(chunks);
    const upstream = http.request({
      host: "127.0.0.1", port: CONTROL_PORT, path: "/" + rest, method: req.method,
      headers: { "content-type": req.headers["content-type"] ?? "application/json", accept: req.headers.accept ?? "*/*", "content-length": body.length },
      timeout: 120_000,
    }, (up) => {
      const headers = { "content-type": up.headers["content-type"] ?? "application/octet-stream", "cache-control": "no-store" };
      if (up.headers["x-openra-ai-utterance"]) headers["x-openra-ai-utterance"] = up.headers["x-openra-ai-utterance"];
      res.writeHead(up.statusCode ?? 502, headers);
      up.pipe(res);
    });
    upstream.on("error", (e) => { if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "companion_unavailable", detail: e.message })); });
    upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
    upstream.end(body);
  }

  return { upgrade, start, stop, status, proxy };
}
