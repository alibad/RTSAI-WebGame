"""Freeze Natural Earth v5.1.2 land, clipped to the Hormuz region. No invented geometry."""
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_land.geojson'
SHA = '1ac90796408bc6ad6911d69448485d3c4dbf2190370080368a09976e1c9f7416'
BOX = [53, 24, 60, 29]  # west, south, east, north

def clip(ring):
    points = ring[:-1] if ring[0] == ring[-1] else ring
    for axis, edge, above in [(0, BOX[0], True), (0, BOX[2], False), (1, BOX[1], True), (1, BOX[3], False)]:
        output = []
        for a, b in zip(points, points[1:] + points[:1]):
            inside_a = a[axis] >= edge if above else a[axis] <= edge
            inside_b = b[axis] >= edge if above else b[axis] <= edge
            if inside_a:
                output.append(a)
            if inside_a != inside_b:
                t = (edge - a[axis]) / (b[axis] - a[axis])
                output.append([a[i] + t * (b[i] - a[i]) for i in range(2)])
        points = output
        if not points:
            break
    return [[round(p[1], 6), round(p[0], 6)] for p in points]  # compiler lat, lon

raw = Path(sys.argv[1]).read_bytes() if len(sys.argv) > 1 else urllib.request.urlopen(URL, timeout=60).read()
assert hashlib.sha256(raw).hexdigest() == SHA
polygons = []
for feature in json.loads(raw)['features']:
    geom = feature['geometry']
    for polygon in geom['coordinates'] if geom['type'] == 'MultiPolygon' else [geom['coordinates']]:
        rings = [clip(r) for r in polygon]
        if len(rings[0]) >= 3:
            polygons.append([r for r in rings if len(r) >= 3])
dest = Path(__file__).resolve().parents[2] / 'RTSAI-Web/data/hormuz-land.json'
dest.write_text(json.dumps(dict(source=URL, sourceSha256=SHA, license='Public domain', scale='1:10,000,000', coverage=BOX, polygons=polygons), separators=(',', ':')) + '\n', encoding='utf-8')
print(f'{dest}: {len(polygons)} land polygons, {dest.stat().st_size} bytes')
