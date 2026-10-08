// Local preview of build-public output, including Brotli and byte-range headers.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const root = fs.realpathSync(option('--root', 'build/public-web'));
const build = JSON.parse(fs.readFileSync(path.join(root, 'BUILD.json'), 'utf8'));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
http.createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '') || 'index.html'; }
  catch { res.writeHead(400).end(); return; }
  const target = path.resolve(root, rel), relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { res.writeHead(404).end(); return; }
  const actual = fs.realpathSync(target), checked = path.relative(root, actual);
  if (checked.startsWith('..') || path.isAbsolute(checked)) { res.writeHead(403).end(); return; }
  const compressed = rel.startsWith(build.rtRoot) || rel.startsWith(`${build.dataRoot}public/sprites/`) || /\/web-(bundle\.pack|audio\.json|art\.json)$/.test(rel) || /\/audio\/.*\.(wav|aud)$/.test(rel);
  res.setHeader('Content-Type', mime[path.extname(target)] || 'application/octet-stream');
  res.setHeader('Cache-Control', rel === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable');
  if (compressed) res.setHeader('Content-Encoding', 'br');
  const size = fs.statSync(actual).size;
  let start = 0, end = size - 1;
  if (req.headers.range && !compressed) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
    if (!match) { res.writeHead(416).end(); return; }
    start = Number(match[1]); end = match[2] ? Number(match[2]) : end;
    if (start > end || end >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
    res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  res.setHeader('Accept-Ranges', compressed ? 'none' : 'bytes');
  res.setHeader('Content-Length', end - start + 1);
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(actual, { start, end }).pipe(res);
}).listen(Number(option('--port', '3507')), '127.0.0.1', () => console.log(`Static Web RTS: http://127.0.0.1:${option('--port', '3507')}/`));
