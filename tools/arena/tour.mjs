// A screen recording of the admin's AI Arena page, for the notebook and the owner's talks: the run panel, the
// notebook (an entry opened and its films played), the ladder, the wins table and one game's decision log.
//   node tools/arena/tour.mjs [--url http://127.0.0.1:3451/workshop/arena?mode=ra2] [--entry "<title words>"] [--dir <arena data>]
// Writes <arena data>/films/tour-arena.mp4 and a .jpg poster. Needs the local admin app and the Arena runner.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const url = opt("url", "http://127.0.0.1:3451/workshop/arena?mode=ra2");
const entry = opt("entry", "Pick units against");
const dir = opt("dir", path.join(process.env.LOCALAPPDATA ?? os.homedir(), "RTSAI-WebGame", "arena"));

const { chromium } = await import(pathToFileURL(path.join(repo, "web", "node_modules", "playwright-core", "index.mjs")).href);
const root = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
const chrome = (fs.existsSync(root) ? fs.readdirSync(root) : []).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
  .map((d) => path.join(root, d, "chrome-win64", "chrome.exe")).find((f) => fs.existsSync(f));
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const size = { width: 1440, height: 900 };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arena-tour-"));
const context = await browser.newContext({ viewport: size, recordVideo: { dir: tmp, size } });
const page = await context.newPage();
const wait = (ms) => page.waitForTimeout(ms);
/** Scrolls smoothly so an element sits near the top of the window. */
const glide = async (selector, offset = 90) => {
  const y = await page.locator(selector).first().evaluate((el, o) => el.getBoundingClientRect().top + window.scrollY - o, offset);
  await page.evaluate(async (to) => {
    const from = window.scrollY, steps = 40;
    for (let i = 1; i <= steps; i++) { window.scrollTo(0, from + (to - from) * (1 - Math.cos((i / steps) * Math.PI)) / 2); await new Promise((r) => setTimeout(r, 16)); }
  }, y);
};

try {
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForSelector(".arena-notebook", { timeout: 60000 });
  const loaded = (Date.now() - t0) / 1000;
  await wait(2500);
  await glide(".arena-notebook");
  await wait(1500);
  const head = page.locator(".nb-head", { hasText: entry }).first();
  await head.click();
  await wait(800);
  await glide(".arena-notebook li.open", 70);
  await page.locator(".arena-notebook li.open video").evaluate((v) => { v.muted = true; return v.play(); }).catch(() => {});
  await wait(12000);
  const reel = page.locator(".arena-notebook li.open .nb-reel button");
  if (await reel.count() > 1) { await reel.nth(1).click(); await wait(400); await page.locator(".arena-notebook li.open video").evaluate((v) => { v.muted = true; return v.play(); }).catch(() => {}); await wait(7000); }
  await glide(".arena-ladder");
  await wait(3500);
  await glide(".arena-matrix");
  await page.locator(".arena-matrix button.cell").first().hover().catch(() => {});
  await wait(3500);
  await glide(".arena-games");
  await page.locator(".arena-games > li > button").first().click();
  await wait(1500);
  await glide(".arena-log");
  await wait(4000);
  const video = page.video();
  await context.close();
  const out = path.join(dir, "films", "tour-arena.mp4");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(loaded + 0.3), "-i", await video.path(), "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", "8", "-i", out, "-frames:v", "1", "-q:v", "3", out.replace(/\.mp4$/, ".jpg")]);
  console.log(out);
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
