import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Built to web/dist and served by server/serve.mjs on 127.0.0.1:3490 (which adds COOP/COEP and the runtime/data routes).
export default defineConfig({
  plugins: [react()],
  build: { target: "es2022", sourcemap: true },
  worker: { format: "es" },
});
