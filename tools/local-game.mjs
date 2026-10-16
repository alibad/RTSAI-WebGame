// One entry for the accepted local web build. Never guesses payloads or kills a port owner.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const state = path.resolve(process.env.RTSAI_LOCAL_LAUNCHER_DIR ?? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'RTSAI-WebGame', 'launcher'));
const registry = path.join(state, 'current.json');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const hashFile = async file => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
const atomicJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temp, file);
};
function git(...args) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim(); }
function serverIdentity() {
  const files = fs.readdirSync(path.join(repo, 'server')).filter(name => name.endsWith('.mjs')).sort();
  return sha(Buffer.concat(files.map(name => Buffer.concat([Buffer.from(name), fs.readFileSync(path.join(repo, 'server', name))]))));
}

export async function verifyAcceptedBuild(config) {
  if (config.schema !== 1 || !Number.isInteger(config.port) || config.port < 1024 || config.port > 60531) throw new Error('Invalid local launcher registration or reserved companion ports');
  const bytes = fs.readFileSync(config.receipt);
  if (sha(bytes) !== config.receiptSha256) throw new Error('Accepted-build receipt changed. Register a newly verified build explicitly.');
  const receipt = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (receipt.variant !== 'original-countries' || !receipt.checksums?.length || receipt.buildId !== config.buildId) throw new Error('Wrong accepted game variant');
  if (git('branch', '--show-current') !== 'main') throw new Error('Launch from canonical main; a feature checkout cannot select the local game.');
  const source = receipt.sources?.['RTSAI-WebGame']?.head;
  if (!source) throw new Error('Missing accepted source identity');
  git('merge-base', '--is-ancestor', source, 'main');
  if (!config.scenarios || !config.scenarioFiles?.length) throw new Error('Accepted scenarios are not frozen; register this build again.');
  for (const entry of config.scenarioFiles) if (await hashFile(entry.path) !== entry.sha256) throw new Error(`Accepted scenario changed: ${entry.path}`);
  const entries = new Map(receipt.checksums.map(entry => [path.resolve(entry.path).toLowerCase(), entry.sha256]));
  const required = [path.join(config.page, 'index.html'), path.join(config.page, 'build-local.json'), path.join(config.page, 'NOTICE')];
  for (const profile of ['public', 'public-classic']) {
    required.push(...['web-bundle.pack', 'web-art.json', 'web-art.pack', 'web-audio.json', 'web-audio.pack', 'sprites/index.json', 'wasm-aot/wwwroot/_framework/runtime-identity.json'].map(name => path.join(config.data, profile, name)));
  }
  for (const file of required) if (!entries.has(path.resolve(file).toLowerCase())) throw new Error(`Receipt does not cover the selected payload: ${file}`);
  for (const entry of receipt.checksums) if (await hashFile(entry.path) !== entry.sha256) throw new Error(`Accepted build changed: ${entry.path}. Refusing to open a mixed build.`);
  const page = read(path.join(config.page, 'build-local.json'));
  if (page.buildId !== receipt.buildId || page.runtime !== receipt.runtime) throw new Error('Page and runtime receipt do not match');
  for (const profile of ['public', 'public-classic']) {
    const runtime = read(path.join(config.data, profile, 'wasm-aot/wwwroot/_framework/runtime-identity.json'));
    if (runtime.identity !== receipt.runtime) throw new Error(`Mismatched ${profile} runtime`);
  }
  const content = read(path.join(config.data, 'public/content-profile.json'));
  if (!content.originalCountryArt || !content.originalCountryVoices) throw new Error('Original-country assets missing');
  const twin = path.join(config.native, 'bin/OpenRA.WebSim.Native-public/Release/net10.0/websim.dll');
  if (!fs.existsSync(twin) || await hashFile(twin) !== config.nativeSha256) throw new Error('Native replay host changed or is missing');
  for (const entry of config.nativeFiles ?? []) if (await hashFile(entry.path) !== entry.sha256) throw new Error(`Native replay dependency changed: ${entry.path}`);
  return { receipt, receiptSha256: sha(bytes), serverSha256: serverIdentity() };
}

async function probe(port) {
  try { const response = await fetch(`http://127.0.0.1:${port}/api/local-build`, { signal: AbortSignal.timeout(2000), cache: 'no-store' }); return response.ok ? await response.json() : null; } catch { return null; }
}
async function portBusy(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}
function matching(active, config, identity, port) {
  return active?.buildId === config.buildId && active.receiptSha256 === identity.receiptSha256 && active.serverSha256 === identity.serverSha256 && samePath(active.page, config.page) && samePath(active.data, config.data) && samePath(active.native, config.native) && active.scenarios && samePath(active.scenarios, config.scenarios) && active.grpcPort === port + 5000;
}
async function verifyHttp(port, config, identity) {
  const active = await probe(port);
  if (!matching(active, config, identity, port)) throw new Error(`Port ${port} is serving another or unverified build. It has been left untouched.`);
  for (const [url, file] of [['/', path.join(config.page, 'index.html')], ['/build-local.json', path.join(config.page, 'build-local.json')], ['/rt/public/aot/_framework/runtime-identity.json', path.join(config.data, 'public/wasm-aot/wwwroot/_framework/runtime-identity.json')]]) {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
    if (!response.ok || sha(Buffer.from(await response.arrayBuffer())) !== await hashFile(file)) throw new Error(`Server payload does not match the accepted build: ${url}`);
  }
  for (const name of ['skirmish-originals.json', 'skirmish-classic.json']) {
    const response = await fetch(`http://127.0.0.1:${port}/scenarios/${name}`, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
    if (!response.ok || sha(Buffer.from(await response.arrayBuffer())) !== await hashFile(path.join(config.scenarios, name))) throw new Error(`Server is using different scenario inputs: ${name}`);
  }
  return active;
}
async function locked(action) {
  fs.mkdirSync(state, { recursive: true });
  const lock = path.join(state, 'launch.lock');
  for (let attempt = 0; attempt < 150; attempt++) {
    try { const fd = fs.openSync(lock, 'wx'); fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = Number(fs.readFileSync(lock, 'utf8')); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      if (owner) { try { process.kill(owner, 0); } catch (e) { if (e.code === 'ESRCH') { fs.unlinkSync(lock); continue; } } }
      if (attempt === 149) throw new Error('Another launcher is still checking the game. Try again when it completes.');
      await pause(200);
    }
  }
  try { return await action(); } finally { fs.unlinkSync(lock); }
}

export async function startAcceptedBuild(config, { port = config.port } = {}) {
  const identity = await verifyAcceptedBuild(config);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
  if (await portBusy(port)) {
    await verifyHttp(port, config, identity);
  } else {
    if (port + 5004 > 65535) throw new Error('Invalid port or reserved companion ports');
    const stdout = fs.openSync(path.join(state, `server-${port}.log`), 'a');
    const stderr = fs.openSync(path.join(state, `server-${port}.err.log`), 'a');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', '--port', String(port)], {
      cwd: repo, detached: true, windowsHide: true, stdio: ['ignore', stdout, stderr],
      env: { ...process.env, RTSAI_LOCAL_LAUNCHER_DIR: state, RTSAI_LOCAL_LAUNCH_ID: crypto.randomUUID(), RTSAI_EXPECTED_REGISTRATION: sha(fs.readFileSync(registry)) },
    });
    fs.closeSync(stdout); fs.closeSync(stderr); child.unref();
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await probe(port)) { ready = true; break; }
      await pause(200);
    }
    if (!ready) throw new Error(`Accepted build did not start. See ${state}/server-${port}.err.log`);
    const active = await verifyHttp(port, config, identity);
    atomicJson(path.join(state, `server-${port}.json`), active);
  }
  return { buildId: config.buildId, url: `http://127.0.0.1:${port}/?profile=public&mode=skirmish`, source: identity.receipt.sources['RTSAI-WebGame'].head, currentMain: git('rev-parse', 'main') };
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'launch';
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  if (command === 'register') {
    if (!args.includes('--receipt') || !args.includes('--page') || !args.includes('--data') || !args.includes('--native')) throw new Error('Registration requires --receipt, --page, --data and --native');
    const receipt = path.resolve(option('--receipt'));
    const config = { schema: 1, buildId: read(receipt).buildId, receipt, receiptSha256: await hashFile(receipt), page: path.resolve(option('--page')), data: path.resolve(option('--data')), native: path.resolve(option('--native')), port: Number(option('--port', '38664')) };
    const nativeDir = path.join(config.native, 'bin/OpenRA.WebSim.Native-public/Release/net10.0');
    config.nativeSha256 = await hashFile(path.join(nativeDir, 'websim.dll'));
    config.nativeFiles = [];
    for (const file of fs.readdirSync(nativeDir, { recursive: true })) {
      const absolute = path.join(nativeDir, file);
      if (fs.statSync(absolute).isFile()) config.nativeFiles.push({ path: absolute, sha256: await hashFile(absolute) });
    }
    const source = read(receipt).sources['RTSAI-WebGame'].head;
    config.scenarios = path.join(state, 'inputs', config.buildId, 'scenarios');
    config.scenarioFiles = [];
    for (const rel of git('ls-tree', '-r', '--name-only', source, '--', 'scenarios').split('\n').filter(Boolean)) {
      const contents = execFileSync('git', ['-C', repo, 'show', `${source}:${rel}`], { windowsHide: true });
      const file = path.join(config.scenarios, path.relative('scenarios', rel));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file) && await hashFile(file) !== sha(contents)) throw new Error(`Frozen scenario was modified: ${file}`);
      fs.writeFileSync(file, contents);
      config.scenarioFiles.push({ path: file, sha256: sha(contents) });
    }
    await verifyAcceptedBuild(config);
    if (fs.existsSync(registry)) fs.copyFileSync(registry, path.join(state, `previous-${Date.now()}.json`));
    atomicJson(registry, config);
    console.log(`Registered accepted build ${config.buildId}. No server or browser was opened.`);
    return;
  }
  if (!fs.existsSync(registry)) throw new Error('No accepted local game registered. See docs/LOCAL-GAME.md; refusing to guess build folders.');
  const config = read(registry);
  if (command === 'serve') {
    if (!process.env.RTSAI_EXPECTED_REGISTRATION || sha(fs.readFileSync(registry)) !== process.env.RTSAI_EXPECTED_REGISTRATION) throw new Error('Registration changed while starting');
    const identity = await verifyAcceptedBuild(config);
    const port = Number(option('--port', String(config.port)));
    // Older previews may still own the historical bridge port. Never attach this game's AI to that bridge.
    if (port + 5004 > 65535 || await portBusy(port + 5000)) throw new Error('The accepted game companion bridge port is unavailable; no fallback bridge was used.');
    Object.assign(process.env, {
      RTSAI_WEBGAME_PORT: String(port), RTSAI_WEB_DIST: config.page, RTSAI_WEB_DATA: config.data, RTSAI_WEB_BUILD: config.native,
      RTSAI_WEB_SCRATCH: path.join(state, 'scratch', config.buildId), RTSAI_WEB_BR_CACHE: path.join(state, 'compression', config.buildId),
      RTSAI_WEB_SCENARIOS: config.scenarios,
      RTSAI_WEB_COMPANION_GRPC: String(port + 5000), RTSAI_WEB_COMPANION_PORT: String(port + 5001),
      RTSAI_WEB_MOCK_AI_PORT: String(port + 5003), RTSAI_WEB_LOCAL_AI_PORT: String(port + 5004),
      RTSAI_VERIFIED_LOCAL_BUILD: JSON.stringify({ buildId: config.buildId, receiptSha256: identity.receiptSha256, serverSha256: identity.serverSha256, page: config.page, data: config.data, native: config.native, scenarios: config.scenarios, grpcPort: port + 5000, pid: process.pid, launchId: process.env.RTSAI_LOCAL_LAUNCH_ID }),
    });
    delete process.env.RTSAI_MAP_MOD_ROOT; delete process.env.RTSAI_MAP_OUTPUT_ROOT; delete process.env.RTSAI_SITE_PUBLIC;
    await import(pathToFileURL(path.join(repo, 'server/serve.mjs')).href);
    return;
  }
  if (command === 'verify') { await verifyAcceptedBuild(config); console.log(`Verified ${config.buildId}`); return; }
  if (!['launch', 'start'].includes(command)) throw new Error('Use register, verify, start or launch');
  const result = await locked(() => startAcceptedBuild(config, { port: Number(option('--port', String(config.port))) }));
  console.log(JSON.stringify(result));
  if (command === 'launch' && !args.includes('--no-open')) {
    if (process.platform === 'win32') {
      const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', result.url], { detached: true, windowsHide: true, stdio: 'ignore' }); child.unref();
    } else throw new Error(`Open the verified game: ${result.url}`);
  }
}
if (process.argv[1] && samePath(fileURLToPath(import.meta.url), process.argv[1])) main().catch(error => { console.error(error.message); process.exitCode = 1; });
