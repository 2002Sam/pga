import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Built into the app (served as pga://app/ by the native shell). `npm run dev` serves it at :5180 with /v1 passed on to
// the PGA server, so it can be worked on in a browser too (?uid=…&mode=float|home).
export default defineConfig({
  plugins: [svelte()],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, target: "safari16", assetsInlineLimit: 0 },
  server: { port: 5180, proxy: { "/v1": "http://localhost:8010" } },
});
