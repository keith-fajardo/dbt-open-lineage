import { describe, it, expect } from "vitest";
import {
  nodeAreas, areaMembers, memberCorners, boundingBox, convexHull, padHull, type Pt,
} from "./zones";
import { nodeLabels } from "./zones";

describe("nodeAreas", () => {
  it("returns the string list from the namespaced meta.dbt_open_lineage.subject_areas", () => {
    expect(nodeAreas({ meta: { dbt_open_lineage: { subject_areas: ["a", "b"] } } })).toEqual(["a", "b"]);
  });
  it("falls back to legacy flat meta.subject_areas when the namespaced key is absent", () => {
    expect(nodeAreas({ meta: { subject_areas: ["a", "b"] } })).toEqual(["a", "b"]);
  });
  it("returns [] when absent, non-array, or non-string entries", () => {
    expect(nodeAreas({})).toEqual([]);
    expect(nodeAreas({ meta: {} })).toEqual([]);
    expect(nodeAreas({ meta: { subject_areas: "a" } })).toEqual([]);
    expect(nodeAreas({ meta: { subject_areas: ["a", 3] } })).toEqual(["a"]);
  });
});

describe("nodeLabels", () => {
  it("returns the string list from the namespaced meta.dbt_open_lineage.labels", () => {
    expect(nodeLabels({ meta: { dbt_open_lineage: { labels: ["core", "revenue"] } } }))
      .toEqual(["core", "revenue"]);
  });
  it("falls back to legacy flat meta.labels when the namespaced key is absent", () => {
    expect(nodeLabels({ meta: { labels: ["core", "revenue"] } })).toEqual(["core", "revenue"]);
  });
  it("returns [] when absent / non-array / non-string entries", () => {
    expect(nodeLabels({})).toEqual([]);
    expect(nodeLabels({ meta: { labels: "core" } })).toEqual([]);
    expect(nodeLabels({ meta: { labels: ["core", 7] } })).toEqual(["core"]);
  });
});

describe("areaMembers", () => {
  const nodes = [
    { id: "1", meta: { subject_areas: ["orders"] } },
    { id: "2", meta: { subject_areas: ["orders", "discounts"] } },
    { id: "3", meta: {} },
  ];
  it("returns ids of nodes whose subject_areas contains the area", () => {
    expect(areaMembers(nodes, "orders")).toEqual(["1", "2"]);
    expect(areaMembers(nodes, "discounts")).toEqual(["2"]);
    expect(areaMembers(nodes, "none")).toEqual([]);
  });
});

describe("boundingBox", () => {
  it("wraps member corners with padding", () => {
    const pos = new Map<string, Pt>([["1", { x: 0, y: 0 }], ["2", { x: 200, y: 100 }]]);
    const box = boundingBox(memberCorners(pos, ["1", "2"]), 10);
    // corners span x:0..380 (200+180), y:0..144 (100+44); pad 10 each side
    expect(box).toEqual({ x: -10, y: -10, w: 400, h: 164 });
  });
  it("returns null for no corners", () => {
    expect(boundingBox([], 10)).toBeNull();
  });
});

describe("convexHull + padHull", () => {
  it("hull contains all input points, padded hull excludes an interior stranger", () => {
    const square: Pt[] = [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
      { x: 50, y: 50 }, // interior point — must not be a hull vertex
    ];
    const hull = convexHull(square);
    expect(hull).toHaveLength(4);
    expect(hull).not.toContainEqual({ x: 50, y: 50 });
    const padded = padHull(hull, 5);
    // padding pushes vertices outward from centroid, so bbox grows
    const xs = padded.map((p) => p.x);
    expect(Math.min(...xs)).toBeLessThan(0);
    expect(Math.max(...xs)).toBeGreaterThan(100);
  });
});
