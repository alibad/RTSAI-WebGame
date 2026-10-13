// Original-art (EA) gate for public static builds. The public isometric game may carry original Westwood ART for the
// nine original countries under EA's free, non-commercial C&C modding guidelines: only .shp/.vxl/.hva/.pal files,
// only under mods/rtsai/web/ea/, each listed in the bundle's ea-content.json. Never EA archives, video or audio, and
// nothing original in the Classic/top-down profile. This gate reads the actual bundle entries, the range-read pack
// indexes and the finished output tree.
import fs from "node:fs";
import path from "node:path";

export const EA_NOTICE = "EA has not endorsed and does not support this product.";
export const EA_DIR = "mods/rtsai/web/ea/";
const ARCHIVE_OR_VIDEO = /\.(mix|bag|idx|vqa|bik)$/i;
const AUDIO = /\.(aud|wav|ogg|mp3|bag|idx)$/i;
const ART = /\.(shp|vxl|hva|pal)$/i;

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

/**
 * Checks one profile's data directory (web-bundle.pack, web-art.json, web-audio.json). Returns the original-art
 * summary ({files, bytes, notice}) or null when the profile carries none. Throws on any violation.
 */
export function checkProfile(profile) {
  const fail = (msg) => { throw new Error(`Original-art gate (${profile.id}): ${msg}`); };
  const pack = fs.readFileSync(path.join(profile.dir, "web-bundle.pack"));
  const entries = listPackEntries(pack);
  const lazy = (name) => {
    const file = path.join(profile.dir, name);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).files.map((f) => ({ name: f.path, length: f.size })) : [];
  };
  const art = lazy("web-art.json"), audio = lazy("web-audio.json");
  for (const e of [...entries, ...art, ...audio])
    if (ARCHIVE_OR_VIDEO.test(e.name)) fail(`archive or video payload ${e.name}`);
  for (const e of audio)
    if (e.name.startsWith(EA_DIR) || e.name.includes("/web/ea/")) fail(`audio under the original-art folder: ${e.name}`);
  const original = [...entries, ...art].filter((e) => e.name.startsWith(EA_DIR) || e.name.includes("/web/ea/"));
  if (!original.length) return null;
  if (profile.id !== "public") fail(`original art in the ${profile.id} profile (isometric only)`);
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
  return { files, bytes, notice: content.notice };
}

/** Checks the finished static output: no archive/video file, no original audio, nothing original outside the data roots. */
export function checkOutput(out) {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(out)) {
    const rel = path.relative(out, f).replace(/\\/g, "/");
    if (ARCHIVE_OR_VIDEO.test(rel)) throw new Error(`Original-art gate: archive or video file in the output: ${rel}`);
    if (rel.includes("/web/ea/") && (AUDIO.test(rel) || /\/audio\//.test(rel))) throw new Error(`Original-art gate: original audio in the output: ${rel}`);
  }
}

/** The NOTICE file written at the static root when the build carries original art. */
export function noticeText(summary) {
  return [
    "RTS AI — notices",
    "",
    "Original Command & Conquer: Red Alert 2 art (sprites, voxel models and palettes) is shown for the nine original",
    "countries under EA's Command & Conquer Franchise Modding Guidelines: free and non-commercial.",
    EA_NOTICE,
    "Command & Conquer and Red Alert are trademarks of Electronic Arts Inc. No EA audio, music or video is included.",
    summary ? `This build carries ${summary.files} original art files (${(summary.bytes / 1048576).toFixed(1)} MB), listed in ea-content.json inside the game data.` : "This build carries no original art.",
    "",
    "Everything else (engine: OpenRA, GPLv3; game rules, project art and audio) belongs to its authors.",
    "",
  ].join("\n");
}
