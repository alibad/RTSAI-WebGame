// Original (EA) content gate for public static builds. The public isometric game may carry original Westwood ART for
// the nine original countries and original unit VOICE and sound clips (their voice sets, and the Attack Dog's barks and
// bite for every faction) under EA's free, non-commercial C&C modding guidelines, which forbid only C&C music:
//   * art: only .shp/.vxl/.hva/.pal files, only directly under mods/rtsai/web/ea/, each listed in ea-content.json;
//   * clips: only short RIFF WAVE .wav files with RA2's clip names (never EVA), only under mods/rtsai/web/ea/audio/ in
//     the range-read audio pack, each listed in ea-content.json's "audio".
// Never EA archives (.mix/.bag/.idx), music or video, nothing original in the Classic/top-down profile, and nothing
// unlisted. This gate reads the actual bundle entries, the range-read pack indexes and the finished output tree.
import fs from "node:fs";
import path from "node:path";

export const EA_NOTICE = "EA has not endorsed and does not support this product.";
export const EA_DIR = "mods/rtsai/web/ea/";
export const EA_AUDIO_DIR = EA_DIR + "audio/";
const ARCHIVE_OR_VIDEO = /\.(mix|bag|idx|vqa|bik)$/i;
const AUDIO = /\.(aud|wav|ogg|mp3|bag|idx)$/i;
const ART = /\.(shp|vxl|hva|pal)$/i;
// RA2's audio.idx names (at most 16 characters with .wav); EVA (ceva*) is not a unit voice.
export const CLIP = /^(?!ceva)[a-z0-9][a-z0-9_-]{0,15}\.wav$/;
// A voice or sound clip is short: anything larger would be music or speech the build must not carry.
export const CLIP_MAX_BYTES = 512 * 1024;

/** Every entry (name, offset, length) of an ORAPACK1 pack. */
export function listPackEntries(pack) {
  if (pack.length < 12 || pack.subarray(0, 8).toString() !== "ORAPACK1") throw new Error("Malformed ORAPACK1 header");
  const count = pack.readInt32LE(8);
  const entries = [];
  let offset = 12;
  for (let i = 0; i < count; i++) {
    if (offset + 2 > pack.length) throw new Error("Malformed ORAPACK1 entry");
    const nameLength = pack.readUInt16LE(offset); offset += 2;
    const name = pack.subarray(offset, offset + nameLength).toString("utf8"); offset += nameLength;
    if (offset + 4 > pack.length) throw new Error("Malformed ORAPACK1 entry");
    const length = pack.readInt32LE(offset); offset += 4;
    if (length < 0 || offset + length > pack.length) throw new Error("Malformed ORAPACK1 entry bounds");
    entries.push({ name, offset, length });
    offset += length;
  }
  if (offset !== pack.length) throw new Error("Malformed ORAPACK1 trailing bytes");
  return entries;
}

const isOriginal = (name) => name.startsWith(EA_DIR) || name.includes("/web/ea/");

/**
 * Checks one profile's data directory (web-bundle.pack, web-art.json, web-audio.json and web-audio.pack). Returns the
 * original-content summary ({files, bytes, notice, audio: {files, bytes, names}}) or null when the profile carries none.
 * Throws on any violation.
 */
export function checkProfile(profile) {
  const fail = (msg) => { throw new Error(`Original-content gate (${profile.id}): ${msg}`); };
  const pack = fs.readFileSync(path.join(profile.dir, "web-bundle.pack"));
  const entries = listPackEntries(pack);
  const lazy = (name) => {
    const file = path.join(profile.dir, name);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).files.map((f) => ({ name: f.path, length: f.size, offset: f.offset })) : [];
  };
  const art = lazy("web-art.json"), audio = lazy("web-audio.json");
  for (const e of [...entries, ...art, ...audio])
    if (ARCHIVE_OR_VIDEO.test(e.name)) fail(`archive or video payload ${e.name}`);
  const originalAudio = audio.filter((e) => isOriginal(e.name));
  const original = [...entries, ...art].filter((e) => isOriginal(e.name));
  if (!original.length && !originalAudio.length) return null;
  if (profile.id !== "public") fail(`original content in the ${profile.id} profile (isometric only)`);
  const record = entries.find((e) => e.name === EA_DIR + "ea-content.json");
  if (!record) fail("ea-content.json missing");
  const content = JSON.parse(pack.subarray(record.offset, record.offset + record.length).toString("utf8"));
  if (content.notice !== EA_NOTICE) fail("ea-content.json lacks EA's notice");
  const listed = new Map(content.files.map((f) => [f.name, f]));
  let bytes = 0, files = 0;
  for (const e of original) {
    if (e.name === EA_DIR + "ea-content.json") continue;
    if (!e.name.startsWith(EA_DIR) || e.name.slice(EA_DIR.length).includes("/")) fail(`original art outside ${EA_DIR}: ${e.name}`);
    const name = e.name.slice(EA_DIR.length);
    if (AUDIO.test(name)) fail(`audio in the original-art folder: ${name}`);
    if (!ART.test(name)) fail(`not an allowed art file: ${name}`);
    if (!listed.has(name)) fail(`${name} is not listed in ea-content.json`);
    bytes += e.length; files++;
  }
  if (files !== listed.size) fail(`ea-content.json lists ${listed.size} files, the bundle carries ${files}`);

  // Original clips: only in the range-read audio pack, only under web/ea/audio/, each listed, short and a real WAVE file.
  const clips = new Map((content.audio ?? []).map((f) => [f.name, f]));
  for (const name of clips.keys()) if (!CLIP.test(name)) fail(`ea-content.json lists a clip that is not a unit voice or sound: ${name}`);
  let audioPack = null;
  if (originalAudio.length) {
    const file = path.join(profile.dir, "web-audio.pack");
    if (!fs.existsSync(file)) fail("web-audio.pack missing");
    audioPack = fs.readFileSync(file);
  }
  let audioBytes = 0;
  const names = [];
  for (const e of originalAudio) {
    if (!e.name.startsWith(EA_AUDIO_DIR) || e.name.slice(EA_AUDIO_DIR.length).includes("/")) fail(`original audio outside ${EA_AUDIO_DIR}: ${e.name}`);
    const name = e.name.slice(EA_AUDIO_DIR.length);
    if (!CLIP.test(name)) fail(`not an allowed voice or sound clip: ${name}`);
    if (!clips.has(name)) fail(`${name} is not listed in ea-content.json`);
    if (e.length > CLIP_MAX_BYTES) fail(`${name}: ${e.length} bytes is not a voice or sound clip`);
    if (typeof e.offset !== "number") fail(`${name}: no offset in web-audio.json`);
    const head = audioPack.subarray(e.offset, e.offset + 12);
    if (head.length < 12 || head.subarray(0, 4).toString("latin1") !== "RIFF" || head.subarray(8, 12).toString("latin1") !== "WAVE")
      fail(`${name} is not a RIFF WAVE file`);
    audioBytes += e.length; names.push(name);
  }
  if (names.length !== clips.size) fail(`ea-content.json lists ${clips.size} clips, the audio pack carries ${names.length}`);
  return { files, bytes, notice: content.notice, audio: { files: names.length, bytes: audioBytes, names: names.sort() } };
}

/**
 * Checks the finished static output: no archive/video file, and no original audio except the listed clips at
 * <data root>/public/audio/web/ea/audio/<clip>.wav (summary from checkProfile).
 */
export function checkOutput(out, summary = null) {
  const allowed = new Set(summary?.audio?.names ?? []);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const seen = new Set();
  for (const f of walk(out)) {
    const rel = path.relative(out, f).replace(/\\/g, "/");
    if (ARCHIVE_OR_VIDEO.test(rel)) throw new Error(`Original-content gate: archive or video file in the output: ${rel}`);
    if (!rel.includes("/web/ea/")) continue;
    const m = rel.match(/^data-[0-9a-f]+\/public\/audio\/web\/ea\/audio\/([^/]+)$/);
    if (!m || !CLIP.test(m[1]) || !allowed.has(m[1])) throw new Error(`Original-content gate: original audio not listed for the build: ${rel}`);
    if (fs.statSync(f).size > CLIP_MAX_BYTES) throw new Error(`Original-content gate: ${rel} is larger than a voice or sound clip`);
    seen.add(m[1]);
  }
  for (const name of allowed) if (!seen.has(name)) throw new Error(`Original-content gate: listed clip ${name} is missing from the output`);
}

/** The NOTICE file written at the static root when the build carries original content. */
export function noticeText(summary) {
  const clips = summary?.audio?.files ? ` and ${summary.audio.files} original unit voice and sound clips (${(summary.audio.bytes / 1048576).toFixed(1)} MB)` : "";
  return [
    "RTS AI — notices",
    "",
    "Original Command & Conquer: Red Alert 2 art (sprites, voxel models and palettes) and unit voices and sounds are used",
    "for the nine original countries (and the Attack Dog's barks for every faction) under EA's Command & Conquer",
    "Franchise Modding Guidelines: free and non-commercial.",
    EA_NOTICE,
    "Command & Conquer and Red Alert are trademarks of Electronic Arts Inc. No C&C music, EVA or video is included.",
    summary ? `This build carries ${summary.files} original art files (${(summary.bytes / 1048576).toFixed(1)} MB)${clips}, listed in ea-content.json inside the game data.` : "This build carries no original art or audio.",
    "",
    "Everything else (engine: OpenRA, GPLv3; game rules, project art and audio) belongs to its authors.",
    "",
  ].join("\n");
}
