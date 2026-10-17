# Bridge artwork and editor previews

The editor previously requested production cameos for every actor. Bridge pieces,
trees and other scenery commonly have no cameo, so their cards were text only.
The standalone mod also still used brown rectangular stand-ins for bridge sprites.

The editor now requests the native `EditorActorPreview` sprite composition on
demand, in batches of up to 60. Cards preserve sprite offsets, scale, alpha and
palette, then crop transparent margins for readability. Results are cached per
map and owner. Actors rendered only as voxel models retain their cameo fallback.
Native previews do not place actors or modify editor history.

The canonical mod supplies 21 original bridge sheets from
`RTSAI-Mod/tools/standalone-bridges.py`, with per-file hashes in
`mods/rtsai/standalone/bridges/PROVENANCE.json`. The geometry uses the terrain's
30-by-15 pixel cell basis and native sequence names. No input images are used.
Concrete and wood spans, both axes, bank ramps, broken spans, elevated scenery
and a repair hut replace the old rectangles. Broken sprites expose the gap.

Native ground-level bridges already provide connections, passability, demolition
and repair. This change reuses those traits. A span opens its footprint over water;
removing it closes the crossing; repairing a destroyed span opens it again.
Ramps and spans must be aligned and connected to suitable banks.

Elevated actors are still native scenery placeholders. A playable elevated bridge
also requires map-level `ElevatedBridgePlaceholder` definitions for its location,
orientation, length and height. The palette explains this limitation; placing an
elevated actor alone does not create a traversable bridge.

## Verification

`websim editorbridgetest --root <unpacked-public-vfs>` checks all 21 bridge previews,
all editor actor preview requests (713 in the current public catalog), placement,
undo, redo and map export, plus tracked-unit passability before, during and after
native bridge removal and repair. Build the host from verified private inputs.

Browser QA covers actual Cairo placements and undo, preview pictures, material
and orientation labels, and the owner picker. Local preview artifacts record
their source snapshots and inherited content bundle. This work is local only.
