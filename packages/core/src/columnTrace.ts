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
 * so a chain a.x→b.y→c.z is two edges sharing the endpoint (b,y). We walk
 * endpoint ADJACENCY (both directions) transitively via BFS, matching on the
 * shared (node,column) endpoint — never on the column NAME — so a mid-chain
 * rename (sourceColumn≠targetColumn) is followed for free. The visited set
 * terminates any cycle. Returns the set of endpoint keys on the trace,
 * including the start. */
export function traceColumn(payload: ColumnLineagePayload, start: ColEndpoint): Set<string> {
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
  };
  for (const e of payload.edges) {
    const s = endpointKey(e.source, e.sourceColumn);
    const t = endpointKey(e.target, e.targetColumn);
    link(s, t);
    link(t, s);
  }
  const startKey = endpointKey(start.node, start.column);
  const visited = new Set<string>([startKey]);
  const stack = [startKey];
  while (stack.length) {
    for (const nb of adj.get(stack.pop()!) ?? []) {
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
