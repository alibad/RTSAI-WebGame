// Download-size report: raw and brotli (quality 11) for the runtime, page and mod bundle.
//   node tools/sizes.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const br = (buf) => zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24 } }).length;

const groups = {
  "runtime (interpreter)": path.join(repo, "data", "wasm-interp", "wwwroot", "_framework"),
  "runtime (AOT)": path.join(repo, "data", "wasm-aot", "wwwroot", "_framework"),
  "page (web/dist)": path.join(repo, "web", "dist"),
  "mod bundle": path.join(repo, "data", "web-bundle.pack"),
};
const out = {};
for (const [name, p] of Object.entries(groups)) {
  if (!fs.existsSync(p)) continue;
  const files = fs.statSync(p).isDirectory() ? walk(p).filter((f) => !f.endsWith(".map")) : [p];
  let raw = 0, comp = 0;
  for (const f of files) {
    const b = fs.readFileSync(f);
    raw += b.length;
    comp += br(b);
  }
  out[name] = { files: files.length, rawMB: +(raw / 1048576).toFixed(1), brotliMB: +(comp / 1048576).toFixed(1) };
  console.log(name, JSON.stringify(out[name]));
}
fs.writeFileSync(path.join(repo, "data", "sizes.json"), JSON.stringify(out, null, 1));
