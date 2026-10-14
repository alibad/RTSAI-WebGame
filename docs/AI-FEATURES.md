# Local browser AI features

9 October 2026. All five roadmap areas now have playable local implementations. No deployment or hosted CI was added.

Open `http://127.0.0.1:3490/?profile=public` with the local server running (`node server/serve.mjs`). The public profile uses project content. The co-commander's Scripted mode is sufficient to exercise strategy and annotations without paid model calls.

| Area | Entry point | Behavior |
| --- | --- | --- |
| Contextual strategy | Skirmish → Co-commander → Strategy | Choose a persistent goal, reserve and confirmed next steps. Press G to apply the newest pending recommendation; C remains repair. |
| Battlefield communication | A pending co-commander proposal | Owned-unit rings, intent arrows, focus and dismiss; remembered visible contacts are uncertain. |
| Coaching & practice | Battlefield review | Timestamped native evidence; pause/seek/return live, drill links, exported scenario/evidence. |
| Opponent personalities | Skirmish → Tactical personality | Standard, Raider, Sentinel, Adaptive; separate from difficulty and native economy/production. |
| Battle simulator | Main menu → Battle simulator | Pick any map, drop units from each faction's roster (Faction Viewer cards), or describe the battle; Fight hands you one side with the full HUD while the engine's AI, at the chosen skill, commands the other. See [EDITOR-SIMULATOR.md](EDITOR-SIMULATOR.md). |

Practice objectives use native simulation time and record measured survivors, shots and damage at completion. Repeat same seed & forces compares with the preceding identical exercise. Changing the seed, forces or objective intentionally starts a new comparison. Local storage holds only the latest practice result.

The simulator places two forces on a real map, rather than arbitrary campaign scripts. Coaching retains six minutes of sampled visible rendering; exported evidence is JSON, not a portable rendering replay or a saved world state. Opponent personalities only direct up to eight idle combat units every five seconds; the existing native bot still handles production, economy and difficulty. No bonus resources or model-based simulation decisions are introduced.

Verification commands:

```powershell
cd C:/Users/Admin/Code/hq/games/RTSAI-WebGame
node tools/ai-lab-unit-test.mjs
dotnet build sim/OpenRA.WebSim.Native -c Release -p:WebProfile=public
bin/OpenRA.WebSim.Native-public/Release/net10.0/websim.exe ailabtest --root "$env:LOCALAPPDATA/RTSAI-WebGame/scratch/vfs-native-public"
node tools/battle-plan-unit-test.mjs
node tools/strategy-test.mjs
cd web
npm run build
```

After a WebAssembly publish, `node tools/verify-runtime.mjs` checks every declared resource hash against the final published bytes. `--repair` can regenerate stale publish hashes without disabling browser integrity validation, but cannot repair mismatched AOT assembly metadata. A fresh intermediate/output variant is required for that case. Browser acceptance is necessary after either operation; a hash check alone does not establish runtime compatibility.

The native VFS must already be unpacked from the current public bundle (the local verification endpoint prepares it). Interpreter verification can set `TEST_RUNTIME=interp`; the default browser test uses AOT. WebAssembly publishing uses the user-local SDK with the installed `wasm-tools` workload. Screenshots, parity and test results are under `artifacts/ai-lab/` and the adjacent `ai-lab-*` logs.

The native suite checks three doctrines × three factions × two seeds, standard bot integration on twin-fords and harbor-line, distant/near Sentinel behavior, fog-respecting contacts, native ground routes, survival, elimination, timeout and own-force failure. Browser coverage exercises text interpretation, invalid force rejection, validated preview, objective completion, measured results, safe seeking, native doctrine parity, real companion proposal annotations and dismissal without acceptance.

Final local verification: 20 native scenario evaluations passed, alongside objective/fog/route checks. The default AOT browser flow passed without page errors and replayed 151/151 frames identically in native CoreCLR. The interpreter flow also passed (152/152 frames), and the final default AOT contextual-strategy regression accepted its actual economy step (60/60 frames). The native, frontend, interpreter and fresh AOT builds passed. The visual overview is `artifacts/ai-lab/overview.html` / `overview.png`.

The current AOT artifact was published from fresh intermediates with:

```powershell
& C:/Users/Admin/.dotnet/dotnet.exe publish sim/OpenRA.WebSim.Browser -c Release -p:WebProfile=public -p:Aot=true -p:RuntimeVariant=none -p:VariantSuffix=-public-aot-ai-lab -o data/public/wasm-aot-fresh
```

Its verified `_framework` was copied to `data/public/wasm-aot/wwwroot` for the default launch path. This local artifact retains more AOT code than the lean build; cold download/compile size is larger. The public production site was not changed.
