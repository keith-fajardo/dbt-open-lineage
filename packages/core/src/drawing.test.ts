import { describe, it, expect } from "vitest";
import { strokePath, hitStroke, eraseAt, type Stroke } from "./drawing";

const S = (color: string, points: [number, number][]): Stroke => ({ color, width: 3, points });

describe("strokePath", () => {
  it("builds an SVG path from points", () => {
    expect(strokePath([[0, 0], [10, 20]])).toBe("M0.0,0.0 L10.0,20.0");
  });
  it("renders a single point as a dot (degenerate segment)", () => {
    expect(strokePath([[5, 5]])).toBe("M5.0,5.0 L5.0,5.0");
  });
  it("is empty for no points", () => {
    expect(strokePath([])).toBe("");
  });
});

describe("hitStroke", () => {
  const stroke = S("#fff", [[0, 0], [100, 0]]); // horizontal segment
  it("hits near the segment", () => {
    expect(hitStroke(stroke, [50, 3], 8)).toBe(true);
  });
  it("misses far from the segment", () => {
    expect(hitStroke(stroke, [50, 40], 8)).toBe(false);
  });
  it("hits a single-point stroke within tolerance", () => {
    expect(hitStroke(S("#fff", [[10, 10]]), [12, 12], 8)).toBe(true);
  });
});

describe("eraseAt", () => {
  const a = S("#a", [[0, 0], [100, 0]]);
  const b = S("#b", [[0, 0], [0, 100]]);
  it("removes the topmost stroke under the point, keeps the rest", () => {
    const out = eraseAt([a, b], [50, 2], 8); // only a is near (50,2)
    expect(out).toEqual([b]);
  });
  it("removes the last-drawn when strokes overlap at the point", () => {
    const out = eraseAt([a, b], [1, 1], 8); // both pass through origin area; b is last
    expect(out).toEqual([a]);
  });
  it("returns the same array reference when nothing is hit", () => {
    const input = [a, b];
    expect(eraseAt(input, [500, 500], 8)).toBe(input);
  });
});
