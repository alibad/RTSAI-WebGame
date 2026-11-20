"""Original Westwood (EA) unit voices and weapon sounds for the nine original countries in the public isometric browser
game, and the Attack Dog's original barks and bite for every faction.

EA's Command & Conquer Franchise Modding Guidelines forbid only C&C music; the other original assets (art, audio) may be
used freely and non-commercially with the notice "EA has not endorsed and does not support this product." This module
uses only unit voice and sound-effect clips (.wav from RA2's audio.bag, kept exactly as Westwood compressed them); no
music (theme.mix or any score), no EVA, no video.

It reads the same two views of the frozen RTSAI-Mod snapshot as tools/ea_originals.py:
  * the REFERENCE view (the classic add-on, mods/rtsai-classic): the voice set each actor speaks with in the original
    game (e.g. e1 -> GIVoice) and the clips it names, which the add-on plays from the player's own RA2 files;
  * the CURRENT view (the public isometric game): the project voice set the actor has today (e.g. e1 ->
    R2ChinainfantryVoice).
For every actor an original country fields whose reference speaks with original clips it writes a twin voice set
(`Ea<VoiceSet>`) naming the bundled copies (ra2|web/ea/audio/<clip>), and render-free rules: a faction condition (the
builder's faction, like the original art) enables the twin for the nine countries and disables the project voice, so
modern factions keep their own voices for shared units. The Attack Dog uses its original voice for every owner. A
phrase whose original clips RA2 lacks falls back to the current project clips of that phrase, never to silence, and every
phrase of the current voice set stays defined (the engine throws on a phrase a voice set lacks).
The dog's bite (weapon DogJaw, shared by every faction) gets its original sounds, and so do the weapons only
original-country actors fire (the Apocalypse's cannons, Tesla bolts, the Prism, ...; a weapon any modern faction can
fire, e.g. the G.I.'s, which modern factions field in missions, keeps the project's sounds): Report, StartBurstReport,
AfterFireSound and the warheads' ImpactSounds. Weapons inheriting a changed one keep theirs.
Their vehicles, aircraft, ships and buildings also die with RA2's own sounds (tools/data/ra2-death-sounds.json) instead
of the standalone game's synthesised ones: a twin of the death weapon that differs only in its sounds, behind a
death-sound-only condition for the original countries. Modern factions keep theirs.
Nothing here changes the simulation: voices, voice- and sound-only conditions and weapon sounds.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import ea_originals as E
import ea_retail

# The bundled copies: mods/rtsai/web/ea/audio/<clip>.wav (the extract directory's audio/ folder).
AUDIO_FOLDER = 'audio'
AUDIO_PREFIX = E.EA_PREFIX + AUDIO_FOLDER + '/'
AUDIO_EXTENSION = '.wav'
# A unit voice or sound-effect clip name as RA2's audio.idx spells them (at most 16 characters with the extension).
CLIP_NAME = re.compile(r'[a-z0-9][a-z0-9_-]{0,15}\.wav')
CONDITION = 'ea-voice'
VOICE_TRAITS = ('Voiced', 'RTSAIVoiced')
# Actors whose original voice every owner uses: a real bark is not a faction voice, and the dog is drawn in the original
# art for every faction already.
EVERY_FACTION_ACTORS = ('dog',)
# Weapons every faction shares whose original sounds replace the project's: the dog's bite.
EVERY_FACTION_WEAPONS = ('DogJaw',)
# Red Alert 2's own death sounds (tools/data/ra2-death-sounds.json, written by tools/ra2-death-sounds.py from the
# player's rules.ini, art.ini and sound.ini). The original countries' vehicles, aircraft, ships and buildings die with
# them, not with the standalone game's synthesised stand-ins (RTSAI-Mod tools/standalone-sfx.py), which the owner heard
# as "some very weird sound" when a tank or a building was destroyed (20 November 2026).
DEATH_FACTS = Path(__file__).resolve().parent / 'data/ra2-death-sounds.json'
DEATH_CONDITION = 'ea-death'
DEATH_PREFIX = 'ea-death-'
STAND_IN_DEATH = re.compile(r'(^|\|)audio/sfx/rtsai-explode-[a-z0-9-]+\.wav$', re.I)
# The project's explosions are drawn after RA2's animations of the same name; an actor RA2 gives no Explosion= list
# (the Nuclear Reactor, which RA2 blows up with a nuke) sounds like the explosions it is drawn with.
EXPLOSION_ANIMS = (('twlt', 'TWLT070'), ('bang', 'S_BANG48'), ('brnl', 'S_BRNL58'), ('clsn', 'S_CLSN58'), ('tumu', 'S_TUMU60'))


class VoiceError(E.GenerationError):
    pass


# The engine's weapon sounds (WeaponInfo) and warhead sounds (CreateEffectWarhead).
WEAPON_SOUND_FIELDS = ('Report', 'StartBurstReport', 'AfterFireSound')
WARHEAD_SOUND_FIELDS = ('ImpactSounds',)


def weapon_sounds(node):
    """A resolved weapon's sound fields: {(field,) or (warhead, field): value}."""
    out = {}
    for f in WEAPON_SOUND_FIELDS:
        if node.val(f):
            out[(f,)] = node.val(f)
    for c in node.children:
        if E.trait_type(c.key) == 'Warhead':
            for f in WARHEAD_SOUND_FIELDS:
                if c.val(f):
                    out[(c.key, f)] = c.val(f)
    return out


def same_sounds(a, b):
    """Two weapon_sounds results name the same files (file names are compared case-insensitively)."""
    def norm(s):
        return {k: [x.lower() for x in E.split_list(v)] for k, v in s.items()}
    return norm(a) == norm(b)


def child(parent, key):
    """parent's child node key, created when missing."""
    node = parent.get(key)
    if node is None:
        node = E.Node(key)
        parent.children.append(node)
    return node


def clip_file(name, strict=True):
    """A bare original clip file name (lower case), or None for a project path (ra2|...) or another extension. A bare
    name that cannot be an RA2 clip is an error in a reference voice set (strict) and a project file otherwise."""
    if '|' in name or '/' in name or '\\' in name:
        return None
    name = name.lower()
    if not name.endswith(AUDIO_EXTENSION):
        return None
    if not CLIP_NAME.fullmatch(name):
        if strict:
            raise VoiceError(f'unexpected original clip name {name}')
        return None
    return name


class VoiceSet:
    """A resolved voice definition (SoundInfo): clips per phrase plus the prefix/variant rules."""

    def __init__(self, key, node: E.Node):
        self.key = key
        self.node = node
        voices = node.get('Voices')
        self.phrases = {} if voices is None else {c.key: E.split_list(c.value) for c in voices.children}
        self.default_variant = node.val('DefaultVariant', '.aud')
        self.default_prefix = node.val('DefaultPrefix', '')
        self.variants = self._per_faction('Variants')
        self.prefixes = self._per_faction('Prefixes')
        self.disable_variants = set(E.split_list(node.val('DisableVariants')))
        self.disable_prefixes = set(E.split_list(node.val('DisablePrefixes')))

    def _per_faction(self, field):
        n = self.node.get(field)
        out = {}
        for c in (n.children if n is not None else []):
            values = E.split_list(c.value)
            if len(values) > 1:
                # The engine picks one by actor id: not one file per faction, so not supported here.
                raise VoiceError(f'{self.key}.{field}.{c.key}: several values')
            out[c.key] = values[0] if values else ''
        return out

    def file(self, phrase, clip, faction):
        """The file name the engine plays (Sound.PlayPredefined): prefix + clip + suffix for an owner's faction."""
        prefix = self.default_prefix if phrase in self.disable_prefixes else self.prefixes.get(faction, self.default_prefix)
        suffix = self.default_variant if phrase in self.disable_variants else self.variants.get(faction, self.default_variant)
        return prefix + clip + suffix

    def files(self, phrase, faction):
        return [self.file(phrase, c, faction) for c in self.phrases.get(phrase, [])]


class VoiceGenerator:
    def __init__(self, art: E.Generator):
        self.art = art
        mod = art.mod_root / 'mods'
        rtsai = (mod / 'rtsai/mod.yaml').read_text(encoding='utf-8')
        classic = (mod / 'rtsai-classic/mod.yaml').read_text(encoding='utf-8')
        # The web build adds no voice or weapon files: both views load the manifests' own lists.
        self.cur_voices = {k.lower(): v for k, v in art.files.load(E._section(rtsai, 'Voices')).items()}
        self.ref_voices = {k.lower(): v for k, v in art.files.load(E._section(classic, 'Voices')).items()}
        ea_retail.normalize_voices(self.cur_voices, E)
        ea_retail.normalize_voices(self.ref_voices, E)
        self.cur_weapon_sources = [E.parse(art.files.path(e).read_text(encoding='utf-8'), str(art.files.path(e)))
                                   for e in E._section(rtsai, 'Weapons')]
        self.cur_weapons = E.merge(self.cur_weapon_sources)
        self.ref_weapons = art.files.load(E._section(classic, 'Weapons'))
        self.cur_weapon_sources.append(art.retail.weapons)
        self.cur_weapons = E.merge(self.cur_weapon_sources)
        self.ref_weapons.update({w.key: w.clone() for w in art.retail.weapons})

    # -- reading

    def voice_set(self, view, name):
        voices = self.cur_voices if view == 'cur' else self.ref_voices
        node = voices.get(name.lower())
        if node is None:
            raise VoiceError(f'{view} voice set {name} not found')
        return VoiceSet(name, node)

    def current_phrases(self, name):
        """Every phrase the current voice set defines in any language variant (RTSAIVoiced picks __faction or __en),
        with the English variant's clips where it has the phrase: the fallback for original-country units, which speak
        English in the original game."""
        phrases = {}
        for suffix in ('__en', '', '__faction'):
            v = self.cur_voices.get((name + suffix).lower())
            if v is not None:
                for k, clips in VoiceSet(name + suffix, v).phrases.items():
                    phrases.setdefault(k, clips)
        return phrases

    @staticmethod
    def voice_traits(actor):
        return [(t.key, t) for t in actor.children if E.trait_type(t.key) in VOICE_TRAITS]

    # -- the plan

    def plan(self):
        """Which actors get which original voice set, and the original clips that needs (before extraction)."""
        self.actors = {}
        self.skipped = {}
        clips = set()
        for name in sorted(self.art.skirmish):
            if not self.art.skirmish[name] & set(E.COUNTRIES) or name not in self.art.cur or name not in self.art.ref:
                continue
            cur, ref = self.art.cur[name], self.art.ref[name]
            ref_traits, cur_traits = self.voice_traits(ref), self.voice_traits(cur)
            if not ref_traits:
                self.skipped[name] = 'the original game gives it no voice'
                continue
            if not cur_traits:
                # A new voice could be asked for phrases nothing defines (the engine throws): keep it silent.
                self.skipped[name] = 'the current game gives it no voice'
                continue
            if len(ref_traits) > 1 or len(cur_traits) > 1:
                raise VoiceError(f'{name}: several voice traits')
            ref_set = ref_traits[0][1].val('VoiceSet')
            cur_key, cur_trait = cur_traits[0]
            every = name in EVERY_FACTION_ACTORS
            factions = list(E.COUNTRIES + E.MODERN) if every else list(E.COUNTRIES)
            spec = {'reference': ref_set, 'current': cur_trait.val('VoiceSet'), 'trait': cur_key,
                    'traitType': E.trait_type(cur_key), 'condition': cur_trait.val('RequiresCondition'),
                    'volume': ref_traits[0][1].val('Volume'), 'every': every, 'factions': factions}
            r = self.voice_set('ref', ref_set)
            original = {f for phrase in r.phrases for faction in factions for f in r.files(phrase, faction) if clip_file(f)}
            if not original:
                self.skipped[name] = f'its original voice set {ref_set} names no original clip'
                continue
            clips |= {clip_file(f) for f in original}
            # Phrases only the current voice set has keep its clips; those named after an RA2 clip (the project's
            # stand-ins, e.g. the generic infantry deaths) play the original instead where RA2 has it.
            c = self.voice_set('cur', spec['current'])
            cur_phrases = self.current_phrases(spec['current'])
            clips |= {clip_file(f, strict=False) for phrase in cur_phrases if phrase not in r.phrases for faction in factions
                      for f in self._current_files(c, cur_phrases, phrase, faction)} - {None}
            self.actors[name] = spec
        # Weapons: the dog's bite for everyone, and the weapons only original-country actors fire.
        self.weapons = {}
        for weapon in EVERY_FACTION_WEAPONS:
            cur, ref = self.cur_weapons.get(weapon), self.ref_weapons.get(weapon)
            if cur is None or ref is None:
                raise VoiceError(f'weapon {weapon} not found')
            sounds = weapon_sounds(cur)
            if not same_sounds(sounds, weapon_sounds(ref)):
                raise VoiceError(f'{weapon}: the current sounds {sounds} differ from the original {weapon_sounds(ref)}')
            files = {clip_file(x) for v in sounds.values() for x in E.split_list(v)} - {None}
            if not files:
                raise VoiceError(f'{weapon}: no original sound clip')
            clips |= files
            self.weapons[weapon] = {'sounds': sounds, 'firedBy': 'every faction'}
        for weapon, users in sorted(self.original_weapons().items()):
            sounds = weapon_sounds(self.cur_weapons[weapon])
            files = {clip_file(x, strict=False) for v in sounds.values() for x in E.split_list(v)} - {None}
            if files:
                clips |= files
                self.weapons[weapon] = {'sounds': sounds, 'firedBy': sorted(users)}
        for weapon in self.art.retail.weapons:
            sounds = weapon_sounds(weapon)
            files = {clip_file(x, strict=False) for value in sounds.values() for x in E.split_list(value)} - {None}
            if files:
                clips |= files
                self.weapons[weapon.key] = {'sounds': sounds, 'firedBy': ['original countries']}
        self.deaths = self._plan_deaths()
        clips |= {c for specs in self.deaths.values() for s in specs for c in s['explosion'] + s['die']}
        self.clips = sorted(clips)
        return self

    def _plan_deaths(self):
        """Original-art actors whose death weapon plays a standalone stand-in sound, with RA2's own death sounds for them:
        the sound of one of its Explosion= animations (as RA2 picks one), and its DieSound= on top (every vehicle's
        GenVehicleDie, a building's BuildingGenericDie crumble and its own, if any)."""
        facts = json.loads(DEATH_FACTS.read_text(encoding='utf-8'))
        self.death_facts = facts
        weapons = {k.lower(): k for k in self.cur_weapons}

        def clips(events):
            out = []
            for e in events:
                for c in facts['sounds'].get(e, {}).get('clips', []):
                    if c not in out:
                        out.append(c)
            return out
        def stand_in(weapon):
            return weapon is not None and any(STAND_IN_DEATH.search(x) for v in weapon_sounds(self.cur_weapons[weapon]).values()
                                              for x in E.split_list(v))

        def spec(trait, weapon, ra2, **extra):
            die = ([facts['buildingDieSound']] if ra2['kind'] == 'building' and facts['buildingDieSound'] else []) + \
                  ([ra2['dieSound']] if ra2['dieSound'] else [])
            explosions = [facts['animations'].get(a, '') for a in ra2['explosions']]
            if not clips(explosions):
                drawn = [x.lower() for w in self.cur_weapons[weapon].children if E.trait_type(w.key) == 'Warhead'
                         for x in E.split_list(w.val('Explosions') or '')]
                explosions = [facts['animations'].get(anim, '') for part, anim in EXPLOSION_ANIMS if any(part in x for x in drawn)]
            return {'trait': trait, 'weapon': weapon, 'kind': ra2['kind'], **extra,
                    'events': {'explosion': sorted({e for e in explosions if e}), 'die': die},
                    'explosion': clips(explosions), 'die': clips(die)}
        deaths = {}
        for name in sorted(self.art.actors):
            ra2 = facts['actors'].get(name)
            if ra2 is None:
                continue
            for key, trait in E.traits(self.art.cur[name], 'FireWarheadsOnDeath'):
                weapon = weapons.get((trait.val('Weapon') or '').lower())
                if stand_in(weapon):
                    deaths.setdefault(name, []).append(spec(key, weapon, ra2))
            # An aircraft's wreck falls and explodes on the ground (FallsToEarth): RA2's sound of its explosion.
            for _, trait in E.traits(self.art.cur[name], 'SpawnActorOnDeath'):
                husk = (trait.val('Actor') or '').lower()
                falls = self.art.cur[husk].get('FallsToEarth') if husk in self.art.cur else None
                weapon = weapons.get((falls.val('Explosion') or '').lower()) if falls is not None else None
                if stand_in(weapon):
                    deaths.setdefault(husk, []).append(spec('FallsToEarth', weapon, ra2, wreckOf=name))
        return deaths

    @staticmethod
    def _without_sounds(weapon):
        """A weapon without its sounds or the death cry's warhead: what must not change between a weapon and its twin."""
        w = weapon.clone()
        w.key = ''
        w.children = [c for c in w.children if c.key not in WEAPON_SOUND_FIELDS and c.key != 'Inherits'
                      and not c.key.startswith('Inherits@') and c.key != 'Warhead@' + DEATH_CONDITION]
        for c in w.children:
            if E.trait_type(c.key) == 'Warhead':
                c.children = [x for x in c.children if x.key not in WARHEAD_SOUND_FIELDS]
        return E.dump([w])

    def _deaths(self, present, rules):
        """The original countries' death sounds: per weapon and sound set, a twin of the death weapon that differs from it
        only in its sounds, and per actor a twin of its death trait for the original countries (condition ea-death).
        Extends `rules` (the actors' voice rules) in place; returns (weapons, summary)."""
        effective = {k.lower(): v for k, v in E.merge([list(self.art.cur.values()), self.art.rules_nodes]).items()}
        by_actor = {n.key.lower(): n for n in rules}
        twins, weapons, summary = {}, [], {}
        for name, specs in sorted(self.deaths.items()):
            for spec in specs:
                trait = effective[name].get(spec['trait'])
                if trait is None:
                    continue
                wreck = spec['trait'] == 'FallsToEarth'
                if wreck and not (self.art.owners.get(name) and self.art.owners[name] <= set(E.COUNTRIES)):
                    continue  # a wreck the modern countries' aircraft leave too: FallsToEarth has no condition to twin
                condition = trait.val('RequiresCondition') or ''
                if '!' + E.CONDITION in condition.replace(' ', ''):
                    continue  # it does not fire for the original countries (an original twin does)
                explosion = [AUDIO_PREFIX + c for c in spec['explosion'] if c in present]
                die = [AUDIO_PREFIX + c for c in spec['die'] if c in present]
                if not explosion and not die:
                    continue  # RA2 lacks every clip: the project's sound stays
                self.used |= {c for c in spec['explosion'] + spec['die'] if c in present}
                signature = json.dumps([spec['weapon'].lower(), explosion, die])
                twin = twins.get(signature)
                if twin is None:
                    n = sum(1 for s in twins if json.loads(s)[0] == spec['weapon'].lower())
                    twin = DEATH_PREFIX + spec['weapon'].lower() + (f'-{n + 1}' if n else '')
                    twins[signature] = twin
                    w = self.cur_weapons[spec['weapon']].clone()
                    w.key = twin
                    w.children = [c for c in w.children if c.key != 'Inherits' and not c.key.startswith('Inherits@')]
                    for c in w.children:
                        if E.trait_type(c.key) == 'Warhead' and explosion and any(
                                STAND_IN_DEATH.search(x) for x in E.split_list(c.val('ImpactSounds') or '')):
                            c.get('ImpactSounds').value = ', '.join(explosion)
                    if die:
                        w.children.append(E.Node('Warhead@' + DEATH_CONDITION, 'CreateEffect', [
                            E.Node('ImpactSounds', ', '.join(die)), E.Node('ValidTargets', 'Ground, Water, Air'),
                            E.Node('ImpactActors', 'false')]))
                    if self._without_sounds(w) != self._without_sounds(self.cur_weapons[spec['weapon']]):
                        raise VoiceError(f'{twin}: differs from {spec["weapon"]} in more than its sounds')
                    weapons.append(w)
                node = by_actor.get(name)
                if node is None:
                    node = E.Node(self.art.cur[name].key)
                    rules.append(node)
                    by_actor[name] = node
                if wreck:
                    # Only the original countries' aircraft leave this wreck: its explosion is theirs alone.
                    node.children.append(E.Node('FallsToEarth', None, [E.Node('Explosion', twin)]))
                    summary.setdefault(name, []).append({'trait': 'FallsToEarth', 'weapon': spec['weapon'], 'twin': twin,
                                                         'kind': spec['kind'], 'wreckOf': spec['wreckOf'],
                                                         'events': spec['events'], 'explosion': explosion, 'die': die})
                    continue
                if node.get('GrantConditionOnFaction@' + DEATH_CONDITION) is None:
                    node.children.append(E.Node('GrantConditionOnFaction@' + DEATH_CONDITION, None, [
                        E.Node('Condition', DEATH_CONDITION), E.Node('Factions', ', '.join(self.art.actors[name]['countries']))]))
                key = spec['trait']
                node.children.append(E.Node(key, None, [E.Node('RequiresCondition', E.both('!' + DEATH_CONDITION, condition))]))
                body = [c.clone() for c in trait.children if c.key not in ('Weapon', 'RequiresCondition')]
                for c in body:
                    if c.key == 'EmptyWeapon' and (c.value or '').lower() == spec['weapon'].lower():
                        c.value = twin
                body += [E.Node('Weapon', twin), E.Node('RequiresCondition', E.both(DEATH_CONDITION, condition))]
                node.children.append(E.Node(key + ('-' if '@' in key else '@') + DEATH_CONDITION, None, body))
                summary.setdefault(name, []).append({'trait': key, 'weapon': spec['weapon'], 'twin': twin, 'kind': spec['kind'],
                                                     'events': spec['events'], 'explosion': explosion, 'die': die})
        return weapons, summary

    def original_weapons(self):
        """Weapons only actors the original countries own fire (skirmish reachability and mission placements), with the
        same sounds as in the original game: weapon -> its users. Conservative: a weapon another weapon names, or one an
        actor of unknown, modern or every-faction ownership names (the World and Player actors included), is shared and
        keeps the project's sounds, as do weapons whose sounds the current game changed."""
        names = {k.lower(): k for k in self.cur_weapons if not k.startswith('^')}
        users, nested = {}, set()

        def scan(node, found):
            for c in node.children:
                for token in E.split_list(c.value):
                    if token.lower() in names:
                        found.add(names[token.lower()])
                scan(c, found)
        for actor, node in self.art.cur.items():
            if actor.startswith('^'):
                continue
            found = set()
            scan(node, found)
            for w in found:
                users.setdefault(w, set()).add(actor)
        for key, node in self.cur_weapons.items():
            found = set()
            scan(node, found)
            nested |= found - {key}
        out = {}
        for w, actors in users.items():
            if w in EVERY_FACTION_WEAPONS or w in nested or w not in self.ref_weapons:
                continue
            if any(a in EVERY_FACTION_ACTORS or not self.art.owners.get(a) or not self.art.owners[a] <= set(E.COUNTRIES) for a in actors):
                continue
            if not same_sounds(weapon_sounds(self.cur_weapons[w]), weapon_sounds(self.ref_weapons[w])):
                continue
            out[w] = actors
        return out

    def needed_clips(self):
        return list(self.clips)

    # -- generation

    def generate(self, present, absent):
        """Voice sets, rules and weapons naming only bundled clips (present) or, where RA2 lacks a clip (absent), the
        current project clips. A planned clip in neither set is an incomplete extract: refused."""
        present, absent = set(present), set(absent)
        missing = [c for c in self.clips if c not in present and c not in absent]
        if missing:
            raise VoiceError(f'original clips missing from the extract (neither extracted nor recorded as absent from RA2): {missing}')
        extra = sorted(present - set(self.clips))
        if extra:
            raise VoiceError(f'the extract carries clips the plan does not name: {extra}')
        self.present = present
        self.used = set()
        self.fallbacks = {}
        self.dropped = {}
        sets = {}       # twin name -> Node
        rules = []
        actor_summary = {}
        for name, spec in sorted(self.actors.items()):
            r = self.voice_set('ref', spec['reference'])
            c = self.voice_set('cur', spec['current'])
            cur_phrases = self.current_phrases(spec['current'])
            # Countries whose files resolve alike share one twin (e.g. the engineer: an Allied and a Soviet prefix).
            groups = {}
            for f in spec['factions']:
                key = (tuple((p, tuple(r.files(p, f))) for p in sorted(r.phrases)),
                       tuple((p, tuple(self._current_files(c, cur_phrases, p, f))) for p in sorted(cur_phrases)))
                groups.setdefault(key, []).append(f)
            twins = []
            for gi, (key, factions) in enumerate(sorted(groups.items(), key=lambda kv: E.COUNTRIES.index(kv[1][0]) if kv[1][0] in E.COUNTRIES else 99)):
                body, fell_back = self._twin(name, r, c, cur_phrases, factions[0])
                twin = 'Ea' + spec['reference'] + (('-' + factions[0]) if len(groups) > 1 else '') + (('-via-' + spec['current']) if fell_back else '')
                if twin.lower() in sets and E.dump([sets[twin.lower()]]) != E.dump([E.Node(twin, None, body)]):
                    raise VoiceError(f'{name}: twin {twin} differs from an earlier one of the same name')
                sets[twin.lower()] = E.Node(twin, None, body)
                twins.append((twin, factions, fell_back))
            if spec['every']:
                if len(twins) != 1:
                    raise VoiceError(f'{name}: an every-faction voice resolves differently per faction')
                out = E.Node(self.art.cur[name].key, None, [E.Node(spec['trait'], None, [E.Node('VoiceSet', twins[0][0])])])
            else:
                out = E.Node(self.art.cur[name].key)
                conditions = []
                for i, (twin, factions, _) in enumerate(twins):
                    cond = CONDITION if len(twins) == 1 else f'{CONDITION}-{factions[0]}'
                    conditions.append(cond)
                    out.children.append(E.Node(f'GrantConditionOnFaction@{cond}', None, [E.Node('Condition', cond), E.Node('Factions', ', '.join(factions))]))
                disable = ' && '.join('!' + cond for cond in conditions)
                out.children.append(E.Node(spec['trait'], None, [E.Node('RequiresCondition', E.both(disable, spec['condition']))]))
                for twin, factions, _ in twins:
                    cond = conditions[[t[0] for t in twins].index(twin)]
                    children = [E.Node('VoiceSet', twin)]
                    if spec['volume']:
                        children.append(E.Node('Volume', spec['volume']))
                    children.append(E.Node('RequiresCondition', E.both(cond, spec['condition'])))
                    out.children.append(E.Node(spec['traitType'] + '@' + cond, None, children))
            rules.append(out)
            actor_summary[name] = {'reference': spec['reference'], 'current': spec['current'],
                                   'twins': {t: f for t, f, _ in twins}, 'everyFaction': spec['every'],
                                   'fallbackPhrases': sorted(self.fallbacks.get(name, [])),
                                   'droppedPhrases': sorted(self.dropped.get(name, []))}
        weapons = []
        weapon_summary = {}
        for weapon, spec in sorted(self.weapons.items()):
            node = E.Node(weapon)
            changed = {}
            for path, value in spec['sounds'].items():
                names = []
                for x in E.split_list(value):
                    f = clip_file(x, strict=False)
                    if f and f in present:
                        names.append(AUDIO_PREFIX + f)
                        self.used.add(f)
                    else:
                        names.append(x)
                if names == E.split_list(value):
                    continue
                changed['.'.join(path)] = names
                parent = node
                for key in path[:-1]:
                    parent = child(parent, key)
                parent.children.append(E.Node(path[-1], ', '.join(names)))
            if node.children:
                weapons.append(node)
                weapon_summary[weapon] = {'firedBy': spec['firedBy'], 'sounds': changed}
        death_weapons, death_summary = self._deaths(present, rules)
        weapons += death_weapons
        # Weapons that inherit a changed one keep their own sounds.
        before = self.cur_weapons
        after = E.merge(self.cur_weapon_sources + [[w.clone() for w in weapons]])
        for key in sorted(before):
            if key in weapon_summary or key.startswith('^'):
                continue
            was, now = weapon_sounds(before[key]), weapon_sounds(after[key])
            if was != now:
                node = E.Node(key)
                for path in sorted(set(was) | set(now)):
                    if was.get(path) == now.get(path):
                        continue
                    if path not in was:
                        raise VoiceError(f'{key}: inherits {".".join(path)} only through a changed weapon')
                    parent = node
                    for k in path[:-1]:
                        parent = child(parent, k)
                    parent.children.append(E.Node(path[-1], was[path]))
                weapons.append(node)
                weapon_summary[key] = {'kept': {'.'.join(p): v for p, v in was.items()}}
        check = E.merge(self.cur_weapon_sources + [[w.clone() for w in weapons]])
        for key in before:
            if key not in self.weapons and not key.startswith('^') and weapon_sounds(before[key]) != weapon_sounds(check[key]):
                raise VoiceError(f'{key}: its sounds would change')
        unused = sorted(present - self.used)
        if unused:
            raise VoiceError(f'extracted clips no voice set or weapon uses: {unused}')
        self.voice_nodes = [sets[k] for k in sorted(sets)]
        self.rules_nodes = rules
        self.weapon_nodes = weapons
        self.summary = {'schema': 1, 'countries': list(E.COUNTRIES), 'everyFaction': list(EVERY_FACTION_ACTORS),
                        'clips': sorted(self.used), 'absent': sorted(absent & set(self.clips)), 'actors': actor_summary,
                        'weapons': weapon_summary, 'skipped': dict(sorted(self.skipped.items())),
                        'deaths': death_summary, 'deathWeapons': {w.key: next(s['weapon'] for d in death_summary.values() for s in d
                                                                              if s['twin'] == w.key) for w in death_weapons},
                        'deathFactsSha256': self.death_facts['sourceSha256']}
        self._validate()
        return self

    def _current_files(self, c: VoiceSet, phrases, phrase, faction):
        """The files the current voice set plays for a phrase (its own prefix/variant rules); language variants that only
        add phrases resolve through the base set's rules (they inherit it)."""
        clips = phrases.get(phrase, [])
        return [c.file(phrase, clip, faction) for clip in clips]

    def _twin(self, actor, r: VoiceSet, c: VoiceSet, cur_phrases, faction):
        """A voice set (DefaultVariant .wav, explicit names) for one faction group. Returns (children, fell_back)."""
        voices = E.Node('Voices')
        fell_back = False
        for phrase in sorted(set(r.phrases) | set(cur_phrases), key=lambda p: (list(r.phrases) + sorted(cur_phrases)).index(p)):
            if phrase in r.phrases and not r.phrases[phrase]:
                voices.children.append(E.Node(phrase))
                continue
            names = []
            if phrase in r.phrases:
                for f in r.files(phrase, faction):
                    clip = clip_file(f)
                    if clip is None:
                        # The reference itself plays a project file here.
                        names.append(self._strip(f, actor, phrase))
                    elif clip in self.present:
                        names.append(AUDIO_PREFIX + clip[:-len(AUDIO_EXTENSION)])
                        self.used.add(clip)
            if not names and phrase in cur_phrases:
                # RA2 lacks every original clip of this phrase (or the original never had it): the project's sound, or
                # the original of a clip the project only stands in for.
                names = [self._fallback(f, actor, phrase) for f in self._current_files(c, cur_phrases, phrase, faction)]
                if phrase in r.phrases:
                    self.fallbacks.setdefault(actor, set()).add(phrase)
                if names:
                    fell_back = True
            if names:
                voices.children.append(E.Node(phrase, ', '.join(names)))
            else:
                # Neither RA2 nor the current voice set has a clip for it: nothing asks for the phrase today.
                self.dropped.setdefault(actor, set()).add(phrase)
        return [E.Node('DefaultVariant', AUDIO_EXTENSION), voices], fell_back

    def _fallback(self, f, actor, phrase):
        clip = clip_file(f, strict=False)
        if clip is not None and clip in self.present:
            self.used.add(clip)
            return AUDIO_PREFIX + clip[:-len(AUDIO_EXTENSION)]
        return self._strip(f, actor, phrase)

    @staticmethod
    def _strip(f, actor, phrase):
        if not f.lower().endswith(AUDIO_EXTENSION):
            raise VoiceError(f'{actor}.{phrase}: {f} is not a .wav clip')
        return f[:-len(AUDIO_EXTENSION)]

    def _validate(self):
        names = {n.key.lower() for n in self.voice_nodes}
        for n in self.voice_nodes:
            voices = n.get('Voices')
            if voices is None or not voices.children:
                raise VoiceError(f'{n.key}: no phrase')
            for p in voices.children:
                for clip in E.split_list(p.value):
                    if clip.startswith(AUDIO_PREFIX):
                        f = clip[len(AUDIO_PREFIX):] + AUDIO_EXTENSION
                        if f not in self.present:
                            raise VoiceError(f'{n.key}.{p.key}: {f} is not extracted')
                    elif clip.startswith(E.EA_PREFIX):
                        raise VoiceError(f'{n.key}.{p.key}: {clip} is outside the original audio folder')
        for actor in self.rules_nodes:
            for t in actor.children:
                if t.val('VoiceSet') and t.val('VoiceSet').lower() not in names:
                    raise VoiceError(f'{actor.key}.{t.key}: voice set {t.val("VoiceSet")} not generated')

    def write(self, out: Path):
        header = ('# GENERATED by RTSAI-WebGame tools/prepare-content.py (tools/ea_voices.py). Original Command & Conquer\n'
                  '# unit voices and sounds under EA\'s free, non-commercial modding guidelines (no music).\n'
                  '# EA has not endorsed and does not support this product.\n\n')
        (out / 'ea-audio.yaml').write_text(header + '\n'.join(E.dump([n]) for n in self.rules_nodes), encoding='utf-8', newline='\n')
        (out / 'ea-voices.yaml').write_text(header + '\n'.join(E.dump([n]) for n in self.voice_nodes), encoding='utf-8', newline='\n')
        (out / 'ea-weapons.yaml').write_text(header + '\n'.join(E.dump([n]) for n in self.weapon_nodes), encoding='utf-8', newline='\n')
        (out / 'ea-audio.json').write_text(json.dumps(self.summary, indent=1) + '\n', encoding='utf-8', newline='\n')
        return self.summary



def plan_digest(clips):
    return hashlib.sha256(json.dumps(clips).encode()).hexdigest()
