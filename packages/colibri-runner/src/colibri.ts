import { spawn } from "child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
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
  /** Executable to spawn. Defaults to "colibri" resolved via PATH. Callers
   * that know a project venv's colibri exists should pass its absolute path
   * — PATH-based lookup is unreliable from a GUI-launched editor, whose
   * process env may not include a venv's bin dir. */
  binPath?: string;
  /** Restrict parsing and output to this exact visible graph node set. An
   * empty array intentionally produces an empty payload; undefined preserves
   * the legacy whole-manifest behaviour. */
  nodeIds?: string[];
}

/** Spawns dbt-colibri's `colibri generate` (PyPI package `dbt-colibri`,
 * binary name `colibri`), reads its colibri-manifest.json output, and
 * trims it via extractColumnLineage(). --light drops compiledCode (not
 * needed — colibri already resolved lineage, and it would bloat the
 * embedded static-bundle payload); --disable-telemetry avoids a network
 * call during a CI build. Uses async `spawn` (not `spawnSync`) — this
 * function is called from a live VSCode extension host, where a
 * synchronous child-process call would block the whole event loop for the
 * duration of the colibri run. */
export async function runColibri(opts: RunColibriOptions): Promise<ColumnLineagePayload> {
  const ownWorkDir = !opts.workDir;
  const workDir = opts.workDir ?? mkdtempSync(join(tmpdir(), "dol-colibri-"));
  try {
    const args = [
      "generate",
      "--manifest", opts.manifestPath,
      "--catalog", opts.catalogPath,
      "--output-dir", workDir,
    ];
    if (opts.nodeIds) {
      const nodeIdsPath = join(workDir, "selected-node-ids.json");
      writeFileSync(nodeIdsPath, JSON.stringify([...new Set(opts.nodeIds)].sort()), "utf8");
      args.push("--node-ids-file", nodeIdsPath);
    }
    args.push("--light", "--disable-telemetry");
    // Classify a spawn failure the same way whether it arrives as an async
    // 'error' event OR is thrown synchronously by spawn() (on Windows, spawn
    // throws synchronously — e.g. `spawn UNKNOWN` — rather than emitting
    // 'error'; an unguarded sync throw would otherwise leak that raw, contextless
    // message straight to the UI).
    const startupError = (error: Error): Error =>
      opts.binPath
        ? new Error(`column-lineage engine failed to start at ${opts.binPath}: ${error.message}`)
        : new Error("dbt-colibri (colibri) not found. Install with: pip install dbt-colibri");

    await new Promise<void>((resolvePromise, rejectPromise) => {
      let child;
      try {
        child = spawn(
          opts.binPath ?? "colibri",
          args,
          // Force UTF-8 for the child's stdout/stderr. colibri's CLI prints a
          // banner containing an emoji ("Welcome to dbt-colibri 🐦"); on Windows
          // Python defaults its console encoding to cp1252, which can't encode
          // it and crashes with UnicodeEncodeError before any work happens.
          // PYTHONIOENCODING + PYTHONUTF8 make Python use UTF-8 regardless.
          { env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } },
        );
      } catch (error) {
        rejectPromise(startupError(error as Error));
        return;
      }
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8").on("data", (d) => { stdout += d; });
      child.stderr?.setEncoding("utf8").on("data", (d) => { stderr += d; });
      child.on("error", (error) => { rejectPromise(startupError(error)); });
      child.on("close", (code) => {
        if (code !== 0) {
          rejectPromise(new Error(`colibri generate failed: ${stderr || stdout || "unknown error"}`));
          return;
        }
        resolvePromise();
      });
    });

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
