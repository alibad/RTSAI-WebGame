# Publishing the web game at rtsai.net/play: what it would take

**Status:** deployed on 9 October 2026 at https://rtsai.net/play/ following the owner's explicit deployment request. See [the release record](RELEASE-20261009.md) for source revisions and live checks. Future pushing or deploying needs the owner's approval. The workspace rules also
apply:
- standard build machine;
- no manual `vercel deploy` unless asked;
- `vercel usage --scope alibads-projects` before a manual production deploy.

## What gets published

`node tools/build-public.mjs` writes `build/public-web/`. This is the standalone game: project art and audio only,
no EA content, no server APIs (accounts, events and matchmaking: below). Its exact standalone and engine inputs are recorded in the verified `build-inputs.json`; use `tools/pin-standalone.ps1` to prepare those inputs.

The static builder validates the actual ORAPACK1 `ora/BUNDLE_ID` against each supplied `sprites/index.json` before deleting output or running Vite. Missing, malformed, duplicate or mismatched IDs stop the build; rebuild the prebakes from the exact current pack. The builder never relabels a cache automatically. Run `node --test tools/public-sprite-inputs.test.mjs` to check this guard and output preservation.

| Path | Contents | Raw | Stored and sent | Downloaded |
|---|---|---|---|---|
| `/` (index.html, assets/, flags/) | page (React UI, renderer, worker) | 0.8 MB | 0.2 MB (host compression) | always |
| `rt-<hash>/public/aot/_framework/` | .NET runtime + engine + mod, lean AOT | 48 MB | 11.0 MB (brotli 11) | always |
| `data-<hash>/public/web-bundle.pack` | rules, maps, terrain, small files | 9.2 MB | 4.7 MB (brotli 11) | always |
| `data-<hash>/public/sprites/` | prebaked sprite sheets, one set per faction + shared + effects | 467 MB | 16.7 MB (brotli 11) | shared 2.7 + own faction 1.6 before the game; the other factions and effects (2 MB) right after; factions not in the match only if they appear |
| `data-<hash>/public/audio/` | sounds and music, one file each | 84 MB | 70 MB (WAVs brotli) | as played; the announcer and the music fetched in the background |
| `data-<hash>/public/web-art.pack` + .json | large sprite files, read by byte range only if sheets were not prebaked | 108 MB | as stored | normally never |

`web-art.pack` can be left out (e.g. over a host's file-size limit): every map's sprites are prebaked, and since
8 October the cursor art is in the core bundle (it used to be read from the art pack at the start of every game: on a
host without the file that read failed and crashed the runtime, "memory access out of bounds"). A sprite the sheets lack
would still be read from the art pack; without it that read is now an I/O error the engine reports, not a crash.

The build also writes `vercel.json` and `_headers` (Netlify / Cloudflare Pages), plus `BUILD.json` (sizes,
standalone SHA, bundle id). To check the output exactly as a CDN would serve it:
`node tools/static-serve.mjs [--throttle 9000,170] [--h2]`.

## Accounts, events and matchmaking

The public game starts only for signed-in players (`VITE_REQUIRE_SIGNIN=1`, set by `build-public.mjs`). Sign-in,
`/api/event` and `/api/feedback` belong to the website (RTSAI-Web), which shares the rtsai.net origin with /play.

1. **Firebase web config.** Copy rtsai.net's public `NEXT_PUBLIC_FIREBASE_*` values into
   `web/.env.production.local` (gitignored) as `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`,
   `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID` and `VITE_FIREBASE_MEASUREMENT_ID`. `build-public.mjs` refuses
   to build without them, because the game would otherwise start for anyone.
2. **Firestore rules** for matchmaking and usage counters are deployed from RTSAI-Web
   (`firebase deploy --only firestore:rules --project rtsai-net`). Deploy them before a game build that uses them.
3. **Cleanup** is done by the clients: the host deletes each join offer once that guest is seated or turned away,
   and the match when it starts or closes. (Firestore TTL policies would need the paid Blaze plan; rtsai-net stays on
   the free Spark plan.)

## Hard requirements on the host

1. **Cross-origin isolation** for the snapshot ring (SharedArrayBuffer):
   - `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on the document and
     on everything under the game's path.
   - Every subresource is same-origin today, so nothing else is needed.
   - Keep these headers off the rest of rtsai.net: they would block third-party embeds there.
2. **Precompressed files.** Runtime, bundle, sprite sheets and WAVs are stored brotli-compressed and must be served
   with `Content-Encoding: br` (the header rules say so), not compressed again. Verify this on a preview: if a host
   ignores the rule, the browser receives brotli bytes it does not decode and the game fails to load.
3. **Byte ranges** (`Range` → `206`) for `web-art.pack` only (rarely used).
4. **Caching.** Runtime and data live under content-hashed roots (`rt-<hash>/`, `data-<hash>/`), and Vite hashes
   `assets/`, so all of them are `immutable`; only `index.html` revalidates. A returning player downloads
   `index.html` and nothing else until a new build.
5. **No SPA fallback** is needed: there is a single `index.html`, and the page uses relative URLs, so any base path
   such as `/play/` works.

## Options for rtsai.net/play

| Option | How | Pros | Watch out for |
|---|---|---|---|
| **A. Separate static project + rewrite** (recommended) | New Vercel project (framework: none, output `build/public-web`); RTSAI-Web adds a rewrite `/play/:path*` → that project | game deploys independently of the site; headers live in the game project; no 200+ MB in the site repo | the rewrite must pass COOP/COEP and `Content-Encoding` through; check on a preview before going live |
| B. Subdomain play.rtsai.net | same project on a subdomain; rtsai.net/play redirects | simplest isolation, no proxying | a second origin (fine: it shares nothing with the site) |
| C. Inside RTSAI-Web `public/play/` | copy the build into the site | one project | 200+ MB of binaries in the site repo and in every site deploy; headers must be scoped to /play |
| D. Heavy files on object storage | runtime/data on Vercel Blob or R2, page on Vercel | cheap egress (R2) | cross-origin under COEP: needs `Cross-Origin-Resource-Policy: cross-origin` + CORS; the page already takes its runtime and data roots from the build (`VITE_RT_BASE`, `VITE_DATA_BASE`), so they can point at another origin |

Before any of these, verify on a preview deployment:
- COOP/COEP headers present (`self.crossOriginIsolated === true` in the page);
- precompressed files arrive with `Content-Encoding: br` and are not compressed twice;
- the file-size and deployment-size limits for the 108 MB art pack, which I could not confirm from the docs search.
  It can be left out of a deployment entirely while every map's sheets are prebaked.

## First-visit numbers

Setup:
- Static build served by `tools/static-serve.mjs`, lean AOT runtime, Twin Fords, Saudi Arabia against Iran.
- Network emulated at the server: one shared downlink and its latency (WebPageTest profiles).
- Desktop Chromium on an RTX 5090 with a fresh disk profile.
- HTTP/1.1, and HTTP/2 over HTTPS (`--h2`, like a CDN).

| Network | Visit | Setup screen | Map + art ready | World started | Downloaded by world start |
|---|---|---|---|---|---|
| 4G (9 Mbps, 170 ms), HTTP/2 | first | 18.1 s | 21.6 s | **23.0 s** | about 20 MB |
| 4G, HTTP/1.1 | first | 19.8 s | 23.3 s | 24.7 s | about 20 MB |
| 4G, HTTP/1.1 | return | 5.7 s | 7.1 s | **8.5 s** | index.html (plus downloads the first visit left unfinished) |
| Cable (5 Mbps, 28 ms), HTTP/1.1 | first | 31.2 s | 35.5 s | 36.9 s | about 20 MB |
| Cable, HTTP/1.1 | return | 2.9 s | 4.1 s | 5.2 s | as above |

Before: 80.4 s and 66.7 MB on a 4G first visit, 18.9 s on a return visit.

Breakdown of a first visit (26.7 MB in the first three seconds of play):
- before the world starts:
  - runtime 10.6 MB;
  - bundle 4.7 MB;
  - shared sheets 2.7 MB and the player's faction 1.6 MB;
  - page 0.2 MB;
- right after, in the background: the opponent's sheets and the effects (about 3.6 MB), the opening music track and
  the announcer (about 2.9 MB).

In game: 240–300 MB heap, 144 fps. Start → playing: 1.0–1.4 s. Music never blocks start: it begins once its file is
in, and a sound that has not arrived is skipped.

What made the difference:
1. **Prebaked sheets per faction**, packed by the engine in groups (`SpriteCache.PackGroup`, `PackGroups.cs`). The
   game waits for the shared and own-faction sheets only.
2. **Planar sheets plus brotli 11.** Indexed sheets hold four 8-bit sprite planes in RGBA; stored plane by plane,
   cropped to the rows in use, they shrink about 3× more.
3. **Lean AOT.** Third-party assemblies are fully trimmed, IL is stripped after AOT, and libraries off the per-tick
   path are interpreted. Download 17 → 11 MB, same tick speed (mean 0.78 vs 0.82 ms over 1500 ticks), parity
   identical.
4. **Non-blocking audio** (`Sound.AudioReady` in the engine): no synchronous network read for music or sounds.
5. **Content-hashed immutable roots**, single-file audio, and parallel downloads (bundle alongside the runtime,
   shared sheets during engine boot).

## Browser matrix

| Browser | Status |
|---|---|
| Chromium desktop (Playwright) | full playtest, co-commander, parity verify: pass |
| Phones and tablets (Chromium emulation of Pixel 7 landscape, real touch events) | touch controls pass `tools/touch-test.mjs`: tap to select, tap to order, long-press to order onto own units (e.g. deploy), one-finger selection box, pinch zoom, two-finger tap to clear, cameo tap to build, long-press to hold. Compact sidebar below 600 px tall or 900 px wide; a "turn sideways" screen in portrait. Not measured with a phone's CPU. |
| WebKit and Firefox (Playwright) | not run: Playwright's WebKit and Firefox builds (about 60–90 MB each, from the Playwright CDN) are not installed, and installing them needs the owner's OK. The code paths they exercise all exist in current Safari (16.4+) and Firefox; the matrix is needed to confirm. |

The code paths those browsers would exercise:
- SharedArrayBuffer with COOP/COEP;
- WebAssembly SIMD;
- synchronous XHR in workers;
- CompressionStream and DecompressionStream;
- WebGL2.

## Not in the public build yet

- **Co-commander.** It needs either the player's local companion or hosted mode (see `docs/CO-COMMANDER.md`, waiting
  for the owner's environment variables).
- **Analytics and error reporting.**
- **A credits/licenses page** for the project's audio.
