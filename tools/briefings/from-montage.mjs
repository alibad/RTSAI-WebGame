// Export a mission's briefing film from Montage (the screening room on this machine) into the folder that is
// deployed to Cloudflare Pages: <out>/<mission>/briefing.mp4 (a web encode: 1280x720 H.264, CRF 26 capped at 700 kbit/s,
// +faststart, AAC 128k: about 5 MB a minute), briefing.vtt (the captions), poster.webp, and briefing.json (which film).
// It takes the newest finished film commissioned for that mission that a newer commission has not superseded
// (and that was not rejected). Nothing is deployed.
//
//   node tools/briefings/from-montage.mjs <mission> [--montage http://127.0.0.1:8018] [--montage-dir C:/Users/Admin/Code/hq/montage]
//        [--out D:/Builds/RTSAI/ea-build/play-cdn/campaign] [--crf 26] [--max-rate 700] [--force]
//
// The cap: the forge's clips are full of texture, and plain CRF 26 came to ~15 MB a minute on the pilot (SSIM 0.965
// against the 720p master); capped at 700 kbit/s it is ~5 MB a minute (SSIM 0.918: grass and camouflage soften, faces and
// the HUD hold). --max-rate 0 encodes plain CRF.
//
// Montage is read through its API; if it is not answering, its database is read read-only.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const mission = argv[0] && !argv[0].startsWith("--") ? argv[0] : undefined;
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
if (!mission) {
  console.error("Usage: node tools/briefings/from-montage.mjs <mission> [--montage URL] [--montage-dir DIR] [--out DIR] [--crf 26] [--force]");
  process.exit(2);
}
const montageUrls = [opt("montage", "http://127.0.0.1:8018"), "http://127.0.0.1:8017"].map((u) => u.replace(/\/$/, ""));
const montageDir = opt("montage-dir", "C:/Users/Admin/Code/hq/montage");
const outDir = path.join(opt("out", "D:/Builds/RTSAI/ea-build/play-cdn/campaign"), mission);
const crf = Number(opt("crf", 26));
const maxRate = Number(opt("max-rate", 700)); // kbit/s; 0 = plain CRF
const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;

async function filmsFromApi() {
  for (const base of [...new Set(montageUrls)]) {
    try {
      const res = await fetch(`${base}/api/films`, { signal: AbortSignal.timeout(60_000) });
      if (res.ok) return { films: (await res.json()).films, from: `${base}/api/films` };
    } catch {
      // the next one, then the database
    }
  }
  return null;
}

async function filmsFromDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const file = path.join(montageDir, "data", "montage.db");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return { films: db.prepare("SELECT data FROM films ORDER BY created_at DESC").all().map((r) => JSON.parse(r.data)), from: `${file} (read-only)` };
  } finally {
    db.close();
  }
}

const got = (await filmsFromApi()) ?? (await filmsFromDb());
const film = got.films
  .filter((f) => f.externalId === mission && (f.source ?? "rtsai") === "rtsai" && f.output && ["review", "approved"].includes(f.status) && !f.supersededBy)
  .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
if (!film) {
  const any = got.films.filter((f) => f.externalId === mission);
  console.error(
    any.length
      ? `No finished, current film for "${mission}" yet (${any.map((f) => `${f.id}: ${f.supersededBy ? "superseded" : f.status}`).join(", ")}).`
      : `Montage has no film commissioned for "${mission}". Commission one with: node tools/briefings/commission.mjs ${mission}`,
  );
  process.exit(1);
}

const media = (rel) => path.join(montageDir, "out", "reels", ...rel.split("/"));
const src = media(film.output);
if (!fs.existsSync(src)) {
  console.error(`The film's file is missing: ${src}`);
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });
const files = { video: path.join(outDir, "briefing.mp4"), captions: path.join(outDir, "briefing.vtt"), poster: path.join(outDir, "poster.webp"), manifest: path.join(outDir, "briefing.json") };

let previous = null;
try {
  previous = JSON.parse(fs.readFileSync(files.manifest, "utf8"));
} catch {
  previous = null;
}
const same = previous?.film === film.id && previous?.output === film.output && previous?.crf === crf && (previous?.maxRateKbps ?? 0) === maxRate && fs.existsSync(files.video) && !argv.includes("--force");

if (!same) {
  // Encode next to the target, then swap it in, so a half-written file is never served.
  const tmp = `${files.video}.part.mp4`;
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-i", src,
    "-vf", "scale=1280:720:flags=lanczos",
    "-c:v", "libx264", "-preset", "slow", "-crf", String(crf), ...(maxRate > 0 ? ["-maxrate", `${maxRate}k`, "-bufsize", `${maxRate * 2}k`] : []), "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2",
    tmp,
  ]);
  fs.renameSync(tmp, files.video);
}
if (film.captions && fs.existsSync(media(film.captions))) fs.copyFileSync(media(film.captions), files.captions);
else console.warn("This film has no captions file; briefing.vtt was not written.");
// The poster is a frame of the opening shot (after the fade from black), not Montage's title card: the game draws its
// own play button and length over it, which would cover the title.
execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", "3", "-i", src, "-frames:v", "1", "-vf", "scale=1280:-2:flags=lanczos", "-c:v", "libwebp", "-quality", "82", files.poster]);

const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,width,height", "-of", "json", files.video]).toString());
const seconds = Number(probe.format.duration);
const bytes = fs.statSync(files.video).size;
const manifest = {
  mission,
  film: film.id,
  output: film.output,
  title: film.story?.title,
  eyebrow: film.eyebrow,
  seconds: Math.round(seconds * 10) / 10,
  crf,
  maxRateKbps: maxRate,
  video: { file: "briefing.mp4", bytes, width: 1280, height: 720 },
  captions: fs.existsSync(files.captions) ? "briefing.vtt" : null,
  poster: fs.existsSync(files.poster) ? "poster.webp" : null,
  madeWith: film.stack ? { pictures: film.stack.pictures, motion: film.stack.video, voice: film.stack.voice, score: "ACE-Step 1.5" } : undefined,
  exportedAt: new Date().toISOString(),
};
fs.writeFileSync(files.manifest, JSON.stringify(manifest, null, 2));

// The index the game reads when the campaign screen opens (web/src/briefings.ts): every exported briefing.
const campaignDir = path.dirname(outDir);
const briefings = fs.readdirSync(campaignDir, { withFileTypes: true }).filter((d) => d.isDirectory())
  .map((d) => path.join(campaignDir, d.name, "briefing.json")).filter((f) => fs.existsSync(f))
  .map((f) => JSON.parse(fs.readFileSync(f, "utf8")))
  .filter((b) => b.video && b.captions && b.poster)
  .map((b) => ({ mission: b.mission, title: b.title, eyebrow: b.eyebrow, seconds: b.seconds }))
  .sort((x, y) => x.mission.localeCompare(y.mission));
fs.writeFileSync(path.join(campaignDir, "index.json"), JSON.stringify({ updatedAt: new Date().toISOString(), briefings }, null, 2));

console.log(`"${film.story?.title}" (${film.eyebrow ?? mission}) — Montage film ${film.id}, read from ${got.from}`);
console.log(`  source  ${src}`);
for (const [what, file] of Object.entries(files)) {
  if (!fs.existsSync(file)) continue;
  const extra = what === "video" ? `  ${seconds.toFixed(1)} s, ${(bytes / 1048576 / (seconds / 60)).toFixed(1)} MB a minute${same ? " (unchanged, not re-encoded)" : ""}` : "";
  console.log(`  wrote   ${file}  ${mb(fs.statSync(file).size)}${extra}`);
}
console.log("Not deployed: the folder goes to Cloudflare Pages with the next deploy.");
