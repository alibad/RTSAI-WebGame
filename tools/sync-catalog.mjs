// Copies the player-facing faction identity (title, tagline, accent, strengths) from the website's catalog
// (RTSAI-Web data/factions.generated.json, itself generated from OpenRA-AI/catalog/factions.json) into
// web/src/data/factions.json, keyed by the RA2 engine faction id. Re-run when the catalog changes:
//   node tools/sync-catalog.mjs [--from ../RTSAI-Web]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const i = process.argv.indexOf("--from");
const web = path.resolve(repo, i > 0 ? process.argv[i + 1] : "../RTSAI-Web");
const src = JSON.parse(fs.readFileSync(path.join(web, "data", "factions.generated.json"), "utf8"));
const out = { source: src.source, sha256: src.sha256, revision: src.catalog.revision, factions: {} };
for (const f of src.catalog.factions) {
  const id = f.variants?.ra2?.engineFactionId ?? f.id;
  out.factions[id] = { name: f.variants?.ra2?.name ?? f.name, title: f.title, tagline: f.tagline, accent: f.accent, strengths: f.strengths };
}
fs.mkdirSync(path.join(repo, "web", "src", "data"), { recursive: true });
fs.writeFileSync(path.join(repo, "web", "src", "data", "factions.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`synced ${Object.keys(out.factions).length} factions (catalog ${out.revision})`);
