// Original-art browser check against a static public build (served by tools/static-serve.mjs):
//  * EA's notice on the skirmish and campaign screens;
//  * an America base and army and a Russia base and army in the original Westwood art (screenshots);
//  * no audio request under web/ea, no page errors;
//  * the prebaked sheet groups fetched: an America vs Russia match takes shared, effects and groups with America or
//    Russia; a modern match (Saudi Arabia vs Iran) never fetches a group made only of original countries.
//   RTSAI_TEST_URL=http://127.0.0.1:3591/ RTSAI_TEST_OUT=<dir> node tools/ea-art-browser-test.mjs [--runtime aot]
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { browserArgs, browserExecutable } from "./browser-launch.mjs";

const { chromium } = await import(pathToFileURL(process.env.RTSAI_PLAYWRIGHT_MODULE ?? path.resolve("web/node_modules/playwright-core/index.mjs")).href);
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const base = process.env.RTSAI_TEST_URL || "http://127.0.0.1:3591/";
const runtime = opt("runtime", "aot");
const out = path.resolve(process.env.RTSAI_TEST_OUT || "artifacts/ea-art");
fs.mkdirSync(out, { recursive: true });
const NOTICE = "EA has not endorsed and does not support this product.";
const ORIGINALS = ["america", "germany", "england", "france", "korea", "cuba", "libya", "iraq", "russia"];

// Two bases and armies on the flat arena (MPos cells; the west and east spawns are at u 30 / 98, v 72).
const grid = (types, player, u0, v0, du, dv, columns) => types.map((type, i) => ({ type, player, x: u0 + (i % columns) * du, y: v0 + Math.floor(i / columns) * dv }));
const showcase = {
  map: "web-arena", seed: 7,
  players: [{ slot: "Multi0", faction: "america", color: "2A6FDB", spawn: 1 }, { slot: "Multi1", faction: "russia", bot: "webidle", color: "D83A2E", spawn: 2 }],
  options: { explored: "True", fog: "False", crates: "False", shortgame: "False" },
  spawns: [
    ...grid(["gacnst", "gapowr", "garefn", "gapile", "gaweap", "gaairc", "gadept", "gatech", "gacsph", "gapill", "nasam", "atesla"], 0, 14, 40, 6, 12, 4),
    ...grid(["mtnk", "fv", "sref", "mgtk", "amcv", "cmin", "e1", "e1", "engineer", "dog", "spy", "tany", "jumpjet", "cleg", "shad", "orca"], 0, 16, 84, 2, 4, 8),
    ...grid(["nacnst", "narefn", "naweap", "naradr", "nairon", "nayard", "tesla", "nalasr", "naflak", "napowr", "nahand", "natech"], 1, 86, 40, 6, 12, 4),
    ...grid(["htnk", "apoc", "ttnk", "htk", "smcv", "harv", "sapc", "dron", "e2", "e2", "flakt", "shk", "ivan", "yuri", "terror", "zep"], 1, 88, 84, 2, 4, 8),
  ],
};

const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true, args: browserArgs() });
const receipt = { base, runtime, notice: {}, matches: [], screenshots: [] };

async function open(context) {
  const page = await context.newPage();
  const net = { sheets: [], audio: [], eaAudio: [], art: 0, index: null, errors: [] };
  page.on("pageerror", (e) => net.errors.push(String(e)));
  page.on("request", (r) => {
    const u = new URL(r.url()).pathname;
    if (/\/sprites\/[^/]+\.\d+\.bin$/.test(u)) net.sheets.push(u);
    if (/\/sprites\/index\.json$/.test(u)) net.index = r.url();
    if (/\/audio\//.test(u)) net.audio.push(u);
    if (/\/web\/ea\//.test(u) && /\.(aud|wav|ogg|mp3|bag|idx)$/i.test(u)) net.eaAudio.push(u);
    if (/web-art\.pack$/.test(u)) net.art++;
  });
  await page.goto(`${base}?profile=public&runtime=${runtime}&private=0`);
  await page.waitForFunction(() => ["setup", "error"].includes(window.store?.getState().phase), null, { timeout: 300000 });
  assert.equal(await page.evaluate(() => window.store.getState().phase), "setup", await page.evaluate(() => window.store.getState().error));
  return { page, net };
}

/** Sheet URL -> pack group, from the build's own sprites/index.json. */
async function groupsOf(net) {
  const index = await (await fetch(net.index)).json();
  const groups = new Map();
  for (const [key, p] of Object.entries(index.packings)) p.sheets.forEach((s, i) => groups.set(`${key}.${i}.bin`, s.group ?? ""));
  return [...new Set(net.sheets.map((u) => groups.get(u.split("/").pop())))].sort();
}

async function play(page, scenario) {
  await page.evaluate((s) => window.game.start(JSON.stringify(s)), scenario);
  await page.waitForFunction(() => window.store.getState().phase === "playing" && window.store.getState().ui?.tick > 30, null, { timeout: 300000 });
}

/** Centres the camera on a player's visible buildings or units (the snapshot lists the actors in view). */
async function frame(page, index, buildings, zoom = 1) {
  return page.evaluate(([index, buildings, zoom]) => {
    const g = window.game, s = g.client.cur;
    const playable = s.players.map((p, k) => [p, k]).filter(([p]) => p.flags & 4).map(([, k]) => k);
    let own = s.actors.filter((a) => !(a.flags & 16) && a.owner === playable[index]);
    // The showcase lays the base out above its army: the army is the bottom two rows (64 px apart on screen).
    const bottom = Math.max(...own.map((a) => a.sy));
    own = own.filter((a) => buildings ? a.sy < bottom - 100 : a.sy >= bottom - 100);
    if (!own.length) return 0;
    const xs = own.map((a) => a.sx), ys = own.map((a) => a.sy);
    g.cam.zoom = zoom;
    g.lookAt((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2);
    return own.length;
  }, [index, buildings, zoom]);
}

async function shot(page, name, index, buildings, zoom = 1) {
  const n = await frame(page, index, buildings);
  assert.ok(n >= 8, `${name}: ${n} actors in view`);
  await page.waitForTimeout(2500);
  await frame(page, index, buildings, zoom);
  await page.waitForTimeout(1500);
  const file = path.join(out, `${name}.png`); await page.screenshot({ path: file }); receipt.screenshots.push(file);
  return n;
}

try {
  // 1. Notice on the skirmish and campaign screens.
  {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const { page } = await open(context);
    await page.getByRole("button", { name: "Skirmish", exact: false }).first().click().catch(() => {});
    const setupNotice = await page.getByTestId("ea-notice").first().textContent({ timeout: 30000 });
    assert.ok(setupNotice.includes(NOTICE), setupNotice);
    await page.screenshot({ path: path.join(out, "setup-notice.png") });
    await page.getByRole("button", { name: "Campaign", exact: true }).click();
    const missionNotice = await page.getByTestId("ea-notice").first().textContent({ timeout: 30000 });
    assert.ok(missionNotice.includes(NOTICE), missionNotice);
    const staticNotice = await (await fetch(new URL("NOTICE", base))).text();
    assert.ok(staticNotice.includes(NOTICE));
    receipt.notice = { setup: setupNotice, missions: missionNotice, staticFile: staticNotice.split("\n").find((l) => l.includes("EA has not")) };
    await context.close();
  }

  // 2. America and Russia: bases and armies in the original art.
  {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const { page, net } = await open(context);
    await play(page, showcase);
    await page.waitForTimeout(12000); // the sheets of both groups arrive in the background
    receipt.inView = {};
    receipt.inView.americaBase = await shot(page, "america-base", 0, true);
    receipt.inView.americaUnits = await shot(page, "america-units", 0, false, 2);
    // The Russian base lies 72 cells east (MPos u; 60 px per cell on the isometric grid).
    await page.evaluate(() => window.game.lookAt(window.game.cam.x + 72 * 60, window.game.cam.y));
    await page.waitForTimeout(3000);
    await page.evaluate(() => { window.game.cam.zoom = 1; });
    receipt.inView.russiaBase = await shot(page, "russia-base", 1, true);
    receipt.inView.russiaUnits = await shot(page, "russia-units", 1, false, 2);
    const groups = await groupsOf(net);
    const unexpected = groups.filter((g) => g !== "" && g !== "fx" && !g.split("+").some((f) => f === "america" || f === "russia"));
    receipt.matches.push({ match: "america vs russia (showcase)", groups, unexpected, sheets: net.sheets.length, artPackReads: net.art, audioRequests: net.audio.length, eaAudio: net.eaAudio, errors: net.errors });
    assert.deepEqual(net.eaAudio, []);
    assert.deepEqual(net.errors, []);
    assert.deepEqual(unexpected, [], `unexpected sheet groups ${unexpected}`);
    await context.close();
  }

  // 3. A modern match fetches no group made only of original countries.
  {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const { page, net } = await open(context);
    await play(page, { map: "twin-fords", seed: 4242, players: [{ slot: "Multi0", faction: "saudi", color: "2A6FDB" }, { slot: "Multi1", faction: "iran", bot: "normal", color: "D83A2E" }],
      options: { startingunits: "medium", explored: "True", fog: "False", crates: "False" } });
    await page.waitForTimeout(10000);
    const groups = await groupsOf(net);
    const originalOnly = groups.filter((g) => g && g !== "fx" && g.split("+").every((f) => ORIGINALS.includes(f)));
    const file = path.join(out, "saudi-vs-iran.png"); await page.screenshot({ path: file }); receipt.screenshots.push(file);
    receipt.matches.push({ match: "saudi vs iran", groups, originalOnly, sheets: net.sheets.length, artPackReads: net.art, eaAudio: net.eaAudio, errors: net.errors });
    assert.deepEqual(originalOnly, [], `a modern match fetched original-art groups ${originalOnly}`);
    assert.deepEqual(net.eaAudio, []);
    assert.deepEqual(net.errors, []);
    await context.close();
  }
  receipt.passed = true;
  console.log("PASS original art: notice shown, America and Russia drawn, no original audio, sheet groups as expected");
} catch (error) {
  receipt.error = String(error?.stack ?? error);
  throw error;
} finally {
  fs.writeFileSync(path.join(out, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  await browser.close();
}
