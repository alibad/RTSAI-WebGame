// Compact metadata from the generated companion tree; native observations override generated fallback names.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=process.argv.slice(2).find(a=>!a.startsWith('--'))??path.resolve(repo,'../RTSAI-Mod/companion/services/companion/src/openra_ai_companion/data/tech_tree.json');
const data=JSON.parse(fs.readFileSync(source,'utf8')),out={};
for(const profile of ['rtsai','standalone'])for(const faction of Object.values(data.profiles[profile].factions))for(const [type,item] of Object.entries(faction.items)){
 const info={};for(const key of ['name','kind','queue','cost','order','provides','produces'])if(item[key]!==undefined)info[key]=item[key];
 out[type]=info;
}
// Which faction fields what: the browser adviser names only units the player's own faction can build (cocommander.ts).
const rosters={};
for(const profile of ['rtsai','standalone'])for(const [id,faction] of Object.entries(data.profiles[profile].factions))rosters[id]=[...new Set([...(rosters[id]??[]),...Object.keys(faction.items)])].sort();
fs.writeFileSync(path.join(repo,'web/src/adviser-rosters.json'),JSON.stringify(rosters)+'\n');
// --rosters: only the rosters (the tree's names are kept as they were last synced).
if(!process.argv.includes('--rosters'))
fs.writeFileSync(path.join(repo,'web/src/adviser-tree.json'),JSON.stringify(out,null,2)+'\n');
console.log(`Synced ${Object.keys(out).length} adviser actor definitions`);
