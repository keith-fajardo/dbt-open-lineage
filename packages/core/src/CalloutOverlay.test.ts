import { describe, it, expect } from "vitest";
import { gistOf } from "./CalloutOverlay";

describe("gistOf", () => {
  it("returns the trimmed gist when namespaced gist + callout are both present", () => {
    expect(gistOf({ meta: { dbt_open_lineage: { gist: "  hello  ", callout: "top" } } })).toBe("hello");
  });

  it("falls back to legacy flat gist/callout when the namespaced keys are absent", () => {
    expect(gistOf({ meta: { gist: "legacy gist", callout: "top" } })).toBe("legacy gist");
  });

  it("returns null when gist is present but there is no callout placement", () => {
    expect(gistOf({ meta: { dbt_open_lineage: { gist: "hello" } } })).toBeNull();
  });

  it("returns null when callout is present but gist is empty/whitespace-only", () => {
    expect(gistOf({ meta: { dbt_open_lineage: { gist: "   ", callout: "top" } } })).toBeNull();
  });

  it("returns null when meta is absent entirely", () => {
    expect(gistOf({})).toBeNull();
  });
});
