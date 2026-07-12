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
