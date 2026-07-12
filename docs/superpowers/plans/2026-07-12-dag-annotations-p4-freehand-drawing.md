# DAG Annotations — Plan 4: Freehand Drawing (whiteboard pen)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An ephemeral freehand pen for talking over the graph on a screenshare — draw bright strokes that pan/zoom with the DAG, erase individual strokes or clear all, never saved, auto-cleared on relayout.

**Architecture:** Strokes are stored in **flow coordinates** (converted from the pointer's screen position via React Flow's `screenToFlowPosition`) and rendered inside a `ViewportPortal` so they pan/zoom with the graph. A screen-fixed capture surface (active only in draw/erase mode) collects pointer input; in pen mode it appends points to the current stroke, in erase mode it deletes the stroke under the pointer. All drawing lives in React `useState` — **in-memory only**, gone on reload, and an effect clears it whenever the layout changes (a filter/selector change moves the nodes out from under the ink). The geometry (hit-testing, path building) is a pure, tested `drawing.ts`. See `packages/core/ARCHITECTURE.md` for the flow-space overlay invariant.

**Tech Stack:** React 19, `@xyflow/react` v12 (`ViewportPortal`, `useReactFlow`), vitest. Package: `@dbt-open-lineage/core`.

## Global Constraints

- Drawing is **ephemeral, in-memory only** — never persisted, never committed, never through the Bridge. Gone on reload.
- Ink lives in **flow coordinates** and renders in a `ViewportPortal` (pans/zooms with the graph). It is **cleared on relayout** (when the `positioned` map changes — filter/selector/graph change) so it can never strand. This is the one deliberate coordinate-space annotation (justified by being ephemeral).
- Strokes are **bright with a glow** so they read on the dark canvas — no dark default.
- In draw/erase mode, node drag / pane pan / selection are suppressed so pointer input becomes strokes; turning draw off restores normal interaction.
- Node/graph interaction styling still flows through `ViewContext`; drawing does not touch nodes, `DagNodeData`, or the node-build key.
- Tests: vitest (`npx vitest run` from `packages/core`); `npx tsc --noEmit` is the type gate. `DrawLayer` uses `screenToFlowPosition`, which needs real layout (unavailable in jsdom), so it is verified by tsc + hand, not unit-tested — the tested logic lives in `drawing.ts`.
- Mirror rule: core is consumed by both in-repo packages; do not break it.

---

### Task 1: Drawing geometry (`drawing.ts`)

**Files:**
- Create: `packages/core/src/drawing.ts`
- Test: `packages/core/src/drawing.test.ts`

**Interfaces:**
- Produces:
  - `type Point = [number, number]` (flow coords)
  - `interface Stroke { color: string; width: number; points: Point[] }`
  - `strokePath(points: Point[]): string` — an SVG path (`M x,y L x,y …`); a single point renders a dot (degenerate segment).
  - `hitStroke(stroke: Stroke, pt: Point, tol: number): boolean` — is `pt` within `tol` (flow units) of any segment of the stroke?
  - `eraseAt(strokes: Stroke[], pt: Point, tol: number): Stroke[]` — remove the **topmost** (last-drawn) stroke under `pt`; return a new array, or the same array if nothing is hit.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/drawing.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { strokePath, hitStroke, eraseAt, type Stroke } from "./drawing";

const S = (color: string, points: [number, number][]): Stroke => ({ color, width: 3, points });

describe("strokePath", () => {
  it("builds an SVG path from points", () => {
    expect(strokePath([[0, 0], [10, 20]])).toBe("M0.0,0.0 L10.0,20.0");
  });
  it("renders a single point as a dot (degenerate segment)", () => {
    expect(strokePath([[5, 5]])).toBe("M5.0,5.0 L5.0,5.0");
  });
  it("is empty for no points", () => {
    expect(strokePath([])).toBe("");
  });
});

describe("hitStroke", () => {
  const stroke = S("#fff", [[0, 0], [100, 0]]); // horizontal segment
  it("hits near the segment", () => {
    expect(hitStroke(stroke, [50, 3], 8)).toBe(true);
  });
  it("misses far from the segment", () => {
    expect(hitStroke(stroke, [50, 40], 8)).toBe(false);
  });
  it("hits a single-point stroke within tolerance", () => {
    expect(hitStroke(S("#fff", [[10, 10]]), [12, 12], 8)).toBe(true);
  });
});

describe("eraseAt", () => {
  const a = S("#a", [[0, 0], [100, 0]]);
  const b = S("#b", [[0, 0], [0, 100]]);
  it("removes the topmost stroke under the point, keeps the rest", () => {
    const out = eraseAt([a, b], [50, 2], 8); // only a is near (50,2)
    expect(out).toEqual([b]);
  });
  it("removes the last-drawn when strokes overlap at the point", () => {
    const out = eraseAt([a, b], [1, 1], 8); // both pass through origin area; b is last
    expect(out).toEqual([a]);
  });
  it("returns the same array reference when nothing is hit", () => {
    const input = [a, b];
    expect(eraseAt(input, [500, 500], 8)).toBe(input);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && npx vitest run src/drawing.test.ts`
Expected: FAIL — `Cannot find module './drawing'`.

- [ ] **Step 3: Implement `drawing.ts`**

```ts
export type Point = [number, number];
export interface Stroke { color: string; width: number; points: Point[] }

/** SVG path for a polyline. A single point renders as a zero-length segment
 * (a dot with round linecaps). Empty for no points. */
export function strokePath(points: Point[]): string {
  if (points.length === 0) return "";
  const fmt = ([x, y]: Point) => `${x.toFixed(1)},${y.toFixed(1)}`;
  if (points.length === 1) return `M${fmt(points[0])} L${fmt(points[0])}`;
  return "M" + points.map(fmt).join(" L ");
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/core && npx vitest run src/drawing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/drawing.ts packages/core/src/drawing.test.ts
git commit -m "feat(core): freehand drawing geometry (path, hit-test, erase)"
```

---

### Task 2: DrawLayer (capture + flow-space render)

**Files:**
- Create: `packages/core/src/DrawLayer.tsx`

**Interfaces:**
- Consumes: `Stroke`, `Point`, `strokePath`, `eraseAt` (Task 1); `ViewportPortal`, `useReactFlow` from `@xyflow/react`.
- Produces: `DrawLayer` component (rendered INSIDE `<ReactFlow>` so `useReactFlow` works):

```ts
type DrawMode = "off" | "pen" | "erase";
interface DrawLayerProps {
  mode: DrawMode;
  color: string;
  width: number;
  strokes: Stroke[];
  onStrokesChange: (updater: (prev: Stroke[]) => Stroke[]) => void; // React setState updater form
}
```

- [ ] **Step 1: Implement `DrawLayer.tsx`**

```tsx
import { type PointerEvent as ReactPointerEvent, useRef } from "react";
import { ViewportPortal, useReactFlow } from "@xyflow/react";
import { type Stroke, type Point, strokePath, eraseAt } from "./drawing";

export type DrawMode = "off" | "pen" | "erase";

interface DrawLayerProps {
  mode: DrawMode;
  color: string;
  width: number;
  strokes: Stroke[];
  onStrokesChange: (updater: (prev: Stroke[]) => Stroke[]) => void;
}

const ERASE_TOL = 8; // flow units

/** Freehand ink over the graph. A screen-fixed capture surface (active only in
 * pen/erase mode) turns pointer input into strokes stored in flow coordinates;
 * the strokes render in a ViewportPortal so they pan/zoom with the graph. Must
 * be rendered inside <ReactFlow> (uses useReactFlow). */
export function DrawLayer({ mode, color, width, strokes, onStrokesChange }: DrawLayerProps) {
  const rf = useReactFlow();
  const drawing = useRef(false);

  const toFlow = (e: ReactPointerEvent): Point => {
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    return [p.x, p.y];
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (mode === "off") return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const pt = toFlow(e);
    if (mode === "erase") { onStrokesChange((prev) => eraseAt(prev, pt, ERASE_TOL)); return; }
    drawing.current = true;
    onStrokesChange((prev) => [...prev, { color, width, points: [pt] }]);
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (mode === "erase" && (e.buttons & 1)) { const pt = toFlow(e); onStrokesChange((prev) => eraseAt(prev, pt, ERASE_TOL)); return; }
    if (mode !== "pen" || !drawing.current) return;
    const pt = toFlow(e);
    onStrokesChange((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      const updated: Stroke = { ...last, points: [...last.points, pt] };
      return [...prev.slice(0, -1), updated];
    });
  };

  const onPointerUp = () => { drawing.current = false; };

  return (
    <>
      {mode !== "off" && (
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          style={{
            position: "absolute", inset: 0, zIndex: 5,
            cursor: mode === "erase" ? "cell" : "crosshair",
            touchAction: "none",
          }}
        />
      )}
      <ViewportPortal>
        <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible", width: 1, height: 1, pointerEvents: "none" }}>
          {strokes.map((s, i) => (
            <path
              key={i} d={strokePath(s.points)} fill="none" stroke={s.color} strokeWidth={s.width}
              strokeLinecap="round" strokeLinejoin="round"
              style={{ filter: `drop-shadow(0 0 3px ${s.color})` }}
            />
          ))}
        </svg>
      </ViewportPortal>
    </>
  );
}
```

- [ ] **Step 2: Typecheck + full test run**

Run: `cd packages/core && npx tsc --noEmit && npx vitest run`
Expected: PASS (no new tests here — `DrawLayer` isn't mounted yet, so this just confirms it compiles and nothing regresses).

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/DrawLayer.tsx
git commit -m "feat(core): DrawLayer — flow-space freehand capture + render"
```

---

### Task 3: Wire drawing into App (toolbar + gating + auto-clear)

**Files:**
- Modify: `packages/core/src/App.tsx`

**Interfaces:**
- Consumes: `DrawLayer`, `type DrawMode` (Task 2); `type Stroke` (Task 1).
- Produces: drawing state (`drawMode`, `penColor`, `strokes`), a Draw toolbar group (Off/Pen/Erase + color palette + Clear), draw-mode gating of node/pane interaction, an auto-clear-on-relayout effect, and the `<DrawLayer>` mount.

- [ ] **Step 1: Add imports + state**

In `packages/core/src/App.tsx`, add imports:

```ts
import { DrawLayer, type DrawMode } from "./DrawLayer";
import { type Stroke } from "./drawing";
```

Add state near the other view state (after the drawing-unrelated filter state, e.g. after `tagFilter`):

```ts
  const [drawMode, setDrawMode] = useState<DrawMode>("off");
  const [penColor, setPenColor] = useState("#f8fafc");
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  // Ink is pinned in flow-space; when the layout changes (filter/selector/graph
  // change → new `positioned`), the nodes move out from under it, so clear it.
  useEffect(() => { setStrokes([]); }, [positioned]);
```

(The `positioned` memo is defined earlier in the component, so this effect can depend on it.)

- [ ] **Step 2: Gate node/pane interaction while drawing**

In the `<ReactFlow>` element, change the interaction props so draw mode suppresses drag/pan/selection. Replace the bare `nodesDraggable` prop:

```tsx
            nodesDraggable
```

with:

```tsx
            nodesDraggable={drawMode === "off"}
            panOnDrag={drawMode === "off"}
            elementsSelectable={drawMode === "off"}
```

(Leave `autoPanOnNodeDrag={false}`, `zoomOnDoubleClick={false}`, `minZoom`, etc. unchanged. Zoom/scroll stays enabled so you can still zoom while drawing.)

- [ ] **Step 3: Mount `<DrawLayer>` inside ReactFlow**

Right after the `{showCallouts && ( <CalloutOverlay … /> )}` block (still inside `<ReactFlow>`), add:

```tsx
            <DrawLayer
              mode={drawMode}
              color={penColor}
              width={3}
              strokes={strokes}
              onStrokesChange={setStrokes}
            />
```

(`setStrokes` is React's setState — its updater-form signature matches `onStrokesChange`.)

- [ ] **Step 4: Add the Draw controls to the toolbar**

In the toolbar row (the `<div style={{ display: "flex", gap: 8, padding: 8, alignItems: "center" }}>`), after the existing Callouts checkbox, add the Draw controls:

```tsx
          <div style={{ display: "inline-flex", border: "1px solid #334155", borderRadius: 6, overflow: "hidden" }}>
            {(["off", "pen", "erase"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setDrawMode(m)}
                style={{
                  padding: "6px 10px", border: "none", borderRadius: 0, cursor: "pointer",
                  fontFamily: "inherit", fontSize: 13,
                  background: drawMode === m ? "#2563eb" : "#111827",
                  color: drawMode === m ? "#e5e7eb" : "#94a3b8",
                }}
              >{m === "off" ? "Draw off" : m === "pen" ? "✎ Pen" : "⌫ Erase"}</button>
            ))}
          </div>
          {drawMode !== "off" && (
            <>
              {["#f8fafc", "#22d3ee", "#f0abfc", "#fde047"].map((c) => (
                <button
                  key={c}
                  aria-label={`pen color ${c}`}
                  onClick={() => setPenColor(c)}
                  style={{
                    width: 18, height: 18, borderRadius: "50%", cursor: "pointer",
                    background: c, border: penColor === c ? "2px solid #e5e7eb" : "1px solid #334155",
                    padding: 0,
                  }}
                />
              ))}
              <button
                onClick={() => setStrokes([])}
                style={{
                  padding: "6px 10px", borderRadius: 6, border: "1px solid #334155",
                  background: "#111827", color: "#e5e7eb", cursor: "pointer", fontFamily: "inherit", fontSize: 13,
                }}
              >Clear</button>
            </>
          )}
```

- [ ] **Step 5: Typecheck + full test run**

Run: `cd packages/core && npx tsc --noEmit && npx vitest run`
Expected: PASS (existing App render tests unaffected — draw mode defaults to `"off"`, so `DrawLayer` renders only the empty `ViewportPortal` and no capture surface).

- [ ] **Step 6: Verify by hand (documented)**

In the downstream consumer app: toggle **✎ Pen** → the pane no longer pans/selects; dragging draws a bright glowing stroke that pans/zooms with the graph. Switch **pen color** → new strokes use it. **⌫ Erase** → dragging over a stroke deletes it. **Clear** → wipes all. Applying a selector/focus filter (relayout) clears the ink. Reloading the view loses all ink (never saved). **Draw off** restores normal pan/drag/select. (Requires the consumer app; `screenToFlowPosition` needs real layout, so this isn't runnable from `packages/core` in isolation.)

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/App.tsx
git commit -m "feat(core): freehand pen toolbar — draw/erase/clear, ink auto-clears on relayout"
```

---

## Self-Review

**Spec coverage (Plan 4 scope):**
- Ephemeral in-memory pen, never saved, gone on reload — `strokes` is React state only — Task 3. ✓
- Flow-space strokes via `screenToFlowPosition` + `ViewportPortal` (pan/zoom with graph) — Task 2. ✓
- Auto-clear on relayout (`positioned` change) — Task 3. ✓
- Bright stroke + glow on the dark canvas; a color palette — Tasks 2, 3. ✓
- Draw-mode toggle suppresses pan/drag/selection — Task 3. ✓
- Eraser (per-stroke) + Clear all — Tasks 1 (`eraseAt`), 2 (erase mode), 3 (Clear button). ✓
- Deferred/absent (correct): persistence (never), per-stroke undo, variable widths, and stroke smoothing — not in scope.

**Placeholder scan:** No TBD/TODO; every code step carries complete code; every command has an expected result.

**Type consistency:** `Stroke`/`Point` from `drawing.ts` used by `DrawLayer` and App; `DrawMode` from `DrawLayer` used by App state; `onStrokesChange` is the React setState updater form and App passes `setStrokes` directly; `strokePath`/`eraseAt` (Task 1) consumed by `DrawLayer` (Task 2). No `ViewState`/node-data changes — drawing is fully independent of the node/filter machinery.

**Cross-task note:** `DrawLayer` is not unit-tested (its `screenToFlowPosition` needs real layout absent in jsdom); the geometry it relies on is fully tested in `drawing.ts` (Task 1), and Tasks 2–3 gate on `tsc` + the existing suite staying green + documented hand-verification. The capture surface (`zIndex: 5`, `position: absolute; inset: 0`) sits above the pane while draw mode is on; it renders only when `mode !== "off"`, so normal interaction is untouched by default.
