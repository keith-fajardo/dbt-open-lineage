# @dbt-open-lineage/core — Architecture

Host-agnostic React UI that renders a dbt lineage DAG (React Flow / `@xyflow/react` v12).
Two consumers embed it: the VSCode extension (`packages/vscode`) and the Mnemo `.mext`
(`packages/mext`). Core never imports a host — it reaches the host only through an injected **Bridge**.

## Module map (`src/`)

| File | Responsibility |
|---|---|
| `index.tsx` | `mountApp(el, {bridge, projectPath, initialSelector})` — injects the bridge, mounts `<App>` inside an error boundary. Re-exports `App`, `setBridge`, types. |
| `bridge.ts` | The host access surface: `invoke(cmd,args)`, `saveExport`, `openInIde`, `onContext`. `setBridge()` installs the impl; core calls the module-level wrappers. |
| `App.tsx` | The whole app: loads the graph, holds all state, runs layout, builds nodes/edges, renders toolbar + `<ReactFlow>` + overlays + the details panel. Large file. |
| `graphTypes.ts` | `Graph` = `{nodes: GraphNode[], edges: GraphEdge[]}`. `GraphNode` carries `id,name,resource_type,layer,path,description` + optional `tags,materialized,meta,tests,patch_path`. |
| `layout.ts` | `layoutGraph(graph) -> Map<id,{x,y}>` (dagre, LR, columns for source/seed/staging). Exports `NODE_W=180`, `NODE_H=44`. Positions are **top-left**. |
| `selector.ts` | `resolveSelector(graph, str) -> Set<id>` (dbt selector syntax), `focalName(str)`. |
| `nodes.tsx` | `DagNode` (the `"dag"` node type) + `DagNodeData`. Reads emphasis from `ViewContext`. `nodeTypes = { dag: DagNode }`. |
| `viewContext.ts` | `ViewState` + `ViewContext`. The channel for interaction/emphasis styling. |
| `yamlEdit.ts` | `targetYamlPath(node)`, `upsertModelDoc(text,name,desc,gist)` — comment-preserving model-`.yml` edits (writes `config.meta.gist`). |
| `zones.ts` | Subject-area geometry + node-meta accessors: `nodeAreas`, `nodeLabels`, `areaMembers`, `memberCorners`, `boundingBox`, `convexHull`, `padHull`. Pure. |
| `annotations.ts` | Style sidecar `lineage.yml`: `parseAnnotations`, `setSidecarColor`, `fallbackColor`, `SIDECAR_PATH`, `AreaStyle`/`LabelStyle` (`{name,color}`). |
| `styles.ts` | `resolveStyles(defs, keys) -> Map<key,{name,color}>` — single source of truth for area/label display styles (stable fallback-color index over the passed key list). |
| `ZonesOverlay.tsx` | Subject-area zones (box/hull) in a `ViewportPortal` (flow-space). |
| `AreaControl.tsx` | Toolbar: zone shape toggle, area-visibility dropdown, spotlight `<select>`. |
| `export.ts` | Selection export (CSV/Mermaid/SVG/PNG) via `saveExport`. |

## Data model, two layers

- **Shared / committed** (git-diffable, travels with the repo):
  - Per-model `config.meta` in the model's schema `.yml` — surfaced onto `GraphNode.meta`.
    `meta.gist` (note), `meta.callout` (placement), `meta.subject_areas` (list), `meta.labels` (list).
    Membership is authored here.
  - Style sidecar **`lineage.yml`** at project root — `areas:` / `labels:` maps of `{name, color}`.
    Display styling is authored here (block or flow YAML both parse).
- **Personal / local** (Plan 3+): favorites in `localStorage` (`dol.personal.<projectPath>`); freehand
  drawing in-memory only.

`meta.*` reaches core because the host builds `Graph` from the dbt manifest and passes `config.meta`
through as `GraphNode.meta`. Core reads it; it does **not** write model `.yml` except via `upsertModelDoc`.

## Invariants (break these and the graph blanks or diffs churn)

1. **Never rebuild the node array mid-drag.** Nodes live in state keyed to a build key; a drag is applied
   with `applyNodeChanges` preserving every node object's identity except the dragged one. Rebuilding the
   whole array per frame re-syncs React Flow's store and blanks the graph in WKWebView. The build key is
   `{positioned, labelStyles}` — it changes on layout or label-style change, never on a drag.
2. **Interaction/emphasis styling flows through `ViewContext`, not node `data`.** Clicking/selecting/
   filtering must not produce new node objects. Exception: *static* per-node values (label stripe colors)
   may live in `data` — but they only change via a build-key change (invariant 1), never per interaction.
3. **Layout runs once per (visible) graph.** Typing a selector just dims (unless Focus filters the
   subgraph and re-lays it out). Overlays read the `positioned` map, so they align with node positions.
   (Known limitation: overlays read layout positions, not live hand-dragged positions — a dragged node's
   zone/callout lags until the next relayout.)
4. **Flow-space overlays use `ViewportPortal`** so they pan/zoom with the graph. Positions are top-left,
   node 180×44; anchor to node positions, never to screen coordinates. **RELAXED in Column Lineage mode:**
   node width/height vary per node via a `nodeSizes` map fed to `layoutGraph`; `layout.ts` and the image
   export read per-node sizes (falling back to 180×44 when the map is empty, so normal mode is byte-identical).
   Known v1 limitation: `zones.ts` `memberCorners` hulls and `CalloutOverlay` anchors still assume 180×44,
   so a subject-area zone or callout drawn over a grown column-mode node is slightly misplaced — this mirrors
   the existing "overlays read layout positions, not live drags" caveat and is accepted for v1.

   **SUPERSEDED (2026-07-15) — column selection now relayouts in Column Lineage mode.** The original
   column-lineage design carried over "selecting a column costs ZERO relayout" (an overlay-style invariant
   from zones/callouts): `nodeSizes` was computed from a static *picked-columns* set only, deliberately
   ignoring the live trace, so an auto-revealed row rendered taller than its dagre-reserved slot. In practice
   this caused real overlap (a multi-column derivation reveals 5–10+ rows that collided with neighbouring
   nodes) AND made trace edges appear to converge at the node *centre* rather than the traced row — the
   node's true DOM height exceeded its reserved size, so React Flow never measured a `handleBounds` entry for
   the unreserved rows and fell back to the node centre for those handles. Picking (search dropdown) is
   removed entirely; a node is now **collapsed by default** with a per-node expand/collapse chevron, and its
   rendered rows are: expanded → the full catalog, collapsed → only the columns on the live trace. Because a
   collapsed node's row count is a function of the trace, `nodeSizes` now depends on `columnTrace`, so
   **selecting/deselecting a column re-lays-out** (a single relayout, exactly like toggling callouts or the
   old picking). The reserved box therefore always matches what renders — no overlap, and every rendered
   row's `Handle` measures at a correct Y, so trace edges anchor to the row. This reversal is **scoped to
   Column Lineage mode only**: `nodeSizes` is empty otherwise → normal mode and every other overlay feature
   are byte-identical and still relayout-free on selection. It does **not** violate Invariant 1: a relayout
   is only ever driven by a CLICK (`onSelectColumn` / `onToggleExpand`), which is never concurrent with a
   node drag — a drag routes through `applyNodeChanges` and touches neither `selectedColumn` nor
   `expandedNodes`, so the build key never changes mid-drag. Expand state (`expandedNodes`) is **structural**
   (a `nodeBuildKey` + `nodeSizes` dependency, like the old `pickedColumns`), NOT a ViewContext value; only
   the `onToggleExpand` callback rides in context.
5. **YAML writes use `doc.toString({ lineWidth: 0 })`** (comment/format-preserving, no spurious re-wrap).
6. **All host I/O goes through the Bridge.** No host imports in core. Paths are project-relative.

## ViewContext dim channels (`ViewState`)

`selected`/`up`/`down` (lineage cone), `active` (open model, never dimmed), `matched` (selector dim when
Focus off), `search`, `spotlight` (area spotlight: dim non-members), `filtered` (label/personal filters:
dim non-matching). `DagNode.dim` composes them; `active` short-circuits to not-dimmed.

## Testing

vitest (`npx vitest run` from `packages/core`). Pure modules (`zones`, `annotations`, `styles`, `yamlEdit`,
`selector`, `export`) are unit-tested; `nodes`/`App` have render tests (`@testing-library/react`).
`npx tsc --noEmit` is the type gate. `tsconfig.base.json` does not error on unused locals.

## Feature: DAG annotations (in progress)

Spec + plans in `docs/superpowers/`. Plan 1 (subject-area zones) merged to master. Plan 2 (callouts +
labels) in progress on `feat/dag-annotations-p2`. Plans 3 (favorites + unified filter bar) and 4 (freehand
drawing) pending. Follow-ups tracked in `.superpowers/sdd/progress.md`.
