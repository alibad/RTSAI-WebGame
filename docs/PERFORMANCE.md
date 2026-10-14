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

## Starting a match without regrowing memory

WebAssembly memory grows but never shrinks, so the tab keeps the highest point any load reached. Each match start used
to rebuild the same large assets and raise that point: 331 → 397 → 476 MB over three matches. The timings now record,
for every timed load step, the WebAssembly memory after it (`mem.<step>`), what it allocated (`alloc.<step>`) and the
live managed memory (`live.<step>`). They showed that `new World` allocated about 165 MB every start: 85 MB to build
the tileset's tile cache (`TerrainRenderer`) and 79 MB to load every voxel model (`VoxelCache`).

- **Engine (`alibad/OpenRA` `53424ddb79`, on `rtsai/engine`):** `TerrainRenderer` shares one `DefaultTileCache` per tileset across worlds, counting its
  users; `VoxelCache` shares its loaded models while the model rules are the same and the map ships no `.vxl`/`.hva`
  of its own. The last cache used is kept for the next world; one no world uses is freed when another replaces it.
  `VoxelLoader` also disposes the sheet builders it retires on a sheet overflow (the first voxel sheet used to leak,
  16 MB per match).
- **Web sim:** `SpriteStore` keeps the last restored packing for the next map with the same reservation key: same
  sprites, same sheets, already on the page's GPU, so the restore and the page's re-download and upload are skipped.
  `EndGame` clears every static reference into the ended world (the snapshot's renderables and view actors, spawned
  actors, sandbox and AI lab players, the map behind `MayReopen`) before its full collection, reported as
  `retainedAfterEndMB` in the engine's stats. A prepare starts from a collected heap (`prepare.collect`) and a start
  ends with one (`start.settle`).

Measured on the same build, six 15-second skirmishes in a row: WebAssembly memory 331 → 397 MB, then flat (it was
331 → 397 → 476 MB, then flat). From the second match on, world creation allocates nothing and takes about 30 ms
instead of about 900 ms; Start to playing went from 2.2 s to 0.4 s. SyncHash is unchanged on battle-50,
hezbollah-swarm and battle-originals at 1500 ticks, and random-map ids are the same.

The rest is the garbage collector's normal working size: with `soft-heap-limit=200m` (`worker.ts`), the heap may
grow to about 200 MB of objects between full collections during play, and long runs of 200-unit battles still reach
476 MB. A lower limit (128m) kept skirmishes at 331 MB but made the battle's ticks about 40% slower, so the default
stays. `?gc=` overrides it.
