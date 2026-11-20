// Reads games played by adviser-match.mjs and says where the player who follows the adviser falls behind.
//   node tools/arena/adviser-report.mjs <run folder | game.json>... [--every 120]
// Per game: the outcome, and every <every> game seconds the player's and the computer's income, army value, unspent
// money and what they own (refineries, harvesters, factories, defences, fighters, idle fighters); then the adviser's
// recommendations by kind, with the times its attacks left.
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const every = Number(argv.includes("--every") ? argv[argv.indexOf("--every") + 1] : 120);
const files = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--every").flatMap((p) => fs.statSync(p).isDirectory()
  ? fs.readdirSync(p).filter((f) => f.endsWith(".json")).map((f) => path.join(p, f)) : [p]);
const catalogFile = ["D:/Generated/RTSAI/ai-opponent-20261120/data/catalog.json"].find((f) => fs.existsSync(f));
const catalog = catalogFile ? JSON.parse(fs.readFileSync(catalogFile, "utf8")) : { units: [] };
const units = Object.fromEntries(catalog.units.map((u) => [u.name, u]));
const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t) % 60).padStart(2, "0")}`;
const role = (type) => {
  const u = units[type], label = (u?.label ?? type).toLowerCase();
  if (/refinery/.test(label)) return "refinery";
  if (/harvester|miner|ore truck|chrono miner/.test(label) || ["harv", "cmin"].includes(type)) return "harvester";
  if (/war factory|vehicle factory/.test(label)) return "factory";
  if (u?.kind === "defense" && !/wall|fence|gate/.test(label)) return "defence";
  if (u?.kind === "building" || u?.queue === "Building") return "building";
  if (["Infantry", "Vehicle", "Aircraft", "Ship"].includes(u?.queue) && u?.combat !== false && !/mcv|construction|engineer/i.test(label)) return "fighter";
  return "other";
};
for (const file of files) {
  const g = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!g.minutes) { console.log(`${path.basename(file)}: ${g.outcome} ${g.failed?.slice(0, 200) ?? ""}`); continue; }
  const [me, ai] = g.players;
  console.log(`\n== ${g.name}: ${g.outcome} at ${clock(g.gameSeconds)} · destroyed ${me.killsCost} lost ${me.deathsCost} · earned ${me.earned} vs ${ai.earned} · army peak ${me.armyPeak} vs ${ai.armyPeak}`);
  console.log("time   | earned me/ai   | army me/ai    | cash | ref  harv fact def  fight(idle) | ai: ref harv fact def fight");
  for (const m of g.minutes.filter((m) => m.game % every < 30 || m === g.minutes.at(-1))) {
    const own = (side) => {
      const o = { refinery: 0, harvester: 0, factory: 0, defence: 0, fighter: 0, idle: 0 };
      for (const [type, [n, idle]] of Object.entries(side?.types ?? {})) { const r = role(type); if (r in o) o[r] += n; if (r === "fighter") o.idle += idle; }
      return o;
    };
    const a = own(m.census?.[0]), b = own(m.census?.[1]);
    console.log(`${clock(m.game).padStart(6)} | ${String(m.p[0].earned).padStart(6)}/${String(m.p[1].earned).padEnd(6)} | ${String(m.p[0].army).padStart(6)}/${String(m.p[1].army).padEnd(6)} | ${String(m.own?.cash ?? "?").padStart(5)} | ${a.refinery}    ${a.harvester}    ${a.factory}    ${a.defence}    ${a.fighter}(${a.idle})`.padEnd(98) + ` | ${b.refinery} ${b.harvester} ${b.factory} ${b.defence} ${b.fighter}`);
    if (m.own && "advice" in m.own) {
      const a = m.own.advice, cc = m.own.cc;
      console.log(`         adviser: ${a?.key ? `${a.key} "${a.summary}" (${a.orders} orders)` : `nothing${a?.summary ? ` ("${a.summary}")` : ""}`}${m.own.held ? " [held: already applied]" : ""} · it saw enemy buildings ${a?.seen?.join("/") ?? "?"}, ${a?.available ?? "?"} buildable · queue ${(a?.queue ?? m.own.queue)?.join(", ") || "empty"}`);
      if (cc && (cc.pending || cc.deciding || cc.uncertain || cc.paused)) console.log(`         card: ${cc.pending ?? "none"}${cc.deciding ? " · applying" : ""}${cc.uncertain ? " · outcome unknown" : ""}${cc.paused ? " · paused" : ""}${cc.autoRetried ? " · auto retried once" : ""}`);
    }
  }
  const kinds = {};
  for (const [, key] of g.cards) kinds[key] = (kinds[key] ?? 0) + 1;
  console.log("cards:", Object.entries(kinds).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ${n}`).join(", "));
  console.log("waves:", g.cards.filter(([, k]) => /attack|sweep|press/.test(k)).map(([t, k, s]) => `${clock(t)} ${k} (${s.match(/\d+/)?.[0]})`).join(", "));
  const last = g.minutes.at(-1)?.census?.[0]?.types ?? {};
  console.log("player owns at the end:", Object.entries(last).map(([t, [n]]) => `${units[t]?.label ?? t} ${n}`).join(", "));
  if (g.receipts) {
    const refused = g.receipts.filter(([ok]) => !ok);
    console.log(`engine: ${g.receipts.length - refused.length} cards accepted, ${refused.length} refused${refused.length ? ": " + [...new Set(refused.map(([, d]) => d))].slice(0, 4).join(" | ") : ""}`);
  }
  if (g.errors?.length) console.log("errors:", g.errors.slice(0, 3).join(" | "));
}
