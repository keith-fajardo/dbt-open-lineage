import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import { LineBuffer, parseDbtLogLine, mapNodeStatus, buildRunArgs, startDbtRun } from "./run";

describe("LineBuffer", () => {
  it("splits complete lines and carries a partial one across pushes", () => {
    const b = new LineBuffer();
    expect(b.push("a\nb\nc")).toEqual(["a", "b"]);
    expect(b.push("d\ne\n")).toEqual(["cd", "e"]);
    expect(b.flush()).toEqual([]);
  });

  it("flush returns a trailing partial line with no newline", () => {
    const b = new LineBuffer();
    b.push("partial");
    expect(b.flush()).toEqual(["partial"]);
    expect(b.flush()).toEqual([]); // draining is a one-shot
  });
});

describe("mapNodeStatus", () => {
  it("maps dbt's node_status values onto our 4-state Status", () => {
    expect(mapNodeStatus("started")).toBe("running");
    expect(mapNodeStatus("success")).toBe("success");
    expect(mapNodeStatus("passed")).toBe("success");
    expect(mapNodeStatus("pass")).toBe("success");
    expect(mapNodeStatus("reused")).toBe("success");
    expect(mapNodeStatus("error")).toBe("failed");
    expect(mapNodeStatus("failed")).toBe("failed");
    expect(mapNodeStatus("fail")).toBe("failed");
    expect(mapNodeStatus("skipped")).toBe("skipped");
  });

  it("unknown statuses map to null (no status event, but the line still displays)", () => {
    expect(mapNodeStatus("warn")).toBeNull();
    expect(mapNodeStatus("")).toBeNull();
  });
});

describe("parseDbtLogLine", () => {
  const nodeLine = (msg: string, node_status: string) => JSON.stringify({
    code: "Q011", level: "info", log_version: 3, msg,
    node_info: { unique_id: "model.proj.stg_orders", node_name: "stg_orders", node_status, resource_type: "model" },
    type: "log_line",
  });

  it("extracts the human-readable msg for display, and a status event from node_info", () => {
    const { event, display } = parseDbtLogLine(nodeLine("1 of 3 START sql table model main.stg_orders", "started"));
    expect(display).toBe("1 of 3 START sql table model main.stg_orders");
    expect(event).toEqual({ type: "status", nodeId: "model.proj.stg_orders", status: "running" });
  });

  it("finish line maps to success", () => {
    const { event } = parseDbtLogLine(nodeLine("1 of 3 OK created sql table model main.stg_orders", "success"));
    expect(event).toEqual({ type: "status", nodeId: "model.proj.stg_orders", status: "success" });
  });

  it("a line with no node_info displays but produces no status event", () => {
    const { event, display } = parseDbtLogLine(JSON.stringify({ msg: "Found 3 models", level: "info", type: "log_line" }));
    expect(display).toBe("Found 3 models");
    expect(event).toBeNull();
  });

  it("a malformed (non-JSON) line displays raw and produces no event, without throwing", () => {
    const { event, display } = parseDbtLogLine("not json at all {{{");
    expect(display).toBe("not json at all {{{");
    expect(event).toBeNull();
  });

  it("an empty line displays as-is with no event", () => {
    expect(parseDbtLogLine("")).toEqual({ event: null, display: "" });
  });
});

describe("buildRunArgs", () => {
  it("builds run/build/test argv with --log-format json", () => {
    expect(buildRunArgs("run", "stg_orders int_orders")).toEqual(
      ["run", "--select", "stg_orders int_orders", "--log-format", "json"],
    );
    expect(buildRunArgs("build", "x")).toEqual(["build", "--select", "x", "--log-format", "json"]);
    expect(buildRunArgs("test", "x")).toEqual(["test", "--select", "x", "--log-format", "json"]);
  });
});

// A minimal fake ChildProcess: an EventEmitter with stdout/stderr sub-emitters
// and a pid, enough to drive startDbtRun's wiring without a real process.
function fakeChild() {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = 4242;
  return proc;
}

describe("startDbtRun", () => {
  it("parses stdout lines into onWrite/onEvent calls, then emits done on close", () => {
    const proc = fakeChild();
    const spawnSpy = vi.fn(() => proc as unknown as ChildProcess);
    const written: string[] = [];
    const events: unknown[] = [];
    startDbtRun("/proj", "run", "stg_orders", { onWrite: (t) => written.push(t), onEvent: (e) => events.push(e) }, { spawn: spawnSpy });

    expect(spawnSpy).toHaveBeenCalledWith("/proj", ["run", "--select", "stg_orders", "--log-format", "json"]);

    const line = JSON.stringify({ msg: "1 of 1 START ...", node_info: { unique_id: "model.proj.stg_orders", node_status: "started" } });
    proc.stdout.emit("data", Buffer.from(line + "\n"));
    expect(written).toEqual(["1 of 1 START ...\r\n"]);
    expect(events).toEqual([{ type: "status", nodeId: "model.proj.stg_orders", status: "running" }]);

    proc.emit("close", 0);
    expect(events).toEqual([
      { type: "status", nodeId: "model.proj.stg_orders", status: "running" },
      { type: "done", exitCode: 0 },
    ]);
  });

  it("flushes a trailing partial line (no final newline) before emitting done", () => {
    const proc = fakeChild();
    const written: string[] = [];
    startDbtRun("/proj", "run", "x", { onWrite: (t) => written.push(t), onEvent: () => {} }, { spawn: () => proc as unknown as ChildProcess });
    proc.stdout.emit("data", Buffer.from("no trailing newline"));
    proc.emit("close", 0);
    expect(written).toEqual(["no trailing newline\r\n"]);
  });

  it("a spawn error is written to the terminal and closes the run with exit -1", () => {
    const proc = fakeChild();
    const written: string[] = [];
    const events: unknown[] = [];
    startDbtRun("/proj", "run", "x", { onWrite: (t) => written.push(t), onEvent: (e) => events.push(e) }, { spawn: () => proc as unknown as ChildProcess });
    proc.emit("error", new Error("ENOENT"));
    expect(written[0]).toContain("ENOENT");
    expect(events).toEqual([{ type: "done", exitCode: -1 }]);
  });

  it("emits exactly one done event when a spawn failure fires both 'error' and 'close' (real Node behavior)", () => {
    const proc = fakeChild();
    const written: string[] = [];
    const events: unknown[] = [];
    startDbtRun("/proj", "run", "x", { onWrite: (t) => written.push(t), onEvent: (e) => events.push(e) }, { spawn: () => proc as unknown as ChildProcess });
    proc.emit("error", new Error("ENOENT"));
    proc.emit("close", null);
    expect(events).toEqual([{ type: "done", exitCode: -1 }]);
  });

  it("cancel() sends SIGTERM to the process group (negative pid) on POSIX", () => {
    const proc = fakeChild();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const controller = startDbtRun("/proj", "run", "x", { onWrite: () => {}, onEvent: () => {} }, { spawn: () => proc as unknown as ChildProcess, platform: "darwin" });
    controller.cancel();
    expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
    killSpy.mockRestore();
  });
});
