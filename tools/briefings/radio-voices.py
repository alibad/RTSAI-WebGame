"""Voice a campaign's radio calls (resources/campaign-story.json -> radio) with cached local Kokoro voices, on the CPU.

Each speaker has a fixed voice; commanders and Lantern go through a field-radio filter, the Broker through a colder,
slightly processed one. Writes <out>/<mission>/radio-<n>.mp3 and sets each call's "audio" field to that path (relative
to the campaign folder on the CDN). A call whose line has not changed keeps its file.

  C:/Users/Admin/Code/AI/chatterbox/.venv/Scripts/python.exe tools/briefings/radio-voices.py
      --story ../RTSAI-Mod/resources/campaign-story.json --out D:/rtsai-campaign/campaign-v2
"""
import argparse, hashlib, json, os, pathlib, shutil, subprocess

ap = argparse.ArgumentParser()
ap.add_argument('--story', required=True)
ap.add_argument('--out', required=True)
opt = ap.parse_args()

VOICES = {
    'badr': 'am_adam', 'nabil': 'am_puck', 'turki': 'bm_lewis', 'kemal': 'am_fenrir', 'lin': 'bm_fable',
    'signals-chief': 'am_michael', 'lantern': 'af_heart', 'tanya': 'af_bella', 'orlov': 'bm_george',
    'einstein': 'bm_lewis', 'narrator': 'am_michael',
}
RADIO = 'highpass=f=280,lowpass=f=3600,acompressor=threshold=-20dB:ratio=4:attack=5:release=80,loudnorm=I=-16:TP=-1.5'
BROKER = 'highpass=f=90,lowpass=f=7000,aecho=0.8:0.5:35:0.2,loudnorm=I=-17:TP=-1.5'

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ.setdefault('HF_HOME', 'D:/AI Models/huggingface')
import numpy as np, soundfile as sf, torch
from kokoro import KModel, KPipeline

story_path = pathlib.Path(opt.story)
story = json.loads(story_path.read_text(encoding='utf-8'))
out = pathlib.Path(opt.out)
ffmpeg = shutil.which('ffmpeg'); assert ffmpeg
snapshot = next(p for p in (pathlib.Path(os.environ['HF_HOME']) / 'hub/models--hexgrad--Kokoro-82M/snapshots').iterdir() if (p / 'kokoro-v1_0.pth').exists())
torch.set_num_threads(4)
model = KModel(repo_id='hexgrad/Kokoro-82M', config=str(snapshot / 'config.json'), model=str(snapshot / 'kokoro-v1_0.pth')).to('cpu').eval()
pipes = {}
voices = {}
made = kept = 0
for mission, calls in story.get('radio', {}).items():
    (out / mission).mkdir(parents=True, exist_ok=True)
    for n, call in enumerate(calls, 1):
        voice = VOICES.get(call['speaker'], 'am_michael')
        rel = f'{mission}/radio-{n}.mp3'
        mp3 = out / rel
        stamp = mp3.with_suffix('.key')
        key = hashlib.sha256(f"{voice}|{call['line']}".encode()).hexdigest()[:16]
        call['audio'] = rel
        if mp3.exists() and stamp.exists() and stamp.read_text() == key:
            kept += 1
            continue
        lang = voice[0]
        if lang not in pipes:
            pipes[lang] = KPipeline(lang_code=lang, repo_id='hexgrad/Kokoro-82M', model=model)
        if voice not in voices:
            voices[voice] = torch.load(snapshot / f'voices/{voice}.pt', weights_only=True)
        audio = np.concatenate([r.audio.cpu().numpy() for r in pipes[lang](call['line'], voice=voices[voice], speed=1.0)])
        wav = mp3.with_suffix('.wav')
        sf.write(wav, np.concatenate([np.zeros(2400, dtype=audio.dtype), audio, np.zeros(4800, dtype=audio.dtype)]), 24000)
        chain = BROKER if call['speaker'] == 'orlov' else RADIO
        subprocess.run([ffmpeg, '-loglevel', 'error', '-y', '-i', str(wav), '-af', chain, '-ar', '44100', '-ac', '1', '-b:a', '64k', str(mp3)], check=True)
        wav.unlink()
        stamp.write_text(key)
        made += 1
        print('voiced', rel, voice, flush=True)

story_path.write_text(json.dumps(story, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
print(json.dumps({'made': made, 'kept': kept}))
