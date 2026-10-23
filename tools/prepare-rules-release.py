"""Package rules files from a RTSAI-Mod commit onto exact published data, retaining every other input.

  python tools/prepare-rules-release.py --base <published profile inputs, e.g. D:/rtsai-full-20261021/final/public>
      --mod <RTSAI-Mod checkout> --from <the published data's Mod commit> --to <Mod commit with the change>
      --out <new profile folder> [--files mods/rtsai/rules/ai.yaml ...]
      [--content <regenerated web content> --content-files ea-art.yaml --content-lines <regex> --content-source <commit>]

Each file must be byte-identical in the base bundle and at --from (so only the --from..--to change ships), and
--from..--to must change nothing but the listed files. Generated web content (tools/prepare-content.py output, bundled
under mods/rtsai/web/content/) may be packaged too: every line it adds or removes must match --content-lines. Art and
audio packs are carried over unchanged; the bundle gets a new id and an `ora/rules-release.json` receipt. Then unpack
and re-bake the sprites from the new bundle (websim unpack/bake, as tools/public.py does) before
tools/build-public.mjs --data-only.
"""
import difflib
import re
import argparse
import hashlib
import importlib.util
import json
import shutil
import subprocess
from pathlib import Path


def git(mod, *args):
    return subprocess.run(['git', '-C', str(mod), *args], check=True, capture_output=True).stdout


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    for key in ('base', 'mod', 'out'):
        ap.add_argument('--' + key, type=Path, required=True)
    ap.add_argument('--from', dest='frm', required=True)
    ap.add_argument('--to', required=True)
    ap.add_argument('--files', nargs='*', default=['mods/rtsai/rules/ai.yaml'],
                    help='Explicitly empty for a generated-content-only release with identical --from/--to')
    ap.add_argument('--content', type=Path)
    ap.add_argument('--content-files', nargs='*', default=[])
    ap.add_argument('--content-lines', default=None)
    ap.add_argument('--content-source', default=None)
    args = ap.parse_args()
    if args.content_files and not (args.content and args.content_lines and args.content_source):
        raise ValueError('--content-files needs --content, --content-lines and --content-source')
    if args.out.exists():
        raise ValueError('Output exists; preserve it and choose a fresh path')
    spec = importlib.util.spec_from_file_location('maps', Path(__file__).with_name('prepare-map-release.py'))
    maps = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(maps)

    changed = set(git(args.mod, 'diff', '--name-only', args.frm, args.to).decode().split())
    if changed != set(args.files):
        raise ValueError(f'{args.frm}..{args.to} changes {sorted(changed)}, not exactly {sorted(args.files)}')
    core = maps.read_pack(args.base / 'web-bundle.pack')
    art = maps.read_pack(args.base / 'web-art.pack')
    audio = maps.read_pack(args.base / 'web-audio.pack')
    before_bundle = core['ora/BUNDLE_ID'].decode()
    receipt_files = {}
    for name in args.files:
        live, old, new = core.get(name), git(args.mod, 'show', f'{args.frm}:{name}'), git(args.mod, 'show', f'{args.to}:{name}')
        if live is None or live.replace(b'\r\n', b'\n') != old.replace(b'\r\n', b'\n'):
            raise ValueError(f'{name} in the base bundle is not the file at {args.frm}')
        core[name] = new.replace(b'\r\n', b'\n')
        receipt_files[name] = {'before': hashlib.sha256(live).hexdigest(), 'after': hashlib.sha256(core[name]).hexdigest()}
    allowed = re.compile(args.content_lines) if args.content_lines else None
    for f in args.content_files:
        name = 'mods/rtsai/web/content/' + f
        live, new = core.get(name), (args.content / f).read_bytes().replace(b'\r\n', b'\n')
        if live is None:
            raise ValueError(f'{name} is not in the base bundle')
        for line in difflib.unified_diff(live.decode().splitlines(), new.decode().splitlines(), lineterm='', n=0):
            if line[:1] in '+-' and not line.startswith(('+++', '---')) and not allowed.search(line[1:]):
                raise ValueError(f'{name}: change outside --content-lines: {line[:160]}')
        core[name] = new
        receipt_files[name] = {'before': hashlib.sha256(live).hexdigest(), 'after': hashlib.sha256(new).hexdigest(), 'generatedBy': args.content_source}
    reviewed = json.loads((args.base / 'map-release.json').read_text())
    core['ora/rules-release.json'] = (json.dumps({'schema': 1, 'from': args.frm, 'to': args.to, 'baseBundle': before_bundle,
        'files': receipt_files, 'scope': 'The listed rules and generated content files only. Art, audio, maps and every other file retained.'},
        indent=2) + '\n').encode()
    args.out.mkdir(parents=True)
    maps.emit(args.out, core, art, audio, reviewed)
    for name in ('build-inputs.json', 'ea-inputs.json', 'content-profile.json', 'gameplay-release.json'):
        if (args.base / name).exists():
            shutil.copy2(args.base / name, args.out / name)
    if (args.base / 'wasm-aot').exists():  # build-public --data-only needs some runtime beside the data
        shutil.copytree(args.base / 'wasm-aot', args.out / 'wasm-aot')
    # Everything else must be byte-identical to the base.
    after = {**maps.read_pack(args.out / 'web-bundle.pack'), **maps.read_pack(args.out / 'web-art.pack'), **maps.read_pack(args.out / 'web-audio.pack')}
    base_all = {**maps.read_pack(args.base / 'web-bundle.pack'), **art, **audio}
    meta = {'ora/BUNDLE_ID', 'ora/map-release.json', 'ora/rules-release.json'}
    differ = sorted(k for k in set(after) | set(base_all) if k not in meta and after.get(k) != base_all.get(k))
    expected = sorted(args.files + ['mods/rtsai/web/content/' + f for f in args.content_files])
    if differ != expected:
        raise ValueError(f'unexpected differences: {differ}')
    print(f'{before_bundle} -> {after["ora/BUNDLE_ID"].decode()}: {", ".join(expected)}; {len(base_all) - len(expected)} other files unchanged')


if __name__ == '__main__':
    main()
