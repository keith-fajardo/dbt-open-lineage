import { parse } from "yaml";

export interface AreaStyle { name: string; color: string }
export interface LabelStyle { name: string; color: string }
export interface Annotations {
  areas: Record<string, AreaStyle>;
  labels: Record<string, LabelStyle>;
}

export const EMPTY_ANNOTATIONS: Annotations = { areas: {}, labels: {} };

/** Project-relative path of the committed style sidecar. */
export const SIDECAR_PATH = "lineage.annotations.yml";

const PALETTE = [
  "#8b5cf6", "#14b8a6", "#6366f1", "#ef4444", "#22c55e",
  "#f59e0b", "#0ea5e9", "#ec4899", "#84cc16", "#f97316",
];

/** A stable fallback color for a style whose sidecar entry omits `color`. */
export function fallbackColor(index: number): string {
  return PALETTE[index % PALETTE.length];
}

function toStyleMap(raw: unknown): Record<string, AreaStyle> {
  const out: Record<string, AreaStyle> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  let i = 0;
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const v = (val && typeof val === "object" ? val : {}) as { name?: unknown; color?: unknown };
    out[key] = {
      name: typeof v.name === "string" ? v.name : key,
      color: typeof v.color === "string" ? v.color : fallbackColor(i),
    };
    i++;
  }
  return out;
}

/** Parse the style sidecar text. Tolerant: any shape that is not a map of
 * `{ name?, color? }` entries collapses to empty. */
export function parseAnnotations(text: string | null): Annotations {
  if (!text || !text.trim()) return EMPTY_ANNOTATIONS;
  let doc: unknown;
  try { doc = parse(text); } catch { return EMPTY_ANNOTATIONS; }
  if (!doc || typeof doc !== "object") return EMPTY_ANNOTATIONS;
  const d = doc as { areas?: unknown; labels?: unknown };
  return { areas: toStyleMap(d.areas), labels: toStyleMap(d.labels) };
}
