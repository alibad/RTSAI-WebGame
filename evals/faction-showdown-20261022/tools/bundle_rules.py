"""Compare (or patch) rules files in a published web-bundle.pack against the RTSAI-Mod checkout.

  python tools/bundle_rules.py diff  <web-bundle.pack> <mod checkout> [files...]
  python tools/bundle_rules.py patch <web-bundle.pack> <mod checkout> <out.pack> [files...]

Files are mod paths such as mods/rtsai/rules/ai.yaml. `patch` writes a copy of the bundle with those files taken from
the checkout and nothing else changed (the AI-vs-AI harness serves it in place of the live bundle to test a rules fix).
"""
import difflib
import subprocess
import tempfile
import importlib.util
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('maps', Path(r'C:\Users\Admin\Code\hq\games\RTSAI-WebGame\tools\prepare-map-release.py'))
maps = importlib.util.module_from_spec(spec)
spec.loader.exec_module(maps)

DEFAULT = ['mods/rtsai/rules/ai.yaml', 'mods/rtsai/rules/player.yaml']


def read(pack):
    """The bundle's files; a CDN copy is stored brotli-compressed (decompressed with Node's zlib)."""
    if pack.read_bytes()[:8] != b'ORAPACK1':
        plain = Path(tempfile.mkdtemp()) / 'web-bundle.pack'
        subprocess.run(['node', '-e', "const z=require('zlib'),fs=require('fs');fs.writeFileSync(process.argv[2],z.brotliDecompressSync(fs.readFileSync(process.argv[1])))",
                        str(pack), str(plain)], check=True)
        pack = plain
    return maps.read_pack(pack)


def main():
    mode, pack, mod = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
    out = Path(sys.argv[4]) if mode == 'patch' else None
    files = sys.argv[5:] if mode == 'patch' else sys.argv[4:]
    files = files or DEFAULT
    core = read(pack)
    for f in files:
        # "bundle/path=local/file" takes the file from anywhere (generated web content); otherwise from the checkout.
        f, _, source = f.partition('=')
        live = core.get(f)
        mine = Path(source).read_bytes() if source else (mod / f).read_bytes()
        if live is None:
            print(f'{f}: not in the bundle')
            continue
        same = live.replace(b'\r\n', b'\n') == mine.replace(b'\r\n', b'\n')
        print(f'{f}: {"identical" if same else "differs"} ({len(live)} live bytes, {len(mine)} checkout bytes)')
        if not same and mode == 'diff':
            for line in difflib.unified_diff(live.decode().splitlines(), mine.decode().splitlines(), 'live', 'checkout', lineterm='', n=1):
                print('   ', line)
        if mode == 'patch':
            core[f] = mine.replace(b'\r\n', b'\n')
    if mode == 'patch':
        maps.write_pack(out, core)
        print(f'wrote {out}')


if __name__ == '__main__':
    main()
