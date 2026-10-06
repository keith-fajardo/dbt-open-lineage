import { describe, it, expect } from "vitest";
import { parseRuntimeCost, formatRuntime, formatCost, RUNTIME_COST_PATH } from "./runtimeCost";

describe("parseRuntimeCost", () => {
  it("indexes records by unique_id", () => {
    const m = parseRuntimeCost(JSON.stringify([
      { unique_id: "model.p.a", runtime_seconds: 12.3, cost_usd: 0.04 },
      { unique_id: "model.p.b", runtime_seconds: 0.5, cost_usd: 0 },
    ]));
    expect(m.get("model.p.a")).toEqual({ runtimeSeconds: 12.3, costUsd: 0.04 });
    expect(m.get("model.p.b")).toEqual({ runtimeSeconds: 0.5, costUsd: 0 });
    expect(m.size).toBe(2);
  });

  it("lets the last record win on a duplicate unique_id", () => {
    const m = parseRuntimeCost(JSON.stringify([
      { unique_id: "model.p.a", runtime_seconds: 1, cost_usd: 1 },
      { unique_id: "model.p.a", runtime_seconds: 2, cost_usd: 2 },
    ]));
    expect(m.get("model.p.a")).toEqual({ runtimeSeconds: 2, costUsd: 2 });
  });

  it("keeps a record that carries only one of the two values", () => {
    const m = parseRuntimeCost(JSON.stringify([
      { unique_id: "model.p.a", runtime_seconds: 3 },
      { unique_id: "model.p.b", cost_usd: 0.2 },
    ]));
    expect(m.get("model.p.a")).toEqual({ runtimeSeconds: 3, costUsd: undefined });
    expect(m.get("model.p.b")).toEqual({ runtimeSeconds: undefined, costUsd: 0.2 });
  });

  it("skips records with no usable id or no usable values", () => {
    const m = parseRuntimeCost(JSON.stringify([
      { runtime_seconds: 1, cost_usd: 1 },
      { unique_id: 7, runtime_seconds: 1 },
      { unique_id: "model.p.nothing" },
      { unique_id: "model.p.strings", runtime_seconds: "12", cost_usd: "0.1" },
      { unique_id: "model.p.nan", runtime_seconds: null, cost_usd: -1 },
      null,
      "junk",
      { unique_id: "model.p.ok", runtime_seconds: 4 },
    ]));
    expect([...m.keys()]).toEqual(["model.p.ok"]);
  });

  it("returns an empty map for a missing, empty, malformed or wrongly-shaped file", () => {
    expect(parseRuntimeCost(null).size).toBe(0);
    expect(parseRuntimeCost("").size).toBe(0);
    expect(parseRuntimeCost("{not json").size).toBe(0);
    expect(parseRuntimeCost(JSON.stringify({ "model.p.a": { runtime_seconds: 1 } })).size).toBe(0);
    // The static CLI bridge answers every fs.readText with the sidecar text.
    expect(parseRuntimeCost("areas:\n  a: {color: '#fff'}\n").size).toBe(0);
  });

  it("reads from target/", () => {
    expect(RUNTIME_COST_PATH).toBe("target/model_runtime_cost.json");
  });
});

describe("formatRuntime", () => {
  it("always speaks seconds: one decimal under 100, whole number above", () => {
    expect(formatRuntime(0)).toBe("0.0s");
    expect(formatRuntime(3.24)).toBe("3.2s");
    expect(formatRuntime(12.35)).toBe("12.4s");
    expect(formatRuntime(99.94)).toBe("99.9s");
    expect(formatRuntime(100)).toBe("100s");
    expect(formatRuntime(125.6)).toBe("126s");
  });
});

describe("formatCost", () => {
  it("renders dollars to the cent, with a floor marker for sub-cent amounts", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.04)).toBe("$0.04");
    expect(formatCost(12.5)).toBe("$12.50");
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(1234.567)).toBe("$1,234.57");
  });
});
