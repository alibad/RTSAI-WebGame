"""Rename a faction in the published Classic profile, retaining every other file byte for byte.

Classic is a published profile that releases reuse byte for byte (build-public.mjs). When the mod renames a faction
(13 November 2026: the seventh modern faction became Lebanon), regenerating Classic would replace everything else in
it too, so this tool applies only the rename to the published packs:

  - a file the published Classic shared byte for byte with the published isometric profile is taken from the NEW
    isometric profile, at its renamed path, so the two stay in step (catalog texts, unit bindings, revision stamps);
  - the files given with --replace come from the frozen mod (the flag atlases, the roster preview card);
  - any other text file that names the faction gets the name swapped, keeping its case, and so does every path;
  - everything else is retained byte for byte, in the same pack.

It refuses when the old name would survive anywhere, when a binary file names it and has no --replace, when two paths
would collide, or when a file would change packs. The receipt (ora/classic-rename.json) lists every changed file with
its hashes; it does not record the old name.

  python tools/prepare-classic-rename.py --base <published classic> --base-isometric <published isometric> \
      --isometric <new isometric> --mod <frozen mod>/mods --old <old id> --new <new id> \
      --replace <pack path>=<path under --mod> --out <new classic> --source <commit>
"""
import argparse
import hashlib
import importlib.util
import json
import shutil
from pathlib import Path

PACKS = ('web-bundle.pack', 'web-art.pack', 'web-audio.pack')
RECEIPTS = ('ora/BUNDLE_ID', 'ora/map-release.json', 'ora/classic-rename.json')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for key in ('base', 'base-isometric', 'isometric', 'mod', 'out'):
        ap.add_argument('--' + key, type=Path, required=True)
    ap.add_argument('--old', required=True, help='the faction id to remove (lower case)')
    ap.add_argument('--new', required=True, help='the faction id that replaces it (lower case)')
    ap.add_argument('--replace', action='append', default=[], metavar='PACK_PATH=MOD_PATH',
                    help='take this file (named by its new pack path) from the frozen mod')
    ap.add_argument('--source', required=True, help='Canonical main implementation commit')
    args = ap.parse_args()
    if args.out.exists():
        raise ValueError('Output exists; preserve it and choose a fresh path')
    spec = importlib.util.spec_from_file_location('maps', Path(__file__).with_name('prepare-map-release.py'))
    maps = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(maps)

    forms = [(f(args.old).encode(), f(args.new).encode()) for f in (str.upper, str.capitalize, str.lower)]
    old_lower = args.old.lower().encode()

    def swap(data):
        for a, b in forms:
            data = data.replace(a, b)
        return data

    def names(data):
        return old_lower in data.lower()

    def read(folder, required=PACKS):
        return [maps.read_pack(folder / p) if (folder / p).exists() or p in required else {} for p in PACKS]

    base = read(args.base)
    live_iso = {name: data for pack in read(args.base_isometric, required=PACKS[:1]) for name, data in pack.items()}
    new_iso = {name: data for pack in read(args.isometric) for name, data in pack.items()}
    replace = dict(item.split('=', 1) for item in args.replace)
    used = set()

    out_packs, changed = [], {}
    for pack in base:
        result = {}
        for name, data in pack.items():
            new_name = swap(name.encode()).decode()
            if new_name in result:
                raise ValueError('Two files would share the path ' + new_name)
            if new_name in replace:
                new_data, why = (args.mod / replace[new_name]).read_bytes(), 'from the mod'
                used.add(new_name)
            elif name not in RECEIPTS and live_iso.get(name) == data and new_name in new_iso:
                new_data, why = new_iso[new_name], 'shared with the isometric profile'
            elif names(data):
                if bytes(1) in data:
                    raise ValueError('A binary file names the faction and has no --replace: ' + name)
                new_data, why = swap(data), 'name swapped'
            else:
                new_data, why = data, None
            if names(new_data) or names(new_name.encode()):
                raise ValueError('The old name would survive in ' + new_name)
            if new_name != name or new_data != data:
                changed[new_name] = {'from': sha(data), 'to': sha(new_data),
                                     'how': why or 'path only', 'renamedPath': new_name != name}
            result[new_name] = new_data
        out_packs.append(result)
    if set(replace) - used:
        raise ValueError('--replace names files the profile does not have: ' + ', '.join(sorted(set(replace) - used)))
    core, art, audio = out_packs

    # Receipts that record hashes of changed files follow them.
    by_sha = {c['from']: c['to'] for c in changed.values() if c['from'] != c['to']}
    for name in [n for n in core if n.startswith('ora/') and n.endswith('.json') and n not in RECEIPTS[2:]]:
        text = core[name].decode()
        for a, b in by_sha.items():
            text = text.replace(a, b)
        core[name] = text.encode()
    reviewed = json.loads(core['ora/map-release.json'])
    base_bundle = base[0]['ora/BUNDLE_ID'].decode()
    how = {}
    for item in changed.values():
        how[item['how']] = how.get(item['how'], 0) + 1
    core['ora/classic-rename.json'] = (json.dumps({
        'schema': 1, 'source': args.source, 'baseBundle': base_bundle, 'faction': args.new,
        'changed': dict(sorted(changed.items())), 'counts': how,
        'scope': 'One faction renamed. Every other Classic file and all pack residency retained byte for byte.'
    }, indent=2) + chr(10)).encode()

    args.out.mkdir(parents=True)
    maps.emit(args.out, core, art, audio, reviewed)
    for name in ('build-inputs.json', 'content-profile.json'):
        if (args.base / name).exists():
            shutil.copy2(args.base / name, args.out / name)

    # Check the serialized packs, not the in-memory assignment.
    for before, p in zip(base, PACKS):
        after = maps.read_pack(args.out / p)
        expect = {swap(n.encode()).decode() for n in before} | ({'ora/classic-rename.json'} if p == PACKS[0] else set())
        assert set(after) == expect, f'{p}: pack residency changed'
        for name, data in before.items():
            new_name = swap(name.encode()).decode()
            if new_name not in changed and name not in RECEIPTS and not (name.startswith('ora/') and name.endswith('.json')):
                assert after[new_name] == data, 'an untouched file changed: ' + name
        assert not any(names(n.encode()) or names(d) for n, d in after.items()), f'{p}: the old name survived'
    print(f'Classic rename: {len(changed)} files changed ({how}); '
          f'{sum(len(p) for p in base) - len(changed)} other files and all pack residency unchanged; '
          f'bundle {base_bundle} -> {maps.read_pack(args.out / PACKS[0])["ora/BUNDLE_ID"].decode()}')


if __name__ == '__main__':
    main()
