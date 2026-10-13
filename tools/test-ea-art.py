#!/usr/bin/env python3
"""Original-art (EA) regressions.

Unit checks (always): the MiniYaml port's merge/inheritance/removal semantics, the web manifest order, the art
allowlist and the footprint exclusions.
Generated-content checks (with --content <generated content dir> [--ea-art <verified original-art dir>]):
  * every original file the overlays name is in EA-INPUTS.json (and the allowlist), no audio anywhere;
  * every actor's FactionImages keys equal its WithFactionPalettes/GrantConditionOnFaction factions, all original
    countries and nothing else, and every image it names is generated;
  * the five footprint-mismatched Soviet buildings get no original art.
  python tools/test-ea-art.py [--content D:/build/public-iso/content --ea-art D:/rtsai-ea-build/ea-art]
"""
import argparse
import json
from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ea_originals as E  # noqa: E402

ARGS = None


class MiniYaml(unittest.TestCase):
    def merged(self, *texts):
        return E.merge([E.parse(t, f'f{i}') for i, t in enumerate(texts)])

    def test_inherits_and_removal_across_files(self):
        tree = self.merged('^Base:\n\tA:\n\t\tX: 1\n\tB:\n\tC:\nunit:\n\tInherits: ^Base\n\tA:\n\t\tY: 2\n',
                           'unit:\n\t-B:\n\tD: d\n')
        unit = tree['unit']
        self.assertEqual([c.key for c in unit.children], ['A', 'C', 'D'])
        self.assertEqual(unit.get('A').val('X'), '1')
        self.assertEqual(unit.get('A').val('Y'), '2')

    def test_readd_after_removal_starts_fresh(self):
        tree = self.merged('unit:\n\tT:\n\t\tOld: 1\n', 'unit:\n\t-T:\n', 'unit:\n\tT:\n\t\tNew: 2\n')
        t = tree['unit'].get('T')
        self.assertIsNone(t.val('Old'))
        self.assertEqual(t.val('New'), '2')

    def test_empty_value_does_not_override(self):
        tree = self.merged('unit:\n\tT: value\n', 'unit:\n\tT:\n\t\tChild: 1\n')
        self.assertEqual(tree['unit'].get('T').value, 'value')

    def test_comments_and_escapes(self):
        n = E.parse('a: b # comment\nc: d\\#e\n')
        self.assertEqual((n[0].value, n[1].value), ('b', 'd#e'))

    def test_removing_missing_key_fails(self):
        with self.assertRaises(ValueError):
            self.merged('unit:\n\t-Nothing:\n')


class Manifest(unittest.TestCase):
    def test_web_content_goes_before_the_mods_country_files(self):
        text = 'Rules:\n\tra2|a.yaml\n\n\tra2|campaigns/countries.yaml\n\nSequences:\n\tra2|s.yaml\n\n\tra2|campaigns/country-sequences.yaml\n\nModelSequences:\n\tra2|v.yaml\n\nCursors:\n'
        rules, seqs, models = E.web_lists(text)
        self.assertEqual(rules, ['ra2|a.yaml', 'ra2|web/content/countries.yaml', 'ra2|campaigns/countries.yaml'])
        self.assertEqual(seqs, ['ra2|s.yaml', 'ra2|web/content/country-sequences.yaml', 'ra2|campaigns/country-sequences.yaml'])
        self.assertEqual(models, ['ra2|v.yaml'])

    def test_allowlist_is_art_only(self):
        self.assertEqual(set(E.ALLOWED_EXTENSIONS), {'.shp', '.vxl', '.hva', '.pal'})
        self.assertEqual(set(E.FOOTPRINT_EXCLUDED), {'napowr', 'nahand', 'nadept', 'natech', 'nanrct'})

    def test_condition_combination(self):
        self.assertEqual(E.both('ea-art', 'false'), 'ea-art && (false)')
        self.assertEqual(E.both('!ea-art', ''), '!ea-art')
        self.assertEqual(E.both('ea-art', '!a || b'), 'ea-art && (!a || b)')

    def test_blank_png_is_a_transparent_rgba_pixel(self):
        png = E.blank_png()
        self.assertEqual(png[:8], b'\x89PNG\r\n\x1a\n')
        self.assertEqual(png[25], 6)


class Generated(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not ARGS.content:
            raise unittest.SkipTest('pass --content to check generated content')
        cls.content = ARGS.content
        cls.rules = {n.key: n for n in E.parse((cls.content / 'ea-art.yaml').read_text(encoding='utf-8'))}
        cls.seqs = {n.key: n for n in E.parse((cls.content / 'ea-sequences.yaml').read_text(encoding='utf-8'))}
        cls.models = {n.key: n for n in E.parse((cls.content / 'ea-models.yaml').read_text(encoding='utf-8'))}
        cls.files = json.loads((cls.content / 'ea-files.json').read_text(encoding='utf-8'))

    def referenced(self):
        names = set()
        for text in [(self.content / f).read_text(encoding='utf-8') for f in ('ea-art.yaml', 'ea-sequences.yaml', 'ea-models.yaml')]:
            names.update(m.lower() for m in re.findall(r'ra2\|web/ea/([A-Za-z0-9_.-]+)', text))
        return names

    def test_overlay_files_are_planned_art(self):
        referenced = self.referenced()
        model_files = {f + ext for f in referenced if '.' not in f for ext in ('.vxl', '.hva')}
        sprite_files = {f for f in referenced if '.' in f}
        planned = set(self.files['files'])
        self.assertTrue(sprite_files <= planned, sorted(sprite_files - planned))
        self.assertTrue(model_files <= planned, sorted(model_files - planned))
        for f in planned:
            self.assertIn(Path(f).suffix, E.ALLOWED_EXTENSIONS, f)

    def test_overlay_names_are_in_the_manifest(self):
        if not ARGS.ea_art:
            self.skipTest('pass --ea-art to check against EA-INPUTS.json')
        manifest = json.loads((ARGS.ea_art / 'EA-INPUTS.json').read_text())
        listed = {f['name'] for f in manifest['files']}
        self.assertTrue(set(self.files['files']) <= listed, sorted(set(self.files['files']) - listed))
        self.assertEqual(manifest['notice'], 'EA has not endorsed and does not support this product.')
        for f in manifest['files']:
            self.assertIn(Path(f['name']).suffix, E.ALLOWED_EXTENSIONS, f['name'])
        audio = [p.name for p in ARGS.ea_art.iterdir() if p.suffix.lower() in ('.aud', '.wav', '.bag', '.idx', '.mix', '.ogg', '.mp3', '.vqa', '.bik')]
        self.assertEqual(audio, [])

    def test_faction_images_match_trait_factions(self):
        checked = 0
        for key, actor in self.rules.items():
            if key.startswith('^'):
                continue
            rs = actor.get('RenderSprites')
            palettes = actor.get('WithFactionPalettes@ea')
            grant = actor.get('GrantConditionOnFaction@ea-art')
            if rs is None:
                self.assertIsNone(palettes, key)
                continue
            images = {c.key: c.value for c in rs.get('FactionImages').children}
            factions = E.split_list(palettes.val('Factions'))
            self.assertEqual(sorted(images), sorted(factions), key)
            self.assertTrue(set(factions) <= set(E.COUNTRIES), key)
            if grant is not None:
                self.assertEqual(sorted(E.split_list(grant.val('Factions'))), sorted(factions), key)
            for image in images.values():
                self.assertTrue(image.startswith('ea-') and image in self.seqs, f'{key}: {image}')
            voxels = actor.get('RenderVoxels')
            if voxels is not None and voxels.val('Image'):
                self.assertIn(voxels.val('Image'), self.models, key)
            checked += 1
        self.assertGreater(checked, 40)

    def test_footprint_exclusions(self):
        for name in E.FOOTPRINT_EXCLUDED:
            self.assertNotIn(name, {k.lower() for k in self.rules})

    def test_palettes(self):
        palettes = {c.key for c in self.rules['^Palettes'].children}
        self.assertIn('PlayerColorPalette@eaplayer', palettes)
        for key, actor in self.rules.items():
            t = actor.get('WithFactionPalettes@ea')
            if t is None:
                continue
            for group in ('PlayerPalettes', 'Palettes'):
                for p in (t.get(group).children if t.get(group) is not None else []):
                    self.assertIn(p.value, E.EA_PALETTE_NAMES | E.NEUTRAL_PALETTES, f'{key}: {p.value}')


def main():
    global ARGS
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--content', type=Path)
    ap.add_argument('--ea-art', type=Path)
    ARGS, rest = ap.parse_known_args()
    unittest.main(argv=[sys.argv[0], *rest], verbosity=2)


if __name__ == '__main__':
    main()
