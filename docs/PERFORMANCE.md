# Memory and drawing budget

Measured on 13 October 2026 with the live build (RTX 5090, 1080p, Chromium, three Saudi Arabia vs Iran skirmishes in a
row), before and after the fixes below.

| | Before | After |
|---|---|---|
| Sprite sheets on the GPU, matches 1 / 2 / 3 | 34 / 65 / 96 (592 MB / 1.09 GB / 1.58 GB) | 34 / 35 / 36 (447–479 MB) |
| Chrome's GPU memory, matches 1 / 2 / 3 | 0.9 / 1.54 / 2.17 GB | about 0.4 GB, flat |
| Left on the GPU after leaving a match | 31 sheets (496 MB) | 1 sheet per match played (16 MB, see below) |
| Frames drawn in a match (144 Hz screen) | 144 a second | 60 a second |
| Frames drawn behind the menus | 144 a second (the last battlefield, hidden) | none |

With Chrome's graphics acceleration off, WebGL is drawn on the CPU (WARP). There a match cost about 13.5 of 24 cores
before the fixes and about 8.3 after. An endlessly drifting menu backdrop alone cost about 8 cores there (about a quarter
of a core with the GPU): the backdrops now push in once and stay still, and `gpu.ts` tells players whose browser draws
without the GPU how to turn acceleration on.

## Rules the code now follows

- **Restored sprite sheets are freed with their map.** Sheets restored from the prebaked sprite cache
  (`SpriteStore.TryRestore`) belong to no `SheetBuilder`, so `SpriteCache.Dispose` never frees them. `SpriteStore`
  keeps them per cache, and `SimHost` releases them wherever a map is disposed (`DisposeMap` when another map is
  prepared, and `EndGame`). The page then deletes their GPU textures.
- **Texture ids are never reused.** The renderer remembers freed ids: a late upload for one is dropped (a sheet still
  downloading when its map went away). `SpriteBake.forget` also stops fetching it.
- **Stale samplers are not textures.** The engine rebinds only the samplers a batch uses, so the others keep whatever an
  earlier batch, even one from an earlier world, bound. `WebShader.TextureId` reports a disposed texture as unbound, and
  `drawCaptured` binds nothing for a freed id instead of skipping the batch. (Before these fixes, nothing was ever
  freed, so this never showed.)
- **Shipped sheets hold only their used rows.** About 46% of each 2048×2048 shipped sheet is empty. `uploadSheetRows`
  allocates only the used rows, and the combined fragment shader scales v by `uRowScale[sampler]`
  (full height / allocated rows). **Any new shader or pass that samples sprite sheets must apply the same scale**:
  the icon raster does, by scaling the cameo's uv. The voxel pass samples model sheets, which are never trimmed.
- **Draw only what can be seen, and only when it changed.** `Game.frame` draws only while the phase is `playing` (the
  canvas is hidden otherwise), at most 60 frames a second (`?fps=N` overrides; `?fps=0` draws every refresh), and
  skips a frame identical to the last one drawn (`Game.shouldDraw`: a new or still-interpolating tick, camera, overlay,
  canvas size, or `Renderer.version`, which every texture, sprite, shroud and model change bumps). A paused or idle
  view redraws 4 times a second as a safety net. The perf HUD's fps is now frames drawn.
- **Leaving a match clears it.** `SimClient` drops its snapshots and `Renderer.clearWorld` frees the terrain buffers on
  `end`. `setStartInfo` also frees the previous match's terrain buffers.

## Not fixed (known)

- **Voxel sheet after an overflow** (engine): `VoxelLoader` replaces its `SheetBuilder` when a voxel sheet overflows
  and disposes only the newest one, so the first voxel sheet (16 MB) stays allocated after each match with voxels.
  The fix belongs in the engine fork (`OpenRA.Mods.Cnc/Graphics/VoxelLoader.cs`).
- **The WebAssembly heap grows about 70 MB a match** (331 → 397 → 476 MB over three matches) while live managed
  objects stay around 90 MB. WebAssembly memory never shrinks, so a long session keeps the high-water mark.
