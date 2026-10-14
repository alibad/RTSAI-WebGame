// Campaign screen (prologue, acts, locked chapters, lazy portraits) and in-mission radio calls, against a built page
// whose VITE_CAMPAIGN_BASE serves campaign/index.json, cast/<id>.webp and <mission>/radio-<n>.mp3.
//   RTSAI_TEST_URL=http://127.0.0.1:3731/ [RADIO_SHOTS=D:/rtsai-campaign/radio-shots] node tools/campaign-radio-test.mjs
// The start call and the first time-triggered call come from the real match (game time, at 3x speed); the objective
// and victory calls are triggered by synthetic UI states, which test the radio only, not mission logic.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "../web/node_modules/playwright-core/index.mjs";

const base = (process.env.RTSAI_TEST_URL ?? "http://127.0.0.1:3731/").replace(/\/?$/, "/");
const url = `${base}?mode=missions&profile=public`;
const shots = process.env.RADIO_SHOTS ?? "artifacts/campaign-radio";
fs.mkdirSync(shots, { recursive: true });
const story = JSON.parse(fs.readFileSync(process.env.CAMPAIGN_STORY_JSON ?? "../RTSAI-Mod/resources/campaign-story.json", "utf8"));
const missions = JSON.parse(fs.readFileSync("content/missions.json", "utf8"));
const MISSION = "jizan-corridor";
const calls = story.radio[MISSION];
const startCall = calls.find((c) => c.when === "start");
const timeCall = calls.filter((c) => typeof c.when === "object" && "time" in c.when).sort((a, b) => a.when.time - b.when.time)[0];
const objectiveCall = calls.find((c) => typeof c.when === "object" && "objective" in c.when);
const victoryCall = calls.find((c) => c.when === "victory");
assert(startCall && timeCall && objectiveCall && victoryCall, "jizan-corridor needs start, time, objective and victory calls");
const launchable = (id) => story.chapters[id]?.status !== "coming" && missions.some((m) => m.id === id);
const locked = story.arcs.flatMap((a) => a.missions).filter((id) => !launchable(id));
// Where to scroll for the last act: its locked chapters while there are any, else its own chapters.
const lastActFirst = locked[0] ?? story.arcs.at(-1).missions[0];
const lastActEnd = locked.at(-1) ?? story.arcs.at(-1).missions.at(-1);

const browser = await chromium.launch({ executablePath: path.join(process.env.LOCALAPPDATA, "ms-playwright/chromium-1228/chrome-win64/chrome.exe"), headless: true,
  args: ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
const requested = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("request", (r) => requested.push(r.url()));
page.on("console", (m) => { if (m.type() === "error") console.log("Browser:", m.text()); });
const shot = async (name) => { await page.screenshot({ path: `${shots}/${name}.png` }); console.log("Screenshot:", `${shots}/${name}.png`); };
const radio = () => page.evaluate(() => { const el = document.querySelector(".rd-call"); return el && { speaker: el.dataset.speaker, voice: el.dataset.voice, line: el.querySelector(".rd-line")?.textContent }; });
const waitForCall = (line, timeout = 120000) => page.waitForFunction((l) => document.querySelector(".rd-call .rd-line")?.textContent === l, line, { timeout });

// A portrait not published yet: its initials stand in.
const UNPUBLISHED = "signals-chief";
await page.route((u) => u.pathname.endsWith(`/cast/${UNPUBLISHED}.webp`), (route) => route.fulfill({ status: 404, body: "" }));

try {
  await page.goto(url);
  await page.waitForFunction(() => ["setup", "error"].includes(window.store?.getState().phase), null, { timeout: 600000 });
  assert.equal(await page.evaluate(() => window.store.getState().phase), "setup");
  await page.getByRole("heading", { name: story.title, exact: true }).waitFor();

  // The prologue's poster card, every act, the locked chapters (not buttons), the launchable ones.
  const prologue = page.getByRole("button", { name: `${story.prologue.eyebrow}: ${story.prologue.title}` });
  await prologue.waitFor({ timeout: 30000 });
  for (const [i, arc] of story.arcs.entries()) await page.getByRole("region", { name: `${arc.act ?? `Act ${i + 1}`}: ${arc.title}` }).waitFor();
  for (const id of locked) {
    const card = page.locator(`.cp-mission.is-locked[data-chapter="${id}"]`);
    await card.waitFor();
    assert.equal(await card.evaluate((el) => el.tagName), "DIV");
    assert.match(await card.textContent(), /In production/);
  }
  assert.equal(await page.locator("button.cp-mission").count(), missions.filter((m) => launchable(m.id)).length);
  // Lazy: nothing of a film before it is played; portraits only for cards on screen.
  assert(!requested.some((u) => /briefing\.mp4/.test(u)), "a film loaded before it was played");
  const speakers = await page.locator(".cp-mission-speaker").count();
  const loadedBefore = await page.locator(".cp-mission-speaker img").count();
  assert(loadedBefore < speakers, `every portrait loaded at once (${loadedBefore}/${speakers})`);
  await page.waitForTimeout(900);
  await shot("campaign-desktop");
  await page.locator(`.cp-mission[data-chapter="${lastActEnd}"]`).scrollIntoViewIfNeeded();
  await page.waitForFunction((n) => document.querySelectorAll(".cp-mission-speaker img").length > n, loadedBefore);
  const unpublished = page.locator(`.cp-mission-speaker[data-cast="${UNPUBLISHED}"]`);
  await unpublished.scrollIntoViewIfNeeded();
  await unpublished.locator('.lazy-img[data-state="failed"] .cast-initials').waitFor();
  await page.locator(`.cp-mission[data-chapter="${lastActEnd}"]`).scrollIntoViewIfNeeded();
  await page.waitForTimeout(900);
  await shot("campaign-act3-desktop");
  console.log(`Campaign screen passed: prologue, ${story.arcs.length} acts, ${locked.length} locked chapters, portraits ${loadedBefore}/${speakers} before scrolling.`);

  // The prologue plays the way chapter films do: inline, captioned.
  await prologue.scrollIntoViewIfNeeded();
  // The film is fetched whole (briefings.ts useWholeFile) and plays from memory, so its source is a blob: URL.
  const fetched = page.waitForResponse((r) => /prologue\/briefing\.mp4$/.test(r.url()) && r.ok(), { timeout: 60000 });
  await prologue.click();
  await fetched;
  await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2, null, { timeout: 60000 });
  const film = await page.locator("video").evaluate(async (v) => { v.muted = true; await v.play(); await new Promise((r) => setTimeout(r, 1500)); return { time: v.currentTime, src: v.currentSrc }; });
  assert(film.time > 0 && /^blob:|prologue\/briefing\.mp4$/.test(film.src), JSON.stringify(film));
  await shot("prologue-desktop");
  await page.locator("video").evaluate((v) => v.pause());
  await page.getByRole("button", { name: /^Begin / }).click();
  await page.getByRole("heading", { name: missions.find((m) => launchable(m.id)).title, exact: true }).waitFor();
  console.log("Prologue film passed.");

  // A chapter's briefing with its commander, then the launch.
  await page.getByRole("button", { name: /Jizan Corridor/ }).click();
  await page.locator(`.cp-voice[data-speaker="${story.chapters[MISSION].speaker}"] .cast-portrait img`).waitFor({ timeout: 30000 });
  await shot("briefing-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.querySelector(".scr-content")?.scrollTo?.(0, 0));
  await page.getByRole("heading", { name: story.title, exact: true }).scrollIntoViewIfNeeded();
  await shot("campaign-phone");
  await page.locator(`.cp-mission[data-chapter="${lastActFirst}"]`).scrollIntoViewIfNeeded();
  await shot("campaign-act3-phone");
  await page.getByRole("button", { name: /Jizan Corridor/ }).click();
  await page.waitForTimeout(800);
  await shot("briefing-phone");
  await page.setViewportSize({ width: 1440, height: 1000 });

  const start = page.getByRole("button", { name: "Start mission", exact: true });
  await start.waitFor({ timeout: 600000 });
  await start.click();
  await page.waitForFunction(() => window.store.getState().phase === "playing", null, { timeout: 600000 });
  await page.waitForFunction((id) => window.store.getState().ui?.mission?.id === id, MISSION, { timeout: 60000 });
  console.log("Mission launched.");

  // Start call, with its voice.
  await waitForCall(startCall.line, 30000);
  const first = await radio();
  assert.equal(first.speaker, startCall.speaker);
  await page.waitForFunction(() => ["playing", "missing"].includes(document.querySelector(".rd-call")?.dataset.voice), null, { timeout: 15000 });
  const voiced = await radio();
  console.log("Start call:", JSON.stringify(voiced));
  if (startCall.audio) assert.equal(voiced.voice, "playing", "the start call's voice did not play");
  await page.waitForTimeout(600);
  await shot("radio-start-desktop");

  // Game time: no time call while paused (the tick stands still), then at 3x speed it comes at its game second.
  await page.evaluate(() => window.game.setPaused(true));
  const pausedAt = await page.evaluate(() => window.store.getState().ui.tick);
  await page.waitForTimeout(2500);
  assert.equal(await page.evaluate(() => window.store.getState().ui.tick), pausedAt, "the world ticked while paused");
  await page.evaluate(() => window.game.setPaused(false));
  await page.evaluate(() => window.game.client.send({ type: "speed", speed: 3 }));
  await waitForCall(timeCall.line, (timeCall.when.time + 60) * 1000);
  const timed = await page.evaluate(() => window.store.getState().ui.tick / 25);
  assert(timed >= timeCall.when.time, `time call at ${timed}s of game time, wanted ${timeCall.when.time}s`);
  console.log(`Time call at ${timed.toFixed(1)} s of game time (trigger ${timeCall.when.time} s):`, JSON.stringify(await radio()));
  await shot("radio-time-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await shot("radio-time-phone");
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(500);
  await shot("radio-time-phone-landscape");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => window.game.client.send({ type: "speed", speed: 1 }));

  // Synthetic states: objective N complete, then victory (which replaces whatever is on air or waiting).
  await page.evaluate(() => { window.game.setPaused(true); window.game.onUi = () => {}; });
  await page.evaluate((n) => {
    const s = window.store.getState();
    s.set({ ui: { ...s.ui, mission: { ...s.ui.mission, objectives: s.ui.mission.objectives.map((o, i) => (i === n ? { ...o, status: "complete" } : o)) } } });
  }, objectiveCall.when.objective);
  await page.waitForTimeout(300);
  if (await page.locator(".rd-call .rd-line").textContent() !== objectiveCall.line) await page.getByRole("button", { name: "Dismiss radio call" }).click();
  await page.evaluate(() => window.game.setPaused(false));
  await waitForCall(objectiveCall.line, 20000);
  console.log("Objective call:", JSON.stringify(await radio()));
  await page.evaluate(() => { const s = window.store.getState(); s.set({ ui: { ...s.ui, win: "Won" } }); });
  await waitForCall(victoryCall.line, 10000);
  assert.equal(await page.evaluate(() => document.querySelector(".rd-waiting")), null, "calls still waiting after the victory call");
  await page.getByRole("heading", { name: "Operation complete" }).waitFor();
  await page.waitForTimeout(600);
  await shot("radio-victory-desktop");
  console.log("Victory call:", JSON.stringify(await radio()));
  // Auto-dismiss: the line leaves on its own.
  await page.waitForFunction(() => !document.querySelector(".rd-call"), null, { timeout: 30000 });
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log("Radio passed: start (voiced), game-time call, objective call, victory call, auto-dismiss.");
} finally {
  await browser.close();
}
