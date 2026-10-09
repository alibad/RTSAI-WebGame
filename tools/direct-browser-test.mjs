import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
const base = process.env.RTSAI_TEST_URL || 'http://127.0.0.1:3505/';
const browser = await chromium.launch({ executablePath: path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1228/chrome-win64/chrome.exe'), headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const contexts = await Promise.all([1, 2].map(() => browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone'] })));
const pages = await Promise.all(contexts.map(c => c.newPage()));
const errors = []; let roomRequests = 0;
for (const p of pages) { p.on('pageerror', e => errors.push(String(e))); p.on('request', r => { if (r.url().includes('api/multiplayer')) roomRequests++; }); }
fs.mkdirSync('artifacts/direct', { recursive: true });
try {
  await Promise.all(pages.map(p => p.goto(`${base}?profile=public&runtime=${process.env.RTSAI_TEST_RUNTIME || 'aot'}&private=0`)));
  await Promise.all(pages.map(p => p.waitForFunction(() => ['setup', 'error'].includes(window.store?.getState().phase), null, { timeout: 240000 })));
  for (const p of pages) {
    assert.equal(await p.evaluate(() => window.store.getState().phase), 'setup', await p.evaluate(() => window.store.getState().error));
    await p.evaluate(() => { window.peerFrames = []; window.peerErrors = []; window.game.client.on('networkStatus', m => { window.peerFrames.push(m.frame); if (m.error) window.peerErrors.push(m.error); }); });
    await p.getByRole('button', { name: 'Direct peer-to-peer', exact: true }).click();
  }
  await pages[1].getByLabel('Direct faction').selectOption('iran');
  await pages[0].getByRole('button', { name: 'Create offer', exact: true }).click();
  await pages[0].getByLabel('Your connection code').waitFor({ timeout: 60000 });
  const offer = await pages[0].getByLabel('Your connection code').inputValue();
  await pages[1].getByLabel('Friend connection code').fill(offer);
  await pages[1].getByRole('button', { name: 'Answer friend offer', exact: true }).click();
  await pages[1].getByLabel('Your connection code').waitFor({ timeout: 60000 });
  await pages[0].getByLabel('Friend connection code').fill(await pages[1].getByLabel('Your connection code').inputValue());
  await pages[0].getByRole('button', { name: 'Connect with friend answer', exact: true }).click();
  await pages[0].getByRole('button', { name: 'Start direct match', exact: true }).waitFor({ timeout: 60000 });
  console.log('Independent browsers connected by manually exchanged WebRTC descriptions');
  await pages[0].getByLabel('Direct chat message').fill('Friends connected without a room server');
  await pages[0].getByRole('button', { name: 'Send', exact: true }).click();
  await pages[1].getByText('Friend: Friends connected without a room server', { exact: true }).waitFor();
  for (const p of pages) await p.getByRole('button', { name: 'Enable camera and microphone', exact: true }).click();
  for (const p of pages) await p.waitForFunction(() => { const v = document.querySelector('video[aria-label="Friend camera"]'); return v?.readyState >= 2 && v.videoWidth > 0; }, null, { timeout: 30000 });
  console.log('Peer chat and bidirectional video/audio media tracks passed (synthetic test devices)');
  await pages[0].screenshot({ path: 'artifacts/direct/call-lobby.png' });
  await pages[0].getByRole('button', { name: 'Start direct match', exact: true }).click();
  await Promise.all(pages.map(p => p.waitForFunction(() => ['playing', 'error'].includes(window.store.getState().phase), null, { timeout: 240000 })));
  for (const p of pages) assert.equal(await p.evaluate(() => window.store.getState().phase), 'playing', await p.evaluate(() => window.store.getState().error));
  await Promise.all(pages.map(p => p.waitForFunction(() => window.peerFrames.at(-1) >= 120 || window.peerErrors.length > 0, null, { timeout: 120000 })));
  for (const p of pages) assert.deepEqual(await p.evaluate(() => window.peerErrors), []);
  for (const [i,p] of pages.entries()) {
    await p.locator('canvas.stage').focus();await p.keyboard.press('Enter');
    const composer=p.getByLabel('Direct chat message');await composer.waitFor();
    await composer.fill(`Commander ${i+1} ready on the direct channel`);await p.keyboard.press('Enter');
    await composer.waitFor({state:'hidden'});
    await pages[1-i].getByRole('log',{name:'Chat messages'}).getByText(`Commander ${i+1} ready on the direct channel`,{exact:true}).waitFor();
  }
  console.log('Keyboard-first direct chat and passive corner feed passed in both browsers');
  for (const p of pages) await p.evaluate(async () => { const g = window.game, s = g.client.cur; const mcv = s.actors.find(a => a.owner === s.header.localPlayer && g.client.str(a.type).includes('mcv')); if (!mcv) throw Error('No local MCV'); await g.select([mcv.id]); await g.command({ cmd: 'deploy' }); });
  const before = await pages[0].evaluate(() => window.peerFrames.at(-1));
  await pages[0].waitForFunction(x => window.peerFrames.at(-1) >= x + 80 || window.peerErrors.length > 0, before, { timeout: 90000 });
  for (const p of pages) assert.deepEqual(await p.evaluate(() => window.peerErrors), []);
  console.log(`Matching per-frame engine hashes through ${await pages[0].evaluate(() => window.peerFrames.at(-1))}; both human deploy orders serialized`);
  await pages[0].screenshot({ path: 'artifacts/direct/match-host.png' });
  await contexts[1].close();
  await pages[0].getByRole('button', { name: /^Direct match/ }).click();
  await pages[0].getByRole('alert').waitFor({ timeout: 30000 });
  const stop = await pages[0].evaluate(() => window.peerFrames.at(-1)); await pages[0].waitForTimeout(1500);
  assert.equal(await pages[0].evaluate(() => window.peerFrames.at(-1)), stop);
  assert.equal(roomRequests, 0, 'Direct mode called the room API'); assert.deepEqual(errors, []);
  console.log('Disconnect freezes simulation with a visible reason; zero room API requests; direct browser test passed');
} catch (error) {
  console.log('Browser errors', errors);
  for (const [i,p] of pages.entries()) if (!p.isClosed()) { console.log('Client',i+1,(await p.locator('body').innerText()).slice(-4000)); await p.screenshot({path:`artifacts/direct/failure-${i}.png`}); }
  throw error;
} finally { await browser.close(); }
