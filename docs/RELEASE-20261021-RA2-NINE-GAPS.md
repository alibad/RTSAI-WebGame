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
