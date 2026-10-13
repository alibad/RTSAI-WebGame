#!/usr/bin/env python3
"""Original Westwood art (EA) for the public isometric browser game: plan, extract and record it.

  plan     --inputs <prepare-inputs dir> --out <plan.json>
           Lists the original art files (.shp .vxl .hva .pal only) the generator draws for the nine original countries.
  extract  --plan <plan.json> --out <dir outside every Git repository>
           Copies each file from the RTSAI-Web Studio cache when it holds the player's original (extracted by the same
           engine), else extracts it from the player's own RA2 files with the mod engine's OpenRA.Utility:
           `OpenRA.Utility rtsai-classic --extract`, exactly as RTSAI-Web lib/art-lab/originals.ts does.
  manifest --plan <plan.json> --dir <extracted dir> --inputs <prepare-inputs dir>
           Verifies and writes <dir>/EA-INPUTS.json (name, sha256, size, source).
  verify   --dir <extracted dir>
           Checks EA-INPUTS.json against the files.

Legal: EA's C&C Franchise Modding Guidelines allow free, non-commercial use of the original art with the notice
"EA has not endorsed and does not support this product." No EA audio, music or video is ever planned, extracted or
recorded here (allowlist), and the extracted files never enter a Git repository.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
GAMES = ROOT.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import ea_originals  # noqa: E402

NOTICE = 'EA has not endorsed and does not support this product.'
SOURCE_CACHE = 'RTSAI-Web Studio cache (OpenRA.Utility rtsai-classic --extract from the player\'s RA2 files)'
SOURCE_EXTRACT = 'OpenRA.Utility rtsai-classic --extract (the player\'s RA2 files: ra2.mix, language.mix)'


def digest(p: Path):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def inside_git(path: Path):
    for p in [path, *path.parents]:
        if (p / '.git').exists():
            return p
    return None


def allowed(name):
    return Path(name).suffix.lower() in ea_originals.ALLOWED_EXTENSIONS and ea_originals.SAFE_NAME.fullmatch(name) is not None


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
    print(json.dumps({k: v for k, v in json.loads(out.read_text()).items() if k != 'files'}, indent=1))


def shim_dir(base: Path, mod_root: Path, support: Path):
    """A minimal engine directory for OpenRA.Utility: junctions to the mod engine's mods and the RA2 Support folder,
    and copies of the mix database and VERSION (RTSAI-Web lib/art-lab/originals.ts ensureShim). Nothing else."""
    shim = base / 'ea-shim'
    shim.mkdir(parents=True, exist_ok=True)
    engine = mod_root / 'engine'
    for name, target in (('mods', engine / 'mods'), ('Support', support)):
        link = shim / name
        if not link.exists():
            subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(target)] if os.name == 'nt' else ['ln', '-s', str(target), str(link)],
                           check=True, stdout=subprocess.DEVNULL)
    for f in ('global mix database.dat', 'VERSION'):
        if not (shim / f).exists():
            shutil.copy2(engine / f, shim / f)
    return shim


def extract(args):
    names = json.loads(args.plan.read_text())['files']
    out = args.out.absolute()
    if inside_git(out):
        raise ValueError(f'{out} is inside a Git repository; original art must stay outside every repository')
    bad = [n for n in names if not allowed(n)]
    if bad:
        raise ValueError(f'not allowlisted art files: {bad}')
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
    if todo:
        mod_root = args.mod.resolve()
        support = args.support.resolve()
        if not (support / 'Content/ra2/ra2.mix').is_file():
            raise ValueError(f'No RA2 content at {support / "Content/ra2"}')
        shim = shim_dir(out.parent, mod_root, support)
        exe = mod_root / 'engine/bin' / ('OpenRA.Utility.exe' if os.name == 'nt' else 'OpenRA.Utility.dll')
        cmd = [str(exe)] if os.name == 'nt' else ['dotnet', str(exe)]
        env = {**os.environ, 'ENGINE_DIR': str(shim), 'MOD_SEARCH_PATHS': str(mod_root / 'mods')}
        with tempfile.TemporaryDirectory(dir=out.parent) as work:
            work = Path(work)
            rest = list(todo)
            # The utility extracts in order and stops at the first name it cannot find: note it, carry on after it.
            while rest:
                batch = rest[:80]
                r = subprocess.run([*cmd, 'rtsai-classic', '--extract', *batch], cwd=work, env=env, capture_output=True, text=True, timeout=300)
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
             'contents': 'original Red Alert 2 art only (.shp .vxl .hva .pal); no audio, music or video',
             'plan': planned.get('planSha256'), 'files': files}
    value['sha256'] = hashlib.sha256(json.dumps(files, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    (d / 'EA-INPUTS.json').write_text(json.dumps(value, indent=1) + '\n')
    print(f'EA-INPUTS.json: {len(files)} files, {sum(f["size"] for f in files) / 1048576:.1f} MB, sha256 {value["sha256"]}')


def verify_dir(d: Path):
    value = json.loads((d / 'EA-INPUTS.json').read_text())
    for f in value['files']:
        p = d / f['name']
        if not allowed(f['name']) or not p.is_file() or digest(p) != f['sha256']:
            raise ValueError(f'{d}: {f["name"]} differs from EA-INPUTS.json')
    if hashlib.sha256(json.dumps(value['files'], sort_keys=True, separators=(',', ':')).encode()).hexdigest() != value['sha256']:
        raise ValueError(f'{d}: EA-INPUTS.json identity mismatch')
    return value


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('plan'); p.add_argument('--inputs', type=Path, required=True); p.add_argument('--out', type=Path, required=True)
    e = sub.add_parser('extract'); e.add_argument('--plan', type=Path, required=True); e.add_argument('--out', type=Path, required=True)
    e.add_argument('--cache', type=Path, default=GAMES / 'RTSAI-Web/.cache/ra2-originals')
    e.add_argument('--mod', type=Path, default=GAMES / 'RTSAI-Mod'); e.add_argument('--support', type=Path, default=GAMES / 'OpenRA/Support')
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
    print(f'verified {len(value["files"])} original art files ({value["sha256"]})')


if __name__ == '__main__':
    sys.exit(main() or 0)
