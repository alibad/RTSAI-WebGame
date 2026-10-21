"""Give the published Classic profile the current soundtrack, retaining every other file byte for byte.

Classic carries its own copy of the standalone soundtrack (prepare-map-release.py copies it from the isometric
profile it was built beside). When the soundtrack changes, take it from the newly generated isometric profile
instead of regenerating Classic: its reviewed maps, rules, art and pack residency stay exactly as published.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil

MUSIC = 'mods/rtsai/standalone/audio/music'
RECEIPTS = ('ora/BUNDLE_ID', 'ora/map-release.json', 'ora/soundtrack-release.json')


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    for key in ('base', 'soundtrack', 'out'):
        ap.add_argument('--' + key, type=Path, required=True)
    ap.add_argument('--source', required=True, help='Canonical main implementation commit')
    args = ap.parse_args()
    if args.out.exists():
        raise ValueError('Output exists; preserve it and choose a fresh path')
    spec = importlib.util.spec_from_file_location('maps', Path(__file__).with_name('prepare-map-release.py'))
    maps = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(maps)
    packs = ('web-bundle.pack', 'web-art.pack', 'web-audio.pack')
    core, art, audio = (maps.read_pack(args.base / p) for p in packs)
    source = {name: data for p in packs for name, data in maps.read_pack(args.soundtrack / p).items() if name.startswith(MUSIC)}
    if MUSIC + '.yaml' not in source or not any(name.endswith('.ogg') for name in source):
        raise ValueError('The soundtrack profile has no music.yaml or tracks')
    old = {**core, **art, **audio}
    retired = sorted(name for name in old if name.startswith(MUSIC) and name not in source)
    for pack in (core, art, audio):
        for name in [n for n in pack if n.startswith(MUSIC)]:
            del pack[name]
    core.update(source)  # emit() moves the tracks into the audio pack
    reviewed = json.loads(core['ora/map-release.json'])
    core['ora/soundtrack-release.json'] = (json.dumps({
        'schema': 1, 'source': args.source, 'baseBundle': core['ora/BUNDLE_ID'].decode(),
        'tracks': {name: hashlib.sha256(data).hexdigest() for name, data in sorted(source.items())},
        'retired': retired,
        'scope': 'Soundtrack only. Classic rules, maps, art, audio and pack residency retained byte for byte.'
    }, indent=2) + '\n').encode()
    args.out.mkdir(parents=True)
    maps.emit(args.out, core, art, audio, reviewed)
    for name in ('build-inputs.json', 'content-profile.json'):
        if (args.base / name).exists():
            shutil.copy2(args.base / name, args.out / name)
    # Check the serialized packs, not the in-memory assignment.
    new = {name: data for p in packs for name, data in maps.read_pack(args.out / p).items()}
    kept = [name for name in old if not name.startswith(MUSIC) and name not in RECEIPTS]
    assert all(new.get(name) == old[name] for name in kept), 'a non-soundtrack file changed'
    assert set(new) - set(kept) - set(RECEIPTS) == set(source), 'unexpected files added'
    assert all(new[name] == data for name, data in source.items())
    for p in packs:
        before = {n for n in maps.read_pack(args.base / p) if not n.startswith(MUSIC) and n not in RECEIPTS}
        after = {n for n in maps.read_pack(args.out / p) if not n.startswith(MUSIC) and n not in RECEIPTS}
        assert before == after, f'{p}: pack residency changed'
    print(f'Classic soundtrack: {len(source)} files from the current profile, {len(retired)} retired; '
          f'{len(kept)} other files and their pack residency unchanged')


if __name__ == '__main__':
    main()
