import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Relative base so the built bundle loads from a file:// asset path in the host.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
});
