import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.RTSAI_PLAYWRIGHT_MODULE??path.resolve('web/node_modules/playwright-core/index.mjs')).href);
import { browserExecutable, browserArgs } from './browser-launch.mjs';
const base = process.env.RTSAI_TEST_URL || 'http://127.0.0.1:3508/';
const out = path.resolve(process.env.RTSAI_TEST_OUT || 'artifacts/static-modes');
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true, args: browserArgs() });
const receipt = { modes: [], deniedLocalRoutes: [], scope: 'Fresh local static production artifact; no external publication or analytics' };
try {
  for (const endpoint of ['api/companion/status', 'api/companion/start', 'api/maps/library', 'api/multiplayer', 'companion/api/v1/state', 'private/ra2-all.pack']) {
    const response = await fetch(new URL(endpoint, base)); assert.equal(response.status, 404, endpoint); receipt.deniedLocalRoutes.push(endpoint);
  }
  for (const [mode, profile, grid] of [['classic', 'public-classic', 'Rectangular'], ['isometric', 'public', 'RectangularIsometric']]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage(); const errors = [], localRequests = [];
    page.on('pageerror', e => errors.push(String(e))); page.on('request', r => { if (/\/(api|companion|private)\//.test(new URL(r.url()).pathname)) localRequests.push(r.url()); });
    await page.goto(`${base}?profile=${profile}&runtime=aot&private=0`);
    await page.waitForFunction(() => ['setup', 'error'].includes(window.store?.getState().phase), null, { timeout: 240000 });
    const setup = await page.evaluate(() => ({ phase: window.store.getState().phase, error: window.store.getState().error, isolated: crossOriginIsolated, ccAvailable: window.store.getState().ccAvailable, factions: window.store.getState().setup?.factions.filter(f => !f.random).length, missions: window.store.getState().setup?.missions.length }));
    assert.equal(setup.phase, 'setup', setup.error); assert.equal(setup.isolated, true); assert.equal(setup.ccAvailable, true); assert.equal(setup.factions, 16); assert.equal(setup.missions, 6);
    assert.equal(await page.getByRole('button', { name: 'Map studio', exact: false }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Private multiplayer', exact: true }).count(), 0);
    assert.ok(await page.getByRole('button', { name: 'Multiplayer', exact:true }).count());
    const selectedMode = mode === 'classic' ? 'Isometric' : 'Classic / top-down';
    await page.getByRole('button', { name: selectedMode, exact: true }).click();
    await page.waitForFunction(expected => window.store?.getState().phase === 'setup' && window.store.getState().profile === expected, profile === 'public' ? 'public-classic' : 'public', { timeout: 240000 });
    await page.getByRole('button', { name: mode === 'classic' ? 'Classic / top-down' : 'Isometric', exact: true }).click();
    await page.waitForFunction(expected => window.store?.getState().phase === 'setup' && window.store.getState().profile === expected, profile, { timeout: 240000 });
    await page.evaluate(() => { const m = window.store.getState().setup.missions[0]; window.game.start(JSON.stringify({ map: m.id, mission: m.id, seed: 2026, players: [{ slot: m.slot, faction: m.faction, color: '2A6FDB' }], options: { difficulty: 'normal' } })); });
    await page.waitForFunction(() => window.store.getState().phase === 'playing' && window.store.getState().ui?.tick > 20, null, { timeout: 180000 });
    assert.equal(await page.evaluate(() => window.store.getState().info.gridType), grid);
    const adviser=await page.evaluate(()=>window.game.client.adviserObserve());assert.ok(adviser.tick>0);assert.ok(adviser.units.length+adviser.buildings.length>0);
    await page.screenshot({ path: path.join(out, `${mode}.png`) }); assert.deepEqual(errors, []); assert.deepEqual(localRequests, []);
    receipt.modes.push({ mode, profile, grid, setup, selectorRoundTrip: true, actualWorldPlaying: true, missionAdviserObservation:true, localRequests, errors }); await context.close();
  }
  const context = await browser.newContext(); const page = await context.newPage();
  await page.route('**/embed-qa.html', route => route.fulfill({ status: 200, headers: { 'content-type': 'text/html', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }, body: '<script>window.starts=[];addEventListener("message",e=>{if(e.origin===location.origin&&e.data?.type==="rtsai:world-started")window.starts.push(e.data)})</script><iframe src="/?profile=public-classic&runtime=aot"></iframe>' }));
  await page.goto(new URL('embed-qa.html', base).href); const frame = page.frames().find(f => f !== page.mainFrame());
  await frame.waitForFunction(() => window.store?.getState().phase === 'setup', null, { timeout: 240000 }); assert.deepEqual(await page.evaluate(() => window.starts), []);
  await frame.evaluate(() => { const m = window.store.getState().setup.missions[0]; window.game.start(JSON.stringify({ map: m.id, mission: m.id, players: [{ slot: m.slot, faction: m.faction }], options: { difficulty: 'normal' } })); });
  await frame.waitForFunction(() => window.store.getState().phase === 'playing', null, { timeout: 180000 }); await page.waitForFunction(() => window.starts.length === 1);
  receipt.sameOriginEmbed = await page.evaluate(() => window.starts); assert.deepEqual(receipt.sameOriginEmbed, [{ type: 'rtsai:world-started', version: 1, event: 'world-started', mode: 'classic', transport: 'singleplayer' }]); await context.close();
  receipt.passed = true; console.log('PASS static mode selector, actual worlds, local service denial and same-origin accepted-start event');
} catch(error) { receipt.error=String(error); throw error; } finally { fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); await browser.close(); }
