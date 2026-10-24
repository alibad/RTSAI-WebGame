# Command Red — web game UI

The actual web game now uses the approved Command Red identity throughout its menus and HUD. The migration separates presentation accents (`--hud-accent` / `--command-accent`) from resource gold (`--hud-gold`).

Red covers navigation, primary actions, toggles, selected factions/maps, production categories, command buttons, focus, replay controls, settings and the adviser. Portalled picker options and expanded triggers use the same palette, including readable text while a selected option is keyboard-focused. Panels use charcoal and steel. Credits and unit costs remain gold. Gameplay warning/status colors, health, terrain, flags, team swatches, unit artwork and renderer pixels retain their meanings.

This is a presentation change. No simulation code, map data, factions, unit stats or art assets were changed. The TSX changes replace color references; hooks, subscriptions, handlers, keys and component structure are unchanged.

Validation: TypeScript and Vite production build; local desktop and actual WASM shared-build acceptance; rendered skirmish setup, construction, production HUD, adviser, settings, replay and outcome; expanded custom pickers on desktop and a 390-pixel phone layout. The selected red option's focused descendants were checked for dark text on the red fill. No visible native select was introduced. There is no Arabic interface in this game to claim as RTL-tested.

The narrated local demo is at `C:/Users/Admin/Code/hq/games/artifacts/saudi-skirmish-demo-20261024/saudi-skirmish-demo.mp4`, with captions, transcript, chapters, raw captures and edit scripts beside it. Native footage comes from the completed Saudi-versus-Easy-Iran acceptance replay at 2×. The Guard close-up manually demonstrates the ordinary deploy/move commands used by the new bot module; it is explicitly labelled, separate from full skirmish footage. Narration uses cached local Kokoro `am_michael`.

Use the installed **RTS AI Web Game** shortcut, which resolves the latest accepted local build through `tools/launch-web-game.ps1`. Source pushes do not deploy this game. No public release or website deployment was performed for this change.
