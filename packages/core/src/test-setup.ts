// Shared vitest setup for @dbt-open-lineage/core: jsdom environment (configured
// in vitest.config.ts) + jest-dom matchers for React Testing Library assertions.
import "@testing-library/jest-dom/vitest";

// Ensure localStorage is available in jsdom environment
if (typeof globalThis !== "undefined" && !globalThis.localStorage) {
  const store: Record<string, string> = {};
  globalThis.localStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      for (const key in store) delete store[key];
    },
    length: Object.keys(store).length,
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
}
