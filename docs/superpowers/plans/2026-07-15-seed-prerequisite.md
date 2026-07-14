# Run Seed Prerequisite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the DAG's active selection includes a seed, clicking Run/Build/Test runs `dbt seed` on that selection first, then the requested command — because `dbt run`/`dbt test` can never build a seed regardless of what's in `--select`.

**Architecture:** `packages/core/src/App.tsx` detects whether the active node set includes a seed (`hasSeed`) and passes it alongside the existing `{command, selector}` in the `dbt.run` invoke call. `packages/vscode/src/host/run.ts` gets a new orchestration wrapper, `startDbtRunWithSeed`, that runs `dbt seed --select <selector>` first when `hasSeed` is true (swallowing its own `done` event, forwarding everything else), then the originally-requested command — or aborts with the seed's exit code if the seed phase fails. `packages/vscode/src/extension.ts`'s `"dbt.run"` case calls the new wrapper instead of `startDbtRun` directly.

**Tech Stack:** TypeScript, vitest, VSCode Extension API (`child_process`, reusing the existing `startDbtRun`/`RunController`/`RunEvent` machinery from the DAG run-button feature).

## Global Constraints

- The same selector string is reused for both the seed phase and the main command — do not build a separate seed-only selector string. Each dbt command's own resource-type filtering naturally resolves it to the subset it cares about.
- If the seed phase fails (nonzero exit), the main command must never run. Surface the failure via a `{type:"done", exitCode}` using the seed's own exit code.
- `startDbtRun` itself (in `packages/vscode/src/host/run.ts`) is not modified — it stays single-purpose and independently testable. All new orchestration logic lives in a new wrapper function alongside it.
- The existing `activeRun` guard, Output-channel setup, and Cancel wiring in `packages/vscode/src/extension.ts` are unchanged — still exactly one logical run (one `activeRun`, one continuous Output-channel log) for the whole, optionally two-phase, sequence.
- `npm test` and `npm run typecheck`/`npx tsc --noEmit` must pass in both `packages/core` and `packages/vscode` before a task is considered complete.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `packages/vscode/src/host/run.ts` | modify | Add `startDbtRunWithSeed` — the seed-then-main orchestration wrapper. |
| `packages/vscode/src/host/run.test.ts` | modify | Tests for `startDbtRunWithSeed`; extend the `fakeChild()` helper to accept a custom pid so seed-phase and main-phase processes are distinguishable in cancel-delegation tests. |
| `packages/vscode/src/extension.ts` | modify | `"dbt.run"` case reads `hasSeed` from `msg.args` and calls `startDbtRunWithSeed` instead of `startDbtRun`. |
| `packages/core/src/App.tsx` | modify | Compute `hasSeed` from the active node set; include it in the `dbt.run` invoke call. |
| `packages/core/src/App.test.tsx` | modify | Tests for `hasSeed` computation; update the two existing `dbt.run` invoke assertions (now missing the new `hasSeed` key, since they assert exact object equality). |

---

### Task 1: VSCode host — `startDbtRunWithSeed` orchestration wrapper

**Files:**
- Modify: `packages/vscode/src/host/run.ts`
- Test: `packages/vscode/src/host/run.test.ts`

**Interfaces:**
- Consumes: `startDbtRun`, `RunController`, `RunCallbacks`, `RunDeps` (all already exist in `run.ts`, unmodified).
- Produces: `startDbtRunWithSeed(projectRoot: string, command: "run" | "build" | "test", selector: string, hasSeed: boolean, cb: RunCallbacks, deps?: RunDeps): RunController` — consumed by Task 2 (`extension.ts`).

- [ ] **Step 1: Extend `fakeChild()` to accept a custom pid**

Read `packages/vscode/src/host/run.test.ts` first to confirm current line numbers match (the file may have shifted slightly). Change:

```ts
// A minimal fake ChildProcess: an EventEmitter with stdout/stderr sub-emitters
// and a pid, enough to drive startDbtRun's wiring without a real process.
function fakeChild() {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = 4242;
  return proc;
}
```

to:

```ts
// A minimal fake ChildProcess: an EventEmitter with stdout/stderr sub-emitters
// and a pid, enough to drive startDbtRun's wiring without a real process.
// Optional pid override lets a test distinguish two concurrent-in-sequence
// fake processes (e.g. a seed phase's process vs the main command's).
function fakeChild(pid = 4242) {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = pid;
  return proc;
}
```

This is a pure default-parameter addition — every existing `fakeChild()` call (no argument) keeps behaving exactly as before.

- [ ] **Step 2: Write the failing tests for `startDbtRunWithSeed`**

Add to `packages/vscode/src/host/run.test.ts`, after the closing `});` of the existing `describe("startDbtRun", ...)` block:

```ts
describe("startDbtRunWithSeed", () => {
  it("hasSeed=false bypasses straight to a single-phase run (no seed invocation)", () => {
    const proc = fakeChild();
    const spawnSpy = vi.fn(() => proc as unknown as ChildProcess);
    const events: unknown[] = [];
    startDbtRunWithSeed(
      "/proj", "run", "stg_orders", false,
      { onWrite: () => {}, onEvent: (e) => events.push(e) },
      { spawn: spawnSpy },
    );
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy).toHaveBeenCalledWith("/proj", ["run", "--select", "stg_orders", "--log-format", "json"]);
    proc.emit("close", 0);
    expect(events).toEqual([{ type: "done", exitCode: 0 }]);
  });

  it("hasSeed=true runs `dbt seed` first, then the main command, on one continuous event/write stream", () => {
    const seedProc = fakeChild(1111);
    const mainProc = fakeChild(2222);
    let call = 0;
    const spawnSpy = vi.fn(() => (call++ === 0 ? seedProc : mainProc) as unknown as ChildProcess);
    const written: string[] = [];
    const events: unknown[] = [];
    startDbtRunWithSeed(
      "/proj", "run", "stg_orders", true,
      { onWrite: (t) => written.push(t), onEvent: (e) => events.push(e) },
      { spawn: spawnSpy },
    );

    expect(spawnSpy).toHaveBeenNthCalledWith(1, "/proj", ["seed", "--select", "stg_orders", "--log-format", "json"]);

    const seedLine = JSON.stringify({
      data: { node_info: { unique_id: "seed.proj.my_seed", node_status: "success" } },
      info: { msg: "1 of 1 OK loaded seed ..." },
    });
    seedProc.stdout.emit("data", Buffer.from(seedLine + "\n"));
    expect(events).toEqual([{ type: "status", nodeId: "seed.proj.my_seed", status: "success" }]);
    expect(written).toContain("1 of 1 OK loaded seed ...");

    seedProc.emit("close", 0);

    // The seed phase's own `done` is swallowed (not forwarded) — instead
    // the main command starts, using the SAME selector string.
    expect(spawnSpy).toHaveBeenNthCalledWith(2, "/proj", ["run", "--select", "stg_orders", "--log-format", "json"]);
    expect(events).toEqual([{ type: "status", nodeId: "seed.proj.my_seed", status: "success" }]);

    const mainLine = JSON.stringify({
      data: { node_info: { unique_id: "model.proj.stg_orders", node_status: "started" } },
      info: { msg: "1 of 1 START ..." },
    });
    mainProc.stdout.emit("data", Buffer.from(mainLine + "\n"));
    mainProc.emit("close", 0);

    expect(events).toEqual([
      { type: "status", nodeId: "seed.proj.my_seed", status: "success" },
      { type: "status", nodeId: "model.proj.stg_orders", status: "running" },
      { type: "done", exitCode: 0 },
    ]);
  });

  it("aborts with the seed's exit code when the seed phase fails, never starting the main command", () => {
    const seedProc = fakeChild(1111);
    const spawnSpy = vi.fn(() => seedProc as unknown as ChildProcess);
    const events: unknown[] = [];
    startDbtRunWithSeed(
      "/proj", "run", "x", true,
      { onWrite: () => {}, onEvent: (e) => events.push(e) },
      { spawn: spawnSpy },
    );
    seedProc.emit("close", 1);
    expect(events).toEqual([{ type: "done", exitCode: 1 }]);
    expect(spawnSpy).toHaveBeenCalledTimes(1); // the main command was never spawned
  });

  it("cancel() during the seed phase kills the seed process and the main command never starts", () => {
    const seedProc = fakeChild(1111);
    const spawnSpy = vi.fn(() => seedProc as unknown as ChildProcess);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const events: unknown[] = [];
    const controller = startDbtRunWithSeed(
      "/proj", "run", "x", true,
      { onWrite: () => {}, onEvent: (e) => events.push(e) },
      { spawn: spawnSpy, platform: "darwin" },
    );
    controller.cancel();
    expect(killSpy).toHaveBeenCalledWith(-1111, "SIGTERM");
    // Cancel sends SIGTERM; the process then exits non-zero, which the
    // wrapper treats the same as any other seed failure — abort.
    seedProc.emit("close", null);
    expect(events).toEqual([{ type: "done", exitCode: -1 }]);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    killSpy.mockRestore();
  });

  it("cancel() during the main phase delegates to the main command's controller, not the already-finished seed one", () => {
    const seedProc = fakeChild(1111);
    const mainProc = fakeChild(2222);
    let call = 0;
    const spawnSpy = vi.fn(() => (call++ === 0 ? seedProc : mainProc) as unknown as ChildProcess);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const controller = startDbtRunWithSeed(
      "/proj", "run", "x", true,
      { onWrite: () => {}, onEvent: () => {} },
      { spawn: spawnSpy, platform: "darwin" },
    );
    seedProc.emit("close", 0); // seed succeeds → main phase starts (mainProc)
    controller.cancel();
    expect(killSpy).toHaveBeenCalledWith(-2222, "SIGTERM");
    expect(killSpy).not.toHaveBeenCalledWith(-1111, "SIGTERM");
    killSpy.mockRestore();
  });
});
```

Also update the file's import line — change:

```ts
import { LineBuffer, parseDbtLogLine, mapNodeStatus, buildRunArgs, startDbtRun } from "./run";
```

to:

```ts
import { LineBuffer, parseDbtLogLine, mapNodeStatus, buildRunArgs, startDbtRun, startDbtRunWithSeed } from "./run";
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/vscode && npx vitest run src/host/run.test.ts`
Expected: FAIL — `startDbtRunWithSeed is not a function` (or a TypeScript import error, depending on how vitest reports it).

- [ ] **Step 4: Implement `startDbtRunWithSeed`**

Add to `packages/vscode/src/host/run.ts`, after the closing `}` of the existing `startDbtRun` function (i.e. at the end of the file):

```ts
/** Like `startDbtRun`, but when `hasSeed` is true, runs `dbt seed --select
 * <selector>` first — dbt run/build/test can never build a seed regardless
 * of what's in --select, since dbt excludes seeds from those commands by
 * resource type, not by selection scope. The SAME selector string is reused
 * for both phases; each dbt command's own resource-type filtering resolves
 * it to the subset it cares about, so there's no need to build a
 * seed-only selector separately.
 *
 * The seed phase's own `done` event is swallowed (never forwarded to `cb`)
 * — only its exit code is inspected. On success, the main command starts
 * exactly as `startDbtRun` would run it alone, and ITS `done` event is what
 * finally reaches `cb`. On failure, `cb` receives a `done` with the seed's
 * exit code immediately, and the main command never starts — a model that
 * depends on a seed that failed to load is likely to fail or produce wrong
 * data anyway, so stopping there is safer than proceeding.
 *
 * `hasSeed === false` bypasses this entirely and behaves identically to
 * calling `startDbtRun` directly. */
export function startDbtRunWithSeed(
  projectRoot: string, command: "run" | "build" | "test", selector: string, hasSeed: boolean,
  cb: RunCallbacks, deps: RunDeps = defaultDeps,
): RunController {
  if (!hasSeed) return startDbtRun(projectRoot, command, selector, cb, deps);

  // Reassigned once the main phase starts, so cancel() always delegates to
  // whichever phase is currently in flight.
  let current: RunController = startDbtRun(projectRoot, "seed", selector, {
    onWrite: cb.onWrite,
    onEvent: (event) => {
      if (event.type === "status") { cb.onEvent(event); return; }
      if (event.exitCode !== 0) { cb.onEvent({ type: "done", exitCode: event.exitCode }); return; }
      current = startDbtRun(projectRoot, command, selector, cb, deps);
    },
  }, deps);

  return { cancel: () => current.cancel() };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/vscode && npx vitest run src/host/run.test.ts`
Expected: PASS (all pre-existing `startDbtRun` tests plus the new `startDbtRunWithSeed` tests green).

- [ ] **Step 6: Run the full vscode suite + typecheck**

Run: `cd packages/vscode && npm test && npx tsc --noEmit`
Expected: `npm test` PASS. `npx tsc --noEmit` shows only the 8 pre-existing baseline errors in `extension.ts`/`host/context.ts`/`host/projectRoot.ts` and their tests (all `TS6142`/`TS7006`, unrelated to this change) — no new errors.

- [ ] **Step 7: Commit**

```bash
git add packages/vscode/src/host/run.ts packages/vscode/src/host/run.test.ts
git commit -m "feat(vscode): add startDbtRunWithSeed to run a seed prerequisite first"
```

---

### Task 2: VSCode extension wiring

**Files:**
- Modify: `packages/vscode/src/extension.ts`

**Interfaces:**
- Consumes: `startDbtRunWithSeed` (Task 1).
- Produces: the `"dbt.run"` command now reads an additional `hasSeed: boolean` field from `msg.args`, consumed by Task 3 (`App.tsx`, which sends it).

This task has no new unit test, by design — matches the existing convention for `extension.ts`'s command-wiring cases (the `"dbt.compile"` and `"dbt.run"`/`"dbt.cancel"` cases already have no dedicated unit tests; they're thin glue covered by `host/*.ts`'s own unit tests, verified here via typecheck + build + a manual smoke-test note).

- [ ] **Step 1: Update the import and the `"dbt.run"` case**

Read `packages/vscode/src/extension.ts` first to confirm current line numbers match (temporary diagnostic logging from an in-progress, unrelated bug investigation may still be present in this case block — leave it untouched, just change the two lines described below).

Change the import:

```ts
import { startDbtRun, type RunController } from "./host/run";
```

to:

```ts
import { startDbtRunWithSeed, type RunController } from "./host/run";
```

Inside the `"dbt.run"` case, change:

```ts
        const command = String(msg.args.command ?? "run") as "run" | "build" | "test";
        const selector = String(msg.args.selector ?? "");
        if (!selector.trim()) throw new Error("no runnable models in current view");
```

to:

```ts
        const command = String(msg.args.command ?? "run") as "run" | "build" | "test";
        const selector = String(msg.args.selector ?? "");
        const hasSeed = msg.args.hasSeed === true;
        if (!selector.trim()) throw new Error("no runnable models in current view");
```

Then find the line that calls `startDbtRun(root, command, selector, {`  inside this same case (the one that assigns to `activeRun = ...`) and change it to call `startDbtRunWithSeed` with the new `hasSeed` argument in the correct position — change:

```ts
        activeRun = startDbtRun(root, command, selector, {
```

to:

```ts
        activeRun = startDbtRunWithSeed(root, command, selector, hasSeed, {
```

Leave everything else in the case (the `onWrite`/`onEvent` callback bodies, any diagnostic logging present) exactly as-is — only the function name and the new `hasSeed` argument change.

- [ ] **Step 2: Typecheck**

Run: `cd packages/vscode && npx tsc --noEmit`
Expected: only the same 8 pre-existing baseline errors, no new ones (specifically, no error about `startDbtRun` being unused/undefined — confirm the import was fully replaced, not just added alongside).

- [ ] **Step 3: Build**

Run: `cd packages/vscode && npm run build`
Expected: PASS (both `build:host` and `build:webview` steps succeed).

- [ ] **Step 4: Run the full vscode test suite**

Run: `cd packages/vscode && npm test`
Expected: PASS (all pre-existing + Task 1 tests green; `extension.ts` remains untested at the unit level, consistent with the existing convention).

- [ ] **Step 5: Manual smoke test (documented, not automated)**

In a real dbt project with a model that depends on a seed, opened in VSCode with this extension loaded:
1. Type a selector covering both the seed and the dependent model, press Enter.
2. Click "▶ Run" → the seed's pilot light goes queued → running → success/failed BEFORE the dependent model's light moves at all.
3. If the seed fails (e.g. temporarily rename its CSV file to break it), confirm the dependent model's light never leaves queued/idle and settles to skipped when the run ends, and a "run failed" error appears reflecting the seed's failure.
4. Confirm Cancel works whether clicked during the seed phase or after the main command has started.

Record the outcome in this task's completion note — this is the one part of this feature that only a real VSCode host + real dbt project with an actual seed dependency can exercise.

- [ ] **Step 6: Commit**

```bash
git add packages/vscode/src/extension.ts
git commit -m "feat(vscode): wire dbt.run to run a seed prerequisite before the main command"
```

---

### Task 3: Core — compute `hasSeed`, send it with the run request

**Files:**
- Modify: `packages/core/src/App.tsx`
- Modify: `packages/core/src/App.test.tsx`

**Interfaces:**
- Consumes: `activeIds`, `graph` (both already exist in `App.tsx`).
- Produces: the `dbt.run` invoke call now always includes `hasSeed: boolean` alongside `{command, selector}` — this is the contract Task 2's host wiring reads.

- [ ] **Step 1: Write the failing tests**

Read `packages/core/src/App.test.tsx` first to confirm the two existing `dbt.run` assertions are still at their expected locations (search for `toHaveBeenCalledWith("dbt.run"`).

First, update the two PRE-EXISTING assertions (they'll start failing once `hasSeed` is added to the real call, since they assert exact object equality with no `hasSeed` key). Change:

```ts
      expect(invokeMock).toHaveBeenCalledWith("dbt.run", { command: "run", selector: "a b c d" }),
```

to:

```ts
      expect(invokeMock).toHaveBeenCalledWith("dbt.run", { command: "run", selector: "a b c d", hasSeed: false }),
```

and change:

```ts
      expect(invokeMock).toHaveBeenCalledWith("dbt.run", { command: "build", selector: "a b c d" }),
```

to:

```ts
      expect(invokeMock).toHaveBeenCalledWith("dbt.run", { command: "build", selector: "a b c d", hasSeed: false }),
```

Then add two new tests to the `describe("run/build/test button", ...)` block (anywhere inside it — e.g. right after the `"invokes dbt.run with the union of matched+filtered active ids as a selector, on click"` test):

```ts
  it("passes hasSeed:true when the active selection includes a seed", async () => {
    manifestGraph = {
      nodes: [
        { id: "seed.proj.my_seed", name: "my_seed", resource_type: "seed", layer: "model", path: "seeds/my_seed.csv", description: "" },
        { id: "model.proj.uses_seed", name: "uses_seed", resource_type: "model", layer: "staging", path: "m.sql", description: "" },
      ],
      edges: [{ from: "seed.proj.my_seed", to: "model.proj.uses_seed" }],
    };
    render(<App projectPath="/proj" initialSelector="my_seed uses_seed" debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("uses_seed").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("dbt.run", { command: "run", selector: "my_seed uses_seed", hasSeed: true }),
    );
  });

  it("passes hasSeed:false when the active selection has no seed", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("dbt.run", { command: "run", selector: "a b c d", hasSeed: false }),
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run App.test.tsx`
Expected: FAIL — the two updated pre-existing assertions fail (actual call has no `hasSeed` key yet), and the two new tests fail the same way.

- [ ] **Step 3: Implement `hasSeed`**

Read `packages/core/src/App.tsx` first to confirm the `runSelector` memo and `onRun` function are still at their expected locations (search for `const runSelector = useMemo`).

Change:

```tsx
  const runSelector = useMemo(() => (graph ? buildSelector(activeIds, graph) : ""), [graph, activeIds]);

  const [runMenu, setRunMenu] = useState(false);
```

to:

```tsx
  const runSelector = useMemo(() => (graph ? buildSelector(activeIds, graph) : ""), [graph, activeIds]);
  // dbt run/test can never build a seed regardless of what's in --select —
  // dbt excludes seeds from those commands by resource type, not selection
  // scope. When the active view includes a seed, the host runs `dbt seed`
  // as a prerequisite before the requested command (see onRun below).
  const hasSeed = useMemo(
    () => (graph ? graph.nodes.some((n) => activeIds.has(n.id) && n.resource_type === "seed") : false),
    [graph, activeIds],
  );

  const [runMenu, setRunMenu] = useState(false);
```

Then change:

```tsx
    try {
      await invoke<boolean>("dbt.run", { command, selector: runSelector });
    } catch (e) {
```

to:

```tsx
    try {
      await invoke<boolean>("dbt.run", { command, selector: runSelector, hasSeed });
    } catch (e) {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/core && npx vitest run App.test.tsx`
Expected: PASS (all pre-existing + new tests green).

- [ ] **Step 5: Run the full core suite + typecheck**

Run: `cd packages/core && npm test && npm run typecheck`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/App.tsx packages/core/src/App.test.tsx
git commit -m "feat(core): compute hasSeed and send it with every dbt.run request"
```

---

### Task 4: Full-repo verification sweep

**Files:** none (verification only).

- [ ] **Step 1: Run every package's test suite**

Run:
```bash
(cd packages/core && npm test)
(cd packages/vscode && npm test)
(cd packages/mext && npm test)
(cd packages/cli && npm test)
```
Expected: all PASS. `mext`/`cli` are included as a regression check — neither is touched by this plan, but both consume `@dbt-open-lineage/core`'s `Bridge`/type exports, and this plan doesn't change either, so this just confirms nothing broke.

- [ ] **Step 2: Typecheck every package**

Run:
```bash
(cd packages/core && npm run typecheck)
(cd packages/vscode && npx tsc --noEmit)
(cd packages/mext && npx tsc --noEmit)
(cd packages/cli && npx tsc --noEmit)
```
Expected: all PASS (vscode retains only its 8 pre-existing baseline errors, unrelated to this plan).

- [ ] **Step 3: Build vscode's webview + host bundles**

Run: `cd packages/vscode && npm run build`
Expected: PASS — confirms `App.tsx`'s new `hasSeed` computation and `extension.ts`'s new wiring both compile cleanly into the actual shipped bundles, not just under vitest.

## Self-Review Notes

- **Spec coverage:** detection (Task 3), host orchestration + cancel + failure semantics (Task 1), extension wiring (Task 2), testing (every task) — all covered. The spec's two explicitly out-of-scope items (the Output-panel bug, and the empty-selector-show-all-with-confirm feature) are correctly not addressed by any task here.
- **Placeholder scan:** no TBDs; Task 2 Step 5 is an intentionally manual (not automated) smoke test, called out with a reason (needs a real VSCode host + a real dbt project with an actual seed dependency), not a placeholder for missing work.
- **Type consistency:** `startDbtRunWithSeed(projectRoot, command, selector, hasSeed, cb, deps?)` — the parameter order and types are identical everywhere it's named: defined in Task 1, imported and called in Task 2 with `(root, command, selector, hasSeed, {...})`. `hasSeed: boolean` is named identically in the `App.tsx` computation (Task 3), the invoke call payload (Task 3), and `msg.args.hasSeed` read (Task 2). `RunController`/`RunCallbacks`/`RunDeps` are reused unmodified from the existing `run.ts`, no shadowing or redefinition.
