# Browser multiplayer

The browser offers two distinct transports. **Direct peer-to-peer** is the two-person WebRTC flow included in public static builds. **Private multiplayer** uses a local, loopback room server; static hosting does not provide that server. Neither flow enables hosted matchmaking or accounts.

## Direct invitations

1. Open the same game build and runtime in both browsers. Choose **Direct peer-to-peer**.
2. The host chooses a faction, presses **Create offer**, and sends the offer code through an existing chat.
3. The friend pastes it into **Friend connection code**, presses **Answer friend offer**, and sends the answer back.
4. The host pastes the answer and presses **Connect with friend answer**. Both browsers verify their runtime/content fingerprints before accepting lobby messages.
5. The host selects a map. Each commander selects a faction and presses **Ready**. A map or faction change clears both ready states. Only the host starts, after both commanders are ready.

Codes belong to one connection. Repeated joins, offers, answers and starts are rejected or disabled. To change connections, use **Start a new connection** and exchange fresh codes. The previous world is discarded; it is never resumed from new signaling codes.

Direct protocol revision `direct-2` fingerprints the runtime's `dotnet.js` and complete data pack with SHA-256. The host also sends the selected map ID and UID; the receiving browser checks both against its own catalog. Start settings have a bounded integer seed, two assigned client IDs/slots/spawns, catalog factions, fixed colors/teams, and the supported option values. Unknown/malformed messages, incompatible builds/maps and invalid settings close the connection. Legacy `direct-1` peers must reload the same updated frontend.

During a match, ordered WebRTC messages carry OpenRA binary orders and per-frame synchronization hashes. `PeerLockstep` waits for both order packets and the preceding matching hash reports before advancing. A synchronization mismatch or conflicting report permanently stops that lockstep instance. No state repair or replay recovery is implemented.

Disconnects and malformed live messages stop simulation, cancel pending world starts, close media/data channels and show a reason. Pending sprite-upload waits and late companion success/failure callbacks carry a launch generation; quitting, disposal or direct stop invalidates them so they cannot construct or mutate a replacement world. The page and worker also attach a session generation to commands, world events and shared snapshot slots. Old world receipts and mutations are ignored; pending request promises settle with a cancellation error. Immutable baked sprite assets remain reusable across cancellation so a cold restart does not lose its uploads. A heartbeat stops an unresponsive peer after 15 seconds without inbound messages, checked every three seconds. Both commanders must return to setup and exchange new codes for a new world. Reload/rejoin does not restore a previous world.

Chat and camera/microphone controls remain available after verification. Press Enter from the battlefield to open chat; Enter sends and Escape closes the composer while preserving a draft. Camera/microphone permission errors leave the game connection open. Stopping media or leaving closes local tracks. Local synthetic media tests are not physical microphone/camera acceptance.

The default direct connection uses `stun:stun.l.google.com:19302` to discover potential routes. There is no TURN relay or relay credential configuration. Some firewalls/NATs will prevent a connection; try another network. Same-computer host-route tests do not establish different-device or different-network connectivity, real Safari behavior, or universal connectivity.

## Local room server

Run the local server from a private, prepared build workspace and keep it running. On Windows the existing `launch-multiplayer.cmd` launcher is available. The room screen's **Local server connected** indicator checks the same-origin `/api/health` endpoint. An invite works on this computer because the server binds loopback.

```sh
RTSAI_WEBGAME_PORT=3491 RTSAI_WEB_COMPANION_GRPC=9989 node server/serve.mjs
```

Open the local URL in two independent browser profiles. Choose **Private multiplayer**, create a room, copy the invite and join from the second browser. The host chooses the map and any supported AI seats; both humans choose their factions/teams and mark themselves ready. Changing settings clears readiness. “No team” means no alliance.

AI requires a map with enough slots. The S02 frozen public bundle has two-seat maps only; two humans plus AI is therefore unavailable in that bundle. The generator `tools/prepare-multiplayer-map.py` is a source preparation tool, not proof that its four-seat map is present in a particular packaged build. Future content integration must include and validate an appropriate map before claiming room AI coverage.

Rooms live in server memory and expire after one hour of inactivity. Temporary HTTP failures in the same open browser retain pending order packets and retry for up to 60 seconds; ticks wait at the order barrier. A player is marked disconnected after 12 seconds without contact; after 60 seconds the room stops. Closing/reloading a browser, losing credentials or restarting the server cannot restore its world. Start a new match after a permanent failure. A synchronization mismatch stops the room without repair.

Local build paths are supplied through the adapters described in `docs/BUILD-INPUTS.md`. Use private copies of frozen source/data/native outputs and separate `RTSAI_WEB_DATA`, `RTSAI_WEB_BUILD`, `RTSAI_WEB_DIST`, `RTSAI_WEB_SCRATCH`, `LOCALAPPDATA` and ports. Generate the ignored frontend catalog in that private workspace with `sync-catalog.mjs --catalog ... --out ...`. Do not compile or serve immutable shared inputs; `/api/verify` writes receipts.

## Verification

From a prepared private WebGame workspace with its own dependencies:

```sh
node tools/peer-unit-test.mjs
RTSAI_TEST_URL='http://127.0.0.1:3491/?profile=public&runtime=aot&private=0' node tools/worker-lifecycle-test.mjs
node tools/multiplayer-test.mjs
RTSAI_TEST_URL=http://127.0.0.1:3491/ node tools/direct-browser-test.mjs
RTSAI_TEST_URL=http://127.0.0.1:3491/ node tools/multiplayer-ux-test.mjs
RTSAI_TEST_URL=http://127.0.0.1:3491/ node tools/multiplayer-browser-test.mjs
npm --prefix web run build
```

The direct browser check uses two independent Chromium contexts and the real runtime. It covers malformed codes, incompatible builds/maps, repeated-join prevention, readiness reset, chat, synthetic bidirectional media, matching hashes, both human deploy orders, malformed live-message and deliberate hash-mismatch stops, new-code fresh sessions, cancelled loading/late companion continuations, and disconnect stop/restart. It explicitly restricts test ICE configuration to host routes; production retains its STUN configuration. Receipts/screenshots go to `artifacts/direct/`. The room tests cover permissions, malformed packets, readiness, retry, hash mismatch and disconnect; optional AI is skipped explicitly if its map prerequisite is unavailable.

Fresh real Safari, physical camera/microphone, different-device/network, and AI-capable map acceptance remain separate gates. The 9 October Windows two-human-plus-AI/Four Fronts receipt is historical evidence for that build, not the S02/S03 frozen public bundle.
