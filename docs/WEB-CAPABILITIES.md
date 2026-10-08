# Local browser capability pass

The browser UI now exposes native OpenRA capabilities that were previously reachable only through keys or missing from the HUD.

- Selection drives the barracks/vehicle-factory production tab and shows only supported attack-move, guard, deploy, scatter and stop commands.
- Selected combat units show aggressive, defend, return-fire and hold-fire stance controls, including mixed-state feedback.
- Production facilities show their primary status, a primary toggle, and a rally-point instruction. Right-clicking the battlefield uses the native rally-point order.
- Available support powers have native cameos, descriptions, readiness, charge progress and countdowns. Clicking a ready power invokes its native target generator, including multi-stage target generators.
- **Saves & replays** is available at setup and in matches. Up to ten local records can be resumed, replayed, exported and imported. Replays are read-only and support play/pause, speed and seeking. Restores reconstruct the world from native order packets and reject mismatching recorded sync hashes.
- **Settings** persists master/effects/music/companion volume, camera scroll speed and basic command keys. Music ducking preserves the user's volume. Key conflicts are rejected; hotkey help and command hints reflect remappings.
- Private rooms accept human commanders up to map capacity, retain their readiness barrier and compare every participant's synchronization reports. Bot client IDs begin after the human IDs. Chat is available in the lobby and match. Interrupted connections retry for 60 seconds while retaining pending packets.
- Private invites can be watched without occupying a player seat. Spectators consume the recorded frame stream and cannot send game orders or alter the lobby. The current spectator view follows Commander 1's visibility, rather than revealing hidden enemy information.

Everything remains local. Room state is ephemeral and expires with the local server; connection recovery preserves an existing open browser world, not a closed or reloaded multiplayer world. Local saves require compatible game content and do not embed art or engine binaries. Selection, control groups, camera position and camera bookmarks are saved as UI metadata alongside the native order stream.

## Verification

```powershell
C:/Users/Admin/.dotnet/dotnet.exe build sim/OpenRA.WebSim.Native -c Release -nologo -v q
npm --prefix web run build
node tools/multiplayer-test.mjs
bin/OpenRA.WebSim.Native/Release/net10.0/websim.exe restoretest --root "$env:LOCALAPPDATA/RTSAI-WebGame/scratch/vfs-native-public" --scenario scenarios/capabilities-ui.json
```

The restore test checks exact hashes after restoring a real stance order, continued recording after resume, read-only playback, and corrupted-hash rejection. Room API tests cover four humans, full-map rejection, packet and hash barriers, chat and rate limiting, duplicate retry reports, spectator frame history and permissions, synchronization failure and explicit leave.

The `capabilities-ui` fixture extends the production UI fixture with a fully charged Falcon precision strike for browser verification. `tools/feature-preview.mjs` can proxy the existing static preview and supply local ephemeral room APIs without publishing anything.

The public AOT default uses partial trimming and retains IL. The opt-in `lean` variant aborted during Mono core-library initialization in this pass; the compatible AOT build was launched and tested successfully. Interpreter startup, an actual support-power target and recharge, primary-factory selection, save/resume and read-only replay were checked in the browser. A live spectator matched Commander 1's hashes through frame 797 and observed a subsequent MCV deployment; issuing an order as that spectator was rejected.
