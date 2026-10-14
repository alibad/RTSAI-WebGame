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
  defender's base on the site from its own roster, armies of equal value (an older army gets more units), the
  attack from the farthest start position.
- Save writes the map with the engine's `Map.Save` into IndexedDB (`rtsai-maps`) and mounts it, so it appears in
  the simulator and skirmish map lists; `.oramap` downloads the same package. Test in simulator opens it there.

## Battle simulator (`?mode=simulator`)

- Pick a map (or a random one), each side's nation and the enemy AI's skill (Easy / Normal / Hard / Brutal: the
  engine's bots with the mod's handicap and bonus cash, `web/src/sandbox.ts` `AI_SKILLS`).
- Drop units: the drawer lists each nation's roster from the rules' prerequisites (`Ui.Rosters`); hovering a unit
  opens its card with the website's Faction Viewer stage (`web/src/ui/FactionViewerStage.tsx`) and the engine's
  stats (`unitinfo`). Or describe the battle ("8 Abrams against 10 Karrar") and the planner lays it out
  (`web/src/battle-plan.ts`).
- Fight starts a bare scenario: no starting units, the placed actors, starting money. You command your side with
  the full HUD (production, power, selection, orders); the AI commands the other. Edit returns to the layout.

## Data

The Faction Viewer frames come from RTSAI-Web: `npm run export:viewer` there, then `node tools/sync-viewer.mjs`
here copies them to `web/public/viewer/` (ignored). The dev server serves the website's art from
`RTSAI_SITE_PUBLIC`. Building the page needs the website source: `RTSAI_SITE_ROOT` (default `../RTSAI-Web`).

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

Known gaps: the Earth compiler reads OpenStreetMap ways only, so lakes and canals mapped as multipolygon relations
(Lake Timsah, the Suez Canal's water area) are missing from built maps; the classic countries' units are weaker than
the modern factions' (missions even out the armies' value, not their strength); and the `Bundle.cs` editor-widget
overlay takes effect after the next data repack (the runtime also quiets the editor widgets itself).
