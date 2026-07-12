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

  it("puts sources and seeds in ONE shared column, staging in its own", () => {
    const chain: Graph = {
      nodes: [
        node("src1", "source"), node("src2", "source"),
        node("seed1", "seed"),
        node("stg1", "staging"), node("stg2", "staging"), node("stg3", "staging"),
      ],
      edges: [
        { from: "src1", to: "stg1" },
        { from: "src2", to: "stg2" },
        // stg2 → stg3: same-layer edge must NOT split the staging column
        // (plain dagre would push stg3 a rank right).
        { from: "stg2", to: "stg3" },
        { from: "seed1", to: "stg3" },
      ],
    };
    const pos = layoutGraph(chain);
    const xs = (ids: string[]) => new Set(ids.map((id) => pos.get(id)!.x));
    // Sources AND seeds share one x (seed_netsuite lines up with netsuite).
    expect(xs(["src1", "src2", "seed1"]).size).toBe(1);
    expect(xs(["stg1", "stg2", "stg3"]).size).toBe(1);
    // Column order: raw inputs < staging.
    expect(pos.get("src1")!.x).toBeLessThan(pos.get("stg1")!.x);
    // Stacked nodes never overlap (44px tall + 24px gap) — including the
    // seed stacked among the sources.
    const raws = ["src1", "src2", "seed1"].map((id) => pos.get(id)!.y).sort((a, b) => a - b);
    expect(raws[1] - raws[0]).toBeGreaterThanOrEqual(44 + 24);
    expect(raws[2] - raws[1]).toBeGreaterThanOrEqual(44 + 24);
    const ys = ["stg1", "stg2", "stg3"].map((id) => pos.get(id)!.y).sort((a, b) => a - b);
    expect(ys[1] - ys[0]).toBeGreaterThanOrEqual(44 + 24);
    expect(ys[2] - ys[1]).toBeGreaterThanOrEqual(44 + 24);
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
    // And every free node sits right of the locked staging column.
    expect(pos.get("int_a")!.x).toBeGreaterThan(pos.get("stg")!.x);
  });

  it("collapses locked columns that are empty", () => {
    // No sources or seeds: staging is the ONLY locked column, at x = 0,
    // and free nodes start one column later.
    const pos = layoutGraph(g);
    expect(pos.get("a")!.x).toBe(0);
    expect(pos.get("b")!.x).toBe(180 + 80);
  });
});
