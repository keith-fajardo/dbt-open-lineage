import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { generate } from "./generate";
import { runColibri } from "@dbt-open-lineage/colibri-runner";

vi.mock("@dbt-open-lineage/colibri-runner", () => ({ runColibri: vi.fn() }));
const mockedRunColibri = vi.mocked(runColibri);

let workDir: string;
let assetsDir: string;
let manifestPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "dol-cli-test-"));
  assetsDir = join(workDir, "fake-assets");
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, "main.js"), "// fake bundle");
  writeFileSync(join(assetsDir, "main.css"), "/* fake styles */");
  manifestPath = resolve(__dirname, "../test/fixtures/manifest.min.json");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  vi.resetAllMocks();
});

describe("generate", () => {
  it("writes index.html with the parsed graph embedded, plus the copied assets", () => {
    const outDir = join(workDir, "out");
    generate({ manifestPath, outDir, assetsDir });

    const html = readFileSync(join(outDir, "index.html"), "utf8");
    expect(html).toContain("window.__DOL_STATIC_DATA__=");
    expect(html).toContain("model.proj.stg_orders");
    expect(existsSync(join(outDir, "assets", "main.js"))).toBe(true);
    expect(existsSync(join(outDir, "assets", "main.css"))).toBe(true);
  });

  it("creates outDir if it doesn't exist", () => {
    const outDir = join(workDir, "nested", "does", "not", "exist");
    generate({ manifestPath, outDir, assetsDir });
    expect(existsSync(join(outDir, "index.html"))).toBe(true);
  });

  it("throws a clear error when the manifest doesn't exist", () => {
    expect(() => generate({ manifestPath: join(workDir, "nope.json"), outDir: join(workDir, "out"), assetsDir }))
      .toThrow(/manifest not found/i);
  });

  it("throws a clear, path-prefixed error on malformed manifest JSON", () => {
    const badManifest = join(workDir, "bad.json");
    writeFileSync(badManifest, "{not json");
    expect(() => generate({ manifestPath: badManifest, outDir: join(workDir, "out"), assetsDir }))
      .toThrow(new RegExp(badManifest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("embeds sidecar text when --sidecar is given and the file exists", () => {
    const sidecarPath = join(workDir, "lineage.yml");
    writeFileSync(sidecarPath, "subject_areas:\n  core: {}\n");
    const outDir = join(workDir, "out");
    generate({ manifestPath, outDir, assetsDir, sidecarPath });
    const html = readFileSync(join(outDir, "index.html"), "utf8");
    expect(html).toContain("subject_areas");
  });

  it("does not error when --sidecar is given but the file is missing (optional)", () => {
    const outDir = join(workDir, "out");
    expect(() => generate({ manifestPath, outDir, assetsDir, sidecarPath: join(workDir, "missing.yml") })).not.toThrow();
    const html = readFileSync(join(outDir, "index.html"), "utf8");
    expect(html).toContain('"sidecarText":null');
  });
});

describe("generate with --column-lineage", () => {
  it("calls runColibri and embeds its payload when columnLineage is true", () => {
    mockedRunColibri.mockReturnValue({
      nodes: { "model.proj.stg_orders": { columns: { id: { columnName: "id", hasLineage: true } } } },
      edges: [],
    });
    const outDir = join(workDir, "out");
    generate({ manifestPath, outDir, assetsDir, columnLineage: true, catalogPath: "catalog.json" });

    expect(mockedRunColibri).toHaveBeenCalledWith({ manifestPath, catalogPath: "catalog.json" });
    const html = readFileSync(join(outDir, "index.html"), "utf8");
    expect(html).toContain('"hasLineage":true');
  });

  it("throws when columnLineage is true but catalogPath is missing", () => {
    const outDir = join(workDir, "out");
    expect(() => generate({ manifestPath, outDir, assetsDir, columnLineage: true }))
      .toThrow(/--catalog is required/);
  });

  it("does not call runColibri when columnLineage is not set (default off)", () => {
    const outDir = join(workDir, "out");
    generate({ manifestPath, outDir, assetsDir });
    expect(mockedRunColibri).not.toHaveBeenCalled();
  });
});
