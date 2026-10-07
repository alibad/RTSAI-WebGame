// AI co-commander end to end (local mode): starts a skirmish with the co-commander on (the server starts the local
// companion; --mode mock uses the scripted AI gateway), then asks a question, gives an order and accepts the proposal
// (it must reach the engine as an order), talks through the fake microphone, takes screenshots, and finally checks
// SyncHash parity of the whole session (the confirmed order included) against the native engine.
//   node tools/cocommander-test.mjs [--runtime aot] [--mode mock|local] [--profile public] [--out dir]
import fs from "node:fs";
import path from "node:path";
import { chromium } from "../web/node_modules/playwright-core/index.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const runtime = opt("runtime", "aot");
const mode = opt("mode", "mock");
const profile = opt("profile", "");
const out = opt("out", "shots-cocommander");
fs.mkdirSync(out, { recursive: true });
const exe = path.join(process.env.LOCALAPPDATA, "ms-playwright", "chromium-1228", "chrome-win64", "chrome.exe");
const browser = await chromium.launch({ executablePath: fs.existsSync(exe) ? exe : undefined, headless: true,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, permissions: ["microphone"] });
await context.addInitScript((m) => localStorage.setItem("rtsai.cocommander", JSON.stringify({ enabled: true, mode: m, muted: false })), mode);
const page = await context.newPage();
page.on("pageerror", (e) => console.log("pageerror", String(e)));
page.on("console", (m) => { if (m.type() === "error") console.log("console", m.text().slice(0, 300)); });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const until = async (f, arg, ms = 60000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await page.evaluate(f, arg); if (v) return v; await page.waitForTimeout(250); }
  return null;
};
const shot = async (name) => { const f = path.join(out, name); await page.screenshot({ path: f }); log("wrote", f); };
const feed = () => page.evaluate(() => window.store.getState().cc.feed.map((f) => `${f.kind}${f.state ? `(${f.state})` : ""}: ${f.text}`));

await page.goto(`http://127.0.0.1:3490/?runtime=${runtime}${profile ? `&profile=${profile}` : "&shot=1"}`);
await page.waitForFunction(() => ["setup", "error"].includes(window.store?.getState().phase), null, { timeout: 600000 });
const scenario = fs.readFileSync(path.join("scenarios", profile ? `skirmish-${profile}.json` : "skirmish.json"), "utf8");
await page.evaluate((s) => window.game.start(s), scenario);
await page.waitForFunction(() => ["playing", "error"].includes(window.store.getState().phase), null, { timeout: 600000 });
log("playing; co-commander:", JSON.stringify(await page.evaluate(() => { const c = window.store.getState().cc; return { running: c.running, error: c.error }; })));
const linked = await until(() => window.store.getState().cc.linked && window.store.getState().ui?.companion);
log("linked:", !!linked, JSON.stringify(linked));
await page.waitForTimeout(6000);
log("relay:", JSON.stringify((await (await fetch("http://127.0.0.1:3490/api/companion/status")).json()).relay));
await shot("cc-1-strip.png");

// An order: the companion proposes, the player accepts, the engine queues it.
await page.evaluate(() => window.game.cc.ask("Build a power plant"));
const proposal = await until(() => window.store.getState().cc.feed.find((f) => f.kind === "proposal" && f.state === "pending")?.text, null, 60000);
log("proposal:", proposal);
await page.waitForTimeout(500);
await shot("cc-2-proposal.png");
if (proposal) {
  await page.evaluate(() => { const g = window.game; g.cc.decide(g.cc.pending(), true); });
  const done = await until(() => window.store.getState().cc.feed.find((f) => f.kind === "done" || f.kind === "rejected")?.text, null, 30000);
  log("receipt:", done);
  const queued = await until(() => window.store.getState().ui?.queues.find((q) => q.type === "Building")?.items.map((i) => i.name).join(","), null, 10000);
  log("building queue:", queued);
}

// A question (the brain answers; mock: canned advice).
await page.evaluate(() => window.game.cc.ask("What should I build next?"));
await until(() => !window.store.getState().cc.thinking, null, 60000);

// Push-to-talk through the (fake) microphone.
await page.evaluate(() => window.game.cc.startListening());
await page.waitForTimeout(1500);
await page.evaluate(() => window.game.cc.stopListening());
await until(() => !window.store.getState().cc.thinking && !window.store.getState().cc.listening, null, 60000);
await page.waitForTimeout(800);
log("feed:\n  " + (await feed()).join("\n  "));
await page.evaluate(() => window.game.cc.setOpen(true));
await page.waitForTimeout(500);
await shot("cc-3-feed.png");

// Parity: the session, the companion's order included, replayed natively.
await page.evaluate(() => window.game.requestVerify());
const verify = await until(() => { const v = window.store.getState().verify; return v && !/\.\.\.$|…$/.test(v) ? v : null; }, null, 300000);
log("verify:", verify);
await browser.close();
