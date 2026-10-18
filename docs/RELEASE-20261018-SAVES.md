# Saved-battle compatibility — 18 October 2026

Updates previously rejected saved battles when their runtime or rules changed. Custom
maps were not embedded, and the eleventh save silently evicted the oldest battle.
Saves now retain their original engine/content pair and a compatible archived client,
embed custom maps, and keep earlier battles until the player deletes them. Restores
start paused at the exact checkpoint while graphics load. Native hash validation is
unchanged.

Live page: `9090e05`; runtime `rt-738104198cd2/` and data `data-6d6e5f05c328/` remain
the verified current gameplay pair. Official release `2026-10-18T14-06-47-558Z`,
production `dpl_bUEo1uYksuHCZX5K5sa6dyGRz7Uo`. The ten archived identities keep
their original immutable assets. The UI repair changes their client to
`saved-clients/9090e056628b/`; its worker is byte-identical to the previous client.
Old client files and immutable deployments remain available.

The original Hormuz save required its missing map as well as the archived runtime.
The earlier geographic export reproduces every one of its 13,010 recorded simulation
frames. Its later cosmetic sand-paint stroke could not be recovered; that limit is
shown in the save library and recorded in the recovery asset's provenance.

Actual signed-in Chrome verification:

- Original 8:40 checkpoint restored on its original `rt-6f954db93fe3/` and
  `data-5371825e5fda/`, holding paused at tick 13,010.
- A fresh live export exactly matches the original scenario, full log (all hashes and
  order packets), tick, selection, groups, profile, identity, view and title.
- Original save fields remain unchanged; only recovery/version/map metadata is added.
- A 9:03 continuation was saved, exported and successfully resumed after a page reload.
- Custom-map exports are self-contained. Original and newer 6:10 Hormuz checkpoints
  are backed up separately. No browser warnings or runtime errors in final acceptance.

Validation: compatibility/catalog/quota tests, TypeScript, original native 13,010-frame
comparison, protected preview byte checks, five official browser battle smoke runs,
and the live Chrome checks above. Release retries now distinguish staged files from
published files and permit validated deployment-header rules to grow. The retired
data44 alias copy remains on disk and its immutable asset deployment remains online.

Evidence: `artifacts/hormuz-battle-live-20261018/exact-live-restore-comparison.json`,
`hormuz-map-recovery-native.json`, `paused-client-repair-check.json` and final screenshots
12–14. Recovery copies and Git bundles are backed up under
`E:/rtsai-backups/hormuz-battle-live-20261018/`.
