# Publishing the web game at rtsai.net/play: what it would take

**Status:** prepared, not deployed. Pushing or deploying needs the owner's approval. The workspace rules also
apply:
- standard build machine;
- no manual `vercel deploy` unless asked;
- `vercel usage --scope alibads-projects` before a manual production deploy.

## What gets published

`node tools/build-public.mjs` writes `build/public-web/`. This is the standalone game: project art and audio only,
no EA content, no server APIs. It is pinned by `tools/pin-standalone.ps1`; today that is rtsai/standalone 93fd6e6.

| Path | Contents | On disk | Over the wire |
|---|---|---|---|
| `/` (index.html, assets/, flags/) | page (React UI, renderer, worker) | 0.7 MB | 0.2 MB (brotli) |
| `rt/public/aot/_framework/` | .NET runtime + engine + mod, AOT | 65 MB | 17 MB (brotli) |
| `data/public/web-bundle.pack` | rules, maps, terrain, small files | 11.8 MB | 5 MB (brotli) |
| `data/public/sprites/` | prebaked sprite sheets (gzip) + index | 42 MB | 42 MB |
| `data/public/web-audio.pack` + .json | sounds and music, read by byte range | 83 MB | as played |
| `data/public/web-art.pack` + .json | large sprite files, read by range only if the sheets are not prebaked | 103 MB | normally 0 |

The build also writes `vercel.json` and `_headers` (Netlify / Cloudflare Pages), plus `BUILD.json` (sizes,
standalone SHA, bundle id). To check the output exactly as a CDN would serve it:
`node tools/static-serve.mjs [--throttle 9000,170]`.

## Hard requirements on the host

1. **Cross-origin isolation** for the snapshot ring (SharedArrayBuffer):
   - `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on the document and
     on everything under the game's path.
   - Every subresource is same-origin today, so nothing else is needed.
   - Keep these headers off the rest of rtsai.net: they would block third-party embeds there.
2. **Byte ranges** (`Range` → `206`) for `web-audio.pack` and `web-art.pack`. The worker reads them with synchronous
   range requests, so do not compress these two files on the fly.
3. **Compression** (brotli or gzip) for `.wasm`, `.js` and `web-bundle.pack`. Without it, the runtime alone is
   65 MB instead of 17 MB.
4. **Caching.**
   - Hashed `assets/` are immutable.
   - `data/` and `rt/` keep stable names and revalidate with ETag. A returning visitor downloads about 3–8 MB,
     mostly the music track that starts the match.
5. **No SPA fallback** is needed: there is a single `index.html`, and the page uses relative URLs, so any base path
   such as `/play/` works.

## Options for rtsai.net/play

| Option | How | Pros | Watch out for |
|---|---|---|---|
| **A. Separate static project + rewrite** (recommended) | New Vercel project (framework: none, output `build/public-web`); RTSAI-Web adds a rewrite `/play/:path*` → that project | game deploys independently of the site; headers live in the game project; no 270 MB in the site repo | the rewrite must pass COOP/COEP and Range through; check on a preview before going live |
| B. Subdomain play.rtsai.net | same project on a subdomain; rtsai.net/play redirects | simplest isolation, no proxying | a second origin (fine: it shares nothing with the site) |
| C. Inside RTSAI-Web `public/play/` | copy the build into the site | one project | 270 MB of binaries in the site repo and in every site deploy; headers must be scoped to /play |
| D. Heavy files on object storage | runtime/data on Vercel Blob or R2, page on Vercel | cheap egress (R2) | cross-origin under COEP: needs `Cross-Origin-Resource-Policy: cross-origin` + CORS incl. Range; the page needs a configurable data base URL (not built yet) |

Before any of these, verify on a preview deployment:
- COOP/COEP headers present (`self.crossOriginIsolated === true` in the page);
- `206` replies for range reads on the `.pack` files;
- brotli on `.wasm`;
- the file-size and deployment-size limits for the 83 MB and 103 MB packs, which I could not confirm from the docs
  search.

## First-visit numbers

Setup:
- Static build served by `tools/static-serve.mjs`, AOT runtime, Twin Fords.
- Network emulated at the server: a shared downlink and latency (WebPageTest profiles).
- Desktop Chromium on an RTX 5090 with a fresh disk profile.
- HTTP/1.1 here; a CDN's HTTP/2 or 3 avoids the six-connection limit, so real numbers should be slightly better.

| Network | Visit | Setup screen | Map + art ready | World started | Transferred |
|---|---|---|---|---|---|
| 4G (9 Mbps, 170 ms) | first | 33.5 s | 74.4 s | 80.4 s | 66.7 MB |
| 4G | return | 5.4 s | 12.3 s | 18.9 s | 7.8 MB |
| Cable (5 Mbps, 28 ms) | first | 47.6 s | 118.4 s | 124.2 s | 66.3 MB |
| Cable | return | 2.6 s | 4.1 s | 10.5 s | 2.7 MB |

Breakdown:
- In game: 240–290 MB heap, 144 fps.
- Start → playing takes about 6 s. About 1.7 s is CPU; the rest is the opening music track: NVorbis scans the whole
  2.3 MB file before it plays.
- The first visit is dominated by:
  - the sprite sheets: 42 MB, up from 28 MB since the art agent's effects landed;
  - the runtime: 17 MB.

What would cut it next:
1. **Sheets per need.** Ship sheets per faction or tileset instead of one packing for every actor, or use brotli or
   zstd sheets once DecompressionStream supports them everywhere.
2. **Background download.** Keep the setup screen useful while the art downloads; it already shows "Loading art n%".
3. **Music.** Start the opening track lazily (compute the Ogg length on demand, or prefetch the first track).

## Browser matrix

| Browser | Status |
|---|---|
| Chromium desktop (Playwright) | full playtest, co-commander, parity verify: pass |
| Mobile viewport (Pixel 7 portrait/landscape, iPad Pro 11 landscape; Chromium emulation, touch) | loads and plays (about 11 s from open to playing on an unthrottled link, 245 MB heap, no horizontal overflow); the setup screen stacks well in portrait. In game the RA2-style sidebar takes ~30% of a landscape phone and its build palette is cut off, and every control assumes a mouse (right-click, hover). A touch layout is still to do. |
| WebKit and Firefox (Playwright) | not run: Playwright's WebKit and Firefox builds (about 60–90 MB each, from the Playwright CDN) are not installed, and installing them needs the owner's OK. The code paths they exercise all exist in current Safari (16.4+) and Firefox; the matrix is needed to confirm. |

The code paths those browsers would exercise:
- SharedArrayBuffer with COOP/COEP;
- WebAssembly SIMD;
- synchronous XHR in workers;
- CompressionStream / DecompressionStream;
- WebGL2.

## Not in the public build yet

- **Co-commander.** It needs either the player's local companion or hosted mode (see `docs/CO-COMMANDER.md`, waiting
  for the owner's environment variables).
- **Touch controls and a mobile layout.**
- **Analytics and error reporting.**
- **A credits/licenses page** for the project's audio.
