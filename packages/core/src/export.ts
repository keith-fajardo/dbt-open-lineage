import type { Graph, GraphNode } from "./graphTypes";

/** The export scope: the nodes the current selector matches, plus the edges
 * that stay inside that set. */
export function exportScope(graph: Graph, matched: Set<string>): Graph {
  return {
    nodes: graph.nodes.filter((n) => matched.has(n.id)),
    edges: graph.edges.filter((e) => matched.has(e.from) && matched.has(e.to)),
  };
}

const csvCell = (v: string): string =>
  /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

/** One row per selected node: the "download the selection as a list" case. */
export function toCsv(nodes: GraphNode[]): string {
  const header = "name,resource_type,layer,materialized,tags,tests,path";
  const rows = nodes.map((n) => [
    n.name,
    n.resource_type,
    n.layer,
    n.materialized ?? "",
    (n.tags ?? []).join(";"),
    (n.tests ?? []).join(";"),
    n.path,
  ].map(csvCell).join(","));
  return [header, ...rows].join("\n") + "\n";
}

/** Mermaid flowchart of the selection. Node ids are sanitized (manifest ids
 * contain dots); labels carry the model names. */
export function toMermaid(g: Graph): string {
  const ref = new Map<string, string>();
  g.nodes.forEach((n, i) => ref.set(n.id, `n${i}`));
  const lines = ["graph LR"];
  for (const n of g.nodes) lines.push(`  ${ref.get(n.id)}["${n.name.replace(/"/g, "'")}"]`);
  for (const e of g.edges) {
    const from = ref.get(e.from);
    const to = ref.get(e.to);
    if (from && to) lines.push(`  ${from} --> ${to}`);
  }
  return lines.join("\n") + "\n";
}

/** UTF-8 → base64 (btoa alone mangles non-ASCII). */
export function b64encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
