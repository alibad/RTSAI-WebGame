"""How an original weapon's hit looks follows Red Alert 2's own rules (tools/ea_retail.py): the impact animation is the
warhead's AnimList entry for the weapon's damage, in bands of 25, and animations art.ini marks Translucent are drawn at
half strength. Checked on the RA2 facts in tools/data and on made-up rules, so no original files are needed."""
import json
from pathlib import Path
import unittest
import ea_originals as E
import ea_retail as R

LOOK = json.loads((Path(__file__).parent / 'data/ra2-weapon-look.json').read_text(encoding='utf-8'))
EXPLOSION = E.parse('''explosion:
	building:
		Filename: twlt070.shp
	tiny_grey_explosion:
		Filename: xgrysml1.shp
	small_grey_explosion:
		Filename: xgrysml2.shp
	small_explosion:
		Filename: explosml.shp
	medium_grey_explosion:
		Filename: xgrymed1.shp
	large_grey_explosion:
		Filename: xgrymed2.shp
	medium_explosion:
		Filename: explomed.shp
	large_explosion:
		Filename: explolrg.shp
	large_twlt:
		Filename: twlt070.shp
	tiny_clsn:
		Filename: s_clsn16.shp
	small_clsn:
		Filename: s_clsn22.shp
	medium_clsn:
		Filename: s_clsn30.shp
''')[0]


def weapon(explosion='medium_clsn'):
    return E.parse(f'''ea-retail-x:
	Warhead@1Dam: SpreadDamage
		Damage: 100
	Warhead@2Eff: CreateEffect
		Explosions: {explosion}
		ValidTargets: Ground, Air
	Warhead@3EffWater: CreateEffect
		Explosions: small_watersplash
		ValidTargets: Water
''')[0]


class ImpactByDamage(unittest.TestCase):
    files = R.explosion_files(E, EXPLOSION)

    def pick(self, damage, anims):
        w = weapon()
        chosen = R.retail_impact(E, w, {'Damage': str(damage)}, {'AnimList': anims}, self.files)
        return chosen, w

    def test_bands_of_25_and_the_last_past_the_end(self):
        comet = LOOK['weapons']['comet']
        wh = {'AnimList': comet['impact']}
        self.assertEqual(self.pick(24, wh['AnimList'])[0], 'tiny_grey_explosion')
        self.assertEqual(self.pick(25, wh['AnimList'])[0], 'small_grey_explosion')
        # The Prism Tank: 100 damage, RA2's grey smoke puff XGRYMED2, not a fireball.
        self.assertEqual(self.pick(int(comet['damage']), wh['AnimList'])[0], 'large_grey_explosion')
        self.assertEqual(self.pick(1000, wh['AnimList'])[0], 'large_twlt')  # twlt070 is a blast, not a building's death

    def test_tank_shells_land_with_rams_small_blast(self):
        # The Rhino: AP warhead (S_CLSN16, S_CLSN22), 90 damage: the second, smaller than the port's medium_clsn.
        self.assertEqual(LOOK['weapons']['120mm']['impact'].lower(), 's_clsn16,s_clsn22')
        self.assertEqual(self.pick(90, 'S_CLSN16,S_CLSN22')[0], 'small_clsn')

    def test_water_splash_and_unknown_files_are_kept(self):
        chosen, w = self.pick(100, 'XGRYMED2')
        self.assertEqual(w.get('Warhead@3EffWater').val('Explosions'), 'small_watersplash')
        self.assertIsNone(self.pick(100, 'NOTANANIM')[0])
        self.assertIsNone(self.pick(0, 'XGRYMED2')[0])
        self.assertIsNone(R.retail_impact(E, weapon(), {'Damage': '100'}, {'AnimList': 'XGRYMED2', 'EMEffect': 'yes'}, self.files))


class ProjectilePalettes(unittest.TestCase):
    def test_original_trails_and_shells_without_a_palette_get_the_original_one(self):
        torpedo = E.parse('''ea-retail-subtorpedo:
	Projectile: Missile
		Image: ea-missile
		Palette: shadow
		TrailImage: ea-bbblelrg
''')[0].get('Projectile')
        self.assertEqual(R.original_projectile_palettes(E, torpedo), 1)
        self.assertEqual(torpedo.val('TrailPalette'), 'eaeffect')  # the bubbles: RA2's animation palette
        self.assertEqual(torpedo.val('Palette'), 'shadow')  # the torpedo keeps its dark underwater look
        shell = E.parse('''w:
	Projectile: Bullet
		Image: ea-120mm
''')[0].get('Projectile')
        self.assertEqual(R.original_projectile_palettes(E, shell), 1)
        self.assertEqual(shell.val('Palette'), 'eaeffect')
        modern = E.parse('''w:
	Projectile: Missile
		Image: dragon
		TrailImage: smokey2
''')[0].get('Projectile')
        self.assertEqual(R.original_projectile_palettes(E, modern), 0)  # project art keeps the project palette


class Translucency(unittest.TestCase):
    def test_translucent_animations_are_drawn_at_half_strength(self):
        images = E.parse('''ea-explosion:
	large_grey_explosion:
		Filename: ra2|web/ea/xgrymed2.shp
	apoc_explosion:
		Filename: ra2|web/ea/apocexp.shp
	already:
		Filename: ra2|web/ea/s_clsn30.shp
		Alpha: 0.8
''')
        self.assertEqual(R.translucent_sequences(E, images, LOOK['anims']), 1)
        seqs = images[0]
        self.assertEqual(seqs.get('large_grey_explosion').val('Alpha'), '0.5')  # art.ini: Translucent=yes
        self.assertIsNone(seqs.get('apoc_explosion').get('Alpha'))  # APOCEXP is solid in RA2 too
        self.assertEqual(seqs.get('already').val('Alpha'), '0.8')  # a sequence's own choice is kept

    def test_every_impact_of_the_prism_and_the_tank_guns_is_translucent_in_ra2(self):
        for name in ('xgrymed2', 's_clsn22', 's_clsn30', 'explosml', 'twlt070'):
            self.assertEqual(LOOK['anims'][name].get('Translucent'), 'yes', name)


if __name__ == '__main__':
    unittest.main()
