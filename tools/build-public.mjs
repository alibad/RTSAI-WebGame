// Static production build of the public web game (the standalone mod: project art and audio only) for a static
// host or CDN. No server APIs: no private content, no co-commander (it needs the local companion), no native verify.
//   node tools/build-public.mjs [--out build/public-web] [--quality 11]
// Inputs: data/public (tools/pin-standalone.ps1 or tools/public.ps1) and its AOT runtime (data/public/wasm-aot).
// This only builds; deploying it needs the owner's approval (see docs/DEPLOY-PUBLIC.md).
//
// Layout and caching:
//   index.html                      revalidated (the only file that changes name-stably)
//   assets/*                        content-hashed by Vite: immutable
//   rt-<hash>/public/aot/_framework the .NET runtime, under a root named by its content hash: immutable
//   data-<hash>/public/...          bundle, sprite sheets, audio and art packs, likewise: immutable
// A returning player downloads index.html and nothing else until a new build.
//
// Compression: everything a browser reads whole is stored brotli-compressed (quality 11, large window) and served
// with Content-Encoding: br, so the browser inflates it natively. The audio and art packs are read by byte range and
// stay as they are.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import os from "node:os";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BROTLI = (quality, size) => ({ params: {
  [zlib.constants.BROTLI_PARAM_QUALITY]: quality, [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size } });

if (!isMainThread) {
  // Compression worker: brotli-compress files in place.
  for (const f of workerData.files) {
    const raw = fs.readFileSync(f);
    fs.writeFileSync(f, zlib.brotliCompressSync(raw, BROTLI(workerData.quality, raw.length)));
    parentPort.postMessage({ file: f, raw: raw.length });
  }
  process.exit(0);
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const out = path.resolve(repo, opt("out", "build/public-web"));
const quality = Number(opt("quality", 11));
const data = path.join(repo, "data", "public");
const framework = path.join(data, "wasm-aot", "wwwroot", "_framework");
for (const f of ["web-bundle.pack", "web-audio.pack", "web-audio.json", "web-art.pack", "web-art.json", "sprites/index.json", "wasm-aot/wwwroot/_framework/dotnet.js"])
  if (!fs.existsSync(path.join(data, f))) throw new Error(`missing ${path.join(data, f)}: run tools/public.ps1 and the public AOT publish first`);

const list = (d) => fs.readdirSync(d).map((f) => path.join(d, f)).filter((f) => fs.statSync(f).isFile());
const hashOf = (files) => {
  const h = crypto.createHash("sha256");
  for (const f of [...files].sort()) h.update(path.basename(f)).update(fs.readFileSync(f));
  return h.digest("hex").slice(0, 12);
};
const runtimeFiles = list(framework);
const dataFiles = [...["web-bundle.pack", "web-audio.pack", "web-audio.json", "web-art.pack", "web-art.json"].map((f) => path.join(data, f)), ...list(path.join(data, "sprites"))];
const rtRoot = `rt-${hashOf(runtimeFiles)}/`;
const dataRoot = `data-${hashOf(dataFiles)}/`;

// 1. The page (the standalone game by default, no source maps), pointing at the hashed roots.
// Never remove the checkout, a source directory, or a drive root through --out.
const root = path.parse(out).root;
const isAncestor = (parent, child) => { const rel = path.relative(parent, child); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); };
if (out === root || isAncestor(out, repo) || isAncestor(out, data) || isAncestor(path.join(repo, "web"), out))
  throw new Error(`Unsafe output directory: ${out}`);
if (fs.existsSync(out)) {
  if (!fs.existsSync(path.join(out, "BUILD.json"))) throw new Error(`Output exists without a public-build marker: ${out}`);
  fs.rmSync(out, { recursive: true, force: true });
}
execSync(`npx vite build --outDir "${out}" --emptyOutDir`, {
  cwd: path.join(repo, "web"), stdio: "inherit",
  env: { ...process.env, VITE_DEFAULT_PROFILE: "public", RTSAI_PUBLIC_BUILD: "1", VITE_STATIC_BUILD: "1", VITE_RT_BASE: rtRoot, VITE_DATA_BASE: dataRoot },
});

// 2. Runtime and data at the paths the worker requests.
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); return to; };
const precompress = [];
for (const f of runtimeFiles) precompress.push(copy(f, path.join(out, rtRoot, "public", "aot", "_framework", path.basename(f))));
for (const f of dataFiles) {
  const rel = path.relative(data, f);
  if (/web-audio\.(pack|json)$/.test(f)) continue; // written as single files below
  const to = copy(f, path.join(out, dataRoot, "public", rel));
  if (!/web-art\.pack$/.test(f)) precompress.push(to);
}

// Audio as single files (instead of byte ranges of web-audio.pack): plain immutable GETs, so the browser caches them
// and a returning player downloads no sound again; WAVs are stored brotli-compressed. The index tells the worker.
{
  const index = JSON.parse(fs.readFileSync(path.join(data, "web-audio.json"), "utf8"));
  const pack = fs.readFileSync(path.join(data, "web-audio.pack"));
  for (const f of index.files) {
    const rel = "audio/" + f.path.replace(/^mods\/rtsai\//, "");
    const to = path.join(out, dataRoot, "public", rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, pack.subarray(f.offset, f.offset + f.size));
    if (/\.(wav|aud)$/i.test(rel)) precompress.push(to);
    f.file = rel;
    delete f.offset;
  }
  const to = path.join(out, dataRoot, "public", "web-audio.json");
  fs.writeFileSync(to, JSON.stringify(index));
  precompress.push(to);
}

// 3. Brotli (in parallel workers; quality 11 on ~600 MB of raw sheets and runtime takes a while).
const rawSizes = new Map();
{
  const lanes = Math.max(1, Math.min(os.cpus().length - 2, 12));
  const bySize = [...precompress].sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  const parts = Array.from({ length: lanes }, () => []);
  bySize.forEach((f, i) => parts[i % lanes].push(f));
  await Promise.all(parts.filter((p) => p.length).map((files) => new Promise((resolve, reject) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { files, quality } });
    w.on("message", (m) => rawSizes.set(m.file, m.raw));
    w.on("error", reject);
    w.on("exit", resolve);
  })));
}

// 4. Header rules. COOP/COEP make the page cross-origin isolated (SharedArrayBuffer for the snapshot ring); every
// subresource is same-origin, so require-corp needs nothing else.
const isolation = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];
const immutable = { key: "Cache-Control", value: "public, max-age=31536000, immutable" };
const br = { key: "Content-Encoding", value: "br" };
const rtGlob = `/${rtRoot}`, dataGlob = `/${dataRoot}public`;
const vercel = {
  $schema: "https://openapi.vercel.sh/vercel.json",
  headers: [
    { source: "/(.*)", headers: isolation },
    { source: "/", headers: [{ key: "Cache-Control", value: "no-cache" }] },
    { source: "/index.html", headers: [{ key: "Cache-Control", value: "no-cache" }] },
    { source: "/assets/(.*)", headers: [immutable] },
    { source: `${rtGlob}(.*)`, headers: [immutable, br] },
    { source: `${dataGlob}/sprites/(.*)`, headers: [immutable, br, { key: "Content-Type", value: "application/octet-stream" }] },
    { source: `${dataGlob}/web-bundle.pack`, headers: [immutable, br, { key: "Content-Type", value: "application/octet-stream" }] },
    { source: `${dataGlob}/(web-audio|web-art).json`, headers: [immutable, br] },
    { source: `${dataGlob}/web-art.pack`, headers: [immutable, { key: "Content-Type", value: "application/octet-stream" }] },
    { source: `${dataGlob}/audio/(.*)`, headers: [immutable] },
    { source: `${dataGlob}/audio/(.*)\.(wav|aud)`, headers: [br, { key: "Content-Type", value: "application/octet-stream" }] },
  ],
};
fs.writeFileSync(path.join(out, "vercel.json"), JSON.stringify(vercel, null, 2) + "\n");
fs.writeFileSync(path.join(out, "_headers"), [
  "/*", ...isolation.map((h) => `  ${h.key}: ${h.value}`),
  "/index.html", "  Cache-Control: no-cache",
  "/assets/*", `  ${immutable.key}: ${immutable.value}`,
  `${rtGlob}*`, `  ${immutable.key}: ${immutable.value}`, `  ${br.key}: ${br.value}`,
  `${dataGlob}/sprites/*`, `  ${immutable.key}: ${immutable.value}`, `  ${br.key}: ${br.value}`, "  Content-Type: application/octet-stream",
  `${dataGlob}/web-bundle.pack`, `  ${immutable.key}: ${immutable.value}`, `  ${br.key}: ${br.value}`, "  Content-Type: application/octet-stream",
  `${dataGlob}/web-audio.json`, `  ${immutable.key}: ${immutable.value}`, `  ${br.key}: ${br.value}`,
  `${dataGlob}/web-art.json`, `  ${immutable.key}: ${immutable.value}`, `  ${br.key}: ${br.value}`,
  `${dataGlob}/audio/*`, `  ${immutable.key}: ${immutable.value}`,
  `${dataGlob}/audio/*.wav`, `  ${br.key}: ${br.value}`, "  Content-Type: application/octet-stream",
  `${dataGlob}/audio/*.aud`, `  ${br.key}: ${br.value}`, "  Content-Type: application/octet-stream",
  `${dataGlob}/web-art.pack`, `  ${immutable.key}: ${immutable.value}`, "  Content-Type: application/octet-stream",
  "",
].join("\n"));

// 5. What was built: sizes on disk (raw) and over the wire (as stored: brotli, or raw for the range-read packs).
const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name)); };
walk(out);
const groups = {};
for (const f of files) {
  const rel = path.relative(out, f).replace(/\\/g, "/");
  const group = rel.startsWith("rt-") ? "runtime (AOT)" : rel.includes("/sprites/") ? "sprite sheets" : rel.includes("web-audio.pack") ? "audio (range)"
    : rel.includes("web-art") ? "art (range)" : rel.includes("/audio/") ? "audio (files)" : rel.startsWith("data-") ? "game data" : "page";
  const wire = fs.statSync(f).size;
  const raw = rawSizes.get(f) ?? wire;
  const g = (groups[group] ??= { files: 0, raw: 0, wire: 0 });
  g.files++; g.raw += raw; g.wire += wire;
}
const mb = (n) => (n / 1048576).toFixed(1);
let sha = "";
try { sha = execSync("git -C ../RTSAI-Mod-wt-web-public rev-parse HEAD", { cwd: repo }).toString().trim(); } catch { /* not a checkout */ }
const index = JSON.parse(fs.readFileSync(path.join(data, "sprites", "index.json"), "utf8"));
const build = { builtAt: new Date().toISOString(), standalone: sha, bundleId: index.bundle, rtRoot, dataRoot, brotliQuality: quality, groups };
fs.writeFileSync(path.join(out, "BUILD.json"), JSON.stringify(build, null, 2) + "\n");
console.log(`\n${out}  (${rtRoot}, ${dataRoot})`);
for (const [k, g] of Object.entries(groups)) console.log(`  ${k.padEnd(16)} ${String(g.files).padStart(4)} files  ${mb(g.raw).padStart(7)} MB raw  ${mb(g.wire).padStart(7)} MB stored / over the wire`);
