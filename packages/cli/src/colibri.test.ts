import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { runColibri } from "./colibri";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal() as typeof import("child_process");
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

const mockedSpawnSync = vi.mocked(spawnSync);

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "dol-colibri-test-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  vi.resetAllMocks();
});

describe("runColibri", () => {
  it("spawns colibri generate with --light and --disable-telemetry, and returns the extracted payload", () => {
    writeFileSync(join(workDir, "colibri-manifest.json"), JSON.stringify({
      nodes: { "model.a": { columns: { id: { columnName: "id", hasLineage: true, lineageType: "unknown" } } } },
      lineage: { edges: [{ id: 1, source: "model.a", target: "model.b", sourceColumn: "id", targetColumn: "id" }] },
    }));
    mockedSpawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "", error: undefined } as any);

    const result = runColibri({ manifestPath: "m.json", catalogPath: "c.json", workDir });

    expect(mockedSpawnSync).toHaveBeenCalledWith(
      "colibri",
      ["generate", "--manifest", "m.json", "--catalog", "c.json", "--output-dir", workDir, "--light", "--disable-telemetry"],
      { encoding: "utf8" },
    );
    expect(result.edges).toEqual([{ source: "model.a", target: "model.b", sourceColumn: "id", targetColumn: "id" }]);
  });

  it("throws a clear install-instruction error when colibri is not on PATH", () => {
    mockedSpawnSync.mockReturnValue({ error: new Error("spawn colibri ENOENT") } as any);
    expect(() => runColibri({ manifestPath: "m.json", catalogPath: "c.json", workDir }))
      .toThrow(/pip install dbt-colibri/);
  });

  it("throws wrapping stderr when colibri exits non-zero", () => {
    mockedSpawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "manifest not found at target/manifest.json", error: undefined } as any);
    expect(() => runColibri({ manifestPath: "m.json", catalogPath: "c.json", workDir }))
      .toThrow(/manifest not found at target\/manifest\.json/);
  });

  it("throws if colibri exits 0 but never wrote colibri-manifest.json", () => {
    mockedSpawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "", error: undefined } as any);
    expect(() => runColibri({ manifestPath: "m.json", catalogPath: "c.json", workDir }))
      .toThrow(/did not produce/);
  });
});
