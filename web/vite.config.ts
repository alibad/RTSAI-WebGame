import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The website's own source (RTSAI-Web): the battle simulator's unit cards draw with its Faction viewer components
// (@site/app/components/art/...), the same files, not a copy. RTSAI_SITE_ROOT points elsewhere when the checkouts
// are not siblings.
const site = path.resolve(process.env.RTSAI_SITE_ROOT ?? path.join(__dirname, "../../RTSAI-Web"));

// Built to web/dist and served by server/serve.mjs on 127.0.0.1:3490 (which adds COOP/COEP and the runtime/data
// routes). `base` is relative so the same build also works behind the local app's /play proxy.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  // One React for the game and the website's components.
  resolve: { alias: { "@site": site }, dedupe: ["react", "react-dom", "lucide-react"] },
  server: { fs: { allow: [__dirname, site] } },
  // The static public build (tools/build-public.mjs) ships without source maps.
  build: { target: "es2022", sourcemap: process.env.RTSAI_PUBLIC_BUILD !== "1" },
  worker: { format: "es" },
});
