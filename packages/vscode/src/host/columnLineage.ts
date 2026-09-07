import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runColibri } from "@dbt-open-lineage/colibri-runner";
import type { ColumnLineagePayload } from "@dbt-open-lineage/core/src/columnLineage";
import { readStableJsonText } from "./stableArtifact";
import { spawnDbtToCompletion } from "./run";

export interface BundledEnginePlatform {
  platform?: NodeJS.Platform;
  arch?: string;
  exists?: (filePath: string) => boolean;
}

export interface ColumnLineageOptions {
  /** Exact node ids currently rendered in the lineage graph. Passed into the
   * bundled engine so hidden models are not parsed at all. */
  nodeIds?: string[];
  /** Name of a dbt profiles.yml target whose schema is dedicated to
   * disposable zero-row inspection relations. Empty disables warehouse
   * mutation and leaves unresolved models on inferred lineage. */
  inspectionTarget?: string;
  autoBuild?: boolean;
  /** Refresh information_schema through dbt docs generate into an isolated
   * target-path before comparing physical and compiled schemas. */
  refreshCatalog?: boolean;
  onLog?: (line: string) => void;
}

export const COLUMN_LINEAGE_ARTIFACT = "column-lineage.json";

function persistColumnLineage(root: string, payload: ColumnLineagePayload): string {
  const targetDir = path.join(root, "target");
  const outputPath = path.join(targetDir, COLUMN_LINEAGE_ARTIFACT);
  const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(targetDir, { recursive: true });
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, outputPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  return outputPath;
}

function inspectionSelector(manifestJson: string, nodeIds: string[]): string {
  const manifest = JSON.parse(manifestJson) as {
    nodes?: Record<string, { name?: string; fqn?: string[] }>;
  };
  return nodeIds.map((id) => {
    const node = manifest.nodes?.[id];
    // fqn is unambiguous across packages; fall back to the model name for
    // older/minimal manifests that omit it. Leading + includes all ancestors
    // needed to create a self-contained inspection DAG in the scratch target.
    const exact = node?.fqn?.length ? `fqn:${node.fqn.join(".")}` : (node?.name ?? id);
    return `+${exact}`;
  }).join(" ");
}

/** Locate the engine distributed inside this VSIX. Keeping the OS/CPU in the
 * directory name lets release builds publish a platform-specific extension
 * without asking users to install Python or dbt-colibri. */
export function resolveBundledLineageEngine(
  extensionRoot: string,
  opts: BundledEnginePlatform = {},
): string {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const executable = platform === "win32" ? "lineage-engine.exe" : "lineage-engine";
  const candidate = path.join(extensionRoot, "bin", `${platform}-${arch}`, executable);
  if (!(opts.exists ?? fs.existsSync)(candidate)) {
    throw new Error(
      `bundled column-lineage engine is unavailable for ${platform}-${arch}; reinstall the matching extension build`,
    );
  }
  return candidate;
}

/** Resolve <root>/target/manifest.json and <root>/target/catalog.json,
 * snapshot both only after they parse as complete JSON, then run the engine
 * shipped in the extension. The snapshots matter: dbt can rewrite a large
 * manifest between validation and the child process opening it otherwise. */
export async function runColumnLineageForProject(
  root: string,
  extensionRoot: string,
  opts: ColumnLineageOptions = {},
): Promise<ColumnLineagePayload> {
  const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "dol-artifacts-"));
  try {
    let manifestPath = path.join(root, "target", "manifest.json");
    let catalogPath = path.join(root, "target", "catalog.json");

    if (opts.refreshCatalog) {
      const currentTargetPath = path.join(snapshotDir, "current-target");
      opts.onLog?.("> dbt docs generate (refreshing warehouse column metadata)");
      const docsCode = await spawnDbtToCompletion(root, [
        "docs", "generate", "--target-path", currentTargetPath,
      ], opts.onLog ?? (() => {}));
      const refreshedManifest = path.join(currentTargetPath, "manifest.json");
      const refreshedCatalog = path.join(currentTargetPath, "catalog.json");
      if (docsCode === 0 && fs.existsSync(refreshedManifest) && fs.existsSync(refreshedCatalog)) {
        manifestPath = refreshedManifest;
        catalogPath = refreshedCatalog;
      } else {
        opts.onLog?.("Catalog refresh failed; falling back to existing target artifacts.");
      }
    }

    if (!fs.existsSync(manifestPath)) throw new Error(`no manifest at ${manifestPath} — run \`dbt compile\``);
    if (!fs.existsSync(catalogPath)) throw new Error(`no catalog at ${catalogPath} — run \`dbt docs generate\``);
    const binPath = resolveBundledLineageEngine(extensionRoot);
    const [manifestJson, catalogJson] = await Promise.all([
      readStableJsonText(manifestPath),
      readStableJsonText(catalogPath),
    ]);
    const snapshotManifest = path.join(snapshotDir, "manifest.json");
    const snapshotCatalog = path.join(snapshotDir, "catalog.json");
    fs.writeFileSync(snapshotManifest, manifestJson, "utf8");
    fs.writeFileSync(snapshotCatalog, catalogJson, "utf8");
    if (opts.nodeIds) {
      opts.onLog?.(`Column lineage scope: ${new Set(opts.nodeIds).size} visible node(s)`);
    }
    let payload = await runColibri({
      manifestPath: snapshotManifest,
      catalogPath: snapshotCatalog,
      binPath,
      nodeIds: opts.nodeIds,
    });

    const inspection = payload.inspection;
    const ephemeral = new Set(inspection?.ephemeral ?? []);
    const needsPhysicalInspection = [...new Set([
      ...(inspection?.missing ?? []),
      ...(inspection?.divergent ?? []),
      ...(inspection?.unknown ?? []),
    ])].filter((id) => !ephemeral.has(id));

    if (opts.autoBuild !== false && opts.inspectionTarget?.trim() && needsPhysicalInspection.length) {
      const target = opts.inspectionTarget.trim();
      const targetPath = path.join(snapshotDir, "inspection-target");
      const selector = inspectionSelector(manifestJson, needsPhysicalInspection);
      opts.onLog?.(`> dbt run --empty --select ${selector} --target ${target}`);
      const runCode = await spawnDbtToCompletion(root, [
        "run", "--empty", "--select", selector,
        "--target", target, "--target-path", targetPath,
      ], opts.onLog ?? (() => {}));
      if (runCode !== 0) throw new Error(`empty lineage inspection build failed (exit ${runCode})`);

      opts.onLog?.(`> dbt docs generate --target ${target}`);
      const docsCode = await spawnDbtToCompletion(root, [
        "docs", "generate", "--target", target, "--target-path", targetPath,
      ], opts.onLog ?? (() => {}));
      if (docsCode !== 0) throw new Error(`lineage inspection catalog generation failed (exit ${docsCode})`);

      const inspectedManifest = path.join(targetPath, "manifest.json");
      const inspectedCatalog = path.join(targetPath, "catalog.json");
      if (!fs.existsSync(inspectedManifest) || !fs.existsSync(inspectedCatalog)) {
        throw new Error(`dbt did not produce inspection artifacts in ${targetPath}`);
      }
      payload = await runColibri({
        manifestPath: inspectedManifest,
        catalogPath: inspectedCatalog,
        binPath,
        nodeIds: opts.nodeIds,
      });
    }

    const persistedPath = persistColumnLineage(root, payload);
    opts.onLog?.(`Column lineage artifact: ${persistedPath}`);
    return payload;
  } finally {
    fs.rmSync(snapshotDir, { recursive: true, force: true });
  }
}
