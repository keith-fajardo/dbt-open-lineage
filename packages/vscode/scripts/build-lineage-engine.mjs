import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const target = `${process.platform}-${process.arch}`;
const outDir = join(root, "bin", target);
const workDir = mkdtempSync(join(tmpdir(), "dol-pyinstaller-"));
const python = process.env.LINEAGE_PYTHON || (process.platform === "win32" ? "python" : "python3");

mkdirSync(outDir, { recursive: true });

try {
  const result = spawnSync(python, [
    "-m", "PyInstaller",
    "--noconfirm",
    "--clean",
    "--onefile",
    "--name", "lineage-engine",
    "--distpath", outDir,
    "--workpath", join(workDir, "work"),
    "--specpath", join(workDir, "spec"),
    "--collect-submodules", "dbt_colibri",
    "--collect-submodules", "sqlglot",
    "--copy-metadata", "dbt-colibri",
    "--copy-metadata", "sqlglot",
    join(root, "python", "lineage_engine.py"),
  ], {
    cwd: root,
    stdio: "inherit",
    // Keep PyInstaller's mutable cache in the disposable build directory.
    // GUI/sandboxed build hosts may not be allowed to write its default
    // per-user Application Support/AppData location.
    env: { ...process.env, PYINSTALLER_CONFIG_DIR: join(workDir, "config") },
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (process.platform !== "win32") chmodSync(join(outDir, "lineage-engine"), 0o755);
  console.log(`Bundled lineage engine: bin/${target}/lineage-engine${process.platform === "win32" ? ".exe" : ""}`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
