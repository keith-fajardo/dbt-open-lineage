# Run seeds as a prerequisite — design

Date: 2026-07-15
Status: approved (brainstorming), pending implementation plan

## Problem

`dbt run` (and `dbt test`) can never build a seed, no matter what a
`--select` selector contains — dbt excludes seeds from those commands by
resource type, not by selection scope. So when a model in the active DAG
view depends on a seed, clicking Run (or Test) silently does nothing for
that seed, and the dependent model can fail or read stale/missing data.
`dbt build` already handles seeds (it runs seeds, snapshots, models, and
tests together in dependency order), but that changes Run's behavior by
always adding tests, which isn't what "Run" means today.

## Approach

When the active selection (the same node set `buildSelector` already turns
into the `--select` string) includes at least one seed, run
`dbt seed --select <selector>` first, then the originally-requested command
(`run`/`build`/`test`) with the *same* selector string. Each dbt command's
own resource-type filtering naturally picks out just the entries it cares
about from that one shared selector — a seed-only invocation doesn't need
a separately-built selector string.

If the seed phase fails, the main command does not run — a model that
depends on a seed that failed to load is likely to fail or produce wrong
data anyway, so stopping there and surfacing the seed failure clearly is
safer than proceeding and producing a confusing downstream failure.

## Detection

`packages/core/src/App.tsx` already computes `activeIds` (the run's node
scope) from `graph.nodes`, which carries `resource_type`. Add:

```ts
const hasSeed = graph
  ? graph.nodes.some((n) => activeIds.has(n.id) && n.resource_type === "seed")
  : false;
```

`onRun` passes `hasSeed` as a new field alongside the existing
`{command, selector}` in the `invoke("dbt.run", ...)` call. No other
webview-side change — the pilot light / queued-status machinery already
treats every `RunEvent` the same regardless of which underlying dbt
invocation produced it.

## Host orchestration (`packages/vscode/src/host/run.ts`)

A new wrapper, `startDbtRunWithSeed(projectRoot, command, selector, hasSeed,
cb, deps)`, sitting alongside the existing `startDbtRun` (left untouched,
still single-purpose and independently testable):

- `hasSeed === false` → calls `startDbtRun(projectRoot, command, selector,
  cb, deps)` directly; behavior is byte-identical to today.
- `hasSeed === true`:
  1. Calls `startDbtRun(projectRoot, "seed", selector, seedCb, deps)`.
     `seedCb.onWrite` forwards straight to `cb.onWrite` (one continuous
     Output-panel log spanning both phases). `seedCb.onEvent` forwards
     `status` events straight to `cb.onEvent` (pilot lights update live
     during the seed phase) but **swallows the seed phase's own `done`
     event** rather than forwarding it — the wrapper inspects its
     `exitCode` internally instead.
  2. Seed phase `exitCode !== 0` → the wrapper immediately emits
     `{type:"done", exitCode}` to `cb.onEvent` with the seed's exit code,
     and returns — the main command is never started.
  3. Seed phase succeeds → the wrapper calls `startDbtRun(projectRoot,
     command, selector, cb, deps)` exactly as today; that call's own
     `done` event is what finally reaches the webview.
- **Cancel**: the wrapper's returned `RunController` holds a mutable
  reference to whichever phase's `RunController` is currently live (the
  seed phase's, then swapped to the main command's once that phase starts)
  and delegates `.cancel()` to it, so Cancel works correctly regardless of
  which phase is in flight when it's clicked.

## Extension wiring (`packages/vscode/src/extension.ts`)

The `"dbt.run"` case reads `hasSeed` from `msg.args` and calls
`startDbtRunWithSeed` instead of `startDbtRun`. `activeRun`, the
already-in-progress guard, and the Output-channel setup are unchanged —
still exactly one logical run, one continuous log, for the whole
(optionally) two-phase sequence.

## Testing

- `App.tsx`: `hasSeed` computes correctly (true only when a seed node is in
  `activeIds`) and is included in the `dbt.run` invoke call.
- `run.ts`: unit tests for `startDbtRunWithSeed` using the existing
  fake-child-process pattern — seed-success-then-main-runs,
  seed-failure-aborts-with-its-exit-code, cancel-during-seed-phase,
  cancel-during-main-phase, and `hasSeed:false` bypassing straight to the
  existing single-phase path (a regression guard that the common case
  stays untouched).
- Reuses the real `dbt seed --log-format json` schema already captured and
  verified this session (`resource_type: "seed"`, top-level `node_info`,
  same `node_status` values as models) — no new schema risk, `dbt seed`'s
  output already matches the shape `parseDbtLogLine` handles.

## Out of scope

- The Output-panel logging issue currently being diagnosed separately is a
  bug, not a design decision, and isn't part of this spec.
- The "show all lineage on empty selector + Enter, with a confirmation
  prompt" feature is a separate, unrelated change, queued for its own
  design pass after this one.
