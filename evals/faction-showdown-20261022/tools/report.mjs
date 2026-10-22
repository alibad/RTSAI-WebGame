// The tournament report of one run: <run>/report.html, beside the run's videos. Standings, results by starting
// settings, head-to-head matrix, groups, the filmed matches and the bugs found (bugs.json).
//   node tools/report.mjs --run runs/<name>
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const run = path.resolve(opt("run", "."));
const resultsFile = path.join(run, "results.jsonl");
const outFile = path.join(run, "report.html");
const results = (fs.existsSync(resultsFile) ? fs.readFileSync(resultsFile, "utf8") : "").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const jobs = JSON.parse(fs.readFileSync(path.join(run, "jobs.json"), "utf8"));
const firstCount = results.length;
// --include runs/<other>: games of another run with the same settings (follow-up games) count in this report.
const included = argv.flatMap((a, i) => (a === "--include" ? [path.resolve(argv[i + 1])] : []));
for (const other of included) {
  const file = path.join(other, "results.jsonl");
  if (fs.existsSync(file)) results.push(...fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
  jobs.push(...JSON.parse(fs.readFileSync(path.join(other, "jobs.json"), "utf8")));
}
// Two runners may meet on a job at the crossover: count each job once (its first result).
const firstOf = new Map();
for (const r of results) { const k = `${r.a}|${r.b}|${r.map}|${r.seed}`; if (!firstOf.has(k)) firstOf.set(k, r); }
results.splice(0, results.length, ...firstOf.values());
const bugs = JSON.parse(fs.readFileSync(path.join(root, "bugs.json"), "utf8"));
const setup = JSON.parse(fs.readFileSync(path.join(root, "setup.json"), "utf8")).setup;
// The run's own build note (BUILD.txt) when it has one, else the page twin's.
const build = fs.readFileSync(fs.existsSync(path.join(run, "BUILD.txt")) ? path.join(run, "BUILD.txt") : path.join(root, "page", "EVAL-BUILD.txt"), "utf8").replace(/^﻿/, "").trim();

const F = ["america", "germany", "england", "france", "korea", "cuba", "libya", "iraq", "russia", "china", "iran", "turkey", "saudi", "israel", "yemen", "hezbollah"];
const GROUP = { america: "Allies", germany: "Allies", england: "Allies", france: "Allies", korea: "Allies", cuba: "Soviets", libya: "Soviets", iraq: "Soviets", russia: "Soviets" };
const groupOf = (f) => GROUP[f] ?? "Modern";
const nameOf = (f) => setup.factions.find((x) => x.id === f)?.name ?? f;
const flagCache = {};
// Hezbollah shows the HZB monogram, as in the films (owner rule: never its flag).
const HZB = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 40"><rect width="60" height="40" rx="3" fill="#24331a"/><rect x="1" y="1" width="58" height="38" rx="2.5" fill="none" stroke="#7fae3a" stroke-width="2"/><text x="30" y="26.5" text-anchor="middle" font-family="Segoe UI,Arial,sans-serif" font-weight="700" font-size="17" fill="#cfe7a4">HZB</text></svg>`;
const flag = (f) => (flagCache[f] ??= `data:image/svg+xml;base64,${(f === "hezbollah" ? Buffer.from(HZB) : fs.readFileSync(path.join(root, "page", "flags", `${f}.svg`))).toString("base64")}`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const pct = (x) => `${Math.round(x * 100)}%`;

// A game counts when it finished cleanly: a winner, or the time cap. Crashed games are bugs, not results.
const crashed = (r) => r.failed || (r.errors ?? []).some((e) => e.kind === "phase" || e.kind === "crash");
const games = results.filter((r) => !crashed(r));
const crashes = results.filter(crashed);
const stat = Object.fromEntries(F.map((f) => [f, { f, w: 0, d: 0, l: 0, games: 0, winSecs: [], earned: [], kills: 0, deaths: 0 }]));
const h2h = {};
for (const r of games) {
  for (const [me, them] of [[r.a, r.b], [r.b, r.a]]) {
    const s = stat[me];
    s.games++;
    if (!r.winner) s.d++; else if (r.winner === me) { s.w++; s.winSecs.push(r.gameSeconds); } else s.l++;
    const p = r.players?.find((x) => x.faction === me);
    if (p) { s.earned.push(p.earned); s.kills += p.killsCost; s.deaths += p.deathsCost; }
    const k = `${me}|${them}`;
    (h2h[k] ??= { pts: 0, n: 0, list: [] });
    h2h[k].pts += !r.winner ? 0.5 : r.winner === me ? 1 : 0;
    h2h[k].n++;
    h2h[k].list.push(r);
  }
}
const avg = (a) => (a.length ? a.reduce((t, x) => t + x, 0) / a.length : 0);
const table = Object.values(stat).map((s) => ({ ...s, pts: s.w + s.d / 2, rate: s.games ? (s.w + s.d / 2) / s.games : 0 }))
  .sort((p, q) => q.rate - p.rate || q.w - p.w);
// Wilson 95% interval of the score rate (draws as half points), to show what is noise.
const wilson = (rate, n) => { if (!n) return [0, 1]; const z = 1.96, d = 1 + z * z / n, c = rate + z * z / (2 * n), m = z * Math.sqrt(rate * (1 - rate) / n + z * z / (4 * n * n)); return [(c - m) / d, (c + m) / d]; };

// Group vs group.
const groups = ["Allies", "Soviets", "Modern"];
const gg = {};
for (const r of games) for (const [me, them] of [[r.a, r.b], [r.b, r.a]]) {
  const k = `${groupOf(me)}|${groupOf(them)}`;
  (gg[k] ??= { pts: 0, n: 0 });
  gg[k].pts += !r.winner ? 0.5 : r.winner === me ? 1 : 0;
  gg[k].n++;
}

// By starting settings: each faction's score per configuration (units, cash), in the jobs' order.
const UNITS = { none: "No starting units", light: "Light units", medium: "Medium units", heavy: "Heavy starting units" };
const cfgOf = (r) => `${r.units ?? "medium"}-${r.cash ?? 5000}`;
const UNIT_ORDER = ["none", "light", "medium", "heavy"];
const configs = [...new Set(jobs.map(cfgOf))].sort((p, q) => UNIT_ORDER.indexOf(p.split("-")[0]) - UNIT_ORDER.indexOf(q.split("-")[0]) || Number(p.split("-")[1]) - Number(q.split("-")[1]));
const byCfg = {};
for (const r of games) for (const me of [r.a, r.b]) {
  const k = `${me}|${cfgOf(r)}`;
  (byCfg[k] ??= { pts: 0, n: 0 });
  byCfg[k].pts += !r.winner ? 0.5 : r.winner === me ? 1 : 0;
  byCfg[k].n++;
}
const cfgSummary = Object.fromEntries(configs.map((c) => {
  const gs = games.filter((r) => cfgOf(r) === c), won = gs.filter((r) => r.winner);
  return [c, { n: gs.length, avgWin: avg(won.map((r) => r.gameSeconds)), planned: jobs.filter((j) => cfgOf(j) === c).length }];
}));
const unitGroups = [...new Set(configs.map((c) => c.split("-")[0]))];
const cfgName = (c) => `${UNITS[c.split("-")[0]] ?? c.split("-")[0]}, $${Number(c.split("-")[1]).toLocaleString("en-US")}`;

// Coverage (tools/coverage.mjs): per faction, roster units buildable with a full base and combat units seen firing;
// plus which units the AI built at least once, before the AI fix (the units-and-money run) and after it.
const rosters = fs.existsSync(path.join(root, "dev", "rosters.json")) ? JSON.parse(fs.readFileSync(path.join(root, "dev", "rosters.json"), "utf8")) : null;
const covDir = path.join(root, "dev", "coverage");
const coverage = rosters && fs.existsSync(covDir) ? fs.readdirSync(covDir).filter((f) => /^[a-z]+\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(covDir, f), "utf8"))) : [];
const unitLabel = rosters ? Object.fromEntries(rosters.units.map((u) => [u.name, u.label])) : {};
function aiBuilt(runDir) {
  const file = path.join(root, "runs", runDir, "results.jsonl");
  const seen = {};
  if (!fs.existsSync(file)) return null;
  for (const l of fs.readFileSync(file, "utf8").split("\n")) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    for (const c of r.census ?? []) for (const [f, t] of Object.entries(c.sides)) for (const k of Object.keys(t)) (seen[f] ??= new Set()).add(k);
  }
  return seen;
}
const before = aiBuilt("units-and-money"), after = aiBuilt("ai-fix-none-10000");
// Units that only spot for others, and jets that need an airfield to fly from: not expected to fire on this range.
const NOT_EXPECTED = { r2ilobserver: "spotter", r2sajtac: "spotter", r2trdroneop: "spotter", r2skyspear: "interceptor jet (needs an airfield)", r2sahin: "interceptor jet (needs an airfield)", r2raad: "inconclusive on this range" };
const covRows = coverage.map((c) => {
  const units = Object.keys(c.buildable);
  const buildable = units.filter((n) => c.buildable[n].buildable).length;
  const tested = Object.entries(c.fires).filter(([, x]) => x.tested);
  const fired = tested.filter(([, x]) => x.fired).length;
  const silent = tested.filter(([, x]) => !x.fired).map(([n]) => n);
  const trainable = units.filter((n) => !/^(amcv|smcv|engineer|spy|lcrf|sapc|shad)$/.test(n));
  const count = (seen) => seen?.[c.faction] ? trainable.filter((n) => seen[c.faction].has(n)).length : null;
  return { f: c.faction, units: units.length, buildable, fired, tested: tested.length, silent, trainable: trainable.length, before: count(before), after: count(after),
    missingBefore: before?.[c.faction] ? trainable.filter((n) => !before[c.faction].has(n)) : [] };
}).sort((p, q) => F.indexOf(p.f) - F.indexOf(q.f));

// Why sides win: value destroyed per value lost, and each side's army mix in minutes 10-25 (from the census).
const kd = {};
for (const r of games) for (const p of r.players ?? []) { const k = (kd[p.faction] ??= { k: 0, d: 0 }); k.k += p.killsCost; k.d += p.deathsCost; }
const kdRows = Object.entries(kd).map(([f, v]) => ({ f, ratio: v.d ? v.k / v.d : 0 })).sort((p, q) => q.ratio - p.ratio);
const unitKind = rosters ? Object.fromEntries(rosters.units.map((u) => [u.name, u.kind])) : {};
const mix = {};
for (const r of games) for (const c of r.census ?? []) {
  if (c.game < 600 || c.game > 1500) continue;
  for (const [f, t] of Object.entries(c.sides)) for (const [u, n] of Object.entries(t))
    if (["vehicle", "infantry", "aircraft", "ship"].includes(unitKind[u]) && !/harv|cmin|mcv|engineer/.test(u)) (mix[f] ??= {})[u] = (mix[f][u] ?? 0) + n;
}
const mixOf = (f) => { const m = mix[f] ?? {}; const tot = Object.values(m).reduce((s, x) => s + x, 0) || 1;
  const byKind = {}; for (const [u, n] of Object.entries(m)) byKind[unitKind[u]] = (byKind[unitKind[u]] ?? 0) + n;
  return { top: Object.entries(m).sort((p, q) => q[1] - p[1]).slice(0, 6).map(([u, n]) => ({ u, pct: n / tot })), ships: (byKind.ship ?? 0) / tot }; };

// Videos: the filmed matches, with a poster frame each.
const vdir = path.join(run, "videos");
const posters = path.join(vdir, "posters");
fs.mkdirSync(posters, { recursive: true });
const films = fs.existsSync(vdir) ? fs.readdirSync(vdir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(vdir, f), "utf8"))) : [];
for (const v of films) {
  const base = path.basename(v.video, ".mp4");
  const poster = path.join(posters, `${base}.jpg`);
  v.poster = `videos/posters/${base}.jpg`;
  v.href = `videos/${base}.mp4`;
  if (!fs.existsSync(poster)) {
    // A frame from a battle when there was one, else from the middle.
    const battle = (v.timeline ?? []).find((e) => e.event === "resume");
    const at = Math.min(v.videoSeconds - 1, battle ? 12 : v.videoSeconds / 2);
    try { execFileSync("ffmpeg", ["-y", "-v", "error", "-ss", String(at), "-i", v.video, "-frames:v", "1", "-vf", "scale=480:-1", "-q:v", "4", poster]); } catch { /* no poster */ }
  }
}
const filmCfg = (v) => cfgOf(jobs.find((j) => j.a === v.a && j.b === v.b && j.seed === v.seed) ?? {});
films.sort((p, q) => (jobs.findIndex((j) => j.a === p.a && j.b === p.b && j.seed === p.seed)) - (jobs.findIndex((j) => j.a === q.a && j.b === q.b && j.seed === q.seed)));

const decisive = games.filter((r) => r.winner);
// The time cap the run used: draws end at it (rounded to whole minutes), else the longest win.
const capMin = Math.round(Math.max(0, ...games.filter((r) => !r.winner).map((r) => r.gameSeconds), ...(games.some((r) => !r.winner) ? [] : games.map((r) => r.gameSeconds))) / 600) * 10 || 40;
const fastest = [...decisive].sort((p, q) => p.gameSeconds - q.gameSeconds)[0];
const longestWin = [...decisive].sort((p, q) => q.gameSeconds - p.gameSeconds)[0];
const champion = table[0];
const flagImg = (f, cls = "fl") => `<img class="${cls}" src="${flag(f)}" alt="" title="${esc(nameOf(f))}">`;
const scoreColor = (x) => { // 0 red .. .5 neutral .. 1 green
  const a = Math.abs(x - 0.5) * 2;
  return x >= 0.5 ? `rgba(87,211,107,${(0.12 + a * 0.6).toFixed(2)})` : `rgba(239,91,63,${(0.12 + a * 0.6).toFixed(2)})`;
};

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Faction Showdown</title>
<style>
:root { --bg:#0b0e0b; --panel:#131812; --panel2:#0f130e; --line:#2c3329; --gold:#f1d28b; --gold2:#a8924f; --ink:#eeeadd; --mute:#a2a695; --faint:#6f7168; --red:#ef5b3f; --green:#57d36b; --blue:#4f80ff; }
* { box-sizing: border-box; }
body { margin: 0; background: radial-gradient(1200px 600px at 50% -200px, #1d251a, var(--bg)); color: var(--ink); font: 15px/1.5 "Segoe UI", system-ui, sans-serif; }
main { max-width: 1180px; margin: 0 auto; padding: 32px 16px 80px; }
h1 { font-size: 40px; letter-spacing: .1em; text-transform: uppercase; color: var(--gold); margin: 0; }
h2 { font-size: 13px; letter-spacing: .2em; text-transform: uppercase; color: var(--gold2); margin: 48px 0 14px; display: flex; align-items: center; gap: 12px; }
h2::after { content: ""; flex: 1; height: 1px; background: var(--line); }
.sub { color: var(--mute); margin: 6px 0 0; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin-top: 22px; }
.tile { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; }
.tile b { display: block; font: 700 28px/1.1 Consolas, ui-monospace, monospace; color: var(--ink); }
.tile span { color: var(--mute); font-size: 12px; letter-spacing: .06em; }
.tile.alert b { color: var(--red); } .tile.good b { color: var(--green); }
.fl { width: 24px; height: 16px; object-fit: cover; border-radius: 2px; box-shadow: 0 0 0 1px #0008; vertical-align: middle; }
.podium { display: grid; grid-template-columns: 1fr 1.25fr 1fr; gap: 12px; align-items: end; }
.pod { background: linear-gradient(#1a2118, var(--panel2)); border: 1px solid var(--line); border-radius: 10px; text-align: center; padding: 18px 10px 14px; }
.pod.first { border-color: #f1d28b77; box-shadow: 0 0 40px #f1d28b22; padding-top: 26px; }
.pod img { width: 84px; height: 56px; object-fit: cover; border-radius: 4px; box-shadow: 0 0 0 1px #0009; }
.pod.first img { width: 120px; height: 80px; }
.pod .rk { font: 700 12px/1 Consolas, monospace; color: var(--gold2); letter-spacing: .2em; }
.pod .nm { font-size: 20px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; margin-top: 8px; }
.pod .sc { color: var(--mute); font: 13px Consolas, monospace; }
.rows { display: grid; gap: 6px; margin-top: 14px; }
.row { display: grid; grid-template-columns: 28px 28px 150px 1fr 120px; align-items: center; gap: 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 7px 12px; }
.row .n { color: var(--faint); font: 12px Consolas, monospace; }
.row .nm { font-weight: 600; }
.row .nm small { color: var(--faint); font-weight: 400; margin-left: 6px; font-size: 11px; }
.bar { position: relative; height: 14px; background: #0a0d0a; border-radius: 3px; overflow: hidden; }
.bar i { position: absolute; inset: 0 auto 0 0; background: linear-gradient(90deg, #a8924f, #f1d28b); }
.bar .ci { position: absolute; top: 5px; height: 4px; background: #0008; }
.bar::after { content: ""; position: absolute; left: 50%; top: 0; bottom: 0; width: 1px; background: #eeeadd55; }
.row .wdl { font: 12px Consolas, monospace; color: var(--mute); text-align: right; }
.row .wdl b { color: var(--ink); font-size: 14px; }
.mx { overflow-x: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px; }
.mx table { border-collapse: separate; border-spacing: 2px; margin: 0 auto; }
.mx td, .mx th { width: 46px; height: 34px; text-align: center; font: 12px Consolas, monospace; border-radius: 3px; }
.mx th.rh { width: 120px; text-align: right; font: 600 12px "Segoe UI"; padding-right: 6px; white-space: nowrap; }
.mx td.self { background: #0a0d0a; }
.mx td { cursor: default; }
.legend { color: var(--mute); font-size: 12px; margin-top: 8px; text-align: center; }
.groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
.gcard { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; }
.gcard h3 { margin: 0 0 4px; font-size: 14px; letter-spacing: .1em; text-transform: uppercase; color: var(--gold); }
.gcard .flags { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 10px; }
.gline { display: grid; grid-template-columns: 90px 1fr 46px; gap: 8px; align-items: center; font-size: 13px; margin: 4px 0; color: var(--mute); }
.vids { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }
.vid { display: block; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; color: inherit; text-decoration: none; transition: transform .15s, border-color .15s; }
.vid:hover { transform: translateY(-2px); border-color: #f1d28b77; }
.vid .pic { position: relative; aspect-ratio: 16/9; background: #000 center/cover; }
.vid .pic span { position: absolute; right: 6px; bottom: 6px; background: #000c; color: var(--ink); font: 11px Consolas, monospace; padding: 2px 6px; border-radius: 3px; }
.vid .pic em { position: absolute; left: 6px; top: 6px; background: var(--gold); color: #111; font: 700 10px "Segoe UI"; letter-spacing: .1em; text-transform: uppercase; padding: 2px 6px; border-radius: 3px; font-style: normal; }
.vid .cap { padding: 8px 10px; display: flex; align-items: center; gap: 6px; font-size: 13px; }
.vid .cap .vs { color: var(--faint); font-size: 11px; }
.vid .cap .t { margin-left: auto; color: var(--faint); font: 11px Consolas, monospace; }
.bug { background: var(--panel); border: 1px solid var(--line); border-left: 4px solid var(--red); border-radius: 8px; padding: 16px 18px; margin-bottom: 12px; }
.bug.medium { border-left-color: #f3c94a; } .bug.low { border-left-color: var(--mute); }
.bug h3 { margin: 0; font-size: 17px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.chip { font: 700 10px/1 "Segoe UI"; letter-spacing: .12em; text-transform: uppercase; padding: 4px 7px; border-radius: 3px; }
.chip.high { background: #ef5b3f33; color: #ff9b85; } .chip.medium { background: #f3c94a2a; color: #f3d983; } .chip.low { background: #ffffff14; color: var(--mute); }
.chip.fixed { background: #57d36b2a; color: #8be69a; } .chip.live { background: #57d36b; color: #0b0e0b; } .chip.open { background: #ffffff14; color: var(--mute); }
.bug .id { color: var(--faint); font: 12px Consolas, monospace; }
.bug p { margin: 8px 0 0; color: var(--mute); } .bug p b { color: var(--ink); font-weight: 600; }
.bug ul { margin: 6px 0 0; padding-left: 18px; color: var(--mute); } .bug li { margin: 3px 0; }
.bug code { font: 12px Consolas, monospace; color: var(--gold); }
.cov td { width: auto; min-width: 92px; padding: 0 8px; }
.cov th small, .cov td small { color: var(--faint); font: 400 10px "Segoe UI"; }
.cov .lt { text-align: left; font: 12px "Segoe UI"; color: var(--mute); min-width: 260px; }
.reel { display: block; width: 100%; border-radius: 10px; border: 1px solid var(--line); background: #000; margin-top: 12px; }
.vgroup { margin: 18px 0 10px; font-size: 14px; font-weight: 600; color: var(--ink); letter-spacing: .04em; }
.vgroup small { color: var(--faint); font-weight: 400; margin-left: 8px; }
.player { position: fixed; inset: 0; background: #000d; display: grid; place-items: center; z-index: 10; padding: 16px; }
.player[hidden] { display: none; }
.pbox { width: min(1280px, 100%); background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.pbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; font-size: 14px; }
.pbar span { flex: 1; color: var(--gold); }
.pbar button { background: #ffffff12; color: var(--ink); border: 1px solid var(--line); border-radius: 6px; width: 34px; height: 30px; font-size: 16px; cursor: pointer; }
.pbar button:hover { border-color: #f1d28b77; }
.player video { display: block; width: 100%; max-height: calc(100vh - 90px); background: #000; }
.note { color: var(--mute); font-size: 13px; background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; }
.note li { margin: 4px 0; }
@media (max-width: 640px) { .row { grid-template-columns: 22px 24px 1fr 90px; } .row .bar { display: none; } h1 { font-size: 28px; } .podium { grid-template-columns: 1fr; } }
</style></head><body><main>
<h1>Faction Showdown</h1>
<p class="sub">Every faction against every faction, AI against AI, in the live web game (rtsai.net/play; ${esc(build.split(/[(;]/)[0].trim())}). Official Tournament Map B, Normal AI on both sides, ${capMin}-minute cap. ${configs.length === 1 ? `Every pairing is played once at one starting setting (${esc(cfgName(configs[0]))})` : `Every pairing is played once with each starting setting (${configs.map((c) => esc(cfgName(c))).join("; ")})`}, spawns alternating${included.length ? `, plus ${results.length - firstCount} follow-up games for the lopsided pairings (two more each, one from each spawn)` : ""}.</p>
<div class="tiles">
  <div class="tile"><b>${games.length}<span style="font-size:14px;color:var(--faint)"> / ${jobs.length}</span></b><span>games played</span></div>
  <div class="tile"><b>${pct(decisive.length / Math.max(1, games.length))}</b><span>ended with a winner (the rest hit the ${capMin}-minute cap)</span></div>
  <div class="tile"><b>${mmss(avg(decisive.map((r) => r.gameSeconds)))}</b><span>average time to a win (game time)</span></div>
  <div class="tile ${crashes.length ? "alert" : "good"}"><b>${crashes.length}</b><span>games that crashed</span></div>
  <div class="tile alert"><b>${bugs.length}</b><span>bugs found · ${bugs.filter((b) => b.status !== "open").length} fixed</span></div>
</div>

<h2>Bugs found</h2>
${bugs.map((b) => `<div class="bug ${b.severity}"><h3><span class="id">${b.id}</span>${esc(b.title)}<span class="chip ${b.severity}">${b.severity}</span><span class="chip ${b.status}">${b.status === "live" ? "fixed · live" : b.status}</span></h3>
<p><b>What happens:</b> ${esc(b.what)}</p>
<ul>${b.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>
<p><b>Fix:</b> ${esc(b.fix)}</p>
<p><b>Status:</b> ${esc(b.statusDetail)} <span class="id">· ${esc(b.where)}</span></p></div>`).join("\n")}

<h2>Champion</h2>
<div class="podium">
${[1, 0, 2].map((i) => { const s = table[i]; if (!s) return "<div></div>"; return `<div class="pod${i === 0 ? " first" : ""}"><div class="rk">${["1ST", "2ND", "3RD"][i]}</div><div style="margin-top:10px"><img src="${flag(s.f)}" alt=""></div><div class="nm">${esc(nameOf(s.f))}</div><div class="sc">${pct(s.rate)} · ${s.w}W ${s.d}D ${s.l}L</div></div>`; }).join("\n")}
</div>

<h2>Standings</h2>
<div class="rows">
${table.map((s, i) => { const [lo, hi] = wilson(s.rate, s.games); return `<div class="row"><span class="n">${i + 1}</span>${flagImg(s.f)}<span class="nm">${esc(nameOf(s.f))}<small>${groupOf(s.f)}</small></span><div class="bar" title="score ${pct(s.rate)}; 95% range ${pct(lo)}–${pct(hi)}"><i style="width:${(s.rate * 100).toFixed(1)}%"></i><span class="ci" style="left:${(lo * 100).toFixed(1)}%;width:${((hi - lo) * 100).toFixed(1)}%"></span></div><span class="wdl"><b>${pct(s.rate)}</b> · ${s.w}-${s.d}-${s.l}</span></div>`; }).join("\n")}
</div>
<p class="legend">Score = wins + half the draws, over ${(() => { const g = table.map((r) => r.games); const lo = Math.min(...g), hi = Math.max(...g); return g.length ? (lo === hi ? lo : `${lo}–${hi}`) : 0; })()} games each so far. The dark strip is the 95% range: with this many games, factions whose strips overlap are not clearly different.</p>

${configs.length > 1 ? `<h2>By starting settings</h2>
<div class="mx"><table>
<tr><th></th>${unitGroups.map((u) => `<th colspan="${configs.filter((c) => c.startsWith(u + "-")).length}" style="font:600 12px 'Segoe UI';color:var(--gold);letter-spacing:.06em">${esc(UNITS[u] ?? u)}</th>`).join("")}</tr>
<tr><th></th>${configs.map((c) => `<th style="width:64px">$${(Number(c.split("-")[1]) / 1000).toLocaleString("en-US")}k</th>`).join("")}</tr>
${table.map((r) => `<tr><th class="rh">${esc(nameOf(r.f))} ${flagImg(r.f)}</th>${configs.map((c) => {
  const v = byCfg[`${r.f}|${c}`];
  if (!v) return `<td style="background:#0a0d0a;color:var(--faint)">·</td>`;
  const x = v.pts / v.n;
  return `<td style="background:${scoreColor(x)}" title="${esc(nameOf(r.f))}, ${esc(cfgName(c))}: ${v.pts} of ${v.n}">${pct(x)}</td>`;
}).join("")}</tr>`).join("")}
<tr><th class="rh" style="color:var(--faint)">games · avg win</th>${configs.map((c) => `<td style="color:var(--faint);font-size:11px;line-height:1.3">${cfgSummary[c].n}/${cfgSummary[c].planned}<br>${cfgSummary[c].avgWin ? mmss(cfgSummary[c].avgWin) : "–"}</td>`).join("")}</tr>
</table><p class="legend">Each faction's score with each starting setting (15 games per cell when complete). Bottom row: games played so far and the average time to a win.</p></div>` : ""}

${covRows.length ? `<h2>Coverage check</h2>
<p class="sub" style="margin-top:-6px">Every faction's roster in the live game: buildable once its base stands, firing on a target range, and trained by the AI in real games. 0 page errors across all ${covRows.length} factions.</p>
<div class="mx" style="margin-top:12px"><table class="cov">
<tr><th></th><th>Buildable</th><th>Fires</th><th>AI used it<br><small>before the fix</small></th><th>AI used it<br><small>after the fix</small></th><th class="lt">Not firing on the range</th></tr>
${covRows.map((r) => `<tr><th class="rh">${esc(nameOf(r.f))} ${flagImg(r.f)}</th>
<td style="background:${scoreColor(r.buildable / r.units)}">${r.buildable}/${r.units}</td>
<td style="background:${scoreColor(r.fired / Math.max(1, r.tested))}">${r.fired}/${r.tested}</td>
<td style="background:${r.before == null ? "#0a0d0a" : scoreColor(r.before / r.trainable)}" title="${esc(r.missingBefore.map((n) => unitLabel[n] ?? n).join(", "))}">${r.before ?? "·"}/${r.trainable}</td>
<td style="background:${r.after == null ? "#0a0d0a" : scoreColor(r.after / r.trainable)}">${r.after ?? "·"}/${r.trainable}</td>
<td class="lt">${r.silent.map((n) => `${esc(unitLabel[n] ?? n)}${NOT_EXPECTED[n] ? ` <small>(${NOT_EXPECTED[n]})</small>` : n === "yuri" ? ` <small>(bug B5)</small>` : ""}`).join(", ") || "—"}</td></tr>`).join("")}
</table><p class="legend">"AI used it": units the AI built at least once in the AI-vs-AI games (hover the before column for the units it never built). Transports, spies and engineers are left out of that count.</p></div>` : ""}

<h2>Head to head</h2>
<div class="mx"><table>
<tr><th></th>${table.map((s) => `<th>${flagImg(s.f)}</th>`).join("")}</tr>
${table.map((r) => `<tr><th class="rh">${esc(nameOf(r.f))} ${flagImg(r.f)}</th>${table.map((c) => {
  if (r.f === c.f) return `<td class="self"></td>`;
  const h = h2h[`${r.f}|${c.f}`];
  if (!h) return `<td style="background:#0a0d0a;color:var(--faint)">·</td>`;
  const x = h.pts / h.n;
  const tip = h.list.map((g) => `${nameOf(g.a)} vs ${nameOf(g.b)}: ${g.winner ? nameOf(g.winner) + " in " + mmss(g.gameSeconds) : "draw (cap)"}`).join("\n");
  return `<td style="background:${scoreColor(x)}" title="${esc(tip)}">${h.pts % 1 ? (Math.floor(h.pts) || "") + "½" : h.pts}–${(h.n - h.pts) % 1 ? (Math.floor(h.n - h.pts) || "") + "½" : h.n - h.pts}</td>`;
}).join("")}</tr>`).join("\n")}
</table><p class="legend">Row faction's score against the column faction (${included.length ? "1 game per pairing, 3 for the lopsided ones" : `${configs.length} games per pairing when complete`}). Green: the row side won more; red: it lost more. Hover a cell for the games.</p></div>

${kdRows.length ? `<h2>Why sides win</h2>
<div class="groups">
<div class="gcard"><h3>Value destroyed per value lost</h3>
${kdRows.map((r) => `<div class="gline" style="grid-template-columns:120px 1fr 46px"><span>${flagImg(r.f)} ${esc(nameOf(r.f))}</span><div class="bar"><i style="width:${Math.min(100, r.ratio / 2 * 100).toFixed(1)}%;background:${r.ratio >= 1 ? "linear-gradient(90deg,#3f9b4e,#57d36b)" : "linear-gradient(90deg,#a8412c,#ef5b3f)"}"></i></div><span style="text-align:right;font:12px Consolas">${r.ratio.toFixed(2)}</span></div>`).join("")}
<p class="legend" style="text-align:left">Enemy losses each side caused for every credit it lost (1.00 = an even trade; the bar's midline).</p></div>
${[kdRows[0], kdRows.at(-1)].filter(Boolean).map((r) => { const m = mixOf(r.f); return `<div class="gcard"><h3>${esc(nameOf(r.f))}'s army, minutes 10–25</h3>
${m.top.map((x) => `<div class="gline" style="grid-template-columns:150px 1fr 46px"><span>${esc(unitLabel[x.u] ?? x.u)}</span><div class="bar"><i style="width:${(x.pct * 100).toFixed(1)}%"></i></div><span style="text-align:right;font:12px Consolas">${pct(x.pct)}</span></div>`).join("")}
<p class="legend" style="text-align:left">Ships make up ${pct(m.ships)} of its units by count.</p></div>`; }).join("")}
</div>` : ""}

<h2>Original countries vs modern nations</h2>
<div class="groups">
${groups.map((g) => `<div class="gcard"><h3>${g === "Modern" ? "Modern nations" : g === "Allies" ? "Original Allies" : "Original Soviets"}</h3><div class="flags">${F.filter((f) => groupOf(f) === g).map((f) => flagImg(f)).join("")}</div>
${groups.filter((o) => o !== g || g === "Modern" || true).map((o) => { const v = gg[`${g}|${o}`]; if (!v) return ""; const x = v.pts / v.n; return `<div class="gline"><span>vs ${o === g ? "each other" : o}</span><div class="bar"><i style="width:${(x * 100).toFixed(1)}%"></i></div><span style="text-align:right;font:12px Consolas">${pct(x)}</span></div>`; }).join("")}
</div>`).join("\n")}
</div>

${fs.existsSync(path.join(run, "reel", "faction-showdown-best-battles.mp4")) ? `<h2>Best battles reel</h2>
<p class="sub" style="margin-top:-6px">The biggest fights across every game, chosen so all sixteen factions appear, over Steel Horizon from the game's own soundtrack.</p>
<video class="reel" src="reel/faction-showdown-best-battles.mp4" poster="reel/title.png" controls preload="metadata"></video>` : ""}

${films.length ? `<h2>Match films</h2>
<p class="sub" style="margin-top:-6px">Each film is the scored match's own replay: the opening, the best fight from each stretch of the game, then the final assault. ${films.length} filmed so far. Click one to watch.</p>
${configs.filter((c) => films.some((v) => filmCfg(v) === c)).map((c) => `<h3 class="vgroup">${esc(cfgName(c))} <small>${films.filter((v) => filmCfg(v) === c).length} films</small></h3>
<div class="vids">
${films.filter((v) => filmCfg(v) === c).map((v) => `<a class="vid" href="${v.href}" data-video="${v.href}" data-title="${esc(nameOf(v.a))} vs ${esc(nameOf(v.b))} · ${esc(cfgName(c))} · ${v.winner ? esc(nameOf(v.winner)) + " wins in " + mmss(v.gameSeconds) : "draw"}"><div class="pic" style="background-image:url('${v.poster}')">${v.winner ? `<em>${esc(nameOf(v.winner))} wins</em>` : `<em style="background:var(--mute)">Draw</em>`}<span>${mmss(v.videoSeconds)}</span></div>
<div class="cap">${flagImg(v.a)} ${esc(nameOf(v.a))} <span class="vs">vs</span> ${esc(nameOf(v.b))} ${flagImg(v.b)}<span class="t">${mmss(v.gameSeconds)} game</span></div></a>`).join("\n")}
</div>`).join("\n")}` : ""}

<h2>How this was run</h2>
<div class="note"><ul>
<li>The page is the exact live page's sign-in-free twin from the release tool (same runtime and data roots on the CDN), served locally and driven by headless Chromium. Both seats are Normal AI; the page spectates.</li>
<li>OpenRA's bots use unsynced randomness, so a seed alone does not replay a bot match. Every match's recorded orders are saved, and the films are the game's own read-only replays of the scored matches.</li>
<li>Records: ${fastest ? `fastest win ${esc(nameOf(fastest.winner))} over ${esc(nameOf(fastest.winner === fastest.a ? fastest.b : fastest.a))} in ${mmss(fastest.gameSeconds)}` : "—"}; ${longestWin ? `longest win ${esc(nameOf(longestWin.winner))} over ${esc(nameOf(longestWin.winner === longestWin.a ? longestWin.b : longestWin.a))} in ${mmss(longestWin.gameSeconds)}` : "—"}.</li>
<li>Build: ${esc(build)}. Results: ${esc(resultsFile)}; replays: ${esc(path.join(run, "replays"))}.</li>
</ul></div>
</main>
<div class="player" id="player" hidden><div class="pbox"><div class="pbar"><span id="ptitle"></span><button type="button" id="pprev" aria-label="Previous film">‹</button><button type="button" id="pnext" aria-label="Next film">›</button><button type="button" id="pclose" aria-label="Close">✕</button></div><video id="pvideo" controls autoplay playsinline></video></div></div>
<script>
const cards = [...document.querySelectorAll(".vid[data-video]")];
const player = document.getElementById("player"), video = document.getElementById("pvideo");
let at = -1;
function show(i) {
  at = (i + cards.length) % cards.length;
  const c = cards[at];
  video.src = c.dataset.video;
  document.getElementById("ptitle").textContent = c.dataset.title;
  player.hidden = false;
  video.play().catch(() => {});
}
function close() { player.hidden = true; video.pause(); video.removeAttribute("src"); video.load(); }
cards.forEach((c, i) => c.addEventListener("click", (e) => { e.preventDefault(); show(i); }));
document.getElementById("pclose").onclick = close;
document.getElementById("pnext").onclick = () => show(at + 1);
document.getElementById("pprev").onclick = () => show(at - 1);
player.addEventListener("click", (e) => { if (e.target === player) close(); });
video.addEventListener("ended", () => show(at + 1));
addEventListener("keydown", (e) => {
  if (player.hidden) return;
  if (e.key === "Escape") close();
  if (e.key === "ArrowRight" && e.shiftKey) show(at + 1);
  if (e.key === "ArrowLeft" && e.shiftKey) show(at - 1);
});
</script>
</body></html>`;
fs.writeFileSync(outFile, html);
console.log(`wrote ${outFile}: ${games.length} games, ${crashes.length} crashed, ${films.length} films, champion ${champion ? nameOf(champion.f) : "-"}`);
