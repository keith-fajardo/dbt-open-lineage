import { describe, it, expect } from "vitest";
import { estimateCalloutHeight } from "./CalloutOverlay";

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
