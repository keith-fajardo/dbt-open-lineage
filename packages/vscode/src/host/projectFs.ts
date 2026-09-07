import * as path from "path";

function pathApiFor(value: string): typeof path.posix | typeof path.win32 {
  return /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value) ? path.win32 : path.posix;
}

/** Resolve `rel` (a project-relative path from the webview) to an absolute
 * path guaranteed to sit inside `root`. Throws on any `..` escape or absolute
 * input — the webview must never reach outside the bound dbt project. */
export function resolveInProject(root: string, rel: string): string {
  const pathApi = pathApiFor(root);
  if (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel)) throw new Error("path escapes project");
  const abs = pathApi.resolve(root, rel);
  const rootAbs = pathApi.resolve(root);
  const samePath = pathApi === path.win32
    ? abs.toLowerCase() === rootAbs.toLowerCase()
    : abs === rootAbs;
  const isChild = pathApi === path.win32
    ? abs.toLowerCase().startsWith((rootAbs + pathApi.sep).toLowerCase())
    : abs.startsWith(rootAbs + pathApi.sep);
  if (!samePath && !isChild) throw new Error("path escapes project");
  return abs;
}
