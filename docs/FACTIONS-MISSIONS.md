# Browser factions and missions

The public browser profile now exposes all sixteen countries in the RTS AI catalog: America, Germany, England, France, Korea, Cuba, Libya, Iraq, Russia, China, Iran, Türkiye, Saudi Arabia, Israel, Yemen and Hezbollah. Random faction pools include the restored countries.

The nine restored countries retain the mod's original unit rules, weapons, costs and signature units. Their browser rendering uses existing project-owned faction artwork and announcers. Shared infrastructure uses the standalone base kit. These are playable gameplay rosters; they do not introduce nine new bespoke art sets. Automated checks cover deployment, power production, technology prerequisites, signature availability, unit and structure creation, deployed GI/Desolator states, icons and snapshot rendering. They do not establish competitive balance.

## Missions

The launch menu offers Skirmish and Missions. Mission cards show a briefing, map preview, objectives and difficulty; in-game objectives include progress and target location buttons. Victories are recorded locally by difficulty.

Five missions are adapted from authored companion content:

- Jizan Corridor, Hodeidah Lifeline and Bab al-Mandab Passage: `OpenRA-AI/missions/red-sea-2026`.
- Haitan Network: `OpenRA-AI/missions/china-faction`.
- Straits Shield: `OpenRA-AI/missions/turkey-faction`, with the source map binary recovered from the Classic OpenRA packaged map.

Their source maps use the older RA terrain and actors. The browser ports preserve terrain layout, resources, important locations and core objectives, while replacing terrain tiles and units with compatible standalone RA2 project content. Objectives run in the deterministic simulation host because the browser build does not link the native Lua mission runtime. Relief vehicles and shipping likewise use available project units. These are adaptations, not byte-identical campaign imports.

Relay Under Siege is a new fictional Hezbollah training exercise, built on Twin Fords. No authored Hezbollah mission was found. It tests faction infrastructure, defense against waves and an attack objective. All six missions are available immediately. Old Classic campaign maps and internal AI fixtures are not exposed as compatible playable RA2 missions.

## Local generation and validation

From `RTSAI-WebGame`:

```powershell
python tools/prepare-content.py
dotnet build sim/OpenRA.WebSim.Native -c Release -p:WebProfile=public
tools/public.ps1 -NoBuild
& C:/Users/Admin/.dotnet/dotnet.exe publish sim/OpenRA.WebSim.Browser -c Release -p:WebProfile=public -o data/public/wasm-interp
npm --prefix web run build
node server/serve.mjs
```

Open `http://127.0.0.1:3490/?profile=public&runtime=interp`. The public profile requires no original RA2 files. Generated packs, runtime output and sprite caches are local build artifacts.

Native regression commands accept an absolute extracted VFS root:

```powershell
websim.exe contenttest --root <absolute-vfs-root> --faction america
websim.exe missiontest --root <absolute-vfs-root> --mission haitan-network --mode success
websim.exe missiontest --root <absolute-vfs-root> --mission haitan-network --mode failure
node tools/fidelity.mjs --profile public --runtime interp --scenario scenarios/mission-haitan-network.json --ticks 300
node tools/content-browser-test.mjs
```

The browser regression currently targets local port3505. Native completion tests exercise scripted objective transitions and actual convoy/amphibious routes; they remove enemy combat units to isolate objective regression from combat balance. Manual difficulty and balance playtesting remains useful.

This work is local only. The website gateway is `RTSAI-Web` (`alibad/RTSAI-Web`); `/play` forwards to the Vercel game deployment. This browser checkout has no configured Git remote. Publishing requires a separate explicit deployment request.
