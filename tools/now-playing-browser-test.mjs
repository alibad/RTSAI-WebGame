// Real engine soundtrack metadata and Web Audio clock, plus expanded desktop/phone/RTL visual checks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
import { browserExecutable, browserArgs } from './browser-launch.mjs';

const url = process.env.RTSAI_TEST_URL ?? 'http://127.0.0.1:3490/?profile=public&runtime=interp';
const out = 'artifacts/now-playing';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true,
  args: [...browserArgs(), '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(url);
  await page.waitForFunction(() => ['setup', 'error'].includes(window.store?.getState().phase), null, { timeout: 180000 });
  assert.equal(await page.evaluate(() => window.store.getState().phase), 'setup', await page.evaluate(() => window.store.getState().error));
  console.log('Game ready; starting real skirmish');
  await page.evaluate(s => window.game.start(s), fs.readFileSync('scenarios/skirmish-public.json', 'utf8'));
  await page.waitForFunction(() => window.store.getState().phase === 'playing', null, { timeout: 180000 });
  await page.locator('canvas.stage').click({ position: { x: 500, y: 300 } });
  await page.waitForFunction(() => window.store.getState().ui?.music?.duration > 0 && window.game.audio.musicPlayback().active, null, { timeout: 90000 });
  const track = await page.evaluate(() => window.store.getState().ui.music);
  assert(track.duration > 0, 'The current track must have its measured duration');
  await page.getByRole('button', { name: 'Now playing music', exact: true }).click();
  await page.getByText(track.title, { exact: true }).waitFor();
  await page.waitForTimeout(1200);
  const a = await page.evaluate(() => window.game.audio.musicPlayback().elapsed);
  await page.waitForTimeout(1200);
  assert((await page.evaluate(() => window.game.audio.musicPlayback().elapsed)) > a + .5);
  await page.getByRole('button', { name: 'Mute music', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => ({ music: window.game.audio.musicOn, effects: window.game.audio.soundOn })), { music: false, effects: true });
  await page.getByRole('button', { name: 'Unmute music', exact: true }).click();
  for (const [name, viewport, dir] of [
    ['desktop', { width: 1440, height: 900 }, 'ltr'],
    ['phone', { width: 844, height: 390 }, 'ltr'],
    ['phone-rtl', { width: 844, height: 390 }, 'rtl'],
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(dir => { document.documentElement.dir = dir; }, dir);
    await page.waitForTimeout(300);
    const box = await page.locator('.np-panel').boundingBox();
    assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height, `${name}: popup must fit`);
    await page.screenshot({ path: `${out}/${name}.png` });
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  assert.equal(await page.getByRole('button', { name: 'Now playing music', exact: true }).getAttribute('aria-expanded'), 'false');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Now playing music');
  await page.evaluate(() => window.game.setPaused(true));
  await page.waitForTimeout(300);
  const frozen = await page.evaluate(() => window.game.audio.musicPlayback().elapsed);
  await page.waitForTimeout(1200);
  assert(Math.abs(await page.evaluate(() => window.game.audio.musicPlayback().elapsed) - frozen) < .1, 'Paused audio freezes the track clock');
  await page.evaluate(() => window.game.setPaused(false));
  assert.deepEqual(errors, []);
  console.log('PASS real soundtrack:', track, '; progress, music-only mute, paused clock, Escape/focus, desktop/phone/RTL popup');
} finally { await browser.close(); }
