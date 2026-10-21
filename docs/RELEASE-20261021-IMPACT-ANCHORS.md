# Correct missile impact artwork placement

The reported England–Israel footage shows `r2ilat` missiles using the project
`explosion.verylarge_clsn` sequence. The missile and damage reach the tank correctly;
the generated `s_clsn58.shp` artwork's authored ground contact is 72 pixels below
the fixed canvas centre. Rendering that centre at the impact displaced the blast.

The content generator now bridges those coordinate systems with a sequence offset.
It uses recorded project-authoring metadata and exact asset SHA256/canvas checks,
preserves X and depth offsets, and applies one fixed correction across every frame.
There are 46 matching project assets and 47 sequence aliases. Original
`ea-explosion` artwork retains its existing offsets. No sprite pixels were regenerated.

`tools/effect_anchors.py` runs from normal original-country content generation, so
the correction survives future builds. `tools/prepare-effect-release.py` packages
that generated patch against exact published data: all original-country sequence
bytes must match before it accepts the appended project-only offsets. It also
verifies every reviewed map/scenery overlay before emitting the new bundle.

Validation:

- Focused anchor regressions pass, including changed-artifact rejection.
- Controlled native stationary hits from eight directions and short/long moving
  target shots reach the tank, with the expected 300→170 health change.
- Before/after WASM scene telemetry is identical, including impact tick 37 and
  damage. Inspected browser screenshots show the ground burst at the tank after
  the 72-pixel correction rather than below it.
- The original England–Israel replay restores all 18,055 recorded frame hashes
  with the repaired content. Combat/order results are unchanged.
- 5,524 existing packed files are byte-identical. The only changed payloads are
  the sequence presentation file and bundle/map identity metadata; one new
  presentation provenance record is added. Art and audio packs are byte-identical.
- All 615 Classic static files are byte-identical; all 84 reviewed map/scenery
  overlays remain intact. No runtime or gameplay weapon rules changed.
- All five official packaged smoke matches pass, including original, modern,
  repeated starts and Classic. Preview HTML/script bytes and isolation headers pass.

The full legacy art-overlay test command has three pre-existing stale assertions
for the prior nine-gap garrison/civilian changes; running it against the unchanged
published baseline reproduces the same two failures and one error. Its other
33 checks pass. Those unrelated expectations were not weakened for this fix.

Release through `tools/release-play.mjs prepare --data ...` and `promote`:

- Live source `ffbb5ce`, runtime `rt-35a4e258c802/` unchanged.
- New data `data-d6eab40ee94c/`, bundle `2bea0b9e193ebd97df47`.
- Release `2026-10-21T19-58-15-678Z`.
- Preview `dpl_E1um72hp5WLjZsRcEjQckeFUo3Wu`; production
  `dpl_8L2Lkf2HEcPAtAxCR8Jm2fVDZ7W7`.
- Immutable new assets `https://7b3a5f32.rtsai-play-cdn.pages.dev/`.
- All 13 existing archive identities retained, plus the new identity (14 total).
  The earlier `data-b5df9dd495d8/` alias was archived locally after its 2,590
  manifest entries and both original content hashes matched retained immutable
  deployment `b10de5d5`. Current/previous live assets remain served.

Use the official release page with runtime `rt-35a4e258c802/`. The intermediate
data-only staging output reuses an older build runtime as a packaging prerequisite;
that runtime was not promoted. The release tool selected and verified the matching
current runtime for the new data root.

Evidence and reproducible probes: `D:/rtsai-projectile-impact-20261021/`.
The owner's paused original Hormuz battle was not opened or advanced. Existing
recorded videos and immutable old saved-game clients retain their original pixels;
new gameplay from the updated live link uses the corrected content.
