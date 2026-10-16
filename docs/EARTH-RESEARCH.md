# Earth map dependencies

Build battlefield requires geographic terrain features: roads, water, land cover and buildings from OpenStreetMap.
Elevation tiles start in parallel with that request and have a bounded fallback to level ground.
The native compiler/editor still validates the generated map and player starts.

Nearby-site research is optional. Mapped military/transport sites and Wikipedia geosearch run independently,
publishing partial results. Article titles and coordinates appear before summaries, and summaries run concurrently.
Those results supply mission targets, descriptions and suggested nations; they do not gate map generation.
Known site coordinates can reserve level ground during elevation shaping, but an unfinished lookup is never awaited.

Optional requests have deadlines (mapped sites 15 seconds, Wikipedia search 12 seconds, summaries 8 seconds).
Changing the place or footprint cancels the previous research, and closing the studio cancels research/build callbacks.
Late results cannot overwrite manually chosen nations. Mapped site cards remain available as articles arrive.

`tools/earth-async-browser-test.mjs` holds public-source responses locally and verifies that real terrain compilation,
map registration and WASM editor opening proceed independently. It also covers concurrent summaries, partial results,
stale-place cancellation, manual choices, and unavailable sources ending the spinner. Its geography and imagery are
synthetic fixtures, not a check of an external provider's current accuracy or availability.
