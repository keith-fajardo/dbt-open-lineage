import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { realpathSync } from "fs";
import { generate } from "./generate";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BOOLEAN_FLAGS = new Set(["column-lineage"]);

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) { out[key] = "true"; continue; }
      out[key] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function usage(): string {
  return "Usage: dbt-open-lineage generate --manifest <path> --out <dir> [--sidecar <path>] [--title <name>] [--catalog <path>] [--column-lineage]";
}

export function main(argv: string[]): void {
  const [cmd, ...rest] = argv;
  if (cmd !== "generate") {
    console.error(usage());
    process.exit(1);
  }
  const args = parseArgs(rest);
  if (!args.manifest || !args.out) {
    console.error("Error: --manifest and --out are required\n" + usage());
    process.exit(1);
  }
  try {
    generate({
      manifestPath: args.manifest,
      outDir: args.out,
      sidecarPath: args.sidecar,
      title: args.title,
      catalogPath: args.catalog,
      columnLineage: args["column-lineage"] === "true",
      // This is the one place the real build output is referenced by
      // build-relative path — see generate()'s GenerateOptions comment
      // in Task 5 for why generate() itself takes assetsDir as an input
      // instead of resolving it internally.
      assetsDir: resolve(__dirname, "../dist/webview/assets"),
    });
    console.log(`Generated static DAG viewer at ${resolve(args.out)}/index.html`);
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}

/** True when this module was executed directly as the entry script (not
 * imported, e.g. by cli.test.ts). import.meta.url is always the fully
 * resolved real path, but process.argv[1] is the path AS INVOKED — under
 * `npm link`, that's a symlink (e.g. /opt/homebrew/bin/dbt-open-lineage),
 * so comparing them raw never matches and main() silently never runs.
 * realpathSync resolves the symlink so both sides compare real paths. */
export function isMainModule(argv1: string, metaUrl: string): boolean {
  try {
    return metaUrl === `file://${realpathSync(argv1)}`;
  } catch {
    return false;
  }
}

if (isMainModule(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2));
}
