// Generate the public project-audio inventory from the canonical mod's provenance, never from private game files.
// node tools/sync-audio-credits.mjs [--check] [--mod <RTSAI-Mod>]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2), modArg = args.indexOf("--mod");
const mod = path.resolve(modArg >= 0 ? args[modArg + 1] : path.join(repo, "../RTSAI-Mod"));
const base = path.join(mod, "mods/rtsai");
const read = name => JSON.parse(fs.readFileSync(path.join(base, name), "utf8"));
const modern = read("modern-factions/audio/PROVENANCE.json");
const clips = [];
function add(prefix, file, record, category) {
  if (!file || file.includes("..") || path.isAbsolute(file)) throw new Error(`Invalid audio path: ${file}`);
  const filename = `${prefix}/${file}`;
  const bytes = fs.readFileSync(path.join(base, filename));
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (record.sha256 && record.sha256 !== sha256) throw new Error(`Provenance hash mismatch: ${filename}`);
  clips.push({ filename, category, sha256,
    source: record.source ?? record.generator ?? record.generator_version ?? record.engine_id ?? record.engine,
    engine: record.engine_id ?? record.engine ?? null,
    license: record.license ?? null });
}
for (const section of ["announcers", "voice_lines", "sound_effects"])
  for (const record of modern[section]) add("modern-factions/audio", record.filename, record, section);
for (const prefix of ["standalone/audio", "audio/sfx"])
  for (const [file, record] of Object.entries(read(`${prefix}/PROVENANCE.json`).files)) add(prefix, file, record, record.category ?? "sound_effects");
clips.sort((a, b) => a.filename.localeCompare(b.filename, "en"));
if (new Set(clips.map(c => c.filename)).size !== clips.length) throw new Error("Duplicate audio credit");
const engines = Object.fromEntries(Object.entries(modern.engines).map(([id, e]) => [id, {
  name: e.engine, model: e.model, revision: e.revision, license: e.license, licenseEvidence: e.license_evidence,
}]));
const result = JSON.stringify({ schema: 1, generatedBy: "tools/sync-audio-credits.mjs",
  scope: "Project audio available to both gameplay modes. This source inventory may include clips not selected by a particular browser build. Original Westwood audio is covered separately by the game's EA notice.",
  provenance: "https://github.com/alibad/RTSAI-Mod/blob/main/docs/audio-provenance.md", engines, clips }, null, 2) + "\n";
const output = path.join(repo, "web/public/audio-credits.json");
if (args.includes("--check")) {
  if (!fs.existsSync(output) || fs.readFileSync(output, "utf8") !== result) throw new Error("Audio credits are stale; run node tools/sync-audio-credits.mjs");
} else fs.writeFileSync(output, result);
console.log(`Audio credits: ${clips.length} provenance-checked project clips`);
