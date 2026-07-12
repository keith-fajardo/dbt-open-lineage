# DAG Annotations — Plan 3: Favorites + Unified Filter Bar

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a personal **favorites** layer (local ★, `localStorage`, never committed) and unify **favorites + labels + dbt tags** into one filter that narrows the graph — and make that filter dim edges and callouts too, not just nodes.

**Architecture:** Favorites are pure interaction state, so they ride `ViewContext` (`favorites` set + an `onToggleFavorite` callback) exactly like the dim channels — no node-array rebuild. A pure `favorites.ts` reads/writes `localStorage` keyed by project. A pure `filters.ts` combines the three filter categories (AND across categories, OR within a category) into the existing `ViewState.filtered` set. The node dim rule is extracted into a shared `isDimmed(id, view)` helper so `DagNode`, the edge styler, and the callout overlay all dim consistently. See `packages/core/ARCHITECTURE.md` for the invariants.

**Tech Stack:** React 19, `@xyflow/react` v12, vitest (jsdom — `localStorage` is available in tests). Package: `@dbt-open-lineage/core`.

## Global Constraints

- All host access via the `Bridge`; **favorites are local only** (`localStorage`), never written to disk/git.
- Interaction styling flows through `ViewContext`, **not** node `data` (favorites star + dim are context-driven → no node-array rebuild). Node 180×44, top-left.
- Filter semantics: a node matches when it satisfies **every active category** (AND across categories); **within** a category, matching any selected value suffices (OR). No active category ⇒ `filtered` is `null` (no dimming).
- dbt tags come from `GraphNode.tags` and are **read-only** in the UI (never written to `config.tags`).
- `localStorage` key: `dol.personal.<projectPath>`, value `{ "favorites": ["<id>", ...] }`. All access is wrapped in try/catch (storage may be unavailable) and tolerant of garbage.
- Tests: vitest (`npx vitest run` from `packages/core`); clear `localStorage` between favorites tests. `npx tsc --noEmit` is the type gate.
- Mirror rule: core is consumed by both in-repo packages; do not break it.

---

### Task 1: Favorites store (localStorage)

**Files:**
- Create: `packages/core/src/favorites.ts`
- Test: `packages/core/src/favorites.test.ts`

**Interfaces:**
- Produces:
  - `favoritesKey(projectPath: string): string`
  - `loadFavorites(projectPath: string): Set<string>`
  - `saveFavorites(projectPath: string, favorites: Set<string>): void`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/favorites.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { favoritesKey, loadFavorites, saveFavorites } from "./favorites";

beforeEach(() => localStorage.clear());

describe("favorites store", () => {
  it("is empty for a fresh project", () => {
    expect(loadFavorites("/p/a")).toEqual(new Set());
  });

  it("round-trips a saved set, scoped by project path", () => {
    saveFavorites("/p/a", new Set(["m1", "m2"]));
    expect(loadFavorites("/p/a")).toEqual(new Set(["m1", "m2"]));
    expect(loadFavorites("/p/b")).toEqual(new Set()); // other project unaffected
    expect(localStorage.getItem(favoritesKey("/p/a"))).toContain("m1");
  });

  it("tolerates garbage / malformed storage", () => {
    localStorage.setItem(favoritesKey("/p/a"), "not json");
    expect(loadFavorites("/p/a")).toEqual(new Set());
    localStorage.setItem(favoritesKey("/p/a"), JSON.stringify({ favorites: "nope" }));
    expect(loadFavorites("/p/a")).toEqual(new Set());
    localStorage.setItem(favoritesKey("/p/a"), JSON.stringify({ favorites: ["ok", 3] }));
    expect(loadFavorites("/p/a")).toEqual(new Set(["ok"]));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && npx vitest run src/favorites.test.ts`
Expected: FAIL — `Cannot find module './favorites'`.

- [ ] **Step 3: Implement `favorites.ts`**

```ts
/** Personal, machine-local favorites — a set of node ids per project, stored in
 * localStorage. Never committed, never on disk. All access is best-effort:
 * storage may be unavailable and stored data may be malformed. */
const PREFIX = "dol.personal.";

export function favoritesKey(projectPath: string): string {
  return PREFIX + projectPath;
}

export function loadFavorites(projectPath: string): Set<string> {
  try {
    const raw = localStorage.getItem(favoritesKey(projectPath));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as { favorites?: unknown };
    const list = Array.isArray(parsed.favorites) ? parsed.favorites : [];
    return new Set(list.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

export function saveFavorites(projectPath: string, favorites: Set<string>): void {
  try {
    localStorage.setItem(favoritesKey(projectPath), JSON.stringify({ favorites: [...favorites] }));
  } catch {
    /* storage unavailable — favorites are best-effort */
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/core && npx vitest run src/favorites.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/favorites.ts packages/core/src/favorites.test.ts
git commit -m "feat(core): local favorites store (localStorage, per project)"
```

---

### Task 2: Unified filter computation

**Files:**
- Create: `packages/core/src/filters.ts`
- Test: `packages/core/src/filters.test.ts`

**Interfaces:**
- Consumes: `nodeLabels` from `zones.ts`.
- Produces:
  - `interface FilterOpts { favActive: boolean; favorites: Set<string>; labels: Set<string>; tags: Set<string> }`
  - `computeFiltered(nodes: { id: string; meta?: Record<string, unknown>; tags?: string[] }[], o: FilterOpts): Set<string> | null`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/filters.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeFiltered } from "./filters";

const nodes = [
  { id: "a", meta: { labels: ["core"] }, tags: ["nightly"] },
  { id: "b", meta: { labels: ["revenue"] }, tags: ["nightly"] },
  { id: "c", meta: {}, tags: ["adhoc"] },
];
const none = { favActive: false, favorites: new Set<string>(), labels: new Set<string>(), tags: new Set<string>() };

describe("computeFiltered", () => {
  it("returns null when no category is active", () => {
    expect(computeFiltered(nodes, none)).toBeNull();
  });
  it("favorites only", () => {
    expect(computeFiltered(nodes, { ...none, favActive: true, favorites: new Set(["b"]) })).toEqual(new Set(["b"]));
  });
  it("labels only (OR within category)", () => {
    expect(computeFiltered(nodes, { ...none, labels: new Set(["core", "revenue"]) })).toEqual(new Set(["a", "b"]));
  });
  it("tags only", () => {
    expect(computeFiltered(nodes, { ...none, tags: new Set(["adhoc"]) })).toEqual(new Set(["c"]));
  });
  it("AND across categories", () => {
    // nightly tag AND core label → only a
    expect(computeFiltered(nodes, { ...none, tags: new Set(["nightly"]), labels: new Set(["core"]) })).toEqual(new Set(["a"]));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && npx vitest run src/filters.test.ts`
Expected: FAIL — `Cannot find module './filters'`.

- [ ] **Step 3: Implement `filters.ts`**

```ts
import { nodeLabels } from "./zones";

export interface FilterOpts {
  favActive: boolean;
  favorites: Set<string>;
  labels: Set<string>;
  tags: Set<string>;
}

/** Ids of nodes matching ALL active filter categories (favorites, labels, tags).
 * Within a category the match is OR (any selected value). Returns null when no
 * category is active — the caller treats null as "no filter, dim nothing". */
export function computeFiltered(
  nodes: { id: string; meta?: Record<string, unknown>; tags?: string[] }[], o: FilterOpts,
): Set<string> | null {
  if (!o.favActive && o.labels.size === 0 && o.tags.size === 0) return null;
  const out = new Set<string>();
  for (const n of nodes) {
    if (o.favActive && !o.favorites.has(n.id)) continue;
    if (o.labels.size && !nodeLabels(n).some((l) => o.labels.has(l))) continue;
    if (o.tags.size && !(n.tags ?? []).some((t) => o.tags.has(t))) continue;
    out.add(n.id);
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/core && npx vitest run src/filters.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/filters.ts packages/core/src/filters.test.ts
git commit -m "feat(core): unified filter computation (favorites AND labels AND tags)"
```

---

### Task 3: Favorites star via ViewContext

**Files:**
- Modify: `packages/core/src/viewContext.ts`, `packages/core/src/nodes.tsx`, `packages/core/src/App.tsx`
- Test: `packages/core/src/nodes.test.tsx`

**Interfaces:**
- Consumes: `loadFavorites`, `saveFavorites` (Task 1).
- Produces: `ViewState.favorites: Set<string>` and `ViewState.onToggleFavorite: (id: string) => void` — a ★ on each node reflects membership and toggles it; toggling persists to `localStorage` and never rebuilds the node array (context re-render only).

- [ ] **Step 1: Extend ViewState**

In `packages/core/src/viewContext.ts`, add to the interface (after `filtered`):

```ts
  /** Ids the user has starred (personal, localStorage). Drives the ★ badge. */
  favorites: Set<string>;
  /** Toggle a node's favorite state (persists to localStorage). */
  onToggleFavorite: (id: string) => void;
```

and to the default value:

```ts
  favorites: new Set(),
  onToggleFavorite: () => {},
```

- [ ] **Step 2: Write the failing star test**

In `packages/core/src/nodes.test.tsx`, add (mirror the file's existing render + ViewContext helper; if the file uses a helper that spreads a base `ViewState`, add `favorites`/`onToggleFavorite` to that base so all existing literals keep compiling):

```tsx
it("renders a filled ★ for a favorited node and toggles on click", () => {
  const toggled: string[] = [];
  const view = {
    selected: null, active: null, up: new Set<string>(), down: new Set<string>(),
    matched: null, spotlight: null, filtered: null, search: "",
    favorites: new Set<string>(["n"]), onToggleFavorite: (id: string) => toggled.push(id),
  };
  const { getByLabelText } = render(
    <ViewContext.Provider value={view}>
      <DagNode id="n" data={{ label: "n", layer: "model", materialized: "", testCount: 0 }} />
    </ViewContext.Provider>,
  );
  const star = getByLabelText("unfavorite");
  expect(star.textContent).toBe("★");
  fireEvent.click(star);
  expect(toggled).toEqual(["n"]);
});
```

(Import `fireEvent` from `@testing-library/react` alongside the existing `render` import.)

- [ ] **Step 3: Run to verify it fails**

Run: `cd packages/core && npx vitest run src/nodes.test.tsx`
Expected: FAIL — no element labelled "unfavorite" (star not rendered yet). You will also need to add `favorites`/`onToggleFavorite` to any existing `ViewState` literals/helpers in this file so the suite type-checks; do that as part of this step.

- [ ] **Step 4: Render the star in DagNode**

In `packages/core/src/nodes.tsx`, inside the node's outer `<div>`, add the star (after the opening `<Handle type="target" …/>`, near the other corner elements). Read favorite state from context:

```tsx
      {(() => {
        const fav = view.favorites.has(id);
        return (
          <button
            aria-label={fav ? "unfavorite" : "favorite"}
            title={fav ? "Unfavorite" : "Favorite"}
            onClick={(e) => { e.stopPropagation(); view.onToggleFavorite(id); }}
            style={{
              position: "absolute", right: 1, top: -9, padding: 2, lineHeight: 1,
              background: "none", border: "none", cursor: "pointer",
              color: fav ? "#fbbf24" : "#475569", fontSize: 12,
            }}
          >
            {fav ? "★" : "☆"}
          </button>
        );
      })()}
```

(`stopPropagation` keeps a star click from also selecting the node.)

- [ ] **Step 5: Run to verify it passes**

Run: `cd packages/core && npx vitest run src/nodes.test.tsx`
Expected: PASS.

- [ ] **Step 6: Wire favorites state + persistence into App**

In `packages/core/src/App.tsx`:

Add imports:

```ts
import { useCallback } from "react"; // add to the existing "react" import if not present
import { loadFavorites, saveFavorites } from "./favorites";
```

Add state + load + toggle near the other view state (after the `showCallouts`/`labelFilter` lines):

```ts
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  useEffect(() => { setFavorites(loadFavorites(projectPath)); }, [projectPath]);
  const onToggleFavorite = useCallback((id: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      saveFavorites(projectPath, next);
      return next;
    });
  }, [projectPath]);
```

Add `favorites,` and `onToggleFavorite,` to the `view` memo object, and add `favorites, onToggleFavorite` to that memo's dependency array.

- [ ] **Step 7: Typecheck + full test run**

Run: `cd packages/core && npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/viewContext.ts packages/core/src/nodes.tsx packages/core/src/nodes.test.tsx packages/core/src/App.tsx
git commit -m "feat(core): favorite ★ per node (localStorage, via ViewContext)"
```

---

### Task 4: Unified filter bar (favorites + tags) + wire computeFiltered

**Files:**
- Create: `packages/core/src/TagChips.tsx`
- Modify: `packages/core/src/App.tsx`

**Interfaces:**
- Consumes: `computeFiltered` (Task 2); `favorites`, `labelFilter` (existing), and the new `favActive`/`tagFilter` state.
- Produces: `TagChips` component:

```ts
interface TagChipsProps {
  tags: string[];
  filter: Set<string>;
  onToggle: (tag: string) => void;
}
```
plus a "★ Favorites" toggle in the toolbar, and a rewritten `filtered` memo that combines all three categories.

- [ ] **Step 1: Implement `TagChips.tsx`**

Read-only dbt-tag chips (no color picker — tags aren't styled). Renders nothing when there are no tags.

```tsx
interface TagChipsProps {
  tags: string[];
  filter: Set<string>;
  onToggle: (tag: string) => void;
}

/** Read-only filter chips for the dbt tags already on the graph (config.tags).
 * Clicking a chip toggles it into the active tag filter. */
export function TagChips(p: TagChipsProps) {
  if (!p.tags.length) return null;
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      {p.tags.map((tag) => {
        const on = p.filter.has(tag);
        return (
          <button
            key={tag}
            onClick={() => p.onToggle(tag)}
            aria-pressed={on}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 11px",
              borderRadius: 20, border: `1px solid ${on ? "#3b82f6" : "#334155"}`,
              background: on ? "#16233d" : "#111827", fontSize: 12, color: "#e5e7eb",
              cursor: "pointer", fontFamily: "inherit",
            }}
          >
            <span aria-hidden style={{ opacity: 0.6 }}>#</span>{tag}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Add favorites-filter + tag-filter state and the tag list in App**

In `packages/core/src/App.tsx`, add state near the other filter state (`labelFilter`, etc.):

```ts
  const [favActive, setFavActive] = useState(false);
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  const onToggleTag = (tag: string) =>
    setTagFilter((prev) => {
      const next = new Set(prev);
      next.has(tag) ? next.delete(tag) : next.add(tag);
      return next;
    });

  const allTags = useMemo(() => {
    const set = new Set<string>();
    if (graph) for (const n of graph.nodes) for (const t of n.tags ?? []) set.add(t);
    return [...set].sort();
  }, [graph]);
```

- [ ] **Step 3: Rewrite the `filtered` memo to combine all three categories**

Replace the existing label-only `filtered` memo:

```ts
  const filtered = useMemo(() => {
    if (!graph || labelFilter.size === 0) return null;
    return new Set(
      graph.nodes.filter((n) => nodeLabels(n).some((l) => labelFilter.has(l))).map((n) => n.id),
    );
  }, [graph, labelFilter]);
```

with:

```ts
  const filtered = useMemo(
    () => (graph ? computeFiltered(graph.nodes, { favActive, favorites, labels: labelFilter, tags: tagFilter }) : null),
    [graph, favActive, favorites, labelFilter, tagFilter],
  );
```

Add the import: `import { computeFiltered } from "./filters";`. (`nodeLabels` may now be unused in App — if `tsc` flags it, remove it from the `./zones` import; if it's still used elsewhere in App, leave it.)

- [ ] **Step 4: Mount the Favorites toggle + TagChips in the toolbar**

Add the import: `import { TagChips } from "./TagChips";`.

In the toolbar, after `<LabelBar … />`, add a favorites toggle and the tag chips:

```tsx
          <button
            onClick={() => setFavActive((v) => !v)}
            aria-pressed={favActive}
            title="Show only favorites"
            style={{
              display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 11px",
              borderRadius: 20, border: `1px solid ${favActive ? "#3b82f6" : "#334155"}`,
              background: favActive ? "#16233d" : "#111827",
              color: "#e5e7eb", cursor: "pointer", fontFamily: "inherit", fontSize: 12,
            }}
          >
            <span style={{ color: favActive ? "#fbbf24" : "#64748b" }}>★</span> Favorites
          </button>
          <TagChips tags={allTags} filter={tagFilter} onToggle={onToggleTag} />
```

- [ ] **Step 5: Typecheck + full test run**

Run: `cd packages/core && npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Verify by hand (documented)**

Against a project with dbt tags + labels + a starred node: the "★ Favorites" toggle dims all non-favorites; tag chips and label chips further narrow (AND across categories); clearing all restores the full graph. (Requires the downstream consumer app.)

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/TagChips.tsx packages/core/src/App.tsx
git commit -m "feat(core): unified filter bar — favorites toggle + dbt tag chips"
```

---

### Task 5: Dim edges + callouts on filter (shared dim rule)

**Files:**
- Modify: `packages/core/src/nodes.tsx` (extract `isDimmed`, use it in `DagNode`)
- Modify: `packages/core/src/App.tsx` (edges + a `dimmedIds` set)
- Modify: `packages/core/src/CalloutOverlay.tsx` (per-node dim)
- Test: `packages/core/src/nodes.test.tsx` (add an `isDimmed` unit test)

**Interfaces:**
- Produces: `isDimmed(id: string, v: DimView): boolean` exported from `nodes.tsx`, where
  `DimView = Pick<ViewState, "selected" | "active" | "up" | "down" | "matched" | "spotlight" | "filtered">`.
  `DagNode`, the edge styler, and `CalloutOverlay` all use it so a filter dims nodes, their edges, and their callouts consistently.

- [ ] **Step 1: Extract `isDimmed` and use it in DagNode**

In `packages/core/src/nodes.tsx`, add the exported helper above `DagNode` (it encodes the exact rule DagNode already uses):

```ts
import type { ViewState } from "./viewContext";

export type DimView = Pick<ViewState, "selected" | "active" | "up" | "down" | "matched" | "spotlight" | "filtered">;

/** The single source of truth for whether a node is dimmed. The open model is
 * never dimmed; a selection dims everything off its lineage; otherwise the
 * selector (matched), area spotlight, and label/personal filter each dim
 * non-members. */
export function isDimmed(id: string, v: DimView): boolean {
  if (id === v.active) return false;
  if (v.selected != null) return !(id === v.selected || v.up.has(id) || v.down.has(id));
  const spotlit = v.spotlight == null || v.spotlight.has(id);
  const inFilter = v.filtered == null || v.filtered.has(id);
  return (v.matched != null && !v.matched.has(id)) || !spotlit || !inFilter;
}
```

Then in `DagNode`, replace the inline `spotlit`/`inFilter`/`dim` computation with:

```ts
  const dim = isDimmed(id, view);
```

(Delete the now-redundant `spotlit`/`inFilter` locals. `hasSel`, `inLineage`, `selected`, `active` locals used elsewhere in the component stay.)

- [ ] **Step 2: Add an `isDimmed` unit test**

In `packages/core/src/nodes.test.tsx`, add:

```tsx
import { isDimmed } from "./nodes"; // add to the existing import from "./nodes"

describe("isDimmed", () => {
  const base = { selected: null, active: null, up: new Set<string>(), down: new Set<string>(), matched: null, spotlight: null, filtered: null };
  it("open model is never dimmed", () => {
    expect(isDimmed("m", { ...base, active: "m", filtered: new Set(["x"]) })).toBe(false);
  });
  it("filter dims non-members", () => {
    expect(isDimmed("m", { ...base, filtered: new Set(["x"]) })).toBe(true);
    expect(isDimmed("x", { ...base, filtered: new Set(["x"]) })).toBe(false);
  });
  it("spotlight and filter compose", () => {
    expect(isDimmed("m", { ...base, spotlight: new Set(["m"]), filtered: new Set(["x"]) })).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify (DagNode still green, new test passes)**

Run: `cd packages/core && npx vitest run src/nodes.test.tsx`
Expected: PASS (the extraction is behavior-preserving, so existing DagNode dim tests stay green; the new `isDimmed` test passes).

- [ ] **Step 4: Dim edges when the filter (or spotlight) excludes an endpoint**

In `packages/core/src/App.tsx`, import the helper: `import { nodeTypes, isDimmed, type DagNodeData } from "./nodes";` (extend the existing `./nodes` import).

In the `rfEdges` memo, replace the `opacity` expression:

```ts
            opacity: hasSel
              ? (onLineage ? 0.95 : 0.06)
              : !focus && !(matched.has(e.from) && matched.has(e.to)) ? 0.1 : 0.9,
```

with one that also fades edges touching a dimmed (spotlight/filter) node:

```ts
            opacity: hasSel
              ? (onLineage ? 0.95 : 0.06)
              : (isDimmed(e.from, view) || isDimmed(e.to, view)) ? 0.1 : 0.9,
```

Add `view` to the `rfEdges` memo dependency array (the memo already lists `graph, matched, focus, selected, lineage` — add `view`). `view` is defined just above `rfEdges`, so it is in scope.

- [ ] **Step 5: Dim callouts per node**

In `packages/core/src/App.tsx`, compute the dimmed-id set once and pass it to the overlay. Add near the `view` memo:

```ts
  const dimmedIds = useMemo(
    () => (graph ? new Set(graph.nodes.filter((n) => isDimmed(n.id, view)).map((n) => n.id)) : new Set<string>()),
    [graph, view],
  );
```

Change the `<CalloutOverlay>` mount to pass `dimmedIds` instead of the single `dimmed` boolean:

```tsx
            {showCallouts && (
              <CalloutOverlay
                nodes={graph?.nodes ?? []}
                positions={positioned}
                dimmedIds={dimmedIds}
              />
            )}
```

In `packages/core/src/CalloutOverlay.tsx`, change the prop and the per-callout opacity:

```ts
interface CalloutOverlayProps {
  nodes: { id: string; meta?: Record<string, unknown> }[];
  positions: Map<string, Pt>;
  dimmedIds: Set<string>;
}
```

and in the component signature (`{ nodes, positions, dimmedIds }`) and the wrapper `div`'s style:

```tsx
          <div key={n.id} style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", opacity: dimmedIds.has(n.id) ? 0.25 : 1 }}>
```

- [ ] **Step 6: Typecheck + full test run**

Run: `cd packages/core && npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/nodes.tsx packages/core/src/nodes.test.tsx packages/core/src/App.tsx packages/core/src/CalloutOverlay.tsx
git commit -m "feat(core): dim edges and callouts with the active filter (shared isDimmed)"
```

---

## Self-Review

**Spec coverage (Plan 3 scope):**
- Favorites: local ★ per node, `localStorage` per project, filter-only — Tasks 1, 3. ✓
- Favorites toggle from the node, no node rebuild (ViewContext) — Task 3. ✓
- Unified filter bar: favorites + labels + dbt tags → one `filtered` set, AND across / OR within — Tasks 2, 4. ✓
- dbt tags surfaced as read-only chips — Task 4. ✓
- Filter dims nodes **and** edges **and** callouts (fixes the Plan-2 follow-up) via a shared `isDimmed` — Task 5. ✓
- Deferred (correctly absent): freehand drawing (Plan 4); canvas authoring / `config.meta` writes (Phase 2). Area spotlight stays a separate control (`AreaControl`), not folded into the chip bar — areas have their own visibility+spotlight semantics.

**Placeholder scan:** No TBD/TODO; every code step carries complete code; every command has an expected result.

**Type consistency:** `ViewState` gains `favorites` + `onToggleFavorite` (Task 3), read in `nodes.tsx` and supplied by App's `view` memo. `FilterOpts`/`computeFiltered` in `filters.ts` (Task 2) called in App (Task 4). `isDimmed(id, DimView)` exported from `nodes.tsx` (Task 5), used by `DagNode`, the `rfEdges` styler, and `dimmedIds`; `CalloutOverlay` prop changes `dimmed: boolean` → `dimmedIds: Set<string>` at its only call site. `favoritesKey`/`loadFavorites`/`saveFavorites` (Task 1) used in App (Task 3).

**Cross-task note:** Task 3 adds `favorites`/`onToggleFavorite` to every `ViewState` literal in `nodes.test.tsx`; Task 5's new `isDimmed` test constructs a `DimView` (a subset), which needs none of the favorites fields. The `filtered` memo is authored label-only in Plan 2 and rewritten in Task 4 to use `computeFiltered` — ensure the Plan-2 version is fully replaced, not duplicated.
