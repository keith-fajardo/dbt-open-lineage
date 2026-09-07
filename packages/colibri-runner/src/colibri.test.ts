import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import { runColibri } from "./colibri";

vi.mock("child_process", () => ({ spawn: vi.fn() }));

const mockedSpawn = vi.mocked(spawn);

/** A minimal fake ChildProcess: an EventEmitter with stdout/stderr as their
 * own EventEmitters, matching the shape runColibri() listens on. */
function fakeChild() {
  const child = new EventEmitter() as any;
  const stdout = new EventEmitter() as any;
  const stderr = new EventEmitter() as any;
  stdout.setEncoding = (enc: string) => stdout;
  stderr.setEncoding = (enc: string) => stderr;
  child.stdout = stdout;
  child.stderr = stderr;
  return child;
}

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "dol-colibri-test-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  vi.resetAllMocks();
});

describe("runColibri", () => {
  it("spawns colibri generate with --light and --disable-telemetry, and resolves the extracted payload", async () => {
    writeFileSync(join(workDir, "colibri-manifest.json"), JSON.stringify({
      nodes: { "model.a": { columns: { id: { columnName: "id", hasLineage: true, lineageType: "unknown" } } } },
      lineage: { edges: [{ id: 1, source: "model.a", target: "model.b", sourceColumn: "id", targetColumn: "id" }] },
    }));
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child);

    const resultPromise = runColibri({ manifestPath: "m.json", catalogPath: "c.json", workDir });
    child.emit("close", 0);
    const result = await resultPromise;

    expect(mockedSpawn).toHaveBeenCalledWith(
      "colibri",
      ["generate", "--manifest", "m.json", "--catalog", "c.json", "--output-dir", workDir, "--light", "--disable-telemetry"],
      // UTF-8 env so colibri's emoji banner doesn't crash Windows (cp1252).
      expect.objectContaining({ env: expect.objectContaining({ PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }) }),
    );
    expect(result.edges).toEqual([{ source: "model.a", target: "model.b", sourceColumn: "id", targetColumn: "id" }]);
  });

  it("spawns the given binPath instead of PATH-resolved colibri", async () => {
    writeFileSync(join(workDir, "colibri-manifest.json"), JSON.stringify({ nodes: {}, lineage: { edges: [] } }));
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child);

    const resultPromise = runColibri({
      manifestPath: "m.json", catalogPath: "c.json", workDir,
      binPath: "/proj/.venv/bin/colibri",
    });
    child.emit("close", 0);
    await resultPromise;

    expect(mockedSpawn).toHaveBeenCalledWith(
      "/proj/.venv/bin/colibri",
      ["generate", "--manifest", "m.json", "--catalog", "c.json", "--output-dir", workDir, "--light", "--disable-telemetry"],
      expect.objectContaining({ env: expect.objectContaining({ PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }) }),
    );
  });

  it("passes the visible graph node ids through a file so only that subgraph is parsed", async () => {
    writeFileSync(join(workDir, "colibri-manifest.json"), JSON.stringify({ nodes: {}, lineage: { edges: [] } }));
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child);

    const resultPromise = runColibri({
      manifestPath: "m.json", catalogPath: "c.json", workDir,
      nodeIds: ["model.proj.b", "model.proj.a", "model.proj.b"],
    });
    child.emit("close", 0);
    await resultPromise;

    const nodeIdsPath = join(workDir, "selected-node-ids.json");
    expect(JSON.parse(readFileSync(nodeIdsPath, "utf8"))).toEqual(["model.proj.a", "model.proj.b"]);
    expect(mockedSpawn.mock.calls[0][1]).toEqual([
      "generate", "--manifest", "m.json", "--catalog", "c.json", "--output-dir", workDir,
      "--node-ids-file", nodeIdsPath, "--light", "--disable-telemetry",
    ]);
  });

  it("rejects with a clear install-instruction error when colibri is not on PATH", async () => {
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child);

    const resultPromise = runColibri({ manifestPath: "m.json", catalogPath: "c.json", workDir });
    child.emit("error", new Error("spawn colibri ENOENT"));

    await expect(resultPromise).rejects.toThrow(/pip install dbt-colibri/);
  });

  it("reports a packaged engine startup failure without suggesting pip", async () => {
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child);

    const resultPromise = runColibri({
      manifestPath: "m.json", catalogPath: "c.json", workDir,
      binPath: "/extension/bin/darwin-arm64/lineage-engine",
    });
    child.emit("error", new Error("spawn EACCES"));

    await expect(resultPromise).rejects.toThrow(/column-lineage engine failed to start.*EACCES/);
    await expect(resultPromise).rejects.not.toThrow(/pip install/);
  });

  it("rejects wrapping stderr when colibri exits non-zero", async () => {
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child);

    const resultPromise = runColibri({ manifestPath: "m.json", catalogPath: "c.json", workDir });
    child.stderr.emit("data", "manifest not found at target/manifest.json");
    child.emit("close", 1);

    await expect(resultPromise).rejects.toThrow(/manifest not found at target\/manifest\.json/);
  });

  it("rejects if colibri exits 0 but never wrote colibri-manifest.json", async () => {
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child);

    const resultPromise = runColibri({ manifestPath: "m.json", catalogPath: "c.json", workDir });
    child.emit("close", 0);

    await expect(resultPromise).rejects.toThrow(/did not produce/);
  });
});
