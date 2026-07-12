import * as fs from "fs";
import * as path from "path";

export interface CompiledSql { sql: string; compiled: boolean }

/** Pull `compiled_code` for one node from a manifest.json string. `compiled`
 * is false when the node exists but was never compiled (empty/absent
 * compiled_code). Throws when the node id isn't in the manifest at all. */
export function compiledCodeFromManifest(manifestJson: string, uniqueId: string): CompiledSql {
  const manifest = JSON.parse(manifestJson) as {
    nodes?: Record<string, { compiled_code?: string }>;
  };
  const node = manifest.nodes?.[uniqueId];
  if (!node) throw new Error(`no node ${uniqueId} in manifest`);
  const sql = node.compiled_code ?? "";
  return { sql, compiled: sql.length > 0 };
}

/** Read <root>/target/manifest.json and return the node's compiled SQL. */
export function readCompiledSql(root: string, uniqueId: string): CompiledSql {
  const p = path.join(root, "target", "manifest.json");
  return compiledCodeFromManifest(fs.readFileSync(p, "utf8"), uniqueId);
}

/** The virtual-document URI string for a compiled model. The `.sql` suffix
 * makes VSCode infer SQL highlighting; the query carries the node id so
 * Recompile can re-resolve it. */
export function compiledDocUri(name: string, uniqueId: string): string {
  return `dbt-compiled:/${name}.sql?${encodeURIComponent(uniqueId)}`;
}
