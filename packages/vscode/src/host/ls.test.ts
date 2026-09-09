import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import { buildLsArgs, parseLsUniqueIds, runDbtLs } from "./ls";
import type { RunDeps } from "./run";

describe("buildLsArgs", () => {
  it("selects with --state and requests unique_id json output", () => {
    expect(buildLsArgs("state:modified+", "target/prod/")).toEqual([
      "ls", "--select", "state:modified+", "--state", "target/prod/",
      "--resource-type", "model", "snapshot", "seed", "source",
      "--output", "json", "--output-keys", "unique_id",
    ]);
  });

  it("splits an embedded --exclude into a discrete CLI arg", () => {
    expect(buildLsArgs("state:modified+ --exclude tag:wip", "target/prod/")).toEqual([
      "ls", "--select", "state:modified+", "--exclude", "tag:wip", "--state", "target/prod/",
      "--resource-type", "model", "snapshot", "seed", "source",
      "--output", "json", "--output-keys", "unique_id",
    ]);
  });

  it("unions multiple --exclude clauses into one --exclude arg", () => {
    const args = buildLsArgs("state:modified+ --exclude tag:wip --exclude tag:weekly", "d/");
    expect(args[args.indexOf("--select") + 1]).toBe("state:modified+");
    expect(args[args.indexOf("--exclude") + 1]).toBe("tag:wip tag:weekly");
  });

  it("drops a trailing/blank --exclude clause instead of emitting an empty --exclude arg", () => {
    expect(buildLsArgs("state:modified+ --exclude", "d/")).toEqual(
      buildLsArgs("state:modified+", "d/"),
    );
  });
});

describe("parseLsUniqueIds", () => {
  it("pulls unique_id from each json line", () => {
    expect(parseLsUniqueIds([
      '{"unique_id": "model.proj.a"}',
      '{"unique_id": "model.proj.b"}',
    ])).toEqual(["model.proj.a", "model.proj.b"]);
  });
  it("ignores blank and malformed lines without throwing", () => {
    expect(parseLsUniqueIds([
      "", "not json", '{"no_id": 1}', '{"unique_id": "model.proj.a"}',
    ])).toEqual(["model.proj.a"]);
  });
  it("accepts ANSI-colored JSON emitted by dbt on interactive Windows setups", () => {
    expect(parseLsUniqueIds([
      '\u001b[32m{"unique_id": "model.proj.a"}\u001b[0m',
    ])).toEqual(["model.proj.a"]);
  });
});

describe("runDbtLs", () => {
  it("spawns dbt ls and resolves the parsed unique_ids", async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const spawn = vi.fn(() => child as never);
    const deps: RunDeps = { spawn };

    const p = runDbtLs("/proj", "state:modified+", "target/prod/", deps);
    child.stdout.emit("data", Buffer.from('{"unique_id": "model.proj.a"}\n{"unique_id":'));
    child.stdout.emit("data", Buffer.from(' "model.proj.b"}\n'));
    child.emit("close", 0);

    expect(await p).toEqual(["model.proj.a", "model.proj.b"]);
    expect(spawn).toHaveBeenCalledWith("/proj", buildLsArgs("state:modified+", "target/prod/"));
  });

  it("rejects with the stderr tail on a non-zero exit", async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const deps: RunDeps = { spawn: vi.fn(() => child as never) };

    const p = runDbtLs("/proj", "state:modified+", "missing/", deps);
    child.stderr.emit("data", Buffer.from("Error: no manifest found in missing/\n"));
    child.emit("close", 2);

    await expect(p).rejects.toThrow(/no manifest found in missing\//);
  });

  it("falls back to dbt's stdout error when stderr is empty", async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const deps: RunDeps = { spawn: vi.fn(() => child as never) };

    const p = runDbtLs("C:/wrong", "state:modified+", "C:/proj/target/prod", deps);
    child.stdout.emit("data", Buffer.from(JSON.stringify({
      info: { msg: "No dbt_project.yml found at expected path C:/wrong/dbt_project.yml" },
    }) + "\n"));
    child.emit("close", 2);

    await expect(p).rejects.toThrow(/No dbt_project\.yml found.*C:\/wrong/);
  });

  it("times out and terminates a dbt process that never exits", async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      const p = runDbtLs("/proj", "state:modified+", "target/prod/", { spawn: vi.fn(() => child as never) }, 1000);
      vi.advanceTimersByTime(1000);
      await expect(p).rejects.toThrow(/timed out after 1 seconds/);
      expect(child.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("streams dbt output lines to the optional callback", async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const output: string[] = [];
    const p = runDbtLs("/proj", "state:modified+", "target/prod/", { spawn: vi.fn(() => child as never) }, 1000, (line) => output.push(line));
    child.stdout.emit("data", Buffer.from(JSON.stringify({ info: { msg: "Parsing project" } }) + "\n"));
    child.emit("close", 0);
    await expect(p).resolves.toEqual([]);
    expect(output).toEqual(["Parsing project"]);
  });
});
