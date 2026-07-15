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
 * The walk runs in two separate phases, deliberately kept apart so neither can
 * leak a value's UNRELATED siblings into the trace:
 *
 *   PHASE 1 — forward closure. Follow source→target edges from the start,
 *   completely unrestricted, however many hops. Fan-out is always genuine
 *   lineage of the value we started from.
 *
 *   PHASE 2 — backward climb. Follow target→source edges from the start
 *   (merge or not — clicking a merge column directly is an explicit request
 *   to see everything feeding it, e.g. a `UNION ALL` branch where dbt-colibri's
 *   edge shape can't tell a union from a genuine multi-column derivation), and
 *   continue climbing through any node with exactly ONE distinct source (a
 *   genuine 1:1 pass-through/rename). It stops at a node with ≥2 distinct
 *   sources reached mid-climb (a merge point) — walking into its OTHER
 *   sibling source would conflate a different value's lineage with ours.
 *
 *   Critically, phase 2 NEVER re-enters the forward map. An ancestor
 *   discovered only by climbing backward does not get to project its own
 *   unrelated forward fan-out into the trace — it was reached to explain
 *   where OUR value came from, not to introduce everything else it also
 *   feeds. (Real case: `memo` has exactly one source, `document_number` — a
 *   genuine 1:1 backward hop — but `document_number` ALSO independently feeds
 *   `flag` and its own downstream. Tracing `memo` must stop at
 *   `document_number`, not continue forward into `flag` and beyond.)
 *
 * An undirected single-phase walk is exactly the special case where every
 * node is 1:1 and has no independent forward fan-out of its own, so pure
 * rename chains, plain fan-outs, and cycles all behave identically to before.
 * The visited set terminates any cycle. Returns the set of endpoint keys on
 * the trace, including the start. */
export function traceColumn(payload: ColumnLineagePayload, start: ColEndpoint): Set<string> {
  // fwd:  source endpoint → target endpoints (value flows OUT).
  // back: target endpoint → source endpoints (value flows IN).
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

  // Phase 1: forward closure, always unrestricted.
  const visited = new Set<string>([startKey]);
  const fStack = [startKey];
  while (fStack.length) {
    const cur = fStack.pop()!;
    for (const nb of fwd.get(cur) ?? []) {
      if (!visited.has(nb)) {
        visited.add(nb);
        fStack.push(nb);
      }
    }
  }

  // Phase 2: backward-only climb — never touches `fwd`, so a node reached
  // here can't fan its own unrelated targets into the trace.
  const bStack = [startKey];
  while (bStack.length) {
    const cur = bStack.pop()!;
    if (cur !== startKey && !isPassThrough(cur)) continue;
    for (const nb of back.get(cur) ?? []) {
      if (!visited.has(nb)) {
        visited.add(nb);
        bStack.push(nb);
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
