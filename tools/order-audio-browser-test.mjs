// Exercise actual order acknowledgements, including lazily fetched Attack Dog move audio.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
import { browserExecutable, browserArgs } from './browser-launch.mjs';

const base = process.env.RTSAI_TEST_URL ?? 'http://127.0.0.1:38664/';
const out = process.env.RTSAI_TEST_OUT ?? 'artifacts/order-audio';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true,
  args: [...browserArgs(), '--autoplay-policy=no-user-gesture-required'] });
const receipt = { base, cases: [], passed: false };
try {
  for (const profile of (process.env.RTSAI_TEST_PROFILES ?? 'public,public-classic').split(',')) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [], consoleErrors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(m.text()); });
    await page.goto(`${base}?profile=${profile}&runtime=aot&mode=skirmish`);
    await page.waitForFunction(() => ['setup', 'error'].includes(window.store?.getState().phase), null, { timeout: 240000 });
    assert.equal(await page.evaluate(() => window.store.getState().phase), 'setup');
    const scenario = { map: 'web-arena', seed: 711, players: [
      { slot: 'Multi0', faction: 'america', color: '2A6FDB' },
      { slot: 'Multi1', faction: 'russia', color: 'D83A2E', bot: 'webidle' },
    ], options: { explored: 'True', fog: 'False', crates: 'False', shortgame: 'False', startingunits: 'none' },
    spawns: [{ type: 'dog', player: 0, x: 24, y: 70 }, { type: 'e1', player: 0, x: 28, y: 70 },
      { type: 'gacnst', player: 0, x: 20, y: 60 }, { type: 'nacnst', player: 1, x: 70, y: 60 }] };
    if (profile === 'public-classic') scenario.spawns.forEach(s => { s.y -= 30; if (s.player === 1) s.x = 60; });
    await page.evaluate(s => window.game.start(JSON.stringify(s)), scenario);
    await page.waitForFunction(() => ['playing', 'error'].includes(window.store.getState().phase), null, { timeout: 180000 });
    assert.equal(await page.evaluate(() => window.store.getState().phase), 'playing');
    await page.evaluate(() => {
      const g = window.game;
      window.orderAudio = { sources: [], plays: [], orders: [] };
      g.client.on('audio', m => { if (m.op === 'source') window.orderAudio.sources.push({ id: m.id, bytes: m.data.byteLength });
        if (m.op === 'play') window.orderAudio.plays.push(m.source); });
      g.client.on('ordered', m => window.orderAudio.orders.push(m.count));
      g.client.send({ type: 'view', x0: -100000, y0: -100000, x1: 100000, y1: 100000 });
    });
    await page.waitForFunction(() => window.game.client.cur?.actors.some(a => window.game.client.strings[a.type] === 'dog'));
    for (let i = 0; i < 12; i++) {
      const ordered = await page.evaluate(async i => {
        const g = window.game, dog = g.client.cur.actors.find(a => g.client.strings[a.type] === 'dog');
        if (!dog) return { error: 'Dog missing from current view', actors: g.client.cur.actors.map(a => ({ ...a, name: g.client.strings[a.type] })), cam: g.cam };
        await g.client.request({ type: 'select', ids: [dog.id], additive: false });
        g.lookAt(dog.sx, dog.sy);
        g.client.send({ type: 'click', x: dog.sx + (i % 2 ? -100 : 100), y: dog.sy, button: 2, mods: 0, t: performance.now() });
        return null;
      }, i);
      if (ordered) { await page.screenshot({ path: `${out}/${profile}-missing.png` }); throw Error(JSON.stringify(ordered)); }
      await page.waitForTimeout(450);
      if (await page.evaluate(() => window.store.getState().phase === 'error')) break;
    }
    const state = await page.evaluate(() => ({ phase: window.store.getState().phase, error: window.store.getState().error,
      audio: window.orderAudio, tick: window.game.client.cur?.tick }));
    receipt.cases.push({ profile, ...state, errors, consoleErrors });
    await page.screenshot({ path: `${out}/${profile}.png` });
    console.log(JSON.stringify(receipt.cases.at(-1)));
    assert.equal(state.phase, 'playing', state.error);
    assert.ok(state.audio.orders.some(n => n > 0), 'No real move order was issued');
    assert.ok(state.audio.sources.some(s => s.bytes > 1000), 'No voice PCM was decoded');
    assert.deepEqual(errors, []);
    await page.close();
  }
  receipt.passed = true;
} finally {
  fs.writeFileSync(`${out}/receipt.json`, JSON.stringify(receipt, null, 2) + '\n');
  await browser.close();
}
