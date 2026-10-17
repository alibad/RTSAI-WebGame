"""Retail RA2 country rules and shared effects, layered over the original-art generator.

Original files remain external. The checked-in baseline contains source configuration facts,
with its retail input SHA. This module is used only when the original-country content is enabled.
"""
from pathlib import Path
import json
import math


NEW_ACTORS = ('v3', 'dred', 'v3rocket', 'dmisl')
ARMORS = ('None', 'Flak', 'Plate', 'Light', 'Medium', 'Heavy', 'Wood', 'Steel', 'Concrete', 'Drone', 'Rocket')


def load_baseline():
    return json.loads((Path(__file__).parent / 'data/ra2-retail.json').read_text(encoding='utf-8'))


def set_value(E, node, key, value):
    child = node.get(key)
    if child is None:
        child = E.Node(key)
        node.children.append(child)
    child.value = str(value)
    return child


def trait(E, actor, key, **fields):
    child = actor.get(key)
    if child is None:
        child = E.Node(key)
        actor.children.append(child)
    for field, value in fields.items():
        set_value(E, child, field, value)
    return child


def cells(value):
    length = round(float(value) * 1024)
    return f'{length // 1024}c{length % 1024}'


def normalize_voices(voices, E):
    # sound.ini's CrazyIvanMove/AttackCommand and TeslaTroopSelect do not name these clips.
    # Kirov has no fear/feedback voice event at all. Keep an explicitly empty phrase so the
    # engine can safely receive a generic feedback request without inventing replacement speech.
    absent = {'icraate', 'icramoe', 'itesseb', 'vkirfea', 'vkirfeb', 'vkirfec'}
    for node in voices.values():
        phrases = node.get('Voices')
        if phrases is not None:
            for phrase in phrases.children:
                values = E.split_list(phrase.value)
                phrase.value = ', '.join(x for x in values if x.lower().removesuffix('.wav') not in absent) or None


def initialize(g, E):
    """Supply the two retail actors omitted by the port, before ownership/art planning."""
    b = load_baseline()
    g.retail_baseline = b
    for name, template in [('v3', 'htnk'), ('dred', 'sub')]:
        actor = g.ref[template].clone()
        actor.key = name
        remove = {'Armament', 'WithVoxelBody', 'WithVoxelTurret', 'Turreted', 'WithMuzzleOverlay',
                  'Cloak', 'DetectCloaked', 'RenderDetectionCircle', 'AttackTurreted', 'SpawnActorOnDeath',
                  'WithFacingSpriteBody', 'WithSpriteBody', 'GrantConditionOnAttack', 'WithAttackAnimation',
                  'WithVoxelBarrel', 'WithVoxelWalkerBody'}
        actor.children = [t for t in actor.children if E.trait_type(t.key) not in remove and
                          not (E.trait_type(t.key) == 'Targetable' and '@' in t.key and
                               t.val('RequiresCondition') in ('underwater', '!underwater'))]
        values = b['actors'][name]
        trait(E, actor, 'Valued', Cost=values['Cost'])
        trait(E, actor, 'Health', HP=values['Strength'])
        trait(E, actor, 'Armor', Type=values['Armor'].title())
        trait(E, actor, 'Tooltip', Name=values['Name'])
        trait(E, actor, 'Mobile', Speed=int(values['Speed']) * 15, TurnSpeed=20 if name == 'v3' else 4)
        trait(E, actor, 'RevealsShroud', Range=cells(values['Sight']))
        trait(E, actor, 'Targetable', TargetTypes='Ground, Vehicle' if name == 'v3' else 'Ground, Water')
        # Derive interaction/selection bounds from the original voxel hull, not the template tank/submarine.
        selectable = actor.get('Selectable')
        selectable.children = [n for n in selectable.children if n.key not in ('Bounds', 'DecorationBounds', 'Polygon')]
        trait(E, actor, 'Buildable', Queue='Vehicle' if name == 'v3' else 'Ship',
              BuildPaletteOrder=65, Prerequisites=('naradr, ~naweap' if name == 'v3' else 'natech, ~nayard') + ', ~original-ra2-country',
              Description='Long-range missile siege. Rockets can be intercepted by anti-aircraft weapons.')
        trait(E, actor, 'RenderSprites', Image=name)
        trait(E, actor, 'RenderVoxels', Image=name)
        trait(E, actor, 'WithOriginalLauncherBody', RegenerationTicks=values['SpawnRegenRate'],
              ReloadingCondition='rocket-reloading' if name == 'v3' else '')
        trait(E, actor, 'AttackFrontal', FacingTolerance=512 if name == 'dred' else 0, Voice='Attack')
        trait(E, actor, 'AutoTarget', InitialStance='HoldFire', InitialStanceAI='HoldFire')
        trait(E, actor, 'MustBeDestroyed', RequiredForShortGame='false')
        trait(E, actor, 'StrategicRole', Roles='artillery', Domain='ground' if name == 'v3' else 'naval')
        trait(E, actor, 'Armament', Weapon='RetailV3Launch' if name == 'v3' else 'RetailDredLaunch',
              LocalOffset='-640,0,300' if name == 'v3' else '120,172,368',
              PauseOnCondition='rocket-reloading' if name == 'v3' else 'false', RequiresCondition='!rank-elite')
        elite = actor.get('Armament').clone()
        elite.key = 'Armament@elite'
        set_value(E, elite, 'Weapon', 'RetailV3LaunchElite' if name == 'v3' else 'RetailDredLaunchElite')
        set_value(E, elite, 'RequiresCondition', 'rank-elite')
        actor.children.append(elite)
        trait(E, actor, 'RTSAIVoiced', VoiceSet='SovietVehicleVoice' if name == 'v3' else 'SovietNavalVoice')
        g.cur[name] = actor.clone()
        g.ref[name] = actor.clone()
        trait(E, g.cur[name], 'RenderSprites', PlayerPalette='kitplayer')
        trait(E, g.ref[name], 'Buildable', Prerequisites='naradr, ~naweap' if name == 'v3' else 'natech, ~nayard')
        # Existing reference sprite definitions contain the original retail cameos.
        g.curseq[name] = g.refseq[name].clone()
        model = g.refmodels[name]
        if model.get('empty') is None:
            model.children.append(E.Node('empty', name + 'wo'))
        g.curmodels[name] = model.clone()

    for name in ('v3rocket', 'dmisl'):
        values = b['actors'][name]
        actor = g.ref['hornet'].clone()
        actor.key = name
        keep = {'RenderVoxels', 'RenderSprites', 'WithVoxelBody', 'BodyOrientation', 'Aircraft',
                'HiddenUnderFog', 'HitShape', 'Health', 'Armor', 'Tooltip', 'Interactable', 'RejectsOrders',
                'OwnerLostAction', 'AppearsOnRadar'}
        actor.children = [t for t in actor.children if E.trait_type(t.key) in keep]
        trait(E, actor, 'Health', HP=50)
        trait(E, actor, 'Armor', Type='Rocket')
        trait(E, actor, 'Tooltip', Name=values['Name'])
        trait(E, actor, 'RenderSprites', Image=name)
        trait(E, actor, 'RenderVoxels', Image=name)
        trait(E, actor, 'WithVoxelBody', ShowShadow='false')
        trait(E, actor, 'Targetable', TargetTypes='Air, Rocket')
        trait(E, actor, 'Aircraft', IdleBehavior='None', Repulsable='false', TakeOffOnCreation='false',
              CruiseAltitude=3072, MinAirborneAltitude=0, Speed=int(values['Speed']) * 15)
        prefix = 'V3Rocket' if name == 'v3rocket' else 'DMisl'
        m = b['missiles']
        trait(E, actor, 'OriginalRa2RocketFlight', PauseFrames=m[prefix + 'PauseFrames'],
              TiltFrames=m[prefix + 'TiltFrames'], InitialPitch=round(float(m[prefix + 'PitchInitial']) * 256),
              FinalPitch=round(float(m[prefix + 'PitchFinal']) * 256),
              TurnRate=round(float(m[prefix + 'TurnRate']) * 256),
              Acceleration=round(float(m[prefix + 'Acceleration']) * 15),
              MaximumSpeed=int(values['Speed']) * 15, Altitude=int(m[prefix + 'Altitude']) * 4,
              LazyCurve='true' if m[prefix + 'LazyCurve'].lower() == 'yes' else 'false')
        g.cur[name] = actor.clone()
        g.ref[name] = actor.clone()
        # Voxel-only body; a transparent sprite is used only for the engine's image contract.
        trait(E, g.cur[name], 'WithVoxelBody', RequiresCondition='false')
        image = E.Node(name, None, [E.Node('idle', None, [E.Node('Filename', E.BLANK)])])
        g.refseq[name] = image
        g.curseq[name] = image.clone()
        model = E.Node(name, None, [E.Node('idle')])
        g.refmodels[name] = model
        g.curmodels[name] = model.clone()


class Retail:
    def __init__(self, g, E):
        self.g, self.E = g, E
        self.baseline = g.retail_baseline
        self.weapons = []
        self.rules = []
        self.modern_rules = []
        self.effects = set()
        self.weapon_names = {}
        self.rules.append(E.Node('Player', None, [E.Node('OriginalCountryLabels', None, [
            E.Node('Factions', ', '.join(E.COUNTRIES)),
            E.Node('ModernActors', None, [E.Node('gacsph', 'Strategic Uplink'), E.Node('nairon', 'EW Array')]),
            E.Node('ModernPowers', None, [E.Node('chrono', 'Rapid Redeployment'), E.Node('invuln', 'EW Shield')])])]))
        manifest = (g.mod_root / 'mods/rtsai/mod.yaml').read_text(encoding='utf-8')
        self.stock_weapons = g.files.load(E._section(manifest, 'Weapons'))
        by_lower = {k.lower(): v for k, v in self.stock_weapons.items()}
        self.by_lower = by_lower
        self._new_weapons(E)
        for actor, facts in g.actors.items():
            patch = E.Node(g.cur[actor].key)
            renamed_armaments = {}
            values = self.baseline['actors'].get(actor, {})
            # These physical actor values are shared by any owner of the actor, like foundations.
            for key, kind, field in [('Cost', 'Valued', 'Cost'), ('Strength', 'Health', 'HP'),
                                     ('Sight', 'RevealsShroud', 'Range'), ('Power', 'Power', 'Amount')]:
                if key in values and g.cur[actor].get(kind) is not None:
                    trait(E, patch, kind, **{field: cells(values[key]) if key == 'Sight' else values[key]})
            if 'Armor' in values and g.cur[actor].get('Armor') is not None:
                armor = {'special_1': 'Drone', 'special_2': 'Rocket'}.get(values['Armor'], values['Armor'].title())
                trait(E, patch, 'Armor', Type=armor)
            for key, arm in E.traits(g.cur[actor], 'Armament'):
                weapon = arm.val('Weapon', '')
                name = self._original_weapon(weapon)
                if name is None:
                    continue
                # Preserve the modern armament and add a faction-conditioned original twin.
                trait(E, patch, key, RequiresCondition=E.both('!ea-art', arm.val('RequiresCondition')))
                twin_arm = arm.clone()
                twin_arm.key = key.split('@')[0] + '@retail-' + (key.split('@', 1)[1] if '@' in key else 'primary')
                old_name = arm.val('Name', 'primary')
                new_name = 'retail-' + key.replace('@', '-').lower()
                renamed_armaments.setdefault(old_name, []).append(new_name)
                set_value(E, twin_arm, 'Name', new_name)
                set_value(E, twin_arm, 'Weapon', name)
                set_value(E, twin_arm, 'RequiresCondition', E.both('ea-art', arm.val('RequiresCondition')))
                patch.children.append(twin_arm)
                trait(E, patch, 'GrantConditionOnFaction@ea-art', Condition='ea-art', Factions=', '.join(E.COUNTRIES))
            # Suicide units detonate via death/deploy traits rather than their targeting
            # armament. Restoring an unused TerrorBomb definition would leave gameplay wrong.
            for original in g.cur[actor].children:
                if E.trait_type(original.key) not in ('FireWarheadsOnDeath', 'PeriodicExplosion'):
                    continue
                replacements = {field: self._original_weapon(original.val(field, ''))
                                for field in ('Weapon', 'EmptyWeapon')}
                replacements = {field: value for field, value in replacements.items() if value}
                if not replacements:
                    continue
                trait(E, patch, original.key, RequiresCondition=E.both('!ea-art', original.val('RequiresCondition')))
                twin = original.clone()
                twin.key += '-retail' if '@' in twin.key else '@retail'
                set_value(E, twin, 'RequiresCondition', E.both('ea-art', original.val('RequiresCondition')))
                for field, value in replacements.items():
                    set_value(E, twin, field, value)
                patch.children.append(twin)
                trait(E, patch, 'GrantConditionOnFaction@ea-art', Condition='ea-art', Factions=', '.join(E.COUNTRIES))
            # Render helpers use Single(armament.Name); a second armament must have a unique
            # name. Extend only the attack selectors that originally used that armament.
            for item in g.cur[actor].children:
                if item.key.startswith('Attack') and renamed_armaments:
                    selected = E.split_list(item.val('Armaments', 'primary, secondary'))
                    extra = [new for old in selected for new in renamed_armaments.get(old, [])]
                    if extra:
                        trait(E, patch, item.key, Armaments=', '.join(selected + extra))
            # Infantry animation dictionaries select by armament name, too.
            for key, body in E.traits(g.cur[actor], 'WithInfantryBody'):
                sequences = body.get('AttackSequences')
                if sequences is not None:
                    for old, names in renamed_armaments.items():
                        sequence = sequences.get(old)
                        if sequence is not None:
                            target = trait(E, patch, key)
                            mapping = target.get('AttackSequences')
                            if mapping is None:
                                mapping = E.Node('AttackSequences')
                                target.children.append(mapping)
                            for name in names:
                                set_value(E, mapping, name, sequence.value)
            for item in g.ref[actor].children:
                if E.trait_type(item.key) not in ('WithAttackAnimation', 'WithTurretAttackAnimation'):
                    continue
                names = renamed_armaments.get(item.val('Armament', 'primary'), [])
                if not names or g.cur[actor].get(item.key) is None:
                    continue
                current = g.cur[actor].get(item.key)
                trait(E, patch, item.key, RequiresCondition=E.both('!ea-art', current.val('RequiresCondition')))
                for name in names:
                    helper = item.clone()
                    helper.key += '-'+name if '@' in helper.key else '@'+name
                    set_value(E, helper, 'Armament', name)
                    set_value(E, helper, 'RequiresCondition', E.both('ea-art', item.val('RequiresCondition')))
                    patch.children.append(helper)
            if actor == 'tnkd':
                trait(E, patch, 'Buildable', Prerequisites='radar, ~vehicles.germany')
            if actor in ('gacsph', 'nairon'):
                trait(E, patch, 'Tooltip', Name='actor-gacsph-name' if actor == 'gacsph' else 'actor-nairon-name')
                kind = 'ChronoshiftPower@chronoshift' if actor == 'gacsph' else 'GrantExternalConditionPower@IRONCURTAIN'
                trait(E, patch, kind, Name='Chronoshift' if actor == 'gacsph' else 'Iron Curtain',
                      ChargeInterval=10500 if actor == 'gacsph' else 7500,
                      Description='Teleport a group of units.' if actor == 'gacsph' else 'Temporarily make a group of vehicles invulnerable.')
                if actor == 'nairon':
                    trait(E, patch, 'WithSupportPowerActivationAnimation', RequiresCondition='true', Sequence='active')
            if actor == 'amradr':
                trait(E, patch, 'ParatroopersPower@paratroopers', ChargeInterval=6000)
            # Explicit images on actor effects do not pass through WithFactionPalettes.
            for key, original in [(t.key, t) for t in g.cur[actor].children]:
                if any(original.val(f) for f in ('Image', 'TrailImage', 'MissileImage')) and E.trait_type(key) not in ('RenderSprites', 'RenderVoxels'):
                    twin = original.clone()
                    self._effect_refs(twin, 'actor')
                    if E.dump([twin]) != E.dump([original]):
                        # Original-only support structures; actor-conditioned traits retain their conditions.
                        patch.children.append(twin)
            if patch.children:
                self.rules.append(patch)
        # Sparse explicit values protect modern descendants from changes to shared RA2 parents.
        # This separate overlay follows ea-art without imposing original palettes on modern art.
        for actor, owners in g.owners.items():
            if actor in g.actors or not (owners & set(E.MODERN)) or actor not in g.cur:
                continue
            patch = E.Node(g.cur[actor].key)
            for item in g.cur[actor].children:
                if E.trait_type(item.key) in ('Valued', 'Health', 'Armor', 'RevealsShroud', 'Power') or (
                        E.trait_type(item.key) not in ('RenderSprites', 'RenderVoxels') and
                        any(item.val(field) for field in ('Image', 'TrailImage', 'MissileImage'))):
                    patch.children.append(item.clone())
            if patch.children:
                self.modern_rules.append(patch)
        for name in self.effects:
            g.images.setdefault(name, set())

    def _original_weapon(self, weapon):
        E = self.E
        source = self.by_lower.get(weapon.lower())
        if source is None or weapon.lower() not in self.baseline['weapons']:
            return None
        name = 'ea-retail-' + weapon.lower()
        if name not in self.weapon_names:
            self.weapon_names[name] = weapon
            twin = source.clone()
            twin.key = name
            self._weapon(twin, self.baseline['weapons'][weapon.lower()])
            self._effect_refs(twin, 'weapon')
            self.weapons.append(twin)
        return name

    def _effect_refs(self, node, where):
        E = self.E
        g = self.g
        def image(parent, field, default=None):
            value = parent.val(field, default)
            if value and value.lower() in g.refseq and value.lower() not in g.images:
                self.effects.add(value.lower())
                set_value(E, parent, field, 'ea-' + value.lower())
                for palette in ('Palette', 'TrailPalette', 'TargetOverlayPalette', 'MissilePalette'):
                    old = parent.val(palette)
                    if old in ('effect', 'ra', 'terrain', 'effect75alpha'):
                        set_value(E, parent, palette, 'eaeffect' if old != 'ra' else 'eaunit')
        for field in ('Image', 'TrailImage', 'MissileImage'):
            image(node, field)
        if node.value == 'CreateEffect':
            image(node, 'Image', 'explosion')
            trait_palette = node.get('Image')
            if trait_palette and trait_palette.value.startswith('ea-'):
                set_value(E, node, 'ExplosionPalette', 'eaeffect')
        for child in list(node.children):
            if child.children:
                self._effect_refs(child, where)

    def _weapon(self, twin, original):
        E = self.E
        for source, target in [('ROF', 'ReloadDelay'), ('Range', 'Range'), ('MinimumRange', 'MinRange'), ('Burst', 'Burst')]:
            value = original.get(source)
            if value is not None and not (source == 'Range' and float(value) < 0):
                set_value(E, twin, target, cells(value) if source in ('Range', 'MinimumRange') else value)
        if 'Burst' not in original:
            set_value(E, twin, 'Burst', 1)
        warhead = self.baseline['warheads'].get(original.get('Warhead'), {})
        if twin.key in ('ea-retail-demobomb', 'ea-retail-terrorbomb'):
            # Retail suicide damage is one radial blast, not the port's extra delayed nuclear rings.
            twin.children = [n for n in twin.children if not n.key.startswith('Warhead')]
            spread = float(warhead.get('CellSpread', '1'))
            blast = E.Node('Warhead@retail', 'SpreadDamage', [E.Node('Damage', original['Damage']),
                E.Node('Spread', cells(spread)), E.Node('Falloff', '100, ' + str(round(float(warhead.get('PercentAtMax', '.5')) * 100)) ),
                E.Node('ValidTargets', 'Ground, Water, Air'), E.Node('AffectsParent', 'true'),
                E.Node('DamageTypes', 'FlameDeath' if warhead.get('InfDeath') == '4' else 'ExplosionDeath')])
            twin.children.append(blast)
            twin.children.append(E.Node('Warhead@retail-effect', 'CreateEffect', [
                E.Node('Image', 'explosion'), E.Node('Explosions', 'demotruck_explosion' if 'demobomb' in twin.key else 'terrorist_explosion'),
                E.Node('ValidTargets', 'Ground, Water, Air')]))
            if original.get('RadLevel'):
                twin.children.append(E.Node('Warhead@retail-radiation', 'CreateTintedCells', [
                    E.Node('Spread', cells(spread)), E.Node('Level', original['RadLevel']), E.Node('MaxLevel', '500')]))
        damages = [n for n in twin.children if n.value == 'SpreadDamage']
        if len(damages) == 1 and original.get('Damage'):
            set_value(E, damages[0], 'Damage', original['Damage'])
        verses = warhead.get('Verses', '').split(',')
        for damage in damages:
            if len(verses) == len(ARMORS):
                versus = damage.get('Versus')
                if versus is None:
                    versus = E.Node('Versus')
                    damage.children.append(versus)
                for armor, value in zip(ARMORS, verses):
                    set_value(E, versus, armor, value.strip().rstrip('%'))

    def _new_weapons(self, E):
        for name, rocket, prefix, wh, damage, burst, cooldown, range_, min_range in [
                ('RetailV3Launch', 'v3rocket', 'V3Rocket', 'V3WH', 200, 1, 150, 18, 5),
                ('RetailDredLaunch', 'dmisl', 'DMisl', 'DMISLWH', 300, 2, 80, 25, 8)]:
            spec = self.baseline['warheads'][wh]
            spread = spec['CellSpread']
            weapon = E.Node(name, None, [E.Node('ReloadDelay', str(cooldown)), E.Node('Range', cells(range_)),
                E.Node('MinRange', cells(min_range)), E.Node('Burst', str(burst)), E.Node('BurstDelays', '20'),
                E.Node('ValidTargets', 'Ground, Water'), E.Node('Projectile', 'OriginalRa2Rocket', [E.Node('Actor', rocket)]),
                E.Node('Warhead@retail', 'SpreadDamage', [E.Node('Damage', str(damage)), E.Node('Spread', cells(spread)),
                    E.Node('Falloff', '100, 25'), E.Node('DamageTypes', 'ExplosionDeath'),
                    E.Node('Versus', None, [E.Node(a, x.strip().rstrip('%')) for a,x in zip(ARMORS, spec['Verses'].split(','))])]),
                E.Node('Warhead@retail-effect', 'CreateEffect', [E.Node('Image', 'explosion'), E.Node('Explosions', 'large_explosion')])])
            weapon.children.append(E.Node('Report', 'vv3latta.wav, vv3lattb.wav' if rocket == 'v3rocket' else 'vdreatta.wav, vdreattb.wav'))
            self._effect_refs(weapon, 'weapon')
            self.weapons.append(weapon)
            elite = weapon.clone()
            elite.key += 'Elite'
            set_value(E, elite.get('Warhead@retail'), 'Damage', self.baseline['missiles'][prefix + 'EliteDamage'])
            spec_elite = self.baseline['warheads']['V3EWH' if rocket == 'v3rocket' else 'DMISLEWH']
            for armor, value in zip(ARMORS, spec_elite['Verses'].split(',')):
                set_value(E, elite.get('Warhead@retail').get('Versus'), armor, value.strip().rstrip('%'))
            self.weapons.append(elite)

    def finish(self):
        # The base mod has no definitions for these actors, so ship full resolved definitions first.
        bases = [self.g.cur[name].clone() for name in NEW_ACTORS]
        for actor in bases:
            for item in actor.children:
                for field in ('Palette', 'PlayerPalette', 'DeathSequencePalette', 'CrushedSequencePalette'):
                    current = item.get(field)
                    if current and current.value in self.E.EA_PALETTES:
                        current.value = self.E.EA_PALETTES[current.value]
                    elif current and current.value == 'kitplayer':
                        current.value = 'eaplayer'
        self.g.rules_nodes[1:1] = bases
        self.g.rules_nodes.extend(self.rules)
        self.g.rules_nodes = self.E._merge_self_partial(self.g.rules_nodes)
        return self.g

    def write(self, out):
        E = self.E
        (out / 'ea-modern-preserve.yaml').write_text('# Preserve modern descendant rules.\n' + E.dump(self.modern_rules), encoding='utf-8')
        (out / 'ea-retail-weapons.yaml').write_text('# Retail country rules; original files remain external.\n' + E.dump(self.weapons), encoding='utf-8')
        (out / 'retail-ra2-restoration.json').write_text(json.dumps({'schema': 1, 'sourceSha256':self.baseline['sourceSha256'],
            'actors':list(NEW_ACTORS), 'countryRules': [n.key for n in self.rules], 'weapons':[n.key for n in self.weapons],
            'effects':sorted(self.effects)}, indent=2) + '\n', encoding='utf-8')
