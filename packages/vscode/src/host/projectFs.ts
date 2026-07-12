import * as path from "path";

/** Resolve `rel` (a project-relative path from the webview) to an absolute
 * path guaranteed to sit inside `root`. Throws on any `..` escape or absolute
 * input — the webview must never reach outside the bound dbt project. */
export function resolveInProject(root: string, rel: string): string {
  if (path.isAbsolute(rel)) throw new Error("path escapes project");
  const abs = path.resolve(root, rel);
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) throw new Error("path escapes project");
  return abs;
}
