// The final merged rules of actors as the running simulation loaded them (the Ui "unitrules" command), for a faction.
//   node tools/unit-rules.mjs --types yuri,e1 [--faction russia] [--url http://127.0.0.1:3743/]
import { chromium } from "file:///C:/Users/Admin/Code/hq/games/RTSAI-WebGame/web/node_modules/playwright-core/index.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const types = opt("types", "yuri").split(","), faction = opt("faction", "russia"), url = opt("url", "http://127.0.0.1:3743/");
const exe = process.env.LOCALAPPDATA + "/ms-playwright/chromium-1228/chrome-win64/chrome.exe";
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11", "--mute-audio"] });
const page = await browser.newPage();
await page.goto(`${url}?profile=public&mode=skirmish`);
await page.waitForFunction(() => window.store?.getState().phase === "setup", null, { timeout: 300000, polling: 500 });
const options = await page.evaluate(() => Object.fromEntries((window.store.getState().setup.options ?? []).map((o) => [o.id, o.default])));
await page.evaluate((s) => window.game.start(JSON.stringify(s)), { map: "ra2-tournament-2B", seed: 1, players: [
  { slot: "Multi0", faction, color: "4F80FF" }, { slot: "Multi1", faction: "america", bot: "webidle", color: "FF4848" }], options: { ...options, "rtsai-cocommander": "False" } });
await page.waitForFunction(() => window.store.getState().phase === "playing", null, { timeout: 300000, polling: 250 });
for (const t of types) {
  const r = await page.evaluate((t) => window.game.command({ cmd: "unitrules", type: t }), t);
  console.log(`===== ${t}\n${r.actor ?? JSON.stringify(r)}\n----- weapons\n${Object.entries(r.weapons ?? {}).map(([k, v]) => `${k}:\n${v}`).join("\n")}`);
}
await browser.close();
