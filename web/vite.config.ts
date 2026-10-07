import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Built to web/dist and served by server/serve.mjs on 127.0.0.1:3490 (which adds COOP/COEP and the runtime/data
// routes). `base` is relative so the same build also works behind the local app's /play proxy.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  // The static public build (tools/build-public.mjs) ships without source maps.
  build: { target: "es2022", sourcemap: process.env.RTSAI_PUBLIC_BUILD !== "1" },
  worker: { format: "es" },
});
