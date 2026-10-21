"""Place project-made impact art at its authored contact point, not its canvas centre.

fx_forge's base is measured below the fixed SHP canvas centre. OpenRA centres that
canvas at the warhead position. A sequence offset must bridge those two contracts.
Use authoring metadata and exact asset hashes; never infer pivots per animation frame.
"""
import hashlib
import json
from pathlib import Path
import struct


def anchor_patches(generator, E, records=None):
    if records is None:
        records = json.loads((Path(__file__).parent / 'data/project-effect-anchors.json').read_text())['effects']
    image = generator.curseq.get('explosion')
    if image is None:
        return []
    defaults = image.get('Defaults')
    patch = E.Node('explosion')
    for sequence in image.children:
        if sequence.key == 'Defaults':
            continue
        filename = sequence.val('Filename') or (defaults.val('Filename') if defaults else None)
        if not filename:
            continue
        record = records.get(filename)
        if record is None:
            continue
        path = generator.mod_root / 'mods/rtsai/standalone/effects' / filename
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != record['sha256']:
            raise ValueError(f'{filename}: project impact artwork changed; audit its anchor before publishing')
        magic, width, height, _ = struct.unpack_from('<4H', data)
        if magic != 0 or [width, height] != record['canvas']:
            raise ValueError(f'{filename}: project impact canvas differs from its authoring record')
        offset = sequence.val('Offset') or (defaults.val('Offset') if defaults else None) or '0, 0, 0'
        components = [float(value.strip()) for value in offset.split(',')]
        components += [0] * (3 - len(components))
        components[1] -= record['groundY']
        patch.children.append(E.Node(sequence.key, None, [E.Node('Offset', ', '.join(f'{value:g}' for value in components))]))
    return [patch] if patch.children else []
