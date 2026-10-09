"""Replace narration locally, retaining the existing scene videos and script."""
import os,json,pathlib,subprocess,shutil,re,time
os.environ['HF_HUB_OFFLINE']='1';os.environ['TRANSFORMERS_OFFLINE']='1'
import numpy as np,soundfile as sf,torch
from kokoro import KModel,KPipeline
root=pathlib.Path(__file__).resolve().parents[1]/'artifacts/app-videos'
out=root/'neural';out.mkdir(exist_ok=True)
cache=pathlib.Path(os.environ['HF_HOME'])/'hub/models--hexgrad--Kokoro-82M/snapshots'
snapshot=next(p for p in cache.iterdir() if (p/'kokoro-v1_0.pth').exists())
torch.set_num_threads(4)
print('Loading cached Kokoro model on CUDA',flush=True)
model=KModel(repo_id='hexgrad/Kokoro-82M',config=str(snapshot/'config.json'),model=str(snapshot/'kokoro-v1_0.pth')).to('cuda').eval()
pipe=KPipeline(lang_code='a',repo_id='hexgrad/Kokoro-82M',model=model)
voice=torch.load(snapshot/'voices/am_michael.pt',weights_only=True)
manifest=json.loads((root/'manifest.json').read_text());results=[]
ffmpeg=shutil.which('ffmpeg');probe=shutil.which('ffprobe')
def stamp(s):
 ms=round(s*1000);h,ms=divmod(ms,3600000);m,ms=divmod(ms,60000);sec,ms=divmod(ms,1000);return f'{h:02}:{m:02}:{sec:02},{ms:03}'
for ch in manifest:
 parts=[];duration=0;cues=[]
 for n,sc in enumerate(ch['scenes']):
  name=f"{ch['id']}-{n+1}";wav=out/(name+'.wav');meta=out/(name+'.json');segment=out/(name+'.mp4')
  if not wav.exists() or not meta.exists():
   chunks=[];sentence_times=[];offset=0
   for sentence in re.split(r'(?<=[.!?])\s+',sc['narration']):
    spoken=sentence.replace('RTS AI','R T S A I').replace('JSON','jay son').replace('1080p','ten eighty pee')
    audio=np.concatenate([r.audio.cpu().numpy() for r in pipe(spoken,voice=voice,speed=0.98)])
    assert len(audio)>1000 and np.isfinite(audio).all()
    sentence_times.append({'text':sentence,'start':offset,'end':offset+len(audio)/24000})
    pause=np.zeros(round(24000*0.16),dtype=np.float32);chunks.extend([audio,pause]);offset+=(len(audio)+len(pause))/24000
   sf.write(wav,np.concatenate(chunks),24000)
   meta.write_text(json.dumps(sentence_times,indent=2),encoding='utf8')
  length=sf.info(wav).duration+0.5
  original=root/'sources'/(name+'.mp4')
  old=float(subprocess.check_output([probe,'-v','error','-show_entries','format=duration','-of','csv=p=0',str(original)]))
  subprocess.run([ffmpeg,'-hide_banner','-loglevel','error','-y','-i',str(original),'-i',str(wav),'-map','0:v:0','-map','1:a:0','-vf',f'setpts={length/old}*PTS,fps=24','-af','loudnorm=I=-16:TP=-1.5:LRA=11,apad','-t',str(length),'-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-movflags','+faststart',str(segment)],check=True)
  for cue in json.loads(meta.read_text()):cues.append(f"{len(cues)+1}\n{stamp(duration+cue['start'])} --> {stamp(duration+cue['end'])}\n{cue['text']}\n")
  duration+=length;parts.append(segment)
  print('Neural narration rendered:',name,round(length,1),'seconds',flush=True)
 concat=out/(ch['id']+'-concat.txt');concat.write_text('\n'.join("file '"+p.as_posix()+"'" for p in parts),encoding='utf8')
 target=out/(ch['id']+'.mp4');subprocess.run([ffmpeg,'-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',str(concat),'-c','copy','-movflags','+faststart',str(target)],check=True)
 shutil.copy2(target,root/target.name)
 (root/(ch['id']+'.srt')).write_text('\n'.join(cues),encoding='utf8')
 results.append({'id':ch['id'],'title':ch['title'],'duration':round(duration,2),'file':target.name,'bytes':target.stat().st_size})
 (root/'render-results.json').write_text(json.dumps(results,indent=2))
(root/'narration.json').write_text(json.dumps({'engine':'Kokoro-82M','voice':'am_michael','device':'cuda','source':'Existing local model weights','speed':0.98,'visuals':'Existing scene videos retained; timing adapted to speech','captions':'Sentence timings measured from individually generated audio','normalization':'-16 LUFS, -1.5 dBTP'},indent=2))
print('All nine chapters revoiced.',flush=True)
