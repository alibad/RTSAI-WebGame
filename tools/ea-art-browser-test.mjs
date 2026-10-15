// Original-art and original-voice browser check against a static public build (served by tools/static-serve.mjs):
//  * EA's notice on the skirmish and campaign screens;
//  * an America base and army and a Russia base and army in the original Westwood art (screenshots);
//  * original voices: an America G.I. speaks GIVoice and an America dog the original dog clips, a Russia Conscript
//    ConscriptVoice, all fetched from web/ea/audio and decoded by the engine; a Russia Tesla tank fires its original
//    bolt; a China rifleman keeps China's voice and a China dog barks with the original clips, the only original clips
//    a modern match fetches;
//  * no music, no archive and no clip outside web/ea/audio's listed .wav files is requested; no page errors;
//  * the prebaked sheet groups fetched: an America vs Russia match takes shared, effects and groups with America or
//    Russia; a modern match never fetches a group made only of original countries.
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
const EA_CLIP = /\/audio\/web\/ea\/audio\/([a-z0-9_-]+\.wav)$/;
// The original clips the Attack Dog's voice set and bite name: the only ones a modern faction may play.
const DOG_CLIPS = /^(idog[a-z]+|igenzapa|igenmel[abc]|igenexpa|ienadia)\.wav$/;

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
    ...grid(["htnk", "apoc", "ttnk", "htk", "smcv", "harv", "sapc", "dron", "e2", "e2", "flakt", "shk", "ivan", "yuri", "dog", "zep"], 1, 88, 84, 2, 4, 8),
  ],
};
// The local player's units, in a small arena match against an idle bot.
const squad = (faction, enemy, types) => ({
  map: "web-arena", seed: 11,
  players: [{ slot: "Multi0", faction, color: "2A6FDB", spawn: 1 }, { slot: "Multi1", faction: enemy, bot: "webidle", color: "D83A2E", spawn: 2 }],
  options: { explored: "True", fog: "False", crates: "False", shortgame: "False" },
  spawns: grid(types, 0, 24, 70, 3, 4, 4),
});

const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true, args: browserArgs() });
const receipt = { base, runtime, notice: {}, matches: [], voices: [], screenshots: [] };

async function open(context) {
  const page = await context.newPage();
  const net = { sheets: [], audio: [], audioRanges: [], eaAudio: [], eaOther: [], art: 0, index: null, audioIndex: null, errors: [] };
  page.on("pageerror", (e) => net.errors.push(String(e)));
  page.on("request", (r) => {
    const u = new URL(r.url()).pathname;
    if (/\/sprites\/[^/]+\.\d+\.bin$/.test(u)) net.sheets.push(u);
    if (/\/sprites\/index\.json$/.test(u)) net.index = r.url();
    if (/\/web-audio\.json$/.test(u)) net.audioIndex = r.url();
    if (/\/audio\//.test(u)) net.audio.push(u);
    if (/\/web-audio\.pack$/.test(u)) net.audioRanges.push(r.headers().range ?? "");
    if (/\/web\/ea\//.test(u)) {
      const m = u.match(EA_CLIP);
      if (m) net.eaAudio.push(m[1]); else if (/\.(aud|wav|ogg|mp3|bag|idx|mix)$/i.test(u) || /\/audio\//.test(u)) net.eaOther.push(u);
    }
    if (/\.(mix|bag|idx|vqa|bik)$/i.test(u)) net.eaOther.push(u);
    if (/web-art\.pack$/.test(u)) net.art++;
  });
  await page.goto(`${base}?profile=public&runtime=${runtime}&private=0`);
  await page.waitForFunction(() => ["setup", "error"].includes(window.store?.getState().phase), null, { timeout: 300000 });
  assert.equal(await page.evaluate(() => window.store.getState().phase), "setup", await page.evaluate(() => window.store.getState().error));
  await page.evaluate(() => {
    window.audioSources = [];
    window.game.client.on("audio", (m) => { if (m.op === "source") window.audioSources.push(m.data.byteLength); });
  });
  return { page, net };
}

/** Sheet URL -> pack group, from the build's own sprites/index.json. */
async function groupsOf(net) {
  const index = await (await fetch(net.index)).json();
  const groups = new Map();
  for (const [key, p] of Object.entries(index.packings)) p.sheets.forEach((s, i) => groups.set(`${key}.${i}.bin`, s.group ?? ""));
  return [...new Set(net.sheets.map((u) => groups.get(u.split("/").pop())))].sort();
}

/** The original clips the build lists in its audio index (web/ea/audio/*.wav). */
async function listedClips(net) {
  const index = await (await fetch(net.audioIndex)).json();
  return new Set(index.files.map((f) => f.path).filter((p) => p.startsWith("mods/rtsai/web/ea/audio/")).map((p) => p.split("/").pop()));
}

async function play(page, scenario) {
  await page.evaluate((s) => window.game.start(JSON.stringify(s)), scenario);
  await page.waitForFunction(() => window.store.getState().phase === "playing" && window.store.getState().ui?.tick > 30, null, { timeout: 300000 });
}

/**
 * Selects the local player's first actor of a type and plays its Select voice through the engine (Settings' "Preview
 * selected unit voice"): the voice set (family), the files it names, and whether it played (the clip arrived).
 */
async function voiceOf(page, net, type) {
  const result = await page.evaluate(async (type) => {
    const g = window.game;
    g.client.send({ type: "view", x0: -100000, y0: -100000, x1: 100000, y1: 100000 });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let actor;
    for (let i = 0; i < 100 && !actor; i++) {
      const s = g.client.cur;
      const local = s?.players.findIndex((p) => p.flags & 4);
      actor = s?.actors.find((a) => g.client.strings[a.type] === type && a.owner === local);
      if (!actor) await sleep(100);
    }
    if (!actor) return { error: `no local ${type}` };
    await g.client.request({ type: "select", ids: [actor.id], additive: false });
    const before = window.audioSources.length;
    let r;
    for (let i = 0; i < 60; i++) {
      r = await g.client.previewVoice();
      if (r.played) break;
      await sleep(250);
    }
    await sleep(500);
    return { ...r, decoded: window.audioSources.slice(before) };
  }, type);
  const voice = { type, family: result.family, files: result.files, played: result.played, decodedBytes: result.decoded, error: result.error };
  receipt.voices.push(voice);
  assert.ok(!result.error, result.error);
  assert.equal(result.played, true, `${type}: ${JSON.stringify(result)}`);
  return voice;
}

/** Every original request is a listed .wav clip under web/ea/audio; no archive, music or other original audio. */
async function checkOriginalRequests(net) {
  assert.deepEqual(net.eaOther, [], `unexpected original or archive requests ${net.eaOther}`);
  // The local server reads clips by indexed byte range; static builds expose individual clip URLs.
  if (net.audioRanges.length) {
    const index = await (await fetch(net.audioIndex)).json();
    for (const range of net.audioRanges) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      assert.ok(match, `audio pack must be read by range: ${range}`);
      const start = Number(match[1]), end = Number(match[2]);
      const file = index.files.find(f => f.offset <= start && f.offset + f.size > end);
      assert.ok(file, `audio range is not inside a listed clip: ${range}`);
      if (file.path.startsWith('mods/rtsai/web/ea/audio/')) net.eaAudio.push(file.path.split('/').pop());
    }
  }
  const listed = await listedClips(net);
  const unlisted = net.eaAudio.filter((c) => !listed.has(c));
  assert.deepEqual(unlisted, [], `original clips not listed in web-audio.json: ${unlisted}`);
  return listed;
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
    receipt.notice = { setup: setupNotice, missions: missionNotice, staticFile: staticNotice.split("\n").filter((l) => /EA has not|voices|music/.test(l)) };
    await context.close();
  }

  // 2. America and Russia: bases and armies in the original art; America's G.I. and dog speak their original voices.
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
    const gi = await voiceOf(page, net, "e1");
    assert.match(gi.family, /^eagivoice/, gi.family);
    assert.ok(gi.files.length && gi.files.every((f) => /^ra2\|web\/ea\/audio\/igise[a-f]\.wav$/.test(f)), JSON.stringify(gi.files));
    assert.ok(gi.decodedBytes.some((b) => b > 1000), "the G.I.'s original clip was not decoded");
    const dog = await voiceOf(page, net, "dog");
    assert.match(dog.family, /^eadogvoice/, dog.family);
    assert.ok(dog.files.every((f) => /^ra2\|web\/ea\/audio\/idog[a-z]+\.wav$/.test(f)), JSON.stringify(dog.files));
    const engineer = await voiceOf(page, net, "engineer");
    assert.match(engineer.family, /^eaengineervoice/, engineer.family);
    await page.waitForTimeout(1500);
    const groups = await groupsOf(net);
    const unexpected = groups.filter((g) => g !== "" && g !== "fx" && !g.split("+").some((f) => f === "america" || f === "russia"));
    const listed = await checkOriginalRequests(net);
    receipt.matches.push({ match: "america vs russia (showcase)", groups, unexpected, sheets: net.sheets.length, artPackReads: net.art,
      audioRequests: net.audio.length, eaAudio: [...new Set(net.eaAudio)].sort(), listedClips: listed.size, errors: net.errors });
    assert.ok(net.eaAudio.some((c) => /^igise[a-f]\.wav$/.test(c)), `no G.I. clip fetched: ${net.eaAudio}`);
    assert.ok(net.eaAudio.some((c) => /^idog/.test(c)), `no dog clip fetched: ${net.eaAudio}`);
    assert.deepEqual(net.errors, []);
    assert.deepEqual(unexpected, [], `unexpected sheet groups ${unexpected}`);
    await context.close();
  }

  // 3. Russia: the Conscript speaks ConscriptVoice from the original clips, and a Tesla tank firing at an America tank
  //    plays its original Tesla bolt (a weapon only original countries fire).
  {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const { page, net } = await open(context);
    const russia = squad("russia", "america", ["e2", "e2", "dog", "htnk", "ttnk"]);
    // The Tesla tank stands at MPos (24, 74); the target about three cells away, in range.
    russia.spawns.push({ type: "mtnk", player: 1, x: 26, y: 74 });
    await play(page, russia);
    for (let i = 0; i < 80 && !net.eaAudio.some((c) => /^vtesatt[ab]\.wav$/.test(c)); i++) await page.waitForTimeout(500);
    assert.ok(net.eaAudio.some((c) => /^vtesatt[ab]\.wav$/.test(c)), `the Tesla tank's original bolt was not fetched: ${net.eaAudio}`);
    const conscript = await voiceOf(page, net, "e2");
    assert.match(conscript.family, /^eaconscriptvoice/, conscript.family);
    assert.ok(conscript.files.every((f) => /^ra2\|web\/ea\/audio\/iconse[a-c]\.wav$/.test(f)), JSON.stringify(conscript.files));
    assert.ok(conscript.decodedBytes.some((b) => b > 1000), "the Conscript's original clip was not decoded");
    const tank = await voiceOf(page, net, "htnk");
    assert.match(tank.family, /^easovietvehiclevoice/, tank.family);
    await page.waitForTimeout(1500);
    await checkOriginalRequests(net);
    receipt.matches.push({ match: "russia squad", eaAudio: [...new Set(net.eaAudio)].sort(), errors: net.errors });
    assert.ok(net.eaAudio.some((c) => /^iconse[a-c]\.wav$/.test(c)), `no Conscript clip fetched: ${net.eaAudio}`);
    assert.deepEqual(net.errors, []);
    await context.close();
  }

  // 4. A modern match: China's rifleman keeps China's voice, China's dog barks with the original clips (the only
  //    original clips it fetches), and no sheet group made only of original countries is fetched.
  {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const { page, net } = await open(context);
    await play(page, squad("china", "iran", ["r2cnrifle", "r2cnrifle", "dog", "engineer"]));
    await page.waitForTimeout(8000);
    const rifleman = await voiceOf(page, net, "r2cnrifle");
    assert.match(rifleman.family, /^r2chinainfantryvoice/, rifleman.family);
    assert.ok(rifleman.files.every((f) => f.startsWith("ra2|modern-factions/audio/")), JSON.stringify(rifleman.files));
    const dog = await voiceOf(page, net, "dog");
    assert.match(dog.family, /^eadogvoice/, dog.family);
    assert.ok(dog.decodedBytes.some((b) => b > 1000), "the dog's original clip was not decoded");
    const engineer = await voiceOf(page, net, "engineer");
    assert.equal(engineer.family, "engineervoice", engineer.family);
    await page.waitForTimeout(1500);
    const groups = await groupsOf(net);
    const originalOnly = groups.filter((g) => g && g !== "fx" && g.split("+").every((f) => ORIGINALS.includes(f)));
    const file = path.join(out, "china-vs-iran.png"); await page.screenshot({ path: file }); receipt.screenshots.push(file);
    await checkOriginalRequests(net);
    const notDog = net.eaAudio.filter((c) => !DOG_CLIPS.test(c));
    receipt.matches.push({ match: "china squad vs iran", groups, originalOnly, sheets: net.sheets.length, artPackReads: net.art,
      eaAudio: [...new Set(net.eaAudio)].sort(), notDog, errors: net.errors });
    assert.deepEqual(originalOnly, [], `a modern match fetched original-art groups ${originalOnly}`);
    assert.ok(net.eaAudio.some((c) => /^idog/.test(c)), `no dog clip fetched: ${net.eaAudio}`);
    assert.deepEqual(notDog, [], `a modern match fetched original clips other than the dog's: ${notDog}`);
    assert.deepEqual(net.errors, []);
    await context.close();
  }
  receipt.passed = true;
  console.log("PASS original art and voices: notice shown, America and Russia drawn, G.I./Conscript/dog original voices, China keeps its voice, only listed clips and no music fetched, sheet groups as expected");
} catch (error) {
  receipt.error = String(error?.stack ?? error);
  throw error;
} finally {
  fs.writeFileSync(path.join(out, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  await browser.close();
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
