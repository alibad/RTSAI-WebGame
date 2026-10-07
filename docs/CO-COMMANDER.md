# AI co-commander in the browser game

The desktop game's co-commander is the Python companion (OpenRA-AI `services/companion`). It talks gRPC
(`rl_bridge.proto`) to the mod's `CompanionBridge` trait, which runs inside the game. In the browser, the game runs
in a Web Worker and cannot host a gRPC server. The browser build keeps both ends unchanged and relays between them:

```
local mode (today)
  Python companion ──gRPC h2c :9988──▶ server/companion.mjs ──WebSocket /companion/bridge──▶ worker
     │  (watch --no-speak)                (relay, same bytes)        protobuf RPC frames          │
     │                                                                                          ▼
     │                                                              CompanionRpc.cs ─▶ CompanionBridge (mod, unchanged)
     ▼                                                                                   observations / orders
  page ◀──── /companion/api/* (ask, transcribe, speak, confirm, cancel) ──── server proxy ──── companion :8797

hosted mode (next): worker ──wss://rtsai.net/companion/bridge──▶ hosted companion session (same frames)
                    page   ──https://rtsai.net/api/ai/...────────▶ hosted proxy (Claude Haiku 4.5, Whisper, TTS)
```

## Transport

- **Frames.** Each frame has three parts:
  - a little-endian u32 header length;
  - a JSON header: `{t:"call", id, method}`, or `{t:"reply", id, code, message}`;
  - the protobuf message itself.

  There is no translation layer. Every request and reply is an `rl_bridge.proto` message, so the local relay and a
  hosted companion speak exactly the same bytes.
- **Engine side** (`sim/OpenRA.WebSim/CompanionRpc.cs`) answers the RPCs the companion uses during a match:
  - `Observe`, `GetState`;
  - `UpdateCompanionStatus`, `UpdateCompanionThreat`;
  - `ExecuteCompanionActions`.

  `CaptureCompanionFrame` returns FAILED_PRECONDITION, so the companion falls back to its tactical overview. A later
  step can return the page's canvas instead.
- **Mod code.** The mod's `CompanionBridge`, `ObservationSerializer` and `ActionHandler` compile unchanged.
  `sim/OpenRA.Mods.RTSAI/Web/CompanionWeb.cs` stands in for the desktop-only pieces:
  - the Kestrel host;
  - the sidecar process manager;
  - one helper from the widget logic.
- **Local server** (`server/companion.mjs`), loopback only:
  - serves a gRPC facade (HTTP/2 cleartext, which grpcio's insecure channel speaks) on 127.0.0.1:9988;
  - accepts the worker's WebSocket;
  - proxies the companion's HTTP API at `/companion/api/`;
  - starts and stops the companion process:
    - **local brain:** the player's local AI stack (gateway on :4000);
    - **scripted brain:** `server/mock-ai.mjs`, a canned OpenAI-compatible gateway with no models and no GPU.

  Ports avoid the desktop game's 9998 and 8787.

## Parity

Orders are inputs. The companion's confirmed actions go through `CompanionBridge.ExecuteActions` on the game
thread, then `world.IssueOrder`, then the OrderManager. So they are recorded in the session like any click and
replayed natively.

Test: `tools/cocommander-test.mjs` runs:
1. "Build a power plant";
2. the companion proposes "deploy the MCV first";
3. the player accepts;
4. the order is issued;
5. a question;
6. push-to-talk.

Native verify then reports 755 of 755 net frames identical.

AUTO (the native bot takes the local player) is kept off in the browser. It grants a condition outside the order
stream, which a replay cannot reproduce. Re-enabling it needs an order of its own.

## The panel (`web/src/ui/CoCommander.tsx`, `web/src/cocommander.ts`)

- **Strip** over the battlefield:
  - status orb;
  - threat meter;
  - the latest line;
  - push-to-talk (hold **V** or the mic button);
  - mute;
  - feed toggle.
- **Proposal card.** A proposed order shows as a card with ✓ / ✕. Accepting sends `/v1/actions/confirm`, and the
  engine's receipt shows as ✓.
- **Feed.** Player lines, answers, alerts by importance, proposals, receipts, and a text box.
- **Voice.**
  - The browser microphone records 16 kHz mono WAV and sends it to `/v1/transcribe` (Whisper).
  - Replies are spoken through `/v1/speak` (Kokoro) and played with WebAudio, ducking the music.
  - Alerts the companion raises on its own are spoken when important or critical.
- **Setup.** The setup screen's **Co-commander** switch has two brains: **Local AI** and **Scripted**. The switch
  appears only when the local server is present; a static public build has no co-commander until hosted mode exists.

## Hosted mode (next)

- **Bridge.** A per-session companion service behind rtsai.net accepts the worker's WebSocket and speaks the same
  frames. The worker connects to it instead of the loopback relay.
- **Brain.** The service runs the companion with its router pointed at the hosted proxy (Claude Haiku 4.5). This
  waits for the owner's environment variables.
- **Voice.** Speech recognition and speech go to hosted Whisper and TTS routes. The page code stays the same; only
  the base URL changes.
- **Costs.**
  - An observation is about 400 KB, measured at the start of a Twin Fords skirmish, and the local companion asks for
    one every 0.5 s. Hosted mode should send observations only on events or every few seconds, and send compact
    diffs.
  - Questions and alerts are the only model calls.
