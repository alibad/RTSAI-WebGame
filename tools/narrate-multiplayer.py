"""Generate and assemble local neural narration over the actual browser footage."""
import json
import os
from pathlib import Path
import subprocess
import shutil
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ.setdefault('HF_HOME', 'D:/AI Models/huggingface')
import numpy as np
import soundfile as sf
import torch
from kokoro import KModel, KPipeline

ROOT = Path('artifacts/videos/multiplayer')
FFMPEG = os.environ.get('RTSAI_FFMPEG', 'ffmpeg')
FFPROBE = str(Path(FFMPEG).with_name('ffprobe.exe')) if Path(FFMPEG).is_absolute() else 'ffprobe'
OUT = ROOT / 'narration'
OUT.mkdir(parents=True, exist_ok=True)

FULL = [
 ('intro', 'Want to take on a friend, or team up against the computer? Here is how multiplayer works in R T S, A I.'),
 ('01-create', 'One player hosts. Create a private room, and you are in control of the battlefield.'),
 ('02-invite', 'Copy the invite and share it with your second commander.'),
 ('03-join', 'They paste the link, hit Join Room, and enter your lobby. No account setup to get in the way.'),
 ('04-map-ai', 'Pick your map, then add computer opponents if you want a bigger challenge.'),
 ('05-faction', 'Choose your factions. Fight each other, or choose the same team and take on the computer together.'),
 ('06-ready', 'Once everyone is happy with the setup, both players press Ready.'),
 ('07-start', 'The host starts the match. Now you are both in the same battle, with your own base to command.'),
 ('08-match', 'Deploy your base, plan your opening, and coordinate in room chat. Play head to head, or bring an ally and face the computer together. Build up, make your move, and find out whose strategy wins.'),
 ('end', 'This room preview runs locally, in two browser profiles on one computer. Grab a commander, and try your first match.'),
]
QUICK = [
 ('quick-intro', 'Bring a friend. Take command. This is multiplayer in R T S, A I.'),
 ('quick-1', 'Create a private room. You choose the battlefield.'),
 ('quick-2', 'Copy the invite for your second commander.'),
 ('quick-3', 'They join, choose their faction, and get ready.'),
 ('quick-4', 'Both ready? The host starts the match.'),
 ('quick-5', 'Deploy your bases and coordinate in chat. Your strategy starts here.'),
 ('end', 'Try the local desktop preview with two browser profiles on one computer.'),
]

def run(args):
    subprocess.run(args, check=True)

def duration(file):
    return float(subprocess.check_output([FFPROBE, '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', str(file)], text=True))

def stamp(t):
    ms = round(t * 1000)
    return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02}.{ms%1000:03}'

cache = Path(os.environ['HF_HOME']) / 'hub/models--hexgrad--Kokoro-82M/snapshots'
snapshot = next(p for p in cache.iterdir() if (p / 'kokoro-v1_0.pth').exists() and (p / 'voices/am_michael.pt').exists())
torch.set_num_threads(4)
device = 'cuda' if torch.cuda.is_available() else 'cpu'
model = KModel(repo_id='hexgrad/Kokoro-82M', config=str(snapshot / 'config.json'), model=str(snapshot / 'kokoro-v1_0.pth')).to(device).eval()
pipe = KPipeline(lang_code='a', repo_id='hexgrad/Kokoro-82M', model=model)
voice = torch.load(snapshot / 'voices/am_michael.pt', weights_only=True)
previous = {}
brand_pronunciation = 'R, T, S. A, I.'
previous_brand = ''
if (OUT / 'takes.json').exists():
    old = json.loads((OUT / 'takes.json').read_text(encoding='utf-8'))
    previous_brand = old.get('brandPronunciation', '')
    if old.get('voice') == 'am_michael' and old.get('engine') == 'Kokoro-82M':
        previous = {(t['video'], t['take']): t['text'] for t in old['takes']}
ledger = []
for name, takes in [('multiplayer-walkthrough-narrated', FULL), ('multiplayer-quick-intro-narrated', QUICK)]:
    pieces, captions, time = [], [], 0.0
    for i, (clip, text) in enumerate(takes):
        wav = OUT / f'{name}-{i:02}.wav'
        if not wav.exists() or previous.get((name, i)) != text or ('R T S, A I' in text and previous_brand != brand_pronunciation):
            results = list(pipe(text.replace('R T S, A I', brand_pronunciation), voice=voice, speed=0.98))
            audio = np.concatenate([r.audio.cpu().numpy() for r in results])
            assert len(audio) > 1000 and np.isfinite(audio).all()
            sf.write(wav, audio, 24000)
            (OUT / f'{name}-{i:02}-pronunciation.txt').write_text('\n'.join(r.phonemes for r in results), encoding='utf-8')
        speech_duration = sf.info(wav).duration
        video = ROOT / 'edit' / f'{clip}.mp4'
        length = max(duration(video), speech_duration + 0.35)
        target = OUT / f'{name}-{i:02}.mp4'
        # Preserve speech at its natural speed; extend the picture where needed.
        if not target.exists() or target.stat().st_mtime < max(video.stat().st_mtime, wav.stat().st_mtime):
            run([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-i', str(video), '-i', str(wav), '-t', str(length),
             '-vf', 'tpad=stop_mode=clone:stop_duration=30',
             '-af', 'loudnorm=I=-16:TP=-1.5:LRA=7,afade=t=in:d=0.04,apad',
             '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-threads', '4', '-pix_fmt', 'yuv420p',
             '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', str(target)])
        actual = duration(target)
        pieces.append(target)
        display_text = text.replace('R T S, A I', 'RTS AI')
        captions.append(f'{stamp(time)} --> {stamp(time + speech_duration)}\n{display_text}\n')
        ledger.append(dict(video=name, take=i, clip=clip, text=text, speechSeconds=round(speech_duration, 3), start=round(time, 3), duration=actual))
        time += actual
        print(f'{name}/{clip}: voice {speech_duration:.2f}s, picture {actual:.2f}s', flush=True)
    listing = OUT / f'{name}-concat.txt'
    listing.write_text('\n'.join("file '" + str(p.resolve()).replace('\\', '/') + "'" for p in pieces), encoding='utf-8')
    final = ROOT / f'{name}.mp4'
    run([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', str(listing), '-c', 'copy', '-movflags', '+faststart', str(final)])
    (ROOT / f'{name}.vtt').write_text('WEBVTT\n\n' + '\n'.join(captions), encoding='utf-8')
    srt = []
    for index, cue in enumerate(captions, 1):
        timing, text = cue.strip().split('\n', 1)
        srt.append(f'{index}\n{timing.replace(".", ",")}\n{text}\n')
    (ROOT / f'{name}.srt').write_text('\n'.join(srt), encoding='utf-8')
    (ROOT / f'{name}-transcript.txt').write_text('\n\n'.join(text.replace('R T S, A I', 'RTS AI') for _, text in takes), encoding='utf-8')
    # Previous user-facing links must open the corrected version with sound.
    alias = name.replace('-narrated', '')
    for extension in ['mp4', 'vtt', 'srt']:
        original = ROOT / f'{alias}.{extension}'
        backup = ROOT / f'{alias}-silent.{extension}'
        if original.exists() and not backup.exists():
            shutil.copy2(original, backup)
        shutil.copy2(ROOT / f'{name}.{extension}', original)
    print(f'FINISHED {final}: {duration(final):.2f}s', flush=True)
(OUT / 'takes.json').write_text(json.dumps(dict(engine='Kokoro-82M', voice='am_michael', brandPronunciation=brand_pronunciation, device=device, speed=0.98, modelCard='https://huggingface.co/hexgrad/Kokoro-82M', snapshot=str(snapshot), takes=ledger), indent=2), encoding='utf-8')
