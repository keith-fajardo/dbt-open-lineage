import * as fs from "fs";
import * as path from "path";
import { runColibri } from "@dbt-open-lineage/colibri-runner";
import type { ColumnLineagePayload } from "@dbt-open-lineage/core/src/columnLineage";

/** Resolve <root>/target/manifest.json and <root>/target/catalog.json,
 * throwing a clear, actionable error if either is missing, then delegate
 * to the shared colibri-runner package. Both files are dbt-colibri's own
 * requirement, not just this extension's — manifest comes from `dbt
 * compile` (already a one-click action in this extension), catalog comes
 * from `dbt docs generate` (not currently wired to anything here — the
 * error message tells the user the exact command to run manually). */
export function runColumnLineageForProject(root: string): ColumnLineagePayload {
  const manifestPath = path.join(root, "target", "manifest.json");
  const catalogPath = path.join(root, "target", "catalog.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`no manifest at ${manifestPath} — run \`dbt compile\``);
  if (!fs.existsSync(catalogPath)) throw new Error(`no catalog at ${catalogPath} — run \`dbt docs generate\``);
  return runColibri({ manifestPath, catalogPath });
}
