export type Point = [number, number];
export interface Stroke { color: string; width: number; points: Point[] }

/** SVG path for a polyline. A single point renders as a zero-length segment
 * (a dot with round linecaps). Empty for no points. */
export function strokePath(points: Point[]): string {
  if (points.length === 0) return "";
  const fmt = ([x, y]: Point) => `${x.toFixed(1)},${y.toFixed(1)}`;
  if (points.length === 1) return `M${fmt(points[0])} L${fmt(points[0])}`;
  return "M" + fmt(points[0]) + points.slice(1).map(p => " L" + fmt(p)).join("");
}

/** Squared distance from p to segment ab (avoids a sqrt). */
function distSqToSeg(p: Point, a: Point, b: Point): number {
  const [px, py] = p, [ax, ay] = a, [bx, by] = b;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  const ex = px - cx, ey = py - cy;
  return ex * ex + ey * ey;
}

/** True when pt is within tol (flow units) of any segment of the stroke. */
export function hitStroke(stroke: Stroke, pt: Point, tol: number): boolean {
  const tol2 = tol * tol;
  const pts = stroke.points;
  if (pts.length === 1) return distSqToSeg(pt, pts[0], pts[0]) <= tol2;
  for (let i = 0; i < pts.length - 1; i++) {
    if (distSqToSeg(pt, pts[i], pts[i + 1]) <= tol2) return true;
  }
  return false;
}

/** Remove the topmost (last-drawn) stroke under pt. Returns a new array, or the
 * same reference when nothing is hit (lets callers skip a no-op state update). */
export function eraseAt(strokes: Stroke[], pt: Point, tol: number): Stroke[] {
  for (let i = strokes.length - 1; i >= 0; i--) {
    if (hitStroke(strokes[i], pt, tol)) return [...strokes.slice(0, i), ...strokes.slice(i + 1)];
  }
  return strokes;
}
