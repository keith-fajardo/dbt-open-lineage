import { describe, it, expect } from "vitest";
import { estimateCalloutHeight, gistOf, estimateStackedCalloutHeight, grainOf } from "./CalloutOverlay";

describe("estimateCalloutHeight", () => {
  it("returns at least a single line's height for short text", () => {
    const oneChar = estimateCalloutHeight("x");
    // single line: 11*1.35 + 12 + 14 + 20 rounded
    expect(oneChar).toBe(Math.round(1 * 11 * 1.35 + 12 + 14 + 20));
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

describe("grainOf", () => {
  it("returns the trimmed grain when grain_callout is set (namespaced)", () => {
    const node = { meta: { dbt_open_lineage: { grain: "  one row per order  ", grain_callout: "top" } } };
    expect(grainOf(node)).toBe("one row per order");
  });

  it("returns null when grain_callout is not set", () => {
    const node = { meta: { dbt_open_lineage: { grain: "one row per order" } } };
    expect(grainOf(node)).toBeNull();
  });

  it("returns null when grain is empty/whitespace", () => {
    const node = { meta: { dbt_open_lineage: { grain: "   ", grain_callout: "top" } } };
    expect(grainOf(node)).toBeNull();
  });

  it("falls back to the legacy flat meta.grain / meta.grain_callout", () => {
    const node = { meta: { grain: "one row per order", grain_callout: "top" } };
    expect(grainOf(node)).toBe("one row per order");
  });
});

describe("estimateStackedCalloutHeight", () => {
  it("returns 0 when neither text is present", () => {
    expect(estimateStackedCalloutHeight(null, null)).toBe(0);
  });

  it("matches estimateCalloutHeight exactly when only gist is present", () => {
    const text = "One row per invoice line.";
    expect(estimateStackedCalloutHeight(text, null)).toBe(estimateCalloutHeight(text));
  });

  it("matches estimateCalloutHeight exactly when only grain is present", () => {
    const text = "transaction_line_id";
    expect(estimateStackedCalloutHeight(null, text)).toBe(estimateCalloutHeight(text));
  });

  it("stacking both reserves MORE height than either alone", () => {
    const gist = "One row per invoice line. Late-arriving credit memos re-open closed periods.";
    const grain = "transaction_line_id";
    const stacked = estimateStackedCalloutHeight(gist, grain);
    expect(stacked).toBeGreaterThan(estimateCalloutHeight(gist));
    expect(stacked).toBeGreaterThan(estimateCalloutHeight(grain));
  });

  it("stacked height equals both bubble heights plus two 14px gaps plus the 20px margin", () => {
    const gist = "short";
    const grain = "also short";
    const stacked = estimateStackedCalloutHeight(gist, grain);
    // Recompute independently (not via the function under test) to catch a
    // regression in the formula itself, not just a refactor that keeps the
    // same (possibly wrong) numbers.
    const bubbleH = (t: string) => {
      const innerW = 184 - 18;
      const charsPerLine = Math.max(1, Math.floor(innerW / 5.4));
      const lines = Math.max(1, Math.ceil(t.trim().length / charsPerLine));
      return lines * 11 * 1.35 + 12;
    };
    expect(stacked).toBe(Math.round(bubbleH(gist) + bubbleH(grain) + 2 * 14 + 20));
  });
});
