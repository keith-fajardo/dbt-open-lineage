import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const target = `${process.platform}-${process.arch}`;
const cli = join(root, "..", "..", "node_modules", "@vscode", "vsce", "vsce");
const out = join(root, `${pkg.name}-${pkg.version}-${target}.vsix`);
const result = spawnSync(process.execPath, [cli, "package", "--no-dependencies", "--target", target, "--out", out], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
