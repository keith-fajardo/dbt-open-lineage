import { defineConfig } from "vitest/config";

// Plain Node (spawns child_process, reads fs) — no jsdom needed. Defaulting
// the whole package to Node means colibri.test.ts's child_process mock
// doesn't need the "// @vitest-environment node" per-file override that
// was required in packages/cli (whose vitest.config.ts defaults to jsdom
// for its webview tests) — see that package's colibri.test.ts history for
// why the override existed there.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
