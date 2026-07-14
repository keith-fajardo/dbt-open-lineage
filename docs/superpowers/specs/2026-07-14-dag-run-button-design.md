# DAG run/build/test button — design

Date: 2026-07-14
Status: approved (brainstorming), pending implementation plan

## Goal

Add a Run/Build/Test control to the DAG viewer that executes the models
currently active in the view (selector-matched ∪ category-filtered), streams
dbt's output into a real terminal, and shows a live per-node pass/fail/running
pilot light on the graph itself.

## Scope

- **VSCode**: full implementation this pass — UI, execution, streaming,
  pilot light.
- **Mnemo (mext)**: webview UI + the host bridge *contract* (new `invoke`
  commands and push-event channel) land now. Actual shell-exec on the Mnemo
  side is Rust/Tauri work in the sibling Mnemo repo, out of scope for this
  repo — tracked as a follow-up spec there, built against the contract
  defined here. The Run button stays disabled in Mnemo until that lands.
- Out of scope: parallel/queued runs (a run blocks further runs; the button
  becomes Cancel while one is active), remote/CI execution, run history.

## Active model set → dbt selector

"Currently active in the DAG" = union of two existing view-state sets:

- `matched` — the selector-box result (`App.tsx:393`, hide-based, populated
  when Focus is on)
- `filtered` — the subject-area/label/tag chip result (`App.tsx:703`,
  currently dim-only)

A blank selector box → the DAG itself renders nothing (existing behavior,
`App.tsx`: `visibleGraph` returns `{nodes:[],edges:[]}` whenever the selector
is empty, regardless of any category filter) — so a blank selector means an
**empty** active set, not "the whole graph." Populating the selector box is
required before Run does anything; this avoids a blank-screen click
accidentally kicking off a full-project `dbt run`. Once the selector is
non-blank, the active set is `matched ∪ filtered` (filtered treated as
contributing nothing when no category filter is active).

New pure function, `packages/core/src/selector.ts`:

```ts
function buildSelector(nodeIds: Set<string>, graph: Graph): string
```

- Restricts to `resource_type` in `{model, seed, snapshot}` — sources aren't
  runnable; tests aren't graph nodes and come along for free via
  `dbt test -s <models>`.
- Joins `node.name` (dbt selector syntax matches by name; `node.id` is the
  manifest's `unique_id` key, a different string).
- Empty result after restriction → the Run button is disabled with a tooltip
  ("no runnable models in current view"), not a wasted invocation.

Confirmed fact: graph node `id` **is** the manifest's `unique_id`
(`manifest.ts:31,45`). dbt's `--log-format json` node events key on
`node_info.unique_id`, so status events map onto graph node ids with zero
translation.

## UI

- Split-button "▶ Run ▾" in toolbar row 0 (`App.tsx:836-919`), next to the
  Focus/selector controls, same visual pattern as the existing `Export ▾`
  dropdown. Dropdown items: Run / Build / Test.
- While a run is active, the button becomes "■ Cancel" — a second click
  during a run is blocked, not queued and not run in parallel (dbt against
  the same target concurrently risks resource/lock contention).
- Pilot light: a thin animated bar along the **top edge** of each `DagNode`
  (`nodes.tsx`), colored by status:
  - idle → no bar
  - running → animated blue sweep
  - success → solid green
  - failed → solid red
  - skipped → solid amber
  Chosen over a corner-dot and a border-glow variant (see mockups in
  `.superpowers/brainstorm/`) — a border-glow override would visually
  collide with the existing "open model" ring and search-hit amber ring.
- Status state lives in `App.tsx` as `runStatus: Map<nodeId, Status>`, fed by
  the new bridge push channel, read by `DagNode`. Cleared at the start of
  each new run; nodes the run hasn't reached yet keep their prior state
  (idle on a first run, last result on a re-run).

## Execution & streaming

VSCode's existing `vscode.Task` infra (`compile.ts`) only exposes an exit
code, not live stdout — insufficient for a live pilot light. Run/Build/Test
use a different mechanism: `vscode.Pseudoterminal` backed by
`child_process.spawn`, giving a real terminal UI (the process's actual
stdout) while the extension also owns the stream to parse it.

Single dbt invocation per run:

```
dbt <run|build|test> --select <selector> --log-format json
```

Per output line:
1. `JSON.parse(line)` — on failure, write the raw line to the terminal and
   skip status parsing (a malformed/partial line must not crash the run).
2. Write the parsed `msg` field to the terminal — reads like normal dbt
   output, not raw JSON.
3. If `node_info` is present, emit a status event keyed by
   `node_info.unique_id` / mapped `node_info.node_status`.

### Bridge contract (`packages/core/src/bridge.ts`)

New push channel, same shape as the existing `onContext`:

```ts
onRunEvent(cb: (e: RunEvent) => void): () => void

type RunEvent =
  | { type: "status"; nodeId: string; status: Status }
  | { type: "done"; exitCode: number };
```

New invoke commands, mirroring the existing `dbt.compile` pattern
(`extension.ts:95-104`):

- `dbt.run({ command: "run" | "build" | "test", selector: string })`
- `dbt.cancel()`

### Host wiring

- **VSCode** (`extension.ts`): `"dbt.run"` starts the Pseudoterminal-backed
  process, rejecting if one is already active (backs the Cancel-blocks-new-run
  behavior). `"dbt.cancel"` kills the **process group**, not just the child
  pid — killing only the direct pid leaves orphaned dbt/db-adapter children
  running, the same class of bug as the known agent-cancel issue elsewhere.
  Any node still `running` when a run ends (success, failure, or cancel)
  flips to `skipped`, never left spinning.
- **Mnemo** (`mext/src/bridge.ts`): `invoke`/`onRunEvent` forwarded to
  `window.parent` via the same origin-checked postMessage RPC already used
  for `onContext`. No host-side exec yet (see Scope).

## Error handling

- `dbt` not found / spawn fails → error toast (existing pattern) + the raw
  spawn error written to the terminal.
- A model fails mid-run → dbt continues without `--fail-fast`; that node's
  pilot light goes red, dbt's own downstream skip logic produces `skipped`
  node-status events for anything depending on it. Overall pass/fail comes
  from the process exit code at the `"done"` event.
- Cancel mid-run → process-group kill (see above), in-flight nodes settle to
  `skipped`.

## Testing

- `buildSelector`: unit tests for filter-union, resource-type restriction,
  and empty-result cases.
- JSON-log line parser (`line: string → RunEvent | null`): unit tests using
  real `dbt --log-format json` sample lines (success/fail/skip node events,
  and a deliberately malformed line).
- VSCode Pseudoterminal wiring: dependency-injected like the existing
  `TaskDeps` (`compile.ts:54`) so spawn/kill are mockable.
- Mnemo bridge contract: unit-tested the same way as the existing
  `mextBridge` tests (`bridge.test.ts`) — contract shape only, no real exec
  to test yet.

## Follow-up (separate spec, sibling Mnemo repo)

A Mnemo/Tauri Rust command that actually spawns and streams dbt output to
the mext webview, implementing the `dbt.run` / `dbt.cancel` / `onRunEvent`
contract defined above. Scoped and built against this contract once written.
