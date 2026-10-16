// Real engine soundtrack metadata and Web Audio clock, plus expanded desktop/phone/RTL visual checks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
import { browserExecutable, browserArgs } from './browser-launch.mjs';

const url = process.env.RTSAI_TEST_URL ?? 'http://127.0.0.1:3490/?profile=public&runtime=interp';
const out = process.env.RTSAI_TEST_OUT ?? 'artifacts/now-playing';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true,
  args: [...browserArgs(), '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route('**/*', route => /^(https?:\/\/(127\.0\.0\.1|localhost)(:|\/)|blob:|data:)/.test(route.request().url()) ? route.continue() : route.abort());
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(url);
  await page.waitForFunction(() => ['setup', 'error'].includes(window.store?.getState().phase), null, { timeout: 180000 });
  assert.equal(await page.evaluate(() => window.store.getState().phase), 'setup', await page.evaluate(() => window.store.getState().error));
  console.log('Game ready; starting real skirmish');
  const scenario = JSON.parse(fs.readFileSync(process.env.RTSAI_TEST_SCENARIO ?? (url.includes('profile=public-classic') ? 'scenarios/skirmish-classic.json' : 'scenarios/skirmish-public.json'), 'utf8'));
  if (process.env.RTSAI_TEST_SANDBOX === '1') scenario.sandbox = true;
  await page.evaluate(s => window.game.start(JSON.stringify(s)), scenario);
  await page.waitForFunction(() => window.store.getState().phase === 'playing', null, { timeout: 180000 });
  await page.locator('canvas.stage').click({ position: { x: 500, y: 300 } });
  await page.waitForFunction(() => window.store.getState().ui?.music?.duration > 0 && window.game.audio.musicPlayback().active, null, { timeout: 90000 });
  const track = await page.evaluate(() => window.store.getState().ui.music);
  assert(track.duration > 0, 'The current track must have its measured duration');
  await page.getByRole('button', { name: 'Now playing music', exact: true }).click();
  await page.locator('.np-title').filter({ hasText: track.title }).waitFor();
  const library = await page.evaluate(() => window.game.command({ cmd: 'music-list' }));
  assert(library.tracks.length >= 2);
  assert.equal(await page.locator('.np-tracks li').count(), library.tracks.length);
  const select = async song => {
    await page.getByRole('button', { name: `Play ${song.title}`, exact: true }).click();
    await page.waitForFunction(id => window.store.getState().ui?.music?.id === id && window.game.audio.musicPlayback().active && !window.game.audio.musicPlayback().paused, song.id, { timeout: 90000 });
    assert.equal(await page.getByRole('button', { name: `Play ${song.title}`, exact: true }).getAttribute('aria-current'), 'true');
  };
  for (const song of library.tracks) await select(song);
  await select(library.tracks[0]);
  await page.getByRole('button', { name: 'Next track', exact: true }).click();
  await page.waitForFunction(id => window.store.getState().ui?.music?.id !== id, library.tracks[0].id);
  await page.getByRole('button', { name: 'Previous track', exact: true }).click();
  await page.waitForFunction(id => window.store.getState().ui?.music?.id === id && window.game.audio.musicPlayback().active, library.tracks[0].id);
  await page.waitForTimeout(1200);
  const a = await page.evaluate(() => window.game.audio.musicPlayback().elapsed);
  await page.waitForTimeout(1200);
  assert((await page.evaluate(() => window.game.audio.musicPlayback().elapsed)) > a + .5);
  await page.getByRole('button', { name: 'Pause music', exact: true }).click();
  await page.waitForFunction(() => window.game.audio.musicPlayback().paused);
  const musicPaused = await page.evaluate(() => window.game.audio.musicPlayback().elapsed);
  await page.waitForTimeout(1300);
  assert(Math.abs(await page.evaluate(() => window.game.audio.musicPlayback().elapsed) - musicPaused) < .1, 'Music-only pause freezes queued PCM');
  assert.equal(await page.evaluate(() => window.game.audio.context().state), 'running', 'Effects still run during music-only pause');
  await page.getByRole('button', { name: 'Play music', exact: true }).click();
  await page.waitForFunction(() => !window.game.audio.musicPlayback().paused);
  await page.waitForTimeout(700);
  assert(await page.evaluate(() => window.game.audio.musicPlayback().elapsed) > musicPaused + .3);
  const volume = page.getByLabel('Music volume', { exact: true });
  await volume.press('Home');
  for (let i = 0; i < 37; i++) await volume.press('ArrowRight');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('rtsai.preferences.v1')).music), .37);
  await page.getByRole('button', { name: 'Mute music', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => ({ music: window.game.audio.musicOn, effects: window.game.audio.soundOn })), { music: false, effects: true });
  await page.getByRole('button', { name: 'Unmute music', exact: true }).click();
  for (const [name, viewport, dir] of [
    ['desktop', { width: 1440, height: 900 }, 'ltr'],
    ['phone', { width: 844, height: 390 }, 'ltr'],
    ['phone-portrait', { width: 390, height: 844 }, 'ltr'],
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
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(await page.getByRole('slider', { name: 'Music', exact: true }).inputValue(), '0.37', 'Settings reflects the player volume');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.evaluate(() => window.game.setPaused(true));
  await page.waitForTimeout(300);
  const frozen = await page.evaluate(() => window.game.audio.musicPlayback().elapsed);
  await page.waitForTimeout(1200);
  assert(Math.abs(await page.evaluate(() => window.game.audio.musicPlayback().elapsed) - frozen) < .1, 'Paused audio freezes the track clock');
  await page.evaluate(() => window.game.setPaused(false));
  assert.deepEqual(errors, []);
  fs.writeFileSync(`${out}/receipt.json`, JSON.stringify({ passed: true, url, track, tracks: library.tracks, tests: ['select first/last', 'previous/next', 'PCM pause/resume with effects running', 'volume persistence', 'mute', 'match pause', 'Escape/focus', 'desktop/phone/RTL popup'] }, null, 2));
  console.log('PASS real soundtrack:', track, ';', library.tracks.length, 'tracks, selection, previous/next, real pause/resume, volume, mute, match pause, Escape/focus, desktop/phone/RTL popup');
} finally { await browser.close(); }
