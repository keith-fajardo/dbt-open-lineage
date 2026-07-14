# Selector & run UX improvements: show-all confirm, --full-refresh, run toast — design

Date: 2026-07-15
Status: approved (brainstorming), pending implementation plan

## Scope

Three small, related improvements to the DAG viewer's selector box and
Run/Build/Test feature:

1. Pressing Enter with a blank selector box currently blanks the DAG
   silently (deliberate — avoids accidentally loading the whole project).
   Instead, offer to show the whole project lineage behind a confirmation.
2. Typing `--full-refresh` in the selector box is currently a harmless,
   accidental no-op (it resolves to "matches nothing" as an unrecognized
   selector term, contributing nothing to the union). Make it a real,
   deliberate flag that reaches the underlying `dbt run/build/seed`
   invocation.
3. A run's outcome (success/failure) is currently only visible via the
   pilot lights and, on failure, a small inline banner near the toolbar —
   there's no toast-style confirmation, and the one existing toast
   mechanism only renders inside the (usually closed) details sidebar.

Bundled as one spec since all three touch the same selector/run feature
area and are individually small, but each gets its own implementation task.

## 1. Show-all confirmation on blank Enter

### Why not a native `window.confirm()`

VSCode webviews block native browser dialogs (`confirm`/`alert`/`prompt`)
entirely — a documented VSCode security restriction. This must be a custom
in-app modal to behave identically in both hosts (VSCode and Mnemo).

### Data model

A new `showAll: boolean` state in `packages/core/src/App.tsx`, orthogonal
to the `selector` string — same pattern as the existing `focus` boolean.
The four places that currently guard on `!selector.trim()` and blank the
DAG (`matched` at `App.tsx:393`, `visibleGraph` at `App.tsx:402`,
`buildNodes` at `App.tsx:477`, `rfEdges` at `App.tsx:873`) instead treat a
blank selector as "every node" when `showAll` is true — reusing
`resolveSelector`'s own existing convention that an empty query already
resolves to the whole graph (`selector.ts`: `if (!q) return new
Set(g.nodes.map(...))`). No synthetic selector string is written into the
input box; it stays visually blank. `showAll` is a separate signal, not a
selector-text hack.

### Flow

1. Enter pressed with `raw.trim() === ""` → don't commit yet. Show a
   blocking modal: **"Show all `<N>` models? Large projects may take a
   moment to render."** with **Show All** / **Cancel** buttons, where `N`
   is `graph.nodes.length` (already loaded client-side).
2. **Show All** → `setShowAll(true)`, `setFocus(true)` (matches the
   existing invariant that Enter always commits focus — visually moot here
   since nothing is dimmed when everything matches, but keeps the
   contract consistent for any code that reads `focus`).
3. **Cancel** (or dismiss) → nothing changes; selector stays blank, DAG
   stays blank — exactly today's behavior.
4. `showAll` resets to `false` whenever `raw` changes away from blank
   (the user starts typing again) — the next blank-Enter always
   re-prompts, per "ask every time." No session-level memory of a prior
   confirmation.

## 2. `--full-refresh` flag

### Detection and stripping

The raw typed selector text (`raw`/`selector` state) is checked for a
literal `--full-refresh` token (word-boundary match, e.g.
`/(^|\s)--full-refresh(\s|$)/`) and the token is stripped before the
remaining text reaches `resolveSelector` — today it silently resolves to
"matches nothing" as an unrecognized term (harmless by coincidence, not by
design); stripping makes the no-op deliberate rather than incidental.

A derived `hasFullRefresh: boolean` (true iff the token was present) is
computed the same way `hasSeed` already is, and included in the
`invoke("dbt.run", {command, selector, hasSeed, hasFullRefresh})` call —
same shape, same call site.

No visible badge/indicator for the flag, matching the existing `hasSeed`
precedent (detected and applied silently, no UI chip).

### Host: scope of the flag

- **`run` / `build`**: `--full-refresh` is appended to the main command's
  argv.
- **Seed prerequisite** (when `hasSeed` is also true): `--full-refresh` is
  ALSO appended to the `dbt seed` invocation — "full refresh" means the
  whole two-phase operation, not half of it.
- **`test`**: the flag is silently dropped — never appended to a `dbt
  test` invocation, since nothing is materialized by a test run and the
  flag is meaningless there. No error, no warning.

### Signature changes

`packages/vscode/src/host/run.ts`'s `startDbtRun` and
`startDbtRunWithSeed` gain a `fullRefresh: boolean` parameter each,
threaded through to `buildRunArgs`, which appends `"--full-refresh"` to
the argv only when both `fullRefresh` is true AND `command !== "test"`.

## 3. Run-result toast

### Why not the existing toast

The existing `toast`/`flashToast` mechanism (`App.tsx:543-548`, rendered
at `App.tsx:1557` inside the details `<aside>`) only appears while a node
is selected (sidebar open) — but a run typically starts and ends with no
node selected. Reusing it would make the run-result notification silently
invisible most of the time.

### New, separate mechanism

A new `runToast: string | null` state (mirroring `toast`'s shape but
independent), with its own render site anchored to the DAG canvas itself —
not inside the sidebar's conditional block — so it's visible regardless of
whether a node is selected. Positioned bottom-center of the canvas,
auto-dismissing after the same ~2.5s the existing toast uses.

### Trigger

In the existing `onRunEvent` handler's final `else` branch (the `done`
case, already reached for every run's terminal event): fire the toast
alongside the existing `runErr` logic — `"✓ Run succeeded"` when
`exitCode === 0`, `"✗ Run failed"` otherwise.

### Known limitation, inherited not introduced

Cancel and a genuine failure both currently produce the same
`{type:"done", exitCode:-1}` shape (SIGTERM'd processes don't distinguish
"user cancelled" from "crashed") — this ambiguity already exists in the
current `runErr` "run failed" banner and is not something this spec
addresses. The new toast will inherit the same behavior: cancelling a run
shows "✗ Run failed," same as a real failure would. Out of scope for this
change.

## Testing

- Show-all: a test that hits Enter on a blank box and asserts the modal
  appears with the correct node count; Cancel leaves the DAG blank;
  Show All reveals every node and sets `focus`; typing after a confirmed
  show-all resets `showAll` (next blank-Enter re-prompts rather than
  silently reusing `true`).
- `--full-refresh`: `hasFullRefresh` computed correctly from a selector
  string containing the token (and correctly false when absent); the
  token is stripped before selector resolution (a graph where a node is
  literally named `--full-refresh`... not applicable, dbt names can't
  contain `-` at the start, so no collision risk); the invoke call
  includes `hasFullRefresh`; host-side `buildRunArgs`/`startDbtRun` tests
  for run/build (`--full-refresh` appended), test (not appended even when
  `fullRefresh:true`), and the seed-prerequisite phase (appended to both
  phases when both `hasSeed` and `fullRefresh` are true).
- Run toast: a test that a `done` event with `exitCode:0` shows "✓ Run
  succeeded" and a nonzero exit shows "✗ Run failed"; the toast renders
  with no node selected (the common case); the toast auto-dismisses.

## Out of scope

- Distinguishing a user-cancelled run from a genuine failure in the
  `done` event contract (pre-existing limitation, not addressed here).
- A visible indicator/badge for `--full-refresh` or `hasSeed` being
  detected in the current selector.
- Remembering a "show all" confirmation across blank-Enter presses in the
  same session (explicitly rejected — always re-prompt).
