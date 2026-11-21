import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  /*
    Named rather than left to discovery.

    Vite pre-bundles dependencies when the server starts, and finds them by
    crawling the imports it can see. `mermaid` is reached only through a
    dynamic `import()` inside a component that most sessions never render, so
    it is not in that first crawl — the diagram's first appearance is what asks
    for it, and by then the optimiser has to stop, re-bundle and reload the
    page mid-use. Listing it here pays that cost once, at startup, where it
    belongs.
  */
  optimizeDeps: {
    include: ["mermaid"],
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
