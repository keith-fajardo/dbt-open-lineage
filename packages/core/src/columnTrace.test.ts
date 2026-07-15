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

  // ── Fan-in (merge) leak: the bug that motivated the directed walk. ──────────
  // `gl_code` genuinely derives int.flag (a CASE-WHEN). document_number ALSO
  // feeds that SAME flag (a second, distinct input) AND fans out on its own to
  // unrelated fact columns. flag itself flows forward to revenue_earned.
  //
  //   stg.gl_code ─────────────┐
  //                            ▼
  //   stg2.document_number ─► int.flag ─► fact.revenue_earned
  //          │
  //          ├─► fact.document_number      (unrelated to gl_code)
  //          └─► fact.memo                 (unrelated to gl_code)
  const fanIn: ColumnLineagePayload = {
    nodes: {},
    edges: [
      { source: "stg", target: "int", sourceColumn: "gl_code", targetColumn: "flag" },
      { source: "stg2", target: "int", sourceColumn: "document_number", targetColumn: "flag" },
      { source: "stg2", target: "fact", sourceColumn: "document_number", targetColumn: "document_number" },
      { source: "stg2", target: "fact", sourceColumn: "document_number", targetColumn: "memo" },
      { source: "int", target: "fact", sourceColumn: "flag", targetColumn: "revenue_earned" },
    ],
  };

  it("does NOT leak into a sibling source's unrelated fan-out through a merge node", () => {
    const trace = traceColumn(fanIn, { node: "stg", column: "gl_code" });
    // document_number and everything it (alone) feeds must be absent.
    expect(trace.has("stg2::document_number")).toBe(false);
    expect(trace.has("fact::document_number")).toBe(false);
    expect(trace.has("fact::memo")).toBe(false);
  });

  it("still includes the shared derived target itself (a genuine one-hop derivation) and its forward lineage", () => {
    const trace = traceColumn(fanIn, { node: "stg", column: "gl_code" });
    expect(trace).toEqual(
      new Set(["stg::gl_code", "int::flag", "fact::revenue_earned"]),
    );
  });

  it("forward fan-out is unrestricted even when it passes THROUGH a merge node", () => {
    // Arriving at int.flag forward (from gl_code) must not stop the forward
    // walk: revenue_earned (flag's downstream) is still reached, merge or not.
    const trace = traceColumn(fanIn, { node: "stg", column: "gl_code" });
    expect(trace.has("fact::revenue_earned")).toBe(true);
  });

  it("forward fan-out downstream of a 1:1 pass-through node is unchanged by the merge rule", () => {
    // a.id ─► b.id (1:1) ─► c.id and ─► d.id : classic fan-out past a
    // pass-through node, none of which is a merge point.
    const fanPastPassThrough: ColumnLineagePayload = {
      nodes: {},
      edges: [
        { source: "a", target: "b", sourceColumn: "id", targetColumn: "id" },
        { source: "b", target: "c", sourceColumn: "id", targetColumn: "id" },
        { source: "b", target: "d", sourceColumn: "id", targetColumn: "id" },
      ],
    };
    expect(traceColumn(fanPastPassThrough, { node: "a", column: "id" })).toEqual(
      new Set(["a::id", "b::id", "c::id", "d::id"]),
    );
  });

  // Judgment call: selecting the merge node ITSELF as the start. We block
  // backward exploration even from the start endpoint — a merge column is a new
  // value, not the identity of either input — so its distinct inputs are hidden
  // while its forward lineage is shown. This is the same uniform rule with no
  // special-casing, and it cannot re-leak into a sibling's fan-out.
  it("selecting the merge column directly shows its forward lineage but not its distinct inputs", () => {
    const trace = traceColumn(fanIn, { node: "int", column: "flag" });
    expect(trace).toEqual(new Set(["int::flag", "fact::revenue_earned"]));
    // Neither input is pulled in from the start...
    expect(trace.has("stg::gl_code")).toBe(false);
    expect(trace.has("stg2::document_number")).toBe(false);
    // ...so the sibling's unrelated fan-out stays out too.
    expect(trace.has("fact::memo")).toBe(false);
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
