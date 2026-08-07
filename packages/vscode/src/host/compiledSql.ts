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
 * makes VSCode infer SQL highlighting; the query carries the node id AND the
 * project root so Recompile can re-resolve both without touching
 * `activeTextEditor` — at recompile time the active editor IS this virtual
 * doc, and deriving root from ITS fsPath (as earlier code did) silently
 * resolves to "/", pointing dbt at the wrong cwd. */
export function compiledDocUri(name: string, uniqueId: string, root: string): string {
  const query = new URLSearchParams({ id: uniqueId, root });
  return `dbt-compiled:/${name}.sql?${query.toString()}`;
}

/** Inverse of compiledDocUri's query — pulls the node id + project root back
 * out of a compiled-doc uri's query string. */
export function parseCompiledDocQuery(query: string): { id: string; root: string } {
  const params = new URLSearchParams(query);
  return { id: params.get("id") ?? "", root: params.get("root") ?? "" };
}

export interface ModelSql { raw: string; compiled: string }

/** Pull both `raw_code` (source, Jinja intact) and `compiled_code` (rendered,
 * "" if never compiled) for one node from a manifest.json string. Throws when
 * the node id isn't in the manifest at all — same contract as
 * compiledCodeFromManifest. */
export function modelSqlFromManifest(manifestJson: string, uniqueId: string): ModelSql {
  const manifest = JSON.parse(manifestJson) as {
    nodes?: Record<string, { raw_code?: string; compiled_code?: string }>;
  };
  const node = manifest.nodes?.[uniqueId];
  if (!node) throw new Error(`no node ${uniqueId} in manifest`);
  return { raw: node.raw_code ?? "", compiled: node.compiled_code ?? "" };
}

/** Read <root>/target/manifest.json and return the node's raw + compiled SQL. */
export function readModelSql(root: string, uniqueId: string): ModelSql {
  const p = path.join(root, "target", "manifest.json");
  return modelSqlFromManifest(fs.readFileSync(p, "utf8"), uniqueId);
}

/** Find the analysis node (resource_type "analysis") whose original_file_path
 * matches `relPath` (project-relative, forward slashes). Analyses are NOT in
 * the DAG graph (parseManifest keeps only model/seed/snapshot/source), so the
 * compile commands resolve them straight off the manifest instead. Returns the
 * node's unique id + name, or null (no match / malformed json — never throws). */
export function analysisNodeFromManifest(manifestJson: string, relPath: string): { id: string; name: string } | null {
  let doc: { nodes?: Record<string, { resource_type?: string; name?: string; original_file_path?: string }> };
  try { doc = JSON.parse(manifestJson); } catch { return null; }
  for (const [id, n] of Object.entries(doc.nodes ?? {})) {
    if (n.resource_type === "analysis" && n.original_file_path === relPath) {
      return { id, name: n.name ?? "" };
    }
  }
  return null;
}
