# Local browser multiplayer

Double-click `launch-multiplayer.cmd` in `C:\Users\Admin\Code\hq\games\RTSAI-WebGame` and keep that window open while playing. Open `http://127.0.0.1:3491/?profile=public&runtime=interp&private=0` in the in-app browser or Chrome. The room screen shows **Local server connected** when it is ready. If it shows **Local server unavailable**, start the launcher and press **Check connection**. Changing browsers does not fix a stopped server.

To build the frontend and start the server manually from the same folder:

```powershell
npm --prefix web run build
$env:RTSAI_WEBGAME_PORT = '3491'
$env:RTSAI_WEB_COMPANION_GRPC = '9989'
node server/serve.mjs
```

Open `http://127.0.0.1:3491/?profile=public&runtime=interp&private=0` in two independent browser profiles or an ordinary and a private window. Choose **Private multiplayer**, create a room, copy the invite link, and join from the second window. The host chooses a map and optional AI opponents. Choose **Four Fronts** for two humans plus up to two AI players; the original two-seat maps support two humans. Each human chooses a faction and team. A team of zero means no alliance. Both humans must press **Ready**, then the host starts the match. Any faction/map/team/AI change clears both ready states.

The server stays bound to loopback. Invites work on this computer; no public hosting, accounts, matchmaking, LAN exposure, or deployment is included. Rooms live in server memory, expire after one hour without activity, and disappear on server restart. Transient connection interruptions retry for up to 60 seconds in the same open browser, retaining pending order packets. After 12 seconds without contact a commander is marked disconnected; after 60 seconds the match stops with a clear reason. Closing or reloading a browser cannot restore its world; create a new match after the grace expires.

The four-seat map is generated locally with `python tools/prepare-multiplayer-map.py` and included by the public content bundle builder. It has symmetric clear terrain, home ore mines and central gems.

To rebuild the public game data and simulation from the existing input checkouts, use the installed SDK that includes `wasm-tools`:

```powershell
python tools/prepare-content.py
python tools/prepare-multiplayer-map.py
& "$env:USERPROFILE/.dotnet/dotnet.exe" build sim/OpenRA.WebSim.Native -c Release -p:WebProfile=public
& ./bin/OpenRA.WebSim.Native-public/Release/net10.0/websim.exe pack --engine ../OpenRA-wt-rtsai-engine --mod ../RTSAI-Mod-wt-web-public --out data/public/web-bundle.pack --no-mix-database
& "$env:USERPROFILE/.dotnet/dotnet.exe" publish sim/OpenRA.WebSim.Browser -c Release -p:WebProfile=public -o data/public/wasm-interp
```

Use identical runtime and content builds in both windows. The room handshake fingerprints `dotnet.js` (which embeds assembly/resource hashes), the complete mod data pack, and the multiplayer protocol revision. An incompatible build is rejected before it can join. Restart the server after changing server code and reload both windows after rebuilding the frontend, runtime or content.

## Transport and simulation

`server/rooms.mjs` implements authenticated private rooms over same-origin HTTP POST. The worker exchanges frames on a 40 ms cadence, with at most one exchange in flight. The server holds a submitted packet for up to 35 ms to return both peers' packets together. Reliable ordered requests are sufficient for two local clients and avoid a new WebSocket dependency; latency slows the frame barrier rather than dropping orders or predicting world state.

OpenRA `Order.Serialize`, `OrderPacket`, `OrderIO`, `OrderManager.TryTick`, and the original `WebConnection` were inspected before choosing this design. The wire envelope carries base64 OpenRA binary order bytes and a frame number. Actor IDs and targets are deserialized only when the frame is processed in its own world. The server assigns sequential human client IDs; optional bots occupy the remaining slots and are controlled only by client 1. Both clients receive identical lobby settings, seed, slots, spawn points and order packets.

The engine gates each tick on both packets, including empty packets. `WebConnection.Poll` invokes OpenRA's existing guarded `SendOrders` path before waiting at the HTTP barrier. This small reflection adapter avoids editing the engine; an engine update that removes that method fails explicitly. Single-player replay behavior remains available through the existing connection path.

Every engine frame reports its `SyncHash` and defeat bitset. The room server compares both reports and records the last verified frame. A mismatch stops the match and displays the frame number. No state repair is attempted. Leaving or a failed world startup stops the match. Requests time out after 12 seconds and retry with their pending packets; the frame barrier pauses while waiting. Closing a browser stops the match after the 60-second reconnect grace. Simulation pause, speed adjustment, manual stepping, benchmarks and the AI co-commander are disabled in multiplayer. Ordinary OpenRA AI opponents remain supported.

## Local checks

```powershell
node tools/multiplayer-test.mjs
node tools/multiplayer-ux-test.mjs
$env:RTSAI_TEST_URL = 'http://127.0.0.1:3491/'
$env:RTSAI_TEST_HEADED = '1' # Show two separate Chromium windows; omit for headless checks.
node tools/multiplayer-browser-test.mjs
```

The API checks cover room credentials, version rejection, seats, host permissions, readiness, AI/team settings, delayed packets, mismatching hashes and explicit disconnects. The browser check uses separate Chromium contexts, joins via the invite, rejects an altered runtime fingerprint, requires an AI-capable map and an actual AI seat, verifies AI order packets before human input, compares at least 240 actual OpenRA hashes, sends human deploy orders, introduces 120 ms request latency, and closes the guest browser to verify timeout handling. Screenshots are written to `artifacts/multiplayer/`. It uses the existing local Playwright Chromium installation.

The UX check also verifies an offline server produces launcher guidance, connection checks recover, an empty invite cannot be submitted, failed requests can be retried, creating a room shows a busy state and issues one request, copying confirms success, starting stays disabled until everyone is ready, and the lobby fits a 390-pixel screen.

During play, the compact toolbar shows a stable connection state and a Chat toggle. Frame counters and per-request timing stay inside Connection details; timing is averaged and refreshed every two seconds. Chat shows a badge only for unread messages. The two-client check verifies the healthy toolbar keeps its text and dimensions while frames advance, and opens details and sends a room message.


Verified locally on 9 October 2026: two visible Chromium windows with independent browser contexts, two humans plus AI on Four Fronts, matching hashes through frame 241, nonempty AI order packets before human input, both human MCV deploy orders, and continued synchronization with 120 ms added client latency. The separate two-human-only match also passed. Closing the guest context marked it disconnected after 12 seconds, then stopped the host after the 60-second grace with an explicit reason; changing the runtime fingerprint was rejected in the lobby. API tests also verified mismatching hashes stop the room. Frontend build, native build and public interpreter publish succeeded.



## In-game chat

In both private-room and direct-peer matches, press **Enter** from the battlefield to open and focus chat. Type a message and press **Enter** to send; focus returns to the game. **Escape** closes the composer without sending and keeps your draft. Tab keeps normal keyboard focus navigation. Other game controls do not receive chat keystrokes.

The upper-left corner shows up to four recent messages for 15 seconds without opening a panel. Press Enter or choose Chat to see retained history. A failed send preserves the draft and shows an error so you can retry. Messages are shared with the whole room; this is not team-only chat.

Camera and microphone support currently belongs to the separate **Direct peer-to-peer** flow. After exchanging connection codes, choose **Enable camera and microphone** and grant browser permission. Joining a private room does not initiate a voice or video call. Local synthetic-device tests validate WebRTC media; separate physical-device/network testing is still needed.
