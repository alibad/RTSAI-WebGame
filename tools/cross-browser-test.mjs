// Run installed browsers only; no downloads, accounts, telemetry writes or deployment.
// node tools/cross-browser-test.mjs <local-url> [output-directory]
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "../web/node_modules/playwright-core/index.mjs";
import { browserExecutable, browserArgs } from "./browser-launch.mjs";

const url = process.argv[2];
assert.ok(url && ["127.0.0.1", "localhost"].includes(new URL(url).hostname), "Use a local test server");
const out = path.resolve(process.argv[3] ?? "artifacts/cross-browser");
fs.mkdirSync(out, { recursive: true });
const runs = [];
for (const [name, browserType, options, contextOptions] of [
  ["chromium", chromium, { executablePath: browserExecutable(), args: browserArgs() }, {}],
  ["firefox", firefox, {}, {}],
  ["webkit", webkit, {}, {}],
  ["chromium-touch", chromium, { executablePath: browserExecutable(), args: browserArgs() }, { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
]) {
  const row = { browser: name, passed: false, modes: [], errors: [] };
  runs.push(row);
  let browser;
  try {
    browser = await browserType.launch({ headless: true, ...options });
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, ...contextOptions });
    // The test is local. Never send analytics, feedback or account traffic to a public service.
    await context.route("**/*", route => {
      const u = new URL(route.request().url());
      return ["127.0.0.1", "localhost"].includes(u.hostname) || ["blob:", "data:"].includes(u.protocol) ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    page.on("pageerror", error => row.errors.push(error.message));
    for (const [profile, scenarioFile] of [["public", "skirmish-public"], ["public-classic", "skirmish-classic"]]) {
      const target = new URL(url); target.searchParams.set("profile", profile); target.searchParams.set("runtime", "aot");
      await page.goto(target.href);
      await page.waitForFunction(() => ["setup", "error"].includes(window.store?.getState().phase), null, { timeout: 120000 });
      const ready = await page.evaluate(() => ({ phase: window.store.getState().phase, error: window.store.getState().error,
        webAudioSupported: typeof window.AudioContext === "function" || typeof window.webkitAudioContext === "function",
        isolated: crossOriginIsolated, sharedMemory: typeof SharedArrayBuffer !== "undefined" }));
      row.webAudioSupported = ready.webAudioSupported;
      assert.equal(ready.phase, "setup", ready.error);
      assert.ok(ready.isolated && ready.sharedMemory, "Shared-memory isolation required");
      if (profile === "public") {
        const link = page.getByRole("link", { name: "Credits & licenses" });
        await link.waitFor();
        const response = await page.request.get(new URL(await link.getAttribute("href"), page.url()).href);
        assert.equal(response.status(), 200);
        assert.match(await response.text(), /audio-credits\.json/);
        // Both modes must be reachable from the menu, in either direction, without knowing a query-string URL.
        await page.getByRole("button", { name: "Classic / top-down", exact: true }).click();
        await page.waitForFunction(() => window.store?.getState().phase === "setup" && window.store.getState().profile === "public-classic", null, { timeout: 120000 });
        await page.getByRole("button", { name: "Isometric", exact: true }).click();
        await page.waitForFunction(() => window.store?.getState().phase === "setup" && window.store.getState().profile === "public", null, { timeout: 120000 });
      }
      const scenario = JSON.parse(fs.readFileSync(new URL(`../scenarios/${scenarioFile}.json`, import.meta.url), "utf8"));
      await page.evaluate(map => window.game.prepare(map), scenario.map);
      await page.waitForFunction(map => window.store.getState().preparedMap === map || window.store.getState().phase === "error", scenario.map, { timeout: 120000 });
      await page.evaluate(json => window.game.start(json), JSON.stringify(scenario));
      await page.waitForFunction(() => window.store.getState().phase === "error" || (window.store.getState().phase === "playing" && !!window.game.client.cur), null, { timeout: 120000 });
      const first = await page.evaluate(() => window.game.client.cur?.header.tick ?? 0);
      await page.waitForTimeout(8000);
      const played = await page.evaluate(() => ({ phase: window.store.getState().phase, error: window.store.getState().error,
        gridType: window.store.getState().info?.gridType,
        tick: window.game.client.cur?.header.tick ?? 0, actors: window.game.client.cur?.actors.length ?? 0,
        draws: window.game.renderer.stats.draws, textures: window.game.renderer.textures.size }));
      row.modes.push({ profile, ...played, advancedTicks: played.tick - first });
      await page.screenshot({ path: path.join(out, `${name}-${profile}.png`) });
      assert.equal(played.phase, "playing", played.error);
      assert.equal(played.gridType, profile === "public" ? "RectangularIsometric" : "Rectangular", "Incorrect gameplay grid");
      assert.ok(played.tick - first >= 40, "Simulation stalled");
      assert.ok(played.actors > 0 && played.draws > 0 && played.textures > 0, "No rendered battlefield");
      await page.evaluate(() => window.game.quit());
    }
    assert.deepEqual(row.errors, []);
    row.passed = true;
  } catch (error) { row.failure = String(error); }
  finally { await browser?.close(); }
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ scope: "Installed browser engines on Windows and touch emulation; not physical Safari or phone hardware", runs }, null, 2) + "\n");
  console.log(JSON.stringify(row));
}
process.exitCode = runs.every(r => r.passed) ? 0 : 1;
