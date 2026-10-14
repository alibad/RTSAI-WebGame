// Copies the player-facing faction identity (title, tagline, accent, strengths) from the website's catalog
// (RTSAI-Web data/factions.generated.json, itself generated from OpenRA-AI/catalog/factions.json) into
// web/src/data/factions.json, keyed by the RA2 engine faction id. Re-run when the catalog changes:
//   node tools/sync-catalog.mjs [--from ../RTSAI-Web]
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const i = process.argv.indexOf("--from");
const web = path.resolve(repo, i > 0 ? process.argv[i + 1] : "../RTSAI-Web");
const rawIndex = process.argv.indexOf("--catalog");
const rawPath = rawIndex > 0 ? path.resolve(process.argv[rawIndex + 1]) : null;
const bytes = rawPath ? fs.readFileSync(rawPath) : null;
const src = rawPath ? {source: "OpenRA-AI/catalog/factions.json", sha256: crypto.createHash("sha256").update(bytes).digest("hex"), catalog: JSON.parse(bytes)}
  : JSON.parse(fs.readFileSync(path.join(web, "data", "factions.generated.json"), "utf8"));
const out = { source: src.source, sha256: src.sha256, revision: src.catalog.revision, factions: {} };
for (const f of src.catalog.factions) {
  const id = f.variants?.ra2?.engineFactionId ?? f.id;
  out.factions[id] = { name: f.variants?.ra2?.name ?? f.name, title: f.title, tagline: f.tagline, accent: f.accent, strengths: f.strengths };
}
// Each catalogued unit's story, keyed by the actor the isometric game runs: the simulator's unit card shows it next to
// the engine's own numbers (cost, health, weapons), so the text and the rules never come from two copies.
out.units = {};
for (const u of src.catalog.units ?? []) {
  const actor = u.variants?.ra2?.actorId;
  if (!actor) continue;
  out.units[actor] = { faction: u.factionId, name: u.variants.ra2.name ?? u.name, role: u.variants.ra2.role ?? u.role, story: u.story, strengths: u.strengths, counterplay: u.counterplay };
}
const outIndex = process.argv.indexOf("--out");
const destination = outIndex > 0 ? path.resolve(process.argv[outIndex + 1]) : path.join(repo, "web", "src", "data", "factions.json");
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, JSON.stringify(out, null, 2) + "\n");
console.log(`synced ${Object.keys(out.factions).length} factions and ${Object.keys(out.units).length} units (catalog ${out.revision})`);
