import { nodeLabels, nodeAreas } from "./zones";

export interface FilterOpts {
  favActive: boolean;
  favorites: Set<string>;
  labels: Set<string>;
  tags: Set<string>;
  areas: Set<string>;
}

/** Ids of nodes matching ALL active filter categories (favorites, subject
 * areas, labels, tags). Within a category the match is OR (any selected value).
 * Returns null when no category is active — the caller treats null as "no
 * filter, dim nothing". */
export function computeFiltered(
  nodes: { id: string; meta?: Record<string, unknown>; tags?: string[] }[], o: FilterOpts,
): Set<string> | null {
  if (!o.favActive && o.areas.size === 0 && o.labels.size === 0 && o.tags.size === 0) return null;
  const out = new Set<string>();
  for (const n of nodes) {
    if (o.favActive && !o.favorites.has(n.id)) continue;
    if (o.areas.size && !nodeAreas(n).some((a) => o.areas.has(a))) continue;
    if (o.labels.size && !nodeLabels(n).some((l) => o.labels.has(l))) continue;
    if (o.tags.size && !(n.tags ?? []).some((t) => o.tags.has(t))) continue;
    out.add(n.id);
  }
  return out;
}

/** The "currently active in the DAG" scope for the run/build/test button:
 * the union of the selector-matched and category-filtered sets. A plain
 * union — each channel contributes nothing when null. This is DELIBERATELY
 * NOT the same convention `filtered` itself uses for dimming (there, null
 * means "no restriction," i.e. everything counts). For a union, "channel
 * inactive" must mean "contributes nothing," or a blank selector would make
 * Run target the whole project even though the DAG renders nothing on
 * screen in that state. Callers must pass null for the selector channel
 * when the selector box is blank — see App.tsx. */
export function computeActiveIds(
  matched: Set<string> | null, filtered: Set<string> | null,
): Set<string> {
  const out = new Set<string>();
  if (matched) for (const id of matched) out.add(id);
  if (filtered) for (const id of filtered) out.add(id);
  return out;
}
