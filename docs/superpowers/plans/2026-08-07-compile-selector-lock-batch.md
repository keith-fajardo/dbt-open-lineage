# Compile / Selector / Lock Batch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship four DAG-viewer changes — silent compile, compile-analyses support, an `unused:staging` selector, and a run-protecting lineage lock — across the monorepo without regressions and with mext↔vscode parity.

**Architecture:** `packages/core` holds the shared React app (`App.tsx`) and the pure selector engine (`selector.ts`); changes there reach CLI, VSCode, and Mnemo once rebuilt. `packages/vscode` is the VSCode extension host (Node) — the only surface with the Terminal-yank problem and its own compile-analyses wiring. The Mnemo host lives in a separate repo (compile-analyses parity done via a dispatched subagent).

**Tech Stack:** TypeScript, React, React Flow, Vitest, esbuild (host) + Vite (webview), VSCode extension API.

## Global Constraints

- **No regression:** after each task, the touched package's full vitest suite passes (`cd packages/<pkg> && npx vitest run`). Do NOT move to the next task on red.
- **TDD:** features `unused:staging` and the lock helpers are written test-first (failing test → implement → green).
- **Parity:** shared `core` changes (Tasks 1, 4, 5) reach every surface after a rebuild; compile-analyses (Task 8) needs the Mnemo host subagent; silent compile is VSCode-only.
- **Detection rule (unused:staging):** a staging model is a node with `resource_type === "model"` whose `name` (lower-cased) starts with `stg_`. Name prefix only — NOT the `/staging/` folder, NOT the `layer` field.
- **Unused definition:** zero downstream graph consumers (`adj.down` empty). Tests/exposures do not count as usage (mirrors `unused:sources`).
- **Silent output:** compile streams to the existing `getRunOutputChannel()` ("dbt Open Lineage" `OutputChannel`); NEVER call `.show()`.
- **Release:** lockstep-bump `core` / `mext` / `vscode`; run `bash scripts/rebuild-consumers.sh` (repackages `.vsix` + `.mext dist`); do not clobber an existing untracked `.vsix` without a version bump.

---

## Task 1: `unused:staging` selector (core)

**Files:**
- Modify: `packages/core/src/selector.ts:77-85` (the `unused` branch of `matchCore`)
- Modify: `packages/core/src/App.tsx:1466` (placeholder help text — document the new method)
- Test: `packages/core/src/selector.test.ts`

**Interfaces:**
- Consumes: existing `Adj` (`adj.nodes`, `adj.down`), `GraphNode.name`, `GraphNode.resource_type`.
- Produces: `unused:staging` recognized by `matchCore` → usable as an include term and as `--exclude unused:staging` (no other wiring; `resolveSelector` already routes `--exclude`).

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/selector.test.ts` (the top `g` fixture is a linear chain a→b→c→d; add a dedicated fixture so staging names/leaves are explicit):

```ts
describe("unused:staging", () => {
  // s1 (stg_, leaf) unused; s2 (stg_, has child m) used; m (mart leaf) not staging;
  // seed_stg (stg_-named but a seed) excluded by the model guard.
  const gs: Graph = {
    nodes: [
      { id: "s1", name: "stg_orphan", resource_type: "model", layer: "staging", path: "models/staging/stg_orphan.sql", description: "", tags: [], meta: {} },
      { id: "s2", name: "stg_used",   resource_type: "model", layer: "staging", path: "models/staging/stg_used.sql",   description: "", tags: [], meta: {} },
      { id: "m",  name: "mart_x",     resource_type: "model", layer: "mart",    path: "models/marts/mart_x.sql",       description: "", tags: [], meta: {} },
      { id: "sd", name: "stg_seed",   resource_type: "seed",  layer: "staging", path: "seeds/stg_seed.csv",            description: "", tags: [], meta: {} },
    ],
    edges: [{ from: "s2", to: "m" }],
  };
  const sids = (q: string) => [...resolveSelector(gs, q)].sort();

  it("matches a stg_-named model with no downstream consumers", () =>
    expect(sids("unused:staging")).toEqual(["s1"]));
  it("does NOT match a stg_ model that has a downstream consumer", () =>
    expect(sids("unused:staging")).not.toContain("s2"));
  it("does NOT match a non-stg_ leaf model", () =>
    expect(sids("unused:staging")).not.toContain("m"));
  it("does NOT match a stg_-named non-model (seed) — model guard", () =>
    expect(sids("unused:staging")).not.toContain("sd"));
  it("--exclude unused:staging subtracts the unused staging set", () =>
    expect(sids("s1 s2 m --exclude unused:staging")).toEqual(["m", "s2"]));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run selector`
Expected: the new `unused:staging` cases FAIL (currently `unused:staging` matches nothing → `sids("unused:staging")` is `[]`).

- [ ] **Step 3: Implement the staging branch**

In `packages/core/src/selector.ts`, replace the current `unused` block (lines 77-85):

```ts
  if (method === "unused") {
    // unused:sources — sources with NO downstream consumers at all (defined
    // in a .yml but never referenced by staging/int/mart models). Composes
    // with --exclude to hide them: "--exclude unused:sources".
    if (value === "sources" || value === "source")
      return adj.nodes
        .filter((n) => n.resource_type === "source" && !adj.down.get(n.id)?.length)
        .map((n) => n.id);
    // unused:staging — staging MODELS nothing references. "Staging" is the
    // stg_ NAME prefix (not the /staging/ folder, not the layer field), per
    // the project's naming convention. Same "no downstream consumers" rule
    // as unused:sources; tests/exposures aren't graph edges so they don't
    // count as usage.
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/core && npx vitest run selector`
Expected: PASS (all `unused:staging` cases green; existing `unused:sources` cases still green).

- [ ] **Step 5: Document the method in the selector placeholder**

In `packages/core/src/App.tsx:1466`, extend the placeholder text to mention the new method:

```tsx
              placeholder="select… e.g. stg_orders+ or tag:mart --exclude unused:staging  (Enter shows only the selection)"
```

- [ ] **Step 6: Full core suite + typecheck**

Run: `cd packages/core && npx vitest run && npx tsc --noEmit`
Expected: all green (regression gate).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/selector.ts packages/core/src/selector.test.ts packages/core/src/App.tsx
git commit -m "feat(core): unused:staging selector (stg_ name prefix, no downstream consumers)"
```

---

## Task 2: Silent compile helper `spawnDbtToCompletion` (vscode)

**Files:**
- Modify: `packages/vscode/src/host/run.ts` (add `spawnDbtToCompletion`)
- Delete: `packages/vscode/src/host/compile.ts`
- Delete: `packages/vscode/src/host/compile.test.ts`
- Test: `packages/vscode/src/host/run.test.ts`

**Interfaces:**
- Consumes: existing `RunDeps`, module-private `defaultDeps` (`resolveBin("dbt")` spawn), `LineBuffer` — all already in `run.ts`.
- Produces: `spawnDbtToCompletion(root: string, args: string[], onWrite: (line: string) => void, deps?: RunDeps): Promise<number>` — spawns `dbt <args>`, streams every output line to `onWrite`, resolves the exit code (or -1). Consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

Add to `packages/vscode/src/host/run.test.ts` (reuse the existing `fakeChild` helper defined lower in the file — move the new `describe` block below `fakeChild`'s definition, or hoist a local fake). Import `spawnDbtToCompletion` at the top:

```ts
// add to the import on line 4:
import { LineBuffer, parseDbtLogLine, mapNodeStatus, buildRunArgs, startDbtRun, startDbtRunWithSeed, spawnDbtToCompletion } from "./run";
```

```ts
describe("spawnDbtToCompletion", () => {
  it("spawns dbt with the given args and streams stdout lines to onWrite", async () => {
    const proc = fakeChild();
    const spawnSpy = vi.fn(() => proc as unknown as ChildProcess);
    const written: string[] = [];
    const p = spawnDbtToCompletion("/proj", ["compile"], (l) => written.push(l), { spawn: spawnSpy });
    expect(spawnSpy).toHaveBeenCalledWith("/proj", ["compile"]);
    proc.stdout.emit("data", Buffer.from("Running with dbt=1.11\nDone.\n"));
    proc.emit("close", 0);
    await expect(p).resolves.toBe(0);
    expect(written).toEqual(["Running with dbt=1.11", "Done."]);
  });

  it("resolves the non-zero exit code and flushes a trailing partial line", async () => {
    const proc = fakeChild();
    const written: string[] = [];
    const p = spawnDbtToCompletion("/proj", ["compile", "--select", "stg_x"], (l) => written.push(l), { spawn: () => proc as unknown as ChildProcess });
    proc.stdout.emit("data", Buffer.from("no trailing newline"));
    proc.emit("close", 2);
    await expect(p).resolves.toBe(2);
    expect(written).toEqual(["no trailing newline"]);
  });

  it("a spawn error writes the message and resolves -1", async () => {
    const proc = fakeChild();
    const written: string[] = [];
    const p = spawnDbtToCompletion("/proj", ["compile"], (l) => written.push(l), { spawn: () => proc as unknown as ChildProcess });
    proc.emit("error", new Error("ENOENT"));
    await expect(p).resolves.toBe(-1);
    expect(written.join("\n")).toContain("ENOENT");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/vscode && npx vitest run run.test`
Expected: FAIL — `spawnDbtToCompletion` is not exported.

- [ ] **Step 3: Implement `spawnDbtToCompletion` in run.ts**

Append to `packages/vscode/src/host/run.ts` (after `startDbtRunWithSeed`):

```ts
/** Run `dbt <args>` to completion in `projectRoot`, streaming every output
 * line to `onWrite` (one line, no trailing newline) and resolving with the
 * exit code (or -1 on spawn failure / no code). Unlike vscode.Task's
 * ShellExecution this spawns via child_process (resolveBin("dbt"), no shell),
 * so it never reveals the Terminal panel — the caller pipes onWrite to the
 * "dbt Open Lineage" OutputChannel WITHOUT .show(). Plain text: compile has
 * no --log-format json, so there's nothing to parse per line. */
export function spawnDbtToCompletion(
  projectRoot: string, args: string[], onWrite: (line: string) => void,
  deps: RunDeps = defaultDeps,
): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = deps.spawn(projectRoot, args);
    const out = new LineBuffer();
    const err = new LineBuffer();
    const emit = (lines: string[]) => { for (const l of lines) onWrite(l); };
    let done = false;
    const finish = (code: number) => { if (done) return; done = true; resolve(code); };

    child.stdout?.on("data", (c: Buffer) => emit(out.push(c.toString("utf8"))));
    child.stderr?.on("data", (c: Buffer) => emit(err.push(c.toString("utf8"))));
    child.on("close", (code: number | null) => {
      emit(out.flush());
      emit(err.flush());
      finish(code ?? -1);
    });
    child.on("error", (e: Error) => { onWrite(`spawn error: ${e.message}`); finish(-1); });
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/vscode && npx vitest run run.test`
Expected: PASS.

- [ ] **Step 5: Delete the now-dead Task-based compile module + its test**

The whole of `compile.ts` (`makeCompileTask`, `makeCompileSelectTask`, `compileSelectArgs`, `runTaskToCompletion`) is superseded. Delete both files:

```bash
git rm packages/vscode/src/host/compile.ts packages/vscode/src/host/compile.test.ts
```

(`extension.ts` still imports from it — that import is fixed in Task 3, so the host build stays red until Task 3 lands. That's fine: Tasks 2 and 3 form one deliverable; run the vscode suite green at the end of Task 3.)

- [ ] **Step 6: Commit**

```bash
git add packages/vscode/src/host/run.ts packages/vscode/src/host/run.test.ts
git commit -m "feat(vscode): spawnDbtToCompletion helper; drop Task-based compile module"
```

---

## Task 3: Wire silent compile into extension.ts (vscode)

**Files:**
- Modify: `packages/vscode/src/extension.ts:9` (imports), `:165-178` (`dbt.compile` case), `:387-413` (`recompile` command)

**Interfaces:**
- Consumes: `spawnDbtToCompletion` (Task 2), existing `getRunOutputChannel()`, `parseManifest`, `readCompiledSql`.
- Produces: neither compile path constructs a `vscode.Task`; output goes to the Output channel, never the Terminal.

- [ ] **Step 1: Fix imports**

In `packages/vscode/src/extension.ts`:
- Remove line 9: `import { makeCompileTask, runTaskToCompletion, makeCompileSelectTask } from "./host/compile";`
- Change line 10 to also import the new helper:

```ts
import { startDbtRunWithSeed, spawnDbtToCompletion, type RunController } from "./host/run";
```

- [ ] **Step 2: Rewrite the `dbt.compile` case**

Replace the body of `case "dbt.compile":` (lines 165-178) with:

```ts
      case "dbt.compile": {
        projectRoot = resolveRoot();
        if (!projectRoot) throw new Error("no dbt project found (dbt_project.yml)");
        ensureManifestWatcher(projectRoot); // re-pin the watcher to the freshly resolved root
        const channel = getRunOutputChannel();
        channel.clear();
        channel.appendLine("> dbt compile");
        // Silent: spawn (no Task, no Terminal). Output goes to the "dbt Open
        // Lineage" channel; never .show() it — a compile must not yank focus.
        const code = await spawnDbtToCompletion(projectRoot, ["compile"], (l) => channel.appendLine(l));
        if (code !== 0) throw new Error(`dbt compile failed (exit ${code})`);
        const p = path.join(projectRoot, "target", "manifest.json");
        const graph: Graph = parseManifest(fs.readFileSync(p, "utf8"));
        lastGraph = graph;
        reply({ ok: true, result: graph });
        break;
      }
```

- [ ] **Step 3: Rewrite the recompile command's task run**

In the `dbt-open-lineage.recompile` command (lines ~400-407), replace the `withProgress(... runTaskToCompletion(makeCompileSelectTask(...)) ...)` block with a spawn inside the same progress spinner:

```ts
      const channel = getRunOutputChannel();
      channel.clear();
      channel.appendLine(`> dbt compile --select ${name}`);
      const code = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Recompiling ${name}…`, cancellable: false },
        () => spawnDbtToCompletion(root, ["compile", "--select", name], (l) => channel.appendLine(l)),
      );
      if (code !== 0) { void vscode.window.showErrorMessage(`dbt compile failed (exit ${code})`); return; }
```

(The lines after — `readCompiledSql`, `compiledContent.set`, `compiledChanged.fire`, the status-bar message — are unchanged.)

- [ ] **Step 4: Typecheck + full vscode suite**

Run: `cd packages/vscode && npx tsc --noEmit -p . && npx vitest run`
Expected: compiles cleanly (no dangling `./host/compile` import), all tests green.

- [ ] **Step 5: Build the host bundle (smoke)**

Run: `cd packages/vscode && npm run build:host`
Expected: esbuild succeeds (catches any missed reference).

- [ ] **Step 6: Commit**

```bash
git add packages/vscode/src/extension.ts
git commit -m "feat(vscode): compile silently to Output channel (no Terminal Task)"
```

---

## Task 4: Lock pure helpers (core)

**Files:**
- Create: `packages/core/src/lock.ts`
- Test: `packages/core/src/lock.test.ts`

**Interfaces:**
- Produces:
  - `isLineageLocked(locked: boolean, runActive: unknown): boolean` — `locked || runActive !== null`.
  - `shouldConfirmSwitch(lineageLocked: boolean, hasLiveRun: boolean): boolean` — `lineageLocked && hasLiveRun`.
  Consumed by Task 5.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/lock.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isLineageLocked, shouldConfirmSwitch } from "./lock";

describe("isLineageLocked", () => {
  it("locked when the manual toggle is on", () => expect(isLineageLocked(true, null)).toBe(true));
  it("auto-locked while a run is active", () => expect(isLineageLocked(false, "run")).toBe(true));
  it("unlocked when idle and toggle off", () => expect(isLineageLocked(false, null)).toBe(false));
  it("locked when both", () => expect(isLineageLocked(true, "build")).toBe(true));
});

describe("shouldConfirmSwitch", () => {
  it("confirms when locked with a live run", () => expect(shouldConfirmSwitch(true, true)).toBe(true));
  it("no confirm when not locked", () => expect(shouldConfirmSwitch(false, true)).toBe(false));
  it("no confirm when locked but no live run (idle manual lock)", () => expect(shouldConfirmSwitch(true, false)).toBe(false));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run lock`
Expected: FAIL — `./lock` does not exist.

- [ ] **Step 3: Implement lock.ts**

Create `packages/core/src/lock.ts`:

```ts
/** Pure lock predicates for the lineage view (unit-tested in isolation so the
 * App.tsx wiring stays thin). */

/** Effective lock state: a run auto-locks the lineage; the manual toggle locks
 * it even when idle. `runActive` is App's run state (a command string while a
 * run is in flight, else null). */
export function isLineageLocked(locked: boolean, runActive: unknown): boolean {
  return locked || runActive !== null;
}

/** Whether a deliberate lineage switch should ask first: only when the view is
 * locked AND there are live run statuses that the switch would discard. */
export function shouldConfirmSwitch(lineageLocked: boolean, hasLiveRun: boolean): boolean {
  return lineageLocked && hasLiveRun;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/core && npx vitest run lock`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/lock.ts packages/core/src/lock.test.ts
git commit -m "feat(core): pure lineage-lock predicates (isLineageLocked, shouldConfirmSwitch)"
```

---

## Task 5: Wire the lock into App.tsx (core)

**Files:**
- Modify: `packages/core/src/App.tsx` — imports, state (~320-328), the debounce effect (~487), the `onContext` effect (~469), `onNodeDoubleClick` (~1354), the selector-box `Enter` handler (~1474), plus a lock toggle button (~1518 area) and a confirm modal (~1411 area).

**Interfaces:**
- Consumes: `isLineageLocked`, `shouldConfirmSwitch` (Task 4); existing `runActive`, `runStatus`, `openInIde`, `setSelector`, `setRaw`, `setFocus`, `setSelected`, `setActiveName`, `focalName`.
- Produces: user-visible lock behavior. No new exports.

Note: this task's deliverable is UI wiring that unit tests can't drive; the gate is `npx tsc --noEmit`, `npm run build:webview`, the Task-4 helper tests staying green, and a manual smoke of the lock behavior.

- [ ] **Step 1: Import the helpers**

Add to the imports near `import { resolveSelector, focalName, buildSelector } from "./selector";` (line 11):

```ts
import { isLineageLocked, shouldConfirmSwitch } from "./lock";
```

- [ ] **Step 2: Add lock state near the other early state**

After `const [confirmShowAll, setConfirmShowAll] = useState(false);` (line 328) add:

```ts
  const [locked, setLocked] = useState(false); // manual lineage lock (🔒 toggle)
  const [confirmSwitch, setConfirmSwitch] = useState<{ onConfirm: () => void } | null>(null);
  const lineageLockedRef = useRef(false);      // live lock state for the stable onContext callback
  const allowNextRetargetRef = useRef(false);  // let ONE confirmed retarget through the lock
```

(`useRef` is already imported — it's used elsewhere in the file, e.g. the debounce `timer`.)

- [ ] **Step 3: Guard the `onContext` retarget (accidental file-open)**

Replace the `onContext` effect body (lines 469-475) with:

```ts
  useEffect(() => onContext((value) => {
    // Locked (manually or auto during a run): ignore host-pushed retargets so
    // an accidental file-open can't wipe live run statuses. A confirmed switch
    // sets allowNextRetargetRef to let exactly one through.
    if (lineageLockedRef.current && !allowNextRetargetRef.current) return;
    allowNextRetargetRef.current = false;
    setRaw(value);
    setSelector(value);
    setFocus(value !== "");
    setSelected(null);
    setActiveName(focalName(value)); // the newly-opened model becomes the focus
  }), []);
```

- [ ] **Step 4: Suspend the debounce auto-commit while locked**

Replace the debounce effect (lines 487-491) with:

```ts
  useEffect(() => {
    clearTimeout(timer.current);
    // While locked, typing must not auto-retarget the DAG (that would wipe
    // statuses without a confirm). Only an explicit Enter commits (guarded).
    if (lineageLockedRef.current) return;
    timer.current = setTimeout(() => setSelector(raw), debounceMs);
    return () => clearTimeout(timer.current);
  }, [raw, debounceMs]);
```

- [ ] **Step 5: Derive effective lock + keep the ref current**

Immediately AFTER the `runStatus` state is declared (after line 1098 `const [runStatus, setRunStatus] = ...`) add:

```ts
  const lineageLocked = isLineageLocked(locked, runActive);
  const hasLiveRun = runActive !== null || (runStatus?.size ?? 0) > 0;
  lineageLockedRef.current = lineageLocked; // mirror for the stable onContext callback
```

- [ ] **Step 6: Confirm on a deliberate double-click switch**

Replace `onNodeDoubleClick` (lines 1354-1357) with:

```ts
  const onNodeDoubleClick: NodeMouseHandler = (_, n) => {
    const target = graph?.nodes.find((x) => x.id === n.id);
    if (!target?.path) return;
    const open = () => { allowNextRetargetRef.current = true; void openInIde(target.path).catch(() => {/* standalone */}); };
    // Locked + a live run → ask before letting the retarget discard statuses.
    if (shouldConfirmSwitch(lineageLocked, hasLiveRun)) { setConfirmSwitch({ onConfirm: open }); return; }
    // Unlocked → normal: openInIde pushes a context that retargets the DAG.
    // Locked but no live run → openInIde still opens the file; onContext stays
    // blocked, so the DAG stays frozen (nothing to protect, no dialog).
    void openInIde(target.path).catch(() => {/* standalone */});
  };
```

- [ ] **Step 7: Confirm on a deliberate selector-box Enter commit**

In the selector `onKeyDown` Enter branch (lines 1474-1488), replace the final two lines (`setSelector(raw); setFocus(true);`) with:

```ts
                const commit = () => { setSelector(raw); setFocus(true); };
                if (shouldConfirmSwitch(lineageLocked, hasLiveRun)) {
                  setConfirmSwitch({ onConfirm: commit });
                  return;
                }
                commit();
```

- [ ] **Step 8: Add the 🔒 toggle button to the toolbar**

After the `Focus` button (ends line 1518) add:

```tsx
            <button
              onClick={() => setLocked((v) => !v)}
              aria-pressed={lineageLocked}
              title={lineageLocked
                ? (runActive ? "Lineage locked while a run is active" : "Lineage locked — click to unlock")
                : "Lock the lineage so navigation can't discard run statuses"}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 11px",
                borderRadius: 20, border: `1px solid ${lineageLocked ? "#3b82f6" : "#334155"}`,
                background: lineageLocked ? "#16233d" : "#111827",
                color: "#e5e7eb", cursor: "pointer", fontFamily: "inherit", fontSize: 12,
              }}
            >{lineageLocked ? "🔒 Locked" : "🔓 Lock"}</button>
```

- [ ] **Step 9: Add the confirm-switch modal**

After the `confirmShowAll` modal block (ends line 1447) add a sibling modal, mirroring its markup:

```tsx
      {confirmSwitch && (
        <div role="dialog" aria-modal="true" aria-label="switch lineage confirmation"
          style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(2,6,23,0.6)" }}>
          <div style={{ background: "#111827", border: "1px solid #334155", borderRadius: 10, padding: 20, width: 340, boxShadow: "0 20px 50px rgba(0,0,0,0.5)" }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#e5e7eb", marginBottom: 6 }}>Run in progress</div>
            <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 16 }}>
              Switching lineage discards this run's live statuses. Continue?
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={() => setConfirmSwitch(null)}
                style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #334155", background: "#111827", color: "#94a3b8", cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>Cancel</button>
              <button onClick={() => { const c = confirmSwitch; setConfirmSwitch(null); c.onConfirm(); }}
                style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #334155", background: "#2563eb", color: "#fff", cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>Switch</button>
            </div>
          </div>
        </div>
      )}
```

- [ ] **Step 10: Typecheck + full core suite + webview build**

Run: `cd packages/core && npx tsc --noEmit && npx vitest run`
Then: `cd packages/vscode && npm run build:webview`
Expected: all green; Vite build succeeds.

- [ ] **Step 11: Manual smoke (record result in the commit body if anything deviates)**

Load the DAG, start a run, then (a) open another `.sql` file → DAG stays, statuses persist; (b) double-click a node → confirm dialog appears; Cancel keeps statuses, Switch retargets; (c) 🔒 toggles state and shows locked while running.

- [ ] **Step 12: Commit**

```bash
git add packages/core/src/App.tsx
git commit -m "feat(core): lock lineage during a run (auto-lock + 🔒 toggle + switch confirm)"
```

---

## Task 6: `analysisNodeFromManifest` (vscode)

**Files:**
- Modify: `packages/vscode/src/host/compiledSql.ts` (add the analysis lookup)
- Test: `packages/vscode/src/host/compiledSql.test.ts`

**Interfaces:**
- Produces: `analysisNodeFromManifest(manifestJson: string, relPath: string): { id: string; name: string } | null` — finds a manifest node with `resource_type === "analysis"` whose `original_file_path === relPath`. Consumed by Task 7.

- [ ] **Step 1: Write the failing tests**

Add to `packages/vscode/src/host/compiledSql.test.ts`:

```ts
import { analysisNodeFromManifest } from "./compiledSql"; // add to existing import if present

describe("analysisNodeFromManifest", () => {
  const manifest = JSON.stringify({
    nodes: {
      "model.p.stg_x":   { resource_type: "model",    name: "stg_x", original_file_path: "models/staging/stg_x.sql" },
      "analysis.p.rev":  { resource_type: "analysis", name: "rev",   original_file_path: "analyses/rev.sql" },
    },
  });
  it("resolves an analysis node by its file path", () =>
    expect(analysisNodeFromManifest(manifest, "analyses/rev.sql")).toEqual({ id: "analysis.p.rev", name: "rev" }));
  it("returns null for a non-analysis file path (a model)", () =>
    expect(analysisNodeFromManifest(manifest, "models/staging/stg_x.sql")).toBeNull());
  it("returns null when nothing matches", () =>
    expect(analysisNodeFromManifest(manifest, "analyses/missing.sql")).toBeNull());
  it("returns null on malformed json without throwing", () =>
    expect(analysisNodeFromManifest("not json", "analyses/rev.sql")).toBeNull());
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/vscode && npx vitest run compiledSql`
Expected: FAIL — `analysisNodeFromManifest` not exported.

- [ ] **Step 3: Implement the lookup**

Append to `packages/vscode/src/host/compiledSql.ts`:

```ts
/** Find the analysis node (resource_type "analysis") whose original_file_path
 * matches `relPath` (project-relative, forward slashes). Analyses are NOT in
 * the DAG graph (parseManifest keeps only model/seed/snapshot/source), so the
 * compile commands resolve them straight off the manifest instead. Returns the
 * node's unique id + name, or null (no match / malformed json — never throws). */
export function analysisNodeFromManifest(manifestJson: string, relPath: string): { id: string; name: string } | null {
  let doc: { nodes?: Record<string, { resource_type?: string; name?: string; original_file_path?: string }> };
  try { doc = JSON.parse(manifestJson); } catch { return null; }
  for (const [id, n] of Object.entries(doc.nodes ?? {})) {
    if (n.resource_type === "analysis" && n.original_file_path === relPath) {
      return { id, name: n.name ?? "" };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/vscode && npx vitest run compiledSql`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/vscode/src/host/compiledSql.ts packages/vscode/src/host/compiledSql.test.ts
git commit -m "feat(vscode): resolve analysis nodes off the manifest (compile-analyses support)"
```

---

## Task 7: Recognize analyses in the compile commands (vscode)

**Files:**
- Modify: `packages/vscode/src/extension.ts` — import (`analysisNodeFromManifest`), add `activeCompilableNode()`, use it in `setModelCtx` and the `dbt-open-lineage.compile` command, rename the context key.
- Modify: `packages/vscode/package.json` — rename `dbtOpenLineage.activeIsModel` → `dbtOpenLineage.activeIsCompilable` in the two compile `when` clauses (lines 51, 68).

**Interfaces:**
- Consumes: `analysisNodeFromManifest` (Task 6), existing `activeModelNode`, `resolveRoot`, `readCompiledSql`, `compiledDocUri`.
- Produces: Compile Model / Recompile Model available on analysis files; context key `dbtOpenLineage.activeIsCompilable`.

- [ ] **Step 1: Import the lookup**

In `packages/vscode/src/extension.ts` line 11, add `analysisNodeFromManifest` to the `compiledSql` import:

```ts
import { readCompiledSql, readModelSql, compiledDocUri, parseCompiledDocQuery, analysisNodeFromManifest } from "./host/compiledSql";
```

- [ ] **Step 2: Add `activeCompilableNode()`**

Immediately after `activeModelNode()` (after line 131) add:

```ts
// Like activeModelNode, but also recognizes an ANALYSIS file (not in the DAG
// graph) by scanning the manifest. Used by the Compile commands + their context
// key so analyses (analyses/*.sql) can be compiled like models.
function activeCompilableNode(): { root: string; node: { id: string; name: string; path?: string } } | undefined {
  const m = activeModelNode();
  if (m) return m;
  const ed = vscode.window.activeTextEditor;
  if (!ed || path.extname(ed.document.uri.fsPath) !== ".sql" || ed.document.uri.scheme !== "file") return undefined;
  const root = resolveRoot();
  if (!root) return undefined;
  const p = path.join(root, "target", "manifest.json");
  if (!fs.existsSync(p)) return undefined;
  const rel = path.relative(root, ed.document.uri.fsPath).split(path.sep).join("/");
  const node = analysisNodeFromManifest(fs.readFileSync(p, "utf8"), rel);
  return node ? { root, node } : undefined;
}
```

- [ ] **Step 3: Point the context key at compilable nodes + rename it**

In `activate()`, change `setModelCtx` (lines 349-353):

```ts
  const setModelCtx = () => {
    void vscode.commands.executeCommand(
      "setContext", "dbtOpenLineage.activeIsCompilable", activeCompilableNode() !== undefined,
    );
  };
```

- [ ] **Step 4: Use `activeCompilableNode()` in the Compile command**

In the `dbt-open-lineage.compile` command (line 366-373), change `const m = activeModelNode();` to `const m = activeCompilableNode();`. The rest (the "not a dbt model" message, `readCompiledSql(m.root, m.node.id)`, `compiledDocUri(m.node.name, m.node.id, m.root)`) is unchanged — `m.node` carries `id` and `name` for both models and analyses.

- [ ] **Step 5: Rename the context key in package.json**

In `packages/vscode/package.json`, in both compile menu entries (editor/title line 51 and editor/context line 68) replace `dbtOpenLineage.activeIsModel` with `dbtOpenLineage.activeIsCompilable`:

```json
"when": "resourceExtname == .sql && dbtOpenLineage.activeIsCompilable",
```

- [ ] **Step 6: Typecheck + suite + host build**

Run: `cd packages/vscode && npx tsc --noEmit -p . && npx vitest run && npm run build:host`
Expected: all green.

- [ ] **Step 7: Verify the analysis recompile mechanism (spec open item)**

Against a real dbt project that has an analysis (e.g. the he-dbt-bi project), confirm `dbt compile --select <analysis_name>` writes the analysis's `compiled_code` into `target/manifest.json`:

```bash
cd <dbt-project> && dbt compile --select <analysis_name> && \
  python3 -c "import json;m=json.load(open('target/manifest.json'));print(bool([n for n in m['nodes'].values() if n.get('resource_type')=='analysis' and n['name']=='<analysis_name>' and n.get('compiled_code')]))"
```

- If it prints `True` → the existing recompile path (Task 3, `["compile","--select",name]`) works for analyses; no code change.
- If it prints `False`/errors → add an analysis fallback to the recompile command: when the compiled doc's node is an analysis, run `spawnDbtToCompletion(root, ["compile"], …)` (full compile) instead of `--select`. Record which branch was taken in the commit body.

- [ ] **Step 8: Commit**

```bash
git add packages/vscode/src/extension.ts packages/vscode/package.json
git commit -m "feat(vscode): compile/recompile support for analyses files"
```

---

## Task 8: Mnemo host parity for compile-analyses (subagent, separate repo)

**Files:** Mnemo host repo (separate from this monorepo — the subagent locates it).

**Interfaces:** Mnemo's native compile path must recognize `analysis` nodes the same way (mirror `analysisNodeFromManifest`), so the Mnemo surface can compile analyses.

- [ ] **Step 1: Dispatch a subagent to the Mnemo host repo**

Per the project rule "Mnemo changes via subagent", spawn a subagent whose task is:
- Locate the Mnemo host app repo and its dbt compile trigger (the native equivalent of VSCode's `dbt-open-lineage.compile` / `recompile` — likely in the Mnemo IDE / SCM / bridge host code).
- Extend its compilable-node lookup to include `resource_type === "analysis"` nodes matched by `original_file_path`, mirroring `packages/vscode/src/host/compiledSql.ts` `analysisNodeFromManifest`.
- Verify Mnemo already compiles silently (no Terminal concept) — silent-compile is not needed there; only analysis recognition.
- Make, commit, and release the change in that repo per its own release process.

- [ ] **Step 2: Confirm parity**

The subagent reports the Mnemo commit/version. Record it in this plan's execution notes. (This monorepo's mext bridge needs no code change — it only forwards; the change is host-side.)

---

## Task 9: Version bumps, rebuild consumers, final gate

**Files:**
- Modify: `packages/core/package.json`, `packages/mext/package.json`, `packages/vscode/package.json` (lockstep version bumps).

**Interfaces:** ships the built UI to `packages/vscode/media` and the `.mext dist`, repackages the `.vsix`.

- [ ] **Step 1: Lockstep-bump versions**

Bump `core`, `mext`, and `vscode` package versions together (patch/minor per the size of the batch — a feature batch → minor). Use the current versions as the base (core 0.2.39 / mext 0.5.39 / vscode 0.4.62 per recent commits; confirm with `git log` before choosing the next numbers).

- [ ] **Step 2: Full monorepo test run**

Run (from repo root): `npm test`
Expected: every workspace suite green.

- [ ] **Step 3: Rebuild consumers**

Run: `bash scripts/rebuild-consumers.sh`
Expected: `packages/vscode/media` rebuilt, `.mext dist` rebuilt, `.vsix` repackaged. Do NOT overwrite an existing untracked `.vsix` of the same version — the bump in Step 1 prevents that.

- [ ] **Step 4: Commit**

```bash
git add packages/core/package.json packages/mext/package.json packages/vscode/package.json
git commit -m "chore: lockstep bump for compile/selector/lock batch + rebuild consumers"
```

---

## Self-Review

**Spec coverage:**
- Silent compile (both paths) → Tasks 2 + 3. ✓
- Compile analyses (VSCode) → Tasks 6 + 7; (Mnemo) → Task 8; analysis recompile verification → Task 7 Step 7. ✓
- `unused:staging` (stg_ name prefix, no downstream, ignore tests/exposures) → Task 1. ✓
- Lock lineage (auto-lock + manual toggle + confirm; blocks onContext wipe) → Tasks 4 + 5. ✓
- No-regression gates → every task ends on a green suite/typecheck. ✓
- Parity + release → Task 9 (+ Task 8 for Mnemo). ✓

**Placeholder scan:** No TBD/TODO. The only conditional is Task 7 Step 7 (verify-then-branch), which gives both concrete branches. ✓

**Type consistency:** `spawnDbtToCompletion(root, args, onWrite, deps?)` defined in Task 2, consumed identically in Task 3. `analysisNodeFromManifest(json, relPath) → {id,name}|null` defined Task 6, consumed Task 7. `isLineageLocked`/`shouldConfirmSwitch` signatures match between Task 4 and Task 5. Context key `dbtOpenLineage.activeIsCompilable` renamed consistently in extension.ts (Task 7 Step 3) and package.json (Task 7 Step 5). ✓
