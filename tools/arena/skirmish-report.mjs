// Reads a skirmish grid's results (tools/arena/skirmish-grid.mjs) and says, per game and side, what the computer
// player did: what it built of its roster, how much of its army sat idle, when and with how much it reached the
// enemy base, how much money it left unspent, and whether the game ended.
//   node tools/arena/skirmish-report.mjs --run <folder> [--catalog <catalog.json>] [--json]
// Writes <run>/report.json and prints a table. The catalog (units with costs, and each faction's roster) is
// <run>/catalog.json unless --catalog names another.
import fs from "node:fs";
import path from "node:path";
import { SKILLS } from "./skirmish-skills.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const run = path.resolve(opt("run", "."));
const catalog = JSON.parse(fs.readFileSync(opt("catalog", path.join(run, "catalog.json")), "utf8"));
const unit = Object.fromEntries(catalog.units.map((u) => [u.name, u]));
const results = fs.readFileSync(path.join(run, "results.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const TPS = 25;
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`;
const UNIT_QUEUES = new Set(["Infantry", "Vehicle", "Aircraft", "Ship"]);
// Not fighters: they never join an attack, so they are left out of "idle" and "forward" shares.
const WORKER = /^(harv|cmin|amcv|smcv|engineer|dog|spy)$|miner|harvest|mcv/i;
const isWorker = (t) => WORKER.test(t) || WORKER.test(unit[t]?.label ?? "");

function side(r, k) {
  const faction = k === 0 ? r.a : r.b, skill = k === 0 ? r.aSkill : r.bSkill, p = r.players[k];
  const roster = (catalog.rosters?.[faction] ?? []).filter((n) => unit[n]);
  // Everything this side ever owned, by type, with the most it had at once and how often it was seen idle.
  const seen = {};
  for (const c of r.census) for (const [t, [n, idle]] of Object.entries(c.sides[faction] ?? {})) { const s = (seen[t] ??= { max: 0, samples: 0, idle: 0, first: c.game }); s.max = Math.max(s.max, n); s.samples += n; s.idle += idle; }
  const land = roster.filter((n) => ["Infantry", "Vehicle", "Aircraft"].includes(unit[n].queue));
  const ships = roster.filter((n) => unit[n].queue === "Ship");
  const buildings = roster.filter((n) => !UNIT_QUEUES.has(unit[n].queue));
  const never = (list) => list.filter((n) => !seen[n]).map((n) => ({ id: n, name: unit[n].label, cost: unit[n].cost }));
  // Fighters only, per census minute: how many, how many idle.
  const minutes = r.census.map((c) => {
    let fighters = 0, idle = 0, value = 0;
    for (const [t, [n, i]] of Object.entries(c.sides[faction] ?? {})) {
      value += n * (unit[t]?.cost ?? 0);
      if (!unit[t] || !UNIT_QUEUES.has(unit[t].queue) || isWorker(t)) continue;
      fighters += n; idle += i;
    }
    return { game: c.game, fighters, idle, value };
  });
  const late = minutes.filter((m) => m.game >= 300 && m.fighters >= 4);
  const idleShare = late.length ? late.reduce((s, m) => s + m.idle / m.fighters, 0) / late.length : null;
  const idlePeak = minutes.reduce((best, m) => (m.idle > (best?.idle ?? 0) ? m : best), null);
  // Reaching the enemy base: units within a fifth of the map of the enemy's start (workers included; they rarely go).
  const fwd = r.samples.map((s) => ({ t: s.tick / TPS, n: s.s[k][2], units: s.s[k][0], buildings: s.s[k][3] }));
  const firstAttack = fwd.find((s) => s.n >= 3);
  const visits = []; // stretches with units at the enemy base
  for (const s of fwd) { if (s.n >= 1) { const v = visits.at(-1); if (v && s.t - v.to < 30) { v.to = s.t; v.peak = Math.max(v.peak, s.n); } else visits.push({ from: s.t, to: s.t, peak: s.n }); } }
  const trickles = visits.filter((v) => v.peak <= 2).length;
  // Money: starting cash and any difficulty bonus, plus everything earned, less what stands on the map (beyond the
  // free start) and what was lost. Selling, repairs and half-built items make it an estimate.
  const start = Number(r.cash ?? 5000) + (SKILLS[skill]?.cash ?? 0);
  const startValue = minutes[0]?.value ?? 0;
  const bank = r.timeline.map((e) => { const m = minutes.findLast((x) => x.game * TPS <= e.tick) ?? minutes[0]; return { t: e.tick / TPS, bank: start + e.p[k][5] - Math.max(0, (m?.value ?? 0) - startValue) - e.p[k][2] }; });
  const bankPeak = bank.reduce((b, x) => (x.bank > (b?.bank ?? -1e9) ? x : b), null);
  const bankEnd = bank.at(-1)?.bank ?? 0;
  return { faction, skill, skillLabel: SKILLS[skill]?.label ?? skill, won: p.win === "Won", lost: p.win === "Lost", earned: p.earned, killsCost: p.killsCost, deathsCost: p.deathsCost, armyPeak: p.armyPeak, armyEnd: p.armyEnd,
    buildingsPeak: Math.max(0, ...fwd.map((s) => s.buildings)), built: Object.fromEntries(Object.entries(seen).map(([t, s]) => [t, s.max])),
    rosterLand: land.length, neverLand: never(land), neverShips: never(ships), neverBuildings: never(buildings),
    idleShare: idleShare === null ? null : Math.round(idleShare * 100), idlePeak: idlePeak && { at: idlePeak.game, idle: idlePeak.idle, of: idlePeak.fighters },
    firstAttack: firstAttack ? Math.round(firstAttack.t) : null, visits: visits.length, trickles, biggestWave: Math.max(0, ...visits.map((v) => v.peak)),
    bankPeak: bankPeak && { at: Math.round(bankPeak.t), about: Math.round(bankPeak.bank / 100) * 100 }, bankEnd: Math.round(bankEnd / 100) * 100, minutes };
}

const games = results.filter((r) => !r.failed).map((r) => ({ id: r.id, a: r.a, b: r.b, map: r.map, seed: r.seed, gameSeconds: r.gameSeconds, ended: r.winner !== null, winner: r.winner, winnerSeat: r.winnerSeat, errors: r.errors?.length ?? 0, replay: r.replay, playedAt: r.playedAt, sides: [side(r, 0), side(r, 1)] }));
const failed = results.filter((r) => r.failed).map((r) => ({ id: r.id, a: r.a, b: r.b, failed: r.failed.slice(0, 300) }));
fs.writeFileSync(path.join(run, "report.json"), JSON.stringify({ games, failed }, null, 1));
if (argv.includes("--json")) process.exit(0);
for (const g of games) {
  console.log(`\n${g.id} ${g.map} · ${g.ended ? `${g.winner} wins at ${clock(g.gameSeconds)}` : `NO WINNER after ${clock(g.gameSeconds)}`}${g.errors ? ` · ${g.errors} page errors` : ""}`);
  for (const s of g.sides) {
    console.log(`  ${s.faction.padEnd(8)} ${s.skillLabel.padEnd(24)} ${s.won ? "WON " : s.lost ? "lost" : "    "} army peak ${String(s.armyPeak).padStart(6)} · killed ${String(s.killsCost).padStart(6)} lost ${String(s.deathsCost).padStart(6)} · earned ${String(s.earned).padStart(6)} · bank peak ~${s.bankPeak?.about} at ${clock(s.bankPeak?.at ?? 0)}, end ~${s.bankEnd}`);
    console.log(`           idle ${s.idleShare ?? "-"}% of fighters after 5:00 (most: ${s.idlePeak?.idle ?? 0} of ${s.idlePeak?.of ?? 0} at ${clock(s.idlePeak?.at ?? 0)}) · first 3+ at enemy base ${s.firstAttack === null ? "NEVER" : clock(s.firstAttack)} · ${s.visits} visits, ${s.trickles} of them 1-2 units, biggest ${s.biggestWave}`);
    console.log(`           never built (${s.neverLand.length} of ${s.rosterLand} land/air): ${s.neverLand.map((u) => u.name).join(", ") || "none"}`);
  }
}
for (const f of failed) console.log(`\nFAILED ${f.id} ${f.a} vs ${f.b}: ${f.failed}`);
