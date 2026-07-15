import { describe, it, expect } from "vitest";
import { layoutGraph } from "./layout";
import type { Graph } from "./graphTypes";

const node = (id: string, layer: string) => ({
  id, name: id, resource_type: "model", layer, path: "", description: "",
});

const g: Graph = {
  nodes: [node("a", "staging"), node("b", "mart")],
  edges: [{ from: "a", to: "b" }],
};

describe("layoutGraph", () => {
  it("assigns a position to every node", () => {
    const pos = layoutGraph(g);
    expect(pos.size).toBe(2);
    expect(pos.get("a")).toHaveProperty("x");
    expect(pos.get("a")).toHaveProperty("y");
  });

  it("lays out left→right (downstream node has greater x)", () => {
    const pos = layoutGraph(g);
    expect(pos.get("b")!.x).toBeGreaterThan(pos.get("a")!.x);
  });

  it("puts sources and seeds in ONE shared column; staging is NOT locked (flows by topology)", () => {
    const chain: Graph = {
      nodes: [
        node("src1", "source"), node("src2", "source"),
        node("seed1", "seed"),
        node("stg1", "staging"), node("stg2", "staging"), node("stg3", "staging"),
      ],
      edges: [
        { from: "src1", to: "stg1" },
        { from: "src2", to: "stg2" },
        // stg2 → stg3: staging is free now, so this same-layer edge SHOULD
        // step stg3 a rank right of stg2 (topology-driven, no column lock).
        { from: "stg2", to: "stg3" },
        { from: "seed1", to: "stg3" },
      ],
    };
    const pos = layoutGraph(chain);
    const xs = (ids: string[]) => new Set(ids.map((id) => pos.get(id)!.x));
    // Sources AND seeds still share one x (seed_netsuite lines up with netsuite).
    expect(xs(["src1", "src2", "seed1"]).size).toBe(1);
    // Staging no longer forced into one column: stg1/stg2 sit at the same rank,
    // but stg3 (downstream of stg2) steps to the right.
    expect(pos.get("stg1")!.x).toBe(pos.get("stg2")!.x);
    expect(pos.get("stg3")!.x).toBeGreaterThan(pos.get("stg2")!.x);
    // Raw inputs still sit left of staging.
    expect(pos.get("src1")!.x).toBeLessThan(pos.get("stg1")!.x);
    // Stacked raw inputs never overlap (44px tall + 24px gap).
    const raws = ["src1", "src2", "seed1"].map((id) => pos.get(id)!.y).sort((a, b) => a - b);
    expect(raws[1] - raws[0]).toBeGreaterThanOrEqual(44 + 24);
    expect(raws[2] - raws[1]).toBeGreaterThanOrEqual(44 + 24);
  });

  it("does NOT column-lock downstream layers: an int chain still steps right", () => {
    const chain: Graph = {
      nodes: [
        node("stg", "staging"),
        node("int_a", "intermediate"), node("int_b", "intermediate"),
        node("mrt", "mart"),
      ],
      edges: [
        { from: "stg", to: "int_a" },
        { from: "int_a", to: "int_b" }, // same layer, but keeps dagre ranking
        { from: "int_b", to: "mrt" },
      ],
    };
    const pos = layoutGraph(chain);
    expect(pos.get("int_b")!.x).toBeGreaterThan(pos.get("int_a")!.x);
    expect(pos.get("mrt")!.x).toBeGreaterThan(pos.get("int_b")!.x);
    // Staging is free now too, but still upstream, so int_a sits right of it.
    expect(pos.get("int_a")!.x).toBeGreaterThan(pos.get("stg")!.x);
  });

  it("no calloutHeights arg → layout unchanged from passing an empty map", () => {
    const a = layoutGraph(g);
    const b = layoutGraph(g, new Map());
    for (const id of ["a", "b"]) {
      expect(b.get(id)).toEqual(a.get(id));
    }
  });

  it("reserves extra vertical space above a node that has a callout", () => {
    // Two free nodes that dagre stacks in the SAME rank (both feed one mart),
    // so they share an x and sit one above the other.
    const stacked: Graph = {
      nodes: [
        node("int_a", "intermediate"),
        node("int_b", "intermediate"),
        node("mrt", "mart"),
      ],
      edges: [
        { from: "int_a", to: "mrt" },
        { from: "int_b", to: "mrt" },
      ],
    };
    const gapOf = (pos: Map<string, { x: number; y: number }>) =>
      Math.abs(pos.get("int_a")!.y - pos.get("int_b")!.y);

    const base = layoutGraph(stacked);
    const baseGap = gapOf(base);
    // The callout reserves space ABOVE its node, pushing whatever is above it
    // away — so put the callout on the LOWER of the two stacked nodes.
    const lower = base.get("int_a")!.y > base.get("int_b")!.y ? "int_a" : "int_b";

    const reserved = layoutGraph(stacked, new Map([[lower, 120]]));
    const reservedGap = gapOf(reserved);

    expect(reservedGap).toBeGreaterThan(baseGap);
  });

  it("collapses locked columns that are empty", () => {
    // No sources or seeds at all → no locked columns. The free subgraph
    // (staging a → mart b) starts at x = 0 and steps right by one column.
    const pos = layoutGraph(g);
    expect(pos.get("a")!.x).toBe(0);
    expect(pos.get("b")!.x).toBe(180 + 80);
  });

  it("no sizes arg → layout byte-identical to passing an empty sizes map", () => {
    const a = layoutGraph(g);
    const b = layoutGraph(g, undefined, new Map());
    for (const id of ["a", "b"]) {
      expect(b.get(id)).toEqual(a.get(id));
    }
  });

  it("a per-node size map grows the node and keeps stacked nodes non-overlapping", () => {
    const stacked: Graph = {
      nodes: [
        node("int_a", "intermediate"),
        node("int_b", "intermediate"),
        node("mrt", "mart"),
      ],
      edges: [
        { from: "int_a", to: "mrt" },
        { from: "int_b", to: "mrt" },
      ],
    };
    const gapOf = (pos: Map<string, { x: number; y: number }>) =>
      Math.abs(pos.get("int_a")!.y - pos.get("int_b")!.y);
    const base = layoutGraph(stacked);
    // dagre anchors each same-rank box's TOP edge relative to its neighbor and
    // extends purely DOWNWARD as its own height grows (verified directly: a
    // grown trailing/lower node's top edge is invariant since nothing sits
    // below it to push into). So growing the UPPER of the two stacked nodes
    // is what forces the one below it further away.
    const upper = base.get("int_a")!.y < base.get("int_b")!.y ? "int_a" : "int_b";
    const grown = layoutGraph(stacked, undefined, new Map([[upper, { w: 240, h: 200 }]]));
    expect(gapOf(grown)).toBeGreaterThan(gapOf(base));
  });
});
