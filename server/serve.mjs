// Local, private server for the RTS AI web game. Binds 127.0.0.1:3490 only.
//   node server/serve.mjs
// - Cross-origin isolation (COOP/COEP) so the page and worker can share a SharedArrayBuffer snapshot ring.
// - /rt/aot|interp/  the .NET WebAssembly runtime + assemblies (sim/OpenRA.WebSim.Browser publish output).
// - /data/           the public mod bundle (project + OpenRA files only).
// - /private/        LOCAL ONLY: the player's own RA2 files from %LOCALAPPDATA%\RTSAI-WebGame\private\files,
//                    served with byte ranges so the worker mounts them lazily. Refused for non-loopback clients,
//                    never bundled into web/dist, never committed.
// - /api/verify      replays the browser session natively (same host code, CoreCLR) and compares SyncHashes.
// Everything also answers under /play/... so the local app's gateway can proxy this server on one origin.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCompanion } from "./companion.mjs";

const PORT = Number(process.env.RTSAI_WEBGAME_PORT ?? 3490);
const HOST = "127.0.0.1";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(repo, "web", "dist");
const data = path.join(repo, "data");
const appData = path.join(process.env.LOCALAPPDATA ?? os.homedir(), "RTSAI-WebGame");
const privateDir = path.join(appData, "private");
const privateFiles = path.join(privateDir, "files");
const scratch = process.env.RTSAI_WEB_SCRATCH ?? path.join(appData, "scratch");
const brDir = path.join(appData, "brotli-cache");
const websim = path.join(repo, "bin", "OpenRA.WebSim.Native", "Release", "net10.0", "websim.exe");
const runtimes = { interp: path.join(data, "wasm-interp", "wwwroot"), aot: path.join(data, "wasm-aot", "wwwroot") };
// The public profile (standalone mod, project art only) has its own bundle and runtimes under data/public.
const profiles = { public: path.join(data, "public") };
// Runtime variants (size experiments, e.g. ?runtime=aot-lean) live next to the default builds as wasm-<variant>.
const runtimeDir = (profile, runtime) => path.join(profile ? profiles[profile] : data, `wasm-${runtime}`, "wwwroot");

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".wasm": "application/wasm", ".map": "application/json", ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".webp": "image/webp", ".ogg": "audio/ogg", ".wav": "audio/wav", ".mp3": "audio/mpeg",
  ".pack": "application/octet-stream", ".dat": "application/octet-stream", ".pdb": "application/octet-stream",
};

// ---------------------------------------------------------------- compression (cached on disk, warmed at start)

const brMemo = new Map(); // file -> { key, buf }

function brKey(file, stat) {
  return crypto.createHash("sha1").update(`${file}|${stat.size}|${stat.mtimeMs}`).digest("hex");
}

function compressed(file, stat) {
  const key = brKey(file, stat);
  const hit = brMemo.get(file);
  if (hit && hit.key === key) return hit.buf;
  const disk = path.join(brDir, key + ".br");
  let buf;
  if (fs.existsSync(disk)) buf = fs.readFileSync(disk);
  else {
    buf = zlib.brotliCompressSync(fs.readFileSync(file), {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: stat.size },
    });
    fs.mkdirSync(brDir, { recursive: true });
    fs.writeFileSync(disk, buf);
  }
  brMemo.set(file, { key, buf });
  return buf;
}

function warmCompression() {
  const files = [];
  const walk = (d) => { if (fs.existsSync(d)) for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name)); };
  for (const profile of ["", ...Object.keys(profiles)]) {
    walk(path.join(runtimeDir(profile, "aot"), "_framework"));
    walk(path.join(runtimeDir(profile, "interp"), "_framework"));
    const pack = path.join(profile ? profiles[profile] : data, "web-bundle.pack");
    if (fs.existsSync(pack)) files.unshift(pack);
  }
  let i = 0;
  const next = () => {
    if (i >= files.length) return;
    const f = files[i++];
    try { const st = fs.statSync(f); if (st.size > 1024) compressed(f, st); } catch { /* ignore */ }
    setImmediate(next);
  };
  next();
}

// ---------------------------------------------------------------- responses

function isolationHeaders(res) {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

/**
 * Static file with ETag revalidation (the browser keeps the runtime and bundles and re-downloads only when they
 * change), brotli for compressible content, byte ranges for uncompressed content.
 */
function sendFile(req, res, file, { compress = true, immutable = false } = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error("not a file");
  } catch {
    res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" });
    res.end("not found");
    return;
  }
  const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304);
    res.end();
    return;
  }

  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && !compress) {
    let start = range[1] === "" ? stat.size - Number(range[2]) : Number(range[1]);
    let end = range[1] === "" || range[2] === "" ? stat.size - 1 : Number(range[2]);
    start = Math.max(0, start);
    end = Math.min(stat.size - 1, end);
    if (start > end) {
      res.writeHead(416, { "content-range": `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, { "content-type": type, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${stat.size}`, "accept-ranges": "bytes" });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }

  const accepts = /\bbr\b/.test(req.headers["accept-encoding"] ?? "");
  if (compress && accepts && stat.size > 1024) {
    const buf = compressed(file, stat);
    res.writeHead(200, { "content-type": type, "content-encoding": "br", "content-length": buf.length, vary: "accept-encoding", "x-raw-length": stat.size });
    res.end(req.method === "HEAD" ? undefined : buf);
    return;
  }
  res.writeHead(200, { "content-type": type, "content-length": stat.size, "accept-ranges": compress ? "none" : "bytes" });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
}

function safeJoin(root, rel) {
  const p = path.normalize(path.join(root, decodeURIComponent(rel)));
  return p === root || p.startsWith(root + path.sep) ? p : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, obj, status = 200) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: repo, env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}

const isLocal = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");

// ---------------------------------------------------------------- private content (local only)

/** Files the worker mounts lazily: [{ path (relative to support/Content/ra2), size }]. */
function privateManifest() {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push({ path: r, size: fs.statSync(path.join(d, e.name)).size });
    }
  };
  if (fs.existsSync(privateFiles)) walk(privateFiles, "");
  return out;
}

// ---------------------------------------------------------------- native SyncHash verification

let lastYield = 0;
function gpuYieldLine() {
  // Shared-box etiquette: native comparison runs are CPU-only (Null platform), but announce them anyway.
  if (Date.now() - lastYield < 3600_000) return;
  lastYield = Date.now();
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const line = `${stamp} RTS AI web game (native headless SyncHash replay): CPU-only Null-platform OpenRA runs, no GPU, up to 60 min\n`;
  try { fs.appendFileSync("C:\\Users\\Admin\\Code\\AI\\logs\\gpu-yield.txt", line); } catch { /* optional */ }
}

async function verify(req, res) {
  const body = JSON.parse(await readBody(req));
  const browserHashes = body.log.hashes;
  fs.mkdirSync(scratch, { recursive: true });
  const id = Date.now();
  const scenarioFile = path.join(scratch, `verify-${id}.scenario.json`);
  const logFile = path.join(scratch, `verify-${id}.browser.json`);
  const hashFile = path.join(scratch, `verify-${id}.native.hashes`);
  fs.writeFileSync(scenarioFile, JSON.stringify(body.scenario));
  fs.writeFileSync(logFile, JSON.stringify(body.log));

  // The native twin of the page's profile, on a VFS root rebuilt whenever the bundle changes (as tools/fidelity.mjs).
  const profile = body.profile === "public" ? "public" : "";
  const twin = profile ? websim.replace("OpenRA.WebSim.Native", `OpenRA.WebSim.Native-${profile}`) : websim;
  const root = path.join(scratch, `vfs-native${profile ? "-" + profile : ""}`);
  const stamp = root + ".stamp";
  const pack = path.join(profile ? profiles[profile] : data, "web-bundle.pack");
  const want = String(fs.statSync(pack).mtimeMs);
  if (!fs.existsSync(root) || !fs.existsSync(stamp) || fs.readFileSync(stamp, "utf8") !== want) {
    fs.rmSync(root, { recursive: true, force: true });
    const r = await run(twin, ["unpack", "--pack", pack, "--root", root, ...(profile ? [] : ["--private", path.join(privateDir, "ra2-all.pack")])]);
    if (r.code !== 0) return json(res, { error: r.out.slice(-2000) });
    fs.writeFileSync(stamp, want);
  }

  gpuYieldLine();
  const t0 = Date.now();
  const r = await run(twin, ["run", "--root", root, "--scenario", scenarioFile, "--replay", logFile, "--ticks", String(browserHashes.length), "--hashes", hashFile],
    { OPENRA_AI_HOST: "0" });
  if (r.code !== 0) return json(res, { error: r.out.slice(-2000) });
  const native = fs.readFileSync(hashFile, "utf8").trim().split(/\r?\n/).map((l) => Number(l.split(" ")[1]));
  const n = Math.min(native.length, browserHashes.length);
  let firstMismatch = -1;
  for (let i = 0; i < n; i++) if (native[i] !== browserHashes[i]) { firstMismatch = i + 1; break; }
  const result = {
    match: firstMismatch < 0 && n > 0, compared: n, firstMismatch, nativeMs: Date.now() - t0,
    browserRuntime: body.log.runtime, packets: Object.keys(body.log.packets).length, files: { scenarioFile, logFile, hashFile },
  };
  fs.appendFileSync(path.join(data, "verify.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n");
  // A mismatch keeps its files (the scenario, the browser's orders and hashes, the native hashes) for diagnosis.
  if (result.match) for (const f of [scenarioFile, logFile, hashFile]) try { fs.unlinkSync(f); } catch { /* keep going */ }
  json(res, result);
}

// ---------------------------------------------------------------- routes

// The AI co-commander's local mode (gRPC facade for the companion, WebSocket relay to the game, its HTTP API).
const companion = createCompanion({ repo, appData });

const server = http.createServer(async (req, res) => {
  isolationHeaders(res);
  const url = new URL(req.url, `http://${req.headers.host}`);
  let p = url.pathname;
  if (p === "/play") p = "/";
  else if (p.startsWith("/play/")) p = p.slice(5);
  try {
    if (p === "/api/verify" && req.method === "POST") return await verify(req, res);
    if (p === "/api/health") {
      return json(res, {
        ok: true, private: fs.existsSync(privateFiles), runtimes: Object.keys(runtimes).filter((k) => fs.existsSync(runtimes[k])),
        profiles: Object.fromEntries(Object.keys(profiles).map((pr) => [pr, Object.keys(runtimes).filter((k) => fs.existsSync(runtimeDir(pr, k)))])),
      });
    }
    if (p.startsWith("/api/companion/") || p.startsWith("/companion/")) {
      if (!isLocal(req)) return res.writeHead(403).end("local only");
      if (p === "/api/companion/status") return json(res, companion.status());
      if (p === "/api/companion/start" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        try { return json(res, await companion.start(body.mode)); } catch (e) { return json(res, { error: String(e.message ?? e), ...companion.status() }, 500); }
      }
      if (p === "/api/companion/stop" && req.method === "POST") { companion.stop(url.searchParams.get("all") === "1"); return json(res, companion.status()); }
      if (p.startsWith("/companion/api/")) return companion.proxy(req, res, p.slice("/companion/api/".length) + url.search);
      return res.writeHead(404).end();
    }
    if (p === "/api/metrics" && req.method === "POST") {
      fs.appendFileSync(path.join(data, "metrics.jsonl"), (await readBody(req)).trim() + "\n");
      return json(res, { ok: true });
    }
    const rt = p.match(/^\/rt\/(?:(public)\/)?((?:interp|aot)(?:-[a-z]+)?)\/(.*)$/);
    if (rt) {
      const f = safeJoin(runtimeDir(rt[1], rt[2]), rt[3]);
      return f ? sendFile(req, res, f) : res.writeHead(400).end();
    }
    if (p.startsWith("/data/")) {
      const f = safeJoin(data, p.slice(6));
      if (!f || !/\.(pack|json|gz|bin)$/.test(f) || /(measure|fidelity|verify|metrics)/.test(f)) return res.writeHead(404).end();
      // The audio pack is read by byte range (lazily, per sound), so it is served uncompressed; prebaked sprite
      // sheets (sprites/*.gz) are already compressed.
      return sendFile(req, res, f, { compress: !/web-(audio|art)\.pack$|\.gz$/.test(f) });
    }
    if (p.startsWith("/private/")) {
      if (!isLocal(req)) return res.writeHead(403).end("local only");
      res.setHeader("Cache-Control", "no-store");
      if (p === "/private/manifest.json") return json(res, { files: privateManifest() });
      if (p.startsWith("/private/files/")) {
        const f = safeJoin(privateFiles, p.slice("/private/files/".length));
        return f ? sendFile(req, res, f, { compress: false }) : res.writeHead(400).end();
      }
      return res.writeHead(404).end();
    }
    if (p.startsWith("/scenarios/")) {
      const f = safeJoin(path.join(repo, "scenarios"), p.slice(11));
      return f ? sendFile(req, res, f, { compress: false }) : res.writeHead(400).end();
    }
    const rel = p === "/" ? "index.html" : p.slice(1);
    const f = safeJoin(dist, rel);
    if (f && fs.existsSync(f) && fs.statSync(f).isFile()) return sendFile(req, res, f, { immutable: rel.startsWith("assets/") });
    return sendFile(req, res, path.join(dist, "index.html"));
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(e?.stack ?? e));
  }
});

// The game's side of the co-commander relay (the worker), local only.
server.on("upgrade", (req, socket) => {
  const p = new URL(req.url, "http://x").pathname.replace(/^\/play(?=\/)/, "");
  if (p === "/companion/bridge" && isLocal(req)) companion.upgrade(req, socket);
  else socket.destroy();
});

server.listen(PORT, HOST, () => {
  console.log(`RTS AI web game: http://${HOST}:${PORT}/  (private RA2 files: ${fs.existsSync(privateFiles) ? "available" : "missing"})`);
  warmCompression();
});
