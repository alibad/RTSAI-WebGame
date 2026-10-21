"""Apply generated presentation anchors to exact live data, retaining every other input."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import ea_originals as E


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    for key in ('base', 'content', 'out'):
        ap.add_argument('--' + key, type=Path, required=True)
    ap.add_argument('--source', required=True)
    args = ap.parse_args()
    if args.out.exists():
        raise ValueError('Output exists; preserve it and choose a fresh path')
    spec = importlib.util.spec_from_file_location('maps', Path(__file__).with_name('prepare-map-release.py'))
    maps = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(maps)
    core = maps.read_pack(args.base / 'web-bundle.pack')
    art = maps.read_pack(args.base / 'web-art.pack')
    audio = maps.read_pack(args.base / 'web-audio.pack')
    filename = 'mods/rtsai/web/content/ea-sequences.yaml'
    before = core[filename]
    after = (args.content / 'ea-sequences.yaml').read_bytes()
    # The complete original-country sequence table must remain byte-identical.
    original, separator, patch_text = after.partition(b'\nexplosion:\n')
    if not separator or original.rstrip() != before.rstrip():
        raise ValueError('Generated changes extend beyond the project impact anchor patch')
    patch = E.parse('explosion:\n' + patch_text.decode())[0]
    if not patch.children or any([c.key for c in sequence.children] != ['Offset'] for sequence in patch.children):
        raise ValueError('Impact presentation patch may set only sequence offsets')
    reviewed = json.loads(core['ora/map-release.json'])
    allfiles = {**core, **art}
    for path, sha in reviewed['overlays'].items():
        if hashlib.sha256(allfiles[path]).hexdigest() != sha:
            raise ValueError('Reviewed map/scenery changed: ' + path)
    core[filename] = after
    receipt = {'schema': 1, 'source': args.source, 'baseBundle': core['ora/BUNDLE_ID'].decode(),
               'sequences': {node.key: node.val('Offset') for node in patch.children},
               'scope': 'Presentation offsets only. Original assets, all gameplay rules, audio and reviewed maps retained.'}
    core['ora/effect-release.json'] = (json.dumps(receipt, indent=2) + '\n').encode()
    args.out.mkdir(parents=True)
    maps.emit(args.out, core, art, audio, reviewed)
    for name in ('build-inputs.json', 'ea-inputs.json', 'content-profile.json'):
        shutil.copy2(args.base / name, args.out / name)
    print(f'Anchored {len(patch.children)} project impact sequences; retained {len(reviewed["overlays"])} map/scenery overlays and all gameplay/audio/assets')


if __name__ == '__main__':
    main()
