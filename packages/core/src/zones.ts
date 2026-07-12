import { NODE_W, NODE_H } from "./layout";

export interface Pt { x: number; y: number }
export interface Box { x: number; y: number; w: number; h: number }

/** The subject areas a node declares, via `meta.subject_areas` (a string list).
 * Tolerant of a missing/mistyped value: always returns a string[]. */
export function nodeAreas(node: { meta?: Record<string, unknown> }): string[] {
  const v = node.meta?.subject_areas;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Ids of the nodes that belong to `area`. */
export function areaMembers(
  nodes: { id: string; meta?: Record<string, unknown> }[], area: string,
): string[] {
  return nodes.filter((n) => nodeAreas(n).includes(area)).map((n) => n.id);
}

/** The four corners of every member node rectangle (top-left position map). */
export function memberCorners(pos: Map<string, Pt>, ids: string[]): Pt[] {
  const out: Pt[] = [];
  for (const id of ids) {
    const p = pos.get(id);
    if (!p) continue;
    out.push(
      { x: p.x, y: p.y }, { x: p.x + NODE_W, y: p.y },
      { x: p.x + NODE_W, y: p.y + NODE_H }, { x: p.x, y: p.y + NODE_H },
    );
  }
  return out;
}

/** Axis-aligned bounding box of `corners`, expanded by `pad` on all sides.
 * null when there are no corners. */
export function boundingBox(corners: Pt[], pad: number): Box | null {
  if (!corners.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of corners) {
    minX = Math.min(minX, c.x); minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x); maxY = Math.max(maxY, c.y);
  }
  return { x: minX - pad, y: minY - pad, w: (maxX - minX) + 2 * pad, h: (maxY - minY) + 2 * pad };
}

/** Convex hull (Andrew's monotone chain), counter-clockwise, no interior points. */
export function convexHull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/** Push each hull vertex outward from the centroid by `pad`. */
export function padHull(hull: Pt[], pad: number): Pt[] {
  if (!hull.length) return hull;
  const cx = hull.reduce((s, p) => s + p.x, 0) / hull.length;
  const cy = hull.reduce((s, p) => s + p.y, 0) / hull.length;
  return hull.map((p) => {
    const dx = p.x - cx, dy = p.y - cy, len = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / len) * pad, y: p.y + (dy / len) * pad };
  });
}
