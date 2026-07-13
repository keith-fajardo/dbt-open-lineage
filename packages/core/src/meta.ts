/** Read one of this extension's own keys (`gist`, `callout`, `subject_areas`,
 * `labels`) off a compiled node's `meta`. Prefers the namespaced
 * `meta.dbt_open_lineage.<key>` shape (see yamlEdit.ts's upsertModelDoc,
 * which only ever writes there); falls back to the pre-namespace flat
 * `meta.<key>` for models not yet re-saved through this extension. `key`
 * presence (not truthiness) decides which side wins, so an explicit nested
 * `""` still beats a non-empty legacy value. */
export function readMeta(meta: Record<string, unknown> | undefined, key: string): unknown {
  const ns = meta?.dbt_open_lineage as Record<string, unknown> | undefined;
  if (ns && key in ns) return ns[key];
  return meta?.[key];
}
