// Commission a mission's briefing film from the BeTenshi console's Video Forge, from its shot list
// (tools/briefings/<mission>.json) and the first frames art.mjs drew (<stills>/<mission>/<shot id>.png).
//
// The forge animates every frame with a local image-to-video model (Wan 2.2 14B when it fits in memory,
// else Wan 2.2 5B) as soon as the GPU is free, under the shared GPU claim; Montage then voices the lines
// (Chatterbox, checked by Whisper; Kokoro when it cannot run), scores it (ACE-Step) and cuts the film for
// the game (16:9, no burned-in subtitles, WebVTT captions, the chapter and title at the end). It appears
// in Montage's screening room (http://localhost:8018) on the "RTS AI · Lines of Hope" shelf; export it
// with tools/briefings/from-montage.mjs. Commissioning a mission again replaces its earlier commission
// (Montage keeps the old film, marked superseded).
//
//   node tools/briefings/commission.mjs <mission> [--forge http://127.0.0.1:8003] [--stills D:/Builds/RTSAI/ea-build/briefings]
//        [--video wan14b|wan5b|wan14b-full] [--narrator chatterbox|clone-ali-b|kokoro-am_michael|kokoro-<voice>] [--dry-run]
//
// Shot list fields used: mission, chapter (the eyebrow), title, style (the look), music.caption, an optional logline and
// narrator, and shots [{id, prompt, line, motion, action?}]. "motion" is our camera word (push-in, pan-right, ...),
// rewritten here into a sentence for the video model; "action" (optional) says what moves in the shot.
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const mission = argv[0] && !argv[0].startsWith("--") ? argv[0] : undefined;
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
if (!mission) {
  console.error("Usage: node tools/briefings/commission.mjs <mission> [--forge URL] [--stills DIR] [--video wan14b|wan5b] [--narrator KEY] [--dry-run]");
  process.exit(2);
}
const forge = opt("forge", "http://127.0.0.1:8003").replace(/\/$/, "");
const stillsDir = path.join(opt("stills", "D:/Builds/RTSAI/ea-build/briefings"), mission);
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
const specFile = path.join(here, `${mission}.json`);
if (!fs.existsSync(specFile)) {
  console.error(`No shot list at ${specFile}`);
  process.exit(2);
}
const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));

/** Our camera words, as a sentence a video model follows. */
const CAMERA = {
  "push-in": "The camera pushes in slowly and steadily toward the centre of the frame.",
  "push-in-slow": "The camera creeps in very slowly toward the subject, almost still.",
  "pull-out": "The camera pulls back slowly and steadily, revealing more of the scene.",
  "pan-left": "The camera pans slowly and smoothly from right to left across the scene.",
  "pan-right": "The camera pans slowly and smoothly from left to right across the scene.",
  "zoom-target": "The camera zooms in slowly and steadily on the target in the frame.",
  "tilt-up": "The camera tilts slowly upward.",
  "tilt-down": "The camera tilts slowly downward.",
  orbit: "The camera orbits slowly around the subject.",
  static: "The camera holds still, locked off on a tripod.",
};
const ACTION = "Gentle, natural motion only: smoke, dust, mist and light drift; vehicles and people move a little and keep their shape; one continuous shot, no cuts.";

function cameraSentence(word = "push-in") {
  const w = String(word).trim();
  if (CAMERA[w]) return CAMERA[w];
  // Already a sentence: keep it.
  if (/\s/.test(w)) return /[.!]$/.test(w) ? w : `${w}.`;
  return `The camera moves slowly: ${w.replace(/-/g, " ")}.`;
}

/** The scene in one sentence (the prompt's first), so the video model knows what it is moving. */
function sceneAnchor(prompt) {
  const first = String(prompt).split(/(?<=[.!?])\s+/)[0].replace(/^turn (this|the) .*? into /i, "");
  return first ? first[0].toUpperCase() + first.slice(1) : "";
}

const missing = spec.shots.map((s) => path.join(stillsDir, `${s.id}.png`)).filter((f) => !fs.existsSync(f));
if (missing.length) {
  console.error(`First frames missing (draw them with tools/briefings/art.mjs ${mission}):\n  ${missing.join("\n  ")}`);
  process.exit(1);
}
let pictures;
try {
  pictures = /^[a-z0-9][a-z0-9.\-]*/i.exec(JSON.parse(fs.readFileSync(path.join(stillsDir, "art.json"), "utf8")).model ?? "")?.[0];
} catch {
  pictures = undefined;
}

const story = {
  title: spec.title,
  logline: spec.logline ?? spec.shots[0]?.line,
  eyebrow: spec.chapter,
  look: spec.style,
  music: spec.music?.caption,
  format: "briefing",
  collection: "RTS AI · Lines of Hope",
  source: "rtsai",
  externalId: spec.mission ?? mission,
  stack: {
    video: opt("video", spec.video ?? "wan14b"),
    ...(opt("narrator", spec.narrator) ? { narrator: opt("narrator", spec.narrator) } : {}),
    ...(pictures ? { pictures } : {}),
  },
  shots: spec.shots.map((s) => ({
    id: s.id,
    line: s.line,
    picture: s.prompt,
    motion: [cameraSentence(s.motion), sceneAnchor(s.prompt), s.action ?? ACTION].filter(Boolean).join(" "),
    still: path.resolve(stillsDir, `${s.id}.png`).replace(/\\/g, "/"),
  })),
};

if (argv.includes("--dry-run")) {
  console.log(JSON.stringify({ action: "commission", story }, null, 2));
  process.exit(0);
}

const res = await fetch(`${forge}/api/forge`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action: "commission", story }),
  signal: AbortSignal.timeout(180_000),
}).catch((err) => {
  console.error(`The forge did not answer at ${forge}: ${err.message}`);
  process.exit(1);
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`The forge refused the commission (HTTP ${res.status}): ${body.error ?? "no reason given"}`);
  process.exit(1);
}
const st = body.story;
console.log(`Commissioned "${st.title}" (${st.eyebrow ?? ""}) as ${st.id}: ${body.shots} shots.`);
console.log(`  motion:   ${st.stack.video.label}${st.stack.fallback ? `  (${st.stack.fallback})` : ""}`);
console.log(`  narrator: ${st.stack.voice?.label ?? "?"}; score: ACE-Step from the music brief; pictures: ${st.stack.pictures ?? "provided"}`);
console.log(`  clips:    ${st.shots.map((s) => `${s.ref ?? "?"} ${s.seconds} s`).join(", ")}`);
if (body.superseded?.length) console.log(`  replaces: ${body.superseded.join(", ")} (Montage keeps their films, marked superseded once the new one is cut)`);
console.log("Watch it in Montage (http://localhost:8018); when the film is cut, export it with:");
console.log(`  node tools/briefings/from-montage.mjs ${mission}`);
