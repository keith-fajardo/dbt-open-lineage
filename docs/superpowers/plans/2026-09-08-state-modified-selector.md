# `state:` Selector Method Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support dbt's `state:` selector family (e.g. `state:modified+`) in the DAG viewer's selector box by delegating resolution to a live `dbt ls` process.

**Architecture:** When a committed selector contains a `state:` term, the webview hands the whole cleaned expression to a new async `dbt.ls` host command that runs `dbt ls --select "<expr>" --state <dir> --output json --output-keys unique_id` and returns matched `unique_id`s. The webview resolves this on Enter (single-flight, mirroring the existing column-lineage fetch) and feeds the result into the same `matched` node set the DAG already consumes. dbt itself computes the manifest diff — nothing is reimplemented in-node.

**Tech Stack:** TypeScript, React (core webview), VSCode extension host, Vitest (per-workspace: core=jsdom, vscode=node), Node `child_process`.

**Spec:** `docs/superpowers/specs/2026-09-08-state-modified-selector-design.md`

## Global Constraints

- Scope: live IDE surfaces only (VSCode + Mnemo mext). Static CLI export is out of scope.
- `--state <dir>` for the selector comes from `runFlags.state` (already parsed by `parseRunFlags`) — the same token that feeds the deferred run.
- Node identity across the host boundary is `unique_id` (maps directly to graph node ids), never `name`.
- No new runtime dependencies.
- Tests first (TDD). Sanctioned test command: `npm run test --workspaces --if-present`. Per-package: `npm run test -w @dbt-open-lineage/core` / `-w vscode`.
- A malformed / non-JSON host output line must never throw — it is ignored (same discipline as `parseDbtLogLine`).
- Any new host bridge command MUST be added to `packages/mext/manifest.json` `host_perms` or Mnemo silently blocks it.
- Do NOT bump versions, repack `.vsix`, or run `rebuild-consumers.sh` — that happens only on an explicit "release".

---

### Task 1: `hasStateSelector` detector (core)

**Files:**
- Modify: `packages/core/src/selector.ts`
- Test: `packages/core/src/selector.test.ts`

**Interfaces:**
- Produces: `export function hasStateSelector(expr: string): boolean` — true if any whitespace/comma-separated term of `expr`, after stripping `+`/`Ndigit` hop operators, has method `state`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/selector.test.ts`:

```ts
import { hasStateSelector } from "./selector";

describe("hasStateSelector", () => {
  it("detects a bare state term", () => {
    expect(hasStateSelector("state:modified")).toBe(true);
  });
  it("detects state with hop operators", () => {
    expect(hasStateSelector("state:modified+")).toBe(true);
    expect(hasStateSelector("+state:modified")).toBe(true);
    expect(hasStateSelector("2+state:modified+3")).toBe(true);
  });
  it("detects state inside a union or comma-intersection", () => {
    expect(hasStateSelector("tag:mart state:new")).toBe(true);
    expect(hasStateSelector("state:modified,tag:mart")).toBe(true);
  });
  it("detects the dotted state sub-methods", () => {
    expect(hasStateSelector("state:modified.body")).toBe(true);
  });
  it("is false when no state term is present", () => {
    expect(hasStateSelector("tag:mart+")).toBe(false);
    expect(hasStateSelector("my_model")).toBe(false);
    expect(hasStateSelector("")).toBe(false);
  });
  it("does not match a model literally named to contain state", () => {
    expect(hasStateSelector("stg_state_registry")).toBe(false);
    expect(hasStateSelector("upstream:foo")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w @dbt-open-lineage/core -- selector.test.ts`
Expected: FAIL — `hasStateSelector is not a function` / not exported.

- [ ] **Step 3: Implement**

Add to `packages/core/src/selector.ts` (near `focalName`, both are exported term-shape helpers):

```ts
/** True if any term of `expr` selects by dbt's `state:` method (which needs a
 * `--state` manifest to diff against, hence async host resolution). Splits on
 * whitespace (union) and commas (intersection) exactly like resolveTerms, then
 * strips the up/down hop operators the same way parseTerm does before checking
 * the method. A model literally named "state" is unaffected — a bare name has
 * no ":" so its method is empty. */
export function hasStateSelector(expr: string): boolean {
  for (const tok of expr.trim().split(/\s+/)) {
    for (const part of tok.split(",")) {
      const { name } = parseTerm(part);
      if (name.startsWith("state:")) return true;
    }
  }
  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -w @dbt-open-lineage/core -- selector.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/selector.ts packages/core/src/selector.test.ts
git commit -m "feat(core): hasStateSelector detector for state: method"
```

---

### Task 2: `dbt.ls` host runner (vscode)

**Files:**
- Create: `packages/vscode/src/host/ls.ts`
- Modify: `packages/vscode/src/host/run.ts` (export `defaultDeps` so `ls.ts` can reuse the spawn machinery)
- Test: `packages/vscode/src/host/ls.test.ts`

**Interfaces:**
- Consumes: `LineBuffer`, `RunDeps`, `defaultDeps` from `./run`.
- Produces:
  - `export function buildLsArgs(select: string, state: string): string[]`
  - `export function parseLsUniqueIds(lines: string[]): string[]`
  - `export function runDbtLs(projectRoot: string, select: string, state: string, deps?: RunDeps): Promise<string[]>`

- [ ] **Step 1: Export `defaultDeps` from run.ts**

In `packages/vscode/src/host/run.ts`, change the declaration at line ~129 from `const defaultDeps: RunDeps = {` to:

```ts
export const defaultDeps: RunDeps = {
```

(No behavior change — only visibility. `startDbtRun`/`spawnDbtToCompletion` already default to it.)

- [ ] **Step 2: Write the failing tests**

Create `packages/vscode/src/host/ls.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import { buildLsArgs, parseLsUniqueIds, runDbtLs } from "./ls";
import type { RunDeps } from "./run";

describe("buildLsArgs", () => {
  it("selects with --state and requests unique_id json output", () => {
    expect(buildLsArgs("state:modified+", "target/prod/")).toEqual([
      "ls", "--select", "state:modified+", "--state", "target/prod/",
      "--resource-type", "model", "snapshot", "seed", "source",
      "--output", "json", "--output-keys", "unique_id",
    ]);
  });
});

describe("parseLsUniqueIds", () => {
  it("pulls unique_id from each json line", () => {
    expect(parseLsUniqueIds([
      '{"unique_id": "model.proj.a"}',
      '{"unique_id": "model.proj.b"}',
    ])).toEqual(["model.proj.a", "model.proj.b"]);
  });
  it("ignores blank and malformed lines without throwing", () => {
    expect(parseLsUniqueIds([
      "", "not json", '{"no_id": 1}', '{"unique_id": "model.proj.a"}',
    ])).toEqual(["model.proj.a"]);
  });
});

describe("runDbtLs", () => {
  it("spawns dbt ls and resolves the parsed unique_ids", async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const spawn = vi.fn(() => child as never);
    const deps: RunDeps = { spawn };

    const p = runDbtLs("/proj", "state:modified+", "target/prod/", deps);
    child.stdout.emit("data", Buffer.from('{"unique_id": "model.proj.a"}\n{"unique_id":'));
    child.stdout.emit("data", Buffer.from(' "model.proj.b"}\n'));
    child.emit("close", 0);

    expect(await p).toEqual(["model.proj.a", "model.proj.b"]);
    expect(spawn).toHaveBeenCalledWith("/proj", buildLsArgs("state:modified+", "target/prod/"));
  });

  it("rejects with the stderr tail on a non-zero exit", async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const deps: RunDeps = { spawn: vi.fn(() => child as never) };

    const p = runDbtLs("/proj", "state:modified+", "missing/", deps);
    child.stderr.emit("data", Buffer.from("Error: no manifest found in missing/\n"));
    child.emit("close", 2);

    await expect(p).rejects.toThrow(/no manifest found in missing\//);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test -w vscode -- ls.test.ts`
Expected: FAIL — cannot find module `./ls`.

- [ ] **Step 4: Implement `ls.ts`**

Create `packages/vscode/src/host/ls.ts`:

```ts
import { LineBuffer, defaultDeps, type RunDeps } from "./run";

/** `dbt ls --select <expr> --state <dir>` restricted to the four resource
 * types the DAG shows, emitting one JSON object per matched node with just its
 * unique_id (which maps directly onto graph node ids). */
export function buildLsArgs(select: string, state: string): string[] {
  return [
    "ls", "--select", select, "--state", state,
    "--resource-type", "model", "snapshot", "seed", "source",
    "--output", "json", "--output-keys", "unique_id",
  ];
}

/** Parse `dbt ls --output json --output-keys unique_id` stdout lines into node
 * ids. Each line is its own JSON object; a blank or malformed line (partial
 * write, non-JSON noise) is skipped rather than thrown on. */
export function parseLsUniqueIds(lines: string[]): string[] {
  const ids: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { unique_id?: unknown };
      if (typeof obj.unique_id === "string") ids.push(obj.unique_id);
    } catch { /* non-JSON line — ignore */ }
  }
  return ids;
}

/** Run `dbt ls` to completion in `projectRoot`, collecting stdout and
 * resolving the matched node ids. Rejects with the stderr tail (or a generic
 * exit-code message) when dbt exits non-zero — e.g. a missing/invalid --state
 * dir or absent prior manifest. */
export function runDbtLs(
  projectRoot: string, select: string, state: string, deps: RunDeps = defaultDeps,
): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const child = deps.spawn(projectRoot, buildLsArgs(select, state));
    const out = new LineBuffer();
    const err = new LineBuffer();
    const outLines: string[] = [];
    const errLines: string[] = [];
    let done = false;

    child.stdout?.on("data", (c: Buffer) => { for (const l of out.push(c.toString("utf8"))) outLines.push(l); });
    child.stderr?.on("data", (c: Buffer) => { for (const l of err.push(c.toString("utf8"))) errLines.push(l); });
    child.on("close", (code: number | null) => {
      if (done) return; done = true;
      for (const l of out.flush()) outLines.push(l);
      for (const l of err.flush()) errLines.push(l);
      if ((code ?? -1) === 0) { resolve(parseLsUniqueIds(outLines)); return; }
      const tail = errLines.filter((l) => l.trim()).slice(-3).join(" ").trim();
      reject(new Error(tail || `dbt ls failed (exit ${code ?? -1})`));
    });
    child.on("error", (e: Error) => { if (done) return; done = true; reject(e); });
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test -w vscode -- ls.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/vscode/src/host/ls.ts packages/vscode/src/host/ls.test.ts packages/vscode/src/host/run.ts
git commit -m "feat(vscode): dbt ls host runner (buildLsArgs/parseLsUniqueIds/runDbtLs)"
```

---

### Task 3: Wire `dbt.ls` into the extension invoke handler (vscode)

**Files:**
- Modify: `packages/vscode/src/extension.ts` (add a `case "dbt.ls"` to the `switch (msg.cmd)` at ~line 204; add the import)

**Interfaces:**
- Consumes: `runDbtLs` from `./host/ls`; the `reply({ ok, result })` contract (bridge resolves `msg.result`).
- Produces: host command `"dbt.ls"` → `Promise<string[]>` of node ids.

- [ ] **Step 1: Add the import**

At the top of `packages/vscode/src/extension.ts`, alongside the existing `./host/run` import, add:

```ts
import { runDbtLs } from "./host/ls";
```

- [ ] **Step 2: Add the case**

Insert immediately before `case "dbt.cancel": {` (i.e. after the `dbt.run` case closes at ~line 283):

```ts
      case "dbt.ls": {
        projectRoot = resolveRoot();
        if (!projectRoot) throw new Error("no dbt project found (dbt_project.yml)");
        const select = String(msg.args.select ?? "");
        const state = typeof msg.args.state === "string" ? msg.args.state : "";
        if (!select.trim()) throw new Error("dbt.ls: missing select expression");
        if (!state.trim()) throw new Error("state: selectors need --state <dir>");
        const ids = await runDbtLs(projectRoot, select, state);
        reply({ ok: true, result: ids });
        break;
      }
```

- [ ] **Step 3: Verify it typechecks and the suite is green**

Run: `npm run test -w vscode`
Expected: PASS (existing 107 tests, still green — no test regresses). If the workspace has a typecheck/build script, also run `npm run build -w vscode` and expect no TS errors.

(The `extension.ts` switch is not unit-tested — it needs the live `vscode` API — so the runner's own coverage in Task 2 plus a clean typecheck is the gate here.)

- [ ] **Step 4: Commit**

```bash
git add packages/vscode/src/extension.ts
git commit -m "feat(vscode): wire dbt.ls invoke handler"
```

---

### Task 4: Async `state:` resolution in the webview (core)

**Files:**
- Modify: `packages/core/src/App.tsx`
- Test: `packages/core/src/App.test.tsx`

**Interfaces:**
- Consumes: `hasStateSelector` (Task 1) from `./selector`; `invoke("dbt.ls", { select, state })` → `string[]` (Task 3); `runFlags.state` (existing).
- Produces: the final `matched: Set<string>` now reflects a `state:` resolve; new derived `stateMode: boolean`; App state `asyncMatched`, `matchBusy`, `matchError`.

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/App.test.tsx`, extend the mock so `dbt.ls` returns ids. The harness's `invokeMock` (line ~52) is a `vi.fn`; in the new tests configure it per-cmd. Add a new describe block:

```ts
describe("state: selector resolution", () => {
  it("delegates a state: selector to dbt.ls with the --state dir", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "dbt.manifest") return SAMPLE_GRAPH;      // reuse the suite's sample graph
      if (cmd === "dbt.ls") return ["model.proj.a"];
      return null;
    });
    render(<App />);
    await screen.findByText("a");                            // graph mounted

    const box = screen.getByPlaceholderText(/selector/i);    // the selector input
    fireEvent.change(box, { target: { value: "state:modified+ --state target/prod/" } });
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("dbt.ls", {
        select: "state:modified+", state: "target/prod/",
      }));
  });

  it("shows an error and does not call dbt.ls when --state is missing", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "dbt.manifest") return SAMPLE_GRAPH;
      return null;
    });
    render(<App />);
    await screen.findByText("a");

    const box = screen.getByPlaceholderText(/selector/i);
    fireEvent.change(box, { target: { value: "state:modified+" } });
    fireEvent.keyDown(box, { key: "Enter" });

    await screen.findByText(/state: selectors need --state/i);
    expect(invokeMock).not.toHaveBeenCalledWith("dbt.ls", expect.anything());
  });
});
```

> If the existing suite names the sample graph or the selector input differently, match those exact identifiers — grep the top of `App.test.tsx` for the shared graph fixture and the box query already used by other tests, and reuse them rather than introducing new ones.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w @dbt-open-lineage/core -- App.test.tsx`
Expected: FAIL — no `dbt.ls` call is made / no error text rendered (feature absent).

- [ ] **Step 3: Add the import**

In `packages/core/src/App.tsx` line 11, extend the selector import:

```ts
import { resolveSelector, focalName, buildSelector, hasStateSelector } from "./selector";
```

- [ ] **Step 4: Add state + the single-flight resolve effect**

Near the other selector-derived state (after `cleanedSelector` at ~line 512), add:

```ts
  // state: selectors can't resolve in-node — they need dbt to diff the current
  // manifest against the one in --state <dir>. When the committed selector has
  // a state: term (and we're not in regex mode, where selector syntax doesn't
  // apply), resolve the WHOLE expression via the dbt.ls host command instead of
  // the synchronous engine. Single-flight (mirrors columnLineageReq): a resolve
  // only commits if it's still the newest when it settles.
  const stateMode = !regexMode && !!cleanedSelector.trim() && hasStateSelector(cleanedSelector);
  const [asyncMatched, setAsyncMatched] = useState<Set<string> | null>(null);
  const [matchBusy, setMatchBusy] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);
  const matchReq = useRef(0);
  useEffect(() => {
    if (!graph) return;
    if (!stateMode) { setAsyncMatched(null); setMatchError(null); setMatchBusy(false); return; }
    if (!runFlags.state) { setAsyncMatched(null); setMatchError("state: selectors need --state <dir>"); return; }
    const myReq = ++matchReq.current;
    setMatchBusy(true); setMatchError(null);
    const known = new Set(graph.nodes.map((n) => n.id));
    void invoke<string[]>("dbt.ls", { select: cleanedSelector, state: runFlags.state })
      .then((ids) => {
        if (myReq !== matchReq.current) return;               // superseded — drop
        setAsyncMatched(new Set(ids.filter((id) => known.has(id))));
      })
      .catch((e) => {
        if (myReq !== matchReq.current) return;               // superseded — drop
        setAsyncMatched(new Set());
        setMatchError(String((e as Error).message ?? e));
      })
      .finally(() => { if (myReq === matchReq.current) setMatchBusy(false); });
    // cleanedSelector/runFlags.state/stateMode capture everything the resolve depends on
  }, [graph, stateMode, cleanedSelector, runFlags.state]);
```

- [ ] **Step 5: Route `matched` through the async result in state-mode**

The `useMemo` at ~line 595 stays as the SYNC path but must not run the engine on a `state:` expression (unknown method → empty is fine, but we skip it for clarity). Rename its output and derive the final `matched`:

Change the destructure at line 595 from `const { matched, regexError } = useMemo(...)` to `const { matched: syncMatched, regexError } = useMemo(...)`, then immediately after that memo add:

```ts
  // In state-mode the matched set comes from the async dbt.ls resolve (empty
  // until it lands); otherwise it's the synchronous engine result.
  const matched = stateMode ? (asyncMatched ?? new Set<string>()) : syncMatched;
```

- [ ] **Step 6: Run tests to verify the delegate + error tests pass**

Run: `npm run test -w @dbt-open-lineage/core -- App.test.tsx`
Expected: PASS for the two new tests. Fix any fixture-name mismatches flagged in Step 1's note.

- [ ] **Step 7: Full core suite green**

Run: `npm run test -w @dbt-open-lineage/core`
Expected: PASS — the pre-existing 431 tests still pass (the `matched` rename is internal; all consumers read the final `matched`).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/App.tsx packages/core/src/App.test.tsx
git commit -m "feat(core): async state: selector resolution via dbt.ls"
```

---

### Task 5: Error + busy UI for state-mode (core)

**Files:**
- Modify: `packages/core/src/App.tsx` (the selector toolbar row, near the `regexError` span at ~line 1682)
- Test: `packages/core/src/App.test.tsx` (busy-indicator assertion)

**Interfaces:**
- Consumes: `matchError`, `matchBusy` (Task 4).

- [ ] **Step 1: Write the failing test**

Add to the `state: selector resolution` describe block in `App.test.tsx`:

```ts
  it("shows a busy indicator while a state: resolve is in flight", async () => {
    let release!: (ids: string[]) => void;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "dbt.manifest") return SAMPLE_GRAPH;
      if (cmd === "dbt.ls") return new Promise<string[]>((r) => { release = r; });
      return null;
    });
    render(<App />);
    await screen.findByText("a");

    const box = screen.getByPlaceholderText(/selector/i);
    fireEvent.change(box, { target: { value: "state:modified+ --state target/prod/" } });
    fireEvent.keyDown(box, { key: "Enter" });

    await screen.findByLabelText(/resolving state selector/i);   // spinner present
    release(["model.proj.a"]);
    await waitFor(() => expect(screen.queryByLabelText(/resolving state selector/i)).toBeNull());
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @dbt-open-lineage/core -- App.test.tsx`
Expected: FAIL — no element labelled "resolving state selector".

- [ ] **Step 3: Implement the UI**

In `packages/core/src/App.tsx`, replace the `regexError` span block (~lines 1682-1684):

```tsx
            {regexMode && regexError && (
              <span style={{ color: "#fca5a5", fontSize: 12, whiteSpace: "nowrap" }}>{regexError}</span>
            )}
```

with:

```tsx
            {regexMode && regexError && (
              <span style={{ color: "#fca5a5", fontSize: 12, whiteSpace: "nowrap" }}>{regexError}</span>
            )}
            {matchBusy && (
              <span aria-label="resolving state selector" style={{ color: "#93c5fd", fontSize: 12, whiteSpace: "nowrap" }}>resolving…</span>
            )}
            {!matchBusy && matchError && (
              <span style={{ color: "#fca5a5", fontSize: 12, whiteSpace: "nowrap" }}>{matchError}</span>
            )}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -w @dbt-open-lineage/core -- App.test.tsx`
Expected: PASS (busy + the Task 4 error test — the error span now renders `matchError`).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/App.tsx packages/core/src/App.test.tsx
git commit -m "feat(core): busy + error UI for state: selector resolution"
```

---

### Task 6: mext host-perms allowlist for `dbt.ls`

**Files:**
- Modify: `packages/mext/manifest.json` (`host_perms` array)
- Test: `packages/mext/` — add/extend a manifest test asserting the entry.

**Interfaces:**
- Produces: `dbt.ls` present in the mext manifest's `host_perms`.

- [ ] **Step 1: Write the failing test**

Locate the mext test dir (`packages/mext/src` or `packages/mext/test`). Add `packages/mext/src/manifest.test.ts` (adjust path to match the workspace's test glob):

```ts
import { describe, it, expect } from "vitest";
import manifest from "../manifest.json";

describe("mext manifest host_perms", () => {
  it("allowlists dbt.ls (else Mnemo silently blocks the bridge call)", () => {
    expect((manifest as { host_perms: string[] }).host_perms).toContain("dbt.ls");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w mext -- manifest.test.ts`
Expected: FAIL — `dbt.ls` not in `host_perms`. (If importing JSON errors, add `resolveJsonModule`/`assert { type: "json" }` per the workspace's existing convention — check how other mext tests import fixtures first.)

- [ ] **Step 3: Add the entry**

In `packages/mext/manifest.json`, add `"dbt.ls"` to the `host_perms` array (alongside `"dbt.run"`, `"dbt.cancel"`):

```json
      "dbt.run",
      "dbt.cancel",
      "dbt.ls"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w mext -- manifest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mext/manifest.json packages/mext/src/manifest.test.ts
git commit -m "feat(mext): allowlist dbt.ls in manifest host_perms"
```

---

### Task 7: Full-suite green gate

**Files:** none (verification only).

- [ ] **Step 1: Run every workspace's tests**

Run: `npm run test --workspaces --if-present`
Expected: PASS across cli, colibri-runner, core, mext, vscode. Baseline before this plan was 587 (cli 29, colibri-runner 9, core 431, mext 11, vscode 107); the new tests raise core/vscode/mext counts. Zero failures.

- [ ] **Step 2: Commit only if any test file needed a fixture tweak** (otherwise skip — nothing to commit).

---

### Task 8: Mnemo host `dbt.ls` (separate repo, via subagent)

> **Not this repo.** Per the standing rules ("Mnemo changes via subagent", "mext↔vscode parity"), the Mnemo host's `dbt.run`-style bridge must gain a `dbt.ls` command or the mext surface resolves `state:` selectors to nothing. This task is executed by dispatching a subagent into the Mnemo host repo — do NOT edit Mnemo inline from this session.

**Contract the subagent must implement (mirror of Task 2 + Task 3):**
- Command name: `dbt.ls`. Args: `{ select: string, state: string }`.
- Behavior: run `dbt ls --select "<select>" --state "<state>" --resource-type model snapshot seed source --output json --output-keys unique_id` in the bound project root; parse each stdout line's `unique_id`; resolve with `string[]`. On non-zero exit, reject with the stderr tail. On missing `state`, reject with "state: selectors need --state <dir>".
- Same spawn discipline as the host's existing `dbt.run` (no shell; resolve the dbt bin the same way).

- [ ] **Step 1:** Dispatch a subagent into the Mnemo host repo with the contract above; have it implement, test, commit, and (per the release rule) leave release to an explicit "release".
- [ ] **Step 2:** Confirm the subagent reported the command registered and tests green; relay the summary.

---

## Self-Review

**Spec coverage:**
- Resolution flow (webview async path, single-flight, `matched` routing, `runFlags.state` reuse) → Tasks 1, 4.
- Host command `dbt.ls` (buildLsArgs, unique_id output, stdout parse, extension wiring) → Tasks 2, 3.
- mext `host_perms` → Task 6.
- Mnemo host → Task 8.
- Error handling (no `--state`, dbt non-zero, empty result) → Tasks 2 (reject), 3 (guard), 4 (effect), 5 (UI).
- UX busy spinner → Task 5.
- Testing plan → per-task tests + Task 7 gate.
- Out-of-scope (static CLI, caching, release) → honored (no tasks; Global Constraints).

**Placeholder scan:** No TBD/TODO; every code step has concrete code. The two fixture-name caveats (SAMPLE_GRAPH / selector input query in Task 4, JSON-import convention in Task 6) are explicit "match the existing identifier" instructions, not deferred work — the executor greps the current test file for the real names, which cannot be known without reading that specific harness.

**Type consistency:** `hasStateSelector(string): boolean`, `buildLsArgs(select, state): string[]`, `parseLsUniqueIds(string[]): string[]`, `runDbtLs(root, select, state, deps?): Promise<string[]>`, host command `dbt.ls` args `{ select, state }` → `string[]`, App `matched: Set<string>` — consistent across Tasks 1-8.
