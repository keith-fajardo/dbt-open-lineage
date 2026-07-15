# Column-level lineage — design

Date: 2026-07-15
Status: deferred — superseded by decision to prototype dbt-colibri
(Python/sqlglot) integration in a separate repo first. No implementation
planned against this spec for now. Kept for the engine-options research.

## Scope

A toggle-able column-level lineage view layered onto the existing model-level
DAG. When on, nodes show their output columns and edges redraw as
column-to-column instead of model-to-model; when off, the graph is unchanged
from today. TS-native — no Python dependency, no subprocess.

## Why not dbt-colibri

dbt-colibri (Python, sqlglot-based) already solves this well, but adopting it
means shelling to a Python CLI, requiring `pip install dbt-colibri` in the
user's environment, and consuming an upstream JSON schema we don't control.
Rejected in favor of staying TS-native — the whole project is currently pure
TS/npm workspaces, and the user explicitly wants to avoid a Python dependency
(subprocess spawn latency, an extra install story on top of `dbt` itself).

## 1. Inference engine — spike-gated

The hard part is dialect-aware column resolution through CTEs, joins, and
`SELECT *`. Two credible TS-native paths exist:

- **`@polyglot-sql/sdk`** (tobilg/polyglot, MIT, Rust→WASM, 30+ dialects
  including Redshift/Snowflake/BigQuery/Postgres). Ships a purpose-built
  `lineage(column, sql, dialect?)` API with OpenLineage-compatible output,
  CTE/join/subquery resolution. Repo is ~6 months old (created 2026-01-15),
  886★, single maintainer, pre-1.0 (v0.6.0), ~weekly release cadence, 45 open
  issues. Real and actively iterating, but not production-hardened.
- **`node-sql-parser`-based heuristic** — parser-only (no built-in lineage),
  so we'd build resolution ourselves: parse the top-level SELECT list and CTE
  chain, classify each output column as resolved or unknown. More scope to
  build, but no dependency on a pre-1.0 single-maintainer package.

**Sequencing: spike Polyglot first.** Timeboxed (few hours) go/no-go test
against real compiled SQL pulled from an actual Redshift dbt project — not
synthetic examples. Pass (handles the Redshift dialect, CTEs, common join
shapes without throwing) → Polyglot becomes the engine, skip building a
parser. Fail → build the `node-sql-parser` heuristic instead.

Either way, the engine sits behind one interface (see §4) so the choice is
swappable without touching UI code.

## 2. Data pipeline

`manifest.ts` currently extracts `name`, `resource_type`, `path`,
`description`, `tags`, `materialized`, `meta`, `tests`, `patch_path` per node
— no SQL. Add `compiled_code` (only present in `manifest.json` after `dbt
compile`/`dbt run` has been run against current state) to `GraphNode`. The
host already triggers compile (`packages/vscode/src/host/compile.ts`), so
this is one more field read, not a new host command.

If `compiled_code` is absent for a node (never compiled since last manifest
regen), that node's columns render as "unknown" — the rest of the graph is
unaffected.

## 3. New module: `columnLineage.ts`

`packages/core/src/columnLineage.ts`, pure (no host imports, same
Bridge-isolation rule as every other core module). Interface:

```ts
function computeColumnLineage(
  compiledSql: string,
  dialect: string,
): { columns: ColumnRef[]; edges: ColumnEdge[]; unresolved: string[] }
```

Wraps whichever engine wins the spike. Called per-node when column-lineage
mode is toggled on and that node is visible; results cached by node id +
compiled-SQL hash (mirrors the existing `hashConfig.ts` pattern) so toggling
or panning doesn't re-parse unchanged SQL.

## 4. UI / toggle

New `ViewState.columnLineage: boolean` (default `false`), toggle button in
the toolbar alongside Focus/Apply-Filter, same pill-button visual treatment
as the regex-mode toggle.

- **Off** (default): today's model-level graph, unchanged.
- **On**: each visible node's card expands to list its output columns
  (parsed from the top-level SELECT list). Edges redraw column-to-column:
  solid where resolved, dashed grey where unknown. Clicking a column
  highlights its full upstream/downstream column chain, reusing the existing
  `up`/`down` dim-channel pattern in `viewContext.ts` — no new dim-channel
  concept, just a finer-grained id space (`nodeId::columnName` instead of
  `nodeId`).

## 5. Error handling

- Parser throw or dialect mismatch on a given node's SQL → caught per-node,
  that node's columns marked "unknown"; does not block the rest of the
  graph.
- No `compiled_code` at all → same "unknown" treatment, plus an inline hint
  ("run dbt compile to enable column lineage") rather than a silent gap.
- Column lineage is additive and non-destructive: turning it off always
  restores the exact model-level graph state from before it was turned on.

## 6. Testing

- `columnLineage.ts` unit tests with fixture SQL snippets: simple
  `SELECT`/alias, linear CTE chain, single-source `SELECT *`, multi-table
  join `SELECT *` (expect unknown), window function (expect unknown) —
  same fixture-driven pattern as `selector.test.ts`/`yamlEdit.test.ts`.
- Toggle + column-edge rendering gets an `App.test.tsx`-style render test:
  toggle on shows column cards and column edges; toggle off restores the
  exact prior model-level render.
- Regression: with the toggle off, every existing DAG test is unaffected
  (new field on `GraphNode` is additive/optional).

## Out of scope (v1)

- Schema-aware resolution via `catalog.json` (`lineageWithSchema`) — stretch,
  only if MVP "unknown" rate on real projects feels too high after
  shipping.
- Cross-project / cross-package column lineage (dbt Mesh `ref()` across
  projects) — not requested.
- Persisting the toggle's on/off state across sessions — defaults to off
  every time, same as every other toolbar toggle in this codebase.
- Column-level annotations (gist/callout/labels at the column grain) —
  separate feature, not part of this spec.

## Open risk

Polyglot's real-world accuracy on Redshift-dialect compiled dbt SQL is
unverified beyond its README — the spike in §1 exists specifically to
resolve this before committing to it as the engine.
