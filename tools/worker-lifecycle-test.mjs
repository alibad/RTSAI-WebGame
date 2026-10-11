import { browserExecutable, browserArgs } from './browser-launch.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true, args: browserArgs() });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = []; page.on('pageerror', e => errors.push(String(e)));
let release; const gate = new Promise(resolve => { release = resolve; }); let held = 0;
await context.route(/\/sprites\/[^/]+\.\d+\.bin$/, async route => { held++; await gate; await route.continue(); });
const receipt = { scope: 'Cold Chromium context; actual OpenRA WASM; delayed immutable sprite downloads across cancelled launch', checks: {} };
const out=path.resolve(process.env.RTSAI_TEST_OUT||'artifacts/lifecycle');fs.mkdirSync(out, { recursive: true });
try {
  await page.goto(process.env.RTSAI_TEST_URL || `http://127.0.0.1:3496/?profile=${process.env.RTSAI_TEST_PROFILE || "public"}&runtime=aot&private=0`);
  await page.waitForFunction(() => ['setup', 'error'].includes(window.store?.getState().phase), null, { timeout: 240000 });
  assert.equal(await page.evaluate(() => window.store.getState().phase), 'setup');
  const mission = await page.evaluate(() => window.store.getState().setup.missions[0]);
  const scenario = JSON.stringify({ map: mission.id, mission: mission.id, seed: 2026, players: [{ slot: mission.slot, faction: mission.faction, color: '2A6FDB' }], options: { difficulty: 'normal', startingcash: '10000', fog: 'True', explored: 'False' } });
  await page.evaluate(m => { window.game.wantFactions(null, m.faction); window.game.prepare(m.id); }, mission);
  await page.waitForFunction(id => window.store.getState().preparedMap === id && window.store.getState().sheets.total > window.store.getState().sheets.uploaded, mission.id, { timeout: 120000 });
  assert.ok(held > 0);
  await page.evaluate(scenario => { window.game.start(scenario); window.game.quit(); }, scenario);
  const cancellation = await page.evaluate(async () => {
    let settled; window.game.client.replies.set(99999, json => { settled = JSON.parse(json); });
    window.game.quit(); await Promise.resolve(); return { settled, pending: window.game.client.replies.size };
  });
  assert.equal(cancellation.pending, 0); assert.ok(cancellation.settled.error.includes('cancelled'));
  release();
  await page.waitForFunction(() => window.store.getState().sheets.uploaded >= window.store.getState().sheets.total, null, { timeout: 120000 });
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(() => window.store.getState().phase), 'setup');
  receipt.checks.cancelledUploadWaitStayedInSetup = true; receipt.checks.heldSpriteRequests = held; receipt.checks.pendingRepliesCancelled = cancellation;
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.evaluate(scenario => window.game.start(scenario), scenario);
    await page.waitForFunction(() => ['playing', 'error'].includes(window.store.getState().phase), null, { timeout: 120000 });
    assert.equal(await page.evaluate(() => window.store.getState().phase), 'playing');
    await page.waitForFunction(() => window.game.client.cur?.header.tick >= 20, null, { timeout: 30000 });
    assert.ok(await page.evaluate(() => window.game.client.cur.actors.length));
    await page.screenshot({ path: path.join(out,`mission-${attempt + 1}.png`) });
    await page.evaluate(() => window.game.quit()); await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.store.getState().phase), 'setup');
  }
  receipt.checks.actualSinglePlayerStartQuitRestart = true; assert.deepEqual(errors, []); receipt.status = 'passed';
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) { receipt.status = 'failed'; receipt.error = String(error); receipt.state = await page.evaluate(() => ({ phase: window.store?.getState().phase, sheets: window.store?.getState().sheets, error: window.store?.getState().error })); await page.screenshot({ path: path.join(out,'failure.png') }); console.log(JSON.stringify(receipt, null, 2)); throw error;
} finally { release(); receipt.errors = errors; fs.writeFileSync(path.join(out,'receipt.json'), JSON.stringify(receipt, null, 2)); await browser.close(); }
