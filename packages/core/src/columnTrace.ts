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
 * columns (a join key, a `CASE`/`COALESCE` over two different columns, a
 * `UNION ALL` branch, etc.):
 *
 *   - FORWARD exploration (source→target — where a value FLOWS OUT) is always
 *     followed. Fan-out is genuine lineage no matter how we reached the node.
 *   - BACKWARD exploration (target→source — where a value FLOWS IN) is followed
 *     only THROUGH a 1:1 node — one whose single incoming source column is a
 *     genuine pass-through/rename/staging-copy, i.e. the SAME identity — OR
 *     through the START endpoint itself, merge or not. If a node has ≥2
 *     distinct incoming sources it is a merge point, and walking back into its
 *     sibling sources MID-WALK would conflate two DIFFERENT values' lineages
 *     (the classic leak: trace gl_code, reach a flag that gl_code and
 *     document_number both feed, then walk back into document_number and
 *     forward into document_number's unrelated downstream). So backward
 *     exploration STOPS at a merge point reached mid-walk. The START endpoint
 *     is exempt from that block: clicking a merge column directly is an
 *     explicit request to see everything feeding it (e.g. a `UNION ALL` of two
 *     upstream models into one shared column — dbt-colibri's edge shape can't
 *     tell that apart from a genuine multi-column derivation, so this is a
 *     deliberate trade-off, not a general rule). It can still fan into a
 *     sibling's unrelated downstream when the start truly is a COALESCE/CASE
 *     merge rather than a union branch — acceptable because it only happens
 *     when the user clicks that exact merge column, never as a side effect of
 *     tracing an unrelated column through it.
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
    // Cross backward through a genuine 1:1 pass-through node, or through the
    // START endpoint itself (merge or not) — never through a merge point
    // (≥2 distinct sources) reached mid-walk.
    const back_ = (cur === startKey || isPassThrough(cur)) ? back.get(cur) : undefined;
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
/** The expand/collapse control strip ("▸ N columns") under the header. */
export const TOGGLE_H = 22;
/** One rendered column row. */
export const ROW_H = 18;
const CHAR_W = 7;   // ~monospace advance at 11px
const PAD = 22;     // row horizontal padding (dot + gutters)
const MAX_W = 260;  // width cap — long column names ellipsize past this

/** Per-node box size in column mode, estimated from the ACTUALLY RENDERED
 * column NAMES (monospace rows make width estimable without DOM measurement,
 * the same spirit as estimateCalloutHeight). The caller passes whichever list
 * is currently rendered on the node — the full catalog when the node is
 * EXPANDED, or just the live trace-revealed rows when it is COLLAPSED — so the
 * dagre-reserved box always matches what renders and neighbouring nodes never
 * overlap (see App.tsx `nodeSizes`). Zero rows → the plain NODE_W box plus the
 * header + toggle strip, so most nodes stay compact even with column mode on.
 * Because the reserved height now tracks the rendered rows exactly, React Flow
 * measures a correct handle position for every row's Handle — trace edges
 * anchor to the row, not the (formerly stale, undersized) node centre. */
export function estimateColumnNodeSize(columns: string[]): { w: number; h: number } {
  const longest = columns.reduce((m, c) => Math.max(m, c.length), 0);
  const w = Math.max(NODE_W, Math.min(MAX_W, PAD + longest * CHAR_W));
  const h = HEADER_H + TOGGLE_H + columns.length * ROW_H;
  return { w, h };
}
