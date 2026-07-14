# DAG Run/Build/Test Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Run/Build/Test control to the DAG viewer (packages/core, consumed by packages/vscode and packages/mext) that executes the models currently active in the view, streams dbt's output into a real terminal, and shows a live per-node pilot light on the graph.

**Architecture:** `packages/core` owns the shared React UI (toolbar button, pilot-light bar on `DagNode`), the pure selector-building/active-set logic, and the `Bridge` contract (`onRunEvent` push channel). `packages/vscode` implements real execution via `child_process` + `vscode.Pseudoterminal` (not `vscode.Task` — the Task API only exposes an exit code, not live stdout, and this feature needs to parse `--log-format json` output line-by-line to drive the pilot light). `packages/mext` implements the webview-side bridge contract only; the Mnemo/Tauri host-side executor is out of scope for this repo (tracked as a follow-up in the sibling Mnemo repo).

**Tech Stack:** TypeScript, React 19, `@xyflow/react`, vitest + `@testing-library/react`, VSCode Extension API (`child_process`, `vscode.Pseudoterminal`).

## Global Constraints

- Follow existing file conventions: core is browser/React code; `packages/vscode/src/host/*` is Node-only extension-host code; webview-side bridge implementations (`packages/vscode/src/bridge.ts`, `packages/mext/src/bridge.ts`) run inside a sandboxed iframe/webview with no Node APIs.
- Host-only Node code that needs a *type* from core imports it via the subpath `@dbt-open-lineage/core/src/<file>` (type-only imports are erased, so this is safe even though core's package `main` is `src/index.tsx`, a React entrypoint that must never be pulled into the Node-only extension-host bundle — see the existing comment in `packages/vscode/src/host/manifest.ts`).
- No shell strings: any argv passed to `child_process` must be an array of discrete tokens (never string-concatenated into a shell command), matching the existing `compileSelectArgs`/`tokenizeCommand` convention — this is what makes model/selector names injection-safe by construction.
- All new pure logic (parsers, selector builders, set-combinators) must ship with unit tests in the same task that introduces it. No task is "done" until its tests pass.
- `npm run typecheck` (core) and the package's own `npm test` must pass before a task is considered complete.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `packages/core/src/runStatus.ts` | new | `Status` and `RunEvent` types — the shared contract between host and webview for run progress. |
| `packages/core/src/selector.ts` | modify | Add `buildSelector(nodeIds, graph)` — the reverse of `resolveSelector`: a set of node ids → a dbt selector string. |
| `packages/core/src/filters.ts` | modify | Add `computeActiveIds(...)` — combines the selector-matched and category-filtered sets into the "currently active in the DAG" scope. |
| `packages/core/src/bridge.ts` | modify | Add `onRunEvent` to the `Bridge` interface + a top-level re-export, mirroring `onContext`. |
| `packages/core/src/viewContext.ts` | modify | Add `runStatus: Map<string, Status> \| null` to `ViewState`. |
| `packages/core/src/nodes.tsx` | modify | Render the top-edge pilot-light bar on `DagNode` from `view.runStatus`. |
| `packages/core/src/App.tsx` | modify | Compute the active-model selector string, run/cancel handlers, the Run▾/Cancel toolbar control, run-status state, and the sweep-animation keyframes. |
| `packages/core/src/nodes.test.tsx` | modify | Add `runStatus: null` to existing `ViewState` literals (new required field); add pilot-light tests. |
| `packages/core/src/App.test.tsx` | modify | Add `onRunEvent` to the mocked bridge module; add Run button tests. |
| `packages/core/src/filters.test.ts` | modify | Tests for `computeActiveIds`. |
| `packages/core/src/selector.test.ts` | modify | Tests for `buildSelector`. |
| `packages/vscode/src/host/run.ts` | new | `LineBuffer`, `parseDbtLogLine`, `mapNodeStatus`, `buildRunArgs`, `startDbtRun` — the Node-side process/parsing logic, dependency-injected for testability. |
| `packages/vscode/src/host/run.test.ts` | new | Unit tests for everything in `run.ts`. |
| `packages/vscode/src/bridge.ts` | modify | Add `onRunEvent` to `vscodeBridge`. |
| `packages/vscode/src/bridge.test.ts` | new | First unit test for this file — needs `jsdom` + a dynamic-import pattern to stub `acquireVsCodeApi` before module load. |
| `packages/vscode/package.json` | modify | Add `jsdom` devDependency (needed by the new bridge test). |
| `packages/vscode/src/extension.ts` | modify | Add `"dbt.run"` / `"dbt.cancel"` message cases, wiring `startDbtRun` to a `vscode.Pseudoterminal`, with a module-level `activeRun` guard. |
| `packages/mext/src/bridge.ts` | modify | Add `onRunEvent` to `mextBridge`, with the same `ev.source === window.parent` origin check as `onContext`. |
| `packages/mext/src/bridge.test.ts` | modify | Add `onRunEvent` tests mirroring the existing `onContext` tests. |

---

### Task 1: Core — run/status types, selector-building, active-set logic, bridge contract

**Files:**
- Create: `packages/core/src/runStatus.ts`
- Modify: `packages/core/src/selector.ts`
- Modify: `packages/core/src/filters.ts`
- Modify: `packages/core/src/bridge.ts`
- Test: `packages/core/src/selector.test.ts`
- Test: `packages/core/src/filters.test.ts`

**Interfaces:**
- Produces: `Status = "running" | "success" | "failed" | "skipped"` (from `runStatus.ts`) — absence from a status map means "idle", so "idle" is not a member of the type.
- Produces: `RunEvent = { type: "status"; nodeId: string; status: Status } | { type: "done"; exitCode: number }` (from `runStatus.ts`).
- Produces: `buildSelector(nodeIds: Set<string>, graph: Graph): string` (from `selector.ts`).
- Produces: `computeActiveIds(matched: Set<string> | null, filtered: Set<string> | null): Set<string>` (from `filters.ts`) — a plain union; null contributes nothing (the caller is responsible for passing `null` for the selector channel when the selector box is blank, since a blank selector must mean an empty active set, not "everything" — see Task 3).
- Produces: `Bridge.onRunEvent(cb: (e: RunEvent) => void): () => void` (interface member) and `onRunEvent` (top-level function export from `bridge.ts`).

- [ ] **Step 1: Write the failing tests for `buildSelector`**

Append to `packages/core/src/selector.test.ts`:

```ts
import { buildSelector } from "./selector";

describe("buildSelector", () => {
  const rg: Graph = {
    nodes: [
      { id: "model.p.stg_orders", name: "stg_orders", resource_type: "model", layer: "staging", path: "", description: "" },
      { id: "seed.p.raw_countries", name: "raw_countries", resource_type: "seed", layer: "model", path: "", description: "" },
      { id: "snapshot.p.orders_snap", name: "orders_snap", resource_type: "snapshot", layer: "model", path: "", description: "" },
      { id: "source.p.raw.orders", name: "orders", resource_type: "source", layer: "source", path: "", description: "" },
      { id: "test.p.not_null_x", name: "not_null_x", resource_type: "test", layer: "model", path: "", description: "" },
    ],
    edges: [],
  };

  it("joins the names of runnable nodes (model/seed/snapshot), sorted", () => {
    const ids = new Set(["model.p.stg_orders", "seed.p.raw_countries", "snapshot.p.orders_snap"]);
    expect(buildSelector(ids, rg)).toBe("orders_snap raw_countries stg_orders");
  });

  it("excludes sources and tests even if their ids are included", () => {
    const ids = new Set(["model.p.stg_orders", "source.p.raw.orders", "test.p.not_null_x"]);
    expect(buildSelector(ids, rg)).toBe("stg_orders");
  });

  it("empty selection produces an empty string", () => {
    expect(buildSelector(new Set(), rg)).toBe("");
  });

  it("a selection with only non-runnable ids produces an empty string", () => {
    expect(buildSelector(new Set(["source.p.raw.orders"]), rg)).toBe("");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run selector.test.ts`
Expected: FAIL — `buildSelector is not a function` / import error.

- [ ] **Step 3: Implement `buildSelector`**

Append to `packages/core/src/selector.ts`:

```ts
const RUNNABLE = new Set(["model", "seed", "snapshot"]);

/** The reverse of resolveSelector: a set of node ids -> a dbt selector string
 * naming the runnable ones. dbt selector syntax matches by NAME, not the
 * manifest's unique_id, so this joins `node.name` (space = union in dbt
 * selector syntax). Sources and tests are never independently runnable —
 * sources aren't buildable and a selected model's tests come along for free
 * via `dbt test -s <models>` — so both are filtered out here. Sorted for a
 * deterministic, readable selector string. */
export function buildSelector(nodeIds: Set<string>, g: Graph): string {
  const names = new Set(
    g.nodes.filter((n) => nodeIds.has(n.id) && RUNNABLE.has(n.resource_type)).map((n) => n.name),
  );
  return [...names].sort().join(" ");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/core && npx vitest run selector.test.ts`
Expected: PASS (all `buildSelector` + existing `resolveSelector`/`focalName` tests green).

- [ ] **Step 5: Write the failing tests for `computeActiveIds`**

Append to `packages/core/src/filters.test.ts`:

```ts
import { computeActiveIds } from "./filters";

describe("computeActiveIds", () => {
  it("both channels inactive (null) -> empty set, NOT 'everything'", () => {
    // A blank selector must never fall back to "the whole graph" — the DAG
    // itself renders nothing when the selector is blank (see App.tsx), so
    // Run must have nothing to act on either.
    expect(computeActiveIds(null, null)).toEqual(new Set());
  });

  it("selector only -> the matched set, even if it's empty", () => {
    expect(computeActiveIds(new Set(["a"]), null)).toEqual(new Set(["a"]));
    expect(computeActiveIds(new Set(), null)).toEqual(new Set());
  });

  it("filter only -> the filtered set, even if it's empty", () => {
    expect(computeActiveIds(null, new Set(["b"]))).toEqual(new Set(["b"]));
    expect(computeActiveIds(null, new Set())).toEqual(new Set());
  });

  it("both active -> the UNION of the two sets", () => {
    expect(computeActiveIds(new Set(["a"]), new Set(["b"]))).toEqual(new Set(["a", "b"]));
  });

  it("both active with overlap -> no duplicate double-counting (still a Set)", () => {
    expect(computeActiveIds(new Set(["a", "b"]), new Set(["b", "c"]))).toEqual(new Set(["a", "b", "c"]));
  });
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run filters.test.ts`
Expected: FAIL — `computeActiveIds is not a function`.

- [ ] **Step 7: Implement `computeActiveIds`**

Append to `packages/core/src/filters.ts`:

```ts
/** The "currently active in the DAG" scope for the run/build/test button:
 * the union of the selector-matched and category-filtered sets. A plain
 * union — each channel contributes nothing when null. This is DELIBERATELY
 * NOT the same convention `filtered` itself uses for dimming (there, null
 * means "no restriction," i.e. everything counts). For a union, "channel
 * inactive" must mean "contributes nothing," or a blank selector would make
 * Run target the whole project even though the DAG renders nothing on
 * screen in that state. Callers must pass null for the selector channel
 * when the selector box is blank — see App.tsx. */
export function computeActiveIds(
  matched: Set<string> | null, filtered: Set<string> | null,
): Set<string> {
  const out = new Set<string>();
  if (matched) for (const id of matched) out.add(id);
  if (filtered) for (const id of filtered) out.add(id);
  return out;
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd packages/core && npx vitest run filters.test.ts`
Expected: PASS.

- [ ] **Step 9: Add the `Status`/`RunEvent` types**

Create `packages/core/src/runStatus.ts`:

```ts
/** Per-node run outcome. Absence of an id from a status map means "idle" —
 * "idle" is deliberately not a member of this type, so a caller can't
 * accidentally treat "no entry yet" and "explicitly idle" as different
 * states. */
export type Status = "running" | "success" | "failed" | "skipped";

/** Pushed from the host to the webview while a dbt run/build/test is in
 * flight. `status` events arrive as dbt's own `--log-format json` stream is
 * parsed (see packages/vscode/src/host/run.ts); exactly one `done` event
 * arrives when the underlying process exits. */
export type RunEvent =
  | { type: "status"; nodeId: string; status: Status }
  | { type: "done"; exitCode: number };
```

- [ ] **Step 10: Re-export the new types from the package barrel**

Modify `packages/core/src/index.tsx` — add after the existing `export type { Graph, GraphNode, GraphEdge } from "./graphTypes";` line:

```tsx
export type { Status, RunEvent } from "./runStatus";
```

- [ ] **Step 11: Extend the `Bridge` interface with `onRunEvent`**

Modify `packages/core/src/bridge.ts`:

```ts
/** Host access surface. The consumer (VSCode ext / Mnemo mext) supplies an
 * implementation via setBridge() before mounting; core never imports a host. */
import type { RunEvent } from "./runStatus";

export interface Bridge {
  invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T>;
  saveExport(filename: string, dataB64: string): Promise<boolean>;
  openInIde(path: string): Promise<boolean>;
  onContext(cb: (value: string) => void): () => void;
  onRunEvent(cb: (e: RunEvent) => void): () => void;
}

let active: Bridge | null = null;
export function setBridge(b: Bridge): void { active = b; }
function get(): Bridge {
  if (!active) throw new Error("dbt-open-lineage: bridge not set (call setBridge first)");
  return active;
}

export const invoke = <T>(cmd: string, args: Record<string, unknown>): Promise<T> => get().invoke<T>(cmd, args);
export const saveExport = (filename: string, dataB64: string): Promise<boolean> => get().saveExport(filename, dataB64);
export const openInIde = (path: string): Promise<boolean> => get().openInIde(path);
export const onContext = (cb: (value: string) => void): () => void => get().onContext(cb);
export const onRunEvent = (cb: (e: RunEvent) => void): (() => void) => get().onRunEvent(cb);
```

(Replace the whole file — it's short; the diff is the added import, the added interface member, and the added `onRunEvent` export at the bottom.)

- [ ] **Step 12: Typecheck**

Run: `cd packages/core && npm run typecheck`
Expected: PASS. (This will currently FAIL if any other file constructs a `Bridge` object literal missing `onRunEvent` — none do yet at this point in the plan; `App.test.tsx`'s mock is a plain object matching the module's exports, not type-checked against `Bridge`, so it's unaffected until Task 3.)

- [ ] **Step 13: Commit**

```bash
git add packages/core/src/runStatus.ts packages/core/src/selector.ts packages/core/src/selector.test.ts \
  packages/core/src/filters.ts packages/core/src/filters.test.ts packages/core/src/bridge.ts packages/core/src/index.tsx
git commit -m "feat(core): add run-status types, buildSelector, computeActiveIds, onRunEvent bridge contract"
```

---

### Task 2: Core — pilot-light bar on `DagNode`

**Files:**
- Modify: `packages/core/src/viewContext.ts`
- Modify: `packages/core/src/nodes.tsx`
- Modify: `packages/core/src/nodes.test.tsx`

**Interfaces:**
- Consumes: `Status` from `./runStatus` (Task 1).
- Produces: `ViewState.runStatus: Map<string, Status> | null` — read by `App.tsx` in Task 3 to feed live status, and by tests to assert the pilot light renders.

- [ ] **Step 1: Add `runStatus` to `ViewState`**

Modify `packages/core/src/viewContext.ts`:

```ts
import { createContext } from "react";
import type { Status } from "./runStatus";

/** Selection/emphasis state consumed by DagNode via context, NOT via node
 * data: styling changes (click a node, type a selector) then re-render the
 * node components without ever producing new node OBJECTS — during drags
 * React Flow must see stable node identities except the node being dragged,
 * or it re-syncs the whole store every frame (which breaks measurement in
 * WKWebView and blanks the graph). */
export interface ViewState {
  selected: string | null;
  /** The model whose file is OPEN in the IDE editor — the focus of the
   * pushed lineage. Rendered with a persistent emphasis so it's obvious
   * which node in the cone is the model you're looking at, independent of
   * any node you click (`selected`). null in the standalone window. */
  active: string | null;
  up: Set<string>;
  down: Set<string>;
  /** When set (focus off), nodes NOT in this set render dimmed. */
  matched: Set<string> | null;
  /** When set (an area is spotlighted), nodes NOT in this set render dimmed. */
  spotlight: Set<string> | null;
  /** When set (a label filter is active), nodes NOT in this set render dimmed. */
  filtered: Set<string> | null;
  /** Live search term (lowercased, "" = off): nodes whose name contains it
   * highlight the matching text and get an amber ring. */
  search: string;
  /** Ids the user has starred (personal, localStorage). Drives the ★ badge. */
  favorites: Set<string>;
  /** Toggle a node's favorite state (persists to localStorage). */
  onToggleFavorite: (id: string) => void;
  /** Per-node run/build/test outcome for the in-flight or most recent run.
   * null when no run has happened yet; absence of a node's id from the map
   * (with the map non-null) means that node is idle (not yet reached, or a
   * fresh run cleared prior results). Drives the top-edge pilot-light bar. */
  runStatus: Map<string, Status> | null;
}

export const ViewContext = createContext<ViewState>({
  selected: null,
  active: null,
  up: new Set(),
  down: new Set(),
  matched: null,
  spotlight: null,
  filtered: null,
  search: "",
  favorites: new Set(),
  onToggleFavorite: () => {},
  runStatus: null,
});
```

- [ ] **Step 2: Write the failing pilot-light tests**

Add to `packages/core/src/nodes.test.tsx` (add `import type { Status } from "./runStatus";` near the top imports, then append this describe block at the end of the file):

```tsx
describe("DagNode run status pilot light", () => {
  const withStatus = (status?: Status) => {
    const view: ViewState = {
      selected: null, active: null, up: new Set(), down: new Set(),
      matched: null, spotlight: null, filtered: null, search: "",
      favorites: new Set(), onToggleFavorite: () => {},
      runStatus: status ? new Map([["n", status]]) : null,
    };
    return render(
      <ViewContext.Provider value={view}>
        <DagNode id="n" data={data("n")} />
      </ViewContext.Provider>,
    );
  };

  it("shows nothing when the node has no run status", () => {
    withStatus();
    expect(screen.queryByLabelText(/run status/)).toBeNull();
  });

  it("renders an animated sweep bar while running", () => {
    withStatus("running");
    const bar = screen.getByLabelText("run status: running");
    expect(bar).toHaveAttribute("data-run-status", "running");
    expect(bar.style.animation).toContain("dol-run-sweep");
  });

  it("renders a solid green bar on success", () => {
    withStatus("success");
    expect(screen.getByLabelText("run status: success").style.background).toBe("rgb(34, 197, 94)");
  });

  it("renders a solid red bar on failure", () => {
    withStatus("failed");
    expect(screen.getByLabelText("run status: failed").style.background).toBe("rgb(239, 68, 68)");
  });

  it("renders a solid amber bar when skipped", () => {
    withStatus("skipped");
    expect(screen.getByLabelText("run status: skipped").style.background).toBe("rgb(245, 158, 11)");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run nodes.test.tsx`
Expected: FAIL — several pre-existing tests in this file now also fail to typecheck/compile (see Step 4 below), and the new pilot-light tests fail because `DagNode` renders nothing extra yet.

- [ ] **Step 4: Add `runStatus: null` to every existing `ViewState` literal in this file**

`ViewState` now has a new required field. Six existing object literals in `packages/core/src/nodes.test.tsx` need `runStatus: null` added (all currently end with `favorites: new Set..., onToggleFavorite: ...`):

In `withSearch` (search-highlight tests):
```tsx
const withSearch = (label: string, search: string) =>
  render(
    <ViewContext.Provider value={{ selected: null, active: null, up: new Set(), down: new Set(), matched: null, spotlight: null, filtered: null, search, favorites: new Set(), onToggleFavorite: () => {}, runStatus: null }}>
      <DagNode id="n1" data={data(label)} />
    </ViewContext.Provider>,
  );
```

In `withView` (open-model emphasis tests):
```tsx
const withView = (id: string, view: Partial<ViewState>) =>
  render(
    <ViewContext.Provider
      value={{ selected: null, active: null, up: new Set(), down: new Set(), matched: null, spotlight: null, filtered: null, search: "", favorites: new Set(), onToggleFavorite: () => {}, runStatus: null, ...view }}
    >
      <DagNode id={id} data={data("dim_date")} />
    </ViewContext.Provider>,
  );
```

In "DagNode label stripes" → "renders a left-edge stripe per label color":
```tsx
const view = {
  selected: null, active: null, up: new Set<string>(), down: new Set<string>(),
  matched: null, search: "", spotlight: null, filtered: null,
  favorites: new Set<string>(), onToggleFavorite: () => {}, runStatus: null,
};
```

In "DagNode spotlight dimming" → "dims a node that is not in the spotlight set":
```tsx
const view = {
  selected: null, active: null, up: new Set<string>(), down: new Set<string>(),
  matched: null, search: "", spotlight: new Set<string>(["keepme"]), filtered: null,
  favorites: new Set<string>(), onToggleFavorite: () => {}, runStatus: null,
};
```

In "DagNode label-filter dimming" → "dims a node not in the label-filter set":
```tsx
const view = {
  selected: null, active: null, up: new Set<string>(), down: new Set<string>(),
  matched: null, search: "", spotlight: null, filtered: new Set<string>(["keep"]),
  favorites: new Set<string>(), onToggleFavorite: () => {}, runStatus: null,
};
```

In "DagNode favorites" → "renders a filled ★ for a favorited node and toggles on click":
```tsx
const view = {
  selected: null, active: null, up: new Set<string>(), down: new Set<string>(),
  matched: null, spotlight: null, filtered: null, search: "",
  favorites: new Set<string>(["n"]), onToggleFavorite: (id: string) => toggled.push(id), runStatus: null,
};
```

(The `isDimmed` tests further down use `DimView`, a `Pick<...>` that does not include `runStatus` — those are unaffected.)

- [ ] **Step 5: Render the pilot-light bar in `DagNode`**

Modify `packages/core/src/nodes.tsx` — add the render block right after the label-stripes block (after the `{data.labelColors && ...}` block, before the `{/* Corner tag marking THE open model ... */}` block):

```tsx
{(() => {
  const status = view.runStatus?.get(id);
  if (!status) return null;
  const solid = status === "success" ? "#22c55e" : status === "failed" ? "#ef4444" : status === "skipped" ? "#f59e0b" : undefined;
  return (
    <div
      aria-label={`run status: ${status}`}
      data-run-status={status}
      style={{
        position: "absolute", left: 6, right: 6, top: -2, height: 3, borderRadius: 2,
        background: solid,
        // "running" has no solid color: an animated sweep instead, so a
        // long-running node reads as "in progress" rather than "stuck".
        backgroundImage: status === "running" ? "linear-gradient(90deg, transparent, #93c5fd, transparent)" : undefined,
        backgroundSize: status === "running" ? "60px 100%" : undefined,
        animation: status === "running" ? "dol-run-sweep 1.2s linear infinite" : undefined,
      }}
    />
  );
})()}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/core && npx vitest run nodes.test.tsx`
Expected: PASS (all pre-existing + new pilot-light tests green). Note: the sweep-animation CSS `@keyframes dol-run-sweep` doesn't need to exist for this test to pass — jsdom doesn't validate keyframe names, it just stores the string; the keyframes themselves are added to `App.tsx` in Task 3 so they actually animate in a real browser/webview.

- [ ] **Step 7: Typecheck**

Run: `cd packages/core && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/viewContext.ts packages/core/src/nodes.tsx packages/core/src/nodes.test.tsx
git commit -m "feat(core): render a per-node run-status pilot light on the DAG"
```

---

### Task 3: Core — App.tsx wiring (active selector, run/cancel, toolbar, keyframes)

**Files:**
- Modify: `packages/core/src/App.tsx`
- Modify: `packages/core/src/App.test.tsx`

**Interfaces:**
- Consumes: `buildSelector`, `computeActiveIds` (Task 1); `onRunEvent`, `invoke` (Task 1's bridge); `ViewState.runStatus` (Task 2).
- Produces: nothing new consumed by later tasks — this is the last core task before the host tasks, which only need the `Bridge` interface (already final after Task 1) and the `"dbt.run"`/`"dbt.cancel"` command names + `{command, selector}` args shape used below.

- [ ] **Step 1: Update the bridge mock in `App.test.tsx`**

Modify `packages/core/src/App.test.tsx` — the `vi.mock("./bridge", ...)` factory needs an `onRunEvent` export or every existing test breaks (`App.tsx` will call it unconditionally once wired). Change:

```ts
let contextCb: ((v: string) => void) | null = null;
let manifestGraph: Graph = g;
```

to:

```ts
let contextCb: ((v: string) => void) | null = null;
let runEventCb: ((e: import("./runStatus").RunEvent) => void) | null = null;
let manifestGraph: Graph = g;
```

and change:

```ts
vi.mock("./bridge", () => ({
  invoke: (...a: unknown[]) => invokeMock(...(a as [string, Record<string, unknown>])),
  onContext: (cb: (v: string) => void) => { contextCb = cb; return () => { contextCb = null; }; },
  saveExport: (...a: unknown[]) => saveExport(...(a as [])),
  openInIde: (...a: unknown[]) => openInIde(...(a as [])),
}));
```

to:

```ts
vi.mock("./bridge", () => ({
  invoke: (...a: unknown[]) => invokeMock(...(a as [string, Record<string, unknown>])),
  onContext: (cb: (v: string) => void) => { contextCb = cb; return () => { contextCb = null; }; },
  onRunEvent: (cb: (e: import("./runStatus").RunEvent) => void) => { runEventCb = cb; return () => { runEventCb = null; }; },
  saveExport: (...a: unknown[]) => saveExport(...(a as [])),
  openInIde: (...a: unknown[]) => openInIde(...(a as [])),
}));
```

Also add `runEventCb = null;` to the existing `beforeEach(() => { layoutSpy.mockClear(); invokeMock.mockClear(); manifestGraph = g; lastCalloutHeights = undefined; });` (append `runEventCb = null;`).

- [ ] **Step 2: Write the failing Run-button tests**

Append to `packages/core/src/App.test.tsx`:

```tsx
describe("run/build/test button", () => {
  it("is disabled with no runnable models in view (blank selector)", async () => {
    render(<App projectPath="/proj" debounceMs={0} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("dbt.manifest", expect.anything()));
    expect(screen.getByText("▶ Run")).toBeDisabled();
  });

  it("invokes dbt.run with the union of matched+filtered active ids as a selector, on click", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("dbt.run", { command: "run", selector: "a b c d" }),
    );
  });

  it("dropdown offers Build and Test, each invoking dbt.run with that command", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByLabelText("run command menu"));
    fireEvent.click(screen.getByRole("menuitem", { name: "build" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("dbt.run", { command: "build", selector: "a b c d" }),
    );
  });

  it("shows Cancel instead of Run while a run is active, and invokes dbt.cancel on click", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() => expect(screen.getByText("■ Cancel")).toBeInTheDocument());
    fireEvent.click(screen.getByText("■ Cancel"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("dbt.cancel", {}));
  });

  it("run-status events from the bridge drive the pilot light, and a done event restores the Run button", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() => expect(runEventCb).not.toBeNull());
    act(() => runEventCb!({ type: "status", nodeId: "a", status: "success" }));
    await waitFor(() => expect(screen.getByLabelText("run status: success")).toBeInTheDocument());
    act(() => runEventCb!({ type: "done", exitCode: 0 }));
    await waitFor(() => expect(screen.getByText("▶ Run")).toBeInTheDocument());
  });

  it("a nonzero exit code on done surfaces a run-failed error", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() => expect(runEventCb).not.toBeNull());
    act(() => runEventCb!({ type: "done", exitCode: 1 }));
    await waitFor(() => expect(screen.getByText(/run failed/)).toBeInTheDocument());
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run App.test.tsx`
Expected: FAIL — no "▶ Run" text exists yet.

- [ ] **Step 4: Add imports**

Modify `packages/core/src/App.tsx` — change:

```tsx
import { invoke, onContext, saveExport, openInIde } from "./bridge";
import { layoutGraph } from "./layout";
import { resolveSelector, focalName } from "./selector";
```

to:

```tsx
import { invoke, onContext, onRunEvent, saveExport, openInIde } from "./bridge";
import { layoutGraph } from "./layout";
import { resolveSelector, focalName, buildSelector } from "./selector";
import type { Status, RunEvent } from "./runStatus";
```

and change:

```tsx
import { computeFiltered } from "./filters";
```

to:

```tsx
import { computeFiltered, computeActiveIds } from "./filters";
```

- [ ] **Step 5: Add active-set + run state**

Modify `packages/core/src/App.tsx` — right after the `filtered` memo (currently):

```tsx
  const filtered = useMemo(
    () => (graph ? computeFiltered(graph.nodes, { favActive, favorites, areas: areaFilter, labels: labelFilter, tags: tagFilter }) : null),
    [graph, favActive, favorites, areaFilter, labelFilter, tagFilter],
  );
```

add:

```tsx
  // The run/build/test button's scope: the union of the selector-matched and
  // category-filtered sets — but ONLY once the selector box is non-blank.
  // A blank selector already blanks the whole DAG (see `visibleGraph` above,
  // which returns {nodes:[],edges:[]} whenever `!selector.trim()`, filters
  // notwithstanding) — so Run must see nothing active in that state too,
  // rather than falling back to "the whole project."
  const activeIds = useMemo(
    () => (selector.trim() ? computeActiveIds(matched, filtered) : new Set<string>()),
    [selector, matched, filtered],
  );
  const runSelector = useMemo(() => (graph ? buildSelector(activeIds, graph) : ""), [graph, activeIds]);

  const [runMenu, setRunMenu] = useState(false);
  const [runActive, setRunActive] = useState<"run" | "build" | "test" | null>(null);
  const [runStatus, setRunStatus] = useState<Map<string, Status> | null>(null);
  const [runErr, setRunErr] = useState<string | null>(null);

  useEffect(() => onRunEvent((e: RunEvent) => {
    if (e.type === "status") {
      setRunStatus((prev) => {
        const next = new Map(prev ?? []);
        next.set(e.nodeId, e.status);
        return next;
      });
    } else {
      setRunActive(null);
      if (e.exitCode !== 0) setRunErr(`run failed (exit ${e.exitCode})`);
    }
  }), []);

  const onRun = async (command: "run" | "build" | "test") => {
    setRunMenu(false);
    if (!runSelector) return;
    setRunErr(null);
    setRunStatus(new Map());
    setRunActive(command);
    try {
      await invoke<boolean>("dbt.run", { command, selector: runSelector });
    } catch (e) {
      setRunActive(null);
      setRunErr(String((e as Error).message ?? e));
    }
  };

  const onCancelRun = async () => {
    try { await invoke<boolean>("dbt.cancel", {}); }
    catch (e) { setRunErr(String((e as Error).message ?? e)); }
  };
```

- [ ] **Step 6: Wire `runStatus` into the `view` memo**

Modify `packages/core/src/App.tsx` — change:

```tsx
  const view: ViewState = useMemo(() => ({
    selected,
    active: activeId,
    up: lineage.up,
    down: lineage.down,
    // With focus OFF, un-matched nodes dim; with focus ON they're filtered out.
    matched: focus ? null : matched,
    // Subject areas now filter (folded into `filtered`), so nothing drives the
    // separate spotlight channel — it stays a valid but unused dim path.
    spotlight: null,
    filtered,
    search: searchQ,
    favorites,
    onToggleFavorite,
  }), [selected, activeId, lineage, focus, matched, filtered, searchQ, favorites, onToggleFavorite]);
```

to:

```tsx
  const view: ViewState = useMemo(() => ({
    selected,
    active: activeId,
    up: lineage.up,
    down: lineage.down,
    // With focus OFF, un-matched nodes dim; with focus ON they're filtered out.
    matched: focus ? null : matched,
    // Subject areas now filter (folded into `filtered`), so nothing drives the
    // separate spotlight channel — it stays a valid but unused dim path.
    spotlight: null,
    filtered,
    search: searchQ,
    favorites,
    onToggleFavorite,
    runStatus,
  }), [selected, activeId, lineage, focus, matched, filtered, searchQ, favorites, onToggleFavorite, runStatus]);
```

- [ ] **Step 7: Add the toolbar control**

Modify `packages/core/src/App.tsx` — insert right after the Export `</div>` that closes the `position: "relative"` wrapper (immediately before Row 0's closing `</div>`, i.e. right after the block ending `)}\n            </div>\n          </div>` around the Export dropdown). Add this new `<div style={{ position: "relative" }}>...</div>` block as a sibling right after the Export control's wrapping `<div style={{ position: "relative" }}>...</div>`:

```tsx
            <div style={{ position: "relative" }}>
              {runActive ? (
                <button
                  onClick={() => void onCancelRun()}
                  style={{
                    padding: "6px 10px", borderRadius: 7, border: "1px solid #f87171",
                    background: "#1e293b", color: "#f87171", cursor: "pointer", fontFamily: "inherit", fontSize: 12,
                  }}
                >■ Cancel</button>
              ) : (
                <div style={{ display: "flex", borderRadius: 7, border: "1px solid #334155", overflow: "hidden" }}>
                  <button
                    disabled={!runSelector}
                    title={runSelector ? undefined : "no runnable models in current view"}
                    onClick={() => void onRun("run")}
                    style={{
                      padding: "6px 10px", border: "none", borderRight: "1px solid #334155",
                      background: "#111827", color: runSelector ? "#4ade80" : "#475569",
                      cursor: runSelector ? "pointer" : "default", fontFamily: "inherit", fontSize: 12, fontWeight: 600,
                    }}
                  >▶ Run</button>
                  <button
                    aria-label="run command menu"
                    aria-haspopup="menu"
                    aria-expanded={runMenu}
                    onClick={() => setRunMenu((v) => !v)}
                    style={{
                      padding: "6px 8px", border: "none", background: "#111827",
                      color: "#e5e7eb", cursor: "pointer", fontFamily: "inherit", fontSize: 12,
                    }}
                  >▾</button>
                </div>
              )}
              {runMenu && !runActive && (
                <div
                  role="menu"
                  style={{
                    position: "absolute", right: 0, top: "110%", zIndex: 20, minWidth: 110,
                    background: "#111827", border: "1px solid #334155", borderRadius: 8, overflow: "hidden",
                    boxShadow: "0 16px 34px rgba(0,0,0,0.5)",
                  }}
                >
                  {(["run", "build", "test"] as const).map((cmd) => (
                    <button
                      key={cmd}
                      role="menuitem"
                      disabled={!runSelector}
                      onClick={() => void onRun(cmd)}
                      style={{
                        display: "block", width: "100%", textAlign: "left", padding: "7px 12px",
                        background: "none", border: "none", color: runSelector ? "#e5e7eb" : "#475569",
                        cursor: runSelector ? "pointer" : "default", fontFamily: "inherit", fontSize: 13, textTransform: "capitalize",
                      }}
                    >{cmd}</button>
                  ))}
                </div>
              )}
            </div>
```

- [ ] **Step 8: Surface run errors and add the sweep keyframes**

Modify `packages/core/src/App.tsx` — change:

```tsx
        {error && <div style={{ color: "#fca5a5", padding: 8 }}>{error}</div>}
        {exportErr && <div style={{ color: "#fca5a5", padding: 8 }}>export failed: {exportErr}</div>}
```

to:

```tsx
        {error && <div style={{ color: "#fca5a5", padding: 8 }}>{error}</div>}
        {exportErr && <div style={{ color: "#fca5a5", padding: 8 }}>export failed: {exportErr}</div>}
        {runErr && <div style={{ color: "#fca5a5", padding: 8 }}>run failed: {runErr}</div>}
```

Then wrap the component's `return (...)` in a fragment carrying the keyframes (they must not become a flex item inside the `width:"100vw"` wrapper div). Change:

```tsx
  return (
    <div style={{ width: "100vw", height: "100vh", display: "flex", background: "#0b1220", fontFamily: FONT_UI }}>
```

to:

```tsx
  return (
    <>
      <style>{"@keyframes dol-run-sweep{0%{background-position:-60px 0}100%{background-position:240px 0}}"}</style>
      <div style={{ width: "100vw", height: "100vh", display: "flex", background: "#0b1220", fontFamily: FONT_UI }}>
```

...and change the component's final closing tags. Currently:

```tsx
        </aside>
      )}
    </div>
  );
}
```

to:

```tsx
        </aside>
      )}
      </div>
    </>
  );
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd packages/core && npx vitest run App.test.tsx nodes.test.tsx selector.test.ts filters.test.ts`
Expected: PASS — full core suite green.

- [ ] **Step 10: Run the full core suite + typecheck**

Run: `cd packages/core && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/core/src/App.tsx packages/core/src/App.test.tsx
git commit -m "feat(core): add the Run/Build/Test toolbar control and wire live run status"
```

---

### Task 4: VSCode host — dbt process execution + json-log parsing

**Files:**
- Create: `packages/vscode/src/host/run.ts`
- Test: `packages/vscode/src/host/run.test.ts`

**Interfaces:**
- Consumes: `RunEvent`, `Status` types via `import type { RunEvent, Status } from "@dbt-open-lineage/core/src/runStatus";` (Task 1). Type-only import — erased at compile time, no bundler risk (same rationale as the existing `host/manifest.ts` comment, which applies to *value* imports; a `import type` never reaches the bundle at all).
- Consumes: `resolveBin` from `./gist` (existing, Task-independent) — reused to avoid the exact PATH/ENOENT bug class `resolveBin` was already written to fix for the `claude` gist command (a GUI-launched VSCode inherits a minimal PATH lacking Homebrew/pyenv/etc; `child_process.spawn`, unlike `vscode.Task`'s `ShellExecution`, does NOT go through a login shell, so it needs the same fix).
- Produces: `buildRunArgs(command, selector): string[]`, `parseDbtLogLine(line): { event: RunEvent | null; display: string }`, `mapNodeStatus(raw): Status | null`, `LineBuffer` class, `startDbtRun(projectRoot, command, selector, callbacks, deps?): RunController` — all consumed by `extension.ts` in Task 6.

- [ ] **Step 1: Write the failing tests**

Create `packages/vscode/src/host/run.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import { LineBuffer, parseDbtLogLine, mapNodeStatus, buildRunArgs, startDbtRun } from "./run";

describe("LineBuffer", () => {
  it("splits complete lines and carries a partial one across pushes", () => {
    const b = new LineBuffer();
    expect(b.push("a\nb\nc")).toEqual(["a", "b"]);
    expect(b.push("d\ne\n")).toEqual(["cd", "e"]);
    expect(b.flush()).toEqual([]);
  });

  it("flush returns a trailing partial line with no newline", () => {
    const b = new LineBuffer();
    b.push("partial");
    expect(b.flush()).toEqual(["partial"]);
    expect(b.flush()).toEqual([]); // draining is a one-shot
  });
});

describe("mapNodeStatus", () => {
  it("maps dbt's node_status values onto our 4-state Status", () => {
    expect(mapNodeStatus("started")).toBe("running");
    expect(mapNodeStatus("success")).toBe("success");
    expect(mapNodeStatus("passed")).toBe("success");
    expect(mapNodeStatus("pass")).toBe("success");
    expect(mapNodeStatus("reused")).toBe("success");
    expect(mapNodeStatus("error")).toBe("failed");
    expect(mapNodeStatus("failed")).toBe("failed");
    expect(mapNodeStatus("fail")).toBe("failed");
    expect(mapNodeStatus("skipped")).toBe("skipped");
  });

  it("unknown statuses map to null (no status event, but the line still displays)", () => {
    expect(mapNodeStatus("warn")).toBeNull();
    expect(mapNodeStatus("")).toBeNull();
  });
});

describe("parseDbtLogLine", () => {
  const nodeLine = (msg: string, node_status: string) => JSON.stringify({
    code: "Q011", level: "info", log_version: 3, msg,
    node_info: { unique_id: "model.proj.stg_orders", node_name: "stg_orders", node_status, resource_type: "model" },
    type: "log_line",
  });

  it("extracts the human-readable msg for display, and a status event from node_info", () => {
    const { event, display } = parseDbtLogLine(nodeLine("1 of 3 START sql table model main.stg_orders", "started"));
    expect(display).toBe("1 of 3 START sql table model main.stg_orders");
    expect(event).toEqual({ type: "status", nodeId: "model.proj.stg_orders", status: "running" });
  });

  it("finish line maps to success", () => {
    const { event } = parseDbtLogLine(nodeLine("1 of 3 OK created sql table model main.stg_orders", "success"));
    expect(event).toEqual({ type: "status", nodeId: "model.proj.stg_orders", status: "success" });
  });

  it("a line with no node_info displays but produces no status event", () => {
    const { event, display } = parseDbtLogLine(JSON.stringify({ msg: "Found 3 models", level: "info", type: "log_line" }));
    expect(display).toBe("Found 3 models");
    expect(event).toBeNull();
  });

  it("a malformed (non-JSON) line displays raw and produces no event, without throwing", () => {
    const { event, display } = parseDbtLogLine("not json at all {{{");
    expect(display).toBe("not json at all {{{");
    expect(event).toBeNull();
  });

  it("an empty line displays as-is with no event", () => {
    expect(parseDbtLogLine("")).toEqual({ event: null, display: "" });
  });
});

describe("buildRunArgs", () => {
  it("builds run/build/test argv with --log-format json", () => {
    expect(buildRunArgs("run", "stg_orders int_orders")).toEqual(
      ["run", "--select", "stg_orders int_orders", "--log-format", "json"],
    );
    expect(buildRunArgs("build", "x")).toEqual(["build", "--select", "x", "--log-format", "json"]);
    expect(buildRunArgs("test", "x")).toEqual(["test", "--select", "x", "--log-format", "json"]);
  });
});

// A minimal fake ChildProcess: an EventEmitter with stdout/stderr sub-emitters
// and a pid, enough to drive startDbtRun's wiring without a real process.
function fakeChild() {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = 4242;
  return proc;
}

describe("startDbtRun", () => {
  it("parses stdout lines into onWrite/onEvent calls, then emits done on close", () => {
    const proc = fakeChild();
    const spawnSpy = vi.fn(() => proc);
    const written: string[] = [];
    const events: unknown[] = [];
    startDbtRun("/proj", "run", "stg_orders", { onWrite: (t) => written.push(t), onEvent: (e) => events.push(e) }, { spawn: spawnSpy });

    expect(spawnSpy).toHaveBeenCalledWith("/proj", ["run", "--select", "stg_orders", "--log-format", "json"]);

    const line = JSON.stringify({ msg: "1 of 1 START ...", node_info: { unique_id: "model.proj.stg_orders", node_status: "started" } });
    proc.stdout.emit("data", Buffer.from(line + "\n"));
    expect(written).toEqual(["1 of 1 START ...\r\n"]);
    expect(events).toEqual([{ type: "status", nodeId: "model.proj.stg_orders", status: "running" }]);

    proc.emit("close", 0);
    expect(events).toEqual([
      { type: "status", nodeId: "model.proj.stg_orders", status: "running" },
      { type: "done", exitCode: 0 },
    ]);
  });

  it("flushes a trailing partial line (no final newline) before emitting done", () => {
    const proc = fakeChild();
    const written: string[] = [];
    startDbtRun("/proj", "run", "x", { onWrite: (t) => written.push(t), onEvent: () => {} }, { spawn: () => proc });
    proc.stdout.emit("data", Buffer.from("no trailing newline"));
    proc.emit("close", 0);
    expect(written).toEqual(["no trailing newline\r\n"]);
  });

  it("a spawn error is written to the terminal and closes the run with exit -1", () => {
    const proc = fakeChild();
    const written: string[] = [];
    const events: unknown[] = [];
    startDbtRun("/proj", "run", "x", { onWrite: (t) => written.push(t), onEvent: (e) => events.push(e) }, { spawn: () => proc });
    proc.emit("error", new Error("ENOENT"));
    expect(written[0]).toContain("ENOENT");
    expect(events).toEqual([{ type: "done", exitCode: -1 }]);
  });

  it("cancel() sends SIGTERM to the process group (negative pid) on POSIX", () => {
    const proc = fakeChild();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const controller = startDbtRun("/proj", "run", "x", { onWrite: () => {}, onEvent: () => {} }, { spawn: () => proc, platform: "darwin" });
    controller.cancel();
    expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
    killSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/vscode && npx vitest run src/host/run.test.ts`
Expected: FAIL — `./run` module does not exist.

- [ ] **Step 3: Implement `run.ts`**

Create `packages/vscode/src/host/run.ts`:

```ts
import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import { resolveBin } from "./gist";
import type { RunEvent, Status } from "@dbt-open-lineage/core/src/runStatus";

export function buildRunArgs(command: "run" | "build" | "test", selector: string): string[] {
  return [command, "--select", selector, "--log-format", "json"];
}

/** Accumulates chunks and yields only complete (newline-terminated) lines;
 * a trailing partial line carries over to the next push. `flush()` returns
 * any leftover partial line once — call it exactly once, when the stream
 * ends, so a final unterminated line isn't silently dropped. */
export class LineBuffer {
  private carry = "";
  push(chunk: string): string[] {
    const text = this.carry + chunk;
    const parts = text.split("\n");
    this.carry = parts.pop() ?? "";
    return parts;
  }
  flush(): string[] {
    const rest = this.carry;
    this.carry = "";
    return rest ? [rest] : [];
  }
}

/** dbt's `node_info.node_status` values (which vary a little across dbt
 * versions/resource types) collapsed onto our 4-state Status. Anything not
 * listed here (e.g. "warn") returns null: the line still displays in the
 * terminal, it just doesn't move the pilot light. */
export function mapNodeStatus(raw: string): Status | null {
  switch (raw) {
    case "started": return "running";
    case "success": case "passed": case "pass": case "reused": return "success";
    case "error": case "failed": case "fail": case "runtime error": return "failed";
    case "skipped": return "skipped";
    default: return null;
  }
}

export interface ParsedLine { event: RunEvent | null; display: string }

/** Parse one line of `dbt ... --log-format json` output. `display` is always
 * populated (the JSON's human-readable `msg` field when present, otherwise
 * the raw line) so the terminal panel reads like normal dbt output even
 * though the underlying process emits structured JSON. A malformed line
 * (partial write, non-JSON noise) must never throw — it just displays raw
 * with no status event. */
export function parseDbtLogLine(line: string): ParsedLine {
  if (!line.trim()) return { event: null, display: line };
  let parsed: unknown;
  try { parsed = JSON.parse(line); }
  catch { return { event: null, display: line }; }
  const obj = parsed as { msg?: unknown; node_info?: { unique_id?: unknown; node_status?: unknown } };
  const display = typeof obj.msg === "string" ? obj.msg : line;
  const info = obj.node_info;
  if (info && typeof info.unique_id === "string" && typeof info.node_status === "string") {
    const status = mapNodeStatus(info.node_status);
    if (status) return { event: { type: "status", nodeId: info.unique_id, status }, display };
  }
  return { event: null, display };
}

export interface RunCallbacks {
  onWrite(text: string): void;
  onEvent(event: RunEvent): void;
}

export interface RunDeps {
  spawn(cwd: string, args: string[]): ChildProcess;
  /** Overridable only for tests — real callers always use process.platform. */
  platform?: NodeJS.Platform;
}

const defaultDeps: RunDeps = {
  // No shell: args stay discrete argv tokens (same injection-safety rationale
  // as compileSelectArgs). resolveBin avoids the GUI-launch PATH problem
  // gist.ts already had to solve for `claude` — child_process.spawn, unlike
  // vscode.Task's ShellExecution, never goes through a login shell.
  spawn: (cwd, args) => nodeSpawn(resolveBin("dbt"), args, { cwd, detached: process.platform !== "win32" }),
};

export interface RunController { cancel(): void }

/** Spawn `dbt <command> --select <selector> --log-format json` in
 * `projectRoot`, parsing stdout/stderr line-by-line: every line is written
 * to the terminal (via `cb.onWrite`, CRLF-terminated as vscode.Pseudoterminal
 * requires) and, when it carries node status, turned into a `RunEvent` (via
 * `cb.onEvent`). Emits a final `{type:"done"}` event when the process exits
 * or fails to spawn. */
export function startDbtRun(
  projectRoot: string, command: "run" | "build" | "test", selector: string,
  cb: RunCallbacks, deps: RunDeps = defaultDeps,
): RunController {
  const child = deps.spawn(projectRoot, buildRunArgs(command, selector));
  const platform = deps.platform ?? process.platform;
  const out = new LineBuffer();
  const err = new LineBuffer();

  const handle = (lines: string[]) => {
    for (const line of lines) {
      const { event, display } = parseDbtLogLine(line);
      cb.onWrite(display + "\r\n");
      if (event) cb.onEvent(event);
    }
  };

  child.stdout?.on("data", (chunk: Buffer) => handle(out.push(chunk.toString("utf8"))));
  child.stderr?.on("data", (chunk: Buffer) => handle(err.push(chunk.toString("utf8"))));
  child.on("close", (code: number | null) => {
    handle(out.flush());
    handle(err.flush());
    cb.onEvent({ type: "done", exitCode: code ?? -1 });
  });
  child.on("error", (e: Error) => {
    cb.onWrite(`spawn error: ${e.message}\r\n`);
    cb.onEvent({ type: "done", exitCode: -1 });
  });

  return {
    cancel: () => {
      if (!child.pid) return;
      try {
        if (platform === "win32") nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
        // Negative pid = signal the whole process GROUP, not just the direct
        // child — dbt/db-adapter children must die too, or Cancel leaves
        // orphans running (the class of bug process-group kills exist for).
        else process.kill(-child.pid, "SIGTERM");
      } catch { /* already exited */ }
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/vscode && npx vitest run src/host/run.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full vscode test suite + typecheck**

Run: `cd packages/vscode && npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/vscode/src/host/run.ts packages/vscode/src/host/run.test.ts
git commit -m "feat(vscode): add dbt run/build/test process execution and json-log parsing"
```

---

### Task 5: VSCode webview bridge — `onRunEvent`

**Files:**
- Modify: `packages/vscode/src/bridge.ts`
- Create: `packages/vscode/src/bridge.test.ts`
- Modify: `packages/vscode/package.json`

**Interfaces:**
- Consumes: `Bridge` interface (Task 1) — `vscodeBridge` must satisfy it, including the new `onRunEvent` member.
- Produces: nothing new consumed elsewhere — this is the webview-side half of the contract Task 6 pushes events into (`view.postMessage({ evt: "run", event })`).

- [ ] **Step 1: Add the `jsdom` devDependency**

Modify `packages/vscode/package.json` — in `devDependencies`, add `"jsdom": "^29.1.1"` (matching the version already used by `packages/core` and `packages/mext`), keeping keys alphabetically placed next to `"esbuild"`/`"typescript"` as the file already roughly does:

```json
    "esbuild": "^0.27.0",
    "jsdom": "^29.1.1",
    "typescript": "^5.6.0",
```

Run: `cd packages/vscode && npm install`
Expected: `jsdom` added to `node_modules` and `package-lock.json` updated.

- [ ] **Step 2: Write the failing tests**

Create `packages/vscode/src/bridge.test.ts`:

```ts
// @vitest-environment jsdom
//
// This is the first unit test for a webview-side (browser) file in this
// package — every other test here is Node-only host code (see
// vitest.config.ts's comment). vscode's vitest config therefore defaults to
// the "node" environment; the pragma above overrides it for this file only.
//
// bridge.ts calls acquireVsCodeApi() as a MODULE-LEVEL side effect. ES module
// imports are hoisted and evaluated before any of a test file's own top-level
// statements run, so a plain `globalThis.acquireVsCodeApi = ...` written
// above a static `import { vscodeBridge } from "./bridge"` would NOT run in
// time. Each test instead stubs the global first, then dynamically imports
// the module (with vi.resetModules() so the module's internal `seq`/`pending`
// state is fresh every time).
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("vscodeBridge", () => {
  let postMessageSpy: ReturnType<typeof vi.fn>;
  let vscodeBridge: typeof import("./bridge")["vscodeBridge"];

  beforeEach(async () => {
    vi.resetModules();
    postMessageSpy = vi.fn();
    (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (m: unknown) => void } }).acquireVsCodeApi =
      () => ({ postMessage: postMessageSpy });
    ({ vscodeBridge } = await import("./bridge"));
  });

  it("invoke() posts {id,cmd,args} via vscode.postMessage and resolves on a matching reply", async () => {
    const p = vscodeBridge.invoke("dbt.manifest", { foo: "bar" });
    const sent = postMessageSpy.mock.calls[0][0] as { id: number; cmd: string; args: unknown };
    expect(sent).toMatchObject({ cmd: "dbt.manifest", args: { foo: "bar" } });
    window.dispatchEvent(new MessageEvent("message", { data: { id: sent.id, ok: true, result: "pong" } }));
    await expect(p).resolves.toBe("pong");
  });

  it("onRunEvent() forwards evt:'run' pushes", () => {
    const events: unknown[] = [];
    const unsub = vscodeBridge.onRunEvent((e) => events.push(e));
    window.dispatchEvent(new MessageEvent("message", { data: { evt: "run", event: { type: "done", exitCode: 0 } } }));
    expect(events).toEqual([{ type: "done", exitCode: 0 }]);
    unsub();
  });

  it("onRunEvent() ignores pushes for other event types", () => {
    const events: unknown[] = [];
    vscodeBridge.onRunEvent((e) => events.push(e));
    window.dispatchEvent(new MessageEvent("message", { data: { evt: "context", value: "+dim_date+" } }));
    expect(events).toEqual([]);
  });

  it("unsubscribing stops further delivery", () => {
    const events: unknown[] = [];
    const unsub = vscodeBridge.onRunEvent((e) => events.push(e));
    unsub();
    window.dispatchEvent(new MessageEvent("message", { data: { evt: "run", event: { type: "done", exitCode: 0 } } }));
    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/vscode && npx vitest run src/bridge.test.ts`
Expected: FAIL — `vscodeBridge.onRunEvent is not a function`.

- [ ] **Step 4: Implement `onRunEvent`**

Modify `packages/vscode/src/bridge.ts` — change:

```ts
export const vscodeBridge: Bridge = {
  invoke: (cmd, args) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    vscode.postMessage({ id, cmd, args });
  }),
  saveExport: (filename, dataB64) => vscodeBridge.invoke("export.save", { filename, dataB64 }),
  openInIde: (path) => vscodeBridge.invoke("ide.open", { path }),
  onContext: (cb) => {
    const onMsg = (ev: MessageEvent) => {
      const m = ev.data;
      if (!m || m.evt !== "context" || typeof m.value !== "string") return;
      cb(m.value);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  },
};
```

to:

```ts
export const vscodeBridge: Bridge = {
  invoke: (cmd, args) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    vscode.postMessage({ id, cmd, args });
  }),
  saveExport: (filename, dataB64) => vscodeBridge.invoke("export.save", { filename, dataB64 }),
  openInIde: (path) => vscodeBridge.invoke("ide.open", { path }),
  onContext: (cb) => {
    const onMsg = (ev: MessageEvent) => {
      const m = ev.data;
      if (!m || m.evt !== "context" || typeof m.value !== "string") return;
      cb(m.value);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  },
  onRunEvent: (cb) => {
    const onMsg = (ev: MessageEvent) => {
      const m = ev.data;
      if (!m || m.evt !== "run" || !m.event) return;
      cb(m.event);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  },
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/vscode && npx vitest run src/bridge.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full vscode suite + typecheck**

Run: `cd packages/vscode && npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/vscode/src/bridge.ts packages/vscode/src/bridge.test.ts packages/vscode/package.json packages/vscode/package-lock.json 2>/dev/null; git add package-lock.json
git commit -m "feat(vscode): add onRunEvent to the webview bridge"
```

(If the repo uses a single root `package-lock.json`, `npm install` above updates that one, not a per-package lockfile — the commit command covers both layouts; only files that actually changed get staged.)

---

### Task 6: VSCode extension host — wire `dbt.run`/`dbt.cancel` to a Pseudoterminal

**Files:**
- Modify: `packages/vscode/src/extension.ts`

**Interfaces:**
- Consumes: `startDbtRun`, `RunController` (Task 4); `RunEvent` type (Task 1, via subpath import); the `handleMessage` switch's existing `reply`/`view` conventions.
- Produces: the `"dbt.run"` / `"dbt.cancel"` commands and `evt: "run"` push messages that Task 3's `App.tsx` and Task 5's `vscodeBridge` already assume.

This task's wiring is thin glue over already-tested logic (`run.ts`) — consistent with how `extension.ts`'s existing `"dbt.compile"` case has no dedicated unit test of its own (it's covered by `host/compile.ts`'s tests plus the `test/integration/open.test.ts` end-to-end check). Verification here is typecheck + build + the existing integration test, not a new unit test.

- [ ] **Step 1: Add the import and module-level `activeRun` state**

Modify `packages/vscode/src/extension.ts` — change:

```ts
import { makeCompileTask, runTaskToCompletion, makeCompileSelectTask } from "./host/compile";
import { readCompiledSql, compiledDocUri, parseCompiledDocQuery } from "./host/compiledSql";
```

to:

```ts
import { makeCompileTask, runTaskToCompletion, makeCompileSelectTask } from "./host/compile";
import { startDbtRun, type RunController } from "./host/run";
import { readCompiledSql, compiledDocUri, parseCompiledDocQuery } from "./host/compiledSql";
```

and change:

```ts
let view: vscode.Webview | undefined; // the resolved panel view's webview
let projectRoot: string | undefined;
let lastGraph: Graph | undefined;
```

to:

```ts
let view: vscode.Webview | undefined; // the resolved panel view's webview
let projectRoot: string | undefined;
let lastGraph: Graph | undefined;
let activeRun: RunController | undefined; // set while a dbt.run is in flight; guards against overlapping runs
```

- [ ] **Step 2: Add the `"dbt.run"` and `"dbt.cancel"` cases**

Modify `packages/vscode/src/extension.ts` — inside the `switch (msg.cmd)` block in `handleMessage`, add these two cases right after the existing `case "dbt.compile":` block (before `case "ide.open":`):

```ts
      case "dbt.run": {
        projectRoot = resolveRoot();
        if (!projectRoot) throw new Error("no dbt project found (dbt_project.yml)");
        if (activeRun) throw new Error("a run is already in progress");
        const root = projectRoot;
        const command = String(msg.args.command ?? "run") as "run" | "build" | "test";
        const selector = String(msg.args.selector ?? "");
        if (!selector.trim()) throw new Error("no runnable models in current view");
        const writeEmitter = new vscode.EventEmitter<string>();
        const closeEmitter = new vscode.EventEmitter<number>();
        const pty: vscode.Pseudoterminal = {
          onDidWrite: writeEmitter.event,
          onDidClose: closeEmitter.event,
          open: () => {
            const controller = startDbtRun(root, command, selector, {
              onWrite: (text) => writeEmitter.fire(text),
              onEvent: (event) => {
                view?.postMessage({ evt: "run", event });
                if (event.type === "done") {
                  activeRun = undefined;
                  closeEmitter.fire(event.exitCode);
                }
              },
            });
            activeRun = controller;
          },
          close: () => { activeRun?.cancel(); activeRun = undefined; },
        };
        const terminal = vscode.window.createTerminal({ name: `dbt ${command}`, pty });
        terminal.show();
        reply({ ok: true, result: true });
        break;
      }
      case "dbt.cancel": {
        activeRun?.cancel();
        reply({ ok: true, result: true });
        break;
      }
```

- [ ] **Step 3: Typecheck**

Run: `cd packages/vscode && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Build**

Run: `cd packages/vscode && npm run build`
Expected: PASS (both `build:host` esbuild and `build:webview` vite steps succeed — the webview step picks up Task 3's `App.tsx` changes, the host step picks up this task's `extension.ts` changes).

- [ ] **Step 5: Run the full vscode test suite**

Run: `cd packages/vscode && npm test`
Expected: PASS (all pre-existing + Task 4/5 tests green; `extension.ts` itself remains untested at the unit level, consistent with the existing convention).

- [ ] **Step 6: Manual smoke test (documented, not automated)**

In a real dbt project opened in VSCode with this extension loaded (`F5` Extension Development Host, or install the built `.vsix`):
1. Open the dbt Lineage view, type a selector that resolves to a couple of models, press Enter (Focus on).
2. Click "▶ Run" → a new integrated terminal named "dbt run" opens and shows live dbt output; the corresponding nodes' top edges show the animated sweep, then flip to green/red/amber as each model finishes.
3. Click "■ Cancel" mid-run → the terminal process stops, in-flight nodes settle (don't stay spinning forever).
4. Click "▶ Run" again immediately after a run finishes → a fresh run starts (no stale "already in progress" error).

This step has no exit code to assert in this plan — record the outcome in the task's completion note (pass/fail + anything odd) since it's the one part of this feature that only a real VSCode host + real dbt project can exercise.

- [ ] **Step 7: Commit**

```bash
git add packages/vscode/src/extension.ts
git commit -m "feat(vscode): wire dbt.run/dbt.cancel to a Pseudoterminal-backed dbt process"
```

---

### Task 7: Mnemo webview bridge (mext) — `onRunEvent`

**Files:**
- Modify: `packages/mext/src/bridge.ts`
- Modify: `packages/mext/src/bridge.test.ts`

**Interfaces:**
- Consumes: `Bridge` interface (Task 1) — `mextBridge` must satisfy it.
- Produces: the mext half of the run-event contract. No Mnemo/Rust host implementation exists yet (out of scope, see the spec's Follow-up section) — until that lands, `dbt.run`/`dbt.cancel` invokes in Mnemo will reject with "unknown command" from whatever the Rust host's generic dispatcher does with an unrecognized `cmd`, and `onRunEvent` will simply never fire. That's an acceptable, self-explanatory failure mode for now (the Run button in `App.tsx` will show an error toast from the rejected `invoke`, same as any other unimplemented host command) — no extra guard code needed in this package for it.

- [ ] **Step 1: Write the failing tests**

Append to `packages/mext/src/bridge.test.ts` (inside the existing `describe("mextBridge", ...)` block, after the `onContext` tests):

```ts
  it("onRunEvent() forwards evt:'run' pushes from window.parent", () => {
    const events: unknown[] = [];
    const unsubscribe = mextBridge.onRunEvent((e) => events.push(e));

    window.dispatchEvent(
      new MessageEvent("message", { data: { evt: "run", event: { type: "done", exitCode: 0 } }, source: window.parent }),
    );
    expect(events).toEqual([{ type: "done", exitCode: 0 }]);

    unsubscribe();
  });

  it("onRunEvent() ignores pushes whose event.source is not window.parent", () => {
    const events: unknown[] = [];
    mextBridge.onRunEvent((e) => events.push(e));

    window.dispatchEvent(
      new MessageEvent("message", { data: { evt: "run", event: { type: "done", exitCode: 1 } }, source: null }),
    );
    expect(events).toEqual([]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/mext && npx vitest run src/bridge.test.ts`
Expected: FAIL — `mextBridge.onRunEvent is not a function`.

- [ ] **Step 3: Implement `onRunEvent`**

Modify `packages/mext/src/bridge.ts` — change:

```ts
export const mextBridge: Bridge = {
  invoke: (cmd, args) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    window.parent.postMessage({ id, cmd, args }, "*");
  }),
  saveExport: (filename, dataB64) => mextBridge.invoke("export.save", { filename, dataB64 }),
  openInIde: (path) => mextBridge.invoke("ide.open", { path }),
  onContext: (cb) => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.source !== window.parent) return;
      const m = ev.data;
      if (!m || m.evt !== "context" || typeof m.value !== "string") return;
      cb(m.value);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  },
};
```

to:

```ts
export const mextBridge: Bridge = {
  invoke: (cmd, args) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    window.parent.postMessage({ id, cmd, args }, "*");
  }),
  saveExport: (filename, dataB64) => mextBridge.invoke("export.save", { filename, dataB64 }),
  openInIde: (path) => mextBridge.invoke("ide.open", { path }),
  onContext: (cb) => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.source !== window.parent) return;
      const m = ev.data;
      if (!m || m.evt !== "context" || typeof m.value !== "string") return;
      cb(m.value);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  },
  onRunEvent: (cb) => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.source !== window.parent) return;
      const m = ev.data;
      if (!m || m.evt !== "run" || !m.event) return;
      cb(m.event);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  },
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/mext && npx vitest run src/bridge.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full mext suite + typecheck**

Run: `cd packages/mext && npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mext/src/bridge.ts packages/mext/src/bridge.test.ts
git commit -m "feat(mext): add onRunEvent to the webview bridge"
```

---

### Task 8: Full-repo verification sweep

**Files:** none (verification only).

- [ ] **Step 1: Run every package's test suite**

Run:
```bash
(cd packages/core && npm test)
(cd packages/vscode && npm test)
(cd packages/mext && npm test)
(cd packages/cli && npm test)
```
Expected: all PASS. (`cli` is included because it depends on `@dbt-open-lineage/core` and re-exports/consumes its types — a broken barrel export would surface there.)

- [ ] **Step 2: Typecheck every package**

Run:
```bash
(cd packages/core && npm run typecheck)
(cd packages/vscode && npx tsc --noEmit)
(cd packages/mext && npx tsc --noEmit)
(cd packages/cli && npx tsc --noEmit)
```
Expected: all PASS.

- [ ] **Step 3: Build vscode and mext (webview bundles)**

Run:
```bash
(cd packages/vscode && npm run build)
(cd packages/mext && npm run build)
```
Expected: both PASS — confirms the new `App.tsx` toolbar control and pilot-light rendering compile cleanly into each host's actual bundle, not just under vitest.

- [ ] **Step 4: Note the deferred cross-repo follow-up**

No code change here — just confirm (re-read `docs/superpowers/specs/2026-07-14-dag-run-button-design.md`'s "Follow-up" section) that the Mnemo/Rust executor spec still accurately describes the contract this plan just implemented (`dbt.run({command, selector})` / `dbt.cancel()` / `onRunEvent` pushing `{type:"status",nodeId,status}` and `{type:"done",exitCode}`) before that follow-up work starts in the sibling Mnemo repo.

---

## Self-Review Notes

- **Spec coverage:** every spec section has a task — active-set/selector (Task 1), UI + toolbar (Task 3), pilot light (Task 2), execution/streaming + bridge contract (Tasks 1, 4, 5, 6), error handling (Tasks 3, 4, 6), testing (every task), Mnemo follow-up (explicitly deferred, noted in Task 7 and Task 8 Step 4).
- **Placeholder scan:** no TBDs; Task 6 Step 6 is an intentionally manual (not automated) smoke test, called out explicitly with a reason (needs a real VSCode host + real dbt project), not a placeholder for missing work.
- **Type consistency:** `Status`/`RunEvent` defined once in `packages/core/src/runStatus.ts` (Task 1) and consumed identically by name everywhere else — `ViewState.runStatus` (Task 2), `App.tsx` state (Task 3), `run.ts`'s callbacks (Task 4), both bridge implementations (Tasks 5, 7). `command: "run" | "build" | "test"` and the `{command, selector}` invoke-args shape are identical in `App.tsx` (Task 3), `run.ts` (Task 4), and `extension.ts` (Task 6).
