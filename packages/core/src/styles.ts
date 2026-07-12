import { fallbackColor } from "./annotations";

export interface Style { name: string; color: string }

/** Resolve every key to a { name, color }. Keys present in `defs` use their
 * committed style; the rest get { name: key, color: fallbackColor(indexInKeys) }.
 * Callers pass one stable ordered `keys` list (e.g. the sorted union of all
 * area or all label keys), so a key's fallback color never depends on which
 * subset happens to be visible. */
export function resolveStyles(
  defs: Record<string, { name: string; color: string }>, keys: string[],
): Map<string, Style> {
  const out = new Map<string, Style>();
  keys.forEach((key, i) => {
    out.set(key, defs[key] ?? { name: key, color: fallbackColor(i) });
  });
  return out;
}
