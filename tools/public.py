#!/usr/bin/env python3
"""Portable public pack/bake adapter. Builds only isolated dependency copies.
Usage: python3 tools/public.py --inputs <prepare-inputs directory> --out <NEW session build dir>
Pass --check-only to verify inputs/prerequisites without compiling. No worktree/default private content.
Isometric only: --ea-art <dir> (tools/prepare-ea-art.py, outside every repository) draws the nine original countries
with the original Westwood art and gives them their original unit voices, and the Attack Dog its original barks and bite
for every faction (EA's free, non-commercial modding guidelines: art and unit voice/sound clips, never C&C music).
--no-ea-audio keeps the original art without the original voices.
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
    content = ap.add_mutually_exclusive_group()
    content.add_argument('--ea-art',type=Path,help='verified original-country art and voices (normal isometric build)')
    content.add_argument('--project-art-only',action='store_true',help='explicit isometric fallback with substitute country art; not the normal game content')
    ap.add_argument('--no-ea-audio',action='store_true',help='with --ea-art: original art only, no original unit voices or sounds')
    args=ap.parse_args(); inputs=args.inputs.resolve(); out=args.out.absolute()
    ea=args.ea_art.resolve() if args.ea_art else None
    if args.game_mode == 'isometric' and not ea and not args.project_art_only:
        ap.error('Isometric content must be explicit: use --ea-art <verified original-country assets> for the normal game, or --project-art-only for the fallback. Omitting the assets must not silently substitute other factions.')
    if ea and args.game_mode!='isometric': raise ValueError('Original art is isometric only; Classic/top-down keeps the stand-ins')
    if ea: subprocess.run([sys.executable,str(ROOT/'tools/prepare-ea-art.py'),'verify','--dir',str(ea)],check=True)
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
                    '--classic-source',str(inputs/'classic-map-source'),'--out',str(content),'--scenarios-out',str(scenarios),'--game-mode',args.game_mode,
                    *(['--ea-art',str(ea)] if ea else []),*(['--no-ea-audio'] if ea and args.no_ea_audio else [])],check=True)
    props=['-p:WebProfile=public',f'-p:EngineRoot={build_engine}{os.sep}',f'-p:ModRoot={mod}{os.sep}',f'-p:WebBuildRoot={out}{os.sep}']
    subprocess.run(['dotnet','build',str(ROOT/'sim/OpenRA.WebSim.Native/OpenRA.WebSim.Native.csproj'),'-c','Release','--nologo','-v:q',*props],check=True)
    runner=out/'bin/OpenRA.WebSim.Native-public/Release/net10.0/websim.dll'
    data=out/('data/public-classic' if args.game_mode=='classic' else 'data/public');scratch=out/'work/vfs-public'
    def run(*a): subprocess.run(['dotnet',str(runner),*map(str,a)],check=True,env={**os.environ,'OPENRA_AI_HOST':'0'})
    run('pack','--engine',build_engine,'--mod',mod,'--out',data/'web-bundle.pack','--content',content,'--no-mix-database','--game-mode',args.game_mode,*(['--ea',ea] if ea else []))
    run('unpack','--pack',data/'web-bundle.pack','--root',scratch)
    run('bake','--root',scratch,'--maps',args.maps,'--out',data/'sprites')
    shutil.copy2(inputs/'build-inputs.json',data/'build-inputs.json')
    if ea: shutil.copy2(ea/'EA-INPUTS.json',data/'ea-inputs.json')
    (data/'content-profile.json').write_text(json.dumps({'schema':1,'gameMode':args.game_mode,
        'variant':'original-countries' if ea else 'project-art-only',
        'originalCountryArt':bool(ea),'originalCountryVoices':bool(ea and not args.no_ea_audio),
        'modSource':expected['inputs']['mod']},indent=2)+'\n')
    print(f'Public pack/bake ready: {data}; publish browser runtime separately using the same props and private engine copy.')

if __name__=='__main__': main()
