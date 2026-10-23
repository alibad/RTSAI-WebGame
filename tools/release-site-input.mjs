// Git-free, immutable build input for the website version already published.
// This is a dependency export, never a development checkout or a worktree.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const markerName = '.release-site-input.json';
function files(dir, prefix = '') {
  return fs.readdirSync(path.join(dir, prefix), { withFileTypes: true }).flatMap(e => {
    const rel = prefix ? prefix + '/' + e.name : e.name;
    if (!prefix && (e.name === 'node_modules' || e.name === markerName)) return [];
    return e.isDirectory() ? files(dir, rel) : [rel];
  });
}

export function verifySiteInput(dir) {
  if (fs.existsSync(path.join(dir, '.git'))) throw new Error('Published website input must be Git-free');
  const marker = JSON.parse(fs.readFileSync(path.join(dir, markerName), 'utf8'));
  if (marker.schema !== 1 || !/^[a-f0-9]{40}$/.test(marker.commit)) throw new Error('Invalid published website input identity');
  const actual = files(dir).sort(), expected = Object.keys(marker.files).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Published website input file list changed');
  for (const rel of actual) if (hash(path.join(dir, rel)) !== marker.files[rel]) throw new Error(`Published website input changed: ${rel}`);
  return marker;
}

export function publishedSiteInput(canonical, work, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid website commit');
  const dir = path.join(work, 'inputs', 'published-site-' + commit);
  if (!fs.existsSync(dir)) {
    const staging = dir + '.export-' + process.pid, tar = staging + '.tar';
    if (fs.existsSync(staging)) throw new Error(`Incomplete export preserved at ${staging}`);
    fs.mkdirSync(staging, { recursive: true });
    execFileSync('git', ['-C', canonical, 'archive', '--format=tar', '-o', tar, commit]);
    execFileSync(process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar', ['-xf', tar, '-C', staging]);
    const manifest = Object.fromEntries(files(staging).map(rel => [rel, hash(path.join(staging, rel))]));
    fs.writeFileSync(path.join(staging, markerName), JSON.stringify({ schema: 1, canonical, commit, files: manifest }, null, 2) + '\n');
    verifySiteInput(staging);
    fs.renameSync(staging, dir);
    fs.unlinkSync(tar);
  }
  const marker = verifySiteInput(dir);
  if (marker.commit !== commit || path.resolve(marker.canonical) !== path.resolve(canonical)) throw new Error('Published website input does not match its canonical source');
  let sharedDependencies = false;
  if (fs.existsSync(path.join(canonical, 'node_modules')) && hash(path.join(canonical, 'package-lock.json')) === hash(path.join(dir, 'package-lock.json'))) {
    const modules = path.join(dir, 'node_modules');
    if (!fs.existsSync(modules)) fs.symlinkSync(path.join(canonical, 'node_modules'), modules, process.platform === 'win32' ? 'junction' : 'dir');
    sharedDependencies = fs.realpathSync(modules) === fs.realpathSync(path.join(canonical, 'node_modules'));
  }
  return { dir, canonical, commit, frozen: true, sharedDependencies };
}
