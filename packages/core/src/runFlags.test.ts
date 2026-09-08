import { describe, it, expect } from "vitest";
import { parseRunFlags } from "./runFlags";

describe("parseRunFlags — --full-refresh", () => {
  it("detects the token on its own and leaves an empty selector", () => {
    const f = parseRunFlags("--full-refresh");
    expect(f.fullRefresh).toBe(true);
    expect(f.selector).toBe("");
  });

  it("detects the token in any position and strips it from the selector", () => {
    expect(parseRunFlags("stg_orders --full-refresh").selector).toBe("stg_orders");
    expect(parseRunFlags("--full-refresh stg_orders").selector).toBe("stg_orders");
    const f = parseRunFlags("tag:mart --full-refresh --exclude x");
    expect(f.fullRefresh).toBe(true);
    expect(f.selector).toBe("tag:mart --exclude x");
  });

  it("is false when absent, and does not match a prefix/substring", () => {
    expect(parseRunFlags("stg_orders").fullRefresh).toBe(false);
    expect(parseRunFlags("").fullRefresh).toBe(false);
    // Not the exact token → treated as an ordinary selector term, kept as-is.
    expect(parseRunFlags("--full-refreshx").fullRefresh).toBe(false);
    expect(parseRunFlags("--full-refreshx").selector).toBe("--full-refreshx");
    expect(parseRunFlags("full-refresh").fullRefresh).toBe(false);
  });
});

describe("parseRunFlags — --defer", () => {
  it("detects the bare flag in any position and strips it", () => {
    expect(parseRunFlags("--defer").defer).toBe(true);
    expect(parseRunFlags("--defer").selector).toBe("");
    const f = parseRunFlags("state:modified+ --defer");
    expect(f.defer).toBe(true);
    expect(f.selector).toBe("state:modified+");
  });

  it("is false when absent", () => {
    expect(parseRunFlags("stg_orders").defer).toBe(false);
  });
});

describe("parseRunFlags — --state <dir>", () => {
  it("consumes the following token as the path and strips both", () => {
    const f = parseRunFlags("stg_orders --state target/prod/");
    expect(f.state).toBe("target/prod/");
    expect(f.selector).toBe("stg_orders");
  });

  it("accepts the equals form", () => {
    const f = parseRunFlags("stg_orders --state=target/prod/");
    expect(f.state).toBe("target/prod/");
    expect(f.selector).toBe("stg_orders");
  });

  it("does not swallow a legitimate selector token when --state has a value", () => {
    const f = parseRunFlags("--state target/prod/ int_orders --exclude x");
    expect(f.state).toBe("target/prod/");
    expect(f.selector).toBe("int_orders --exclude x");
  });

  it("drops a trailing bare --state with no path", () => {
    const f = parseRunFlags("stg_orders --state");
    expect(f.state).toBeUndefined();
    expect(f.selector).toBe("stg_orders");
  });

  it("keeps the last path when --state repeats", () => {
    expect(parseRunFlags("--state a --state b x").state).toBe("b");
  });

  it("is undefined when absent", () => {
    expect(parseRunFlags("stg_orders").state).toBeUndefined();
  });
});

describe("parseRunFlags — the full requested combination", () => {
  it("extracts all three and preserves the remaining selector", () => {
    const f = parseRunFlags("state:modified+ --defer --state target/prod/ --full-refresh");
    expect(f).toEqual({
      selector: "state:modified+",
      fullRefresh: true,
      defer: true,
      state: "target/prod/",
    });
  });
});
