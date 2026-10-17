# Resource editing

The ore/gems palette uses its content height, as does the start-position tip. It must not cover the map with a full-height empty panel.

The native resource layer allows resources on flat clear, rough and road tiles. It rejects slopes and unsuitable terrain. The editor reports the changed tile count after each stroke, or explains a blocked placement, rather than silently doing nothing. Ore and Gems retain their distinct native resource indices and art.

Choose a round brush diameter of 1, 3, 5 or 9 cells in the resource palette (5 by default). The width persists when switching between Ore, Gems and Flatten ground. Arrow keys and Home/End operate the width choices; the pointer guide shows the approximate projected brush size at the current zoom. The native terrain hit test determines the actual cells.

Flatten ground samples the height at the start of the drag, gathers the dry cells along it, then levels the patch on release. It replaces sloped or unsuitable ground with the tileset's flat clear ground. A small apron is fitted with native ramp tiles to join the plateau to the surrounding terrain. Water, shores, actors and resource fields outside the painted area are protected. If the level cannot be joined, the stroke restores its original terrain and explains why. One undo restores the tiles, elevations and resources of the complete stroke, including its apron. Both game modes use their own default terrain.

Pointer input captures buttons/modifiers at enqueue time. Moves can coalesce within a stroke; down/up remain ordered. Native resource strokes sample the segment between moves, including the release point, so fast dragging paints continuously. A stroke remains one undo action. Save, download, undo and brush changes wait for queued pointer input. Download saves dirty edits even when an older saved copy exists.

Undo, redo and deletion also mark a saved map dirty, so downloading after undo exports the currently visible terrain rather than an earlier save.

Checks:

```
node tools/editor-pointer-test.mjs
websim editorresourcetest --root <local native VFS>
npm --prefix web run build
```

Browser acceptance: preserve and open the player's Cairo map; confirm the compact panel; choose a large width; flatten a patch, then drag Gems across it. Inspect the purple field and changed counts, undo/redo, then save/download/reopen and verify resource type 2 and edited terrain remain in map.bin. Check width selection with keyboard navigation and confirm the guide follows zoom. The native regression also verifies the complete 69-cell footprint, exact hillside restoration and resource placement on prepared ground.

The local preview requires the rebuilt native/WASM resource-feedback code as well as the frontend. Its build artifacts are separate from the accepted launcher payload; development here does not deploy the public game or alter launcher registration.
