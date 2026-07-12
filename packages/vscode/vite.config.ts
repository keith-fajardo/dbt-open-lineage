import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// Build the webview app into media/. Relative base so asWebviewUri works.
export default defineConfig({
  plugins: [react()],
  base: "./",
  root: "src/webview",
  build: {
    outDir: resolve(__dirname, "media"),
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, "src/webview/index.html") },
  },
});
