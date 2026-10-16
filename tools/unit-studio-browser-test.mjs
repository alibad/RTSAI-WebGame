// Studio unit overrides, actual WASM acceptance: inspect the loaded unit, train it through the HUD,
// and verify credits deducted. Never changes public content or saved matches.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
import { browserExecutable, browserArgs } from './browser-launch.mjs';

const base = process.env.RTSAI_TEST_URL ?? 'http://127.0.0.1:3519/';
const out = path.resolve(process.env.RTSAI_TEST_OUT ?? '../artifacts/shared-content-pilot-20261016');
const modifications = JSON.parse(fs.readFileSync(new URL('../../RTSAI-Mod/mods/rtsai/unit-overrides/manifest.json', import.meta.url), 'utf8'));
const expected = JSON.parse(fs.readFileSync(new URL('../../RTSAI-Mod/mods/rtsai/shared-content/manifest.json', import.meta.url), 'utf8'));
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true, args: browserArgs() });
const receipt = { revision: modifications.revision, scope: 'Actual local browser WASM; Classic uses the preserved top-down adapter, not full desktop Classic parity', targets: [], passed: false };
try {
  for (const [mode, profile, grid] of [['ra2', 'public', 'RectangularIsometric'], ['classic', 'public-classic', 'Rectangular']]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`${base}?profile=${profile}&runtime=interp&private=0`);
    await page.waitForFunction(() => ['setup', 'error'].includes(window.store?.getState().phase), null, { timeout: 240000 });
    assert.equal(await page.evaluate(() => window.store.getState().phase), 'setup', await page.evaluate(() => window.store.getState().error));
    const scenario = { map: 'web-arena', seed: 20261016, bare: true,
      players: [{ slot: 'Multi0', faction: 'america', color: '2A6FDB' }, { slot: 'Multi1', faction: 'russia', bot: 'webidle' }],
      options: { startingcash: '10000', fog: 'False', explored: 'True', crates: 'False' },
      spawns: [{ type: 'gacnst', player: 0, x: 20, y: 20 }, { type: 'gapowr', player: 0, x: 25, y: 20 },
        { type: 'gapile', player: 0, x: 20, y: 25 }, { type: 'smcv', player: 1, x: 45, y: 45 }],
    };
    await page.evaluate(scenario => window.game.start(JSON.stringify(scenario)), scenario);
    await page.waitForFunction(() => ['playing', 'error'].includes(window.store.getState().phase), null, { timeout: 240000 });
    assert.equal(await page.evaluate(() => window.store.getState().phase), 'playing', await page.evaluate(() => window.store.getState().error));
    await page.waitForFunction(() => window.store.getState().ui?.tick >= 30, null, { timeout: 60000 });
    await page.evaluate(() => {
      const g = window.game, s = g.client.cur;
      const base = s.actors.find(a => a.owner === s.header.localPlayer && g.client.str(a.type) === 'gapile');
      if (!base) throw Error('The proof barracks is missing');
      g.lookAt(base.sx, base.sy);
    });
    await page.waitForTimeout(600);
    const unit = await page.evaluate(() => window.game.client.command({ cmd: 'unitinfo', type: 'engineer' }));
    const override = modifications.units[mode === 'classic' ? 'classic:e6' : 'ra2:engineer'] ?? {};
    assert.equal(unit.cost, override.cost ?? expected.targets[`${mode}-web`].cost);
    if (override.health !== undefined) assert.equal(unit.hp, override.health);
    if (override.speed !== undefined) assert.equal(unit.speed, override.speed);
    assert.equal(unit.contentRevision, expected.revision);
    const data = await page.evaluate(() => ({ grid: window.store.getState().info.gridType,
      price: window.store.getState().catalog.find(q => q.type === 'Infantry')?.items.find(i => i.name === 'engineer'),
      cash: window.store.getState().ui.cash }));
    assert.equal(data.grid, grid);
    assert.equal(data.price.cost, unit.cost);
    assert.equal(data.price.buildable, true);
    await page.locator('button[title="Infantry"]').click();
    const button = page.getByRole('button', { name: data.price.label, exact: true });
    await button.hover();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(out, `${mode}-web-cost.png`) });
    await button.click();
    await page.waitForFunction(() => {
      const g = window.game, s = g.client.cur;
      return s?.actors.some(a => a.owner === s.header.localPlayer && g.client.str(a.type) === 'engineer');
    }, null, { timeout: 180000 });
    const result = await page.evaluate(() => ({ cash: window.store.getState().ui.cash, tick: window.store.getState().ui.tick,
      engineers: window.game.client.cur.actors.filter(a => a.owner === window.game.client.cur.header.localPlayer && window.game.client.str(a.type) === 'engineer').length }));
    assert.equal(data.cash - result.cash, unit.cost);
    assert.equal(result.engineers, 1);
    assert.deepEqual(errors, []);
    receipt.targets.push({ target: `${mode}-web`, profile, grid, unit, catalogCost: data.price.cost, cashBefore: data.cash, ...result, spent: data.cash - result.cash, errors });
    await page.screenshot({ path: path.join(out, `${mode}-web-trained.png`) });
    console.log(`PASS ${mode} WASM: ${unit.cost} credits, one Engineer trained, revision ${unit.contentRevision.slice(0, 12)}`);
    await context.close();
  }
  receipt.passed = true;
} finally {
  fs.writeFileSync(path.join(out, 'unit-studio-web-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  await browser.close();
}
