// Write the edit list cut-film.py follows for a mission: the forge's cinematic shots (from the mission's Montage film
// folder: s01.mp4..., with the recorded narration n01.wav... and the score) around real in-engine footage recorded by
// game-footage.mjs. The shape:
//   opening shot → the real battlefield (the briefing-table line over the establishing glide) → ... → the commander →
//   every objective on the real map, with its card → live battle → the remaining shots → the last shot and the title.
// A mission with no footage yet keeps its cinematic shots only.
//   node tools/briefings/make-cut.mjs <mission> [--footage D:/rtsai-campaign/footage-out] [--montage http://127.0.0.1:8018]
//        [--films C:/Users/Admin/Code/hq/montage/out/reels] [--battle 10] [--zoom 1.25]
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

// The newest cut Montage film for this mission (not superseded).
const res = await fetch(`${opt("montage", "http://127.0.0.1:8018")}/api/films`);
const body = await res.json();
const films = (Array.isArray(body.films ?? body) ? body.films ?? body : Object.values(body.films ?? body))
  .filter((f) => f.source === "rtsai" && f.externalId === mission && f.output && !f.superseded);
if (!films.length) { console.error(`No cut Montage film for ${mission} yet`); process.exit(1); }
const film = films.sort((a, b) => String(b.id).localeCompare(String(a.id)))[0];
const dir = path.join(reels, path.dirname(film.output));
const narration = JSON.parse(fs.readFileSync(path.join(dir, "narration.json"), "utf8"));
const part = (kind, i) => path.join(dir, `${kind}${String(i + 1).padStart(2, "0")}.${kind === "s" ? "mp4" : "wav"}`).replace(/\\/g, "/");

const footage = fs.existsSync(path.join(footageDir, "footage.json")) ? JSON.parse(fs.readFileSync(path.join(footageDir, "footage.json"), "utf8")) : null;
const game = (file) => path.join(footageDir, file).replace(/\\/g, "/");
const objectiveShots = () => {
  if (!footage) return [];
  const seen = new Set();
  return footage.segments.filter((s) => s.objective && !seen.has(s.objective.index) && seen.add(s.objective.index)).map((s) => ({
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
// No commander shot: the objectives follow the battlefield glide.
if (footage && !spec.shots.some((s) => s.id === "commander")) {
  const at = segments.findIndex((s) => s.kind === "game") + 1 || 1;
  segments.splice(at, 0, ...objectiveShots());
}

const edit = { mission, chapter: spec.chapter, title: spec.title, music: path.join(dir, "music.mp3").replace(/\\/g, "/"), musicVolume: 0.55, segments };
fs.mkdirSync(path.join(here, "cuts"), { recursive: true });
fs.writeFileSync(path.join(here, "cuts", `${mission}.json`), JSON.stringify(edit, null, 2) + "\n");
console.log(`cuts/${mission}.json: ${segments.length} segments (${segments.filter((s) => s.kind === "game").length} in-game) from ${film.id}`);
