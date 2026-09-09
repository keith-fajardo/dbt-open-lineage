import dagre from "dagre";
import type { Graph } from "./graphTypes";

export const NODE_W = 180;
export const NODE_H = 44;
const COL_GAP = 80;
const ROW_GAP = 24;

/** Above this size, Dagre's crossing-minimisation pass costs more than the
 * useful geometry it produces. The large-render acknowledgement in App.tsx
 * switches to this deterministic linear layout instead. Keeping the
 * threshold below the UI guard means a user who clicks "Show anyway" never
 * enters an O(V·E) layout pass for a project-sized graph. */
export const LARGE_LAYOUT_LIMIT = 1000;
const LARGE_LAYOUT_MAX_ROWS = 80;

/** Only the raw/input layers get column-locked so each lines up vertically;
 * everything downstream (staging, intermediate, marts, reports, …) keeps a
 * topology-driven dagre flow — chains step rightward naturally. Sources and
 * seeds are both raw inputs, so they SHARE one column (a source `netsuite`
 * and a seed `seed_netsuite` line up together). Staging is intentionally NOT
 * locked — it flows with the free subgraph like the rest of the model layers. */
const COLUMN_GROUPS: string[][] = [["source", "seed"]];
const LOCKED_LAYERS = COLUMN_GROUPS.flat();

/**
 * Fast layout for very large graphs.
 *
 * Dagre is excellent for a few hundred nodes, but its crossing-minimisation
 * pass becomes noticeably expensive once a manifest contains thousands. For
 * the explicit "Show anyway" path we only need stable, non-overlapping
 * coordinates. A Kahn pass gives each acyclic node a left-to-right rank; each
 * rank is then packed into short columns of at most LARGE_LAYOUT_MAX_ROWS.
 * Raw inputs (sources and seeds) are kept in one dedicated vertical column so
 * they remain visually identifiable even when rank zero contains many other
 * disconnected roots. Cycles (which dbt permits in partially-built manifests)
 * are placed in rank zero, still deterministically, rather than blocking the
 * whole layout.
 *
 * Callout/column heights are intentionally ignored here: large graphs render
 * compact nodes (see DagNodeData.compact), and reserving rich callout boxes
 * would defeat the purpose of the fast path. The regular Dagre path remains
 * byte-compatible for graphs below LARGE_LAYOUT_LIMIT.
 */
function layoutLargeGraph(graph: Graph): Map<string, { x: number; y: number }> {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const rank = new Map<string, number>();
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const n of graph.nodes) {
    rank.set(n.id, 0);
    indegree.set(n.id, 0);
    outgoing.set(n.id, []);
  }
  for (const e of graph.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    outgoing.get(e.from)!.push(e.to);
    indegree.set(e.to, indegree.get(e.to)! + 1);
  }

  // Stable queue order makes repeated renders use identical coordinates.
  const queue = graph.nodes
    .filter((n) => indegree.get(n.id) === 0)
    .map((n) => n.id)
    .sort();
  let head = 0;
  const processed = new Set<string>();
  while (head < queue.length) {
    const id = queue[head++];
    if (processed.has(id)) continue;
    processed.add(id);
    for (const child of outgoing.get(id) ?? []) {
      rank.set(child, Math.max(rank.get(child) ?? 0, (rank.get(id) ?? 0) + 1));
      const next = indegree.get(child)! - 1;
      indegree.set(child, next);
      if (next === 0) queue.push(child);
    }
  }

  const rawNodes = graph.nodes
    .filter((n) => LOCKED_LAYERS.includes(n.layer))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const rawIds = new Set(rawNodes.map((n) => n.id));
  const byRank = new Map<number, typeof graph.nodes>();
  for (const n of graph.nodes) {
    if (rawIds.has(n.id)) continue;
    const r = processed.has(n.id) ? (rank.get(n.id) ?? 0) : 0;
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r)!.push(n);
  }

  const pos = new Map<string, { x: number; y: number }>();
  for (let i = 0; i < rawNodes.length; i++) {
    pos.set(rawNodes[i].id, { x: 0, y: i * (NODE_H + ROW_GAP) });
  }
  let x = rawNodes.length ? NODE_W + COL_GAP : 0;
  for (const r of [...byRank.keys()].sort((a, b) => a - b)) {
    const rows = byRank.get(r)!;
    rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const columns = Math.max(1, Math.ceil(rows.length / LARGE_LAYOUT_MAX_ROWS));
    for (let i = 0; i < rows.length; i++) {
      const column = Math.floor(i / LARGE_LAYOUT_MAX_ROWS);
      const row = i % LARGE_LAYOUT_MAX_ROWS;
      pos.set(rows[i].id, {
        x: x + column * (NODE_W + COL_GAP),
        y: row * (NODE_H + ROW_GAP),
      });
    }
    x += columns * (NODE_W + COL_GAP);
  }
  return pos;
}

/** Compute a left→right layout once. The free (non-locked) subgraph gets its
 * OWN dagre pass, so its vertical extent is compact — laying out the full
 * graph and then removing the locked nodes leaves the survivors scattered
 * over the original (huge) height, with lonely outliers and an ocean of
 * empty space. Locked layers stack into one column each (source, seed,
 * staging), rows ordered by the average Y of their placed neighbors so
 * edges stay short, columns centered on the free subgraph. Top-left coords. */
export function layoutGraph(
  graph: Graph,
  calloutHeights?: Map<string, number>,
  sizes?: Map<string, { w: number; h: number }>,
): Map<string, { x: number; y: number }> {
  if (graph.nodes.length >= LARGE_LAYOUT_LIMIT) return layoutLargeGraph(graph);
  const isLocked = (layer: string) => LOCKED_LAYERS.includes(layer);
  const free = graph.nodes.filter((n) => !isLocked(n.layer));
  const freeIds = new Set(free.map((n) => n.id));

  // Dagre pass over the free subgraph only. A node with a callout is given
  // EXTRA height so dagre spaces its neighbors apart; the real node then sits
  // at the BOTTOM of that taller box, leaving the reserved space above it for
  // the callout bubble (rendered in flow-space by CalloutOverlay).
  const extraOf = (id: string) => calloutHeights?.get(id) ?? 0;
  // Per-node box size (column mode). Absent → NODE_W×NODE_H → byte-identical.
  const widthOf = (id: string) => sizes?.get(id)?.w ?? NODE_W;
  const nodeHeightOf = (id: string) => sizes?.get(id)?.h ?? NODE_H;
  const boxHeightOf = (id: string) => nodeHeightOf(id) + extraOf(id);
  const dg = new dagre.graphlib.Graph();
  dg.setGraph({ rankdir: "LR", nodesep: ROW_GAP, ranksep: COL_GAP });
  dg.setDefaultEdgeLabel(() => ({}));
  for (const n of free) dg.setNode(n.id, { width: widthOf(n.id), height: boxHeightOf(n.id) });
  for (const e of graph.edges) {
    if (freeIds.has(e.from) && freeIds.has(e.to)) dg.setEdge(e.from, e.to);
  }
  dagre.layout(dg);

  const pos = new Map<string, { x: number; y: number }>();

  // Free extent (dagre gives box centers; we store top-left at the end). Use
  // each node's ACTUAL dagre height so a tall callout box is fully accounted
  // for when centering the locked columns against the free subgraph.
  let fLeft = Infinity, fTop = Infinity, fBottom = -Infinity;
  for (const n of free) {
    const { x, y, height } = dg.node(n.id);
    fLeft = Math.min(fLeft, x - widthOf(n.id) / 2);
    fTop = Math.min(fTop, y - height / 2);
    fBottom = Math.max(fBottom, y + height / 2);
  }
  const freeMidY = free.length ? (fTop + fBottom) / 2 : 0;

  // Undirected adjacency, for barycenter ordering of locked rows.
  const neighbors = new Map<string, string[]>();
  for (const e of graph.edges) {
    (neighbors.get(e.from) ?? neighbors.set(e.from, []).get(e.from)!).push(e.to);
    (neighbors.get(e.to) ?? neighbors.set(e.to, []).get(e.to)!).push(e.from);
  }

  const byGroup = new Map<number, typeof graph.nodes>();
  for (const n of graph.nodes) {
    if (!isLocked(n.layer)) continue;
    const gi = COLUMN_GROUPS.findIndex((layers) => layers.includes(n.layer));
    if (!byGroup.has(gi)) byGroup.set(gi, []);
    byGroup.get(gi)!.push(n);
  }
  const usedGroups = [...byGroup.keys()].sort((a, b) => a - b);
  // Each locked group is as wide as its widest member; columns pack left→right
  // by cumulative width. Uniform sizes collapse this to the old
  // `index * (NODE_W + COL_GAP)`.
  const groupWidth = (gi: number) =>
    Math.max(NODE_W, ...byGroup.get(gi)!.map((n) => widthOf(n.id)));
  const colXMap = new Map<number, number>();
  let lockedAcc = 0;
  for (const gi of usedGroups) {
    colXMap.set(gi, lockedAcc);
    lockedAcc += groupWidth(gi) + COL_GAP;
  }
  const lockedWidth = lockedAcc;

  // Free node centers, shifted right of the locked columns (placed first so
  // locked barycenters can read final neighbor positions).
  const centerY = new Map<string, number>(); // node id → center y (final)
  const freeShift = free.length ? lockedWidth - fLeft : 0;
  for (const n of free) {
    const { x, y } = dg.node(n.id);
    // Place the real NODE_H-tall node at the bottom of its (taller) box: the
    // box top is `y - H/2` where H = NODE_H + extra, so the node top-left is
    // `boxTop + extra = y - NODE_H/2 + extra/2`. With extra === 0 this reduces
    // to `y - NODE_H/2` — byte-identical to the pre-callout layout.
    const extra = extraOf(n.id);
    pos.set(n.id, { x: x - widthOf(n.id) / 2 + freeShift, y: y - nodeHeightOf(n.id) / 2 + extra / 2 });
    // Locked barycenter ordering reads the dagre box center y, unchanged.
    centerY.set(n.id, y);
  }

  // Place locked columns RIGHT-to-left (staging → sources+seeds): each row
  // sorts by the average center-Y of its already-placed neighbors, so e.g.
  // staging follows its int consumers and raw inputs follow their staging.
  const colX = (gi: number) => colXMap.get(gi)!;
  for (const gi of [...usedGroups].reverse()) {
    const rows = byGroup.get(gi)!;
    const keyed = rows.map((n) => {
      const ys = (neighbors.get(n.id) ?? [])
        .map((nb) => centerY.get(nb))
        .filter((y): y is number => y !== undefined);
      return {
        id: n.id,
        name: n.name,
        bary: ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Number.POSITIVE_INFINITY,
      };
    });
    // Stable, deterministic: barycenter first, unconnected rows last by name.
    keyed.sort((a, b) => (a.bary - b.bary) || a.name.localeCompare(b.name));
    const totalH =
      keyed.reduce((s, r) => s + nodeHeightOf(r.id), 0) +
      Math.max(0, keyed.length - 1) * ROW_GAP;
    let yTop = freeMidY - totalH / 2;
    for (const r of keyed) {
      pos.set(r.id, { x: colX(gi), y: yTop });
      centerY.set(r.id, yTop + nodeHeightOf(r.id) / 2);
      yTop += nodeHeightOf(r.id) + ROW_GAP;
    }
  }

  return pos;
}

/** Top-left rect (in flow coords) that tightly bounds `nodes`, used to frame
 * the PNG/SVG export viewport. Per-node width/height come from `sizes`
 * (column mode's grown boxes — see App.tsx's nodeSizes) with a fallback to
 * NODE_W×NODE_H, mirroring layoutGraph's own widthOf/nodeHeightOf fallback
 * above. Absent `sizes` (or a node missing from it) → byte-identical to the
 * pre-Task-8 hardcoded 180×44 math. Pulled out of the App.tsx export handler
 * specifically to be unit-tested directly (see layout.test.ts): the export
 * path itself needs html-to-image + a real react-flow viewport to exercise,
 * neither of which this pure geometry depends on. */
export function computeExportBounds(
  nodes: { id: string; position: { x: number; y: number } }[],
  sizes?: Map<string, { w: number; h: number }>,
): { x: number; y: number; w: number; h: number } {
  const xs = nodes.map((n) => n.position.x);
  const ys = nodes.map((n) => n.position.y);
  const wOf = (id: string) => sizes?.get(id)?.w ?? NODE_W;
  const hOf = (id: string) => sizes?.get(id)?.h ?? NODE_H;
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    w: Math.max(...nodes.map((n) => n.position.x + wOf(n.id))) - x,
    h: Math.max(...nodes.map((n) => n.position.y + hOf(n.id))) - y,
  };
}
