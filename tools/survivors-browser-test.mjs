// Lights in the Water's stranded crews in the browser: launches the chapter through the campaign screen, frames each
// group of survivors (fishermen, a man in a thobe, an elder, a young deckhand: the standalone's civilians) and the
// Orion patrol beside it, then sends three units to the cove so the first objective completes with the crew in view.
// Serve a static page and data root first (tools/static-serve.mjs).
//   node tools/survivors-browser-test.mjs   (env SURVIVORS_TEST_URL, SURVIVORS_SHOTS)
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "../web/node_modules/playwright-core/index.mjs";
import { browserArgs, browserExecutable } from "./browser-launch.mjs";

const url = process.env.SURVIVORS_TEST_URL ?? "http://127.0.0.1:3582/?mode=missions&profile=public";
const out = process.env.SURVIVORS_SHOTS ?? "artifacts/survivors";
fs.mkdirSync(out, { recursive: true });
const id = "lights-in-the-water";
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true, args: browserArgs() });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") console.log("Browser:", m.text()); });
const mission = () => page.evaluate(() => window.store.getState().ui?.mission ?? null);
const marker = (m, name) => m.objectives.flatMap((o) => o.markers ?? []).find((k) => k.name === name);
const ticks = (n) => page.evaluate((n) => new Promise((done) => {
  const start = window.store.getState().ui?.tick ?? 0;
  const t = setInterval(() => { if ((window.store.getState().ui?.tick ?? 0) >= start + n) { clearInterval(t); done(); } }, 100);
}), n);
try {
  await page.goto(url);
  await page.waitForFunction(() => ["setup", "error"].includes(window.store?.getState().phase), null, { timeout: 600000 });
  const def = await page.evaluate((id) => (window.store.getState().setup?.missions ?? []).find((m) => m.id === id), id);
  assert.ok(def, `${id} not in the campaign catalog`);
  await page.getByRole("button", { name: new RegExp(def.title) }).first().click();
  const start = page.getByRole("button", { name: "Start mission", exact: true });
  await start.waitFor({ timeout: 600000 });
  await page.waitForFunction(() => !document.querySelector("button[disabled]")?.textContent?.includes("Start mission"), null, { timeout: 600000 });
  await start.click();
  await page.waitForFunction((id) => window.store.getState().phase === "playing" && window.store.getState().ui?.mission?.id === id, id, { timeout: 600000 });
  let m = await mission();
  // the survivors, as the snapshot names them
  const crews = await page.evaluate(() => {
    const g = window.game, c = g.client.cur;
    return c.actors.map((a) => ({ type: g.client.str(a.type), x: a.sx, y: a.sy, seq: g.client.str(a.sequence) })).filter((a) => /^civ/.test(a.type));
  });
  console.log(`civilians in the snapshot: ${crews.length} (${[...new Set(crews.map((a) => a.type))].join(", ")})`);
  for (const site of ["SurvivorsCove", "SurvivorsJetty", "StrangerSite"]) {
    const k = marker(m, site);
    assert.ok(k, `no marker for ${site}`);
    await page.evaluate((k) => { const g = window.game; g.cam.zoom = 2; g.lookAt(k.x, k.y - 20); }, k);
    await ticks(8);
    await page.screenshot({ path: `${out}/${site}.png` });
  }
  // three technicals reach the cove: the first objective completes with the crew beside them
  const cove = marker(m, "SurvivorsCove");
  await page.evaluate((k) => window.game.command({ cmd: "spawn", type: "r2technical", x: Math.round(k.x + 40), y: Math.round(k.y + 40), player: 0, count: 3 }), cove);
  await page.waitForFunction(() => window.store.getState().ui?.mission?.objectives[0].status !== "active", null, { timeout: 120000 });
  await page.evaluate((k) => window.game.lookAt(k.x, k.y - 20), cove);
  await ticks(8);
  await page.screenshot({ path: `${out}/SurvivorsCove-found.png` });
  m = await mission();
  console.log(m.objectives.map((o) => `${o.status.padEnd(8)} ${o.text}`).join("\n"));
  assert.equal(m.objectives[0].status, "complete");
  assert.deepEqual(errors, []);
  console.log("PASS");
} finally {
  await browser.close();
}
