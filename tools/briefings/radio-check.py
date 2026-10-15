"""Check voiced radio calls against their script: each mp3 is transcribed by the local Whisper service (:8001,
OpenAI-style /v1/audio/transcriptions) and compared word by word with its line. Prints the calls that read under
--min (default 0.8) of the words, so they can be voiced again.

  python tools/briefings/radio-check.py --story ../RTSAI-Mod/resources/campaign-story.json --dir D:/rtsai-campaign/campaign-v2
"""
import argparse, difflib, json, pathlib, re, urllib.request, uuid

ap = argparse.ArgumentParser()
ap.add_argument('--story', required=True)
ap.add_argument('--dir', required=True)
ap.add_argument('--whisper', default='http://127.0.0.1:8001')
ap.add_argument('--min', type=float, default=0.8)
opt = ap.parse_args()

words = lambda s: re.findall(r"[a-z0-9']+", s.lower().replace('nineteen fifty-three', '1953'))


def transcribe(path):
    boundary = uuid.uuid4().hex
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n'
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{path.name}"\r\nContent-Type: audio/mpeg\r\n\r\n').encode() \
        + path.read_bytes() + f'\r\n--{boundary}--\r\n'.encode()
    req = urllib.request.Request(f'{opt.whisper}/v1/audio/transcriptions', data=body, headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read()).get('text', '')


story = json.loads(pathlib.Path(opt.story).read_text(encoding='utf-8'))
bad, total = [], 0
for mission, calls in story.get('radio', {}).items():
    for n, call in enumerate(calls, 1):
        mp3 = pathlib.Path(opt.dir) / call['audio']
        heard = transcribe(mp3)
        a, b = words(call['line']), words(heard)
        score = difflib.SequenceMatcher(None, a, b).ratio()
        total += 1
        if score < opt.min:
            bad.append((call['audio'], round(score, 2), call['line'], heard.strip()))
for audio, score, line, heard in bad:
    print(f'{score}  {audio}\n   line : {line}\n   heard: {heard}')
print(json.dumps({'checked': total, 'below': len(bad)}))
