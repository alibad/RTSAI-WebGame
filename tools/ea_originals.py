"""Original Westwood (EA) art for the nine original countries in the public isometric browser game.

EA's Command & Conquer Franchise Modding Guidelines allow free, non-commercial use of the original art with the
notice "EA has not endorsed and does not support this product." This module uses only art files (.shp .vxl .hva
.pal); the original unit voices are tools/ea_voices.py's (short .wav clips), and no C&C music or video ever enters the
build.

The generator reads two views of the frozen RTSAI-Mod snapshot:
  * the REFERENCE view: the rules and sequences the classic add-on (mods/rtsai-classic) loads, which draw the original
    countries with the original RA2 art;
  * the CURRENT view: what the public isometric web game loads today (mods/rtsai with its standalone stand-ins and the
    web content overlays, in the web manifest's order).
For every actor an original country can own it clones the reference image as ea-<image> (filenames rewritten to the
bundled ra2|web/ea/<file>), and gives those countries the original images and palettes. The original-country bundle
also restores the five shared Soviet isometric foundations and seven original-country production entries hidden by
the standalone kit. Modern factions retain their art and production menus; shared foundations are authoritative for
all owners. The separate Classic (top-down) bundle is untouched.
"""
from __future__ import annotations

import copy
import hashlib
import json
import re
from pathlib import Path
import ea_retail
import effect_anchors

COUNTRIES = ('america', 'germany', 'england', 'france', 'korea', 'cuba', 'libya', 'iraq', 'russia')
MODERN = ('china', 'iran', 'turkey', 'saudi', 'israel', 'yemen', 'hezbollah')
# Original isometric foundations replace the kit geometry when original-country content is enabled.
RESTORED_FOUNDATIONS = ('napowr', 'nahand', 'nadept', 'natech', 'nanrct')
RESTORED_PRODUCTION = ('gaorep', 'gagap', 'gaspysat', 'gaweat', 'napsis', 'naclon', 'namisl')
ORIGINAL_PREREQUISITE = 'original-ra2-country'
# Only art here (voice clips: tools/ea_voices.py). C&C music and video never enter the build.
ALLOWED_EXTENSIONS = ('.shp', '.vxl', '.hva', '.pal')
EA_PREFIX = 'ra2|web/ea/'
# The palettes the original art is drawn with (from the original RA2 palette files).
EA_PALETTE_FILES = {'eaunit': 'unittem.pal', 'eaeffect': 'anim.pal', 'eacameo': 'cameo.pal'}
CONDITION = 'ea-art'
SAFE_NAME = re.compile(r'[a-z0-9][a-z0-9_.-]{0,63}')


# ---------------------------------------------------------------------------------------------------------------
# MiniYaml: a faithful port of OpenRA.Game/MiniYaml.cs parsing, merging and inheritance (removals included).

class Node:
    __slots__ = ('key', 'value', 'children', 'loc')

    def __init__(self, key, value=None, children=None, loc=''):
        self.key = key
        self.value = value
        self.children = children if children is not None else []
        self.loc = loc

    def get(self, key):
        for n in self.children:
            if n.key == key:
                return n
        return None

    def val(self, key, default=None):
        n = self.get(key)
        return n.value if n is not None and n.value is not None else default

    def clone(self):
        return Node(self.key, self.value, [c.clone() for c in self.children], self.loc)

    def __repr__(self):
        return f'Node({self.key!r}, {self.value!r}, {len(self.children)} children)'


def parse(text, name=''):
    """Lines -> top-level nodes, exactly as MiniYaml.FromLines (tabs or 4 spaces per level, # comments, \\# escapes)."""
    root = []
    stack = [(-1, root)]
    for lineno, raw in enumerate(text.replace('\r\n', '\n').split('\n'), 1):
        level = 0
        spaces = 0
        i = 0
        while i < len(raw) and raw[i] in ' \t':
            if raw[i] == '\t':
                level += 1
            else:
                spaces += 1
                if spaces >= 4:
                    spaces = 0
                    level += 1
            i += 1
        line = raw
        key_start = i
        key_len = len(line) - key_start
        value_start = -1
        value_len = 0
        for j, ch in enumerate(line):
            if value_start < 0 and ch == ':':
                value_start = j + 1
                key_len = j - key_start
                value_len = len(line) - j - 1
            if ch == '#' and (j == 0 or line[j - 1] != '\\'):
                if j <= key_start + key_len:
                    key_len = j - key_start
                else:
                    value_len = j - value_start
                break
        key = line[key_start:key_start + key_len].strip() if key_len > 0 else ''
        value = None
        if value_start >= 0:
            v = line[value_start:value_start + value_len].strip()
            if v:
                value = v.replace('\\#', '#')
        if not key:
            continue
        while stack[-1][0] >= level:
            stack.pop()
        if level > stack[-1][0] + 1:
            raise ValueError(f'{name}:{lineno}: bad indent')
        node = Node(key, value, [], f'{name}:{lineno}')
        stack[-1][1].append(node)
        stack.append((level, node.children))
    return root


def _last_index(nodes, key):
    for i in range(len(nodes) - 1, -1, -1):
        if nodes[i].key == key:
            return i
    return -1


def _merge_partial_yaml(existing, override):
    """MiniYaml.MergePartial(MiniYaml, MiniYaml): (value, nodes) pairs."""
    if existing is None:
        return override
    if override is None:
        return existing
    return (override[0] if override[0] is not None else existing[0], _merge_partial_nodes(existing[1], override[1]))


def _merge_partial_nodes(existing, override):
    if not existing:
        return override
    if not override:
        return existing
    ret = []
    plain = set()
    for n in list(existing) + list(override):
        if n.key.startswith('-'):
            ret.append(n)
            continue
        if n.key not in plain:
            plain.add(n.key)
            ret.append(n)
            continue
        prev = _last_index(ret, n.key)
        prev_removal = _last_index(ret, '-' + n.key)
        if prev_removal != -1 and prev_removal > prev:
            ret.append(n)
            continue
        value, nodes = _merge_partial_yaml((ret[prev].value, ret[prev].children), (n.value, n.children))
        ret[prev] = Node(n.key, value, nodes, n.loc)
    return ret


def _merge_self_partial(nodes):
    ret = []
    keys = set()
    for n in nodes:
        if n.key in keys:
            i = _last_index(ret, n.key)
            value, children = _merge_partial_yaml((ret[i].value, ret[i].children), (n.value, n.children))
            ret[i] = Node(ret[i].key, value, children, ret[i].loc)
        else:
            keys.add(n.key)
            ret.append(n)
    return ret


def _resolve_inherits(nodes, tree, inherited):
    if not nodes:
        return nodes
    resolved = []
    keys = set()
    for n in nodes:
        if n.key == 'Inherits' or n.key.startswith('Inherits@'):
            if n.value not in tree:
                raise ValueError(f'{n.loc}: parent type {n.value} not found')
            if n.value in inherited:
                raise ValueError(f'{n.loc}: parent type {n.value} already inherited')
            inherited = inherited | {n.value}
            for r in _resolve_inherits(tree[n.value][1], tree, inherited):
                _merge_into_resolved(r, resolved, keys, tree, inherited)
        elif n.key.startswith('-'):
            removed = n.key[1:]
            before = len(resolved)
            resolved = [r for r in resolved if r.key != removed]
            if len(resolved) == before:
                raise ValueError(f'{n.loc}: there are no elements with key {removed} to remove')
            keys.discard(removed)
        else:
            _merge_into_resolved(n, resolved, keys, tree, inherited)
    return resolved


def _merge_into_resolved(o, existing, keys, tree, inherited):
    index = -1
    current = None
    if o.key in keys:
        index = _last_index(existing, o.key)
        current = existing[index]
    else:
        keys.add(o.key)
    value, nodes = _merge_partial_yaml(None if current is None else (current.value, current.children), (o.value, o.children))
    nodes = _resolve_inherits(nodes, tree, inherited)
    if current is not None:
        existing[index] = Node(current.key, value, nodes, current.loc)
    else:
        existing.append(Node(o.key, value, nodes, o.loc))


def merge(sources):
    """MiniYaml.Merge: several parsed files -> {top-level key: resolved Node} (inheritance and removals applied)."""
    agg = None
    for s in sources:
        s = _merge_self_partial(s)
        agg = s if agg is None else _merge_partial_nodes(agg, s)
    agg = agg or []
    tree = {}
    for n in agg:
        tree[n.key] = (n.value, n.children)
    resolved = [Node(k, v[0], _resolve_inherits(v[1], tree, frozenset([k]))) for k, v in tree.items()]
    final = _resolve_inherits(resolved, tree, frozenset())
    return {n.key: n for n in final}


def dump(nodes, depth=0):
    out = []
    for n in nodes:
        out.append('\t' * depth + n.key + ':' + (' ' + n.value if n.value is not None else '') + '\n')
        out.append(dump(n.children, depth + 1))
    return ''.join(out)


def split_list(value):
    return [x.strip() for x in (value or '').split(',') if x.strip()]


# ---------------------------------------------------------------------------------------------------------------
# Manifests: which files each view loads, in order.

def _section(manifest_text, key):
    """Entries of a top-level manifest list (e.g. Rules), in order."""
    out = []
    inside = False
    for line in manifest_text.replace('\r\n', '\n').split('\n'):
        if line and not line[0].isspace():
            inside = line.split('#', 1)[0].strip().split(':', 1)[0] == key
            continue
        entry = line.split('#', 1)[0].strip()
        if inside and entry:
            out.append(entry)
    return out


class ModFiles:
    def __init__(self, mod_root: Path, content: Path | None = None):
        self.mod = mod_root / 'mods'
        self.content = content

    def path(self, entry):
        package, _, rel = entry.partition('|')
        if package == 'ra2' and rel.startswith('web/content/'):
            if self.content is None:
                raise ValueError(f'{entry}: no web content directory')
            return self.content / rel[len('web/content/'):]
        folder = {'ra2': 'rtsai', 'classic': 'rtsai-classic', 'topdown': 'rtsai-topdown'}.get(package)
        if folder is None:
            raise ValueError(f'unsupported manifest entry {entry}')
        return self.mod / folder / rel

    def load(self, entries):
        sources = []
        for e in entries:
            p = self.path(e)
            if not p.exists():
                raise ValueError(f'missing manifest file {p}')
            sources.append(parse(p.read_text(encoding='utf-8'), str(p)))
        return merge(sources)


def web_lists(manifest_text, with_content=True):
    """The web mod.yaml's Rules/Sequences/ModelSequences in the order Bundle.WebModYaml writes them, without the EA
    overlays: the web content (and the in-memory web-rules.yaml, which only touches World/Player UI traits) is inserted
    at the first blank line of each section, i.e. before the mod's own campaigns/country* files."""
    text = manifest_text.replace('\r\n', '\n')

    def entries_with_insert(key, insert):
        lines = text.split('\n')
        start = lines.index(key + ':')
        out = []
        inserted = False
        for line in lines[start + 1:]:
            if line and not line[0].isspace():
                break
            entry = line.split('#', 1)[0].strip()
            if not entry and not inserted:
                out.extend(insert)
                inserted = True
                continue
            if entry:
                out.append(entry)
        if not inserted:
            out.extend(insert)
        return out

    rules = entries_with_insert('Rules', ['ra2|web/content/countries.yaml'] if with_content else [])
    sequences = entries_with_insert('Sequences', ['ra2|web/content/country-sequences.yaml'] if with_content else [])
    models = _section(text, 'ModelSequences')
    return rules, sequences, models


# ---------------------------------------------------------------------------------------------------------------
# Rules helpers.

def traits(actor: Node, name):
    """(key, node) of every trait instance of a type, e.g. traits(a, 'WithVoxelBody') -> WithVoxelBody, WithVoxelBody@x."""
    return [(n.key, n) for n in actor.children if n.key == name or n.key.startswith(name + '@')]


def trait_type(key):
    return key.split('@', 1)[0]


def prerequisites_of(actor):
    b = actor.get('Buildable')
    return split_list(b.val('Prerequisites')) if b is not None else []


def render_image(actor: Node, faction):
    """RenderSpritesInfo.GetImage."""
    rs = actor.get('RenderSprites')
    if rs is None:
        return None
    images = rs.get('FactionImages')
    if images is not None and faction:
        img = images.val(faction)
        if img:
            return img.lower()
    return (rs.val('Image') or actor.key).lower()


def voxel_image(actor: Node):
    rv = actor.get('RenderVoxels')
    if rv is None:
        return None
    return (rv.val('Image') or actor.key).lower()


# Trait fields that name actors an owner creates (spawned, transformed, dropped, carried).
SPAWN_FIELDS = {
    'Transforms': ('IntoActor',), 'TransformOnCapture': ('IntoActor',), 'SpawnActorOnDeath': ('Actor',),
    'SpawnActorsOnSell': ('ActorTypes',), 'FreeActor': ('Actor',), 'FreeActorWithDelivery': ('Actor', 'DeliveringActor'),
    'ParatroopersPower': ('UnitType', 'DropItems'), 'AirstrikePower': ('UnitType',), 'SpawnActorPower': ('Actor',),
    'ProduceActorPower': ('Actors',), 'CarrierParent': ('Actors',), 'BaseSpawnerParent': ('Actors',),
    'MissileSpawnerParent': ('Actors',), 'Cargo': ('InitialUnits',), 'EjectOnDeath': ('PilotActor',),
    'Minelayer': ('Mine',), 'SpawnActorOnMindControlled': ('Actor',), 'DeliversCash': (), 'TransformOnCondition': ('IntoActor',),
}


def _resolve_actors(rules):
    return {k.lower(): v for k, v in rules.items() if not k.startswith('^') and not k.startswith('-')}


def reachable(rules, faction):
    """Actors a faction can own: a fixed point over starting units, buildable prerequisites (provided by what it
    owns), transformations and spawned actors."""
    actors = _resolve_actors(rules)
    world = actors['world']
    player = actors['player']
    owned = set()
    for t in world.children:
        key = t.key
        if trait_type(key) == 'StartingUnits':
            fs = split_list(t.val('Factions'))
            if fs and faction not in fs:
                continue
            for a in [t.val('BaseActor')] + split_list(t.val('SupportActors')):
                if a and a.lower() in actors:
                    owned.add(a.lower())
    provided = set()

    def provide(actor):
        for key, t in [(n.key, n) for n in actor.children]:
            tt = trait_type(key)
            if tt in ('ProvidesPrerequisite', 'ProvidesTechPrerequisite'):
                fs = split_list(t.val('Factions'))
                if fs and faction not in fs:
                    continue
                if tt == 'ProvidesTechPrerequisite':
                    provided.update(p.lower() for p in split_list(t.val('Prerequisites')))
                else:
                    provided.add((t.val('Prerequisite') or actor.key).lower())
        provided.add(actor.key.lower())

    provide(player)
    provide(world)
    # Faction-determined prerequisites (Player/World): a buildable that excludes one of them (!x) is never available.
    static = set(provided)
    # Infiltration proxies (a spy entering an enemy building) can be earned by any side.
    for a in actors.values():
        for t in a.children:
            if trait_type(t.key).startswith('Infiltrate') and t.val('Proxy'):
                provided.add(t.val('Proxy').lower())
    changed = True
    while changed:
        changed = False
        for a in list(owned):
            provide(actors[a])
            for key, t in [(n.key, n) for n in actors[a].children]:
                fields = SPAWN_FIELDS.get(trait_type(key), ())
                for f in fields:
                    for name in split_list(t.val(f)):
                        name = name.lower()
                        if name in actors and name not in owned:
                            owned.add(name)
                            changed = True
        for name, a in actors.items():
            if name in owned or a.get('Buildable') is None:
                continue
            prereqs = [p.lstrip('~').lower() for p in prerequisites_of(a)]
            required = [p for p in prereqs if not p.startswith('!')]
            if not required or any(p[1:] in static for p in prereqs if p.startswith('!')):
                continue
            if all(p in provided for p in required):
                owned.add(name)
                changed = True
    return owned


# ---------------------------------------------------------------------------------------------------------------
# Generation.

# Packages the classic add-on mounts from the player's RA2 files: a filename prefixed with one of them is EA content.
EA_PACKAGES = {'content', 'lang', 'ra2mix', 'cameo', 'cache', 'conquer', 'local', 'theme'}
# Project-authored, fully transparent single frame: the alias for overlay/body sequences the original art lacks and
# that the original countries never draw (palette independent, so it is safe with any palette).
BLANK_FILE = 'ea-blank.png'
BLANK = 'ra2|web/content/' + BLANK_FILE
# Reference palette -> the palette the EA art is drawn with. Code-generated palettes are the same in both views.
EA_PALETTES = {'player': 'eaplayer', 'effect': 'eaeffect', 'effect50alpha': 'eaeffect50alpha', 'chrome': 'eacameo',
               'cloak': 'eacloak'}
NEUTRAL_PALETTES = {'shadow', 'normals', 'ts-normals'}
EA_PALETTE_NAMES = {'eaunit', 'eaplayer', 'eaeffect', 'eaeffect50alpha', 'eacameo', 'eacloak'}
DAMAGE_PREFIXES = ('critical-', 'damaged-', 'scratched-', 'scuffed-')
# Render traits whose renderables pass through Actor.Render (so through WithFactionPalettes) and which draw sequences
# of the actor's own image unless an explicit Image is given: (palette field, player-palette flag field) or None when
# they draw with RenderSprites' palette.
ACTOR_IMAGE_TRAITS = {
    'WithSpriteBody': None, 'WithFacingSpriteBody': None, 'WithWallSpriteBody': None, 'WithGateSpriteBody': None,
    'WithMirageSpriteBody': None, 'WithChargeSpriteBody': None, 'WithHarvesterSpriteBody': None,
    'WithInfantryBody': None, 'WithDisguisingInfantryBody': None, 'WithSplitAttackPaletteInfantryBody': None,
    'WithSpriteTurret': None, 'WithSpriteBarrel': None, 'WithMakeAnimation': None, 'WithMakeOverlay': None,
    'WithIdleOverlay': ('Palette', 'IsPlayerPalette'), 'WithBuildingPlacedOverlay': ('Palette', 'IsPlayerPalette'),
    'WithDockedOverlay': ('Palette', 'IsPlayerPalette'), 'WithRepairOverlay': ('Palette', 'IsPlayerPalette'),
    'WithProductionOverlay': ('Palette', 'IsPlayerPalette'), 'WithTeslaChargeOverlay': ('Palette', 'IsPlayerPalette'),
    'WithExitOverlay': ('Palette', 'IsPlayerPalette'), 'WithSupportPowerActivationOverlay': ('Palette', 'IsPlayerPalette'),
    'WithHarvestOverlay': ('Palette', None), 'WithBuildingPlacedAnimation': None, 'WithSupportPowerActivationAnimation': None,
    'WithTeslaChargeAnimation': None, 'WithResupplyAnimation': None, 'WithTurretAttackAnimation': None,
    'WithTurretDeployAnimation': None, 'WithAttackAnimation': None, 'WithIdleAnimation': None, 'WithMoveAnimation': None,
    'WithDockingAnimation': None, 'WithHarvestAnimation': None, 'WithAimAnimation': None, 'WithTurretAimAnimation': None,
    'WithDeliveryAnimation': None, 'WithAcceptDeliveredCashAnimation': None, 'WithMuzzleOverlay': None,
    'WithDamageOverlay': ('Palette', 'IsPlayerPalette'), 'WithChargeOverlay': ('Palette', 'IsPlayerPalette'),
}
PALETTE_DEFAULTS = {'WithHarvestOverlay': 'effect', 'WithDamageOverlay': 'effect'}
# Render traits drawn through Actor.Render from another image (their palette must not be swapped): field, default,
# default player-palette flag.
OTHER_IMAGE_TRAITS = {'WithParachute': ('Palette', 'player', True), 'WithIdleOverlay': ('Palette', None, False)}
VOXEL_TRAITS = ('WithVoxelBody', 'WithVoxelTurret', 'WithVoxelBarrel', 'WithVoxelHelicopterBody', 'WithVoxelWalkerBody',
                'WithVoxelUnloadBody')
VOXEL_DEFAULT_SEQUENCE = {'WithVoxelBody': 'idle', 'WithVoxelTurret': 'turret', 'WithVoxelBarrel': 'barrel',
                          'WithVoxelHelicopterBody': 'idle', 'WithVoxelWalkerBody': 'idle', 'WithVoxelUnloadBody': 'idle'}
# Engine ConditionalTraitInfo subclasses among the render traits this generator conditions (checked against the engine
# source: OpenRA.Mods.Common/Cnc and OpenRA.Mods.RA2 Traits/Render).
CONDITIONAL = {'WithSpriteBody', 'WithFacingSpriteBody', 'WithWallSpriteBody', 'WithMirageSpriteBody', 'WithInfantryBody',
               'WithDisguisingInfantryBody', 'WithSpriteTurret', 'WithSpriteBarrel', 'WithIdleOverlay', 'WithDockedOverlay',
               'WithRepairOverlay', 'WithProductionOverlay', 'WithExitOverlay', 'WithBuildingPlacedAnimation',
               'WithBuildingPlacedOverlay', 'WithSupportPowerActivationAnimation', 'WithSupportPowerActivationOverlay',
               'WithResupplyAnimation', 'WithTurretAttackAnimation', 'WithTurretDeployAnimation', 'WithAttackAnimation',
               'WithIdleAnimation', 'WithMoveAnimation', 'WithMuzzleOverlay', 'WithDeathAnimation', 'WithVoxelBody',
               'WithVoxelTurret', 'WithVoxelBarrel', 'WithVoxelHelicopterBody', 'WithVoxelWalkerBody', 'WithAimAnimation',
               'WithTurretAimAnimation', 'WithDamageOverlay', 'WithChargeOverlay', 'WithShadow', 'WithGateSpriteBody',
               'WithChargeSpriteBody', 'WithHarvesterSpriteBody', 'WithSplitAttackPaletteInfantryBody'}
SEQUENCE_FILE_FIELDS = ('Filename', 'FilenamePattern', 'TilesetFilenames', 'TilesetFilenamesPattern')
TILESET = 'TEMPERATE'


class GenerationError(ValueError):
    pass


def both(condition, expression):
    expression = (expression or '').strip()
    if not expression:
        return condition
    return f'{condition} && ({expression})'


def png_color_type(path: Path):
    data = path.read_bytes()[:26]
    if len(data) < 26 or data[:8] != b'\x89PNG\r\n\x1a\n':
        return None
    return data[25]


def blank_png():
    """A 1x1 fully transparent RGBA PNG (project-authored)."""
    import struct
    import zlib

    def chunk(kind, data):
        body = kind + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(b'\x00\x00\x00\x00\x00', 9)) + chunk(b'IEND', b'')


def sha256(path: Path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Generator:
    def __init__(self, mod_root: Path, content: Path):
        self.mod_root = Path(mod_root)
        self.content = Path(content)
        self.files = ModFiles(self.mod_root, self.content)
        rtsai = (self.mod_root / 'mods/rtsai/mod.yaml').read_text(encoding='utf-8')
        classic = (self.mod_root / 'mods/rtsai-classic/mod.yaml').read_text(encoding='utf-8')
        rules, sequences, models = web_lists(rtsai)
        self.cur = {k.lower(): v for k, v in self.files.load(rules).items()}
        self.curseq = {k.lower(): v for k, v in self.files.load(sequences).items()}
        self.curmodels = {k.lower(): v for k, v in self.files.load(models).items()}
        self.ref = {k.lower(): v for k, v in self.files.load(_section(classic, 'Rules')).items()}
        self.refseq = {k.lower(): v for k, v in self.files.load(_section(classic, 'Sequences')).items()}
        self.refmodels = {k.lower(): v for k, v in self.files.load(_section(classic, 'ModelSequences')).items()}
        bits = self.mod_root / 'mods/rtsai/bits'
        self.bits = {p.name.lower() for d in (bits, bits / 'cameos') if d.is_dir() for p in d.iterdir() if p.is_file()}
        # The standalone game's mounted mod folders, last mounted first (a bare file name resolves to the first match).
        self.packages = []
        for e in _section(rtsai, 'FileSystem'):
            e = e.lstrip('~')
            if e.startswith('ra2|'):
                self.packages.append(self.mod_root / 'mods/rtsai' / e[4:].split(':')[0].strip())
        self.packages.reverse()
        ea_retail.initialize(self, __import__(__name__))
        self._restore_production()
        self.owners = self._owners()

    def _restore_production(self):
        """The kit hid seven stock structures. Restore their real prerequisites for original countries only."""
        self.production = {}
        for name in RESTORED_PRODUCTION:
            buildable = self.ref[name].get('Buildable').clone()
            prereq = buildable.get('Prerequisites')
            prereq.value += ', ~' + ORIGINAL_PREREQUISITE
            self.production[name] = buildable
            actor = self.cur[name]
            actor.children = [t for t in actor.children if t.key != 'Buildable'] + [buildable.clone()]
        self.original_prerequisite = Node('ProvidesPrerequisite@original-ra2-country', None, [
            Node('Prerequisite', ORIGINAL_PREREQUISITE), Node('Factions', ', '.join(COUNTRIES))])
        self.cur['player'].children.append(self.original_prerequisite.clone())
        # Originals build the original Ore Purifier, not the kit's refinery plug.
        plug = self.cur.get('gapurifier')
        self.plug_prerequisites = None
        if plug is not None and plug.get('Buildable') is not None:
            prereq = plug.get('Buildable').get('Prerequisites')
            self.plug_prerequisites = prereq.value + ', ~!' + ORIGINAL_PREREQUISITE
            prereq.value = self.plug_prerequisites

    # -- who owns what

    def _owners(self):
        owners = {}
        for f in COUNTRIES + MODERN:
            for a in reachable(self.cur, f):
                owners.setdefault(a, set()).add(f)
        for missile, launcher in (('v3rocket', 'v3'), ('dmisl', 'dred')):
            owners[missile] = set(owners.get(launcher, ()))
        # What a country can build or field in a skirmish decides which actors get original art.
        self.skirmish = {k: set(v) for k, v in owners.items()}
        # Mission maps place actors for their own (modern) factions. An actor placed with its own faction (Tanya,
        # player-owned in Glass Island and Black Platform but "Faction: america") is fielded by that faction: its
        # FactionInit, not its owner, picks her art and voice, so a modern owner must not change the overlays.
        for m in sorted((self.content / 'maps').glob('*/map.yaml')):
            tree = {n.key: n for n in parse(m.read_text(encoding='utf-8'), str(m))}
            players = {}
            for p in tree.get('Players', Node('Players')).children:
                players[p.val('Name')] = p.val('Faction')
            for a in tree.get('Actors', Node('Actors')).children:
                faction = a.val('Faction') or players.get(a.val('Owner'))
                if a.value and faction:
                    owners.setdefault(a.value.lower(), set()).add(faction)
        return owners

    # -- sequences

    def _file(self, name, where):
        """(rewritten filename, EA file name or None) for a reference sequence filename."""
        if '|' in name:
            package, _, rel = name.partition('|')
            if package in EA_PACKAGES:
                name = rel
            elif package == 'ra2':
                return name, None
            else:
                raise GenerationError(f'{where}: unsupported package in {name}')
        if name.lower() in self.bits:
            return name, None
        if Path(name).suffix.lower() not in ALLOWED_EXTENSIONS:
            raise GenerationError(f'{where}: original art {name} is not an allowed art file')
        return EA_PREFIX + name.lower(), name.lower()

    def _flatten(self, image, seq: Node, defaults, files: set):
        """A reference sequence as a self-contained node: Defaults folded in, the temperate file resolved exactly as
        TilesetSpecificSpriteSequence does, EA filenames rewritten to the bundled copies."""
        where = f'{image}.{seq.key}'
        data = {c.key: c for c in seq.children}
        dflt = {c.key: c for c in defaults.children} if defaults is not None else {}

        def field(key):
            return data.get(key) or dflt.get(key)

        out = Node(seq.key, seq.value)
        for c in seq.children:
            if c.key not in SEQUENCE_FILE_FIELDS and c.key != 'Combine':
                out.children.append(c.clone())
        for key, c in dflt.items():
            if key not in data and key not in SEQUENCE_FILE_FIELDS and key != 'Combine':
                out.children.append(c.clone())
        if field('TilesetFilenamesPattern') is not None or field('FilenamePattern') is not None:
            raise GenerationError(f'{where}: filename patterns are not supported')
        filename = None
        tilesets = field('TilesetFilenames')
        if tilesets is not None and tilesets.val(TILESET):
            filename = tilesets.val(TILESET)
        elif field('Filename') is not None:
            filename = field('Filename').value
        combine = data.get('Combine')
        if combine is not None:
            parts = Node('Combine')
            for part in combine.children:
                sub = Node(part.key, part.value, [c.clone() for c in part.children if c.key not in SEQUENCE_FILE_FIELDS])
                pt = part.get('TilesetFilenames')
                pname = pt.val(TILESET) if pt is not None and pt.val(TILESET) else part.val('Filename')
                if not pname:
                    raise GenerationError(f'{where}: combined part {part.key} has no temperate file')
                rewritten, ea = self._file(pname, where)
                if ea:
                    files.add(ea)
                sub.children.insert(0, Node('Filename', rewritten))
                parts.children.append(sub)
            out.children.append(parts)
        elif filename:
            rewritten, ea = self._file(filename, where)
            if ea:
                files.add(ea)
            out.children.insert(0, Node('Filename', rewritten))
        else:
            raise GenerationError(f'{where}: no temperate file')
        depth = out.get('DepthSprite')
        if depth is not None and depth.value:
            rewritten, ea = self._file(depth.value, where)
            depth.value = rewritten
            if ea:
                files.add(ea)
        return out

    @staticmethod
    def _alias(name, seqs: dict, mindcontrol):
        """The sequence an original image uses for a name only its stand-in offered."""
        def have(n):
            return seqs.get(n)
        if name == 'mindcontrol' and mindcontrol is not None:
            return mindcontrol
        if have('stand') is not None:
            # Infantry poses the original lacks: the closest original pose.
            if name.startswith('prone-') and have(name[len('prone-'):]) is not None:
                return have(name[len('prone-'):])
            if name in ('liedown', 'standup'):
                return have('stand')
            if name in ('strike', 'shoot', 'prone-shoot'):
                return have('shoot') or have('stand')
            if re.fullmatch(r'die\d+', name):
                return have('die1') or have('stand')
        if name == 'build' and have('idle') is not None:
            return have('idle')
        # Anything else is a stand-in body or overlay the original countries never draw.
        return Node(name, None, [Node('Filename', BLANK)])

    # -- the plan

    def _stand_in_facings(self, ri, ci):
        """Record the facing count (ISpriteSequence.Facings: InterpolatedFacings, else |Facings|) of each stand-in
        sequence with more than one facing. WithSpriteTurret and WithSpriteBarrel quantize the actor's Turreted to
        their sequence's facings when they are constructed, even while the ea-art condition disables them, so an alias
        must report the same count (see generate)."""
        node = self.curseq[ci]
        defaults = node.get('Defaults')
        known = self.facings.setdefault(ri, {})
        for s in node.children:
            if s.key == 'Defaults':
                continue
            value = None
            for key in ('InterpolatedFacings', 'Facings'):
                value = s.val(key) or (defaults.val(key) if defaults is not None else None)
                if value:
                    break
            facings = abs(int(value)) if value else 1
            if facings <= 1:
                continue
            if known.get(s.key, facings) != facings:
                raise GenerationError(f'ea-{ri}.{s.key}: the stand-in images disagree on facings ({known[s.key]}, {facings})')
            known[s.key] = facings

    def plan(self):
        self.actors = {}       # actor -> facts
        self.images = {}       # reference image -> names the EA twin must provide
        self.facings = {}      # reference image -> {stand-in sequence name: facings} (more than one facing only)
        self.models = set()    # reference voxel images used
        for name in sorted(self.skirmish):
            if not self.skirmish[name] & set(COUNTRIES) or name not in self.cur or name not in self.ref:
                continue
            # Every original country gets the original art of an actor any of them fields: a country that only rarely
            # owns it (a captured or spawned actor keeps its builder's faction) still sees original art, and no
            # stand-in image stays attached to an original country, so stand-in sprite sheets are not downloaded for
            # original-country matches (PackGroups.cs groups a file by the factions whose images use it).
            countries = list(COUNTRIES)
            if not self._original_art(name):
                continue  # a modern-faction unit: its reference art is project art too
            cur, ref = self.cur[name], self.ref[name]
            facts = {'countries': countries, 'modern': sorted(self.owners[name] - set(COUNTRIES))}
            if cur.get('RenderSprites') is not None and ref.get('RenderSprites') is not None:
                images = {}
                for k in countries:
                    ri = render_image(ref, k)
                    if ri not in self.refseq:
                        raise GenerationError(f'{name}: reference image {ri} has no sequences')
                    images[k] = ri
                    self.images.setdefault(ri, set())
                    ci = render_image(cur, k)
                    if ci in self.curseq:
                        self.images[ri].update(c.key for c in self.curseq[ci].children if c.key != 'Defaults')
                        self._stand_in_facings(ri, ci)
                facts['images'] = images
            elif cur.get('RenderSprites') is not None or ref.get('RenderSprites') is not None:
                raise GenerationError(f'{name}: RenderSprites differs between the reference and the current game')
            if ref.get('RenderVoxels') is not None:
                if cur.get('RenderVoxels') is None:
                    raise GenerationError(f'{name}: the current game removed RenderVoxels')
                rv = voxel_image(ref)
                if rv not in self.refmodels:
                    raise GenerationError(f'{name}: reference voxel image {rv} has no model sequences')
                facts['voxel'] = rv
                self.models.add(rv)
            if 'images' in facts or 'voxel' in facts:
                self.actors[name] = facts
        # Original support powers use the reference cameo set, independently of actor build icons.
        self.images['icon'] = set()
        self.retail = ea_retail.Retail(self, __import__(__name__))
        return self

    def _original_art(self, name):
        ref = self.ref[name]
        if ref.get('RenderVoxels') is not None:
            return True
        image = self.refseq.get(render_image(ref, None) or '')
        if image is None:
            return False
        for s in image.children:
            for f in [s] + [p for c in s.children if c.key == 'Combine' for p in c.children]:
                fn = f.val('Filename')
                t = f.get('TilesetFilenames')
                for v in [fn] + ([c.value for c in t.children] if t is not None else []):
                    if v and not v.startswith('ra2|') and v.lower() not in self.bits:
                        return True
        return False

    def needed_files(self):
        """The original files the plan draws (sprites, voxels, palettes), without generating anything else."""
        self.generate(validate=False)
        return self.ea_files

    def generate(self, validate=True):
        files = set()
        seq_nodes = []
        mind = self.refseq.get('^mindcontrollable')
        mind_seq = None
        if mind is not None and mind.get('mindcontrol') is not None:
            mind_seq = self._flatten('^MindControllable', mind.get('mindcontrol'), mind.get('Defaults'), files)
        self.aliases = {}
        for ri in sorted(self.images):
            node = self.refseq[ri]
            defaults = node.get('Defaults')
            seqs = {}
            for s in node.children:
                if s.key != 'Defaults':
                    seqs[s.key] = self._flatten(ri, s, defaults, files)
            own = dict(seqs)
            for needed in sorted(self.images[ri]):
                if needed in seqs:
                    continue
                prefix = next((p for p in DAMAGE_PREFIXES if needed.startswith(p)), None)
                if prefix:
                    continue  # RenderSprites falls back to the undamaged sequence
                alias = self._alias(needed, own, mind_seq).clone()
                alias.key = needed
                facings = self.facings.get(ri, {}).get(needed, 1)
                if alias.val('Filename') == BLANK and facings > 1:
                    # The transparent frame keeps the stand-in's facing count: a disabled stand-in sprite turret still
                    # quantizes the shared Turreted to it, and one facing locked the original countries' voxel turret,
                    # muzzle flash and shell origin facing north (the Grizzly, 1 November 2026).
                    alias.children.append(Node('InterpolatedFacings', str(facings)))
                seqs[needed] = alias
                self.aliases.setdefault('ea-' + ri, []).append(needed)
            seq_nodes.append(Node('ea-' + ri, None, list(seqs.values())))
        model_nodes = []
        for rv in sorted(self.models):
            node = Node('ea-' + rv)
            for s in self.refmodels[rv].children:
                vxl = hva = rv
                if s.value:
                    parts = [p.strip() for p in s.value.split(',') if p.strip()]
                    vxl = hva = parts[0]
                    if len(parts) > 1:
                        hva = parts[1]
                for f in (vxl + '.vxl', hva + '.hva'):
                    if f.lower() in self.bits:
                        raise GenerationError(f'{rv}: voxel {f} is a project file')
                    files.add(f.lower())
                value = EA_PREFIX + vxl.lower() + ('' if hva == vxl else ', ' + EA_PREFIX + hva.lower())
                node.children.append(Node(s.key, value))
            model_nodes.append(node)
        files.update(EA_PALETTE_FILES.values())
        self.seq_nodes = seq_nodes
        self.model_nodes = model_nodes
        self.ea_files = sorted(files)
        bad = [f for f in self.ea_files if Path(f).suffix.lower() not in ALLOWED_EXTENSIONS]
        if bad:
            raise GenerationError(f'not art files: {bad}')
        availability = [Node('Player', None, [self.original_prerequisite.clone(),
            Node('FactionSupportPowerIcons', None, [Node('Factions', ', '.join(COUNTRIES)),
                Node('SourceImage', 'icon'), Node('Image', 'ea-icon'), Node('Palette', 'eacameo')])])]
        if self.plug_prerequisites is not None:
            availability.append(Node('gapurifier', None, [Node('Buildable', None, [Node('Prerequisites', self.plug_prerequisites)])]))
        self.rules_nodes = [self._palettes()] + availability + [self._actor(name) for name in sorted(self.actors)]
        self.retail.finish()
        # Only the project "explosion" image: original ea-explosion keeps its own pivots.
        self.seq_nodes.extend(effect_anchors.anchor_patches(self, __import__(__name__)))
        if validate:
            self._validate()
        return self

    def _palettes(self):
        return Node('^Palettes', None, [
            Node('PaletteFromFile@eaunit', None, [Node('Name', 'eaunit'), Node('Filename', EA_PREFIX + 'unittem.pal'), Node('ShadowIndex', '1')]),
            Node('PlayerColorPalette@eaplayer', None, [Node('BasePalette', 'eaunit'), Node('BaseName', 'eaplayer'),
                 Node('RemapIndex', ', '.join(str(i) for i in range(16, 32)))]),
            Node('PaletteFromFile@eaeffect', None, [Node('Name', 'eaeffect'), Node('Filename', EA_PREFIX + 'anim.pal')]),
            Node('PaletteFromPaletteWithAlpha@eaeffect50alpha', None, [Node('Name', 'eaeffect50alpha'), Node('BasePalette', 'eaeffect'), Node('Alpha', '0.5')]),
            Node('PaletteFromFile@eacameo', None, [Node('Name', 'eacameo'), Node('Filename', EA_PREFIX + 'cameo.pal'),
                 Node('AllowModifiers', 'false'), Node('ShadowIndex', '242')]),
            Node('PaletteFromPlayerPaletteWithAlpha@eacloak', None, [Node('BaseName', 'eacloak'), Node('BasePalette', 'eaplayer'), Node('Alpha', '0.50')]),
        ])

    @staticmethod
    def _ea_palette(name, where):
        if name in NEUTRAL_PALETTES:
            return name
        if name not in EA_PALETTES:
            raise GenerationError(f'{where}: no original-art palette for reference palette {name}')
        return EA_PALETTES[name]

    def _resolve_file(self, filename):
        if '|' in filename:
            package, _, rel = filename.partition('|')
            if package != 'ra2':
                return None
            p = self.mod_root / 'mods/rtsai' / rel
            return p if p.is_file() else None
        for d in self.packages:
            p = d / filename
            if p.is_file():
                return p
        return None

    def _icon_file(self, image, icon):
        seq = self.curseq.get(image)
        s = seq.get(icon) if seq is not None else None
        if s is None:
            return None, None
        d = seq.get('Defaults')
        fn = s.val('Filename') or (d.val('Filename') if d is not None else None)
        return fn, (self._resolve_file(fn) if fn else None)

    def _actor(self, name):
        facts = self.actors[name]
        cur, ref = self.cur[name], self.ref[name]
        countries = facts['countries']
        out = Node(cur.key)  # the rules' own spelling (actor names are case-insensitive, e.g. FLAMEGUY)
        uses_condition = False
        player = {}     # current player palette base -> EA base
        plain = {}      # current palette -> EA palette

        def add(key, children):
            n = out.get(key)
            if n is None:
                n = Node(key)
                out.children.append(n)
            n.children.extend(children)
            return n

        def condition(t, expression):
            nonlocal uses_condition
            if trait_type(t) not in CONDITIONAL:
                raise GenerationError(f'{name}.{t}: not a conditional trait')
            add(t, [Node('RequiresCondition', expression)])
            uses_condition = True

        if name in self.production:
            add('Buildable', [c.clone() for c in self.production[name].children])
        if name in RESTORED_FOUNDATIONS:
            # Foundations are actor rules, not sprites. Restore collision, placement, rally and exits together.
            # These shared isometric actors keep one authoritative footprint for all owners.
            geometry = {'Building', 'HitShape', 'IsometricSelectable', 'RallyPoint', 'Exit'}
            for t in cur.children:
                if trait_type(t.key) in geometry and ref.get(t.key) is None:
                    out.children.append(Node('-' + t.key))
            for t in ref.children:
                if trait_type(t.key) in geometry:
                    add(t.key, [c.clone() for c in t.children])

        if 'images' in facts:
            images = facts['images']
            add('RenderSprites', [Node('FactionImages', None, [Node(k, 'ea-' + images[k]) for k in countries])])
            rs_cur, rs_ref = cur.get('RenderSprites'), ref.get('RenderSprites')
            if bool(rs_cur.val('Palette')) != bool(rs_ref.val('Palette')):
                raise GenerationError(f'{name}: the stand-in and the reference disagree on a fixed RenderSprites palette')
            if rs_cur.val('Palette') == rs_ref.val('Palette') == 'terrain':
                # The mirage tank: its sprite image only disguises it as (project) scenery, drawn with the terrain.
                pass
            elif rs_cur.val('Palette'):
                plain[rs_cur.val('Palette')] = self._ea_palette(rs_ref.val('Palette'), name)
            else:
                player[rs_cur.val('PlayerPalette', 'player')] = self._ea_palette(rs_ref.val('PlayerPalette', 'player'), name)
            # Palettes of the traits that draw the actor's own image and stay enabled for the original countries.
            for t in cur.children:
                tt = trait_type(t.key)
                if tt == 'Armament' and t.val('MuzzleSequence') and cur.get('WithMuzzleOverlay') is not None:
                    r = ref.get(t.key)
                    reference = r.val('MuzzlePalette', 'effect') if r is not None else 'effect'
                    plain[t.val('MuzzlePalette', 'effect')] = self._ea_palette(reference, f'{name}.{t.key}')
                    continue
                spec = ACTOR_IMAGE_TRAITS.get(tt)
                if not spec or t.val('Image') or ref.get(t.key) is None:
                    continue
                pal_field, player_field = spec
                current = t.val(pal_field, PALETTE_DEFAULTS.get(tt))
                if current is None:
                    continue
                reference = ref.get(t.key).val(pal_field, PALETTE_DEFAULTS.get(tt))
                is_player = bool(player_field) and (t.val(player_field) or 'false').lower() == 'true'
                if reference is None:
                    raise GenerationError(f'{name}.{t.key}: the stand-in sets a palette the reference does not')
                (player if is_player else plain)[current] = self._ea_palette(reference, f'{name}.{t.key}')
            cloak = cur.get('Cloak')
            if cloak is not None and cloak.val('CloakedPalette'):
                is_player = (cloak.val('IsPlayerPalette') or 'false').lower() == 'true'
                rc = ref.get('Cloak')
                reference = rc.val('CloakedPalette') if rc is not None else None
                if reference is None:
                    raise GenerationError(f'{name}.Cloak: no reference cloak palette')
                (player if is_player else plain)[cloak.val('CloakedPalette')] = self._ea_palette(reference, f'{name}.Cloak')
            # Traits drawing another image through Actor.Render keep their palettes: they must not be swapped.
            for t in cur.children:
                tt = trait_type(t.key)
                if tt not in OTHER_IMAGE_TRAITS or (tt == 'WithIdleOverlay' and not t.val('Image')):
                    continue
                if (t.val('RequiresCondition') or '').strip() == 'false':
                    continue
                field_, default, is_player = OTHER_IMAGE_TRAITS[tt]
                pal = t.val(field_, default)
                flag = (t.val('IsPlayerPalette') or str(is_player)).lower() == 'true'
                if pal and ((flag and pal in player) or (not flag and pal in plain)):
                    raise GenerationError(f'{name}.{t.key}: draws project image {t.val("Image")} with palette {pal}, which the original art swaps')
            # Cameos: the original cameo palette. Every other owner's cameo must be a palette-free RGB(A) PNG.
            bi = cur.get('Buildable')
            if bi is not None:
                icon = bi.val('Icon', 'icon')
                other_owners = sorted(self.owners[name] - set(countries))
                for f in other_owners + ([] if name in RESTORED_PRODUCTION + ea_retail.NEW_ACTORS else [None]):
                    img = render_image(cur, f)
                    fn, path = self._icon_file(img, icon)
                    if fn is None:
                        continue
                    if path is None or path.suffix.lower() != '.png' or png_color_type(path) not in (2, 6):
                        raise GenerationError(f'{name}: cameo {img}.{icon} ({fn}) is not a palette-free PNG; its icon palette cannot change')
                if all(icon in {c.key for c in self.refseq[images[k]].children} for k in countries):
                    if bi.val('IconPaletteIsPlayerPalette'):
                        raise GenerationError(f'{name}: player-coloured cameo palettes are not supported')
                    add('Buildable', [Node('IconPalette', 'eacameo')])
            # Render traits the reference does not have (stand-in bodies, kit overlays): never drawn for the originals.
            for t in cur.children:
                tt = trait_type(t.key)
                if tt in ACTOR_IMAGE_TRAITS and ref.get(t.key) is None and not t.val('Image'):
                    condition(t.key, both('!' + CONDITION, t.val('RequiresCondition')))
            # Reference overlays the standalone kit removed: restored for the originals with their own image.
            unique = {images[k] for k in countries}
            for t in ref.children:
                if trait_type(t.key) != 'WithIdleOverlay' or cur.get(t.key) is not None or t.val('Image') or len(unique) != 1:
                    continue
                restored = [c.clone() for c in t.children if c.key != 'RequiresCondition']
                restored.append(Node('Image', 'ea-' + next(iter(unique))))
                if t.val('Palette'):
                    if (t.val('IsPlayerPalette') or 'false').lower() == 'true':
                        raise GenerationError(f'{name}.{t.key}: restored player palette overlays are not supported')
                    restored = [c for c in restored if c.key != 'Palette'] + [Node('Palette', self._ea_palette(t.val('Palette'), name))]
                else:
                    restored += [Node('Palette', self._ea_palette(rs_ref.val('PlayerPalette', 'player'), name)), Node('IsPlayerPalette', 'true')]
                restored.append(Node('RequiresCondition', both(CONDITION, t.val('RequiresCondition'))))
                add(t.key, restored)
                uses_condition = True
            # Death animations are separate effects (never drawn through the actor): an original-art twin.
            for t in list(cur.children):
                if trait_type(t.key) != 'WithDeathAnimation':
                    continue
                r = ref.get(t.key)
                src = r if r is not None else t
                twin = [c.clone() for c in t.children if c.key not in (
                    'RequiresCondition', 'DeathSequencePalette', 'DeathPaletteIsPlayerPalette', 'CrushedSequencePalette', 'CrushedPaletteIsPlayerPalette')]
                twin += [Node('DeathSequencePalette', self._ea_palette(src.val('DeathSequencePalette', 'player'), f'{name}.{t.key}')),
                         Node('DeathPaletteIsPlayerPalette', src.val('DeathPaletteIsPlayerPalette', 'true')),
                         Node('CrushedSequencePalette', self._ea_palette(src.val('CrushedSequencePalette', 'effect'), f'{name}.{t.key}')),
                         Node('CrushedPaletteIsPlayerPalette', src.val('CrushedPaletteIsPlayerPalette', 'false')),
                         Node('RequiresCondition', both(CONDITION, t.val('RequiresCondition')))]
                add('WithDeathAnimation@ea-' + (t.key.split('@')[1] if '@' in t.key else 'default'), twin)
                condition(t.key, both('!' + CONDITION, t.val('RequiresCondition')))
            # Which factions field the actor (skirmish reachability and mission placements): the browser groups sprite
            # sheets by the factions whose images use them (PackGroups.cs), so a match fetches its own side's art only.
            owners = [f for f in COUNTRIES + MODERN if f in self.owners.get(name, set())]
            add('SpriteGroupFactions@ea', [Node('Factions', ', '.join(owners))])
            ints = [Node('Factions', ', '.join(countries))]
            if player:
                ints.append(Node('PlayerPalettes', None, [Node(k, v) for k, v in sorted(player.items())]))
            if plain:
                ints.append(Node('Palettes', None, [Node(k, v) for k, v in sorted(plain.items())]))
            add('WithFactionPalettes@ea', ints)
        if 'voxel' in facts:
            rv_ref = ref.get('RenderVoxels')
            vox = [Node('Image', 'ea-' + facts['voxel']),
                   Node('PlayerPalette', self._ea_palette(rv_ref.val('PlayerPalette', 'player'), name))]
            if rv_ref.val('Palette'):
                vox.append(Node('Palette', self._ea_palette(rv_ref.val('Palette'), name)))
            add('RenderVoxels', vox)
            sprite = 'images' in facts
            if not sprite and facts['modern']:
                raise GenerationError(f'{name}: voxel-only actor also owned by {facts["modern"]}')
            model = {c.key for c in self.refmodels[facts['voxel']].children}
            for t in cur.children:
                if trait_type(t.key) in VOXEL_TRAITS and sprite and ref.get(t.key) is None and (t.val('RequiresCondition') or '') != 'false':
                    raise GenerationError(f'{name}.{t.key}: a current voxel trait would draw the original voxels for every owner')
            for t in ref.children:
                tt = trait_type(t.key)
                if tt not in VOXEL_TRAITS:
                    continue
                seqname = t.val('Sequence', t.val('IdleSequence', VOXEL_DEFAULT_SEQUENCE[tt]))
                if seqname not in model:
                    raise GenerationError(f'{name}.{t.key}: voxel sequence {seqname} missing from {facts["voxel"]}')
                c = cur.get(t.key)
                if not sprite:
                    if c is None:
                        raise GenerationError(f'{name}.{t.key}: removed from a voxel-only actor')
                    continue
                if tt == 'WithVoxelUnloadBody':
                    unload = t.val('UnloadSequence', 'unload')
                    if unload not in model:
                        raise GenerationError(f'{name}: missing original unloading model sequence {unload}')
                    # Same immediate dock callbacks as the reference; only the model visibility is conditional.
                    add('WithOriginalVoxelUnloadBody@ea-unload',
                        [x.clone() for x in t.children if x.key != 'RequiresCondition'] +
                        [Node('RequiresCondition', both(CONDITION, t.val('RequiresCondition')))])
                    uses_condition = True
                elif c is None:
                    add(t.key, [x.clone() for x in t.children if x.key != 'RequiresCondition'] +
                        [Node('RequiresCondition', both(CONDITION, t.val('RequiresCondition')))])
                    uses_condition = True
                else:
                    if (c.val('RequiresCondition') or '') != 'false':
                        raise GenerationError(f'{name}.{t.key}: the stand-in did not disable this voxel trait')
                    condition(t.key, both(CONDITION, t.val('RequiresCondition')))
        if uses_condition:
            out.children.insert(0, Node('GrantConditionOnFaction@ea-art', None, [Node('Condition', CONDITION), Node('Factions', ', '.join(countries))]))
        return out

    def _validate(self):
        seqs = {n.key: {c.key: c for c in n.children} for n in self.seq_nodes}
        for name, facts in self.actors.items():
            for k, ri in facts.get('images', {}).items():
                if 'ea-' + ri not in seqs:
                    raise GenerationError(f'{name}: EA image ea-{ri} not generated')
                # Every name the stand-in image of that country offered resolves in the original image.
                ci = render_image(self.cur[name], k)
                for s in (c.key for c in self.curseq.get(ci, Node(ci)).children if c.key != 'Defaults'):
                    if s not in seqs['ea-' + ri] and not s.startswith(DAMAGE_PREFIXES):
                        raise GenerationError(f'{name}: sequence {s} does not resolve in ea-{ri}')
        palettes = EA_PALETTE_NAMES | NEUTRAL_PALETTES
        for node in self.rules_nodes[1:]:
            for t in node.children:
                if trait_type(t.key) == 'WithFactionPalettes':
                    for group in ('PlayerPalettes', 'Palettes'):
                        for p in (t.get(group).children if t.get(group) is not None else []):
                            if p.value not in palettes:
                                raise GenerationError(f'{node.key}: palette {p.value} does not resolve')
                for f in ('DeathSequencePalette', 'CrushedSequencePalette', 'PlayerPalette', 'IconPalette', 'Palette'):
                    v = t.val(f)
                    if v and t.key.startswith(('WithDeathAnimation@ea-', 'RenderVoxels', 'Buildable', 'WithIdleOverlay')) and v not in palettes:
                        raise GenerationError(f'{node.key}.{t.key}: palette {v} does not resolve')
        # Every file an original image draws is original art, the shared blank, or a project file the classic add-on
        # itself draws in that image (bits overrides), with the same palettes.
        for n in self.seq_nodes:
            for s in n.children:
                names = [c for c in s.children if c.key == 'Filename']
                names += [p.get('Filename') for c in s.children if c.key == 'Combine' for p in c.children]
                for f in names:
                    v = f.value
                    if v.startswith(EA_PREFIX) or v == BLANK or v.lower() in self.bits:
                        continue
                    # A project RGBA sheet (ra2|...png) carries its own colours: no palette applies to it, so an
                    # original image may draw it (the ships' wake, standalone/effects/wake1.png, since 26 Oct).
                    if v.startswith('ra2|') and v.lower().endswith('.png'):
                        continue
                    raise GenerationError(f'{n.key}.{s.key}: project file {v} would be drawn with original palettes')
        audit = self.audit()
        failures = {f: a for f, a in audit['countries'].items() if a['missing'] or a['replacements'] or a['extensions']}
        if failures:
            raise GenerationError('Original-country roster is incomplete: ' + json.dumps(failures))

    def audit(self):
        """Compare complete reachable rosters, not a minimum number of original-looking actors."""
        countries = {}
        for faction in COUNTRIES:
            expected = set(reachable(self.ref, faction))
            actual = set(reachable(self.cur, faction))
            original = sorted(n for n in actual if n in self.ref and self._original_art(n))
            countries[faction] = {'actors': sorted(actual), 'originalArtActors': original,
                                  'missing': sorted(expected - actual), 'extensions': sorted(actual - expected),
                                  'replacements': sorted(set(original) - self.actors.keys())}
        effective = {k.lower(): v for k, v in merge([list(self.cur.values()), self.rules_nodes]).items()}
        foundations = {}
        for name in RESTORED_FOUNDATIONS:
            building = self.ref[name].get('Building')
            actual = effective[name].get('Building')
            for field in ('Dimensions', 'Footprint'):
                if actual.val(field) != building.val(field):
                    raise GenerationError(f'{name}: generated {field} does not match the original foundation')
            for kind in ('HitShape', 'Exit', 'RallyPoint'):
                expected_traits = {k: dump([v]) for k, v in traits(self.ref[name], kind)}
                actual_traits = {k: dump([v]) for k, v in traits(effective[name], kind)}
                if expected_traits != actual_traits:
                    raise GenerationError(f'{name}: generated {kind} does not match the original foundation')
            foundations[name] = {'dimensions': building.val('Dimensions'), 'footprint': building.val('Footprint'),
                                 'generatedDimensions': actual.val('Dimensions'), 'generatedFootprint': actual.val('Footprint'),
                                 'exits': {k: v.val('ExitCell') for k, v in traits(self.ref[name], 'Exit')}}
        return {'schema': 1, 'countries': countries, 'foundations': foundations,
                'scope': 'Reachable original RA2 country rosters, original images/models, reference isometric foundations. '
                         'Project art and original-country art share the same actor foundation in this isometric bundle.'}

    def write(self, out: Path):
        out.mkdir(parents=True, exist_ok=True)
        self.retail.write(out)
        header = ('# GENERATED by RTSAI-WebGame tools/prepare-content.py (tools/ea_originals.py). Original Command & Conquer\n'
                  '# art under EA\'s free, non-commercial modding guidelines. EA has not endorsed and does not support this product.\n\n')
        (out / 'ea-art.yaml').write_text(header + '\n'.join(dump([n]) for n in self.rules_nodes), encoding='utf-8', newline='\n')
        (out / 'ea-sequences.yaml').write_text(header + '\n'.join(dump([n]) for n in self.seq_nodes), encoding='utf-8', newline='\n')
        (out / 'ea-models.yaml').write_text(header + '\n'.join(dump([n]) for n in self.model_nodes), encoding='utf-8', newline='\n')
        (out / BLANK_FILE).write_bytes(blank_png())
        summary = {'schema': 2, 'countries': list(COUNTRIES), 'excluded': [], 'files': self.ea_files,
                   'restoredFoundations': list(RESTORED_FOUNDATIONS), 'restoredProduction': list(RESTORED_PRODUCTION),
                   'actors': {k: {'countries': v['countries'], 'images': sorted({'ea-' + i for i in v.get('images', {}).values()}),
                                  'voxel': ('ea-' + v['voxel']) if v.get('voxel') else None} for k, v in sorted(self.actors.items())},
                   'aliases': {k: sorted(v) for k, v in sorted(self.aliases.items())}}
        (out / 'ea-files.json').write_text(json.dumps(summary, indent=1) + '\n', encoding='utf-8', newline='\n')
        (out / 'original-country-audit.json').write_text(json.dumps(self.audit(), indent=1) + '\n', encoding='utf-8', newline='\n')
        return summary
