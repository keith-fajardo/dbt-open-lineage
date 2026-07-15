# Grain meta field — design

Date: 2026-07-15
Status: approved (brainstorming), pending implementation plan

## Scope

Add a new owned meta key, `grain`, alongside the existing `gist`,
`callout`, `subject_areas`, and `labels` keys under
`config.meta.dbt_open_lineage`. `grain` is a free-text field describing a
model's grain (e.g. "one row per order_id per day"), edited in the node
details side panel next to description/gist. No AI-generate button, no
DAG-canvas display — side-panel only, matching gist's editing UX minus the
sparkle button.

## 1. Write layer (`packages/core/src/yamlEdit.ts`)

`upsertModelDoc` gains a new required parameter `grain: string`, positioned
immediately after `gist` (a required scalar, not an optional list like
`subjectAreas`/`labels`):

```ts
export function upsertModelDoc(
  existingText: string | null, name: string, description: string, gist: string,
  grain: string, callout?: string | null, subjectAreas?: string[], labels?: string[], tags?: string[],
)
```

`grain` gets the exact same write treatment as `gist` today: nested-first,
avoid seeding a spurious empty key, clear the legacy flat key on explicit
clear.

```ts
const grainPath = nsPath("grain");
const legacyGrainPath = legacyPath("grain");
if (grain !== "" || doc.hasIn(grainPath) || doc.hasIn(legacyGrainPath)) doc.setIn(grainPath, grain);
if (grain === "" && doc.hasIn(legacyGrainPath)) doc.deleteIn(legacyGrainPath);
```

All existing callers of `upsertModelDoc` must pass the new argument at its
new position — this is a breaking signature change to an internal function,
not a back-compat-shimmed addition (no other callers exist outside
`App.tsx`).

## 2. Read layer (`packages/core/src/meta.ts`)

No change. `readMeta(meta, "grain")` already works: it's a generic
by-key lookup (namespaced-first, legacy-flat fallback) with no hardcoded
key list.

## 3. UI / state (`packages/core/src/App.tsx`)

- New state: `grainDraft` (string, mirrors `gistDraft`) and `grainH`
  (number, resizable box height, mirrors `gistH`, default `72`).
- Seeded in the same `useEffect` that populates `descDraft`/`gistDraft`
  from `selectedNode`, using the same `readMeta` typeof-guard pattern:
  ```ts
  setGrainDraft(typeof readMeta(selectedNode?.meta, "grain") === "string"
    ? (readMeta(selectedNode?.meta, "grain") as string) : "");
  ```
- Added to the `dirty` computation with the same baseline-via-`readMeta`
  comparison as `gistDraft`.
- New `dt`/`dd` block in the details panel JSX, placed immediately after
  the gist block (so panel order is: description, gist, grain, subject
  areas/labels/tags). Same textarea + resize-handle markup as gist
  (`aria-label="grain"`, `role="separator" aria-label="Resize grain"`),
  gated by the same `editable` check gist uses — no AI-generate button.
- `onSave`: pass `grainDraft` into `upsertModelDoc` at its new parameter
  position; mirror it into the optimistic `setGraph` update alongside
  `gist`/`callout`/`subject_areas`/`labels`:
  ```ts
  dbt_open_lineage: {
    ...(...),
    gist: gistDraft, grain: grainDraft, callout: nextCallout ?? undefined,
    subject_areas: areasDraft, labels: labelsDraft,
  },
  ```
- Reset lifecycle: `grainDraft`/`grainH` reset alongside the other drafts
  in the `useEffect` keyed on `selectedNode` (same block gist/desc reset
  in); no independent reset logic needed.

## 4. `CalloutOverlay.tsx` / `zones.ts`

No change. Neither consumes `grain` — callout bubbles are driven by
`gist`+`callout` only, zones by `subject_areas`. `grain` is a pure
side-panel field, same isolation as if it were a second `description`.

## Testing

- **`yamlEdit.test.ts`**: writing a fresh `grain` value creates the nested
  key; clearing an existing nested `grain` (empty string) removes it;
  clearing a legacy flat `grain` key removes that too; a save that leaves
  `grain` untouched relative to baseline does not spuriously write
  `grain: ""` onto a model that never had one (same non-seeding guarantee
  as gist).
- **`App.test.tsx`**: grain textarea renders in the details panel for an
  editable node; typing into it sets `dirty`; Save calls `upsertModelDoc`
  with the typed value at the correct argument position and optimistically
  updates the node's `meta.dbt_open_lineage.grain` in-memory; no
  AI-generate button exists for grain; a non-editable node (source, or
  read-only mode) does not show the grain field, matching gist's existing
  behavior.
- **`meta.test.ts`**: no new test required — `readMeta`'s existing
  generic-key tests already cover any key including `grain`; confirmed
  during spec self-review, not re-verified per-key.

## Out of scope

- AI-generate (sparkle) button for grain — explicitly rejected.
- Displaying grain on the DAG canvas (callout bubble, node label, or
  tooltip) — side-panel only, confirmed in brainstorming.
- Read-only display of grain for non-editable nodes (source nodes,
  read-only mode) — matches gist's current behavior of showing nothing in
  that case; not a regression, not a new gap being introduced.
- `packages/vscode` / `packages/mext` host-bridge changes — this is a
  core-only change (shared UI + yaml-write logic), no host bridge surface
  touched.
