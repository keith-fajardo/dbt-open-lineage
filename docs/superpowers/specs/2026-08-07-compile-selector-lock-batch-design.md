# Design: silent compile, compile analyses, `unused:staging`, lock lineage

Date: 2026-08-07
Status: approved (design), pending implementation plan

## Overview

A batch of four user-requested changes to the dbt Open Lineage DAG viewer
(monorepo: `packages/core` shared React app + selector engine, `packages/cli`
static export, `packages/vscode` VSCode host, `packages/mext` Mnemo host
bridge). Each item below records the surface(s) it touches and why.

| # | Change | Surface(s) | Shared? |
|---|--------|-----------|---------|
| 1 | Silent compile (no Terminal) | VSCode host | VSCode-only |
| 2 | Compile analyses files | VSCode host + Mnemo host | needs subagent for Mnemo |
| 3 | `unused:staging` selector | `core/selector.ts` | auto covers CLI + VSCode + Mnemo |
| 4 | Lock lineage during run | `core/App.tsx` | auto covers all surfaces |

Cross-cutting constraints: **no regression** (run each package's vitest suite
after every change; features 3 and 4 are written test-first), and **mext ↔
vscode parity** with lockstep version bumps and consumer rebuilds.

Implementation order: **3 → 1 → 4 → 2** — pure shared logic first, the Mnemo
host subagent last.

---

## 1. Silent compile (VSCode only)

### Problem
Two VSCode compile paths build a `vscode.Task` with a `ShellExecution`
(`host/compile.ts` `makeCompileTask` / `makeCompileSelectTask`, driven by
`runTaskToCompletion`). A shell Task forces VSCode to reveal the **Terminal**
panel, yanking the user's focus off whatever tab they were on. This is the same
complaint that already ruled Tasks out for `dbt.run`.

Confirmed VSCode-only: Mnemo runs compile natively (no Terminal concept) and
the CLI's `dbt.compile` just returns the embedded graph (no real compile). So
this item does not touch `core`, `cli`, or `mext`.

### Approach
`host/run.ts` already solved this for runs: spawn `dbt` via `child_process`
with `resolveBin("dbt")`, buffer stdout/stderr with `LineBuffer`, and stream
lines to the dedicated **"dbt Open Lineage"** `OutputChannel` **without** calling
`.show()`. Compile borrows the same path.

Add one helper to `host/run.ts`:

```ts
/** Spawn `dbt <args>` in root, stream every output line to onWrite,
 * resolve with the exit code (or -1). No shell, no Task, no Terminal. */
export function spawnDbtToCompletion(
  root: string,
  args: string[],
  onWrite: (line: string) => void,
  deps: RunDeps = defaultDeps,
): Promise<number>
```

Reuses the existing `defaultDeps.spawn` (`resolveBin("dbt")`, `detached` on
non-Windows) and `LineBuffer`. Compile output is plain text — no
`--log-format json`, no per-node status parsing.

Wire-up in `extension.ts`:
- `case "dbt.compile"`: `const code = await spawnDbtToCompletion(projectRoot,
  ["compile"], (l) => channel.appendLine(l));` where `channel =
  getRunOutputChannel()` (cleared first, header appended, never `.show()`n).
  Then parse `target/manifest.json` and reply the graph exactly as today.
- `dbt-open-lineage.recompile` command: same spawn with
  `["compile", "--select", name]`, still wrapped in the existing
  `vscode.window.withProgress({location: Notification, title: "Recompiling
  <name>…"})` spinner. On non-zero exit, keep the existing
  `showErrorMessage`.

### Cleanup
`makeCompileTask`, `makeCompileSelectTask`, `compileSelectArgs`, and
`runTaskToCompletion` become unused. Remove them and their `compile.test.ts`
coverage; replace with tests for `spawnDbtToCompletion` (injected `spawn` dep,
assert args, streamed lines, resolved exit code) mirroring the existing
`run.ts` test style.

### Non-goals
Compile stays non-cancellable (matches today; the progress spinner is
`cancellable: false`).

---

## 2. Compile analyses files (VSCode host + Mnemo host)

### Problem
Analyses live in `analyses/` with `resource_type: "analysis"`. `parseManifest`
`KEEP`s only `model | seed | snapshot | source`, so analyses never become
graph nodes. Both `activeModelNode()` and the `dbtOpenLineage.activeIsModel`
context key therefore treat an analysis file as "not a dbt model", so Compile
Model / Recompile Model are unavailable on it.

### Decision
**Compile support only.** Analyses are NOT added to the DAG (they cannot be
`ref()`'d and have no downstream lineage — adding them would clutter the graph
for no navigational value). YAGNI.

### Approach (VSCode)
1. `activeCompilableNode()` — supersedes `activeModelNode()` for the compile
   commands. It first tries the existing graph-node lookup (models etc.), then,
   on a miss, scans `target/manifest.json` for a node with
   `resource_type === "analysis"` whose `original_file_path` equals the active
   file's project-relative path, returning `{ root, node: { id, name } }`.
   `readCompiledSql` / `readModelSql` already read `compiled_code` / `raw_code`
   by unique_id, and analyses carry both in the manifest, so the doc-open and
   recompile paths need no further change once the id is resolved.
2. Rename context key `dbtOpenLineage.activeIsModel` →
   `dbtOpenLineage.activeIsCompilable`, updating the three `when` clauses in
   `package.json` (editor/title compile, editor/context compile — the
   recompile clause is scheme-gated and unaffected) and the `setContext` call
   in `extension.ts`. The command surfaces on any compilable dbt node.
3. **Verification gate (during implementation):** confirm `dbt compile --select
   <analysis_name>` actually writes the analysis's `compiled_code`. dbt node
   selection has historically been model-centric; if `--select` does not
   compile the analysis, the recompile path for analyses falls back to a full
   `dbt compile` (correct, just slower). This must be verified against a real
   dbt project with an analysis before the recompile path is considered done.

### Approach (Mnemo host — subagent)
Mnemo's native compile command must mirror the analysis recognition. Because
the Mnemo host lives in a separate repo, this is done by a dispatched subagent
that makes, commits, and releases the change there (per the project rule
"Mnemo changes via subagent"). The subagent first locates Mnemo's compile
trigger (the native equivalent of the VSCode editor-title Compile command),
then extends its node lookup to include `analysis` nodes the same way.

### Tests
- `activeCompilableNode` analysis-fallback: given a manifest string with an
  `analysis` node, a matching file path resolves its id/name; a non-matching
  path resolves nothing. (Pure function over an injected manifest string, no
  VSCode.)

---

## 3. `unused:staging` selector (shared `core`)

### Problem / opportunity
`selector.ts` `matchCore` already implements a custom `unused` method:
`unused:sources` returns sources with no downstream consumers. The user wants
`--exclude unused:staging` to drop staging models nothing references.

### Detection decision (user-confirmed)
A staging model is detected **by name prefix only**: `n.name` starts with
`stg_` (case-insensitive). This is intentionally *narrower* than the DAG's
`inferLayer` "staging" classification, which also counts a `/staging/` folder
path — the user's convention is the `stg_` name prefix, so the selector keys on
the name, **not** the `layer` field. Guarded to `resource_type === "model"`
(staging is a model concept; seeds/snapshots are excluded).

### Approach
Extend the existing `unused` branch (`selector.ts:77`):

```ts
if (method === "unused") {
  if (value === "sources" || value === "source")
    return adj.nodes
      .filter((n) => n.resource_type === "source" && !adj.down.get(n.id)?.length)
      .map((n) => n.id);
  if (value === "staging")
    return adj.nodes
      .filter((n) =>
        n.resource_type === "model" &&
        n.name.toLowerCase().startsWith("stg_") &&
        !adj.down.get(n.id)?.length)
      .map((n) => n.id);
  return [];
}
```

Definition of "unused staging": a `model` node whose **name starts with
`stg_`** with **zero downstream graph consumers** (`adj.down` empty). Tests,
exposures, and metrics are not graph edges and do not count as usage — this is
consistent with the existing `unused:sources` semantics (user-confirmed:
ignore tests/exposures).

Because `matchCore` is used by both include and exclude term resolution, this
works as `unused:staging` (include) and `--exclude unused:staging` (exclude)
with no other wiring. Shared `core` means CLI, VSCode, and Mnemo all get it.

### Tests (test-first)
`selector.test.ts`:
- `stg_`-named model with no children → matched by `unused:staging`.
- `stg_`-named model with a downstream child → NOT matched.
- leaf model NOT named `stg_` (e.g. a mart leaf, or a model living in
  `models/staging/` but named `customers`) → NOT matched (name prefix only).
- non-model leaf (seed/snapshot) named `stg_...` → NOT matched (model guard).
- `a+ --exclude unused:staging` subtracts the unused staging set from an
  otherwise-including selection.
- `unused:garbage` (unknown value) → matches nothing (unchanged).

### Docs
Add `unused:staging` to the selector help/examples text near the selector
input (`App.tsx` placeholder / help panel).

---

## 4. Lock lineage during a run (shared `core/App.tsx`)

### Problem
While a run's pilot lights are live, an accidental navigation wipes them:
double-click a node → `onNodeDoubleClick` → `openInIde(path)` opens the file →
the host's active-editor watcher pushes `evt:"context"` → the `onContext`
handler (`App.tsx:469`) calls `setSelector(value)`, retargeting the DAG → the
effect keyed on `[selector, regexMode]` (`App.tsx:1127`) clears `runStatus`,
`runLogs`, `runErr`, `pruned`. Returning to the original model does not restore
the statuses — they were cleared, not hidden — so the user cannot tell whether
the run is still going.

### Chosen UX
Auto-lock while running + a manual lock toggle + confirm-to-override.

- `locked` — manual toggle state (a 🔒 button in the toolbar, usable anytime).
- `lineageLocked = locked || runActive !== null` — effective lock: a run
  auto-locks; the toggle locks even when idle. Mirrored into a ref
  (`lineageLockedRef`) so the stable, empty-deps `onContext` callback reads the
  live value.
- **Accidental host retarget (file-open elsewhere) while `lineageLocked`** →
  the `onContext` handler returns early, silently. The DAG stays put and
  statuses survive. No dialog (a genuinely accidental tab switch should not
  nag).
- **Deliberate switch while `lineageLocked`** → a confirm modal:
  > Run in progress — switching lineage discards its live run statuses.
  > Continue?  [Cancel] [Switch]

  Fires from two entry points:
  - `onNodeDoubleClick` on a node.
  - Committing a **changed** selector via Enter in the selector box.

  On **Switch**: set `allowNextRetarget` ref true and perform the action
  (for double-click, `openInIde`, whose resulting `onContext` is let through
  once because of the ref; for the box, commit `setSelector(raw)`), then the
  existing `[selector]` effect clears the stale statuses as intended. On
  **Cancel**: do nothing (box: revert `raw` to the current `selector`).
- While `lineageLocked`, the debounced auto-commit of the selector box is
  suspended, so typing does not repeatedly trigger the confirm; only an
  explicit Enter does.

### State + helpers
- New state: `locked: boolean`, `confirmSwitch: { onConfirm: () => void } |
  null`.
- New refs: `lineageLockedRef`, `allowNextRetargetRef`.
- Pure, unit-testable helpers (keep `App.tsx` wiring thin):
  - `isLineageLocked(locked: boolean, runActive: unknown): boolean`
  - `shouldConfirmSwitch(lineageLocked: boolean, hasLiveRun: boolean):
    boolean` — where `hasLiveRun = runActive !== null || (runStatus?.size ??
    0) > 0`.
- Confirm modal: a lightweight fixed-overlay component rendered above the DAG
  (same layering approach as the existing `runMenu` / `exportMenu` overlays);
  not `window.confirm` (blocking, unstyled, unreliable in the sandboxed
  iframe).

### Toolbar
A 🔒 toggle button placed with the selector / run controls. It reflects the
effective `lineageLocked` state (shows locked while a run is active). Clicking
toggles the manual `locked` flag.

### Tests (test-first for the pure helpers)
- `isLineageLocked`: manual on/off, run-active auto-lock, both.
- `shouldConfirmSwitch`: locked + live run → true; unlocked → false; locked +
  no live run → false.

### Non-goals
Switching lineage does not stop the underlying run in the host — it only stops
showing that run's statuses (pre-existing behavior; "Switch" accepts this).

---

## Cross-cutting: parity, regression, release

- **Regression:** after each change run the affected package's vitest suite
  (`packages/core`, `packages/vscode`). Whole-suite green before moving to the
  next item. Features 3 and 4 add tests before the implementation.
- **Parity:** features 3 and 4 live in shared `core` and reach every surface
  once `core` rebuilds. Feature 2 needs the Mnemo host subagent for parity.
  Feature 1 is VSCode-only by nature.
- **Release:** lockstep-bump `core` / `mext` / `vscode`, run `npm run rebuild`
  (or `scripts/rebuild-consumers.sh`) so `packages/vscode/media` and the `.mext`
  `dist` ship the new UI, and repackage the `.vsix` via
  `scripts/rebuild-consumers.sh --vscode-only` (a plain `npm run build` does
  not repackage the `.vsix`). Do not clobber an existing untracked `.vsix`
  without bumping the version.

## Open verification item (must close during implementation)
`dbt compile --select <analysis_name>` behavior (feature 2) — verify it emits
the analysis's compiled SQL against a real project; fall back to full
`dbt compile` for analyses if it does not.
