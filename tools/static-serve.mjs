// A plain static host for the public build (tools/build-public.mjs), behaving like a CDN: the build's own header
// rules (_headers), ETag revalidation, byte ranges, brotli for compressible content. No game APIs. Used to test and
// measure the build exactly as a static deployment would serve it.
//   node tools/static-serve.mjs [--dir build/public-web] [--port 3491] [--prefix /play] [--throttle 9000,170]
// --throttle <kbit/s>,<ms>: a shared downlink of that capacity for every response (all connections together, the way
// one household link is shared) and that much latency before each response starts: a network profile applied at the
// server, so it covers the page, its worker and every lazy range read alike.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { Transform } from "node:stream";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const dir = path.resolve(repo, opt("dir", "build/public-web"));
const port = Number(opt("port", 3491));
const prefix = opt("prefix", "");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm",
  ".svg": "image/svg+xml", ".png": "image/png", ".dat": "application/octet-stream", ".pack": "application/octet-stream", ".gz": "application/octet-stream" };

// _headers: "/pattern" lines followed by indented "Key: value" lines.
const rules = [];
for (const line of fs.readFileSync(path.join(dir, "_headers"), "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  if (!/^\s/.test(line)) rules.push({ re: new RegExp("^" + line.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"), headers: [] });
  else { const i = line.indexOf(":"); rules.at(-1).headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]); }
}
const compressed = new Map();

const [kbps, latency] = (opt("throttle", "") || "0,0").split(",").map(Number);
let budgetAt = 0; // the shared link is busy until this time (ms)
function shaped() {
  if (!kbps) return null;
  const bytesPerMs = kbps * 1000 / 8 / 1000;
  return new Transform({
    transform(chunk, _enc, done) {
      // Serialise on the shared link: this chunk goes out after everything already queued on it.
      const now = Date.now();
      budgetAt = Math.max(budgetAt, now) + chunk.length / bytesPerMs;
      setTimeout(() => done(null, chunk), Math.max(0, budgetAt - now));
    },
  });
}
// Bytes sent (GET /__stats returns and resets them: the measurement tools read the total a visit transferred).
let sent = 0, requests = 0;
const trace = argv.includes("--trace");
function send(res, body) {
  const n = typeof body === "string" ? fs.statSync(body).size : body.length;
  if (trace) console.log(`${res.statusCode} ${n} ${res.req.headers.range ?? ""} ${res.req.url} ${res.req.headers["if-none-match"] ? "(had etag)" : ""} ${res.req.headers["cache-control"] ?? ""}`);
  sent += n;
  requests++;
  const s = shaped();
  const src = typeof body === "string" ? fs.createReadStream(body) : null;
  if (!s) return src ? src.pipe(res) : res.end(body);
  s.pipe(res);
  if (src) src.pipe(s); else { for (let i = 0; i < body.length; i += 16384) s.write(body.subarray(i, i + 16384)); s.end(); }
}

// Compress up front (as a CDN serves from its cache), so the first request is not slowed by compression.
const all = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : all.push(path.join(d, e.name)); };
walk(dir);
for (const file of all) {
  const stat = fs.statSync(file);
  if (stat.size <= 1024 || /web-(audio|art)\.pack$|\.gz$|\.png$/.test(file)) continue;
  const etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
  compressed.set(file + etag, zlib.brotliCompressSync(fs.readFileSync(file), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }));
}

http.createServer((req, res) => setTimeout(() => handle(req, res), latency)).listen(port, "127.0.0.1", () =>
  console.log(`static public build: http://127.0.0.1:${port}${prefix}/ (${dir})${kbps ? `, throttled to ${kbps / 1000} Mbit/s and ${latency} ms` : ""}`));

function handle(req, res) {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/__stats") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ sent, requests }));
    sent = 0;
    requests = 0;
    return;
  }
  if (prefix && p.startsWith(prefix)) p = p.slice(prefix.length) || "/";
  if (p.endsWith("/")) p += "index.html";
  for (const r of rules) if (r.re.test(p)) for (const [k, v] of r.headers) res.setHeader(k, v);
  const file = path.normalize(path.join(dir, p));
  if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  const stat = fs.statSync(file);
  const etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
  res.setHeader("ETag", etag);
  if (!res.hasHeader("Content-Type")) res.setHeader("Content-Type", MIME[path.extname(file)] ?? "application/octet-stream");
  if (req.headers["if-none-match"] === etag) { res.writeHead(304); return res.end(); }
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
  if (range) {
    const start = Number(range[1]), end = Math.min(stat.size - 1, range[2] ? Number(range[2]) : stat.size - 1);
    res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": end - start + 1, "Accept-Ranges": "bytes" });
    const part = Buffer.alloc(end - start + 1);
    const fd = fs.openSync(file, "r");
    fs.readSync(fd, part, 0, part.length, start);
    fs.closeSync(fd);
    return send(res, part);
  }
  const compressible = stat.size > 1024 && !/web-(audio|art)\.pack$|\.gz$|\.png$/.test(file) && /\bbr\b/.test(req.headers["accept-encoding"] ?? "");
  if (compressible) {
    let buf = compressed.get(file + etag);
    if (!buf) { buf = zlib.brotliCompressSync(fs.readFileSync(file), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }); compressed.set(file + etag, buf); }
    res.writeHead(200, { "Content-Encoding": "br", "Content-Length": buf.length, Vary: "Accept-Encoding" });
    return send(res, buf);
  }
  res.writeHead(200, { "Content-Length": stat.size, "Accept-Ranges": "bytes" });
  send(res, file);
}
