# Saved geography and provider failures

Site discovery and terrain acquisition have separate caches. Terrain comes from complete OpenStreetMap geometry replies, not site names, satellite pixels or generated substitutes.

`web/public/earth-terrain/manifest.json` lists immutable coverage packs exported from canonical `RTSAI-Mod/resources/earth-terrain` with `tools/earth-terrain.mjs`. The browser loads only a pack whose queried bounds fully contain the requested battlefield. It checks byte count, SHA-256, completeness and detail level. Never infer coverage from geometry extents. The initial packs preserve the Cairo city center and the owner's selected 3 km square (30.048238620287975, 31.228992081250226). They do not cover all Cairo or all footprint sizes.

Successful downloaded areas and packaged evidence are kept in IndexedDB `rtsai-earth-terrain`, separate from sites. The cache is bounded to 32 MB / 12 areas, with a 12 MB per-area limit; storage denial falls back to session memory. Saved geography is used immediately. **Refresh geography** explicitly requests new data and retains saved terrain if the provider fails. A wholly new area still requires a working provider. Coverage is conservative: partial overlap is not enough.

The local relay has a 42 second overall deadline, inside the page's 45 second relay timeout. It tries at most two mirrors concurrently, cancels remaining work on success or client disconnect, rejects provider remarks/partial results and validates old cached replies. Previously it could continue for minutes after the page's 20 second timeout and cache partial replies as successes. New replies also get a query/source sidecar on disk.

The generated map retains geographic source/query/bounds in `geography.json`; editor saves preserve it. The full source evidence remains in the bounded browser cache and canonical dataset. The selection survives reload in session storage; reproducible local links can use `mode=earth&earthPlace=Cairo&earthLat=...&earthLon=...&earthRadius=1500`.

Verification: `node tools/earth-terrain-test.mjs`, `node tools/overpass-relay-test.mjs`, frontend build, and real-browser generation/play with provider requests blocked. Existing site cache checks: `node tools/earth-sites-test.mjs`.
