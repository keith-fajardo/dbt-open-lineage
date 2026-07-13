import { defineConfig } from "vitest/config";

// jsdom (not "node"): staticBridge.test.ts exercises a browser download via
// document.createElement, and jsdom is a strict superset for the Node-side
// generate/template tests in this same package — no need to split configs
// the way packages/vscode does (that split exists because of a conflicting
// vite.config `root`, which this package's vite.config.ts doesn't set).
export default defineConfig({
  test: { environment: "jsdom", include: ["src/**/*.test.ts"] },
});
