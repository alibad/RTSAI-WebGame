import hashlib
from pathlib import Path
from types import SimpleNamespace
import struct
import tempfile
import unittest
import ea_originals as E
from effect_anchors import anchor_patches


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


if __name__ == '__main__':
    unittest.main()
