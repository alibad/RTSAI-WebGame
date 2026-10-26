# Faster repairs and powered Ore Purifiers — 26 October 2026

Owner balance choices for the nine original countries:

- Repair depots restore 20 HP every 25 host ticks (one second). Hospitals restore 20 HP every five ticks (0.2 seconds). This is a deliberate faster-repair setting, not a claim of exact retail timing. Building repair and repair-IFV weapons are unchanged. The existing 15% repair-cost setting remains in place.
- Ore Purifiers add 25% only while electrical power is normal. Spy outages and ordinary supply shortages suppress the bonus; base refinery income continues. Power recovery automatically resumes the bonus. Capture uses the current owner's power policy and funds.
- Engineer recycling remains $250; aircraft rearming remains 50 ticks per round. Neither is restored to the slower/lower retail value.

The changes use the existing per-owner runtime adapters; modern factions and Classic retain their existing behavior. No original assets, terrain, team colors, maps or saves are replaced by this mechanics change. The combined release also includes separately authorized Command Red UI/launcher updates and the modern rocket-impact presentation correction coordinated with the other chats.

`websim repairpowertest --root <VFS>` tests nine original plus seven modern owners. It deposits actual ore into a refinery and checks base/bonus funds through normal power, blackout, restoration and a normal supply shortage. A captured Purifier must pay its new owner and obey that owner's outage. Actual Resupply activities check depot/hospital HP steps and cadence; distance is bypassed to isolate repair speed. Actual DeliverCash orders consume Engineers for $250. Aircraft RearmTick is exercised directly, excluding flight/landing. Both-side supplied buildings are synthetic captured-tech cases, not new natural roster access.

Evidence: D:/rtsai-repair-power-20261026/. Final native/browser/gate verification and production promotion are pending; append release identities only after successful verification.

The first fresh input validation correctly rejected two Python bytecode cache files added by source-check imports; no source files changed. `prepare-inputs.py` now suppresses bytecode in-process and in child validators. The failed input is preserved and a new input snapshot is used; the manifest check is not weakened.

To stay within the CDN file limit, the release tool may archive the superseded, non-live `data-bad1fbdfc616/` alias locally. All 2,592 entries match its immutable deployment `https://4af1edcb.rtsai-play-cdn.pages.dev/`; downloaded bundle SHA256 `650fc191d3218f1b4aa651c876d4e8e5a45c4a7fe79839030b979e85d510160a` matches its saved-game catalog identity. The current live data and original saved-battle roots remain. Every prior catalog entry and immutable deployment is retained.
