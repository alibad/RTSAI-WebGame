// Static production build of the public web game (the standalone mod: project art and audio only) for a static
// host or CDN. Lays out the page, the AOT runtime and the data exactly as the page requests them, and writes header
// rules (COOP/COEP for SharedArrayBuffer, caching, MIME) for Vercel (vercel.json) and Netlify/Cloudflare Pages
// (_headers). No server APIs: no private content, no co-commander (it needs the local companion), no native verify.
//   node tools/build-public.mjs [--out build/public-web]
// Inputs: data/public (tools/pin-standalone.ps1 or tools/public.ps1) and its AOT runtime (data/public/wasm-aot).
// This only builds; deploying it needs the owner's approval (see docs/DEPLOY-PUBLIC.md).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const out = path.resolve(repo, opt("out", "build/public-web"));
const data = path.join(repo, "data", "public");
const framework = path.join(data, "wasm-aot", "wwwroot", "_framework");
for (const f of ["web-bundle.pack", "web-audio.pack", "web-audio.json", "web-art.pack", "web-art.json", "sprites/index.json", "../public/wasm-aot/wwwroot/_framework/dotnet.js"])
  if (!fs.existsSync(path.join(data, f))) throw new Error(`missing ${path.join(data, f)}: run tools/public.ps1 and the public AOT publish first`);

// 1. The page (the standalone game by default, no source maps).
fs.rmSync(out, { recursive: true, force: true });
execSync(`npx vite build --outDir "${out}" --emptyOutDir`, {
  cwd: path.join(repo, "web"), stdio: "inherit", env: { ...process.env, VITE_DEFAULT_PROFILE: "public", RTSAI_PUBLIC_BUILD: "1" },
});

// 2. Data and runtime, at the paths the worker requests (data/public/..., rt/public/aot/_framework/...).
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
for (const f of ["web-bundle.pack", "web-audio.pack", "web-audio.json", "web-art.pack", "web-art.json"]) copy(path.join(data, f), path.join(out, "data", "public", f));
for (const f of fs.readdirSync(path.join(data, "sprites"))) copy(path.join(data, "sprites", f), path.join(out, "data", "public", "sprites", f));
for (const f of fs.readdirSync(framework)) copy(path.join(framework, f), path.join(out, "rt", "public", "aot", "_framework", f));

// 3. Header rules. COOP/COEP make the page cross-origin isolated (SharedArrayBuffer for the snapshot ring); every
// subresource is same-origin, so require-corp needs nothing else. Hashed page assets are immutable; data and runtime
// keep stable names, so they revalidate (ETag) instead.
const isolation = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];
const vercel = {
  $schema: "https://openapi.vercel.sh/vercel.json",
  headers: [
    { source: "/(.*)", headers: isolation },
    { source: "/assets/(.*)", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
    { source: "/(data|rt)/(.*)", headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }] },
    { source: "/(.*)\\.pack", headers: [{ key: "Content-Type", value: "application/octet-stream" }] },
  ],
};
fs.writeFileSync(path.join(out, "vercel.json"), JSON.stringify(vercel, null, 2) + "\n");
fs.writeFileSync(path.join(out, "_headers"), [
  "/*", ...isolation.map((h) => `  ${h.key}: ${h.value}`),
  "/assets/*", "  Cache-Control: public, max-age=31536000, immutable",
  "/data/*", "  Cache-Control: public, max-age=0, must-revalidate",
  "/rt/*", "  Cache-Control: public, max-age=0, must-revalidate",
  "/*.pack", "  Content-Type: application/octet-stream", "",
].join("\n"));

// 4. What was built: sizes on disk and over the wire (brotli for what a CDN compresses; the lazily range-read packs
// and the gzip sprite sheets go as they are).
const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name)); };
walk(out);
const rangeRead = (f) => /web-(audio|art)\.pack$|\.gz$/.test(f);
const groups = {};
for (const f of files) {
  const rel = path.relative(out, f).replace(/\\/g, "/");
  const group = rel.startsWith("rt/") ? "runtime (AOT)" : rel.startsWith("data/public/sprites") ? "sprite sheets" : rel.includes("web-audio") ? "audio (range)" : rel.includes("web-art") ? "art (range)" : rel.startsWith("data/") ? "game data" : "page";
  const raw = fs.statSync(f).size;
  const wire = rangeRead(f) || raw < 1024 ? raw : zlib.brotliCompressSync(fs.readFileSync(f), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }).length;
  const g = (groups[group] ??= { files: 0, raw: 0, wire: 0 });
  g.files++; g.raw += raw; g.wire += wire;
}
const mb = (n) => (n / 1048576).toFixed(1);
let sha = "";
try { sha = execSync("git -C ../RTSAI-Mod-wt-web-public rev-parse HEAD", { cwd: repo }).toString().trim(); } catch { /* not a checkout */ }
const build = { builtAt: new Date().toISOString(), standalone: sha, bundleId: fs.readFileSync(path.join(data, "sprites", "index.json"), "utf8").match(/"bundle":\s*"([^"]+)"/)?.[1], groups };
fs.writeFileSync(path.join(out, "BUILD.json"), JSON.stringify(build, null, 2) + "\n");
console.log(`\n${out}`);
for (const [k, g] of Object.entries(groups)) console.log(`  ${k.padEnd(16)} ${String(g.files).padStart(4)} files  ${mb(g.raw).padStart(7)} MB on disk  ${mb(g.wire).padStart(7)} MB over the wire (full download)`);
