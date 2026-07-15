# Column-Lineage Interactive Extension Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire a `dbt.columnLineage` host command into the VSCode extension
(and declare the matching permission for the Mnemo `.mext`), backed by a new
shared Node-only package so `packages/cli` and `packages/vscode` both use one
`runColibri()` implementation instead of two. No UI changes — this plan
produces a working, testable backend command with zero visible change to the
DAG (that's Plan 2, built after this one).

**Architecture:** Extract `packages/cli/src/colibri.ts`'s exact logic into a
new workspace package, `packages/colibri-runner`, consumed as source (no
build step, same pattern `@dbt-open-lineage/core` already uses). `cli`
becomes a consumer instead of the owner. `packages/vscode`'s extension host
(a real Node process) gets a new small testable wrapper —
`host/columnLineage.ts`, matching the existing `host/compiledSql.ts`
pattern — that resolves `manifest.json`/`catalog.json` paths, throws clear
errors if either is missing, and delegates to the shared package. A new
`case "dbt.columnLineage"` in `extension.ts`'s `handleMessage` switch wires
it to the webview's `invoke()` channel, matching the existing `dbt.gist`
case's shape exactly. `packages/mext/manifest.json` gets the permission
name added to `host_perms` — the actual Mnemo-side command handler is a
separate, out-of-repo follow-up (see the design spec's "Repo-boundary
note").

**Tech Stack:** TypeScript, Node's `child_process`/`fs`, Vitest.

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-07-15-column-lineage-interactive-design.md`
and the already-shipped `docs/superpowers/specs/2026-07-15-column-lineage-design.md`
(same dbt-colibri contract, already verified against installed
`dbt-colibri==0.3.0`):

- Binary name is **`colibri`**, invoked as `colibri generate --manifest
  <path> --catalog <path> --output-dir <dir> --light --disable-telemetry`.
- `runColibri(opts: { manifestPath: string; catalogPath: string; workDir?:
  string }): ColumnLineagePayload` — throws `"dbt-colibri (colibri) not
  found. Install with: pip install dbt-colibri"` when not on PATH, wraps
  stderr on non-zero exit, throws `"colibri did not produce <path>"` if it
  exits 0 without writing `colibri-manifest.json`.
- The VSCode host's pre-flight check (this plan's new responsibility, not
  `runColibri`'s) throws `"no manifest at <path> — run \`dbt compile\`"`
  and `"no catalog at <path> — run \`dbt docs generate\`"` for its own two
  missing-file cases, per the interactive-design spec §4.
- `packages/mext` in this repo is only the sandboxed iframe's JS bundle +
  `manifest.json`'s `host_perms` declaration — the real Mnemo-side command
  handler is out of scope for this plan (separate repo, separate dispatch).

---

### Task 1: Extract `packages/colibri-runner`, cli becomes a consumer

**Files:**
- Create: `packages/colibri-runner/package.json`
- Create: `packages/colibri-runner/tsconfig.json`
- Create: `packages/colibri-runner/vitest.config.ts`
- Create: `packages/colibri-runner/src/index.ts`
- Create: `packages/colibri-runner/src/colibri.ts`
- Create: `packages/colibri-runner/src/colibri.test.ts`
- Delete: `packages/cli/src/colibri.ts`
- Delete: `packages/cli/src/colibri.test.ts`
- Modify: `packages/cli/src/generate.ts:5`
- Modify: `packages/cli/src/generate.test.ts:6,8`
- Modify: `packages/cli/package.json`

**Interfaces:**
- Produces: `runColibri(opts: RunColibriOptions): ColumnLineagePayload` and
  `RunColibriOptions` exported from `@dbt-open-lineage/colibri-runner`
  (package root — `main: "src/index.ts"`, no deep-import path needed,
  unlike core). Task 2 imports from this exact package name.

This task is a refactor-safe **move**, not new behavior — the code and its
5 existing tests are already correct and passing on `master`. TDD's
red→green cycle doesn't apply to moving already-tested code; instead, each
step verifies the move didn't change behavior.

- [ ] **Step 1: Scaffold the new package**

Create `packages/colibri-runner/package.json`:

```json
{
  "name": "@dbt-open-lineage/colibri-runner",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@dbt-open-lineage/core": "*",
    "@types/node": "^20.0.0",
    "typescript": "^5.6.0",
    "vite": "^8.0.16",
    "vitest": "^4.1.10"
  }
}
```

Create `packages/colibri-runner/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

Create `packages/colibri-runner/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

// Plain Node (spawns child_process, reads fs) — no jsdom needed. Defaulting
// the whole package to Node means colibri.test.ts's child_process mock
// doesn't need the "// @vitest-environment node" per-file override that
// was required in packages/cli (whose vitest.config.ts defaults to jsdom
// for its webview tests) — see that package's colibri.test.ts history for
// why the override existed there.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
```

- [ ] **Step 2: Move the source and test files, dropping the now-unneeded environment override**

Create `packages/colibri-runner/src/colibri.ts` (identical to
`packages/cli/src/colibri.ts` — content unchanged):

```ts
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { extractColumnLineage } from "@dbt-open-lineage/core/src/columnLineage";
import type { ColumnLineagePayload } from "@dbt-open-lineage/core/src/columnLineage";

export interface RunColibriOptions {
  manifestPath: string;
  catalogPath: string;
  /** Injectable for tests. Production code omits this — runColibri creates
   * a temp dir and cleans it up itself. */
  workDir?: string;
}

/** Spawns dbt-colibri's `colibri generate` (PyPI package `dbt-colibri`,
 * binary name `colibri`), reads its colibri-manifest.json output, and
 * trims it via extractColumnLineage(). --light drops compiledCode (not
 * needed — colibri already resolved lineage, and it would bloat the
 * embedded static-bundle payload); --disable-telemetry avoids a network
 * call during a CI build. */
export function runColibri(opts: RunColibriOptions): ColumnLineagePayload {
  const ownWorkDir = !opts.workDir;
  const workDir = opts.workDir ?? mkdtempSync(join(tmpdir(), "dol-colibri-"));
  try {
    const result = spawnSync(
      "colibri",
      [
        "generate",
        "--manifest", opts.manifestPath,
        "--catalog", opts.catalogPath,
        "--output-dir", workDir,
        "--light",
        "--disable-telemetry",
      ],
      { encoding: "utf8" },
    );

    if (result.error) {
      throw new Error("dbt-colibri (colibri) not found. Install with: pip install dbt-colibri");
    }
    if (result.status !== 0) {
      throw new Error(`colibri generate failed: ${result.stderr || result.stdout || "unknown error"}`);
    }

    const outputPath = join(workDir, "colibri-manifest.json");
    if (!existsSync(outputPath)) {
      throw new Error(`colibri did not produce ${outputPath}`);
    }
    const raw = JSON.parse(readFileSync(outputPath, "utf8"));
    return extractColumnLineage(raw);
  } finally {
    if (ownWorkDir) rmSync(workDir, { recursive: true, force: true });
  }
}
```

Create `packages/colibri-runner/src/colibri.test.ts` (same 4 tests, minus
the now-unnecessary `// @vitest-environment node` line since this package's
`vitest.config.ts` already defaults to Node):

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { runColibri } from "./colibri";

vi.mock("child_process", () => ({ spawnSync: vi.fn() }));

const mockedSpawnSync = vi.mocked(spawnSync);

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "dol-colibri-test-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  vi.resetAllMocks();
});

describe("runColibri", () => {
  it("spawns colibri generate with --light and --disable-telemetry, and returns the extracted payload", () => {
    writeFileSync(join(workDir, "colibri-manifest.json"), JSON.stringify({
      nodes: { "model.a": { columns: { id: { columnName: "id", hasLineage: true, lineageType: "unknown" } } } },
      lineage: { edges: [{ id: 1, source: "model.a", target: "model.b", sourceColumn: "id", targetColumn: "id" }] },
    }));
    mockedSpawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "", error: undefined } as any);

    const result = runColibri({ manifestPath: "m.json", catalogPath: "c.json", workDir });

    expect(mockedSpawnSync).toHaveBeenCalledWith(
      "colibri",
      ["generate", "--manifest", "m.json", "--catalog", "c.json", "--output-dir", workDir, "--light", "--disable-telemetry"],
      { encoding: "utf8" },
    );
    expect(result.edges).toEqual([{ source: "model.a", target: "model.b", sourceColumn: "id", targetColumn: "id" }]);
  });

  it("throws a clear install-instruction error when colibri is not on PATH", () => {
    mockedSpawnSync.mockReturnValue({ error: new Error("spawn colibri ENOENT") } as any);
    expect(() => runColibri({ manifestPath: "m.json", catalogPath: "c.json", workDir }))
      .toThrow(/pip install dbt-colibri/);
  });

  it("throws wrapping stderr when colibri exits non-zero", () => {
    mockedSpawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "manifest not found at target/manifest.json", error: undefined } as any);
    expect(() => runColibri({ manifestPath: "m.json", catalogPath: "c.json", workDir }))
      .toThrow(/manifest not found at target\/manifest\.json/);
  });

  it("throws if colibri exits 0 but never wrote colibri-manifest.json", () => {
    mockedSpawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "", error: undefined } as any);
    expect(() => runColibri({ manifestPath: "m.json", catalogPath: "c.json", workDir }))
      .toThrow(/did not produce/);
  });
});
```

Create `packages/colibri-runner/src/index.ts`:

```ts
export { runColibri } from "./colibri";
export type { RunColibriOptions } from "./colibri";
export type { ColumnLineagePayload, ColumnLineageNode, ColumnLineageEdge, ColumnEntry } from "@dbt-open-lineage/core/src/columnLineage";
```

Run (from `packages/colibri-runner/`, after `npm install` at the repo root
to link the new workspace member): `npx vitest run`
Expected: PASS (4 tests) — same tests, same behavior, new location.

- [ ] **Step 3: Delete the old files and point cli at the new package**

```bash
rm packages/cli/src/colibri.ts packages/cli/src/colibri.test.ts
```

In `packages/cli/src/generate.ts`, change line 5:

```ts
import { runColibri } from "@dbt-open-lineage/colibri-runner";
```

(was `import { runColibri } from "./colibri";`)

In `packages/cli/src/generate.test.ts`, change lines 6 and 8:

```ts
import { runColibri } from "@dbt-open-lineage/colibri-runner";
```

```ts
vi.mock("@dbt-open-lineage/colibri-runner", () => ({ runColibri: vi.fn() }));
```

(both were the `"./colibri"` forms — only the module specifier changes,
`mockedRunColibri` and every test body stay exactly as they are)

In `packages/cli/package.json`, add to `devDependencies` (alongside the
existing `"@dbt-open-lineage/core": "*"` line):

```json
"@dbt-open-lineage/colibri-runner": "*",
```

- [ ] **Step 4: Reinstall workspaces and verify no regression**

Run (from repo root): `npm install`
Run (from `packages/cli/`): `npx vitest run`
Expected: PASS, same test count as before the move (no `colibri.test.ts`
in this package anymore — its 4 tests now live in `colibri-runner` and were
already confirmed passing in Step 2; `generate.test.ts`'s tests that mock
`runColibri` still pass since only the mocked module specifier changed, not
the mock's shape or `generate.ts`'s calling code).

- [ ] **Step 5: Typecheck both packages**

Run (from `packages/colibri-runner/`): `npx tsc --noEmit`
Run (from `packages/cli/`): `npx tsc --noEmit`
Expected: no errors in either.

- [ ] **Step 6: Commit**

```bash
git add packages/colibri-runner packages/cli/src/generate.ts packages/cli/src/generate.test.ts packages/cli/package.json package-lock.json
git rm packages/cli/src/colibri.ts packages/cli/src/colibri.test.ts
git commit -m "refactor: extract colibri-runner into a shared package

cli and the upcoming vscode host command both need runColibri(); moving
it out of packages/cli into a new Node-only workspace package (consumed
as source, same pattern core already uses) avoids duplicating it."
```

---

### Task 2: VSCode host command + mext permission

**Files:**
- Create: `packages/vscode/src/host/columnLineage.ts`
- Create: `packages/vscode/src/host/columnLineage.test.ts`
- Modify: `packages/vscode/src/extension.ts:14` (new import), and its
  `handleMessage` switch (new case, inserted after the existing
  `case "dbt.gist":` block, i.e. after line 159's `break;` and before
  line 160's `default:`)
- Modify: `packages/vscode/package.json` (add `colibri-runner` dependency)
- Modify: `packages/mext/manifest.json` (add `host_perms` entry)

**Interfaces:**
- Consumes: `runColibri(opts: RunColibriOptions): ColumnLineagePayload`
  from `@dbt-open-lineage/colibri-runner` (Task 1).
- Produces: `runColumnLineageForProject(root: string): ColumnLineagePayload`
  from `packages/vscode/src/host/columnLineage.ts`. Plan 2 (the UI plan,
  not part of this one) relies on the webview being able to call
  `invoke<ColumnLineagePayload>("dbt.columnLineage", {})` and get this same
  return shape back, or a rejected promise with one of the three error
  messages below.

- [ ] **Step 1: Write the failing tests**

Create `packages/vscode/src/host/columnLineage.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runColumnLineageForProject } from "./columnLineage";
import { runColibri } from "@dbt-open-lineage/colibri-runner";

vi.mock("@dbt-open-lineage/colibri-runner", () => ({ runColibri: vi.fn() }));
const mockedRunColibri = vi.mocked(runColibri);

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dol-columnlineage-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.resetAllMocks();
});

describe("runColumnLineageForProject", () => {
  it("throws a clear error when manifest.json is missing", () => {
    expect(() => runColumnLineageForProject(dir)).toThrow(/no manifest at .*run `dbt compile`/);
    expect(mockedRunColibri).not.toHaveBeenCalled();
  });

  it("throws a clear error when catalog.json is missing (manifest present)", () => {
    fs.mkdirSync(path.join(dir, "target"), { recursive: true });
    fs.writeFileSync(path.join(dir, "target", "manifest.json"), "{}");
    expect(() => runColumnLineageForProject(dir)).toThrow(/no catalog at .*run `dbt docs generate`/);
    expect(mockedRunColibri).not.toHaveBeenCalled();
  });

  it("calls runColibri with the resolved manifest/catalog paths when both exist", () => {
    fs.mkdirSync(path.join(dir, "target"), { recursive: true });
    fs.writeFileSync(path.join(dir, "target", "manifest.json"), "{}");
    fs.writeFileSync(path.join(dir, "target", "catalog.json"), "{}");
    mockedRunColibri.mockReturnValue({ nodes: {}, edges: [] });

    const result = runColumnLineageForProject(dir);

    expect(mockedRunColibri).toHaveBeenCalledWith({
      manifestPath: path.join(dir, "target", "manifest.json"),
      catalogPath: path.join(dir, "target", "catalog.json"),
    });
    expect(result).toEqual({ nodes: {}, edges: [] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `packages/vscode/`): `npx vitest run src/host/columnLineage.test.ts`
Expected: FAIL — `Cannot find module './columnLineage'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/vscode/src/host/columnLineage.ts`:

```ts
import * as fs from "fs";
import * as path from "path";
import { runColibri } from "@dbt-open-lineage/colibri-runner";
import type { ColumnLineagePayload } from "@dbt-open-lineage/core/src/columnLineage";

/** Resolve <root>/target/manifest.json and <root>/target/catalog.json,
 * throwing a clear, actionable error if either is missing, then delegate
 * to the shared colibri-runner package. Both files are dbt-colibri's own
 * requirement, not just this extension's — manifest comes from `dbt
 * compile` (already a one-click action in this extension), catalog comes
 * from `dbt docs generate` (not currently wired to anything here — the
 * error message tells the user the exact command to run manually). */
export function runColumnLineageForProject(root: string): ColumnLineagePayload {
  const manifestPath = path.join(root, "target", "manifest.json");
  const catalogPath = path.join(root, "target", "catalog.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`no manifest at ${manifestPath} — run \`dbt compile\``);
  if (!fs.existsSync(catalogPath)) throw new Error(`no catalog at ${catalogPath} — run \`dbt docs generate\``);
  return runColibri({ manifestPath, catalogPath });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `packages/vscode/`): `npx vitest run src/host/columnLineage.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the case into extension.ts**

In `packages/vscode/src/extension.ts`, add this import after line 13
(`import { resolveInProject } from "./host/projectFs";`):

```ts
import { runColumnLineageForProject } from "./host/columnLineage";
```

Add this case in `handleMessage`'s switch, immediately after the existing
`case "dbt.gist": { ... break; }` block (i.e. right before the `default:`
case):

```ts
      case "dbt.columnLineage": {
        projectRoot = resolveRoot();
        if (!projectRoot) throw new Error("no dbt project found (dbt_project.yml)");
        const payload = runColumnLineageForProject(projectRoot);
        reply({ ok: true, result: payload });
        break;
      }
```

- [ ] **Step 6: Add the workspace dependency and mext permission**

In `packages/vscode/package.json`, add to `dependencies` (alongside the
existing `"@dbt-open-lineage/core": "*"` line — this package's own
convention keeps workspace-bundled packages under real `dependencies`,
unlike `cli`'s `devDependencies` choice):

```json
"@dbt-open-lineage/colibri-runner": "*",
```

In `packages/mext/manifest.json`, add `"dbt.columnLineage"` to the
`host_perms` array (after the existing `"dbt.gist"` entry):

```json
  "host_perms": [
    "dbt.manifest",
    "dbt.compile",
    "export.save",
    "ide.open",
    "fs.readText",
    "fs.writeText",
    "dbt.gist",
    "dbt.columnLineage"
  ]
```

This declares the permission for when Mnemo's own repo implements the
command handler (out of scope for this plan — see the design spec's
"Repo-boundary note"). No test needed for this JSON-only change; it isn't
executable code in this repo.

- [ ] **Step 7: Reinstall, run the full vscode suite, and typecheck**

Run (from repo root): `npm install`
Run (from `packages/vscode/`): `npx vitest run`
Expected: all tests pass, including the 3 new ones (no regression on
existing host tests — `extension.ts`'s switch case itself has no dedicated
test file, matching the existing convention for `dbt.compile`/`dbt.gist`;
its only new line of untested glue is the `reply({ ok: true, result:
payload })` wrapping, identical in shape to every other case).

Run (from `packages/vscode/`): `npx tsc --noEmit`
Expected: no *new* errors introduced by this task. (Note: this package has
a pre-existing, unrelated typecheck gap — several host files import
`@dbt-open-lineage/core`'s root index without `--jsx` set in
`packages/vscode/tsconfig.json`. This predates this plan; do not fix it
here — confirm the error count/files match what's already present on
`master` before this task's changes, so this task doesn't get blamed for a
pre-existing issue or silently paper over it.)

- [ ] **Step 8: Commit**

```bash
git add packages/vscode/src/host/columnLineage.ts packages/vscode/src/host/columnLineage.test.ts packages/vscode/src/extension.ts packages/vscode/package.json packages/mext/manifest.json package-lock.json
git commit -m "feat(vscode): add dbt.columnLineage host command

Resolves manifest.json/catalog.json, delegates to the shared
colibri-runner package. Also declares the dbt.columnLineage host_perms
entry in mext's manifest — the Mnemo-side handler is a separate,
out-of-repo follow-up."
```

---

## Self-Review Notes

- **Spec coverage:** Interactive-design spec §1 (shared package) → Task 1.
  §2 (VSCode host case) → Task 2 Steps 5-6. §4 (error messages: not-found,
  catalog-missing, manifest-missing) → Task 2's implementation matches all
  three exact strings from the spec/Global Constraints. The mext
  repo-boundary note → Task 2 Step 6 (permission declared, handler
  explicitly out of scope). UI/rendering (spec §3) is Plan 2, not this
  plan.
- **Type consistency:** `RunColibriOptions`/`ColumnLineagePayload` defined
  once (Task 1) and referenced identically in Task 2 — no renaming.
  `runColumnLineageForProject`'s return type matches what Task 2's own
  step 5 wiring expects (`payload` passed straight into `reply()`).
- **No placeholders:** every step has complete, runnable code; error
  message regexes in tests match the exact strings the implementation
  throws.
