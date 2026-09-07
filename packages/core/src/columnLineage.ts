export interface ColumnEntry {
  columnName: string;
  hasLineage: boolean;
  lineageType?: string;
}

export interface ColumnLineageNode {
  columns: Record<string, ColumnEntry>;
}

export interface ColumnLineageEdge {
  source: string;
  target: string;
  sourceColumn: string;
  targetColumn: string;
}

export interface ColumnLineageInspection {
  /** Existing relation whose physical type and output-column set match the
   * current compiled SQL closely enough for column-lineage purposes. */
  current: string[];
  /** Existing relation whose physical type or output columns differ. */
  divergent: string[];
  /** Persistent model with no entry in catalog.json. */
  missing: string[];
  /** Persistent model whose projection could not be inferred safely. */
  unknown: string[];
  /** Virtual dbt nodes; inferred from SQL and never expected in the catalog. */
  ephemeral: string[];
}

export interface ColumnLineagePayload {
  nodes: Record<string, ColumnLineageNode>;
  edges: ColumnLineageEdge[];
  inspection?: ColumnLineageInspection;
}

interface RawColibriColumn {
  columnName: string;
  hasLineage?: boolean;
  lineageType?: string;
}

interface RawColibriNode {
  columns?: Record<string, RawColibriColumn>;
}

interface RawColibriEdge {
  source: string;
  target: string;
  sourceColumn: string;
  targetColumn: string;
  edgeType?: string;
}

interface RawColibriManifest {
  nodes?: Record<string, RawColibriNode>;
  lineage?: { edges?: RawColibriEdge[] };
  dbtOpenLineageInspection?: ColumnLineageInspection;
}

/** Trims dbt-colibri's colibri-manifest.json down to just what the DAG's
 * column-lineage toggle needs: per-node column resolution state, and real
 * column-to-column edges. Model-level dependency edges and structural
 * join/filter edges both use empty-string columns in colibri's output and
 * are excluded here — see
 * docs/superpowers/specs/2026-07-15-column-lineage-design.md §3. */
export function extractColumnLineage(raw: unknown): ColumnLineagePayload {
  const doc = (raw ?? {}) as RawColibriManifest;

  const nodes: Record<string, ColumnLineageNode> = {};
  for (const [nodeId, node] of Object.entries(doc.nodes ?? {})) {
    const columns: Record<string, ColumnEntry> = {};
    for (const [colName, col] of Object.entries(node.columns ?? {})) {
      columns[colName] = {
        columnName: col.columnName,
        hasLineage: col.hasLineage ?? false,
        ...(col.lineageType ? { lineageType: col.lineageType } : {}),
      };
    }
    nodes[nodeId] = { columns };
  }

  const edges: ColumnLineageEdge[] = (doc.lineage?.edges ?? [])
    .filter((e) => e.sourceColumn !== "" && e.targetColumn !== "" && !e.edgeType)
    .map((e) => ({ source: e.source, target: e.target, sourceColumn: e.sourceColumn, targetColumn: e.targetColumn }));

  return {
    nodes,
    edges,
    ...(doc.dbtOpenLineageInspection ? { inspection: doc.dbtOpenLineageInspection } : {}),
  };
}
