# The local web game

Use `launch-game.cmd` in this canonical checkout, or the **RTS AI Web Game** desktop shortcut.
`tools/launch-web-game.ps1 -NoOpen` starts or verifies it without opening a browser. The normal local URL is
`http://127.0.0.1:38664/?profile=public&mode=skirmish`. Multiplayer and the Studio's `/play` use this same game.
The desktop native game keeps its separate launcher.

The selected game is an explicitly accepted build, not whichever `web/dist`, data folder, port or environment
variable happens to exist. Selection lives in `%LOCALAPPDATA%/RTSAI-WebGame/launcher/current.json`.
Each launch checks every recorded file, the page identity, both modes' runtime identities, original-country art
and voices, and the native replay host. Scenario files are frozen from the accepted source revision, so subsequent
source edits cannot change the running build's missions. It then checks the live server identity and actual HTTP payloads.
A mismatched listener, modified file or missing build causes an error. It never falls back to another build,
switches ports automatically, downloads content or kills a listener. It starts a detached server when needed.
Concurrent launches share a lock. Server logs and process records live beside `current.json`. The companion uses
dedicated ports derived from the selected game port (43664/43665 for the default game), avoiding older previews'
bridge on 9988. An occupied bridge is an error, never a connection to a different game's AI.

The accepted build's source commit must be in canonical main. New source commits do **not** silently replace
the accepted game. Launcher output reports both the accepted source and current main. Build, test and register
a complete replacement together; do not change a page or runtime in place and call it the same build.

After full local acceptance, register its exact paths:

```powershell
node tools/local-game.mjs register --receipt '<complete-verification.json>' --page '<page>' --data '<data>' --native '<native-build>' --port 38664
node tools/local-game.mjs verify
node tools/local-game.mjs start
```

The receipt is a JSON document with `buildId`, `variant: original-countries`, source SHAs, a runtime identity,
and SHA-256 `checksums` covering the selected page, both complete content profiles, runtime files and evidence.
The native replay DLL is hashed separately during registration. Registrations retain a previous copy.
For a host-only correction that reuses a matched page/runtime/data payload, the receipt may name `serverSource`
separately. That commit must also belong to canonical main; the launcher freezes its server files while preserving
the original page, simulation and scenario source identities.
Registering does not restart a running different build; verify its identity and close the known managed server
before promoting a replacement. Never treat `/api/health` alone as proof that the right game is running.

The launcher redirects the stable entry URL to `/local-builds/<buildId>/`. Keep that path: each tab then fetches
its page, worker, runtime, audio/art indices, packs, sprite sheets and scenarios from the same accepted build.
Registrations are retained under `accepted/`; a replacement host verifies and serves previous registered payloads
too. Unavailable builds return 410, never the new build's bytes. This prevents an older tab's audio byte offsets
from addressing a new pack after an update. Refreshing an older scoped page selects the current build while its
already-running worker keeps reading its own files. Tabs opened before this protection need one reload from the stable URL.

The accepted 16 October build is `local-adviser-8151b3d`: one built-in web adviser, original isometric countries
plus project Classic, with 333 original art files and 521 original voice/sound clips. Both data profiles and the
AOT runtime use consolidated engine main `27c5038ab9`, recorded as a local override without changing public pins.
The receipt and recipe live in `D:/rtsai-release/adviser-20261016`. Earlier accepted builds remain recoverable.
Local AI and Scripted are absent from normal web controls; explicit developer hooks and actual model-readiness
checks are documented in `PUBLIC-CO-COMMANDER.md`.

## Local backup

`python tools/backup-workspace.py --out '<new backup directory>' --build-receipt '<receipt>'` creates full Git
bundles for all eight product repositories, records branch/worktree ancestry, saves tracked/staged binary patches
and nonignored untracked files, and copies/hash-checks the accepted web payload. It also backs up nested engine
repositories. `--previous-recovery '<folder>'` preserves older raw recovery copies too. No pushes or deployments.
Generated ignored caches are indexed, not copied; source art/history and the explicitly accepted payload are backed up.
Keep backups on a separate disk. Verify `checksums.json` before restoration; Git bundles can be fetched into a
recovery repository. The accepted build's receipt paths need remapping and re-registration if restored elsewhere.
