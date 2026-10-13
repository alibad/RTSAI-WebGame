# Web RTS: direct play

The public build is static. Players sign in on rtsai.net first. It contains the game, sprites, original audio and the AOT simulation. Friends play through **Multiplayer**: the host creates a match and sends an invite link, and everyone's browser connects directly to the host's (see [MULTIPLAYER.md](MULTIPLAYER.md)). Chat and the optional camera and microphone use the same WebRTC connections. Media permissions are requested only when a player starts their camera.

No owned Red Alert installation is needed. The Firestore matchmaker only introduces browsers, and public STUN endpoints help discover routes. Neither runs the match. There is no TURN relay. Same-machine/LAN acceptance passed; connections across restrictive networks remain an acceptance item. Public hosting must use HTTPS for camera access and retain the provided isolation and Brotli headers.

Build and preview locally from RTSAI-WebGame:

```powershell
node tools/build-public.mjs --out D:/rtsai-release/dual-20261009/web-public --quality 4
node tools/serve-static.mjs --root D:/rtsai-release/dual-20261009/web-public --port 3507
```

Open `http://127.0.0.1:3507/`. Sign-in, events and feedback come from the website: use `tools/feature-preview.mjs` to serve the game at /play/ beside a website dev server, as on rtsai.net. A model co-commander needs the local companion; ordinary bots and the AI workshop do not need a model. Classic presentation is still a browser migration item.

Multiplayer checks are listed in [MULTIPLAYER.md](MULTIPLAYER.md#checks).

Checks:

```powershell
node tools/peer-unit-test.mjs
$env:RTSAI_TEST_URL='http://127.0.0.1:3494/play/'   # tools/feature-preview.mjs: game + website, one origin
node tools/multiplayer-browser-test.mjs
```
