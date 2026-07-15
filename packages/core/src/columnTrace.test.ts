import { describe, it, expect } from "vitest";
import {
  endpointKey, traceColumn, columnTraceEdges, estimateColumnNodeSize, toRfTraceEdge,
  HEADER_H, PICKBAR_H, ROW_H,
} from "./columnTrace";
import type { ColumnLineagePayload, ColumnLineageEdge } from "./columnLineage";

// a.id → b.id → c.id  (a straight two-hop chain, same column name each hop)
const chain: ColumnLineagePayload = {
  nodes: {},
  edges: [
    { source: "a", target: "b", sourceColumn: "id", targetColumn: "id" },
    { source: "b", target: "c", sourceColumn: "id", targetColumn: "id" },
  ],
};

// a.amount → b.total → c.total  (a mid-chain RENAME: amount becomes total)
const renamed: ColumnLineagePayload = {
  nodes: {},
  edges: [
    { source: "a", target: "b", sourceColumn: "amount", targetColumn: "total" },
    { source: "b", target: "c", sourceColumn: "total", targetColumn: "total" },
  ],
};

describe("endpointKey", () => {
  it("joins node and column with a :: separator", () => {
    expect(endpointKey("model.proj.a", "id")).toBe("model.proj.a::id");
  });
});

describe("traceColumn", () => {
  it("follows an endpoint across every hop (both directions), including the start", () => {
    const trace = traceColumn(chain, { node: "b", column: "id" });
    expect(trace).toEqual(new Set(["a::id", "b::id", "c::id"]));
  });

  it("follows a mid-chain rename by matching the shared endpoint, not the column name", () => {
    const trace = traceColumn(renamed, { node: "a", column: "amount" });
    expect(trace).toEqual(new Set(["a::amount", "b::total", "c::total"]));
  });

  it("returns just the start for a column with no edges", () => {
    const trace = traceColumn(chain, { node: "z", column: "orphan" });
    expect(trace).toEqual(new Set(["z::orphan"]));
  });

  it("fans out to every reachable endpoint on a branch", () => {
    const fan: ColumnLineagePayload = {
      nodes: {},
      edges: [
        { source: "a", target: "b", sourceColumn: "id", targetColumn: "id" },
        { source: "a", target: "c", sourceColumn: "id", targetColumn: "id" },
      ],
    };
    expect(traceColumn(fan, { node: "a", column: "id" })).toEqual(
      new Set(["a::id", "b::id", "c::id"]),
    );
  });

  it("terminates on a rename cycle (a→b→a) without looping forever", () => {
    const cycle: ColumnLineagePayload = {
      nodes: {},
      edges: [
        { source: "a", target: "b", sourceColumn: "x", targetColumn: "y" },
        { source: "b", target: "a", sourceColumn: "y", targetColumn: "x" },
      ],
    };
    expect(traceColumn(cycle, { node: "a", column: "x" })).toEqual(
      new Set(["a::x", "b::y"]),
    );
  });
});

describe("columnTraceEdges", () => {
  it("returns only edges whose BOTH endpoints lie on the trace", () => {
    const trace = traceColumn(chain, { node: "a", column: "id" });
    const edges = columnTraceEdges(chain, trace);
    expect(edges).toEqual([
      { source: "a", target: "b", sourceColumn: "id", targetColumn: "id" },
      { source: "b", target: "c", sourceColumn: "id", targetColumn: "id" },
    ]);
  });

  it("excludes an edge that only touches the trace on one side", () => {
    const trace = new Set(["a::id", "b::id"]); // c::id NOT on trace
    const edges = columnTraceEdges(chain, trace);
    expect(edges).toEqual([
      { source: "a", target: "b", sourceColumn: "id", targetColumn: "id" },
    ]);
  });
});

describe("toRfTraceEdge", () => {
  const edge: ColumnLineageEdge = { source: "a", target: "b", sourceColumn: "acct_id", targetColumn: "account_id" };

  it("maps source/target straight through and sourceHandle/targetHandle to the RAW column names (not swapped)", () => {
    const rf = toRfTraceEdge(edge, 0);
    expect(rf.source).toBe("a");
    expect(rf.target).toBe("b");
    // This is exactly the swap-typo this test exists to catch: sourceHandle
    // must be the SOURCE column, not the target column, or every trace edge
    // silently fails to attach to the right Handle (nodes.tsx row id).
    expect(rf.sourceHandle).toBe("acct_id");
    expect(rf.targetHandle).toBe("account_id");
    expect(rf.animated).toBe(true);
  });

  it("produces a stable, predictable id", () => {
    const rf = toRfTraceEdge(edge, 3);
    expect(rf.id).toBe("col-3-a.acct_id->b.account_id");
  });

  it("gives two different edges (or the same edge at different indices) two different ids — no collision", () => {
    const other: ColumnLineageEdge = { source: "b", target: "c", sourceColumn: "account_id", targetColumn: "account_id" };
    const rf0 = toRfTraceEdge(edge, 0);
    const rf1 = toRfTraceEdge(other, 1);
    expect(rf0.id).not.toBe(rf1.id);
  });

  it("styles the trace edge with the sky-blue stroke and a 2px width", () => {
    const rf = toRfTraceEdge(edge, 0);
    expect(rf.style).toMatchObject({ stroke: "#38bdf8", strokeWidth: 2 });
  });
});

describe("estimateColumnNodeSize", () => {
  it("reports the plain-width box with a header + pick-bar strip for zero picks", () => {
    expect(estimateColumnNodeSize([])).toEqual({ w: 180, h: HEADER_H + PICKBAR_H });
  });

  it("adds one row of height per picked column", () => {
    const size = estimateColumnNodeSize(["id", "amount"]);
    expect(size.h).toBe(HEADER_H + PICKBAR_H + 2 * ROW_H);
    expect(size.w).toBeGreaterThanOrEqual(180);
  });

  it("widens for a long column name but never past the max cap of 260", () => {
    const size = estimateColumnNodeSize(["a".repeat(80)]);
    expect(size.w).toBe(260);
  });
});
