/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "public" in the static public build: the standalone game by default. */
  readonly VITE_DEFAULT_PROFILE?: string;
  /** Static public build: the content-hashed runtime and data roots (e.g. "rt-3f2a1c/"); "rt/", "data/" otherwise. */
  readonly VITE_RT_BASE?: string;
  readonly VITE_DATA_BASE?: string;
}
