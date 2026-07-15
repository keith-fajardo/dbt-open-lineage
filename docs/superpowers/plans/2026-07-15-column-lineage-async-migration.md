# Column-Lineage Async Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `runColibri()` from synchronous (`spawnSync`, blocks the
calling process's entire event loop) to asynchronous (`spawn`, non-blocking),
and propagate `async`/`await` through both consumers. This is a prerequisite
for the interactive extension's toggle UI (a separate, later plan) — wiring
a live button to a blocking host call would freeze the VSCode extension
host on every click.

**Architecture:** `packages/colibri-runner/src/colibri.ts` switches from
`child_process.spawnSync` to `child_process.spawn`, wrapped in a `Promise`
that resolves/rejects on the child's `close`/`error` events. Same three
error messages, same invocation args, same downstream
read-file/parse/trim logic — only the process-spawning mechanism and the
function's sync-vs-async signature change. `packages/cli/src/generate.ts`
and `cli.ts`'s `main()` become `async`. `packages/vscode/src/host/columnLineage.ts`
and its call site in `extension.ts` add `await` (trivial — `handleMessage`
is already `async` and already awaits other cases).

**Tech Stack:** TypeScript, Node's `child_process`/`fs`, Vitest.

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-07-15-column-lineage-interactive-ui-design.md` §1:

- Binary/invocation unchanged: `colibri generate --manifest <path> --catalog
  <path> --output-dir <dir> --light --disable-telemetry`.
- Same three error messages, now as Promise rejections instead of thrown
  exceptions: `"dbt-colibri (colibri) not found. Install with: pip install
  dbt-colibri"` (spawn `error` event), `"colibri generate failed: <stderr>"`
  (non-zero exit via `close` event), `"colibri did not produce <path>"`
  (exits 0 without writing `colibri-manifest.json`).
- No behavior change other than non-blocking-ness — same output, same
  errors, same call sites' external contract (just `Promise`-wrapped now).

---

### Task 1: `runColibri` becomes async (spawn-based)

**Files:**
- Modify: `packages/colibri-runner/src/colibri.ts`
- Modify: `packages/colibri-runner/src/colibri.test.ts`

**Interfaces:**
- Produces: `async function runColibri(opts: RunColibriOptions):
  Promise<ColumnLineagePayload>` — same `RunColibriOptions` shape as
  before (`manifestPath: string; catalogPath: string; workDir?: string`).
  Task 2 (`cli`) and Task 3 (`vscode` host) both `await` this.

- [ ] **Step 1: Write the failing tests**

Replace `packages/colibri-runner/src/colibri.test.ts` entirely:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import { runColibri } from "./colibri";

vi.mock("child_process", () => ({ spawn: vi.fn() }));

const mockedSpawn = vi.mocked(spawn);

/** A minimal fake ChildProcess: an EventEmitter with stdout/stderr as their
 * own EventEmitters, matching the shape runColibri() listens on. */
function fakeChild() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "dol-colibri-test-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  vi.resetAllMocks();
});

describe("runColibri", () => {
  it("spawns colibri generate with --light and --disable-telemetry, and resolves the extracted payload", async () => {
    writeFileSync(join(workDir, "colibri-manifest.json"), JSON.stringify({
      nodes: { "model.a": { columns: { id: { columnName: "id", hasLineage: true, lineageType: "unknown" } } } },
      lineage: { edges: [{ id: 1, source: "model.a", target: "model.b", sourceColumn: "id", targetColumn: "id" }] },
    }));
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child);

    const resultPromise = runColibri({ manifestPath: "m.json", catalogPath: "c.json", workDir });
    child.emit("close", 0);
    const result = await resultPromise;

    expect(mockedSpawn).toHaveBeenCalledWith(
      "colibri",
      ["generate", "--manifest", "m.json", "--catalog", "c.json", "--output-dir", workDir, "--light", "--disable-telemetry"],
    );
    expect(result.edges).toEqual([{ source: "model.a", target: "model.b", sourceColumn: "id", targetColumn: "id" }]);
  });

  it("rejects with a clear install-instruction error when colibri is not on PATH", async () => {
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child);

    const resultPromise = runColibri({ manifestPath: "m.json", catalogPath: "c.json", workDir });
    child.emit("error", new Error("spawn colibri ENOENT"));

    await expect(resultPromise).rejects.toThrow(/pip install dbt-colibri/);
  });

  it("rejects wrapping stderr when colibri exits non-zero", async () => {
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child);

    const resultPromise = runColibri({ manifestPath: "m.json", catalogPath: "c.json", workDir });
    child.stderr.emit("data", "manifest not found at target/manifest.json");
    child.emit("close", 1);

    await expect(resultPromise).rejects.toThrow(/manifest not found at target\/manifest\.json/);
  });

  it("rejects if colibri exits 0 but never wrote colibri-manifest.json", async () => {
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child);

    const resultPromise = runColibri({ manifestPath: "m.json", catalogPath: "c.json", workDir });
    child.emit("close", 0);

    await expect(resultPromise).rejects.toThrow(/did not produce/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `packages/colibri-runner/`): `npx vitest run src/colibri.test.ts`
Expected: FAIL — `mockedSpawn` assertion mismatches (current implementation
calls `spawnSync`, not `spawn`), and the async/reject-based assertions
don't match the current throw-based implementation.

- [ ] **Step 3: Write minimal implementation**

Replace `packages/colibri-runner/src/colibri.ts` entirely:

```ts
import { spawn } from "child_process";
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
 * call during a CI build. Uses async `spawn` (not `spawnSync`) — this
 * function is called from a live VSCode extension host, where a
 * synchronous child-process call would block the whole event loop for the
 * duration of the colibri run. */
export async function runColibri(opts: RunColibriOptions): Promise<ColumnLineagePayload> {
  const ownWorkDir = !opts.workDir;
  const workDir = opts.workDir ?? mkdtempSync(join(tmpdir(), "dol-colibri-"));
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(
        "colibri",
        [
          "generate",
          "--manifest", opts.manifestPath,
          "--catalog", opts.catalogPath,
          "--output-dir", workDir,
          "--light",
          "--disable-telemetry",
        ],
      );
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8").on("data", (d) => { stdout += d; });
      child.stderr?.setEncoding("utf8").on("data", (d) => { stderr += d; });
      child.on("error", () => {
        rejectPromise(new Error("dbt-colibri (colibri) not found. Install with: pip install dbt-colibri"));
      });
      child.on("close", (code) => {
        if (code !== 0) {
          rejectPromise(new Error(`colibri generate failed: ${stderr || stdout || "unknown error"}`));
          return;
        }
        resolvePromise();
      });
    });

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

- [ ] **Step 4: Run tests to verify they pass**

Run (from `packages/colibri-runner/`): `npx vitest run src/colibri.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run (from `packages/colibri-runner/`): `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/colibri-runner/src/colibri.ts packages/colibri-runner/src/colibri.test.ts
git commit -m "refactor(colibri-runner): switch runColibri to async spawn

spawnSync blocks the calling process's entire event loop for the
duration of the colibri run — harmless in the one-shot CLI, but a real
problem once the VSCode extension host calls this live from a toggle.
Same invocation, same three error messages, now Promise-based."
```

---

### Task 2: Propagate async through `cli`

**Files:**
- Modify: `packages/cli/src/generate.ts`
- Modify: `packages/cli/src/generate.test.ts`
- Modify: `packages/cli/src/cli.ts`

**Interfaces:**
- Consumes: `runColibri(opts): Promise<ColumnLineagePayload>` (Task 1).
- Produces: `async function generate(opts: GenerateOptions): Promise<void>`
  — same `GenerateOptions` shape as before. `cli.ts`'s `main()` becomes
  `async function main(argv: string[]): Promise<void>`, `await`s
  `generate(...)`.

- [ ] **Step 1: Write the failing tests**

Replace `packages/cli/src/generate.test.ts` entirely:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { generate } from "./generate";
import { runColibri } from "@dbt-open-lineage/colibri-runner";

vi.mock("@dbt-open-lineage/colibri-runner", () => ({ runColibri: vi.fn() }));
const mockedRunColibri = vi.mocked(runColibri);

let workDir: string;
let assetsDir: string;
let manifestPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "dol-cli-test-"));
  assetsDir = join(workDir, "fake-assets");
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, "main.js"), "// fake bundle");
  writeFileSync(join(assetsDir, "main.css"), "/* fake styles */");
  manifestPath = resolve(__dirname, "../test/fixtures/manifest.min.json");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  vi.resetAllMocks();
});

describe("generate", () => {
  it("writes index.html with the parsed graph embedded, plus the copied assets", async () => {
    const outDir = join(workDir, "out");
    await generate({ manifestPath, outDir, assetsDir });

    const html = readFileSync(join(outDir, "index.html"), "utf8");
    expect(html).toContain("window.__DOL_STATIC_DATA__=");
    expect(html).toContain("model.proj.stg_orders");
    expect(existsSync(join(outDir, "assets", "main.js"))).toBe(true);
    expect(existsSync(join(outDir, "assets", "main.css"))).toBe(true);
  });

  it("creates outDir if it doesn't exist", async () => {
    const outDir = join(workDir, "nested", "does", "not", "exist");
    await generate({ manifestPath, outDir, assetsDir });
    expect(existsSync(join(outDir, "index.html"))).toBe(true);
  });

  it("throws a clear error when the manifest doesn't exist", async () => {
    await expect(generate({ manifestPath: join(workDir, "nope.json"), outDir: join(workDir, "out"), assetsDir }))
      .rejects.toThrow(/manifest not found/i);
  });

  it("throws a clear, path-prefixed error on malformed manifest JSON", async () => {
    const badManifest = join(workDir, "bad.json");
    writeFileSync(badManifest, "{not json");
    await expect(generate({ manifestPath: badManifest, outDir: join(workDir, "out"), assetsDir }))
      .rejects.toThrow(new RegExp(badManifest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("embeds sidecar text when --sidecar is given and the file exists", async () => {
    const sidecarPath = join(workDir, "lineage.yml");
    writeFileSync(sidecarPath, "subject_areas:\n  core: {}\n");
    const outDir = join(workDir, "out");
    await generate({ manifestPath, outDir, assetsDir, sidecarPath });
    const html = readFileSync(join(outDir, "index.html"), "utf8");
    expect(html).toContain("subject_areas");
  });

  it("does not error when --sidecar is given but the file is missing (optional)", async () => {
    const outDir = join(workDir, "out");
    await expect(generate({ manifestPath, outDir, assetsDir, sidecarPath: join(workDir, "missing.yml") }))
      .resolves.toBeUndefined();
    const html = readFileSync(join(outDir, "index.html"), "utf8");
    expect(html).toContain('"sidecarText":null');
  });
});

describe("generate with --column-lineage", () => {
  it("calls runColibri and embeds its payload when columnLineage is true", async () => {
    mockedRunColibri.mockResolvedValue({
      nodes: { "model.proj.stg_orders": { columns: { id: { columnName: "id", hasLineage: true } } } },
      edges: [],
    });
    const outDir = join(workDir, "out");
    await generate({ manifestPath, outDir, assetsDir, columnLineage: true, catalogPath: "catalog.json" });

    expect(mockedRunColibri).toHaveBeenCalledWith({ manifestPath, catalogPath: "catalog.json" });
    const html = readFileSync(join(outDir, "index.html"), "utf8");
    expect(html).toContain('"hasLineage":true');
  });

  it("throws when columnLineage is true but catalogPath is missing", async () => {
    const outDir = join(workDir, "out");
    await expect(generate({ manifestPath, outDir, assetsDir, columnLineage: true }))
      .rejects.toThrow(/--catalog is required/);
  });

  it("does not call runColibri when columnLineage is not set (default off)", async () => {
    const outDir = join(workDir, "out");
    await generate({ manifestPath, outDir, assetsDir });
    expect(mockedRunColibri).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `packages/cli/`): `npx vitest run src/generate.test.ts`
Expected: FAIL — `generate()` still returns `void` synchronously, so
`await generate(...)` resolves immediately without doing the async
`runColibri` wait, and `.rejects.toThrow(...)` assertions fail because the
current `generate()` throws synchronously (before any `await` point) rather
than rejecting a returned Promise the test can await.

- [ ] **Step 3: Write minimal implementation**

Replace `packages/cli/src/generate.ts` entirely:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from "fs";
import { resolve } from "path";
import { parseManifest } from "@dbt-open-lineage/core/src/manifest";
import type { Graph } from "@dbt-open-lineage/core";
import { runColibri } from "@dbt-open-lineage/colibri-runner";
import { buildHtml } from "./template";

export interface GenerateOptions {
  manifestPath: string;
  outDir: string;
  assetsDir: string;
  sidecarPath?: string;
  title?: string;
  catalogPath?: string;
  columnLineage?: boolean;
}

export async function generate(opts: GenerateOptions): Promise<void> {
  if (!existsSync(opts.manifestPath)) {
    throw new Error(`manifest not found: ${opts.manifestPath}`);
  }
  const manifestJson = readFileSync(opts.manifestPath, "utf8");
  let graph: Graph;
  try {
    graph = parseManifest(manifestJson);
  } catch (e) {
    throw new Error(`failed to parse ${opts.manifestPath}: ${(e as Error).message}`);
  }

  const sidecarText = opts.sidecarPath && existsSync(opts.sidecarPath)
    ? readFileSync(opts.sidecarPath, "utf8")
    : null;

  let columnLineage;
  if (opts.columnLineage) {
    if (!opts.catalogPath) {
      throw new Error("--catalog is required when --column-lineage is set");
    }
    columnLineage = await runColibri({ manifestPath: opts.manifestPath, catalogPath: opts.catalogPath });
  }

  mkdirSync(opts.outDir, { recursive: true });
  const html = buildHtml({ graph, sidecarText, title: opts.title, columnLineage });
  writeFileSync(resolve(opts.outDir, "index.html"), html, "utf8");
  cpSync(opts.assetsDir, resolve(opts.outDir, "assets"), { recursive: true });
}
```

(The `columnLineage` branch changed from an IIFE-in-ternary to a plain
`if`/`let` — the IIFE was only needed to embed a throw inside an
expression; now that `generate()` is `async`, a plain statement with
`await` reads more clearly and this function is already being rewritten in
this task, so this isn't separate scope creep.)

- [ ] **Step 4: Run tests to verify they pass**

Run (from `packages/cli/`): `npx vitest run src/generate.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Propagate async into `cli.ts`'s `main()`**

In `packages/cli/src/cli.ts`, change `export function main(argv: string[]): void {`
to `export async function main(argv: string[]): Promise<void> {`, and
change the `generate({...})` call to `await generate({...})`:

```ts
export async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (cmd !== "generate") {
    console.error(usage());
    process.exit(1);
  }
  const args = parseArgs(rest);
  if (!args.manifest || !args.out) {
    console.error("Error: --manifest and --out are required\n" + usage());
    process.exit(1);
  }
  try {
    await generate({
      manifestPath: args.manifest,
      outDir: args.out,
      sidecarPath: args.sidecar,
      title: args.title,
      catalogPath: args.catalog,
      columnLineage: args["column-lineage"] === "true",
      // This is the one place the real build output is referenced by
      // build-relative path — see generate()'s GenerateOptions comment
      // in Task 5 for why generate() itself takes assetsDir as an input
      // instead of resolving it internally.
      assetsDir: resolve(__dirname, "../dist/webview/assets"),
    });
    console.log(`Generated static DAG viewer at ${resolve(args.out)}/index.html`);
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
```

At the bottom of the same file, change the module-execution guard from
`main(process.argv.slice(2));` to `void main(process.argv.slice(2));` —
`main` now returns a Promise, and `void` makes the intentional
fire-and-forget explicit (every error path inside `main` is already
handled by its own `try`/`catch` + `process.exit`, so there is no
unhandled-rejection risk):

```ts
if (isMainModule(process.argv[1], import.meta.url)) {
  void main(process.argv.slice(2));
}
```

(`parseArgs` and `isMainModule` are unchanged — not part of this task.)

- [ ] **Step 6: Run the full package suite and typecheck**

Run (from `packages/cli/`): `npx vitest run`
Expected: all tests pass (no regressions in `cli.test.ts`'s `parseArgs`/
`isMainModule` tests, which don't touch `main()`'s async-ness).

Run (from `packages/cli/`): `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/generate.ts packages/cli/src/generate.test.ts packages/cli/src/cli.ts
git commit -m "refactor(cli): propagate async through generate() and main()

generate() now awaits the async runColibri() from Task 1. Existing
throw-based test assertions became reject-based; every other test gained
an await since generate() is no longer synchronous."
```

---

### Task 3: Propagate async through the VSCode host

**Files:**
- Modify: `packages/vscode/src/host/columnLineage.ts`
- Modify: `packages/vscode/src/host/columnLineage.test.ts`
- Modify: `packages/vscode/src/extension.ts:220`

**Interfaces:**
- Consumes: `runColibri(opts): Promise<ColumnLineagePayload>` (Task 1).
- Produces: `async function runColumnLineageForProject(root: string):
  Promise<ColumnLineagePayload>`. The `dbt.columnLineage` case in
  `extension.ts` awaits it — no change to the reply shape or the webview
  contract (`invoke("dbt.columnLineage", {})` already returns a Promise
  regardless of whether the host resolves it sync or async, since it's
  message-passing).

- [ ] **Step 1: Write the failing tests**

Replace `packages/vscode/src/host/columnLineage.test.ts` entirely:

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
  it("throws a clear error when manifest.json is missing", async () => {
    await expect(runColumnLineageForProject(dir)).rejects.toThrow(/no manifest at .*run `dbt compile`/);
    expect(mockedRunColibri).not.toHaveBeenCalled();
  });

  it("throws a clear error when catalog.json is missing (manifest present)", async () => {
    fs.mkdirSync(path.join(dir, "target"), { recursive: true });
    fs.writeFileSync(path.join(dir, "target", "manifest.json"), "{}");
    await expect(runColumnLineageForProject(dir)).rejects.toThrow(/no catalog at .*run `dbt docs generate`/);
    expect(mockedRunColibri).not.toHaveBeenCalled();
  });

  it("calls runColibri with the resolved manifest/catalog paths when both exist", async () => {
    fs.mkdirSync(path.join(dir, "target"), { recursive: true });
    fs.writeFileSync(path.join(dir, "target", "manifest.json"), "{}");
    fs.writeFileSync(path.join(dir, "target", "catalog.json"), "{}");
    mockedRunColibri.mockResolvedValue({ nodes: {}, edges: [] });

    const result = await runColumnLineageForProject(dir);

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
Expected: FAIL — `runColumnLineageForProject` is still synchronous, so
awaiting its (non-Promise) return value and using `.rejects` on a
non-rejecting call doesn't match the current implementation.

- [ ] **Step 3: Write minimal implementation**

Replace `packages/vscode/src/host/columnLineage.ts` entirely:

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
 * error message tells the user the exact command to run manually). Async
 * because runColibri() spawns a real subprocess non-blockingly — see
 * packages/colibri-runner's async migration. */
export async function runColumnLineageForProject(root: string): Promise<ColumnLineagePayload> {
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

- [ ] **Step 5: Await the call site in `extension.ts`**

In `packages/vscode/src/extension.ts`, the existing `case
"dbt.columnLineage":` block (currently at line 217) changes its
`runColumnLineageForProject` call to be awaited:

```ts
      case "dbt.columnLineage": {
        projectRoot = resolveRoot();
        if (!projectRoot) throw new Error("no dbt project found (dbt_project.yml)");
        const payload = await runColumnLineageForProject(projectRoot);
        reply({ ok: true, result: payload });
        break;
      }
```

(Only the one line changes — `const payload = runColumnLineageForProject(projectRoot);`
becomes `const payload = await runColumnLineageForProject(projectRoot);`.
The surrounding `handleMessage` function is already `async` and this
`case` block was already inside its `try`/`catch`, matching every other
awaited case like `dbt.compile`/`dbt.gist`.)

- [ ] **Step 6: Run the full package suite and typecheck**

Run (from `packages/vscode/`): `npx vitest run`
Expected: all tests pass, same count as before this task (no new test
files — `extension.ts`'s switch case has no dedicated test, matching the
established convention for every other case).

Run (from `packages/vscode/`): `npx tsc --noEmit`
Expected: same pre-existing typecheck gap as before this task (8 errors,
5 files, missing `--jsx` in host tsconfig) — confirm the count/files
haven't changed, since this task must not fix or worsen that unrelated,
already-documented issue.

- [ ] **Step 7: Commit**

```bash
git add packages/vscode/src/host/columnLineage.ts packages/vscode/src/host/columnLineage.test.ts packages/vscode/src/extension.ts
git commit -m "refactor(vscode): await the now-async runColumnLineageForProject

Trivial propagation — handleMessage was already async and already
awaits every other case's host call. No behavior change other than the
extension host no longer blocking during a colibri run."
```

---

## Self-Review Notes

- **Spec coverage:** UI-design spec §1 (async migration, all three
  bullets: colibri-runner, cli, vscode host) → Tasks 1-3 respectively.
  Same error messages/invocation preserved (Global Constraints block) and
  verified in every task's tests.
- **Type consistency:** `RunColibriOptions` and `ColumnLineagePayload` are
  unchanged from Plan 1 (still defined in Task-1-of-the-backend-plan's
  `colibri-runner`/`columnLineage.ts`); `runColibri`'s new return type
  (`Promise<ColumnLineagePayload>`) is referenced identically by name in
  Tasks 2 and 3 — no renaming across tasks.
- **No placeholders:** every step has complete, runnable code; every
  rewritten test file is shown in full, not diffed against an assumed
  prior state the implementer would have to reconstruct.
