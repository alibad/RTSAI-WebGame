// Films the public game's built-in adviser being asked and obeyed, in the live game's sign-in-free twin page: a
// player who does exactly what the adviser recommends (clicks Apply on every card), with the game's own screen and a
// caption strip saying what was recommended, what the engine answered, and what happened.
//   node tools/arena/adviser-clip.mjs --scene opening|defend|scout|attack --out <folder>
//        [--faction iran] [--enemy saudi] [--skill normal] [--map ra2-tournament-2B] [--seed 3001] [--url http://127.0.0.1:3464/]
//        [--bundle <pack>] [--adviser <adviser js>] [--name <file name>] [--label "after the fix"]
// --adviser previews an adviser change on the live page: a bundle of web/src/adviser.ts and adviser-tree.ts as the
// global __adviserPreview (esbuild --bundle --format=iife --global-name=__adviserPreview) takes the place of the
// page's own skirmish adviser. Everything else, the engine included, is the live game.
// Scenes: opening (the first cards up to the factory), defend (until "enemies are at your base" is applied), scout
// (until the adviser says to scout), attack (until "attack the enemy base" is applied). The stretch before a scene's
// moment plays fast and is shortened again in the cut; the moment itself plays near normal speed.
// Writes <name>.mp4 (1280x720, H.264), <name>.jpg and <name>.json (every card, the engine's receipt, the cut).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SKILLS } from "./skirmish-skills.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const scene = opt("scene", "opening");
const faction = opt("faction", "iran"), enemy = opt("enemy", "saudi"), skill = opt("skill", "normal");
const map = opt("map", "ra2-tournament-2B"), seed = Number(opt("seed", 3001));
const url = opt("url", "http://127.0.0.1:3464/");
const out = path.resolve(opt("out", "."));
const name = opt("name", `adviser-${scene}-${faction}`);
const bundle = opt("bundle", "");
const adviser = opt("adviser", ""), label = opt("label", "");
const FAST = Number(opt("fast", 6)), SHOW = Number(opt("show", 1.5));
const maxGame = Number(opt("max", { opening: 300, defend: 720, scout: 720, attack: 1200 }[scene] ?? 600)); // game seconds
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { chromium } = await import(pathToFileURL(path.join(repo, "web", "node_modules", "playwright-core", "index.mjs")).href);
const msPlaywright = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
const chrome = (fs.existsSync(msPlaywright) ? fs.readdirSync(msPlaywright) : []).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
  .map((d) => path.join(msPlaywright, d, "chrome-win64", "chrome.exe")).find((f) => fs.existsSync(f));
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11", "--mute-audio"] });
const size = { width: 1280, height: 720 };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adviser-clip-"));
const context = await browser.newContext({ viewport: size, recordVideo: { dir: tmp, size } });
const page = await context.newPage();
const t0 = Date.now();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
if (bundle) await page.route(/\/public\/web-bundle\.pack$/, (r) => r.fulfill({ status: 200, contentType: "application/octet-stream", body: fs.readFileSync(bundle) }));

await page.goto(`${url}?profile=public&mode=skirmish`);
await page.waitForFunction(() => ["setup", "error"].includes(window.store?.getState().phase), null, { timeout: 300000, polling: 500 });
const setup = await page.evaluate(() => window.store.getState().setup);
const factionName = (id) => setup.factions.find((f) => f.id === id)?.name ?? id;
const options = { ...Object.fromEntries((setup.options ?? []).map((o) => [o.id, o.default])), cheats: "False", crates: "False", "rtsai-cocommander": "True" };
const s = SKILLS[skill];
const scenario = { map, seed, options, players: [{ slot: "Multi0", faction, color: "4F80FF" },
  { slot: "Multi1", faction: enemy, color: "FF4848", bot: s.bot, ...(s.handicap ? { handicap: s.handicap } : {}), ...(s.cash ? { cash: s.cash } : {}) }] };
// The player's own choices on the setup screen: the built-in adviser on, Auto off (every order is applied by a click).
await page.evaluate(() => { const cc = window.game.cc; cc.setEnabled(true); cc.setMode("browser"); cc.setAuto(false); });
if (adviser) {
  await page.addScriptTag({ path: path.resolve(adviser) });
  const ok = await page.evaluate(() => {
    const cc = window.game.cc, A = window.__adviserPreview;
    if (typeof cc.browserChoice !== "function" || !A?.nextAdvice) return false;
    cc.browserChoice = (observation) => A.nextAdvice({ ...observation, techTree: A.adviserTreeFor(observation) });
    return true;
  });
  if (!ok) throw new Error("--adviser: the page's adviser could not be replaced");
}
await page.evaluate((sc) => window.game.start(JSON.stringify(sc)), scenario);
await page.waitForFunction(() => ["playing", "error"].includes(window.store.getState().phase), null, { timeout: 300000, polling: 250 });
if ((await page.evaluate(() => window.store.getState().phase)) !== "playing") throw new Error("did not start: " + await page.evaluate(() => window.store.getState().error));

// A caption strip of our own (the film's, not the game's) and a pointer, since a recording shows no mouse cursor.
await page.evaluate(({ title }) => {
  const css = document.createElement("style");
  css.textContent = `#ac{position:fixed;left:300px;bottom:14px;width:700px;z-index:2147483646;pointer-events:none;font:500 14px/1.35 "Segoe UI",system-ui,sans-serif;color:#f3efe2}
    #ac .t{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#f1d28b;display:flex;gap:10px;align-items:center}
    #ac .t b{background:#f1d28b;color:#14180f;border-radius:3px;padding:1px 6px;letter-spacing:.06em}
    #ac .l{margin-top:5px;display:flex;flex-direction:column;gap:4px}
    #ac .l div{background:rgba(12,15,11,.86);border-left:3px solid #8fd18a;border-radius:5px;padding:5px 10px;width:max-content;max-width:680px}
    #ac .l .ask{border-color:#6bd0ff}#ac .l .bad{border-color:#ff6b5a}#ac .l .note{border-color:#f1d28b}
    #ap{position:fixed;z-index:2147483647;pointer-events:none;width:22px;height:22px;margin:-2px 0 0 -2px;transition:transform .12s}
    #ap.down{transform:scale(.8)}#ap i{position:absolute;left:-13px;top:-13px;width:44px;height:44px;border-radius:50%;border:3px solid #f1d28b;opacity:0}
    #ap.down i{animation:apr .5s ease-out}@keyframes apr{from{opacity:.9;transform:scale(.3)}to{opacity:0;transform:scale(1.2)}}`;
  document.head.append(css);
  const box = document.createElement("div"); box.id = "ac";
  box.innerHTML = `<div class="t"><span>${title}</span><b id="ac-speed"></b></div><div class="l" id="ac-lines"></div>`;
  const ptr = document.createElement("div"); ptr.id = "ap";
  ptr.innerHTML = `<i></i><svg width="22" height="22" viewBox="0 0 22 22"><path d="M2 2l6 17 3-7 7-3z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  ptr.style.left = "640px"; ptr.style.top = "420px";
  document.body.append(box, ptr);
  addEventListener("mousemove", (e) => { ptr.style.left = e.clientX + "px"; ptr.style.top = e.clientY + "px"; }, true);
  addEventListener("mousedown", () => { ptr.classList.remove("down"); void ptr.offsetWidth; ptr.classList.add("down"); }, true);
  addEventListener("mouseup", () => setTimeout(() => ptr.classList.remove("down"), 350), true);
  window.__ac = {
    say(text, kind = "") { const l = document.getElementById("ac-lines"), d = document.createElement("div"); d.className = kind; d.textContent = text; l.append(d); while (l.children.length > 3) l.firstChild.remove(); },
    speed(text) { document.getElementById("ac-speed").textContent = text; },
  };
}, { title: `Built-in adviser${label ? ` · ${label}` : ""} · ${factionName(faction)} (you) vs ${s.label} (${factionName(enemy)})` });

const marks = []; // the cut: { from, to (ms of the recording), fast }
let markFrom = Date.now() - t0, fastNow = true;
const setPace = async (fast) => {
  const now = Date.now() - t0;
  if (fast !== fastNow) { marks.push({ from: markFrom, to: now, fast: fastNow }); markFrom = now; fastNow = fast; }
  await page.evaluate(([v, label]) => { window.game.client.send({ type: "speed", speed: v }); window.__ac.speed(label); }, [fast ? FAST : SHOW, fast ? `fast-forward` : `${SHOW}× speed`]);
};
const say = (text, kind) => page.evaluate(([t, k]) => window.__ac.say(t, k), [text, kind ?? ""]);
const gameSeconds = () => page.evaluate(() => (window.game.client.cur?.header.tick ?? 0) / 25);
const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t) % 60).padStart(2, "0")}`;
const feed = () => page.evaluate(() => window.store.getState().cc.feed.map((f) => ({ id: f.id, kind: f.kind, text: f.text, state: f.state })));
const click = async (locator) => {
  const b = await locator.boundingBox();
  if (!b) return false;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 18 });
  await sleep(350);
  await page.mouse.down(); await sleep(90); await page.mouse.up();
  return true;
};
const kindOf = (text) => /to the attackers/.test(text) ? "defend" : /to the enemy base/.test(text) ? "attack" : /to scout|to find the enemy/.test(text) ? "scout" : /^Deploy/.test(text) ? "deploy" : /^Place/.test(text) ? "place" : /^Build/.test(text) ? "build" : /^Train/.test(text) ? "train" : /scout|explore/i.test(text) ? "scout" : "other";

// scout: before the fix the adviser only talks ("scout-talk"); with --adviser the moment is its scouting card.
const MOMENT = { opening: null, defend: "defend", scout: adviser ? "scout" : "scout-talk", attack: "attack" }[scene];
const cards = [];
let done = false, reason = "", momentAt = null, lastCardAt = Date.now();
await setPace(scene !== "opening");
if (scene === "opening") { marks.length = 0; markFrom = Date.now() - t0; fastNow = false; }
await say(scene === "opening" ? "A new player who clicks Apply on everything the adviser recommends." : "Fast-forward: every recommendation is applied, until the moment this clip is about.", "note");

while (!done) {
  await sleep(250);
  const gs = await gameSeconds();
  const st = await page.evaluate(() => { const s = window.store.getState(), p = window.game.cc.pending(); return { phase: s.phase, pending: p ? { id: p.id, proposalId: p.proposalId, text: p.text, commands: p.commands?.length ?? 0 } : null, line: [...s.cc.feed].reverse().find((f) => f.kind === "ai")?.text ?? "" }; });
  if (st.phase !== "playing") { reason = `the game left play (${st.phase})`; break; }
  if (gs > maxGame) {
    // The moment never came: that is the finding. The clip is the last stretch and a closing line.
    reason = `not reached by ${clock(maxGame)} of game time`;
    await setPace(false);
    const kinds = cards.reduce((m, c) => { m[c.kind] = (m[c.kind] ?? 0) + 1; return m; }, {});
    await say(`${clock(gs)} · ${cards.length} recommendations applied (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", ")}).`, "note");
    await say(scene === "attack" ? `The adviser never recommended an attack. "${st.line}"` : `The adviser never got to it. "${st.line}"`, "bad");
    await sleep(9000);
    break;
  }
  // The adviser talks about scouting but has nothing to apply.
  // Once there is an army (5:00): the adviser talks about scouting but has nothing to apply.
  if (!st.pending && MOMENT === "scout-talk" && gs >= 300 && /haven't found the enemy base/.test(st.line)) {
    if (momentAt === null) {
      momentAt = gs;
      await setPace(false);
      await say(`${clock(gs)} · Adviser: "${st.line}"`, "ask");
      await sleep(2500);
      await page.evaluate(() => window.game.cc.setOpen(true));
      await sleep(900);
      await say("There is no order to apply. The player asks again: Next suggestion.", "bad");
      for (let i = 0; i < 2; i++) { await click(page.getByRole("button", { name: "Next suggestion" })); await sleep(2600); }
      const again = (await feed()).filter((f) => f.kind === "ai").at(-1)?.text ?? "";
      await say(/haven't found the enemy base/.test(again) ? "Same answer. Nothing moves; the army waits at home." : `Adviser now: "${again}"`, "bad");
      await sleep(3500);
      reason = "moment filmed"; break;
    }
  }
  // The opening waits for each building: those waits play fast.
  if (!st.pending) { if (scene === "opening" && !fastNow && Date.now() - lastCardAt > 1800) await setPace(true); continue; }
  const kind = kindOf(st.pending.text);
  const isMoment = scene === "opening" || kind === MOMENT;
  if (isMoment && fastNow) { await setPace(false); momentAt ??= gs; }
  if (isMoment) { await say(`${clock(gs)} · Adviser recommends: ${st.pending.text}`, "ask"); await sleep(1100); }
  const apply = page.locator(".cc-root .cc-apply").first();
  const clicked = isMoment ? await click(apply) : (await apply.click({ timeout: 3000 }).then(() => true).catch(() => false));
  if (!clicked) await page.evaluate(() => { const p = window.game.cc.pending(); if (p) void window.game.cc.decide(p, true); });
  const receipt = await page.waitForFunction((id) => { const r = window.game.cc.receipts.get(id); return r ? { accepted: !!r.accepted, detail: r.detail ?? "" } : null; }, st.pending.proposalId, { timeout: 15000, polling: 100 })
    .then((h) => h.jsonValue()).catch(() => null);
  cards.push({ game: Math.round(gs), kind, text: st.pending.text, commands: st.pending.commands, accepted: receipt?.accepted ?? null, detail: receipt?.detail ?? "no receipt in 15 s" });
  if (isMoment) await say(receipt?.accepted ? `Applied. The engine accepted ${st.pending.commands} order${st.pending.commands === 1 ? "" : "s"}.` : `Applied, but the engine ${receipt ? `refused: ${receipt.detail}` : "did not answer"}.`, receipt?.accepted ? "" : "bad");
  lastCardAt = Date.now();
  if (scene === "opening") { if (kind === "place" && /factory/i.test(st.pending.text)) { await sleep(5000); reason = "the factory is placed"; done = true; } }
  else if (kind === MOMENT) { await sleep(scene === "attack" ? 26000 : 16000); reason = "moment filmed"; done = true; }
}
marks.push({ from: markFrom, to: Date.now() - t0, fast: fastNow });
const all = await feed();
const video = page.video();
await context.close();
await browser.close();
const webm = await video.path();

// The cut: fast stretches are shortened four times more (the last 2 s of each are kept as they were, to arrive gently).
const parts = [];
const unreached = reason.startsWith("not reached");
for (const m of marks) {
  // A moment that never came: only the last 14 s of the fast-forward are kept before the closing line.
  const from = Math.max(m.from / 1000, unreached && m.fast ? m.to / 1000 - 14 : 0), to = m.to / 1000;
  if (to - from < 0.2) continue;
  if (m.fast && to - from > 4) { parts.push({ from, to: to - 2, rate: 4 }); parts.push({ from: to - 2, to, rate: 1 }); } else parts.push({ from, to, rate: 1 });
}
const filter = parts.map((p, i) => `[0:v]trim=start=${p.from.toFixed(2)}:end=${p.to.toFixed(2)},setpts=(PTS-STARTPTS)/${p.rate}[v${i}]`).join(";") + `;${parts.map((_, i) => `[v${i}]`).join("")}concat=n=${parts.length}:v=1:a=0,fps=30[v]`;
const mp4 = path.join(out, `${name}.mp4`);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-filter_complex", filter, "-map", "[v]", "-c:v", "libx264", "-preset", "medium", "-crf", "25", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4]);
const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4]).toString().trim());
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(Math.max(0, seconds - 8)), "-i", mp4, "-frames:v", "1", "-q:v", "3", path.join(out, `${name}.jpg`)]);
fs.rmSync(tmp, { recursive: true, force: true });
const result = { scene, name, faction, enemy, skill, map, seed, reached: reason === "moment filmed" || reason === "the factory is placed", reason, momentAtGameSeconds: momentAt === null ? null : Math.round(momentAt),
  seconds: Math.round(seconds), video: mp4, cards, refused: cards.filter((c) => c.accepted === false).length, feed: all.filter((f) => f.kind !== "proposal").map((f) => `${f.kind}: ${f.text}`), errors, bundle: bundle || null, adviser: adviser || null, filmedAt: new Date().toISOString() };
fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(result, null, 1));
console.log("RESULT " + JSON.stringify({ ...result, feed: result.feed.length, cards: cards.length }));
