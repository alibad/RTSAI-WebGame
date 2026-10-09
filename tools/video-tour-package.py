import pathlib,json,subprocess,shutil,html,zipfile,re
from PIL import Image,ImageDraw,ImageFont
root=pathlib.Path(__file__).resolve().parents[1]/'artifacts/app-videos'
items=json.loads((root/'render-results.json').read_text());assert len(items)==9
ffmpeg=shutil.which('ffmpeg');probe=shutil.which('ffprobe');checks=[];cards=[];fulltext=[];offset=0;chapters=[]
sheet=Image.new('RGB',(1440,990),'#0b100d');draw=ImageDraw.Draw(sheet);font=ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf',18)
for i,item in enumerate(items):
 video=root/item['file']; info=json.loads(subprocess.check_output([probe,'-v','error','-show_streams','-show_format','-of','json',str(video)]))
 assert any(s['codec_type']=='video' and s['width']==1920 and s['height']==1080 for s in info['streams'])
 assert any(s['codec_type']=='audio' for s in info['streams'])
 subprocess.run([ffmpeg,'-hide_banner','-loglevel','error','-i',str(video),'-f','null','-'],check=True)
 image=root/(item['id']+'-poster.jpg')
 subprocess.run([ffmpeg,'-hide_banner','-loglevel','error','-y','-ss','5','-i',str(video),'-frames:v','1','-q:v','3',str(image)],check=True)
 pic=Image.open(image);pic.thumbnail((456,257));x=12+i%3*480;y=12+i//3*330;sheet.paste(pic,(x,y));draw.text((x,y+265),item['title'][:45],font=font,fill='#efd096')
 srt=(root/(item['id']+'.srt')).read_text();(root/(item['id']+'.vtt')).write_text('WEBVTT\n\n'+re.sub(r'(\d{2}:\d{2}:\d{2}),(\d{3})',r'\1.\2',srt),encoding='utf8')
 title=html.escape(item['title']);duration=float(info['format']['duration']);checks.append({'file':video.name,'duration':duration,'decoded':True,'audio':True,'resolution':'1920x1080'})
 chapters.append({'title':item['title'],'seconds':round(offset,2)});offset+=duration
 fulltext.append((root/(item['id']+'.md')).read_text())
 cards.append(f'<article><h2>{title}</h2><p>{round(duration/60,1)} minutes · English narration</p><video controls preload="metadata" poster="{image.name}"><source src="{video.name}" type="video/mp4"><track kind="captions" src="{item["id"]}.vtt" srclang="en" label="English" default></video><p><a href="{video.name}" download>Download MP4</a> · <a href="{item["id"]}.md">Transcript</a> · <a href="{item["id"]}.srt" download>Captions</a></p></article>')
sheet.save(root/'series-overview.jpg')
concat=root/'sources/full-tour-concat.txt';concat.write_text('\n'.join("file '"+str((root/i['file']).as_posix())+"'" for i in items),encoding='utf8')
subprocess.run([ffmpeg,'-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',str(concat),'-c','copy','-movflags','+faststart',str(root/'full-app-tour.mp4')],check=True)
(root/'full-transcript.md').write_text('# RTS AI browser app: complete walkthrough\n\n'+'\n'.join(fulltext),encoding='utf8')
(root/'chapters.json').write_text(json.dumps(chapters,indent=2))
(root/'verification.json').write_text(json.dumps({'passed':True,'chapters':checks,'totalSeconds':round(offset,2),'captionTiming':'Sentence timing measured from individually generated neural speech.' if (root/'narration.json').exists() else 'Sentence timing estimated proportionally from local narration duration.','scope':'Current local browser build. Multiplayer interfaces reviewed; remote connections not acceptance-tested for this series.'},indent=2))
(root/'index.html').write_text('''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>RTS AI — Video walkthroughs</title><style>*{box-sizing:border-box}body{margin:0;background:#0b100d;color:#e2eae3;font:16px/1.5 system-ui}main{max-width:1400px;margin:auto;padding:40px}h1,h2{color:#efd096}h1{font-size:38px}h2{font-size:21px}p{color:#aabeb0}a{color:#8bd6a1}video{width:100%;background:#000;border-radius:8px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:22px}article{background:#151e17;border:1px solid #354b3c;border-radius:12px;padding:20px}.hero{margin-bottom:28px}.hero video{max-height:65vh}@media(max-width:850px){main{padding:18px}.grid{grid-template-columns:1fr}}</style><main><p>RTS AI / LOCAL BROWSER BUILD / 9 OCTOBER 2026</p><h1>How the app works</h1><p>Nine narrated chapters with actual app captures, gameplay footage, and clearly labeled recommendations. Updated narration: local Kokoro neural voice, Michael. Scope: this browser build; the wider Classic/isometric consolidation is a product direction, not a completed claim.</p><article class="hero"><h2>Complete walkthrough</h2><video controls preload="metadata" poster="01-start-here-poster.jpg" src="full-app-tour.mp4"></video><p><a href="full-app-tour.mp4" download>Download complete video</a> · <a href="full-transcript.md">Complete transcript</a> · <a href="walkthrough-series.zip" download>Download chapter pack</a></p></article><div class="grid">'''+''.join(cards)+'''</div><p>Rendered locally at 1080p. Narration: local Kokoro neural speech, Michael voice. Caption timing follows the generated speech. The multiplayer chapter describes interfaces and code, without claiming remote connection verification. No deployment was performed.</p></main></html>''',encoding='utf8')
with zipfile.ZipFile(root/'walkthrough-series.zip','w',zipfile.ZIP_DEFLATED) as z:
 for p in root.iterdir():
  if p.is_file() and p.suffix in ['.mp4','.md','.srt','.vtt','.jpg','.html','.json']:z.write(p,p.name)
print(json.dumps({'passed':True,'videos':len(items),'minutes':round(offset/60,1),'output':str(root)},indent=2))
