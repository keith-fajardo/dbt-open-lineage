import { parse, parseDocument } from "yaml";

export interface AreaStyle { name: string; color: string }
export interface LabelStyle { name: string; color: string }
export interface Annotations {
  areas: Record<string, AreaStyle>;
  labels: Record<string, LabelStyle>;
}

export const EMPTY_ANNOTATIONS: Annotations = { areas: {}, labels: {} };

/** Project-relative path of the committed style sidecar. */
export const SIDECAR_PATH = "lineage.yml";

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
  // `subject_areas` is the canonical key (matches the model's
  // config.meta.subject_areas); `areas` is still accepted as a legacy alias.
  const d = doc as { subject_areas?: unknown; areas?: unknown; labels?: unknown };
  return { areas: toStyleMap(d.subject_areas ?? d.areas), labels: toStyleMap(d.labels) };
}

/** Set the sidecar color for a style, preserving comments and formatting of
 * everything else (live-document edit, like yamlEdit). `kind` "areas" maps to
 * the canonical `subject_areas` yaml key. Seeds an empty
 * `subject_areas: {}\nlabels: {}` doc when the file does not exist yet. */
export function setSidecarColor(
  existingText: string | null, kind: "areas" | "labels", key: string, color: string,
): string {
  const yamlKey = kind === "areas" ? "subject_areas" : "labels";
  const base = existingText && existingText.trim() ? existingText : "subject_areas: {}\nlabels: {}\n";
  const doc = parseDocument(base);
  doc.setIn([yamlKey, key, "color"], color);
  return doc.toString({ lineWidth: 0 });
}
