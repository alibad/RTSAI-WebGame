// rtsai.net on one local origin, for end-to-end tests that cross the website and the game (sign-in, the Earth studio's
// "Play in browser", /api/event): the website's dev server (RTSAI-Web, with the Firebase emulators) at /, this repo's
// static frontend build at /play/, and the published runtime and data (rt-*/, data-*/) fetched once and cached on disk:
// from the Cloudflare CDN, where the roots have lived since 13 October, else from rtsai-play on Vercel (older roots).
// /play/ gets the same cross-origin isolation headers as production. A build whose VITE_RT_BASE / VITE_DATA_BASE are
// /play/rt-<hash>/ and /play/data-<hash>/ then loads everything from this one origin.
//   node tools/local-site-server.mjs <frontend dist> [port=3530] [website port=3476]
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";

const dist = path.resolve(process.argv[2] ?? "dist"), port = Number(process.argv[3] || 3530), sitePort = Number(process.argv[4] || 3476);
const upstreams = ["rtsai-play-cdn.pages.dev", "rtsai-play.vercel.app"];
const cacheDir = path.join(os.tmpdir(), "rtsai-play-cache");
fs.mkdirSync(cacheDir, { recursive: true });
const isolation = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "same-origin" };
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".mp4": "video/mp4", ".vtt": "text/vtt", ".webp": "image/webp", ".woff2": "font/woff2" };

function fetchFrom(host, p, range) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path: p, headers: { "accept-encoding": "br", ...(range ? { range } : {}) } }, res => {
      const chunks = []; res.on("data", c => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject); req.end();
  });
}

/** The first upstream that has the file. Cloudflare answers a missing path with its placeholder page (200, HTML). */
async function fetchUpstream(p, range) {
  let r;
  for (const host of upstreams) {
    r = await fetchFrom(host, p, range);
    const placeholder = String(r.headers["content-type"] || "").startsWith("text/html") && !p.endsWith(".html");
    if ((r.status === 200 || r.status === 206) && !placeholder) return r;
  }
  return { ...r, status: 404 };
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x"), p = decodeURIComponent(url.pathname);
  try {
    if (p === "/play") { res.writeHead(308, { Location: "/play/" + url.search }); return res.end(); }
    if (!p.startsWith("/play/")) {
      const proxy = http.request({ hostname: "localhost", port: sitePort, path: req.url, method: req.method, headers: { ...req.headers, host: `localhost:${sitePort}` } }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      proxy.on("error", e => { res.writeHead(502); res.end(String(e)); }); req.pipe(proxy); return;
    }
    const game = p.slice("/play".length);
    if (/^\/(rt|data)-[0-9a-f]+\//.test(game)) {
      const range = req.headers.range, key = crypto.createHash("sha1").update(game + "|" + (range || "")).digest("hex");
      const file = path.join(cacheDir, key), meta = file + ".json";
      let r;
      if (fs.existsSync(meta)) r = { ...JSON.parse(fs.readFileSync(meta, "utf8")), body: fs.readFileSync(file) };
      else {
        r = await fetchUpstream(game, range);
        if (r.status === 200 || r.status === 206) { fs.writeFileSync(file, r.body); fs.writeFileSync(meta, JSON.stringify({ status: r.status, headers: r.headers })); }
      }
      const h = { ...isolation };
      for (const k of ["content-type", "content-encoding", "content-range", "accept-ranges", "cache-control"]) if (r.headers[k]) h[k] = r.headers[k];
      h["content-length"] = r.body.length;
      res.writeHead(r.status, h); return res.end(r.body);
    }
    let f = path.join(dist, game === "/" ? "index.html" : game.slice(1));
    if (!f.startsWith(dist) || !fs.existsSync(f) || !fs.statSync(f).isFile()) f = path.join(dist, "index.html");
    res.writeHead(200, { ...isolation, "Content-Type": MIME[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-cache" });
    fs.createReadStream(f).pipe(res);
  } catch (e) { res.writeHead(502); res.end(String(e)); }
}).listen(port, "127.0.0.1", () => console.log(`local rtsai.net http://127.0.0.1:${port}/ (game ${dist} at /play/, website :${sitePort})`));
