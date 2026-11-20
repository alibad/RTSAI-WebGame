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

    def test_every_input_names_its_git_commit(self):
        # The three shapes RTSAI-Mod tools/build-inputs.py writes into INPUTS.json.
        engine=inputs.source('engine',{'kind':'engine-archive','commit':'a'*40})
        self.assertEqual(engine,{'repository':'alibad/OpenRA','commit':'a'*40,'uncommittedFiles':0})
        committed=inputs.source('mod',{'kind':'committed-tree-snapshot','head':'b'*40,'excludedWorkingChanges':[' M x']})
        self.assertEqual(committed,{'repository':'alibad/RTSAI-Mod','commit':'b'*40,'uncommittedFiles':0})
        working=inputs.source('missions',{'kind':'working-tree-snapshot','head':'c'*40,'dirtyPaths':[' M a','?? b']})
        self.assertEqual(working['uncommittedFiles'],2)
        with self.assertRaises(ValueError):inputs.source('mod',{'kind':'working-tree-snapshot'})

if __name__=='__main__':unittest.main()
