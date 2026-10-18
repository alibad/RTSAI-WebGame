# Original RA2 gameplay restoration — 18 October 2026

Production: https://rtsai.net/play/

Restores all 15 confirmed findings from the gameplay audit: original promotion thresholds, elite healing, eight omitted elite primary weapons, non-trainable units, Iron Curtain organic-target behavior, lethal Chronosphere terrain mismatches, Chrono Legionnaire teleport/erasure, Prism Tower support, Prism Tank branches, Squid grabs, Terror Drone infestation/removal, attached Ivan bombs and engineer defusal, repair values, Lightning Storm damage and nuclear falloff/radiation.

The original-country overlay uses extracted original RA2 rules and assets. It preserves modern faction behavior and the 84 reviewed map/scenery overlay files. Original temporal waves, directional Squid grab animations, beam rendering, lightning effects and strike sounds are included. Implementation commits: `715d27e`, `8c8cc81`, `254268e` on canonical main.

Verification:

- 72 isolated native gameplay probes: eight suites across America, Germany, Great Britain, France, Korea, Cuba, Libya, Iraq and Russia. Real orders exercise combat, support powers, teleportation, defusal and Service Depot removal; controlled XP/damage isolate rank/healing thresholds and area damage.
- Seven mechanic batches use the final mechanics before the storm-palette-only data correction; the final damage/rules batch and temporal rendering were retested. The payload diff is retained with the evidence.
- All nine original and seven modern faction content suites pass; 36 asset/rule checks pass.
- Nine original country browser galleries and modern China pass on the new AOT runtime/data. Browser frames confirm temporal waves, directional Squid grabs and Prism support (150 damage versus the normal 60 in the controlled wood-armored fixture).
- V3/Dreadnought impact and enemy Flak interception, Terrorist/Demolition Truck suicide blasts and Iron Curtain rendering pass regression checks.
- TypeScript checks and all five official browser smoke matches pass, including Classic; repeat-match memory and texture checks pass.
- Network tracing attributes all seven smoke 404s to the optional local `api/content-status` capability probe; no game/CDN asset failed.
- Saved-game catalog retains 10 engine/content identities. Original Hormuz and current-save descriptors and all 223 frozen-client files verified; authenticated preview catalog, index, worker, CSS and isolation headers verified by the coordinating chat.
- Production BUILD.json, release identity, content roots, isolation headers and saved-game catalog verified after promotion.

Release identity:

- Page: `50d68da`; canonical main, pushed.
- Runtime: `rt-738104198cd2/`; source hash `28f24a809fb2517e`; engine `8dfa3b12ea9039b1f23dcaf6d7e9e0d3405bdd28`.
- Data: `data-6d6e5f05c328/`; bundle `fde6c2d7992ae16d296c`; published standalone baseline `b5e12cd265ce7a47943c2701086b54a54e4ecdec15d2314e5f198e4aa5e69d65`.
- Website: `d43e3b9`; immutable asset deployment https://7de3418f.rtsai-play-cdn.pages.dev/.
- Release: `2026-10-18T13-27-21-122Z` through `tools/release-play.mjs prepare/promote`; standard Vercel build machine and usage check.
- Preview: `dpl_3tjgodM2Xy2ZZy5xteZRoDNA7RLr`; production: `dpl_22H1pgsBostji7z3jES5mqAQxkYH`.
- Receipt: `D:/rtsai-play-release/releases/2026-10-18T13-27-21-122Z/receipt.json`.
- Visual report and detailed evidence: `D:/rtsai-ra2-gameplay-fix-20261018/index.html`.

The Cloudflare 20,000-file limit required recoverably archiving the old data44 alias copy (3,381 files); its immutable deployment remains available to saves. The original data537 and prior live data-dbb alias copies remain retained. Release retries now compare the live manifest with staged files and treat the validated `_headers` control file as mutable without weakening immutable asset checks.

Start a new battle to test these gameplay fixes. Older saved battles deliberately use their original engine/rules through the frozen compatibility client. These focused checks certify the 15 confirmed findings, not every retail executable behavior, full campaign playthroughs, global engine timing or pathfinding parity.
