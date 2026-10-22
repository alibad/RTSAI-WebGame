// The reload notice on a release-style page: no notice while BUILD.json names this page's roots, the notice once it
// names newer ones; and the main menu never asks for the local-only api/content-status.
import { chromium } from "file:///C:/Users/Admin/Code/hq/games/RTSAI-WebGame/web/node_modules/playwright-core/index.mjs";
import fs from "node:fs";
const exe = process.env.LOCALAPPDATA + "/ms-playwright/chromium-1228/chrome-win64/chrome.exe";
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11", "--mute-audio"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const asked = [];
page.on("request", (r) => { if (/content-status|BUILD\.json/.test(r.url())) asked.push(r.url().replace(/^https?:\/\/[^/]+/, "")); });
const live = JSON.parse(fs.readFileSync("C:/Users/Admin/Code/hq/games/artifacts/faction-showdown-20261021/release-effects-fix/page-test/BUILD.json", "utf8"));
let newer = false;
await page.route(/BUILD\.json/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(newer ? { ...live, rtRoot: "rt-000000000001/", dataRoot: "data-000000000001/" } : live) }));
await page.goto("http://127.0.0.1:3744/?profile=public");
await page.waitForFunction(() => ["setup", "error"].includes(window.store?.getState().phase), null, { timeout: 300000, polling: 500 });
await page.waitForTimeout(11000);
const visibility = () => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
await visibility(); await page.waitForTimeout(1500);
const before = await page.locator(".release-notice").count();
newer = true; await visibility(); await page.waitForTimeout(1500);
const after = await page.locator(".release-notice").innerText().catch(() => null);
await page.screenshot({ path: "C:/Users/Admin/Code/hq/games/artifacts/faction-showdown-20261021/dev/notice-check.png" });
console.log(JSON.stringify({ phase: await page.evaluate(() => window.store.getState().phase), noticeWhileCurrent: before, noticeWhenNewer: after, requests: asked }));
await browser.close();
