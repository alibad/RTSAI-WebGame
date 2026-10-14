// Lines of Hope, Act III chapters in the browser: each mission is listed by the campaign screen, launches through the
// player UI, shows its objectives, completes one objective, then runs forward at 8x with an idle player until the
// match ends (the failure path) or the time limit. Serve a static page and data root first (tools/static-serve.mjs).
//   node tools/chapters-browser-test.mjs [mission-id]   (env CHAPTERS_TEST_URL, CHAPTERS_SHOTS)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "../web/node_modules/playwright-core/index.mjs";

const url = process.env.CHAPTERS_TEST_URL ?? "http://127.0.0.1:3492/?mode=missions&profile=public";
const out = process.env.CHAPTERS_SHOTS ?? "artifacts/chapters";
fs.mkdirSync(out, { recursive: true });
const ids = ["lights-in-the-water", "hold-the-ferry-line"].filter((id) => !process.argv[2] || id === process.argv[2]);
const catalog = JSON.parse(fs.readFileSync("content/missions.json", "utf8"));
const exe = path.join(process.env.LOCALAPPDATA, "ms-playwright/chromium-1228/chrome-win64/chrome.exe");
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--use-angle=d3d11", "--ignore-gpu-blocklist"] });
const results = [];
const state = (page) => page.evaluate(() => {
  const s = window.store.getState();
  return { phase: s.phase, win: ["Won", "Lost"].includes(s.ui?.win) ? s.ui.win : "", tick: s.ui?.tick ?? 0, mission: s.ui?.mission ?? null };
});
const summary = (m) => m?.objectives.map((o) => `${o.status.padEnd(8)} ${o.text}${o.progress ? ` [${o.progress}]` : ""}`).join("\n  ");
try {
  for (const id of ids) {
    const def = catalog.find((m) => m.id === id);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") console.log("Browser:", m.text()); });
    await page.goto(url);
    await page.waitForFunction(() => ["setup", "error"].includes(window.store?.getState().phase), null, { timeout: 600000 });
    const listed = await page.evaluate(() => (window.store.getState().setup?.missions ?? []).map((m) => m.id));
    assert(listed.includes(id), `${id} not in the campaign catalog: ${listed}`);
    await page.getByRole("button", { name: new RegExp(def.title) }).first().click();
    const start = page.getByRole("button", { name: "Start mission", exact: true });
    await start.waitFor({ timeout: 600000 });
    await page.waitForFunction(() => !document.querySelector("button[disabled]")?.textContent?.includes("Start mission"), null, { timeout: 600000 });
    await page.screenshot({ path: `${out}/${id}-briefing.png` });
    await start.click();
    await page.waitForFunction((id) => window.store.getState().phase === "playing" && window.store.getState().ui?.mission?.id === id, id, { timeout: 600000 });
    let s = await state(page);
    assert.deepEqual(s.mission.objectives.map((o) => o.text), def.objectives.map((o) => o.text));
    assert(s.mission.objectives.every((o) => o.status === "active"), summary(s.mission));
    console.log(`${id}: launched at tick ${s.tick}\n  ${summary(s.mission)}`);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${out}/${id}-start.png` });
    await page.evaluate(() => window.game.client.send({ type: "speed", speed: 8 }));
    let completed;
    if (id === "lights-in-the-water") {
      // Three units reach the first group: spawn them at the objective's own marker (the sandbox spawn command).
      const marker = s.mission.objectives[0].markers.find((m) => m.name === "SurvivorsCove");
      const reply = await page.evaluate((m) => window.game.command({ cmd: "spawn", type: "r2technical", x: m.x, y: m.y, player: 0, count: 3 }), marker);
      console.log(`${id}: spawn at the cove ->`, JSON.stringify(reply));
      await page.waitForFunction(() => window.store.getState().ui?.mission?.objectives[0].status !== "active" || ["Won", "Lost"].includes(window.store.getState().ui?.win), null, { timeout: 120000 });
      completed = 0;
    } else {
      // Loading takes six minutes of game time; then the ferries sail.
      await page.waitForFunction(() => window.store.getState().ui?.mission?.objectives[0].status !== "active" || ["Won", "Lost"].includes(window.store.getState().ui?.win), null, { timeout: 600000 });
      completed = 0;
      await page.waitForTimeout(4000);
      await page.screenshot({ path: `${out}/${id}-ferries.png` });
    }
    s = await state(page);
    console.log(`${id}: objective ${completed} -> ${s.mission.objectives[completed].status} at tick ${s.tick}\n  ${summary(s.mission)}`);
    assert.equal(s.mission.objectives[completed].status, "complete");
    await page.screenshot({ path: `${out}/${id}-objective.png` });
    // Idle player at 8x: the match must end by itself (the failure path) or reach the time limit.
    const limit = 25 * 60 * 17;
    let last = 0;
    while (!s.win && s.tick < limit) {
      await page.waitForTimeout(5000);
      s = await state(page);
      if (s.tick - last >= 25 * 60) { last = s.tick; console.log(`  ${(s.tick / 1500).toFixed(1)} min: ${s.mission.objectives.map((o) => o.status[0] + (o.progress ? `(${o.progress})` : "")).join(" ")}`); }
    }
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${out}/${id}-end.png` });
    console.log(`${id}: ended "${s.win}" at ${(s.tick / 1500).toFixed(2)} min\n  ${summary(s.mission)}`);
    results.push({ id, win: s.win, minutes: +(s.tick / 1500).toFixed(2), objectives: s.mission.objectives.map((o) => ({ text: o.text, status: o.status, progress: o.progress })), errors });
    assert.equal(errors.length, 0, JSON.stringify(errors));
    await page.close();
  }
  fs.writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
} finally { await browser.close(); }
