// Full native missions through ordinary browser Auto orders. Never changes objectives, actors or resources.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
const args=process.argv.slice(2), opt=(k,d)=>{const i=args.indexOf('--'+k);return i<0?d:args[i+1];};
const out=path.resolve(opt('out','artifacts/campaign-victory-20261016/baseline'));
const url=opt('url','http://127.0.0.1:3486/?mode=missions&profile=public');
const missions=JSON.parse(fs.readFileSync('content/missions.json','utf8')).map(m=>m.id);
const selected=opt('missions',missions.join(',')).split(',');
const queue=[...selected], reports=[];fs.mkdirSync(out,{recursive:true});
await Promise.all(Array.from({length:Number(opt('jobs','2'))},async()=>{
 for(let id;id=queue.shift();){
  if(!missions.includes(id))throw Error('Unknown mission '+id);
  console.log('START',id);
  const log=fs.openSync(path.join(out,id+'.log'),'w');
  const child=spawn(process.execPath,['tools/chapters-playtest.mjs',id,opt('difficulty','normal'),'--runs','1','--speed',opt('speed','8'),'--limit',opt('limit','25'),'--url',url,'--out',out],{stdio:['ignore',log,log]});
  const watchdog=setTimeout(()=>child.kill(),25*60000);
  const code=await new Promise(resolve=>child.on('exit',resolve));clearTimeout(watchdog);fs.closeSync(log);
  const file=path.join(out,id+'-results.json');
  const result=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8'))[0]:{mission:id,error:'No report; exit '+code};
  reports.push(result);console.log('FINISH',id,result.win??result.error,result.minutes??'');
  fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify({url,scope:'Actual unchanged campaign objectives, fog on, normal resources, ordinary Auto player orders; no director or cheats',reports},null,2));
 }
}));
if(reports.some(r=>r.win!=='Won'))process.exitCode=1;
