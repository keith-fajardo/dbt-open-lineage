import { describe, it, expect } from "vitest";
import { parse } from "yaml"; // already imported in this file — reuse
import { parseAnnotations, EMPTY_ANNOTATIONS, setSidecarColor } from "./annotations";

describe("parseAnnotations", () => {
  it("returns empty for null/blank/garbage", () => {
    expect(parseAnnotations(null)).toEqual(EMPTY_ANNOTATIONS);
    expect(parseAnnotations("")).toEqual(EMPTY_ANNOTATIONS);
    expect(parseAnnotations("just a string")).toEqual(EMPTY_ANNOTATIONS);
  });

  it("parses area and label styles (block form)", () => {
    const src = [
      "areas:",
      "  order_ledger:",
      '    name: "Order Ledger"',
      '    color: "#8b5cf6"',
      "labels:",
      "  core:",
      '    name: "Core"',
      '    color: "#ef4444"',
    ].join("\n");
    const a = parseAnnotations(src);
    expect(a.areas.order_ledger).toEqual({ name: "Order Ledger", color: "#8b5cf6" });
    expect(a.labels.core).toEqual({ name: "Core", color: "#ef4444" });
  });

  it("defaults a missing name to the key and a missing color to the fallback palette", () => {
    const a = parseAnnotations("areas:\n  web_session: {}\n");
    expect(a.areas.web_session.name).toBe("web_session");
    expect(a.areas.web_session.color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("returns empty when yaml.parse() throws on malformed input", () => {
    const malformed = "foo:\n  - bar\n bar: 1";
    const a = parseAnnotations(malformed);
    expect(a).toEqual(EMPTY_ANNOTATIONS);
  });

  it("rejects arrays in style maps", () => {
    const a = parseAnnotations("areas:\n  - foo\n  - bar\n");
    expect(a.areas).toEqual({});
  });
});

describe("setSidecarColor", () => {
  it("sets a color on an existing entry, preserving siblings + comments", () => {
    const src = [
      "labels:",
      "  core: { name: \"Core\", color: \"#ef4444\" }  # important ones",
      "  pii:  { name: \"PII\", color: \"#f59e0b\" }",
    ].join("\n");
    const out = setSidecarColor(src, "labels", "core", "#123456");
    expect(out).toContain("# important ones");
    const doc = parse(out);
    expect(doc.labels.core.color).toBe("#123456");
    expect(doc.labels.core.name).toBe("Core");    // name untouched
    expect(doc.labels.pii.color).toBe("#f59e0b");  // sibling untouched
  });

  it("creates the entry (and section) when absent, seeding an empty doc", () => {
    const out = setSidecarColor(null, "areas", "order_ledger", "#8b5cf6");
    const doc = parse(out);
    expect(doc.areas.order_ledger.color).toBe("#8b5cf6");
  });
});
