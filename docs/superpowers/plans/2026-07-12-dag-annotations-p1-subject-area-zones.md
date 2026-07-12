# DAG Annotations — Plan 1: Subject-Area Zones + Overlay Infra

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw named subject-area zones (box or convex-hull) around the models that belong to them, and let the user spotlight one area so its members stay lit while the rest of the graph dims — all as a flow-space overlay that pans and zooms with the DAG.

**Architecture:** A new SVG/div overlay is rendered inside React Flow's `ViewportPortal`, so it shares the viewport transform and stays glued to node positions through pan/zoom. Zone geometry is computed from the same `layoutGraph` position map the nodes use. Membership comes from each model's `meta.subject_areas` (a list, surfaced from `config.meta`); zone label + color come from a committed sidecar `lineage.annotations.yml`, read through the existing host `Bridge`. Spotlight dimming reuses the established pattern of pushing style state through `ViewContext` (never node data).

**Tech Stack:** React 19, `@xyflow/react` v12 (`ViewportPortal`), `yaml`, vitest. Package: `@dbt-open-lineage/core`.

## Global Constraints

- All host access goes through the `Bridge` in `src/bridge.ts` (`invoke`, `saveExport`, `openInIde`, `onContext`). No host-specific imports in core.
- Node dimensions are `180 × 44` (`NODE_W`/`NODE_H` in `src/layout.ts`); positions are **top-left** corners.
- Styling that changes on interaction must flow through `ViewContext` (`src/viewContext.ts`), **not** through node `data` — rebuilding node objects mid-drag blanks the graph in WKWebView.
- Sidecar and yaml paths passed to `fs.readText`/`fs.writeText` are **project-relative** (the host resolves them), matching `targetYamlPath`.
- YAML serialization always uses `doc.toString({ lineWidth: 0 })` (never re-wrap untouched lines).
- Any change to core is mirrored to the sibling VSCode repo per the existing mirror rule (out of scope for this plan's tasks, but do not break that contract).
- Tests: vitest, `import { describe, it, expect } from "vitest"`. Run from `packages/core` with `npm test`.

---

### Task 1: Zone geometry module

**Files:**
- Modify: `packages/core/src/layout.ts` (export `NODE_W`, `NODE_H`)
- Create: `packages/core/src/zones.ts`
- Test: `packages/core/src/zones.test.ts`

**Interfaces:**
- Consumes: `NODE_W`, `NODE_H` from `layout.ts`.
- Produces:
  - `nodeAreas(node: { meta?: Record<string, unknown> }): string[]`
  - `areaMembers(nodes: { id: string; meta?: Record<string, unknown> }[], area: string): string[]`
  - `interface Pt { x: number; y: number }`
  - `interface Box { x: number; y: number; w: number; h: number }`
  - `memberCorners(pos: Map<string, Pt>, ids: string[]): Pt[]`
  - `boundingBox(corners: Pt[], pad: number): Box | null`
  - `convexHull(pts: Pt[]): Pt[]`
  - `padHull(hull: Pt[], pad: number): Pt[]`

- [ ] **Step 1: Export node dimensions from layout**

In `packages/core/src/layout.ts`, change the two private constants to named exports (leave the values and all other code unchanged):

```ts
export const NODE_W = 180;
export const NODE_H = 44;
```

- [ ] **Step 2: Write the failing geometry tests**

Create `packages/core/src/zones.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  nodeAreas, areaMembers, memberCorners, boundingBox, convexHull, padHull, type Pt,
} from "./zones";

describe("nodeAreas", () => {
  it("returns the string list from meta.subject_areas", () => {
    expect(nodeAreas({ meta: { subject_areas: ["a", "b"] } })).toEqual(["a", "b"]);
  });
  it("returns [] when absent, non-array, or non-string entries", () => {
    expect(nodeAreas({})).toEqual([]);
    expect(nodeAreas({ meta: {} })).toEqual([]);
    expect(nodeAreas({ meta: { subject_areas: "a" } })).toEqual([]);
    expect(nodeAreas({ meta: { subject_areas: ["a", 3] } })).toEqual(["a"]);
  });
});

describe("areaMembers", () => {
  const nodes = [
    { id: "1", meta: { subject_areas: ["orders"] } },
    { id: "2", meta: { subject_areas: ["orders", "discounts"] } },
    { id: "3", meta: {} },
  ];
  it("returns ids of nodes whose subject_areas contains the area", () => {
    expect(areaMembers(nodes, "orders")).toEqual(["1", "2"]);
    expect(areaMembers(nodes, "discounts")).toEqual(["2"]);
    expect(areaMembers(nodes, "none")).toEqual([]);
  });
});

describe("boundingBox", () => {
  it("wraps member corners with padding", () => {
    const pos = new Map<string, Pt>([["1", { x: 0, y: 0 }], ["2", { x: 200, y: 100 }]]);
    const box = boundingBox(memberCorners(pos, ["1", "2"]), 10);
    // corners span x:0..380 (200+180), y:0..144 (100+44); pad 10 each side
    expect(box).toEqual({ x: -10, y: -10, w: 400, h: 164 });
  });
  it("returns null for no corners", () => {
    expect(boundingBox([], 10)).toBeNull();
  });
});

describe("convexHull + padHull", () => {
  it("hull contains all input points, padded hull excludes an interior stranger", () => {
    const square: Pt[] = [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
      { x: 50, y: 50 }, // interior point — must not be a hull vertex
    ];
    const hull = convexHull(square);
    expect(hull).toHaveLength(4);
    expect(hull).not.toContainEqual({ x: 50, y: 50 });
    const padded = padHull(hull, 5);
    // padding pushes vertices outward from centroid, so bbox grows
    const xs = padded.map((p) => p.x);
    expect(Math.min(...xs)).toBeLessThan(0);
    expect(Math.max(...xs)).toBeGreaterThan(100);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run src/zones.test.ts`
Expected: FAIL — `Cannot find module './zones'`.

- [ ] **Step 4: Implement `zones.ts`**

Create `packages/core/src/zones.ts`:

```ts
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/core && npx vitest run src/zones.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/layout.ts packages/core/src/zones.ts packages/core/src/zones.test.ts
git commit -m "feat(core): subject-area zone geometry (members, bbox, convex hull)"
```

---

### Task 2: Sidecar annotations parser

**Files:**
- Create: `packages/core/src/annotations.ts`
- Test: `packages/core/src/annotations.test.ts`

**Interfaces:**
- Produces:
  - `interface AreaStyle { label: string; color: string }`
  - `interface LabelStyle { label: string; color: string }`
  - `interface Annotations { areas: Record<string, AreaStyle>; labels: Record<string, LabelStyle> }`
  - `const EMPTY_ANNOTATIONS: Annotations`
  - `const SIDECAR_PATH = "lineage.annotations.yml"`
  - `parseAnnotations(text: string | null): Annotations`
  - `fallbackColor(index: number): string`

- [ ] **Step 1: Write the failing parser tests**

Create `packages/core/src/annotations.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseAnnotations, EMPTY_ANNOTATIONS } from "./annotations";

describe("parseAnnotations", () => {
  it("returns empty for null/blank/garbage", () => {
    expect(parseAnnotations(null)).toEqual(EMPTY_ANNOTATIONS);
    expect(parseAnnotations("")).toEqual(EMPTY_ANNOTATIONS);
    expect(parseAnnotations("just a string")).toEqual(EMPTY_ANNOTATIONS);
  });

  it("parses area and label styles", () => {
    const src = [
      "areas:",
      '  order_ledger: { label: "Order Ledger", color: "#8b5cf6" }',
      '  discounts:    { label: "Discounts",    color: "#6366f1" }',
      "labels:",
      '  core: { label: "Core", color: "#ef4444" }',
    ].join("\n");
    const a = parseAnnotations(src);
    expect(a.areas.order_ledger).toEqual({ label: "Order Ledger", color: "#8b5cf6" });
    expect(a.areas.discounts.color).toBe("#6366f1");
    expect(a.labels.core).toEqual({ label: "Core", color: "#ef4444" });
  });

  it("defaults a missing label to the key and a missing color to the fallback palette", () => {
    const a = parseAnnotations("areas:\n  web_session: {}\n");
    expect(a.areas.web_session.label).toBe("web_session");
    expect(a.areas.web_session.color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run src/annotations.test.ts`
Expected: FAIL — `Cannot find module './annotations'`.

- [ ] **Step 3: Implement `annotations.ts`**

Create `packages/core/src/annotations.ts`:

```ts
import { parse } from "yaml";

export interface AreaStyle { label: string; color: string }
export interface LabelStyle { label: string; color: string }
export interface Annotations {
  areas: Record<string, AreaStyle>;
  labels: Record<string, LabelStyle>;
}

export const EMPTY_ANNOTATIONS: Annotations = { areas: {}, labels: {} };

/** Project-relative path of the committed style sidecar. */
export const SIDECAR_PATH = "lineage.annotations.yml";

const PALETTE = [
  "#8b5cf6", "#14b8a6", "#6366f1", "#ef4444", "#22c55e",
  "#f59e0b", "#0ea5e9", "#ec4899", "#84cc16", "#f97316",
];

/** A stable fallback color for a style whose sidecar entry omits `color`. */
export function fallbackColor(index: number): string {
  return PALETTE[index % PALETTE.length];
}

function toStyleMap(raw: unknown): Record<string, AreaStyle> {
  const out: Record<string, AreaStyle> = {};
  if (!raw || typeof raw !== "object") return out;
  let i = 0;
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const v = (val && typeof val === "object" ? val : {}) as { label?: unknown; color?: unknown };
    out[key] = {
      label: typeof v.label === "string" ? v.label : key,
      color: typeof v.color === "string" ? v.color : fallbackColor(i),
    };
    i++;
  }
  return out;
}

/** Parse the style sidecar text. Tolerant: any shape that is not a map of
 * `{ label?, color? }` entries collapses to empty. */
export function parseAnnotations(text: string | null): Annotations {
  if (!text || !text.trim()) return EMPTY_ANNOTATIONS;
  let doc: unknown;
  try { doc = parse(text); } catch { return EMPTY_ANNOTATIONS; }
  if (!doc || typeof doc !== "object") return EMPTY_ANNOTATIONS;
  const d = doc as { areas?: unknown; labels?: unknown };
  return { areas: toStyleMap(d.areas), labels: toStyleMap(d.labels) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/core && npx vitest run src/annotations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/annotations.ts packages/core/src/annotations.test.ts
git commit -m "feat(core): parse lineage.annotations.yml style sidecar"
```

---

### Task 3: Load annotations + area/zone state in App

**Files:**
- Modify: `packages/core/src/App.tsx`

**Interfaces:**
- Consumes: `parseAnnotations`, `SIDECAR_PATH`, `EMPTY_ANNOTATIONS`, `type Annotations` (Task 2); `nodeAreas` (Task 1).
- Produces (App-local state used by Tasks 4–7): `annotations: Annotations`, `areasVisible: Set<string>`, `zoneShape: "box" | "hull"`, `spotArea: string | null`, and `allAreas: string[]` (sorted union of every area key appearing on any node or in the sidecar).

- [ ] **Step 1: Add imports**

In `packages/core/src/App.tsx`, add to the existing import block:

```ts
import { parseAnnotations, SIDECAR_PATH, EMPTY_ANNOTATIONS, type Annotations } from "./annotations";
import { nodeAreas } from "./zones";
```

- [ ] **Step 2: Add annotation load + area state**

Immediately after the existing `useEffect(() => { void load("dbt.manifest"); ... }, []);` line (~line 119), add:

```ts
  const [annotations, setAnnotations] = useState<Annotations>(EMPTY_ANNOTATIONS);
  useEffect(() => {
    let live = true;
    void invoke<string | null>("fs.readText", { path: SIDECAR_PATH })
      .then((t) => { if (live) setAnnotations(parseAnnotations(t)); })
      .catch(() => { if (live) setAnnotations(EMPTY_ANNOTATIONS); });
    return () => { live = false; };
  }, [projectPath]);

  // Every area key referenced by a node or defined in the sidecar, sorted.
  const allAreas = useMemo(() => {
    const set = new Set<string>(Object.keys(annotations.areas));
    if (graph) for (const n of graph.nodes) for (const a of nodeAreas(n)) set.add(a);
    return [...set].sort();
  }, [graph, annotations]);

  const [areasVisible, setAreasVisible] = useState<Set<string>>(new Set());
  const [zoneShape, setZoneShape] = useState<"box" | "hull">("box");
  const [spotArea, setSpotArea] = useState<string | null>(null);

  // Default: show every zone once the area list is known (and whenever it grows).
  useEffect(() => { setAreasVisible(new Set(allAreas)); }, [allAreas]);
```

- [ ] **Step 3: Typecheck**

Run: `cd packages/core && npx tsc --noEmit`
Expected: PASS (state is declared; unused-for-now `spotArea`/`zoneShape`/`areasVisible` are consumed in later tasks — if the project's tsconfig flags unused locals, that surfaces here and is resolved when Tasks 4–7 consume them; do not add throwaway usage).

Note: this project compiles with the shared `tsconfig.base.json`; unused *locals* are not errored by default (only unused parameters can be). If `tsc` is clean, proceed.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/App.tsx
git commit -m "feat(core): load annotations sidecar and add subject-area view state"
```

---

### Task 4: Zone overlay (box) in the viewport

**Files:**
- Create: `packages/core/src/ZonesOverlay.tsx`
- Modify: `packages/core/src/App.tsx`

**Interfaces:**
- Consumes: `areaMembers`, `memberCorners`, `boundingBox`, `type Box`, `type Pt` (Task 1); `type Annotations` (Task 2); the `positioned` map already computed in `App.tsx` (`Map<string, { x: number; y: number }>`).
- Produces: `ZonesOverlay` React component:

```ts
interface ZonesOverlayProps {
  nodes: { id: string; meta?: Record<string, unknown> }[];
  positions: Map<string, Pt>;
  annotations: Annotations;
  areasVisible: Set<string>;
  shape: "box" | "hull";
}
```

- [ ] **Step 1: Implement `ZonesOverlay.tsx` (box only for now)**

Create `packages/core/src/ZonesOverlay.tsx`:

```tsx
import { ViewportPortal } from "@xyflow/react";
import { areaMembers, memberCorners, boundingBox, type Pt } from "./zones";
import { fallbackColor, type Annotations } from "./annotations";

const ZONE_PAD = 18;

interface ZonesOverlayProps {
  nodes: { id: string; meta?: Record<string, unknown> }[];
  positions: Map<string, Pt>;
  annotations: Annotations;
  areasVisible: Set<string>;
  shape: "box" | "hull";
}

/** Renders subject-area zones inside the flow viewport so they pan/zoom with
 * the graph. Box shape only in this task; hull is added in Task 5. */
export function ZonesOverlay({ nodes, positions, annotations, areasVisible, shape }: ZonesOverlayProps) {
  // Stable order: sidecar order first, then any ad-hoc areas, alphabetical.
  const keys = [...areasVisible].sort();
  return (
    <ViewportPortal>
      {keys.map((area, i) => {
        const ids = areaMembers(nodes, area);
        const box = boundingBox(memberCorners(positions, ids), ZONE_PAD);
        if (!box) return null;
        const style = annotations.areas[area] ?? { label: area, color: fallbackColor(i) };
        const count = ids.length;
        return (
          <div key={area} data-area={area} style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }}>
            {/* Box drawn as a positioned div; hull (Task 5) swaps to an SVG path. */}
            {shape === "box" && (
              <div
                style={{
                  position: "absolute", left: box.x, top: box.y, width: box.w, height: box.h,
                  border: `1.5px dashed ${style.color}`, borderRadius: 14,
                  background: `${style.color}14`, boxSizing: "border-box",
                }}
              />
            )}
            <div
              style={{
                position: "absolute", left: box.x, top: box.y, transform: "translateY(-100%)",
                background: style.color, color: "#fff", padding: "4px 9px",
                borderRadius: "7px 7px 0 0", font: "600 11px/1 inherit", whiteSpace: "nowrap",
              }}
            >
              {style.label} <span style={{ opacity: 0.8, fontWeight: 500 }}>{count}</span>
            </div>
          </div>
        );
      })}
    </ViewportPortal>
  );
}
```

- [ ] **Step 2: Mount the overlay inside ReactFlow**

In `packages/core/src/App.tsx`, add the import:

```ts
import { ZonesOverlay } from "./ZonesOverlay";
```

Then inside the `<ReactFlow>…</ReactFlow>` element, alongside `<Background />` and `<Controls />` (around line 483), add:

```tsx
            <ZonesOverlay
              nodes={graph?.nodes ?? []}
              positions={positioned}
              annotations={annotations}
              areasVisible={areasVisible}
              shape={zoneShape}
            />
```

- [ ] **Step 3: Typecheck**

Run: `cd packages/core && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Verify by hand (documented, since this is a visual overlay)**

Run the existing dev harness for the package's consumer (VSCode extension or Mnemo mext) against a project whose models declare `config.meta.subject_areas`, e.g.:

```yaml
models:
  - name: stg_orders
    config:
      meta:
        subject_areas: [order_ledger]
```

with a `lineage.annotations.yml` at project root:

```yaml
areas:
  order_ledger: { label: "Order Ledger", color: "#8b5cf6" }
```

Expected: a violet dashed rounded box wraps `stg_orders` with an "Order Ledger 1" tab at its top-left; panning/zooming the graph moves the box with the node. If `@xyflow/react` in this repo does not export `ViewportPortal`, stop and check the installed version (`npm ls @xyflow/react` — must be ≥ 12.0); the portal is required for flow-space overlays.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/ZonesOverlay.tsx packages/core/src/App.tsx
git commit -m "feat(core): render subject-area zones (box) as a flow-space overlay"
```

---

### Task 5: Convex-hull zone shape

**Files:**
- Modify: `packages/core/src/ZonesOverlay.tsx`

**Interfaces:**
- Consumes: `convexHull`, `padHull` (Task 1), already-imported geometry helpers.

- [ ] **Step 1: Add hull rendering**

In `packages/core/src/ZonesOverlay.tsx`, extend the import from `./zones`:

```ts
import { areaMembers, memberCorners, boundingBox, convexHull, padHull, type Pt } from "./zones";
```

Replace the `{shape === "box" && ( … )}` block with box **and** hull branches:

```tsx
            {shape === "box" ? (
              <div
                style={{
                  position: "absolute", left: box.x, top: box.y, width: box.w, height: box.h,
                  border: `1.5px dashed ${style.color}`, borderRadius: 14,
                  background: `${style.color}14`, boxSizing: "border-box",
                }}
              />
            ) : (
              (() => {
                const hull = padHull(convexHull(memberCorners(positions, ids)), ZONE_PAD);
                if (hull.length < 3) return null;
                const d = "M" + hull.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L ") + " Z";
                return (
                  <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible", width: 1, height: 1 }}>
                    <path
                      d={d} fill={`${style.color}17`} stroke={style.color}
                      strokeWidth={1.5} strokeDasharray="7 5" strokeLinejoin="round"
                    />
                  </svg>
                );
              })()
            )}
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/core && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Verify by hand**

With the same fixture as Task 4 and a second member added to the area, toggle `zoneShape` to `"hull"` (temporarily default it to `"hull"` in App, or use the Task 7 control once built). Expected: the zone becomes a tight dashed polygon hugging the member nodes rather than a rectangle. Revert any temporary default.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/ZonesOverlay.tsx
git commit -m "feat(core): convex-hull zone shape option"
```

---

### Task 6: Spotlight-dim through ViewContext

**Files:**
- Modify: `packages/core/src/viewContext.ts`
- Modify: `packages/core/src/nodes.tsx`
- Modify: `packages/core/src/App.tsx`
- Test: `packages/core/src/nodes.test.tsx` (extend)

**Interfaces:**
- Consumes: `areaMembers` (Task 1), `spotArea` state (Task 3).
- Produces: `ViewState.spotlight: Set<string> | null` — when non-null, nodes whose id is **not** in the set render dimmed (composed with the existing selector/lineage dim).

- [ ] **Step 1: Extend ViewState**

In `packages/core/src/viewContext.ts`, add the field to the interface (after `matched`):

```ts
  /** When set (an area is spotlighted), nodes NOT in this set render dimmed. */
  spotlight: Set<string> | null;
```

and to the default context value:

```ts
  spotlight: null,
```

- [ ] **Step 2: Write the failing node-dim test**

In `packages/core/src/nodes.test.tsx`, add a test that a node outside the spotlight set dims. Follow the file's existing render + ViewContext pattern; the assertion:

```tsx
import { ViewContext } from "./viewContext";
// … inside the existing describe block …
it("dims a node that is not in the spotlight set", () => {
  const view = {
    selected: null, active: null, up: new Set<string>(), down: new Set<string>(),
    matched: null, search: "", spotlight: new Set<string>(["keepme"]),
  };
  const { container } = render(
    <ViewContext.Provider value={view}>
      <DagNode id="other" data={{ label: "other", layer: "model", materialized: "", testCount: 0 }} />
    </ViewContext.Provider>,
  );
  const box = container.firstElementChild as HTMLElement;
  expect(box.style.opacity).toBe("0.18");
});
```

(Import `render` from `@testing-library/react` and `DagNode` from `./nodes` as the existing tests in this file already do — match their imports rather than duplicating.)

- [ ] **Step 3: Run to verify it fails**

Run: `cd packages/core && npx vitest run src/nodes.test.tsx`
Expected: FAIL — `spotlight` is not yet read by `DagNode`, so `other` is not dimmed (opacity `"1"`).

- [ ] **Step 4: Read spotlight in DagNode**

In `packages/core/src/nodes.tsx`, update the `dim` computation (currently line ~56) to also dim on spotlight:

```ts
  const spotlit = view.spotlight == null || view.spotlight.has(id);
  const dim = active ? false
    : hasSel ? !inLineage
    : (view.matched != null && !view.matched.has(id)) || !spotlit;
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd packages/core && npx vitest run src/nodes.test.tsx`
Expected: PASS (new test green, existing tests still green).

- [ ] **Step 6: Wire spotlight into the App's ViewState**

In `packages/core/src/App.tsx`, compute the spotlight set and add it to the `view` memo. Add before the `view` memo (~line 274):

```ts
  const spotlight = useMemo(
    () => (graph && spotArea ? new Set(areaMembers(graph.nodes, spotArea)) : null),
    [graph, spotArea],
  );
```

Then add `spotlight,` to the object returned by the `view` useMemo, and add `spotlight` to that memo's dependency array. Import `areaMembers`:

```ts
import { nodeAreas, areaMembers } from "./zones";
```

(replacing the Task 3 `import { nodeAreas } from "./zones";`).

- [ ] **Step 7: Typecheck + full test run**

Run: `cd packages/core && npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/viewContext.ts packages/core/src/nodes.tsx packages/core/src/nodes.test.tsx packages/core/src/App.tsx
git commit -m "feat(core): spotlight an area to dim non-members via ViewContext"
```

---

### Task 7: Area control (visibility, spotlight, shape) in the toolbar

**Files:**
- Create: `packages/core/src/AreaControl.tsx`
- Modify: `packages/core/src/App.tsx`

**Interfaces:**
- Consumes: `allAreas`, `areasVisible`/`setAreasVisible`, `spotArea`/`setSpotArea`, `zoneShape`/`setZoneShape` (Task 3); `type Annotations` (Task 2).
- Produces: `AreaControl` component:

```ts
interface AreaControlProps {
  areas: string[];
  annotations: Annotations;
  visible: Set<string>;
  onVisibleChange: (next: Set<string>) => void;
  spot: string | null;
  onSpot: (area: string | null) => void;
  shape: "box" | "hull";
  onShape: (s: "box" | "hull") => void;
}
```

- [ ] **Step 1: Implement `AreaControl.tsx`**

Create `packages/core/src/AreaControl.tsx`:

```tsx
import { useState } from "react";
import { fallbackColor, type Annotations } from "./annotations";

interface AreaControlProps {
  areas: string[];
  annotations: Annotations;
  visible: Set<string>;
  onVisibleChange: (next: Set<string>) => void;
  spot: string | null;
  onSpot: (area: string | null) => void;
  shape: "box" | "hull";
  onShape: (s: "box" | "hull") => void;
}

const btn = (on: boolean): React.CSSProperties => ({
  padding: "6px 10px", borderRadius: 6, border: "1px solid #334155",
  background: on ? "#2563eb" : "#111827", color: "#e5e7eb",
  cursor: "pointer", fontFamily: "inherit", fontSize: 13,
});

/** Zone-shape toggle, an area-visibility dropdown, and a spotlight selector.
 * No areas ⇒ renders nothing (keeps the toolbar clean for un-annotated projects). */
export function AreaControl(p: AreaControlProps) {
  const [open, setOpen] = useState(false);
  if (!p.areas.length) return null;
  const toggle = (area: string) => {
    const next = new Set(p.visible);
    next.has(area) ? next.delete(area) : next.add(area);
    p.onVisibleChange(next);
  };
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <div style={{ display: "inline-flex", border: "1px solid #334155", borderRadius: 6, overflow: "hidden" }}>
        {(["box", "hull"] as const).map((s) => (
          <button key={s} onClick={() => p.onShape(s)}
            style={{ ...btn(p.shape === s), border: "none", borderRadius: 0 }}>{s}</button>
        ))}
      </div>

      <div style={{ position: "relative" }}>
        <button aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} style={btn(false)}>
          Areas · {p.visible.size}/{p.areas.length} ▾
        </button>
        {open && (
          <div role="menu" style={{
            position: "absolute", left: 0, top: "110%", zIndex: 20, minWidth: 220,
            background: "#111827", border: "1px solid #334155", borderRadius: 6, padding: 4,
          }}>
            {p.areas.map((area, i) => {
              const st = p.annotations.areas[area] ?? { label: area, color: fallbackColor(i) };
              return (
                <label key={area} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px",
                  color: "#e5e7eb", fontSize: 13, cursor: "pointer" }}>
                  <input type="checkbox" checked={p.visible.has(area)} onChange={() => toggle(area)} />
                  <span style={{ width: 11, height: 11, borderRadius: 3, background: st.color }} />
                  {st.label}
                </label>
              );
            })}
          </div>
        )}
      </div>

      <select
        aria-label="Spotlight area"
        value={p.spot ?? ""}
        onChange={(e) => p.onSpot(e.target.value || null)}
        style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #334155",
          background: "#111827", color: "#e5e7eb", fontFamily: "inherit", fontSize: 13 }}
      >
        <option value="">Spotlight: none</option>
        {p.areas.map((area, i) => (
          <option key={area} value={area}>{p.annotations.areas[area]?.label ?? area}</option>
        ))}
      </select>
    </div>
  );
}
```

- [ ] **Step 2: Mount it in the toolbar**

In `packages/core/src/App.tsx`, add the import:

```ts
import { AreaControl } from "./AreaControl";
```

Then inside the toolbar row `<div style={{ display: "flex", gap: 8, padding: 8, alignItems: "center" }}>` (line ~380), after the Focus `<label>…</label>` and before the search `<input>`, add:

```tsx
          <AreaControl
            areas={allAreas}
            annotations={annotations}
            visible={areasVisible}
            onVisibleChange={setAreasVisible}
            spot={spotArea}
            onSpot={setSpotArea}
            shape={zoneShape}
            onShape={setZoneShape}
          />
```

- [ ] **Step 3: Typecheck + full test run**

Run: `cd packages/core && npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 4: Verify by hand (end-to-end)**

With the Task 4 fixture (add a second area, e.g. `discounts`, sharing a model with `order_ledger`):
- The **box/hull** toggle switches every zone's shape.
- The **Areas ▾** dropdown checkboxes show/hide individual zones.
- **Spotlight** selecting an area dims every node outside it (shared models stay lit under either area); selecting "none" restores full brightness. No relayout occurs (nodes do not move).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/AreaControl.tsx packages/core/src/App.tsx
git commit -m "feat(core): area control — zone shape, visibility, and spotlight"
```

---

## Self-Review

**Spec coverage (Plan 1 scope):**
- Subject-area zones drawn from `meta.subject_areas` — Tasks 1, 4. ✓
- Multi-area membership (a model in several zones) — `areaMembers` selects by `includes`; a node appears in every matching zone — Tasks 1, 4. ✓
- Box **and** convex-hull shapes — Tasks 4, 5. ✓
- Sidecar `lineage.annotations.yml` for area label/color, read via Bridge — Tasks 2, 3. ✓
- Spotlight = dim non-members, no relayout (reuses the ViewContext style channel, never touches `layoutGraph`) — Task 6. ✓
- Flow-space overlay that pans/zooms with the graph (`ViewportPortal`) — Task 4. ✓
- Area visibility filter + shape toggle + spotlight UI — Task 7. ✓
- Deferred to later plans (correctly absent here): callouts, labels, favorites, drawing, and any yaml **writes** (this plan is read-only on disk).

**Placeholder scan:** No TBD/TODO; every code step carries complete code; every command has an expected result. ✓

**Type consistency:** `Pt`/`Box` defined in `zones.ts` and imported everywhere; `Annotations`/`AreaStyle` defined in `annotations.ts`; `ViewState.spotlight` added in Task 6 and read in `nodes.tsx`; `ZonesOverlayProps`/`AreaControlProps` match their call sites in `App.tsx`; `zoneShape` union `"box" | "hull"` consistent across Tasks 3–7. ✓

**Open dependency for later plans:** the list-valued `meta` **write** path (append/remove a `subject_areas`/`labels` value in `yamlEdit.ts`) is intentionally **not** in Plan 1 — Plan 1 reads membership only. It lands in Plan 2, where labels first need to be written.
