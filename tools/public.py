#!/usr/bin/env python3
"""Portable public pack/bake adapter. Builds only isolated dependency copies.
Usage: python3 tools/public.py --inputs <prepare-inputs directory> --out <NEW session build dir>
Pass --check-only to verify inputs/prerequisites without compiling. No worktree/default private content.
"""
import argparse
import importlib.util
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--inputs',type=Path,required=True); ap.add_argument('--out',type=Path,required=True)
    ap.add_argument('--game-mode',choices=['isometric','classic'],default='isometric'); ap.add_argument('--maps',default='all'); ap.add_argument('--check-only',action='store_true')
    args=ap.parse_args(); inputs=args.inputs.resolve(); out=args.out.absolute()
    mod=inputs/'mod'; engine=inputs/'engine'
    tool=mod/'tools/build-inputs.py'
    expected=json.loads((inputs/'build-inputs.json').read_text())
    for name,sha in expected['inputs'].items():
        result=subprocess.check_output([sys.executable,str(tool),'verify',str(inputs/name)],text=True)
        if json.loads(result)['sourceSha256']!=sha: raise ValueError(f'{name} differs from build-inputs manifest')
    spec=importlib.util.spec_from_file_location('prepare_inputs',ROOT/'tools/prepare-inputs.py')
    adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter);adapter.standalone(mod)
    if not shutil.which('dotnet'): raise ValueError('Requires .NET 10 SDK')
    subprocess.run([sys.executable,'-c','from PIL import Image'],check=True)
    if args.check_only:
        print('PASS verified engine, standalone main source, mission and terrain identities; .NET/Pillow found');return
    if out.exists(): raise ValueError(f'Refusing to overwrite output: {out}')
    if out==inputs or out in inputs.parents or inputs in out.parents: raise ValueError('Output overlaps frozen inputs')
    out.mkdir(parents=True)
    build_engine=out/'work/engine';shutil.copytree(engine,build_engine)
    pin=json.loads((engine/'INPUTS.json').read_text())['commit']
    (build_engine/'VERSION').write_text(pin+'\n')
    for manifest in (build_engine/'mods').glob('*/mod.yaml'):
        manifest.write_text(re.sub(r'Version: .*', f'Version: {pin}', manifest.read_text()))
    (out/'build-transforms.json').write_text(json.dumps({'engineInput':expected['inputs']['engine'],
        'engineCommit':pin,'transforms':['stamp private engine VERSION and engine mod versions']},indent=2)+'\n')
    content=out/'content';scenarios=out/'scenarios'
    subprocess.run([sys.executable,str(ROOT/'tools/prepare-content.py'),'--mod',str(mod),'--missions',str(inputs/'missions/missions'),
                    '--classic-source',str(inputs/'classic-map-source'),'--out',str(content),'--scenarios-out',str(scenarios),'--game-mode',args.game_mode],check=True)
    props=['-p:WebProfile=public',f'-p:EngineRoot={build_engine}{os.sep}',f'-p:ModRoot={mod}{os.sep}',f'-p:WebBuildRoot={out}{os.sep}']
    subprocess.run(['dotnet','build',str(ROOT/'sim/OpenRA.WebSim.Native/OpenRA.WebSim.Native.csproj'),'-c','Release','--nologo','-v:q',*props],check=True)
    runner=out/'bin/OpenRA.WebSim.Native-public/Release/net10.0/websim.dll'
    data=out/('data/public-classic' if args.game_mode=='classic' else 'data/public');scratch=out/'work/vfs-public'
    def run(*a): subprocess.run(['dotnet',str(runner),*map(str,a)],check=True,env={**os.environ,'OPENRA_AI_HOST':'0'})
    run('pack','--engine',build_engine,'--mod',mod,'--out',data/'web-bundle.pack','--content',content,'--no-mix-database','--game-mode',args.game_mode)
    run('unpack','--pack',data/'web-bundle.pack','--root',scratch)
    run('bake','--root',scratch,'--maps',args.maps,'--out',data/'sprites')
    shutil.copy2(inputs/'build-inputs.json',data/'build-inputs.json')
    print(f'Public pack/bake ready: {data}; publish browser runtime separately using the same props and private engine copy.')

if __name__=='__main__': main()
