import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from "fs";
import { resolve } from "path";
import { parseManifest } from "@dbt-open-lineage/core/src/manifest";
import type { Graph } from "@dbt-open-lineage/core";
import { buildHtml } from "./template";

export interface GenerateOptions {
  manifestPath: string;
  outDir: string;
  assetsDir: string;
  sidecarPath?: string;
  title?: string;
}

export function generate(opts: GenerateOptions): void {
  if (!existsSync(opts.manifestPath)) {
    throw new Error(`manifest not found: ${opts.manifestPath}`);
  }
  const manifestJson = readFileSync(opts.manifestPath, "utf8");
  let graph: Graph;
  try {
    graph = parseManifest(manifestJson);
  } catch (e) {
    throw new Error(`failed to parse ${opts.manifestPath}: ${(e as Error).message}`);
  }

  const sidecarText = opts.sidecarPath && existsSync(opts.sidecarPath)
    ? readFileSync(opts.sidecarPath, "utf8")
    : null;

  mkdirSync(opts.outDir, { recursive: true });
  const html = buildHtml({ graph, sidecarText, title: opts.title });
  writeFileSync(resolve(opts.outDir, "index.html"), html, "utf8");
  cpSync(opts.assetsDir, resolve(opts.outDir, "assets"), { recursive: true });
}
