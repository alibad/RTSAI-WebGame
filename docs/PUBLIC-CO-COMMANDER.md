# Public co-commander: strategy adviser

The browser strategy adviser reads the native `CompanionRpc.Observe` observation and ports the existing
Python `Advisor.next_step` and `assess_threat` algorithms. Suggestions cover MCV deployment, ready-building
placement, power, the opening economy/production order, harvesters, radar, army production and visible threats.
Names and build availability come from the game; compact role/queue metadata comes from the generated companion
tech tree (`node tools/sync-adviser-tree.mjs`). There is no model API, companion server or additional model download.

The adviser is on by default in public single-player games. Apply or J confirms the displayed proposal (G is
RA2's Guard). Cancel dismisses it until the situation changes or the player asks for another suggestion. The feed
explains the recommendation. Game settings → AI co-commander chooses Off, Suggest or Auto; the setup switch turns
it off too, and the choice persists after reload. Off ends the adviser at once. Auto confirms each proposal as it
is made, through the same path as Apply, and once more after a pause. Turning it back on mid-match works only in
a match that started with it; otherwise it starts with the next match.

Every confirmation re-observes the current world and recomputes the advice. Its decision key and complete
command set must match the displayed proposal. The native executor then checks the player, ownership,
production, legal placement, tick freshness and request ID before issuing ordinary recorded player orders.
Duplicate inputs, cancelled/expired proposals, changed worlds, replay/spectator views and multiplayer cannot
apply these proposals. Pause disables confirmation. Success is reported from a matching native receipt;
a missing receipt blocks further proposals until the player reviews the outcome.

## How production ended up without it

- 7 October 2026, `fa72bc0`: the browser's local Python companion worked, while its static public builder
  explicitly excluded the companion service. Local and public were different delivery scopes.
- 9 October, `09eb8da`: static builds explicitly set `ccAvailable=false` and hid the controls.
- Later that day, `e8bc05c`: G confirmation was added to local recommendations; it did not add public execution.
- S06 acceptance checked local suggestions separately and expected the public static build to omit companion
  controls and reject local routes. S10 preserved that split. Production checks verified route denial rather
  than the expected public suggestion/confirmation experience.
- The 12 October repair badge update preserved that content and feature split; it did not delete the adviser.

The release completeness mistake was treating successful local companion checks and a companion-free public
build as sufficient evidence for the public co-commander experience. Public acceptance now requires an actual
visible recommendation, explicit confirmation and a matching native order receipt in both game modes.

## Local verification

`node tools/adviser-test.mjs` compares decisions and commands against the real Python adviser across the generated
faction profiles and Classic. `node tools/browser-adviser-test.mjs --url <static-or-public-url> --out <fresh-directory>`
checks both modes against the actual native AOT engine: no unconfirmed orders, fog, J/G, repeated keys, pause,
placement, stale proposals, cancel/reoffer, world replacement and persisted opt-out.

`tools/static-modes-test.mjs` keeps mode switching, campaign starts, embedding and local-service route denial covered
while requiring the browser adviser to be available. Physical iPhone/Safari acceptance remains a separate check.

The full local neural/text/voice companion is preserved. Hosted conversational model inference remains separate
integration work; the public strategy adviser makes no claim to supply it.
