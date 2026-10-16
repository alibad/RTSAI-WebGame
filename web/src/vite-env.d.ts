/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Explicitly enables engine diagnostics in the development server only. */
  readonly VITE_DEVELOPER_TOOLS?: string;
  /** Developer server only: opt into local-model and scripted test hooks. Never enabled by production builds. */
  readonly VITE_COMPANION_DEV_TOOLS?: string;
  /** "public" in the static public build: the standalone game by default. */
  readonly VITE_DEFAULT_PROFILE?: string;
  /** Static public build: the content-hashed runtime and data roots (e.g. "rt-3f2a1c/"); "rt/", "data/" otherwise. */
  readonly VITE_RT_BASE?: string;
  /** Where published mission briefings live (campaign/index.json), e.g. the CDN; unset keeps the bundled introductions. */
  readonly VITE_CAMPAIGN_BASE?: string;
  readonly VITE_DATA_BASE?: string;
  /** The rtsai-net Firebase web config (public values, shared with rtsai.net). */
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
  readonly VITE_FIREBASE_MEASUREMENT_ID?: string;
  /** "1": use the local Firebase emulators (tests). */
  readonly VITE_FIREBASE_EMULATORS?: string;
  /** "1": the game starts only for signed-in players (public build). */
  readonly VITE_REQUIRE_SIGNIN?: string;
  /** The website that owns sign-in, /api/event and /api/feedback; "" = this origin (rtsai.net/play). */
  readonly VITE_SITE_ORIGIN?: string;
}
