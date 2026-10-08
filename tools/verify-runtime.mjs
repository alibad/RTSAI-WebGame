// Verify .NET WebAssembly publish resource integrity. --repair regenerates hashes from the final published
// payloads after incremental AOT/IL stripping; integrity checking stays enabled in the browser.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const args = process.argv.slice(2);
const root = path.resolve(args.find(a => !a.startsWith('--')) ?? 'data/public/wasm-aot/wwwroot/_framework');
const boot = path.join(root, 'dotnet.js');
const source = fs.readFileSync(boot, 'utf8');
const begin = source.indexOf('/*json-start*/') + '/*json-start*/'.length, end = source.indexOf('/*json-end*/');
if (begin < 14 || end <= begin) throw new Error('Embedded runtime configuration not found.');
const config = JSON.parse(source.slice(begin, end));
let checked = 0; const mismatches = [];
for (const entries of Object.values(config.resources).filter(Array.isArray)) for (const entry of entries) {
  if (!entry.hash || !entry.name) continue;
  const file = path.resolve(root, entry.name);
  if (!file.startsWith(root + path.sep)) throw new Error('Resource outside publish directory.');
  const hash = 'sha256-' + crypto.createHash('sha256').update(fs.readFileSync(file)).digest('base64'); checked++;
  if (hash !== entry.hash) { mismatches.push(entry.name); if (args.includes('--repair')) entry.hash = hash; }
}
if (mismatches.length && args.includes('--repair')) {
  config.resources.hash = 'sha256-' + crypto.createHash('sha256').update(JSON.stringify(config.resources)).digest('base64');
  fs.writeFileSync(boot, source.slice(0, begin) + JSON.stringify(config, null, 2) + source.slice(end));
}
console.log(JSON.stringify({ checked, mismatches, repaired: mismatches.length > 0 && args.includes('--repair') }));
if (mismatches.length && !args.includes('--repair')) process.exitCode = 1;
