import { existsSync, readFileSync } from "fs";
import { parseManifest } from "@dbt-open-lineage/core/src/manifest";
import type { Graph } from "@dbt-open-lineage/core";
import { traceColumn, columnTraceEdges, parseEndpointKey } from "@dbt-open-lineage/core/src/columnTrace";
import type { ColEndpoint } from "@dbt-open-lineage/core/src/columnTrace";
import { runColibri } from "@dbt-open-lineage/colibri-runner";
import type { ColumnLineageEdge, ColumnLineagePayload } from "@dbt-open-lineage/colibri-runner";

export interface TraceColumnOptions {
  manifestPath: string;
  catalogPath: string;
  column: string;
  /** dbt unique_id of the starting node, e.g. "model.proj.stg_orders". Takes
   * precedence over `model` when both are given. */
  node?: string;
  /** Friendly model/source/seed/snapshot name, resolved against the manifest.
   * Errors if zero or multiple nodes share the name (use `node` instead). */
  model?: string;
}

export interface TraceColumnResult {
  start: ColEndpoint;
  /** Every (node, column) the trace touches, including the start. Sorted for
   * stable output. */
  endpoints: ColEndpoint[];
  /** The subset of column-lineage edges whose both endpoints lie on the trace. */
  edges: ColumnLineageEdge[];
}

/** Resolves a friendly model name to its dbt unique_id via the manifest's
 * node names. Throws with the candidate unique_ids when the name is missing
 * or ambiguous (e.g. same model name in two packages). */
export function resolveNodeId(graph: Graph, model: string): string {
  const matches = graph.nodes.filter((n) => n.name === model);
  if (matches.length === 0) {
    throw new Error(`no node named "${model}" found in manifest`);
  }
  if (matches.length > 1) {
    const ids = matches.map((n) => n.id).join(", ");
    throw new Error(`"${model}" is ambiguous (${ids}) — pass --node with the exact unique_id instead`);
  }
  return matches[0].id;
}

export async function traceColumnCommand(opts: TraceColumnOptions): Promise<TraceColumnResult> {
  if (!existsSync(opts.manifestPath)) {
    throw new Error(`manifest not found: ${opts.manifestPath}`);
  }
  const manifestJson = readFileSync(opts.manifestPath, "utf8");
  let graph: Graph;
  try {
    graph = parseManifest(manifestJson);
  } catch (e) {
    throw new Error(`failed to parse ${opts.manifestPath}: ${(e as Error).message}`);
  }

  let nodeId = opts.node;
  if (!nodeId) {
    if (!opts.model) throw new Error("either --node or --model is required");
    nodeId = resolveNodeId(graph, opts.model);
  }

  const payload: ColumnLineagePayload = await runColibri({
    manifestPath: opts.manifestPath,
    catalogPath: opts.catalogPath,
  });

  const node = payload.nodes[nodeId];
  if (!node) {
    throw new Error(`no column-lineage data for node "${nodeId}" (unknown node, or dbt-colibri could not resolve it)`);
  }
  if (!node.columns[opts.column]) {
    const available = Object.keys(node.columns).sort().join(", ");
    throw new Error(`column "${opts.column}" not found on "${nodeId}". Available columns: ${available}`);
  }

  const start: ColEndpoint = { node: nodeId, column: opts.column };
  const traceSet = traceColumn(payload, start);
  const edges = columnTraceEdges(payload, traceSet);
  const endpoints = [...traceSet]
    .map(parseEndpointKey)
    .sort((a, b) => (a.node === b.node ? a.column.localeCompare(b.column) : a.node.localeCompare(b.node)));

  return { start, endpoints, edges };
}
