// Scenario workshop regressions, in a real browser against a running server (node server/serve.mjs):
//  - "N units" never becomes a non-combat actor (the opponent was an MCV), and no combat-unit error is reachable;
//  - field problems show next to their field;
//  - formations never draw units over each other (1, 6, 8 and 24 a side; infantry to the largest vehicles);
//  - "Start battle" is one click and you can then select and move your units.
// RTSAI_TEST_URL (default http://127.0.0.1:3490/) picks the server, RTSAI_TEST_OUT the screenshot folder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
import { browserArgs, browserExecutable } from './browser-launch.mjs';

const base = process.env.RTSAI_TEST_URL ?? 'http://127.0.0.1:3490/';
const out = process.env.RTSAI_TEST_OUT ?? 'artifacts/practice-workshop';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true, args: browserArgs() });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(() => { try { localStorage.setItem('rtsai.mouseLock', '0'); } catch { /* optional */ } });
const errors = []; page.on('pageerror', e => { errors.push(String(e)); console.log(e.stack); });
const results = {};
const start = page.getByRole('button', { name: 'Start battle', exact: true });
const ready = () => page.waitForFunction(() => { const b = [...document.querySelectorAll('[data-practice] button')].find(x => x.textContent.includes('Start battle')); return b && !b.disabled; }, null, { timeout: 240000 });
const trigger = label => page.locator(`[data-practice] [aria-label="${label}"]`);
async function pick(label, search, option) {
  const input = page.locator('input[aria-label="Find a unit…"]');
  await input.waitFor({ state: 'detached' });
  await trigger(label).click();
  await input.fill(search);
  await page.getByRole('option', { name: option ?? search }).first().click();
  await input.waitFor({ state: 'detached' });
  assert.match(await trigger(label).innerText(), new RegExp(option ?? search));
}
/** The two forces as the engine draws them: selection boxes in world px, per side. */
const forces = () => page.evaluate(() => {
  const c = window.game.client, s = c.cur, local = s.header.localPlayer;
  const own = s.actors.filter(a => !(a.flags & 8) && (a.flags & 1) && s.players[a.owner]?.flags & 4);
  return own.map(a => ({ id: a.id, type: c.str(a.type), side: a.owner === local ? 0 : 1, x0: a.sx + a.bx, y0: a.sy + a.by, x1: a.sx + a.bx + a.bw, y1: a.sy + a.by + a.bh }));
});
function assertSeparate(list, what) {
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0;
    assert(!overlap, `${what}: ${a.type} #${a.id} overlaps ${b.type} #${b.id}`);
  }
}
async function checkForces(mine, theirs, what, shot) {
  await ready();
  await page.waitForFunction(n => window.game.client.cur?.actors.filter(a => a.flags & 1).length >= n, mine + theirs, { timeout: 30000 });
  const list = await forces();
  assert.equal(list.filter(a => a.side === 0).length, mine, `${what}: your force`);
  assert.equal(list.filter(a => a.side === 1).length, theirs, `${what}: opponent force`);
  assertSeparate(list, what);
  assert.equal(await page.getByRole('alert').count(), 0, `${what}: no problems shown`);
  if (shot) await page.screenshot({ path: `${out}/${shot}` });
  results[what] = { mine, theirs, types: [...new Set(list.map(a => a.type))] };
  console.log('ok', what, results[what].types.join(' vs '));
}

try {
  await page.goto(`${base}?profile=public`);
  await page.getByRole('button', { name: /Scenario workshop/ }).first().waitFor({ timeout: 300000 });
  await page.getByRole('button', { name: /Scenario workshop/ }).first().click();
  await page.getByLabel('Scenario request').fill('Defend with 6 tanks against 8 units for 2 minutes');
  await page.getByRole('button', { name: 'Interpret request', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-practice] form button')?.disabled, null, { timeout: 300000 });
  await page.getByRole('button', { name: 'Interpret request', exact: true }).click();
  await ready();
  results.plan = {
    you: await trigger('Your unit').innerText(), opponent: await trigger('Opponent unit').innerText(),
    force: await page.getByLabel('Your force').inputValue(), enemyForce: await page.getByLabel('Opponent force').inputValue(),
    seconds: await page.getByLabel('Duration seconds').inputValue(), factions: [await trigger('Your faction').innerText(), await trigger('Opponent faction').innerText()],
  };
  console.log('interpreted', results.plan);
  assert.deepEqual([results.plan.force, results.plan.enemyForce, results.plan.seconds], ['6', '8', '120']);
  assert.match(results.plan.you, /Battle Tank/); assert.match(results.plan.opponent, /Battle Tank/);
  await checkForces(6, 8, 'owner request 6 v 8', 'workshop-6v8.png');
  // Only fighting units are offered: the MCV and harvesters are not in the list at all.
  await trigger('Opponent unit').click();
  await page.locator('input[aria-label="Find a unit…"]').fill('Construction');
  await page.getByText('Nothing matches that search.').waitFor();
  await page.locator('input[aria-label="Find a unit…"]').fill('Harvester');
  assert.equal(await page.getByRole('option', { name: /Ore Harvester/ }).count(), 0);
  await page.keyboard.press('Escape');

  // A problem shows next to the field that causes it, and blocks Start until fixed.
  await page.getByLabel('Your force').fill('99');
  const near = page.locator('[data-practice] section[aria-label="You"] [role="alert"]');
  await near.filter({ hasText: '1–24' }).waitFor();
  assert(await start.isDisabled());
  await page.getByLabel('Your force').fill('1');
  await page.getByLabel('Opponent force').fill('1');
  await checkForces(1, 1, '1 v 1');
  await page.getByLabel('Your force').fill('24');
  await page.getByLabel('Opponent force').fill('24');
  await pick('Your unit', 'Heavy Airship');
  await pick('Opponent unit', 'Basij');
  await checkForces(24, 24, 'largest vehicle 24 v infantry 24', 'workshop-24v24.png');
  await pick('Your unit', 'Heavy Assault Tank');
  await pick('Opponent unit', 'Karrar');
  await checkForces(24, 24, 'tanks 24 v 24');

  // Back to the owner's battle, then one click to play it.
  await page.getByRole('button', { name: 'Interpret request', exact: true }).click();
  await page.getByLabel('Your force').fill('6');
  await page.getByLabel('Opponent force').fill('8');
  await pick('Your unit', 'M1A2S');
  await pick('Opponent unit', 'Karrar');
  await checkForces(6, 8, 'owner request again');
  await start.click();
  await page.locator('[data-practice]').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.store.getState().paused), false);
  const target = await page.evaluate(() => {
    const g = window.game, s = g.client.cur, box = g.canvas.getBoundingClientRect();
    const css = (x, y) => ({ x: box.left + box.width / 2 + (x - g.cam.x) * g.cam.zoom, y: box.top + box.height / 2 + (y - g.cam.y) * g.cam.zoom });
    const a = s.actors.find(a => a.owner === s.header.localPlayer && (a.flags & 1) && !(a.flags & 8));
    const at = css(a.sx, a.sy), clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    // A destination well inside the battlefield, up and towards the middle of the screen.
    return { id: a.id, from: { x: a.sx, y: a.sy }, at, to: { x: clamp(at.x + 260, box.left + 40, box.right - 40), y: clamp(at.y - 160, box.top + 80, box.bottom - 120) } };
  });
  await page.mouse.click(target.at.x, target.at.y);
  await page.waitForFunction(id => window.game.overlay.selected.has(id), target.id, { timeout: 10000 });
  await page.mouse.click(target.to.x, target.to.y, { button: 'right' });
  await page.waitForFunction(({ id, from }) => { const a = window.game.client.cur.actorById.get(id); return a && Math.hypot(a.sx - from.x, a.sy - from.y) > 60; }, target, { timeout: 30000 });
  results.moved = await page.evaluate(id => { const a = window.game.client.cur.actorById.get(id); return { x: a.sx, y: a.sy }; }, target.id);
  console.log('selected and moved', target.id, target.from, '->', results.moved);
  await page.screenshot({ path: `${out}/battle-moving.png` });
  assert.deepEqual(errors, []);
  results.passed = true;
  fs.writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
  console.log('Scenario workshop passed: combat-only picks, field-level problems, non-overlapping formations, playable battle');
} catch (e) {
  await page.screenshot({ path: `${out}/failure.png` });
  fs.writeFileSync(`${out}/failure.json`, JSON.stringify({ error: String(e), errors, results }, null, 2));
  throw e;
} finally { await browser.close(); }
