import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const args=process.argv.slice(2),option=name=>{const i=args.indexOf(`--${name}`);if(i<0||!args[i+1])throw Error(`Required --${name}`);return path.resolve(args[i+1]);};
const source=option('root'),script=option('script'),out=option('out');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function files(root){return fs.readdirSync(root,{withFileTypes:true}).flatMap(e=>{const p=path.join(root,e.name);if(e.isSymbolicLink())throw Error(`Symlink input: ${p}`);return e.isDirectory()?files(p):[p];});}
function identity(root){return sha(JSON.stringify(files(root).sort().map(f=>[path.relative(root,f),sha(fs.readFileSync(f))])));}
if(out===source||out.startsWith(source+path.sep)||source.startsWith(out+path.sep)||fs.existsSync(out))throw Error('Output must be a new independent directory.');
const buildFile=path.join(source,'BUILD.json'),build=JSON.parse(fs.readFileSync(buildFile,'utf8'));
if(build.integrationScripts?.length)throw Error('Use an unintegrated static build.');
for(const key of ['rtRoot','dataRoot'])if(typeof build[key]!=='string'||path.isAbsolute(build[key])||path.resolve(source,build[key]).startsWith(source+path.sep)===false)throw Error(`Unsafe ${key}`);
const preserved=Object.fromEntries(['rtRoot','dataRoot'].map(key=>[key,identity(path.resolve(source,build[key]))]));
const bytes=fs.readFileSync(script),scriptHash=sha(bytes),name=`integration-${scriptHash}.js`;
const index=fs.readFileSync(path.join(source,'index.html'),'utf8');
const entry=/<script\b([^>]*type="module"[^>]*?)src="([^"]+)"([^>]*)><\/script>/;
const match=index.match(entry);if(!match||!/^\.\/assets\/[A-Za-z0-9_.-]+\.js$/.test(match[2]))throw Error('Expected relative Vite module entry.');
const shim=`import "./${name}";\nimport "./${path.basename(match[2])}";\n`,shimName=`integration-entry-${sha(shim)}.js`;
fs.cpSync(source,out,{recursive:true});fs.rmSync(path.join(out,'INPUTS.json'),{force:true});
fs.writeFileSync(path.join(out,'assets',name),bytes);fs.writeFileSync(path.join(out,'assets',shimName),shim);
fs.writeFileSync(path.join(out,'index.html'),index.replace(entry,`<script$1src="./assets/${shimName}"$3></script>`));
for(const [key,value] of Object.entries(preserved))if(identity(path.resolve(out,build[key]))!==value)throw Error(`Changed immutable ${key}`);
const receipt={schema:1,inputRoot:source,inputBuildSha256:sha(fs.readFileSync(buildFile)),inputManifestSha256:fs.existsSync(path.join(source,'INPUTS.json'))?sha(fs.readFileSync(path.join(source,'INPUTS.json'))):null,script:{source:script,sha256:scriptHash,path:`assets/${name}`},entry:`assets/${shimName}`,preserved,managedRuntimeUnchanged:true,contentUnchanged:true,publication:'none',acceptance:'Registration verified by import order; actual event/analytics topology must be tested separately.'};
build.integrationScripts=[receipt.script];fs.writeFileSync(path.join(out,'BUILD.json'),JSON.stringify(build,null,2)+'\n');fs.writeFileSync(path.join(out,'STATIC-INTEGRATION.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt,null,2));
