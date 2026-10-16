# Player menus

Normal builds offer one built-in adviser, with its switch in skirmish setup and its order policy in Settings.
The setup footer owns its own height and contains only utility buttons and Start match. Content scrolls above it.
Campaign launch controls stay inside the briefing; dialogs are portaled above navigation and retain keyboard focus.
Portrait gameplay explains the landscape requirement and provides an exit.

Skirmish rules use an explicit player-facing allowlist with explanations. Engine co-commander plumbing, cheats,
and multiplayer-only rules are excluded. Ordinary skirmishes force cheats off and keep the native adviser bridge
available; the player's adviser setting still controls whether it runs. Engine statistics, native verification,
AI doctrine logs and evidence exports require `VITE_DEVELOPER_TOOLS=1` in the development server. Production builds
never expose them. Local-model hooks separately require `VITE_COMPANION_DEV_TOOLS=1` in development.

Local checks (set `RTSAI_TEST_URL` and `RTSAI_TEST_OUT` to the candidate server and evidence directory):

- `node tools/menu-ux-browser-test.mjs`: full-screen menus at desktop, laptop, portrait phone, landscape and RTL;
  footer containment and touch height, no overlapping setup panels, advanced rules, model-free settings, expanded
  pickers, multiplayer entry, campaign and editor menus, simulator/pause menus, and a real match/save/replay flow.
- `node tools/themed-pickers-browser-test.mjs`: expanded voice and editor-owner pickers, keyboard dismissal and RTL.
- `node tools/adviser-options-browser-test.mjs`: saved preferences, switch keyboard behavior, order policies.
- `node tools/simulator-palette-browser-test.mjs`: complete cameo labels/prices and real drag placement.
- `node tools/browser-adviser-test.mjs --url <local-url> --out <fresh-directory>`: actual order approval in both views.
- `node tools/cross-browser-test.mjs <local-url> <directory>`: both game modes in installed Chromium, Firefox, WebKit
  and touch emulation. This does not constitute physical phone or Safari hardware testing.

Feedback submission and an external multiplayer connection require their configured services and are not sent by
this local menu check. The multiplayer entry dialog is inspected without creating a hosted room.
Frontend-only revisions reuse an accepted runtime/data pair only after confirming unchanged simulation source
and hashing the copied payload. Register the new page and verification receipt with `tools/local-game.mjs`;
never edit an already registered payload in place. Keep the stable launcher URL on port 38664.
