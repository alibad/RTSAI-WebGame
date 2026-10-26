"""The shared infantry-rocket visual must fit a tank and keep its authored contact point."""
import hashlib
import json
from pathlib import Path
import unittest
from types import SimpleNamespace
import ea_originals as E
from effect_anchors import anchor_patches

MOD = Path(__file__).resolve().parents[2] / 'RTSAI-Mod'
ROCKETS = ('R2ChinaPortableAT', 'R2ToophanMissile', 'R2PortableAT',
           'R2SaudiATGM', 'R2ILSaudiATGM', 'R2YemenRPG', 'R2HZYemenRPG')


class RocketImpacts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        manifest = (MOD / 'mods/rtsai/mod.yaml').read_text(encoding='utf-8')
        files = E.ModFiles(MOD)
        cls.weapons = files.load(E._section(manifest, 'Weapons'))
        cls.sequences = files.load(E._section(manifest, 'Sequences'))

    def test_all_seven_infantry_rockets_draw_the_compact_effect(self):
        for name in ROCKETS:
            with self.subTest(weapon=name):
                effect = self.weapons[name].get('Warhead@2Eff')
                self.assertEqual(effect.val('Image'), 'rtsai-atgm-impact')
                self.assertEqual(effect.val('Explosions'), 'impact')
                self.assertEqual(effect.value, 'CreateEffect')

    def test_visible_footprint_and_fixed_contact(self):
        effect = self.sequences['rtsai-atgm-impact'].get('impact')
        self.assertEqual(effect.val('Length'), '*')
        scale = float(effect.val('Scale'))
        self.assertGreater(scale, 0)
        self.assertLessEqual(scale, 0.25, 'The rocket flash must not dwarf a tank')
        record = json.loads((Path(__file__).parent / 'data/project-effect-anchors.json').read_text())['effects']['s_clsn58.shp']
        data = (MOD / 'mods/rtsai/standalone/effects/s_clsn58.shp').read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), record['sha256'], 'Audit a changed sprite before reusing its pivot')
        x, y, _ = map(float, effect.val('Offset').split(','))
        self.assertEqual(x, 0)
        self.assertEqual((y + record['groundY']) * scale, 0, 'Scale both pixels and pivot so contact stays exactly at the hit')
        self.assertLessEqual(record['canvas'][0] * scale, 48, 'Fixed canvas fits within one normal tank footprint')
        patches = anchor_patches(SimpleNamespace(curseq=self.sequences, mod_root=MOD), E)
        self.assertNotIn('rtsai-atgm-impact', [p.key for p in patches], 'The generic browser anchor must not apply twice')

    def test_large_weapons_keep_their_own_art(self):
        for name in ('Maverick', 'R2F15Strike', 'R2ILF15Strike'):
            with self.subTest(weapon=name):
                effect = self.weapons[name].get('Warhead@2Eff')
                self.assertNotEqual(effect.val('Image'), 'rtsai-atgm-impact')


if __name__ == '__main__':
    unittest.main()
