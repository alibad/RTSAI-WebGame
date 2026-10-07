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

## Observations: pushed, compact

An observation is about 400 KB, nearly all of it the spatial map (float32 per cell and channel). The companion asks
for one twice a second, about 800 KB/s: fine on loopback, far too much for the hosted link. So the game pushes
observations instead of being polled.

- **Worker** (`web/src/sim/companion.ts`, `streamObservations`): every 0.5 s, when the tick has changed, it sends:
  - the observation without its spatial map, deflated;
  - the spatial map as a deflated XOR against the previous one (unchanged cells are zeros), or in full after a
    reconnect.
- **Relay** (`server/companion.mjs`): rebuilds the exact `GameObservation` bytes by appending field 10 to the rest,
  and answers `Observe` from that copy with no round trip to the game.
- **Measured** on a Twin Fords skirmish with the scripted brain:
  - 48 frames: 86.8 KB on the wire for 19.0 MB of observations, about 1.8 KB per frame (3.6 KB/s);
  - all 47 `Observe` calls answered from the rebuilt copy;
  - native verify identical (613/613).
- **Hosted mode** sends the same frames over `wss://` to a hosted relay that rebuilds the observations the same way,
  so the companion code stays unchanged. Rate and events: two frames a second is cheap at this size. A hosted relay
  can also forward on change only, for example when visible enemies, own losses or finished production differ from
  the last frame.

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

## Latency

- **Measured** with the scripted brain, which answers instantly (`tools/cocommander-test.mjs`, 5 push-to-talk
  rounds): from releasing the talk key to the spoken reply starting to play took 65 ms (median). By stage:
  - transcript 10 ms;
  - answer 30 ms;
  - speech audio 10 ms;
  - start of playback 0 ms.

  That is the whole cost of the browser, relay and companion; real models add their own time on top.
- **Real local models** (`tools/cocommander-live.mjs`, 7 October; 12 spoken turns per run). The player's lines are
  Kokoro "onyx" played into the browser microphone; the browser game runs the public profile and an Iran mirror on
  Twin Fords. Each run ends with a native SyncHash replay of the whole session.
  - **GPU stack** (the measured one): the product's own Qwen3-VL 2B Q4 on a CUDA llama.cpp, Whisper large-v3 and
    Kokoro on the GPU, behind one gateway (`RTSAI_WEB_AI_GATEWAY`, `--gateway`). It ran beside the owner's 3D run,
    with a yield line.
    - The companion's usual large model (Qwen3-Coder 30B on vLLM, 22.9 GB) did not fit: 20 GB was free.
    - Ollama's qwen3-vl:8b thinks before every answer even when thinking is turned off, so it was not used.

    | 23 turns, two runs | Median | p95 | Max |
    |---|---|---|---|
    | Talk key released to reply playing | **1.8 s** | 11.8 s | 24.1 s |
    | Same, without "what should I do?" questions (19 turns) | 1.6 s | 4.0 s | 4.6 s |
    | Transcript (Whisper) | 0.9 s | 3.6 s | |
    | Answer (companion and LLM) | 0.4 s | 10.5 s | |
    | Speech audio (Kokoro) | 0.4 s | 0.9 s | |

    - "What should I build first?" and "What should I do next?" go through the companion's planner, which makes
      several model calls. They took 8.9 to 24.1 s, and they are the whole p95 tail.
    - Transcripts were word-exact on 23 of 24 lines. The 24th was a timing slip in the first version of the
      harness, not a Whisper error.
  - **Orders.** Of 14 spoken orders across the two runs, 8 became the right card. The engine executed 7 of them:
    power plant, tanks east and stop all in both runs, infantry north in one.
    - The other "infantry north" card arrived after the first harness version had moved on, and accepting it then
      returned HTTP 409.
    - The remaining 6 were refused, correctly, because their prerequisite was missing:
      - barracks and refinery need the power plant placed;
      - training needs the barracks.
    - The power plant was never placed, for this reason. The co-commander offers to place the finished building
      (pending action, shown as a card). In the companion measured here, any later question replaced that offer.
    - For an item that isn't available yet, the companion said *I don't recognize "barracks"* instead of naming
      the missing prerequisite.
    - Both are fixed in OpenRA-AI d639b65, after this measurement:
      - The companion holds up to 3 offers (`pending_actions` in `GET /v1/state`, newest first). A question no
        longer drops one. A finished building always keeps its "Place the completed X" offer.
      - "Build a barracks" before the power plant is placed gets a card for the power plant, and the reply says
        the barracks needs it first.
      - "What should I build first?" and "What should I do next?" answer with a card and almost no model time.
      - Not re-measured yet.
    - In the browser, a card shows every offer the companion holds. A card it no longer holds (cancelled, or
      replaced by a newer offer about the same thing) turns to "–" (no longer offered) instead of failing with
      HTTP 409.
  - **Parity.** Both runs replayed identically: 2605 of 2605 and 2999 of 2999 net frames.
    - An earlier run reported a mismatch at frame 5224 of 5259, and it also had two stalls (47 s and 71 s) that never
      reached the model.
    - Its files had already been deleted, and the two later runs did not reproduce it.
    - The verify endpoint now keeps the files of any mismatch.
  - **CPU stack** (the product pack: llama.cpp CPU, whisper.cpp base.en, Kokoro ONNX). This was not a usable
    measurement. The machine was at 98 % CPU: the 3D run plus other sessions' software-rendered browsers.
    - The first answer took 129 s and the next six 7.5 to 25 s.
    - One line's audio was cut, so its transcript landed in the next turn.
    - It needs a quiet machine to measure.
- **Spoken order replies** are the order and its note ("Build a Power Plant. I'll offer to place the Power Plant
  when it's finished."). The desktop game's "I prepared 1 validated order. Say confirm to execute, or cancel." is
  left out: in the browser the card is accepted with a click or Enter.

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
  - Observations: about 3.6 KB/s per player with the compact stream (see above), instead of about 800 KB/s.
  - Questions and alerts are the only model calls.
