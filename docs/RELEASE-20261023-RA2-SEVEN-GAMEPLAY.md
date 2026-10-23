# Restore seven original-RA2 economy and splash rules — 23 October 2026

The seven confirmed gameplay differences are restored for the nine original countries:

- Base production uses retail BuildSpeed=.7: Grizzly735 host ticks, Rhino945. Walls also use the retail3x time coefficient.
- Additional factories apply cumulative0.8 multipliers, with one final rounding and no seven-factory table cap.
- Low-power production uses the base game's MinLowPowerProductionSpeed=.5, MaxLowPowerProductionSpeed=.8 and LowPowerPenaltyModifier=1. Queue progress retains fractional credit; the remaining-time display uses the same rate.
- Oil pays$20 every100 retail frames using a rational15/25 clock: host ticks167,334,500,667,834,1000. Ownership changes reset the retail interval.
- Spy power sabotage lasts1,667 host ticks (1,000 retail frames).
- Spy theft transfers50% of the victim's funds, including zero; it does not mint a$500 minimum payout.
- Original CellSpread weapons use their source radius and linear PercentAtMax endpoint, measured from actor centers. An explicit zero just beyond the radius retains the nonzero inclusive endpoint. Split enemy/ally warheads retain their first-point multipliers. V3/Dreadnought ordinary and elite radii use their own warhead facts.

## Audit correction

The previous report incorrectly interpreted the unused/older WorstLowPowerBuildRateCoefficient=.1 and BestLowPowerBuildRateCoefficient=.2 as base RA2's active production rule. The source rules.ini lines279–282 instead specify the .5/.8 clamp and shortfall penalty. The report was corrected. The mismatch remains real, but the original implementation should speed up low-power production from the web port's one-third rate, not slow it to10–20%.

Primary references: original extracted rules.ini SHA256 fd1e95cea0306ea78049dc81c8cd816e18c28c496872a1ff02edd50bd082062f; tools/data/ra2-retail.json. Ares' maintainer documentation also describes the original build-time and power settings: https://ares-developers.github.io/Ares-docs/new/buildtime.html . The source INI's MultipleFactory comment explicitly specifies cumulative discount multipliers.

## Isolation and verification

Runtime factories select per-player original-country queues without mutating shared rules infos. Spy effects select the attacking owner's rules even against a modern building. Oil selects its current owner. Modern factions retain their previous queue, income, blackout and theft behavior; Classic has no OriginalRa2Economy marker and keeps its existing queue.

The generated-content-only release updates ea-art.yaml and ea-retail-weapons.yaml. All other5,583 packed files, art/audio packs and the reviewed map overlays are retained. No art substitution is part of this release.

Native regression command: `websim originaleconomytest --root <verified-vfs>` (nine original and seven modern countries). It exercises actual production orders, normal/critical power, min/intermediate/max power ratios, three balances for spy theft, the outage timer,1,000 ticks of actual oil account changes, and actual AP impact HP at center/midpoint/radius/outside. Synthetic captured-tech cases are intentional and do not add units to natural rosters. The generated-art suite passes38 tests.

Evidence: D:/rtsai-ra2-seven-fixes-20261023/ . Build/release/browser verification is still pending; production details will be appended only after successful promotion.

The non-live data-b1abd205626b alias is scheduled for local archival to keep the CDN below20,000 files. All2,592 manifest entries match immutable deployment06a5cd0d, and its downloaded bundle SHA256 matches the existing save-catalog identity. The current live bad1 root and original Hormuz537 root remain served. The immutable deployment and frozen client are retained; the release tool owns the move.

The original splash conversion also sets TargetActorCenter so a direct shell lands where the center-based radius is evaluated. The all-nine building-fire regression caught the missing aim setting before release; after correction, hit ticks27,127,227,327 preserve the100-host-tick reload and the storm schedule is unchanged.

Release input isolation: RTSAI-Web has unpublished main commits owned by another chat. --published-site exports the already-live website commit with git archive from that canonical repository, after verifying it is on origin/main's ancestry. The resulting Git-free dependency is fully SHA256-manifested and revalidated before/after both page builds; changed files, extra files, Git metadata or a changed website origin cause refusal. The helper's integrity probe rejected a modified source file and passed after restoration. No checkout, worktree, clone, reset, stash or Website push is used. Vite records the verified source commit explicitly. The ordinary dirty/ahead website guard remains unchanged without this flag.
