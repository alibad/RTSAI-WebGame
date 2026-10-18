"""Carry reviewed live map overlays into a newly generated RA2 gameplay profile.

Classic is reused byte-for-byte by build-public.mjs; this tool only writes public.
The source packages and their original provenance remain immutable.
"""
import argparse
import hashlib
import importlib.util
import json
import shutil
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ('base', 'gameplay', 'out'):
        parser.add_argument('--' + key, type=Path, required=True)
    parser.add_argument('--source', required=True, help='Canonical main implementation commit')
    args = parser.parse_args()
    if args.out.exists():
        raise ValueError('Output already exists; preserve it and choose a fresh path')
    spec = importlib.util.spec_from_file_location('maps', Path(__file__).with_name('prepare-map-release.py'))
    maps = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(maps)
    core = maps.read_pack(args.gameplay / 'web-bundle.pack')
    art = maps.read_pack(args.gameplay / 'web-art.pack')
    audio = maps.read_pack(args.gameplay / 'web-audio.pack')
    old = {**maps.read_pack(args.base / 'web-bundle.pack'), **maps.read_pack(args.base / 'web-art.pack')}
    reviewed = json.loads(old['ora/map-release.json'])
    retained = {}
    for name, sha in reviewed['overlays'].items():
        data = old[name]
        if hashlib.sha256(data).hexdigest() != sha:
            raise ValueError('Reviewed map overlay changed: ' + name)
        art.pop(name, None)
        core[name] = data
        retained[name] = sha
    manifest = core['mods/rtsai/mod.yaml'].decode('utf-8').replace('\r\n', '\n')
    for section, entry in [('Rules', 'ra2|standalone/editor-world/rules.yaml'),
                           ('Sequences', 'ra2|standalone/editor-world/sequences.yaml'),
                           ('Sequences', 'ra2|standalone/bridges/sequences.yaml')]:
        manifest = maps.append(manifest, section, entry)
    core['mods/rtsai/mod.yaml'] = manifest.encode()
    core['ora/gameplay-release.json'] = (json.dumps({
        'schema': 1, 'source': args.source,
        'baseBundle': old['ora/BUNDLE_ID'].decode(),
        'generatedGameplayBundle': core['ora/BUNDLE_ID'].decode(),
        'retainedMapOverlays': retained,
        'scope': 'Original RA2 gameplay fixes; exact reviewed live map and scenery overlays retained.'
    }, indent=2) + '\n').encode()
    maps.emit(args.out, core, art, audio, reviewed)
    for name in ['build-inputs.json', 'ea-inputs.json', 'content-profile.json']:
        shutil.copy2(args.gameplay / name, args.out / name)
    # Check after final partitioning/serialization, not just the in-memory assignment.
    actual = {**maps.read_pack(args.out / 'web-bundle.pack'), **maps.read_pack(args.out / 'web-art.pack')}
    assert all(actual[name] == old[name] for name in retained)
    (args.out / 'gameplay-release.json').write_text(core['ora/gameplay-release.json'].decode(), encoding='utf-8')
    print(f'Verified {len(retained)} reviewed map/scenery files unchanged')


if __name__ == '__main__':
    main()
