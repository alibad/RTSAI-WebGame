// Playtest of a campaign mission by the page's co-commander in Auto (the browser strategy adviser applying its own
// recommendations: build, train, defend, attack), at a raised game speed, with the campaign's lobby options (fog on).
// One browser at a time; each run is a fresh page. Prints the objectives every game minute and the outcome.
//   node tools/chapters-playtest.mjs <mission> <difficulty[,difficulty...]> [--runs 2] [--speed 4] [--url ...] [--out dir]
//        [--director] [--map-yaml content/maps/<mission>/map.yaml]
// The co-commander does not read mission objectives. --director adds what a player who read the briefing would do,
// on top of Auto: the combat units are sent (attack-move, through the co-commander's own order channel) to each
// mission goal in turn (DIRECTOR below), moving on when that goal's objective completes.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "../web/node_modules/playwright-core/index.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const [mission, diffs = "normal"] = argv.filter((a, i) => !a.startsWith("--") && (i === 0 || !argv[i - 1].startsWith("--")));
const runs = Number(opt("runs", 2));
const speed = Number(opt("speed", 4));
const url = opt("url", "http://127.0.0.1:3492/?profile=public");
const out = opt("out", "D:/rtsai-campaign/playtest");
const limitMinutes = Number(opt("limit", 14));
const director = argv.includes("--director");
fs.mkdirSync(out, { recursive: true });
// Mission goals in order: send the army to `goal` (a named actor) until objective `until` is complete (a number), until
// the mission event `until` has fired (a string), or for `minutes` of game time. `units` (a pattern of unit types) sends
// only those units, with `action` (default attack_move); `capture` sends an engineer to capture each named building.
const DIRECTOR = {
  "lights-in-the-water": [{ goal: "SurvivorsCove", until: 0 }, { goal: "SurvivorsJetty", until: 1 }, { goal: "StrangerSite", until: 2 },
    { goal: "ReefRoadMid", until: 3 }, { goal: "TownGate", until: 99 }],
  "hold-the-ferry-line": [{ goal: "OrionPicket0", until: 0 }, { goal: "FerryPierNorth", until: 99 }],
  "sweet-water": [{ goal: "RoadblockEastGun", until: 0 }, { goal: "PlantPower", until: 2, capture: ["PlantPower", "WaterPlant"] },
    { goal: "CoilVault", until: 3, capture: ["CoilVault"] }],
  // Observers first, on the contacts along the city road and the bay head; then the relays; then home to hold.
  "ghosts-on-the-glass": [{ goal: "Contact6", until: "ghost-school", units: "observer", action: "move" },
    { goal: "Contact7", until: "ghost-north", units: "observer", action: "move" },
    { goal: "Contact4", until: "ghost-bridge", units: "observer", action: "move" },
    { goal: "RelayNorth", minutes: 3 }, { goal: "RelayCape", minutes: 3 }, { goal: "RelaySouth", until: 1 }, { goal: "IsraelConyard", until: 99 }],
};
// Named actors' cells from the map (CPos), converted to the co-commander's map positions (MPos, isometric).
const named = {};
{
  const text = fs.readFileSync(opt("map-yaml", path.join("content/maps", argv[0] ?? "", "map.yaml")), "utf8");
  let name = null;
  for (const line of text.split(/\r?\n/)) {
    const a = line.match(/^\t([^\t:]+): \S+/); if (a) { name = a[1]; continue; }
    const l = line.match(/^\t\tLocation: (-?\d+),(-?\d+)/);
    if (l && name) { const x = +l[1], y = +l[2], v = x + y; named[name] = [(x - y - (v & 1)) / 2, v]; }
  }
}
const nonCombat = /harv|mcv|engineer|truck|sapc|lcrf|spy|dog/i;
const exe = path.join(process.env.LOCALAPPDATA, "ms-playwright/chromium-1228/chrome-win64/chrome.exe");
const results = [];
for (const difficulty of diffs.split(",")) {
  for (let run = 1; run <= runs; run++) {
    const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => {
      try { localStorage.setItem("rtsai.cocommander", JSON.stringify({ enabled: true, mode: "browser", muted: true, auto: true, browserVersion: 1 })); } catch { /* about:blank */ }
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const tag = `${mission} ${difficulty} #${run}`;
    try {
      await page.goto(url);
      await page.waitForFunction(() => ["setup", "error"].includes(window.store?.getState().phase), null, { timeout: 600000 });
      const spec = await page.evaluate((id) => window.store.getState().setup?.missions?.find((m) => m.id === id) ?? null, mission);
      if (!spec) throw new Error(`no mission ${mission}`);
      await page.evaluate((m) => { window.game.wantFactions(null, m.faction); window.game.prepare(m.id); }, spec);
      await page.waitForFunction((id) => { const s = window.store.getState(); return s.preparedMap === id && s.sheets.uploaded >= s.sheets.total; }, mission, { timeout: 600000 });
      // Run 1 uses the campaign's seed; later runs vary it (the co-commander's timing varies too).
      const scenario = { map: spec.id, mission: spec.id, seed: 2025 + run, players: [{ slot: spec.slot, faction: spec.faction, color: "2A6FDB" }],
        options: { difficulty, startingcash: "10000", fog: "True", explored: "False" } };
      await page.evaluate((s) => window.game.start(JSON.stringify(s)), scenario);
      await page.waitForFunction((id) => window.store.getState().phase === "playing" && window.store.getState().ui?.mission?.id === id, mission, { timeout: 600000 });
      await page.evaluate((v) => window.game.client.send({ type: "speed", speed: v }), speed);
      const state = () => page.evaluate(() => { const s = window.store.getState(); return { win: ["Won", "Lost"].includes(s.ui?.win) ? s.ui.win : "", tick: s.ui?.tick ?? 0, cash: s.ui?.cash ?? 0, m: s.ui?.mission }; });
      let s = await state(), lastMin = -1, lastPush = 0, step = 0, stepStart = 0;
      const timeline = [];
      const plan = director ? DIRECTOR[mission] ?? [] : [];
      const stepDone = (p) => typeof p.until === "string" ? (s.m.events ?? []).includes(p.until)
        : p.minutes ? s.tick - stepStart >= p.minutes * 1500 : s.m.objectives[p.until]?.status === "complete";
      while (!s.win && s.tick < limitMinutes * 1500) {
        await page.waitForTimeout(2000);
        s = await state();
        while (step < plan.length && stepDone(plan[step])) { step++; stepStart = s.tick; }
        if (step < plan.length && Date.now() - lastPush > 8000) {
          lastPush = Date.now();
          const p = plan[step];
          const goal = named[p.goal];
          const captures = (p.capture ?? []).map((n) => named[n]);
          const sent = await page.evaluate(async ({ goal, nonCombat, units, action, captures }) => {
            const obs = await window.game.client.adviserObserve();
            const pick = (u) => units ? new RegExp(units, "i").test(u.kind) : u.canAttack && !new RegExp(nonCombat, "i").test(u.kind);
            const far = obs.units.filter((u) => pick(u) && Math.hypot(u.cellX - goal[0], (u.cellY - goal[1]) / 2) > 3);
            let ok = 0;
            for (const u of far.slice(0, 30)) {
              try { const r = await window.game.client.adviserExecute(`director-${u.actorId}-${Date.now()}`, [{ action, actor_id: u.actorId, target_x: goal[0], target_y: goal[1] }]); if (r?.accepted) ok++; } catch { /* refused */ }
            }
            // One engineer to each building to capture (the nearest idle one each time; re-sent while not taken).
            const engineers = obs.units.filter((u) => /engineer/i.test(u.kind));
            for (const [k, c] of captures.entries()) {
              const e = engineers[k];
              if (!e) break;
              try { const r = await window.game.client.adviserExecute(`director-capture-${e.actorId}-${Date.now()}`, [{ action: "capture", actor_id: e.actorId, target_x: c[0], target_y: c[1] }]); if (r?.accepted) ok++; } catch { /* refused */ }
            }
            return ok;
          }, { goal, nonCombat: nonCombat.source, units: p.units ?? null, action: p.action ?? "attack_move", captures });
          if (sent) timeline.push(`${(s.tick / 1500).toFixed(1)} min: ${sent} orders toward ${p.goal}`);
        }
        const min = Math.floor(s.tick / 1500);
        if (min !== lastMin) {
          lastMin = min;
          const line = `${min} min $${s.cash}: ${s.m.objectives.map((o) => o.status[0] + (o.progress && !o.progress.includes("seconds") ? `(${o.progress})` : "")).join(" ")}`;
          timeline.push(line); console.log(`  ${tag} ${line}`);
        }
      }
      await page.screenshot({ path: path.join(out, `${mission}-${difficulty}-${run}.png`) });
      const result = { mission, difficulty, run, seed: scenario.seed, speed, win: s.win || "undecided", minutes: +(s.tick / 1500).toFixed(2),
        objectives: s.m.objectives.map((o) => `${o.status}: ${o.text} ${o.progress ?? ""}`.trim()), timeline, errors };
      results.push(result);
      console.log(`${tag}: ${result.win} at ${result.minutes} min${errors.length ? `, ${errors.length} page errors` : ""}`);
    } catch (e) {
      results.push({ mission, difficulty, run, error: String(e), errors });
      console.log(`${tag}: error ${e}`);
    } finally { await browser.close(); }
    fs.writeFileSync(path.join(out, `${mission}-results.json`), JSON.stringify(results, null, 2));
  }
}
