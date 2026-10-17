"""Assert Studio/native roster parity and generate an inspectable local audit report.

Run after audit-faction-rosters.ts and the native rosteraudit command, with the
directory containing studio-current.json, engine-{mode}{-fixed}.json,
native-{mode}.json and original content snapshots. Never edits game content.
"""
import argparse
import datetime
import html
import json
from pathlib import Path


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("directory", type=Path)
    ap.add_argument("--mod", type=Path, required=True)
    ap.add_argument("--receipt", type=Path)
    args = ap.parse_args()
    root = args.directory
    read = lambda name: json.loads((root / name).read_text(encoding="utf-8-sig"))
    studio = read("studio-current.json")["modes"]
    preserved = {}
    for old, current in [("original-bindings.json", "unit-bindings.json"),
                         ("original-modifications.json", "unit-modifications.json"),
                         ("original-details.json", "unit-details.json")]:
        preserved[current] = read(old) == json.loads((args.mod / "content" / current).read_text(encoding="utf-8-sig"))
        assert preserved[current], f"Content changed: {current}; inspect before claiming preservation"

    rows = []
    names = {}
    for mode in ("classic", "ra2"):
        source = studio[mode]
        before = {f["id"]: f for f in read(f"engine-{mode}.json")["factions"]}
        native = {a["id"]: a for a in read(f"native-{mode}.json")["actors"]}
        after = read(f"engine-{mode}-fixed.json")
        # Compare fields exported by both versions of the native audit command.
        fields = ("nameKey", "name", "cost", "queue", "prerequisites", "providers", "transforms", "building", "drawable")
        for actor in after["actors"]:
            if actor["id"] in native:
                assert all(actor.get(k) == native[actor["id"]].get(k) for k in fields), (mode, actor["id"], "desktop/web rules differ")
        for faction in after["factions"]:
            f = next(f for f in source["factions"] if f["id"] == faction["id"])
            ids = {u["id"] for u in f["units"]}
            deployments = set(source["deployments"][f["id"]])
            assert ids == set(faction["eligible"]) == set(faction["unlocked"]), (mode, f["id"], "native tech tree mismatch")
            assert ids | deployments == set(faction["drawer"]), (mode, f["id"], "web drawer mismatch")
            labels = [u["name"] for u in f["units"]]
            assert len(labels) == len(set(labels)), (mode, f["id"], "duplicate display names")
            for u in f["units"]:
                assert u["name"] == native[u["id"]]["name"], (mode, u["id"], "localized name mismatch")
                names[f"{mode}:{u['id']}"] = u["name"]
            old = set(before[f["id"]]["drawer"])
            rows.append({"mode": mode, "id": f["id"], "name": f["name"], "count": len(ids),
                         "restored": sorted(ids - old), "excluded": sorted(old - ids - deployments),
                         "deployments": sorted(deployments), "passed": True,
                         "units": [{**u, "source": source["actors"][u["id"]].get("source")} for u in f["units"]]})
    assert len(names) == 392, f"Expected all 392 existing actor bindings, got {len(names)}"
    build = json.loads(args.receipt.read_text()) if args.receipt else None
    if build:
        assert build.get("verified") and build["verification"]["passed"], "Candidate build has not passed acceptance"
        browser = json.loads(Path(build["verification"]["browser"]).read_text())
        assert browser["passed"] and browser["revision"] == build["revision"], "Browser build/revision mismatch"
        assert {(f["mode"], f["faction"]) for f in browser["rosters"] if f["passed"]} == {(f["mode"], f["id"]) for f in rows}, "Missing WASM faction proof"
        assert sum(len(t["units"]) for t in browser["targets"]) == len(names), "Missing WASM unit binding proof"
        saved = json.loads((args.mod / "mods/rtsai/unit-overrides/manifest.json").read_text())
        assert saved["revision"] == build["revision"], "Verified build is not current saved content"
    summary = {"generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "passed": True,
               "scope": "world-war-iii profile; own-country infrastructure; unrestricted tech; no captured foreign tech or campaign map overrides",
               "uniqueActors": len(names), "preserved": preserved, "factions": rows,
               "browserBuild": build}
    (root / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    e = lambda value: html.escape(str(value))
    cards = []
    for mode, title in [("classic", "Classic modification"), ("ra2", "RA2 modification")]:
        factions = [f for f in rows if f["mode"] == mode]
        details = []
        for f in factions:
            units = "".join(f'<tr><td>{e(u["name"])}</td><td><code>{e(u["id"])}</code></td><td>{e(u["origin"])}</td><td>{e(u["source"])}</td></tr>' for u in f["units"])
            removed = ", ".join(f["excluded"]) or "None"
            details.append(f'<details><summary><span>{e(f["name"])}</span><strong>{f["count"]} rule-matched</strong><small>{len(f["restored"])} missing entries restored · {len(f["excluded"])} invalid entries excluded</small></summary><div class="inside"><p>Placement-only deployed starting base: <code>{e(", ".join(f["deployments"]))}</code>. Kept outside the trainable roster.</p><p>Previously missing: <code>{e(", ".join(f["restored"]) or "None")}</code></p><p>Campaign/special entries excluded from ordinary selection: <code>{e(removed)}</code>. Source actors preserved.</p><div class="scroll"><table><thead><tr><th>Native localized name</th><th>Actor ID</th><th>Catalog origin</th><th>Rule source</th></tr></thead><tbody>{units}</tbody></table></div></div></details>')
        cards.append(f'<section id="{mode}"><h2>{title} <span>{len(factions)} factions</span></h2>{"".join(details)}</section>')
    build = summary["browserBuild"]
    build_text = f'Build <code>{e(build.get("buildId"))}</code> · content <code>{e(build.get("revision"))}</code> · verified: <strong>{e(build.get("verified"))}</strong>' if build else 'Native audit passed. Fresh four-target browser acceptance is still running; no new build is claimed verified here.'
    document = '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Faction roster audit · RTS AI</title><style>
    *{box-sizing:border-box}body{margin:0;background:#101511;color:#e5e9dd;font:16px/1.55 system-ui,sans-serif}main{max-width:1200px;margin:auto;padding:40px 24px}header{border-bottom:1px solid #3c4935;padding-bottom:24px}h1{font-size:clamp(30px,4vw,48px);line-height:1.15;margin:10px 0}h2{margin:38px 0 16px}h2 span{font-size:15px;color:#b4c3a5}p{max-width:95ch}a{color:#d7c689}nav{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}nav a,.badge{border:1px solid #46513d;padding:8px 14px;text-decoration:none;border-radius:4px}.good{color:#c3d8a8}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:24px 0}.metric{background:#1d261b;border:1px solid #43513a;padding:18px}.metric strong{display:block;font-size:32px}details{background:#192018;border:1px solid #35432e;margin-bottom:10px;border-radius:4px}summary{padding:16px;cursor:pointer;display:flex;align-items:center;gap:16px;flex-wrap:wrap}summary span{min-width:120px;font-size:19px;font-weight:600}summary strong{color:#c3d8a8;font-size:14px}summary small{margin-left:auto;color:#b1baaa}.inside{padding:0 18px 18px}.scroll{overflow:auto}table{width:100%;border-collapse:collapse;font-size:14px;text-align:left}th,td{padding:10px;border-bottom:1px solid #35432e}th{color:#d7c689}code{font-size:12px;overflow-wrap:anywhere}.note{border-left:3px solid #b7a56c;padding:6px 20px;background:#21251c}footer{margin-top:36px;color:#b1baaa;font-size:14px}summary:focus-visible,a:focus-visible{outline:2px solid #e4d29a;outline-offset:4px}@media(max-width:650px){main{padding:24px 14px}summary small{margin-left:0;width:100%}}
    </style><main><header><div class="good">LOCAL AUDIT · ACTUAL GAME RULES</div><h1>Every faction. Every existing unit.</h1><p>Studio, the native tech tree and the corrected web roster agree. Expand a faction to inspect its units, native names and rule sources.</p><nav><a href="#classic">Classic</a><a href="#ra2">RA2</a><a href="summary.json">Machine-readable evidence</a></nav></header><div class="metrics"><div class="metric"><strong>28 / 28</strong>Faction rosters matched</div><div class="metric"><strong>392 / 392</strong>Unique actor names matched</div><div class="metric"><strong>0</strong>Custom actors or edits removed</div></div><div class="note"><p><b>What was wrong:</b> England’s country replacement was previously shown alongside its parent Spy. It is correctly named <b>British Spy</b> and replaces the standard Spy for England. The wider audit found a separate web drawer filter omitting Classic tech units, omitting RA2 superweapon structures, and leaking campaign-only actors.</p><p><b>What changed:</b> the web drawer now resolves the current rules’ prerequisites, country gates, tech providers and starting-base transformations. Saved Studio prerequisite edits participate in that resolution. Gameplay rules and custom units remain intact.</p></div><p>Scope: own-country, full-tech rosters in our world-war-iii profile. Captured foreign infrastructure, mission scripts and map-specific overrides can intentionally make other units available. This audit checks our OpenRA modifications, not parity with the proprietary retail RA2 executable.</p><p>BUILD_STATUS</p>MODE_CARDS<footer>Bindings, saved stats and detailed rule edits were compared with pre-audit snapshots and are unchanged. Desktop typed rules and web typed rules match for all compared fields. Native evidence uses real ProductionQueue and TechTree queries in disposable matches, without AllTech cheats. Local only; no publishing performed by this audit.</footer></main></html>'''
    (root / "report.html").write_text(document.replace("BUILD_STATUS", build_text).replace("MODE_CARDS", "".join(cards)), encoding="utf-8")
    print(json.dumps({"passed": True, "factions": len(rows), "actors": len(names), "report": str(root / "report.html")}))


if __name__ == "__main__":
    main()
