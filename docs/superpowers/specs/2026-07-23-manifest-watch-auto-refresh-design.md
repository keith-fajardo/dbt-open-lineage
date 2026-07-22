# Design: auto-refresh DAG on external `dbt compile`

**Date:** 2026-07-23
**Status:** Approved
**Scope:** VSCode extension host + shared core; Mnemo host watcher deferred (parity follow-up)

## Problem

The webview fetches `dbt.manifest` once at mount. A `dbt compile` run in an
external terminal rewrites `target/manifest.json`, but nothing notifies the
webview — new tags/nodes/edges don't appear until a full window reload.
(Observed: a model's `telehealth` tag missing from the Tags filter until
Developer: Reload Window.)

## Decision

Silent auto-reload, push-based, mirroring the existing `onContext` pattern.

## Components

1. **Host watcher — `packages/vscode/src/extension.ts`**
   `vscode.workspace.createFileSystemWatcher` on
   `new vscode.RelativePattern(projectRoot, "target/manifest.json")`,
   onDidChange + onDidCreate. Debounce 500ms (guards partial-write double
   events) → `view?.postMessage({ evt: "manifestChanged" })`. Watcher created
   in `resolveWebviewView` alongside the existing editor-change subscription;
   disposed with it.

2. **Bridge — optional event**
   `packages/core/src/bridge.ts`: add OPTIONAL
   `onManifestChanged?(cb: () => void): () => void` to `Bridge` + a module
   export that no-ops (returns a noop unsubscribe) when the active bridge
   doesn't implement it. Optional keeps the mext compiling before Mnemo host
   support exists.
   `packages/vscode/src/bridge.ts`: implement it — listen for
   `msg.evt === "manifestChanged"`, same shape as the `onContext` listener.
   `packages/mext/src/bridge.ts`: same listener (Mnemo host doesn't emit yet;
   harmless).

3. **Core subscription — `packages/core/src/App.tsx`**
   One `useEffect` subscribing via the bridge export. On event:
   - skip if a graph load is already in flight or a DAG-initiated run is
     active (`activeRun`-equivalent guard: the local `loading` state);
   - silent `load("dbt.manifest")` (existing function — no spinner change);
   - invalidate the column-lineage payload (existing state, same invalidation
     the manual compile path performs) so stale column data doesn't outlive
     the graph.
   Selection/filters/favorites live in separate state → survive the reload.

## Error handling

Refetch failure → existing `load()` error path (error banner) — no new
handling. Watcher on a project with no `target/` yet: onDidCreate covers the
first compile.

## Testing

- Core (`App.test.tsx`): mocked bridge exposes `onManifestChanged`; push the
  event → assert a second `invoke("dbt.manifest")` and the re-rendered graph
  reflects changed data; bridge WITHOUT the method → subscribing no-ops, no
  crash.
- Bridge unit (`packages/vscode/src/bridge` has no test file; mext bridge
  test exists): add mext bridge test that a `manifestChanged` message from
  the parent fires the callback and unsubscribe works.
- Host watcher: build-verified only (extension.ts has no unit harness —
  established pattern).

## Out of scope

Watching `catalog.json`; Mnemo host-side watcher (folds into the pending
Mnemo parity batch); watching model `.sql` edits; any UI affordance (no
toast, no button).
