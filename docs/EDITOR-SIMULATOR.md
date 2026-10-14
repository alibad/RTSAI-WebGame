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
  Build runs the website's Earth compiler (imported from RTSAI-Web via the `@site` alias) and opens the map in the
  editor. **Start mission** turns a scanned site into a battle between any two nations (`web/src/mission.ts`): the
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
