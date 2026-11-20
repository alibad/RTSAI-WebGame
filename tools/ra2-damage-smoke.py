#!/usr/bin/env python3
"""Red Alert 2's damage smoke, as facts: which original vehicles and ships give off smoke (and sparks) once damaged,
from the player's own rules.ini (base game, not Yuri's Revenge), extracted with the mod engine:

  OpenRA.Utility rtsai-classic --extract rules.ini      (ENGINE_DIR=<OpenRA>, cwd outside every repo)
  python tools/ra2-damage-smoke.py --rules rules.ini [--out tools/data/ra2-damage-smoke.json]

In RA2 a vehicle or ship with DamageParticleSystems= starts those particle systems when its health falls to
[AudioVisual] ConditionYellow= (50%): SmallGreySSys puffs small grey smoke (SGRYSMK1, half translucent) and SparkSys
throws sparks. Submarines, the Dolphin and the Squid have none: they fight underwater. Names and numbers only.
"""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LISTS = {'VehicleTypes': 'vehicle', 'AircraftTypes': 'aircraft', 'BuildingTypes': 'building'}


def ini(path: Path):
    """{section: {key: value}} with comments removed; a repeated key or section keeps its last value, as the game does."""
    sections, current = {}, None
    for raw in path.read_text(encoding='latin-1').splitlines():
        line = raw.split(';', 1)[0].strip()
        if not line:
            continue
        if line.startswith('[') and ']' in line:
            current = sections.setdefault(line[1:line.index(']')].strip(), {})
        elif current is not None and '=' in line:
            key, value = line.split('=', 1)
            current[key.strip()] = value.strip()
    return sections


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--rules', type=Path, required=True)
    ap.add_argument('--out', type=Path, default=ROOT / 'tools/data/ra2-damage-smoke.json')
    args = ap.parse_args()
    rules = ini(args.rules)
    actors, systems = {}, {}
    for list_name, kind in LISTS.items():
        for _, actor in rules.get(list_name, {}).items():
            section = rules.get(actor)
            if section is None or not section.get('DamageParticleSystems'):
                continue
            particles = [x.strip() for x in section['DamageParticleSystems'].split(',') if x.strip()]
            actors[actor.lower()] = {'kind': kind, 'naval': section.get('Naval', '').lower() == 'yes', 'damageParticleSystems': particles,
                                     **({'damageSmokeOffset': section['DamageSmokeOffset']} if section.get('DamageSmokeOffset') else {})}
            for s in particles:
                system = rules.get(s, {})
                particle = rules.get(system.get('HoldsWhat', ''), {})
                systems[s] = {'holds': system.get('HoldsWhat', ''), 'spawnFrames': system.get('SpawnFrames', ''),
                              'behavesLike': system.get('BehavesLike', ''), 'image': particle.get('Image', ''),
                              'translucency': particle.get('Translucency', '')}
    audio = rules.get('AudioVisual', {})
    body = {'schema': 1,
            'source': 'Original retail RA2 rules.ini extracted with OpenRA.Utility from installed ra2.mix/language.mix; base game, '
                      'not Yuri expansion. Names and numbers only. Written by tools/ra2-damage-smoke.py.',
            'sourceSha256': {args.rules.name: hashlib.sha256(args.rules.read_bytes()).hexdigest()},
            'conditionYellow': audio.get('ConditionYellow', ''), 'conditionRed': audio.get('ConditionRed', ''),
            'particleSystems': dict(sorted(systems.items())), 'actors': dict(sorted(actors.items()))}
    args.out.write_text(json.dumps(body, indent=1) + '\n', encoding='utf-8', newline='\n')
    print(f'{len(actors)} actors with damage particles, systems {", ".join(sorted(systems))} -> {args.out}')


if __name__ == '__main__':
    main()
