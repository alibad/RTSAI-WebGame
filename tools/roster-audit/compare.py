#!/usr/bin/env python3
"""Compare what two builds ship, faction by faction (websim rosteraudit exports of a web bundle and a desktop build).

    python tools/roster-audit/compare.py <web-export.json> <desktop-export.json> [--out differences.json]
        [--accepted tools/roster-audit/accepted-differences.json --key ra2]

For every faction both builds offer, and every unit in either build's roster for it, this compares what an owner of
that faction actually gets at rest: the name it sees, cost, health, armour, speed, sight, prerequisites, production
queue and the weapons it fires (with each weapon's range, reload, burst, damage, damage versus armour and targets).
Weapons a faction never switches on (e.g. the original countries' retail copies on a modern-only unit) are not
differences. Units in one build's roster only are listed too. Exit code 1 when anything differs; with --accepted, only
when a difference is not on the accepted list under --key (one accepted but now gone is reported, not a failure).
"""
import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

ORIGINAL = {"america", "germany", "england", "france", "korea", "cuba", "libya", "iraq", "russia"}
PLAIN = ["cost", "hp", "armor", "speed", "sight", "queue", "prerequisites"]


def load(path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return data, {a["id"]: a for a in data["actors"]}


def seen_by(actor, faction):
    """What an owner of `faction` gets from this actor at rest."""
    facts = {f: actor.get(f) for f in PLAIN}
    facts["name"] = (actor.get("factionNames") or {}).get(faction, actor.get("name"))
    active = (actor.get("factionArmaments") or {}).get(faction, actor.get("armaments") or [])
    weapons = {(w["armament"], w.get("weapon")): {k: v for k, v in w.items() if k != "armament"} for w in actor.get("weapons") or []}
    facts["weapons"] = sorted((json.dumps(weapons.get(tuple(a.split(":", 1)), {"weapon": a}), sort_keys=True) for a in active))
    return facts


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("web")
    parser.add_argument("desktop")
    parser.add_argument("--out")
    parser.add_argument("--accepted", help="JSON of differences accepted as they are, by key (ra2, classic)")
    parser.add_argument("--key", help="which accepted list applies to this pair")
    args = parser.parse_args()
    web, web_actors = load(args.web)
    desk, desk_actors = load(args.desktop)
    factions = [f["id"] for f in web["factions"] if f["id"] in {g["id"] for g in desk["factions"]}]

    # actor -> {difference signature -> {"factions": [...], "fields": {...}}}
    found = defaultdict(dict)
    for faction in factions:
        web_roster, desk_roster = set(web["rosters"].get(faction, [])), set(desk["rosters"].get(faction, []))
        for actor in sorted(web_roster | desk_roster):
            if actor not in desk_roster or actor not in web_roster:
                where = "web" if actor in web_roster else "desktop"
                src = (web_actors if where == "web" else desk_actors).get(actor, {})
                key = "only:" + where
                entry = found[actor].setdefault(key, {"factions": [], "only": where, "name": src.get("name")})
                entry["factions"].append(faction)
                continue
            w, d = seen_by(web_actors[actor], faction), seen_by(desk_actors[actor], faction)
            fields = {f: {"web": w[f], "desktop": d[f]} for f in w if w[f] != d[f]}
            if not fields:
                continue
            key = json.dumps(fields, sort_keys=True)
            entry = found[actor].setdefault(key, {"factions": [], "fields": fields, "name": w["name"]})
            entry["factions"].append(faction)

    differences = []
    for actor, entries in sorted(found.items()):
        for entry in entries.values():
            kind = {"original" if f in ORIGINAL else "modern" for f in entry["factions"]}
            entry["who"] = "original countries" if kind == {"original"} else "modern factions" if kind == {"modern"} else "both"
            differences.append({"id": actor, **entry})
    for d in differences:
        if "fields" in d:
            for w in ("web", "desktop"):
                d["fields"].get("weapons", {})[w] = [json.loads(x) for x in d["fields"].get("weapons", {}).get(w, [])] if "weapons" in d["fields"] else None
            if d["fields"].get("weapons") == {"web": None, "desktop": None}:
                d["fields"].pop("weapons")

    summary = {
        "web": web.get("target"), "desktop": desk.get("target"), "factionsCompared": factions,
        "unitsDiffering": len({d["id"] for d in differences}),
        "byWho": dict(Counter(d["who"] for d in differences)),
        "byField": dict(Counter(f for d in differences for f in d.get("fields", {}))),
        "onlyInOneRoster": dict(Counter(d["only"] for d in differences if "only" in d)),
    }
    failing = differences
    if args.accepted:
        known = {signature(d) for d in json.loads(Path(args.accepted).read_text(encoding="utf-8")).get(args.key, [])}
        current = {signature(d) for d in differences}
        failing = [d for d in differences if signature(d) not in known]
        summary["accepted"] = len(differences) - len(failing)
        summary["new"] = [f"{d['id']} for {', '.join(d['factions'])}: {', '.join(d.get('fields', {})) or 'only in the ' + d['only'] + ' roster'}"
                          for d in failing]
        summary["resolved"] = len(known - current)
    if args.out:
        Path(args.out).write_text(json.dumps({"summary": summary, "differences": differences}, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=1, ensure_ascii=False))
    return 1 if failing else 0


def signature(d):
    """A difference's identity: the unit, who sees it and exactly what differs (a changed value is a new difference)."""
    return json.dumps({"id": d["id"], "factions": sorted(d["factions"]), "only": d.get("only"), "fields": d.get("fields")}, sort_keys=True)


if __name__ == "__main__":
    sys.exit(main())
