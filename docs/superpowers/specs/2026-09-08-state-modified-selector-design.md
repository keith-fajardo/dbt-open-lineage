# `state:` selector method — design

**Date:** 2026-09-08
**Status:** approved design, pre-implementation
**Scope:** live IDE surfaces only (VSCode extension + Mnemo `.mext`). Static CLI export excluded.

## Goal

Support dbt's `state:` selector family in the DAG viewer's selector box, e.g.
`state:modified+ --defer --state target/prod/`. The `--defer --state <dir>`
run-flag passthrough already shipped (commit `ae5b30c`); this spec covers the
`state:modified+` *selector* half.

## Why this is architectural (not a new selector method like the others)

Every existing method (`tag:`, `source:`, `config.materialized:`,
`resource_type:`, `unused:`, `config.meta.*`) reads metadata already present on
the single loaded graph — pure, synchronous, structural (`selector.ts`).

`state:` is categorically different: it requires **diffing the current manifest
against a prior manifest** (the one in `--state <dir>`). Two hard blockers make
an in-node diff a poor fit:

1. The manifest parser deliberately drops the fields dbt's modification check
   hinges on — `checksum` and `raw_code` (`manifest.ts:52`). The loaded graph
   literally cannot answer "did this node change."
2. dbt's real `state:modified` is multi-faceted (body checksum, config, columns,
   tests, contract, relation name, macros, vars, env). Reimplementing it
   in-node would be "close but wrong" — a fidelity trap for a feature that
   drives real deferred prod runs.

## Decision: delegate resolution to `dbt ls`

When a committed selector contains a `state:` term, hand the **whole** cleaned
expression to a new async host command that runs
`dbt ls --select "<expr>" --state <dir> --output json --output-keys unique_id`
and returns the matched node `unique_id`s. dbt itself computes the diff, so the
entire `state:*` family works (`modified`, `modified.body`, `new`, `unmodified`,
`modified.contract`, …), as do hops / unions / `--exclude` / mixed methods
(`state:modified+ tag:mart`) — dbt resolves the full expression.

`unique_id` (not name) is used because it maps directly onto graph node ids; the
webview filters to ids the graph knows and drops the rest (tests, etc.).

Rejected alternative: in-node manifest diff (load `<dir>/manifest.json`, add
`checksum` to the parser, compare). Synchronous but reimplements dbt's
semantics — rejected on fidelity grounds.

## Resolution flow (webview — `packages/core`)

Selection commits on **Enter only**, not per keystroke (`App.tsx:514-519`; live
auto-filter was removed because it froze large projects). So an async resolve on
commit is safe — no debounce gymnastics.

- New pure helper `hasStateSelector(expr): boolean` in `selector.ts` — true if
  any whitespace/comma-separated term's method is `state` (after stripping
  `+`/`Ndigit` hop operators).
- New App state: `asyncMatched: Set<string> | null`, `matchBusy: boolean`,
  `matchError: string | null`, and a monotonic `matchReq` ref for single-flight.
- Effect keyed on `[selector, graph]`: if `hasStateSelector(cleanedSelector)`,
  bump `matchReq`, call
  `invoke<string[]>("dbt.ls", { select: cleanedSelector, state: runFlags.state })`,
  and commit the result **only if still the current request** when the promise
  settles — mirrors the existing `fetchColumnLineage` / `columnLineageReq`
  single-flight pattern (`App.tsx:539`), so a superseded/raced resolve drops its
  result instead of clobbering a newer one.
- `matched` derivation: state-mode → `asyncMatched ?? emptySet`; otherwise the
  existing synchronous `resolveSelector(graph, cleanedSelector)`. The run
  pipeline is unchanged — `buildSelector` already derives the run selector from
  matched node **names**, so the deferred `dbt run` selector still works.

`runFlags.state` (already parsed by `parseRunFlags`) supplies the `--state` dir
for **both** the selector resolution and the deferred run — one token, both
jobs.

## Host command `dbt.ls`

### VSCode (`packages/vscode/src/host/`)

- `buildLsArgs(select, state)` →
  `["ls", "--select", select, "--state", state, "--resource-type", "model", "snapshot", "seed", "source", "--output", "json", "--output-keys", "unique_id"]`.
  Resource types restricted to the four the DAG shows.
- Spawn via the existing `defaultDeps.spawn` + `LineBuffer` machinery; collect
  stdout, parse each JSON line's `unique_id`, return `string[]`. A malformed /
  non-JSON line is ignored (never throws), matching `parseDbtLogLine`.
- Wire a `case "dbt.ls"` into the `extension.ts` invoke handler, returning the
  id array to the webview through the existing invoke round-trip.

### mext parity (`packages/mext`)

- Add `dbt.ls` to `packages/mext/manifest.json` `host_perms` and repack — per
  the standing allowlist rule, an un-allowlisted bridge command is silently
  blocked by Mnemo (`pack.mjs` zips the manifest verbatim).

### Mnemo host (separate repo)

- Implement `dbt.ls` to run the same `dbt ls` and return `unique_id`s.
  Done via a subagent in the Mnemo host repo (parity + host-change rules); not
  edited inline from this repo.

## Error handling & UX

- `state:` term present but **no `--state <dir>`** → set `matchError`
  ("state: selectors need --state <dir>"), skip the host call. Rendered like the
  existing `regexError`.
- `dbt ls` exits non-zero (bad/missing state dir, no prior manifest) →
  `matchError` = stderr tail.
- Empty result → empty `matched` (valid: nothing modified).
- In flight → `matchBusy` drives a small spinner near the selector box.

## Testing (TDD, tests first)

**core:**
- `hasStateSelector` unit tests (bare, hops `+state:modified`, comma-intersect
  `state:modified,tag:mart`, negative cases).
- App test: committing `state:modified+ --defer --state target/prod/` calls
  `invoke("dbt.ls", { select: "state:modified+", state: "target/prod/" })` and
  `matched` reflects returned ids.
- App test: `state:` term with no `--state` → `matchError`, no host call.
- App test: superseded resolve is dropped (single-flight).

**vscode:**
- `buildLsArgs` arg-order / resource-type / output-keys tests.
- stdout-JSON → ids parse tests, including a malformed line ignored.
- `extension.ts` `dbt.ls` handler wiring.

**mext:**
- `manifest.json` `host_perms` includes `dbt.ls`.

## Out of scope

- Static CLI export (no live dbt at view time).
- Result caching keyed on `(expr, state dir, manifest mtime)` — a cheap
  follow-on once the base feature lands.
- Version bumps / `.vsix` repack / `rebuild-consumers.sh` — only on an explicit
  "release".
