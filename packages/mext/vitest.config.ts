import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Needs the react plugin so .tsx source files get the automatic JSX runtime
// transform (matches vite.config.ts, which vitest does NOT inherit since
// this is a separate config file — see packages/core/vitest.config.ts).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
