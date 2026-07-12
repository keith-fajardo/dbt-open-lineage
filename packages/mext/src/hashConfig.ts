/** Parse the extension iframe's URL hash into mount config. URLSearchParams
 * already percent-decodes, so values are used as-is (double-decoding throws
 * "URI malformed" on paths containing a literal %). */
export function readHashConfig(hash: string): { projectPath: string; initialSelector: string } {
  const p = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  return { projectPath: p.get("projectPath") ?? "", initialSelector: p.get("context") ?? "" };
}
