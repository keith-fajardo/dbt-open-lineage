import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { COLUMN_LINEAGE_ARTIFACT, resolveBundledLineageEngine, runColumnLineageForProject } from "./columnLineage";
import { runColibri } from "@dbt-open-lineage/colibri-runner";
import { spawnDbtToCompletion } from "./run";

vi.mock("@dbt-open-lineage/colibri-runner", () => ({ runColibri: vi.fn() }));
vi.mock("./run", () => ({ spawnDbtToCompletion: vi.fn() }));
const mockedRunColibri = vi.mocked(runColibri);
const mockedSpawnDbt = vi.mocked(spawnDbtToCompletion);

let dir: string;
let extensionDir: string;

function addBundledEngine(platform = process.platform, arch = process.arch): string {
  const filename = platform === "win32" ? "lineage-engine.exe" : "lineage-engine";
  const engine = path.join(extensionDir, "bin", `${platform}-${arch}`, filename);
  fs.mkdirSync(path.dirname(engine), { recursive: true });
  fs.writeFileSync(engine, "engine");
  return engine;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dol-columnlineage-"));
  extensionDir = fs.mkdtempSync(path.join(os.tmpdir(), "dol-extension-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(extensionDir, { recursive: true, force: true });
  vi.resetAllMocks();
});

describe("runColumnLineageForProject", () => {
  it("throws a clear error when manifest.json is missing", async () => {
    await expect(runColumnLineageForProject(dir, extensionDir)).rejects.toThrow(/no manifest at .*run `dbt compile`/);
    expect(mockedRunColibri).not.toHaveBeenCalled();
  });

  it("throws a clear error when catalog.json is missing (manifest present)", async () => {
    fs.mkdirSync(path.join(dir, "target"), { recursive: true });
    fs.writeFileSync(path.join(dir, "target", "manifest.json"), "{}");
    await expect(runColumnLineageForProject(dir, extensionDir)).rejects.toThrow(/no catalog at .*run `dbt docs generate`/);
    expect(mockedRunColibri).not.toHaveBeenCalled();
  });

  it("runs the bundled engine against stable manifest/catalog snapshots", async () => {
    fs.mkdirSync(path.join(dir, "target"), { recursive: true });
    fs.writeFileSync(path.join(dir, "target", "manifest.json"), "{}");
    fs.writeFileSync(path.join(dir, "target", "catalog.json"), "{}");
    const engine = addBundledEngine();
    mockedRunColibri.mockResolvedValue({ nodes: {}, edges: [] });

    const result = await runColumnLineageForProject(dir, extensionDir);

    expect(mockedRunColibri).toHaveBeenCalledOnce();
    const options = mockedRunColibri.mock.calls[0][0];
    expect(options.binPath).toBe(engine);
    expect(path.basename(options.manifestPath)).toBe("manifest.json");
    expect(path.basename(options.catalogPath)).toBe("catalog.json");
    expect(options.manifestPath).not.toBe(path.join(dir, "target", "manifest.json"));
    expect(result).toEqual({ nodes: {}, edges: [] });
    expect(JSON.parse(fs.readFileSync(path.join(dir, "target", COLUMN_LINEAGE_ARTIFACT), "utf8"))).toEqual(result);
  });

  it("scopes both lineage passes to the currently visible graph nodes", async () => {
    fs.mkdirSync(path.join(dir, "target"), { recursive: true });
    fs.writeFileSync(path.join(dir, "target", "manifest.json"), JSON.stringify({
      nodes: { "model.proj.a": { name: "a", fqn: ["proj", "a"] } },
    }));
    fs.writeFileSync(path.join(dir, "target", "catalog.json"), "{}");
    addBundledEngine();
    mockedRunColibri
      .mockResolvedValueOnce({
        nodes: {}, edges: [],
        inspection: { current: [], divergent: [], missing: ["model.proj.a"], unknown: [], ephemeral: [] },
      })
      .mockResolvedValueOnce({ nodes: {}, edges: [] });
    mockedSpawnDbt.mockImplementation(async (_root, args) => {
      if (args[0] === "docs") {
        const targetPath = args[args.indexOf("--target-path") + 1];
        fs.mkdirSync(targetPath, { recursive: true });
        fs.writeFileSync(path.join(targetPath, "manifest.json"), "{}");
        fs.writeFileSync(path.join(targetPath, "catalog.json"), "{}");
      }
      return 0;
    });

    await runColumnLineageForProject(dir, extensionDir, {
      nodeIds: ["source.proj.raw", "model.proj.a"],
      inspectionTarget: "lineage_inspection",
    });

    expect(mockedRunColibri).toHaveBeenCalledTimes(2);
    expect(mockedRunColibri.mock.calls[0][0].nodeIds).toEqual(["source.proj.raw", "model.proj.a"]);
    expect(mockedRunColibri.mock.calls[1][0].nodeIds).toEqual(["source.proj.raw", "model.proj.a"]);
  });

  it("fails clearly when this VSIX has no engine for the host platform", async () => {
    fs.mkdirSync(path.join(dir, "target"), { recursive: true });
    fs.writeFileSync(path.join(dir, "target", "manifest.json"), "{}");
    fs.writeFileSync(path.join(dir, "target", "catalog.json"), "{}");
    await expect(runColumnLineageForProject(dir, extensionDir)).rejects.toThrow(/reinstall the matching extension build/);
    expect(mockedRunColibri).not.toHaveBeenCalled();
  });

  it("maps Windows hosts to the packaged .exe", () => {
    const expected = path.join(extensionDir, "bin", "win32-x64", "lineage-engine.exe");
    expect(resolveBundledLineageEngine(extensionDir, {
      platform: "win32", arch: "x64", exists: (candidate) => candidate === expected,
    })).toBe(expected);
  });

  it("empty-builds missing persistent models only in the configured inspection target", async () => {
    fs.mkdirSync(path.join(dir, "target"), { recursive: true });
    fs.writeFileSync(path.join(dir, "target", "manifest.json"), JSON.stringify({
      nodes: { "model.proj.a": { name: "a", fqn: ["proj", "a"] } },
    }));
    fs.writeFileSync(path.join(dir, "target", "catalog.json"), "{}");
    addBundledEngine();
    mockedRunColibri
      .mockResolvedValueOnce({
        nodes: {}, edges: [],
        inspection: { current: [], divergent: [], missing: ["model.proj.a"], unknown: [], ephemeral: [] },
      })
      .mockResolvedValueOnce({ nodes: { "model.proj.a": { columns: {} } }, edges: [] });
    mockedSpawnDbt.mockImplementation(async (_root, args) => {
      if (args[0] === "docs") {
        const targetPath = args[args.indexOf("--target-path") + 1];
        fs.mkdirSync(targetPath, { recursive: true });
        fs.writeFileSync(path.join(targetPath, "manifest.json"), "{}");
        fs.writeFileSync(path.join(targetPath, "catalog.json"), "{}");
      }
      return 0;
    });

    const result = await runColumnLineageForProject(dir, extensionDir, {
      inspectionTarget: "lineage_inspection",
    });

    expect(mockedSpawnDbt).toHaveBeenCalledTimes(2);
    expect(mockedSpawnDbt.mock.calls[0][1]).toEqual([
      "run", "--empty", "--select", "+fqn:proj.a",
      "--target", "lineage_inspection", "--target-path", expect.any(String),
    ]);
    expect(mockedSpawnDbt.mock.calls[1][1]).toEqual([
      "docs", "generate", "--target", "lineage_inspection", "--target-path", expect.any(String),
    ]);
    expect(mockedRunColibri).toHaveBeenCalledTimes(2);
    expect(result.nodes).toHaveProperty("model.proj.a");
  });

  it("never materializes ephemeral nodes during inspection", async () => {
    fs.mkdirSync(path.join(dir, "target"), { recursive: true });
    fs.writeFileSync(path.join(dir, "target", "manifest.json"), "{}");
    fs.writeFileSync(path.join(dir, "target", "catalog.json"), "{}");
    addBundledEngine();
    mockedRunColibri.mockResolvedValue({
      nodes: {}, edges: [],
      inspection: {
        current: [], divergent: [], missing: [], unknown: ["model.proj.helper"],
        ephemeral: ["model.proj.helper"],
      },
    });

    await runColumnLineageForProject(dir, extensionDir, { inspectionTarget: "lineage_inspection" });

    expect(mockedSpawnDbt).not.toHaveBeenCalled();
  });

  it("does not mutate the warehouse when no inspection target is configured", async () => {
    fs.mkdirSync(path.join(dir, "target"), { recursive: true });
    fs.writeFileSync(path.join(dir, "target", "manifest.json"), "{}");
    fs.writeFileSync(path.join(dir, "target", "catalog.json"), "{}");
    addBundledEngine();
    mockedRunColibri.mockResolvedValue({
      nodes: {}, edges: [],
      inspection: { current: [], divergent: ["model.proj.a"], missing: [], unknown: [], ephemeral: [] },
    });

    await runColumnLineageForProject(dir, extensionDir);

    expect(mockedSpawnDbt).not.toHaveBeenCalled();
  });

  it("can refresh information-schema metadata into an isolated target path", async () => {
    addBundledEngine();
    mockedSpawnDbt.mockImplementation(async (_root, args) => {
      const targetPath = args[args.indexOf("--target-path") + 1];
      fs.mkdirSync(targetPath, { recursive: true });
      fs.writeFileSync(path.join(targetPath, "manifest.json"), "{}");
      fs.writeFileSync(path.join(targetPath, "catalog.json"), "{}");
      return 0;
    });
    mockedRunColibri.mockResolvedValue({ nodes: {}, edges: [] });

    await runColumnLineageForProject(dir, extensionDir, { refreshCatalog: true });

    expect(mockedSpawnDbt).toHaveBeenCalledWith(
      dir,
      ["docs", "generate", "--target-path", expect.any(String)],
      expect.any(Function),
    );
    // No project target/ artifacts existed, so reaching the engine proves the
    // refreshed pair was validated and snapshotted successfully.
    expect(mockedRunColibri).toHaveBeenCalledOnce();
  });
});
