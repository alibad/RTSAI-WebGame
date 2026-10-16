# Saved Earth site data

The site pipeline makes **zero Firestore reads or writes**. Firebase still handles the product's existing account, saved-map and multiplayer features; this is not a promise of zero Firestore usage for the entire application.

| Data | When loaded | Storage / refresh |
| --- | --- | --- |
| Version manifest | First Earth visit; once per day thereafter; explicit Refresh bypasses this | Static HTTP JSON + IndexedDB fallback |
| Globe marker overview | Once per content hash | Small static JSON; verified SHA-256 + IndexedDB |
| Region metadata | Only intersecting regions, at most eight packs | Immutable filenames + checksum; cached by hash |
| Discovered core sites | Debounced selected area, when stale or missing | One IndexedDB record per normalized area; seven-day freshness per source |
| Article text | Only the selected Wikipedia site | Separate IndexedDB detail record; thirty days |
| Battlefield evidence | At map generation | `sites.json` beside `earth.json`, `map.yaml`, `map.bin`, and preview in the existing local map library |

The browser cache has a combined 8 MB / 256-record cap; one record cannot exceed 2 MB. Oldest cached records are evicted without deleting packaged source data or saved battlefield files. Evicted areas can be fetched again. When IndexedDB is unavailable, session memory is used and the UI says so. The UI also exposes dataset version, date, saved status, explicit refresh, and JSON download.

All known IDs survive discovery; the old four-mapped-site / six-article selection limits are removed. The globe clusters markers and renders all loaded records. Cards show thirty at a time. Source IDs deduplicate records without guessing that similarly named OSM objects and Wikipedia articles are the same thing. These remain geographic references, not verified current operations.

Small moves reuse a normalized coverage area. Requests are delayed 300 ms to discard transient pointer moves; concurrent source/area lookups share a promise. Successful empty results are cached too. Failed refreshes retain saved sites and wait five minutes before another automatic attempt. A cancelled view cannot publish stale UI updates; an already running bounded request may still finish and fill the cache. Optional site research never gates terrain generation or play.

The shipped baseline currently contains 27 sourced records across six packs (Cairo, Hormuz, Riyadh, Qatar, Suez, and two earlier checked references). It is **not a complete global inventory**. Wikipedia snapshots record a bounded 10 km geosearch, and OSM collection failures do not become false full-region coverage claims. New public discoveries are saved locally; they are not uploaded into a global user-writable catalog.

## Canonical dataset and updates

Canonical snapshots and the collector live in `RTSAI-Mod/resources/earth-sites` and `RTSAI-Mod/tools/earth-sites.mjs`. Original provider replies, acquisition times, source URLs, scope, attribution and license metadata stay there. Exported frontend packs live in `web/public/earth-sites`; normal Vite/public builds copy them. Existing immutable versions remain available for old manifests.

```powershell
# Explicit, bounded collection; choose only the named regions to refresh.
node tools/earth-sites.mjs --collect cairo,hormuz --export ../RTSAI-WebGame/web/public/earth-sites
# Offline, deterministic re-export of preserved snapshots.
node tools/earth-sites.mjs --export ../RTSAI-WebGame/web/public/earth-sites
```

No collection or cloud write happens during a normal build. Expanding to tens of thousands of sites should replace the global overview with zoom-based static vector tiles or spatial chunks, keeping a small manifest and CDN delivery. Do not turn markers into Firestore documents or attach snapshot listeners to a site collection. Private annotations, if later added, belong in a separate bounded user feature.

Validation: `node tools/earth-sites-test.mjs` covers area reuse, one shared request per source, source failure retention, cancellation, lazy details, integrity assumptions and no Firestore calls. Manual browser verification checks the actual persistent database, reopening Cairo, export, map generation and the saved sidecar. The source metadata follows [OpenStreetMap attribution](https://www.openstreetmap.org/copyright) and [MediaWiki geosearch](https://www.mediawiki.org/wiki/API:Geosearch). [Firestore billing](https://firebase.google.com/docs/firestore/pricing) is why the public geographic catalog stays outside per-document database reads.
