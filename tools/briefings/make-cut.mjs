// Write the edit list cut-film.py follows for a mission: the forge's cinematic shots (from the mission's Montage film
// folder: s01.mp4..., with the recorded narration n01.wav... and the score) around real in-engine footage recorded by
// game-footage.mjs. The shape:
//   opening shot → the real battlefield (the briefing-table line over the establishing glide) → ... → the commander →
//   every objective on the real map, with its card → live battle → the remaining shots → the last shot and the title.
// A mission with no footage yet keeps its cinematic shots only.
//   node tools/briefings/make-cut.mjs <mission> [--footage D:/rtsai-campaign/footage-out] [--montage http://127.0.0.1:8018]
//        [--films C:/Users/Admin/Code/hq/montage/out/reels] [--battle 10] [--zoom 1.25]
//        [--clips <shot id -> mp4 json> --music <score>]   (clips straight from the video queue instead of Montage)
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const mission = argv[0];
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
const spec = JSON.parse(fs.readFileSync(path.join(here, `${mission}.json`), "utf8"));
const footageDir = path.join(opt("footage", "D:/rtsai-campaign/footage-out"), mission);
const reels = opt("films", "C:/Users/Admin/Code/hq/montage/out/reels");
const battleSeconds = Number(opt("battle", 10));
const zoom = Number(opt("zoom", 1.25));

// Parts: either clips made directly by the video queue (--clips <json of shot id -> mp4> and --music <file>; the lines are
// then read by cut-film.py's narrator), or the newest cut Montage film for this mission (its clips, takes and score).
let dir, narration, part, film = { id: "direct clips" };
if (opt("clips")) {
  const clips = JSON.parse(fs.readFileSync(opt("clips"), "utf8"));
  narration = { lines: spec.shots.map((s) => s.line) };
  part = (kind, i) => (kind === "s" ? String(clips[spec.shots[i].id]).replace(/\\/g, "/") : "-missing-");
  dir = path.dirname(opt("music"));
} else {
  const res = await fetch(`${opt("montage", "http://127.0.0.1:8018")}/api/films`);
  const body = await res.json();
  const films = (Array.isArray(body.films ?? body) ? body.films ?? body : Object.values(body.films ?? body))
    .filter((f) => f.source === "rtsai" && f.externalId === mission && f.output && !f.superseded);
  if (!films.length) { console.error(`No cut Montage film for ${mission} yet`); process.exit(1); }
  film = films.sort((a, b) => String(b.id).localeCompare(String(a.id)))[0];
  dir = path.join(reels, path.dirname(film.output));
  narration = JSON.parse(fs.readFileSync(path.join(dir, "narration.json"), "utf8"));
  part = (kind, i) => path.join(dir, `${kind}${String(i + 1).padStart(2, "0")}.${kind === "s" ? "mp4" : "wav"}`).replace(/\\/g, "/");
}

const footage = fs.existsSync(path.join(footageDir, "footage.json")) ? JSON.parse(fs.readFileSync(path.join(footageDir, "footage.json"), "utf8")) : null;
const game = (file) => path.join(footageDir, file).replace(/\\/g, "/");
const objectiveShots = () => {
  if (!footage) return [];
  const seen = new Set();
  // At most four, places before timers: a "survive" objective has nothing to show on the map.
  const shots = footage.segments.filter((s) => s.objective && !seen.has(s.objective.index) && seen.add(s.objective.index));
  const shown = [...shots.filter((s) => s.objective.kind !== "survive"), ...shots.filter((s) => s.objective.kind === "survive")].slice(0, 4)
    .sort((a, b) => a.objective.index - b.objective.index);
  return shown.map((s) => ({
    src: game(s.file), kind: "game", dur: 4.2, zoom: 1.1,
    card: { kicker: s.objective.secondary ? "Bonus objective" : `Objective ${s.objective.index}`, text: s.objective.text },
  }));
};

const segments = [];
spec.shots.forEach((shot, i) => {
  const line = narration.lines[i] ?? shot.line;
  const voice = fs.existsSync(part("n", i)) ? part("n", i) : null;
  const last = i === spec.shots.length - 1;
  if (last && footage) segments.push({ src: game("battle.mp4"), kind: "game", in: 1.5, dur: battleSeconds, zoom });
  if (shot.reference === "map" && footage) {
    segments.push({ src: game("establishing.mp4"), kind: "game", voice, line, zoom: 1.1 });
  } else {
    segments.push({ src: part("s", i), kind: "cinema", voice, line, ...(i === 0 ? { poster: true } : {}) });
  }
  if (shot.id === "commander") segments.push(...objectiveShots());
});
// No briefing-table shot: the real battlefield follows the opening shot, captioned with the place (a card, so the film
// keeps one narrator).
if (footage && !spec.shots.some((s) => s.reference === "map")) {
  const storyFile = opt("story", "D:/rtsai-campaign/RTSAI-Mod/resources/campaign-story.json");
  const where = fs.existsSync(storyFile) ? JSON.parse(fs.readFileSync(storyFile, "utf8")).chapters?.[mission]?.location : null;
  segments.splice(1, 0, { src: game("establishing.mp4"), kind: "game", dur: 6.5, zoom: 1.1, ...(where ? { card: { kicker: "Area of operations", text: where } } : {}) });
}
// No commander shot: the objectives follow the battlefield glide.
if (footage && !spec.shots.some((s) => s.id === "commander")) {
  const at = segments.findIndex((s) => s.kind === "game") + 1 || 1;
  segments.splice(at, 0, ...objectiveShots());
}

const edit = { mission, chapter: spec.chapter, title: spec.title, music: (opt("music") ?? path.join(dir, "music.mp3")).replace(/\\/g, "/"), musicVolume: 0.55, segments };
fs.mkdirSync(path.join(here, "cuts"), { recursive: true });
fs.writeFileSync(path.join(here, "cuts", `${mission}.json`), JSON.stringify(edit, null, 2) + "\n");
console.log(`cuts/${mission}.json: ${segments.length} segments (${segments.filter((s) => s.kind === "game").length} in-game) from ${film.id}`);
