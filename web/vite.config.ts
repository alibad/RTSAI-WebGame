import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The website's own source (RTSAI-Web): the battle simulator's unit cards draw with its Faction viewer components and
// the map editor builds real places with its Earth compiler (@site/...), the same files, not a copy. It is found at
// RTSAI_SITE_ROOT, else beside this checkout or beside a parent folder (a worktree in a subfolder).
const siteCandidates = process.env.RTSAI_SITE_ROOT
  ? [path.resolve(process.env.RTSAI_SITE_ROOT)]
  : [1, 2, 3].map((up) => path.resolve(__dirname, "../".repeat(up), "RTSAI-Web"));
const site = siteCandidates.find((dir) => fs.existsSync(path.join(dir, "lib", "earth-evidence.ts"))) ?? siteCandidates[0];

/**
 * Checks the website source is there, and writes its Faction viewer data into public/viewer (tools/sync-viewer.mjs)
 * when it is missing, so any checkout builds the unit cards complete. The build records the website's commit.
 */
function websiteSource(): Plugin {
  return {
    name: "rtsai-website-source",
    config() {
      if (!fs.existsSync(path.join(site, "lib", "earth-evidence.ts")))
        throw new Error(`The website's source (RTSAI-Web) isn't at ${siteCandidates.join(" or ")}. Clone it beside RTSAI-WebGame or set RTSAI_SITE_ROOT.`);
      let commit = process.env.RTSAI_SITE_COMMIT?.slice(0, 12) ?? "";
      if (!commit) try { commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: site }).toString().trim(); } catch { /* verified Git-free release input */ }
      return { define: { "import.meta.env.VITE_SITE_COMMIT": JSON.stringify(commit) } };
    },
    buildStart() {
      if (!fs.existsSync(path.join(__dirname, "public", "viewer", "index.json")))
        execFileSync(process.execPath, [path.join(__dirname, "..", "tools", "sync-viewer.mjs"), "--from", site], { stdio: "inherit" });
    },
  };
}

/** This repository's commit, for the menu's "Source code" link (the GPL source of exactly this build). A release builds
 *  the page from a clean main checkout, so HEAD is the commit its BUILD.json names. RTSAI_GAME_COMMIT: Git-free builds. */
function gameCommit() {
  if (process.env.RTSAI_GAME_COMMIT) return process.env.RTSAI_GAME_COMMIT;
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: __dirname }).toString().trim(); } catch { return ""; }
}

// Built to web/dist and served by server/serve.mjs on 127.0.0.1:3490 (which adds COOP/COEP and the runtime/data
// routes). `base` is relative so the same build also works behind the local app's /play proxy.
export default defineConfig({
  // Keep HTML inputs and root on the same resolved path in Windows packaged-app build snapshots.
  root: __dirname,
  base: "./",
  plugins: [websiteSource(), react(), tailwindcss()],
  define: { "import.meta.env.VITE_GAME_COMMIT": JSON.stringify(gameCommit()) },
  // One React for the game and the website's components.
  resolve: { alias: { "@site": site }, dedupe: ["react", "react-dom", "lucide-react"] },
  server: { fs: { allow: [__dirname, site] } },
  // The static public build (tools/build-public.mjs) ships without source maps.
  build: { target: "es2022", sourcemap: process.env.RTSAI_PUBLIC_BUILD !== "1" },
  worker: { format: "es" },
});
