"""Generate a project-content four-seat map for local multiplayer, without editing the mod checkout."""
from pathlib import Path
from PIL import Image
import math
import struct

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'content' / 'maps' / 'four-fronts'
W, H = 64, 128
SPAWNS = [(14, 28), (49, 100), (49, 28), (14, 100)]

def cpos(u, v):
    odd = v & 1
    return (v + odd) // 2 + u, (v - odd) // 2 - u

def build():
    OUT.mkdir(parents=True, exist_ok=True)
    area = W * H
    data = bytearray(17 + area * 6)
    struct.pack_into('<BHHIII', data, 0, 2, W, H, 17, 17 + area * 3, 17 + area * 4)
    mines = [(u + (7 if u < W // 2 else -7), v + dv) for u, v in SPAWNS for dv in (-10, 10)]
    gems = [(27, 60), (36, 68)]
    preview = Image.new('RGBA', (2 * (W - 2) - 1, H - 2), (0, 0, 0, 0))
    for u in range(W):
        for v in range(H):
            i = u * H + v
            # Template 0 is the standalone tileset's clear grass: every base and route is passable.
            struct.pack_into('<HB', data, 17 + i * 3, 0, 0)
            ore = any(math.hypot((u - x) * 2, v - y) <= 7 for x, y in mines)
            gem = any(math.hypot((u - x) * 2, v - y) <= 5 for x, y in gems)
            kind = 2 if gem else 1 if ore else 0
            if (u, v) in mines: kind = 0
            struct.pack_into('<BB', data, 17 + area * 4 + i * 2, kind, 10 if kind else 0)
            if 1 <= u < W - 1 and 1 <= v < H - 1:
                x, y = 2 * (u - 1) + (v & 1), v - 1
                color = (120, 60, 130, 255) if gem else (180, 155, 65, 255) if ore else (68, 108, 38, 255)
                if x < preview.width: preview.putpixel((x, y), color)
                if x + 1 < preview.width: preview.putpixel((x + 1, y), color)
    players = '\tPlayerReference@Neutral:\n\t\tName: Neutral\n\t\tOwnsWorld: True\n\t\tNonCombatant: True\n\t\tFaction: china\n'
    players += '\tPlayerReference@Creeps:\n\t\tName: Creeps\n\t\tNonCombatant: True\n\t\tFaction: china\n\t\tEnemies: Multi0, Multi1, Multi2, Multi3\n'
    for k in range(4):
        players += f'\tPlayerReference@Multi{k}:\n\t\tName: Multi{k}\n\t\tPlayable: True\n\t\tFaction: Random\n\t\tEnemies: Creeps\n'
    actors = ''
    for kind, points, prefix in [('mpspawn', SPAWNS, 'Spawn'), ('oremine', mines, 'Mine')]:
        for k, point in enumerate(points):
            x, y = cpos(*point)
            actors += f'\t{prefix}{k}: {kind}\n\t\tOwner: Neutral\n\t\tLocation: {x},{y}\n'
    yaml = f'MapFormat: 12\nRequiresMod: rtsai\nTitle: Four Fronts\nAuthor: RTS AI\nTileset: TEMPERATE\nMapSize: {W},{H}\nBounds: 1,1,{W-2},{H-2}\nVisibility: Lobby\nCategories: Conquest\nPlayers:\n{players}Actors:\n{actors}'
    (OUT / 'map.yaml').write_text(yaml, encoding='utf-8', newline='\n')
    (OUT / 'map.bin').write_bytes(data)
    preview.save(OUT / 'map.png')
    print('Prepared Four Fronts: four seats, symmetric clear terrain, home ore mines and central gems.')

if __name__ == '__main__': build()
