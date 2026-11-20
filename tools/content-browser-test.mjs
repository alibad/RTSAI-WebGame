// The game's content on a real page: all sixteen factions are offered, and every campaign chapter a player can open
// starts in the browser as that mission, with objectives and no page error.
//   RTSAI_TEST_URL=http://127.0.0.1:<port>/ node tools/content-browser-test.mjs
// The campaign grew from 6 missions to the Lines of Hope acts (15 October 2026), so the chapters come from the campaign
// screen itself, not from a fixed number. Chapters still in production show as locked cards and are not started.
import { browserExecutable, browserArgs } from './browser-launch.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';

const base = process.env.RTSAI_TEST_URL || 'http://127.0.0.1:3505/';
const profile = process.env.RTSAI_TEST_PROFILE || 'public';
const out = path.resolve(process.env.RTSAI_TEST_OUT || 'artifacts/content'); fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true, args: browserArgs() });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(60000);
// A missing file is reported with its address: the console only says "Failed to load resource ... 404".
const errors = []; page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
page.on('response', r => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
try {
  const target = new URL(base); target.searchParams.set('mode', 'missions'); target.searchParams.set('profile', profile);
  await page.goto(target.href);
  await page.waitForFunction(() => ['setup', 'error'].includes(window.store?.getState().phase), null, { timeout: 240000 });
  assert.equal(await page.evaluate(() => window.store.getState().phase), 'setup');
  const catalog = await page.evaluate(() => window.store.getState().setup);
  assert.equal(catalog.factions.filter(f => !f.random).length, 16, 'Sixteen factions');
  // The chapters the campaign screen lets a player open (locked cards are divs, not buttons).
  await page.locator('button.cp-mission[data-chapter]').first().waitFor();
  const chapters = await page.locator('button.cp-mission[data-chapter]').evaluateAll(buttons => buttons.map(b => b.dataset.chapter));
  const missions = chapters.filter(id => catalog.missions.some(m => m.id === id));
  assert.ok(missions.length >= 6, `The campaign offers its chapters (found ${missions.length})`);
  await page.screenshot({ path: path.join(out, 'missions.png') });
  for (const id of missions) {
    await page.locator(`button.cp-mission[data-chapter="${id}"]`).click();
    const start = page.getByRole('button', { name: 'Start mission', exact: true });
    await start.waitFor({ timeout: 240000 });
    await start.click();
    await page.waitForFunction(() => ['playing', 'error'].includes(window.store.getState().phase), null, { timeout: 240000 });
    assert.equal(await page.evaluate(() => window.store.getState().phase), 'playing', `${id}: ${await page.evaluate(() => window.store.getState().error)}`);
    await page.waitForFunction(id => window.store.getState().ui?.mission?.id === id, id, { timeout: 60000 });
    await page.waitForFunction(() => window.store.getState().ui.mission.objectives.length > 0, null, { timeout: 30000 });
    await page.screenshot({ path: path.join(out, `${id}.png`) });
    console.log(`PASS browser mission ${id}`);
    await page.evaluate(() => window.game.quit());
    await page.waitForFunction(() => window.store.getState().phase === 'setup', null, { timeout: 60000 });
    await page.locator(`button.cp-mission[data-chapter="${id}"]`).waitFor();
  }
  assert.deepEqual(errors, []);
  console.log(`PASS 16 factions, ${missions.length} mission launches, no browser errors`);
} finally { await browser.close(); }
