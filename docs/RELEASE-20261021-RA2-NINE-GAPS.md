# Original RA2 gameplay restoration

This change restores the nine gaps recorded in the 21 October live audit: rank abilities,
IFV passenger weapons, temporal IFV erasure, automatic Chrono movement, civilian garrisons,
elite Squid punch selection, Psychic Sensor detection and intent lines, original nuclear
launch effects, and the moving Ivan fuse overlay. Original rules/art facts come from the
source-hashed retail baseline; the original binary assets remain external and allowlisted.

Veteran abilities persist at elite without stacking duplicate bonuses. The host represents
the original 1.5 armor divisor as a rounded integer damage percentage (67%). Modern rank
traits remain conditioned separately. Chrono movement wraps actual movement activities,
including attack approach, rather than only intercepting a player's Move order.

All 120 original occupiable civilian definitions receive their retail capacities, occupied
frames and firing ports. GI/Conscript entry changes a neutral building's ownership; heavy
damage evacuates it. Infantry enter through an ordinary target order. Original civilian art
also replaces the standalone village images for these actors and their rubble.

The two clock risks are corrected on the normalized rules clock: 900 retail frames and
1,500 host ticks represent one game minute. Weapon ROF is converted once. The storm uses
an integer rational accumulator, retaining its original 250-frame deferment, 180-frame
duration and 10/5-frame strike/scatter intervals without cumulative rounding drift.
This is deterministic rules-clock verification, not a matched-speed retail executable run.

## Verification and release

Native regression entry point:

```
websim ninegapstest --root <verified-vfs> --case <case>
```

Cases: `ranks`, `ifv`, `approach`, `garrison`, `sensor`, `bomb`, `timing`, `naval`, `nuke`.
Each case defaults to all nine original owners. IFV fixtures use ordinary passenger entry
and attack orders; suicide forms get fresh worlds so original radiation cannot contaminate
the next fixture. Captured/combined-tech test units do not change the natural tech trees.

All 81 nine-gap/country combinations and all 72 legacy gameplay/country combinations
passed. A further nine-country garrison render pass verifies original player remapping,
occupied art and the original UCFLASH muzzle; original occupied-building gunshot clips are
included. Faction content regressions, browser validation and production promotion are
required before reporting this release delivered. Evidence is retained outside Git under
`D:/rtsai-ra2-nine-gaps-20261021/`. Release exclusively with `tools/release-play.mjs`.

Keep all 84 reviewed map/scenery overlays, Classic data, soundtrack retirement, frozen
saved clients and immutable save deployments. Never advance the owner's paused Hormuz
battle for release QA.

The non-live `data-dbb802878e04/` alias is retired locally to keep the next CDN upload
below its file limit. All 2,582 manifest entries match its preserved immutable
`https://6788c0a4.rtsai-play-cdn.pages.dev/` deployment, already in the save archive seeds.
The release tool moves the alias to the archive directory; it does not delete it or the
immutable deployment. The current live root and the owner's original Hormuz root remain.

All sixteen faction content tests passed. A final rules review added a carrier-centered
Yuri IFV pulse: retail `AreaFire=yes` affects units around the IFV, rather than shifting
the blast to its selected target. A two-sided infantry regression passed for all nine
owners. Final nuclear launch/trail/impact rendering also passed 70 sampled frames per
country. The browser and production steps remain the delivery gate.

Chrono IFV erasure is also tied to an enabled temporal armament. Removing its passenger
cancels erasure immediately, and destroyed sources are checked before reading their traits.
An unload/reload regression passed under all nine owners; ordinary automatic acquisition
was separately exercised. Re-entering retains the original weapon reload timer.

The first production pixel check exposed a fuse depth issue despite the native enabled-state
checks passing: the world-space fuse could be occluded by a voxel model. The same original
frames now use a top-bound UI decoration, visible to allies, enemies and neutrals without
selection. This keeps the indicator above infantry, vehicles and buildings rather than
relying on a fixed world height.

## Production verification — 21 October 2026

Released from canonical main `e446daf6cb060fb6527d399ce01a9bc903b90c9e` through
`tools/release-play.mjs prepare` and `promote`, with the owner's deployment authorization.
Production: https://rtsai.net/play/?v=e446daf

- Production deployment: `dpl_CeLRBRovp1kBeWBabaKXKY6Tbgxv`.
- Release receipt: `2026-10-21T00-07-50-552Z`.
- Runtime: `rt-35a4e258c802/`, gameplay source `e07526d`; reused because the last change
  only replaces the fuse's data trait with an existing foreground decoration.
- Data: `data-b80ffa239e04/`; original bundle `6416099874606af54679`.
- Immutable assets: https://ae584510.rtsai-play-cdn.pages.dev/
- Production BUILD.json, page, isolation headers and script bytes verified by release tool;
  independent production BUILD.json fetch confirmed source, runtime, data and bundle.
- Five official smoke scenarios passed, including original and modern matches, repeated
  starts and retained Classic compatibility.
- Final nine-country browser scenes passed with the exact release CDN roots. Real garrison
  entry, Chrono attack teleport and completed Chrono IFV erasure passed again. The original
  Ivan fuse was visually confirmed above the enemy MCV model, including blinking frames.
- Native checks: 81 targeted country/case combinations, 72 legacy country/case combinations,
  all sixteen faction content tests, plus nine-country targeted rendering/regression checks.
  The final decoration's attach/move/render/defuse checks passed all nine owners.
- Both timing risks passed deterministic host/retail rules-clock checks. A matched-speed
  retail executable wall-clock comparison was not performed.
- All 84 reviewed map/scenery overlays retained. Thirteen immutable engine/content pairs
  remain indexed for saved games. Owner's paused Hormuz battle was not advanced or reloaded.
- The non-live `data-6d6e5f05c328/` alias was moved to the local retired directory only after
  all 2,586 entries matched preserved immutable deployment `b10de5d5`.

Local visual recap and evidence: `D:/rtsai-ra2-nine-gaps-20261021/index.html`.
This closes the nine confirmed gaps; it does not certify every retail gameplay system.