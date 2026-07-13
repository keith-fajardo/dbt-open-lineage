import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds the browser bundle straight from a .tsx entry (no HTML entry
// point — packages/cli/src/template.ts owns index.html generation instead).
// Deterministic, unhashed asset filenames so the template can reference
// them by a known path without reading a manifest.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist/webview",
    emptyOutDir: true,
    rollupOptions: {
      input: "src/webview/main.tsx",
      output: { entryFileNames: "assets/main.js", assetFileNames: "assets/main[extname]" },
    },
  },
});
