# RTS AI video roadmap

## First delivery: multiplayer, 9 October 2026

Two local review cuts are in `artifacts/videos/multiplayer/`:

| Cut | Length | Purpose |
| --- | --- | --- |
| `multiplayer-walkthrough.mp4` | 55 seconds | Explain the complete two-player room flow, with alternating host/guest views and a final simultaneous view. |
| `multiplayer-quick-intro.mp4` | 28 seconds | A short introduction to creating, inviting, joining, readying and playing. |

Both are 1920×1080 H.264 MP4 at 30 fps, with fast-start metadata. They have burned-in explanatory captions, no soundtrack or voice-over, and matching `.vtt` and `.srt` files. They can be understood without audio. `poster.jpg` is a thumbnail. These are local review assets; nothing has been uploaded or published.

The footage is actual browser capture, using two independent clients, the public content profile and no owned RA2 installation. Both clients deployed their bases and used room chat. The server verified matching OpenRA hashes through frame 300 during the recording. `shots.json` preserves source timestamps, client identity and the synchronization evidence; `raw/` preserves both original recordings. Check any chosen footage against the product's canonical asset provenance index before approving website publication, including UI portraits and terrain. Public-profile capture alone is not a provenance audit.

## The flow a player should understand

1. Start `launch-multiplayer.cmd` and keep the server running.
2. Player 1 chooses Private multiplayer → Create private room.
3. Player 1 copies the invite. Player 2 opens it in a separate browser profile/private window, or pastes the invite into Join room.
4. The host chooses the map and optional AI opponents. Each human chooses a faction and team. Matching numbered teams are allies.
5. Both players press Ready. Changes to the setup clear ready states.
6. The host starts. Each commander controls their own side of the synchronized match and can coordinate through room chat.

**Current room scope:** the default server binds to loopback. This particular invite flow is a local desktop preview on one computer, demonstrated with independent browser contexts. A `127.0.0.1` invite sent to another computer does not connect to the host. Do not describe this video as proven internet private-room play. The separate direct peer-to-peer feature needs its own introduction and acceptance evidence before featuring it.

**Mobile:** the setup/lobby has a narrow-screen layout check, but complete touch multiplayer, performance and reconnection on real phones have not been verified. Mobile is deferred; these videos present desktop controls only.

## Story sequence

| Priority | Video | User's question | Evidence needed before filming/publishing |
| --- | --- | --- | --- |
| Now | Two-player room walkthrough | How do my friend and I start? | Delivered local review cut; retain the local-preview label. |
| Next | First five minutes, edited to 60–90 seconds | What do we do after joining? | Real base building, resource collection and combat; capture both sides and record hashes. |
| Next | Teams and AI, 30–45 seconds | Can we cooperate against the computer? | Two humans on one numbered team against an AI team; actual alliance and combat behavior. |
| After desktop release checks | Play on separate computers, 45–60 seconds | Can I invite a friend elsewhere? | Tested release/runtime compatibility, working access/invite path, two physical computers and interrupted-network recovery. Film the actual supported flow. |
| After mode consolidation | Classic and isometric, 30–45 seconds | Which style should I choose? | One entry point, actual in-game mode choice and approved assets for both modes in the canonical product. |
| Later | A mission in one minute | What story am I playing? | Real briefing, objective progress and a successful ending, using the verified mission build. |
| Later | AI coaching, 30–45 seconds | How does the assistant help? | A real suggestion followed by a visible outcome; distinguish coaching from autonomous orders. |
| Deferred | Mobile | Can I play on my phone? | Real-device controls, GPU/memory performance, legible UI, background/resume and multiplayer acceptance tests. |

Lead with an understandable action and result. Keep the desktop UI readable, show the actual controls, include captions and end with the next useful action. Avoid filling a short introduction with engine statistics. Use the quick cut near a multiplayer introduction and the full walkthrough beside detailed instructions; publish neither automatically.

## Reproduce and revise locally

With the local server already running on 3491:

```powershell
node tools/record-multiplayer-video.mjs
$env:RTSAI_FFMPEG = (Get-Command ffmpeg).Source
node tools/render-multiplayer-video.mjs
```

Capture uses the existing Playwright Chromium installation. Rendering uses local FFmpeg and installed Windows Segoe UI fonts. Recording overwrites these generated review outputs; save an approved revision separately before regenerating. The raw recordings include engine startup and waiting time. The edited cuts remove most waiting and retain the real flow and normal-speed gameplay. The shot list is editable, so the cuts can be revised without recording everything again.
