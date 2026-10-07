/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "public" in the static public build: the standalone game by default. */
  readonly VITE_DEFAULT_PROFILE?: string;
}
