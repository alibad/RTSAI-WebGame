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

## Verification

Native command, with a matching public VFS and native build:

```
websim maplibrarytest --root <vfs> --out <evidence-directory> --ticks 4000
```

All six maps and 26 seats passed. The test checks native tracked movement from
every start to resources, then runs a normal AI in every seat. Each AI earned
income and built at least four buildings. Snapshots before/after reported zero
unsupported renderables. Test settings: seed 4242, medium starting forces, 20,000
starting credits, revealed terrain, fog/crates off. This checks functional starts
and economy; it is not a competitive balance or full naval-combat certification.

The local evidence is under `D:/rtsai-release/map-library-20261018`, including the
exact source snapshots, bundle identity, native reports/previews and build logs.
The ignored `build/map-library/` directory contains browser screenshots and an
interactive source/verification review. Chrome opened Little Big Lake and Tsunami
in the editor and verified the desktop and 390px phone map picker.

## Remaining limitations

- Project terrain art differs from original RA2 artwork. Some cliff junctions have
  visible dark gaps; importing maps preserves topology and does not fix those art
  assets.
- Tsunami is deliberately naval: ships or amphibious transports are required.
  Tournament B's damaged bridge pieces remain part of the original design.
- Eleven snow maps, two urban maps and eight other temperate maps with unfinished
  scenery are not included. They need their own terrain/scenery review.
- Classic and other upstream mod collections are preserved/indexed, not activated
  in another mode without checking terrain, actors, rules, scripts and provenance.
- Desktop main source and local browser artifacts are separate from production.
  Publishing still requires owner authorization and `tools/release-play.mjs`.
