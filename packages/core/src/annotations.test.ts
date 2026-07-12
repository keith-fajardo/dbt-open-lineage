import { describe, it, expect } from "vitest";
import { parseAnnotations, EMPTY_ANNOTATIONS } from "./annotations";

describe("parseAnnotations", () => {
  it("returns empty for null/blank/garbage", () => {
    expect(parseAnnotations(null)).toEqual(EMPTY_ANNOTATIONS);
    expect(parseAnnotations("")).toEqual(EMPTY_ANNOTATIONS);
    expect(parseAnnotations("just a string")).toEqual(EMPTY_ANNOTATIONS);
  });

  it("parses area and label styles", () => {
    const src = [
      "areas:",
      '  order_ledger: { label: "Order Ledger", color: "#8b5cf6" }',
      '  discounts:    { label: "Discounts",    color: "#6366f1" }',
      "labels:",
      '  core: { label: "Core", color: "#ef4444" }',
    ].join("\n");
    const a = parseAnnotations(src);
    expect(a.areas.order_ledger).toEqual({ label: "Order Ledger", color: "#8b5cf6" });
    expect(a.areas.discounts.color).toBe("#6366f1");
    expect(a.labels.core).toEqual({ label: "Core", color: "#ef4444" });
  });

  it("defaults a missing label to the key and a missing color to the fallback palette", () => {
    const a = parseAnnotations("areas:\n  web_session: {}\n");
    expect(a.areas.web_session.label).toBe("web_session");
    expect(a.areas.web_session.color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});
