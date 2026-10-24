/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: proxy the control API so `npm run dev` works against a local farm-control.
export default defineConfig({
  plugins: [react()],
  // Two pages: the map (index.html) and the evidence page control serves at /e/<id> (evidence.html).
  build: { rollupOptions: { input: { index: "index.html", evidence: "evidence.html" } } },
  server: {
    proxy: {
      "/api": process.env.FARM_CONTROL ?? "http://127.0.0.1:8000",
      "/pub": process.env.FARM_CONTROL ?? "http://127.0.0.1:8000",
      "/e": process.env.FARM_CONTROL ?? "http://127.0.0.1:8000",
    },
  },
  test: { environment: "node", globals: true },
});
