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

The first-country focused checks passed during implementation. The full country matrix,
legacy gameplay/content regressions, browser validation and production promotion are
required before reporting this release delivered. Evidence is retained outside Git under
`D:/rtsai-ra2-nine-gaps-20261021/`. Release exclusively with `tools/release-play.mjs`.

Keep all 84 reviewed map/scenery overlays, Classic data, soundtrack retirement, frozen
saved clients and immutable save deployments. Never advance the owner's paused Hormuz
battle for release QA.
