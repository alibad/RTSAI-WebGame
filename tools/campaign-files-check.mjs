// Every file the campaign screen and the in-match radio ask the campaign folder for (VITE_CAMPAIGN_BASE): the
// briefings index and its entry per chapter, each chapter's film, captions and poster, each radio call's voice, each
// cast portrait, and the films around the acts. A chapter missing from the index falls back silently to the old film
// bundled with the page, and a missing voice leaves a caption with no sound, so nothing else notices: on 14 November
// 2026 the seventh faction's chapter was renamed in the story and the page, its folder was not, and the live game lost
// that chapter's film and voices.
//   node tools/campaign-files-check.mjs                      the live folder named in tools/release-play.json
//   node tools/campaign-files-check.mjs --base <url>         another published folder
//   node tools/campaign-files-check.mjs --dir <folder>       a local folder, before it is published
//   [--story ../RTSAI-Mod/resources/campaign-story.json] [--json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const story = JSON.parse(fs.readFileSync(path.resolve(repo, opt("story", "../RTSAI-Mod/resources/campaign-story.json")), "utf8"));
const missions = JSON.parse(fs.readFileSync(path.join(repo, "content", "missions.json"), "utf8")).map((m) => m.id);
const dir = opt("dir", "");
const base = (opt("base", JSON.parse(fs.readFileSync(path.join(repo, "tools", "release-play.json"), "utf8")).page.VITE_CAMPAIGN_BASE) ?? "").replace(/\/?$/, "/");
const where = dir ? path.resolve(dir) : base;

/** Whether the folder has the file (a published folder answers a missing path with an HTML page, some with 200). */
async function has(file) {
  if (dir) return fs.existsSync(path.join(dir, file)) && fs.statSync(path.join(dir, file)).size > 0;
  const r = await fetch(base + file, { method: "HEAD" });
  return r.ok && !(String(r.headers.get("content-type")).startsWith("text/html"));
}
async function index() {
  if (dir) return JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
  const r = await fetch(`${base}index.json`);
  if (!r.ok) throw new Error(`${base}index.json: HTTP ${r.status}`);
  return r.json();
}

const listed = new Set(((await index()).briefings ?? []).map((b) => b.mission));
const chapters = story.arcs.flatMap((a) => a.missions).filter((id) => story.chapters[id]?.status !== "coming" && missions.includes(id));
const parts = [story.prologue?.id, story.epilogue?.id].filter(Boolean);
const wanted = []; // { file, why }
const missing = [];
for (const id of [...parts, ...chapters]) {
  if (!listed.has(id)) missing.push({ file: `index.json: no entry "${id}"`, why: parts.includes(id) ? `the ${id} film's card is not shown` : `${id} plays the old bundled film, or none` });
  for (const f of ["briefing.mp4", "briefing.vtt", "poster.webp"]) wanted.push({ file: `${id}/${f}`, why: `${id}: its film` });
}
for (const id of chapters) for (const [n, call] of (story.radio?.[id] ?? []).entries()) {
  if (!call.audio) missing.push({ file: `${id}: radio call ${n + 1} has no audio in the story`, why: "a caption with no voice" });
  else wanted.push({ file: call.audio, why: `${id}: radio call ${n + 1} (${call.speaker}) has no voice` });
}
const speakers = new Set([...chapters.map((id) => story.chapters[id].speaker), ...chapters.flatMap((id) => (story.radio?.[id] ?? []).map((c) => c.speaker))].filter(Boolean));
for (const who of speakers) wanted.push({ file: story.cast?.[who]?.portrait ?? `cast/${who}.webp`, why: `${who}: initials in place of the portrait` });
// Entries the story no longer names: a renamed chapter leaves its old folder behind under its old name.
const stale = [...listed].filter((id) => !parts.includes(id) && !story.chapters[id]);

const results = await Promise.all(wanted.map(async (w) => ({ ...w, ok: await has(w.file).catch(() => false) })));
for (const r of results) if (!r.ok) missing.push({ file: r.file, why: r.why });
const report = { where, chapters: chapters.length, films: parts.length + chapters.length, files: wanted.length, missing, stale };
if (argv.includes("--json")) console.log(JSON.stringify(report, null, 1));
else {
  console.log(`Campaign files in ${where}: ${chapters.length} chapters, ${parts.length} films around the acts, ${wanted.length} files asked for.`);
  for (const m of missing) console.log(`  MISSING  ${m.file}  (${m.why})`);
  for (const id of stale) console.log(`  STALE    index.json lists "${id}", which the story does not name`);
  console.log(missing.length ? `${missing.length} missing.` : "Nothing missing.");
}
process.exit(missing.length ? 1 : 0);
