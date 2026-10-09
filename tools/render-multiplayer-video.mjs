import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
const root=path.resolve('artifacts/videos/multiplayer'),meta=JSON.parse(fs.readFileSync(path.join(root,'shots.json')));
const ffmpeg=process.env.RTSAI_FFMPEG||'ffmpeg';
const font=path.relative(process.cwd(),'C:/Windows/Fonts/segoeui.ttf').replaceAll('\\','/');
const bold=path.relative(process.cwd(),'C:/Windows/Fonts/segoeuib.ttf').replaceAll('\\','/');
const rel=p=>path.relative(process.cwd(),p).replaceAll('\\','/');
fs.mkdirSync(path.join(root,'edit'),{recursive:true});
fs.mkdirSync(path.join(root,'text'),{recursive:true});
function textFile(id,text){const file=path.join(root,'text',`${id}.txt`);fs.writeFileSync(file,text);return rel(file);}
const local=textFile('scope','LOCAL DESKTOP PREVIEW');
const footer=textFile('footer','Recorded from two independent clients on the same computer. Internet and mobile play are not demonstrated.');
function draw(file,x,y,size,color='white',strong=false){return `drawtext=fontfile='${strong?bold:font}':textfile='${file}':x=${x}:y=${y}:fontsize=${size}:fontcolor=${color}`;}
const codec=['-an','-r','30','-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-threads','4','-movflags','+faststart'];
function run(args){return new Promise((resolve,reject)=>{const p=spawn(ffmpeg,['-hide_banner','-loglevel','error','-y',...args],{stdio:['ignore','ignore','pipe']});let err='';p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('close',code=>code?reject(Error(err)):resolve());});}
const segments=[];
async function card(id,lines,duration){const files=lines.map((t,i)=>textFile(`${id}-${i}`,t));const filters=files.map((f,i)=>draw(f,'(w-text_w)/2',240+i*105,i===0?54:i===1?38:27,i===0?'0xf1d28b':i===2?'0xa8b29f':'white',i===0));filters.push(draw(local,80,40,20,'0xf1d28b'));const target=path.join(root,'edit',`${id}.mp4`);await run(['-f','lavfi','-i','color=c=0x0b100a:s=1920x1080:r=30','-t',String(duration),'-vf',filters.join(','),...codec,target]);return {file:target,duration,caption:lines.join('. ')};}
segments.push(await card('intro',['RTS AI / MULTIPLAYER','Two commanders. One synchronized match.','Create a room. Share an invite. Ready up and play.'],4));
for(const s of meta.shots){const title=textFile(`${s.id}-title`,s.title),caption=textFile(`${s.id}-caption`,s.caption);const duration=s.id==='07-start'?Math.min(7,s.end-s.start):s.end-s.start;const target=path.join(root,'edit',`${s.id}.mp4`);
 const common=[draw(title,80,24,30,'0xf1d28b',true),draw(local,1500,30,18,'0xa8b29f'),draw(caption,'(w-text_w)/2',1000,30),draw(footer,'(w-text_w)/2',1050,17,'0x899780')];
 if(s.id==='08-match'){const one=textFile('player-1-label','PLAYER 1 / HOST'),two=textFile('player-2-label','PLAYER 2 / GUEST');
  const filter=`[0:v]scale=900:562,pad=960:740:30:115:color=0x0b100a[a];[1:v]scale=900:562,pad=960:740:30:115:color=0x0b100a[b];[a][b]hstack,pad=1920:1080:0:90:color=0x0b100a,${draw(one,50,160,24,'0xf1d28b',true)},${draw(two,1010,160,24,'0xf1d28b',true)},${common.join(',')}[out]`;
  await run(['-ss',String(s.start),'-i',meta.files[0],'-ss',String(s.peerStart),'-i',meta.files[1],'-t',String(duration),'-filter_complex',filter,'-map','[out]',...codec,target]);
 }else await run(['-ss',String(s.start),'-i',meta.files[s.client],'-t',String(duration),'-vf',`scale=1440:900,pad=1920:1080:240:80:color=0x0b100a,${common.join(',')}`,...codec,target]);
 segments.push({file:target,duration,caption:s.caption,id:s.id});console.log(`Rendered ${s.id}`);
}
segments.push(await card('end',['TRY THE LOCAL PREVIEW','Two browser profiles on the same computer.','Internet rooms and mobile multiplayer still need verification.'],5));
function stamp(sec,separator='.'){const ms=Math.round(sec*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}${separator}${String(ms%1000).padStart(3,'0')}`;}
async function exportVideo(name,list){const concat=path.join(root,'edit',`${name}.txt`);fs.writeFileSync(concat,list.map(s=>`file '${s.file.replaceAll('\\','/')}'`).join('\n'));const file=path.join(root,`${name}.mp4`);await run(['-f','concat','-safe','0','-i',concat,'-c','copy','-movflags','+faststart',file]);let t=0;const cues=list.map((s,i)=>{const start=t;t+=s.duration;return {index:i+1,start,end:t,text:s.caption};});fs.writeFileSync(path.join(root,`${name}.vtt`),'WEBVTT\n\n'+cues.map(c=>`${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n'));fs.writeFileSync(path.join(root,`${name}.srt`),cues.map(c=>`${c.index}\n${stamp(c.start,',')} --> ${stamp(c.end,',')}\n${c.text}\n`).join('\n'));console.log(`${name}: ${t.toFixed(1)} seconds`);return file;}
await exportVideo('multiplayer-walkthrough',segments);
// Short introduction, using the same real footage and retaining the local-preview label.
const quick=await card('quick-intro',['RTS AI / PLAY TOGETHER','Create. Invite. Join. Ready. Play.','A local desktop multiplayer preview.'],3);
const selected=[quick,...segments.filter(s=>['01-create','02-invite','03-join','06-ready','08-match'].includes(s.id)).map(s=>({...s,duration:Math.min(s.id==='08-match'?6:4,s.duration)})),segments.at(-1)];
// Trim short segments rather than only changing their caption duration.
for(let i=1;i<selected.length-1;i++){const s=selected[i],file=path.join(root,'edit',`quick-${i}.mp4`);await run(['-i',s.file,'-t',String(s.duration),...codec,file]);selected[i]={...s,file};}
await exportVideo('multiplayer-quick-intro',selected);
await run(['-ss','1','-i',path.join(root,'multiplayer-walkthrough.mp4'),'-frames:v','1',path.join(root,'poster.jpg')]);
