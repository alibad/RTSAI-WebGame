#!/usr/bin/env python3
"""Original-art and original-voice (EA) regressions.

Unit checks (always): the MiniYaml port's merge/inheritance/removal semantics, the web manifest order, the art
allowlist and original foundation restoration; the voice generator's file resolution (prefixes, variants), the clip allowlist
(no EVA, music or archives), the WAVE and audio.idx readers.
Generated-content checks (with --content <generated content dir> [--ea-art <verified original-art dir>]):
  * every original file the overlays name is in EA-INPUTS.json (and the allowlist), no audio among the art files;
  * every actor's FactionImages keys equal its WithFactionPalettes/GrantConditionOnFaction factions, all original
    countries and nothing else, and every image it names is generated;
  * original foundations, miner unloading models and support-power cameos are retained;
  * voices: the rules overlay touches voice traits and voice-only conditions only, granted to original countries only
    (the dog: its original voice for everyone, no condition); every original clip a voice set or the dog's bite names
    is listed in EA-INPUTS.json's audio, which lists exactly the clips the content plays.
  python tools/test-ea-art.py [--content D:/build/public-iso/content --ea-art D:/Builds/RTSAI/ea-build/ea-art]
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import struct
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ea_originals as E  # noqa: E402
import ea_voices as V  # noqa: E402

_spec = importlib.util.spec_from_file_location('prepare_ea_art', Path(__file__).resolve().parent / 'prepare-ea-art.py')
P = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(P)

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
        self.assertEqual(set(E.RESTORED_FOUNDATIONS), {'napowr', 'nahand', 'nadept', 'natech', 'nanrct'})

    def test_condition_combination(self):
        self.assertEqual(E.both('ea-art', 'false'), 'ea-art && (false)')
        self.assertEqual(E.both('!ea-art', ''), '!ea-art')
        self.assertEqual(E.both('ea-art', '!a || b'), 'ea-art && (!a || b)')

    def test_blank_png_is_a_transparent_rgba_pixel(self):
        png = E.blank_png()
        self.assertEqual(png[:8], b'\x89PNG\r\n\x1a\n')
        self.assertEqual(png[25], 6)


class OriginalTurrets(unittest.TestCase):
    """The original voxel turret sits where the original rules put it, not where the stand-in moved the shared turret
    (the Flak Track's gun floated half a cell above its hull until 20 November 2026)."""
    # Shapes of the real htk: the kit's sprite turret lifted to 0,0,582, the reference turret on the rear deck.
    CUR = ('htk:\n\tTurreted:\n\t\tTurnSpeed: 60\n\t\tOffset: 0,0,582\n\tAttackTurreted:\n\t\tVoice: Attack\n'
           '\tArmament@primary:\n\t\tWeapon: FlakTrackGun\n\t\tLocalOffset: 489,-244,212\n'
           '\tWithVoxelTurret:\n\t\tRequiresCondition: false\n')
    REF = ('htk:\n\tTurreted:\n\t\tTurnSpeed: 60\n\t\tOffset: -280,-3,0\n\tAttackTurreted:\n\t\tVoice: Attack\n'
           '\tArmament@primary:\n\t\tWeapon: FlakTrackGun\n\t\tLocalOffset: 256,0,1536\n\tWithVoxelTurret:\n')
    OUT = ('htk:\n\tWithVoxelTurret:\n\t\tRequiresCondition: ea-art\n\tArmament@primary:\n\t\tRequiresCondition: !ea-art\n'
           '\tArmament@retail-primary:\n\t\tWeapon: ea-retail-flaktrackgun\n\t\tName: retail-armament-primary\n'
           '\t\tRequiresCondition: ea-art && (!rank-elite)\n'
           '\tArmament@retail-primary-missing-elite:\n\t\tWeapon: ea-retail-flaktrackgune\n\t\tRequiresCondition: ea-art && (rank-elite)\n'
           '\tAttackTurreted:\n\t\tArmaments: primary, retail-armament-primary\n')

    def actors(self, cur=None, ref=None):
        return [E.parse(t)[0] for t in (cur or self.CUR, ref or self.REF, self.OUT)]

    def test_a_moved_stand_in_turret_gives_the_original_art_its_own(self):
        cur, ref, out = self.actors()
        self.assertEqual(E.original_turrets('htk', cur, ref, out), {'primary': ['0,0,582', '-280,-3,0']})
        twin = out.get('Turreted@ea')
        self.assertEqual((twin.val('Turret'), twin.val('Offset'), twin.val('TurnSpeed'), twin.val('RequiresCondition')),
                         ('ea', '-280,-3,0', '60', 'ea-art'))
        self.assertEqual(out.get('WithVoxelTurret').val('Turret'), 'ea')
        # The original guns fire from it at the original rules' muzzle (the kit's put the flash beside the hull).
        for key in ('Armament@retail-primary', 'Armament@retail-primary-missing-elite'):
            self.assertEqual((out.get(key).val('Turret'), out.get(key).val('LocalOffset')), ('ea', '256,0,1536'), key)
        # The stand-in's armament keeps the stand-in's turret and muzzle; the attack turns both turrets.
        self.assertIsNone(out.get('Armament@primary').val('Turret'))
        self.assertIsNone(out.get('Armament@primary').val('LocalOffset'))
        self.assertEqual(E.split_list(out.get('AttackTurreted').val('Turrets')), ['primary', 'ea'])
        self.assertEqual(out.get('AttackTurreted').val('Armaments'), 'primary, retail-armament-primary')

    def test_a_turret_in_its_original_place_is_left_alone(self):
        cur, ref, out = self.actors(cur=self.CUR.replace('0,0,582', '-280,-3,0'))
        before = E.dump([out])
        self.assertEqual(E.original_turrets('htk', cur, ref, out), {})
        self.assertEqual(E.dump([out]), before)

    def test_an_original_gun_with_shared_shots_is_refused(self):
        cur, ref, out = self.actors()
        out.children = [c for c in out.children if not c.key.startswith('Armament@retail')]
        with self.assertRaises(E.GenerationError):
            E.original_turrets('htk', cur, ref, out)


class Voices(unittest.TestCase):
    def test_files_follow_prefixes_and_variants(self):
        node = E.parse('Engineer:\n\tDefaultVariant: .wav\n\tPrefixes:\n\t\tamerica: iena\n\t\tcuba: iens\n'
                       '\tVariants:\n\t\tkorea: .aud\n\tDisablePrefixes: Zapped\n\tVoices:\n\t\tSelect: sea, seb\n\t\tZapped: igenzapa\n')[0]
        v = V.VoiceSet('Engineer', node)
        self.assertEqual(v.files('Select', 'america'), ['ienasea.wav', 'ienaseb.wav'])
        self.assertEqual(v.files('Select', 'cuba'), ['ienssea.wav', 'iensseb.wav'])
        self.assertEqual(v.files('Select', 'korea'), ['sea.aud', 'seb.aud'])
        self.assertEqual(v.files('Zapped', 'cuba'), ['igenzapa.wav'])

    def test_several_prefixes_per_faction_are_refused(self):
        node = E.parse('X:\n\tPrefixes:\n\t\tamerica: a, b\n\tVoices:\n\t\tSelect: s\n')[0]
        with self.assertRaises(V.VoiceError):
            V.VoiceSet('X', node)

    def test_clip_names(self):
        self.assertEqual(V.clip_file('IGISEA.WAV'), 'igisea.wav')
        self.assertIsNone(V.clip_file('ra2|modern-factions/audio/rcn-infantry-select-en.wav'))
        self.assertIsNone(V.clip_file('igisea.aud'))
        with self.assertRaises(V.VoiceError):
            V.clip_file('a-very-long-project-clip-name.wav')
        self.assertIsNone(V.clip_file('a-very-long-project-clip-name.wav', strict=False))

    def test_ra2_death_sound_facts(self):
        # tools/data/ra2-death-sounds.json is read from the same rules.ini as the retail facts.
        facts = json.loads(V.DEATH_FACTS.read_text(encoding='utf-8'))
        retail = json.loads((Path(__file__).resolve().parent / 'data/ra2-retail.json').read_text(encoding='utf-8'))
        self.assertEqual(facts['sourceSha256']['rules.ini'], retail['sourceSha256'])
        self.assertEqual(facts['buildingDieSound'], 'BuildingGenericDie')
        for actor in ('htnk', 'mtnk', 'apoc', 'harv', 'fv'):
            self.assertEqual(facts['actors'][actor]['dieSound'], 'GenVehicleDie', actor)
        self.assertEqual(facts['actors']['gapowr']['dieSound'], 'PowerPlantDie')
        self.assertEqual(facts['sounds']['GenVehicleDie']['clips'], [f'vgendie{c}.wav' for c in 'abcdef'])
        self.assertEqual(facts['animations']['TWLT070'], 'Explosion09')
        for s in facts['sounds'].values():
            for c in s['clips']:
                self.assertTrue(P.allowed_audio(c), c)
        for c in ('rtsai-explode-small.wav', 'ra2|audio/sfx/rtsai-explode-medium.wav'):
            self.assertTrue(V.STAND_IN_DEATH.search('ra2|audio/sfx/' + c.split('/')[-1]), c)
        self.assertIsNone(V.STAND_IN_DEATH.search('ra2|web/ea/audio/vgendiea.wav'))

    def test_clip_allowlist(self):
        for ok in ('igisea.wav', 'idogatta.wav', 'vsquat1a.wav'):
            self.assertTrue(P.allowed_audio(ok), ok)
        for bad in ('ceva001.wav', 'theme.mix', 'audio.bag', 'audio.idx', 'grinder.aud', '../igisea.wav', 'a/b.wav', 'IGISEA.WAV'):
            self.assertFalse(P.allowed_audio(bad), bad)

    @staticmethod
    def wave(code, data, rate=22050, align=512, per_block=1017):
        fmt = struct.pack('<HHIIHH', code, 1, rate, rate, align if code == 17 else 2, 4 if code == 17 else 16)
        if code == 17:
            fmt += struct.pack('<HH', 2, per_block)
        body = b'WAVE' + b'fmt ' + struct.pack('<I', len(fmt)) + fmt + b'data' + struct.pack('<I', len(data)) + data
        return b'RIFF' + struct.pack('<I', len(body)) + body

    def test_wave_reader(self):
        adpcm = P.wav_info(self.wave(17, b'\0' * 1024))
        self.assertEqual((adpcm['format'], adpcm['data'], adpcm['seconds']), ('ima-adpcm', 1024, round(2 * 1017 / 22050, 3)))
        pcm = P.wav_info(self.wave(1, b'\0' * 44100))
        self.assertEqual((pcm['format'], pcm['seconds']), ('pcm', 1.0))
        with self.assertRaises(ValueError):
            P.wav_info(b'RIFF\0\0\0\0AVI LIST')
        with self.assertRaises(ValueError):
            P.check_clip('igisea.wav', self.wave(1, b'\0' * (P.MAX_CLIP_BYTES + 2)))
        with self.assertRaises(ValueError):
            # Small but long: 1000 bytes at 10 Hz is 50 s, music or speech rather than a clip.
            P.check_clip('igisea.wav', self.wave(1, b'\0' * 1000, rate=10))
        self.assertEqual(P.check_clip('igisea.wav', self.wave(17, b'\0' * 1024))['format'], 'ima-adpcm')

    def test_audio_index_reader(self):
        entry = b'igisea'.ljust(16, b'\0') + struct.pack('<5I', 10, 20, 22050, 12, 512)
        index = P.read_idx(b'GABA' + struct.pack('<ii', 2, 1) + entry)
        self.assertEqual(index, {'igisea.wav': (10, 20, 22050, 12, 512)})
        with self.assertRaises(ValueError):
            P.read_idx(b'MIX1' + b'\0' * 8)


class Generated(unittest.TestCase):
    def test_confirmed_retail_stats_are_restored(self):
        import ea_retail
        fields = {'Cost': ('Valued', 'Cost'), 'Strength': ('Health', 'HP'),
                  'Armor': ('Armor', 'Type'), 'Sight': ('RevealsShroud', 'Range'), 'Power': ('Power', 'Amount')}
        for difference in ea_retail.load_baseline()['confirmedStats']:
            kind, field = fields[difference['field']]
            expected = ea_retail.cells(difference['retail']) if difference['field'] == 'Sight' else difference['retail']
            self.assertEqual(self.rules[difference['actor']].get(kind).val(field).lower(), expected.lower(), difference)

    def test_original_weapons_do_not_leak_through_modern_inheritance(self):
        retail = [(actor, arm) for actor, node in self.rules.items()
                  for _, arm in E.traits(node, 'Armament')
                  if arm.val('Weapon', '').startswith('ea-retail-')]
        self.assertTrue(retail)
        for actor, arm in retail:
            if arm.key == 'Armament@retail-garrison':
                # Fired from inside an occupied civilian building (ea_gameplay.py), so the passenger condition gates
                # it. Only the original countries field GIs and Conscripts (websim rosteraudit).
                self.assertIn(actor, ('e1', 'e2'))
                self.assertEqual(arm.val('RequiresCondition'), 'retail-passenger', actor)
                self.assertEqual(self.rules[actor].get('Passenger').val('CargoCondition'), 'retail-passenger', actor)
            else:
                self.assertIn('ea-art', arm.val('RequiresCondition', ''), actor)
            self.assertIsNotNone(self.rules[actor].get('GrantConditionOnFaction@ea-art'), actor)
        modern = {n.key: n for n in E.parse((self.content / 'ea-modern-preserve.yaml').read_text(encoding='utf-8'))}
        self.assertIn('r2crane', modern)
        self.assertIsNotNone(modern['r2crane'].get('Health'))

    def test_original_roster_names_are_not_standalone_replacements(self):
        for actor, expected in [('beag', 'Black Eagle'), ('deso', 'Desolator'), ('ttnk', 'Tesla Tank'),
                                ('tany', 'Tanya'), ('cleg', 'Chrono Legionnaire')]:
            self.assertEqual(self.rules[actor].get('Tooltip').val('Name'), expected, actor)
        labels = self.rules['Player'].get('OriginalCountryLabels').get('ModernActors')
        self.assertEqual(labels.val('gacsph'), 'Strategic Uplink')
        self.assertEqual(labels.val('nairon'), 'EW Array')

    def test_original_missile_units_and_models_are_complete(self):
        for name, cost, hp, range_, weapon in [('v3', '800', '150', '18c0', 'RetailV3Launch'),
                                               ('dred', '2000', '800', '25c0', 'RetailDredLaunch')]:
            actor = self.rules[name]
            self.assertEqual(actor.get('Valued').val('Cost'), cost)
            self.assertEqual(actor.get('Health').val('HP'), hp)
            self.assertEqual(actor.get('RenderVoxels').val('NormalsPalette'), 'normals', name)
            self.assertIn('~original-ra2-country', actor.get('Buildable').val('Prerequisites'))
            self.assertIn(name + 'wo', self.models['ea-' + name].get('empty').value)
            self.assertEqual(actor.get('Armament').val('Weapon'), weapon)
        for name in ('v3rocket', 'dmisl'):
            self.assertEqual(self.rules[name].get('Health').val('HP'), '50')
            self.assertEqual(self.rules[name].get('Armor').val('Type'), 'Rocket')
            self.assertIsNotNone(self.rules[name].get('OriginalRa2RocketFlight'))

    def test_original_power_names_charge_and_activation(self):
        chrono = self.rules['gacsph'].get('ChronoshiftPower@chronoshift')
        self.assertEqual(chrono.val('Name'), 'Chronoshift')
        self.assertEqual(chrono.val('ChargeInterval'), '10500')
        self.assertEqual(self.rules['amradr'].get('ParatroopersPower@paratroopers').val('ChargeInterval'), '6000')
        self.assertEqual(self.rules['nairon'].get('WithSupportPowerActivationAnimation').val('RequiresCondition'), 'true')

    def test_named_armament_listeners_hear_the_original_twins(self):
        # The original twin of an armament has a new name; a trait that acts on a named armament firing must list it,
        # or Yuri never takes control and the carrier and destroyer never launch their aircraft.
        for actor, trait, twin in [('yuri', 'MindController', 'retail-armament'), ('carrier', 'CarrierParent', 'retail-armament'),
                                   ('dest', 'CarrierParent', 'retail-armament-asw')]:
            node = self.rules[actor].get(trait)
            self.assertIsNotNone(node, f'{actor} {trait}')
            self.assertIn(twin, E.split_list(node.val('ArmamentNames', '')), f'{actor} {trait}')

    def test_original_country_deaths_leave_something_on_screen(self):
        # websim effectsaudit found these vanishing without a trace for the original countries.
        # The IFV's ordinary death explosion has no original twin, so it must stay on for them.
        fv = self.rules['fv'].get('FireWarheadsOnDeath')
        self.assertNotIn('!ea-art', (fv.val('RequiresCondition') if fv is not None else '') or '')
        # The dolphin's death frames are drawn frames (116 onwards is its blank shadow half); the squid has one at all.
        self.assertLess(int(self.seqs['ea-dlph'].get('die').val('Start')) + int(self.seqs['ea-dlph'].get('die').val('Length')), 117)
        self.assertIsNotNone(self.seqs['ea-sqd'].get('die'))
        self.assertIsNotNone(self.rules['sqd'].get('WithDeathAnimation@ea-default'))
        # A burning dog plays a death too (it has no burning-infantry actor).
        types = self.rules['dog'].get('WithDeathAnimation@ea-normal').get('DeathTypes')
        self.assertIsNotNone(types.get('FlameDeath'))

    def test_original_turrets_keep_the_stand_in_facings(self):
        # A stand-in WithSpriteTurret, disabled for the original countries, still quantizes the shared Turreted to its
        # sequence's facings: a one-facing blank locked the Grizzly's voxel turret, muzzle flash and shells facing north
        # (1 November 2026). The transparent alias reports the stand-in's 32 facings instead.
        for image in ('ea-mtnk', 'ea-htnk', 'ea-fv', 'ea-ttnk', 'ea-apoc', 'ea-sref'):
            turret = self.seqs[image].get('turret')
            self.assertEqual(turret.val('Filename'), E.BLANK, image)
            self.assertEqual(turret.val('InterpolatedFacings'), '32', image)

    def test_the_flak_tracks_original_gun_sits_on_its_rear_deck(self):
        # The kit lifts the shared turret half a cell for its own sprite (RTSAI-Mod standalone/base-kit.yaml); the
        # original gun has its own turret at the original rules' place, and its armaments fire from it (20 Nov 2026).
        htk = self.rules['htk']
        twin = htk.get('Turreted@ea')
        self.assertIsNotNone(twin, 'htk: no original turret')
        self.assertEqual(twin.val('Offset').replace(' ', ''), '-280,-3,0')
        self.assertEqual(twin.val('RequiresCondition'), 'ea-art')
        self.assertEqual(htk.get('WithVoxelTurret').val('Turret'), 'ea')
        self.assertIn('ea', E.split_list(htk.get('AttackTurreted').val('Turrets')))
        retail = [arm for _, arm in E.traits(htk, 'Armament') if E.ORIGINAL_ONLY.search(arm.val('RequiresCondition') or '')]
        self.assertEqual(len(retail), 4)
        for arm in retail:
            self.assertEqual((arm.val('Turret'), arm.val('LocalOffset')), ('ea', '256,0,1536'), arm.key)
        self.assertEqual(self.files.get('movedTurrets'), {'htk': {'primary': ['0,0,582', '-280,-3,0']}})

    def test_suicide_damage_uses_restored_weapon_not_just_targeting_armament(self):
        weapons = {n.key: n for n in E.parse((self.content / 'ea-retail-weapons.yaml').read_text(encoding='utf-8'))}
        for actor, name, damage in [('terror', 'ea-retail-terrorbomb', '225'), ('dtruck', 'ea-retail-demobomb', '300')]:
            active = [t.val('Weapon') for t in self.rules[actor].children if E.trait_type(t.key) == 'FireWarheadsOnDeath']
            self.assertIn(name, active, actor)
            blast = [w for w in weapons[name].children if w.value == 'SpreadDamage']
            self.assertEqual(len(blast), 1, name)
            self.assertEqual(blast[0].val('Damage'), damage)

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
            if rs.get('FactionImages') is None:
                # Occupiable civilian buildings and their rubble (ea_gameplay.py): one neutral original image for
                # every owner, with no faction palettes or art condition.
                self.assertTrue(key.startswith('ca'), key)
                self.assertIsNone(palettes, key)
                self.assertIsNone(grant, key)
                self.assertTrue(rs.val('Image', '').startswith('ea-') and rs.val('Image') in self.seqs, key)
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

    def test_original_foundations_and_production_are_restored(self):
        expected = {'napowr': ('3,2', 'xxx xxx'), 'nahand': ('2,2', 'xx xx'),
                    'nadept': ('4,3', 'x=== x=== x==='), 'natech': ('3,3', 'xxx xxx xxx'),
                    'nanrct': ('4,4', 'xxxx xxxx xxxx xxxx')}
        for name, (dimensions, footprint) in expected.items():
            actor = self.rules[name]
            self.assertEqual(actor.get('Building').val('Dimensions'), dimensions)
            self.assertEqual(actor.get('Building').val('Footprint'), footprint)
            self.assertIn(name, self.files['actors'])
            image = 'ea-' + name
            for sequence in ('idle', 'make', 'icon'):
                self.assertIn(sequence, {s.key for s in self.seqs[image].children}, name)
        self.assertEqual(self.files['excluded'], [])
        for name in E.RESTORED_PRODUCTION:
            self.assertIn(name, self.files['actors'])
            self.assertIn('~' + E.ORIGINAL_PREREQUISITE, self.rules[name].get('Buildable').val('Prerequisites'))

    def test_all_nine_reference_rosters_have_no_omissions_or_replacements(self):
        audit = json.loads((self.content / 'original-country-audit.json').read_text())
        self.assertEqual(set(audit['countries']), set(E.COUNTRIES))
        for faction, report in audit['countries'].items():
            for field in ('missing', 'replacements', 'extensions'):
                self.assertEqual(report[field], [], faction + ': ' + field)

    def test_original_miner_docking_bodies(self):
        for actor, unload in (('cmin', 'cmon'), ('harv', 'horv')):
            body = self.rules[actor].get('WithOriginalVoxelUnloadBody@ea-unload')
            self.assertIsNotNone(body, actor)
            self.assertEqual(body.val('RequiresCondition'), E.CONDITION)
            self.assertIsNone(self.rules[actor].get('WithVoxelBody@ea-unload'))
            self.assertEqual(self.models['ea-' + actor].val('unload'), E.EA_PREFIX + unload)

    def test_original_support_power_cameos(self):
        icons = self.rules['Player'].get('FactionSupportPowerIcons')
        self.assertEqual(set(E.split_list(icons.val('Factions'))), set(E.COUNTRIES))
        self.assertEqual(icons.val('Palette'), 'eacameo')
        sequences = self.seqs[icons.val('Image')]
        expected = {'gps': 'asaticon', 'invuln': 'ircricon', 'chrono': 'chroicon',
                    'abomb': 'nukeicon', 'paradrop': 'paraicon', 'airborne': 'aparicon',
                    'lightningstorm': 'bolticon'}
        for sequence, file in expected.items():
            self.assertEqual(sequences.get(sequence).val('Filename'), E.EA_PREFIX + file + '.shp')

    def test_sprite_group_hints(self):
        for key, actor in self.rules.items():
            hint = actor.get('SpriteGroupFactions@ea')
            rs = actor.get('RenderSprites')
            if rs is not None:
                # Faction art is grouped by faction; neutral civilian art (no FactionImages) belongs to every group.
                if rs.get('FactionImages') is not None:
                    self.assertIsNotNone(hint, key)
                else:
                    self.assertIsNone(hint, key)
            if hint is not None:
                factions = E.split_list(hint.val('Factions'))
                self.assertTrue(factions and set(factions) <= set(E.COUNTRIES + E.MODERN), key)

    def test_art_manifest_lists_no_audio(self):
        if not ARGS.ea_art:
            self.skipTest('pass --ea-art to check against EA-INPUTS.json')
        manifest = json.loads((ARGS.ea_art / 'EA-INPUTS.json').read_text())
        self.assertFalse([f['name'] for f in manifest['files'] if Path(f['name']).suffix.lower() in ('.wav', '.aud')])

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


class GeneratedVoices(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not ARGS.content or not (ARGS.content / 'ea-audio.json').is_file():
            raise unittest.SkipTest('pass --content with generated original voices to check them')
        c = ARGS.content
        cls.rules = {n.key: n for n in E.parse((c / 'ea-audio.yaml').read_text(encoding='utf-8'))}
        cls.voices = {n.key: n for n in E.parse((c / 'ea-voices.yaml').read_text(encoding='utf-8'))}
        cls.weapons = {n.key: n for n in E.parse((c / 'ea-weapons.yaml').read_text(encoding='utf-8'))}
        cls.summary = json.loads((c / 'ea-audio.json').read_text(encoding='utf-8'))

    def clips(self, value):
        return [x.strip() for x in (value or '').split(',') if x.strip()]

    def test_rules_touch_voices_only(self):
        for key, actor in self.rules.items():
            for t in actor.children:
                kind = E.trait_type(t.key)
                if kind == 'GrantConditionOnFaction':
                    condition = V.DEATH_CONDITION if t.key == 'GrantConditionOnFaction@' + V.DEATH_CONDITION else V.CONDITION
                    self.assertTrue(t.key.startswith('GrantConditionOnFaction@' + condition), f'{key}.{t.key}')
                    self.assertTrue(t.val('Condition').startswith(condition), key)
                    self.assertTrue(set(E.split_list(t.val('Factions'))) <= set(E.COUNTRIES), f'{key}: {t.val("Factions")}')
                    self.assertEqual({c.key for c in t.children}, {'Condition', 'Factions'}, key)
                elif kind in V.VOICE_TRAITS:
                    self.assertTrue({c.key for c in t.children} <= {'VoiceSet', 'Volume', 'RequiresCondition'}, f'{key}.{t.key}')
                    if t.val('VoiceSet'):
                        self.assertIn(t.val('VoiceSet'), self.voices, f'{key}.{t.key}')
                        self.assertTrue(t.val('VoiceSet').startswith('Ea'), key)
                elif kind == 'FireWarheadsOnDeath':
                    # RA2's death sounds: the death trait off for the original countries, its twin (the same trait
                    # with a sound-only twin weapon) on for them.
                    if t.key.endswith(V.DEATH_CONDITION):
                        self.assertTrue(t.val('Weapon').startswith(V.DEATH_PREFIX), f'{key}.{t.key}')
                        self.assertTrue(t.val('RequiresCondition').startswith(V.DEATH_CONDITION), f'{key}.{t.key}')
                    else:
                        self.assertEqual({c.key for c in t.children}, {'RequiresCondition'}, f'{key}.{t.key}')
                        self.assertTrue(t.val('RequiresCondition').startswith('!' + V.DEATH_CONDITION), f'{key}.{t.key}')
                elif kind == 'FallsToEarth':
                    # The wreck of an aircraft only the original countries field: its crash with RA2's sound.
                    self.assertEqual({c.key for c in t.children}, {'Explosion'}, f'{key}.{t.key}')
                    self.assertTrue(t.val('Explosion').startswith(V.DEATH_PREFIX), f'{key}.{t.key}')
                    self.assertIn(key.lower(), self.summary['deaths'])
                else:
                    self.fail(f'{key}.{t.key}: not a voice trait')

    def test_original_voices_only_for_original_countries_except_the_dog(self):
        for key, actor in self.rules.items():
            grants = [t for t in actor.children if t.key.startswith('GrantConditionOnFaction@')]
            twins = [t for t in actor.children if '@' in t.key and E.trait_type(t.key) in V.VOICE_TRAITS]
            grants = [g for g in grants if g.val('Condition') != V.DEATH_CONDITION]
            if key in V.EVERY_FACTION_ACTORS:
                self.assertEqual(grants, [], key)
                self.assertEqual([t.key for t in actor.children], ['RTSAIVoiced'], key)
                continue
            if not twins and key in self.summary['deaths']:
                continue  # only RA2's death sound (a vehicle or a building that has no voice of its own)
            self.assertTrue(grants and twins, key)
            granted = set()
            for g in grants:
                granted |= set(E.split_list(g.val('Factions')))
            self.assertEqual(granted, set(E.COUNTRIES), key)
            project = [t for t in actor.children if '@' not in t.key and E.trait_type(t.key) in V.VOICE_TRAITS]
            self.assertEqual(len(project), 1, key)
            for g in grants:
                self.assertIn('!' + g.val('Condition'), project[0].val('RequiresCondition'), key)
            for t in twins:
                self.assertTrue(t.val('RequiresCondition').startswith(t.key.split('@', 1)[1]), key)
        self.assertEqual(self.rules['dog'].get('RTSAIVoiced').val('VoiceSet'), 'EaDogVoice')
        for unit in ('e1', 'e2', 'engineer', 'mtnk', 'htnk', 'spy'):
            self.assertIn(unit, self.rules)

    def test_voice_sets_name_extracted_clips_or_project_files(self):
        played = set(self.summary['clips'])
        used = set()
        for key, n in self.voices.items():
            self.assertTrue(key.startswith('Ea'), key)
            self.assertEqual(n.val('DefaultVariant'), '.wav', key)
            for phrase in n.get('Voices').children:
                for clip in self.clips(phrase.value):
                    if clip.startswith(V.AUDIO_PREFIX):
                        name = clip[len(V.AUDIO_PREFIX):] + '.wav'
                        self.assertIn(name, played, f'{key}.{phrase.key}')
                        used.add(name)
                    else:
                        self.assertNotIn('web/ea', clip, f'{key}.{phrase.key}')
        report = self.clips(self.weapons['DogJaw'].val('Report'))
        self.assertTrue(report and all(r.startswith(V.AUDIO_PREFIX) for r in report), report)

        def sounds(node):
            for c in node.children:
                yield from self.clips(c.value)
                yield from sounds(c)
        for w in self.weapons.values():
            used |= {x[len(V.AUDIO_PREFIX):] for x in sounds(w) if x.startswith(V.AUDIO_PREFIX)}
        self.assertEqual(used, played)

    def test_original_countries_die_with_ra2s_own_sounds(self):
        # The owner heard the standalone game's synthesised explosion when a tank or a building died (20 Nov 2026).
        deaths = self.summary['deaths']
        for actor in ('htnk', 'mtnk', 'apoc', 'gapowr', 'napowr', 'gapile', 'nahand'):
            self.assertIn(actor, deaths, actor)
        clips = lambda xs: {x[len(V.AUDIO_PREFIX):] for x in xs}
        for actor in ('htnk', 'mtnk', 'apoc'):
            d = deaths[actor][0]
            self.assertEqual(d['events']['die'], ['GenVehicleDie'], actor)
            self.assertEqual(clips(d['die']), {f'vgendie{c}.wav' for c in 'abcdef'}, actor)
            self.assertTrue(clips(d['explosion']) >= {'gexpifva.wav', 'gexp11a.wav', 'gexp14a.wav', 'gexp15a.wav'}, actor)
        self.assertEqual(deaths['gapowr'][0]['events']['die'], ['BuildingGenericDie', 'PowerPlantDie'])
        self.assertEqual(deaths['gapile'][0]['events']['die'], ['BuildingGenericDie'])
        # Aircraft: no death cry in RA2, only the explosion of their wreck hitting the ground.
        for wreck, plane in (('orcahusk', 'orca'), ('zephusk', 'zep')):
            d = deaths[wreck][0]
            self.assertEqual((d['trait'], d['wreckOf'], d['die']), ('FallsToEarth', plane, []), wreck)
            self.assertTrue(d['explosion'], wreck)
        for actor, specs in deaths.items():
            self.assertNotRegex(actor, r'^r2', actor)  # the modern countries keep their own
            rules = self.rules[actor]
            if any(s['trait'] != 'FallsToEarth' for s in specs):
                grant = rules.get('GrantConditionOnFaction@' + V.DEATH_CONDITION)
                self.assertEqual(set(E.split_list(grant.val('Factions'))) - set(E.COUNTRIES), set(), actor)
            for s in specs:
                twin = self.weapons[s['twin']]
                sounds = [x for w in twin.children if E.trait_type(w.key) == 'Warhead' for x in E.split_list(w.val('ImpactSounds') or '')]
                self.assertTrue(sounds, s['twin'])
                for x in sounds:
                    self.assertTrue(x.startswith(V.AUDIO_PREFIX), f'{s["twin"]}: {x}')
        for twin, source in self.summary['deathWeapons'].items():
            self.assertTrue(twin.startswith(V.DEATH_PREFIX) and twin.startswith(V.DEATH_PREFIX + source.lower()), twin)

    def test_weapons_overlay_sets_sounds_only(self):
        fields = set(V.WEAPON_SOUND_FIELDS)
        for key, w in self.weapons.items():
            if key in self.summary.get('deathWeapons', {}):
                continue  # a whole twin of a death weapon, checked against its source by the generator
            for c in w.children:
                if E.trait_type(c.key) == 'Warhead':
                    self.assertEqual({x.key for x in c.children}, set(V.WARHEAD_SOUND_FIELDS) & {x.key for x in c.children}, f'{key}.{c.key}')
                    self.assertTrue(c.children, f'{key}.{c.key}')
                else:
                    self.assertIn(c.key, fields, f'{key}.{c.key}')
        # Original sounds only for the dog's bite and weapons only original-country actors fire; inheritors keep theirs.
        for key, entry in self.summary['weapons'].items():
            if 'kept' in entry:
                self.assertFalse([v for v in entry['kept'].values() if 'web/ea' in v], key)
            elif key != 'DogJaw':
                self.assertTrue(entry['firedBy'], key)

    def test_clips_match_the_manifest(self):
        if not ARGS.ea_art:
            self.skipTest('pass --ea-art to check against EA-INPUTS.json')
        manifest = json.loads((ARGS.ea_art / 'EA-INPUTS.json').read_text())
        audio = manifest['audio']
        self.assertEqual(sorted(f['name'] for f in audio['files']), sorted(self.summary['clips']))
        self.assertEqual(sorted(audio['absent']), sorted(self.summary['absent']))
        for f in audio['files']:
            self.assertTrue(P.allowed_audio(f['name']), f['name'])
            self.assertLessEqual(f['size'], P.MAX_CLIP_BYTES, f['name'])
            self.assertLessEqual(f['seconds'], P.MAX_CLIP_SECONDS, f['name'])
        on_disk = {p.name for p in (ARGS.ea_art / audio['folder']).iterdir()} - set(P.AUDIO_RECORDS)
        self.assertEqual(on_disk, {f['name'] for f in audio['files']})


def main():
    global ARGS
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--content', type=Path)
    ap.add_argument('--ea-art', type=Path)
    ARGS, rest = ap.parse_known_args()
    unittest.main(argv=[sys.argv[0], *rest], verbosity=2)


if __name__ == '__main__':
    main()
