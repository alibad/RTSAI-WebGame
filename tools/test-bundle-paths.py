#!/usr/bin/env python3
"""Exercise the real pack CLI under visible/hidden ancestors and with original-art fixtures (synthetic bytes, never
real EA files): allowlist, hashes, placement under web/ea, ea-content.json and the manifest order."""
import argparse
import hashlib
import json
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
    original_art(args.websim.resolve())


def entries(pack):
    """name -> bytes of an ORAPACK1 pack."""
    out, offset = {}, 12
    count = int.from_bytes(pack[8:12], 'little')
    for _ in range(count):
        n = int.from_bytes(pack[offset:offset + 2], 'little'); offset += 2
        name = pack[offset:offset + n].decode(); offset += n
        size = int.from_bytes(pack[offset:offset + 4], 'little', signed=True); offset += 4
        out[name] = pack[offset:offset + size]; offset += size
    return out


def original_art(websim):
    """--ea: synthetic stand-ins for original files; checks what the bundle may carry and where."""
    with tempfile.TemporaryDirectory(prefix='rtsai-ea-pack-') as tmp:
        root = Path(tmp)
        manifest_yaml = ('LoadScreen: RTSAILoadScreen\nAssemblies: OpenRA.Mods.RTSAI.dll\n\nRules:\n\tra2|rules.yaml\n\n\tra2|campaigns/countries.yaml\n\n'
                         'Sequences:\n\tra2|seq.yaml\n\n\tra2|campaigns/country-sequences.yaml\n\nModelSequences:\n\tra2|voxels.yaml\n\n'
                         'Notifications:\n\tra2|n.yaml\n\nMapFolders:\n\tra2|maps: System\n\n')
        files = {
            'engine/VERSION': b'test\n', 'engine/glsl/combined.vert': b'shader', 'engine/mods/common/rules.yaml': b'World:\n',
            'mod/mods/rtsai/mod.yaml': manifest_yaml.encode(), 'mod/mods/rtsai/rules.yaml': b'World:\n',
            'mod/mods/rtsai/standalone/base-kit.yaml': b'project kit\n',
            'mod/mods/rtsai/maps/blank-shellmap/map.bin': b'map', 'mod/mods/rtsai/maps/blank-shellmap/map.yaml': b'MapFormat: 12\n',
            'content/countries.yaml': b'', 'content/country-sequences.yaml': b'', 'content/country-notifications.yaml': b'',
            'content/ea-art.yaml': b'', 'content/ea-sequences.yaml': b'', 'content/ea-models.yaml': b'',
        }
        for rel, data in files.items():
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            (root / rel).write_bytes(data)
        ea = root / 'ea'
        ea.mkdir()
        art = {'big.shp': b'S' * 40000, 'small.shp': b's' * 100, 'unit.vxl': b'v' * 50000, 'unit.hva': b'h' * 10, 'unittem.pal': b'p' * 768}

        def write(art_files, drawn, extra=()):
            for name, data in art_files.items():
                (ea / name).write_bytes(data)
            listed = [{'name': n, 'sha256': hashlib.sha256(d).hexdigest(), 'size': len(d), 'source': 'fixture'} for n, d in art_files.items()]
            listed += list(extra)
            (ea / 'EA-INPUTS.json').write_text(json.dumps({'files': listed}))
            (root / 'content/ea-files.json').write_text(json.dumps({'files': drawn}))

        def pack(out, *extra):
            return subprocess.run(['dotnet', str(websim), 'pack', '--engine', str(root / 'engine'), '--mod', str(root / 'mod'),
                                   '--out', str(out / 'web-bundle.pack'), '--content', str(root / 'content'), '--no-mix-database',
                                   '--ea', str(ea), *extra], capture_output=True, text=True)

        write(art, sorted(art))
        r = pack(root / 'ok')
        assert r.returncode == 0, r.stderr
        bundle = entries((root / 'ok/web-bundle.pack').read_bytes())
        lazy = [f['path'] for f in json.loads((root / 'ok/web-art.json').read_text())['files']]
        assert lazy == ['mods/rtsai/web/ea/big.shp'], lazy
        for name in ('small.shp', 'unit.vxl', 'unit.hva', 'unittem.pal', 'ea-content.json'):
            assert 'mods/rtsai/web/ea/' + name in bundle, name
        record = json.loads(bundle['mods/rtsai/web/ea/ea-content.json'])
        assert record['notice'] == 'EA has not endorsed and does not support this product.', record
        assert sorted(f['name'] for f in record['files']) == sorted(art), record
        manifest = bundle['mods/rtsai/mod.yaml'].decode()
        for section, last in (('Rules', 'ra2|web/content/ea-art.yaml'), ('Sequences', 'ra2|web/content/ea-sequences.yaml'),
                              ('ModelSequences', 'ra2|web/content/ea-models.yaml')):
            body = manifest.split('\n' + section + ':\n', 1)[1]
            entries_in_section = []
            for line in body.split('\n'):
                if line and not line[0].isspace():
                    break
                if line.strip():
                    entries_in_section.append(line.strip())
            assert entries_in_section[-1] == last, (section, entries_in_section)
        assert manifest.index('ra2|campaigns/countries.yaml') < manifest.index('ra2|web/content/ea-art.yaml')

        # Audio, archives or anything outside the allowlist, a changed file, or art the content draws but the manifest
        # does not list: refused.
        (ea / 'theme.aud').write_bytes(b'audio')
        write(art, sorted(art), [{'name': 'theme.aud', 'sha256': hashlib.sha256(b'audio').hexdigest(), 'size': 5, 'source': 'fixture'}])
        assert pack(root / 'audio').returncode != 0, 'audio accepted'
        write(art, sorted(art))
        (ea / 'small.shp').write_bytes(b'changed')
        assert pack(root / 'changed').returncode != 0, 'changed file accepted'
        write(art, sorted(art) + ['missing.shp'])
        assert pack(root / 'unlisted').returncode != 0, 'unlisted drawn file accepted'
        write(art, sorted(art))
        assert pack(root / 'classic', '--game-mode', 'classic').returncode != 0, 'original art accepted in classic'
    print('PASS: original art bundled under web/ea (large sprites range-read) with ea-content.json and the overlays last; '
          'audio, changed, unlisted and classic-mode original art refused')


if __name__ == '__main__':
    main()
