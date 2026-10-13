"""SUPERSEDED (2026-10-13): its zoompan camera moves flicker. Briefings are now animated by the BeTenshi Video Forge
and cut by Montage: tools/briefings/commission.mjs <mission>, then tools/briefings/from-montage.mjs <mission>.
Kept for reference only.

Assemble a mission's motion briefing from its shot list (tools/briefings/<mission>.json), the art drawn by
tools/briefings/art.mjs and the score from the local ACE-Step engine (music.wav in the same folder).

Each shot is one image with a slow camera move (push in, pan, zoom on a target) for as long as its narration line
needs; shots cross-fade; the last one carries the chapter title. Narration is the project's Kokoro voice, the score
sits under it and ducks while the narrator speaks. Writes <mission>.mp4 (1280x720, H.264/AAC), <mission>.vtt
captions and a poster. Everything is local; nothing is downloaded.

  C:/Users/Admin/Code/AI/chatterbox/.venv/Scripts/python.exe tools/briefings/assemble.py jizan-corridor [--dir D:/rtsai-ea-build/briefings]
"""
import argparse, json, os, pathlib, shutil, subprocess

ap = argparse.ArgumentParser(); ap.add_argument('mission'); ap.add_argument('--dir', default='D:/rtsai-ea-build/briefings')
ap.add_argument('--voice', default='am_michael'); ap.add_argument('--speed', type=float, default=0.95)
opt = ap.parse_args()
HERE = pathlib.Path(__file__).resolve().parent
spec = json.loads((HERE / f'{opt.mission}.json').read_text(encoding='utf-8'))
work = pathlib.Path(opt.dir) / opt.mission
ffmpeg, ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe'); assert ffmpeg and ffprobe
W, H, FPS, FADE = 1280, 720, 30, 0.8

# 1. Narration, one line per shot (Kokoro, cached Hugging Face files only).
os.environ['HF_HUB_OFFLINE'] = '1'; os.environ.setdefault('HF_HOME', 'D:/AI Models/huggingface')
import numpy as np, soundfile as sf, torch
from kokoro import KModel, KPipeline
snap = next(p for p in (pathlib.Path(os.environ['HF_HOME']) / 'hub/models--hexgrad--Kokoro-82M/snapshots').iterdir() if (p / 'kokoro-v1_0.pth').exists())
device = 'cuda' if torch.cuda.is_available() else 'cpu'
model = KModel(repo_id='hexgrad/Kokoro-82M', config=str(snap / 'config.json'), model=str(snap / 'kokoro-v1_0.pth')).to(device).eval()
pipe = KPipeline(lang_code='a', repo_id='hexgrad/Kokoro-82M', model=model)
voice = torch.load(snap / f'voices/{opt.voice}.pt', weights_only=True)
lines = []
for shot in spec['shots']:
    audio = np.concatenate([r.audio.cpu().numpy() for r in pipe(shot['line'], voice=voice, speed=opt.speed)])
    wav = work / f"line-{shot['id']}.wav"; sf.write(wav, audio, 24000); lines.append((wav, len(audio) / 24000))

# 2. Timeline: each shot lasts its line plus breathing room; neighbours overlap by the cross-fade.
LEAD, TAIL, TITLE_HOLD = 1.0, 1.1, 3.2
durs, starts, t = [], [], 0.0
for i, (shot, (_, speech)) in enumerate(zip(spec['shots'], lines)):
    d = max(4.5, (LEAD if i == 0 else 0.5) + speech + TAIL + (TITLE_HOLD if shot.get('title') else 0))
    durs.append(d); starts.append(t); t += d - FADE
total = t + FADE
speech_at = [starts[i] + (LEAD if i == 0 else 0.5 + FADE / 2) for i in range(len(durs))]

# 3. One clip per shot: the image scaled up, then a slow move (zoompan) to 1280x720.
def move(kind, frames):
    p = f'(on/{frames})'  # 0..1 over the clip
    if kind == 'push-in': return f"z='1+0.12*{p}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
    if kind == 'push-in-slow': return f"z='1+0.06*{p}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
    if kind == 'pan-right': return f"z='1.14':x='(iw-iw/zoom)*{p}':y='ih/2-(ih/zoom/2)'"
    if kind == 'pan-left': return f"z='1.14':x='(iw-iw/zoom)*(1-{p})':y='ih/2-(ih/zoom/2)'"
    if kind == 'zoom-target': return f"z='1+0.22*{p}':x='(iw*0.62)-(iw/zoom/2)':y='(ih*0.45)-(ih/zoom/2)'"
    return "z='1':x='0':y='0'"
clips = []
for i, shot in enumerate(spec['shots']):
    frames = round(durs[i] * FPS); clip = work / f"clip-{shot['id']}.mp4"
    vf = (f"scale={W*2}:{H*2}:force_original_aspect_ratio=increase,crop={W*2}:{H*2},"
          f"zoompan={move(shot.get('motion', 'push-in'), frames)}:d={frames}:s={W}x{H}:fps={FPS},format=yuv420p")
    if shot.get('title'):
        font = 'C\\:/Windows/Fonts/segoeuib.ttf'
        appear = max(0.0, durs[i] - TITLE_HOLD - 0.4)
        vf += (f",drawbox=x=0:y=ih*0.62:w=iw:h=ih*0.38:color=black@0.45:t=fill:enable='gte(t,{appear:.2f})'"
               f",drawtext=fontfile='{font}':text='{spec['chapter'].upper()}':fontsize=22:fontcolor=0xA8924F:x=(w-text_w)/2:y=h*0.70:alpha='min(1,max(0,(t-{appear:.2f})/0.6))'"
               f",drawtext=fontfile='{font}':text='{spec['title']}':fontsize=58:fontcolor=0xF1D28B:borderw=2:bordercolor=black@0.6:x=(w-text_w)/2:y=h*0.75:alpha='min(1,max(0,(t-{appear + 0.3:.2f})/0.6))'")
    subprocess.run([ffmpeg, '-loglevel', 'error', '-y', '-loop', '1', '-i', str(work / f"{shot['id']}.png"), '-vf', vf, '-frames:v', str(frames), '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', str(clip)], check=True)
    clips.append(clip)

# 4. Cross-fade the clips, mix voice over the ducked score, fade the ends, normalise loudness.
inputs = sum([['-i', str(c)] for c in clips], []) + sum([['-i', str(w)] for w, _ in lines], []) + ['-i', str(work / 'music.wav')]
n = len(clips); g = []
prev = '0:v'
for i in range(1, n):
    off = starts[i]
    g.append(f'[{prev}][{i}:v]xfade=transition=fade:duration={FADE}:offset={off:.3f}[v{i}]'); prev = f'v{i}'
g.append(f'[{prev}]fade=t=in:st=0:d=0.8,fade=t=out:st={total-1.2:.3f}:d=1.2[vout]')
for i in range(n):
    ms = round(speech_at[i] * 1000)
    g.append(f'[{n+i}:a]aresample=48000,adelay={ms}|{ms},apad[l{i}]')
g.append(''.join(f'[l{i}]' for i in range(n)) + f'amix=inputs={n}:normalize=0,atrim=0:{total:.3f},asplit=2[voice][key]')
g.append(f'[{2*n}:a]aresample=48000,atrim=0:{total:.3f},volume=0.55[music]')
g.append('[music][key]sidechaincompress=threshold=0.02:ratio=8:attack=40:release=600[ducked]')
g.append(f'[voice][ducked]amix=inputs=2:normalize=0,afade=t=in:st=0:d=0.6,afade=t=out:st={total-2:.3f}:d=2,loudnorm=I=-16:TP=-1.5:LRA=11[aout]')
out = work / f'{opt.mission}.mp4'
subprocess.run([ffmpeg, '-loglevel', 'error', '-y', *inputs, '-filter_complex', ';'.join(g), '-map', '[vout]', '-map', '[aout]',
                '-c:v', 'libx264', '-crf', '23', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '128k', '-t', f'{total:.3f}', str(out)], check=True)

# 5. Captions and poster.
def tc(s):
    ms = round(s * 1000); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); sec, ms = divmod(ms, 1000)
    return f'{h:02}:{m:02}:{sec:02}.{ms:03}'
cues = [f"{tc(speech_at[i])} --> {tc(speech_at[i] + lines[i][1] + 0.3)}\n{shot['line']}" for i, shot in enumerate(spec['shots'])]
(work / f'{opt.mission}.vtt').write_text('WEBVTT\n\n' + '\n\n'.join(cues) + '\n', encoding='utf-8')
subprocess.run([ffmpeg, '-loglevel', 'error', '-y', '-i', str(work / f"{spec['shots'][0]['id']}.png"), '-vf', f'scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}', '-q:v', '80', str(work / f'{opt.mission}-poster.webp')], check=True)
print(json.dumps({'video': str(out), 'seconds': round(total, 1), 'bytes': out.stat().st_size}))
