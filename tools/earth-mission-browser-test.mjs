// A mission at a real place: globe -> area -> "Create a mission here" -> defend or attack, the two sides -> the battle
// simulator with both sides placed and the operation's briefing. The plain build still opens the editor (see
// earth-editor-browser-test.mjs); the regional coastline maps (Hormuz) offer no quick mission.
//   RTSAI_TEST_URL=http://127.0.0.1:<port>/ node tools/earth-mission-browser-test.mjs
// Geography is answered by the test (two roads), so it never waits on a public mapping service.
// RTSAI_TEST_ASSET_ORIGIN: the CDN host of a static page's runtime and data, when they are not served beside it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
import { browserExecutable, browserArgs } from './browser-launch.mjs';
const base = process.env.RTSAI_TEST_URL ?? 'http://127.0.0.1:38669/';
const out = process.env.RTSAI_TEST_OUT ?? 'artifacts/earth-mission';
const assets = process.env.RTSAI_TEST_ASSET_ORIGIN ? new URL(process.env.RTSAI_TEST_ASSET_ORIGIN).hostname : '';
fs.mkdirSync(out, { recursive: true });
// Two roads across Riyadh: the least geography the Earth compiler accepts (it refuses an area with nothing mapped).
const GEOGRAPHY = JSON.stringify({ elements: [
  { type: 'way', id: 1, tags: { highway: 'primary' }, geometry: [{ lat: 24.6936, lon: 46.6553 }, { lat: 24.7136, lon: 46.6753 }, { lat: 24.7336, lon: 46.6953 }] },
  { type: 'way', id: 2, tags: { highway: 'secondary' }, geometry: [{ lat: 24.7336, lon: 46.6553 }, { lat: 24.6936, lon: 46.6953 }] },
] });
const browser = await chromium.launch({ executablePath: browserExecutable(), args: browserArgs(), headless: true });
const receipt = { base, cases: [], passed: false };
try {
  for (const spec of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport: spec, hasTouch: spec.width === 390 });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/*', route => {
      const u = new URL(route.request().url());
      if (/\/api\/(overpass|interpreter)$/.test(u.pathname)) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: GEOGRAPHY });
      if (['127.0.0.1', 'localhost', 'server.arcgisonline.com', 'tile.openstreetmap.org', assets].includes(u.hostname) || ['blob:', 'data:'].includes(u.protocol)) return route.continue();
      return route.abort();
    });
    const name = String(spec.width);
    await page.goto(`${base}?profile=public&mode=editor`);
    await page.getByTestId('ed-earth').waitFor({ timeout: 300000 });
    await page.getByTestId('ed-earth').click();
    const region = page.getByRole('region', { name: 'Map editor · real-world area', exact: true });
    await region.getByRole('button', { name: '3D view', exact: true }).and(page.locator(':enabled')).waitFor({ timeout: 60000 });

    // A regional coastline map has no quick mission; a land area offers both ways on.
    await page.locator('[data-place="Strait of Hormuz"]').click();
    await page.getByTestId('es-build').waitFor();
    assert.equal(await page.getByTestId('es-build-mission').count(), 0, 'No quick mission on the regional coastline map');
    await page.getByRole('button', { name: 'Back to the globe', exact: true }).click();
    await page.locator('[data-place="Riyadh"]').click();
    await page.getByTestId('es-build-mission').waitFor();
    assert.equal(await page.getByRole('radio', { name: '5 km', exact: true }).getAttribute('aria-checked'), 'true', 'A regional size does not carry over to a place without one');
    await page.waitForTimeout(1200);
    for (const id of ['es-build', 'es-build-mission']) {
      await page.getByTestId(id).scrollIntoViewIfNeeded();
      const b = await page.getByTestId(id).boundingBox();
      assert.ok(b && b.x >= 0 && b.y >= 0 && b.x + b.width <= spec.width + 1 && b.y + b.height <= spec.height + 1, `${id} can be reached`);
    }
    await page.screenshot({ path: `${out}/${name}-choose.png` });

    // The mission build stays on this screen and sets the mission up; the editor does not open.
    await page.getByTestId('es-build-mission').click();
    await page.getByTestId('es-mission').waitFor({ timeout: 180000 });
    assert.equal(await region.count(), 1, 'The mission is set up on the real-place screen');
    assert.ok(!(await page.evaluate(() => window.store.getState().editor?.map)), 'The editor stays closed');
    const defend = page.getByRole('radio', { name: 'You defend it', exact: true }), attack = page.getByRole('radio', { name: 'You attack it', exact: true });
    assert.equal(await defend.getAttribute('aria-checked'), 'true');
    const sides = async () => [await page.getByLabel('Your nation').innerText(), await page.getByLabel('Enemy nation').innerText()];
    const before = await sides();
    await attack.click();
    assert.equal(await attack.getAttribute('aria-checked'), 'true');
    assert.deepEqual(await sides(), [before[1], before[0]], 'Switching role keeps the nations on the place');
    await defend.click();
    for (const id of ['es-mission', 'es-play', 'es-edit']) assert.equal(await page.getByTestId(id).count(), 1, `${id} is offered`);
    await page.getByTestId('es-mission').scrollIntoViewIfNeeded();
    const overflow = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(overflow.scroll <= overflow.width, 'No horizontal overflow');
    await page.waitForTimeout(2600);
    await page.screenshot({ path: `${out}/${name}-mission.png` });

    // Start: the battle simulator opens on the place's map with both sides placed and the operation's briefing.
    await page.getByTestId('es-mission').click();
    await page.waitForFunction(() => { const s = window.store.getState(); return s.phase === 'playing' && s.sandbox?.mode === 'edit' && !!s.sandbox.operation && s.sandbox.units?.length > 0; }, null, { timeout: 180000 });
    await page.getByTestId('sim-operation').waitFor({ timeout: 60000 });
    const state = await page.evaluate(async () => {
      const s = window.store.getState().sandbox;
      const placed = (await window.game.command({ cmd: 'placements' })).spawns;
      return { map: s.map, fa: s.fa, fb: s.fb, title: s.operation.title ?? null, objectives: s.operation.objectives?.length ?? 0,
        mine: placed.filter(p => p.player === 0).length, theirs: placed.filter(p => p.player === 1).length };
    });
    assert.match(state.map, /^earth-/, 'The battle is on the map built from the place');
    assert.ok(state.mine >= 8 && state.theirs >= 8, `Both sides are placed (${state.mine} and ${state.theirs})`);
    assert.ok(state.objectives >= 1, 'The operation has objectives');
    assert.match(await page.getByTestId('sim-fight').innerText(), /Begin operation/i);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${out}/${name}-simulator.png` });
    if (spec.width === 1440) {
      // The operation runs: the battle starts with its objectives on screen.
      await page.getByTestId('sim-fight').click();
      await page.waitForFunction(() => window.store.getState().sandbox?.mode === 'run' && !!window.store.getState().ui?.mission, null, { timeout: 120000 });
      await page.waitForTimeout(6000);
      await page.screenshot({ path: `${out}/${name}-operation.png` });
      state.running = await page.evaluate(() => ({ objectives: window.store.getState().ui?.mission?.objectives?.length ?? null }));
    }
    assert.deepEqual(errors, []);
    receipt.cases.push({ viewport: spec, coastalHasNoMission: true, missionSetUpOnPlaceScreen: true, simulator: state, overflow, errors });
    await context.close(); console.log(`PASS real-place mission ${name}`, JSON.stringify(state));
  }
  receipt.passed = true;
} finally { fs.writeFileSync(`${out}/receipt.json`, JSON.stringify(receipt, null, 2) + '\n'); await browser.close(); }
