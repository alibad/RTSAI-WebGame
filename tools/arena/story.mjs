// A notebook entry as one short film, for the admin's AI Arena page and the owner's talks: a title card with the
// question, the change, each of the entry's game films (each introduced by its caption), a results card (wins,
// draws and losses of every brain version it compares, counted from the games now) and the lesson.
//   node tools/arena/story.mjs <entry id> [--dir <arena data>] [--clip <seconds per game film>]
// Writes <arena data>/films/story-<entry id>.mp4 and a .jpg poster. Cards are HTML rendered by headless Chromium;
// ffmpeg cuts and joins. Game films come from tools/arena/film.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readNotebook } from "./notebook.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const dir = opt("dir", path.join(process.env.LOCALAPPDATA ?? os.homedir(), "RTSAI-WebGame", "arena"));
const clipSeconds = Number(opt("clip", 24));
const entry = readNotebook(dir).find((e) => e.id === argv[0]);
if (!entry) throw new Error(`no notebook entry ${argv[0]}`);
const films = path.join(dir, "films");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arena-story-"));
const W = 1280, H = 720, FPS = 30;
const ENCODE = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(FPS), "-an"];
const ff = (...args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args]);
const duration = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim());
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const CSS = `*{box-sizing:border-box;margin:0}body{width:${W}px;height:${H}px;background:#0e1116;color:#f3f1ea;font-family:"Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;
  display:flex;flex-direction:column;justify-content:center;padding:0 96px;overflow:hidden}
  .k{font-size:18px;letter-spacing:.14em;text-transform:uppercase;color:#e7c46b;font-weight:600;margin-bottom:22px}
  h1{font-size:58px;line-height:1.08;font-weight:600;max-width:1050px}h2{font-size:40px;font-weight:600;margin-bottom:26px}
  p{font-size:27px;line-height:1.45;color:#c9c6bc;max-width:1050px;margin-top:22px}.big{font-size:32px;color:#f3f1ea}
  .rule{width:64px;height:4px;background:#e7c46b;border-radius:2px;margin:28px 0 0}
  table{border-collapse:separate;border-spacing:0 10px;font-size:22px;margin-top:6px}th{color:#8f8c84;font-weight:500;text-align:left;padding:0 18px 4px 0;font-size:18px}
  td{padding:0 18px 0 0;vertical-align:middle}td.v{font-size:23px;color:#f3f1ea;width:300px}.cell{width:170px}.bar{display:flex;height:12px;border-radius:3px;overflow:hidden;gap:2px;margin-top:6px;width:150px}
  .w{background:#3fb950}.d{background:#8b8a83}.l{background:#f85149}.n{color:#c9c6bc;font-size:19px}.none{color:#55524c;font-size:19px}
  .legend{display:flex;gap:22px;font-size:17px;color:#8f8c84;margin-top:18px}.legend span{display:flex;align-items:center;gap:7px}.legend i{width:12px;height:12px;border-radius:2px;display:inline-block}`;
const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${body}</body></html>`;
const kicker = `AI Arena · ${entry.kind === "experiment" ? "Experiment" : "Milestone"} · ${new Date(entry.date).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`;
const OPPONENTS = ["normal", "rush", "hard", "brutal"].filter((o) => entry.results.some((r) => r.byOpponent[o]));
const cell = (c) => {
  if (!c) return `<td class="cell"><span class="none">not played</span></td>`;
  const n = c.win + c.draw + c.loss;
  const parts = [c.win && `${c.win} W`, c.draw && `${c.draw} D`, c.loss && `${c.loss} L`].filter(Boolean).join(" · ");
  return `<td class="cell"><span class="n">${parts}</span><div class="bar">${c.win ? `<span class="w" style="flex:${c.win}"></span>` : ""}${c.draw ? `<span class="d" style="flex:${c.draw}"></span>` : ""}${c.loss ? `<span class="l" style="flex:${c.loss}"></span>` : ""}</div></td>`;
};
const cards = {
  title: page(`<div class="k">${esc(kicker)}</div><h1>${esc(entry.title)}</h1><div class="rule"></div><p>${esc(entry.question)}</p>`),
  change: page(`<div class="k">The change</div><p class="big">${esc(entry.change)}</p>`),
  results: page(`<div class="k">Results · scripted brain, same seeds</div><table><tr><th></th>${OPPONENTS.map((o) => `<th>vs ${o[0].toUpperCase()}${o.slice(1)}</th>`).join("")}</tr>
    ${entry.results.map((r) => `<tr><td class="v">${esc(r.label)}</td>${OPPONENTS.map((o) => cell(r.byOpponent[o])).join("")}</tr>`).join("")}</table>
    <div class="legend"><span><i class="w"></i>win</span><span><i class="d"></i>draw (40 minutes)</span><span><i class="l"></i>loss</span></div>
    ${entry.finding ? `<p style="font-size:22px">${esc(entry.finding)}</p>` : ""}`),
  lesson: page(`<div class="k">What we learned</div><h2>${esc(entry.lesson || "Still running.")}</h2>${entry.tip ? `<p><span style="color:#e7c46b">Tip:</span> ${esc(entry.tip)}</p>` : ""}`),
};

/**
 * Free-form slides, for entries that explain how something works (an entry's `slides`): a kicker, a title, a body,
 * and an optional diagram: "loop" (boxes in a row that feed back to the first), "path" (boxes in a row with a branch
 * under one of them), or "bars" (labelled bars with a value each).
 */
function box(x, y, w, h, title, sub, accent) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${accent ? "#2a2617" : "#171c22"}" stroke="${accent ? "#e7c46b" : "#3a4350"}" stroke-width="2"/>
    <text x="${x + w / 2}" y="${y + h / 2 - (sub ? 8 : -8)}" text-anchor="middle" font-size="24" font-weight="600" fill="#f3f1ea">${esc(title)}</text>
    ${sub ? `<text x="${x + w / 2}" y="${y + h / 2 + 24}" text-anchor="middle" font-size="17" fill="#a9a59b">${esc(sub)}</text>` : ""}`;
}
const arrow = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#e7c46b" stroke-width="3" marker-end="url(#a)"/>`;
const DEFS = `<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#e7c46b"/></marker></defs>`;
function diagram(s) {
  if (s.diagram === "loop" || s.diagram === "path") {
    const n = s.boxes.length, w = 230, gap = (1088 - n * w) / (n - 1), y = 40, h = 120;
    let svg = s.boxes.map((b, i) => box(i * (w + gap), y, w, h, b.title, b.sub, b.accent)).join("");
    for (let i = 0; i < n - 1; i++) svg += arrow(i * (w + gap) + w + 6, y + h / 2, (i + 1) * (w + gap) - 8, y + h / 2);
    if (s.diagram === "loop") svg += `<path d="M ${(n - 1) * (w + gap) + w / 2} ${y + h + 6} V ${y + h + 60} H ${w / 2} V ${y + h + 10}" fill="none" stroke="#e7c46b" stroke-width="3" stroke-dasharray="8 7" marker-end="url(#a)"/>
      <text x="544" y="${y + h + 88}" text-anchor="middle" font-size="18" fill="#a9a59b">${esc(s.loopLabel ?? "")}</text>`;
    if (s.diagram === "path" && s.branch) {
      const i = s.branch.under, bx = i * (w + gap), by = y + h + 70;
      svg += arrow(bx + w / 2, y + h + 6, bx + w / 2, by - 8) + box(bx - 40, by, w + 80, h, s.branch.title, s.branch.sub, false);
      if (s.branch.to !== undefined) svg += `<path d="M ${bx + w + 46} ${by + h / 2} H ${s.branch.to * (w + gap) + w / 2} V ${y + h + 10}" fill="none" stroke="#e7c46b" stroke-width="3" marker-end="url(#a)"/>`;
    }
    return `<svg width="1088" height="${s.diagram === "loop" ? 280 : 360}" font-family="Segoe UI Variable Display, Segoe UI, sans-serif">${DEFS}${svg}</svg>`;
  }
  if (s.diagram === "bars") {
    const max = Math.max(...s.bars.map((b) => b.value));
    return `<div style="display:grid;gap:14px;margin-top:10px">${s.bars.map((b) => `<div style="display:grid;grid-template-columns:230px 1fr 230px;gap:18px;align-items:center;font-size:23px">
      <span style="color:${b.accent ? "#e7c46b" : "#f3f1ea"}">${esc(b.label)}</span>
      <span style="height:22px;border-radius:4px;background:#1b2128;overflow:hidden"><i style="display:block;height:100%;width:${(b.value / max) * 100}%;background:${b.accent ? "#e7c46b" : "#6f8fb3"}"></i></span>
      <span style="color:#c9c6bc;font-size:20px">${esc(b.text)}</span></div>`).join("")}</div>`;
  }
  return "";
}
const slideHtml = (s) => page(`<div class="k">${esc(s.kicker ?? "")}</div>${s.title ? `<h2${s.big ? ' style="font-size:52px"' : ""}>${esc(s.title)}</h2>` : ""}${s.diagram ? diagram(s) : ""}${s.body ? `<p>${esc(s.body)}</p>` : ""}`);

const { chromium } = await import(pathToFileURL(path.join(repo, "web", "node_modules", "playwright-core", "index.mjs")).href);
const msPlaywright = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
const chrome = (fs.existsSync(msPlaywright) ? fs.readdirSync(msPlaywright) : []).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
  .map((d) => path.join(msPlaywright, d, "chrome-win64", "chrome.exe")).find((f) => fs.existsSync(f));
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const shot = async (name, html) => {
  const p = await browser.newPage({ viewport: { width: W, height: H } });
  await p.setContent(html);
  const png = path.join(tmp, `${name}.png`);
  await p.screenshot({ path: png });
  await p.close();
  return png;
};

const segments = [], cues = [];
let at = 0;
const cue = (seconds, text) => { if (text) cues.push({ from: at, to: at + seconds, text }); at += seconds; };
/** A still card held for `seconds`, fading in and out; `says` is its caption. */
const card = async (name, html, seconds, says) => {
  const png = await shot(name, html), mp4 = path.join(tmp, `${segments.length}-${name}.mp4`);
  ff("-loop", "1", "-t", String(seconds), "-i", png, "-vf", `scale=${W}:${H},fade=t=in:st=0:d=0.5,fade=t=out:st=${seconds - 0.5}:d=0.5`, ...ENCODE, mp4);
  segments.push(mp4);
  cue(duration(mp4), says);
};
/** A game film, sped up to at most `clipSeconds` (up to 4×; beyond that the film is cut to its `clip` window). */
const clip = (f) => {
  const src = path.join(films, f.file), total = duration(src);
  const [a, b] = f.clip ?? [0, 1];
  const from = total * a, length = total * (b - a);
  const speed = Math.min(4, Math.max(1, length / clipSeconds)), used = Math.min(length, clipSeconds * speed);
  const mp4 = path.join(tmp, `${segments.length}-clip.mp4`);
  ff("-ss", String(from), "-t", String(used), "-i", src, "-vf",
    `setpts=PTS/${speed},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0e1116,fade=t=in:st=0:d=0.4,fade=t=out:st=${used / speed - 0.5}:d=0.5`, ...ENCODE, mp4);
  segments.push(mp4);
  cue(duration(mp4), `${f.caption} (the game, sped up; on screen: what the brain decided and saw)`);
};
const tally = (r) => Object.entries(r.byOpponent).map(([o, c]) => `${o} ${[c.win && `${c.win} won`, c.draw && `${c.draw} drawn`, c.loss && `${c.loss} lost`].filter(Boolean).join(", ")}`).join("; ");

try {
  if (entry.slides) {
    // An explainer: its own slides, game films where a slide names one.
    for (const [i, s] of entry.slides.entries()) {
      if (s.film) { const f = entry.films.find((x) => x.game === s.film && x.ready); if (f) { await card(`watch${i}`, page(`<div class="k">Watch</div><p class="big">${esc(f.caption)}</p>`), 3.5, `Watch: ${f.caption}`); clip(f); } continue; }
      await card(`slide${i}`, slideHtml(s), s.seconds ?? 6, [s.title, s.body, s.say].filter(Boolean).join(". "));
    }
  } else {
  await card("title", cards.title, 5, `${entry.title}. ${entry.question}`);
  await card("change", cards.change, 5.5, `The change: ${entry.change}`);
  for (const [i, f] of entry.films.filter((x) => x.ready).entries()) {
    await card(`watch${i}`, page(`<div class="k">Watch</div><p class="big">${esc(f.caption)}</p>`), 3.5, `Watch: ${f.caption}`);
    clip(f);
  }
  await card("results", cards.results, entry.finding ? 9 : 6, `Results. ${entry.results.map((r) => `${r.label}: ${tally(r) || "no games yet"}`).join(". ")}. ${entry.finding}`);
  await card("lesson", cards.lesson, 6.5, `What we learned: ${entry.lesson} ${entry.tip ? `Tip: ${entry.tip}` : ""}`);
  }
  const vtt = (s) => { const t = new Date(s * 1000).toISOString().slice(11, 23); return t; };
  fs.writeFileSync(path.join(films, `story-${entry.id}.vtt`), `WEBVTT\n\n${cues.map((c) => `${vtt(c.from)} --> ${vtt(c.to)}\n${c.text}`).join("\n\n")}\n`);
  const list = path.join(tmp, "list.txt");
  fs.writeFileSync(list, segments.map((s) => `file '${s.replace(/\\/g, "/")}'`).join("\n"));
  const out = path.join(films, `story-${entry.id}.mp4`);
  ff("-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out);
  ff("-ss", "1.5", "-i", out, "-frames:v", "1", "-q:v", "3", out.replace(/\.mp4$/, ".jpg"));
  console.log(`${out} (${Math.round(duration(out))} s, ${entry.films.filter((x) => x.ready).length} game films)`);
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
