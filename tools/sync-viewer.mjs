// Writes the website's Faction viewer data (RTSAI-Web scripts/export-viewer-data.mts) into web/public/viewer, one file
// per faction by engine id. The battle simulator's unit cards draw with the viewer's own components from it.
// Re-run when the website's catalog or art changes:
//   node tools/sync-viewer.mjs [--from ../RTSAI-Web]
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const i = process.argv.indexOf("--from");
const site = path.resolve(repo, i > 0 ? process.argv[i + 1] : process.env.RTSAI_SITE_ROOT ?? "../RTSAI-Web");
execFileSync(process.execPath, ["--import", "tsx", "scripts/export-viewer-data.mts", path.join(repo, "web", "public", "viewer")], { cwd: site, stdio: "inherit" });
