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

/** Breadth-first scan DOWN from each root for a dir containing dbt_project.yml,
 * bounded to `maxDepth` levels. Handles the "workspace opened at a parent folder
 * that holds the dbt project in a subfolder" case (e.g. GitHub/ → he-dbt-bi/),
 * which the upward walk alone can never reach. When several projects match,
 * prefer one that already has target/manifest.json (the compiled project the
 * user most likely means). A dir that IS a project is not descended into. */
function findProjectRootDown(
  roots: string[],
  exists: (p: string) => boolean,
  listDirs: (dir: string) => string[],
  maxDepth = 2,
): string | null {
  const matches: string[] = [];
  for (const root of roots) {
    let frontier = [root];
    for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
      const next: string[] = [];
      for (const dir of frontier) {
        for (const child of listDirs(dir)) {
          if (exists(path.join(child, "dbt_project.yml"))) matches.push(child);
          else next.push(child);
        }
      }
      frontier = next;
    }
  }
  const hasManifest = (d: string) => exists(path.join(d, "target", "manifest.json"));
  matches.sort((a, b) => Number(hasManifest(b)) - Number(hasManifest(a)));
  return matches[0] ?? null;
}

/** Resolve the dbt project root from editor + workspace state, without touching
 * the filesystem directly (`exists`/`listDirs` injected for testability).
 *
 * Order: (1) the active file's own project via upward walk — but only a real
 * `file:` doc; virtual/readonly docs (e.g. the `dbt-compiled:` preview) must be
 * gated out by the caller and passed as `undefined`, else their fabricated
 * fsPath resolves to a garbage root. (2) each workspace folder via upward walk.
 * (3) a bounded downward scan of the workspace folders.
 *
 * Returns undefined when no dbt_project.yml is found anywhere — deliberately NOT
 * a "best guess" start dir, so the caller surfaces a clean "no dbt project
 * found" instead of pointing dbt compile at a folder with no project. */
export function resolveProjectRoot(opts: {
  activeFileDir: string | undefined;
  workspaceFolders: string[];
  exists: (p: string) => boolean;
  listDirs: (dir: string) => string[];
}): string | undefined {
  const { activeFileDir, workspaceFolders, exists, listDirs } = opts;
  if (activeFileDir) {
    const up = findProjectRoot(activeFileDir, exists);
    if (up) return up;
  }
  for (const wf of workspaceFolders) {
    const up = findProjectRoot(wf, exists);
    if (up) return up;
  }
  return findProjectRootDown(workspaceFolders, exists, listDirs) ?? undefined;
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
