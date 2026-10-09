import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';

const browser = await chromium.launch({
  executablePath: path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1228/chrome-win64/chrome.exe'),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
try {
  await page.goto(process.env.RTSAI_TEST_URL || 'http://127.0.0.1:3526/?profile=public&runtime=interp');
  await page.waitForFunction(() => window.store?.getState().phase === 'setup', null, { timeout: 180000 });
  const scenario = JSON.parse(fs.readFileSync('scenarios/production-ui.json', 'utf8'));
  scenario.spawns.push({ type: 'crate', player: 0, x: 14, y: 105 });
  await page.evaluate(s => window.game.start(JSON.stringify(s), true), scenario);
  await page.waitForFunction(() => window.store.getState().phase === 'playing', null, { timeout: 180000 });
  await page.evaluate(() => window.game.setPaused(false));
  await page.waitForFunction(() => window.game.client.cur.captured.batches.some(b => b.ground && b.count > 0), null, { timeout: 60000 });
  await page.waitForTimeout(3000);
  fs.mkdirSync('artifacts/resources', { recursive: true });
  await page.screenshot({ path: 'artifacts/resources/ore-fields.png' });
  const before = await page.evaluate(() => {
    const g = window.game;
    const crate = g.client.cur.actors.find(a => g.client.str(a.type) === 'crate');
    const dog = g.client.cur.actors.find(a => g.client.str(a.type) === 'dog');
    const result = { crate: crate.id, tick: g.client.cur.header.tick, cash: window.store.getState().ui?.cash, groundQuads: g.client.cur.captured.batches.filter(b => b.ground).reduce((n, b) => n + b.count / 4, 0) };
    g.select([dog.id]);
    // Aim at the upper part of the visible crate and force movement onto it.
    g.click(crate.sx, crate.sy - 30, 2, 2);
    return result;
  });
  await page.waitForFunction(id => !window.game.client.cur.actorById.has(id), before.crate, { timeout: 60000 });
  const after = await page.evaluate(() => ({ tick: window.game.client.cur.header.tick, cash: window.store.getState().ui?.cash }));
  assert(after.tick - before.tick < 6000, 'Crate must be collected before its expiration');
  assert(before.groundQuads > 100, 'Real resource field quads must be present');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ before, after }));
  console.log('PASS: ore fields captured and crate collected by a moving unit');
} finally {
  await browser.close();
}
