#!/usr/bin/env python3
"""Prepare NEW main-derived, verified public inputs without touching any worktree."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]

def standalone(mod):
    manifest = mod / 'mods/rtsai/mod.yaml'
    text = manifest.read_text(encoding='utf-8')
    if not (mod/'mods/rtsai/standalone/base-kit.yaml').is_file(): raise ValueError('Missing standalone base-kit')
    package_block = text.split('Packages:', 1)[1].split('\nMapFolders:', 1)[0]
    if any(x in package_block for x in ['content|', 'ra2.mix', 'language.mix', '.bag', '.idx', 'ra2-content']):
        raise ValueError('Owned-game content mount in public input')
    if re.search(r'^\s+(Mix|Bag)File', text, re.M): raise ValueError('Owned-content loader in public manifest')
    for ext in ['*.mix', '*.bag', '*.idx', '*.vqa', '*.bik']:
        if next((mod/'mods/rtsai').rglob(ext), None): raise ValueError('Owned-game/archive/video payload in public input')
    return {'manifestSha256': hashlib.sha256(manifest.read_bytes()).hexdigest(), 'profile': 'standalone-main',
            'provenanceFiles': [p for p in ['docs/standalone-deliverables.json','docs/standalone-art-provenance.md','resources/art-provenance.json'] if (mod/p).exists()]}

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--out', type=Path, required=True)
    ap.add_argument('--mod', type=Path, default=ROOT.parent/'RTSAI-Mod')
    ap.add_argument('--engine-repo', type=Path, default=ROOT.parent/'OpenRA')
    ap.add_argument('--missions', type=Path, default=ROOT.parent/'OpenRA-AI')
    ap.add_argument('--committed', action='store_true', help='Freeze committed main sources only; leave concurrent working changes untouched')
    args=ap.parse_args(); dest=args.out.absolute()
    if dest.exists(): raise ValueError(f'Refusing existing input directory: {dest}')
    tool=args.mod.resolve()/'tools/build-inputs.py'
    dest.mkdir(parents=True)
    def run(*a): subprocess.run([sys.executable, str(tool), *map(str,a)],check=True)
    run('engine','--repo',args.engine_repo,'--out',dest/'engine')
    committed = ['--committed'] if args.committed else []
    run('snapshot','--repo',args.mod,'--out',dest/'mod',*committed)
    run('snapshot','--repo',args.missions,'--include','missions','--out',dest/'missions',*committed)
    run('snapshot','--repo',args.engine_repo,'--include','mods/ra/tilesets','--include','mods/ra/maps','--out',dest/'classic-map-source',*committed)
    result={'schema':1, 'standalone':standalone(dest/'mod'),
            'inputs': {name: json.loads((dest/name/'INPUTS.json').read_text())['sourceSha256'] for name in ['engine','mod','missions','classic-map-source']}}
    (dest/'build-inputs.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result,indent=2))

if __name__=='__main__': main()
