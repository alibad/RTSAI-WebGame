# Choose a place and play

Main menu → **Play a real place**, or `?profile=public&mode=earth` (also the older `mode=map-studio` link).

1. Search for a city or landmark and choose a result, or click the interactive globe. Search only runs on submission; it does not send every keystroke.
2. Explore with drag/zoom, click to move the center or drag its marker, choose a footprint, and use **Show whole area**. **Choose view center / Use view center** provide a keyboard-accessible alternative. Satellite and attributed OpenStreetMap street layers are available.
3. **Generate battlefield** runs the existing Earth compiler, imports geographic evidence, attempts terrain relief, and mounts the map in the engine and browser library.
4. Choose your nation and enemy AI, then **Play skirmish**. It starts a regular match directly, without reloading or passing through the editor. Editing and optional site missions remain available.

Search is Nominatim-backed, with up to five results, duplicate-label removal, cancellation, timeout, a shared rate limit with country lookup, and a small session cache. Errors leave map picking and presets available. Imagery, search, geographic evidence and elevation depend on their public providers; the generated battlefield is a gameplay interpretation, not a reproduction of every real feature. Public requests never use browser geolocation.

Verification: `node tools/place-search-test.mjs`; `npm --prefix web run build`. Manual local browser QA covers live Cairo search, satellite/street layers, footprint choice, generation and direct engine launch; desktop and 390px phone expanded themed nation pickers. No runtime rebuild is needed for these frontend changes. The development preview uses existing accepted local runtime/data; it does not replace the accepted launcher registration or deploy the public game.
