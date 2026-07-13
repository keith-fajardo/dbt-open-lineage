# Static DAG CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@dbt-open-lineage/cli`, a new workspace package that generates a static, read-only, React-Flow-rendered `index.html` from a dbt `manifest.json`, for CI-driven static hosting (replacing `dbt docs generate`'s slower D3-based site for this use case).

**Architecture:** Move the manifest parser into `@dbt-open-lineage/core` so it's shared. Add a `readOnly` mode to `core`'s existing `App` component (one boolean gate, since nearly all editing UI already funnels through a single `editable` flag). Build a new `packages/cli` package with a browser-side `StaticBridge` (implements the existing `Bridge` interface from embedded data instead of a live host) and a Node-side `generate()` function that parses a manifest, renders an HTML template, and writes a static site.

**Tech Stack:** TypeScript, React 19, `@xyflow/react` (React Flow), Vite (webview bundle), esbuild (CLI bin bundle), Vitest (all tests). No new runtime dependencies beyond what `core` already uses.

## Global Constraints

- Read-only viewer: no annotation editing, no gist-save, no write-back to `.yml` files. (Spec: Non-goals.)
- Blank-by-default DAG: the generated site starts with an empty selector, same as the extension — never renders the whole project graph eagerly. This is existing `App.tsx` behavior; nothing in this plan changes it.
- Data delivery: the parsed graph + sidecar are inlined into `index.html` as a `<script>` tag. The JS/CSS bundle stays as separate files alongside it (`assets/main.js`, `assets/main.css`) — only the *data* is inlined, not the bundle.
- No live-reload server, no npm-publish work in this pass (spec Non-goals) — this plan produces a locally buildable, locally testable package. Publishing is a follow-up.
- Follow existing repo conventions exactly: workspace package shape (`package.json` + `tsconfig.json` extending `tsconfig.base.json`), a package-local `vitest.config.ts` (vitest does NOT inherit `vite.config.ts` — see `packages/core/vitest.config.ts`'s comment), esbuild for Node-target bundles (`packages/vscode/esbuild.js` is the reference), Vite for browser bundles (`packages/mext/vite.config.ts` is the reference).

---

### Task 1: Move `parseManifest` into `@dbt-open-lineage/core`

**Files:**
- Create: `packages/core/src/manifest.ts` (moved from `packages/vscode/src/host/manifest.ts`, imports updated to relative)
- Create: `packages/core/src/manifest.test.ts` (moved from `packages/vscode/src/host/manifest.test.ts`)
- Create: `packages/core/test/fixtures/manifest.min.json` (copy of `packages/vscode/test/fixtures/manifest.min.json` — that file stays in place, it's still used by `packages/vscode/src/host/compiledSql.test.ts`)
- Modify: `packages/core/src/index.tsx` (add `export { parseManifest } from "./manifest";`)
- Modify: `packages/vscode/src/host/manifest.ts` (replace body with a re-export)
- Delete: `packages/vscode/src/host/manifest.test.ts` (superseded by `packages/core/src/manifest.test.ts`)

**Interfaces:**
- Produces: `parseManifest(json: string): Graph` — importable as `import { parseManifest } from "@dbt-open-lineage/core"` (public barrel, for general consumers) AND as `import { parseManifest } from "@dbt-open-lineage/core/src/manifest"` (direct subpath — used by Node-only consumers below, see note in Task 7).
- `Graph`, `GraphNode`, `GraphEdge` types already exist in `packages/core/src/graphTypes.ts` and are unchanged.

- [ ] **Step 1: Copy the fixture into core's test directory**

```bash
mkdir -p packages/core/test/fixtures
cp packages/vscode/test/fixtures/manifest.min.json packages/core/test/fixtures/manifest.min.json
```

- [ ] **Step 2: Create `packages/core/src/manifest.ts` with the moved parser**

Same logic as `packages/vscode/src/host/manifest.ts`, with the import made relative (it's now inside `core`, so it imports its own sibling types instead of the package barrel):

```typescript
import type { Graph, GraphNode, GraphEdge } from "./graphTypes";

const KEEP = new Set(["model", "seed", "snapshot", "source"]);

function inferLayer(resourceType: string, path: string): string {
  if (resourceType === "source") return "source";
  const p = path.toLowerCase();
  if (p.includes("/staging/") || p.includes("stg_")) return "staging";
  if (p.includes("/intermediate/") || p.includes("int_")) return "intermediate";
  if (p.includes("/marts/") || p.includes("/mart/") || p.includes("mrt_")) return "mart";
  if (p.includes("/report") || p.includes("rpt_")) return "report";
  return resourceType;
}

interface RawNode {
  name?: string; resource_type?: string; original_file_path?: string;
  description?: string; tags?: string[]; attached_node?: string;
  config?: { materialized?: string; meta?: Record<string, unknown> };
  depends_on?: { nodes?: string[] };
  patch_path?: string;
}

export function parseManifest(json: string): Graph {
  let doc: { nodes?: Record<string, RawNode>; sources?: Record<string, RawNode>; child_map?: Record<string, string[]> };
  try { doc = JSON.parse(json); } catch (e) { throw new Error(`bad manifest json: ${e}`); }

  const kept = new Set<string>();
  const nodes: GraphNode[] = [];
  const testsByModel = new Map<string, string[]>();

  for (const [id, n] of Object.entries(doc.nodes ?? {})) {
    if (n.resource_type !== "test") continue;
    const target = n.attached_node ?? (n.depends_on?.nodes ?? []).find((d) => d.startsWith("model.") || d.startsWith("snapshot.") || d.startsWith("seed."));
    if (target && n.name) {
      if (!testsByModel.has(target)) testsByModel.set(target, []);
      testsByModel.get(target)!.push(n.name);
    }
  }

  const collect = (map: Record<string, RawNode>) => {
    for (const [id, n] of Object.entries(map)) {
      const rt = n.resource_type ?? "";
      if (!KEEP.has(rt)) continue;
      const path = n.original_file_path ?? "";
      nodes.push({
        id,
        name: n.name ?? "",
        resource_type: rt,
        layer: inferLayer(rt, path),
        path,
        description: n.description ?? "",
        tags: n.tags ?? [],
        materialized: n.config?.materialized,
        meta: n.config?.meta ?? {},
        tests: testsByModel.get(id) ?? [],
        patch_path: n.patch_path ? n.patch_path.split("://").pop() : undefined,
      });
      kept.add(id);
    }
  };
  collect(doc.nodes ?? {});
  collect(doc.sources ?? {});

  const edges: GraphEdge[] = [];
  const cm = doc.child_map ?? {};
  for (const from of Object.keys(cm).sort()) {
    if (!kept.has(from)) continue;
    for (const to of cm[from] ?? []) {
      if (kept.has(to)) edges.push({ from, to });
    }
  }

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  return { nodes, edges };
}
```

- [ ] **Step 3: Create `packages/core/src/manifest.test.ts` with the moved tests**

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parseManifest } from "./manifest";

const fixture = () => readFileSync(resolve(__dirname, "../test/fixtures/manifest.min.json"), "utf8");

describe("parseManifest", () => {
  it("keeps model/source, drops test nodes from the graph", () => {
    const g = parseManifest(fixture());
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toContain("model.proj.stg_orders");
    expect(ids).toContain("source.proj.raw.orders");
    expect(ids.some((i) => i.startsWith("test."))).toBe(false);
    expect(g.nodes.length).toBe(3); // 2 models + 1 source
  });

  it("infers layer from path", () => {
    const g = parseManifest(fixture());
    const layer = (id: string) => g.nodes.find((n) => n.id === id)!.layer;
    expect(layer("source.proj.raw.orders")).toBe("source");
    expect(layer("model.proj.stg_orders")).toBe("staging");
    expect(layer("model.proj.mrt_orders")).toBe("mart");
  });

  it("populates tags/materialized/meta from config", () => {
    const g = parseManifest(fixture());
    const n = g.nodes.find((x) => x.id === "model.proj.mrt_orders")!;
    expect(n.tags).toEqual(["mart", "daily"]);
    expect(n.materialized).toBe("table");
    expect(n.meta).toEqual({});
    const s = g.nodes.find((x) => x.id === "model.proj.stg_orders")!;
    expect(s.materialized).toBe("view");
    expect(s.meta).toEqual({ owner: "data" });
  });

  it("rolls test names up onto their referenced model, not as nodes", () => {
    const g = parseManifest(fixture());
    const stg = g.nodes.find((x) => x.id === "model.proj.stg_orders")!;
    expect(stg.tests).toEqual(["not_null_stg_orders_id"]);
  });
});
```

- [ ] **Step 4: Run the new test to verify it passes (proves the move preserved behavior)**

Run: `npm run test -w packages/core`
Expected: PASS, including the 4 new `parseManifest` tests.

- [ ] **Step 5: Point core's public barrel at the new module**

Edit `packages/core/src/index.tsx`, add this line alongside the other named exports (after the existing `export { setBridge, type Bridge } from "./bridge";` line):

```typescript
export { parseManifest } from "./manifest";
```

- [ ] **Step 6: Replace the vscode host file with a re-export and delete the superseded test**

Replace the full contents of `packages/vscode/src/host/manifest.ts` with:

```typescript
// Moved to @dbt-open-lineage/core (shared with packages/cli). Subpath import
// (not the package barrel) so esbuild doesn't pull core's React/App tree
// into this Node-only extension-host bundle — see the barrel's comment.
export { parseManifest } from "@dbt-open-lineage/core/src/manifest";
```

Delete `packages/vscode/src/host/manifest.test.ts` (its coverage now lives in `packages/core/src/manifest.test.ts`).

- [ ] **Step 7: Verify vscode still builds and its remaining tests pass**

Run: `npm run test -w packages/vscode`
Expected: PASS (no more `manifest.test.ts` in the run; `compiledSql.test.ts` and others still pass since they don't depend on `manifest.ts`'s internals, only its own fixture file which is untouched).

Run: `npm run build -w packages/vscode`
Expected: succeeds, `out/extension.js` produced (proves the subpath import resolves correctly through esbuild).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/manifest.ts packages/core/src/manifest.test.ts packages/core/test/fixtures/manifest.min.json packages/core/src/index.tsx packages/vscode/src/host/manifest.ts
git rm packages/vscode/src/host/manifest.test.ts
git commit -m "refactor(core): move parseManifest from vscode host into core

Shared by both packages/vscode and the upcoming packages/cli. vscode's
host file becomes a thin re-export; behavior and tests are unchanged."
```

---

### Task 2: Add `readOnly` mode to `core`'s `App` and `mountApp`

**Files:**
- Modify: `packages/core/src/App.tsx:29` (Props interface), `:243` (function signature), `:562` (`editable` flag), `:912-955` (Draw toolbar), `:1063` (`CalloutOverlay`'s `onBeginEdit`)
- Modify: `packages/core/src/index.tsx` (`mountApp` opts)
- Modify: `packages/core/src/App.test.tsx` (new test case)

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces: `App`'s `Props` gains `readOnly?: boolean` (default `false`). `mountApp`'s `opts` gains `readOnly?: boolean` (default `false`), threaded straight to `<App readOnly>`. Both are additive/optional — existing `vscode`/`mext` call sites are unaffected.

This task found that **all of the editing UI in the side panel already funnels through one boolean**, `editable` (`App.tsx:562`: `const editable = !!selectedNode && selectedNode.resource_type !== "source";`) — it gates the description textarea, the gist textarea + sparkle button, the "show as callout" toggle, all three `ChipEditor`s (subject areas/labels/tags), and the Save/Revert buttons. So most of read-only mode is a one-line change. Two more UI pieces sit outside that flag and need their own guard: the Draw toolbar (freehand annotation, not gated by `editable` since it's not tied to a selected node) and `CalloutOverlay`'s inline double-click-to-edit trigger.

- [ ] **Step 1: Write the failing test — readOnly hides editing UI**

Add to `packages/core/src/App.test.tsx`, inside a new `describe` block placed after the existing `describe("editable description + gist panel", ...)` block (around line 454, right before `describe("edgeOnLineage", ...)`):

```typescript
describe("readOnly mode", () => {
  beforeEach(() => { manifestGraph = oneModelGraph; });

  it("hides Save/Revert, gist, chip editors, and the Draw toolbar; description renders as text", async () => {
    render(<App projectPath="/proj" initialSelector="stg_orders" readOnly />);
    fireEvent.click(await screen.findByText("stg_orders"));
    await screen.findByText("description");

    expect(screen.queryByLabelText("description")).not.toBeInTheDocument(); // textarea absent
    expect(screen.queryByLabelText("gist")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revert" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /generate gist/i })).not.toBeInTheDocument();
    expect(screen.queryByText("subject areas")).not.toBeInTheDocument();
    expect(screen.queryByText("Draw")).not.toBeInTheDocument();
  });

  it("still shows read-only info: description text, tests, materialization", async () => {
    manifestGraph = {
      nodes: [{
        id: "model.proj.stg_orders", name: "stg_orders", resource_type: "model",
        layer: "staging", path: "models/staging/stg_orders.sql",
        description: "a staging model", materialized: "view", tests: ["not_null_id"],
      }],
      edges: [],
    };
    render(<App projectPath="/proj" initialSelector="stg_orders" readOnly />);
    fireEvent.click(await screen.findByText("stg_orders"));
    await screen.findByText("a staging model");
    await screen.findByText("not_null_id");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w packages/core -- App.test.tsx`
Expected: FAIL — `readOnly` is not a recognized prop yet, so the editing UI still renders (the first test's `not.toBeInTheDocument()` assertions fail).

- [ ] **Step 3: Add the `readOnly` prop and thread it into `editable`**

Edit `packages/core/src/App.tsx:29`, change:

```typescript
interface Props { projectPath: string; initialSelector?: string; debounceMs?: number }
```

to:

```typescript
interface Props { projectPath: string; initialSelector?: string; debounceMs?: number; readOnly?: boolean }
```

Edit `packages/core/src/App.tsx:243`, change:

```typescript
export default function App({ projectPath, initialSelector = "", debounceMs = 150 }: Props) {
```

to:

```typescript
export default function App({ projectPath, initialSelector = "", debounceMs = 150, readOnly = false }: Props) {
```

Edit `packages/core/src/App.tsx:562`, change:

```typescript
const editable = !!selectedNode && selectedNode.resource_type !== "source";
```

to:

```typescript
const editable = !readOnly && !!selectedNode && selectedNode.resource_type !== "source";
```

- [ ] **Step 4: Hide the Draw toolbar in readOnly mode**

Edit `packages/core/src/App.tsx`, lines 917-954 (the `<span style={SECTION_LABEL}>Draw</span>` block through its closing `</>` / `)}`). Wrap the whole block:

Before (`App.tsx:917`):
```typescript
            <span style={SECTION_LABEL}>Draw</span>
            <div style={{ display: "inline-flex", background: "#0b1220", border: "1px solid #334155", borderRadius: 7, overflow: "hidden" }}>
```

After:
```typescript
            {!readOnly && (
              <>
                <span style={SECTION_LABEL}>Draw</span>
                <div style={{ display: "inline-flex", background: "#0b1220", border: "1px solid #334155", borderRadius: 7, overflow: "hidden" }}>
```

And at the end of that same block (`App.tsx:954`, the line right after the `drawMode !== "off"` color-swatch conditional's closing `)}`):

Before:
```typescript
              </>
            )}
          </div>
```

After:
```typescript
              </>
            )}
              </>
            )}
          </div>
```

(This nests the existing `drawMode !== "off"` fragment inside the new `!readOnly` fragment — both need their own closing `</>` and `)}`.)

- [ ] **Step 5: Make the callout bubble's inline-edit trigger a no-op in readOnly mode**

Edit `packages/core/src/App.tsx:1063`, change:

```typescript
                onBeginEdit={(id) => { setSelected(id); setEditingCallout(true); }}
```

to:

```typescript
                onBeginEdit={readOnly ? () => {} : (id) => { setSelected(id); setEditingCallout(true); }}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test -w packages/core -- App.test.tsx`
Expected: PASS, including both new `readOnly mode` tests. Also re-run the full suite to confirm no regression: `npm run test -w packages/core`.

- [ ] **Step 7: Thread `readOnly` through `mountApp`**

Edit `packages/core/src/index.tsx`, change:

```typescript
export function mountApp(
  el: HTMLElement,
  opts: { bridge: Bridge; projectPath: string; initialSelector?: string },
): void {
  setBridge(opts.bridge);
  createRoot(el).render(
    <StrictMode>
      <Boundary>
        <App projectPath={opts.projectPath} initialSelector={opts.initialSelector ?? ""} />
      </Boundary>
    </StrictMode>,
  );
}
```

to:

```typescript
export function mountApp(
  el: HTMLElement,
  opts: { bridge: Bridge; projectPath: string; initialSelector?: string; readOnly?: boolean },
): void {
  setBridge(opts.bridge);
  createRoot(el).render(
    <StrictMode>
      <Boundary>
        <App projectPath={opts.projectPath} initialSelector={opts.initialSelector ?? ""} readOnly={opts.readOnly ?? false} />
      </Boundary>
    </StrictMode>,
  );
}
```

- [ ] **Step 8: Full core test run + typecheck**

Run: `npm run test -w packages/core && npm run typecheck -w packages/core`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/App.tsx packages/core/src/App.test.tsx packages/core/src/index.tsx
git commit -m "feat(core): add readOnly mode to App and mountApp

Gates all annotation-editing UI (description/gist/chips/Save-Revert via
the existing 'editable' flag, plus Draw toolbar and inline callout
editing which sit outside it) behind a single readOnly prop. Read-only
display (descriptions, tests, subject-area/label/tag filters) is
unaffected. Prepares core for packages/cli's static viewer."
```

---

### Task 3: Scaffold `packages/cli` and build the browser-side `StaticBridge`

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/vite.config.ts`
- Create: `packages/cli/vitest.config.ts`
- Create: `packages/cli/src/webview/staticBridge.ts`
- Create: `packages/cli/src/webview/staticBridge.test.ts`
- Create: `packages/cli/src/webview/main.tsx`

**Interfaces:**
- Consumes: `Bridge` type from `@dbt-open-lineage/core` (Task 2 didn't change this interface). `mountApp` from `@dbt-open-lineage/core` (Task 2's `readOnly` option).
- Produces: `StaticPageData` type — `{ graph: Graph; sidecarText: string | null; title?: string }` — this is the shape embedded into `index.html` and read back by `main.tsx`. Later tasks (5, 6) both depend on this exact shape.
- Produces: `createStaticBridge(data: StaticPageData): Bridge`, exported from `packages/cli/src/webview/staticBridge.ts`.

- [ ] **Step 1: Create `packages/cli/package.json`**

```json
{
  "name": "@dbt-open-lineage/cli",
  "version": "0.1.0",
  "type": "module",
  "bin": { "dbt-open-lineage": "./out/cli.js" },
  "files": ["out", "dist/webview"],
  "engines": { "node": ">=18" },
  "scripts": {
    "build:webview": "vite build",
    "build:cli": "node esbuild.js",
    "build": "npm run build:webview && npm run build:cli",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "@dbt-open-lineage/core": "*" },
  "devDependencies": {
    "@types/node": "^20.0.0", "@types/react": "^19.2.17", "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^6.0.2", "esbuild": "^0.27.0", "jsdom": "^29.1.1",
    "typescript": "^5.6.0", "vite": "^8.0.16", "vitest": "^4.1.10"
  }
}
```

- [ ] **Step 2: Create `packages/cli/tsconfig.json`**

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

- [ ] **Step 3: Create `packages/cli/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

// jsdom (not "node"): staticBridge.test.ts exercises a browser download via
// document.createElement, and jsdom is a strict superset for the Node-side
// generate/template tests in this same package — no need to split configs
// the way packages/vscode does (that split exists because of a conflicting
// vite.config `root`, which this package's vite.config.ts doesn't set).
export default defineConfig({
  test: { environment: "jsdom", include: ["src/**/*.test.ts"] },
});
```

- [ ] **Step 4: Create `packages/cli/vite.config.ts`**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds the browser bundle straight from a .tsx entry (no HTML entry
// point — packages/cli/src/template.ts owns index.html generation instead).
// Deterministic, unhashed asset filenames so the template can reference
// them by a known path without reading a manifest.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist/webview",
    emptyOutDir: true,
    rollupOptions: {
      input: "src/webview/main.tsx",
      output: { entryFileNames: "assets/main.js", assetFileNames: "assets/main[extname]" },
    },
  },
});
```

- [ ] **Step 5: Install workspace dependencies**

Run: `npm install`
Expected: `packages/cli` is now linked into the workspace; `node_modules/@dbt-open-lineage/cli` symlinks to it.

- [ ] **Step 6: Write the failing test for `createStaticBridge`**

Create `packages/cli/src/webview/staticBridge.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import type { Graph } from "@dbt-open-lineage/core";
import { createStaticBridge } from "./staticBridge";

const graph: Graph = { nodes: [{ id: "model.a", name: "a", resource_type: "model", layer: "staging", path: "a.sql", description: "" }], edges: [] };

describe("createStaticBridge", () => {
  it("resolves dbt.manifest and dbt.compile with the embedded graph", async () => {
    const bridge = createStaticBridge({ graph, sidecarText: null });
    expect(await bridge.invoke("dbt.manifest", {})).toBe(graph);
    expect(await bridge.invoke("dbt.compile", {})).toBe(graph);
  });

  it("resolves fs.readText with the embedded sidecar text", async () => {
    const bridge = createStaticBridge({ graph, sidecarText: "subject_areas:\n  core: {}\n" });
    expect(await bridge.invoke("fs.readText", { path: "anything" })).toBe("subject_areas:\n  core: {}\n");
  });

  it("resolves fs.readText with null when there is no sidecar", async () => {
    const bridge = createStaticBridge({ graph, sidecarText: null });
    expect(await bridge.invoke("fs.readText", { path: "anything" })).toBeNull();
  });

  it("rejects unknown/write commands", async () => {
    const bridge = createStaticBridge({ graph, sidecarText: null });
    await expect(bridge.invoke("fs.writeText", {})).rejects.toThrow(/read-only/i);
    await expect(bridge.invoke("dbt.gist", {})).rejects.toThrow(/read-only/i);
  });

  it("openInIde resolves false (no IDE in a static site)", async () => {
    const bridge = createStaticBridge({ graph, sidecarText: null });
    expect(await bridge.openInIde("some/path")).toBe(false);
  });

  it("onContext returns an unsubscribe that never fires (no live host to push context)", () => {
    const bridge = createStaticBridge({ graph, sidecarText: null });
    const cb = vi.fn();
    const unsubscribe = bridge.onContext(cb);
    unsubscribe();
    expect(cb).not.toHaveBeenCalled();
  });

  it("saveExport triggers a browser download and resolves true", async () => {
    const bridge = createStaticBridge({ graph, sidecarText: null });
    const clickSpy = vi.fn();
    const createElSpy = vi.spyOn(document, "createElement").mockReturnValue({ click: clickSpy } as unknown as HTMLAnchorElement);
    const result = await bridge.saveExport("dag.csv", "aGVsbG8=");
    expect(result).toBe(true);
    expect(clickSpy).toHaveBeenCalledOnce();
    createElSpy.mockRestore();
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npm run test -w packages/cli`
Expected: FAIL — `./staticBridge` doesn't exist yet.

- [ ] **Step 8: Implement `createStaticBridge`**

Create `packages/cli/src/webview/staticBridge.ts`:

```typescript
import type { Bridge } from "@dbt-open-lineage/core";
import type { Graph } from "@dbt-open-lineage/core";

export interface StaticPageData {
  graph: Graph;
  sidecarText: string | null;
  title?: string;
}

function download(filename: string, dataB64: string): boolean {
  const a = document.createElement("a");
  a.href = `data:application/octet-stream;base64,${dataB64}`;
  a.download = filename;
  a.click();
  return true;
}

/** Bridge backed by data embedded at build time (see template.ts) instead
 * of a live host. Read-only: write commands reject rather than silently
 * no-op, as a safety net — their UI is hidden by App's readOnly mode, so
 * this should be unreachable in practice. */
export function createStaticBridge(data: StaticPageData): Bridge {
  return {
    invoke: <T>(cmd: string): Promise<T> => {
      if (cmd === "dbt.manifest" || cmd === "dbt.compile") return Promise.resolve(data.graph as unknown as T);
      if (cmd === "fs.readText") return Promise.resolve(data.sidecarText as unknown as T);
      return Promise.reject(new Error(`read-only viewer: "${cmd}" is not available`));
    },
    saveExport: (filename, dataB64) => Promise.resolve(download(filename, dataB64)),
    openInIde: () => Promise.resolve(false),
    onContext: () => () => {},
  };
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npm run test -w packages/cli`
Expected: PASS, all 7 `createStaticBridge` tests green.

- [ ] **Step 10: Write the webview entry point (not unit-tested — matches `main.tsx` convention in `mext`/`vscode`, neither of which tests their bootstrap entry)**

Create `packages/cli/src/webview/main.tsx`:

```typescript
import { mountApp } from "@dbt-open-lineage/core";
import "@xyflow/react/dist/style.css";
import { createStaticBridge, type StaticPageData } from "./staticBridge";

declare global {
  interface Window { __DOL_STATIC_DATA__?: StaticPageData }
}

// generate.ts (packages/cli/src/generate.ts) embeds this via template.ts
// before this bundle's <script type="module"> tag.
const data = window.__DOL_STATIC_DATA__ ?? { graph: { nodes: [], edges: [] }, sidecarText: null };
if (data.title) document.title = data.title;

mountApp(document.getElementById("root")!, {
  bridge: createStaticBridge(data),
  projectPath: "",
  readOnly: true,
});
```

- [ ] **Step 11: Verify the webview bundle builds**

Run: `npm run build:webview -w packages/cli`
Expected: succeeds, produces `packages/cli/dist/webview/assets/main.js` and `packages/cli/dist/webview/assets/main.css`.

- [ ] **Step 12: Commit**

```bash
git add packages/cli/package.json packages/cli/tsconfig.json packages/cli/vite.config.ts packages/cli/vitest.config.ts packages/cli/src/webview
git commit -m "feat(cli): scaffold packages/cli, add StaticBridge and webview entry

StaticBridge implements core's Bridge interface from data embedded at
build time. The webview entry mounts core's App in readOnly mode
against it. Node-side generation (parse manifest, write index.html)
comes in a follow-up commit."
```

---

### Task 4: HTML template (`template.ts`)

**Files:**
- Create: `packages/cli/src/template.ts`
- Create: `packages/cli/src/template.test.ts`

**Interfaces:**
- Consumes: `StaticPageData` from `packages/cli/src/webview/staticBridge.ts` (Task 3).
- Produces: `buildHtml(data: StaticPageData): string`, consumed by `generate.ts` (Task 5).

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/template.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { Graph } from "@dbt-open-lineage/core";
import { buildHtml } from "./template";

const graph: Graph = { nodes: [], edges: [] };

describe("buildHtml", () => {
  it("embeds the graph data as window.__DOL_STATIC_DATA__", () => {
    const html = buildHtml({ graph, sidecarText: null });
    expect(html).toContain("window.__DOL_STATIC_DATA__=");
    expect(html).toContain('"nodes":[]');
  });

  it("references the built JS and CSS assets by relative path", () => {
    const html = buildHtml({ graph, sidecarText: null });
    expect(html).toContain('src="./assets/main.js"');
    expect(html).toContain('href="./assets/main.css"');
  });

  it("escapes < in embedded JSON so a </script>-like string can't break out", () => {
    const html = buildHtml({ graph, sidecarText: "</script><script>alert(1)</script>" });
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script\\u003e");
  });

  it("defaults the title, or uses and HTML-escapes a provided one", () => {
    expect(buildHtml({ graph, sidecarText: null })).toContain("<title>dbt Lineage</title>");
    const html = buildHtml({ graph, sidecarText: null, title: "<b>My Proj</b> & Co" });
    expect(html).toContain("<title>&lt;b&gt;My Proj&lt;/b&gt; &amp; Co</title>");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w packages/cli`
Expected: FAIL — `./template` doesn't exist yet.

- [ ] **Step 3: Implement `buildHtml`**

Create `packages/cli/src/template.ts`:

```typescript
import type { StaticPageData } from "./webview/staticBridge";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Renders the final static index.html: the prebuilt JS/CSS bundle
 * (packages/cli/dist/webview/assets, copied alongside by generate.ts) plus
 * this run's graph/sidecar data inlined as JSON. The `<` escape mirrors
 * packages/vscode/src/webview/panel.ts's buildHtml — same reason: a sidecar
 * or gist containing "</script>" must not break out of the data script tag. */
export function buildHtml(data: StaticPageData): string {
  const title = data.title ? escapeHtml(data.title) : "dbt Lineage";
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html><html><head>
<meta charset="utf-8" />
<title>${title}</title>
<link rel="stylesheet" href="./assets/main.css" />
</head><body style="margin:0"><div id="root"></div>
<script>window.__DOL_STATIC_DATA__=${json};</script>
<script type="module" src="./assets/main.js"></script>
</body></html>`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w packages/cli`
Expected: PASS, all 4 `buildHtml` tests green (plus the 7 from Task 3, unaffected).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/template.ts packages/cli/src/template.test.ts
git commit -m "feat(cli): add buildHtml static page template"
```

---

### Task 5: Node-side `generate()`

**Files:**
- Create: `packages/cli/src/generate.ts`
- Create: `packages/cli/src/generate.test.ts`
- Create: `packages/cli/test/fixtures/manifest.min.json` (small standalone fixture — kept local to `cli` rather than reused cross-package, matching how `vscode` and the new `core` fixture are each package-local copies)

**Interfaces:**
- Consumes: `parseManifest` from `@dbt-open-lineage/core/src/manifest` (Task 1 — subpath import, same rationale as `packages/vscode/src/host/manifest.ts`: this is Node-only code and must not pull `core`'s React tree into the CLI bin bundle). `buildHtml` from `./template` (Task 4).
- Produces: `generate(opts: GenerateOptions): void`, where `GenerateOptions = { manifestPath: string; outDir: string; sidecarPath?: string; title?: string; assetsDir: string }`. `assetsDir` is an explicit, required input (not resolved internally from `__dirname`) specifically so this function is testable without a real Vite build having run — Task 6's `cli.ts` is the one place that computes the real build-relative path.

- [ ] **Step 1: Create the test fixture**

Create `packages/cli/test/fixtures/manifest.min.json`:

```json
{
  "nodes": {
    "model.proj.stg_orders": {
      "name": "stg_orders", "resource_type": "model", "original_file_path": "models/staging/stg_orders.sql",
      "description": "staged orders", "tags": [], "config": { "materialized": "view", "meta": {} },
      "depends_on": { "nodes": ["source.proj.raw.orders"] }
    }
  },
  "sources": {
    "source.proj.raw.orders": {
      "name": "orders", "resource_type": "source", "original_file_path": "models/staging/src_raw.yml",
      "description": "", "tags": [], "config": {}
    }
  },
  "child_map": { "source.proj.raw.orders": ["model.proj.stg_orders"], "model.proj.stg_orders": [] }
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/cli/src/generate.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { generate } from "./generate";

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

afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

describe("generate", () => {
  it("writes index.html with the parsed graph embedded, plus the copied assets", () => {
    const outDir = join(workDir, "out");
    generate({ manifestPath, outDir, assetsDir });

    const html = readFileSync(join(outDir, "index.html"), "utf8");
    expect(html).toContain("window.__DOL_STATIC_DATA__=");
    expect(html).toContain("model.proj.stg_orders");
    expect(existsSync(join(outDir, "assets", "main.js"))).toBe(true);
    expect(existsSync(join(outDir, "assets", "main.css"))).toBe(true);
  });

  it("creates outDir if it doesn't exist", () => {
    const outDir = join(workDir, "nested", "does", "not", "exist");
    generate({ manifestPath, outDir, assetsDir });
    expect(existsSync(join(outDir, "index.html"))).toBe(true);
  });

  it("throws a clear error when the manifest doesn't exist", () => {
    expect(() => generate({ manifestPath: join(workDir, "nope.json"), outDir: join(workDir, "out"), assetsDir }))
      .toThrow(/manifest not found/i);
  });

  it("throws a clear, path-prefixed error on malformed manifest JSON", () => {
    const badManifest = join(workDir, "bad.json");
    writeFileSync(badManifest, "{not json");
    expect(() => generate({ manifestPath: badManifest, outDir: join(workDir, "out"), assetsDir }))
      .toThrow(new RegExp(badManifest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("embeds sidecar text when --sidecar is given and the file exists", () => {
    const sidecarPath = join(workDir, "lineage.yml");
    writeFileSync(sidecarPath, "subject_areas:\n  core: {}\n");
    const outDir = join(workDir, "out");
    generate({ manifestPath, outDir, assetsDir, sidecarPath });
    const html = readFileSync(join(outDir, "index.html"), "utf8");
    expect(html).toContain("subject_areas");
  });

  it("does not error when --sidecar is given but the file is missing (optional)", () => {
    const outDir = join(workDir, "out");
    expect(() => generate({ manifestPath, outDir, assetsDir, sidecarPath: join(workDir, "missing.yml") })).not.toThrow();
    const html = readFileSync(join(outDir, "index.html"), "utf8");
    expect(html).toContain('"sidecarText":null');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test -w packages/cli`
Expected: FAIL — `./generate` doesn't exist yet.

- [ ] **Step 4: Implement `generate()`**

Create `packages/cli/src/generate.ts`:

```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from "fs";
import { resolve } from "path";
import { parseManifest } from "@dbt-open-lineage/core/src/manifest";
import { buildHtml } from "./template";

export interface GenerateOptions {
  manifestPath: string;
  outDir: string;
  assetsDir: string;
  sidecarPath?: string;
  title?: string;
}

export function generate(opts: GenerateOptions): void {
  if (!existsSync(opts.manifestPath)) {
    throw new Error(`manifest not found: ${opts.manifestPath}`);
  }
  const manifestJson = readFileSync(opts.manifestPath, "utf8");
  let graph;
  try {
    graph = parseManifest(manifestJson);
  } catch (e) {
    throw new Error(`failed to parse ${opts.manifestPath}: ${(e as Error).message}`);
  }

  const sidecarText = opts.sidecarPath && existsSync(opts.sidecarPath)
    ? readFileSync(opts.sidecarPath, "utf8")
    : null;

  mkdirSync(opts.outDir, { recursive: true });
  const html = buildHtml({ graph, sidecarText, title: opts.title });
  writeFileSync(resolve(opts.outDir, "index.html"), html, "utf8");
  cpSync(opts.assetsDir, resolve(opts.outDir, "assets"), { recursive: true });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test -w packages/cli`
Expected: PASS, all 6 `generate` tests green (plus Tasks 3–4's tests, unaffected).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/generate.ts packages/cli/src/generate.test.ts packages/cli/test/fixtures/manifest.min.json
git commit -m "feat(cli): add generate() — parse manifest, write static site"
```

---

### Task 6: CLI entry point (`cli.ts`)

**Files:**
- Create: `packages/cli/src/cli.ts`
- Create: `packages/cli/src/cli.test.ts`
- Create: `packages/cli/esbuild.js`

**Interfaces:**
- Consumes: `generate` and `GenerateOptions` from `./generate` (Task 5).
- Produces: `parseArgs(argv: string[]): Record<string, string>` (exported for the unit test below) and a `main()` invoked when the file runs as the bin script. Built by `esbuild.js` into `packages/cli/out/cli.js`, which `package.json`'s `"bin"` field (Task 3, Step 1) points at.

- [ ] **Step 1: Write the failing test for arg parsing**

Create `packages/cli/src/cli.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseArgs } from "./cli";

describe("parseArgs", () => {
  it("parses --flag value pairs into an object", () => {
    expect(parseArgs(["--manifest", "a.json", "--out", "./public"]))
      .toEqual({ manifest: "a.json", out: "./public" });
  });

  it("parses optional flags alongside required ones", () => {
    expect(parseArgs(["--manifest", "a.json", "--out", "./public", "--sidecar", "l.yml", "--title", "My Project"]))
      .toEqual({ manifest: "a.json", out: "./public", sidecar: "l.yml", title: "My Project" });
  });

  it("returns an empty object for no args", () => {
    expect(parseArgs([])).toEqual({});
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w packages/cli`
Expected: FAIL — `./cli` doesn't exist yet.

- [ ] **Step 3: Implement `cli.ts`**

Create `packages/cli/src/cli.ts`:

```typescript
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { generate } from "./generate";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { out[a.slice(2)] = argv[i + 1]; i++; }
  }
  return out;
}

function usage(): string {
  return "Usage: dbt-open-lineage generate --manifest <path> --out <dir> [--sidecar <path>] [--title <name>]";
}

export function main(argv: string[]): void {
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
    generate({
      manifestPath: args.manifest,
      outDir: args.out,
      sidecarPath: args.sidecar,
      title: args.title,
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

main(process.argv.slice(2));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w packages/cli`
Expected: PASS, all 3 `parseArgs` tests green. (Note: importing `cli.ts` in the test also runs `main(process.argv.slice(2))` at module load — under `vitest run`, `process.argv` won't contain `generate`, so it prints the usage error and calls `process.exit(1)`. This is harmless for the test itself, but Step 5 below fixes it properly.)

- [ ] **Step 5: Guard `main()` so it only auto-runs when executed as a script, not when imported by the test**

Edit `packages/cli/src/cli.ts`, change the last line:

```typescript
main(process.argv.slice(2));
```

to:

```typescript
// Only auto-run when executed as the bin script, not when imported by cli.test.ts.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
```

- [ ] **Step 6: Re-run the test suite to confirm it's still green and no longer prints/exits during the test run**

Run: `npm run test -w packages/cli`
Expected: PASS, no stray "Usage:" output in the test log.

- [ ] **Step 7: Create the esbuild bundle script**

Create `packages/cli/esbuild.js`:

```javascript
const esbuild = require("esbuild");
const watch = process.argv.includes("--watch");
const ctx = {
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "out/cli.js",
  banner: { js: "#!/usr/bin/env node" },
  target: "node18",
  sourcemap: true,
};
(async () => {
  if (watch) { const c = await esbuild.context(ctx); await c.watch(); }
  else { await esbuild.build(ctx); }
})();
```

- [ ] **Step 8: Build the CLI bin and verify it runs end-to-end against the fixture**

Run:
```bash
npm run build -w packages/cli
node packages/cli/out/cli.js generate --manifest packages/cli/test/fixtures/manifest.min.json --out /tmp/dol-cli-smoke --title "Smoke Test"
```
Expected: prints `Generated static DAG viewer at /tmp/dol-cli-smoke/index.html`; `/tmp/dol-cli-smoke/index.html`, `/tmp/dol-cli-smoke/assets/main.js`, and `/tmp/dol-cli-smoke/assets/main.css` all exist. Open `/tmp/dol-cli-smoke/index.html` in a browser to confirm it loads with a blank DAG and a working selector box (type `+stg_orders+` to see the fixture's one model + its source).

- [ ] **Step 9: Make the bin executable and commit**

```bash
chmod +x packages/cli/out/cli.js  # out/ is gitignored, but confirms the shebang mode works locally
git add packages/cli/src/cli.ts packages/cli/src/cli.test.ts packages/cli/esbuild.js
git commit -m "feat(cli): add generate bin entry point

npx-able 'dbt-open-lineage generate --manifest <path> --out <dir>'.
Bundled by esbuild to out/cli.js (Node ESM, shebang'd)."
```

---

### Task 7: Wire `packages/cli` into the repo's rebuild flow

**Files:**
- Modify: `scripts/rebuild-consumers.sh`

**Interfaces:**
- Consumes: `npm run build -w packages/cli` (Task 6).
- Produces: nothing new — this task only extends the existing rebuild script's coverage and its `--cli-only` flag, following the same pattern as `--mext-only`/`--vscode-only`.

- [ ] **Step 1: Add a `CLI` flag and build step**

Edit `scripts/rebuild-consumers.sh`. In the arg-parsing loop (around line 21-30), change:

```bash
MEXT=1; VSCODE=1; PACK=1
for a in "$@"; do
  case "$a" in
    --mext-only)    VSCODE=0 ;;
    --vscode-only)  MEXT=0 ;;
    --no-pack)      PACK=0 ;;
    -h|--help)      sed -n '/^# Rebuild/,/^#   *--no-pack/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $a (try --help)" >&2; exit 2 ;;
  esac
done
```

to:

```bash
MEXT=1; VSCODE=1; CLI=1; PACK=1
for a in "$@"; do
  case "$a" in
    --mext-only)    VSCODE=0; CLI=0 ;;
    --vscode-only)  MEXT=0; CLI=0 ;;
    --cli-only)     MEXT=0; VSCODE=0 ;;
    --no-pack)      PACK=0 ;;
    -h|--help)      sed -n '/^# Rebuild/,/^#   *--no-pack/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $a (try --help)" >&2; exit 2 ;;
  esac
done
```

- [ ] **Step 2: Add the CLI build block after the vscode block**

Edit `scripts/rebuild-consumers.sh`, insert after the closing `fi` of the `if [ "$VSCODE" = 1 ]; then ... fi` block (before the final `say "done — rebuilt artifacts:"` line):

```bash
if [ "$CLI" = 1 ]; then
  say "cli build  →  out/cli.js + dist/webview/"
  npm run build -w packages/cli
  [ -f packages/cli/out/cli.js ]                    || fail "cli build missing out/cli.js"
  [ -f packages/cli/dist/webview/assets/main.js ]   || fail "cli webview build missing dist/webview/assets/main.js"
fi
```

- [ ] **Step 3: Add it to the summary output**

Edit `scripts/rebuild-consumers.sh`'s trailing summary block, after the `if [ "$VSCODE" = 1 ]; then ... fi` block:

```bash
if [ "$CLI" = 1 ]; then
  echo "  cli bin       : packages/cli/out/cli.js"
  echo "  cli webview   : packages/cli/dist/webview/"
fi
```

- [ ] **Step 4: Also update the script's own header comment and help text**

Edit `scripts/rebuild-consumers.sh` lines 6-14, change:

```bash
# core is consumed as SOURCE (no build of its own), so its edits only reach
# users once the consumers' bundles are regenerated:
#   - mext   → packages/mext/dist/  (+ packages/mext/dbt-dag-viz.mext)
#   - vscode → packages/vscode/out/extension.js + packages/vscode/media/
#
# Usage:
#   scripts/rebuild-consumers.sh [--mext-only|--vscode-only] [--no-pack]
#     --mext-only     rebuild only the .mext consumer
#     --vscode-only   rebuild only the VSCode extension
#     --no-pack       skip zipping the .mext bundle (build dist/ only)
```

to:

```bash
# core is consumed as SOURCE (no build of its own), so its edits only reach
# users once the consumers' bundles are regenerated:
#   - mext   → packages/mext/dist/  (+ packages/mext/dbt-dag-viz.mext)
#   - vscode → packages/vscode/out/extension.js + packages/vscode/media/
#   - cli    → packages/cli/out/cli.js + packages/cli/dist/webview/
#
# Usage:
#   scripts/rebuild-consumers.sh [--mext-only|--vscode-only|--cli-only] [--no-pack]
#     --mext-only     rebuild only the .mext consumer
#     --vscode-only   rebuild only the VSCode extension
#     --cli-only      rebuild only the static-site CLI
#     --no-pack       skip zipping the .mext bundle (build dist/ only)
```

- [ ] **Step 5: Run the full rebuild script to verify all three consumers build clean**

Run: `npm run rebuild`
Expected: all three "▸ ..." sections succeed, ending with a summary listing mext, vscode, and cli artifacts.

- [ ] **Step 6: Commit**

```bash
git add scripts/rebuild-consumers.sh
git commit -m "chore: add packages/cli to the rebuild-consumers flow"
```

---

### Task 8: Full-suite verification and version bump

**Files:** none (verification + version bump only)

- [ ] **Step 1: Run every workspace's tests**

Run: `npm test`
Expected: PASS across `core`, `mext`, `vscode`, and the new `cli` package.

- [ ] **Step 2: Run every workspace's typecheck**

Run: `npm run typecheck -w packages/core && npm run typecheck -w packages/cli`
Expected: PASS. (`mext` and `vscode` don't define a `typecheck` script independent of their build; `npm run build -w packages/mext` and `npm run build -w packages/vscode`, already exercised in Task 7 Step 5 via `npm run rebuild`, cover them.)

- [ ] **Step 3: Bump `packages/cli`'s version to reflect this initial release**

Edit `packages/cli/package.json`, no change needed — it starts at `0.1.0` from Task 3 and this is its first release. (Unlike `core`/`mext`/`vscode`, which bump in lockstep per the existing 4-version-bump release convention, `cli` is a new, independent artifact — it isn't part of that lockstep and doesn't need a bump here.)

- [ ] **Step 4: Final commit — update repo README if one documents the packages**

Check `README.md` for a section listing the monorepo's packages (`core`/`mext`/`vscode`). If one exists, add a `cli` entry describing it in one line ("`packages/cli` — generates a static, read-only DAG viewer from `manifest.json`, for CI-driven hosting"). If no such section exists, skip this step — don't add new documentation structure that isn't already there.

```bash
git add README.md   # only if Step 4 made a change
git commit -m "docs: mention packages/cli in the README" --allow-empty-message 2>/dev/null || true
```

(If Step 4 made no change, skip this commit entirely.)
