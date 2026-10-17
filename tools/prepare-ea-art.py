#!/usr/bin/env python3
"""Original Westwood (EA) art and unit voices for the public isometric browser game: plan, extract and record them.

  plan     --inputs <prepare-inputs dir> --out <plan.json>
           Lists the original art files (.shp .vxl .hva .pal only) the generator draws for the nine original countries,
           and the original voice and sound clips (.wav) their voice sets and the dog's bite name (tools/ea_voices.py).
  extract  --plan <plan.json> --out <dir outside every Git repository>
           Art: copies each file from the RTSAI-Web Studio cache when it holds the player's original (extracted by the
           same engine), else extracts it from the player's own RA2 files with the mod engine's OpenRA.Utility:
           `OpenRA.Utility rtsai-classic --extract`, exactly as RTSAI-Web lib/art-lab/originals.ts does.
           Audio: the same utility, into <out>/audio/, only clips RA2's audio.idx lists (audio.bag: unit voices and
           sounds; never theme.mix). A clip the index lacks is recorded in audio/absent.json (the game keeps the
           project's sound for it); each clip stays exactly as Westwood stored it (IMA-ADPCM WAV), checked against the
           index.
  manifest --plan <plan.json> --dir <extracted dir> --inputs <prepare-inputs dir>
           Verifies and writes <dir>/EA-INPUTS.json (name, sha256, size, source; the clips under "audio").
  verify   --dir <extracted dir>
           Checks EA-INPUTS.json against the files.

Legal: EA's C&C Franchise Modding Guidelines allow free, non-commercial use of original C&C assets other than the music,
with the notice "EA has not endorsed and does not support this product." Only art and unit voice/sound clips are
planned, extracted or recorded here (allowlists): no music (theme.mix or any score), EVA or video, and the extracted
files never enter a Git repository.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
GAMES = ROOT.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import ea_originals  # noqa: E402
import ea_voices  # noqa: E402

NOTICE = 'EA has not endorsed and does not support this product.'
SOURCE_CACHE = 'RTSAI-Web Studio cache (OpenRA.Utility rtsai-classic --extract from the player\'s RA2 files)'
SOURCE_EXTRACT = 'OpenRA.Utility rtsai-classic --extract (the player\'s RA2 files: ra2.mix, language.mix)'
SOURCE_AUDIO = 'OpenRA.Utility rtsai-classic --extract (the player\'s RA2 files: audio.bag in language.mix), as stored'
AUDIO = ea_voices.AUDIO_FOLDER
AUDIO_RECORDS = ('sources.json', 'absent.json')
# Unit voice and sound-effect clips are short: a large or long file would be music or speech this build must not carry.
MAX_CLIP_BYTES = 512 * 1024
MAX_CLIP_SECONDS = 20.0
AUDIO_CONTENTS = ('original Red Alert 2 unit voice and sound-effect clips (.wav from audio.bag, as Westwood stored them); '
                  'no music, EVA or video')


def digest(p: Path):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def identity(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def inside_git(path: Path):
    for p in [path, *path.parents]:
        if (p / '.git').exists():
            return p
    return None


def allowed(name):
    return Path(name).suffix.lower() in ea_originals.ALLOWED_EXTENSIONS and ea_originals.SAFE_NAME.fullmatch(name) is not None


def allowed_audio(name):
    """A unit voice or sound clip name as RA2's audio.idx spells it (.wav); never EVA (ceva*)."""
    return ea_voices.CLIP_NAME.fullmatch(name) is not None and not name.startswith('ceva')


def wav_info(data: bytes):
    """Format, channels, rate, data bytes and seconds of a RIFF WAVE file: PCM (1) or IMA ADPCM (17) only."""
    if len(data) < 12 or data[:4] != b'RIFF' or data[8:12] != b'WAVE':
        raise ValueError('not a RIFF WAVE file')
    fmt = extra = size = None
    at = 12
    while at + 8 <= len(data):
        kind, length = data[at:at + 4], struct.unpack_from('<I', data, at + 4)[0]
        if kind == b'fmt ':
            fmt = struct.unpack_from('<HHIIHH', data, at + 8)
            extra = struct.unpack_from('<HH', data, at + 24) if length >= 20 else (0, 0)
        elif kind == b'data':
            size = length
            if at + 8 + length != len(data):
                raise ValueError('the data chunk does not end the file')
            break
        at += 8 + length + (length & 1)
    if fmt is None or size is None:
        raise ValueError('no fmt or data chunk')
    code, channels, rate, _, align, _ = fmt
    if code == 1:
        seconds = size / (channels * 2) / rate
    elif code == 17:
        seconds = (size / align) * extra[1] / rate
    else:
        raise ValueError(f'unsupported WAVE format {code}')
    return {'format': 'ima-adpcm' if code == 17 else 'pcm', 'channels': channels, 'rate': rate, 'data': size,
            'seconds': round(seconds, 3)}


def check_clip(name, data: bytes):
    if not allowed_audio(name):
        raise ValueError(f'{name}: not an allowlisted voice or sound clip name')
    if len(data) > MAX_CLIP_BYTES:
        raise ValueError(f'{name}: {len(data)} bytes, larger than a voice or sound clip ({MAX_CLIP_BYTES})')
    info = wav_info(data)
    if info['seconds'] > MAX_CLIP_SECONDS:
        raise ValueError(f'{name}: {info["seconds"]} s, longer than a voice or sound clip')
    return info


def read_idx(data: bytes):
    """RA2's audio.idx (GABA, version 2): lower-case <name>.wav -> (offset, length, rate, flags, chunk size)."""
    if data[:4] != b'GABA' or struct.unpack_from('<i', data, 4)[0] != 2:
        raise ValueError('not an audio.idx (GABA 2) index')
    count = struct.unpack_from('<i', data, 8)[0]
    if len(data) < 12 + 36 * count:
        raise ValueError('truncated audio.idx')
    out = {}
    for i in range(count):
        o = 12 + 36 * i
        name = data[o:o + 16].split(b'\0')[0].decode('ascii').lower() + '.wav'
        out[name] = struct.unpack_from('<5I', data, o + 16)
    return out


def plan(args):
    inputs = args.inputs.resolve()
    out = args.out.absolute()
    if out.exists():
        raise ValueError(f'Refusing to overwrite {out}')
    with tempfile.TemporaryDirectory(dir=out.parent) as work:
        work = Path(work)
        subprocess.run([sys.executable, str(ROOT / 'tools/prepare-content.py'), '--mod', str(inputs / 'mod'),
                        '--missions', str(inputs / 'missions/missions'), '--classic-source', str(inputs / 'classic-map-source'),
                        '--out', str(work / 'content'), '--scenarios-out', str(work / 'scenarios'), '--game-mode', 'isometric',
                        '--ea-list', str(out)], check=True)
    print(json.dumps({k: v for k, v in json.loads(out.read_text()).items() if k not in ('files', 'audio')}, indent=1))


def shim_dir(base: Path, mod_root: Path, support: Path, engine: Path):
    """A minimal engine directory for OpenRA.Utility: junctions to the mod engine's mods and the RA2 Support folder,
    and copies of the mix database and VERSION (RTSAI-Web lib/art-lab/originals.ts ensureShim). Nothing else."""
    # Do not reuse a historical shim whose mods junction points at the SDK's old engine copy.
    engine_id = hashlib.sha256(str(engine.resolve()).encode()).hexdigest()[:12]
    shim = base / ('ea-shim-' + engine_id)
    shim.mkdir(parents=True, exist_ok=True)
    for name, target in (('mods', engine / 'mods'), ('Support', support)):
        link = shim / name
        if not link.exists():
            subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(target)] if os.name == 'nt' else ['ln', '-s', str(target), str(link)],
                           check=True, stdout=subprocess.DEVNULL)
    for f in ('global mix database.dat', 'VERSION'):
        if not (shim / f).exists():
            shutil.copy2(engine / f, shim / f)
    return shim


class Utility:
    """The mod engine's OpenRA.Utility over the player's own RA2 files (the classic add-on's mounts), in a shim engine
    directory."""

    def __init__(self, args, out: Path):
        mod_root = args.mod.resolve()
        support = args.support.resolve()
        if not (support / 'Content/ra2/ra2.mix').is_file():
            raise ValueError(f'No RA2 content at {support / "Content/ra2"}')
        engine = args.engine.resolve()
        shim = shim_dir(out.parent, mod_root, support, engine)
        exe = engine / 'bin' / ('OpenRA.Utility.exe' if os.name == 'nt' else 'OpenRA.Utility.dll')
        self.cmd = [str(exe)] if os.name == 'nt' else ['dotnet', str(exe)]
        self.env = {**os.environ, 'ENGINE_DIR': str(shim), 'MOD_SEARCH_PATHS': str(mod_root / 'mods')}

    def extract(self, names, work: Path):
        """Extracts the names into work; returns those the RA2 files lack."""
        missing = []
        rest = list(names)
        # The utility extracts in order and stops at the first name it cannot find: note it, carry on after it.
        while rest:
            batch = rest[:80]
            r = subprocess.run([*self.cmd, 'rtsai-classic', '--extract', *batch], cwd=work, env=self.env, capture_output=True, text=True, timeout=300)
            done = [n for n in batch if (work / n).is_file()]
            if r.returncode == 0 and len(done) == len(batch):
                rest = rest[len(batch):]
                continue
            at = next((i for i, n in enumerate(batch) if not (work / n).is_file()), None)
            if at is None:
                rest = rest[len(batch):]
                continue
            missing.append(batch[at])
            rest = rest[at + 1:]
        return missing


def extract(args):
    planned = json.loads(args.plan.read_text())
    names = planned['files']
    out = args.out.absolute()
    if inside_git(out):
        raise ValueError(f'{out} is inside a Git repository; original art must stay outside every repository')
    bad = [n for n in names if not allowed(n)]
    if bad:
        raise ValueError(f'not allowlisted art files: {bad}')
    bad = [n for n in planned.get('audio', []) if not allowed_audio(n)]
    if bad:
        raise ValueError(f'not allowlisted voice or sound clips: {bad}')
    out.mkdir(parents=True, exist_ok=True)
    sources = {}
    record = out / 'sources.json'
    if record.exists():
        sources = json.loads(record.read_text())
    cache = args.cache
    if cache and (cache / 'extracted-by.txt').exists() and (cache / 'extracted-by.txt').read_text().strip() != 'rtsai-classic':
        print(f'ignoring {cache}: not extracted through rtsai-classic')
        cache = None
    todo = []
    for n in names:
        if (out / n).exists() and n in sources:
            continue
        cached = cache / 'files' / n if cache else None
        if cached is not None and cached.is_file():
            shutil.copy2(cached, out / n)
            sources[n] = SOURCE_CACHE
        else:
            todo.append(n)
    missing = []
    utility = None
    if todo:
        utility = Utility(args, out)
        with tempfile.TemporaryDirectory(dir=out.parent) as work:
            work = Path(work)
            missing = utility.extract(todo, work)
            for n in todo:
                if (work / n).is_file():
                    shutil.move(str(work / n), out / n)
                    sources[n] = SOURCE_EXTRACT
    record.write_text(json.dumps(sources, indent=1, sort_keys=True) + '\n')
    print(f'{len(names)} planned: {sum(1 for n in names if (out / n).is_file())} present, {len(missing)} not found in the RA2 files')
    if missing:
        print('missing: ' + ', '.join(missing))
        (out / 'missing.json').write_text(json.dumps(sorted(missing), indent=1) + '\n')
        return 3
    if 'audio' in planned:
        return extract_audio(args, planned['audio'], out, utility)
    return 0


def extract_audio(args, names, out: Path, utility):
    """Unit voice and sound clips into <out>/audio/: only those RA2's audio.idx lists, as stored, checked against it."""
    folder = out / AUDIO
    folder.mkdir(exist_ok=True)
    sources = json.loads((folder / 'sources.json').read_text()) if (folder / 'sources.json').exists() else {}
    utility = utility or Utility(args, out)
    with tempfile.TemporaryDirectory(dir=out.parent) as work:
        work = Path(work)
        # The index of RA2's unit voices and sounds (names, offsets, lengths): read, then deleted with the folder.
        if utility.extract(['audio.idx'], work):
            raise ValueError('RA2\'s audio.idx was not found in the player\'s files')
        index = read_idx((work / 'audio.idx').read_bytes())
        (work / 'audio.idx').unlink()
        absent = {n: 'not in RA2\'s audio.idx' for n in names if n not in index}
        todo = [n for n in names if n in index and not ((folder / n).is_file() and n in sources)]
        missing = utility.extract(todo, work) if todo else []
        if missing:
            raise ValueError(f'clips audio.idx lists could not be extracted: {missing}')
        for n in todo:
            shutil.move(str(work / n), folder / n)
            sources[n] = SOURCE_AUDIO
    for n in names:
        if n in absent:
            continue
        info = check_clip(n, (folder / n).read_bytes())
        if info['data'] != index[n][1]:
            raise ValueError(f'{n}: {info["data"]} data bytes, audio.idx says {index[n][1]}')
    stray = sorted(p.name for p in folder.iterdir() if p.name not in names and p.name not in AUDIO_RECORDS)
    if stray:
        raise ValueError(f'{folder} holds files the plan does not name: {stray}')
    (folder / 'sources.json').write_text(json.dumps({n: sources[n] for n in sorted(sources) if n in names}, indent=1) + '\n')
    (folder / 'absent.json').write_text(json.dumps(dict(sorted(absent.items())), indent=1) + '\n')
    present = [n for n in names if n not in absent]
    size = sum((folder / n).stat().st_size for n in present)
    print(f'{len(names)} clips planned: {len(present)} extracted ({size / 1024:.0f} KB), {len(absent)} not in RA2 '
          f'(project sound kept): {", ".join(sorted(absent))}')
    return 0


def manifest(args):
    planned = json.loads(args.plan.read_text())
    names = planned['files']
    d = args.dir.absolute()
    if inside_git(d):
        raise ValueError(f'{d} is inside a Git repository')
    sources = json.loads((d / 'sources.json').read_text())
    placeholders = args.inputs.resolve() / 'mod/mods/rtsai/standalone/placeholders'
    files = []
    for n in names:
        p = d / n
        if not allowed(n):
            raise ValueError(f'{n}: not an allowlisted art file')
        if not p.is_file():
            raise ValueError(f'{n}: not extracted')
        stand_in = placeholders / n
        if stand_in.is_file() and stand_in.read_bytes() == p.read_bytes():
            raise ValueError(f'{n}: identical to the standalone stand-in, not the original')
        files.append({'name': n, 'sha256': digest(p), 'size': p.stat().st_size, 'source': sources[n]})
    value = {'schema': 1, 'notice': NOTICE, 'guidelines': "EA's C&C Franchise Modding Guidelines (free, non-commercial)",
             'contents': 'original Red Alert 2 art (.shp .vxl .hva .pal); unit voice and sound clips only under "audio"; '
                         'no music or video',
             'plan': planned.get('planSha256'), 'files': files}
    # The art identity is unchanged by the audio section (builds without original voices read only "files").
    value['sha256'] = identity(files)
    if 'audio' in planned:
        value['audio'] = audio_manifest(planned, d, args.inputs.resolve())
    (d / 'EA-INPUTS.json').write_text(json.dumps(value, indent=1) + '\n')
    print(f'EA-INPUTS.json: {len(files)} files, {sum(f["size"] for f in files) / 1048576:.1f} MB, sha256 {value["sha256"]}')
    if 'audio' in value:
        a = value['audio']
        print(f'  audio: {len(a["files"])} clips, {sum(f["size"] for f in a["files"]) / 1024:.0f} KB, '
              f'{len(a["absent"])} absent from RA2, sha256 {a["sha256"]}')


def audio_manifest(planned, d: Path, inputs: Path):
    names = planned['audio']
    folder = d / AUDIO
    sources = json.loads((folder / 'sources.json').read_text())
    absent = json.loads((folder / 'absent.json').read_text())
    if set(absent) - set(names):
        raise ValueError(f'absent clips the plan does not name: {sorted(set(absent) - set(names))}')
    # The project's own clips (several carry RA2's names): an extracted clip identical to one is not the original.
    stand_ins = {}
    for p in (inputs / 'mod/mods/rtsai').rglob('*.wav'):
        stand_ins.setdefault(p.name.lower(), []).append(p)
    files = []
    for n in names:
        if n in absent:
            continue
        p = folder / n
        if not p.is_file():
            raise ValueError(f'{AUDIO}/{n}: not extracted')
        info = check_clip(n, p.read_bytes())
        same = [s for s in stand_ins.get(n, []) if s.read_bytes() == p.read_bytes()]
        if same:
            raise ValueError(f'{AUDIO}/{n}: identical to the project file {same[0]}, not the original')
        files.append({'name': n, 'sha256': digest(p), 'size': p.stat().st_size, 'source': sources[n], 'format': info['format'],
                      'seconds': info['seconds']})
    stray = sorted(p.name for p in folder.iterdir() if p.name not in names and p.name not in AUDIO_RECORDS)
    if stray:
        raise ValueError(f'{folder} holds files the plan does not name: {stray}')
    value = {'folder': AUDIO, 'contents': AUDIO_CONTENTS, 'plan': planned.get('audioPlanSha256'), 'files': files,
             'absent': sorted(absent)}
    value['sha256'] = identity({'files': files, 'absent': value['absent']})
    return value


def verify_dir(d: Path):
    value = json.loads((d / 'EA-INPUTS.json').read_text())
    for f in value['files']:
        p = d / f['name']
        if not allowed(f['name']) or not p.is_file() or digest(p) != f['sha256']:
            raise ValueError(f'{d}: {f["name"]} differs from EA-INPUTS.json')
    if identity(value['files']) != value['sha256']:
        raise ValueError(f'{d}: EA-INPUTS.json identity mismatch')
    audio = value.get('audio')
    if audio is not None:
        if audio.get('folder') != AUDIO:
            raise ValueError(f'{d}: unexpected audio folder {audio.get("folder")}')
        folder = d / AUDIO
        listed = {f['name'] for f in audio['files']}
        for f in audio['files']:
            p = folder / f['name']
            if not p.is_file() or digest(p) != f['sha256']:
                raise ValueError(f'{d}: {AUDIO}/{f["name"]} differs from EA-INPUTS.json')
            check_clip(f['name'], p.read_bytes())
        if listed & set(audio['absent']):
            raise ValueError(f'{d}: clips both extracted and absent: {sorted(listed & set(audio["absent"]))}')
        stray = sorted(p.name for p in folder.iterdir() if p.name not in listed and p.name not in AUDIO_RECORDS)
        if stray:
            raise ValueError(f'{d}: {AUDIO}/ holds files EA-INPUTS.json does not list: {stray}')
        if identity({'files': audio['files'], 'absent': audio['absent']}) != audio['sha256']:
            raise ValueError(f'{d}: EA-INPUTS.json audio identity mismatch')
    return value


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('plan'); p.add_argument('--inputs', type=Path, required=True); p.add_argument('--out', type=Path, required=True)
    e = sub.add_parser('extract'); e.add_argument('--plan', type=Path, required=True); e.add_argument('--out', type=Path, required=True)
    e.add_argument('--cache', type=Path, default=GAMES / 'RTSAI-Web/.cache/ra2-originals')
    e.add_argument('--mod', type=Path, default=GAMES / 'RTSAI-Mod'); e.add_argument('--support', type=Path, default=GAMES / 'OpenRA/Support')
    e.add_argument('--engine', type=Path, default=GAMES / 'OpenRA', help='canonical built OpenRA checkout (never a stale SDK engine copy)')
    m = sub.add_parser('manifest'); m.add_argument('--plan', type=Path, required=True); m.add_argument('--dir', type=Path, required=True)
    m.add_argument('--inputs', type=Path, required=True)
    v = sub.add_parser('verify'); v.add_argument('--dir', type=Path, required=True)
    args = ap.parse_args()
    if args.cmd == 'plan':
        return plan(args)
    if args.cmd == 'extract':
        return extract(args)
    if args.cmd == 'manifest':
        return manifest(args)
    value = verify_dir(args.dir.absolute())
    print(f'verified {len(value["files"])} original art files ({value["sha256"]})'
          + (f' and {len(value["audio"]["files"])} voice and sound clips ({value["audio"]["sha256"]})' if 'audio' in value else ''))


if __name__ == '__main__':
    sys.exit(main() or 0)
