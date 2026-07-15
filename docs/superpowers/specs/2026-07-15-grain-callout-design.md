# Grain callout on the DAG — design

Date: 2026-07-15
Status: approved (mockup iterated live, requirements confirmed by user), pending implementation plan
Supersedes: `2026-07-15-grain-meta-design.md`'s "Out of scope" line —
"Displaying grain on the DAG canvas ... side-panel only, confirmed in
brainstorming." That decision is reversed here. Everything else in that
spec (the side-panel `grain` field itself, already merged in
`344aef0`) is unaffected and unchanged.

## Scope

Add a second DAG-canvas callout bubble, driven by the `grain` meta field,
using the exact same mechanism as the existing `gist` callout (toggle in
the details panel → bubble above the node). Confirmed live against an
interactive HTML mockup (`grain-callout-mockup.html`) before this spec was
written — the mockup's final state is the source of truth for exact visual
behavior described below.

Requirements, as iterated and confirmed:

1. New per-node toggle: **"Show as callout on the DAG"** for `grain`,
   identical label/behavior to the existing gist toggle, independent
   on/off state.
2. New DAG bubble for grain: same mechanics as gist's (184px wide, leader
   line + dot into the node's top edge), **light blue** (`#7dd3fc` fill /
   `#0c2f3f` text / `#38bdf8` leader) instead of gist's yellow, so the two
   are never confused.
3. **Both bubbles switch from rounded to square corners** (`border-radius:
   0`) — this changes gist's existing bubble too, not just the new grain
   one.
4. When both are on for the same node: they **stack**, grain above gist,
   both centered over the node. Each anchors **independently** all the way
   down to the node — NOT chained grain→gist→node. Grain's leader line
   physically passes behind the gist bubble (lower stacking order) rather
   than stopping at gist's edge.
5. Grain's leader is offset slightly (20px) to the left of gist's so the
   two leader lines are visually distinct even where they run alongside
   each other.
6. Single-callout nodes (only gist, or only grain) render exactly like
   today's single-gist bubble — centered, own leader, no stacking logic
   involved.
7. Layout must auto-reserve enough vertical space for whichever bubble(s)
   are actually showing on a node (single bubble, stacked pair, or none),
   the same way it already reserves space for a single gist bubble today
   — generalized, not duplicated.

## 1. New owned meta key: `grain_callout`

Mirrors `callout` exactly. `config.meta.dbt_open_lineage.grain_callout`,
same values (`"top"` or absent), same nested-first/legacy-fallback read via
the existing generic `readMeta` (no code change needed there — confirmed,
it's already key-agnostic).

## 2. Write layer (`packages/core/src/yamlEdit.ts`)

`upsertModelDoc` gains a new optional parameter `grainCallout?: string |
null`, positioned immediately after `callout` (before `subjectAreas`):

```ts
export function upsertModelDoc(
  existingText: string | null, name: string, description: string, gist: string,
  grain: string, callout?: string | null, grainCallout?: string | null,
  subjectAreas?: string[], labels?: string[], tags?: string[],
): string
```

`grainCallout` gets the **exact same treatment as `callout`** (yamlEdit.ts
today, lines 122–126):

```ts
if (typeof grainCallout === "string" && grainCallout) {
  doc.setIn(nsPath("grain_callout"), grainCallout);
} else if (grainCallout === null || grainCallout === "") {
  clearOwnedKey("grain_callout");
}
```

This is a breaking signature change to an internal function (consistent
with how `grain` itself was added) — the one call site in `App.tsx` must
pass the new argument explicitly.

## 3. Read helper (`packages/core/src/CalloutOverlay.tsx`)

New exported `grainOf`, mirroring `gistOf` exactly:

```ts
export function grainOf(node: { meta?: Record<string, unknown> }): string | null {
  const g = readMeta(node.meta, "grain");
  const c = readMeta(node.meta, "grain_callout");
  if (typeof g !== "string" || !g.trim() || !c) return null;
  return g.trim();
}
```

## 4. Layout reservation — a single, precise formula

Refactor `estimateCalloutHeight` to share an inner, unrounded
`bubbleHeightOnly(text, bubbleWidth)` helper (pure text→height geometry, no
gap/margin), so the existing single-bubble function and a new stacked-pair
function both build on ONE source of truth:

```ts
function bubbleHeightOnly(text: string, bubbleWidth = 184): number {
  const innerW = bubbleWidth - 18;
  const charsPerLine = Math.max(1, Math.floor(innerW / 5.4));
  const lines = Math.max(1, Math.ceil(text.trim().length / charsPerLine));
  return lines * 11 * 1.35 + 12;
}

export function estimateCalloutHeight(text: string, bubbleWidth = 184): number {
  return Math.round(bubbleHeightOnly(text, bubbleWidth) + 14 + 20);
}

/** Reserved height for whichever bubble(s) actually show on a node —
 * `null` for a text argument means that bubble isn't showing. One 14px gap
 * per bubble-to-something boundary (bubble→node, or bubble→bubble when
 * stacked), so `estimateStackedCalloutHeight(gistText, null)` is
 * arithmetically IDENTICAL to `estimateCalloutHeight(gistText)` — the
 * existing single-gist-callout installs get byte-identical layout,
 * verified by a shared-value test, not just asserted. */
export function estimateStackedCalloutHeight(
  gistText: string | null, grainText: string | null, bubbleWidth = 184,
): number {
  if (!gistText && !grainText) return 0;
  const gistH = gistText != null ? bubbleHeightOnly(gistText, bubbleWidth) : 0;
  const grainH = grainText != null ? bubbleHeightOnly(grainText, bubbleWidth) : 0;
  const gaps = (gistText ? 1 : 0) + (grainText ? 1 : 0);
  return Math.round(gistH + grainH + gaps * 14 + 20);
}
```

`App.tsx`'s `calloutHeights` memo (today, lines 600–610) generalizes to
call `estimateStackedCalloutHeight` with both texts (each `null` unless
that node's gist/grain callout is actually active):

```ts
const calloutHeights = useMemo(() => {
  const m = new Map<string, number>();
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

No change to `layout.ts` itself — it already consumes an opaque
`calloutHeights: Map<string, number>` per node; it doesn't need to know
whether that height came from one bubble or two.

## 5. Rendering (`CalloutOverlay.tsx`)

Both bubbles switch to `borderRadius: 0` (was `8`) — the one existing gist
style plus the new grain style.

Positioning (flow-space, `p.y` = node's top edge, unchanged convention):

- `gistBubbleBottom = p.y - 14` (unchanged from today — gist's own
  position never moves, whether or not grain also shows).
- `gistBubbleTop = gistBubbleBottom - bubbleHeightOnly(gistText)` (only
  computed when gist is showing).
- Grain, when showing:
  - **Both showing**: `grainBubbleBottom = gistBubbleTop - 14` (stacks
    directly above gist, same 14px gap constant reused for the
    bubble-to-bubble gap as the node-to-bubble gap).
  - **Grain only** (no gist): `grainBubbleBottom = p.y - 14` (identical
    convention to gist's solo position).
- **Each bubble's leader line is independent**, drawn from that bubble's
  own bottom straight down to the node's top (`p.y`) — never chained
  bubble→bubble→node. This is the literal, explicitly-confirmed
  requirement (a hand-drawn reference image showed grain's line running
  the full distance, passing visually behind gist rather than terminating
  at it).
- **Stacking order**: gist's bubble div gets an explicit `zIndex: 2`;
  grain's bubble div gets `zIndex: 1`; both leader `<svg>` elements are
  left at the default stacking tier (below both explicit z-indices). This
  is what makes grain's leader line disappear behind gist's bubble for the
  segment where they visually overlap, while both bubbles themselves stay
  fully visible (they never spatially overlap each other).
- **Horizontal offset**: grain's leader line (svg line + dot) sits 20px
  left of gist's leader (`anchorX - 20` vs `anchorX`), confirmed via the
  mockup, so the two lines never visually merge into one even in the
  region where grain's runs alongside/behind gist's bubble. The BUBBLES
  themselves stay centered (`anchorX - bubbleW/2`) — only the thin leader
  lines are offset.

## 6. Inline edit — per-bubble discriminator

Today's `CalloutOverlay` props assume exactly one editable bubble per
node: `editing: boolean` + `selectedId`. With two possible bubbles on one
node, double-clicking must specify WHICH one entered edit mode. Replace:

- `editing: boolean` → `editingField: "gist" | "grain" | null`
- `onBeginEdit: (id: string) => void` → `onBeginEdit: (id: string, field: "gist" | "grain") => void`
- New props: `grainDraft: string`, `onGrainChange: (v: string) => void`

`onCommit`/`onCancelEdit` stay as-is (unparameterized) — `onSave` already
persists gist AND grain together on every save, so commit doesn't need to
know which field was mid-edit.

Single click on EITHER bubble still just selects the node (`onSelect`),
unchanged behavior.

## 7. UI / state (`App.tsx`)

- New state: `grainCalloutDraft` (boolean), mirrors `calloutDraft` exactly
  — same two seed sites (initial `selectedNode` effect, and the
  post-save reset effect), same dirty-check inclusion, same
  `nextGrainCallout = grainCalloutDraft ? "top" : null` pattern in
  `onSave`, passed into `upsertModelDoc` at its new parameter position,
  and mirrored into the optimistic `setGraph` update alongside
  `grain: grainDraft` (`grain_callout: nextGrainCallout ?? undefined`).
- New checkbox JSX, placed directly after the existing grain
  textarea/resize-handle block, copying the gist toggle's exact
  structure: label text **"Show as callout on the DAG"**, `disabled`
  until `grainDraft.trim() !== ""`, hint text `"· add a grain first"`
  when disabled — same UX contract as gist's toggle, just for grain.
- `CalloutOverlay` call site updated for the new/renamed props
  (`grainDraft`, `onGrainChange={setGrainDraft}`, `editingField` instead
  of `editing`, `onBeginEdit` now takes a field argument).

## Testing

- **`CalloutOverlay.test.ts`**: `grainOf` — namespaced-first, legacy
  fallback, absent grain/grain_callout → null (mirrors existing `gistOf`
  tests). `estimateStackedCalloutHeight`: both-null → 0; one text only →
  arithmetically equal to `estimateCalloutHeight` of that same text
  (explicit equality assertion, not just "a number"); both texts →
  sum of both bubble heights + 2×14 + 20 gap math, asserted precisely.
- **`layout.test.ts`**: a node with both callouts active reserves MORE
  height than a node with only one (regression for the overlap bug this
  whole feature must not reintroduce); a node with only gist (today's
  existing case) reserves the exact same height as before the refactor —
  explicit before/after equality, not just "still positive."
- **`yamlEdit.test.ts`**: writing `grainCallout: "top"` creates
  `config.meta.dbt_open_lineage.grain_callout`; clearing it (`null`)
  removes the nested key AND a legacy flat one if present; omitting the
  argument (`undefined`) leaves an existing value untouched — same three
  cases already covered for `callout`.
- **`App.test.tsx`**: grain toggle renders disabled with no grain text,
  enables once grain has content; toggling it sets `dirty`; Save calls
  `upsertModelDoc` with the new argument at the correct position and
  optimistically updates `meta.dbt_open_lineage.grain_callout` in the
  in-memory graph.
- Manual/visual verification (no automated test for exact pixel
  positioning — matches how the existing single-gist-bubble positioning
  was verified originally): stacked case renders grain above gist with
  independent leaders, offset lines, square corners, correct z-order.

## Out of scope

- No AI-generate (sparkle) button for grain — unchanged from the original
  grain-meta spec.
- No change to how `gist`'s OWN toggle/edit UX works, beyond the shared
  square-corner style change.
- No `packages/vscode` / `packages/mext` host-bridge changes — core-only,
  same as the original grain-meta feature.
