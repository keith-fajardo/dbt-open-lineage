# DAG Annotations — Plan 2: Callouts + Labels

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render each model's note (its `meta.gist`) as a callout bubble pinned to its node, and render `meta.labels` as colored stripes on the node plus a filter/color-picker bar — while centralizing area+label style resolution so the swatch and the rendered mark always agree.

**Architecture:** Builds on Plan 1's flow-space overlay (`ViewportPortal`) and sidecar (`lineage.yml`). A new `styles.ts` resolves every area/label key to a `{label,color}` once in `App` (stable fallback indexing over the full key list), replacing the per-component `fallbackColor` calls that diverged in Plan 1. Callouts render as a node-anchored overlay (same pattern as zones). Label stripes render *inside* the node (via `DagNodeData`) so they dim with the node; the node-state machine is rebuilt when label styles resolve. Label filtering reuses the `ViewContext` dim channel with a new `filtered` set. Color edits are written back to the sidecar with a comment-preserving `yaml` document edit.

**Tech Stack:** React 19, `@xyflow/react` v12 (`ViewportPortal`), `yaml` (`parseDocument`), vitest. Package: `@dbt-open-lineage/core`.

## Global Constraints

- All host access goes through the `Bridge` in `src/bridge.ts` (`invoke`, …). No host-specific imports in core.
- Node dimensions `180 × 44` (`NODE_W`/`NODE_H` in `src/layout.ts`); positions are top-left.
- Interaction/emphasis styling flows through `ViewContext` (`src/viewContext.ts`), **not** node `data`. **Exception, allowed here:** a node's *static* label colors are node `data` (they do not change on interaction), but the node array must still only be rebuilt on layout/label-data changes — never per drag frame.
- Sidecar/yaml paths passed to the bridge are **project-relative** (`SIDECAR_PATH === "lineage.yml"`).
- YAML serialization always uses `doc.toString({ lineWidth: 0 })` — never re-wrap untouched lines.
- The callout text is the model's `meta.gist` verbatim; there is **no** separate callout-text field in this plan. `meta.callout` is a placement string; absent ⇒ no callout.
- The **style sidecar display field is `name`** (not `label`), so it never collides with the Labels concept. Block or flow mapping both parse identically — e.g. block form:
  ```yaml
  areas:
    order_ledger:
      name: "Order Ledger"
      color: "#8b5cf6"
  ```
  The in-memory style field is likewise `name` (`{ name: string; color: string }`). This renames the Plan-1 `AreaStyle.label`/`LabelStyle.label` field to `name`.
- This plan is **read-only on model `.yml` files** (membership/notes are hand-authored). The only disk write is the **style sidecar** (colors). No `config.meta` writes.
- Tests: vitest, `import { describe, it, expect } from "vitest"`, run from `packages/core` (`npx vitest run`).
- Mirror rule: core is consumed by both in-repo packages (`vscode`, `mext`); do not break that contract.

---

### Task 1: Centralized style resolution

**Files:**
- Modify: `packages/core/src/annotations.ts` (rename display field `label` → `name`)
- Test: `packages/core/src/annotations.test.ts` (update to `name`)
- Create: `packages/core/src/styles.ts`
- Test: `packages/core/src/styles.test.ts`
- Modify: `packages/core/src/App.tsx`, `packages/core/src/ZonesOverlay.tsx`, `packages/core/src/AreaControl.tsx`

**Interfaces:**
- Consumes: `fallbackColor`, `type AreaStyle`, `type LabelStyle` from `annotations.ts`.
- Produces:
  - `interface Style { name: string; color: string }`
  - `resolveStyles(defs: Record<string, { name: string; color: string }>, keys: string[]): Map<string, Style>`
    — for each key in `keys` (order = the caller's stable order), use `defs[key]` if present, else `{ name: key, color: fallbackColor(index) }` where `index` is the key's position in `keys`. This single source of truth removes the divergent `fallbackColor(i)` calls that Plan 1 had in both `ZonesOverlay` (indexed over visible-only keys) and `AreaControl` (indexed over all keys).

- [ ] **Step 0: Rename the sidecar display field `label` → `name`**

In `packages/core/src/annotations.ts`, rename the display field in both style interfaces and the parser default:

```ts
export interface AreaStyle { name: string; color: string }
export interface LabelStyle { name: string; color: string }
```

In `toStyleMap`, read `v.name` (was `v.label`) and default it to the key:

```ts
function toStyleMap(raw: unknown): Record<string, AreaStyle> {
  const out: Record<string, AreaStyle> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  let i = 0;
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const v = (val && typeof val === "object" ? val : {}) as { name?: unknown; color?: unknown };
    out[key] = {
      name: typeof v.name === "string" ? v.name : key,
      color: typeof v.color === "string" ? v.color : fallbackColor(i),
    };
    i++;
  }
  return out;
}
```

In `packages/core/src/annotations.test.ts`, update every sidecar fixture and assertion from `label:` to `name:` (the display field), and rewrite the "parses area and label styles" fixture in **block mapping** style so the test also proves block form parses (block and flow both parse identically):

```ts
  it("parses area and label styles (block form)", () => {
    const src = [
      "areas:",
      "  order_ledger:",
      '    name: "Order Ledger"',
      '    color: "#8b5cf6"',
      "labels:",
      "  core:",
      '    name: "Core"',
      '    color: "#ef4444"',
    ].join("\n");
    const a = parseAnnotations(src);
    expect(a.areas.order_ledger).toEqual({ name: "Order Ledger", color: "#8b5cf6" });
    expect(a.labels.core).toEqual({ name: "Core", color: "#ef4444" });
  });
```

The "defaults a missing …" test asserts `a.areas.web_session.name === "web_session"`. (The dbt `meta.subject_areas`/`meta.labels` KEYS are unchanged — only the sidecar's per-entry display field is renamed.)

Run: `cd packages/core && npx vitest run src/annotations.test.ts` — Expected: PASS after the rename.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/styles.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveStyles } from "./styles";

describe("resolveStyles", () => {
  it("uses the sidecar def when present", () => {
    const m = resolveStyles({ a: { name: "Alpha", color: "#111111" } }, ["a"]);
    expect(m.get("a")).toEqual({ name: "Alpha", color: "#111111" });
  });

  it("falls back to key + palette color, indexed by position in keys", () => {
    const m = resolveStyles({}, ["a", "b", "c"]);
    expect(m.get("a")!.name).toBe("a");
    expect(m.get("a")!.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    // stable-by-position: b and c get distinct palette colors from a
    expect(m.get("b")!.color).not.toBe(m.get("a")!.color);
    expect(m.get("c")!.color).not.toBe(m.get("b")!.color);
  });

  it("gives a key the SAME fallback color regardless of which subset is asked, as long as its index in keys is the same", () => {
    const full = resolveStyles({}, ["a", "b", "c"]);
    const same = resolveStyles({}, ["a", "b", "c"]);
    expect(same.get("b")!.color).toBe(full.get("b")!.color);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && npx vitest run src/styles.test.ts`
Expected: FAIL — `Cannot find module './styles'`.

- [ ] **Step 3: Implement `styles.ts`**

```ts
import { fallbackColor } from "./annotations";

export interface Style { name: string; color: string }

/** Resolve every key to a { name, color }. Keys present in `defs` use their
 * committed style; the rest get { name: key, color: fallbackColor(indexInKeys) }.
 * Callers pass one stable ordered `keys` list (e.g. the sorted union of all
 * area or all label keys), so a key's fallback color never depends on which
 * subset happens to be visible. */
export function resolveStyles(
  defs: Record<string, { name: string; color: string }>, keys: string[],
): Map<string, Style> {
  const out = new Map<string, Style>();
  keys.forEach((key, i) => {
    out.set(key, defs[key] ?? { name: key, color: fallbackColor(i) });
  });
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/core && npx vitest run src/styles.test.ts`
Expected: PASS.

- [ ] **Step 5: Thread resolved styles through App**

In `packages/core/src/App.tsx`:

Add the import near the other local imports:

```ts
import { resolveStyles, type Style } from "./styles";
```

After the existing `allAreas` memo (ends ~line 139), add an `allLabels` memo and both resolved-style memos:

```ts
  const allLabels = useMemo(() => {
    const set = new Set<string>(Object.keys(annotations.labels));
    if (graph) for (const n of graph.nodes) for (const l of nodeLabels(n)) set.add(l);
    return [...set].sort();
  }, [graph, annotations]);

  const areaStyles = useMemo(() => resolveStyles(annotations.areas, allAreas), [annotations, allAreas]);
  const labelStyles = useMemo(() => resolveStyles(annotations.labels, allLabels), [annotations, allLabels]);
```

Widen the `./zones` import to include `nodeLabels` (added in Task 2 — if Task 2 is not yet merged when you reach this line, add `nodeLabels` to that import as part of Task 2; for Task 1, temporarily compute `allLabels`/`labelStyles` is still valid because `nodeLabels` is only referenced there). To keep Task 1 self-contained and compiling, add `nodeLabels` to `zones.ts` now as a one-line accessor if it does not exist:

```ts
// in packages/core/src/zones.ts — add next to nodeAreas if not present:
export function nodeLabels(node: { meta?: Record<string, unknown> }): string[] {
  const v = node.meta?.labels;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
```

and import it in App: change `import { nodeAreas, areaMembers } from "./zones";` to `import { nodeAreas, nodeLabels, areaMembers } from "./zones";`.

- [ ] **Step 6: Switch ZonesOverlay + AreaControl to resolved styles**

In `packages/core/src/ZonesOverlay.tsx`: replace the `annotations: Annotations` prop with `styles: Map<string, Style>`, drop the `fallbackColor`/`Annotations` import, and use the map. Full new file:

```tsx
import { ViewportPortal } from "@xyflow/react";
import { areaMembers, memberCorners, boundingBox, convexHull, padHull, type Pt } from "./zones";
import { type Style } from "./styles";

const ZONE_PAD = 18;

interface ZonesOverlayProps {
  nodes: { id: string; meta?: Record<string, unknown> }[];
  positions: Map<string, Pt>;
  styles: Map<string, Style>;
  areasVisible: Set<string>;
  shape: "box" | "hull";
}

/** Subject-area zones rendered inside the flow viewport so they pan/zoom with
 * the graph. Members that lack a position (filtered out) are skipped. */
export function ZonesOverlay({ nodes, positions, styles, areasVisible, shape }: ZonesOverlayProps) {
  const keys = [...areasVisible].sort();
  return (
    <ViewportPortal>
      {keys.map((area) => {
        const ids = areaMembers(nodes, area);
        const corners = memberCorners(positions, ids);
        const box = boundingBox(corners, ZONE_PAD);
        if (!box) return null;
        const style = styles.get(area) ?? { name: area, color: "#64748b" };
        return (
          <div key={area} data-area={area} style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }}>
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
                const hull = padHull(convexHull(corners), ZONE_PAD);
                if (hull.length < 3) return null;
                const d = "M" + hull.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L ") + " Z";
                return (
                  <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible", width: 1, height: 1 }}>
                    <path d={d} fill={`${style.color}17`} stroke={style.color}
                      strokeWidth={1.5} strokeDasharray="7 5" strokeLinejoin="round" />
                  </svg>
                );
              })()
            )}
            <div
              style={{
                position: "absolute", left: box.x, top: box.y, transform: "translateY(-100%)",
                background: style.color, color: "#fff", padding: "4px 9px",
                borderRadius: "7px 7px 0 0", font: "600 11px/1 inherit", whiteSpace: "nowrap",
              }}
            >
              {style.name} <span style={{ opacity: 0.8, fontWeight: 500 }}>{ids.length}</span>
            </div>
          </div>
        );
      })}
    </ViewportPortal>
  );
}
```

In `packages/core/src/AreaControl.tsx`: replace the `annotations: Annotations` prop with `styles: Map<string, Style>`, drop the `fallbackColor`/`Annotations` import, and read `p.styles.get(area)`:
- Change import line to `import { type Style } from "./styles";`
- Change the prop type `annotations: Annotations;` → `styles: Map<string, Style>;`
- In the dropdown map, replace `const st = p.annotations.areas[area] ?? { label: area, color: fallbackColor(i) };` with `const st = p.styles.get(area) ?? { name: area, color: "#64748b" };` (the `i` index is no longer needed — you may keep `(area, i)` or drop `i`), and render `st.name` instead of `st.label` for the row text.
- In the `<select>` options, replace `p.annotations.areas[area]?.label ?? area` with `p.styles.get(area)?.name ?? area`.

Update the two call sites in `App.tsx`:
- `<AreaControl … annotations={annotations} … />` → `styles={areaStyles}`.
- `<ZonesOverlay … annotations={annotations} … />` → `styles={areaStyles}`.

- [ ] **Step 7: Typecheck + full test run**

Run: `cd packages/core && npx tsc --noEmit && npx vitest run`
Expected: PASS (all existing tests + new styles tests; 101+ tests).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/annotations.ts packages/core/src/annotations.test.ts packages/core/src/styles.ts packages/core/src/styles.test.ts packages/core/src/zones.ts packages/core/src/App.tsx packages/core/src/ZonesOverlay.tsx packages/core/src/AreaControl.tsx
git commit -m "refactor(core): centralize style resolution + rename sidecar display field to name"
```

---

### Task 2: Label node stripes

**Files:**
- Modify: `packages/core/src/zones.ts` (ensure `nodeLabels` exists — added in Task 1)
- Test: `packages/core/src/zones.test.ts` (add `nodeLabels` cases)
- Modify: `packages/core/src/nodes.tsx` (render stripes), `packages/core/src/nodes.test.tsx` (stripe test)
- Modify: `packages/core/src/App.tsx` (feed `labelColors` into node data; rebuild nodes when label styles resolve)

**Interfaces:**
- Consumes: `nodeLabels` (Task 1), `labelStyles: Map<string, Style>` (Task 1).
- Produces: `DagNodeData.labelColors?: string[]` — resolved colors of the node's labels, in `meta.labels` order.

- [ ] **Step 1: Add `nodeLabels` tests**

In `packages/core/src/zones.test.ts`, add:

```ts
import { nodeLabels } from "./zones"; // add to the existing import from "./zones"

describe("nodeLabels", () => {
  it("returns the string list from meta.labels", () => {
    expect(nodeLabels({ meta: { labels: ["core", "revenue"] } })).toEqual(["core", "revenue"]);
  });
  it("returns [] when absent / non-array / non-string entries", () => {
    expect(nodeLabels({})).toEqual([]);
    expect(nodeLabels({ meta: { labels: "core" } })).toEqual([]);
    expect(nodeLabels({ meta: { labels: ["core", 7] } })).toEqual(["core"]);
  });
});
```

(If Task 1 already added the `nodeLabels` function, this step only adds the tests.)

- [ ] **Step 2: Run to verify the new tests pass (function exists from Task 1)**

Run: `cd packages/core && npx vitest run src/zones.test.ts`
Expected: PASS. (If `nodeLabels` is missing, add it per Task 1 Step 5's snippet, then re-run.)

- [ ] **Step 3: Write the failing node-stripe test**

In `packages/core/src/nodes.test.tsx`, add (mirroring the file's existing render + ViewContext helper usage):

```tsx
it("renders a left-edge stripe per label color", () => {
  const view = {
    selected: null, active: null, up: new Set<string>(), down: new Set<string>(),
    matched: null, search: "", spotlight: null, filtered: null,
  };
  const { container } = render(
    <ViewContext.Provider value={view}>
      <DagNode id="n" data={{ label: "n", layer: "model", materialized: "", testCount: 0, labelColors: ["#ef4444", "#22c55e"] }} />
    </ViewContext.Provider>,
  );
  const stripes = container.querySelectorAll('[data-label-stripe]');
  expect(stripes).toHaveLength(2);
  expect((stripes[0] as HTMLElement).style.background).toBe("rgb(239, 68, 68)");
});
```

Note: this test's `view` includes `filtered: null` — the `ViewState.filtered` field is added in Task 4. If Task 4 is not yet done when you run Task 2, temporarily omit `filtered` from this literal; the field is optional to construct only if `ViewState` doesn't require it yet. Simpler: do Task 2 and Task 4's `ViewState` field addition can both include `filtered`. If TypeScript complains that `filtered` is missing on `ViewState`, that means Task 4 hasn't run — add `filtered: null` to `ViewState` now (it's harmless and Task 4 will use it) or drop it from this literal.

- [ ] **Step 4: Run to verify it fails**

Run: `cd packages/core && npx vitest run src/nodes.test.tsx`
Expected: FAIL — no `[data-label-stripe]` elements (stripes not rendered yet).

- [ ] **Step 5: Render stripes in DagNode**

In `packages/core/src/nodes.tsx`:

Add `labelColors` to the data interface (after `testCount`):

```ts
  /** Resolved colors of this node's labels (meta.labels), left-edge stripes. */
  labelColors?: string[];
```

Inside the node's outer `<div>` (which is already `position: "relative"`), add the stripe column as the first child, right after the opening `<Handle type="target" … />` line:

```tsx
      {data.labelColors && data.labelColors.length > 0 && (
        <div aria-hidden style={{ position: "absolute", left: 3, top: 6, bottom: 6, display: "flex", gap: 2 }}>
          {data.labelColors.map((c, i) => (
            <span key={i} data-label-stripe style={{ width: 3, borderRadius: 3, background: c, display: "block" }} />
          ))}
        </div>
      )}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd packages/core && npx vitest run src/nodes.test.tsx`
Expected: PASS.

- [ ] **Step 7: Feed labelColors into node data + rebuild on label-style change**

In `packages/core/src/App.tsx`, update `buildNodes` (currently ~line 197) to set `labelColors` from the node's labels resolved through `labelStyles`. In the returned object's `data`, add:

```ts
          labelColors: nodeLabels(n)
            .map((l) => labelStyles.get(l)?.color)
            .filter((c): c is string => !!c),
```

The node array is rebuilt only when `positioned` changes (`nodeState.base !== positioned`). Label colors resolve after the manifest loads (annotations arrive via the sidecar effect), which does **not** change `positioned`, so stripes would not appear until the next relayout. Fix the rebuild key to also fire when `labelStyles` changes — but never per drag frame (label styles never change mid-drag). Introduce a composite build key. Replace:

```ts
  const [nodeState, setNodeState] = useState<{ base: unknown; nodes: Node<DagNodeData>[] }>(
    { base: null, nodes: [] },
  );
  if (nodeState.base !== positioned) {
    setNodeState({ base: positioned, nodes: buildNodes() }); // derived-state reset during render
  }
  const rfNodes = nodeState.base === positioned ? nodeState.nodes : buildNodes();
```

with:

```ts
  // Rebuild the node array when the layout OR the resolved label styles change
  // (label colors live in node data). A drag never changes either, so this
  // never rebuilds mid-drag — preserving node identity for React Flow.
  const nodeBuildKey = useMemo(() => ({ positioned, labelStyles }), [positioned, labelStyles]);
  const [nodeState, setNodeState] = useState<{ base: unknown; nodes: Node<DagNodeData>[] }>(
    { base: null, nodes: [] },
  );
  if (nodeState.base !== nodeBuildKey) {
    setNodeState({ base: nodeBuildKey, nodes: buildNodes() }); // derived-state reset during render
  }
  const rfNodes = nodeState.base === nodeBuildKey ? nodeState.nodes : buildNodes();
```

(Leave `onNodesChange` untouched — it still applies drag changes to `prev.nodes` and preserves `prev.base`.)

- [ ] **Step 8: Typecheck + full test run**

Run: `cd packages/core && npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/zones.ts packages/core/src/zones.test.ts packages/core/src/nodes.tsx packages/core/src/nodes.test.tsx packages/core/src/App.tsx
git commit -m "feat(core): render meta.labels as colored node stripes"
```

---

### Task 3: Callout overlay

**Files:**
- Create: `packages/core/src/CalloutOverlay.tsx`
- Modify: `packages/core/src/App.tsx`

**Interfaces:**
- Consumes: `positions` map, node list; `type Pt` from `zones.ts`.
- Produces: `CalloutOverlay` component:

```ts
interface CalloutOverlayProps {
  nodes: { id: string; meta?: Record<string, unknown> }[];
  positions: Map<string, Pt>;
  dimmed: boolean; // fade callouts while a selection/filter narrows the graph
}
```

- [ ] **Step 1: Implement `CalloutOverlay.tsx`**

A callout renders for any node that has a non-empty `meta.gist` AND a truthy `meta.callout` placement. Bubble sits above the node (placement `top` for this plan) with a leader line to the node's top-center. Node size is 180×44.

```tsx
import { ViewportPortal } from "@xyflow/react";
import { type Pt } from "./zones";

const NODE_W = 180;

interface CalloutOverlayProps {
  nodes: { id: string; meta?: Record<string, unknown> }[];
  positions: Map<string, Pt>;
  dimmed: boolean;
}

function gistOf(node: { meta?: Record<string, unknown> }): string | null {
  const g = node.meta?.gist;
  const c = node.meta?.callout;
  if (typeof g !== "string" || !g.trim() || !c) return null;
  return g.trim();
}

/** Callout bubbles pinned above their node, rendered in flow-space so they
 * pan/zoom with the graph. Text is the model's meta.gist; a node without a
 * gist or without a meta.callout placement gets none. Callouts do not track
 * hand-dragged nodes (they read the layout position map), matching the zone
 * overlay's behavior. */
export function CalloutOverlay({ nodes, positions, dimmed }: CalloutOverlayProps) {
  return (
    <ViewportPortal>
      {nodes.map((n) => {
        const text = gistOf(n);
        const p = text ? positions.get(n.id) : undefined;
        if (!text || !p) return null;
        const anchorX = p.x + NODE_W / 2;
        const bubbleW = 200;
        const bubbleLeft = anchorX - bubbleW / 2;
        const bubbleBottom = p.y - 14; // gap above node top
        return (
          <div key={n.id} style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", opacity: dimmed ? 0.25 : 1 }}>
            <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible", width: 1, height: 1 }}>
              <line x1={anchorX} y1={bubbleBottom} x2={anchorX} y2={p.y - 1} stroke="#38bdf8" strokeWidth={2} />
              <circle cx={anchorX} cy={p.y - 1} r={3.5} fill="#38bdf8" />
            </svg>
            <div
              style={{
                position: "absolute", left: bubbleLeft, top: bubbleBottom, transform: "translateY(-100%)",
                width: bubbleW, boxSizing: "border-box",
                background: "#38bdf8", color: "#0a0f1a", borderRadius: 9, padding: "8px 11px",
                font: "500 12px/1.34 inherit", boxShadow: "0 8px 22px rgba(0,0,0,0.5)",
              }}
            >
              <span style={{ display: "block", font: "700 9px/1 inherit", letterSpacing: "0.11em", textTransform: "uppercase", opacity: 0.72, marginBottom: 5 }}>
                note
              </span>
              {text}
            </div>
          </div>
        );
      })}
    </ViewportPortal>
  );
}
```

- [ ] **Step 2: Mount it in App**

In `packages/core/src/App.tsx`:

```ts
import { CalloutOverlay } from "./CalloutOverlay";
```

A callouts-on/off toggle — add state near the other view state (~line 143):

```ts
  const [showCallouts, setShowCallouts] = useState(true);
```

Inside `<ReactFlow>`, right after `<ZonesOverlay … />`, add:

```tsx
            {showCallouts && (
              <CalloutOverlay
                nodes={graph?.nodes ?? []}
                positions={positioned}
                dimmed={selected != null || spotArea != null}
              />
            )}
```

Add a Callouts checkbox to the toolbar, right after the Focus `<label>` (before `<AreaControl … />`):

```tsx
          <label style={{ color: "#94a3b8", fontSize: 13 }}>
            <input type="checkbox" checked={showCallouts} onChange={(e) => setShowCallouts(e.target.checked)} /> Callouts
          </label>
```

- [ ] **Step 3: Typecheck + full test run**

Run: `cd packages/core && npx tsc --noEmit && npx vitest run`
Expected: PASS (existing App render tests still pass — with no gist/callout meta, the overlay renders nothing).

- [ ] **Step 4: Verify by hand (documented)**

Against a project with a model carrying `config.meta.gist: "…"` and `config.meta.callout: top`, the model shows a cyan bubble above it with a leader line into its top edge; panning/zooming moves it with the node; the Callouts checkbox hides/shows all bubbles; selecting a node fades the callouts to 0.25. (Requires the downstream consumer app; not runnable from `packages/core` in isolation.)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/CalloutOverlay.tsx packages/core/src/App.tsx
git commit -m "feat(core): callout bubbles rendering meta.gist, pinned to nodes"
```

---

### Task 4: Label filtering via ViewContext

**Files:**
- Modify: `packages/core/src/viewContext.ts`, `packages/core/src/nodes.tsx`, `packages/core/src/App.tsx`
- Test: `packages/core/src/nodes.test.tsx`

**Interfaces:**
- Produces: `ViewState.filtered: Set<string> | null` — when non-null, nodes NOT in the set render dimmed (composed with existing selector/spotlight/matched dim). Distinct from `spotlight` so label filters and area spotlight can both be active.

- [ ] **Step 1: Extend ViewState**

In `packages/core/src/viewContext.ts`, add to the interface (after `spotlight`):

```ts
  /** When set (a label filter is active), nodes NOT in this set render dimmed. */
  filtered: Set<string> | null;
```

and to the default value:

```ts
  filtered: null,
```

- [ ] **Step 2: Write the failing test**

In `packages/core/src/nodes.test.tsx`, add:

```tsx
it("dims a node not in the label-filter set", () => {
  const view = {
    selected: null, active: null, up: new Set<string>(), down: new Set<string>(),
    matched: null, search: "", spotlight: null, filtered: new Set<string>(["keep"]),
  };
  const { container } = render(
    <ViewContext.Provider value={view}>
      <DagNode id="other" data={{ label: "other", layer: "model", materialized: "", testCount: 0 }} />
    </ViewContext.Provider>,
  );
  expect((container.firstElementChild as HTMLElement).style.opacity).toBe("0.18");
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd packages/core && npx vitest run src/nodes.test.tsx`
Expected: FAIL — `filtered` not yet read; `other` renders at opacity `"1"`.

- [ ] **Step 4: Read `filtered` in DagNode**

In `packages/core/src/nodes.tsx`, update the `dim` computation to also honor `filtered`:

```ts
  const spotlit = view.spotlight == null || view.spotlight.has(id);
  const inFilter = view.filtered == null || view.filtered.has(id);
  const dim = active ? false
    : hasSel ? !inLineage
    : (view.matched != null && !view.matched.has(id)) || !spotlit || !inFilter;
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd packages/core && npx vitest run src/nodes.test.tsx`
Expected: PASS (new + existing).

- [ ] **Step 6: Wire label filter state into App**

In `packages/core/src/App.tsx`, add label-filter state near the other view state (~line 143):

```ts
  const [labelFilter, setLabelFilter] = useState<Set<string>>(new Set());
```

Compute the filtered set (nodes having at least one selected label) before the `view` memo (near the `spotlight` memo ~line 302):

```ts
  const filtered = useMemo(() => {
    if (!graph || labelFilter.size === 0) return null;
    return new Set(
      graph.nodes.filter((n) => nodeLabels(n).some((l) => labelFilter.has(l))).map((n) => n.id),
    );
  }, [graph, labelFilter]);
```

Add `filtered,` to the `view` memo object and `filtered` to its dependency array.

- [ ] **Step 7: Typecheck + full test run**

Run: `cd packages/core && npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/viewContext.ts packages/core/src/nodes.tsx packages/core/src/nodes.test.tsx packages/core/src/App.tsx
git commit -m "feat(core): dim non-matching nodes when a label filter is active"
```

---

### Task 5: Sidecar color write + label filter bar

**Files:**
- Modify: `packages/core/src/annotations.ts`
- Test: `packages/core/src/annotations.test.ts`
- Create: `packages/core/src/LabelBar.tsx`
- Modify: `packages/core/src/App.tsx`

**Interfaces:**
- Consumes: `type Style` (Task 1), `labelFilter`/`setLabelFilter` (Task 4), `labelStyles`/`allLabels` (Task 1), `annotations`/`setAnnotations` (Plan 1), `invoke` (bridge).
- Produces:
  - `setSidecarColor(existingText: string | null, kind: "areas" | "labels", key: string, color: string): string`
  - `LabelBar` component:
    ```ts
    interface LabelBarProps {
      labels: string[];
      styles: Map<string, Style>;
      filter: Set<string>;
      onToggle: (label: string) => void;
      onColor: (label: string, color: string) => void;
    }
    ```

- [ ] **Step 1: Write the failing sidecar-write test**

In `packages/core/src/annotations.test.ts`, add:

```ts
import { parse } from "yaml"; // already imported in this file — reuse
// add:
import { setSidecarColor } from "./annotations";

describe("setSidecarColor", () => {
  it("sets a color on an existing entry, preserving siblings + comments", () => {
    const src = [
      "labels:",
      "  core: { name: \"Core\", color: \"#ef4444\" }  # important ones",
      "  pii:  { name: \"PII\", color: \"#f59e0b\" }",
    ].join("\n");
    const out = setSidecarColor(src, "labels", "core", "#123456");
    expect(out).toContain("# important ones");
    const doc = parse(out);
    expect(doc.labels.core.color).toBe("#123456");
    expect(doc.labels.core.name).toBe("Core");    // name untouched
    expect(doc.labels.pii.color).toBe("#f59e0b");  // sibling untouched
  });

  it("creates the entry (and section) when absent, seeding an empty doc", () => {
    const out = setSidecarColor(null, "areas", "order_ledger", "#8b5cf6");
    const doc = parse(out);
    expect(doc.areas.order_ledger.color).toBe("#8b5cf6");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && npx vitest run src/annotations.test.ts`
Expected: FAIL — `setSidecarColor` is not exported.

- [ ] **Step 3: Implement `setSidecarColor`**

In `packages/core/src/annotations.ts`, add the import and function:

```ts
import { parse, parseDocument } from "yaml"; // widen the existing `import { parse } from "yaml";`
```

```ts
/** Set `<kind>.<key>.color` in the style sidecar, preserving comments and
 * formatting of everything else (live-document edit, like yamlEdit). Seeds an
 * empty `areas: {}\nlabels: {}` doc when the file does not exist yet. */
export function setSidecarColor(
  existingText: string | null, kind: "areas" | "labels", key: string, color: string,
): string {
  const base = existingText && existingText.trim() ? existingText : "areas: {}\nlabels: {}\n";
  const doc = parseDocument(base);
  doc.setIn([kind, key, "color"], color);
  return doc.toString({ lineWidth: 0 });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/core && npx vitest run src/annotations.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement `LabelBar.tsx`**

```tsx
import { type Style } from "./styles";

interface LabelBarProps {
  labels: string[];
  styles: Map<string, Style>;
  filter: Set<string>;
  onToggle: (label: string) => void;
  onColor: (label: string, color: string) => void;
}

/** Filter chips, one per label: a color swatch (opens a native color picker
 * that writes the sidecar) + the label name (click toggles the filter).
 * Renders nothing when there are no labels. */
export function LabelBar(p: LabelBarProps) {
  if (!p.labels.length) return null;
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      {p.labels.map((label) => {
        const st = p.styles.get(label) ?? { name: label, color: "#64748b" };
        const on = p.filter.has(label);
        return (
          <span
            key={label}
            style={{
              display: "inline-flex", alignItems: "center", gap: 7, padding: "5px 11px",
              borderRadius: 20, border: `1px solid ${on ? "#3b82f6" : "#334155"}`,
              background: on ? "#16233d" : "#111827", fontSize: 12, color: "#e5e7eb",
            }}
          >
            <label
              style={{ width: 14, height: 14, borderRadius: 4, background: st.color, cursor: "pointer",
                position: "relative", flex: "none", boxShadow: "0 0 0 1px rgba(0,0,0,0.4)" }}
              title={`Recolor ${st.name}`}
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="color" value={st.color}
                onChange={(e) => p.onColor(label, e.target.value)}
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer", border: 0, padding: 0 }}
              />
            </label>
            <button
              onClick={() => p.onToggle(label)}
              aria-pressed={on}
              style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", font: "inherit", padding: 0 }}
            >
              {st.name}
            </button>
          </span>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 6: Wire LabelBar into App**

In `packages/core/src/App.tsx`:

```ts
import { LabelBar } from "./LabelBar";
import { setSidecarColor } from "./annotations"; // add to the existing annotations import
```

(Combine with the existing `import { parseAnnotations, SIDECAR_PATH, EMPTY_ANNOTATIONS, type Annotations } from "./annotations";` — add `setSidecarColor`.)

Add the color-write handler and filter-toggle near the other handlers (after the `onSparkle`/save handlers, ~line 260):

```ts
  const onToggleLabel = (label: string) =>
    setLabelFilter((prev) => {
      const next = new Set(prev);
      next.has(label) ? next.delete(label) : next.add(label);
      return next;
    });

  const onLabelColor = async (label: string, color: string) => {
    // Optimistic: update in-memory styles immediately, then persist the sidecar.
    setAnnotations((a) => ({
      ...a,
      labels: { ...a.labels, [label]: { name: a.labels[label]?.name ?? label, color } },
    }));
    try {
      const existing = await invoke<string | null>("fs.readText", { path: SIDECAR_PATH });
      const text = setSidecarColor(existing, "labels", label, color);
      await invoke<boolean>("fs.writeText", { path: SIDECAR_PATH, text });
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };
```

Mount `LabelBar` in the toolbar after `<AreaControl … />`:

```tsx
          <LabelBar
            labels={allLabels}
            styles={labelStyles}
            filter={labelFilter}
            onToggle={onToggleLabel}
            onColor={(l, c) => void onLabelColor(l, c)}
          />
```

- [ ] **Step 7: Typecheck + full test run**

Run: `cd packages/core && npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 8: Verify by hand (documented)**

Against a project with `config.meta.labels: [core]` on a model and a `lineage.yml` `labels: { core: { label: "Core", color: "#ef4444" } }`: a red "Core" chip appears; clicking it dims non-core nodes; opening its swatch and picking a new color recolors both the chip and the node stripe, and rewrites the sidecar's `core.color` while preserving other entries/comments. (Requires the downstream consumer app.)

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/annotations.ts packages/core/src/annotations.test.ts packages/core/src/LabelBar.tsx packages/core/src/App.tsx
git commit -m "feat(core): label filter bar with sidecar-persisted color pickers"
```

---

## Self-Review

**Spec coverage (Plan 2 scope):**
- Callout = `meta.gist` rendered on the node, gated by `meta.callout`, node-anchored, flow-space — Task 3. ✓
- Callouts on/off toggle + fade during selection/filter — Task 3. ✓
- Label = `meta.labels` (list) → colored node stripes — Task 2. ✓
- Label filter chips (dim non-matching) — Tasks 4, 5. ✓
- Custom label colors via picker, persisted to the sidecar (comment-preserving), optimistic UI — Task 5. ✓
- Style-resolution refactor removing the Plan-1 fallback-color divergence + stale comment — Task 1. ✓
- Deferred (correctly absent): favorites + unified filter bar (Plan 3), freehand drawing (Plan 4), canvas authoring / `config.meta` writes (Phase 2). Callouts do not track hand-dragged nodes (documented limitation, same as zones — resolve when drag-tracking is added).

**Placeholder scan:** No TBD/TODO; every code step carries complete code; every command has an expected result.

**Type consistency:** `Style` defined in `styles.ts`, imported by `ZonesOverlay`/`AreaControl`/`LabelBar`/App; `ViewState` gains `spotlight` (Plan 1) and `filtered` (Task 4) — both read in `nodes.tsx`; `DagNodeData.labelColors?` set in `buildNodes`, read in `DagNode`; `nodeLabels` added in `zones.ts` (Task 1), used in App + tested in Task 2; `setSidecarColor` signature matches its App call site. The `nodeBuildKey` composite (Task 2) replaces the `positioned`-only base and is used consistently in the reset check and `rfNodes`.

**Cross-task ordering note:** `nodeLabels` is introduced in Task 1 (needed by `allLabels`) and re-tested in Task 2; the `ViewState.filtered` field is used by a Task 2 test literal and formally added in Task 4 — Task 2's step notes this and says to add the field early if TypeScript requires it. Implementers running strictly in order should add `filtered: null` to `ViewState` at Task 2 if the compiler complains, which Task 4 then builds on.
