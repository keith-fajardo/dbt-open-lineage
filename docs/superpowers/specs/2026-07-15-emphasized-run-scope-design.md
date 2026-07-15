# Run scope = emphasized nodes, plus an Apply Filter/Restore prune action — design

Date: 2026-07-15
Status: approved (brainstorming), pending implementation plan

## Scope

Three related changes to the DAG viewer's filter/emphasis system and the
Run/Build/Test button:

1. Run's target set currently disagrees with what's visually emphasized on
   the DAG (dimmed vs. bright). Fix Run to always target exactly the
   emphasized (non-dimmed) node set — one shared source of truth with the
   dimming logic.
2. Add an "Apply Filter" button: an on-demand action that physically
   removes currently-dimmed nodes from the rendered DAG, leaving only the
   emphasized set on screen. The same button relabels to "Restore" while
   pruning is active, to undo it.
3. Restyle the existing "Focus" checkbox as a button matching the visual
   language of the other toolbar toggles (Favorites, etc.) — no behavior
   change, purely cosmetic.

Bundled as one spec since all three touch the same emphasis/filter system,
but each is implemented and reviewed as its own task.

## Background: the mismatch this fixes

`packages/core/src/nodes.tsx`'s `isDimmed(id, view)` is the DAG's single
source of truth for what's visually emphasized: a node stays bright only if
it passes **every** active dim reason (selector match, category filter,
spotlight, lineage-selection) — an AND/intersection composition. Meanwhile
`packages/core/src/filters.ts`'s `computeActiveIds(matched, filtered)`
(today's Run-scope function) is a plain **union**: `matched ∪ filtered`. So
today, turning on a selector AND a category filter (e.g. Favorites) at the
same time makes Run target more than what's emphasized on screen — e.g. a
favorited node outside the current selector's lineage, which is dimmed, is
still included in the run.

## 1. Run's target set: single source of truth with dimming

`App.tsx`'s `activeIds` currently reads:

```tsx
const activeIds = useMemo(
  () => ((cleanedSelector.trim() || showAll) ? computeActiveIds(matched, filtered) : new Set<string>()),
  [cleanedSelector, matched, filtered, showAll],
);
```

This changes to iterate `graph.nodes` and keep only ids where `isDimmed`
returns `false`, using the exact same `view` object (or the subset of its
fields `isDimmed` needs — `DimView`) already built for rendering:

```tsx
const activeIds = useMemo(() => {
  if (!graph) return new Set<string>();
  const blank = !cleanedSelector.trim() && !showAll;
  if (blank) return new Set<string>(); // no default "whole project"
  return new Set(graph.nodes.filter((n) => !isDimmed(n.id, view)).map((n) => n.id));
}, [graph, cleanedSelector, showAll, view]);
```

`isDimmed` already respects the `focus` gate on the selector channel
(`view.matched` is `focus ? matched : null`) — so this also changes today's
incidental behavior where typing into the selector box narrows Run
immediately, even before Focus/Enter commits it. After this change, Run
matches the DAG's own visual state exactly: an uncommitted, still-being-typed
selector doesn't narrow Run either, same as it doesn't dim anything yet.

**No regression for the no-filter case:** when no category filter is active,
`view.filtered` is `null`, and `isDimmed`'s `inFilter` check
(`v.filtered == null || v.filtered.has(id)`) always passes — so the new
computation reduces to exactly the old selector-only behavior whenever
filters aren't in play (the common case, and what all of the prior
`hasSeed`/`hasFullRefresh` tests exercise).

**`computeActiveIds` is deleted** from `filters.ts` (and its tests removed)
— it becomes dead code once `activeIds` is computed this way. `computeFiltered`
is untouched; it's still what produces `filtered` for `isDimmed` to consume.

## 2. Apply Filter / Restore button

### Purpose

A way to physically clear dimmed clutter off the DAG, so you can *see*
exactly what will run before clicking Run — separate from and additive to
the Run-scope fix above (which already makes Run target the right nodes
with or without pruning).

### State

```tsx
const [pruned, setPruned] = useState<Set<string> | null>(null); // null = no pruning
```

### Button behavior

Rendered in the Filter row (Row 2 of the toolbar), after the tag chips.
Label and action depend on `pruned`:

- **`pruned === null`** → labeled **"Apply Filter"**. Disabled when no
  category filter is active (`!favActive && areas.size===0 &&
  labels.size===0 && tags.size===0`) — same enablement pattern as other
  conditional toolbar buttons (e.g. today's Refresh button, disabled when
  `!runStatus`). On click: `setPruned(new Set(graph.nodes.filter(n =>
  !isDimmed(n.id, view)).map(n => n.id)))` — the SAME emphasized-set
  computation `activeIds` uses (Section 1), snapshotted once, not
  reactive afterward.
- **`pruned !== null`** → labeled **"Restore"**. Always enabled. On click:
  `setPruned(null)`.

This is a one-shot action, not a live toggle (confirmed): adjusting filters
after clicking Apply Filter does NOT re-prune automatically. The button only
shows one of the two labels at a time, so re-narrowing after adjusting
filters requires Restore → adjust filters → Apply Filter again — no
ambiguity about stacking or partial updates.

### Rendering effect

`visibleGraph`, `buildNodes`, and `rfEdges` each gain one more AND
condition, applied only when `pruned !== null`: filter node/edge lists down
to ids present in `pruned`, on top of whatever selector/focus filtering
already applies. When `pruned === null`, these three are unaffected by this
feature — unchanged from their current (Section-1-updated) behavior.

### Lifecycle / reset

- Auto-clears (`pruned` reset to `null`) on the same lineage-change
  `useEffect` that already resets `runStatus`/`runErr`/`runLogs`, keyed on
  `selector` — a newly committed selector or a double-click-into-a-model
  always starts clean, so pruning never survives into an unrelated view
  where it wouldn't make sense.
- Does **not** share the Refresh (↻) button — Refresh keeps its existing,
  narrower meaning (clear run status/logs only). Restore is Apply Filter's
  own, separate undo, available only while `pruned !== null`.

### Never affects Run's target

`activeIds` (Section 1) is computed over `graph.nodes`, not over whatever's
currently rendered — so `pruned` is irrelevant to what Run targets. Run
already targets the emphasized set whether or not Apply Filter has ever
been clicked; pruning is purely a rendering/visibility concern.

## 3. Focus: checkbox → button (visual only)

`App.tsx`'s Focus control currently renders as:

```tsx
<label style={TOGGLE_PILL}>
  <input type="checkbox" checked={focus} onChange={(e) => setFocus(e.target.checked)} /> Focus
</label>
```

This becomes a `<button>` styled like the existing Favorites filter chip
(`aria-pressed`, border/background keyed off the boolean state), e.g.:

```tsx
<button
  onClick={() => setFocus((v) => !v)}
  aria-pressed={focus}
  title="Show only the selector's matched nodes"
  style={{
    display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 11px",
    borderRadius: 20, border: `1px solid ${focus ? "#3b82f6" : "#334155"}`,
    background: focus ? "#16233d" : "#111827",
    color: "#e5e7eb", cursor: "pointer", fontFamily: "inherit", fontSize: 12,
  }}
>Focus</button>
```

**No behavior change** — `focus` remains an instantly-reactive boolean;
clicking the button toggles it exactly like the checkbox did. This is pure
restyling for visual consistency with the other pill-style toolbar
controls, confirmed explicitly as visual-only (not a one-shot action like
Apply Filter).

## Testing

- **Run scope (Section 1):** a test with a selector committed (Focus on)
  AND Favorites on, where the favorited node is OUTSIDE the selector's
  lineage — asserts that node is NOT included in the `dbt.run` invoke call
  (this is the regression the old union-based `computeActiveIds` had). A
  companion test with both active and overlapping — asserts only the
  overlap is included. A test with an uncommitted (typed but Enter not
  pressed, Focus off) selector — asserts it does NOT narrow Run (only
  filters do, since selector channel is off pre-commit). Existing
  `hasSeed`/`hasFullRefresh` tests (no filters active) must continue
  passing unchanged.
- **Apply Filter / Restore:** a test that clicking Apply Filter with
  Favorites on removes non-favorited nodes from the rendered DAG; a test
  that Restore brings them back; a test that the button is disabled with no
  filter active; a test that toggling a filter OFF after Apply Filter does
  NOT auto-restore the pruned nodes (stays stale/static); a test that
  committing a new selector (Enter) auto-clears the pruning.
- **Focus button:** existing Focus-related tests (e.g. clicking it, its
  checked/pressed state reflecting `focus`) continue to pass against the
  new button markup — update any test that queries it via
  `getByLabelText`/checkbox-specific queries to the new button query
  (`getByRole("button", {name: "Focus"})` + `aria-pressed`).
- **`computeActiveIds` removal:** its existing tests in `filters.test.ts`
  are deleted along with the function.

## Out of scope

- Making Apply Filter/Restore a live-reactive toggle (explicitly rejected —
  one-shot button only).
- Sharing Refresh's undo with Apply Filter's Restore (explicitly kept
  separate).
- Changing Focus's reactive (non-one-shot) behavior (explicitly visual-only).
- The `spotlight` dim channel — already unused/always-null in the current
  codebase (subject areas were folded into `filtered` separately); not
  touched by this work.
