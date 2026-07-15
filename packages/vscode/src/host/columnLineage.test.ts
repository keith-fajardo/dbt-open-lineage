import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runColumnLineageForProject } from "./columnLineage";
import { runColibri } from "@dbt-open-lineage/colibri-runner";

vi.mock("@dbt-open-lineage/colibri-runner", () => ({ runColibri: vi.fn() }));
const mockedRunColibri = vi.mocked(runColibri);

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dol-columnlineage-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.resetAllMocks();
});

describe("runColumnLineageForProject", () => {
  it("throws a clear error when manifest.json is missing", async () => {
    await expect(runColumnLineageForProject(dir)).rejects.toThrow(/no manifest at .*run `dbt compile`/);
    expect(mockedRunColibri).not.toHaveBeenCalled();
  });

  it("throws a clear error when catalog.json is missing (manifest present)", async () => {
    fs.mkdirSync(path.join(dir, "target"), { recursive: true });
    fs.writeFileSync(path.join(dir, "target", "manifest.json"), "{}");
    await expect(runColumnLineageForProject(dir)).rejects.toThrow(/no catalog at .*run `dbt docs generate`/);
    expect(mockedRunColibri).not.toHaveBeenCalled();
  });

  it("calls runColibri with the resolved manifest/catalog paths when both exist", async () => {
    fs.mkdirSync(path.join(dir, "target"), { recursive: true });
    fs.writeFileSync(path.join(dir, "target", "manifest.json"), "{}");
    fs.writeFileSync(path.join(dir, "target", "catalog.json"), "{}");
    mockedRunColibri.mockResolvedValue({ nodes: {}, edges: [] });

    const result = await runColumnLineageForProject(dir);

    expect(mockedRunColibri).toHaveBeenCalledWith({
      manifestPath: path.join(dir, "target", "manifest.json"),
      catalogPath: path.join(dir, "target", "catalog.json"),
    });
    expect(result).toEqual({ nodes: {}, edges: [] });
  });
});
