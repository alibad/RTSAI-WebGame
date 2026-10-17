// Real old-tab/new-host regression for lazy audio offsets across local launcher promotions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
import { browserExecutable, browserArgs } from './browser-launch.mjs';

const out = path.resolve(process.env.RTSAI_TEST_OUT ?? 'artifacts/local-build-switch');
const port = Number(process.env.RTSAI_TEST_PORT ?? 38669);
const base = `http://127.0.0.1:${port}`;
const previous = process.env.RTSAI_TEST_PREVIOUS ?? 'D:/rtsai-release/music-player-20261016';
const current = process.env.RTSAI_TEST_CURRENT ?? 'D:/rtsai-release/music-seek-20261016';
const config = root => {
  const receipt = JSON.parse(fs.readFileSync(path.join(root, 'verification.json')));
  return { buildId: receipt.buildId, page: path.join(root, 'page'), data: path.join(root, 'data'),
    native: path.join(root, 'native'), scenarios: path.join(root, 'game-source-final/scenarios') };
};
const old = config(previous), next = config(current);
old.scenarios = path.join(previous, 'game-source/scenarios');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const wait = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(out, { recursive: true });
let child, browser;
const receipt = { old, next, cases: [], passed: false };
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill(); await exited; child = null;
}
async function start(build, history) {
  child = spawn(process.execPath, ['server/serve.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), windowsHide: true,
    env: { ...process.env, RTSAI_WEBGAME_PORT: String(port), RTSAI_WEB_DIST: build.page, RTSAI_WEB_DATA: build.data,
      RTSAI_WEB_BUILD: build.native, RTSAI_WEB_SCENARIOS: build.scenarios, RTSAI_WEB_SCRATCH: path.join(out, 'scratch'),
      RTSAI_WEB_BR_CACHE: path.join(process.env.LOCALAPPDATA, 'RTSAI-WebGame/launcher/compression', build.buildId),
      RTSAI_WEB_COMPANION_GRPC: String(port + 5000), RTSAI_WEB_COMPANION_PORT: String(port + 5001),
      RTSAI_VERIFIED_LOCAL_BUILD: JSON.stringify(build), RTSAI_LOCAL_BUILDS: JSON.stringify(history),
    }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => fs.appendFileSync(path.join(out, 'server.log'), b));
  child.stderr.on('data', b => fs.appendFileSync(path.join(out, 'server-error.log'), b));
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw Error('Fixture server exited');
    try { const r = await fetch(`${base}/api/local-build`); if (r.ok && (await r.json()).buildId === build.buildId) return; } catch {}
    await wait(100);
  }
  throw Error('Fixture server did not start');
}
try {
  // Never stop a port owner; fixtures only stop child handles they created themselves.
  try { await fetch(base, { signal: AbortSignal.timeout(800) }); throw Error(`Fixture port ${port} is occupied`); }
  catch (e) { if (String(e).includes('occupied')) throw e; }
  await start(old, []);
  browser = await chromium.launch({ executablePath: browserExecutable(), headless: true,
    args: [...browserArgs(), '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [], ranges = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('response', async res => {
    if (!res.url().includes('web-audio.pack')) return;
    ranges.push({ url: res.url(), range: res.request().headers().range, status: res.status() });
  });
  await page.goto(`${base}/?profile=public&runtime=aot&mode=skirmish`);
  assert.ok(page.url().includes(`/local-builds/${old.buildId}/`));
  await page.waitForFunction(() => ['setup', 'error'].includes(window.store?.getState().phase), null, { timeout: 240000 });
  assert.equal(await page.evaluate(() => window.store.getState().phase), 'setup');
  await page.evaluate(() => window.game.start(JSON.stringify({ map: 'web-arena', seed: 711,
    players: [{ slot: 'Multi0', faction: 'america', color: '2A6FDB' }, { slot: 'Multi1', faction: 'russia', color: 'D83A2E', bot: 'webidle' }],
    options: { explored: 'True', fog: 'False', crates: 'False', shortgame: 'False', startingunits: 'none' },
    spawns: [{ type: 'dog', player: 0, x: 24, y: 70 }, { type: 'gacnst', player: 0, x: 20, y: 60 }, { type: 'nacnst', player: 1, x: 70, y: 60 }] })));
  await page.waitForFunction(() => ['playing', 'error'].includes(window.store.getState().phase), null, { timeout: 180000 });
  assert.equal(await page.evaluate(() => window.store.getState().phase), 'playing');
  await page.evaluate(() => {
    const g = window.game;
    window.switchAudio = { sources: [], orders: [] };
    g.client.on('audio', m => { if (m.op === 'source') window.switchAudio.sources.push(m.data.byteLength); });
    g.client.on('ordered', m => window.switchAudio.orders.push(m.count));
    g.client.send({ type: 'view', x0: -100000, y0: -100000, x1: 100000, y1: 100000 });
  });
  await page.waitForFunction(() => window.game.client.cur?.actors.some(a => window.game.client.strings[a.type] === 'dog'));
  await wait(2000);
  const before = ranges.length;
  await stop();
  await start(next, [old]);
  for (let i = 0; i < 12; i++) {
    await page.evaluate(async i => {
      const g = window.game, dog = g.client.cur.actors.find(a => g.client.strings[a.type] === 'dog');
      await g.client.request({ type: 'select', ids: [dog.id], additive: false });
      g.lookAt(dog.sx, dog.sy);
      g.client.send({ type: 'click', x: dog.sx + (i % 2 ? -100 : 100), y: dog.sy, button: 2, mods: 0, t: performance.now() });
    }, i);
    await wait(450);
    assert.equal(await page.evaluate(() => window.store.getState().phase), 'playing');
  }
  const audio = await page.evaluate(() => window.switchAudio);
  assert.ok(audio.orders.some(n => n > 0));
  assert.ok(audio.sources.includes(50850), 'The original dog move clip must decode after promotion');
  assert.ok(ranges.slice(before).length > 0, 'Must exercise a cold lazy fetch after promotion');
  assert.ok(ranges.slice(before).every(r => r.url.includes(`/local-builds/${old.buildId}/`)));
  assert.deepEqual(errors, []);
  const name = 'mods/rtsai/web/ea/audio/idogmova.wav';
  const index = JSON.parse(fs.readFileSync(path.join(old.data, 'public/web-audio.json')));
  const entry = index.files.find(f => f.path === name);
  const clip = await fetch(`${base}/local-builds/${old.buildId}/data/public/web-audio.pack`,
    { headers: { Range: `bytes=${entry.offset}-${entry.offset + entry.size - 1}` } });
  assert.equal(clip.status, 206);
  const decoded = Buffer.from(await clip.arrayBuffer());
  assert.equal(decoded.subarray(0, 4).toString(), 'RIFF');
  assert.equal(sha(decoded), sha(fs.readFileSync(path.join(previous, 'vfs-public', name))));
  const wrong = await fetch(`${base}/data/public/web-audio.pack`, { headers: { Range: `bytes=${entry.offset}-${entry.offset + entry.size - 1}` } });
  assert.notEqual(Buffer.from(await wrong.arrayBuffer()).subarray(0, 4).toString(), 'RIFF', 'Control must reproduce old-offset/new-pack corruption');
  const redirect = await fetch(`${base}/?profile=public&mode=skirmish`, { redirect: 'manual' });
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.get('location'), `/local-builds/${next.buildId}/?profile=public&mode=skirmish`);
  assert.equal(redirect.headers.get('cache-control'), 'no-store');
  const refreshed = await fetch(`${base}/local-builds/${old.buildId}/?profile=public&mode=editor`,
    { headers: { accept: 'text/html', 'sec-fetch-dest': 'document' }, redirect: 'manual' });
  assert.equal(refreshed.status, 307);
  assert.equal(refreshed.headers.get('location'), `/local-builds/${next.buildId}/?profile=public&mode=editor`);
  assert.equal((await fetch(`${base}/local-builds/unknown/data/public/web-audio.pack`)).status, 410);
  assert.equal((await fetch(`${base}/local-builds/${old.buildId}/api/verify`, { method: 'POST', body: '{}' })).status, 409);
  for (const b of [old, next]) for (const [url, file] of [
    ['data/public/web-audio.json', path.join(b.data, 'public/web-audio.json')],
    ['rt/public/aot/_framework/runtime-identity.json', path.join(b.data, 'public/wasm-aot/wwwroot/_framework/runtime-identity.json')],
    ['scenarios/skirmish-originals.json', path.join(b.scenarios, 'skirmish-originals.json')],
  ]) assert.equal(sha(Buffer.from(await (await fetch(`${base}/local-builds/${b.buildId}/${url}`)).arrayBuffer())), sha(fs.readFileSync(file)));
  await page.screenshot({ path: path.join(out, 'old-session-after-promotion.png') });
  receipt.cases.push({ oldSessionContinued: true, coldDogMovePcm: 50850, audio, rangesAfterPromotion: ranges.slice(before),
    oldOffsetNewPackControlCorrupt: true, scopedPageDataRuntimeScenarios: true, unknownBuild410: true, oldNativeVerify409: true, errors });
  receipt.passed = true;
  console.log('PASS old tab survives host promotion; cold dog move reads old pack, new entry selects new build, unknown scope cannot fall back');
} finally {
  fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  await browser?.close(); await stop();
}
