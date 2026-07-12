import type { Graph } from "@dbt-open-lineage/core";
import { nodeIdForFile } from "./projectRoot";

/** The selector we push when the user focuses a model's .sql: light up its full
 * lineage (upstream + downstream) via the dbt "+name+" form. */
export function contextValueForEditor(graph: Graph, projectRoot: string, fileAbsPath: string): string | null {
  const name = nodeIdForFile(graph, projectRoot, fileAbsPath);
  return name ? `+${name}+` : null;
}
