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

export interface CostSummary {
  /** Sum of the cost of every shown node that has a cost record. */
  total: number;
  /** Shown nodes with a cost record / all shown nodes — for a coverage hint. */
  withData: number;
  shown: number;
  /** Highest / lowest non-zero cost among shown nodes. Only set when at least
   * two nodes have a non-zero cost (one node would be both). Free ($0) models
   * add nothing to the total and are never named, so "cheapest" means the
   * cheapest model that actually costs something. */
  priciest?: { name: string; costUsd: number };
  cheapest?: { name: string; costUsd: number };
}

/** Cost rollup over the nodes currently shown; null when none has a cost
 * record. Ties on cost go to the alphabetically first name, so the panel
 * doesn't flicker between equal models across redraws. */
export function summarizeCost(
  nodes: Iterable<{ id: string; name: string }>,
  costs: Map<string, RuntimeCost>,
): CostSummary | null {
  let shown = 0, withData = 0, total = 0;
  const paid: { name: string; costUsd: number }[] = [];
  for (const n of nodes) {
    shown++;
    const costUsd = costs.get(n.id)?.costUsd;
    if (costUsd === undefined) continue;
    withData++;
    total += costUsd;
    if (costUsd > 0) paid.push({ name: n.name, costUsd });
  }
  if (withData === 0) return null;
  const summary: CostSummary = { total, withData, shown };
  if (paid.length >= 2) {
    const byCostThenName = (a: { name: string; costUsd: number }, b: { name: string; costUsd: number }) =>
      a.costUsd - b.costUsd || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const sorted = [...paid].sort(byCostThenName);
    summary.cheapest = sorted[0];
    // Highest cost, but still alphabetical among equals.
    const top = sorted[sorted.length - 1].costUsd;
    summary.priciest = sorted.find((p) => p.costUsd === top)!;
  }
  return summary;
}
