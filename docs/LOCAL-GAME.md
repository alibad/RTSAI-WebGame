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
Concurrent launches share a lock. Server logs and process records live beside `current.json`.

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
Registering does not restart a running different build; verify its identity and close the known managed server
before promoting a replacement. Never treat `/api/health` alone as proof that the right game is running.

The accepted 15 October build remains `local-complete-899be6a`: original isometric countries plus project Classic,
with 333 original art files and 521 original voice/sound clips. Later main consolidation is retained in source;
it is not advertised as part of that already-tested binary. Its full recipe is recorded beside the receipt.

## Local backup

`python tools/backup-workspace.py --out '<new backup directory>' --build-receipt '<receipt>'` creates full Git
bundles for all eight product repositories, records branch/worktree ancestry, saves tracked/staged binary patches
and nonignored untracked files, and copies/hash-checks the accepted web payload. It also backs up nested engine
repositories. `--previous-recovery '<folder>'` preserves older raw recovery copies too. No pushes or deployments.
Generated ignored caches are indexed, not copied; source art/history and the explicitly accepted payload are backed up.
Keep backups on a separate disk. Verify `checksums.json` before restoration; Git bundles can be fetched into a
recovery repository. The accepted build's receipt paths need remapping and re-registration if restored elsewhere.
