import { describe, it, expect } from "vitest";
import { layoutGraph, computeExportBounds, NODE_W, NODE_H, LARGE_LAYOUT_LIMIT } from "./layout";
import type { Graph } from "./graphTypes";

const node = (id: string, layer: string) => ({
  id, name: id, resource_type: "model", layer, path: "", description: "",
});

const g: Graph = {
  nodes: [node("a", "staging"), node("b", "mart")],
  edges: [{ from: "a", to: "b" }],
};

describe("layoutGraph", () => {
  it("uses the linear layout for large graphs and keeps coordinates deterministic", () => {
    const large: Graph = {
      nodes: Array.from({ length: LARGE_LAYOUT_LIMIT }, (_, i) => node(`m${String(i).padStart(4, "0")}`, "staging")),
      edges: [],
    };
    const a = layoutGraph(large);
    const b = layoutGraph(large);
    expect(a.size).toBe(LARGE_LAYOUT_LIMIT);
    expect([...a.entries()]).toEqual([...b.entries()]);
    // Disconnected nodes are packed into short columns instead of one
    // 1,000-row strip, so fitting the graph does not collapse it to a sliver.
    expect(a.get("m0000")!.x).toBe(0);
    expect(a.get("m0080")!.x).toBe(NODE_W + 80);
    expect(a.get("m0079")!.y).toBe((NODE_H + 24) * 79);
  });

  it("ranks a large acyclic chain left-to-right without invoking Dagre", () => {
    const large: Graph = {
      nodes: Array.from({ length: LARGE_LAYOUT_LIMIT }, (_, i) => node(`m${String(i).padStart(4, "0")}`, "staging")),
      edges: Array.from({ length: LARGE_LAYOUT_LIMIT - 1 }, (_, i) => ({ from: `m${String(i).padStart(4, "0")}`, to: `m${String(i + 1).padStart(4, "0")}` })),
    };
    const pos = layoutGraph(large);
    expect(pos.get("m0999")!.x).toBeGreaterThan(pos.get("m0998")!.x);
    expect(pos.get("m0000")!.y).toBe(0);
  });

  it("keeps large-graph sources and seeds in one vertical raw-input column", () => {
    const large: Graph = {
      nodes: [
        ...Array.from({ length: 81 }, (_, i) => node(`src${String(i).padStart(3, "0")}`, "source")),
        ...Array.from({ length: LARGE_LAYOUT_LIMIT - 81 }, (_, i) => node(`m${String(i).padStart(4, "0")}`, "staging")),
      ],
      edges: [],
    };
    const pos = layoutGraph(large);
    const rawX = new Set(Array.from({ length: 81 }, (_, i) => pos.get(`src${String(i).padStart(3, "0")}`)!.x));

    expect(rawX).toEqual(new Set([0]));
    expect(pos.get("src080")!.y).toBe((NODE_H + 24) * 80);
    expect(pos.get("m0000")!.x).toBe(NODE_W + 80);
  });

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

  it("a taller (stacked, two-bubble) callout height reserves MORE space than a shorter (single-bubble) one", () => {
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
    const lower = base.get("int_a")!.y > base.get("int_b")!.y ? "int_a" : "int_b";

    // 60 ≈ a single short bubble's reserved height; 110 ≈ two bubbles
    // stacked (roughly estimateStackedCalloutHeight's ballpark for two
    // short notes) — the exact numbers don't matter, only that taller
    // reserves more room than shorter.
    const single = layoutGraph(stacked, new Map([[lower, 60]]));
    const doubled = layoutGraph(stacked, new Map([[lower, 110]]));
    expect(gapOf(doubled)).toBeGreaterThan(gapOf(single));
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

// App.tsx's PNG/SVG export handler frames the viewport on computeExportBounds
// (extracted from the export handler itself — see layout.ts — since exercising
// that path end-to-end needs html-to-image + a rendered react-flow viewport,
// neither of which this pure geometry touches). Task 8 replaced the export
// handler's hardcoded 180x44 per-node box with real sizes read from nodeSizes;
// these tests prove BOTH halves of that change: (1) the no-sizes-map fallback
// is byte-identical to the old hardcoded math, and (2) a grown node's size
// actually widens the computed bounds beyond what 180x44 would have produced.
describe("computeExportBounds", () => {
  const shown = [
    { id: "a", position: { x: 0, y: 0 } },
    { id: "b", position: { x: 300, y: 100 } },
  ];

  it("without a sizes map, falls back to NODE_W x NODE_H per node — byte-identical to the pre-Task-8 hardcoded 180x44 math", () => {
    expect(computeExportBounds(shown)).toEqual({
      x: 0,
      y: 0,
      w: 300 + NODE_W, // rightmost node's x + its (fallback) width, minus min x (0)
      h: 100 + NODE_H, // rightmost-in-y node's y + its (fallback) height, minus min y (0)
    });
    // Pin the actual numbers so a future NODE_W/NODE_H edit can't silently
    // change what "byte-identical to 180x44" means without failing here.
    expect(NODE_W).toBe(180);
    expect(NODE_H).toBe(44);
    expect(computeExportBounds(shown)).toEqual({ x: 0, y: 0, w: 480, h: 144 });
  });

  it("a grown node's real size (nodeSizes, Task 4) widens the bounds beyond the 180x44 fallback", () => {
    const fallback = computeExportBounds(shown);
    const nodeSizes = new Map([["b", { w: 500, h: 300 }]]);
    const grown = computeExportBounds(shown, nodeSizes);
    expect(grown.w).toBeGreaterThan(fallback.w);
    expect(grown.h).toBeGreaterThan(fallback.h);
    expect(grown).toEqual({ x: 0, y: 0, w: 800, h: 400 });
  });

  it("a sizes map that only covers SOME nodes falls back to NODE_W x NODE_H for the rest", () => {
    const nodeSizes = new Map([["a", { w: 240, h: 200 }]]); // b is absent → fallback
    const bounds = computeExportBounds(shown, nodeSizes);
    // b (no entry) still uses the 180x44 fallback for width, so the
    // width-defining corner (b's right edge) is unchanged from the
    // no-sizes-map case; a's grown height now dominates the height bound.
    expect(bounds.w).toBe(300 + NODE_W);
    expect(bounds.h).toBe(0 + 200); // a's own (grown) bottom edge, not b's fallback 144
  });

  it("x/y are the min position across all shown nodes, not just the first", () => {
    const scattered = [
      { id: "a", position: { x: 50, y: 200 } },
      { id: "b", position: { x: -20, y: 10 } },
      { id: "c", position: { x: 400, y: 90 } },
    ];
    const bounds = computeExportBounds(scattered);
    expect(bounds.x).toBe(-20);
    expect(bounds.y).toBe(10);
  });
});
