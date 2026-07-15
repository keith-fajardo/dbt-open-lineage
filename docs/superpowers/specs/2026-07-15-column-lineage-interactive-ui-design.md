# Column-level lineage (interactive extension — toggle UI) — design

Date: 2026-07-15
Status: approved (brainstorming), pending implementation plan

## Scope

Plan 2 of the interactive-extension column-lineage feature (Plan 1, the
backend `dbt.columnLineage` command, already shipped —
`2026-07-15-column-lineage-interactive-backend.md`). This spec covers the
toggle button and rendering in `packages/core` (`App.tsx`/`nodes.tsx`), plus
a required prerequisite: converting the shared `runColibri()` from
synchronous to async. Companion to
`2026-07-15-column-lineage-interactive-design.md` §3, which this spec
makes concrete.

## Why the async conversion is in scope here, not deferred

Plan 1's final whole-branch review flagged that `runColibri` uses
`spawnSync` — Node's synchronous child-process call, which blocks the
entire VSCode extension host's event loop for the whole `colibri` run
(seconds on a real project). That was harmless in Plan 1 because nothing
called the command yet. This plan is what calls it — wiring a live toggle
to a blocking host call would freeze this extension's webview updates (and
any other pending extension-host work) for the duration of every click.
Fixing it here, before the UI ships, is cheaper than shipping the freeze
and fixing it later.

## 1. Async migration (prerequisite)

`packages/colibri-runner/src/colibri.ts`: `spawnSync` → `spawn` (event-based,
non-blocking). `runColibri` becomes `async function runColibri(opts:
RunColibriOptions): Promise<ColumnLineagePayload>` — same signature
otherwise, same three error messages (not-found, non-zero-exit,
did-not-produce-output), same `--light --disable-telemetry` invocation.
Internals: listen for the child's `error` event (ENOENT → not-found
message), collect `stdout`/`stderr` via `data` events, resolve/reject on the
`close` event based on exit code, same downstream logic (check
`colibri-manifest.json` exists, read, `extractColumnLineage`).

Propagates to both consumers:
- `packages/cli/src/generate.ts`: the `columnLineage` branch already sits
  inside an IIFE; it becomes an async IIFE (`await`ed), and `generate()`
  itself becomes `async`. `packages/cli/src/cli.ts`'s `main()` awaits
  `generate(...)` — already fine as an ES module with `"type": "module"`
  (top-level await / async main supported).
- `packages/vscode/src/host/columnLineage.ts`: `runColumnLineageForProject`
  becomes `async`, `await`s `runColibri`. `extension.ts`'s `case
  "dbt.columnLineage":` adds `await` — trivial, since `handleMessage` is
  already `async` and other cases (`dbt.compile`, `dbt.gist`) already await
  their own host calls.

No behavior change other than non-blocking-ness — same errors, same output,
same tests (rewritten to mock `spawn`'s event-emitter shape instead of
`spawnSync`'s return value, asserting identical error conditions).

## 2. Toggle state (`packages/core/src/App.tsx`)

Four new pieces of state, following the existing `gistBusy`/`saveErr`
pattern used by the gist ✨ button:

- `columnLineageMode: boolean` (default `false`) — is the toggle on.
- `columnLineage: ColumnLineagePayload | null` (default `null`) — fetched
  data, `null` until first successful fetch.
- `columnLineageBusy: boolean` — fetch in flight.
- `columnLineageErr: string | null` — last fetch error, if any.

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

Toggle button: same pill-button styling as the regex-mode `.* ` toggle
(`aria-pressed`, border/background keyed off state), labeled "Columns",
`title="Show column-level lineage"`. While `columnLineageBusy`, the button
shows a "loading…" label and is not re-clickable (mirrors the gist
button's `disabled={gistBusy}` treatment). `columnLineageErr` renders as an
inline red banner immediately after the button, identical treatment to the
existing `regexError` span.

**Cache invalidation:** `load()` (the function backing both `dbt.manifest`
on mount and `dbt.compile` on the Compile button) gains `setColumnLineage(null);
setColumnLineageMode(false);` at its top — a fresh compile always drops
back to the off state, requiring an explicit re-toggle rather than
auto-refetching against the new manifest.

## 3. Rendering — fixed node height, canvas edges, details-panel columns

Chosen over two alternatives (full node-card expansion with per-column
React Flow handles; details-panel-only with no canvas edges) specifically
to avoid touching `packages/core/ARCHITECTURE.md`'s layout invariants —
`NODE_H` stays the constant 44px, dagre never relayouts on toggle.

**Edges** (`App.tsx`'s `rfEdges` `useMemo`, `packages/core/src/App.tsx:963`):
when `columnLineageMode && columnLineage`, fully replace the model-edge
computation with column edges instead of overlaying:

```ts
if (columnLineageMode && columnLineage) {
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

`columnLineageMode`/`columnLineage` added to the `useMemo`'s dependency
array. Existing `focus`/`pruned` filtering logic is reused as-is (same
node-id-set semantics apply to column edges' `source`/`target`).

**Known v1 limitation:** multiple columns flowing between the same node
pair render as visually stacked/overlapping edges (React Flow doesn't
auto-fan same-pair edges by default) — the per-edge label distinguishes
them on hover/zoom, but no custom curve-offset logic is in this pass.
Documented, not silently accepted — see Out of scope.

**Details panel** (`App.tsx`, alongside the existing `tests`/`logs`
`<dt>`/`<dd>` fields, matching that exact pattern): a new `columns` section,
rendered only when `columnLineage` is non-null AND the selected node has an
entry in `columnLineage.nodes`:

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

No columns section at all when `columnLineage` is `null` (toggle never
clicked, or reverted after an error) — matches the existing "logs" field's
"only rendered once there's data" convention, keeping the common case
uncluttered.

## 4. Testing

- `packages/colibri-runner/src/colibri.test.ts`: rewritten for `spawn`'s
  event-emitter mock shape (`error`/`data`/`close` events instead of a
  return value) — same 4 cases (happy path, not-found, non-zero-exit,
  missing-output), same assertions on the thrown/resolved values.
- `packages/cli/src/generate.test.ts`, `packages/vscode/src/host/columnLineage.test.ts`:
  existing tests updated to `await` `generate()`/`runColumnLineageForProject()`
  respectively — same mocked-`runColibri` assertions, now resolving/rejecting
  a Promise instead of returning/throwing synchronously.
- `packages/core/src/App.test.tsx`: toggle-click → loading state →
  rendered column edges + details-panel columns section (mocked
  `invoke("dbt.columnLineage", ...)` resolving); toggle-click → error
  banner + toggle reverts to off (mocked rejection); a subsequent
  `dbt.compile` after column lineage is loaded clears both `columnLineage`
  and `columnLineageMode` back to off.

## Out of scope

- Fanning/offsetting multiple same-pair column edges — documented v1
  limitation (§3), not fixed here.
- Per-column React Flow handles / node-height expansion (Approach A,
  explicitly not chosen).
- Auto-refetch on compile (cache invalidation clears state; re-fetch
  requires an explicit re-toggle, per §2).
- Mnemo's own `dbt.columnLineage` Rust/Tauri handler — still a separate,
  out-of-repo follow-up per the backend spec's repo-boundary note; this
  plan's UI code is host-agnostic (same `App.tsx` renders for both VSCode
  and Mnemo once each host implements the command).
