import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { assertAllEnginesPresent } from "./lib/engine-targets.mjs";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// Fail loudly unless every platform's engine is present — a universal VSIX
// missing one installs everywhere but throws at runtime on that platform only.
assertAllEnginesPresent(root);

// Run vsce through node against its JS entry, not the .bin/vsce.cmd shim, so
// packaging works on Windows too (spawning a .cmd throws EINVAL on modern Node).
const cli = join(root, "..", "..", "node_modules", "@vscode", "vsce", "vsce");
const out = join(root, `${pkg.name}-${pkg.version}.vsix`);
console.log(`Packaging universal ${pkg.name} ${pkg.version} with all platform engines -> ${out}`);
const result = spawnSync(process.execPath, [cli, "package", "--no-dependencies", "--out", out], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
