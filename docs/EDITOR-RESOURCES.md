# Resource editing

The ore/gems palette uses its content height, as does the start-position tip. It must not cover the map with a full-height empty panel.

The native resource layer allows resources on flat clear, rough and road tiles. It rejects slopes and unsuitable terrain. The editor reports the changed tile count after each stroke, or explains a blocked placement, rather than silently doing nothing. Ore and Gems retain their distinct native resource indices and art.

Pointer input captures buttons/modifiers at enqueue time. Moves can coalesce within a stroke; down/up remain ordered. Native resource strokes sample the segment between moves, including the release point, so fast dragging paints continuously. A stroke remains one undo action. Save, download, undo and brush changes wait for queued pointer input. Download saves dirty edits even when an older saved copy exists.

Checks:

```
node tools/editor-pointer-test.mjs
websim editorresourcetest --root <local native VFS>
npm --prefix web run build
```

Browser acceptance: open the preserved Cairo map; confirm the compact panel; click/drag Gems on flat ground, inspect the purple deposits and changed counts; undo/redo; try a slope and read the feedback; save/download/reopen and verify resource type 2 remains in map.bin. Check the compact palette at phone width too. Preserve the player's map before testing.

The local preview requires the rebuilt native/WASM resource-feedback code as well as the frontend. Its build artifacts are separate from the accepted launcher payload; development here does not deploy the public game or alter launcher registration.
