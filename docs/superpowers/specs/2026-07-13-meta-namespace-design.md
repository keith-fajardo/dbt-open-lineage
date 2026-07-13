# Namespace extension-owned meta keys under `dbt_open_lineage`

## Problem

`yamlEdit.ts` (`packages/core`) writes the extension's own annotation data
directly into a dbt model's `config.meta` block as flat keys: `gist`,
`callout`, `subject_areas`, `labels`. This risks colliding with other
tooling that also writes into a model's `meta` (top-level or `config.meta`)
in the same dbt project — a real collision was hit in production (a separate
top-level `meta.fact_type` key on a model that also carried this extension's
`config.meta.gist`/`labels`, which caused a hard dbt parse error once both
existed on the same model at different nesting levels).

Namespacing everything this extension writes under a single
`config.meta.dbt_open_lineage` key removes that collision surface going
forward, without dbt itself caring — dbt merges `config.meta` into the
compiled manifest's `node.meta` as an arbitrary nested dict, so one extra
level of nesting is invisible to dbt's own schema handling.

## Scope

**In scope**: `packages/core` only — shared by both the VSCode extension and
the Mnemo `.mext`, so a single core change (plus `npm run rebuild`) reaches
both hosts. No host-bridge code touches meta shape.

- `packages/core/src/yamlEdit.ts` — write side
- `packages/core/src/meta.ts` (new) — read side helper
- `packages/core/src/App.tsx` (4 read sites: gist+callout in the initial-selection
  useEffect, and the same pair again in the Revert-button handler)
- `packages/core/src/zones.ts` (2 read sites: `subject_areas`, `labels`)
- `packages/core/src/CalloutOverlay.tsx` (2 read sites: `gist`, `callout`)

**Out of scope**:
- `lineage.yml` / `annotations.ts` (the project-level style sidecar) — a
  separate, already-dedicated file that only this extension writes to (color
  legend per subject-area/label key, not per-model membership data). No
  collision risk there; not touched.
- `config.tags` — dbt-native, unrelated to `config.meta`.
- Any migration script / bulk rewrite of existing project files.

## Design

### Which keys move

All four: `gist`, `callout`, `subject_areas`, `labels`. All are
extension-owned and share the same collision risk, so all move together
rather than namespacing only `gist`.

### Write side (`yamlEdit.ts`)

Every `doc.setIn` / `doc.hasIn` / `doc.deleteIn` path for these four keys
moves one level deeper:

```
["models", idx, "config", "meta", "gist"]
  -> ["models", idx, "config", "meta", "dbt_open_lineage", "gist"]
```

Same for `callout`, `subject_areas`, `labels`. `config.tags` is untouched.

All future writes go only to the nested shape. If a model already has an old
flat key (`config.meta.gist` etc.) from before this change, it is **left in
place, not deleted**, when the model is next edited through the extension —
the new nested key is written alongside it. The old flat key becomes dead
data (harmless, since reads always prefer the nested key when present) and
naturally goes stale/unused rather than being actively cleaned up. This is a
deliberate choice: no destructive rewrite of a user's YAML beyond the key
this extension is actively setting.

**Refinement — explicit clear/remove is the one exception.** "Leave legacy
alone" only holds for *adding or updating* a value. If the write call is an
explicit clear (gist set to `""`, callout set to `null`/`""`, or
subject_areas/labels set to `[]`) and the value being cleared currently lives
only at the legacy flat location, the legacy key is deleted as part of that
same write. Reasoning: `readMeta`'s fallback means an untouched stale flat
value stays visible after a "clear" — so "leave it alone" would silently make
clearing a no-op for any model not yet migrated to the nested shape. Every
other legacy key on that model (siblings not being cleared) is still left
fully untouched.

### Read side (`meta.ts`, new)

```ts
export function readMeta(meta: Record<string, unknown> | undefined, key: string): unknown {
  const ns = meta?.dbt_open_lineage as Record<string, unknown> | undefined;
  if (ns && key in ns) return ns[key];
  return meta?.[key]; // legacy flat fallback
}
```

Nested value wins when present; otherwise falls back to the old flat key so
existing production data (e.g. models already carrying flat
`config.meta.gist`/`labels`) keeps rendering with zero manual migration.
Returns `unknown` — callers keep doing their own type narrowing exactly as
today (e.g. `typeof readMeta(node.meta, "gist") === "string"`).

Call sites swap raw property access for `readMeta(node.meta, "<key>")`:

- `App.tsx:547`, `App.tsx:1256` — `gist`
- `zones.ts:9` — `subject_areas`; `zones.ts:16` — `labels`
- `CalloutOverlay.tsx:44` — `gist`; `CalloutOverlay.tsx:45` — `callout`

### Testing

- `yamlEdit.test.ts`: ~18 existing tests assert `doc.models[0].config.meta.gist`
  (and `.callout`/`.subject_areas`/`.labels`) directly — all updated to assert
  the nested path instead. Mechanical, but the bulk of the change's size.
- `meta.test.ts` (new): `readMeta` — nested-present, flat-only fallback,
  both-present prefers nested, neither-present returns `undefined`.
- `zones.test.ts` / `CalloutOverlay.test.tsx`: existing fixtures move to the
  nested shape; one fixture per file added in the legacy flat shape to prove
  the fallback path isn't broken.

## Non-goals

- No automatic rewrite/migration of existing sidecar or schema.yml files to
  the new nested shape. Migration happens organically as models are edited
  through the extension.
- No change to how dbt itself parses or merges `config.meta` — this is
  purely how this extension reads/writes within that existing mechanism.
