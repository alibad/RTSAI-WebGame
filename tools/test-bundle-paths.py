#!/usr/bin/env python3
"""Exercise the real pack CLI under visible/hidden ancestors; no game or owned assets required."""
import argparse
import hashlib
from pathlib import Path
import subprocess
import tempfile


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--websim', type=Path, required=True)
    args = ap.parse_args()
    with tempfile.TemporaryDirectory(prefix='rtsai-pack-regression-') as tmp:
        outputs = []
        for parent in ('visible', '.session-artifacts'):
            root = Path(tmp) / parent
            files = {
                'engine/VERSION': b'test\n',
                'engine/glsl/combined.vert': b'shader fixture',
                'engine/glsl/.excluded': b'hidden shader',
                'engine/mods/common/rules.yaml': b'World:\n',
                'mod/mods/rtsai/mod.yaml': b'LoadScreen: RTSAILoadScreen\nAssemblies: OpenRA.Mods.RTSAI.dll\n\nRules:\n\tra2|rules.yaml\n\nMapFolders:\n\tra2|maps: System\n\n',
                'mod/mods/rtsai/rules.yaml': b'World:\n',
                'mod/mods/rtsai/maps/blank-shellmap/map.bin': b'map fixture',
                'mod/mods/rtsai/maps/blank-shellmap/map.yaml': b'MapFormat: 12\n',
                'mod/mods/rtsai/audio/ping.wav': b'RIFF-audio-fixture',
                'mod/mods/rtsai/.cache/leak.wav': b'hidden audio',
                'mod/mods/rtsai/.hidden/rules.yaml': b'hidden rules',
            }
            for rel, data in files.items():
                file = root / rel
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(data)
            data = root / 'data'
            subprocess.run(['dotnet', str(args.websim.resolve()), 'pack', '--engine', str(root / 'engine'),
                            '--mod', str(root / 'mod'), '--out', str(data / 'web-bundle.pack'), '--no-mix-database'], check=True)
            unpacked = root / 'vfs'
            subprocess.run(['dotnet', str(args.websim.resolve()), 'unpack', '--pack', str(data / 'web-bundle.pack'), '--root', str(unpacked)], check=True)
            assert (unpacked / 'ora/glsl/combined.vert').read_bytes() == b'shader fixture'
            assert not (unpacked / 'ora/glsl/.excluded').exists()
            assert not (unpacked / 'mods/rtsai/.hidden/rules.yaml').exists()
            import json
            audio = json.loads((data / 'web-audio.json').read_text())['files']
            assert [entry['path'] for entry in audio] == ['mods/rtsai/audio/ping.wav'], audio
            outputs.append({name: hashlib.sha256((data / name).read_bytes()).hexdigest()
                            for name in ('web-bundle.pack', 'web-audio.pack', 'web-audio.json', 'web-art.pack', 'web-art.json')})
        assert outputs[0] == outputs[1], outputs
    print('PASS: identical visible/hidden-parent packs, shaders and audio included; internal hidden files excluded')


if __name__ == '__main__':
    main()
