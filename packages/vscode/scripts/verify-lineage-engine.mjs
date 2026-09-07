import { accessSync, constants, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const target = `${process.platform}-${process.arch}`;
const executable = process.platform === "win32" ? "lineage-engine.exe" : "lineage-engine";
const engine = join(root, "bin", target, executable);

try {
  accessSync(engine, process.platform === "win32" ? constants.F_OK : constants.X_OK);
} catch {
  console.error(`Missing bundled lineage engine for ${target}. Run: npm run build:lineage -w packages/vscode`);
  process.exit(1);
}

// Keep accidental cross-platform packaging obvious: package.json's script
// asks vsce to mark this VSIX for exactly the binary it contains.
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
console.log(`Packaging ${pkg.name} ${pkg.version} with ${target} lineage engine`);
