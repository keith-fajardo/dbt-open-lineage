import { describe, it, expect } from "vitest";
import { hasFullRefreshFlag, stripFullRefreshFlag } from "./runFlags";

describe("hasFullRefreshFlag", () => {
  it("detects the token on its own", () => {
    expect(hasFullRefreshFlag("--full-refresh")).toBe(true);
  });

  it("detects the token alongside other selector text, in any position", () => {
    expect(hasFullRefreshFlag("stg_orders --full-refresh")).toBe(true);
    expect(hasFullRefreshFlag("--full-refresh stg_orders")).toBe(true);
    expect(hasFullRefreshFlag("tag:mart --full-refresh --exclude x")).toBe(true);
  });

  it("returns false when the token is absent", () => {
    expect(hasFullRefreshFlag("stg_orders")).toBe(false);
    expect(hasFullRefreshFlag("")).toBe(false);
  });

  it("does not match a substring/prefix that isn't the exact token", () => {
    expect(hasFullRefreshFlag("--full-refreshx")).toBe(false);
    expect(hasFullRefreshFlag("full-refresh")).toBe(false);
  });
});

describe("stripFullRefreshFlag", () => {
  it("removes a lone token, leaving an empty string", () => {
    expect(stripFullRefreshFlag("--full-refresh")).toBe("");
  });

  it("removes the token from among other selector text without disturbing the rest", () => {
    expect(stripFullRefreshFlag("stg_orders --full-refresh")).toBe("stg_orders");
    expect(stripFullRefreshFlag("--full-refresh stg_orders")).toBe("stg_orders");
    expect(stripFullRefreshFlag("tag:mart --full-refresh --exclude x")).toBe("tag:mart --exclude x");
  });

  it("is a no-op (aside from whitespace normalization) when the token is absent", () => {
    expect(stripFullRefreshFlag("stg_orders")).toBe("stg_orders");
  });
});
