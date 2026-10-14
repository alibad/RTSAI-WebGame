"""Voice a campaign's radio calls (resources/campaign-story.json -> radio).

Each speaker has a fixed voice. --engine kokoro reads with the cached local Kokoro voice on the CPU. --engine chatterbox
(the film narrator's engine, more expressive) reads through the local Chatterbox service (betenshi service "voice",
:8004): each speaker is enrolled once as "rtsai-<speaker>" from a short reference read by their Kokoro voice, so the
characters keep distinct voices; a take whose pace is implausible is read again, then falls back to Kokoro.
Commanders and Lantern go through a field-radio filter, the Broker through a colder, slightly processed one. Writes
<out>/<mission>/radio-<n>.mp3 and sets each call's "audio" field to that path (relative to the campaign folder on the
CDN). A call whose line, voice and engine have not changed keeps its file.

  C:/Users/Admin/Code/AI/chatterbox/.venv/Scripts/python.exe tools/briefings/radio-voices.py
      --story ../RTSAI-Mod/resources/campaign-story.json --out D:/rtsai-campaign/campaign-v2 [--engine chatterbox]
"""
import argparse, hashlib, json, os, pathlib, shutil, subprocess, urllib.request, uuid

ap = argparse.ArgumentParser()
ap.add_argument('--story', required=True)
ap.add_argument('--out', required=True)
ap.add_argument('--engine', choices=['kokoro', 'chatterbox'], default='kokoro')
ap.add_argument('--chatterbox', default='http://127.0.0.1:8004')
opt = ap.parse_args()

VOICES = {
    'badr': 'am_adam', 'nabil': 'am_puck', 'turki': 'bm_lewis', 'kemal': 'am_fenrir', 'lin': 'bm_fable',
    'signals-chief': 'am_michael', 'lantern': 'af_heart', 'tanya': 'af_bella', 'orlov': 'bm_george',
    'einstein': 'bm_lewis', 'narrator': 'am_michael',
}
# Chatterbox expressiveness per speaker: the Broker is calm, Tanya quick and alive, everyone else in between.
EXAGGERATION = {'orlov': 0.3, 'tanya': 0.7, 'lantern': 0.45}
# What each speaker reads for their reference clip (about 12 s, in character, never a line from the game).
REFERENCE = {
    'lantern': "This is the coordination desk. I keep the roads, the ports and the sea lanes open, and I keep every side talking. Stay on this channel and wait for my word.",
    'tanya': "Alright, listen up. I've been in worse spots than this, and I always get out. Keep your heads down, follow me, and try to keep up.",
    'orlov': "Good evening. I don't make threats. I make offers, and I am very patient. Everyone eventually wants to see the world a little more clearly.",
}
DEFAULT_REFERENCE = "Command here. Hold your positions and report what you see. Engineers forward, reserves stay with the convoy, and nobody moves until I give the order."
RADIO = 'highpass=f=280,lowpass=f=3600,acompressor=threshold=-20dB:ratio=4:attack=5:release=80,loudnorm=I=-16:TP=-1.5'
BROKER = 'highpass=f=90,lowpass=f=7000,aecho=0.8:0.5:35:0.2,loudnorm=I=-17:TP=-1.5'

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ.setdefault('HF_HOME', 'D:/AI Models/huggingface')
import numpy as np, soundfile as sf, torch
from kokoro import KModel, KPipeline

story_path = pathlib.Path(opt.story)
story = json.loads(story_path.read_text(encoding='utf-8'))
out = pathlib.Path(opt.out)
ffmpeg, ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe')
assert ffmpeg and ffprobe
snapshot = next(p for p in (pathlib.Path(os.environ['HF_HOME']) / 'hub/models--hexgrad--Kokoro-82M/snapshots').iterdir() if (p / 'kokoro-v1_0.pth').exists())
torch.set_num_threads(4)
model = KModel(repo_id='hexgrad/Kokoro-82M', config=str(snapshot / 'config.json'), model=str(snapshot / 'kokoro-v1_0.pth')).to('cpu').eval()
pipes, voices = {}, {}


def kokoro(line, voice, wav):
    lang = voice[0]
    if lang not in pipes:
        pipes[lang] = KPipeline(lang_code=lang, repo_id='hexgrad/Kokoro-82M', model=model)
    if voice not in voices:
        voices[voice] = torch.load(snapshot / f'voices/{voice}.pt', weights_only=True)
    audio = np.concatenate([r.audio.cpu().numpy() for r in pipes[lang](line, voice=voices[voice], speed=1.0)])
    sf.write(wav, audio, 24000)


def post(path, body, headers):
    req = urllib.request.Request(f'{opt.chatterbox}{path}', data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=300) as r:
        return r.read()


def enrolled():
    with urllib.request.urlopen(f'{opt.chatterbox}/v1/audio/voices', timeout=30) as r:
        data = json.loads(r.read())
    return {v['id'] for v in (data.get('voices', data) if isinstance(data, dict) else data)}


def enroll(speaker, have):
    vid = f'rtsai-{speaker}'
    if vid in have:
        return vid
    ref = out / '_ref' / f'{speaker}.wav'
    ref.parent.mkdir(parents=True, exist_ok=True)
    kokoro(REFERENCE.get(speaker, DEFAULT_REFERENCE), VOICES.get(speaker, 'am_michael'), ref)
    boundary = uuid.uuid4().hex
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n{vid}\r\n'
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{speaker}.wav"\r\nContent-Type: audio/wav\r\n\r\n').encode() \
        + ref.read_bytes() + f'\r\n--{boundary}--\r\n'.encode()
    post('/v1/audio/voices', body, {'Content-Type': f'multipart/form-data; boundary={boundary}'})
    have.add(vid)
    print('enrolled', vid, flush=True)
    return vid


def duration(path):
    return float(subprocess.check_output([ffprobe, '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)]).decode().strip())


def chatterbox(line, speaker, wav, have):
    vid = enroll(speaker, have)
    words = len(line.split())
    for attempt in range(2):
        wav.write_bytes(post('/v1/audio/speech', json.dumps({'input': line, 'voice': vid, 'response_format': 'wav',
                                                            'exaggeration': EXAGGERATION.get(speaker, 0.5)}).encode(),
                             {'Content-Type': 'application/json'}))
        pace = words / max(duration(wav), 0.1)
        if 1.4 <= pace <= 4.2:  # a garbled or truncated read lands outside a speaking pace
            return 'chatterbox'
        print(f'  odd pace {pace:.1f} w/s, again', flush=True)
    kokoro(line, VOICES.get(speaker, 'am_michael'), wav)
    return 'kokoro'


have = enrolled() if opt.engine == 'chatterbox' else set()
made = kept = fell = 0
for mission, calls in story.get('radio', {}).items():
    (out / mission).mkdir(parents=True, exist_ok=True)
    for n, call in enumerate(calls, 1):
        speaker = call['speaker']
        voice = VOICES.get(speaker, 'am_michael')
        rel = f'{mission}/radio-{n}.mp3'
        mp3 = out / rel
        stamp = mp3.with_suffix('.key')
        key = hashlib.sha256(f"{opt.engine}|{voice}|{EXAGGERATION.get(speaker, 0.5)}|{call['line']}".encode()).hexdigest()[:16]
        call['audio'] = rel
        if mp3.exists() and stamp.exists() and stamp.read_text() == key:
            kept += 1
            continue
        wav = mp3.with_suffix('.wav')
        if opt.engine == 'chatterbox':
            used = chatterbox(call['line'], speaker, wav, have)
            fell += used == 'kokoro'
        else:
            kokoro(call['line'], voice, wav)
            used = 'kokoro'
        padded = mp3.with_suffix('.pad.wav')
        subprocess.run([ffmpeg, '-loglevel', 'error', '-y', '-i', str(wav), '-af', 'adelay=100|100,apad=pad_dur=0.2', str(padded)], check=True)
        chain = BROKER if speaker == 'orlov' else RADIO
        subprocess.run([ffmpeg, '-loglevel', 'error', '-y', '-i', str(padded), '-af', chain, '-ar', '44100', '-ac', '1', '-b:a', '64k', str(mp3)], check=True)
        wav.unlink(); padded.unlink()
        stamp.write_text(key)
        made += 1
        print('voiced', rel, speaker, used, flush=True)

story_path.write_text(json.dumps(story, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
print(json.dumps({'made': made, 'kept': kept, 'kokoroFallbacks': fell}))
