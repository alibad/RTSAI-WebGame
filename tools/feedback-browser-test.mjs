// In-game feedback (ui/Feedback.tsx), end to end in a real browser with a running match: the battlefield screenshot
// taken when Feedback opens (checked for real pixels), the annotator, a voice note, a file and the send. The website's
// /api/feedback, its /api/feedback/upload token route and Vercel Blob are mocked here, so nothing leaves the machine;
// the payload is checked for the uploaded files' links.
//   firebase emulators:start --only auth --project demo-rtsai          (in RTSAI-Web)
//   a game build with VITE_FIREBASE_EMULATORS=1 and VITE_FIREBASE_* demo values, served by server/serve.mjs
//   RTSAI_TEST_URL=http://127.0.0.1:3594/ node tools/feedback-browser-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { browserExecutable, browserArgs } from './browser-launch.mjs';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';

const base = process.env.RTSAI_TEST_URL || 'http://127.0.0.1:3594/';
const out = process.env.RTSAI_TEST_OUT || 'artifacts/feedback';
fs.mkdirSync(out, { recursive: true });
const store = 'teststore123';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const browser = await chromium.launch({
  executablePath: browserExecutable(),
  headless: process.env.RTSAI_TEST_HEADED !== '1',
  // A fake microphone (a tone) for the voice note; tab capture accepted without the picker for "Full screen".
  args: [...browserArgs(), '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--auto-accept-this-tab-capture'],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, permissions: ['microphone'] });
const page = await context.newPage();
page.setDefaultTimeout(60000);
const errors = [], tokenRequests = [], blobPuts = [], feedbackPosts = [];
page.on('pageerror', e => errors.push(String(e)));
const shot = async name => { const file = path.join(out, name); await page.screenshot({ path: file }); console.log('wrote', file); };
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,OPTIONS', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*' };

// The site's upload token route: records what the game asks for and answers like handleUpload does.
await page.route(url => url.pathname.endsWith('/api/feedback/upload'), async route => {
  const request = route.request(), body = request.postDataJSON();
  tokenRequests.push({ authorization: request.headers().authorization ?? '', body });
  const claims = Buffer.from(JSON.stringify({ pathname: body.payload.pathname, validUntil: Date.now() + 600000 })).toString('base64');
  await route.fulfill({ json: { type: 'blob.generate-client-token', clientToken: `vercel_blob_client_${store}_${Buffer.from(`mocksignature.${claims}`).toString('base64')}` } });
});
// Vercel Blob itself: the client upload PUTs the file to vercel.com/api/blob; answer with the stored blob's URL.
await page.route(url => url.hostname === 'vercel.com' && url.pathname.startsWith('/api/blob'), async route => {
  const request = route.request();
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const pathname = new URL(request.url()).searchParams.get('pathname');
  const stored = pathname.replace(/(\.[a-z0-9]+)$/i, '-Mock7RandomSuffix0123456789ab$1');
  blobPuts.push({ method: request.method(), pathname, contentType: request.headers()['x-content-type'], bytes: request.postDataBuffer()?.length ?? 0, authorization: request.headers().authorization ?? '' });
  const url = `https://${store}.public.blob.vercel-storage.com/${stored}`;
  await route.fulfill({ headers: cors, json: { url, downloadUrl: `${url}?download=1`, pathname: stored, contentType: request.headers()['x-content-type'], contentDisposition: 'inline' } });
});
await page.route(url => url.pathname.endsWith('/api/feedback'), async route => {
  feedbackPosts.push({ authorization: route.request().headers().authorization ?? '', body: route.request().postDataJSON() });
  await route.fulfill({ json: { success: true, issueNumber: 101, issueUrl: 'https://github.com/example/private/issues/101', receipt: 'RTS-#101', notificationQueued: true } });
});

/** Luminance spread and colour count of an image in the page: a blank or black capture has neither. */
const pixelStats = selector => page.evaluate(async sel => {
  const img = document.querySelector(sel); await img.decode();
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext('2d'); x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data, colors = new Set();
  let sum = 0, sum2 = 0, n = 0, red = 0;
  for (let i = 0; i < d.length; i += 16) {
    const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; sum += l; sum2 += l * l; n++;
    if (colors.size < 20000) colors.add(((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3));
    if (d[i] > 200 && d[i + 1] < 90 && d[i + 2] < 90) red++;
  }
  return { width: c.width, height: c.height, mean: sum / n, std: Math.sqrt(sum2 / n - (sum / n) ** 2), colors: colors.size, red: red / n, src: img.src };
}, selector);

// A local data/ runtime built before 5bf7757 has no SetVoiceLanguage export, so no match starts from it. Opt-in shim
// for such checkouts (nothing to do with feedback): the voice-language calls become no-ops.
if (process.env.RTSAI_TEST_OLD_RUNTIME === '1') {
  await page.route(url => /\/assets\/worker-[^/]+\.js$/.test(url.pathname), async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace(/\.SetVoiceLanguage\(/g, '.SetVoiceLanguage?.(') });
  });
}

const receipt = { checks: {}, errors };
try {
  await page.goto(`${base}?scenario=skirmish-public&profile=public`);
  await page.waitForFunction(() => ['playing', 'error'].includes(window.store?.getState().phase), null, { timeout: 300000, polling: 250 });
  assert.equal(await page.evaluate(() => window.store.getState().phase), 'playing', await page.evaluate(() => window.store.getState().error));
  // Let the world draw for a moment (terrain, units, a little fog of war movement).
  await page.waitForFunction(() => !!window.game.client.cur && !!window.store.getState().ui, null, { timeout: 120000 });
  await page.waitForTimeout(4000);
  await shot('1-match.png');

  // Opening Feedback grabs the battlefield frame before the dialog covers it.
  await page.getByRole('button', { name: 'Feedback', exact: true }).click();
  await page.getByRole('dialog', { name: /What did you see/ }).waitFor();

  // Signed-out players are asked to sign in; the emulator build signs a test player up in place. (The public build
  // only starts the game for signed-in players.) The screenshot was already taken when Feedback opened.
  await page.waitForFunction(() => !!window.rtsaiTestAccount);
  await page.getByText('Sign in to send feedback').waitFor({ timeout: 5000 }).then(() => shot('2-signed-out.png'), () => {});
  await page.evaluate(() => window.rtsaiTestAccount.signUp(`feedback-${Date.now()}@test.dev`, 'test-password-1'));
  await page.getByRole('textbox', { name: 'Your feedback' }).waitFor();
  receipt.checks.signedIn = true;

  await page.locator('.fbk-shot img').waitFor();
  const grabbed = await pixelStats('.fbk-shot img');
  console.log('battlefield screenshot', grabbed);
  assert.ok(grabbed.width >= 800 && grabbed.height >= 400, 'full battlefield resolution');
  assert.ok(grabbed.std > 8 && grabbed.colors > 60, `screenshot has real content (std ${grabbed.std.toFixed(1)}, ${grabbed.colors} colours)`);
  receipt.checks.battlefieldScreenshot = { width: grabbed.width, height: grabbed.height, luminanceStd: Number(grabbed.std.toFixed(1)), colours: grabbed.colors };
  await shot('3-feedback-open.png');

  // Mark up: arrow (default tool), box, pen, text, then undo/redo and select-to-move.
  await page.getByRole('button', { name: 'Mark up screenshot 1' }).click();
  const canvas = page.locator('.fbk-annotator-canvas');
  await canvas.waitFor();
  await page.waitForTimeout(300);
  const box = await canvas.boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  const drag = async (from, to, steps = 12) => { await page.mouse.move(...from); await page.mouse.down(); await page.mouse.move(...to, { steps }); await page.mouse.up(); };
  await shot('4-annotator.png');
  await drag(at(0.62, 0.22), at(0.46, 0.42));
  await page.getByRole('button', { name: 'Box', exact: true }).click();
  await drag(at(0.36, 0.40), at(0.56, 0.62));
  await page.getByRole('button', { name: 'Pen', exact: true }).click();
  await page.mouse.move(...at(0.2, 0.7)); await page.mouse.down();
  for (let i = 0; i <= 20; i++) await page.mouse.move(...at(0.2 + i * 0.01, 0.7 + Math.sin(i / 3) * 0.04));
  await page.mouse.up();
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.mouse.click(...at(0.64, 0.18));
  await page.locator('.fbk-text-input').fill('Harvester stuck here');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+z');
  assert.equal(await page.getByRole('button', { name: 'Redo' }).isEnabled(), true, 'undo made redo available');
  await page.keyboard.press('Control+Shift+z');
  await page.getByRole('button', { name: 'Select and move', exact: true }).click();
  await page.mouse.click(...at(0.56, 0.51));
  assert.equal(await page.getByRole('button', { name: 'Delete selected' }).isEnabled(), true, 'clicking a box selects it');
  await page.waitForTimeout(400);
  await shot('5-annotated.png');
  const before = grabbed.src;
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('dialog', { name: /What did you see/ }).waitFor();
  await page.waitForFunction(old => document.querySelector('.fbk-shot img')?.src !== old, before);
  const annotated = await pixelStats('.fbk-shot img');
  assert.ok(annotated.red > grabbed.red + 0.001, `the marked-up screenshot carries the red markup (${grabbed.red.toFixed(4)} → ${annotated.red.toFixed(4)})`);
  receipt.checks.annotated = { redShareBefore: Number(grabbed.red.toFixed(4)), redShareAfter: Number(annotated.red.toFixed(4)) };

  // Text, a voice note (fake microphone) and a file.
  await page.getByRole('textbox', { name: 'Your feedback' }).fill('My harvester stopped behind the refinery and never returned to the ore field.');
  await page.getByRole('button', { name: 'Voice note' }).click();
  await page.locator('.fbk-recording').waitFor();
  await page.waitForTimeout(2500);
  await shot('6-recording.png');
  await page.locator('.fbk-rec-stop').click();
  await page.getByRole('button', { name: 'Play voice note' }).waitFor();
  receipt.checks.voiceNote = true;
  const note = path.resolve(out, 'match-notes.txt');
  fs.writeFileSync(note, 'Tick 1840: harvester idle at refinery\n');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Drop or paste files/ }).click();
  await (await chooser).setFiles(note);
  await page.getByText('match-notes.txt').waitFor();
  await page.getByRole('radio', { name: '4 of 5' }).click();
  await shot('7-ready.png');

  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('heading', { name: 'Thank you, commander' }).waitFor();
  await shot('8-sent.png');

  // What went over the wire.
  assert.equal(tokenRequests.length, 3, 'one upload token per file');
  assert.equal(blobPuts.length, 3, 'three client uploads to Vercel Blob');
  assert.equal(feedbackPosts.length, 1);
  const sent = feedbackPosts[0].body;
  assert.match(sent.clientSubmissionId, uuid);
  for (const t of tokenRequests) {
    assert.match(t.authorization, /^Bearer ey/, 'token requests carry the player\'s Firebase ID token');
    assert.equal(t.body.type, 'blob.generate-client-token');
    assert.ok(t.body.payload.pathname.startsWith(`feedback/${sent.clientSubmissionId}/`), t.body.payload.pathname);
  }
  const kinds = tokenRequests.map(t => JSON.parse(t.body.payload.clientPayload));
  assert.deepEqual(kinds.map(k => k.kind), ['screenshot', 'voice', 'file']);
  assert.deepEqual(kinds.map(k => k.contentType), ['image/jpeg', 'audio/webm', 'text/plain']);
  assert.deepEqual(blobPuts.map(p => p.pathname), tokenRequests.map(t => t.body.payload.pathname));
  assert.ok(blobPuts.every(p => p.method === 'PUT' && p.bytes > 0 && p.authorization.startsWith('Bearer vercel_blob_client_')));
  assert.equal(sent.source, 'game');
  assert.equal(sent.category, 'Gameplay');
  assert.equal(sent.rating, 4);
  assert.match(sent.captures[0].screenshot.url, new RegExp(`^https://${store}\\.public\\.blob\\.vercel-storage\\.com/feedback/${sent.clientSubmissionId}/screenshot-1-Mock7`));
  assert.equal(sent.captures[0].screenshot.contentType, 'image/jpeg');
  const voice = sent.attachments.find(a => a.kind === 'voice'), file = sent.attachments.find(a => a.kind === 'file');
  assert.match(voice.url, /\/voice-note-Mock7RandomSuffix0123456789ab\.webm$/);
  assert.ok(voice.durationSeconds >= 2);
  assert.match(file.url, /\/match-notes-Mock7RandomSuffix0123456789ab\.txt$/);
  assert.equal(file.name, 'match-notes.txt');
  assert.deepEqual(sent.context.map(c => c.label), ['Mode', 'Match', 'Tick']);
  assert.doesNotMatch(JSON.stringify(sent), /data:image|base64/);
  receipt.checks.payload = { captures: sent.captures, attachments: sent.attachments, context: sent.context, uploadPaths: tokenRequests.map(t => t.body.payload.pathname) };

  // Full screen (the browser's tab capture, HUD included), when the browser allows it without a picker.
  await page.getByRole('button', { name: 'Back to the game' }).click();
  await page.getByRole('button', { name: 'Feedback', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your feedback' }).waitFor();
  const fullScreen = page.getByRole('button', { name: 'Full screen' });
  if (await fullScreen.isVisible()) {
    await fullScreen.click();
    const opened = await page.locator('.fbk-annotator-canvas').waitFor({ timeout: 15000 }).then(() => true, () => false);
    if (opened) {
      await page.waitForTimeout(300);
      await shot('9-full-screen-capture.png');
      await page.getByRole('button', { name: 'Done' }).click();
      await page.locator('.fbk-shot').nth(1).waitFor();
      await page.waitForTimeout(300);
      await shot('10-two-screenshots.png');
      const full = await pixelStats('.fbk-shot:last-child img');
      receipt.checks.fullScreenCapture = { width: full.width, height: full.height, luminanceStd: Number(full.std.toFixed(1)) };
    } else receipt.checks.fullScreenCapture = 'not available headless';
  }
  assert.deepEqual(errors, []);
  receipt.ok = true;
  console.log('PASS in-game feedback');
} catch (error) {
  receipt.ok = false; receipt.failure = String(error?.stack ?? error);
  await shot('failure.png').catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2));
  await browser.close();
}
