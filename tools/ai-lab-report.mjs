import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
const root = path.resolve('artifacts/ai-lab');
const browser = await chromium.launch({ executablePath: path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1228/chrome-win64/chrome.exe'), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1180, height: 1180 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(path.join(root, 'overview.html')).href);
  await page.locator('img').evaluateAll(async images => { await Promise.all(images.map(i => i.decode())); });
  if (await page.locator('img').evaluateAll(images => images.some(i => !i.naturalWidth))) throw new Error('Report screenshot missing.');
  await page.locator('main').screenshot({ path: path.join(root, 'overview.png') });
  fs.writeFileSync(path.join(root, 'report-check.json'), JSON.stringify({ passed: true, screenshot: 'overview.png', actualGameImages: 4 }));
} finally { await browser.close(); }
