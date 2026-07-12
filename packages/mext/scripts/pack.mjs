#!/usr/bin/env node
// Zips dist/ + manifest.json + icon.svg into dbt-dag-viz.mext (a plain zip;
// Mnemo's ExtensionHost unpacks it and reads manifest.json's "entry" path).
import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outFile = path.join(pkgRoot, "dbt-dag-viz.mext");

for (const required of ["dist/index.html", "manifest.json", "icon.svg"]) {
  if (!existsSync(path.join(pkgRoot, required))) {
    console.error(`pack: missing ${required} — run "npm run build" first`);
    process.exit(1);
  }
}

if (existsSync(outFile)) rmSync(outFile);

execSync(`zip -r -X "${outFile}" dist manifest.json icon.svg`, { cwd: pkgRoot, stdio: "inherit" });

console.log(`packed ${path.relative(process.cwd(), outFile)}`);
