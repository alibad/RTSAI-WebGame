#!/usr/bin/env python3
"""Public input safety gate regressions, without copying or generating game assets."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('prepare_inputs',Path(__file__).with_name('prepare-inputs.py'))
inputs=importlib.util.module_from_spec(spec);spec.loader.exec_module(inputs)

class PublicInputs(unittest.TestCase):
    def fixture(self,root):
        mod=root/'mods/rtsai';(mod/'standalone').mkdir(parents=True)
        (mod/'standalone/base-kit.yaml').write_text('project authored base')
        (mod/'mod.yaml').write_text('FileSystem: DefaultFileSystem\n\tPackages:\n\t\t^EngineDir\n\t\t$rtsai: ra2\nMapFolders:\n\tra2|standalone/maps: System\n')
        return mod

    def test_standalone_gate_requires_kit_and_rejects_owned_mount(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);mod=self.fixture(root);self.assertEqual(inputs.standalone(root)['profile'],'standalone-main')
            original=(mod/'mod.yaml').read_text()
            (mod/'mod.yaml').write_text(original.replace('^EngineDir','content|ra2.mix'))
            with self.assertRaises(ValueError):inputs.standalone(root)
            (mod/'mod.yaml').write_text(original);(mod/'standalone/base-kit.yaml').unlink()
            with self.assertRaises(ValueError):inputs.standalone(root)

    def test_owned_archive_is_rejected_even_if_not_mounted(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);mod=self.fixture(root)
            (mod/'unmounted.mix').write_bytes(b'owned content')
            with self.assertRaises(ValueError):inputs.standalone(root)

if __name__=='__main__':unittest.main()
