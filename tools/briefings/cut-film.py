"""Cut a mission briefing film from an edit list: generated cinematic clips (the forge's Wan shots) intercut with real
in-engine footage of the mission (tools/briefings/game-footage.mjs), narrated, scored, with objective cards over the
game shots, captions and a title card. This replaces Montage's cut for campaign films: Montage (or the forge) supplies
parts (clips, narration takes, a score); the film itself is edited here around what the mission really looks like.

Edit list (tools/briefings/cuts/<mission>.json):
  { "mission", "chapter", "title", "music": "<audio file>", "musicVolume": 0.5,
    "segments": [ { "src": "<mp4>", "kind": "cinema" | "game", "in": 0, "dur": 6,
                    "voice": "<wav>" | null, "line": "<narration>",
                    "card": { "kicker": "Objective 1", "text": "Capture Radar Node Seven." } } ] }
A segment lasts "dur" seconds, or long enough for its narration (voice file, else the line read by Chatterbox on
:8004 when it answers, else Kokoro am_michael). A clip shorter than its segment is slowed a little, then held.
Cuts between cinema and game footage use a short "signal" transition (pixelize); the rest cross-fade.

  python tools/briefings/cut-film.py tools/briefings/cuts/jizan-corridor.json --out D:/rtsai-campaign/campaign-v2
Writes <out>/<mission>/briefing.mp4 (1280x720 H.264, AAC), briefing.vtt, poster.webp and updates <out>/index.json.
"""
import argparse, hashlib, json, os, pathlib, shutil, subprocess, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument('edit')
ap.add_argument('--out', required=True)
ap.add_argument('--work', default='D:/rtsai-campaign/cut-work')
ap.add_argument('--chatterbox', default='http://127.0.0.1:8004')
opt = ap.parse_args()

edit = json.loads(pathlib.Path(opt.edit).read_text(encoding='utf-8'))
mission = edit['mission']
work = pathlib.Path(opt.work) / mission
work.mkdir(parents=True, exist_ok=True)
outdir = pathlib.Path(opt.out) / mission
outdir.mkdir(parents=True, exist_ok=True)
ffmpeg, ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe')
assert ffmpeg and ffprobe
W, H, FPS = 1280, 720, 30
T = 0.6            # transition length
LEAD, TAIL = 0.45, 0.75
TITLE_HOLD = 3.4
FONT = 'C\\:/Windows/Fonts/bahnschrift.ttf'
FONT_B = 'C\\:/Windows/Fonts/segoeuib.ttf'


def probe(path):
    return float(subprocess.check_output([ffprobe, '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)]).decode().strip())


def fpath(p):
    """A path inside an ffmpeg filter argument."""
    return str(p).replace('\\', '/').replace(':', '\\:')


def say(line):
    """Narration for a line with no recorded take: Chatterbox if its service answers, else Kokoro."""
    key = hashlib.sha256(line.encode()).hexdigest()[:16]
    wav = work / f'tts-{key}.wav'
    if wav.exists():
        return wav
    try:
        req = urllib.request.Request(f'{opt.chatterbox}/v1/audio/speech', data=json.dumps({'input': line, 'voice': 'default', 'response_format': 'wav'}).encode(),
                                     headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=180) as r:
            wav.write_bytes(r.read())
        return wav
    except Exception as err:  # noqa: BLE001 - any failure falls back to Kokoro
        print('chatterbox unavailable, Kokoro reads:', line[:40], err)
    py = 'C:/Users/Admin/Code/AI/chatterbox/.venv/Scripts/python.exe'
    script = work / 'kokoro_say.py'
    script.write_text(
        "import os,sys,pathlib,numpy as np,soundfile as sf,torch\n"
        "os.environ['HF_HUB_OFFLINE']='1';os.environ.setdefault('HF_HOME','D:/AI Models/huggingface')\n"
        "from kokoro import KModel,KPipeline\n"
        "snap=next(p for p in (pathlib.Path(os.environ['HF_HOME'])/'hub/models--hexgrad--Kokoro-82M/snapshots').iterdir() if (p/'kokoro-v1_0.pth').exists())\n"
        "m=KModel(repo_id='hexgrad/Kokoro-82M',config=str(snap/'config.json'),model=str(snap/'kokoro-v1_0.pth')).to('cpu').eval()\n"
        "p=KPipeline(lang_code='a',repo_id='hexgrad/Kokoro-82M',model=m)\n"
        "v=torch.load(snap/'voices/am_michael.pt',weights_only=True)\n"
        "a=np.concatenate([r.audio.cpu().numpy() for r in p(sys.argv[1],voice=v,speed=0.95)])\n"
        "sf.write(sys.argv[2],a,24000)\n", encoding='utf-8')
    subprocess.run([py, str(script), line, str(wav)], check=True)
    return wav


# 1. Durations: each segment is long enough for its narration.
segs = edit['segments']
for s in segs:
    s['voiceFile'] = s.get('voice') or (say(s['line']) if s.get('line') else None)
    s['speech'] = probe(s['voiceFile']) if s['voiceFile'] else 0.0
    s['srcLen'] = probe(s['src']) - float(s.get('in', 0))
    need = LEAD + s['speech'] + TAIL if s['speech'] else 0
    s['D'] = max(float(s.get('dur', 0)), need, 2.5)
segs[-1]['D'] += TITLE_HOLD
starts, t = [], 0.0
for s in segs:
    starts.append(t)
    t += s['D'] - T
total = t + T

# 2. One normalised clip per segment (1280x720, 30 fps, exact length, card burned in for game shots).
clips = []
for i, s in enumerate(segs):
    clip = work / f'seg{i:02d}.mp4'
    stretch = min(1.35, max(1.0, s['D'] / max(s['srcLen'], 0.1)))
    zoom = float(s.get('zoom', 1.0))  # punch in on the centre (game footage is 1080p, so up to 1.5 costs no detail at 720p)
    vf = [f"trim=start={float(s.get('in', 0)):.3f}", 'setpts=PTS-STARTPTS', f'setpts={stretch:.4f}*PTS',
          f'crop=iw/{zoom:.3f}:ih/{zoom:.3f}',
          f'scale={W}:{H}:force_original_aspect_ratio=increase:flags=lanczos', f'crop={W}:{H}', f'fps={FPS}',
          f"tpad=stop_mode=clone:stop_duration={s['D']:.3f}", f"trim=duration={s['D']:.3f}", 'format=yuv420p']
    if s.get('kind') == 'game':
        vf.insert(-1, 'eq=saturation=1.08:contrast=1.04')
    card = s.get('card')
    if card:
        (work / f'k{i}.txt').write_text(card.get('kicker', '').upper(), encoding='utf-8')
        (work / f'c{i}.txt').write_text(card['text'], encoding='utf-8')
        a = f"if(lt(t,0.35),0,min(1,(t-0.35)/0.35))"
        vf.insert(-1, f"drawbox=x=48:y=ih-150:w=iw*0.52:h=104:color=0x0B0F14@0.72:t=fill:enable='gte(t,0.3)'")
        vf.insert(-1, f"drawbox=x=48:y=ih-150:w=5:h=104:color=0xE8B34A@0.95:t=fill:enable='gte(t,0.3)'")
        vf.insert(-1, f"drawtext=fontfile='{FONT}':textfile='{fpath(work / f'k{i}.txt')}':fontsize=19:fontcolor=0xE8B34A:x=72:y=h-136:alpha='{a}'")
        vf.insert(-1, f"drawtext=fontfile='{FONT}':textfile='{fpath(work / f'c{i}.txt')}':fontsize=30:fontcolor=0xF3F1EA:x=72:y=h-104:alpha='{a}'")
    if i == len(segs) - 1:
        (work / 'chapter.txt').write_text(edit['chapter'].upper(), encoding='utf-8')
        (work / 'title.txt').write_text(edit['title'], encoding='utf-8')
        appear = max(0.0, s['D'] - TITLE_HOLD - 0.2)
        vf.insert(-1, f"drawbox=x=0:y=ih*0.60:w=iw:h=ih*0.40:color=black@0.5:t=fill:enable='gte(t,{appear:.2f})'")
        vf.insert(-1, f"drawtext=fontfile='{FONT}':textfile='{fpath(work / 'chapter.txt')}':fontsize=22:fontcolor=0xD8B25A:x=(w-text_w)/2:y=h*0.69:alpha='min(1,max(0,(t-{appear:.2f})/0.6))'")
        vf.insert(-1, f"drawtext=fontfile='{FONT_B}':textfile='{fpath(work / 'title.txt')}':fontsize=60:fontcolor=0xF6DE9A:borderw=2:bordercolor=black@0.6:x=(w-text_w)/2:y=h*0.745:alpha='min(1,max(0,(t-{appear + 0.3:.2f})/0.6))'")
    subprocess.run([ffmpeg, '-loglevel', 'error', '-y', '-i', str(s['src']), '-an', '-vf', ','.join(vf), '-r', str(FPS),
                    '-c:v', 'libx264', '-crf', '16', '-preset', 'fast', str(clip)], check=True)
    clips.append(clip)

# 3. Join with transitions; lay narration over a ducked score.
inputs = sum([['-i', str(c)] for c in clips], [])
g, prev = [], '0:v'
for i in range(1, len(clips)):
    kinds = {segs[i - 1].get('kind', 'cinema'), segs[i].get('kind', 'cinema')}
    trans = 'pixelize' if kinds == {'cinema', 'game'} else 'fade'
    g.append(f'[{prev}][{i}:v]xfade=transition={trans}:duration={T}:offset={starts[i]:.3f}[v{i}]')
    prev = f'v{i}'
g.append(f'[{prev}]fade=t=in:st=0:d=0.7,fade=t=out:st={total - 1.2:.3f}:d=1.2[vout]')
voiced = [(i, s) for i, s in enumerate(segs) if s['voiceFile']]
n = len(clips)
for k, (i, s) in enumerate(voiced):
    inputs += ['-i', str(s['voiceFile'])]
    ms = round((starts[i] + LEAD) * 1000)
    g.append(f'[{n + k}:a]aresample=48000,aformat=channel_layouts=stereo,adelay={ms}|{ms},apad[l{k}]')
m = len(voiced)
g.append(''.join(f'[l{k}]' for k in range(m)) + f'amix=inputs={m}:normalize=0,atrim=0:{total:.3f},asplit=2[voice][key]')
inputs += ['-stream_loop', '-1', '-i', str(edit['music'])]
g.append(f"[{n + m}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:{total:.3f},volume={edit.get('musicVolume', 0.5)}[music]")
g.append('[music][key]sidechaincompress=threshold=0.02:ratio=6:attack=40:release=700[ducked]')
g.append(f'[voice][ducked]amix=inputs=2:normalize=0,afade=t=in:st=0:d=0.6,afade=t=out:st={total - 2:.3f}:d=2,loudnorm=I=-16:TP=-1.5:LRA=11[aout]')
film = outdir / 'briefing.mp4'
subprocess.run([ffmpeg, '-loglevel', 'error', '-y', *inputs, '-filter_complex', ';'.join(g), '-map', '[vout]', '-map', '[aout]',
                '-c:v', 'libx264', '-crf', '23', '-preset', 'slow', '-maxrate', '1400k', '-bufsize', '2800k', '-pix_fmt', 'yuv420p',
                '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '128k', '-t', f'{total:.3f}', str(film)], check=True)


# 4. Captions, poster, index.
def tc(x):
    ms = round(x * 1000); h, ms = divmod(ms, 3600000); mi, ms = divmod(ms, 60000); sec, ms = divmod(ms, 1000)
    return f'{h:02}:{mi:02}:{sec:02}.{ms:03}'


cues = [f"{tc(starts[i] + LEAD)} --> {tc(starts[i] + LEAD + s['speech'] + 0.3)}\n{s['line']}" for i, s in voiced if s.get('line')]
(outdir / 'briefing.vtt').write_text('WEBVTT\n\n' + '\n\n'.join(cues) + '\n', encoding='utf-8')
poster_at = next((starts[i] + min(2.5, segs[i]['D'] / 2) for i, s in enumerate(segs) if s.get('poster')), min(3.0, total / 3))
subprocess.run([ffmpeg, '-loglevel', 'error', '-y', '-ss', f'{poster_at:.2f}', '-i', str(film), '-frames:v', '1', '-quality', '80', str(outdir / 'poster.webp')], check=True)
index_file = pathlib.Path(opt.out) / 'index.json'
index = json.loads(index_file.read_text(encoding='utf-8')) if index_file.exists() else {'briefings': []}
index['briefings'] = [b for b in index['briefings'] if b['mission'] != mission] + [
    {'mission': mission, 'title': edit['title'], 'eyebrow': edit['chapter'], 'seconds': round(total, 1)}]
from datetime import datetime, timezone
index['updatedAt'] = datetime.now(timezone.utc).isoformat()
index_file.write_text(json.dumps(index, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'film': str(film), 'seconds': round(total, 1), 'bytes': film.stat().st_size, 'segments': len(segs)}))
