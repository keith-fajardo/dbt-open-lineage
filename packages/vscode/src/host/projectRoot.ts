import * as path from "path";
import type { Graph, GraphNode } from "@dbt-open-lineage/core";

function pathApiFor(value: string): typeof path.posix | typeof path.win32 {
  return /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value) ? path.win32 : path.posix;
}

/** Walk up from startDir until a dir contains dbt_project.yml. Pure: `exists`
 * is injected so this is unit-testable without touching the filesystem. */
export function findProjectRoot(startDir: string, exists: (p: string) => boolean): string | null {
  const pathApi = pathApiFor(startDir);
  let dir = startDir;
  for (;;) {
    if (exists(pathApi.join(dir, "dbt_project.yml"))) return dir;
    const parent = pathApi.dirname(dir);
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
        const pathApi = pathApiFor(dir);
        for (const child of listDirs(dir)) {
          if (exists(pathApi.join(child, "dbt_project.yml"))) matches.push(child);
          else next.push(child);
        }
      }
      frontier = next;
    }
  }
  const hasManifest = (d: string) => exists(pathApiFor(d).join(d, "target", "manifest.json"));
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

/** Return a dbt-style, project-relative path on every host OS.
 *
 * Choosing the path implementation from the input (rather than from the OS
 * running this function) also makes Windows paths deterministic in unit tests
 * running on macOS/Linux. It covers drive-letter and UNC paths; dbt manifest
 * paths always use `/` separators. */
export function projectRelativePath(projectRoot: string, fileAbsPath: string): string {
  const windowsPath = /^[a-z]:[\\/]/i.test(projectRoot) || /^\\\\/.test(projectRoot);
  const pathApi = windowsPath ? path.win32 : path.posix;
  return pathApi.relative(projectRoot, fileAbsPath).replace(/\\/g, "/");
}

/** Map an absolute file path to its graph node using the same normalization on
 * every feature that reacts to the active editor (lineage and Compile). */
export function nodeForFile(graph: Graph, projectRoot: string, fileAbsPath: string): GraphNode | null {
  const rel = projectRelativePath(projectRoot, fileAbsPath);
  const hit = graph.nodes.find((n) => n.path.replace(/\\/g, "/").replace(/^\.\//, "") === rel);
  return hit ?? null;
}

/** Map an absolute .sql path to its graph node NAME (for the context push). */
export function nodeIdForFile(graph: Graph, projectRoot: string, fileAbsPath: string): string | null {
  return nodeForFile(graph, projectRoot, fileAbsPath)?.name ?? null;
}
