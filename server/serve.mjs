// Local, private dev server for the RTS AI web engine spike. Binds 127.0.0.1:3490 only.
//   node server/serve.mjs
// - Cross-origin isolation (COOP/COEP) so the page and worker can share a SharedArrayBuffer snapshot ring.
// - /rt/interp|aot/  the .NET WebAssembly runtime + assemblies (sim/OpenRA.WebSim.Browser publish output)
// - /data/           the public mod bundle (project + OpenRA files only)
// - /private/        LOCAL ONLY: the player's own RA2 packages from %LOCALAPPDATA%\RTSAI-WebGame\private.
//                    Never bundled into web/dist, never committed, refused for non-loopback clients.
// - /api/verify      replays the browser session natively (same host code, CoreCLR) and compares SyncHashes.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = 3490;
const HOST = "127.0.0.1";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(repo, "web", "dist");
const data = path.join(repo, "data");
const privateDir = path.join(process.env.LOCALAPPDATA ?? os.homedir(), "RTSAI-WebGame", "private");
const scratch = process.env.RTSAI_WEB_SCRATCH ?? path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "RTSAI-WebGame", "scratch");
const websim = path.join(repo, "bin", "OpenRA.WebSim.Native", "Release", "net10.0", "websim.exe");
const runtimes = { interp: path.join(data, "wasm-interp", "wwwroot"), aot: path.join(data, "wasm-aot", "wwwroot") };

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".wasm": "application/wasm", ".map": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".pack": "application/octet-stream", ".dat": "application/octet-stream", ".pdb": "application/octet-stream",
};

const brCache = new Map(); // file -> { mtimeMs, buf }

function compressed(file, stat) {
  const hit = brCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.buf;
  const quality = file.endsWith(".pack") ? 6 : 9;
  const buf = zlib.brotliCompressSync(fs.readFileSync(file), {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: stat.size },
  });
  brCache.set(file, { mtimeMs: stat.mtimeMs, buf });
  return buf;
}

function isolationHeaders(res) {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
}

function sendFile(req, res, file, { compress = true } = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error("not a file");
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const accepts = /\bbr\b/.test(req.headers["accept-encoding"] ?? "");
  if (compress && accepts && stat.size > 1024) {
    const buf = compressed(file, stat);
    res.writeHead(200, { "content-type": type, "content-encoding": "br", "content-length": buf.length, vary: "accept-encoding", "x-raw-length": stat.size });
    res.end(buf);
    return;
  }
  res.writeHead(200, { "content-type": type, "content-length": stat.size });
  fs.createReadStream(file).pipe(res);
}

function safeJoin(root, rel) {
  const p = path.normalize(path.join(root, decodeURIComponent(rel)));
  return p.startsWith(root) ? p : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
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

let lastYield = 0;
function gpuYieldLine() {
  // Shared-box etiquette: native comparison runs are CPU-only (Null platform), but announce them anyway.
  if (Date.now() - lastYield < 3600_000) return;
  lastYield = Date.now();
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const line = `${stamp} RTS AI web-engine spike (native headless SyncHash replay): CPU-only Null-platform OpenRA runs, no GPU, up to 60 min\n`;
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

  const root = path.join(scratch, "vfs-native");
  if (!fs.existsSync(root)) {
    const r = await run(websim, ["unpack", "--pack", path.join(data, "web-bundle.pack"), "--private", path.join(privateDir, "ra2-all.pack"), "--root", root]);
    if (r.code !== 0) return json(res, { error: r.out.slice(-2000) });
  }

  gpuYieldLine();
  const t0 = Date.now();
  const r = await run(websim, ["run", "--root", root, "--scenario", scenarioFile, "--replay", logFile, "--ticks", String(browserHashes.length), "--hashes", hashFile],
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
  json(res, result);
}

function json(res, obj) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  isolationHeaders(res);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (p === "/api/verify" && req.method === "POST") return await verify(req, res);
    if (p === "/api/metrics" && req.method === "POST") {
      fs.appendFileSync(path.join(data, "metrics.jsonl"), (await readBody(req)).trim() + "\n");
      return json(res, { ok: true });
    }
    const rt = p.match(/^\/rt\/(interp|aot)\/(.*)$/);
    if (rt) {
      const f = safeJoin(runtimes[rt[1]], rt[2]);
      return f ? sendFile(req, res, f) : res.writeHead(400).end();
    }
    if (p.startsWith("/data/")) {
      const f = safeJoin(data, p.slice(6));
      return f && f.endsWith(".pack") ? sendFile(req, res, f) : res.writeHead(404).end();
    }
    if (p.startsWith("/private/")) {
      const remote = req.socket.remoteAddress ?? "";
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) return res.writeHead(403).end("local only");
      const f = safeJoin(privateDir, p.slice(9));
      return f ? sendFile(req, res, f, { compress: false }) : res.writeHead(400).end();
    }
    if (p.startsWith("/scenarios/")) {
      const f = safeJoin(path.join(repo, "scenarios"), p.slice(11));
      return f ? sendFile(req, res, f, { compress: false }) : res.writeHead(400).end();
    }
    const f = safeJoin(dist, p === "/" ? "index.html" : p.slice(1));
    if (f && fs.existsSync(f) && fs.statSync(f).isFile()) return sendFile(req, res, f);
    return sendFile(req, res, path.join(dist, "index.html"));
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(e?.stack ?? e));
  }
});

server.listen(PORT, HOST, () => console.log(`RTS AI web engine spike: http://${HOST}:${PORT}/  (private RA2 content: ${fs.existsSync(privateDir) ? "available" : "missing"})`));
