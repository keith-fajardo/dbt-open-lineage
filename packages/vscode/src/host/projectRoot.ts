import * as path from "path";
import type { Graph } from "@dbt-open-lineage/core";

/** Walk up from startDir until a dir contains dbt_project.yml. Pure: `exists`
 * is injected so this is unit-testable without touching the filesystem. */
export function findProjectRoot(startDir: string, exists: (p: string) => boolean): string | null {
  let dir = startDir;
  for (;;) {
    if (exists(path.join(dir, "dbt_project.yml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Map an absolute .sql path to its graph node NAME (for the context push).
 * Normalize to forward slashes: dbt manifest `original_file_path` always uses
 * `/`, but path.relative yields `\` on Windows — without this the match (and
 * thus the active-editor context push) silently never fires on Windows. */
export function nodeIdForFile(graph: Graph, projectRoot: string, fileAbsPath: string): string | null {
  const rel = path.relative(projectRoot, fileAbsPath).split(path.sep).join("/");
  const hit = graph.nodes.find((n) => n.path === rel);
  return hit ? hit.name : null;
}
