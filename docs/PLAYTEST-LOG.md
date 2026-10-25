# Playtest log

What the owner saw while playing, what we found, and what shipped. One entry per report, newest day first. A report
stays open until the fix is live on rtsai.net/play or the cause is shown to be outside the game.

## 26 October 2026 (owner, live page ae730bf, RA2 mode, the original Allied country)

| # | Report | Finding | Status |
|---|---|---|---|
| 1 | No music can be heard; the Now playing panel shows "Grid Assault" playing | The game produces sound: on the same build, served locally and started by script, the music bus carried a signal (level 0.066 RMS on both the music and the master bus, audio context running, clock advancing, track Grid Assault). The panel's "Now playing" state means the stream is active, unmuted and the context is not suspended. Silence after that point is the browser's or machine's output: the tab's mute, Chrome's site sound setting, the Windows volume mixer entry for Chrome, or the output device (an HDMI monitor without speakers). | outside the game; owner to check the output side |
| 2 | The Allied ore refinery is drawn over the docked ore truck; the truck should be on top | under investigation (refinery dock offset and sprite z-order) | open |
| 3 | "Malformed rocks": a rock/rubble piece in a forest renders as a flat brown smear | under investigation (scenery sprite, palette) | open |
| 4 | A trail of yellow ellipses behind a ship in water | under investigation (LeavesTrails image/palette) | open |
| 5 | On a loaded map the undiscovered area's top edge is exposed: a strip of terrain shows above the black | Known engine behaviour on random maps: the generator keeps the playable bounds `1 + MaximumTerrainHeight` rows below the map's top edge (Terraformer.InitMap), but the rows above the bounds still get terrain with height, and a cell at height h draws h rows higher on screen. The top rows' high ground therefore draws above the shrouded area, where no shroud tile exists. Fix candidates: flatten the rows above the playable bounds in the generator, or clip terrain drawing to the projected map rectangle in the renderer. Both are engine changes and need a runtime release. | open, engine |
| 6 | Shots seem to land in the wrong place (Grizzly firing at an IFV, a fireball drawn at the Grizzly) | under measurement: impact-effect position versus target position per shot | open |
