# Multiplayer

One **Multiplayer** button, peer-to-peer play, for signed-in players.

## For players

1. Host: **Multiplayer → Create match**, then **Copy invite** and send the link in any chat app.
2. Friends open the link. The game loads and drops them straight into the lobby. They can also paste the link or type
   the 6-character code under **Have an invite?**.
3. The host picks the map (or **New random map**) and AI opponents. Everyone picks a faction and team. Guests press
   **Ready**.
4. The host presses **Start match**.

A match holds up to the map's slot count (4 on Four Fronts, 2 elsewhere), humans first, then AI. Lobby chat,
in-match chat (Enter) and an optional camera and microphone are included.

## How it works

```
 browser A (host) ── offer/answer only ──▶ Firestore p2pMatches (rtsai-net) ◀── browser B, C …
        ▲                                                                       │
        └──────────── direct WebRTC data channel: lobby, orders, chat, media ◀──┘
```

- **Accounts.** Multiplayer (like the whole public game) needs a signed-in rtsai.net account. The game is served at
  rtsai.net/play, the same origin as the website, so the website's Firebase sign-in is visible to the game
  (`web/src/net/account.ts`).
- **Matchmaker** (`web/src/net/matchmaker.ts`, Firestore). It introduces browsers and nothing else.
  - The host creates `p2pMatches/{code}` naming itself.
  - A guest adds `joins/{id}` holding its WebRTC offer. Only the host can list and read the offers, and only the host
    can answer them.
  - Both sides are pushed updates (no polling). The host deletes each offer once that guest is seated or turned
    away, and the match when it starts or closes.
  - The rules live in RTSAI-Web `firestore.rules` and are tested by RTSAI-Web `tools/firestore-rules-test.mjs`.
- **Star topology.** Each guest connects to the host. The host runs the lobby and relays every player's order and
  hash events to the others, so every world receives identical frames.
- **Lockstep with an input delay** (`PeerLockstep` in `web/src/peer.ts`, since 20 Nov 2026).
  - The orders a player's engine issues at frame n run at frame n + delay in every world, and the first `delay`
    frames run without orders. So a frame's orders are already travelling while the frames before it play, and the
    match keeps the game's own speed (25 frames a second) as long as a message crosses in less than delay + 1 frames.
    A slower line holds frames back until its orders arrive; it never skips or guesses one.
  - The host picks the delay when it starts the match, from the pings it measured in the lobby (`inputDelay`): the
    slowest path one way (guest to host, or guest to guest through the host) plus one 40 ms frame of room, at least
    2 frames (80 ms) and at most 12. OpenRA's own default is 3 frames. "Connection details" shows it in ms.
  - Before this, a frame waited for every player's orders for that same frame and for the previous frame's hashes, so
    each frame cost a round trip: measured with two players, 59% of game speed at 100 ms ping, 40% at 150 ms and
    24% at 300 ms (`tools/multiplayer-speed-probe.mjs`).
  - The engines' SyncHash reports are compared as they arrive and no longer hold frames back. The first frame whose
    reports differ stops the match for everyone and is named. Malformed or conflicting input stops it too.
  - The engine worker (`web/src/sim/worker.ts`) keeps the released frames in a short queue and plays one per 40 ms
    beat; an engine that fell behind the others plays two.
  - Bots run on the host (client 1), as in OpenRA.
  - The match's version string starts with `p2p-2`: a page with the older lockstep (`p2p-1`) is told to reload.
- **Random maps.** The lobby carries the request that made a random map (seed, player count, landscape;
  `Lobby.generated`), not the map. Each guest's browser makes the map from it with the engine's map generator, which
  is deterministic: the same request gives the same map and the same uid (the preview's colours are drawn from the
  seed, since the uid hashes the preview). A guest can press Ready only once its copy exists, and a copy that comes out
  different is reported instead of joining. Proof: `tools/random-map-multiplayer-test.mjs` (two browsers, the
  emulators, a synchronized match on the map). The page names a random map ("Coldwater Gap") from the seed the engine
  made it with and its landscape (`web/src/map-names.ts`), so every player's copy has the same name; the engine's
  title in the map files ("Lakes 2489"), which the uid hashes, is unchanged. `node tools/map-names-unit-test.mjs`.
- **Compatibility.** The game build fingerprint (`runtime-identity.json` + content pack) must match. The guest
  checks the match's version before joining, and the host checks again over the direct channel.
- **Disconnects.** A guest leaving the lobby frees the seat. During a match, anyone leaving or going silent for
  15 seconds stops the match for everyone with the reason on screen. There is no reconnection.
  - Closing or reloading the tab says goodbye first (`pagehide`), so the others read "Player 3 left the match" at
    once. Before 20 Nov 2026 a closed tab was only noticed by the 15-second silence check.
  - Once a player's own result is on screen (Victory or Defeat), the other player going back to the menu ends the
    match quietly: the bar reads "Match over", with no error over the result.
- **Ready.** A guest's Ready names the lobby settings it agreed to. A settings change (map, AI, anyone's nation or
  team) clears everyone's Ready; a join, a leave or another player's Ready does not, and no longer swallows a Ready
  that was on its way.
- **A match that stands still says so.** When no frame has played for 1.5 seconds, the match bar turns amber and
  names whose orders the match is waiting for ("Waiting for Player 2…"); at the very start it says that their game
  is still loading, and from 5 seconds on it counts the seconds. It promises no time: only a silent line ends the
  match (15 seconds without any message), not a slow game.
- **Networks.** Public STUN servers (Google, Cloudflare) find routes. There is no TURN relay. Some strict networks
  cannot connect directly.
  - The guest then reads "Couldn't connect directly to your host. Some networks block direct connections; try
    another network, such as a phone hotspot", whichever way the failure is noticed. (Until 20 Nov 2026 that advice
    showed only when the 20-second wait ran out; the browser usually gives up first, and the guest read just
    "Couldn't connect to your host".)
  - The host's lobby says "A friend opened your invite but didn't get through…" instead of only waiting for
    friends. The host can't tell a blocked network from a friend who gave up, so it claims neither.
- **Failed joins are reported** (since 1 Nov 2026), so we learn how many players a relay would help. A guest whose
  join fails on the network sends one `game_error` event: `where: network`, which the weekly digest groups under
  network errors. Its message names the step:
  - "no connection route found";
  - "the host never answered";
  - "the direct line never opened".

  Its props carry:
  - what the player saw;
  - the guest's connection type (`wifi` or `cellular` where the browser says so);
  - the kinds of route each side offered (`host`, `srflx`, `relay`);
  - whether each side's NAT keeps one public port or gives each STUN server a new one ("symmetric", which needs a
    relay with most partners). `routeSummary` in `peer.ts` computes this in the browser, and no address is sent.

  A guest who gives up, an expired invite or a different game version is not a network failure, and is not
  reported.

## Checks

```powershell
node tools/peer-unit-test.mjs               # the lockstep with its input delay, scenarios, connection hygiene
node tools/join-failure-browser-test.mjs    # failed joins: real WebRTC in Chromium, the matchmaker stubbed
# The browser test, the speed probe and the films need: the Firebase emulators (auth + firestore, project
# demo-rtsai; RTSAI-Web's firebase.json, or a config with your own ports), and a game build with
# VITE_FIREBASE_EMULATORS=1 VITE_REQUIRE_SIGNIN=1 (plus VITE_FIREBASE_EMULATOR_PORTS="<auth>,<firestore>" for other
# ports) served with its runtime and data on one origin (tools/local-site-server.mjs <build> <port>).
$env:RTSAI_TEST_URL = 'http://127.0.0.1:3520/play/'
$env:RTSAI_FIRESTORE_EMULATOR = '127.0.0.1:8085'
node tools/multiplayer-browser-test.mjs
node tools/multiplayer-speed-probe.mjs --pings 0,100,200,300 [--players 4] [--jitter 60]
node tools/multiplayer-film.mjs --scenario happy --clips <folder> --work <folder>
```

All three share `tools/multiplayer-harness.mjs`: players as independent Chromium contexts (Firefox too), the emulator
build's test sign-in, every frame's time and SyncHash kept per page, and a shim on the direct line that holds every
message back by half a ping, holds the line (a dropped connection) or makes the other side unreachable (two networks
with no direct route). Host ICE routes only: players on one machine, not a cross-network certification.

The browser test runs three players:
- the sign-in gate (nothing boots before sign-in) and an invite waiting behind it;
- invite-link auto-join, code join, bad codes, a build-mismatch rejection, and a full match that says so;
- a four-slot map with AI, where any settings change clears readiness;
- lobby chat relayed through the host, and a camera to the host;
- a mobile-width lobby;
- a synchronized three-player match with AI: all deploy orders applied in every world, matching hashes, in-match
  chat, the input delay shown to the player;
- a closed tab: the others read "Player 3 left the match" within seconds, and every world stops;
- a second match 100 ms apart that keeps at least 19 of the game's 25 frames a second;
- four seconds without the line: each player reads whom the match waits for, then it goes on, still in step;
- a host quit that stops the guest;
- a friend on an unreachable network: the guest reads what to try, the host reads that a friend didn't get through;
- with `RTSAI_TEST_WEBSITE=1` (the website on the same origin and emulators): every player's match counted by
  `/api/event`, and in-match feedback reaching `/api/feedback`.

Screenshots and a receipt go to `artifacts/multiplayer/`.

The speed probe plays one short match per ping and prints the frames a second each player reached and whether every
frame's hash agreed. The film tool records every player's window on one clock and cuts them side by side
(`docs/VIDEO-ROADMAP.md`).

## In-game chat

Press **Enter** on the battlefield to open chat, type, and press **Enter** to send. Focus returns to the game.
**Escape** closes the composer and keeps your draft. The upper-left corner shows up to four recent messages for
15 seconds. Messages go to everyone in the match.
