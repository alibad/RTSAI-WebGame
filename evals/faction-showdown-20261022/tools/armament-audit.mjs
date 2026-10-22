// Which original-country units have a trait that listens to armaments by name (MindController, BaseSpawnerParent /
// CarrierParent, GrantConditionOnAttack, RevealOnFire) while their working armament is a renamed "retail-*" one the
// trait does not list. Reads the merged rules the running simulation loaded (Ui "unitrules").
//   node tools/armament-audit.mjs [--url http://127.0.0.1:3743/]
import { chromium } from "file:///C:/Users/Admin/Code/hq/games/RTSAI-WebGame/web/node_modules/playwright-core/index.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const url = opt("url", "http://127.0.0.1:3743/");
const DEFAULTS = { MindController: ["primary"], BaseSpawnerParent: ["primary"], CarrierParent: ["primary"], GrantConditionOnAttack: ["primary"], RevealOnFire: ["primary", "secondary"] };
const exe = process.env.LOCALAPPDATA + "/ms-playwright/chromium-1228/chrome-win64/chrome.exe";
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11", "--mute-audio"] });
const page = await browser.newPage();
await page.goto(`${url}?profile=public&mode=skirmish`);
await page.waitForFunction(() => window.store?.getState().phase === "setup", null, { timeout: 300000, polling: 500 });
const options = await page.evaluate(() => Object.fromEntries((window.store.getState().setup.options ?? []).map((o) => [o.id, o.default])));
await page.evaluate((s) => window.game.start(JSON.stringify(s)), { map: "ra2-tournament-2B", seed: 1, players: [
  { slot: "Multi0", faction: "russia", color: "4F80FF" }, { slot: "Multi1", faction: "america", bot: "webidle", color: "FF4848" }], options: { ...options, "rtsai-cocommander": "False" } });
await page.waitForFunction(() => window.store.getState().phase === "playing", null, { timeout: 300000, polling: 250 });
const cat = await page.evaluate(() => window.game.catalog());
const originals = ["america", "germany", "england", "france", "korea", "cuba", "libya", "iraq", "russia"];
const names = [...new Set(originals.flatMap((f) => cat.rosters[f]))];
const findings = [];
for (const n of names) {
  const r = await page.evaluate((t) => window.game.command({ cmd: "unitrules", type: t }), n);
  if (!r.actor) continue;
  // Top-level trait blocks: "Key:" at column 0, fields indented by one tab.
  const blocks = r.actor.split(/\n(?=\S)/).map((b) => { const [head, ...rest] = b.split("\n"); return { key: head.replace(/:.*$/, ""), body: rest.join("\n") }; });
  const armaments = blocks.filter((b) => /^Armament(@|$)/.test(b.key)).map((b) => ({ name: (b.body.match(/^\tName: (.+)$/m)?.[1] ?? "primary").trim(), weapon: b.body.match(/^\tWeapon: (.+)$/m)?.[1]?.trim(), requires: b.body.match(/^\tRequiresCondition: (.+)$/m)?.[1]?.trim() ?? "" }));
  const retail = armaments.filter((a) => a.name.startsWith("retail-"));
  if (!retail.length) continue;
  for (const b of blocks) {
    const type = b.key.split("@")[0];
    if (!DEFAULTS[type]) continue;
    const listed = (b.body.match(/^\tArmamentNames: (.+)$/m)?.[1]?.split(",").map((s) => s.trim())) ?? DEFAULTS[type];
    const working = armaments.filter((a) => listed.includes(a.name));
    const live = working.filter((a) => !/!ea-art/.test(a.requires));
    findings.push({ unit: n, label: cat.units.find((u) => u.name === n)?.label, trait: b.key, listens: listed, retail: retail.map((a) => a.name), broken: live.length === 0 });
  }
}
console.log(JSON.stringify(findings, null, 1));
await browser.close();
