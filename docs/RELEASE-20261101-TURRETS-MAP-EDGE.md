# Original countries' turrets and the map's top edge — 1 November 2026 (second release)

Released on the owner's word ("Yes, publish"), after the owner's "fix all" of the remaining playtest items.

What players get:
- The original countries' turreted vehicles aim at their target again: apoc, fv, gapill, gtgcan, htk, htnk, mtnk (the
  Grizzly), naflak, nasam, sref, ttnk. Their turret had been locked facing north, so the muzzle flash and the shell's
  origin sat north of the hull whatever the target (the owner's 26 Oct "shots in the wrong place" and "no muzzle
  flash"). Cause: the ea- twin aliased the stand-in's sprite turret to a one-facing blank, and the disabled stand-in
  WithSpriteTurret still quantized the shared Turreted to one facing. Fix: tools/ea_originals.py keeps the stand-in's
  facing count on the blank alias (9c733d8). Only web/content/ea-sequences.yaml changes in the data (58 aliases).
- Nothing draws above the map's top edge on isometric maps: the renderer clips terrain, actors and shroud to the
  playable bounds, as the desktop does (da8bc32). Strips of 15 to 165 px on five RA2 maps and random maps are gone.
- Classic is unchanged.

Before and after: hq/games/artifacts/playtest-20261101/muzzle/ and map-edge/. Causes: docs/PLAYTEST-LOG.md items 5 and 7.

## Identities

- Production `dpl_AhwCrPok6iSfpXepdxNrvuwY4uUs` (preview `dpl_Eb5p1WG1h9ffHZd2iikkaAE24QG8`), release
  `2026-11-01T08-37-31-820Z`, standard build machine, amount due $0 (previous period's report; see below).
- Page main `a34de78`, built against the published website `d43e3b9` (`--published-site`).
- New runtime `rt-142f8f7ca20c/` (source a34de78, engine 8dfa3b12ea), new data `data-5eb9c3d0096c/`.
- Public bundle `9707c59401db8dfba057` (pack sha256 fc401b55…) from RTSAI-Mod main `fcb7346`; Classic `1927813ce7fc85248469`,
  unchanged (all 615 published Classic files identical).
- CDN: 19,010 files; the 22 Oct alias `data-b9e0c656e8e4/` was retired first (a34de78), with proof that both permanent
  deployments its saved games load from serve it whole (hq/games/artifacts/release-turrets-map-edge-20261101/).
- 29 saved-game engine/content pairs retained on immutable deployments.

## Checks

- Quality gate `2026-11-01T07-48-31-716Z`: all six steps passed (28 unit scripts, five smoke matches, seven browser
  paths in Chromium, Firefox, WebKit and touch, gameplay audit with both roster comparisons and the catalog).
- Release smoke on the Cloudflare roots: all five matches start, tick and free their textures.
- Independent live check: rtsai.net/play serves a34de78 / rt-142f8f7ca20c / data-5eb9c3d0096c with isolation headers; the
  live bundle's ea-mtnk turret alias carries InterpolatedFacings 32 (58 aliases in all), and the rock fix is still in.

## Note on the usage step

Vercel counts billing periods in Los Angeles time and answers "Costs not found (404)" for a new period with no costs
yet. On 1 Nov that stopped the promote at its usage step before production was touched; release-play now reports the
previous period in that one case (9adb4cd). October's report: $33.88 used, all included, $0 due.
