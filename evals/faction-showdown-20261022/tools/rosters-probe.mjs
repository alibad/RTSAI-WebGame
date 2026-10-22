// Costs of the economy buildings and the starting-units presets, read from the live game's rules (the unit catalog
// the battle simulator uses), plus what each starting-units preset gives each faction.
//   node tools/costs.mjs
import { chromium } from "file:///C:/Users/Admin/Code/hq/games/RTSAI-WebGame/web/node_modules/playwright-core/index.mjs";

const exe = process.env.LOCALAPPDATA + "/ms-playwright/chromium-1228/chrome-win64/chrome.exe";
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11", "--mute-audio"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto("http://127.0.0.1:3741/?profile=public&mode=skirmish");
await page.waitForFunction(() => window.store?.getState().phase === "setup", null, { timeout: 300000, polling: 500 });
const options = await page.evaluate(() => Object.fromEntries((window.store.getState().setup.options ?? []).map((o) => [o.id, o.default])));
await page.evaluate((o) => window.game.start(JSON.stringify({ map: "ra2-tournament-2B", seed: 1, players: [
  { slot: "Multi0", faction: "israel", bot: "normal", color: "4F80FF" }, { slot: "Multi1", faction: "hezbollah", bot: "normal", color: "FF4848" }],
  options: { ...o, cheats: "False", "rtsai-cocommander": "False", startingunits: "none", startingcash: "2500" } })), options);
await page.waitForFunction(() => window.store.getState().phase === "playing", null, { timeout: 300000, polling: 250 });
await page.evaluate(() => window.game.client.send({ type: "pause", paused: true }));
const cat = await page.evaluate(() => window.game.catalog());
const units = cat.units ?? cat;
const want = /^(gapowr|napowr|nanrct|garefn|narefn|gapile|nahand|gaweap|naweap|gacnst|nacnst)$/;
const out = { rosters: cat.rosters, units: units.map((u) => ({ name: u.name, label: u.label, queue: u.queue, kind: u.kind, cost: u.cost })) }; (await import("node:fs")).writeFileSync(new URL("../dev/rosters.json", import.meta.url), JSON.stringify(out)); console.log("rosters", Object.keys(cat.rosters ?? {}).length);
for (const u of units.filter((u) => want.test(u.name))) console.log(`  ${u.name.padEnd(7)} ${String(u.label).padEnd(28)} $${u.cost}`);
const extra = units.filter((u) => /powr|refn|pile|hand|weap/.test(u.name) && !want.test(u.name));
if (extra.length) console.log("faction variants:", extra.map((u) => `${u.name} ${u.label} $${u.cost}`).join("; "));
await browser.close();
