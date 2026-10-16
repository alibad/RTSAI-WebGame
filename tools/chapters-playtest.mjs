// Playtest of a campaign mission by the page's co-commander in Auto (the browser adviser applying its own
// recommendations: in a mission, the objective planner of web/src/mission-adviser.ts), at a raised game speed, with
// the campaign's lobby options (fog on). One browser at a time; each run is a fresh page. Prints the objectives, the
// orders applied and the co-commander's latest line every game minute, and the outcome (with the orders applied and
// refused and the cash left).
//   node tools/chapters-playtest.mjs <mission> <difficulty[,difficulty...]> [--runs 2] [--speed 4] [--url ...] [--out dir]
//        [--limit 14] [--mode auto|suggest] [--director] [--map-yaml content/maps/<mission>/map.yaml]
// --director adds scripted army moves on top of Auto (the combat units attack-move to each mission goal in turn,
// DIRECTOR below): from before the co-commander read objectives, kept to compare against.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "../web/node_modules/playwright-core/index.mjs";
import { WaterPlayer } from "./campaign-player.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const [mission, diffs = "normal"] = argv.filter((a, i) => !a.startsWith("--") && (i === 0 || !argv[i - 1].startsWith("--")));
const runs = Number(opt("runs", 2));
const speed = Number(opt("speed", 4));
const url = opt("url", "http://127.0.0.1:3492/?profile=public");
const out = opt("out", "D:/rtsai-campaign/playtest");
const limitMinutes = Number(opt("limit", 14));
const director = argv.includes("--director");
const auto = opt("mode", "auto") !== "suggest" && !opt("player", "");
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
    await context.addInitScript((a) => {
      try { localStorage.setItem("rtsai.cocommander", JSON.stringify({ enabled: true, mode: "browser", muted: true, auto: a, browserVersion: 1 })); } catch { /* about:blank */ }
    }, auto);
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
      const scenario = { map: spec.id, mission: spec.id, seed: Number(opt("seed", "2026")) + run - 1, players: [{ slot: spec.slot, faction: spec.faction, color: "2A6FDB" }],
        options: { difficulty, startingcash: "10000", fog: "True", explored: "False" } };
      await page.evaluate((s) => window.game.start(JSON.stringify(s)), scenario);
      await page.waitForFunction((id) => window.store.getState().phase === "playing" && window.store.getState().ui?.mission?.id === id, mission, { timeout: 600000 });
      await page.evaluate((v) => window.game.client.send({ type: "speed", speed: v }), speed);
      // The co-commander's feed: orders applied or refused, and its lines (new entries since the last look).
      const state = () => page.evaluate(() => { const s = window.store.getState(); return { phase:s.phase,error:s.error, win: ["Won", "Lost"].includes(s.ui?.win) ? s.ui.win : "", tick: s.ui?.tick ?? 0, cash: s.ui?.cash ?? 0, m: s.ui?.mission,
        feed: s.cc.feed.map((f) => ({ id: f.id, kind: f.kind, text: f.text, state: f.state })) }; });
      let s = await state(), lastMin = -1, lastPush = 0, step = 0, stepStart = 0, seen = 0, applied = 0, refused = 0, line = "";
      const player=opt('player','')==='water'?new WaterPlayer(fs.readFileSync(opt('map-yaml',path.join('content/maps',mission,'map.yaml')),'utf8')):null;
      let playerTick=-1000;
      const timeline = [], lines = [], refusals = [];
      const read = () => {
        for (const f of s.feed.filter((x) => x.id > seen)) {
          if (f.kind === "done") applied++;
          if (f.kind === "rejected") { refused++; if (refusals.length < 20) refusals.push(`${(s.tick / 1500).toFixed(1)} ${f.text}`); }
          if (f.kind === "ai") { line = f.text; lines.push(`${(s.tick / 1500).toFixed(1)} ${f.text}`); }
        }
        seen = Math.max(seen, ...s.feed.map((x) => x.id));
      };
      const plan = director ? DIRECTOR[mission] ?? [] : [];
      const stepDone = (p) => typeof p.until === "string" ? (s.m.events ?? []).includes(p.until)
        : p.minutes ? s.tick - stepStart >= p.minutes * 1500 : s.m.objectives[p.until]?.status === "complete";
      while (!s.win && s.tick < limitMinutes * 1500) {
        await page.waitForTimeout(player?200:2000);
        s = await state();
        if(s.phase==='error')throw Error(s.error||'Simulation entered error phase');
        if(player&&s.tick-playerTick>=125&&!s.win){
          const obs=await page.evaluate(async()=>{const {spatial,...o}=await window.game.client.adviserObserve();return o;});
          await player.tick(obs,s.m,commands=>page.evaluate(commands=>window.game.client.adviserExecute(`campaign-player-${crypto.randomUUID()}`,commands),commands));
          playerTick=s.tick;
        }
        read();
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
          const entry = `${min} min $${s.cash}: ${s.m.objectives.map((o) => o.status[0] + (o.progress && !o.progress.includes("seconds") ? `(${o.progress})` : "")).join(" ")} | ${applied} orders | ${line}`;
          timeline.push(entry); console.log(`  ${tag} ${entry}`);
          fs.writeFileSync(path.join(out, `${mission}-checkpoint.json`), JSON.stringify({tick:s.tick,cash:s.cash,mission:s.m,applied,refused,line,errors},null,2));
          if(argv.includes('--diagnostic-samples')) {
            const sample=await page.evaluate(async()=>{const {spatial,...observation}=await window.game.client.adviserObserve();const memory=window.game.cc.mission?.memory;return {observation,memory:memory?{offset:memory.offset,named:[...memory.named],heading:[...memory.heading],search:[...memory.search],voyages:[...memory.voyages]}:null};});
            fs.writeFileSync(path.join(out,`${mission}-minute-${min}.json`),JSON.stringify(sample,null,2));
          }
        }
      }
      s = await state(); read();
      let progressSaved=false;
      if(s.win==='Won') {
        await page.getByRole('heading',{name:'Operation complete',exact:true}).waitFor({timeout:10000});
        await page.waitForFunction(({mission,difficulty})=>JSON.parse(localStorage.getItem('rtsai.missions.completed')??'{}')[mission]===difficulty,{mission,difficulty},{timeout:10000});
        progressSaved=true;
      }
      await page.screenshot({ path: path.join(out, `${mission}-${difficulty}-${run}.png`) });
      const done = s.m.objectives.filter((o) => o.status === "complete").length;
      const observation = await page.evaluate(() => window.game.client.adviserObserve());
      fs.writeFileSync(path.join(out, `${mission}-${difficulty}-${run}-observation.json`), JSON.stringify(observation, null, 2));
      const result = { mission, difficulty, run, seed: scenario.seed, speed, player:player?'scripted-water':'Auto',playerLines:player?.lines,playerReceipts:player?.receipts, progressSaved, win: s.win || "undecided", minutes: +(s.tick / 1500).toFixed(2), cash: s.cash,
        complete: `${done}/${s.m.objectives.length}`, events: s.m.events ?? [], applied, refused, refusals,
        objectives: s.m.objectives.map((o) => `${o.status}: ${o.text} ${o.progress ?? ""}`.trim()), timeline, lines, errors };
      results.push(result);
      console.log(`${tag}: ${result.win} at ${result.minutes} min, objectives ${result.complete}, ${applied} orders (${refused} refused), $${s.cash}${errors.length ? `, ${errors.length} page errors` : ""}`);
    } catch (e) {
      results.push({ mission, difficulty, run, error: String(e), errors });
      console.log(`${tag}: error ${e}`);
    } finally { await browser.close(); }
    fs.writeFileSync(path.join(out, `${mission}-results.json`), JSON.stringify(results, null, 2));
  }
}
