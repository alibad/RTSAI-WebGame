// Opens the spike in headless Chromium, waits for the world, waits --wait seconds, then evaluates each
// --eval expression in the page and prints the JSON result. For debugging without screenshots.
//   node tools/debug-page.mjs --runtime aot --scenario battle-50 --wait 5 --eval "window.game.hud.tick"
import fs from "node:fs";
import path from "node:path";
import { chromium } from "../web/node_modules/playwright-core/index.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const evals = argv.flatMap((a, i) => (a === "--eval" ? [argv[i + 1]] : []));
const exe = path.join(process.env.LOCALAPPDATA, "ms-playwright", "chromium-1228", "chrome-win64", "chrome.exe");
const browser = await chromium.launch({ executablePath: fs.existsSync(exe) ? exe : undefined, headless: true,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (e) => console.log("pageerror", String(e)));
page.on("console", (m) => { if (m.type() === "error") console.log("console.error", m.text()); });
await page.goto(`http://127.0.0.1:3490/?runtime=${opt("runtime", "aot")}&scenario=${opt("scenario", "battle-50")}${opt("extra", "")}`);
await page.waitForFunction(() => window.game?.hud.phase === "running" || window.game?.hud.phase === "error", null, { timeout: 600000 });
await page.waitForTimeout(1000 * Number(opt("wait", "3")));
for (const e of evals) {
  try { console.log(e, "=>", JSON.stringify(await page.evaluate(`(async () => (${e}))()`))); }
  catch (err) { console.log(e, "=> ERROR", String(err).slice(0, 500)); }
}
await browser.close();
