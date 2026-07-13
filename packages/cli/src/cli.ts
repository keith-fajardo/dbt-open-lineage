import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { generate } from "./generate";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { out[a.slice(2)] = argv[i + 1]; i++; }
  }
  return out;
}

function usage(): string {
  return "Usage: dbt-open-lineage generate --manifest <path> --out <dir> [--sidecar <path>] [--title <name>]";
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

// Only auto-run when executed as the bin script, not when imported by cli.test.ts.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
