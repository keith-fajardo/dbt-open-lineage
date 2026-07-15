# Selector parity, phase 1 — design

Date: 2026-07-15
Status: approved (brainstorming), pending implementation plan

## Scope

`packages/core/src/selector.ts` implements a deliberately-limited subset of
dbt's node-selector syntax. This is phase 1 of closing that gap, scoped to
the methods buildable on today's graph/manifest data with no new
subsystems: `path:`, `resource_type:`, `source:`, and the `@model`
indirect-ancestor operator.

Deferred to future, separate phases (each needs a new subsystem, not just a
selector-syntax extension): `exposure:` (exposures aren't parsed from the
manifest at all today), `test_type:`/`test_name:` (test nodes are collapsed
into a `tests: string[]` list on their parent model, not modeled as their
own resources), `state:` (needs a second/prior manifest to diff against —
no such mechanism exists), and YAML selector files/`--selector name`
(`selectors.yml` loading is a separate config-loading feature).

## 1. `matchCore` extensions (`packages/core/src/selector.ts`)

New branches in the existing method-dispatch chain inside `matchCore`,
following the same pattern as the existing `tag:`/`config.materialized:`
branches:

```ts
if (method === "resource_type")
  return adj.nodes.filter((n) => n.resource_type === value).map((n) => n.id);
if (method === "path")
  return adj.nodes
    .filter((n) => n.path === value || n.path.startsWith(value + "/"))
    .map((n) => n.id);
if (method === "source") {
  const dot = value.indexOf(".");
  if (dot < 0)
    return adj.nodes.filter((n) => n.source_name === value).map((n) => n.id);
  const [srcName, tableName] = [value.slice(0, dot), value.slice(dot + 1)];
  return adj.nodes
    .filter((n) => n.source_name === srcName && n.name === tableName)
    .map((n) => n.id);
}
```

- `resource_type:value` — values are `model`, `seed`, `snapshot`, `source`
  (the same set `manifest.ts`'s `KEEP` constant already restricts the graph
  to; other values simply match nothing, same as an unknown method).
- `path:value` — matches a node whose `path` (project-relative, forward-slash
  normalized — already the case for every path in the manifest) equals
  `value` exactly, or sits under it as a directory (`path` starts with
  `value + "/"`). Case-sensitive. No glob support — dbt's own `path:` is
  prefix matching, not glob matching.
- `source:value` — split `value` on the first `.`. No dot: match every
  source node whose `source_name` equals `value` (the whole source group).
  With a dot: match the one source node whose `source_name` + `name` equal
  the two parts.

## 2. `@model` operator

A new term-level prefix parsed *before* the existing `parseTerm` hop-count
regex, so `@stg_orders` is recognized as the `@` operator rather than
falling through to the `+`/bare-name path (`@` never appears in that
regex's alphabet today, so there's no ambiguity).

```ts
/** True if `raw` is an `@model`-operator term (dbt's indirect-ancestor
 * selector). No hop-count suffix is supported — matches real dbt. */
function isAtTerm(raw: string): boolean {
  return raw.startsWith("@") && raw.length > 1;
}

/** @model = model ∪ every descendant ∪ every ancestor of that descendant
 * set (not just of the focal model itself) — the model plus everything
 * needed to safely rebuild what depends on it. */
function matchAtTerm(adj: Adj, raw: string): Set<string> {
  const name = raw.slice(1);
  const out = new Set<string>();
  for (const id of matchCore(adj, name)) {
    out.add(id);
    const descendants = walk(id, adj.down, Infinity);
    for (const d of descendants) out.add(d);
    for (const d of [id, ...descendants]) {
      for (const a of walk(d, adj.up, Infinity)) out.add(a);
    }
  }
  return out;
}
```

`matchTerm` dispatches to `matchAtTerm` when `isAtTerm(raw)` is true, before
its existing `parseTerm` call. `@` terms compose with the existing
space-union / comma-intersection / `--exclude` machinery unchanged, since
they still resolve to a plain `Set<string>` of node ids like every other
term.

`focalName` (used to mark the DAG's "open" model) treats an `@` term as not
naming a single focal model, the same way it already treats method
selectors and multi-term expressions — returns `""` for any query starting
with `@`.

## 3. Data model (`packages/core/src/graphTypes.ts`, `packages/core/src/manifest.ts`)

`GraphNode` gains one new optional field:

```ts
/** Source-group name for a source node (e.g. "jaffle_shop" in
 * jaffle_shop.orders). Undefined for model/seed/snapshot nodes. */
source_name?: string;
```

`manifest.ts`'s `RawNode` interface gains `source_name?: string`, and
`collect()`'s node-construction sets `source_name: n.source_name` alongside
the other optional fields (undefined for non-source resource types, exactly
like `patch_path` is already optional today).

## Testing

- **`selector.test.ts`**:
  - `resource_type:model`, `resource_type:source` match the expected
    subsets; an unrecognized value matches nothing.
  - `path:models/staging` matches every node under that directory but not
    siblings; `path:models/staging/stg_orders.sql` matches only that exact
    file.
  - `source:jaffle_shop` matches every table under that source;
    `source:jaffle_shop.orders` matches only that one table; a source name
    with no matching nodes returns empty.
  - `@stg_orders` on a small fixture graph (`raw -> stg_orders -> dim_x`,
    `raw2 -> dim_x`) returns `{stg_orders, dim_x, raw, raw2}` — the model,
    its descendant, and the descendant's *other* ancestor (`raw2`), which
    plain `stg_orders+` would NOT include.
  - `@model` composes correctly with `--exclude` and with a second
    space-separated term (union).
  - `focalName("@stg_orders")` returns `""`.
- **`manifest.test.ts`**: a source node's `source_name` is captured on the
  parsed `GraphNode`; a model/seed/snapshot node's `source_name` is
  `undefined`.

## Documentation

Once implemented, extend the selection-methods table already added to
`packages/vscode/README.md`'s "dbt Selector Filtering" section with rows
for `path:`, `resource_type:`, `source:`, and `@model`.

## Out of scope

- `exposure:`, `test_type:`/`test_name:`, `state:`, YAML selector
  files/`--selector name` — each deferred to its own future
  brainstorm/spec/plan cycle per the phased-decomposition decision.
- Any change to how the DAG canvas renders — this phase only extends
  selector *matching*, not what resource types are graphed.
- `packages/vscode`/`packages/mext` host-bridge changes — core-only
  (selector logic is fully shared), matching how `grain` and prior selector
  work landed.
