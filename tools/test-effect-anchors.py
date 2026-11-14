import hashlib
from pathlib import Path
from types import SimpleNamespace
import struct
import tempfile
import unittest
import ea_originals as E
from effect_anchors import anchor_patches, canvas_of


class ImpactAnchors(unittest.TestCase):
    def fixture(self, root):
        folder = Path(root) / 'mods/rtsai/standalone/effects'
        folder.mkdir(parents=True)
        data = struct.pack('<4H', 0, 182, 156, 21) + b'unchanged fixed-canvas frames'
        (folder / 's_clsn58.shp').write_bytes(data)
        records = {'s_clsn58.shp': {'sha256': hashlib.sha256(data).hexdigest(), 'groundY': 72, 'canvas': [182, 156]}}
        sequences = E.parse('explosion:\n\tDefaults:\n\t\tOffset: 0, 0, 30\n\tverylarge_clsn:\n\t\tFilename: s_clsn58.shp\n\tother:\n\t\tFilename: different.shp\nea-explosion:\n\tverylarge_clsn:\n\t\tFilename: ra2|web/ea/s_clsn58.shp\n\t\tOffset: 0, 0, 30\n')
        return SimpleNamespace(mod_root=Path(root), curseq={node.key: node for node in sequences}), records, data

    def test_contact_point_maps_to_the_warhead_position(self):
        with tempfile.TemporaryDirectory() as root:
            g, records, data = self.fixture(root)
            patches = anchor_patches(g, E, records)
            merged = E.merge([list(g.curseq.values()), patches])
            offset = merged['explosion'].get('verylarge_clsn').val('Offset')
            self.assertEqual(offset, '0, -72, 30')
            self.assertEqual(72 + float(offset.split(',')[1]), 0, 'Authored ground contact must land at impact, in every animation frame')
            self.assertEqual(merged['ea-explosion'].get('verylarge_clsn').val('Offset'), '0, 0, 30')
            self.assertIsNone(merged['explosion'].get('other').get('Offset'))
            self.assertEqual((g.mod_root / 'mods/rtsai/standalone/effects/s_clsn58.shp').read_bytes(), data)
            self.assertEqual([node.key for node in patches], ['explosion'])

    def test_rejects_a_changed_artifact_before_reusing_its_anchor(self):
        with tempfile.TemporaryDirectory() as root:
            g, records, _ = self.fixture(root)
            (g.mod_root / 'mods/rtsai/standalone/effects/s_clsn58.shp').write_bytes(b'different artwork')
            with self.assertRaisesRegex(ValueError, 'artwork changed'):
                anchor_patches(g, E, records)

    # The explosions are RGBA sheets since 14 Nov 2026: a sheet's canvas is its FrameSize text chunk.
    @staticmethod
    def sheet(width, height):
        def chunk(kind, body):
            return struct.pack('>I', len(body)) + kind + body + b'\0\0\0\0'
        return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width * 3, height, 8, 6, 0, 0, 0))
                + chunk(b'tEXt', b'FrameSize\0' + f'{width},{height}'.encode()) + chunk(b'tEXt', b'FrameAmount\0003')
                + chunk(b'IDAT', b'frames') + chunk(b'IEND', b''))

    def sheet_fixture(self, root):
        folder = Path(root) / 'mods/rtsai/standalone/effects'
        folder.mkdir(parents=True)
        data = self.sheet(182, 156)
        (folder / 's_clsn58.png').write_bytes(data)
        records = {'s_clsn58.png': {'sha256': hashlib.sha256(data).hexdigest(), 'groundY': 72, 'canvas': [182, 156]}}
        sequences = E.parse('explosion:\n\tDefaults:\n\t\tOffset: 0, 0, 30\n\tverylarge_clsn:\n\t\tFilename: s_clsn58.png\n')
        return SimpleNamespace(mod_root=Path(root), curseq={node.key: node for node in sequences}), records

    def test_a_sheet_keeps_the_contact_point_of_the_shp_it_replaced(self):
        self.assertEqual(canvas_of('s_clsn58.png', self.sheet(182, 156)), [182, 156])
        self.assertIsNone(canvas_of('s_clsn58.png', b'not a picture'))
        with tempfile.TemporaryDirectory() as root:
            g, records = self.sheet_fixture(root)
            merged = E.merge([list(g.curseq.values()), anchor_patches(g, E, records)])
            self.assertEqual(merged['explosion'].get('verylarge_clsn').val('Offset'), '0, -72, 30')

    def test_rejects_a_sheet_on_another_canvas(self):
        with tempfile.TemporaryDirectory() as root:
            g, records = self.sheet_fixture(root)
            data = self.sheet(200, 156)
            (g.mod_root / 'mods/rtsai/standalone/effects/s_clsn58.png').write_bytes(data)
            records['s_clsn58.png']['sha256'] = hashlib.sha256(data).hexdigest()
            with self.assertRaisesRegex(ValueError, 'canvas differs'):
                anchor_patches(g, E, records)


if __name__ == '__main__':
    unittest.main()
