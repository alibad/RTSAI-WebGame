// Reuse the project's original unlabelled portraits. Names are laid out below the art in the web HUD.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const art = path.resolve(repo, "../RTSAI-Art/units");
const mod = path.resolve(repo, "../RTSAI-Mod-wt-web-public/mods/rtsai");
const out = path.join(repo, "web/public/portraits");
fs.mkdirSync(out, { recursive: true });
const manifest = {};
function copy(key, source) {
  const bytes = fs.readFileSync(source);
  const file = `${key}.png`;
  fs.writeFileSync(path.join(out, file), bytes);
  manifest[key] = { file, source: path.relative(path.dirname(art), source).replaceAll("\\", "/"), sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}
for (const actor of fs.readdirSync(art).filter((name) => name.startsWith("r2")).sort()) {
  const source = path.join(art, actor, "candidates/cameo-v3-render/cameo-nolabel.png");
  if (!fs.existsSync(source)) continue;
  const installed = path.join(mod, "modern-factions/icons", `${actor}.png`);
  const labelled = path.join(path.dirname(source), "cameo.png");
  if (fs.existsSync(installed) && !fs.readFileSync(installed).equals(fs.readFileSync(labelled)))
    throw new Error(`${actor}: original portrait does not match the installed cameo`);
  copy(actor, source);
}
for (const faction of ["china", "iran", "turkey", "saudi", "israel", "yemen", "hezbollah"])
  copy(`dog-${faction}`, path.join(art, `kit-dog/candidates/kit-v2/dog-${faction}icon-nolabel.png`));
fs.writeFileSync(path.join(repo, "web/src/portraits.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Copied ${Object.keys(manifest).length} original project portraits.`);
