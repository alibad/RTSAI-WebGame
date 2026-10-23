// A finished Arena game, minute by minute, from its decision log: what was built and trained, what the army did, and
// what each army turn saw (threat, enemy value in sight, our army). For studying why a game was won or lost.
//   node tools/arena/game-story.mjs <game id | "last:<provider>:<opponent>"> [--dir <arena data folder>]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const dir = opt("dir", path.join(process.env.LOCALAPPDATA ?? os.homedir(), "RTSAI-WebGame", "arena"));
const games = fs.readFileSync(path.join(dir, "games.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
let id = argv[0] ?? "";
if (id.startsWith("last:")) {
  const [, provider, opponent] = id.split(":");
  id = games.filter((g) => (g.provider ?? g.brain) === provider && g.opponent === opponent).at(-1)?.id ?? "";
}
const game = games.find((g) => g.id === id);
if (!game) throw new Error(`no game ${argv[0]}`);
const decisions = JSON.parse(fs.readFileSync(path.join(dir, "decisions", `${id}.json`), "utf8"));
console.log(`${game.ours} (${game.provider ?? game.brain}) vs ${game.opponent} ${game.theirs}: ${game.result} at ${Math.floor(game.gameSeconds / 60)}:${String(game.gameSeconds % 60).padStart(2, "0")}`);
console.log(`  us   kills ${game.us?.killsCost} lost ${game.us?.deathsCost} army peak ${game.us?.armyPeak} earned ${game.us?.earned}`);
console.log(`  them kills ${game.them?.killsCost} lost ${game.them?.deathsCost} army peak ${game.them?.armyPeak} earned ${game.them?.earned}`);
const byMinute = new Map();
for (const d of decisions) {
  const m = Math.floor(d.tick / 25 / 60);
  const row = byMinute.get(m) ?? { made: [], army: [], auto: [], seen: "" };
  for (const a of d.auto ?? []) if (!/Gather/.test(a.label)) row.auto.push(a.label.replace(/^Place the /, "place "));
  for (const q of d.questions) {
    if (q.choice && q.choice !== "wait" && q.name !== "army") row.made.push(`${q.name}:${q.choice}${q.accepted === false ? "(refused)" : ""}`);
    if (q.name === "army") row.army.push(q.choice);
  }
  if (d.seen) row.seen = d.seen;
  byMinute.set(m, row);
}
for (const [m, r] of byMinute) {
  const army = Object.entries(r.army.reduce((c, a) => ({ ...c, [a]: (c[a] ?? 0) + 1 }), {})).map(([k, v]) => `${k}x${v}`).join(" ");
  console.log(`${String(m).padStart(2)} min | ${r.made.join(", ") || "-"}${r.auto.length ? ` | ${r.auto.join(", ")}` : ""} | army: ${army || "-"}${r.seen ? ` | ${r.seen}` : ""}`);
}
