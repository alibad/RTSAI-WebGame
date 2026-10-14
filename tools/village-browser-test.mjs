// Villages in random maps, in the browser: makes a map with the engine's generator (as the "New random map" tile does),
// starts it with the fog off, finds the villages (the civilian-structure and civ* actors the generator's
// CivilianBuildings pass places), frames the biggest one and photographs it while its people go about (they wander
// when idle); then two riflemen force-fire at villagers and the shots show them panicking (and the sequences the
// people played are listed).
// Serve a static page and data root first (tools/static-serve.mjs).
//   node tools/village-browser-test.mjs [seed] [terrain]   (env VILLAGE_TEST_URL, VILLAGE_SHOTS)
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "../web/node_modules/playwright-core/index.mjs";
import { browserArgs, browserExecutable } from "./browser-launch.mjs";

const url = process.env.VILLAGE_TEST_URL ?? "http://127.0.0.1:3582/?profile=public&runtime=aot&private=0";
const out = process.env.VILLAGE_SHOTS ?? "artifacts/village";
const seed = Number(process.argv[2] ?? 41);
const terrain = process.argv[3] ?? "Plains";
fs.mkdirSync(out, { recursive: true });
const VILLAGE = /^(civ[a-z0-9]*|cahse0[1367]|camsc07|cawt01|cafarm0[12]|cafncw)$/;
const PEOPLE = /^civ/;

const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true, args: browserArgs() });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") console.log("Browser:", m.text()); });
const ticks = (n) => page.evaluate((n) => new Promise((done) => {
  const start = window.store.getState().ui?.tick ?? 0;
  const t = setInterval(() => { if ((window.store.getState().ui?.tick ?? 0) >= start + n) { clearInterval(t); done(); } }, 100);
}), n);
const villageActors = () => page.evaluate((re) => {
  const g = window.game, c = g.client.cur, r = new RegExp(re);
  return c.actors.map((a) => ({ id: a.id, type: g.client.str(a.type), x: a.sx, y: a.sy, owner: a.owner, hp: a.hp, seq: g.client.str(a.sequence) }))
    .filter((a) => r.test(a.type));
}, VILLAGE.source);
try {
  await page.goto(url);
  await page.waitForFunction(() => ["setup", "error"].includes(window.store?.getState().phase), null, { timeout: 600000 });
  assert.equal(await page.evaluate(() => window.store.getState().phase), "setup");
  const id = await page.evaluate(({ seed, terrain }) => window.game.generateMap({ seed, players: 2, terrain }), { seed, terrain });
  const map = await page.evaluate((id) => window.store.getState().setup.maps.find((m) => m.id === id), id);
  console.log(`map ${id}: ${map.title}`);
  const scenario = { map: id, seed: 77, players: [{ slot: map.slots[0], faction: "saudi", color: "2A6FDB" }],
    options: { startingcash: "10000", fog: "False", explored: "True" } };
  await page.evaluate((s) => window.game.start(JSON.stringify(s)), scenario);
  await page.waitForFunction(() => window.store.getState().phase === "playing" && window.store.getState().ui?.tick > 30, null, { timeout: 300000 });
  // the whole map in view, so every actor is in the snapshot
  await page.evaluate(() => { const g = window.game; g.cam.zoom = 0.35; g.lookAt(g.cam.x, g.cam.y); });
  await ticks(10);
  let all = await villageActors();
  const counts = {};
  for (const a of all) counts[a.type] = (counts[a.type] ?? 0) + 1;
  console.log("village actors:", JSON.stringify(counts));
  assert.ok(all.some((a) => PEOPLE.test(a.type)), "no civilians on the generated map");
  assert.ok(all.some((a) => !PEOPLE.test(a.type)), "no village buildings on the generated map");
  // villages: actors within 10 cells' worth of screen px of each other
  const groups = [];
  for (const a of all) {
    const g = groups.find((g) => g.some((b) => Math.hypot(a.x - b.x, a.y - b.y) < 300));
    if (g) g.push(a); else groups.push([a]);
  }
  groups.sort((p, q) => q.length - p.length);
  console.log(`villages: ${groups.length} (${groups.map((g) => `${g.length} actors, ${g.filter((a) => PEOPLE.test(a.type)).length} people`).join("; ")})`);
  const best = groups.find((g) => g.filter((a) => PEOPLE.test(a.type)).length >= 2) ?? groups[0];
  const cx = best.reduce((s, a) => s + a.x, 0) / best.length, cy = best.reduce((s, a) => s + a.y, 0) / best.length;
  await page.evaluate(({ x, y }) => { const g = window.game; g.cam.zoom = 2; g.lookAt(x, y); }, { x: cx, y: cy });
  await ticks(20);
  await page.screenshot({ path: `${out}/village-${seed}.png` });
  // village life at 4x: idle people wander within two cells now and then
  await page.evaluate(() => window.game.client.send({ type: "speed", speed: 4 }));
  const before = (await villageActors()).filter((a) => PEOPLE.test(a.type));
  for (let k = 0; k < 6; k++) {
    await ticks(150);
    await page.screenshot({ path: `${out}/village-${seed}-life-${k}.png` });
  }
  const after = (await villageActors()).filter((a) => PEOPLE.test(a.type));
  const moved = after.filter((a) => { const b = before.find((b) => b.id === a.id); return b && Math.hypot(a.x - b.x, a.y - b.y) > 4; }).length;
  console.log(`people who walked in ${6 * 150} ticks: ${moved} of ${after.length}`);
  await page.evaluate(() => window.game.client.send({ type: "speed", speed: 1 }));
  // panic: two riflemen force-fire at the villagers nearest the middle (Ctrl + order, sent the way the page sends a
  // right click); each person hit panics and runs
  const folk = after.filter((a) => Math.hypot(a.x - cx, a.y - cy) < 400).sort((p, q) => Math.hypot(p.x - cx, p.y - cy) - Math.hypot(q.x - cx, q.y - cy));
  const tx = Math.round(folk[0].x), ty = Math.round(folk[0].y);
  const spawned = await page.evaluate(({ x, y }) => window.game.command({ cmd: "spawn", type: "r2sang", x: x + 150, y: y + 70, player: 0, count: 2 }), { x: tx, y: ty });
  await ticks(5);
  const team = await page.evaluate(() => { const g = window.game, c = g.client.cur; return c.actors.filter((a) => a.owner === c.header.localPlayer && g.client.str(a.type) === "r2sang").map((a) => a.id); });
  console.log(`riflemen: spawn ${JSON.stringify(spawned)}, ${team.length} in view; targets ${folk.slice(0, 2).map((a) => a.type).join(", ")}`);
  await page.evaluate(({ x, y }) => window.game.lookAt(x, y), { x: tx, y: ty });
  for (const [k, id] of team.entries()) {
    const t = folk[Math.min(k, folk.length - 1)];
    await page.evaluate((id) => window.game.select([id]), id);
    await ticks(1);
    await page.evaluate(({ x, y }) => window.game.client.send({ type: "click", x, y, button: 2, mods: 4, t: performance.now() }), { x: Math.round(t.x), y: Math.round(t.y) });
  }
  const seen = new Set();
  for (let k = 0; k < 10; k++) {
    await ticks(6);
    await page.screenshot({ path: `${out}/village-${seed}-panic-${k}.png` });
    for (const a of await villageActors()) if (PEOPLE.test(a.type)) seen.add(`${a.type}:${a.seq}`);
  }
  console.log(`sequences the people played: ${[...seen].join(", ")}`);
  const panic = [...seen].filter((s) => s.split(":")[1].startsWith("panic-"));
  console.log(`people panicking: ${panic.length} (${panic.join(", ")})`);
  assert.deepEqual(errors, []);
  console.log("PASS");
} finally {
  await browser.close();
}
