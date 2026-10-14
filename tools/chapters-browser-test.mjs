// Lines of Hope, Act III chapters in the browser: each mission is listed by the campaign screen, launches through the
// player UI, shows its objectives, completes one objective (or, for Glass Island, trips the sensor masts), then runs
// forward at 8x with an idle player until the match ends (the failure path) or the time limit. Radio captions shown
// during the run are recorded. Serve a static page and data root first (tools/static-serve.mjs).
//   node tools/chapters-browser-test.mjs [mission-id]   (env CHAPTERS_TEST_URL, CHAPTERS_SHOTS, CHAPTERS_LIMIT minutes)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "../web/node_modules/playwright-core/index.mjs";

const url = process.env.CHAPTERS_TEST_URL ?? "http://127.0.0.1:3492/?mode=missions&profile=public";
const out = process.env.CHAPTERS_SHOTS ?? "artifacts/chapters";
fs.mkdirSync(out, { recursive: true });
const ids = ["lights-in-the-water", "hold-the-ferry-line", "glass-island", "black-platform", "every-light-on"].filter((id) => !process.argv[2] || id === process.argv[2]);
const catalog = JSON.parse(fs.readFileSync("content/missions.json", "utf8"));
const exe = path.join(process.env.LOCALAPPDATA, "ms-playwright/chromium-1228/chrome-win64/chrome.exe");
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--use-angle=d3d11", "--ignore-gpu-blocklist"] });
const results = [];
const state = (page) => page.evaluate(() => {
  const s = window.store.getState();
  return { phase: s.phase, win: ["Won", "Lost"].includes(s.ui?.win) ? s.ui.win : "", tick: s.ui?.tick ?? 0, mission: s.ui?.mission ?? null };
});
const summary = (m) => m?.objectives.map((o) => `${o.status.padEnd(8)}${o.waiting ? " (waiting)" : ""} ${o.text}${o.progress ? ` [${o.progress}]` : ""}`).join("\n  ");
// A marker of the objective that names the actor (the page's "Locate" buttons), as world px.
const marker = (s, name) => s.mission.objectives.flatMap((o) => o.markers ?? []).find((m) => m.name === name);
// The sandbox spawn command: units for the player at a world px position.
const spawn = (page, type, at, count = 1, dx = 0, dy = 0) => page.evaluate(({ type, at, count, dx, dy }) =>
  window.game.command({ cmd: "spawn", type, x: at.x + dx, y: at.y + dy, player: 0, count }), { type, at, count, dx, dy });
const until = (page, fn, arg, ms) => page.waitForFunction(fn, arg, { timeout: ms, polling: 250 });
try {
  for (const id of ids) {
    const def = catalog.find((m) => m.id === id);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    const radio = new Set();
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
    const listen = setInterval(() => page.evaluate(() => [...document.querySelectorAll(".rd-call .rd-line")].map((e) => e.textContent))
      .then((lines) => lines.forEach((l) => radio.add(l))).catch(() => {}), 500);
    let s = await state(page);
    assert.deepEqual(s.mission.objectives.map((o) => o.text), def.objectives.map((o) => o.text));
    assert(s.mission.objectives.every((o) => o.status === "active"), summary(s.mission));
    console.log(`${id}: launched at tick ${s.tick}\n  ${summary(s.mission)}`);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${out}/${id}-start.png` });
    const checks = {};
    let completed = null;
    if (id === "lights-in-the-water") {
      await page.evaluate(() => window.game.client.send({ type: "speed", speed: 8 }));
      // Three units reach the first group: spawn them at the objective's own marker (the sandbox spawn command).
      console.log(`${id}: spawn at the cove ->`, JSON.stringify(await spawn(page, "r2technical", marker(s, "SurvivorsCove"), 3)));
      await until(page, () => window.store.getState().ui?.mission?.objectives[0].status !== "active" || ["Won", "Lost"].includes(window.store.getState().ui?.win), null, 120000);
      completed = 0;
    } else if (id === "hold-the-ferry-line") {
      await page.evaluate(() => window.game.client.send({ type: "speed", speed: 8 }));
      // Loading takes six minutes of game time; then the ferries sail.
      await until(page, () => window.store.getState().ui?.mission?.objectives[0].status !== "active" || ["Won", "Lost"].includes(window.store.getState().ui?.win), null, 600000);
      completed = 0;
      await page.waitForTimeout(4000);
      await page.screenshot({ path: `${out}/${id}-ferries.png` });
    } else if (id === "glass-island") {
      // The sensor zones are drawn over the shroud (the snapshot's above-shroud pass), Tanya with her 1953 art.
      checks.zonesAboveShroud = await page.evaluate(() => window.game.client.cur.captured.batches.filter((b) => b.above).length);
      assert(checks.zonesAboveShroud > 0, "no sensor zone drawn over the shroud");
      const bluff = marker(s, "MastBluff");
      await page.evaluate((m) => window.game.lookAt(m.x, m.y), bluff);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${out}/${id}-mast.png` });
      // A rifleman walks into the bluff mast's zone: once its sweep comes on it trips, the alarm fires (the radio keys
      // off ui.mission.events) and one alarm is spent; a second mast ends the operation on normal.
      await page.evaluate(() => window.game.client.send({ type: "speed", speed: 4 }));
      await spawn(page, "e1", bluff, 1, 40, 20);
      await until(page, () => (window.store.getState().ui?.mission?.events ?? []).includes("alarm"), null, 120000);
      s = await state(page);
      checks.afterFirstAlarm = { events: s.mission.events, progress: s.mission.objectives[2].progress, win: s.win };
      console.log(`${id}: first alarm at tick ${s.tick}: ${JSON.stringify(checks.afterFirstAlarm)}`);
      assert.equal(s.mission.objectives[2].status, "active");
      await page.waitForTimeout(2500);
      await page.screenshot({ path: `${out}/${id}-alarm.png` });
      // The alarm's radio call (keyed off ui.mission.events) comes on air once the calls before it are dismissed.
      for (let i = 0; i < 40 && ![...radio].some((l) => /seen us/.test(l)); i++) {
        const line = await page.locator(".rd-call .rd-line").textContent().catch(() => "");
        if (line && !/seen us/.test(line)) await page.getByRole("button", { name: "Dismiss radio call" }).click().catch(() => {});
        await page.waitForTimeout(500);
      }
      checks.alarmCall = [...radio].find((l) => /seen us/.test(l)) ?? null;
      assert(checks.alarmCall, `the alarm call never came on air: ${[...radio].join(" | ")}`);
      // Tanya, close up: the 1953 commando art (america faction) on the player's side.
      const tanya = await page.evaluate(() => { const c = window.game.client; const a = c.cur.actors.find((x) => c.str(x.type) === "tany"); return a && { x: a.sx, y: a.sy }; });
      await page.evaluate((m) => window.game.lookAt(m.x, m.y), tanya);
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${out}/${id}-tanya.png`, clip: { x: 520, y: 300, width: 400, height: 300 } });
      await spawn(page, "e1", marker(s, "MastRidge"), 1, 30, 10);
      await until(page, () => ["Won", "Lost"].includes(window.store.getState().ui?.win), null, 120000);
      s = await state(page);
      assert.equal(s.win, "Lost"); assert.equal(s.mission.objectives[2].status, "failed");
    } else if (id === "black-platform") {
      s = await state(page);
      assert(s.mission.events.includes("curtain"), "the curtain did not go up");
      assert(s.mission.objectives[1].waiting, "the charges are not waiting for the control room");
      const room = marker(s, "CurtainControl");
      await page.evaluate((m) => window.game.lookAt(m.x, m.y + 120), room);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${out}/${id}-curtain.png` });
      // Engineers (and an escort) beside the control room take it: the curtain comes down.
      await spawn(page, "r2falcon", room, 4, 0, 90);
      await spawn(page, "engineer", room, 4, 0, 70);
      await page.waitForTimeout(800);
      const engineers = await page.evaluate(() => { const c = window.game.client; return c.cur.actors.filter((a) => c.str(a.type) === "engineer" && a.owner === c.cur.players.findIndex((p) => p.flags & 1)).map((a) => a.id); });
      await page.evaluate((ids) => window.game.select(ids), engineers);
      await page.waitForTimeout(300);
      await page.evaluate((m) => window.game.orderAt(m.x, m.y), room);
      await page.evaluate(() => window.game.client.send({ type: "speed", speed: 4 }));
      await until(page, () => window.store.getState().ui?.mission?.objectives[0].status !== "active" || ["Won", "Lost"].includes(window.store.getState().ui?.win), null, 180000);
      s = await state(page);
      completed = 0;
      assert(s.mission.events.includes("curtain-down"), JSON.stringify(s.mission.events));
      await page.evaluate((m) => window.game.lookAt(m.x, m.y), marker(s, "GenSW"));
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${out}/${id}-curtain-down.png` });
      await page.evaluate(() => window.game.client.send({ type: "speed", speed: 8 }));
    } else if (id === "every-light-on") {
      s = await state(page);
      assert(["picture", "hub-sealed"].every((e) => s.mission.events.includes(e)), JSON.stringify(s.mission.events));
      assert(s.mission.objectives[1].waiting, "the capture is not waiting for the towns");
      await page.evaluate((m) => window.game.lookAt(m.x, m.y), marker(s, "DomeEast"));
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${out}/${id}-dome.png` });
      await page.evaluate(() => window.game.client.send({ type: "speed", speed: 8 }));
    }
    s = await state(page);
    if (completed !== null) {
      console.log(`${id}: objective ${completed} -> ${s.mission.objectives[completed].status} at tick ${s.tick}\n  ${summary(s.mission)}`);
      assert.equal(s.mission.objectives[completed].status, "complete");
      await page.screenshot({ path: `${out}/${id}-objective.png` });
    }
    // Idle player at 8x: the match must end by itself (the failure path) or reach the time limit.
    const limit = 25 * 60 * Number(process.env.CHAPTERS_LIMIT ?? 17);
    let last = 0;
    while (!s.win && s.tick < limit) {
      await page.waitForTimeout(5000);
      s = await state(page);
      if (s.tick - last >= 25 * 60) { last = s.tick; console.log(`  ${(s.tick / 1500).toFixed(1)} min: ${s.mission.objectives.map((o) => o.status[0] + (o.progress ? `(${o.progress})` : "")).join(" ")} | ${(s.mission.events ?? []).join(",")}`); }
    }
    await page.waitForTimeout(1500);
    clearInterval(listen);
    await page.screenshot({ path: `${out}/${id}-end.png` });
    console.log(`${id}: ended "${s.win}" at ${(s.tick / 1500).toFixed(2)} min\n  ${summary(s.mission)}\n  events: ${(s.mission.events ?? []).join(", ")}\n  radio: ${[...radio].join(" | ")}`);
    results.push({ id, win: s.win, minutes: +(s.tick / 1500).toFixed(2), objectives: s.mission.objectives.map((o) => ({ text: o.text, status: o.status, progress: o.progress })),
      events: s.mission.events ?? [], radio: [...radio], checks, errors });
    assert.equal(errors.length, 0, JSON.stringify(errors));
    await page.close();
  }
  fs.writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
} finally { await browser.close(); }
