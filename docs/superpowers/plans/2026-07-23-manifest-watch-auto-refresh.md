# Manifest-watch auto-refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DAG silently refetches the graph when an external `dbt compile` rewrites `target/manifest.json` — no window reload.

**Architecture:** VSCode host watches `target/manifest.json` and pushes a `manifestChanged` event to the webview (mirroring the existing `onContext` push). The core subscribes via a new OPTIONAL bridge event and re-runs the existing `load("dbt.manifest")`, dropping (and, when column mode is on, refetching) the colibri payload.

**Tech Stack:** TypeScript, React, Vitest, VSCode `FileSystemWatcher`.

## Global Constraints

- No new npm dependencies.
- `Bridge.onManifestChanged` must be OPTIONAL (`?`) — the mext must keep compiling before Mnemo host support exists.
- Existing bridge methods and their tests unchanged.
- Debounce lives HOST-side (500ms); core performs no extra guard (two rapid events collapse at the host).
- TDD where a harness exists (mext bridge test, App.test); extension.ts host watcher is build-verified (no unit harness — established pattern).

---

### Task 1: Bridge event — core interface + vscode/mext listeners (mext TDD)

**Files:**
- Modify: `packages/core/src/bridge.ts`
- Modify: `packages/vscode/src/bridge.ts`
- Modify: `packages/mext/src/bridge.ts`
- Test: `packages/mext/src/bridge.test.ts`

**Interfaces:**
- Produces: `Bridge.onManifestChanged?(cb: () => void): () => void` (optional) and a module export `onManifestChanged(cb)` in core `bridge.ts` that no-ops (returns a noop unsubscribe) when the active bridge lacks the method. Both host bridges listen for `{ evt: "manifestChanged" }`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/mext/src/bridge.test.ts` (inside the existing `describe("mextBridge")`):

```ts
  it("onManifestChanged() forwards evt:'manifestChanged' pushes from window.parent", () => {
    let fired = 0;
    const unsubscribe = mextBridge.onManifestChanged!(() => fired++);

    window.dispatchEvent(
      new MessageEvent("message", { data: { evt: "manifestChanged" }, source: window.parent }),
    );
    expect(fired).toBe(1);

    unsubscribe();
    window.dispatchEvent(
      new MessageEvent("message", { data: { evt: "manifestChanged" }, source: window.parent }),
    );
    expect(fired).toBe(1);
  });

  it("onManifestChanged() ignores pushes whose event.source is not window.parent", () => {
    let fired = 0;
    mextBridge.onManifestChanged!(() => fired++);

    window.dispatchEvent(
      new MessageEvent("message", { data: { evt: "manifestChanged" }, source: null }),
    );
    expect(fired).toBe(0);
  });
```

- [ ] **Step 2: Run to verify RED**

Run: `cd packages/mext && npx vitest run src/bridge.test.ts`
Expected: FAIL — `mextBridge.onManifestChanged is not a function`.

- [ ] **Step 3: Implement**

`packages/core/src/bridge.ts` — extend the interface and add the export:

```ts
export interface Bridge {
  invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T>;
  saveExport(filename: string, dataB64: string): Promise<boolean>;
  openInIde(path: string): Promise<boolean>;
  onContext(cb: (value: string) => void): () => void;
  onRunEvent(cb: (e: RunEvent) => void): () => void;
  /** Optional: hosts that watch target/manifest.json push this when an
   * EXTERNAL `dbt compile` rewrites it. Optional so hosts without a watcher
   * (Mnemo, static CLI) keep satisfying the interface unchanged. */
  onManifestChanged?(cb: () => void): () => void;
}
```

and alongside the other exports at the bottom:

```ts
export const onManifestChanged = (cb: () => void): (() => void) => {
  const b = get();
  // Host without a watcher: subscribing is a no-op with a no-op unsubscribe.
  return b.onManifestChanged ? b.onManifestChanged(cb) : () => {};
};
```

`packages/vscode/src/bridge.ts` — add to `vscodeBridge` (after `onRunEvent`, same listener shape as `onContext`):

```ts
  onManifestChanged: (cb) => {
    const onMsg = (ev: MessageEvent) => {
      const m = ev.data;
      if (!m || m.evt !== "manifestChanged") return;
      cb();
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  },
```

`packages/mext/src/bridge.ts` — add to `mextBridge` (after `onRunEvent`, keeping the `ev.source !== window.parent` spoof guard the other listeners have):

```ts
  onManifestChanged: (cb) => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.source !== window.parent) return;
      const m = ev.data;
      if (!m || m.evt !== "manifestChanged") return;
      cb();
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  },
```

- [ ] **Step 4: Run to verify GREEN**

Run: `cd packages/mext && npx vitest run src/bridge.test.ts` — all pass (7 = 5 existing + 2 new).
Also: `cd packages/core && npx tsc --noEmit` — clean (optional member breaks nothing).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/bridge.ts packages/vscode/src/bridge.ts packages/mext/src/bridge.ts packages/mext/src/bridge.test.ts
git commit -m "feat(core): optional onManifestChanged bridge event"
```

---

### Task 2: Core subscription — refetch graph + colibri payload on manifestChanged

**Files:**
- Modify: `packages/core/src/App.tsx`
- Test: `packages/core/src/App.test.tsx`

**Interfaces:**
- Consumes: `onManifestChanged` export from Task 1; existing `load("dbt.manifest")` (App.tsx:382) and the column-lineage fetch inside `onToggleColumnLineage` (App.tsx:902).

- [ ] **Step 1: Write the failing test**

In `packages/core/src/App.test.tsx`:

(a) Next to the existing `contextCb` capture (top of file, ~line 45), add:

```ts
let manifestChangedCb: (() => void) | null = null;
```

(b) In the `vi.mock("./bridge", ...)` factory, add alongside `onContext`:

```ts
  onManifestChanged: (cb: () => void) => { manifestChangedCb = cb; return () => { manifestChangedCb = null; }; },
```

(c) In `beforeEach`, add `manifestChangedCb = null;`.

(d) Add the test (near the other top-level graph-loading tests):

```tsx
it("refetches the graph when the host pushes manifestChanged", async () => {
  render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
  await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("dbt.manifest", { projectPath: "/proj" }));
  const before = invokeMock.mock.calls.filter((c) => c[0] === "dbt.manifest").length;

  act(() => { manifestChangedCb?.(); });

  await waitFor(() =>
    expect(invokeMock.mock.calls.filter((c) => c[0] === "dbt.manifest").length).toBe(before + 1),
  );
});
```

(`act` is already imported in this file; if not, add it to the existing `@testing-library/react` import.)

- [ ] **Step 2: Run to verify RED**

Run: `cd packages/core && npx vitest run src/App.test.tsx -t "manifestChanged"`
Expected: FAIL — `manifestChangedCb` stays null (App never subscribes).

- [ ] **Step 3: Implement in App.tsx**

(a) Extend the bridge import (App.tsx:9):

```ts
import { invoke, onContext, onRunEvent, saveExport, openInIde, onManifestChanged } from "./bridge";
```

(b) Extract the fetch body of `onToggleColumnLineage` into a reusable helper placed immediately above it (the toggle then calls it; the manifest subscription reuses it):

```ts
  const fetchColumnLineage = async () => {
    setColumnLineageBusy(true); setColumnLineageErr(null);
    try {
      const payload = await invoke<ColumnLineagePayload>("dbt.columnLineage", {});
      setColumnLineage(payload);
      // dbt-colibri resolves column-level lineage by parsing COMPILED SQL out
      // of manifest.json — if that's stale (e.g. only a selective/partial
      // `dbt compile` ran, or another tool's background parse invalidated
      // it), colibri silently falls back to model-level-only edges, which
      // extractColumnLineage correctly filters out. The result looks
      // identical to "nothing traces," with no indication why. Surface it
      // explicitly rather than leaving the toggle looking broken.
      if (payload.edges.length === 0) {
        setColumnLineageErr("No column-level lineage found — run a full `dbt compile` and try again.");
      }
    } catch (e) {
      setColumnLineageErr(String((e as Error).message ?? e));
      setColumnLineageMode(false); // revert — nothing to show
    } finally {
      setColumnLineageBusy(false);
    }
  };
```

In `onToggleColumnLineage`, replace that inlined fetch block with `await fetchColumnLineage();` (the `if (columnLineage) return;` guard stays in the toggle). Update the now-stale comment in the toggle's turn-off branch: the claim "there's no in-app manifest-refresh that reaches this state" is no longer true — rewrite that comment segment to:

```ts
      // Turning off clears the trace AND drops the cached payload, so the next
      // enable re-runs colibri against the CURRENT target/manifest.json +
      // catalog.json. A host manifestChanged push also drops/refetches the
      // payload (see the onManifestChanged effect), so this off/on gesture is
      // now a fallback refresh, not the only one.
```

(c) Add the subscription effect (place it right after the `useEffect` on `[graph]` at App.tsx:392-395). Depends on `columnLineageMode` so the callback sees the current mode; re-subscribing on toggle is cheap:

```ts
  // An EXTERNAL `dbt compile` rewrote target/manifest.json (host watcher
  // push): silently refetch the graph. Selection/filters/favorites live in
  // separate state and survive; the [graph] effect above already resets
  // column selection/expansion. The colibri payload was parsed from the OLD
  // manifest — drop it, and when column mode is live refetch it too so the
  // visible column edges match the new graph.
  useEffect(() => {
    return onManifestChanged(() => {
      void load("dbt.manifest");
      setColumnLineage(null);
      if (columnLineageMode) void fetchColumnLineage();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnLineageMode]);
```

- [ ] **Step 4: Run to verify GREEN + no regressions**

Run: `cd packages/core && npx vitest run src/App.test.tsx -t "manifestChanged"` — PASS.
Then full: `cd packages/core && npx vitest run` — all green (the extraction must not break the existing column-lineage tests).
Then: `cd packages/core && npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/App.tsx packages/core/src/App.test.tsx
git commit -m "feat(core): auto-refresh graph on host manifestChanged push"
```

---

### Task 3: VSCode host watcher

**Files:**
- Modify: `packages/vscode/src/extension.ts` (inside `LineageViewProvider.resolveWebviewView`)

**Interfaces:**
- Consumes: the webview `view` handle and `projectRoot` (both already set in `resolveWebviewView`).
- Produces: `{ evt: "manifestChanged" }` postMessage, debounced 500ms.

No unit harness for extension.ts — verified by the host build compiling. Separate commit for independent review.

- [ ] **Step 1: Implement**

In `resolveWebviewView`, after the existing `editorSub` subscription (extension.ts:259-…), add:

```ts
    // Watch target/manifest.json so an EXTERNAL `dbt compile` (terminal, CI
    // task…) refreshes the DAG without a window reload. Debounced: dbt may
    // fire create+change (or partial-write double events) for one compile —
    // collapse them into one push. The webview refetches via dbt.manifest on
    // receipt (see core's onManifestChanged effect).
    let manifestTimer: ReturnType<typeof setTimeout> | undefined;
    const pushManifestChanged = () => {
      clearTimeout(manifestTimer);
      manifestTimer = setTimeout(() => { void view?.postMessage({ evt: "manifestChanged" }); }, 500);
    };
    const watcher = projectRoot
      ? vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(projectRoot, "target/manifest.json"),
        )
      : undefined;
    watcher?.onDidChange(pushManifestChanged);
    watcher?.onDidCreate(pushManifestChanged);
```

and extend the existing dispose hookup (the `webviewView.onDidDispose` / subscription cleanup that already disposes `sub` and `editorSub`) to also run:

```ts
    watcher?.dispose();
    clearTimeout(manifestTimer);
```

(Match the file's existing disposal pattern exactly — if disposables are pushed to an array/context.subscriptions, push `watcher` there instead of a manual dispose.)

- [ ] **Step 2: Verify it compiles**

Run: `cd packages/vscode && npm run build:host`
Expected: esbuild completes, no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/vscode/src/extension.ts
git commit -m "feat(vscode): watch target/manifest.json, push manifestChanged"
```

---

### Task 4: Release (gated)

- [ ] **Step 1** (only on the user's explicit "release"): bump `packages/vscode/package.json` patch, `scripts/rebuild-consumers.sh --vscode-only`, verify `manifestChanged` present in `out/extension.js` + webview bundle, `code --install-extension … --force`, commit, tag `vscode-vX.Y.Z`, push master+tag. No npm publish. Mext parity note: the `.mext` bundle picks up the bridge listener at its next Mnemo-batch rebuild — no standalone mext release needed for this (Mnemo host doesn't emit the event yet).

---

## Self-Review

- **Spec coverage:** watcher (T3), optional bridge event + both listeners (T1), silent refetch + colibri invalidation + live-mode refetch (T2), no-watcher no-op fallback (T1 core export), stale-comment update (T2), release (T4). ✓
- **Placeholder scan:** all steps carry complete code; T3's disposal instruction names the concrete alternative (context.subscriptions) rather than "handle cleanup appropriately". ✓
- **Type consistency:** `onManifestChanged?(cb: () => void): () => void` identical across interface, core export, both bridges, mock, and App usage; `{ evt: "manifestChanged" }` identical in T1 listeners and T3 push. ✓
- **Known accepted gap:** the core-export fallback path (bridge without the method) has no dedicated test — noted for the final review; the mocked App path always provides the method.
