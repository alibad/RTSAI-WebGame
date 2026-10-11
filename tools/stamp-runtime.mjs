import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const dir = path.resolve(process.argv[2]);
const resources = fs.readdirSync(dir).filter(name => /\.(js|wasm)$/.test(name)).sort().map(name => ({ name, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex') }));
if (!resources.some(r => r.name === 'OpenRA.WebSim.wasm') || !resources.some(r => r.name === 'dotnet.native.wasm')) throw Error('Incomplete runtime');
const identity = crypto.createHash('sha256').update(JSON.stringify(resources)).digest('hex');
fs.writeFileSync(path.join(dir, 'runtime-identity.json'), JSON.stringify({ schema: 1, identity, resources }) + '\n');
console.log(identity);
