"""Static map packages must boot without the omitted lazy artwork archive."""
import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('map_release', Path(__file__).with_name('prepare-map-release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

class MapPackagingTest(unittest.TestCase):
    def test_large_previews_are_resident_even_when_input_was_lazy(self):
        preview = b'preview' * 10000
        core = {'mods/example/maps/new/map.png': preview, 'mods/example/maps/new/map.yaml': b'Title: New'}
        art = {'mods/example/maps/old/map.png': preview, 'mods/example/unit.png': preview}
        before = {**core, **art}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            release.emit(root, core, art, {}, {})
            resident = release.read_pack(root / 'web-bundle.pack')
            lazy = release.read_pack(root / 'web-art.pack')
            self.assertEqual(resident['mods/example/maps/new/map.png'], preview)
            self.assertEqual(resident['mods/example/maps/old/map.png'], preview)
            self.assertFalse(any('/maps/' in name for name in lazy))
            for name, data in before.items():
                self.assertEqual({**resident, **lazy}[name], data)
            self.assertIn('mods/example/unit.png', lazy)

if __name__ == '__main__':
    unittest.main()
