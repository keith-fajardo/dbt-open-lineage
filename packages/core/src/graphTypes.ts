export interface GraphNode {
  id: string;
  name: string;
  resource_type: string;
  layer: string;
  path: string;
  description: string;
  // Selector-method fields (optional: older cached graphs may lack them).
  tags?: string[];
  materialized?: string;
  meta?: Record<string, unknown>;
  /** Names of dbt tests attached to this node. */
  tests?: string[];
  /** Project-relative path of the schema .yml that patches this node
   * (description/meta live there), stripped of the manifest's `proj://`
   * prefix. Undefined when the node has no schema entry yet. */
  patch_path?: string;
}
export interface GraphEdge { from: string; to: string }

/** Project-wide resource inventory, counted from the full manifest (not just
 * the graph nodes — semantic models / metrics / exposures / tests are never
 * kept as DAG nodes). Optional: older cached graphs may lack it. */
export interface ResourceSummary {
  sources: number;
  models: number;
  snapshots: number;
  seeds: number;
  tests: number;
  semantic_models: number;
  metrics: number;
  exposures: number;
  /** Distinct tag names across the graph's model/seed/snapshot/source nodes. */
  tags: number;
}

export interface Graph { nodes: GraphNode[]; edges: GraphEdge[]; summary?: ResourceSummary }
