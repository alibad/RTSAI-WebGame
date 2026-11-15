# Soft explosions — 15 November 2026

Released on the owner's word. On 14 November, on a battle in the web game: "Explosions here are still shit"; after a
now-vs-new clip: "Yes, put them in"; after a filmed battle on a local build: "Yes, release".

What players get:
- The 38 blast explosions (vehicle and building deaths, shells, rockets, bombs, barrels) are redrawn. Before, each was a
  palette picture with its transparency cut at 50 %: a fireball was a clump of hard lumps with dark outlines, and its
  smoke an opaque grey blob that thinned out through a dotted screen. Now each is one bright fireball with a white-hot
  core, light on the ground, a dust ring, sparks and debris, and soft smoke that rises and fades.
- Each keeps its frame count, ground line and canvas, so explosions land where they did, last as long, and cost no more
  memory. Bullet dust (piff, piffpiff) and the nuke ball keep their pictures; splashes, fire, damage smoke and the nuke
  are other effects and unchanged.
- Classic mode is unchanged, byte for byte.

Pictures: `D:\Generated\RTSAI\explosions-fx-v3-20261114\` (`battle/battle-now-vs-new.mp4`: the same simulator fight on
the 14 Nov release and on the new build).

Sources: RTSAI-Art `tools/fx_soft.py` (74347d73, 4b5078a9) and the 38 sheets (308ca5bd); RTSAI-Mod da7839e (the sheets
in `standalone/effects`, the explosion sequences, the infantry rocket flash, the art record); this repository 4400b09
(impact anchors read a sheet's canvas), 72bd436 (the 1 Nov data root retired) and e911ab3 (release tool fix, below).

## Identities

- Production `dpl_7nLcwV1dt4YZ2EW3x5dmmWdwhfm1` (preview `dpl_GHsKLWsxGmTY4Hu3qJEgtP3ckYij`, previous production
  `dpl_C296G4Rgs646TrFt67iqfbS4ZNvF`), release `2026-11-15T07-24-57-319Z`, standard build machine. Vercel this period:
  $0 due; Build Minutes, Build CPU Minutes and Deployment Storage $0.
- Page main `e911ab3`, built against the published website `3150776` (`--published-site`: RTSAI-Web's canonical checkout
  holds another session's unpushed commit, left untouched).
- New runtime `rt-93fcc127b22e/` (source e911ab3, sim hash 4f17e5295836d257, engine 8dfa3b12ea, mod 82d7baf7fe86), new
  data `data-ada60803287d/` from RTSAI-Mod main `da7839e`. Public bundle `f572d09116ae1392e160`; Classic bundle
  `66af58fcf826d815bb83` (the published one, core pack sha256 71dcd134…).
- CDN rtsai-play-cdn: the 1 Nov root `data-281d8c632556/` retired first (its permanent deployment
  https://bb202449.rtsai-play-cdn.pages.dev/ serves all 2,592 entries and both bundles; its two saved-battle versions
  load from there); added the runtime and data roots: 19,607 files, 49 header rules.
- 35 saved-game engine/content pairs retained on immutable deployments.
- Quality gate `2026-11-15T07-08-52-790Z` passed all six steps.

## What changed in the data

Against the live 14 Nov data:
- **Isometric:** core 3,126 → 3,135 files: 9 small explosion sheets added; 3 mod files changed
  (`standalone/kit-extra-sequences.yaml`, `modern-factions/rocket-impact-sequences.yaml`,
  `standalone/ART-PROVENANCE-STANDALONE.json`) and 3 receipts. Art pack 554 → 583: the 29 larger sheets added, nothing
  else changed. The 84 reviewed map and scenery overlays are carried over unchanged. Sprite sheets 68 → 71: 64 identical
  under another name, 7 redrawn with the new explosions, 3 more because the new effects need more room.
- **Classic:** reassembled from the live data root and proven to be the published bundle; all 57 sprite sheets
  byte-identical.

## Checks

- Gameplay check (with the original art): 3,912 deaths and 1,567 weapon impacts drawn, 0 failures, the same counts as
  the 14 Nov release; both games agree (72 accepted differences, 0 new; Classic 0); the faction catalog matches.
- Quality gate: source, typecheck, 28 unit scripts (including the impact anchor and rocket impact tests), five smoke
  matches (four isometric, one Classic), eight browser paths, gameplay.
- Release smoke on the Cloudflare roots: all five matches start, tick and free their textures.
- Independent live check: rtsai.net/play BUILD.json names rt-93fcc127b22e and data-ada60803287d with the isolation
  headers; the live art index lists the explosion sheets; the live Classic pack is byte-identical to the 14 Nov one;
  the retired root answers 404 on the shared alias and 200 on its own deployment.
- Before the release, the same fight was filmed on the 14 Nov page and on a dry-run page with the new explosions.

## Release tool fix found on the way (e911ab3)

The runtime cache is keyed by its sources, not by the profiles a release ships. A dry run with only the isometric
profile (testing the explosions) left a runtime root with `public/` only, and the gate's next run reused it: Classic
failed to boot ("Failed to fetch ... rt-93fcc127b22e/public-classic/aot/_framework/dotnet.js"), even with `--runtime
rebuild`. A reused build now lays out the profiles it lacks from its own framework files (the files are the same for
every profile); nothing is rebuilt.

## How it was built

Work folder `F:\work\explosions-web-build-20261114` (deleted afterwards). Steps, scripts and logs are kept in
`D:\Generated\RTSAI\explosions-fx-v3-20261114\release`. Order: retire-root proof; push; `prepare-inputs.py --committed`;
`prepare-ea-art.py` plan, extract through a shim of real copies (no junctions), manifest, verify; `public.py --ea-art`;
the live public core from the CDN folder; `prepare-gameplay-release.py` (84 overlays retained); unpack and bake; Classic
reassembled from the live gate's kept data root (`reassemble-classic.py`, adapted for the 14 Nov rename's base
bundle), unpacked and baked; `build-public.mjs --data-only`; `gameplay-check.mjs`; the quality gate with
`--pack --data --inputs --published-site`; `release-play.mjs prepare --published-site --data --inputs`; `promote`.

Not in this release: the desktop game gets the new explosions with its next release.
