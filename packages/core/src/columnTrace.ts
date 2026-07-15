import type { Edge } from "@xyflow/react";
import { NODE_W } from "./layout";
import type { ColumnLineagePayload, ColumnLineageEdge } from "./columnLineage";

/** One (node, column) endpoint on the column-lineage graph. */
export interface ColEndpoint {
  node: string;
  column: string;
}

/** Stable set-membership key for an endpoint. Only ever compared / set-tested,
 * never parsed back — dbt unique_ids use dots and columns are identifiers, so
 * `::` cannot collide. */
export const endpointKey = (node: string, column: string): string => `${node}::${column}`;

/** Multi-hop column trace. An edge is (source,sourceColumn)→(target,targetColumn),
 * so a chain a.x→b.y→c.z is two edges sharing the endpoint (b,y). We match on
 * the shared (node,column) endpoint — never on the column NAME — so a mid-chain
 * rename (sourceColumn≠targetColumn) is followed for free.
 *
 * The graph is walked as a DIRECTED graph, NOT undirected. This matters at a
 * FAN-IN (merge) node — an endpoint fed by two or more DISTINCT upstream source
 * columns (a join key, a `CASE`/`COALESCE` over two different columns, etc.):
 *
 *   - FORWARD exploration (source→target — where a value FLOWS OUT) is always
 *     followed. Fan-out is genuine lineage no matter how we reached the node.
 *   - BACKWARD exploration (target→source — where a value FLOWS IN) is followed
 *     only THROUGH a 1:1 node — one whose single incoming source column is a
 *     genuine pass-through/rename/staging-copy, i.e. the SAME identity. If a
 *     node has ≥2 distinct incoming sources it is a merge point, and walking
 *     back into its sibling sources would conflate two DIFFERENT values'
 *     lineages (the classic leak: trace gl_code, reach a flag that gl_code and
 *     document_number both feed, then walk back into document_number and
 *     forward into document_number's unrelated downstream). So backward
 *     exploration STOPS at a merge point — regardless of the direction we
 *     arrived from, and including the start endpoint itself. Selecting a merge
 *     column therefore shows its forward lineage but not its distinct inputs;
 *     those are a different value and are one click away by selecting them.
 *
 * An undirected walk is exactly the special case where every node is 1:1, so
 * pure rename chains, fan-outs, and cycles all behave identically to before.
 * The visited set terminates any cycle. Returns the set of endpoint keys on the
 * trace, including the start. */
export function traceColumn(payload: ColumnLineagePayload, start: ColEndpoint): Set<string> {
  // fwd:  source endpoint → target endpoints (value flows OUT) — always walked.
  // back: target endpoint → source endpoints (value flows IN)  — walked only
  //       through a 1:1 node (see below).
  const fwd = new Map<string, string[]>();
  const back = new Map<string, string[]>();
  // Distinct source endpoints feeding each target endpoint. size ≥ 2 ⇒ merge
  // point. A Set dedupes duplicate edges so re-declared lineage never inflates
  // the count.
  const sources = new Map<string, Set<string>>();
  const push = (m: Map<string, string[]>, a: string, b: string) => {
    (m.get(a) ?? m.set(a, []).get(a)!).push(b);
  };
  for (const e of payload.edges) {
    const s = endpointKey(e.source, e.sourceColumn);
    const t = endpointKey(e.target, e.targetColumn);
    push(fwd, s, t);
    push(back, t, s);
    (sources.get(t) ?? sources.set(t, new Set<string>()).get(t)!).add(s);
  }
  const isPassThrough = (n: string) => sources.get(n)?.size === 1;

  const startKey = endpointKey(start.node, start.column);
  const visited = new Set<string>([startKey]);
  const stack = [startKey];
  while (stack.length) {
    const cur = stack.pop()!;
    const neighbors = fwd.get(cur) ?? [];
    // Only cross backward through a genuine 1:1 pass-through node — never a
    // merge point (≥2 distinct sources) or a pure source (0 sources).
    const back_ = isPassThrough(cur) ? back.get(cur) : undefined;
    for (const nb of back_ ? [...neighbors, ...back_] : neighbors) {
      if (!visited.has(nb)) {
        visited.add(nb);
        stack.push(nb);
      }
    }
  }
  return visited;
}

/** The subset of edges whose BOTH endpoints lie on the trace — the only edges
 * ever drawn/animated. */
export function columnTraceEdges(
  payload: ColumnLineagePayload,
  trace: Set<string>,
): ColumnLineageEdge[] {
  return payload.edges.filter(
    (e) =>
      trace.has(endpointKey(e.source, e.sourceColumn)) &&
      trace.has(endpointKey(e.target, e.targetColumn)),
  );
}

/** Maps one ColumnLineageEdge to its React Flow row-to-row edge props. `i` is
 * the edge's position in the trace-edges array, folded into `id` for
 * uniqueness. sourceHandle/targetHandle MUST equal the raw column names —
 * they must match the `id` DagNode (nodes.tsx) puts on each column row's
 * Handle — so this mapping is pulled out of the App.tsx memo specifically to
 * be unit-tested directly (see columnTrace.test.ts): a swapped
 * sourceColumn/targetColumn here silently breaks every trace edge's
 * rendering, with nothing else in CI to catch it. */
export function toRfTraceEdge(e: ColumnLineageEdge, i: number): Edge {
  return {
    id: `col-${i}-${e.source}.${e.sourceColumn}->${e.target}.${e.targetColumn}`,
    source: e.source, target: e.target,
    sourceHandle: e.sourceColumn, targetHandle: e.targetColumn, // row-to-row
    animated: true,
    style: { stroke: "#38bdf8", strokeWidth: 2 },
  };
}

/** Header chrome height (today's fixed 44px box). */
export const HEADER_H = 44;
/** The `+ trace column…` pick-bar strip under the header. */
export const PICKBAR_H = 22;
/** One picked-column row. */
export const ROW_H = 18;
const CHAR_W = 7;   // ~monospace advance at 11px
const PAD = 22;     // row horizontal padding (dot + gutters)
const MAX_W = 260;  // width cap — long column names ellipsize past this

/** Per-node box size in column mode, estimated from the picked column NAMES
 * (monospace rows make width estimable without DOM measurement, the same
 * spirit as estimateCalloutHeight). Zero picks → the plain NODE_W box plus the
 * header + pick-bar strip, so most nodes stay compact even with column mode on.
 * dagre only needs this to APPROXIMATE spacing — edge endpoints use React
 * Flow's DOM-measured handle positions, so a small estimate error never
 * affects edge correctness. */
export function estimateColumnNodeSize(columns: string[]): { w: number; h: number } {
  const longest = columns.reduce((m, c) => Math.max(m, c.length), 0);
  const w = Math.max(NODE_W, Math.min(MAX_W, PAD + longest * CHAR_W));
  const h = HEADER_H + PICKBAR_H + columns.length * ROW_H;
  return { w, h };
}
