# RTS AI in the browser: status (7 October 2026)

The real OpenRA engine and the RTS AI mod run in the browser, unchanged, at full speed. The browser game is
deterministic: every test game replays identically in the desktop engine, tick for tick.

## What works

- **Two builds.**
  - **Public:** the standalone game, project art and audio only, safe to publish.
  - **Local:** the RA2 profile, which uses the player's own RA2 files and is never published.
- **Skirmish.** Seven modern factions; the standalone maps Twin Fords and Harbor Line; bots ("Normal AI", "Rush AI"…).
- **Game UI.**
  - RA2-style sidebar: cameo tooltips (cost, build time, power, strengths), radar minimap with real terrain, credits,
    power, repair and sell.
  - Control groups, a hotkey sheet (F1), and a victory or defeat screen with stats and an army-value chart.
- **Battle sandbox.** Drag units in, fight, read the results, scrub the replay, and check the fight against the
  desktop engine. The local app's Studio opens it.
- **AI co-commander, local mode.**
  - A chat and voice panel: hold V to talk, spoken replies, proposed orders as cards to accept or cancel.
  - Accepted orders go through the engine like clicks, so replays stay identical.
  - Hosted mode is designed: observations are already compact (3.6 KB/s) and wait only for the hosted service.
- **Phones and tablets.**
  - Gestures: tap to select or order, long-press for special orders, drag to box-select, pinch to zoom.
  - A compact sidebar and a "turn sideways" prompt.
- **Standalone updates are followed automatically.** Each standalone commit is rebuilt and checked before the public
  build moves to it.

## The numbers (public build, emulated networks, desktop Chromium)

| | 4G (9 Mbps) | Cable (5 Mbps) |
|---|---|---|
| First visit, open to playing | **23 s** (was 80 s) | 37 s |
| Downloaded before playing | **about 20 MB** (was 67 MB) | about 20 MB |
| Returning visit, open to playing | **8.5 s** (was 19 s) | 5.2 s |
| In game | 144 fps, about 300 MB memory | same |

- **Speed:** clicks show on screen in about 50 ms, and Start to playing takes about 1 s.
- **Co-commander, real local models on the GPU:**
  - The models: the product's Qwen3-VL 2B on CUDA llama.cpp, Whisper large-v3 and Kokoro.
  - **1.8 s median** from releasing the talk key to the spoken reply starting, over 23 spoken turns.
  - p95 is 11.8 s. Open "what should I do?" questions use the companion's planner and take 9 to 24 s; without them,
    the median is 1.6 s and p95 4.0 s.
  - Transcripts were word-exact on 23 of 24 lines.
  - Every order the co-commander understood became the right card, and every accepted card was executed.
  - Both sessions replayed natively with identical SyncHash.
  - Details and caveats are in [CO-COMMANDER.md](CO-COMMANDER.md#latency).
  - The CPU-only pack could not be measured fairly: the machine was saturated by other work.
  - Without the models, the overhead of the browser, relay and companion is 65 ms.

## What deploying needs (nothing is deployed)

1. **Owner approval** to publish. Recommended: a separate static Vercel project, which rtsai.net/play rewrites to.
   The build is ready: `node tools/build-public.mjs`.
2. **A preview check**:
   - the isolation headers;
   - the precompressed files arriving as brotli and not compressed twice;
   - the host's size limits for one 108 MB file. That file is only a fallback and can be left out.
3. **Owner approval for test browsers**: Playwright's Safari (WebKit) and Firefox builds, about 60–90 MB each. Until
   then only Chromium is tested.
4. **For the co-commander in the public build**: the hosted service, which needs the owner's environment variables
   for the hosted AI proxy.

## Open risks

- **Safari and Firefox are untested**, and the game relies on features they have only had in recent versions:
  - shared memory with isolation headers;
  - WebAssembly SIMD;
  - synchronous downloads in workers;
  - compression streams.
- **Real phones are untested.** Touch was tested in emulation on a desktop GPU; a real phone's CPU and memory may be
  slower.
- **Hosting.** A host or rewrite that drops the custom headers would break loading. The preview check above catches
  this.
- **Co-commander follow-ups.**
  - Offers that a later question dropped, and *I don't recognize …* for items not yet buildable, are fixed in
    OpenRA-AI d639b65. That companion keeps up to 3 offers and names the missing prerequisite. The browser shows
    every offer it holds. The latency numbers above predate that change.
  - The CPU-only stack still needs a measurement on a quiet machine.
- **Content still landing.** The standalone art is still landing. The rare special-death effects (about 2 MB) still
  ship until the standalone agent confirms they are unused.
