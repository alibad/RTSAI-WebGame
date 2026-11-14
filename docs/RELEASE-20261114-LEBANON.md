# The seventh modern faction is Lebanon — 14 November 2026

Released on the owner's word ("Yes, go live", then "Everything" for the unreleased work on main, 14 November).

What players get:
- The seventh modern faction is **Lebanon**, title "Cedar Guard", with Lebanon's national flag (flag-icons, MIT), a new
  identity story and rewritten rival lines, in the isometric game and in Classic. Its previous name, flag and the
  monogram that stood in for the flag are gone from the page and from both data packs. Unit ids keep their `hz` prefix.
- Real places: "Create a mission here" brings the mission step back (d8944d6).
- The menu's mode is called Isometric, not Red Alert 2 (3e8a956).

The rename itself: RTSAI-Mod 5f904de and 0f5314f, OpenRA f2059fdcab, RTSAI-Web 3150776 (rtsai.net, live the same
day), RTSAI-Art 89e6756d and 97fa2239, this repository a9c34f7 and 4148e77.

## Identities

- Production `dpl_C296G4Rgs646TrFt67iqfbS4ZNvF` (preview `dpl_6VcG1MFMqBAz4BGWuFwfp9H2nP56`), release
  `2026-11-14T13-59-33-442Z`, standard build machine, amount due $0.
- Page main `4148e77`, website `3150776`.
- New runtime `rt-0c32f15a7a84/` (source 4148e77, engine 8dfa3b12ea), new data `data-9dd9b9382f90/`.
- Public bundle `77c15d14fa2059d41327` (pack sha256 ac53840f…), from RTSAI-Mod main `0f5314f`. Classic bundle
  `66af58fcf826d815bb83` (pack sha256 71dcd134…): the published Classic `1927813ce7fc85248469` with only the rename.
- CDN: 19,406 files after the release; the 23 Oct root `data-dc3be2143a5e/` was retired first (4148e77). Its permanent
  deployment https://59510823.rtsai-play-cdn.pages.dev/ serves all 2,592 entries and both bundles, and its two
  saved-battle versions load from there.
- 33 saved-game engine/content pairs retained on immutable deployments.

## What changed in the data

Against the live 1 November bundles:
- **Isometric** (3,126 files): 3,062 identical; 48 differ only by the rename (41 of them at renamed paths); 16 others:
  the loading tips (new rival line), the three flag atlases, nine unit-override files (revision stamps only) and three
  receipts. Nothing added or removed.
- **Classic** (2,703 files, plus one receipt): 2,665 identical; 23 differ only by the rename (9 at renamed paths); the
  three flag atlases, the loading tips, the same nine stamp files and two receipts. In the art pack, the roster preview
  card (its header named the faction) is replaced.
- **Sprite sheets:** all 68 isometric and 57 Classic sheets are byte-identical to the live ones.
- The old name appears in no path and in no file of the new data root (2,594 files, checked decompressed) or of the
  page (458 files).

## Classic: renamed, not regenerated

`public.py --game-mode classic` on today's main builds a different Classic profile (rtsai-topdown; 2,499 files added
and 2,404 removed against the published one), so regenerating Classic would have shipped far more than a rename.
Instead `tools/prepare-classic-rename.py` (new, 4148e77) applies only the rename to the published packs: files the
published Classic shared byte for byte with the published isometric profile come from the new isometric profile, the
flag atlases and the preview card come from the frozen mod, other texts and paths get the name swapped, and
everything else stays byte for byte in the same pack. It refuses if the old name would survive anywhere and leaves
`ora/classic-rename.json`. The published Classic was first reassembled from the CDN core, the kept art pack and the
published audio files, and its bundle identity reproduced exactly.

## Checks

- Quality gate `2026-11-14T13-36-19-302Z` passed all six steps: source, typecheck, 28 unit scripts, five smoke matches
  (four isometric, one Classic), eight browser paths, gameplay audit (3,912 deaths, 1,567 impacts, 0 failures; both
  roster comparisons with 72 accepted differences and 0 new; catalog). Gameplay receipt keyed by the pack: ac53840f…
- Release smoke on the Cloudflare roots: all five matches start, tick and free their textures.
- Independent live check: rtsai.net/play BUILD.json names rt-0c32f15a7a84 and data-9dd9b9382f90 with the isolation
  headers; both live packs decompress to ORAPACK1 with the old name 0 times; the page opens to the sign-in screen with no
  console error.

## Known leftovers

- Older client builds under `saved-clients/` and the retired data roots on their immutable deployments still carry
  the previous name: saved battles need them unchanged.
- The four match posters under `evals/faction-showdown-20261022/before-fix/videos/posters` show it in their scoreboard
  pixels, and so do the match videos in the GitHub release assets.

## How it was built

Work folder `F:\work\rtsai-lebanon-release-20261114` (deleted afterwards). The step log, the helper scripts (base
from the live CDN, Classic reassembly, pack diff, sprite comparison, archive proof, live check) and the proofs are
kept in `D:\Generated\RTSAI\release-lebanon-20261114`. Steps, in order: `prepare-inputs.py --committed`;
`prepare-ea-art.py` plan, extract through a shim of real copies (no junctions), manifest, verify (identity `d33705e5…`
reproduced); `public.py`; `prepare-gameplay-release.py` on the live public core (84 reviewed overlays retained, none
changed); unpack and bake; Classic reassembled and renamed as above, unpacked and baked; `build-public.mjs
--data-only`; `gameplay-check.mjs`; the quality gate with `--pack --data --inputs`; `release-play.mjs prepare --data
--inputs`; `promote`.

One thing the rename missed at first: RTSAI-Mod's generated unit-override files carried stale revision stamps, so
`tools/unit-content.py check` failed while freezing the inputs. `unit-content.py compile` fixed it (0f5314f; stamps
only).
