// Writes the website's Faction viewer data (RTSAI-Web scripts/export-viewer-data.mts) into web/public/viewer, one file
// per faction by engine id. The battle simulator's unit cards draw with the viewer's own components from it.
// Re-run when the website's catalog or art changes:
//   node tools/sync-viewer.mjs [--from ../RTSAI-Web] [--published]
// A release exports the website's committed metadata; local Mod experiments must not regenerate it implicitly.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from 'node:fs';
import { verifySiteInput } from './release-site-input.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const i = process.argv.indexOf("--from");
const site = path.resolve(repo, i > 0 ? process.argv[i + 1] : process.env.RTSAI_SITE_ROOT ?? "../RTSAI-Web");
if (process.argv.includes('--published')) {
  if (fs.existsSync(path.join(site, '.release-site-input.json'))) verifySiteInput(site);
  else execFileSync('git', ['diff', '--quiet', 'HEAD', '--', 'data/shared-content.generated.json', 'data/unit-modifications.generated.json'], { cwd: site, stdio: 'inherit' });
} else {
  execFileSync(process.execPath, ['scripts/sync-shared-content.mjs'], { cwd: site, stdio: 'inherit' });
}
execFileSync(process.execPath, ["--import", "tsx", "scripts/export-viewer-data.mts", path.join(repo, "web", "public", "viewer")], { cwd: site, stdio: "inherit" });
