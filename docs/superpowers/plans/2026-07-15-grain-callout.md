# Grain Callout on the DAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second DAG-canvas callout bubble for the `grain` meta field, toggled the same way as the existing `gist` callout, stacking independently above it when both are on.

**Architecture:** A new namespaced meta key `grain_callout` (mirrors `callout` exactly) drives a new bubble in `CalloutOverlay.tsx`, positioned via a generalized height-reservation formula shared with the existing single-bubble case. `App.tsx` gains parallel `grainCalloutDraft` state and a second toggle checkbox, wired through the same save/dirty/revert plumbing already used for `calloutDraft`.

**Tech Stack:** TypeScript, React, `yaml` package (eemeli), Vitest + @testing-library/react.

## Global Constraints

- `grain_callout` lives at `config.meta.dbt_open_lineage.grain_callout`, written with the EXACT same convention as `callout`: set when a non-empty string, delete on `null`/`""`, leave untouched when `undefined`.
- Both the gist bubble and the new grain bubble use SQUARE corners (`border-radius: 0`) — changes gist's existing style too, not just the new grain one.
- Grain's bubble color: `background: "#7dd3fc"`, `color: "#0c2f3f"`. Grain's leader line/dot: `stroke`/`fill: "#38bdf8"`. Gist's colors are UNCHANGED (`#fde047` bubble bg, `#1c1917` text, `#facc15` leader).
- When both bubbles show on one node: grain stacks ABOVE gist, both anchor to the node INDEPENDENTLY (each has its own leader line reaching the node's top edge — never chained bubble→bubble→node). Grain's leader renders visually behind gist's bubble (`zIndex: 1` vs gist bubble's `zIndex: 2`).
- Grain's leader line/dot sit 20px left of gist's (`anchorX - 20` vs `anchorX`) so the two never visually merge.
- Gist's own bubble position (`p.y - 14`) never changes, whether or not grain also shows.
- `estimateStackedCalloutHeight(gistText, null)` must be arithmetically IDENTICAL to `estimateCalloutHeight(gistText)` — existing single-gist-callout installs get byte-identical layout after this change, not just "close enough."
- No AI-generate (sparkle) button for grain, no `packages/vscode` / `packages/mext` host-bridge changes — core-only, matching the original grain-meta feature's scope.

---

### Task 1: Write layer — `upsertModelDoc` gains `grainCallout`

**Files:**
- Modify: `packages/core/src/yamlEdit.ts:55-58` (signature) and `:118-126` (callout write block, add a mirrored block after it)
- Test: `packages/core/src/yamlEdit.test.ts` (add new test cases; do not remove any existing ones)

**Interfaces:**
- Produces: `upsertModelDoc(existingText: string | null, name: string, description: string, gist: string, grain: string, callout?: string | null, grainCallout?: string | null, subjectAreas?: string[], labels?: string[], tags?: string[]): string` — Task 4 calls this exact signature from `App.tsx`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/yamlEdit.test.ts` (find the existing `describe` block containing the `callout` tests — usually named something like `describe("upsertModelDoc — callout", ...)` — and add a sibling `describe` block right after it):

```ts
describe("upsertModelDoc — grainCallout", () => {
  it("writes a fresh grain_callout under the namespaced key", () => {
    const out = upsertModelDoc(null, "stg_orders", "desc", "a gist", "one row per order", null, "top");
    const doc = parseDocument(out);
    expect(doc.getIn(["models", 0, "config", "meta", "dbt_open_lineage", "grain_callout"])).toBe("top");
  });

  it("clears an existing nested grain_callout on null", () => {
    const seeded = upsertModelDoc(null, "stg_orders", "desc", "a gist", "one row per order", null, "top");
    const cleared = upsertModelDoc(seeded, "stg_orders", "desc", "a gist", "one row per order", null, null);
    const doc = parseDocument(cleared);
    expect(doc.hasIn(["models", 0, "config", "meta", "dbt_open_lineage", "grain_callout"])).toBe(false);
  });

  it("clears a legacy flat grain_callout on null", () => {
    const legacySeed = `version: 2
models:
  - name: stg_orders
    description: desc
    config:
      meta:
        grain_callout: top
`;
    const cleared = upsertModelDoc(legacySeed, "stg_orders", "desc", "a gist", "one row per order", null, null);
    const doc = parseDocument(cleared);
    expect(doc.hasIn(["models", 0, "config", "meta", "grain_callout"])).toBe(false);
    expect(doc.hasIn(["models", 0, "config", "meta", "dbt_open_lineage", "grain_callout"])).toBe(false);
  });

  it("omitting grainCallout (undefined) leaves an existing value untouched", () => {
    const seeded = upsertModelDoc(null, "stg_orders", "desc", "a gist", "one row per order", null, "top");
    const untouched = upsertModelDoc(seeded, "stg_orders", "desc", "a gist", "one row per order", null, undefined);
    const doc = parseDocument(untouched);
    expect(doc.getIn(["models", 0, "config", "meta", "dbt_open_lineage", "grain_callout"])).toBe("top");
  });
});
```

Check the top of `yamlEdit.test.ts` for its existing `parseDocument` import — it already imports from `"yaml"` for other test assertions; reuse that same import, do not add a duplicate.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && npx vitest run src/yamlEdit.test.ts`
Expected: FAIL — 4 new failures (`grainCallout` is not a recognized parameter yet; TypeScript will also flag the extra argument as excess if you run `tsc`, but `vitest` alone will report a runtime type error or simply write nothing to the new path).

- [ ] **Step 3: Implement**

In `packages/core/src/yamlEdit.ts`, change the signature (line 55-58):

```ts
export function upsertModelDoc(
  existingText: string | null, name: string, description: string, gist: string,
  grain: string, callout?: string | null, grainCallout?: string | null,
  subjectAreas?: string[], labels?: string[], tags?: string[],
): string {
```

Immediately after the existing callout block (currently lines 118-126, ending with the closing `}` of the `else if` for callout), add:

```ts
  // grain_callout placement: identical treatment to callout, same reasoning.
  if (typeof grainCallout === "string" && grainCallout) {
    doc.setIn(nsPath("grain_callout"), grainCallout);
  } else if (grainCallout === null || grainCallout === "") {
    clearOwnedKey("grain_callout");
  }
```

Also update the doc comment above the function (lines 19-54) to mention `grain_callout` alongside `callout` in the "Every key this extension owns" list (line 26-27) and add one sentence describing it, mirroring the existing `callout` paragraph (lines 41-45):

```
 * `grain_callout` controls `config.meta.dbt_open_lineage.grain_callout` (the
 * placement that makes `grain` render as a second bubble on the DAG),
 * following the exact same convention as `callout` above.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run src/yamlEdit.test.ts`
Expected: PASS — all tests including the 4 new ones.

- [ ] **Step 5: Run the full core suite and typecheck**

Run: `cd packages/core && npx vitest run && npx tsc --noEmit`
Expected: All tests PASS (App.tsx currently calls `upsertModelDoc` with the OLD signature — this will now be a TypeScript error since `grainCallout` is inserted as a new parameter shifting `subjectAreas`/`labels`/`tags` by one position). If `tsc` reports an error at the `App.tsx` call site, that is EXPECTED at this point — Task 4 fixes that call site. Confirm the error is ONLY at that one call site, nowhere else.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/yamlEdit.ts packages/core/src/yamlEdit.test.ts
git commit -m "feat(core): add grain_callout to upsertModelDoc's namespaced meta keys"
```

---

### Task 2: Geometry & read helper — `CalloutOverlay.tsx` helpers

**Files:**
- Modify: `packages/core/src/CalloutOverlay.tsx:31-53` (the `estimateCalloutHeight`/`gistOf` block — helpers only, JSX untouched in this task)
- Test: `packages/core/src/CalloutOverlay.test.ts`

**Interfaces:**
- Consumes: nothing new from Task 1.
- Produces: `bubbleHeightOnly(text: string, bubbleWidth?: number): number` (internal, not exported), `estimateCalloutHeight(text: string, bubbleWidth?: number): number` (existing signature, unchanged, now built on `bubbleHeightOnly`), `estimateStackedCalloutHeight(gistText: string | null, grainText: string | null, bubbleWidth?: number): number` (NEW, exported), `grainOf(node: { meta?: Record<string, unknown> }): string | null` (NEW, exported). Task 3 calls `estimateStackedCalloutHeight`; Task 5 calls `grainOf`.

- [ ] **Step 1: Write the failing tests**

Read the top of `packages/core/src/CalloutOverlay.test.ts` first to match its existing import style and node-fixture shape (it already has tests for `gistOf` and `estimateCalloutHeight` — follow the same fixture pattern for the node shape, e.g. `{ meta: { dbt_open_lineage: { ... } } }`). Add:

```ts
describe("grainOf", () => {
  it("returns the trimmed grain when grain_callout is set (namespaced)", () => {
    const node = { meta: { dbt_open_lineage: { grain: "  one row per order  ", grain_callout: "top" } } };
    expect(grainOf(node)).toBe("one row per order");
  });

  it("returns null when grain_callout is not set", () => {
    const node = { meta: { dbt_open_lineage: { grain: "one row per order" } } };
    expect(grainOf(node)).toBeNull();
  });

  it("returns null when grain is empty/whitespace", () => {
    const node = { meta: { dbt_open_lineage: { grain: "   ", grain_callout: "top" } } };
    expect(grainOf(node)).toBeNull();
  });

  it("falls back to the legacy flat meta.grain / meta.grain_callout", () => {
    const node = { meta: { grain: "one row per order", grain_callout: "top" } };
    expect(grainOf(node)).toBe("one row per order");
  });
});

describe("estimateStackedCalloutHeight", () => {
  it("returns 0 when neither text is present", () => {
    expect(estimateStackedCalloutHeight(null, null)).toBe(0);
  });

  it("matches estimateCalloutHeight exactly when only gist is present", () => {
    const text = "One row per invoice line.";
    expect(estimateStackedCalloutHeight(text, null)).toBe(estimateCalloutHeight(text));
  });

  it("matches estimateCalloutHeight exactly when only grain is present", () => {
    const text = "transaction_line_id";
    expect(estimateStackedCalloutHeight(null, text)).toBe(estimateCalloutHeight(text));
  });

  it("stacking both reserves MORE height than either alone", () => {
    const gist = "One row per invoice line. Late-arriving credit memos re-open closed periods.";
    const grain = "transaction_line_id";
    const stacked = estimateStackedCalloutHeight(gist, grain);
    expect(stacked).toBeGreaterThan(estimateCalloutHeight(gist));
    expect(stacked).toBeGreaterThan(estimateCalloutHeight(grain));
  });

  it("stacked height equals both bubble heights plus two 14px gaps plus the 20px margin", () => {
    const gist = "short";
    const grain = "also short";
    const stacked = estimateStackedCalloutHeight(gist, grain);
    // Recompute independently (not via the function under test) to catch a
    // regression in the formula itself, not just a refactor that keeps the
    // same (possibly wrong) numbers.
    const bubbleH = (t: string) => {
      const innerW = 184 - 18;
      const charsPerLine = Math.max(1, Math.floor(innerW / 5.4));
      const lines = Math.max(1, Math.ceil(t.trim().length / charsPerLine));
      return lines * 11 * 1.35 + 12;
    };
    expect(stacked).toBe(Math.round(bubbleH(gist) + bubbleH(grain) + 2 * 14 + 20));
  });
});
```

Update the import at the top of the test file to add `estimateStackedCalloutHeight` and `grainOf` alongside the existing `estimateCalloutHeight`/`gistOf` imports from `"./CalloutOverlay"`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && npx vitest run src/CalloutOverlay.test.ts`
Expected: FAIL — `grainOf` and `estimateStackedCalloutHeight` are not exported yet.

- [ ] **Step 3: Implement**

Replace lines 31-53 of `packages/core/src/CalloutOverlay.tsx` (the `estimateCalloutHeight` doc comment through the end of `gistOf`) with:

```ts
/** Pure text→height geometry for ONE bubble — no gap or margin included. The
 * single source of truth both `estimateCalloutHeight` (one bubble) and
 * `estimateStackedCalloutHeight` (one or two, stacked) build on, so they can
 * never drift apart. */
function bubbleHeightOnly(text: string, bubbleWidth = 184): number {
  const innerW = bubbleWidth - 18;          // padding 9*2
  const charsPerLine = Math.max(1, Math.floor(innerW / 5.4)); // ~11px avg char width
  const lines = Math.max(1, Math.ceil(text.trim().length / charsPerLine));
  return lines * 11 * 1.35 + 12;            // line-height 1.35, padding 6*2
}

/** Estimate the rendered height (px, flow-space) of a SINGLE callout bubble
 * for a given note, so the layout can RESERVE that much vertical space above
 * the node (see layout.ts). Single source of truth: the constants here MUST
 * match the bubble actually rendered further down this file — fontSize 11,
 * lineHeight 1.35, padding "6px 9px", bubbleW 184, leader gap 14. */
export function estimateCalloutHeight(text: string, bubbleWidth = 184): number {
  return Math.round(bubbleHeightOnly(text, bubbleWidth) + 14 + 20); // + leader gap (14) + margin (20)
}

/** Reserved height for whichever bubble(s) actually show on a node — `null`
 * for either argument means that bubble isn't showing. One 14px gap per
 * bubble-to-something boundary (bubble→node, or bubble→bubble when both
 * stack): `estimateStackedCalloutHeight(gistText, null)` is arithmetically
 * IDENTICAL to `estimateCalloutHeight(gistText)`, so existing single-gist
 * installs get byte-identical layout. */
export function estimateStackedCalloutHeight(
  gistText: string | null, grainText: string | null, bubbleWidth = 184,
): number {
  if (!gistText && !grainText) return 0;
  const gistH = gistText != null ? bubbleHeightOnly(gistText, bubbleWidth) : 0;
  const grainH = grainText != null ? bubbleHeightOnly(grainText, bubbleWidth) : 0;
  const gaps = (gistText ? 1 : 0) + (grainText ? 1 : 0);
  return Math.round(gistH + grainH + gaps * 14 + 20);
}

/** The model's gist text, or null if there is no gist or no callout
 * placement to anchor it to. Reads via readMeta — namespaced
 * meta.dbt_open_lineage.{gist,callout} first, falling back to the legacy
 * flat meta.{gist,callout}. Exported for direct testing. */
export function gistOf(node: { meta?: Record<string, unknown> }): string | null {
  const g = readMeta(node.meta, "gist");
  const c = readMeta(node.meta, "callout");
  if (typeof g !== "string" || !g.trim() || !c) return null;
  return g.trim();
}

/** The model's grain text, or null if there is no grain or no grain_callout
 * placement to anchor it to. Mirrors `gistOf` exactly, reading
 * `grain`/`grain_callout` instead of `gist`/`callout`. Exported for direct
 * testing. */
export function grainOf(node: { meta?: Record<string, unknown> }): string | null {
  const g = readMeta(node.meta, "grain");
  const c = readMeta(node.meta, "grain_callout");
  if (typeof g !== "string" || !g.trim() || !c) return null;
  return g.trim();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run src/CalloutOverlay.test.ts`
Expected: PASS — all tests including the new ones. The pre-existing `estimateCalloutHeight` tests must still pass unchanged (byte-identical output).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/CalloutOverlay.tsx packages/core/src/CalloutOverlay.test.ts
git commit -m "feat(core): add grainOf and estimateStackedCalloutHeight helpers"
```

---

### Task 3: Layout wiring — `App.tsx` `calloutHeights` memo

**Files:**
- Modify: `packages/core/src/App.tsx:600-610` (the `calloutHeights` useMemo)
- Test: `packages/core/src/layout.test.ts`

**Interfaces:**
- Consumes: `estimateStackedCalloutHeight` from Task 2 (`./CalloutOverlay`).
- Produces: nothing new — `calloutHeights` keeps its existing `Map<string, number>` shape that `layoutGraph` (unchanged) already consumes.

- [ ] **Step 1: Write the failing test**

`layout.test.ts` already has an `it("reserves extra vertical space above a node that has a callout", ...)` test (in the `describe("layoutGraph", ...)` block) that uses this exact fixture and pattern — a 3-node graph (`int_a`, `int_b` both feeding `mrt`, so dagre stacks `int_a`/`int_b` in the same rank), a `gapOf` helper measuring the y-distance between them, and asserting a taller reserved height widens that gap. Add a new test right after it, reusing the SAME fixture/helper:

```ts
it("a taller (stacked, two-bubble) callout height reserves MORE space than a shorter (single-bubble) one", () => {
  const stacked: Graph = {
    nodes: [
      node("int_a", "intermediate"),
      node("int_b", "intermediate"),
      node("mrt", "mart"),
    ],
    edges: [
      { from: "int_a", to: "mrt" },
      { from: "int_b", to: "mrt" },
    ],
  };
  const gapOf = (pos: Map<string, { x: number; y: number }>) =>
    Math.abs(pos.get("int_a")!.y - pos.get("int_b")!.y);
  const base = layoutGraph(stacked);
  const lower = base.get("int_a")!.y > base.get("int_b")!.y ? "int_a" : "int_b";

  // 60 ≈ a single short bubble's reserved height; 110 ≈ two bubbles
  // stacked (roughly estimateStackedCalloutHeight's ballpark for two
  // short notes) — the exact numbers don't matter, only that taller
  // reserves more room than shorter.
  const single = layoutGraph(stacked, new Map([[lower, 60]]));
  const doubled = layoutGraph(stacked, new Map([[lower, 110]]));
  expect(gapOf(doubled)).toBeGreaterThan(gapOf(single));
});
```

- [ ] **Step 2: Run test to verify it fails or passes for the wrong reason**

Run: `cd packages/core && npx vitest run src/layout.test.ts`
Expected: This specific test may already PASS since `layoutGraph` itself doesn't change in this task — it takes a raw `Map<string, number>` regardless of how that map was computed. The point of this task is `App.tsx`'s COMPUTATION of that map, not `layoutGraph` itself. Confirm the existing full `layout.test.ts` suite still passes before proceeding (baseline), then move to Step 3 to change the actual production code this task is about.

- [ ] **Step 3: Implement — generalize `calloutHeights` in App.tsx**

In `packages/core/src/App.tsx`, replace lines 600-610:

```ts
  const calloutHeights = useMemo(() => {
    const m = new Map<string, number>();
    // Mirror CalloutOverlay's gistOf/grainOf exactly (readMeta, namespaced-first)
    // — this memo's whole purpose is predicting what CalloutOverlay will
    // render, so a node with nested-only meta must reserve space too, not
    // just flat.
    if (showCallouts && graph) for (const n of graph.nodes) {
      const g = readMeta(n.meta, "gist"), c = readMeta(n.meta, "callout");
      const gr = readMeta(n.meta, "grain"), gc = readMeta(n.meta, "grain_callout");
      const gistText = (typeof g === "string" && g.trim() && c) ? g.trim() : null;
      const grainText = (typeof gr === "string" && gr.trim() && gc) ? gr.trim() : null;
      if (gistText || grainText) m.set(n.id, estimateStackedCalloutHeight(gistText, grainText));
    }
    return m;
  }, [graph, showCallouts]);
```

Update the import line near the top of `App.tsx` that currently reads:

```ts
import { CalloutOverlay, estimateCalloutHeight } from "./CalloutOverlay";
```

to:

```ts
import { CalloutOverlay, estimateStackedCalloutHeight } from "./CalloutOverlay";
```

(`estimateCalloutHeight` itself is no longer called directly from `App.tsx` — only `estimateStackedCalloutHeight` is. If `tsc`/eslint flags an unused import anywhere else in the file, search for other `estimateCalloutHeight(` call sites in `App.tsx` before removing it; there should be none besides this one memo.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run src/layout.test.ts`
Expected: PASS — including the new stacked-height test and every pre-existing test in the file (the gist-only case must produce IDENTICAL positions to before this change, since `estimateStackedCalloutHeight(gistText, null) === estimateCalloutHeight(gistText)` per Task 2's guarantee).

- [ ] **Step 5: Run the full core suite and typecheck**

Run: `cd packages/core && npx vitest run && npx tsc --noEmit`
Expected: The `App.tsx` call-site error from Task 1 (Step 5) about `upsertModelDoc`'s shifted parameters still exists — that's still expected until Task 4. No NEW errors related to `calloutHeights`/`estimateStackedCalloutHeight` should appear.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/App.tsx packages/core/src/layout.test.ts
git commit -m "feat(core): reserve stacked callout height for gist+grain in App.tsx layout"
```

---

### Task 4: Panel state & save wiring — `grainCalloutDraft` in App.tsx

**Files:**
- Modify: `packages/core/src/App.tsx` — several sites: state declarations (~line 761), the `useEffect` seeding drafts (~line 787-799), the `dirty` computation (~line 822-829), `onSave` (~line 831-879), the Revert button handler (~line 2049-2057), and new checkbox JSX after the existing grain textarea block (~line 1968-1986).
- Test: `packages/core/src/App.test.tsx`

**Interfaces:**
- Consumes: `upsertModelDoc`'s new signature from Task 1 (this task is what actually FIXES the compile error left dangling since Task 1 Step 5).
- Produces: `grainCalloutDraft` state and the "Show as callout on the DAG" checkbox for grain — Task 5's `CalloutOverlay` call-site update reads `grainDraft`/`onGrainChange` (already existing) alongside this task's new state, but does not depend on `grainCalloutDraft` directly (that state only affects `onSave`/`dirty`, not what `CalloutOverlay` renders — `CalloutOverlay` reads the SAVED `grain_callout` meta via `grainOf`, not the draft toggle state).

- [ ] **Step 1: Fix an existing test that this task's new checkbox will break, then write the new failing tests**

`App.test.tsx` has an existing test (`it("populates the gist field from the namespaced meta.dbt_open_lineage.gist", ...)`, currently around line 700-717) that does:

```ts
const calloutCheckbox = screen.getByLabelText(/show as callout on the dag/i) as HTMLInputElement;
```

`getByLabelText` throws "found multiple elements" if more than one match exists. Once this task adds a second checkbox with the identical label text ("Show as callout on the DAG") for grain, that line breaks — it's a real regression this task must fix, not a hypothetical. Update it to disambiguate by DOM order (gist's checkbox renders before grain's, since the gist field precedes the grain field in the panel):

```ts
const calloutCheckbox = screen.getAllByLabelText(/show as callout on the dag/i)[0] as HTMLInputElement;
```

Now add sibling tests for grain in the `describe("editable grain field", ...)` block (starting around line 787), following the EXACT setup/assertion style the existing grain tests there already use (see `it("edits grain and writes YAML on Save", ...)` at line 790-802 for the real `invokeMock`/written-YAML-text assertion pattern — this codebase does NOT mock/spy `upsertModelDoc` directly, it asserts on the actual YAML text passed to the `fs.writeText` invoke call):

```tsx
it("grain callout checkbox is disabled until grain has content, and enables once it does", async () => {
  render(<App projectPath="/proj" initialSelector="stg_orders" />);
  fireEvent.click(await screen.findByText("stg_orders"));
  await screen.findByLabelText("grain");
  const grainCalloutCheckbox = screen.getAllByLabelText(/show as callout on the dag/i)[1] as HTMLInputElement;
  expect(grainCalloutCheckbox).toBeDisabled();
  fireEvent.change(screen.getByLabelText("grain"), { target: { value: "one row per order_id" } });
  expect(grainCalloutCheckbox).not.toBeDisabled();
});

it("toggling the grain callout checkbox marks the panel dirty", async () => {
  render(<App projectPath="/proj" initialSelector="stg_orders" />);
  fireEvent.click(await screen.findByText("stg_orders"));
  fireEvent.change(screen.getByLabelText("grain"), { target: { value: "one row per order_id" } });
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  const grainCalloutCheckbox = screen.getAllByLabelText(/show as callout on the dag/i)[1] as HTMLInputElement;
  fireEvent.click(grainCalloutCheckbox);
  expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
});

it("Save writes grain_callout to YAML and optimistically reflects it in the in-memory graph", async () => {
  render(<App projectPath="/proj" initialSelector="stg_orders" />);
  fireEvent.click(await screen.findByText("stg_orders"));
  fireEvent.change(screen.getByLabelText("grain"), { target: { value: "one row per order_id" } });
  const grainCalloutCheckbox = screen.getAllByLabelText(/show as callout on the dag/i)[1] as HTMLInputElement;
  fireEvent.click(grainCalloutCheckbox);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("fs.writeText", expect.objectContaining({
      path: "models/staging/stg_orders.yml",
    })));
  const writtenText = invokeMock.mock.calls.find((c) => c[0] === "fs.writeText")![1]!.text as string;
  expect(writtenText).toContain("grain_callout: top");
});
```

`oneModelGraph` (used implicitly via the `beforeEach` in the `describe("editable grain field", ...)` block, per line 788: `beforeEach(() => { manifestGraph = oneModelGraph; });`) already provides a `stg_orders` node with no gist/grain/callout set — no separate fixture setup is needed for these three tests.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && npx vitest run src/App.test.tsx`
Expected: FAIL — the new grain callout checkbox doesn't exist yet, `grainCalloutDraft` state doesn't exist, and `upsertModelDoc`'s call site in `App.tsx` is still using the pre-Task-1 argument order (a real bug right now, not just a missing feature — Step 3 fixes it).

- [ ] **Step 3: Implement**

In `packages/core/src/App.tsx`, add the new state right after the existing `calloutDraft` declaration (line 761):

```ts
  const [calloutDraft, setCalloutDraft] = useState(false); // show gist as a DAG callout
  const [grainCalloutDraft, setGrainCalloutDraft] = useState(false); // show grain as a DAG callout
```

In the `useEffect` that seeds drafts from `selectedNode` (currently lines 787-799), add right after the existing `setCalloutDraft` line (791):

```ts
    setCalloutDraft(!!readMeta(selectedNode?.meta, "callout"));
    setGrainCalloutDraft(!!readMeta(selectedNode?.meta, "grain_callout"));
```

In the `dirty` computation (lines 822-829), add a new clause right after the existing `calloutDraft` line (826):

```ts
     calloutDraft !== !!readMeta(selectedNode!.meta, "callout") ||
     grainCalloutDraft !== !!readMeta(selectedNode!.meta, "grain_callout") ||
```

In `onSave` (lines 831-879):
1. Right after the existing `const nextCallout = calloutDraft ? "top" : null;` line (837), add:

```ts
      const nextGrainCallout = grainCalloutDraft ? "top" : null;
```

2. Update the `upsertModelDoc` call (line 847) to pass it at the new position (right after `nextCallout`, before `areasArg`):

```ts
      const text = upsertModelDoc(existing, selectedNode.name, descDraft, gistDraft, grainDraft, nextCallout, nextGrainCallout, areasArg, labelsArg, tagsArg);
```

3. Update the optimistic `setGraph` update's `dbt_open_lineage` object (line 870) to include the new key:

```ts
                  gist: gistDraft, grain: grainDraft, callout: nextCallout ?? undefined,
                  grain_callout: nextGrainCallout ?? undefined,
                  subject_areas: areasDraft, labels: labelsDraft,
```

In the Revert button handler (lines 2049-2057), add right after the existing `setCalloutDraft` line (2053):

```ts
                      setCalloutDraft(!!readMeta(selectedNode.meta, "callout"));
                      setGrainCalloutDraft(!!readMeta(selectedNode.meta, "grain_callout"));
```

Add the new checkbox JSX. Find the existing grain textarea/resize-handle block (currently lines 1968-1986, ending with the resize-handle `<div>` that closes the grain `<dd>`). Insert the new toggle right before that `</dd>` closing tag, mirroring the gist toggle's exact structure (lines 1940-1965):

```tsx
                  {/* Same rule as gist's toggle: a grain callout with no
                      grain text renders nothing, so disable until grain
                      has content. */}
                  {(() => {
                    const hasGrain = grainDraft.trim() !== "";
                    return (
                      <label
                        style={{
                          display: "flex", alignItems: "center", gap: 8, marginTop: 8,
                          fontSize: 12, color: hasGrain ? "#e5e7eb" : "#64748b",
                          cursor: hasGrain ? "pointer" : "default",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={grainCalloutDraft && hasGrain}
                          disabled={!hasGrain}
                          onChange={(e) => setGrainCalloutDraft(e.target.checked)}
                        />
                        Show as callout on the DAG
                        {!hasGrain && (
                          <span style={{ color: "#64748b", fontSize: 11 }}>· add a grain first</span>
                        )}
                      </label>
                    );
                  })()}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run src/App.test.tsx`
Expected: PASS — all tests including the 3 new ones, and every pre-existing test in this file. In particular, confirm the `getAllByLabelText(...)[0]` fix (Step 1) resolves the "found multiple elements" failure that the new grain checkbox would otherwise cause in the existing `"populates the gist field from the namespaced meta.dbt_open_lineage.gist"` test — tests here assert on the actual written YAML text (via the `invoke`/`fs.writeText` mock), not a positional spy on `upsertModelDoc`, so no other existing Save-related assertion needs updating for the new argument position.

- [ ] **Step 5: Run the full core suite and typecheck**

Run: `cd packages/core && npx vitest run && npx tsc --noEmit`
Expected: All PASS, zero TypeScript errors — this is the task that resolves the `upsertModelDoc` call-site error that's been expected since Task 1.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/App.tsx packages/core/src/App.test.tsx
git commit -m "feat(core): add grain callout toggle + save wiring in the details panel"
```

---

### Task 5: Bubble rendering — dual callouts in `CalloutOverlay.tsx`

**Files:**
- Modify: `packages/core/src/CalloutOverlay.tsx` (whole file — full replacement below; builds on Task 2's helpers, which stay unchanged)
- Modify: `packages/core/src/App.tsx:1789-1803` (the `CalloutOverlay` call site)
- Create: `packages/core/src/CalloutOverlay.test.tsx` (NEW file — the existing `CalloutOverlay.test.ts` is a plain `.ts` file with no JSX support, confirmed by reading it: it only tests pure functions `gistOf`/`estimateCalloutHeight`, no rendering. Component-rendering tests need a `.tsx` file, matching how `nodes.tsx` has its rendering tests in `nodes.test.tsx` alongside plain logic. Leave `CalloutOverlay.test.ts` exactly as Task 2 left it — do not move its existing tests.)

**Interfaces:**
- Consumes: `bubbleHeightOnly` (internal), `estimateCalloutHeight`, `estimateStackedCalloutHeight`, `gistOf`, `grainOf` — all from Task 2, unchanged.
- Produces: `CalloutOverlayProps` gains `grainDraft: string`, `onGrainChange: (v: string) => void`; `editing: boolean` is REPLACED by `editingField: "gist" | "grain" | null`; `onBeginEdit: (id: string) => void` is REPLACED by `onBeginEdit: (id: string, field: "gist" | "grain") => void`. `onCommit`/`onCancelEdit`/`onSelect`/`selectedId` keep their existing signatures.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/CalloutOverlay.test.tsx` with the same jsdom/mock setup `nodes.test.tsx` uses for `@xyflow/react` (confirmed at `nodes.test.tsx:1-11`), extended with a `ViewportPortal` mock (`CalloutOverlay.tsx` imports `ViewportPortal`, which `nodes.test.tsx`'s existing mock doesn't provide since `nodes.tsx` doesn't use it):

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";

vi.mock("@xyflow/react", () => ({
  ViewportPortal: ({ children }: { children: ReactNode }) => children,
}));

import { CalloutOverlay } from "./CalloutOverlay";

afterEach(cleanup);
```

```tsx
describe("CalloutOverlay — dual bubbles", () => {
  const baseProps = {
    positions: new Map([["m", { x: 0, y: 200 }]]),
    dimmedIds: new Set<string>(),
    onSelect: () => {},
    selectedId: null,
    editingField: null as "gist" | "grain" | null,
    gistDraft: "", onGistChange: () => {},
    grainDraft: "", onGrainChange: () => {},
    onCommit: () => {}, onCancelEdit: () => {}, onBeginEdit: () => {},
  };
  const nodeWithBoth = {
    id: "m",
    meta: {
      dbt_open_lineage: {
        gist: "One row per invoice line.", callout: "top",
        grain: "transaction_line_id", grain_callout: "top",
      },
    },
  };

  it("renders both a gist and a grain bubble for a node with both callouts on", () => {
    const { getByText } = render(<CalloutOverlay {...baseProps} nodes={[nodeWithBoth]} />);
    expect(getByText("One row per invoice line.")).toBeTruthy();
    expect(getByText("transaction_line_id")).toBeTruthy();
  });

  it("both bubbles render with square corners (border-radius 0)", () => {
    const { getByText } = render(<CalloutOverlay {...baseProps} nodes={[nodeWithBoth]} />);
    expect(getByText("One row per invoice line.")).toHaveStyle({ borderRadius: "0" });
    expect(getByText("transaction_line_id")).toHaveStyle({ borderRadius: "0" });
  });

  it("grain bubble sits ABOVE gist's (a smaller top offset — further up the page) when both are on", () => {
    const { getByText } = render(<CalloutOverlay {...baseProps} nodes={[nodeWithBoth]} />);
    const gistTop = parseFloat((getByText("One row per invoice line.") as HTMLElement).style.top);
    const grainTop = parseFloat((getByText("transaction_line_id") as HTMLElement).style.top);
    expect(grainTop).toBeLessThan(gistTop);
  });

  it("gist bubble has a higher z-index than grain's, so grain's leader renders behind it", () => {
    const { getByText } = render(<CalloutOverlay {...baseProps} nodes={[nodeWithBoth]} />);
    const gistZ = Number((getByText("One row per invoice line.") as HTMLElement).style.zIndex);
    const grainZ = Number((getByText("transaction_line_id") as HTMLElement).style.zIndex);
    expect(gistZ).toBeGreaterThan(grainZ);
  });

  it("a grain-only node renders just the grain bubble, centered like a solo gist bubble", () => {
    const grainOnly = { id: "m", meta: { dbt_open_lineage: { grain: "gl_account_id per period", grain_callout: "top" } } };
    const { queryByText, getByText } = render(<CalloutOverlay {...baseProps} nodes={[grainOnly]} />);
    expect(queryByText(/invoice line/)).toBeNull();
    expect(getByText("gl_account_id per period")).toBeTruthy();
  });

  it("double-clicking the grain bubble calls onBeginEdit with the grain field", () => {
    const calls: [string, "gist" | "grain"][] = [];
    const { getByText } = render(
      <CalloutOverlay {...baseProps} nodes={[nodeWithBoth]} onBeginEdit={(id, field) => calls.push([id, field])} />,
    );
    getByText("transaction_line_id").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(calls).toEqual([["m", "grain"]]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && npx vitest run src/CalloutOverlay.test.tsx`
Expected: FAIL — `grainDraft`/`onGrainChange`/`editingField` props don't exist on `CalloutOverlayProps` yet, and no grain bubble renders.

- [ ] **Step 3: Implement — full file replacement**

Replace the entire contents of `packages/core/src/CalloutOverlay.tsx` with:

```tsx
import { useRef } from "react";
import { ViewportPortal } from "@xyflow/react";
import { type Pt } from "./zones";
import { NODE_W } from "./layout";
import { readMeta } from "./meta";

interface CalloutOverlayProps {
  nodes: { id: string; meta?: Record<string, unknown> }[];
  positions: Map<string, Pt>;
  dimmedIds: Set<string>;
  /** Single click a bubble → select its model (opens the details panel to edit the gist/grain). */
  onSelect: (id: string) => void;
  /** The currently selected node id (drives which bubble may enter inline edit). */
  selectedId: string | null;
  /** Which field of the CURRENTLY SELECTED node's bubbles is being edited
   * inline, if any. Only one bubble across the whole overlay is ever in
   * edit mode at once. */
  editingField: "gist" | "grain" | null;
  /** The shared gist edit buffer — bound to the panel's gist textarea too, so the
   * two stay in sync automatically (both read/write the same App state). */
  gistDraft: string;
  /** Update the shared gist buffer (= App's setGistDraft). */
  onGistChange: (v: string) => void;
  /** The shared grain edit buffer, mirroring gistDraft. */
  grainDraft: string;
  /** Update the shared grain buffer (= App's setGrainDraft). */
  onGrainChange: (v: string) => void;
  /** Commit the edit (= save gist+grain+callouts to yaml, then leave edit mode). */
  onCommit: () => void;
  /** Leave edit mode WITHOUT saving (Escape). Persistence still governed by the
   * panel's Save/Revert; this just stops the inline edit. */
  onCancelEdit: () => void;
  /** Double click a bubble → select the node AND enter inline edit for that field. */
  onBeginEdit: (id: string, field: "gist" | "grain") => void;
}

/** Pure text→height geometry for ONE bubble — no gap or margin included. The
 * single source of truth both `estimateCalloutHeight` (one bubble) and
 * `estimateStackedCalloutHeight` (one or two, stacked) build on, so they can
 * never drift apart. */
function bubbleHeightOnly(text: string, bubbleWidth = 184): number {
  const innerW = bubbleWidth - 18;          // padding 9*2
  const charsPerLine = Math.max(1, Math.floor(innerW / 5.4)); // ~11px avg char width
  const lines = Math.max(1, Math.ceil(text.trim().length / charsPerLine));
  return lines * 11 * 1.35 + 12;            // line-height 1.35, padding 6*2
}

/** Estimate the rendered height (px, flow-space) of a SINGLE callout bubble
 * for a given note, so the layout can RESERVE that much vertical space above
 * the node (see layout.ts). Single source of truth: the constants here MUST
 * match the bubble actually rendered further down this file — fontSize 11,
 * lineHeight 1.35, padding "6px 9px", bubbleW 184, leader gap 14. */
export function estimateCalloutHeight(text: string, bubbleWidth = 184): number {
  return Math.round(bubbleHeightOnly(text, bubbleWidth) + 14 + 20); // + leader gap (14) + margin (20)
}

/** Reserved height for whichever bubble(s) actually show on a node — `null`
 * for either argument means that bubble isn't showing. One 14px gap per
 * bubble-to-something boundary (bubble→node, or bubble→bubble when both
 * stack): `estimateStackedCalloutHeight(gistText, null)` is arithmetically
 * IDENTICAL to `estimateCalloutHeight(gistText)`, so existing single-gist
 * installs get byte-identical layout. */
export function estimateStackedCalloutHeight(
  gistText: string | null, grainText: string | null, bubbleWidth = 184,
): number {
  if (!gistText && !grainText) return 0;
  const gistH = gistText != null ? bubbleHeightOnly(gistText, bubbleWidth) : 0;
  const grainH = grainText != null ? bubbleHeightOnly(grainText, bubbleWidth) : 0;
  const gaps = (gistText ? 1 : 0) + (grainText ? 1 : 0);
  return Math.round(gistH + grainH + gaps * 14 + 20);
}

/** The model's gist text, or null if there is no gist or no callout
 * placement to anchor it to. Reads via readMeta — namespaced
 * meta.dbt_open_lineage.{gist,callout} first, falling back to the legacy
 * flat meta.{gist,callout}. Exported for direct testing. */
export function gistOf(node: { meta?: Record<string, unknown> }): string | null {
  const g = readMeta(node.meta, "gist");
  const c = readMeta(node.meta, "callout");
  if (typeof g !== "string" || !g.trim() || !c) return null;
  return g.trim();
}

/** The model's grain text, or null if there is no grain or no grain_callout
 * placement to anchor it to. Mirrors `gistOf` exactly, reading
 * `grain`/`grain_callout` instead of `gist`/`callout`. Exported for direct
 * testing. */
export function grainOf(node: { meta?: Record<string, unknown> }): string | null {
  const g = readMeta(node.meta, "grain");
  const c = readMeta(node.meta, "grain_callout");
  if (typeof g !== "string" || !g.trim() || !c) return null;
  return g.trim();
}

interface CalloutBubbleProps {
  text: string;
  bottom: number;   // flow-space y of the bubble's BOTTOM edge
  left: number;     // flow-space x of the bubble's LEFT edge
  width: number;
  zIndex: number;
  background: string;
  textColor: string;
  isEditing: boolean;
  draft: string;
  onDraftChange: (v: string) => void;
  onCommit: () => void;
  onCancelEdit: () => void;
  cancelledRef: React.MutableRefObject<boolean>;
  onSelect: () => void;
  onBeginEdit: () => void;
}

/** One callout bubble — used twice per node (gist, grain) so the click/edit
 * mechanics never drift between the two. */
function CalloutBubble({
  text, bottom, left, width, zIndex, background, textColor,
  isEditing, draft, onDraftChange, onCommit, onCancelEdit, cancelledRef,
  onSelect, onBeginEdit,
}: CalloutBubbleProps) {
  return (
    <div
      title={isEditing ? undefined : "Double-click to edit this note"}
      onClick={(e) => { e.stopPropagation(); if (!isEditing) onSelect(); }}
      onDoubleClick={(e) => { e.stopPropagation(); onBeginEdit(); }}
      style={{
        position: "absolute", left, top: bottom, transform: "translateY(-100%)",
        width, boxSizing: "border-box", pointerEvents: "auto", cursor: isEditing ? "text" : "pointer",
        background, color: textColor, borderRadius: 0, padding: "6px 9px", zIndex,
        fontSize: 11, fontWeight: 500, lineHeight: 1.35, boxShadow: "0 8px 22px rgba(0,0,0,0.5)",
      }}
    >
      {isEditing ? (
        <textarea
          aria-label="Edit callout note"
          value={draft}
          autoFocus
          rows={2}
          onChange={(e) => onDraftChange(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onBlur={() => { if (cancelledRef.current) { cancelledRef.current = false; return; } onCommit(); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onCommit(); }
            else if (e.key === "Escape") { e.preventDefault(); cancelledRef.current = true; onCancelEdit(); }
          }}
          style={{
            display: "block", width: "100%", boxSizing: "border-box", margin: 0, padding: 0,
            background: "transparent", color: "#0a0f1a", border: "none", outline: "none",
            fontFamily: "inherit", fontSize: 11, fontWeight: 500, lineHeight: 1.35,
            resize: "none", pointerEvents: "auto",
          }}
        />
      ) : text}
    </div>
  );
}

/** Callout bubbles pinned above their node, rendered in flow-space so they
 * pan/zoom with the graph and track the node when it is dragged (the caller
 * passes live node positions). A node can show a gist bubble, a grain
 * bubble, both (stacked, grain above gist), or neither.
 *
 * Each bubble anchors INDEPENDENTLY all the way to the node with its own
 * leader line — when both are on, grain's leader is drawn 20px left of
 * gist's and behind gist's bubble (lower z-index), so it reads as passing
 * through rather than stopping at gist's edge. Gist's own bubble position
 * never moves whether or not grain also shows.
 *
 * Single click selects the node (opens the details panel). Double click
 * edits that SPECIFIC bubble's note in place: a <textarea> replaces the
 * static text, bound to the matching draft buffer (gistDraft or
 * grainDraft), so typing in either the bubble or the panel field mirrors
 * live. Only one bubble across the whole overlay is ever in edit mode at
 * once (`editingField`, paired with `selectedId`). */
export function CalloutOverlay({
  nodes, positions, dimmedIds, onSelect, selectedId, editingField,
  gistDraft, onGistChange, grainDraft, onGrainChange, onCommit, onCancelEdit, onBeginEdit,
}: CalloutOverlayProps) {
  // Guards commit-on-blur: Escape sets this so the blur that fires when the
  // textarea unmounts (edit mode ends) does not also save. Shared across
  // both bubbles: only one is ever mid-edit at a time (editingField is a
  // single value), so there's no cross-talk between them.
  const cancelledRef = useRef(false);
  return (
    <ViewportPortal>
      {nodes.map((n) => {
        const gText = gistOf(n);
        const grText = grainOf(n);
        if (!gText && !grText) return null;
        const p = positions.get(n.id);
        if (!p) return null;
        const isEditingGist = editingField === "gist" && n.id === selectedId;
        const isEditingGrain = editingField === "grain" && n.id === selectedId;
        const anchorX = p.x + NODE_W / 2;
        const bubbleW = 184;
        const bubbleLeft = anchorX - bubbleW / 2;
        const gistBottom = p.y - 14;
        const gistHeight = gText ? bubbleHeightOnly(gText) : 0;
        // Grain stacks directly above gist's TOP edge (same 14px gap
        // reused for bubble-to-bubble as for bubble-to-node) when both
        // show; otherwise it uses the same solo position gist uses alone.
        const grainBottom = grText ? (gText ? gistBottom - gistHeight - 14 : p.y - 14) : 0;
        const grainLeaderX = anchorX - 20;
        return (
          <div key={n.id} style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", opacity: dimmedIds.has(n.id) ? 0.25 : 1 }}>
            {grText && (
              <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible", width: 1, height: 1 }}>
                <line x1={grainLeaderX} y1={grainBottom} x2={grainLeaderX} y2={p.y - 1} stroke="#38bdf8" strokeWidth={2} />
                <circle cx={grainLeaderX} cy={p.y - 1} r={3.5} fill="#38bdf8" />
              </svg>
            )}
            {gText && (
              <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible", width: 1, height: 1 }}>
                <line x1={anchorX} y1={gistBottom} x2={anchorX} y2={p.y - 1} stroke="#facc15" strokeWidth={2} />
                <circle cx={anchorX} cy={p.y - 1} r={3.5} fill="#facc15" />
              </svg>
            )}
            {grText && (
              <CalloutBubble
                text={grText} bottom={grainBottom} left={bubbleLeft} width={bubbleW} zIndex={1}
                background="#7dd3fc" textColor="#0c2f3f"
                isEditing={isEditingGrain} draft={grainDraft} onDraftChange={onGrainChange}
                onCommit={onCommit} onCancelEdit={onCancelEdit} cancelledRef={cancelledRef}
                onSelect={() => onSelect(n.id)} onBeginEdit={() => onBeginEdit(n.id, "grain")}
              />
            )}
            {gText && (
              <CalloutBubble
                text={gText} bottom={gistBottom} left={bubbleLeft} width={bubbleW} zIndex={2}
                background="#fde047" textColor="#1c1917"
                isEditing={isEditingGist} draft={gistDraft} onDraftChange={onGistChange}
                onCommit={onCommit} onCancelEdit={onCancelEdit} cancelledRef={cancelledRef}
                onSelect={() => onSelect(n.id)} onBeginEdit={() => onBeginEdit(n.id, "gist")}
              />
            )}
          </div>
        );
      })}
    </ViewportPortal>
  );
}
```

Now update the `CalloutOverlay` call site in `packages/core/src/App.tsx` (currently lines 1789-1803):

```tsx
            {showCallouts && (
              <CalloutOverlay
                nodes={graph?.nodes ?? []}
                positions={livePositions}
                dimmedIds={dimmedIds}
                onSelect={setSelected}
                selectedId={selected}
                editingField={editingField}
                gistDraft={gistDraft}
                onGistChange={setGistDraft}
                grainDraft={grainDraft}
                onGrainChange={setGrainDraft}
                onCommit={async () => { await onSave(); setEditingField(null); }}
                onCancelEdit={() => setEditingField(null)}
                onBeginEdit={readOnly ? () => {} : (id, field) => { setSelected(id); setEditingField(field); }}
              />
            )}
```

Rename the state that used to be `editingCallout` (line 766) to `editingField`, with its new type:

```ts
  const [editingField, setEditingField] = useState<"gist" | "grain" | null>(null); // inline-editing a callout bubble ("gist"/"grain") or none
```

Update the reset in the `selectedNode` effect (line 795) and the one other place `setEditingCallout` was called (line ~2, wherever the effect's cleanup sets it back to `false`):

```ts
    setEditingField(null);
```

(There are exactly 2 sites total that reference `editingCallout`/`setEditingCallout` besides the call site itself, per the earlier grep: the state declaration, one reset inside the `selectedNode` effect, and the 3 call-site props already covered above. Search the file for any remaining `editingCallout`/`setEditingCallout` occurrence after this edit — there should be none left.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run src/CalloutOverlay.test.ts src/CalloutOverlay.test.tsx src/App.test.tsx`
Expected: PASS — all tests in all three files, including every pre-existing test (a solo gist bubble must render pixel-identically to before: same position formula, only its `borderRadius` changed from 8 to 0 — if any existing test asserted `borderRadius: 8`, update that ONE assertion to `0`, since the square-corner requirement applies to gist too; none currently do — `CalloutOverlay.test.ts`'s existing tests are pure-function only and don't check bubble style).

- [ ] **Step 5: Run the full core suite and typecheck**

Run: `cd packages/core && npx vitest run && npx tsc --noEmit`
Expected: All PASS, zero TypeScript errors, zero remaining references to `editingCallout`/`setEditingCallout`/`editing=`/old single-argument `onBeginEdit` anywhere in `App.tsx` or `CalloutOverlay.tsx`.

- [ ] **Step 6: Manual verification (no automated test for exact pixel positioning)**

Build and load the extension against a real project with a model that has both a gist and a grain, each toggled on:
- Grain bubble appears ABOVE gist's, both centered over the node, square corners.
- Grain's leader line is visibly offset left of gist's and appears to pass behind the gist bubble.
- A node with only gist, or only grain, renders identically to today's single-bubble gist behavior (just centered, no stacking).
- Double-clicking the grain bubble edits grain inline; double-clicking gist still edits gist inline; only one edits at a time.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/CalloutOverlay.tsx packages/core/src/CalloutOverlay.test.tsx packages/core/src/App.tsx packages/core/src/App.test.tsx
git commit -m "feat(core): render a stacked grain callout bubble alongside gist on the DAG"
```

---

## Final Whole-Branch Review

After all 5 tasks are complete and committed, dispatch a final code reviewer (per `superpowers:subagent-driven-development`'s process) against the full diff from the branch's base commit through the last commit above. Pay particular attention to:
- Every requirement in `docs/superpowers/specs/2026-07-15-grain-callout-design.md` is implemented (spec coverage check).
- The byte-identical guarantee for existing single-gist-callout installs (Task 2's `estimateStackedCalloutHeight(gistText, null) === estimateCalloutHeight(gistText)`, and Task 5's solo-bubble rendering) actually holds, not just asserted in one test.
- No leftover references to the old `editing`/`editingCallout` boolean anywhere in `packages/core/src`.
- `packages/vscode` and `packages/mext` are untouched (core-only scope, per Global Constraints).

Then use `superpowers:finishing-a-development-branch` to wrap up (this repo's convention observed elsewhere in this session: version bump across core/cli/mext/vscode, `npm run rebuild`, commit, push — confirm with the user before pushing).
