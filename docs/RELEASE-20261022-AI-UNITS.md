# Original countries: the AI builds their own units, and mind control and carrier aircraft work — 22 October 2026

Production: https://rtsai.net/play/

An AI-vs-AI survey of the live web game (every faction against every other, no starting units and heavy units at three
cash levels) plus a per-faction coverage check found two gaps that only the nine original countries had. Both are fixed
in this release.

## What players get

- **The original countries' AI fights with its own army.** In about 15 AI games per country, the bots never built a V3
  Launcher, Kirov Airship, Dreadnought or Terror Drone (Soviets), Terrorist (Cuba), Demolition Truck (Libya), Harrier or
  Chrono Legionnaire (Allies) or Black Eagle (Korea), nor a Weather Controller or Ore Purifier, although their bases had
  the prerequisites in hundreds of snapshots. The bots train only units on their `UnitsToBuild` list or tagged with a
  strategic role, and these were on neither. Every bot profile now lists them (Kirov capped at 2, Dreadnought 3, V3 4,
  Terror Drone 6, Chrono Legionnaire 2; Harrier and Black Eagle keep their limit of one), builds the Weather Controller
  and Ore Purifier, and fires the Weather Controller like the nuclear missile (RTSAI-Mod `b286b94`). These units belong
  only to the original countries, so the modern factions' tuned rosters are unchanged.
- **Yuri's mind control, and the carrier's and destroyer's aircraft, work for the original countries.** The original-
  country overlay gives each restored weapon a renamed twin (`retail-armament…`) and turns the original off for those
  countries; attack selectors heard the new names, but `MindController` and `CarrierParent` still listened only for
  `primary` / `asw`. Yuri stood beside an enemy GI, Grizzly, Rhino or Merkava until he died, and the Aircraft Carrier and
  Destroyer never launched their aircraft. `tools/ea_retail.py` now extends every trait that acts on a named armament
  (also `GrantConditionOnAttack`, `RevealOnFire`); regenerated, `ea-art.yaml` changes by five listener lines (carrier,
  dest, ptroop, yuri, yuripr) (RTSAI-WebGame `3c8ed56`, checked by `test-ea-art.py`).

## How it was built

Mod main had changed by `b286b94` alone since the live data's input (`f235dac`), so the release packages exactly that
onto the published profile instead of a full rebuild: `tools/prepare-rules-release.py` (`c231930`) swapped
`mods/rtsai/rules/ai.yaml` (only the `f235dac..b286b94` change) and the regenerated `ea-art.yaml` (only lines matching the
listener pattern) into `D:/rtsai-full-20261021/final/public` and verified the other 5,582 files byte-identical. The
sprites were re-baked from the new bundle and are byte-identical to the live sheets apart from the bundle id in
`index.json`. Classic loads its own rules and is unchanged (its published profile was reused).

```sh
python tools/prepare-content.py ... --ea-art D:/rtsai-full-20261021/ea-art      # with the listener fix: content/
python tools/prepare-rules-release.py --base D:/rtsai-full-20261021/final/public --mod <RTSAI-Mod> --from f235dac --to b286b94 \
  --out <rel>/final/public --content <rel>/content --content-files ea-art.yaml \
  --content-lines '^\s*(CarrierParent|MindController):\s*$|^\s*ArmamentNames: ' --content-source <commit>
websim unpack --pack <rel>/final/public/web-bundle.pack --root <rel>/vfs-iso --audio
websim bake --root <rel>/vfs-iso --maps all --out <rel>/final/public/sprites
node tools/build-public.mjs --data-only --data <rel>/final/public --classic-data D:/rtsai-full-20261021/final/public-classic --out <rel>/static
node tools/release-play.mjs prepare --data <rel>/static --update "..."   # then promote
```

## Verification

- Four AI-vs-AI games with the new rules built all eleven units and buildings, with no page errors; a 120-game round
  at no starting units and $10,000 on the same content is running (results in the faction showdown report).
- Yuri takes a GI, a Rhino and a Merkava on his first shot with the regenerated overlay (none before).
- `test-ea-art.py --content <regenerated>`: 37 tests pass; the new test fails on the previously published content.
- Coverage check before the release: 326 of 326 roster units buildable, 182 of 191 combat units fire on a target range,
  0 page errors (the other 9: spotters, two interceptor jets that need an airfield, Raad on that range, and Yuri).
- Dry run and release smoke: public skirmish 204/201/200 ticks, original-art battle 201, Classic skirmish 203; textures
  released after quitting. 19 saved-game identities retained.

## Release identity

- Page main `6d5a3d6` (no web/ change since live `8d60a60`), runtime `rt-7824bd8bb601/` unchanged.
- Data `data-b1abd205626b/`, public bundle `ee15e53f0ebfa495bf50` (from `1eafa45b210b01c85457`); Classic unchanged.
- Cloudflare rtsai-play-cdn: added `data-b1abd205626b/` (41 header rules, 18,015 files). The 18 October rollback root
  `data-a3b0d296fd95/` (not in the saved-game catalog) moved to the retired folder; original Hormuz `data-5371825e5fda/`,
  `data-b80ffa239e04/`, `data-d6eab40ee94c/` and `data-b9e0c656e8e4/` remain served.
- Vercel: standard build machine, $0 due; preview `dpl_86MCERaELqfbPkv1kJMxGuHAiVet`; production
  `dpl_7fhkh3TppHFxbztWGvjsNyMF6aFR`.
- Release `2026-10-22T00-27-08-897Z`, receipt `D:/rtsai-play-release/releases/2026-10-22T00-27-08-897Z/receipt.json`.
- Evidence: `hq/games/artifacts/faction-showdown-20261021/` (`release-ai-fix/`, `runs/`, `dev/coverage/`, `bugs.json`).
