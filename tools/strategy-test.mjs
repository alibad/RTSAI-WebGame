// Local strategy acceptance, screenshots, and native replay verification. No paid model calls.
// node tools/strategy-test.mjs [--out <directory>]
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "../web/node_modules/playwright-core/index.mjs";

const args = process.argv.slice(2);
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : "artifacts/strategy-review";
fs.mkdirSync(out, { recursive: true });
const exe = path.join(process.env.LOCALAPPDATA, "ms-playwright", "chromium-1228", "chrome-win64", "chrome.exe");
const browser = await chromium.launch({ executablePath: fs.existsSync(exe) ? exe : undefined, headless: true,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (error) => errors.push(String(error)));
await page.addInitScript(() => localStorage.setItem("rtsai.cocommander", JSON.stringify({ enabled: true, mode: "mock", muted: true })));
try {
  await page.goto(`http://127.0.0.1:3490/?runtime=${process.env.TEST_RUNTIME ?? "aot"}&profile=public`);
  await page.waitForFunction(() => ["setup", "error"].includes(window.store?.getState().phase), null, { timeout: 600000 });
  assert.equal(await page.evaluate(() => window.store.getState().phase), "setup");
  const scenario = fs.readFileSync("scenarios/skirmish-public.json", "utf8");
  await page.evaluate((value) => window.game.start(value), scenario);
  await page.waitForFunction(() => ["playing", "error"].includes(window.store.getState().phase), null, { timeout: 600000 });
  assert.equal(await page.evaluate(() => window.store.getState().phase), "playing");
  console.log("Live skirmish started");
  await page.waitForFunction(() => window.store.getState().cc.strategies?.available, null, { timeout: 60000 });
  await page.evaluate(() => window.game.cc.setOfferSteps(false));
  await page.getByRole("button", { name: "Strategy · Choose your approach" }).click();
  assert.equal(await page.locator("[data-strategy-panel]").getByRole("button", { pressed: false }).count() >= 3, true);
  await page.getByRole("button", { name: "All strategies", exact: true }).click();
  await page.getByRole("button", { name: /^Expand economy/ }).click();
  await page.waitForFunction(() => window.store.getState().cc.strategies?.active?.id === "economy");
  await page.getByLabel("Credit reserve").fill("500");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page.waitForFunction(() => window.store.getState().cc.strategies?.reserve === 500);
  await page.getByRole("button", { name: "Contextual choices", exact: true }).click();
  await page.locator("[data-strategy-panel]").evaluate((panel) => { panel.scrollTop = 0; });
  await page.screenshot({ path: path.join(out, "strategy-desktop.png") });
  console.log("Selected economy and set reserve; desktop screenshot captured");

  // Clear older companion offers so this test accepts the selected strategy's actual step.
  await page.evaluate(async () => {
    const api = "companion/api/";
    const state = await (await fetch(api + "v1/state")).json();
    for (const offer of state.pending_actions ?? [])
      await fetch(api + "v1/actions/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proposal_id: offer.proposal_id }) });
  });
  await page.getByRole("button", { name: "Prepare next step", exact: true }).click();
  await page.waitForFunction(() => !!window.game.cc.pending(), null, { timeout: 30000 });
  const before = await page.evaluate(() => ({ active: window.store.getState().cc.strategies.active.id,
    proposal: window.game.cc.pending().text, tick: window.store.getState().ui.tick }));
  console.log("selected strategy proposal", before);
  await page.getByRole("button", { name: "Apply recommendation (G)", exact: true }).first().waitFor();
  const proposalId = await page.evaluate(() => window.game.cc.pending().id);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "g", code: "KeyG", repeat: true, bubbles: true })));
  assert.equal(await page.evaluate(() => window.game.cc.pending().id), proposalId);
  await page.evaluate(() => window.game.cc.setOpen(true));
  await page.getByLabel("Ask the co-commander").fill("g");
  await page.keyboard.press("g");
  assert.equal(await page.evaluate(() => window.game.cc.pending().id), proposalId);
  await page.evaluate(() => { window.game.cc.setOpen(false); window.game.cc.setStrategyOpen(true); });
  await page.locator("canvas.stage").focus();
  await page.screenshot({ path: path.join(out, "recommendation-shortcut.png") });
  await page.keyboard.press("g");
  await page.waitForFunction(() => window.store.getState().cc.feed.some((item) => item.kind === "done"), null, { timeout: 30000 });

  await page.getByRole("button", { name: "All strategies", exact: true }).click();
  await page.getByRole("button", { name: /^Protect the economy/ }).click();
  await page.waitForFunction(() => window.store.getState().cc.strategies?.active?.id === "defend");
  await page.getByRole("button", { name: "Release strategy", exact: true }).click();
  await page.waitForFunction(() => window.store.getState().cc.strategies?.active === null);
  await page.getByRole("button", { name: /^Scout first/ }).click();
  await page.waitForFunction(() => window.store.getState().cc.strategies?.active?.id === "scout");
  await page.getByRole("button", { name: "Contextual choices", exact: true }).click();
  await page.locator("[data-strategy-panel]").evaluate((panel) => { panel.scrollTop = 0; });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.screenshot({ path: path.join(out, "strategy-compact.png") });
  const bounds = await page.locator("[data-strategy-panel]").boundingBox();
  assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 844 && bounds.y + bounds.height < 390);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.evaluate(() => window.game.requestVerify());
  await page.waitForFunction(() => {
    const text = window.store.getState().verify;
    return text && !/\.\.\.$|…$/.test(text);
  }, null, { timeout: 300000 });
  const verify = await page.evaluate(() => window.store.getState().verify);
  console.log("native replay", verify);
  assert.match(verify, /identical/i);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify({ passed: true, before, verify, errors }, null, 2));
  console.log("Strategy acceptance passed; screenshots:", path.resolve(out));
} finally {
  await browser.close();
}
