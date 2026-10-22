// One best-battles reel from a run: the biggest fights across every scored game (by value destroyed, from each
// game's stats timeline), chosen so every faction appears, each filmed from its replay (tools/film.mjs --mode clip),
// between a title card and a standings card, over a track from the game's own soundtrack.
//   node tools/reel.mjs --run runs/units-and-money [--window 24] [--speed 2] [--max 12]
// Writes <run>/reel/faction-showdown-best-battles.mp4 (1920x1080, 30 fps) and reel.json (the clips and why).
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "file:///C:/Users/Admin/Code/hq/games/RTSAI-WebGame/web/node_modules/playwright-core/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const run = path.resolve(root, opt("run", "runs/units-and-money"));
const W = Number(opt("window", 24)); // game seconds per clip
const speed = opt("speed", "2");
const max = Number(opt("max", 12));
const out = path.join(run, "reel");
fs.mkdirSync(out, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const setup = JSON.parse(fs.readFileSync(path.join(root, "setup.json"), "utf8")).setup;
const nameOf = (f) => setup.factions.find((x) => x.id === f)?.name ?? f;
const UNITS = { none: "No starting units", heavy: "Heavy starting units", medium: "Medium starting units" };

// Every scored game with a replay, and its biggest fight: the W-second window that destroyed the most value.
const results = fs.readFileSync(path.join(run, "results.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r && r.replay && fs.existsSync(r.replay) && r.timeline?.length > 3 && !(r.errors ?? []).some((e) => e.kind === "phase"));
const candidates = results.map((r) => {
  const tl = r.timeline, lost = (e) => e.p[0][2] + e.p[1][2];
  let best = { value: 0, at: 0 };
  for (let i = 0; i < tl.length; i++) {
    let j = i; while (j + 1 < tl.length && tl[j + 1].tick <= tl[i].tick + W * 25) j++;
    const value = lost(tl[j]) - lost(tl[i]);
    if (value > best.value) best = { value, at: Math.round(tl[i].tick / 25) };
  }
  return { r, ...best };
}).filter((c) => c.value > 0).sort((p, q) => q.value - p.value);

// Every faction at least once (each pick covering the most factions not yet shown, the bigger fight first), then
// the biggest remaining fights, up to max; shown in the order they were picked from biggest to smallest.
const picks = [], shown = new Set();
while (shown.size < 16) {
  const next = candidates.filter((c) => !picks.includes(c)).map((c) => ({ c, fresh: [c.r.a, c.r.b].filter((f) => !shown.has(f)).length }))
    .filter((x) => x.fresh > 0).sort((p, q) => q.fresh - p.fresh || q.c.value - p.c.value)[0];
  if (!next) break;
  picks.push(next.c); shown.add(next.c.r.a); shown.add(next.c.r.b);
}
for (const c of candidates) if (picks.length < max && !picks.includes(c)) picks.push(c);
picks.sort((p, q) => p.value - q.value); // build up to the biggest fight
log(`${results.length} games, ${picks.length} clips covering ${shown.size} factions`);

// The clips.
const clips = [];
for (const [k, c] of picks.entries()) {
  const name = `clip-${String(k + 1).padStart(2, "0")}`;
  const file = path.join(out, `${name}.mp4`);
  if (!fs.existsSync(file)) {
    const label = `Best battles · ${k + 1}/${picks.length}`, sub = `${UNITS[c.r.units] ?? c.r.units} · $${Number(c.r.cash).toLocaleString("en-US")}`;
    const p = spawnSync(process.execPath, [path.join(here, "film.mjs"), "--mode", "clip", "--replay", c.r.replay, "--result", path.join(run, "results.jsonl"),
      "--out", out, "--name", name, "--at", String(Math.max(0, c.at - 2)), "--window", String(W), "--battle-speed", speed, "--label", label, "--sub", sub, "--crf", "22", ...(opt("url") ? ["--url", opt("url")] : []), ...(opt("bundle") ? ["--bundle", path.resolve(opt("bundle"))] : [])],
      { encoding: "utf8", maxBuffer: 1 << 26 });
    if (!fs.existsSync(file)) { log(`clip ${k + 1} failed: ${p.stderr?.slice(-400)}`); continue; }
  }
  clips.push({ file, a: c.r.a, b: c.r.b, at: c.at, value: c.value, winner: c.r.winner, units: c.r.units, cash: c.r.cash, seed: c.r.seed });
  log(`clip ${k + 1}: ${nameOf(c.r.a)} vs ${nameOf(c.r.b)} at ${Math.floor(c.at / 60)}:${String(c.at % 60).padStart(2, "0")}, $${c.value.toLocaleString("en-US")} destroyed`);
}

// Standings for the closing card: score rate over this run's finished games.
const score = {};
for (const r of results) for (const f of [r.a, r.b]) { const s = (score[f] ??= { p: 0, n: 0 }); s.n++; s.p += !r.winner ? 0.5 : r.winner === f ? 1 : 0; }
const table = Object.entries(score).map(([f, s]) => ({ f, rate: s.p / s.n, n: s.n })).sort((p, q) => q.rate - p.rate);

// Title and closing cards, drawn as pages and held for a few seconds.
const flag = (f) => f === "hezbollah"
  ? `<span class="mono">HZB</span>` // never the Hezbollah flag in a video (owner rule)
  : `<img src="data:image/svg+xml;base64,${fs.readFileSync(path.join(root, "page", "flags", `${f}.svg`)).toString("base64")}">`;
const css = `body{margin:0;width:1920px;height:1080px;background:radial-gradient(1400px 800px at 50% 30%,#1d251a,#090b09);color:#eeeadd;font-family:"Segoe UI",sans-serif;display:grid;place-items:center}
  h1{font-size:120px;letter-spacing:.14em;color:#f1d28b;margin:0;text-transform:uppercase;font-weight:800}
  p{font-size:34px;color:#a2a695;letter-spacing:.06em;margin:18px 0 0}
  .flags{display:grid;grid-template-columns:repeat(8,120px);gap:22px;margin-top:70px;justify-content:center}
  img,.mono{width:120px;height:80px;object-fit:cover;border-radius:6px;box-shadow:0 0 0 2px #0009}
  .mono{display:grid;place-items:center;background:#7fae3a;color:#0d100d;font-weight:800;font-size:28px}
  .row{display:grid;grid-template-columns:70px 130px 1fr 160px;align-items:center;gap:24px;font-size:44px;margin:14px 0;width:1100px}
  .row b{color:#f1d28b;font-family:Consolas,monospace} .row span:last-child{text-align:right;font-family:Consolas,monospace;color:#eeeadd}`;
const pages = {
  title: `<div style="text-align:center"><h1>Faction Showdown</h1><p>16 nations · AI against AI · the biggest battles</p><div class="flags">${setup.factions.filter((f) => !f.random).map((f) => flag(f.id)).join("")}</div></div>`,
  standings: `<div><h1 style="font-size:72px;text-align:center;margin-bottom:40px">Top of the table</h1>${table.slice(0, 5).map((t, i) => `<div class="row"><b>${i + 1}</b>${flag(t.f)}<span>${nameOf(t.f)}</span><span>${Math.round(t.rate * 100)}%</span></div>`).join("")}
    <p style="text-align:center;margin-top:44px">${results.length} AI-vs-AI games so far · rtsai.net/play</p></div>`,
};
const exe = process.env.LOCALAPPDATA + "/ms-playwright/chromium-1228/chrome-win64/chrome.exe";
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const cards = {};
for (const [k, html] of Object.entries(pages)) {
  await page.setContent(`<!doctype html><style>${css}</style>${html}`);
  await page.waitForTimeout(300);
  const png = path.join(out, `${k}.png`);
  await page.screenshot({ path: png });
  cards[k] = path.join(out, `${k}.mp4`);
  execFileSync("ffmpeg", ["-y", "-v", "error", "-loop", "1", "-t", "4", "-i", png, "-vf", "fade=in:0:15,fade=out:105:15,format=yuv420p", "-r", "30",
    "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", cards[k]]);
}
await browser.close();

// Join: title, clips, standings; each clip fades in and out; the soundtrack under all of it, faded at the end.
const parts = [cards.title, ...clips.map((c) => c.file), cards.standings];
const faded = [];
for (const [i, f] of parts.entries()) {
  const d = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString());
  const g = path.join(out, `part-${String(i).padStart(2, "0")}.mp4`);
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", f, "-vf", `fade=in:st=0:d=0.4,fade=out:st=${Math.max(0, d - 0.4).toFixed(2)}:d=0.4,format=yuv420p`, "-an", "-r", "30",
    "-c:v", "libx264", "-crf", "22", "-preset", "medium", "-pix_fmt", "yuv420p", g]);
  faded.push(g);
}
fs.writeFileSync(path.join(out, "parts.txt"), faded.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n"));
const silent = path.join(out, "silent.mp4");
execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", path.join(out, "parts.txt"), "-c", "copy", silent]);
const total = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", silent]).toString());
// The track from the current data root, checked: the CDN answers a missing path with a small HTML page and HTTP 200.
const track = path.join(out, "steel-horizon.ogg");
const isOgg = (f) => fs.existsSync(f) && fs.statSync(f).size > 100000 && fs.readFileSync(f).subarray(0, 4).toString() === "OggS";
if (!isOgg(track)) {
  const res = await fetch("https://rtsai-play-cdn.pages.dev/data-b9e0c656e8e4/public/audio/standalone/audio/music/rtsai-steel-horizon.ogg");
  fs.writeFileSync(track, Buffer.from(await res.arrayBuffer()));
  if (!isOgg(track)) throw new Error(`the soundtrack download is not an Ogg file (${fs.statSync(track).size} bytes)`);
}
const final = path.join(out, "faction-showdown-best-battles.mp4");
execFileSync("ffmpeg", ["-y", "-v", "error", "-i", silent, "-stream_loop", "-1", "-i", track, "-map", "0:v", "-map", "1:a", "-c:v", "copy",
  "-af", `afade=in:st=0:d=1.5,afade=out:st=${Math.max(0, total - 3).toFixed(2)}:d=3,volume=0.85`, "-c:a", "aac", "-b:a", "160k", "-t", total.toFixed(2), "-movflags", "+faststart", final]);
fs.writeFileSync(path.join(out, "reel.json"), JSON.stringify({ video: final, seconds: +total.toFixed(1), music: "Steel Horizon (RTS AI soundtrack, project-made: no third-party rights)", clips }, null, 1));
log(`reel: ${final} (${total.toFixed(0)} s, ${(fs.statSync(final).size / 1048576).toFixed(1)} MB)`);
