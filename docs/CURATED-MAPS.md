# Curated web skirmish maps

Local integration, 18 October 2026. No deployment or push is authorized by this work.

The public isometric game now includes six existing RA2 layouts from canonical
`RTSAI-Mod/mods/rtsai-classic/maps`, adapted into that repository's
`mods/rtsai/standalone/maps/ra2-*` collection:

| Players | Maps |
| --- | --- |
| 2 | Little Big Lake; Official Tournament Map B |
| 4 | Tsunami; Valley of Gems |
| 6 | DEFCON 6 |
| 8 | A Path Beyond II |

`RTSAI-Mod/tools/import-web-skirmish-maps.py --check` verifies every installed
file against the reviewed adapter. Each package has `provenance.json`; the shared
manifest is `RTSAI-Mod/resources/web-skirmish-maps.json`. Original authors are kept.
YAML source hashes use UTF-8/LF; the terrain binary is byte-identical. Heights,
resource amounts, actors, start positions, bridge pieces and map rules are retained.
Only RequiresMod and the three ore drill actors' RenderSprites.Image change. Their
inherited native resource generation and footprints remain intact.

The standalone MapFolders already includes this directory, and Bundle.Build walks
it. Thus a fresh public content build includes these maps automatically, including
static deployments; no workshop API, per-map Firestore document or original game
installation is needed. The six packages add about 1.1 MB uncompressed. This task
does not change the browser simulation and reuses the validated local AOT runtime.

The shared map picker hides internal web-arena fixtures, groups original imports,
loads preview images when cards approach the viewport and shows complete previews.
Skirmish/multiplayer exclude maps with fewer than two players. Editor drafts remain
available in the editor. Locally authored and cloud maps are grouped as Your maps.

## Cliff artwork repair

Raised-only cliff corner templates used their raised height as the wall floor,
creating zero-height exterior walls. `RTSAI-Mod/tools/standalone-terrain.py`
now descends to the template's zero datum and invalidates stale render caches
when geometry, render settings or the Blender renderer change. The incremental
`--repair-cliffs --install` path rebuilt 28 templates / 30 sprite sheets while
preserving the palette and all unrelated terrain. Heights, ramps, collision and
map binaries are unchanged. `tools/test-cliff-geometry.py` checks 78 exterior
walls, exported frame bounds and installed hashes. The art receipt is
`mods/rtsai/standalone/terrain/CLIFF-REPAIR.json`.

## Native Classic and mod collections

The Classic web profile now packages 14 reviewed maps from
`RTSAI-Mod/resources/classic-web-maps`, in place of its unreviewed full map tree:

| Collection | Maps |
| --- | --- |
| Classic | Discovery; Agenda; Behind the Veil; Crossfire; Doughnut; Ardennes |
| Red Alert Plus | Amsterdamned; Black Belt; Belligerent; Bay of Bays |
| Combined Arms | Green Belt; Outdoor Trails; Haos Ridges; All Connected |

These run in `rtsai-classic-core` with native temperate, snow and desert terrain.
They are not converted into isometric approximations. The adapter changes only
RequiresMod; terrain binaries, resources, actors, rules, starts and original
authors remain intact. It rejects external rule dependencies and scripted maps.
`RTSAI-Mod/tools/import-classic-web-maps.py --check` validates the installed files
against the preserved sources. Every map has provenance, also indexed in
`resources/classic-web-maps.json`. The two internal test aliases remain hidden.

ClassicBundle uses locally installed free Classic content and keeps it separate
from the standalone isometric profile. This verified local Classic pack does not
require an owned RA2 installation. Publishing the Classic profile, its content
notices and asset delivery remains a separate release task; this work grants no
deployment authorization. Map browsing adds no Firestore reads.

The main menu offers Isometric and Classic tiles when `VITE_GAME_MODES` includes
both `public` and `public-classic`. Switching clears map/scenario launch parameters
and opens the chosen profile's home screen. Builds containing only one profile
keep one entry. Existing themed view tiles and map pickers are reused; the mode
choice and expanded map picker were inspected on desktop and a 390px phone.

## Verification

Native command, with a matching public VFS and native build:

```
websim maplibrarytest --root <isometric-vfs> --out <evidence-directory> --ticks 6000 --cash 5000
websim maplibrarytest --root <classic-vfs> --out <economy-directory> --ticks 12000 --cash 5000 --allied true
websim maplibrarytest --root <classic-vfs> --out <combat-directory> --ticks 6000 --cash 5000 --combat-only true
```

All 20 imported maps and 90 seats passed native tracked movement from every start
to resources and AI economy checks. Every AI earned income and built at least
four buildings. The 14 Classic maps also completed separate combat runs. The
allied economy run prevents early defeats from being misclassified as broken
starts: several unallied AIs were defeated before reaching four buildings.
Snapshots before/after reported zero unsupported renderables. Settings: seed
4242, medium isometric / heavy Classic starting forces, $5,000 credits, revealed
terrain, fog/crates off. This checks functional starts, harvesting and simulation;
it is not competitive balance or full naval-combat certification.

Current evidence is under `D:/rtsai-release/map-expansion-20261018`, including
frozen committed sources, bundle identities, native reports/previews, sprite
bakes and build logs. The ignored `build/map-expansion/` directory contains a
visual review, screenshots of all 14 new maps in Chrome and the repaired cliffs
on Little Big Lake and Tsunami. A Classic Green Belt browser match verified MCV
deployment, construction, production and harvesting (2,000 earned credits).
The expanded collection also passed a 390px phone card inspection. The frontend passes
TypeScript and Vite builds. The earlier six-map integration and desktop/390px
picker evidence remains under `D:/rtsai-release/map-library-20261018`.

## Remaining limitations

- Project isometric terrain art differs from original RA2 artwork. The missing
  raised-only cliff walls are repaired; this is not a complete terrain art remake.
- Tsunami is deliberately naval: ships or amphibious transports are required.
  Tournament B's damaged bridge pieces remain part of the original design.
- Eleven snow maps, two urban maps and eight other temperate maps with unfinished
  scenery are not included. They need their own terrain/scenery review.
- Broader Classic and upstream collections remain preserved. The 14 reviewed
  imports use Classic gameplay rules; they do not port all of each mod's factions,
  missions or mechanics.
- Desktop main source and local browser artifacts are separate from production.
  Publishing still requires owner authorization and `tools/release-play.mjs`.
