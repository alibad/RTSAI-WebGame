# Contextual production menus and complete portraits

Selecting one owned production building opens its production category. The engine sends the enabled
`Production.Info.Produces` categories with selection details; the browser switches only when selection changes.
Barracks open Infantry, vehicle factories open Vehicle, and other producers use their own engine categories.
Manual tab changes persist while the selection stays the same. Units, enemy buildings, and mixed selections
leave the current category alone.

The standalone web HUD uses the project's original unlabelled cameo images, with a separate name row below.
The installed labelled cameos had names baked over the lower rows: this obscured the attack dog's legs and
some vehicle tracks. CSS cannot recover those overwritten pixels. No art was regenerated or modified.
`node tools/sync-portraits.mjs` copies the original assets from RTSAI-Art and records their source and SHA-256
in `web/src/portraits.json`. The classic profile retains its engine-provided cameos.
The sync checks that each modern portrait's labelled original matches the installed mod icon before copying.

The selection panel names an actor with the build menu's name, else the engine's unit names, else the mod's own
Fluent messages for every actor (`web/src/sim/fluent-names.ts`, read from the game data at boot): the Construction
Yard, the other side's buildings and neutral ones are named too, and an unknown actor reads "Structure" or "Unit",
never its id. Westwood drew no Construction Yard cameo (an MCV deploys into one), so the original countries' yards
had a stand-in, a crane on a plate; the panel shows such actors, and any actor the engine has no cameo for, drawn from
their own sprites in their owner's art (`web/src/ui/actor-display.ts`, `Renderer.renderActor`).
`node tools/actor-names-unit-test.mjs [web-bundle.pack]`.

## Local verification (9 October 2026)

- TypeScript check and Vite production build passed.
- Public WebAssembly interpreter and AOT publishes passed using `C:/Users/Admin/.dotnet/dotnet.exe`.
- The browser project explicitly enables reflection-based JSON serialization for AOT, which the setup payload
  requires; without this setting the current trimmed build fails before setup with `JsonSerializerIsReflectionDisabled`.
- Live browser checks: barracks → Infantry; vehicle factory → Vehicle; manual Infantry choice persists with
  factory selected; a tank selection keeps the current menu; an enemy barracks and a mixed building selection
  leave the current menu alone.
- AOT startup and both contextual menu checks passed after the JSON setting was enabled. Native public build
  also passed with zero warnings and errors.
- At 1440×900 and 900×600, portrait images loaded and retained their complete 60×48 proportions. DOM geometry
  checks confirmed that name rows begin after the image bottom. The shorter palette scrolls.
- `scenarios/production-ui.json` provides a repeatable local match containing both producers, a tank, a dog,
  and an enemy barracks. Open `?profile=public&scenario=production-ui` on a local server with matching runtime
  and data. The scenario is a test fixture, not part of the player-facing setup.

The working data directory had unrelated startup failures during this check (missing classic icon and missing
standalone campaign map folder). Verification used the existing known-good standalone data in
`build/public-web`, with the newly built frontend and runtime, on a separate local preview. No deployment.
