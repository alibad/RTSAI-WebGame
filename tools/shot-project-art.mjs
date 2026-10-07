// Visual check that contains ONLY project-authored art: ?only=r2 hides terrain, effects and every actor whose
// type does not start with "r2" (the modern-faction units drawn for this project). Never use this script
// without the filter: the full scene contains private RA2 content that must not leave the machine.
//   node tools/shot-project-art.mjs --runtime aot --scenario battle-200 --wait 12 --out <png>
import fs from "node:fs";
import path from "node:path";
import { chromium } from "../web/node_modules/playwright-core/index.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const exe = path.join(process.env.LOCALAPPDATA, "ms-playwright", "chromium-1228", "chrome-win64", "chrome.exe");
const browser = await chromium.launch({ executablePath: fs.existsSync(exe) ? exe : undefined, headless: true,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: Number(opt("w", "1280")), height: Number(opt("h", "720")) } });
await page.goto(`http://127.0.0.1:3490/?runtime=${opt("runtime", "aot")}&scenario=${opt("scenario", "battle-200")}&only=r2&zoom=${opt("zoom", "0")}`);
await page.waitForFunction(() => window.game?.hud.phase === "running", null, { timeout: 600000 });
await page.evaluate(() => window.game.lookAt());
await page.waitForTimeout(1000 * Number(opt("wait", "10")));
await page.evaluate(() => {
  const g = window.game;
  const s = g.client.cur;
  const own = s.actors.filter((a) => (a.flags & 1) && a.owner === s.header.localPlayer).slice(0, 12).map((a) => a.id);
  g.overlay.selected = new Set(own);
  const z = Number(new URLSearchParams(location.search).get("zoom") ?? 0);
  if (own.length) {
    const a = s.actorById.get(own[0]);
    g.lookAt(a.sx + 120, a.sy);
  }
  if (z) g.cam.zoom = z;
});
await page.waitForTimeout(600);
const out = opt("out", "shot.png");
await page.screenshot({ path: out });
console.log("wrote", out);
await browser.close();
