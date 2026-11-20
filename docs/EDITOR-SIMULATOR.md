# Map editor and battle simulator

14 October 2026. Two modes on the main menu replace the Scenario workshop, the arena practice drills and the local
Map workshop panel. Both run the engine's own code in the browser; nothing is a separate app.

## Map editor (`?mode=editor`)

The engine's editor world (`WorldType.Editor`) runs in the web sim: `sim/OpenRA.WebSim/Editor.cs` drives the
desktop editor's brushes (`EditorTileBrush`, `EditorActorBrush`, `EditorResourceBrush`, `EditorDefaultBrush`) and
its `EditorActionManager` (undo/redo) through a headless `EditorViewportControllerWidget`, so painting, placing,
selecting and deleting behave as in the desktop editor. Changed terrain rows go to the page as vertex bytes
(`renderer.updateTerrainRows`); actor previews render from `EditorActorLayer`.

- Start: a blank map (64, 96 or 128), any map in the game (or a random one), an `.oramap`, or **From a real place**.
- Lake and river brush (Terrain → Water, `sim/OpenRA.WebSim/WaterBrush.cs`): a stroke paints open water while it is
  dragged; on release the session's water is retiled the way the random map generator paints coasts (a smoothed land
  plan whose borders the Terraformer tiles with the rules' `Segmented` shore pieces), so water gets beaches. Strokes
  that touch merge, with each other and with water already on the map; ore under the water goes; water keeps to the
  level ground where the stroke starts (shore pieces are flat). One stroke is one undo step.
- From a real place (`web/src/ui/EarthStudio.tsx`): a globe; search or pick a place, choose a footprint, scan it.
  The scan lists military sites, airfields and ports from OpenStreetMap (Overpass) and nearby Wikipedia articles,
  and works out the militaries there (`web/src/forces.ts`: forces the sources name, else the country's; the attacker
  is the defender's named or regional rival). They prefill the mission's sides, with the reason shown; any two
  nations can be picked.
  Build runs the website's Earth compiler (imported from RTSAI-Web via the `@site` alias). **Create & edit map** opens
  the map in the editor. **Create a mission here** (land areas; not the regional coastline maps) builds the same map
  and stays on the screen for the mission step: defend or attack, the two sides, then Start mission, with Play
  skirmish and Edit this map beside it (`tools/earth-mission-browser-test.mjs`).
  **Start mission** turns a scanned site into a battle between any two nations (`web/src/mission.ts`): the
  defender's base on the site from its own roster, armies even in strength (`web/src/strength.ts`: health and
  weapons from the rules, `Ui.AppendCombat`; Lanchester's square law, so an older army gets more units), air defence
  for the defender when the attack brings aircraft (or no aircraft), and the attack from the farthest start position.
- Save writes the map with the engine's `Map.Save` into IndexedDB (`rtsai-maps`) and mounts it, so it appears in
  the simulator and skirmish map lists; `.oramap` downloads the same package. Test in simulator opens it there.

## Missions from a real place (operations)

"Start mission" in the Earth studio opens the simulator with an operation (`web/src/mission.ts` `missionOperation`).
Its briefing is written from the analyst's intel: the place's description, who holds it, who attacks and from where.
The campaign's objective code runs it in the engine (`Missions.StartOperation`); the targets are named placements
(`ConstructionYard`, `WarFactory`).

- **You defend:** hold the site for 5:00 and keep the construction yard standing, with keeping the war factory as a
  bonus. The attacker's waves come from the far start position. While the clock runs, the attacker is reinforced as
  soon as it is down to its last few units, so the engine never ends the match early as a conquest. The garrison
  starts 40% stronger than the first attack.
- **You attack:** destroy the construction yard, with the war factory as a bonus. The defender's AI builds from its
  base.
- Radio calls play on the campaign's radio panel (`radio.ts` `setOperation`). The enemy skill sets the difficulty.
  "Free battle" drops the objectives but keeps the forces.

## Battle simulator (`?mode=simulator`)

- Pick a map (or a random one), each side's nation and the enemy AI's skill (Easy / Normal / Hard / Brutal: the
  engine's bots with the mod's handicap and bonus cash, `web/src/sandbox.ts` `AI_SKILLS`).
- Drop units: the drawer lists each nation's roster from the rules' prerequisites (`Ui.Rosters`); hovering a unit
  opens its card with the website's Faction Viewer stage (`web/src/ui/FactionViewerStage.tsx`) and the engine's
  stats (`unitinfo`). Or describe the battle ("8 Abrams against 10 Karrar") and the planner lays it out
  (`web/src/battle-plan.ts`).
- Fight starts a bare scenario: no starting units, the placed actors, starting money. You command your side with
  the full HUD (production, power, selection, orders); the AI commands the other. Edit returns to the layout.
- Placing: a card picked from the palette arms a brush (`sandbox.ts` sends `brush`; sim `SandboxPlacement.cs`). The
  engine draws it at the cursor as a match draws placement: a building's green and red footprint with the building
  see-through (red where it can't stand), units see-through on the cells they would take. One rule
  (`SandboxPlacement.Where`) decides the preview and the click (`spawn`): no building on water, cliffs, slopes or
  other actors; units on cells their locomotor can enter, moved to the nearest free ones. A click answers with a ring
  and a sound where it landed, or a red mark with the reason ("Not on water"). Right-click on open ground or Esc puts
  the brush down. Building cards show the building as the battlefield draws it (`preview`), not the cameo.

## Grid (16 November 2026)

The Grid button (`web/src/ui/GridToggle.tsx`) on the battle's top bar, the simulator's setup bar and the editor's bar
outlines every map cell, so a battle reads as a board you can count and measure. The owner liked this about the old
website Workshop's map. The page draws it (`web/src/render/grid.ts`) from the terrain the engine laid out: each cell's
tile ends at the bottom corner of its diamond, which gives that corner's height, and every other corner is another
cell's bottom corner. So slopes come out as one mesh, and cliffs (more than two height levels) as a clean step. It lies
over the ground, under every unit and under the shroud; Classic's square maps get square cells. The choice is kept in
the preferences (`rtsai.preferences.v1` `grid`). It needs no runtime change.

## See inside a fight (20 November 2026)

The owner's first pick from the old website Workshop (16 Nov): see what is happening in a battle and why. All of it reads
what the engine already sends: no runtime change.

- **Battle board** (`web/src/ui/BattleBoard.tsx`, the Board button, open by default, kept in the preferences). On the
  left, in setup and in battle; hidden during an operation, which has its own objectives panel.
  - In battle: each side's units alive, health left, shots fired, damage dealt and units destroyed, the battle clock and
    the first loss, as the engine measures them (`sim/OpenRA.WebSim/Sandbox.cs`, `ui.sandbox`).
  - Who fell when: each unit lost with the battle clock, newest first (a unit dying, or gone from the battlefield).
  - The field: both sides' actors by type, with the cameo and alive/total, one pip per unit filled to its health,
    crossed out when destroyed. A row or a pip moves the camera there and opens the unit's card.
  - Sides: the world's first two playable players are side A (you) and side B (the enemy), as the scenario sets them.
- **Unit card** (`web/src/ui/Inspector.tsx`). A left click on any unit or building of either side, in setup or in
  battle, opens the palette's card (`UnitCard`: picture, story, the engine's cost, health, armour, speed, sight and
  weapons) with this one's live health, rank and, in battle, its type's shots, damage taken and how many are left. It
  stays on a destroyed unit, steps aside for the victory or defeat screen, and lets go when a new world starts.
- **Ranges** (the Ranges button, battle bar and simulator setup bar, kept in the preferences): every playable side's unit
  gets a ring on the ground at its longest damaging weapon's range (the engine's `unitinfo`, asked once per type), in
  its owner's colour (`Renderer.drawReach`, `render/grid.ts` `ringLines`). The inspected unit's ring is always drawn,
  thicker. A world circle is drawn as the ellipse the engine draws (tile px per 1024 world units on each axis).

## The other three picks: saving, the ground, one unit (20 November 2026)

The owner's other picks from the old website Workshop (16 Nov). Page only: no runtime change.

- **Random maps, chosen** (`web/src/ui/RandomMapMaker.tsx`, on every map strip). The random map tile keeps its one
  click; "Choose landscape" under it opens a chooser: nine landscapes as pictures (each a map the generator made,
  `web/public/menu/landscapes`; remake them with the generator when its landscapes change) or Surprise me, the size,
  how much ore and the seed. The same four always make the same map (`MapGen.cs`), and a random map's entry shows its
  landscape and seed.
- **Battle setups** (`web/src/battle-setups.ts`, `ui/BattleSetups.tsx`, the setup panel's Save / My battles / Copy link).
  - Save keeps the setup in this browser (`localStorage` `rtsai.sim-setups`, 40 at most): the map, both nations, skill,
    money, fog, each side's order, and every placed unit with its rank, health and its own order if it has one.
  - Copy link gives the setup as `?mode=sandbox&s=`. A random map travels as the request that made it, in the optional
    field `gen` (the page makes the map again when it does not have it: `App.tsx`); a map from the editor or a real
    place exists in one browser only, and the note says so. Links without `gen` open as before.
  - A kept setup stores a unit's order only when it is its own (`collect(true)`), so the side's order can still be
    changed after an undo or after opening a saved battle. A link carries every order.
- **Edit map** (the battlefield card, beside Change; `App.tsx` `editMapFromBattle`, store `battleReturn`). The battle is
  kept whole, the editor opens on its map with "Back to the battle" as its primary button, and the battle is laid out
  again on the map that comes back: the same map when nothing changed, a saved copy when the ground did. Units with no
  room any more stay out and the setup says how many (`Sandbox.restore`).
- **Undo and redo** (the setup's top bar, Ctrl+Z and Ctrl+Y; `Sandbox.undo`, `redo`, `apply`). Each placement,
  removal, Clear side, Clear all, plan and what-if is one step (80 kept). Units are taken out and put back in place;
  when a building has to come back the editing world is rebuilt from the placements, the only way onto its exact cells.
  A new map, nation or saved battle starts a new history.
- **One unit's what-ifs** (`web/src/ui/UnitWhatIfs.tsx`, on the unit card in setup): rank, health (10 to 100 percent),
  team, a first order of its own (Engage, Hold, or Move to a clicked point; it outranks its side's), Duplicate and
  Remove. They go into the fight as spawn values (`Scenario.cs` `SpawnSpec`). Still to do, in the engine: one
  building's power switched off, and weapon bonuses.
- **After a battle** (`ui/Outcome.tsx`): in the simulator the result offers Look at the battle (it steps aside for the
  timeline and the board), Save replay, Run again and Back to setup. If a battle's world closes under the simulator by
  any other road, the simulator goes back to the setup (`App.tsx`).

## Replay and Play from here (20 November 2026)

The owner watched a battle and found that moving back and forth showed the wrong moment, that Live was unclear, and
asked to start a game from any moment of a replay. Page only (`web/src/sandbox.ts`, `game.ts` `sendView`,
`ui/Simulator.tsx` `Timeline`): no runtime change.

- **What was wrong.** (1) The engine puts only what is in the page's view into a snapshot (`Snapshot.SetView`, sent by
  `game.ts` `sendView`), so a recorded tick held only what the camera saw then: units that walked off screen were not
  in the replay at all, and looking elsewhere showed empty grass. (2) Every snapshot was recorded, including those of a
  stopped game (the pause, each camera move while stopped), so looking around while scrubbing added copies of one
  moment to the end of the timeline, and a later position could be an early moment seen from somewhere empty. (3) The
  score, the board and the unit card read the live game, which stops where you started scrubbing.
- **Now.** While a battle runs the page asks for the whole battlefield (`Sandbox.fieldView`), so every tick holds every
  unit. One snapshot is kept per tick (a stopped game's snapshot replaces its tick's). Beside each tick the page keeps
  the HUD's readout of that tick (`ui.sandbox`, the money), so the score, the board's readout and field, and the unit
  card show the moment on screen (`battleStats`, `Sandbox.replayFrame`). A seek moves the camera to the moment's units
  when none of them is on screen, or, while the camera is still where a seek put it, when most of them are off screen
  (it follows the action as you drag, until you move it yourself); playback leaves the camera alone. The clock is the
  game's own tick (25 a second).
- **Live.** The timeline's right end is the battle still being fought, marked with a red "Live". Left of it, "Jump to
  now" (the skip-forward button where the mark was) goes straight back and on; Play runs from the moment shown into the
  live battle; the live battle waits, paused, while you look back.
- **Play from here** (`Sandbox.playFromHere`). A new battle from the moment on screen: every unit of both sides on the
  cell it stood on, with its facing, health, rank and deployed state (an infantryman whose body sequence is empty is
  dug in), its own opening order and name from the battle's setup (matched on the first tick by type, side and cell; a
  unit made during the battle takes its side's order), and the money you had then. Buildings keep their exact cells
  (they never move). It starts at once; Edit opens it as a setup, and the address becomes its `?mode=sandbox&s=` link
  in the existing format (no new fields).
- **Not carried, because the engine does not tell the page** (each needs a runtime change and a full release: a
  `state` command in `Ui.cs` and a `subcell` field in `Scenario.cs` `SpawnSpec` passed as `SubCellInit` in
  `SimHost.SpawnActors`): the order a unit was carrying out at that moment (a unit you commanded mid-battle goes back
  to its opening order), the AI's own money (both sides get yours), passengers inside a transport, and an
  infantryman's place inside a shared cell (extras stand on the nearest free cells, at most a cell or two away).
- **Cost.** A snapshot of the whole field is bigger than the view's; a simulator battle is small, and the recording
  was already capped at 8 minutes of ticks.

## Data and building

The page imports website source (RTSAI-Web: the Faction viewer components and the Earth compiler). The build finds
it at `RTSAI_SITE_ROOT`, else beside this checkout (or beside a parent folder), and stops with a clear message when
it is missing. When `web/public/viewer/` (ignored) is missing, the build writes the viewer data itself
(`tools/sync-viewer.mjs`, the website's `scripts/export-viewer-data.mts`); delete it to refresh. The build records
the website's commit as `import.meta.env.VITE_SITE_COMMIT`. In production the cards' art comes from the website's
own `/art-lab`, `/faction-art` and `/units` paths on rtsai.net; locally the server serves them from
`RTSAI_SITE_PUBLIC`.

Earth maps read OpenStreetMap ways and, since 14 October, multipolygon relations (lakes such as Lake Timsah) and the
sea, drawn from coastlines (the Suez Canal's banks are coastline): RTSAI-Web `lib/earth-evidence.ts`.

## Checks

Simulator placements start as completed actors. Both the paused placement command and the scenario rebuilt by
Fight/Edit pass the engine's `SkipMakeAnimsInit`, as preplaced map actors do; ordinary building production keeps
its construction animation. Without that initializer a paused building stayed on the first `make` frame.
Palette categories come from movement traits (aircraft, infantry, mobile), not the production queue: a helicopter
built by a vehicle factory still appears in Aircraft. Search stays inside the selected category, and changing
category/search disarms the old placement brush. Categories unavailable to a nation fall back to an available one.

`tools/replay-seek-browser-test.mjs` runs the owner's dug-in G.I. battle while the camera wanders, writes down the
engine's truth at five moments, then seeks to each (backwards, forwards, after the fight) and checks the units, their
cells and health, the score, the camera and the clock, that looking around keeps the timeline's length, that playing
on reaches the live battle, and that Play from here starts with that moment's units and that its link lays them out
again with their cells, health and ranks. On the page before the fix 10 of its 29 checks failed; after it, all 32 pass.

`websim placementtest --root <unpacked public root>` checks the real catalog and completed buildings before any
tick, plus their positions after scenario recreation. `tools/simulator-placement-browser-test.mjs` checks both
public modes in the actual WASM game, including category-scoped search and edit/run/edit preservation.

Combat uses the same OpenRA death traits, falling husks, effects and snapshots as skirmish. The embedded host must
identify its platform as `Web`, not `Null`: `Game.IsHeadless` makes spatial sprite effects skip ScreenMap registration,
which silently hid infantry deaths and explosions even while their animations ticked. `UnitExplode` and its aircraft
crash descendants choose a land explosion or water splash from terrain, independently of overlapping actors.
`websim effectstest --root <unpacked root> --map twin-fords` exercises modern/original infantry and helicopter/jet
deaths in simulator and ordinary worlds; use `classic-coast` for Classic. `tools/combat-effects-browser-test.mjs`
captures actual weapon kills through WASM and WebGL in both modes, including the falling wreck before impact.
`websim effectsaudit --root <unpacked root>` widens that to every faction's whole roster: each unit killed by each
damage set weapons deal, each weapon's impact on vehicles, infantry, buildings, aircraft, ships, ground and water; the
exit code is the number of failures. `tools/gameplay-check.mjs` runs both on a release bundle.

```powershell
node tools/battle-plan-unit-test.mjs
node tools/ai-lab-unit-test.mjs
cd web; npx tsc --noEmit; cd ..
node server/serve.mjs   # then, in another shell:
$env:RTSAI_TEST_URL = "http://127.0.0.1:3490/"; node tools/editor-simulator-browser-test.mjs
```

The local server relays OpenStreetMap queries and keeps the answers (`/api/overpass`; overpass-api.de refuses
requests without an identifying User-Agent).

Known gaps: islands inside a lake or sea stay water (the compiler has no land fill); a coastline that ends inside the
box (missing data) adds no sea; and the `Bundle.cs` editor-widget overlay takes effect after the next data repack (the
runtime also quiets the editor widgets itself).

Found on 20 November 2026 and still open (the ranked list is in `D:\Generated\RTSAI\maker-tools-20261120\README.md`):
- Random and blank maps are strips four times as wide as tall (`MapGen.cs` and the editor's "new" make a square in
  cells, and an isometric cell is twice as wide as a row is high). Squarer maps are an engine-side change.
- A dragged tile stroke skips cells and painted ground has hard edges: the tile brush paints only where it is told the
  pointer is. Filling the path in on the page did not change what the engine painted. A ground brush like
  `WaterBrush.cs` (dirt, rough ground and sand with their edge pieces) is the fix.
- Every save of an edited map is a new copy in the player's maps, and a saved map cannot be deleted from the page.
