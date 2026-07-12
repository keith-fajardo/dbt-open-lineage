// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { exportScope, toCsv, toMermaid, b64encode } from "./export";
import type { Graph } from "./graphTypes";

const g: Graph = {
  nodes: [
    { id: "model.p.a", name: "a", resource_type: "model", layer: "staging", path: "models/a.sql", description: "", materialized: "view", tags: ["t1", "t2"], tests: ["not_null_a"] },
    { id: "model.p.b", name: "b, with comma", resource_type: "model", layer: "mart", path: "models/b.sql", description: "", materialized: "table", tags: [], tests: [] },
    { id: "model.p.c", name: "c", resource_type: "model", layer: "report", path: "models/c.sql", description: "" },
  ],
  edges: [
    { from: "model.p.a", to: "model.p.b" },
    { from: "model.p.b", to: "model.p.c" },
  ],
};

describe("exportScope", () => {
  it("keeps only matched nodes and the edges fully inside the set", () => {
    const s = exportScope(g, new Set(["model.p.a", "model.p.b"]));
    expect(s.nodes.map((n) => n.name)).toEqual(["a", "b, with comma"]);
    expect(s.edges).toEqual([{ from: "model.p.a", to: "model.p.b" }]); // b→c dropped
  });
});

describe("toCsv", () => {
  it("emits one row per node with quoted commas and joined tags/tests", () => {
    const csv = toCsv(g.nodes);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("name,resource_type,layer,materialized,tags,tests,path");
    expect(lines[1]).toBe("a,model,staging,view,t1;t2,not_null_a,models/a.sql");
    expect(lines[2]).toContain('"b, with comma"'); // comma-safe
    expect(lines[3]).toBe("c,model,report,,,,models/c.sql"); // optional fields default empty
  });
});

describe("toMermaid", () => {
  it("writes a graph LR with sanitized ids and name labels", () => {
    const mmd = toMermaid(exportScope(g, new Set(["model.p.a", "model.p.b"])));
    expect(mmd).toContain("graph LR");
    expect(mmd).toContain('n0["a"]');
    expect(mmd).toContain('n1["b, with comma"]');
    expect(mmd).toContain("n0 --> n1");
    expect(mmd).not.toContain("model.p."); // raw dotted ids never leak
  });
});

describe("b64encode", () => {
  it("round-trips UTF-8 text", () => {
    const b64 = b64encode("héllo → wörld");
    expect(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))))
      .toBe("héllo → wörld");
  });
});
