# Earth map dependencies

Build battlefield uses geographic terrain: roads, water, land cover and buildings from OpenStreetMap.
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

The Hormuz suggestion opens a 120 km square instead of a small offshore box. Click the map or drag its center
marker to relocate it; Use view center also supports keyboard users after map navigation. Show whole area fits
the selected square beside the panel, including on phones. Widths range from 3 to 120 km. Regional widths
(60/120 km) are currently available only inside the packaged Hormuz coverage (53–60°E, 24–29°N).
The 80 × 80 physical game grid compresses regional detail; the UI displays the resulting scale.

Hormuz coastlines use a packaged, clipped Natural Earth v5.1.2 1:10 million land dataset (public domain).
`tools/import-hormuz-land.py` reproduces it from the upstream file and verifies its SHA-256. The source URL,
checksum, scale, coverage and license are recorded in `RTSAI-Web/data/hormuz-land.json`. This is generalized
regional geography, not a navigation chart. Optional live terrain details have a 12 second deadline there;
an empty or failed provider response cannot remove the packaged land/sea geometry. Coastlines and islands
stay intact: the compiler chooses bases on existing land, adds no land border/corridor across the sea, and
reports disconnected coasts honestly. Offshore areas too small for bases offer move/enlarge guidance.
Regional maps open in the native map editor; the quick land-attack mission is unavailable for them.

The site query now includes nodes, ways and relations for ports, seamarks and airports. Regional Wikipedia
searches sample the center and four points across the area, rather than a single offshore 10 km lookup.
Two geographic airport references are included with exact article revisions, coordinates and a checked date;
they stay available offline and are explicitly labeled references, not verified current operations.
IMO/UKMTO links provide separate dated scenario context, including IMO's 17 April 2026 discussion of mine
hazards. News and advisories do not automatically become verified minefields, unit positions or objectives.

`tools/earth-region-browser-test.mjs` builds the real packaged Hormuz geography with zero live mapping features,
opens it in the native WASM editor, and checks movable selection, the offshore error, phone and RTL layout.
`RTSAI-Web/tests/earth-region.test.ts` checks known sea/land points, the absence of fabricated land crossings,
valid starts, regional query limits and coverage. The original land-map compiler still passes Python parity.
