import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { extractColumnLineage } from "@dbt-open-lineage/core/src/columnLineage";
import type { ColumnLineagePayload } from "@dbt-open-lineage/core/src/columnLineage";

export interface RunColibriOptions {
  manifestPath: string;
  catalogPath: string;
  /** Injectable for tests. Production code omits this — runColibri creates
   * a temp dir and cleans it up itself. */
  workDir?: string;
}

/** Spawns dbt-colibri's `colibri generate` (PyPI package `dbt-colibri`,
 * binary name `colibri`), reads its colibri-manifest.json output, and
 * trims it via extractColumnLineage(). --light drops compiledCode (not
 * needed — colibri already resolved lineage, and it would bloat the
 * embedded static-bundle payload); --disable-telemetry avoids a network
 * call during a CI build. */
export function runColibri(opts: RunColibriOptions): ColumnLineagePayload {
  const ownWorkDir = !opts.workDir;
  const workDir = opts.workDir ?? mkdtempSync(join(tmpdir(), "dol-colibri-"));
  try {
    const result = spawnSync(
      "colibri",
      [
        "generate",
        "--manifest", opts.manifestPath,
        "--catalog", opts.catalogPath,
        "--output-dir", workDir,
        "--light",
        "--disable-telemetry",
      ],
      { encoding: "utf8" },
    );

    if (result.error) {
      throw new Error("dbt-colibri (colibri) not found. Install with: pip install dbt-colibri");
    }
    if (result.status !== 0) {
      throw new Error(`colibri generate failed: ${result.stderr || result.stdout || "unknown error"}`);
    }

    const outputPath = join(workDir, "colibri-manifest.json");
    if (!existsSync(outputPath)) {
      throw new Error(`colibri did not produce ${outputPath}`);
    }
    const raw = JSON.parse(readFileSync(outputPath, "utf8"));
    return extractColumnLineage(raw);
  } finally {
    if (ownWorkDir) rmSync(workDir, { recursive: true, force: true });
  }
}
