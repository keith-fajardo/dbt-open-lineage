import type { Graph, GraphNode, GraphEdge } from "./graphTypes";

const KEEP = new Set(["model", "seed", "snapshot", "source"]);

function inferLayer(resourceType: string, path: string): string {
  if (resourceType === "source") return "source";
  const p = path.toLowerCase();
  if (p.includes("/staging/") || p.includes("stg_")) return "staging";
  if (p.includes("/intermediate/") || p.includes("int_")) return "intermediate";
  if (p.includes("/marts/") || p.includes("/mart/") || p.includes("mrt_")) return "mart";
  if (p.includes("/report") || p.includes("rpt_")) return "report";
  return resourceType;
}

interface RawNode {
  name?: string; resource_type?: string; original_file_path?: string;
  description?: string; tags?: string[]; attached_node?: string;
  config?: { materialized?: string; meta?: Record<string, unknown> };
  depends_on?: { nodes?: string[] };
  patch_path?: string;
}

export function parseManifest(json: string): Graph {
  let doc: { nodes?: Record<string, RawNode>; sources?: Record<string, RawNode>; child_map?: Record<string, string[]> };
  try { doc = JSON.parse(json); } catch (e) { throw new Error(`bad manifest json: ${e}`); }

  const kept = new Set<string>();
  const nodes: GraphNode[] = [];
  const testsByModel = new Map<string, string[]>();

  for (const [id, n] of Object.entries(doc.nodes ?? {})) {
    if (n.resource_type !== "test") continue;
    const target = n.attached_node ?? (n.depends_on?.nodes ?? []).find((d) => d.startsWith("model.") || d.startsWith("snapshot.") || d.startsWith("seed."));
    if (target && n.name) {
      if (!testsByModel.has(target)) testsByModel.set(target, []);
      testsByModel.get(target)!.push(n.name);
    }
  }

  const collect = (map: Record<string, RawNode>) => {
    for (const [id, n] of Object.entries(map)) {
      const rt = n.resource_type ?? "";
      if (!KEEP.has(rt)) continue;
      const path = n.original_file_path ?? "";
      nodes.push({
        id,
        name: n.name ?? "",
        resource_type: rt,
        layer: inferLayer(rt, path),
        path,
        description: n.description ?? "",
        tags: n.tags ?? [],
        materialized: n.config?.materialized,
        meta: n.config?.meta ?? {},
        tests: testsByModel.get(id) ?? [],
        patch_path: n.patch_path ? n.patch_path.split("://").pop() : undefined,
      });
      kept.add(id);
    }
  };
  collect(doc.nodes ?? {});
  collect(doc.sources ?? {});

  const edges: GraphEdge[] = [];
  const cm = doc.child_map ?? {};
  for (const from of Object.keys(cm).sort()) {
    if (!kept.has(from)) continue;
    for (const to of cm[from] ?? []) {
      if (kept.has(to)) edges.push({ from, to });
    }
  }

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  return { nodes, edges };
}
