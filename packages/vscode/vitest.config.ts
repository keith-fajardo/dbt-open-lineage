import { defineConfig } from "vitest/config";

// Host tests are plain Node (fs/child_process) — no jsdom/React needed.
// A separate config file is required: vitest would otherwise inherit
// vite.config.ts's `root: "src/webview"` (webview build config) and fail to
// discover src/host/**/*.test.ts.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
