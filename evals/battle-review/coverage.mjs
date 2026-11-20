// The battle clips' coverage as a picture: which country fights in which way, with which unit classes, and what has no
// clip yet. Reads grid.json (and a filming report, when given, to mark clips that are filmed) and writes one HTML file.
//   node evals/battle-review/coverage.mjs --out <coverage.html> [--report <clips folder>/report.json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, "../..");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const grid = JSON.parse(fs.readFileSync(path.join(here, "grid.json"), "utf8"));
const report = opt("report") ? JSON.parse(fs.readFileSync(opt("report"), "utf8")) : null;
const names = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(repo, "web/src/data/factions.json"), "utf8")).factions?.map?.((f) => [f.id, f.name]) ?? []);
const COUNTRIES = ["america", "england", "france", "germany", "korea", "russia", "cuba", "iraq", "libya", "china", "iran", "israel", "lebanon", "saudi", "turkey", "yemen"];
const LABEL = { america: "America", england: "England", france: "France", germany: "Germany", korea: "Korea", russia: "Russia", cuba: "Cuba", iraq: "Iraq", libya: "Libya", china: "China", iran: "Iran", israel: "Israel", lebanon: "Lebanon", saudi: "Saudi Arabia", turkey: "Türkiye", yemen: "Yemen" };
const MODES = [["attack-move", "Attack-move"], ["direct", "Direct attack"], ["defence", "Hold ground"], ["deployed", "Deployed"], ["siege", "Siege"], ["air-strike", "Air strike"], ["anti-air", "Anti-air"], ["naval", "Naval"], ["special", "Special ability"]];
const MISSING = [["garrison", "Garrisoned buildings"], ["superweapon", "Superweapons"], ["guard", "Guard and escort"], ["shore", "Ships against the shore, landings"]];
const CLASSES = [["infantry", "Infantry"], ["vehicle", "Vehicles"], ["aircraft", "Aircraft"], ["ship", "Ships"], ["defence", "Defences"], ["special", "Special"]];
const flag = (id) => { const f = path.join(repo, "web/public/flags", `${id}.svg`); return fs.existsSync(f) ? `data:image/svg+xml;base64,${fs.readFileSync(f).toString("base64")}` : ""; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const filmed = (c) => !report || !!report.clips[c.id];
const clipsOf = (country, mode) => grid.clips.filter((c) => c.mode.id === mode && [c.a.faction, c.b.faction].includes(country));

const cell = (country, mode) => clipsOf(country, mode).map((c) => {
  const other = c.a.faction === country ? c.b.faction : c.a.faction;
  return `<span class="clip${filmed(c) ? "" : " todo"}" title="${esc(c.title)}"><img src="${flag(other)}" alt="${esc(LABEL[other])}">${c.classes.map((k) => `<i class="k-${k}" title="${k}"></i>`).join("")}</span>`;
}).join("");
const classCell = (cls, mode) => { const n = grid.clips.filter((c) => c.mode.id === mode && c.classes.includes(cls)).length; return n ? `<b>${n}</b>` : ""; };

const html = `<!doctype html><meta charset="utf-8"><title>Battle clips: coverage</title>
<style>
  body { margin: 0; padding: 28px; background: #0c100c; color: #f0eee6; font: 14px/1.4 "Segoe UI", system-ui, sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; } p { color: #a4a898; margin: 0 0 18px; max-width: 900px; }
  table { border-collapse: separate; border-spacing: 3px; } th { font-weight: 600; font-size: 12px; color: #a4a898; padding: 4px 6px; text-align: center; }
  th.row { text-align: left; white-space: nowrap; color: #f0eee6; font-size: 13px; } th.row img { width: 24px; height: 16px; object-fit: cover; border-radius: 2px; vertical-align: -3px; margin-right: 8px; box-shadow: 0 0 0 1px #0008; }
  td { min-width: 78px; height: 34px; background: #141a15; border: 1px solid #f0eee61f; border-radius: 6px; text-align: center; padding: 2px 4px; }
  td.none { background: repeating-linear-gradient(135deg, #141a15, #141a15 6px, #191f1a 6px, #191f1a 12px); border-style: dashed; color: #747a6c; font-size: 11px; }
  td b { color: #f1d28b; font-size: 15px; }
  .clip { display: inline-flex; align-items: center; gap: 3px; padding: 3px 6px; border-radius: 999px; background: #86d67c26; border: 1px solid #86d67c80; }
  .clip.todo { background: #f0b65a1f; border-color: #f0b65a80; }
  .clip img { width: 18px; height: 12px; object-fit: cover; border-radius: 1px; }
  .clip i { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
  .k-infantry { background: #7fc7ff; } .k-vehicle { background: #f1d28b; } .k-aircraft { background: #c9a2ff; } .k-ship { background: #5fd3c4; } .k-defence { background: #ff9d7a; } .k-special { background: #ff6fb1; }
  .legend { display: flex; gap: 16px; flex-wrap: wrap; margin: 14px 0 26px; color: #a4a898; font-size: 12.5px; } .legend i { width: 9px; height: 9px; border-radius: 50%; display: inline-block; margin-right: 5px; }
  h2 { font-size: 15px; margin: 0 0 8px; } ul { margin: 6px 0 0; padding-left: 18px; color: #a4a898; } li { margin: 2px 0; }
</style>
<h1>Battle clips: who fights how</h1>
<p>${grid.clips.length} clips on ${esc(grid.build.label)} (page ${esc(grid.build.page)}, ${esc(grid.build.runtime)}, ${esc(grid.build.data)}). A pill is one clip: the flag is the opponent, the dots are the unit classes in it. Hatched columns have no clip yet.</p>
<table>
  <tr><th></th>${MODES.map(([, l]) => `<th>${l}</th>`).join("")}${MISSING.map(([, l]) => `<th>${l}</th>`).join("")}</tr>
  ${COUNTRIES.map((c) => `<tr><th class="row"><img src="${flag(c)}" alt="">${esc(names[c] ?? LABEL[c])}</th>${MODES.map(([m]) => `<td>${cell(c, m)}</td>`).join("")}${MISSING.map(() => `<td class="none"></td>`).join("")}</tr>`).join("\n  ")}
</table>
<div class="legend">${CLASSES.map(([k, l]) => `<span><i class="k-${k}"></i>${l}</span>`).join("")}</div>
<h2>Unit classes by the way of fighting (number of clips)</h2>
<table>
  <tr><th></th>${MODES.map(([, l]) => `<th>${l}</th>`).join("")}</tr>
  ${CLASSES.map(([k, l]) => `<tr><th class="row">${l}</th>${MODES.map(([m]) => { const v = classCell(k, m); return `<td${v ? "" : ' class="none"'}>${v}</td>`; }).join("")}</tr>`).join("\n  ")}
</table>
<h2 style="margin-top:22px">No clip yet</h2>
<ul>${MISSING.map(([, l]) => `<li>${l}</li>`).join("")}<li>Engineers, spies, repair, transports</li><li>Each country in more than two ways of fighting (the table's empty cells)</li></ul>
`;
const out = path.resolve(opt("out", "coverage.html"));
fs.writeFileSync(out, html);
console.log(out);
