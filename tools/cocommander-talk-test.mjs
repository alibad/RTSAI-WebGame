// What the player says (or types) to the local co-commander reaches the order path: a spoken order becomes a card,
// "yes" confirms the newest card, and a phrase the proposal API refuses is answered as a question. No engine or model:
// the page runs from the Vite dev server with the companion developer tools on, and the companion's HTTP API is faked.
//   node tools/cocommander-talk-test.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../web/node_modules/playwright-core/index.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 3496;
const vite = spawn(process.execPath, [path.join(repo, "web", "node_modules", "vite", "bin", "vite.js"), "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
  { cwd: path.join(repo, "web"), env: { ...process.env, VITE_COMPANION_DEV_TOOLS: "1" }, stdio: "ignore" });
const failures = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures.push(what); };
let browser;
try {
  for (let i = 0; i < 120 && !(await fetch(`http://127.0.0.1:${port}/`).then((r) => r.ok).catch(() => false)); i++) await new Promise((r) => setTimeout(r, 500));
  const exe = ["chromium-1228", "chromium-1248"].map((d) => path.join(process.env.LOCALAPPDATA, "ms-playwright", d, "chrome-win64", "chrome.exe")).find((f) => fs.existsSync(f));
  browser = await chromium.launch({ executablePath: exe, headless: true });
  const context = await browser.newContext();
  await context.addInitScript(() => localStorage.setItem("rtsai.cocommander", JSON.stringify({ enabled: true, mode: "mock", muted: true })));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${String(e.stack ?? e).slice(0, 600)}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 300)}`); });
  process.on("exit", () => { if (failures.length && errors.length) console.log(errors.slice(0, 8).join("\n")); });
  const calls = [];
  await page.route(/\/companion\/api\/v1\/(proposals|advice|proposals\/confirm|proposals\/cancel|speak)$/, async (route) => {
    const endpoint = new URL(route.request().url()).pathname.replace(/^.*\/v1\//, "");
    const body = JSON.parse(route.request().postData() || "{}");
    calls.push({ endpoint, body });
    const json = (status, value) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (endpoint === "proposals" && /turtle/i.test(body.instruction)) return json(400, { error: "native doctrine changes use the explicit native controls" });
    if (endpoint === "proposals") return json(200, { text: "Build a Power Plant. I prepared 1 validated order.", metadata: { action: { state: "pending", proposal_id: "p1", summary: "Build a Power Plant" } } });
    if (endpoint === "proposals/confirm") return json(200, { text: "Orders sent.", metadata: { action: { state: "accepted", proposal_id: body.proposal_id } } });
    if (endpoint === "advice") return json(200, { text: "Turtle is the defensive doctrine; pick it in the strategy strip." });
    return route.fulfill({ status: 204, body: "" });
  });
  // The page keeps a local mode only while the server reports a ready local companion.
  await page.route(/\/api\/companion\/status$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ running: true, localAI: { ready: true } }) }));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => window.game?.cc, null, { timeout: 120000 });
  await page.waitForTimeout(1500);
  check(await page.evaluate(() => window.store.getState().cc.mode) === "mock", "the page runs the co-commander in its local (mock) mode");

  await page.evaluate(() => window.game.cc.talk("Build a power plant"));
  const card = await page.evaluate(() => window.store.getState().cc.feed.find((f) => f.kind === "proposal"));
  check(calls.some((c) => c.endpoint === "proposals" && c.body.instruction === "Build a power plant"), "a spoken order goes to v1/proposals");
  check(!calls.some((c) => c.endpoint === "advice"), "a spoken order does not go to the advice-only path");
  check(card?.state === "pending" && card?.proposalId === "p1", "the order becomes a pending card");

  await page.evaluate(() => window.game.cc.talk("Yes."));
  check(calls.some((c) => c.endpoint === "proposals/confirm" && c.body.proposal_id === "p1"), "saying \"yes\" confirms the newest card");

  await page.evaluate(() => window.game.cc.talk("Switch to the turtle strategy"));
  check(calls.some((c) => c.endpoint === "advice" && /turtle/.test(c.body.question)), "a phrase the proposal API refuses is answered as a question");
  const lastAi = await page.evaluate(() => [...window.store.getState().cc.feed].reverse().find((f) => f.kind === "ai")?.text);
  check(/Turtle/.test(lastAi ?? ""), "the answer shows in the feed");
} catch (e) {
  failures.push(String(e.stack ?? e));
  console.log("FAIL", String(e.stack ?? e).slice(0, 800));
} finally {
  await browser?.close();
  vite.kill();
}
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
