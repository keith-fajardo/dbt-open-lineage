# Design: Raw/Compiled SQL in the details drawer

**Date:** 2026-07-22
**Status:** Approved (pending spec review)
**Scope:** VSCode extension + Mnemo `.mext` (shared core UI + two host handlers)

## Problem

The DAG's details side drawer shows a model's metadata (type, materialization,
path, tags, description, gist) but not its SQL. A user inspecting a node has no
way to see what the model actually does without leaving the graph and opening the
file. Add the model's SQL to the drawer, with a toggle between the **raw source**
(`raw_code`, Jinja intact) and the **compiled** SQL (`compiled_code`, rendered).

## Goals

- Show the selected model's SQL inside the details drawer.
- Toggle **Raw** (default) ｜ **Compiled**.
- Read-only, scrollable, copyable.
- Works in both the VSCode extension and the Mnemo `.mext` (parity).

## Non-goals (YAGNI)

- No inline syntax highlighting (keeps the webview bundle light).
- No editing of SQL.
- No new "open in editor" affordance — the existing double-click already opens
  compiled SQL as a virtual doc.
- No length cap — model source files are small; the existing 100k cap on the gist
  prompt is a token concern, not applicable to display.

## Architecture

Reuse the existing host-agnostic bridge (`packages/core/src/bridge.ts`). Its
generic `invoke<T>(cmd, args)` already carries arbitrary host commands, so **no
`Bridge` interface change** is required. Add one new command:

    dbt.modelSql  { id: string }  ->  { raw: string; compiled: string }

Both fields come from the selected node in `target/manifest.json`:
- `raw` = node `raw_code` (source, Jinja intact)
- `compiled` = node `compiled_code` (`""` if the model was never compiled)

One manifest parse returns both.

## Components (three targets)

### 1. `packages/core/src/App.tsx` — shared drawer UI

Add a "sql" section to the details drawer `<dl>` (after the existing fields).

- **State:**
  - `modelSql: { raw: string; compiled: string } | null`
  - `sqlLoading: boolean`
  - `sqlErr: string | null`
  - `sqlMode: "raw" | "compiled"` (default `"raw"`)
- **Fetch:** a `useEffect` keyed on `selectedNode?.id`. On change: reset state,
  set loading, call `invoke<{raw,compiled}>("dbt.modelSql", { id })`, store the
  result (or `sqlErr` on reject). Guard against a stale response overwriting a
  newer selection (ignore the resolve if the selected id changed meanwhile).
- **Render:**
  - A Raw｜Compiled segmented control (two buttons; active one highlighted).
  - A scrollable read-only `<pre>` — monospace, `maxHeight` ~300px,
    `overflow: auto`, wrapping off (horizontal scroll for long lines).
  - A Copy button (writes the currently-shown text to the clipboard).
  - **Empty/edge states:** while loading → "loading…"; on `sqlErr` →
    "SQL unavailable — run `dbt compile`"; when `sqlMode === "compiled"` and
    `compiled === ""` → "Not compiled yet — run `dbt compile`" (Raw still shows).

### 2. VSCode host — `packages/vscode/src/host/compiledSql.ts` + `extension.ts`

- Extend `compiledSql.ts` with:

      export interface ModelSql { raw: string; compiled: string }
      export function modelSqlFromManifest(manifestJson: string, uniqueId: string): ModelSql
      export function readModelSql(root: string, uniqueId: string): ModelSql

  Reads both `raw_code` and `compiled_code` in one parse. Throws when the node id
  isn't in the manifest (same contract as `compiledCodeFromManifest`). Keep the
  existing `compiledCodeFromManifest`/`readCompiledSql` untouched (the virtual-doc
  feature still uses them).
- Add `case "dbt.modelSql"` in `extension.ts`: resolve project root, call
  `readModelSql(root, msg.args.id)`, `reply({ ok: true, result })`.

### 3. Mnemo app host (separate repo) — `dbt.modelSql` handler

The `.mext` bridge forwards `invoke` generically, so no `packages/mext` change.
The Mnemo host (the iframe parent) must implement `dbt.modelSql` reading its bound
project's `target/manifest.json`, mirroring the VSCode handler. Done via a
subagent in the Mnemo repo (per project convention for host-repo changes).

## Data flow

    select node
      -> core useEffect (keyed on selectedNode.id)
      -> invoke("dbt.modelSql", { id })
      -> host reads <root>/target/manifest.json, node[id]
      -> { raw: raw_code, compiled: compiled_code }
      -> drawer renders modelSql[sqlMode]

## Error handling

| Condition                     | Behavior                                             |
|-------------------------------|------------------------------------------------------|
| manifest missing / node absent| host rejects; drawer shows "SQL unavailable — run `dbt compile`" |
| `compiled_code` empty         | Raw works; Compiled tab shows "Not compiled yet — run `dbt compile`" |
| selection changes mid-fetch   | stale resolve ignored (id guard)                     |

## Testing

- **`packages/vscode/src/host/compiledSql.test.ts`** — add `readModelSql` /
  `modelSqlFromManifest` cases: both fields present; `compiled_code` empty
  (raw still returned); node id missing (throws).
- **`packages/core/src/App.test.tsx`** — with a fake bridge whose `invoke`
  resolves `dbt.modelSql`: drawer renders the SQL section on selection; toggle
  switches raw↔compiled; compiled-empty state shows the hint; fetch-reject shows
  the error.

## Rollout

Ship core + VSCode together (parity rule); bump vscode + rebuild `.vsix`
(`scripts/rebuild-consumers.sh --vscode-only`) on release. Mnemo host handler
shipped in its own repo via subagent. No npm publish.
