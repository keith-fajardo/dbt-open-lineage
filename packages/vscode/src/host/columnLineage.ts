import * as fs from "fs";
import * as path from "path";
import { runColibri } from "@dbt-open-lineage/colibri-runner";
import type { ColumnLineagePayload } from "@dbt-open-lineage/core/src/columnLineage";

const VENV_COLIBRI_CANDIDATES = [".venv/bin/colibri", "venv/bin/colibri"];

/** dbt-colibri is almost always installed into a project venv, not
 * globally. A GUI-launched VSCode inherits its process env from the OS
 * (not an activated venv's shell), so a bare `spawn("colibri", ...)` can
 * resolve to the wrong binary or nothing at all even though `colibri` runs
 * fine from the user's own terminal. Check the workspace's own venv first
 * and pass its absolute path — bypasses PATH lookup entirely — falling
 * back to PATH resolution ("colibri" via undefined) if no venv is found. */
function resolveColibriBinPath(root: string): string | undefined {
  for (const candidate of VENV_COLIBRI_CANDIDATES) {
    const candidatePath = path.join(root, candidate);
    if (fs.existsSync(candidatePath)) return candidatePath;
  }
  return undefined;
}

/** Resolve <root>/target/manifest.json and <root>/target/catalog.json,
 * throwing a clear, actionable error if either is missing, then delegate
 * to the shared colibri-runner package. Both files are dbt-colibri's own
 * requirement, not just this extension's — manifest comes from `dbt
 * compile` (already a one-click action in this extension), catalog comes
 * from `dbt docs generate` (not currently wired to anything here — the
 * error message tells the user the exact command to run manually). Async
 * because runColibri() spawns a real subprocess non-blockingly — see
 * packages/colibri-runner's async migration. */
export async function runColumnLineageForProject(root: string): Promise<ColumnLineagePayload> {
  const manifestPath = path.join(root, "target", "manifest.json");
  const catalogPath = path.join(root, "target", "catalog.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`no manifest at ${manifestPath} — run \`dbt compile\``);
  if (!fs.existsSync(catalogPath)) throw new Error(`no catalog at ${catalogPath} — run \`dbt docs generate\``);
  const binPath = resolveColibriBinPath(root);
  return runColibri(binPath ? { manifestPath, catalogPath, binPath } : { manifestPath, catalogPath });
}
