# Run UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three small, related fixes to the DAG viewer's Run/Build/Test feature: the Run▾ dropdown closes on an outside click, the "skipped" pilot-light marble becomes a clearly distinct yellow instead of near-orange, and each model's own dbt log lines are captured and shown in the details sidebar.

**Architecture:** Tasks 1-2 are self-contained UI fixes in `packages/core`. Tasks 3-4 add a new capability end-to-end: `packages/vscode/src/host/run.ts` starts emitting a new `log` `RunEvent` variant for any line dbt attributes to a node (Task 3), and `packages/core/src/App.tsx` accumulates those into per-node arrays and renders them in the sidebar (Task 4) — reusing the exact same lifecycle (new-run / Refresh / lineage-change) the existing `runStatus` map already has.

**Tech Stack:** TypeScript, React 19, vitest + `@testing-library/react`.

## Global Constraints

- "Logs for a model" means only lines dbt itself attributes to that node (via `node_info.unique_id`, or `data.attached_node` for a test line) — never unattributed banner/summary lines.
- A second Run click (without an intervening Refresh or lineage change) *replaces* a model's logs, it does not append across runs.
- Logs reset at exactly the same three points `runStatus` already resets at: a new Run (`onRun`), the Refresh button (`onResetStatus`), and a lineage change (the `useEffect` keyed on `selector`). A run *ending* (`done`) does not clear logs.
- The skipped marble's new color is `250, 204, 21` (`#facc15`, Tailwind yellow-400).
- `npm test` and `npm run typecheck`/`npx tsc --noEmit` must pass in both `packages/core` and `packages/vscode` before a task is considered complete.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `packages/core/src/App.tsx` | modify | Task 1: outside-click handling for the Run▾ dropdown. Task 4: `runLogs` state, its three reset points, the `onRunEvent` log branch, and the sidebar's logs section. |
| `packages/core/src/App.test.tsx` | modify | Tests for both of the above. |
| `packages/core/src/nodes.tsx` | modify | Task 2: skipped marble color. |
| `packages/core/src/nodes.test.tsx` | modify | Test for the new color. |
| `packages/core/src/runStatus.ts` | modify | Task 3: new `RunEvent` "log" variant. |
| `packages/vscode/src/host/run.ts` | modify | Task 3: `parseDbtLogLine` emits a `log` event alongside (not instead of) any `status` event; `startDbtRun`'s line handler forwards both; `startDbtRunWithSeed`'s seed-phase forwarding updated to pass through anything that isn't `done` (previously only `status`). |
| `packages/vscode/src/host/run.test.ts` | modify | Tests for the above; three existing tests updated for the new interleaved `log` events their fixtures now produce. |

---

### Task 1: Run-dropdown closes on outside click

**Files:**
- Modify: `packages/core/src/App.tsx`
- Test: `packages/core/src/App.test.tsx`

**Interfaces:** none — self-contained UI behavior, no new exports.

- [ ] **Step 1: Write the failing test**

Read `packages/core/src/App.test.tsx` first to confirm the `run/build/test button` describe block still contains a test starting `it("dropdown offers Build and Test, ...")` — add the new test directly after it:

```tsx
  it("closes the run dropdown when clicking outside it, but not when clicking inside it", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByLabelText("run command menu"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    // Clicking inside the dropdown itself must not spuriously close it out
    // from under the click (a naive "close on any click" would race the
    // menu item's own onClick handler).
    fireEvent.mouseDown(screen.getByRole("menu"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    // Clicking anywhere outside it (the toolbar background) closes it.
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/core && npx vitest run App.test.tsx -t "closes the run dropdown"`
Expected: FAIL — after `fireEvent.mouseDown(document.body)`, the menu is still in the document (no outside-click handling exists yet).

- [ ] **Step 3: Add the outside-click handler**

Read `packages/core/src/App.tsx` first to confirm the current text still matches (line numbers may have shifted slightly). Change:

```tsx
  const [runMenu, setRunMenu] = useState(false);
  const [runActive, setRunActive] = useState<"run" | "build" | "test" | null>(null);
  const [runStatus, setRunStatus] = useState<Map<string, RunDisplayStatus> | null>(null);
  const [runErr, setRunErr] = useState<string | null>(null);

  // Stale pilot-light colors from a previous lineage view are confusing once
```

to:

```tsx
  const [runMenu, setRunMenu] = useState(false);
  const [runActive, setRunActive] = useState<"run" | "build" | "test" | null>(null);
  const [runStatus, setRunStatus] = useState<Map<string, RunDisplayStatus> | null>(null);
  const [runErr, setRunErr] = useState<string | null>(null);

  const runMenuRef = useRef<HTMLDivElement>(null);
  // Click anywhere outside the Run▾ dropdown (or its own toggle button)
  // closes it. mousedown, not click, so a click ON the toggle button still
  // fires its own onClick afterward instead of racing this listener — by
  // the time a "click" would fire, this handler has already run and closed
  // the menu, which would make the toggle immediately reopen it.
  useEffect(() => {
    if (!runMenu) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (runMenuRef.current && !runMenuRef.current.contains(e.target as Node)) {
        setRunMenu(false);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [runMenu]);

  // Stale pilot-light colors from a previous lineage view are confusing once
```

Then find the Run/Cancel/dropdown wrapper `<div>` (search for `{canRun && !readOnly && (` followed shortly by `<div style={{ position: "relative" }}>` — it's the one whose very next line is `{runActive ? (`). Change:

```tsx
            <div style={{ position: "relative" }}>
              {runActive ? (
```

to:

```tsx
            <div ref={runMenuRef} style={{ position: "relative" }}>
              {runActive ? (
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/core && npx vitest run App.test.tsx -t "closes the run dropdown"`
Expected: PASS.

- [ ] **Step 5: Run the full core suite + typecheck**

Run: `cd packages/core && npm test && npm run typecheck`
Expected: both PASS (no regression to any other dropdown/menu test — the Export dropdown is untouched by this change).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/App.tsx packages/core/src/App.test.tsx
git commit -m "fix(core): close the Run dropdown on an outside click"
```

---

### Task 2: Skipped marble color

**Files:**
- Modify: `packages/core/src/nodes.tsx`
- Test: `packages/core/src/nodes.test.tsx`

**Interfaces:** none — internal color constant only.

- [ ] **Step 1: Write the failing test**

Read `packages/core/src/nodes.test.tsx` first to confirm the current text still matches. Change:

```tsx
  it("renders an amber marble when skipped", () => {
    expect(withStatus("skipped").getByLabelText("run status: skipped").style.background).toContain("245, 158, 11");
  });
```

to:

```tsx
  it("renders a bright yellow marble when skipped (distinct from running's orange)", () => {
    expect(withStatus("skipped").getByLabelText("run status: skipped").style.background).toContain("250, 204, 21");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/core && npx vitest run nodes.test.tsx -t "bright yellow marble"`
Expected: FAIL — the marble's background still contains the old `245, 158, 11`, not `250, 204, 21`.

- [ ] **Step 3: Change the color**

Read `packages/core/src/nodes.tsx` first to confirm the current text still matches. Change:

```tsx
/** Per-state color recipe for the run-status marble (see the render site for
 * how these compose into the gradient/glow). Tuned via a mocked-up eyeball
 * pass: running blinks orange, skipped is the same hue but solid so the two
 * stay distinguishable only by motion; failed is a deeper/cooler red than a
 * plain #ef4444 because a translucent warm red drifts toward looking orange
 * next to running otherwise. Idle is always shown (a grey marble on every
 * node), not hidden, so the indicator reads as a persistent light rather
 * than something that only appears mid-run. Queued is a distinct sky-blue —
 * a plain grey would have been indistinguishable from idle, defeating the
 * point of showing "this node is part of the run, waiting its turn" versus
 * "not part of this run at all". Steady, not blinking, so it doesn't
 * compete with running's more urgent blink. */
```

to:

```tsx
/** Per-state color recipe for the run-status marble (see the render site for
 * how these compose into the gradient/glow). Tuned via a mocked-up eyeball
 * pass: running blinks orange; skipped was originally the same hue held
 * static, but that read as indistinguishable from running at a glance, so
 * skipped is now a clear yellow (`#facc15`) instead — steady, no blink, and
 * no longer orange-family. Failed is a deeper/cooler red than a plain
 * #ef4444 because a translucent warm red drifts toward looking orange next
 * to running otherwise. Idle is always shown (a grey marble on every
 * node), not hidden, so the indicator reads as a persistent light rather
 * than something that only appears mid-run. Queued is a distinct sky-blue —
 * a plain grey would have been indistinguishable from idle, defeating the
 * point of showing "this node is part of the run, waiting its turn" versus
 * "not part of this run at all". Steady, not blinking, so it doesn't
 * compete with running's more urgent blink. */
```

and change:

```tsx
  skipped: { rgb: "245, 158, 11", hi: 0.9, a1: 0.85, a2: 0.78, a3: 0.4, glint: 0.4, glow: 6, glowSpread: 1.5, glowAlpha: 0.8 },
```

to:

```tsx
  skipped: { rgb: "250, 204, 21", hi: 0.9, a1: 0.85, a2: 0.78, a3: 0.4, glint: 0.4, glow: 6, glowSpread: 1.5, glowAlpha: 0.8 },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/core && npx vitest run nodes.test.tsx -t "bright yellow marble"`
Expected: PASS.

- [ ] **Step 5: Run the full core suite + typecheck**

Run: `cd packages/core && npm test && npm run typecheck`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/nodes.tsx packages/core/src/nodes.test.tsx
git commit -m "fix(core): make the skipped marble a clear yellow, not near-orange"
```

---

### Task 3: Host — emit a `log` RunEvent for node-attributed lines

**Files:**
- Modify: `packages/core/src/runStatus.ts`
- Modify: `packages/vscode/src/host/run.ts`
- Test: `packages/vscode/src/host/run.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `RunEvent`'s new `{ type: "log"; nodeId: string; line: string }` variant (from `runStatus.ts`), consumed by Task 4 (`App.tsx`'s `onRunEvent` handler). `parseDbtLogLine`'s return type gains a `logEvent: RunEvent | null` field, consumed only within this task's own `startDbtRun`.

- [ ] **Step 1: Add the `log` variant to `RunEvent`**

Read `packages/core/src/runStatus.ts` first to confirm the current text still matches. Change:

```ts
/** Pushed from the host to the webview while a dbt run/build/test is in
 * flight. `status` events arrive as dbt's own `--log-format json` stream is
 * parsed (see packages/vscode/src/host/run.ts); exactly one `done` event
 * arrives when the underlying process exits. */
export type RunEvent =
  | { type: "status"; nodeId: string; status: Status }
  | { type: "done"; exitCode: number };
```

to:

```ts
/** Pushed from the host to the webview while a dbt run/build/test is in
 * flight. `status` events arrive as dbt's own `--log-format json` stream is
 * parsed (see packages/vscode/src/host/run.ts); `log` events carry that
 * same stream's human-readable text, attributed to whichever node dbt
 * itself attributed the line to (a line with no node attribution produces
 * neither a `status` nor a `log` event); exactly one `done` event arrives
 * when the underlying process exits. */
export type RunEvent =
  | { type: "status"; nodeId: string; status: Status }
  | { type: "log"; nodeId: string; line: string }
  | { type: "done"; exitCode: number };
```

- [ ] **Step 2: Write the failing tests for `parseDbtLogLine`'s new `logEvent` field**

Read `packages/vscode/src/host/run.test.ts` first to confirm the current text still matches (line numbers may have shifted slightly). Two existing whole-object-equality assertions need `logEvent: null` added — change:

```ts
  it("an empty line displays as-is with no event", () => {
    expect(parseDbtLogLine("")).toEqual({ event: null, display: "" });
  });
```

to:

```ts
  it("an empty line displays as-is with no event", () => {
    expect(parseDbtLogLine("")).toEqual({ event: null, logEvent: null, display: "" });
  });
```

and change:

```ts
  it("real dbt 1.11.11 blank formatting line: displays empty string, no event", () => {
    expect(parseDbtLogLine(REAL_FORMATTING_LINE)).toEqual({ event: null, display: "" });
  });
```

to:

```ts
  it("real dbt 1.11.11 blank formatting line: displays empty string, no event", () => {
    expect(parseDbtLogLine(REAL_FORMATTING_LINE)).toEqual({ event: null, logEvent: null, display: "" });
  });
```

Then add new tests. Insert them right after the `it("a line with no node_info displays but produces no status event", ...)` test (the one using `data: {}`):

```ts
  it("a node-attributed line ALSO produces a log event alongside its status event", () => {
    const { event, logEvent } = parseDbtLogLine(nodeLine("1 of 3 START sql table model main.stg_orders", "started"));
    expect(event).toEqual({ type: "status", nodeId: "model.proj.stg_orders", status: "running" });
    expect(logEvent).toEqual({ type: "log", nodeId: "model.proj.stg_orders", line: "1 of 3 START sql table model main.stg_orders" });
  });

  it("a node-attributed line with an UNRECOGNIZED node_status still produces a log event, just no status event", () => {
    const { event, logEvent } = parseDbtLogLine(nodeLine("1 of 3 WARN something main.stg_orders", "warn"));
    expect(event).toBeNull();
    expect(logEvent).toEqual({ type: "log", nodeId: "model.proj.stg_orders", line: "1 of 3 WARN something main.stg_orders" });
  });

  it("a line with no node attribution produces neither a status nor a log event", () => {
    const { event, logEvent } = parseDbtLogLine(JSON.stringify({ data: {}, info: { msg: "Found 3 models", level: "info" } }));
    expect(event).toBeNull();
    expect(logEvent).toBeNull();
  });
```

And after the existing `it("real dbt 1.11.11 test PASS line: routes the status to the parent model via attached_node, not the test's own unique_id", ...)` test, add:

```ts
  it("real dbt 1.11.11 test START line: no attached_node yet, so no log event either", () => {
    const { logEvent } = parseDbtLogLine(REAL_TEST_START_LINE);
    expect(logEvent).toBeNull();
  });

  it("real dbt 1.11.11 test PASS line: the log event routes to the parent model too, not the test", () => {
    const { logEvent } = parseDbtLogLine(REAL_TEST_PASS_LINE);
    expect(logEvent).toEqual({
      type: "log",
      nodeId: "model.he_dbt_bi.int_invoices_with_invoice_lines",
      line: "1 of 2 PASS accepted_values_int_invoices_with_invoice_lines_invoice_source__chikpea__netsuite  [PASS in 3.15s]",
    });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/vscode && npx vitest run src/host/run.test.ts`
Expected: FAIL — `logEvent` is `undefined` everywhere (the field doesn't exist yet), and the two updated whole-object assertions fail too.

- [ ] **Step 4: Implement `logEvent` in `parseDbtLogLine`**

Read `packages/vscode/src/host/run.ts` first to confirm the current text still matches. Change:

```ts
export interface ParsedLine { event: RunEvent | null; display: string }

/** Parse one line of `dbt ... --log-format json` output. `display` is always
 * populated (the JSON's human-readable `info.msg` field when present,
 * otherwise the raw line) so the terminal panel reads like normal dbt output
 * even though the underlying process emits structured JSON. A malformed line
 * (partial write, non-JSON noise) must never throw — it just displays raw
 * with no status event.
 *
 * dbt-core's real json-log schema (verified against dbt-core=1.11.11) wraps
 * every line as `{data: {...}, info: {...}}` — msg lives at `info.msg`,
 * node_info lives at `data.node_info`. Neither is top-level.
 *
 * A `dbt test` run needs extra care: a test is its own manifest node with
 * its own `unique_id` (e.g. `test.proj.not_null_x.<hash>`), which never
 * matches any id in the DAG — only models/seeds/snapshots/sources are graph
 * nodes, tests aren't. A test's status must instead route to the MODEL it
 * tests, via `data.attached_node` (verified against a live `dbt test` run).
 * That field is only present on the test's FINISH event, not its START —
 * dbt doesn't say which model a just-started test belongs to — so a test
 * starting produces no status event; the model's pilot light jumps straight
 * from idle to pass/fail once the test ends, with no "running" blink for
 * test-only activity. */
export function parseDbtLogLine(line: string): ParsedLine {
  if (!line.trim()) return { event: null, display: line };
  let parsed: unknown;
  try { parsed = JSON.parse(line); }
  catch { return { event: null, display: line }; }
  const obj = parsed as {
    info?: { msg?: unknown };
    data?: {
      node_info?: { unique_id?: unknown; node_status?: unknown; resource_type?: unknown };
      attached_node?: unknown;
    };
  };
  const display = typeof obj.info?.msg === "string" ? obj.info.msg : line;
  const info = obj.data?.node_info;
  if (info && typeof info.node_status === "string") {
    const nodeId = info.resource_type === "test"
      ? (typeof obj.data?.attached_node === "string" ? obj.data.attached_node : undefined)
      : (typeof info.unique_id === "string" ? info.unique_id : undefined);
    if (nodeId) {
      const status = mapNodeStatus(info.node_status);
      if (status) return { event: { type: "status", nodeId, status }, display };
    }
  }
  return { event: null, display };
}
```

to:

```ts
export interface ParsedLine { event: RunEvent | null; logEvent: RunEvent | null; display: string }

/** Parse one line of `dbt ... --log-format json` output. `display` is always
 * populated (the JSON's human-readable `info.msg` field when present,
 * otherwise the raw line) so the terminal panel reads like normal dbt output
 * even though the underlying process emits structured JSON. A malformed line
 * (partial write, non-JSON noise) must never throw — it just displays raw
 * with no status/log event.
 *
 * dbt-core's real json-log schema (verified against dbt-core=1.11.11) wraps
 * every line as `{data: {...}, info: {...}}` — msg lives at `info.msg`,
 * node_info lives at `data.node_info`. Neither is top-level.
 *
 * A `dbt test` run needs extra care: a test is its own manifest node with
 * its own `unique_id` (e.g. `test.proj.not_null_x.<hash>`), which never
 * matches any id in the DAG — only models/seeds/snapshots/sources are graph
 * nodes, tests aren't. A test's status/log must instead route to the MODEL
 * it tests, via `data.attached_node` (verified against a live `dbt test`
 * run). That field is only present on the test's FINISH event, not its
 * START — dbt doesn't say which model a just-started test belongs to — so
 * a test starting produces no status AND no log event; the model's pilot
 * light and log both jump straight from idle to pass/fail once the test
 * ends.
 *
 * `event` (status) requires BOTH a resolvable node id AND a `node_status`
 * that maps to a known `Status`. `logEvent` requires only the resolvable
 * node id — a line whose `node_status` doesn't map to anything (e.g.
 * "warn") still carries a `logEvent`, it just carries no `event`. */
export function parseDbtLogLine(line: string): ParsedLine {
  if (!line.trim()) return { event: null, logEvent: null, display: line };
  let parsed: unknown;
  try { parsed = JSON.parse(line); }
  catch { return { event: null, logEvent: null, display: line }; }
  const obj = parsed as {
    info?: { msg?: unknown };
    data?: {
      node_info?: { unique_id?: unknown; node_status?: unknown; resource_type?: unknown };
      attached_node?: unknown;
    };
  };
  const display = typeof obj.info?.msg === "string" ? obj.info.msg : line;
  const info = obj.data?.node_info;
  let event: RunEvent | null = null;
  let logEvent: RunEvent | null = null;
  if (info) {
    const nodeId = info.resource_type === "test"
      ? (typeof obj.data?.attached_node === "string" ? obj.data.attached_node : undefined)
      : (typeof info.unique_id === "string" ? info.unique_id : undefined);
    if (nodeId) {
      logEvent = { type: "log", nodeId, line: display };
      if (typeof info.node_status === "string") {
        const status = mapNodeStatus(info.node_status);
        if (status) event = { type: "status", nodeId, status };
      }
    }
  }
  return { event, logEvent, display };
}
```

- [ ] **Step 5: Run the `parseDbtLogLine` tests to verify they pass**

Run: `cd packages/vscode && npx vitest run src/host/run.test.ts -t "parseDbtLogLine"`
Expected: PASS (all `parseDbtLogLine` tests, including the 5 new ones and the 2 updated ones).

- [ ] **Step 6: Update `startDbtRun`'s line handler to forward `logEvent` too**

Change:

```ts
  const handle = (lines: string[]) => {
    for (const line of lines) {
      const { event, display } = parseDbtLogLine(line);
      cb.onWrite(display);
      if (event) cb.onEvent(event);
    }
  };
```

to:

```ts
  const handle = (lines: string[]) => {
    for (const line of lines) {
      const { event, logEvent, display } = parseDbtLogLine(line);
      cb.onWrite(display);
      if (event) cb.onEvent(event);
      if (logEvent) cb.onEvent(logEvent);
    }
  };
```

- [ ] **Step 7: Update `startDbtRunWithSeed`'s seed-phase forwarding**

The seed phase's `onEvent` callback currently only forwards `status` events through and treats everything else as `done` — with a third event type now possible, that assumption breaks (a `log` event has no `exitCode`, so the existing `if (event.exitCode !== 0)` check right after would be a type error against the narrowed union). Change:

```ts
  let current: RunController = startDbtRun(projectRoot, "seed" as "run" | "build" | "test", selector, {
    onWrite: cb.onWrite,
    onEvent: (event) => {
      if (event.type === "status") { cb.onEvent(event); return; }
      if (event.exitCode !== 0) { cb.onEvent({ type: "done", exitCode: event.exitCode }); return; }
      current = startDbtRun(projectRoot, command, selector, cb, deps);
    },
  }, deps);
```

to:

```ts
  let current: RunController = startDbtRun(projectRoot, "seed" as "run" | "build" | "test", selector, {
    onWrite: cb.onWrite,
    onEvent: (event) => {
      // Forward everything except the seed phase's own `done` — that one
      // is inspected (for its exit code) rather than passed through, since
      // this wrapper's own `done` contract covers the WHOLE two-phase run.
      if (event.type !== "done") { cb.onEvent(event); return; }
      if (event.exitCode !== 0) { cb.onEvent({ type: "done", exitCode: event.exitCode }); return; }
      current = startDbtRun(projectRoot, command, selector, cb, deps);
    },
  }, deps);
```

- [ ] **Step 8: Update the `startDbtRun`/`startDbtRunWithSeed` tests whose fixtures now also produce `log` events**

Two existing tests push a line carrying a recognized `node_status`, and their `events` array assertions expect only the `status`/`done` events — with `logEvent` now also firing for that same line, these need the interleaved `log` entries added.

Change:

```ts
  it("parses stdout lines into onWrite/onEvent calls, then emits done on close", () => {
    const proc = fakeChild();
    const spawnSpy = vi.fn(() => proc as unknown as ChildProcess);
    const written: string[] = [];
    const events: unknown[] = [];
    startDbtRun("/proj", "run", "stg_orders", { onWrite: (t) => written.push(t), onEvent: (e) => events.push(e) }, { spawn: spawnSpy });

    expect(spawnSpy).toHaveBeenCalledWith("/proj", ["run", "--select", "stg_orders", "--log-format", "json"]);

    const line = JSON.stringify({
      data: { node_info: { unique_id: "model.proj.stg_orders", node_status: "started" } },
      info: { msg: "1 of 1 START ..." },
    });
    proc.stdout.emit("data", Buffer.from(line + "\n"));
    expect(written).toEqual(["1 of 1 START ..."]);
    expect(events).toEqual([{ type: "status", nodeId: "model.proj.stg_orders", status: "running" }]);

    proc.emit("close", 0);
    expect(events).toEqual([
      { type: "status", nodeId: "model.proj.stg_orders", status: "running" },
      { type: "done", exitCode: 0 },
    ]);
  });
```

to:

```ts
  it("parses stdout lines into onWrite/onEvent calls (both status AND log), then emits done on close", () => {
    const proc = fakeChild();
    const spawnSpy = vi.fn(() => proc as unknown as ChildProcess);
    const written: string[] = [];
    const events: unknown[] = [];
    startDbtRun("/proj", "run", "stg_orders", { onWrite: (t) => written.push(t), onEvent: (e) => events.push(e) }, { spawn: spawnSpy });

    expect(spawnSpy).toHaveBeenCalledWith("/proj", ["run", "--select", "stg_orders", "--log-format", "json"]);

    const line = JSON.stringify({
      data: { node_info: { unique_id: "model.proj.stg_orders", node_status: "started" } },
      info: { msg: "1 of 1 START ..." },
    });
    proc.stdout.emit("data", Buffer.from(line + "\n"));
    expect(written).toEqual(["1 of 1 START ..."]);
    expect(events).toEqual([
      { type: "status", nodeId: "model.proj.stg_orders", status: "running" },
      { type: "log", nodeId: "model.proj.stg_orders", line: "1 of 1 START ..." },
    ]);

    proc.emit("close", 0);
    expect(events).toEqual([
      { type: "status", nodeId: "model.proj.stg_orders", status: "running" },
      { type: "log", nodeId: "model.proj.stg_orders", line: "1 of 1 START ..." },
      { type: "done", exitCode: 0 },
    ]);
  });
```

And change:

```ts
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
```

to:

```ts
  it("hasSeed=true runs `dbt seed` first, then the main command, on one continuous event/write stream (status AND log both forwarded through both phases)", () => {
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
    expect(events).toEqual([
      { type: "status", nodeId: "seed.proj.my_seed", status: "success" },
      { type: "log", nodeId: "seed.proj.my_seed", line: "1 of 1 OK loaded seed ..." },
    ]);
    expect(written).toContain("1 of 1 OK loaded seed ...");

    seedProc.emit("close", 0);

    // The seed phase's own `done` is swallowed (not forwarded) — instead
    // the main command starts, using the SAME selector string.
    expect(spawnSpy).toHaveBeenNthCalledWith(2, "/proj", ["run", "--select", "stg_orders", "--log-format", "json"]);
    expect(events).toEqual([
      { type: "status", nodeId: "seed.proj.my_seed", status: "success" },
      { type: "log", nodeId: "seed.proj.my_seed", line: "1 of 1 OK loaded seed ..." },
    ]);

    const mainLine = JSON.stringify({
      data: { node_info: { unique_id: "model.proj.stg_orders", node_status: "started" } },
      info: { msg: "1 of 1 START ..." },
    });
    mainProc.stdout.emit("data", Buffer.from(mainLine + "\n"));
    mainProc.emit("close", 0);

    expect(events).toEqual([
      { type: "status", nodeId: "seed.proj.my_seed", status: "success" },
      { type: "log", nodeId: "seed.proj.my_seed", line: "1 of 1 OK loaded seed ..." },
      { type: "status", nodeId: "model.proj.stg_orders", status: "running" },
      { type: "log", nodeId: "model.proj.stg_orders", line: "1 of 1 START ..." },
      { type: "done", exitCode: 0 },
    ]);
  });
```

The other four `startDbtRun`/`startDbtRunWithSeed` tests (trailing-partial-line flush, spawn error, double-done guard, all three cancel tests, and the seed-failure-abort test) push no `stdout` data carrying `node_info` — none of them produce a `log` event, so none of them need changes. Do not modify them.

- [ ] **Step 9: Run the full vscode suite + typecheck**

Run: `cd packages/vscode && npm test && npx tsc --noEmit`
Expected: `npm test` PASS (all pre-existing + new/updated tests green). `npx tsc --noEmit` shows only the 8 pre-existing baseline errors in `extension.ts`/`host/context.ts`/`host/projectRoot.ts` and their tests (all `TS6142`/`TS7006`, unrelated to this change) — no new errors.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/runStatus.ts packages/vscode/src/host/run.ts packages/vscode/src/host/run.test.ts
git commit -m "feat(vscode): emit a log RunEvent for every node-attributed dbt output line"
```

---

### Task 4: Webview — capture and display per-model logs

**Files:**
- Modify: `packages/core/src/App.tsx`
- Test: `packages/core/src/App.test.tsx`

**Interfaces:**
- Consumes: `RunEvent`'s `"log"` variant (Task 3, `packages/core/src/runStatus.ts`).
- Produces: nothing consumed by a later task — this is the last task.

- [ ] **Step 1: Write the failing tests**

Read `packages/core/src/App.test.tsx` first to confirm the current text still matches (in particular the `run/build/test button` describe block's existing tests, and the exact fixture `g` at the top of the file — nodes `a, b, c, d`, ids equal to names). Add these tests to the `run/build/test button` describe block, after the existing `it("clears the pilot light and any run error when the lineage changes (selector commit)", ...)` test:

```tsx
  it("a log RunEvent appends that line to the right node's log, shown in its sidebar section once selected", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() => expect(runEventCb).not.toBeNull());
    act(() => runEventCb!({ type: "log", nodeId: "a", line: "1 of 4 START sql table model main.a" }));
    act(() => runEventCb!({ type: "log", nodeId: "a", line: "1 of 4 OK created sql table model main.a" }));
    fireEvent.click(screen.getAllByText("a")[0]);
    await waitFor(() => expect(screen.getByText("1 of 4 START sql table model main.a")).toBeInTheDocument());
    expect(screen.getByText("1 of 4 OK created sql table model main.a")).toBeInTheDocument();
  });

  it("a node with no logs yet shows no logs section", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText("a")[0]);
    await waitFor(() => expect(screen.getByText("type")).toBeInTheDocument()); // sidebar is open
    expect(screen.queryByText("logs")).not.toBeInTheDocument();
  });

  it("a second Run replaces a node's logs rather than appending to them", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() => expect(runEventCb).not.toBeNull());
    act(() => runEventCb!({ type: "log", nodeId: "a", line: "first run's line" }));
    act(() => runEventCb!({ type: "done", exitCode: 0 }));
    fireEvent.click(screen.getByText("▶ Run"));
    act(() => runEventCb!({ type: "log", nodeId: "a", line: "second run's line" }));
    fireEvent.click(screen.getAllByText("a")[0]);
    await waitFor(() => expect(screen.getByText("second run's line")).toBeInTheDocument());
    expect(screen.queryByText("first run's line")).not.toBeInTheDocument();
  });

  it("Refresh clears logs alongside the pilot light", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() => expect(runEventCb).not.toBeNull());
    act(() => runEventCb!({ type: "log", nodeId: "a", line: "a line to clear" }));
    act(() => runEventCb!({ type: "done", exitCode: 1 })); // enables the Refresh button
    fireEvent.click(screen.getByLabelText("reset run status"));
    fireEvent.click(screen.getAllByText("a")[0]);
    await waitFor(() => expect(screen.getByText("type")).toBeInTheDocument());
    expect(screen.queryByText("a line to clear")).not.toBeInTheDocument();
  });

  it("a lineage change clears logs alongside the pilot light", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() => expect(runEventCb).not.toBeNull());
    act(() => runEventCb!({ type: "log", nodeId: "a", line: "a line to clear" }));

    const input = screen.getByPlaceholderText(/select/i);
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByText("b")).not.toBeInTheDocument());

    fireEvent.click(screen.getAllByText("a")[0]);
    await waitFor(() => expect(screen.getByText("type")).toBeInTheDocument());
    expect(screen.queryByText("a line to clear")).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run App.test.tsx -t "log RunEvent|no logs section|replaces a node|Refresh clears logs|lineage change clears logs"`
Expected: FAIL — `runLogs` doesn't exist yet, so no "log" branch handles the event and no sidebar section renders.

- [ ] **Step 3: Add `runLogs` state and its reset points**

Read `packages/core/src/App.tsx` first to confirm the current text still matches (Task 1, if already applied, changes lines just above this block but not this block itself — the anchor text below is unaffected either way). Change:

```tsx
  const [runErr, setRunErr] = useState<string | null>(null);
```

(the ONE inside the state-declarations cluster, immediately followed by either Task 1's new `runMenuRef` block or, if Task 1 hasn't run yet, directly by the `// Stale pilot-light colors...` comment — search for `const [runErr, setRunErr] = useState<string | null>(null);` to find it unambiguously, there is only one) to:

```tsx
  const [runErr, setRunErr] = useState<string | null>(null);
  // Per-node dbt output, only for lines dbt itself attributes to that node
  // (RunEvent's "log" variant) — never unattributed banner/summary lines.
  // Same three-point reset lifecycle as runStatus: a new run replaces it,
  // Refresh clears it, a lineage change clears it. A run ENDING does not
  // clear it — the last run's logs stay visible until one of those three
  // things happens.
  const [runLogs, setRunLogs] = useState<Map<string, string[]> | null>(null);
```

Then change the lineage-change reset effect:

```tsx
  useEffect(() => {
    setRunStatus(null);
    setRunErr(null);
  }, [selector]);

  const onResetStatus = () => {
    setRunStatus(null);
    setRunErr(null);
  };
```

to:

```tsx
  useEffect(() => {
    setRunStatus(null);
    setRunErr(null);
    setRunLogs(null);
  }, [selector]);

  const onResetStatus = () => {
    setRunStatus(null);
    setRunErr(null);
    setRunLogs(null);
  };
```

Then update the `onRunEvent` handler for the new three-way branch. Change:

```tsx
  useEffect(() => onRunEvent((e: RunEvent) => {
    if (e.type === "status") {
      setRunStatus((prev) => {
        const next = new Map(prev ?? []);
        next.set(e.nodeId, e.status);
        return next;
      });
    } else {
      setRunActive(null);
      // "Never left spinning": any node still `running` OR `queued` when the
      // run ends (success, failure, or cancel) has no terminal status
      // coming — Cancel sends SIGTERM mid-flight, so an in-flight node's dbt
      // process never emits one, and a cancelled/early-failed run can leave
      // many nodes still queued, never even reached. Flip both to `skipped`
      // so nothing is left spinning OR stuck looking like it's still queued.
      setRunStatus((prev) => {
        if (!prev) return prev;
        const next = new Map(prev);
        let changed = false;
        for (const [id, status] of next) {
          if (status === "running" || status === "queued") { next.set(id, "skipped"); changed = true; }
        }
        return changed ? next : prev;
      });
      if (e.exitCode !== 0) setRunErr(`run failed (exit ${e.exitCode})`);
    }
  }), []);
```

to:

```tsx
  useEffect(() => onRunEvent((e: RunEvent) => {
    if (e.type === "status") {
      setRunStatus((prev) => {
        const next = new Map(prev ?? []);
        next.set(e.nodeId, e.status);
        return next;
      });
    } else if (e.type === "log") {
      setRunLogs((prev) => {
        const next = new Map(prev ?? []);
        next.set(e.nodeId, [...(next.get(e.nodeId) ?? []), e.line]);
        return next;
      });
    } else {
      setRunActive(null);
      // "Never left spinning": any node still `running` OR `queued` when the
      // run ends (success, failure, or cancel) has no terminal status
      // coming — Cancel sends SIGTERM mid-flight, so an in-flight node's dbt
      // process never emits one, and a cancelled/early-failed run can leave
      // many nodes still queued, never even reached. Flip both to `skipped`
      // so nothing is left spinning OR stuck looking like it's still queued.
      setRunStatus((prev) => {
        if (!prev) return prev;
        const next = new Map(prev);
        let changed = false;
        for (const [id, status] of next) {
          if (status === "running" || status === "queued") { next.set(id, "skipped"); changed = true; }
        }
        return changed ? next : prev;
      });
      if (e.exitCode !== 0) setRunErr(`run failed (exit ${e.exitCode})`);
    }
  }), []);
```

Then update `onRun` to seed a fresh `runLogs` map alongside the existing `queued` seeding. Change:

```tsx
  const onRun = async (command: "run" | "build" | "test") => {
    setRunMenu(false);
    if (!runSelector) return;
    setRunErr(null);
    // Seed every node in the run's scope as "queued" immediately, rather
    // than an empty map — otherwise a node waiting its turn looks identical
    // to a node that isn't part of this run at all (both render idle-grey)
    // until dbt's own START event for it arrives, which can be a while for
    // a large selection.
    setRunStatus(new Map([...activeIds].map((id) => [id, "queued" as const])));
    setRunActive(command);
```

to:

```tsx
  const onRun = async (command: "run" | "build" | "test") => {
    setRunMenu(false);
    if (!runSelector) return;
    setRunErr(null);
    // Seed every node in the run's scope as "queued" immediately, rather
    // than an empty map — otherwise a node waiting its turn looks identical
    // to a node that isn't part of this run at all (both render idle-grey)
    // until dbt's own START event for it arrives, which can be a while for
    // a large selection.
    setRunStatus(new Map([...activeIds].map((id) => [id, "queued" as const])));
    // A second Run (without an intervening Refresh/lineage-change) REPLACES
    // per-node logs, it does not append across runs.
    setRunLogs(new Map());
    setRunActive(command);
```

- [ ] **Step 4: Add the sidebar logs section**

Read `packages/core/src/App.tsx` first to confirm the current text still matches. First, add a derived value and an auto-scroll ref/effect. Find `const editable = !readOnly && !!selectedNode && selectedNode.resource_type !== "source";` and change:

```tsx
  const editable = !readOnly && !!selectedNode && selectedNode.resource_type !== "source";
```

to:

```tsx
  const editable = !readOnly && !!selectedNode && selectedNode.resource_type !== "source";
  const selectedLogs = selectedNode ? runLogs?.get(selectedNode.id) : undefined;
  const logsBoxRef = useRef<HTMLDivElement>(null);
  // Auto-scroll the logs box to its latest line while it's open — reads
  // like a tailing terminal for a model that's actively running.
  useEffect(() => {
    if (logsBoxRef.current) logsBoxRef.current.scrollTop = logsBoxRef.current.scrollHeight;
  }, [selectedLogs?.length]);
```

Then find the `tests` section in the sidebar (search for `<dt style={{ color: "#94a3b8", marginTop: 8 }}>tests</dt>`) and add the new section right after its closing `</dd>`, before the closing `</dl>`. Change:

```tsx
            <dt style={{ color: "#94a3b8", marginTop: 8 }}>tests</dt>
            <dd style={{ margin: 0, wordBreak: "break-word" }}>
              {selectedNode.tests?.length
                ? (
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {selectedNode.tests.map((t) => <li key={t}>{t}</li>)}
                  </ul>
                )
                : "—"}
            </dd>
          </dl>
```

to:

```tsx
            <dt style={{ color: "#94a3b8", marginTop: 8 }}>tests</dt>
            <dd style={{ margin: 0, wordBreak: "break-word" }}>
              {selectedNode.tests?.length
                ? (
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {selectedNode.tests.map((t) => <li key={t}>{t}</li>)}
                  </ul>
                )
                : "—"}
            </dd>

            {/* Only rendered once this node has at least one log line —
                an idle/never-run node shows nothing here, keeping the
                common case uncluttered. */}
            {selectedLogs && selectedLogs.length > 0 && (
              <>
                <dt style={{ color: "#94a3b8", marginTop: 8 }}>logs</dt>
                <dd style={{ margin: 0 }}>
                  <div
                    ref={logsBoxRef}
                    style={{
                      height: 150, overflowY: "auto", background: "#0b1220",
                      border: "1px solid #334155", borderRadius: 6, padding: 6,
                      fontFamily: "ui-monospace, monospace", fontSize: 11, lineHeight: 1.5,
                      color: "#cbd5e1", whiteSpace: "pre-wrap", wordBreak: "break-word",
                    }}
                  >
                    {selectedLogs.map((line, i) => <div key={i}>{line}</div>)}
                  </div>
                </dd>
              </>
            )}
          </dl>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/core && npx vitest run App.test.tsx -t "log RunEvent|no logs section|replaces a node|Refresh clears logs|lineage change clears logs"`
Expected: PASS.

- [ ] **Step 6: Run the full core suite + typecheck**

Run: `cd packages/core && npm test && npm run typecheck`
Expected: both PASS — no regression to any pre-existing `run/build/test button`, `readOnly mode`, or sidebar test.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/App.tsx packages/core/src/App.test.tsx
git commit -m "feat(core): show each model's own dbt log lines in the details sidebar"
```

---

### Task 5: Full-repo verification sweep

**Files:** none (verification only).

- [ ] **Step 1: Run every package's test suite**

Run:
```bash
(cd packages/core && npm test)
(cd packages/vscode && npm test)
(cd packages/mext && npm test)
(cd packages/cli && npm test)
```
Expected: all PASS. `mext`/`cli` are a regression check — neither is touched by this plan, but both consume `@dbt-open-lineage/core`'s type exports (`RunEvent` gained a new union member), so this confirms nothing there broke.

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
Expected: PASS — confirms the new sidebar UI, dropdown behavior, marble color, and log-event plumbing all compile cleanly into the actual shipped bundles.

## Self-Review Notes

- **Spec coverage:** dropdown outside-click (Task 1), skipped color (Task 2), log capture scope + host emission (Task 3), webview accumulation + three-point reset lifecycle + sidebar UI + auto-scroll (Task 4) — all covered. The spec's "Out of scope" items (persistence across reload, non-run/build/test resource types, copy/export/search in the log box) are correctly not addressed by any task.
- **Placeholder scan:** no TBDs. Every test includes its full assertion code; every host/webview change shows exact before/after text.
- **Type consistency:** `RunEvent`'s `"log"` variant (`{type:"log", nodeId, line}`) is defined once in Task 3 (`runStatus.ts`) and referenced identically everywhere else — `ParsedLine.logEvent` (Task 3, `run.ts`), the `onRunEvent` handler's new `else if (e.type === "log")` branch (Task 4, `App.tsx`). `runLogs: Map<string, string[]> | null` is named and typed identically at its declaration, its three reset points, and its sidebar read site, all within Task 4. Task 3's fix to `startDbtRunWithSeed` (checking `event.type !== "done"` instead of `event.type === "status"`) was necessary for the file to typecheck at all once `RunEvent` gained a third member — verified by tracing the narrowed-union type through that function's existing `event.exitCode` access, not just assumed.
