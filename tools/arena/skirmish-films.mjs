// Films a skirmish grid's games for review, one at a time: each game's replay through the faction showdown's
// broadcast film (evals/faction-showdown-20261022/tools/film.mjs: the opening, the biggest fights, the ending), then a
// 720p copy with two caption lines of what each computer player did (tools/arena/skirmish-report.mjs).
//   node tools/arena/skirmish-films.mjs --run <folder> [--only g01,g02] [--url http://127.0.0.1:3464/] [--bundle <pack>] [--tag after]
// Needs <run>/report.json (run skirmish-report.mjs first) and ffmpeg. Writes <run>/clips/<id>[-tag].mp4, .jpg and
// <run>/clips/<id>[-tag].json (title, what it shows, facts, suspected problems with their second in the clip).
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SKILLS } from "./skirmish-skills.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const run = path.resolve(opt("run", "."));
const url = opt("url", "http://127.0.0.1:3464/");
const only = opt("only") ? new Set(opt("only").split(",")) : null;
const tag = opt("tag", "");
const bundle = opt("bundle", "");
const report = JSON.parse(fs.readFileSync(path.join(run, "report.json"), "utf8"));
const catalog = JSON.parse(fs.readFileSync(opt("catalog", path.join(run, "catalog.json")), "utf8"));
const nameOf = (f) => catalog.factions.find((x) => x.id === f)?.name ?? f;
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`;
const raw = path.join(run, "films"), out = path.join(run, "clips");
fs.mkdirSync(raw, { recursive: true }); fs.mkdirSync(out, { recursive: true });
const filmTool = path.join(repo, "evals", "faction-showdown-20261022", "tools", "film.mjs");

/** One side in a sentence: what the review needs to know without watching the numbers. */
function line(s) {
  const never = s.neverLand.filter((u) => !/Construction Vehicle|Spy/.test(u.name)).map((u) => u.name);
  return `${nameOf(s.faction)} (${s.skillLabel}): ${s.idleShare === null ? "too short to judge idling" : `${s.idleShare}% of its fighters idle after 5:00`}; ${s.firstAttack === null ? "never reached the enemy base" : `at the enemy base from ${clock(s.firstAttack)}, biggest group ${s.biggestWave}`}; ${never.length ? `never built ${never.slice(0, 5).join(", ")}${never.length > 5 ? ` and ${never.length - 5} more` : ""}` : "built its whole land and air roster"}.`;
}

for (const g of report.games) {
  if (only && !only.has(g.id)) continue;
  const name = `${g.id}${tag ? `-${tag}` : ""}`, [a, b] = g.sides;
  const mp4 = path.join(out, `${name}.mp4`);
  if (fs.existsSync(mp4) && !argv.includes("--again")) { console.log(`${name}: already filmed`); continue; }
  const label = `${nameOf(b.faction)} · ${b.skillLabel}`, sub = `vs ${nameOf(a.faction)} · ${a.skillLabel}${tag ? ` · ${tag}` : ""}`;
  const t0 = Date.now();
  const film = spawnSync(process.execPath, [filmTool, "--replay", g.replay, "--result", path.join(run, "results.jsonl"), "--out", raw, "--url", url, "--name", name,
    "--label", label, "--sub", sub, "--windows", "3", "--window", "36", "--opening", "4", ...(bundle ? ["--bundle", path.resolve(bundle)] : [])], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const made = path.join(raw, `${name}.mp4`);
  if (film.status !== 0 || !fs.existsSync(made)) { console.log(`${name}: FILM FAILED ${String(film.stderr).slice(-400)}`); continue; }
  const filmInfo = JSON.parse(fs.readFileSync(path.join(raw, `${name}.json`), "utf8"));
  // Captions: two lines under the picture, the reference side first (blue), then the side under test (red).
  const caption = path.join(raw, `${name}.txt`);
  fs.writeFileSync(caption, `${line(a)}\n${line(b)}`);
  const esc = (p) => p.replace(/\\/g, "/").replace(/:/g, "\\:");
  const vf = `scale=1280:720:flags=lanczos,pad=1280:792:0:0:color=0x10140e,drawtext=fontfile='${esc("C:/Windows/Fonts/segoeui.ttf")}':textfile='${esc(caption)}':fontsize=17:fontcolor=0xeeeadd:x=18:y=732:line_spacing=7`;
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", made, "-vf", vf, "-c:v", "libx264", "-preset", "medium", "-crf", "29", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4]);
  const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4]).toString().trim());
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(Math.max(0, seconds * 0.55)), "-i", mp4, "-frames:v", "1", "-q:v", "3", path.join(out, `${name}.jpg`)]);
  // Where in the clip each kept stretch of the game is (the film's own timeline), to pin suspects to a second.
  const suspected = [];
  if (!g.ended) suspected.push({ t: Math.max(0, Math.round(seconds) - 6), text: `No winner after ${clock(g.gameSeconds)}: neither computer player can finish the game.` });
  for (const s of [a, b]) {
    if (s.idleShare !== null && s.idleShare >= 50) suspected.push({ t: 5, text: `${nameOf(s.faction)}: ${s.idleShare}% of its fighters stand idle at home after 5:00 (most: ${s.idlePeak.idle} of ${s.idlePeak.of} at ${clock(s.idlePeak.at)}).` });
    if (s.firstAttack === null && g.gameSeconds >= 600) suspected.push({ t: 5, text: `${nameOf(s.faction)} never sent three units to the enemy base in ${clock(g.gameSeconds)}.` });
    const never = s.neverLand.filter((u) => !/Construction Vehicle|Spy/.test(u.name));
    if (never.length && g.gameSeconds >= 900) suspected.push({ t: 5, text: `${nameOf(s.faction)} never built ${never.map((u) => u.name).join(", ")}.` });
  }
  const clip = { id: `ai-${name}`, front: "ai", title: `${label} ${sub}`, file: `${name}.mp4`, poster: `${name}.jpg`, seconds: Math.round(seconds),
    shows: `A whole skirmish in about ${Math.round(seconds / 10) * 10} seconds: the opening, the three biggest fights and the ending. ${nameOf(b.faction)} is played by the ${b.skillLabel} computer player, ${nameOf(a.faction)} by the ${a.skillLabel}.`,
    facts: { map: g.map, seed: g.seed, result: g.ended ? `${nameOf(g.winner)} wins at ${clock(g.gameSeconds)}` : `no winner after ${clock(g.gameSeconds)}`, difficulty: `${b.skillLabel} (${SKILLS[b.skill]?.where})`, sides: [a, b].map((s) => ({ faction: s.faction, name: nameOf(s.faction), skill: s.skillLabel, won: s.won, idlePercent: s.idleShare, firstAtEnemyBase: s.firstAttack, biggestGroup: s.biggestWave, killed: s.killsCost, lost: s.deathsCost, earned: s.earned, neverBuilt: s.neverLand.map((u) => u.name) })),
      replay: g.replay, bundle: bundle || "live", settings: "skirmish defaults (5,000 credits, medium starting units), no crates, speed 8" },
    filmedAt: new Date().toISOString(), playedAt: g.playedAt, suspected, filmSeconds: filmInfo.videoSeconds };
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(clip, null, 1));
  console.log(`${name}: ${Math.round(seconds)} s, ${(fs.statSync(mp4).size / 1e6).toFixed(1)} MB, filmed in ${Math.round((Date.now() - t0) / 1000)} s`);
}
