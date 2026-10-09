# Browser resource fields

The browser snapshot now captures the native ResourceRenderer and SmudgeLayer terrain sprite layers. These were previously omitted: only the ore-mine actor appeared while the harvestable gold field was invisible. Engine-computed density, depletion and fog memory are retained. The ground batches use reserved byte 10 in the existing 44-byte capture record and render before foreground actors and the terrain depth clear. Empty cell quads are omitted from snapshots.

The headless viewport is independent of the browser camera, so snapshots read the full occupied engine layers rather than applying headless viewport culling. Gameplay and resource values are unchanged; all art remains project-authored.

Validation: frontend typecheck and build; interpreter resource preview with 306 resource quads; moving dog collected a crate at tick 91 (spawned at tick 0), increasing cash from 5000 to 5500; existing 16-position terrain-clipping and movement regression passed. Screenshot: `artifacts/resources/ore-fields.png`.

Crates are already part of the game. Enable Crates in skirmish options. The normal rule delays the first spawn by 1000 ticks (40 seconds at normal speed), then uses a 3000-tick interval. Infantry and appropriate vehicles collect crates by moving over them. Current rewards include cash, veterancy and map reveal. The collection fixture uses an explicitly placed crate with automatic spawning disabled to test collection separately from scheduling.

Production runtime must pass the static-browser test before release. The SDK lean/IL-stripped publish produced assembly-integrity mismatches during validation, so this release uses the previously validated RuntimeVariant=none configuration. The failed optimized output is not deployed.
