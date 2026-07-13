import { describe, it, expect } from "vitest";
import { estimateCalloutHeight, gistOf } from "./CalloutOverlay";

describe("estimateCalloutHeight", () => {
  it("returns at least a single line's height for short text", () => {
    const oneChar = estimateCalloutHeight("x");
    // single line: 11*1.35 + 12 + 14 + 8 rounded
    expect(oneChar).toBe(Math.round(1 * 11 * 1.35 + 12 + 14 + 8));
    // empty/whitespace still reserves one line (min 1)
    expect(estimateCalloutHeight("   ")).toBe(oneChar);
  });

  it("is monotonic: longer text is never shorter, and eventually taller", () => {
    const short = estimateCalloutHeight("short note");
    const long = estimateCalloutHeight("x".repeat(400));
    expect(long).toBeGreaterThan(short);
    // wrapping onto more lines strictly increases height
    const oneLine = estimateCalloutHeight("x".repeat(10));
    const manyLines = estimateCalloutHeight("x".repeat(300));
    expect(manyLines).toBeGreaterThan(oneLine);
  });
});

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
