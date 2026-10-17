// Shared Studio/Play/desktop candidate. Local only; never modifies the release registration.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const pointer = path.resolve(repo, '../RTSAI-Mod/.recovery/content-current.json');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export function readContentBuild() {
  if (!fs.existsSync(pointer)) return null;
  const ref = JSON.parse(fs.readFileSync(pointer, 'utf8'));
  const bytes = fs.readFileSync(ref.receipt);
  if (hash(bytes) !== ref.sha256) throw Error('Shared content receipt changed. Build and verify again in Studio.');
  const build = JSON.parse(bytes);
  if (!build.verified || !build.verification?.passed || build.verification.targets.length !== 4) throw Error('Shared content has not passed all four targets.');
  return { ...build, receipt: ref.receipt };
}
export async function startContentBuild() {
  const build = readContentBuild();
  if (!build) return null;
  const saved = JSON.parse(fs.readFileSync(path.resolve(repo, '../RTSAI-Mod/mods/rtsai/unit-overrides/manifest.json'), 'utf8'));
  if (saved.revision !== build.revision) throw Error('New content is saved. Build and verify it in Studio before starting a new game.');
  for (const entry of build.checksums) {
    const digest = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(entry.path)) digest.update(chunk);
    if (digest.digest('hex') !== entry.sha256) throw Error(`Shared content build changed: ${entry.path}`);
  }
  const url = new URL(build.webUrl);
  const probe = async () => {
    try { const r = await fetch(new URL('api/content-status', url), { signal: AbortSignal.timeout(2000) }); return r.ok ? await r.json() : null; } catch { return null; }
  };
  let active = await probe();
  if (!active) {
    const env = JSON.parse(fs.readFileSync(path.join(path.dirname(build.receipt), 'server-env.json'), 'utf8'));
    const stdout = fs.openSync(path.join(path.dirname(build.receipt), 'web-server-restart.log'), 'a');
    const child = spawn(process.execPath, [build.serverFile], { cwd: repo, detached: true, windowsHide: true,
      env: { ...process.env, ...env }, stdio: ['ignore', stdout, stdout] });
    fs.closeSync(stdout); child.unref();
    for (let i = 0; i < 100; i++) {
      active = await probe(); if (active) break;
      await new Promise(r => setTimeout(r, 200));
    }
  }
  if (active?.buildId !== build.buildId || active?.revision !== build.revision) throw Error('Local content port belongs to another build; it was left untouched.');
  return { buildId: build.buildId, revision: build.revision, verified: true, url: build.webUrl };
}
