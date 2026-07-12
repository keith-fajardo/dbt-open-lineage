import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Needs the react plugin so .tsx test/source files get the automatic JSX
// runtime transform (matches vite.config.ts, which vitest does NOT inherit
// since this is a separate config file).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
