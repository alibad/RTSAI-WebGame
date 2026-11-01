# Rock scenery and modern refineries — 1 November 2026

The owner's 26 October play reports, released on the owner's word ("Yes, release them").

What players get:
- Rock scenery (TROCK/SROCK on the shipped RA2 maps) draws from frames at their drawn size, without the ground-decal
  depth ramp: no smeared pixels, and tree canopies no longer cut the rocks flat (RTSAI-Mod 1cd56de).
- The ore truck draws in front of the seven modern factions' refineries while it docks, unloads and drives out
  (refn-<faction> sprite depth 31 to -12, measured; RTSAI-Mod 6a5bbff, generator RTSAI-Art 938ec128).
- The original Allied refinery's depth is back to the original game's value 48 (RTSAI-Mod 1bde6ba). The 26 Oct release
  went live with 24; the docked truck shows fully at both.
- The ship wake was already live since 26 Oct; this release drops the unused placeholder `web/ea/wake1.shp`.
- Classic is unchanged.

Before and after: hq/games/artifacts/playtest-20261026/fixes/ (wake.png, rocks.png, refinery.png, refinery-z.png).
Findings and causes: docs/PLAYTEST-LOG.md.

## Identities

- Production `dpl_2ewNGEyBVbh5h6ymkGF24rw1BJWN` (preview `dpl_BBE8C1UVr63ZLKCt4RTjBMaB9zAm`), release
  `2026-11-01T06-55-01-442Z`, standard build machine, amount due $0.
- Page main `fd95e73`, built against the already-published website `d43e3b9` (`--published-site`).
- New runtime `rt-5cdf0b10cf70/` (source fd95e73, engine 8dfa3b12ea), new data `data-2276dd88d67f/`.
- Public bundle `57ed1932e94d732275fa` (pack sha256 3a4abd07…), from RTSAI-Mod main `b51c5ef`. Classic bundle
  `1927813ce7fc85248469`, the live one, unchanged.
- CDN: 18,812 files after the release; the 21 Oct alias `data-d6eab40ee94c/` was retired first (71c9c54). Its permanent
  deployment serves all 2,590 entries and both bundles, and its one saved-battle version loads from there (proof in
  hq/games/artifacts/release-rocks-refinery-20261101/).
- 27 saved-game engine/content pairs retained on immutable deployments.

## Checks

- Quality gate `2026-11-01T06-22-01-525Z` passed all six steps: source, typecheck, 28 unit scripts, five smoke matches,
  seven browser paths (Chromium, Firefox, WebKit, touch), gameplay audit (3,912 deaths, 1,567 impacts, both roster
  comparisons, catalog). Gameplay receipt keyed by the pack: 3a4abd07…
- Release smoke on the Cloudflare roots: all five matches start, tick and free their textures.
- Independent live check: rtsai.net/play BUILD.json names fd95e73, rt-5cdf0b10cf70, data-2276dd88d67f, isolation
  headers present; the live bundle has the wake, the rocks' small sheet, all seven refineries at -12 and garefn at 48.
- Changed files against the live 26 Oct bundle: allied-structures.yaml (garefn), kit-sequences.yaml (refineries),
  editor-world/sequences.yaml (rocks), ea-sequences.yaml (ea-garefn), ea-content.json (wake1.shp dropped), receipts.

## How it was built after the 1 Nov D: cleanup

The cleanup deleted the folders earlier releases were built on (EA set, base profiles, Classic packs). This release
rebuilt them in `F:\work\rtsai-rocks-refinery-20261101` (deleted afterwards; its records are in the artifacts folder):
- EA set re-extracted with `prepare-ea-art.py extract` through a shim of real copies (no junctions), identity
  `d33705e5…` reproduced exactly.
- Gameplay base: the live public core, decompressed from the CDN, with an empty art pack; all 84 reviewed overlays are in
  the core. `--accept-overlay mods/rtsai/standalone/editor-world/sequences.yaml` ships the rock fix.
- Classic: the live profile reassembled exactly from the CDN files and the art pack kept in the 22 Oct dry run's release
  folder; every one of the 615 published Classic files decompresses to the same bytes in the new root.
