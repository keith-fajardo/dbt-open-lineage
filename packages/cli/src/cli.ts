import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { realpathSync } from "fs";
import { generate } from "./generate";
import { traceColumnCommand } from "./traceColumn";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BOOLEAN_FLAGS = new Set(["column-lineage", "json"]);

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
  return [
    "Usage:",
    "  dbt-open-lineage generate --manifest <path> --out <dir> [--sidecar <path>] [--title <name>] [--catalog <path>] [--column-lineage]",
    "  dbt-open-lineage trace-column --manifest <path> --catalog <path> (--model <name> | --node <unique_id>) --column <name> [--json]",
  ].join("\n");
}

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  if (cmd === "generate") {
    if (!args.manifest || !args.out) {
      console.error("Error: --manifest and --out are required\n" + usage());
      process.exit(1);
    }
    try {
      await generate({
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
    return;
  }

  if (cmd === "trace-column") {
    if (!args.manifest || !args.catalog || !args.column || (!args.model && !args.node)) {
      console.error("Error: --manifest, --catalog, --column, and (--model or --node) are required\n" + usage());
      process.exit(1);
    }
    try {
      const result = await traceColumnCommand({
        manifestPath: args.manifest,
        catalogPath: args.catalog,
        column: args.column,
        model: args.model,
        node: args.node,
      });
      if (args.json === "true") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Trace: ${result.start.node}.${result.start.column}\n`);
        console.log(`Endpoints (${result.endpoints.length}):`);
        for (const ep of result.endpoints) {
          const marker = ep.node === result.start.node && ep.column === result.start.column ? "  (start)" : "";
          console.log(`  ${ep.node}.${ep.column}${marker}`);
        }
        console.log(`\nEdges (${result.edges.length}):`);
        for (const e of result.edges) {
          console.log(`  ${e.source}.${e.sourceColumn} -> ${e.target}.${e.targetColumn}`);
        }
      }
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      process.exit(1);
    }
    return;
  }

  console.error(usage());
  process.exit(1);
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
  void main(process.argv.slice(2));
}
