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
    parser.add_argument('--accept-overlay', action='append', default=[], metavar='NAME',
                        help='a reviewed overlay that changed on purpose in the mod: ship the copy from the gameplay build '
                             'and record both hashes (the next base then carries the new one)')
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
    unknown = [name for name in args.accept_overlay if name not in reviewed['overlays']]
    if unknown:
        raise ValueError('Not a reviewed overlay of the base: ' + ', '.join(unknown))
    retained = {}
    updated = {}
    for name, sha in reviewed['overlays'].items():
        data = old[name]
        if hashlib.sha256(data).hexdigest() != sha:
            raise ValueError('Reviewed map overlay changed: ' + name)
        if name in args.accept_overlay:
            new = core.get(name, art.get(name))
            if new is None:
                raise ValueError('Accepted overlay is not in the gameplay build: ' + name)
            new_sha = hashlib.sha256(new).hexdigest()
            if new_sha == sha:
                raise ValueError('Accepted overlay is unchanged; do not list it: ' + name)
            updated[name] = {'from': sha, 'to': new_sha}
            reviewed['overlays'][name] = new_sha
            continue
        mine = core.get(name, art.get(name))
        if mine is not None and hashlib.sha256(mine).hexdigest() != sha:
            # The mod changed a reviewed overlay since the base was reviewed: restoring the base drops that change.
            print(f'WARNING: the mod changed reviewed overlay {name}; the base copy is shipped. '
                  f'If the change is wanted (for example the 26 Oct rock fix in editor-world/sequences.yaml), '
                  f'rerun with --accept-overlay {name}')
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
        'updatedMapOverlays': updated,
        'scope': 'Original RA2 gameplay fixes; exact reviewed live map and scenery overlays retained'
                 + (', except the listed ones, updated on purpose from the mod.' if updated else '.')
    }, indent=2) + '\n').encode()
    maps.emit(args.out, core, art, audio, reviewed)
    for name in ['build-inputs.json', 'ea-inputs.json', 'content-profile.json']:
        shutil.copy2(args.gameplay / name, args.out / name)
    # Check after final partitioning/serialization, not just the in-memory assignment.
    actual = {**maps.read_pack(args.out / 'web-bundle.pack'), **maps.read_pack(args.out / 'web-art.pack')}
    assert all(actual[name] == old[name] for name in retained)
    (args.out / 'gameplay-release.json').write_text(core['ora/gameplay-release.json'].decode(), encoding='utf-8')
    print(f'Verified {len(retained)} reviewed map/scenery files unchanged'
          + (f'; {len(updated)} updated on purpose: ' + ', '.join(updated) if updated else ''))


if __name__ == '__main__':
    main()
