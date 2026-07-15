# Column-Lineage Toggle UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the interactive column-lineage toggle to `packages/core`'s
`App.tsx` — the visible feature this whole multi-plan effort has been
building toward. Clicking a toolbar button fetches column-level lineage via
the already-shipped `dbt.columnLineage` host command and renders it as
column-to-column edges on the canvas plus a column list in the details
panel.

**Architecture:** Four new pieces of `App.tsx` state (mode, data, busy,
error) drive an async click handler mirroring the existing `onSparkle`/
`gistBusy` pattern. Rendering splits into two independently testable
pieces, matching this file's existing conventions: a pure, exported
`columnEdgesFor()` function (unit-tested directly, mirroring how
`edgeOnLineage` is already tested — never through React Flow's rendered
SVG) replaces the model-edge computation when the toggle is on, and a new
`<dt>`/`<dd>` columns section in the details panel (render-tested via
`screen`/`waitFor`, matching the existing `tests`/`logs` fields).

**Tech Stack:** TypeScript, React, `@xyflow/react`, Vitest, Testing Library.

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-07-15-column-lineage-interactive-ui-design.md`
§2/§3, and one correction discovered during planning:

- `columnLineageMode: boolean` (default `false`), `columnLineage:
  ColumnLineagePayload | null` (default `null`), `columnLineageBusy:
  boolean`, `columnLineageErr: string | null` — exact state shape.
- On toggle-on with no cached data: `invoke<ColumnLineagePayload>("dbt.columnLineage", {})`.
  On error: revert `columnLineageMode` to `false`, surface the message in
  an inline error banner (same visual treatment as the existing
  `regexError` span).
- Toggle button: same pill-button styling as the regex-mode `.* ` toggle
  (`aria-pressed`, border/background keyed off state).
- Edges (toggle on): fully replace model edges with column edges, styled
  distinctly (`stroke: "#38bdf8"`, `strokeWidth: 1.5`, `strokeDasharray:
  "4 2"`), each labeled `${sourceColumn} → ${targetColumn}`.
- Details panel: new `columns` section using the exact `<dt>`/`<dd>`
  pattern already used by the `tests`/`logs` fields, rendered only when
  `columnLineage` has an entry for the selected node.
- **Correction from the original spec:** the spec's "cache invalidation on
  `dbt.compile`" bullet is **dropped from this plan**. `load("dbt.compile")`
  has no live call site anywhere in the current `App.tsx` (confirmed by
  grep — only `load("dbt.manifest")` is ever called, once, on mount), so
  wiring cache-clearing to it would be dead, untestable code today. Once a
  real "recompile" UI trigger exists in this codebase, cache invalidation
  can be added as a small follow-up. For now, cached `columnLineage` data
  persists for the component's lifetime once fetched.

---

### Task 1: Toggle state, click handler, toolbar button

**Files:**
- Modify: `packages/core/src/App.tsx`
- Modify: `packages/core/src/App.test.tsx`

**Interfaces:**
- Consumes: `invoke<T>(cmd, args)` from `./bridge` (already imported).
  `ColumnLineagePayload` type from `./columnLineage` (new import this
  task).
- Produces: `columnLineageMode`, `columnLineage`, `columnLineageBusy`,
  `columnLineageErr` state and `onToggleColumnLineage` handler. Task 2
  reads `columnLineageMode`/`columnLineage` (not the handler or busy/err
  state) to build column edges and the details-panel columns section.

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/App.test.tsx`, add a settable module-level variable
alongside the existing `manifestGraph` (near line 47), and a new branch in
`invokeMock` (near line 50-56):

```ts
let columnLineageResult: unknown = { nodes: {}, edges: [] };
```

Add to the `invokeMock` implementation (inside the existing `vi.fn(async
(cmd, _args) => { ... })` body, alongside the existing `if` branches):

```ts
  if (cmd === "dbt.columnLineage") {
    if (columnLineageResult instanceof Error) throw columnLineageResult;
    return columnLineageResult;
  }
```

Add to the existing `beforeEach` (line 84), alongside the other resets:

```ts
beforeEach(() => {
  layoutSpy.mockClear(); invokeMock.mockClear(); manifestGraph = g;
  lastCalloutHeights = undefined; runEventCb = null;
  columnLineageResult = { nodes: {}, edges: [] };
});
```

Add these three new tests inside the existing `describe("dbt DAG App", ...)`
block (anywhere after the other toggle-related tests is fine — no ordering
dependency):

```ts
  it("clicking the Columns toggle fetches column lineage and marks the button pressed", async () => {
    columnLineageResult = {
      nodes: { a: { columns: { id: { columnName: "id", hasLineage: true } } } },
      edges: [],
    };
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    const toggle = screen.getByRole("button", { name: "Columns" });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));
    expect(invokeMock).toHaveBeenCalledWith("dbt.columnLineage", {});
  });

  it("does not re-fetch column lineage on a second toggle-on (cached)", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    const toggle = screen.getByRole("button", { name: "Columns" });
    fireEvent.click(toggle); // on: fetches
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));
    const fetchesAfterFirstToggle = invokeMock.mock.calls.filter((c) => c[0] === "dbt.columnLineage").length;
    fireEvent.click(toggle); // off
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "false"));
    fireEvent.click(toggle); // on again: cached, no re-fetch
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));
    expect(invokeMock.mock.calls.filter((c) => c[0] === "dbt.columnLineage").length).toBe(fetchesAfterFirstToggle);
  });

  it("shows an error banner and reverts the toggle to off when the fetch fails", async () => {
    columnLineageResult = new Error("dbt-colibri (colibri) not found. Install with: pip install dbt-colibri");
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    const toggle = screen.getByRole("button", { name: "Columns" });
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText(/pip install dbt-colibri/)).toBeInTheDocument());
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `packages/core/`): `npx vitest run src/App.test.tsx -t "Columns toggle|re-fetch column lineage|error banner and reverts"`
Expected: FAIL — no button with accessible name "Columns" exists yet.

- [ ] **Step 3: Write minimal implementation**

In `packages/core/src/App.tsx`, add this import after the existing
`import { readMeta } from "./meta";` line:

```ts
import type { ColumnLineagePayload } from "./columnLineage";
```

Add these four state hooks immediately after the existing `const
[regexMode, setRegexMode] = useState(false);` line:

```ts
  const [columnLineageMode, setColumnLineageMode] = useState(false);
  const [columnLineage, setColumnLineage] = useState<ColumnLineagePayload | null>(null);
  const [columnLineageBusy, setColumnLineageBusy] = useState(false);
  const [columnLineageErr, setColumnLineageErr] = useState<string | null>(null);
```

Add this handler immediately after the existing `onSparkle` function's
closing brace (`};` after its `finally` block):

```ts
  const onToggleColumnLineage = async () => {
    const next = !columnLineageMode;
    setColumnLineageMode(next);
    if (!next || columnLineage) return; // turning off, or data already cached
    setColumnLineageBusy(true); setColumnLineageErr(null);
    try {
      setColumnLineage(await invoke<ColumnLineagePayload>("dbt.columnLineage", {}));
    } catch (e) {
      setColumnLineageErr(String((e as Error).message ?? e));
      setColumnLineageMode(false); // revert — nothing to show
    } finally {
      setColumnLineageBusy(false);
    }
  };
```

In the toolbar JSX, add this button and error banner immediately after the
existing Focus button's closing `>Focus</button>` tag (right before the
search `<input>`):

```tsx
            <button
              onClick={() => void onToggleColumnLineage()}
              aria-pressed={columnLineageMode}
              aria-label="Columns"
              disabled={columnLineageBusy}
              title="Show column-level lineage"
              style={{
                display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 11px",
                borderRadius: 20, border: `1px solid ${columnLineageMode ? "#3b82f6" : "#334155"}`,
                background: columnLineageMode ? "#16233d" : "#111827",
                color: columnLineageBusy ? "#64748b" : "#e5e7eb",
                cursor: columnLineageBusy ? "default" : "pointer",
                fontFamily: "inherit", fontSize: 12,
              }}
            >{columnLineageBusy ? "loading…" : "Columns"}</button>
            {columnLineageErr && (
              <span style={{ color: "#fca5a5", fontSize: 12, whiteSpace: "nowrap" }}>{columnLineageErr}</span>
            )}
```

(`aria-label="Columns"` stays fixed even while the visible text switches to
"loading…" — needed so tests, and screen readers, can find the button by a
stable name regardless of busy state, unlike the Focus/regex-mode buttons
whose visible text never changes.)

- [ ] **Step 4: Run tests to verify they pass**

Run (from `packages/core/`): `npx vitest run src/App.test.tsx -t "Columns toggle|re-fetch column lineage|error banner and reverts"`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full package suite and typecheck**

Run (from `packages/core/`): `npx vitest run`
Expected: all tests pass (no regressions — this task only adds new state/
handler/JSX, doesn't modify any existing behavior).

Run (from `packages/core/`): `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/App.tsx packages/core/src/App.test.tsx
git commit -m "feat(core): add column-lineage toggle state and button

Mirrors the existing onSparkle/gistBusy async-fetch pattern. Toggle-on
fetches via dbt.columnLineage once and caches; error reverts the toggle
and shows an inline banner. No rendering yet — that's the next task."
```

---

### Task 2: Column edges + details-panel columns section

**Files:**
- Modify: `packages/core/src/App.tsx`
- Modify: `packages/core/src/App.test.tsx`

**Interfaces:**
- Consumes: `columnLineageMode`, `columnLineage` state (Task 1).
- Produces: `export function columnEdgesFor(columnLineage:
  ColumnLineagePayload, matched: Set<string>, focus: boolean, pruned:
  Set<string> | null): Edge[]` — a pure function, exported for direct unit
  testing (same pattern as the already-exported `edgeOnLineage`).

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/App.test.tsx`, add this `describe` block adjacent to
the existing `describe("edgeOnLineage", ...)` block (same file, same
top-level structure — these are plain unit tests, no `render()`):

```ts
describe("columnEdgesFor", () => {
  const payload: ColumnLineagePayload = {
    nodes: {},
    edges: [
      { source: "a", target: "b", sourceColumn: "id", targetColumn: "id" },
      { source: "b", target: "c", sourceColumn: "id", targetColumn: "id" },
    ],
  };

  it("builds one React Flow edge per column edge, labeled sourceColumn → targetColumn", () => {
    const result = columnEdgesFor(payload, new Set(["a", "b", "c"]), false, null);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ source: "a", target: "b", label: "id → id" });
    expect(result[1]).toMatchObject({ source: "b", target: "c", label: "id → id" });
  });

  it("filters to matched-only when focus is on", () => {
    const result = columnEdgesFor(payload, new Set(["a", "b"]), true, null);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ source: "a", target: "b" });
  });

  it("filters to pruned-only when a prune set is active", () => {
    const result = columnEdgesFor(payload, new Set(["a", "b", "c"]), false, new Set(["b", "c"]));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ source: "b", target: "c" });
  });

  it("gives every edge a unique id even for repeated source/target pairs", () => {
    const dup: ColumnLineagePayload = {
      nodes: {},
      edges: [
        { source: "a", target: "b", sourceColumn: "id", targetColumn: "id" },
        { source: "a", target: "b", sourceColumn: "name", targetColumn: "name" },
      ],
    };
    const result = columnEdgesFor(dup, new Set(["a", "b"]), false, null);
    expect(result[0].id).not.toBe(result[1].id);
  });
});
```

Add the import this test needs, alongside the existing `import App, {
lineageOf, edgeOnLineage } from "./App";` line — change it to:

```ts
import App, { lineageOf, edgeOnLineage, columnEdgesFor } from "./App";
import type { ColumnLineagePayload } from "./columnLineage";
```

Also add these two render-level tests inside `describe("dbt DAG App",
...)`, for the details-panel columns section (this part IS render-tested,
matching the `tests`/`logs` fields' pattern):

```ts
  it("shows the selected node's columns in the details panel once column lineage is loaded", async () => {
    columnLineageResult = {
      nodes: {
        a: {
          columns: {
            id: { columnName: "id", hasLineage: true },
            raw: { columnName: "raw", hasLineage: false },
          },
        },
      },
      edges: [],
    };
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Columns" })).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(screen.getAllByText("a")[0]);
    const panel = await screen.findByRole("complementary");
    await waitFor(() => expect(panel).toHaveTextContent("columns"));
    expect(panel).toHaveTextContent("id");
    expect(panel).toHaveTextContent("raw");
    expect(panel).toHaveTextContent("unresolved");
  });

  it("shows no columns section before the toggle has ever been used", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText("a")[0]);
    const panel = await screen.findByRole("complementary");
    await waitFor(() => expect(panel).toHaveTextContent("materialization"));
    expect(panel).not.toHaveTextContent("(unresolved)");
    expect(screen.queryByText("columns")).not.toBeInTheDocument();
  });
```

(These two tests rely on Task 1's `invokeMock`/`columnLineageResult`
scaffolding, already in place.)

- [ ] **Step 2: Run tests to verify they fail**

Run (from `packages/core/`): `npx vitest run src/App.test.tsx -t "columnEdgesFor|columns in the details panel|no columns section"`
Expected: FAIL — `columnEdgesFor` isn't exported yet; the details-panel
tests find no `columns` text.

- [ ] **Step 3: Write minimal implementation**

In `packages/core/src/App.tsx`, add this exported pure function near the
existing `edgeOnLineage` function (same file, module-level, not inside the
component):

```ts
/** Column-to-column edges for the interactive toggle — pure and exported
 * so it's unit-testable directly, the same way edgeOnLineage is, rather
 * than through React Flow's rendered SVG. Reuses the same focus/pruned
 * node-id-set semantics the model-edge computation already applies. */
export function columnEdgesFor(
  columnLineage: ColumnLineagePayload,
  matched: Set<string>,
  focus: boolean,
  pruned: Set<string> | null,
): Edge[] {
  return columnLineage.edges
    .filter((e) => (focus ? matched.has(e.source) && matched.has(e.target) : true))
    .filter((e) => pruned === null || (pruned.has(e.source) && pruned.has(e.target)))
    .map((e, i) => ({
      id: `col-${i}-${e.source}->${e.target}`,
      source: e.source,
      target: e.target,
      label: `${e.sourceColumn} → ${e.targetColumn}`,
      style: { stroke: "#38bdf8", strokeWidth: 1.5, strokeDasharray: "4 2" },
    }));
}
```

In the `rfEdges` `useMemo` (the one starting `const rfEdges: Edge[] =
useMemo(() => {`), add a branch immediately after the existing blank-DAG
early return and before the `return graph.edges...` line:

```ts
  const rfEdges: Edge[] = useMemo(() => {
    // empty selector → blank DAG, unless "show all" is confirmed
    if (!graph || (!cleanedSelector.trim() && !showAll)) return [];
    if (columnLineageMode && columnLineage) {
      return columnEdgesFor(columnLineage, matched, focus, pruned);
    }
    return graph.edges
```

(The rest of the existing `return graph.edges...` block is unchanged.) Add
`columnLineageMode, columnLineage` to the `useMemo`'s dependency array:

```ts
  }, [graph, matched, focus, selected, lineage, view, cleanedSelector, showAll, pruned, columnLineageMode, columnLineage]);
```

In the details panel, add this new section immediately after the existing
`tests` field's closing `</dd>` tag (right before the `logs` field's
comment/conditional block):

```tsx
            {columnLineage?.nodes[selectedNode.id] && (
              <>
                <dt style={{ color: "#94a3b8", marginTop: 8 }}>columns</dt>
                <dd style={{ margin: 0 }}>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {Object.values(columnLineage.nodes[selectedNode.id].columns).map((c) => (
                      <li key={c.columnName}>
                        {c.columnName}
                        {!c.hasLineage && <span style={{ color: "#64748b" }}> (unresolved)</span>}
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `packages/core/`): `npx vitest run src/App.test.tsx -t "columnEdgesFor|columns in the details panel|no columns section"`
Expected: PASS (6 tests: 4 `columnEdgesFor` unit tests + 2 details-panel
render tests).

- [ ] **Step 5: Run the full package suite and typecheck**

Run (from `packages/core/`): `npx vitest run`
Expected: all tests pass, including Task 1's 3 tests and every pre-existing
test (the `rfEdges` branch only activates when `columnLineageMode` is
true, which no pre-existing test ever sets — zero behavior change to the
model-edge path).

Run (from `packages/core/`): `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Rebuild the mext/vscode consumer bundles and run their suites**

Per this repo's parity rule (`core` is consumed as source by `mext`,
`vscode`, and `cli` — any `core` change must ship in all of them), run
(from repo root): `npm run rebuild`
Expected: succeeds, producing updated `packages/mext/dist/`,
`packages/vscode/media/`+`out/extension.js`, and
`packages/cli/dist/webview/`+`out/cli.js`.

Run (from repo root): `npm test`
Expected: all tests pass across every workspace (this task only touches
`core`, so `mext`/`vscode`/`cli` test counts are unchanged from before this
task).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/App.tsx packages/core/src/App.test.tsx
git commit -m "feat(core): render column-lineage edges and details-panel columns

columnEdgesFor() is pure and unit-tested directly (matching how
edgeOnLineage is already tested, not through rendered SVG). Node height
stays the fixed NODE_H constant — no relayout, per the design spec's
Approach C. Details panel gets a new columns section, only rendered
once column lineage has been fetched."
```

---

## Self-Review Notes

- **Spec coverage:** UI-design spec §2 (toggle state, click handler,
  button, error banner) → Task 1. §3 (edges, details panel, fixed node
  height/no relayout) → Task 2. The dropped cache-invalidation bullet is
  explicitly called out in Global Constraints with the reason, not silently
  omitted.
- **Type consistency:** `ColumnLineagePayload` (from `./columnLineage`,
  already shipped) is the single type referenced across both tasks —
  `columnLineage` state (Task 1) and `columnEdgesFor`'s parameter (Task 2)
  share the exact same shape, no re-definition.
- **No placeholders:** every step shows complete code, including exact
  insertion points relative to existing named lines/functions in
  `App.tsx`, since this is a large shared file where "similar to the
  existing pattern" would leave real ambiguity.
- **Rebuild step:** Task 2 (the one that actually changes rendered output)
  includes the `npm run rebuild` + full-suite step per this repo's
  established mext/vscode parity rule — Task 1 doesn't need it since
  nothing renders differently yet from that task alone, but bundling it
  into Task 2 (the task where core's output actually changes) is correct
  either way since Task 1's commit lands first regardless.
