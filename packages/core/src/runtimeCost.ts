/** Per-model runtime and cost, read from `target/model_runtime_cost.json` — a
 * JSON array of `{ unique_id, runtime_seconds, cost_usd }` records. Anything
 * unreadable or off-shape degrades to "no data" (no badges), never an error:
 * the file is optional and written by tooling outside this project. */

/** Project-relative path, resolved by the host's `fs.readText`. */
export const RUNTIME_COST_PATH = "target/model_runtime_cost.json";

export interface RuntimeCost {
  runtimeSeconds?: number;
  costUsd?: number;
}

const usable = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Index records by unique_id. Later duplicates win; a record with neither a
 * usable runtime nor a usable cost is skipped. Non-JSON input (including the
 * static CLI bridge, which answers every read with the sidecar YAML) and
 * anything that isn't an array yield an empty map. */
export function parseRuntimeCost(text: string | null): Map<string, RuntimeCost> {
  const out = new Map<string, RuntimeCost>();
  if (!text) return out;
  let rows: unknown;
  try { rows = JSON.parse(text); } catch { return out; }
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.unique_id !== "string" || !r.unique_id) continue;
    const runtimeSeconds = usable(r.runtime_seconds) ? r.runtime_seconds : undefined;
    const costUsd = usable(r.cost_usd) ? r.cost_usd : undefined;
    if (runtimeSeconds === undefined && costUsd === undefined) continue;
    out.set(r.unique_id, { runtimeSeconds, costUsd });
  }
  return out;
}

/** Seconds, one decimal under 100 ("12.3s"), whole number from 100 ("126s"). */
export function formatRuntime(seconds: number): string {
  const tenth = Math.round(seconds * 10) / 10;
  return tenth < 100 ? `${tenth.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

const USD = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Dollars to the cent ("$0.04"); a real but sub-cent amount reads "<$0.01"
 * rather than rounding to a misleading "$0.00". */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.005) return "<$0.01";
  return `$${USD.format(usd)}`;
}
