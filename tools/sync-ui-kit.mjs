// Vendors the RTS AI UI kit (shadcn/ui on Base UI, themed) from RTSAI-Web into web/src/components/ui, unchanged
// except for the import path of the cn() helper. Re-run after the kit changes upstream:
//   node tools/sync-ui-kit.mjs [--from ../RTSAI-Web]
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const i = process.argv.indexOf("--from");
const src = path.resolve(repo, i > 0 ? process.argv[i + 1] : "../RTSAI-Web");
const from = path.join(src, "app", "components", "ui");
const to = path.join(repo, "web", "src", "components", "ui");
fs.mkdirSync(to, { recursive: true });

let commit = "unknown";
try { commit = execFileSync("git", ["-C", src, "log", "-1", "--format=%h %s", "--", "app/components/ui", "lib/utils.ts"], { encoding: "utf8" }).trim(); } catch { /* not a checkout */ }

const files = fs.readdirSync(from).filter((f) => /\.(tsx|ts|css)$/.test(f));
for (const f of files) {
  let text = fs.readFileSync(path.join(from, f), "utf8");
  text = text.replaceAll('"../../../lib/utils"', '"../../lib/utils"');
  fs.writeFileSync(path.join(to, f), text);
}
fs.mkdirSync(path.join(repo, "web", "src", "lib"), { recursive: true });
fs.copyFileSync(path.join(src, "lib", "utils.ts"), path.join(repo, "web", "src", "lib", "utils.ts"));
fs.writeFileSync(path.join(to, "VENDORED.md"),
  `Vendored from RTSAI-Web app/components/ui (${commit}) by tools/sync-ui-kit.mjs.\n` +
  `Do not edit these files here; change the kit in RTSAI-Web and re-run the script.\n`);
console.log(`vendored ${files.length} files from ${from} (${commit})`);
