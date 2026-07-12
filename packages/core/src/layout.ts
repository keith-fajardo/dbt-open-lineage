import dagre from "dagre";
import type { Graph } from "./graphTypes";

export const NODE_W = 180;
export const NODE_H = 44;
const COL_GAP = 80;
const ROW_GAP = 24;

/** Only the raw/input layers get column-locked so each lines up vertically;
 * everything downstream (staging, intermediate, marts, reports, …) keeps a
 * topology-driven dagre flow — chains step rightward naturally. Sources and
 * seeds are both raw inputs, so they SHARE one column (a source `netsuite`
 * and a seed `seed_netsuite` line up together). Staging is intentionally NOT
 * locked — it flows with the free subgraph like the rest of the model layers. */
const COLUMN_GROUPS: string[][] = [["source", "seed"]];
const LOCKED_LAYERS = COLUMN_GROUPS.flat();

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
): Map<string, { x: number; y: number }> {
  const isLocked = (layer: string) => LOCKED_LAYERS.includes(layer);
  const free = graph.nodes.filter((n) => !isLocked(n.layer));
  const freeIds = new Set(free.map((n) => n.id));

  // Dagre pass over the free subgraph only. A node with a callout is given
  // EXTRA height so dagre spaces its neighbors apart; the real node then sits
  // at the BOTTOM of that taller box, leaving the reserved space above it for
  // the callout bubble (rendered in flow-space by CalloutOverlay).
  const extraOf = (id: string) => calloutHeights?.get(id) ?? 0;
  const dg = new dagre.graphlib.Graph();
  dg.setGraph({ rankdir: "LR", nodesep: ROW_GAP, ranksep: COL_GAP });
  dg.setDefaultEdgeLabel(() => ({}));
  for (const n of free) dg.setNode(n.id, { width: NODE_W, height: NODE_H + extraOf(n.id) });
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
    fLeft = Math.min(fLeft, x - NODE_W / 2);
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
  const lockedWidth = usedGroups.length * (NODE_W + COL_GAP);
  const heightOf = (rows: number) => rows * NODE_H + (rows - 1) * ROW_GAP;

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
    pos.set(n.id, { x: x - NODE_W / 2 + freeShift, y: y - NODE_H / 2 + extra / 2 });
    // Locked barycenter ordering reads the dagre box center y, unchanged.
    centerY.set(n.id, y);
  }

  // Place locked columns RIGHT-to-left (staging → sources+seeds): each row
  // sorts by the average center-Y of its already-placed neighbors, so e.g.
  // staging follows its int consumers and raw inputs follow their staging.
  const colX = (gi: number) => usedGroups.indexOf(gi) * (NODE_W + COL_GAP);
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
    const colTop = freeMidY - heightOf(keyed.length) / 2;
    keyed.forEach((r, i) => {
      const yTop = colTop + i * (NODE_H + ROW_GAP);
      pos.set(r.id, { x: colX(gi), y: yTop });
      centerY.set(r.id, yTop + NODE_H / 2);
    });
  }

  return pos;
}
