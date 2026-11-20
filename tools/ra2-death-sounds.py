#!/usr/bin/env python3
"""Red Alert 2's own death sounds, as facts: which sound events each original vehicle, aircraft and building plays
when it dies, and which clips those events name. Written from the player's own rules.ini, art.ini and sound.ini
(base game, not Yuri's Revenge), extracted with the mod engine:

  OpenRA.Utility rtsai-classic --extract rules.ini art.ini sound.ini      (ENGINE_DIR=<OpenRA>, cwd outside every repo)
  python tools/ra2-death-sounds.py --rules rules.ini --art art.ini --sound sound.ini [--out tools/data/ra2-death-sounds.json]

What RA2 plays when one of them dies:
  * one of its Explosion= animations, each with its own sound (art.ini Report=);
  * its DieSound= (every vehicle GenVehicleDie; the submarine and Sea Scorpion GenSmallWaterDie; power plants
    PowerPlantDie; aircraft and the other ships none);
  * for a building, also [AudioVisual] BuildingDieSound= (BuildingGenericDie: the crumble).
Infantry are left out: their death cry is a voice phrase (tools/ea_voices.py). Only names and clip lists are recorded,
never audio; tools/ea_voices.py turns them into the original countries' death sounds.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLIP = re.compile(r'[a-z0-9][a-z0-9_-]{0,11}')
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


def names(value):
    return [x.strip() for x in (value or '').split(',') if x.strip()]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--rules', type=Path, required=True)
    ap.add_argument('--art', type=Path, required=True)
    ap.add_argument('--sound', type=Path, required=True)
    ap.add_argument('--out', type=Path, default=ROOT / 'tools/data/ra2-death-sounds.json')
    args = ap.parse_args()
    rules, art, sound = ini(args.rules), ini(args.art), ini(args.sound)
    art_lower = {k.lower(): v for k, v in art.items()}
    sound_lower = {k.lower(): (k, v) for k, v in sound.items()}
    building_die = rules.get('AudioVisual', {}).get('BuildingDieSound', '')
    actors, animations, events = {}, {}, set()
    for list_name, kind in LISTS.items():
        for _, actor in sorted(rules.get(list_name, {}).items(), key=lambda kv: int(kv[0]) if kv[0].isdigit() else 0):
            section = rules.get(actor)
            if section is None:
                continue
            explosions = names(section.get('Explosion'))
            die = section.get('DieSound', '')
            die = '' if die.lower() in ('', 'dummy', 'none') else die
            entry = {'kind': kind, 'explosions': explosions, 'dieSound': die}
            actors[actor.lower()] = entry
            for anim in explosions:
                report = art_lower.get(anim.lower(), {}).get('Report', '')
                animations[anim] = report
                if report:
                    events.add(report)
            if die:
                events.add(die)
    if building_die:
        events.add(building_die)
    sounds = {}
    for event in sorted(events, key=str.lower):
        found = sound_lower.get(event.lower())
        if found is None:
            sounds[event] = {'clips': [], 'note': 'not in sound.ini'}
            continue
        key, entry = found
        tokens = [t.lower() for t in entry.get('Sounds', '').split()]
        sounds[event] = {'clips': [t + '.wav' for t in tokens if CLIP.fullmatch(t)],
                         **({'skipped': [t for t in tokens if not CLIP.fullmatch(t)]} if any(not CLIP.fullmatch(t) for t in tokens) else {})}
    digest = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (args.rules, args.art, args.sound)}
    body = {'schema': 1,
            'source': 'Original retail RA2 rules.ini, art.ini and sound.ini extracted with OpenRA.Utility from installed '
                      'ra2.mix/language.mix; base game, not Yuri expansion. Names only, no audio. Written by tools/ra2-death-sounds.py.',
            'sourceSha256': digest, 'buildingDieSound': building_die,
            'actors': dict(sorted(actors.items())), 'animations': dict(sorted(animations.items())), 'sounds': sounds}
    args.out.write_text(json.dumps(body, indent=1) + '\n', encoding='utf-8', newline='\n')
    print(f'{len(actors)} actors, {len(animations)} explosion animations, {len(sounds)} sound events -> {args.out}')


if __name__ == '__main__':
    main()
