# Standalone browser modes and local integration

Isometric loads the project `rtsai` profile (`public`). Classic/top-down loads
`rtsai-topdown` (`public-classic`) with the fixed engine's Rectangular grid,
32×32 tiles, square radar/shroud cells and square campaign terrain. The historical
owned-RA2 `rtsai-classic` add-on is separate. Both standalone modes use shipped
project sprites/audio and require no owned game. Mode changes reload the page,
creating a fresh runtime and world. Native rules remain authoritative.

Build each mode with `tools/public.py --game-mode isometric|classic`, separate
new output directories and verified frozen inputs. Publish the standard browser
runtime against private copies of the same fixed engine and Mod inputs. Run
`node tools/stamp-runtime.mjs <published wwwroot/_framework>` after publishing;
copy that runtime into each mode's data directory. `tools/build-public.mjs --data
<public> --classic-data <public-classic> --out <new-output>` includes both modes
when Classic inputs exist. Direct/room compatibility binds selected profile,
runtime resource manifest and bundle hash; the lobby also validates map UID.
Save files bind the same identity. Missing or changed identities require the
original simulator/content before replay or resume.

The local companion uses version1 `/v1/contract`, read-only `/v1/advice`, deliberate
`/v1/proposals`, and displayed-ID `/v1/proposals/confirm` or `/cancel`. Ask and
speech do not apply orders. Prepare orders creates a reviewable card; Apply/G
confirms that exact pending ID. A lost confirmation response has unknown outcome:
poll state; further proposals are blocked until an exact engine receipt or explicit player review resolves the uncertainty. Never silently retry. Requests
use the versioned contract deadline and match cancellation; late replies/recordings and
compressed observations cannot mutate replacement worlds. Failed local startup
falls back to authoritative manual gameplay. Hosted providers stay disabled.

Local APIs and WebSocket upgrades validate the loopback remote address, exact
loopback Host/port and same-origin Origin before proxying or stripping Origin.
WebSocket upgrades require Origin. API clients without Origin remain supported.
`RTSAI_OPENRA_AI`, `RTSAI_COMPANION_PYTHON`, `RTSAI_MAP_MOD_ROOT`,
`RTSAI_MAP_PYTHON`, `RTSAI_MAP_OUTPUT_ROOT`, data/scratch/cache paths and ports
support isolated local copies. Static public builds omit local companion,
Map Studio, room-server controls and verification APIs. Direct WebRTC remains
available, with explicit invite/readiness and restart after disconnect/desync.

Local Map Studio preserves source indexing and both mode generation. Earth
outputs go to an owned build directory; Classic adapts the same geometry to
square project terrain/actor coordinates. Historical indexed mission folders
are evidence rather than a playability claim. Generated packages mount only in
their matching mode. Geographic API acquisition and native map verification are
separate checks; synthetic fixture evidence is labeled in session receipts.

A successful accepted world receipt emits a bounded local CustomEvent
`rtsai:world-started`, detail `{version:1,event:"world-started",mode:"classic"|
"isometric",transport:"singleplayer"|"direct"|"room"}`. An embedded game also
posts this payload with `type:"rtsai:world-started"` to its same-origin parent.
This contains no invite, room, player, network address or content identifying
information. A separate-origin tab cannot observe it without explicit topology
integration. Clicks, connected peers and ready lobbies are not world starts.

Verification commands: `npm --prefix web run build`,
`node tools/local-boundary-test.mjs`, `node tools/content-browser-test.mjs`,
`node tools/modes-browser-test.mjs`, `node tools/direct-browser-test.mjs`,
`node tools/multiplayer-browser-test.mjs`, `node tools/worker-lifecycle-test.mjs`,
`node tools/companion-integration-test.mjs` and `tools/fidelity.mjs --replay true`.
Use `RTSAI_TEST_URL/PROFILE/RUNTIME/OUT` and isolated outputs for each run.
Session receipts distinguish engine parity, local Chromium contexts, actual QA
captures, provider/model quality, real remote devices and public availability.

The browser Unit voice language setting uses the canonical local presentation
setting `RTSAISettings.VoiceLanguage`: `faction` and `en`, with invalid values
falling back to `faction`. The browser persists the choice in
`localStorage["rtsai.voiceLanguage.v1"]`, applies it after runtime boot and before
each fresh world, and updates it between ticks without gameplay orders or sync
fields. Setting/preview messages follow the current worker generation; old-world
messages cannot change replacement settings. Reset settings restores faction
language. Preview selected unit voice plays the actual local unit’s Select voice;
select a voiced local unit first, and retry if its audio is still loading.
`RTSAIVoiced` keeps the same voice family and uses its defined `__faction` or
`__en` variant, falling back to the original family if absent. This is local
presentation: peers may choose different languages while playing the same world.
Both-mode browser audio identifiers, persistence, invalid fallback and unchanged
hashes require the separate voice followup acceptance receipt. Native selector
proof alone does not establish browser behavior.

To integrate a reviewed game-document measurement adapter without recompiling
managed simulation or changing its runtime identity, use a NEW static copy:

```text
node tools/integrate-static-script.mjs --root <accepted-static> --script <verified-adapter.js> --out <new-owned-static>
```

This copies the static build, imports the hashed adapter before the Vite game
entry, preserves every runtime/data byte, and writes `STATIC-INTEGRATION.json`.
The output needs a new artifact manifest. The adapter must attach its event
listener synchronously when imported. Test actual accepted world events and
the intended same-origin route/embed topology independently; injection alone
does not establish analytics acceptance. This tool performs no publication.
