# Public co-commander: strategy adviser

The web game presents one **Built-in adviser** switch with an explanation. Local AI and Scripted are not player
choices, including on localhost; saved choices from older versions migrate to the browser adviser. Settings name
the behavior explicitly: Off, Suggest orders, or Apply automatically. Model/mock hooks require a Vite developer
server with `VITE_COMPANION_DEV_TOOLS=1`; production builds always use the built-in adviser.

Local tooling reports `localAI.ready` only after real local chat inference, Kokoro speech generation and Whisper
transcription succeed. Service health or model filenames alone are not readiness. A check expires after a minute;
stopped, hosted, mock and failed model services never report Ready. Web play does not start or check local models.

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

## Campaign missions

In a campaign mission the adviser plans around the mission (`web/src/mission-adviser.ts`); skirmish keeps the
adviser above, unchanged. It reads, all page-side:

- the mission definition the engine publishes with the setup data (`setup.missions`, `Missions.CatalogJson`): each
  objective's kind, targets, route or lanes, gates (`requires`, `after`), deadline (`limit`), radius, count and
  secondary flag, and the mission's sensors and events;
- the live state in `ui.mission`: each objective's status, whether a gate holds it (`waiting`), its progress line
  (time left), and the ids of the events fired;
- the mission map's actors, read once from the game files (`map.yaml`, the worker's `missionMap` request): where
  every named place, target and route waypoint is. A map actor's id is its index in the file plus a constant the
  engine adds; the planner finds that offset from the actors in sight, so it can name targets the observation does
  not list (a neutral building to capture);
- the native observation, now also decoded for world positions, speeds, capture and C4 targets, current targets and
  the engine's cell grid (passability and what is in sight).

Sensor zones: the page draws the rings from the masts' own conditions, but nothing about their state reaches the
page otherwise. The planner recomputes each sweep exactly as `Missions.cs` does (on for the first `sweep[0]` seconds
of each `sweep[0] + sweep[1]` cycle, shifted by `offset`) from the game tick, and counts a sensor tripped once its
`detected` event fired and gone once its `killed` event fired. Distances are the engine's (world units / 1024, the
unit of every radius in the mission JSON); on the isometric maps a map cell is 1448 by 724 world units.

Each step, in order: units in a zone about to sweep get out; units leave a surveillance area before its sweep
(`disperse`); a badly hurt unit the mission needs pulls back; what the mission protects (and the base, and convoys
in sight) is defended; special errands run (a specialist to its node, deployed there; vehicles through a gate);
scouts go to places not seen yet; the army takes the focus objective: reach (the whole force, then units of the
right type step inside the radius), destroy (nearest target first, C4 from commandos, focus fire on buildings that
do not shoot back), capture (the army clears the place, engineers come up behind and capture by actor id), escort
(a step ahead of the leading truck; a civilian convoy's road is swept ahead), shipping and survive (hold, defend);
when only gated objectives remain it prepares for the next one (holds the convoy's road, clears the defences around
a sealed target, gathers by the base). With a base, it alternates with the economy: the skirmish adviser's, plus
what the objectives need (build objectives and their prerequisites from the production menu, an engineer for a
capture, the units a reach objective names) and, when money piles up, more infantry and up to three factories.
A mission with a base waits for 6/8/10 fighters (easy/normal/hard) before striking a defended objective. In a
mission the co-commander looks every game second (every real second at normal speed, more often when a test runs the
game faster); skirmish keeps one look a second.

Stealth (an `undetected` objective): every move is planned on the cell grid round zones that never sleep and,
where it can, round sweeping ones; a group walks to the edge of the next zone and crosses only when the sweep stays
asleep from the moment the fastest unit could enter until the slowest is through (with the order's delay at the
game speed). Waypoints keep both of the engine's bent paths between them clear of zones. A team without a base
(Glass Island) moves in step; its fighters clear guards in sight while the specialist holds or steps back. When
staying hidden is a bonus objective, units on a required errand keep going.

Contacts (sensors that are enemy units, not masts or markers: Act IV's Ghosts on the Glass, where six of nine are
phantoms and firing on an unverified phantom fails the mission) are verified before anyone fires on them: while any
is unverified, armed units are set to return fire only, units move instead of attack-moving, guards are attacked by
name, defence never targets a contact, no new guns are built, and one unit goes within each contact's radius (a
contact out of reach is not tried again). Once every contact is verified, units fire at will again. Captures take the
places not yet ours, the least defended first (Sweet Water's power station before the pumps), and the economy trains
an engineer for each place still to take.

Lines are short and stay the same while nothing changes, so Suggest shows the next objective-driven step: "Find
the first group of survivors at the cove: send 12 units there (3 must reach it).", "Take the Network Technician to
the core node and deploy it: hold at the edge of the bluff mast's zone and cross while it sleeps.", "The curtain
control is clear: send your Engineer to capture it now." The mission's unit orders (move, attack-move, attack,
capture, C4, deploy, stop, stance, queued waypoints) go through the same confirmation and native checks as every
proposal; `target_actor_id` and `queued` are now encoded.

`node tools/mission-adviser-test.mjs` checks the planner on synthetic observations; `node tools/chapters-playtest.mjs`
plays the real missions with the co-commander in Auto (see FACTIONS-MISSIONS.md).

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
