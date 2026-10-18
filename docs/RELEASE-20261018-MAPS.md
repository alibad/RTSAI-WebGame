# Reviewed maps and repaired cliff walls — 18 October 2026

Live: https://rtsai.net/play/?v=70b514b

Published the repaired raised cliff artwork (28 templates, 30 sheets, 78 exterior
walls), six RA2 battlefields, and 14 native Classic / Red Alert Plus / Combined
Arms maps. The collection, authors and limitations are listed in CURATED-MAPS.md.
The current original-country restoration is preserved: 3,405 unrelated isometric
core/art files and the prior audio payload remain unchanged. No installed game,
Workshop service or per-map Firestore reads are needed for this catalog.

Classic uses 1,606 individually hashed art/palette/terrain/lookup files and 242
audited unit/weapon clips, with source package provenance and EA's notice.
Original music, EVA, videos and game archives are excluded. The desktop default
experience resolves to a frozen compatible web manifest on the published runtime.

## Production identity

- Release: `2026-10-18T11-26-59-133Z`, prepared/promoted only through release-play.
- Page/source: canonical main `70b514b432c82e2f6e3cbaf966a9a8fd39ebaaac`, pushed.
- Website: `d43e3b9d4acf6d32e6ab49cfc21f251c465b5434` (unchanged).
- Runtime: `rt-c64a7e3e6f04/` (unchanged); published engine `8dfa3b12ea9039b1f23dcaf6d7e9e0d3405bdd28`.
- Data: `data-dbb802878e04/`; bundles public `3f7d70f035b025a71c2e`, public-classic `cc168b0c0e63de3e66c5`.
- Frozen map/art source: canonical Mod main `5e33512e422cf5b5a1a0d533b5815e502443a9ed`, input hash `57aef0228ef5611e99350d6215ae61b2e58435c4f3e0a2187e9aa8db98b30b9e`.
- Current runtime Mod-code baseline remains `b5e12cd265ce7a47943c2701086b54a54e4ecdec15d2314e5f198e4aa5e69d65`; unrelated unpublished Mod history was not pushed or included.
- Cloudflare: `6788c0a4.rtsai-play-cdn.pages.dev`, 19,530 files / 37 header rules.
- Vercel preview `dpl_3wuRgDstzRoGjfpMch7nVrTZcWVU`, production `dpl_6Yt5p5AMY2625kHTQkqJSFzP8LVY`, standard build machine.
- Receipt: `D:/rtsai-play-release/releases/2026-10-18T11-26-59-133Z/receipt.json`.
- Prepared data artifact for subsequent releases: `D:/rtsai-map-release-20261018/static-startup`.
  Raw reviewed profiles are under `data-startup/public` and `data-startup/public-classic`
  in that same evidence root. Reuse these inputs when preserving this release's maps.

## Verification

- All 20 maps / 90 starting positions passed native tracked resource access and
  economy checks with the published runtime counterpart: 6,000 isometric ticks,
  12,000 allied Classic ticks, and separate 6,000-tick Classic combat runs. All
  starts earned income and reached four buildings; unsupported renderables: zero.
- All nine original and seven modern factions passed native content regression checks.
- 18 content/sprite gate tests, three lazy filesystem tests, one map residency
  regression test and TypeScript validation passed.
- Both final profiles were fully baked. Native QA payload and final published
  payload are identical across all 5,389 isometric / 3,378 Classic files; only
  pack residency changed. Evidence: `startup-payload-equivalence.json`.
- Five required browser matches against the actual Cloudflare roots passed:
  public skirmish 203 ticks, originals battle 200, repeated skirmish 201 + 201,
  native Classic Green Belt 202. Repeated match memory and GPU cleanup passed.
- Preview BUILD.json, index, isolation headers and scripts matched the build.
  After promotion, production release/data identity, COOP/COEP and the script's
  exact bytes were independently checked (`production-check.json`).
- Chrome visual checks against those live CDN assets confirmed the two repaired
  cliff maps and the 14-map Classic catalog; snow/desert spot-checks supplement
  the earlier visual review of all 14 maps. These used the release tool's local
  no-sign-in test page.
- Follow-up signed-in Chrome verification ran directly on `https://rtsai.net/play/`:
  Little Big Lake reached 5,729 ticks, with MCV deployment, a placed power plant
  and enemy attacks observed. The queued refinery was cancelled after the enemy
  destroyed the power plant. Tsunami's repaired cliff walls were inspected in
  the production editor. Classic Green Belt reached 5,653 ticks, with MCV
  deployment, placed power/refinery, ore harvesting and $2,000 earned income.
  All 14 Classic/mod maps were present. Both matches reported no game error and
  no console errors. The Green Belt match was left paused for the owner. The
  ordinary Google sign-in completed; no authentication gate was weakened.

Full evidence: `D:/rtsai-map-release-20261018/`. Browser shots are under
`browser-cdn/`, `browser-production/` and the release receipt's `smoke-shots/`. Earlier all-map visual
evidence remains under `build/map-expansion/` and its frozen source directory.

Two unpromoted candidates were rejected by browser QA: lazy map previews stalled
startup, then moved cursor artwork stalled battlefield preparation. Both roots
were recoverably archived. The final package preserves resident startup art;
short asset responses now fail safely instead of looping. Previous production
data `data-44c6802d8a16/` remains available for rollback.

These checks cover functional starts, harvesting, rendering and short browser
matches, not competitive balance or exhaustive naval combat. Broader upstream
maps and complete mod-specific factions/mechanics remain outside this release.
