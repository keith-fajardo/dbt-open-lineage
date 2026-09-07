import { existsSync } from "node:fs";
import { join } from "node:path";

/** Every platform the universal VSIX must carry an engine for. A universal
 * (no-target) build installs on any of these, and resolveBundledLineageEngine
 * picks bin/<platform>-<arch>/ at runtime — so all four must be present or that
 * platform installs fine yet throws when column lineage runs. */
export const REQUIRED_TARGETS = ["win32-x64", "linux-x64", "darwin-arm64", "darwin-x64"];

/** Path to the bundled engine for a target, mirroring the runtime resolver:
 * Windows carries lineage-engine.exe, every other platform lineage-engine. */
export function enginePathFor(root, target) {
  const executable = target.startsWith("win32-") ? "lineage-engine.exe" : "lineage-engine";
  return join(root, "bin", target, executable);
}

/** Assert every REQUIRED_TARGETS engine exists under <root>/bin, returning the
 * resolved paths. Throws listing all missing targets so an incomplete universal
 * package fails loudly at build time instead of silently at runtime. */
export function assertAllEnginesPresent(root, { existsFn = existsSync } = {}) {
  const paths = REQUIRED_TARGETS.map((target) => ({ target, path: enginePathFor(root, target) }));
  const missing = paths.filter(({ path }) => !existsFn(path));
  if (missing.length > 0) {
    const list = missing.map(({ target, path }) => `  - ${target}: ${path}`).join("\n");
    throw new Error(
      `Cannot build universal VSIX — missing bundled lineage engine(s):\n${list}\n` +
        `Each engine must be built on its own OS (PyInstaller cannot cross-compile) and ` +
        `downloaded into packages/vscode/bin/<target>/ before packaging.`,
    );
  }
  return paths.map(({ path }) => path);
}
