import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import { LineBuffer, parseDbtLogLine, mapNodeStatus, buildRunArgs, startDbtRun, startDbtRunWithSeed } from "./run";

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
  // dbt's real --log-format json (dbt-core 1.11.11, verified against a live
  // run) wraps every line as {data: {...}, info: {...}} — NOT a flat object.
  // msg lives at info.msg (data.msg only exists for a handful of unrelated
  // event types and can't be relied on); node_info lives at data.node_info,
  // not top-level. Getting this nesting wrong means EVERY line falls back to
  // raw-JSON display and ZERO status events ever fire — exactly the bug this
  // fixture guards against.
  const nodeLine = (msg: string, node_status: string) => JSON.stringify({
    data: {
      node_info: { unique_id: "model.proj.stg_orders", node_name: "stg_orders", node_status, resource_type: "model" },
    },
    info: { code: "Q011", level: "info", msg, name: "LogStartLine" },
  });

  it("extracts the human-readable info.msg for display, and a status event from data.node_info", () => {
    const { event, display } = parseDbtLogLine(nodeLine("1 of 3 START sql table model main.stg_orders", "started"));
    expect(display).toBe("1 of 3 START sql table model main.stg_orders");
    expect(event).toEqual({ type: "status", nodeId: "model.proj.stg_orders", status: "running" });
  });

  it("finish line maps to success", () => {
    const { event } = parseDbtLogLine(nodeLine("1 of 3 OK created sql table model main.stg_orders", "success"));
    expect(event).toEqual({ type: "status", nodeId: "model.proj.stg_orders", status: "success" });
  });

  it("a line with no node_info displays but produces no status event", () => {
    const { event, display } = parseDbtLogLine(JSON.stringify({ data: {}, info: { msg: "Found 3 models", level: "info" } }));
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

  // Real lines captured 2026-07-14 from `dbt run --select
  // rpt_unearned_journals_reconciliation --log-format json` against
  // dbt-core=1.11.11, adapter redshift=1.10.1 — the exact schema that
  // exposed the bug above, kept verbatim as a regression fixture.
  const REAL_START_LINE = '{"data": {"description": "sql table model dbt_kfajardo_marts.rpt_unearned_journals_reconciliation", "index": 1, "node_info": {"materialized": "table", "meta": {}, "node_checksum": "ba4cc22d7446229ebedd18486b37bf766924863e9a3868b7c4fe3bebd5274e29", "node_finished_at": "", "node_name": "rpt_unearned_journals_reconciliation", "node_path": "marts/presentation/finance/rpt_unearned_journals_reconciliation.sql", "node_relation": {"alias": "rpt_unearned_journals_reconciliation", "database": "testred", "relation_name": "testred.dbt_kfajardo_marts.rpt_unearned_journals_reconciliation", "schema": "dbt_kfajardo_marts"}, "node_started_at": "2026-07-14T16:30:18.309729", "node_status": "started", "resource_type": "model", "unique_id": "model.he_dbt_bi.rpt_unearned_journals_reconciliation"}, "total": 1}, "info": {"category": "", "code": "Q011", "extra": {}, "invocation_id": "a7981581-12ff-4d3e-b97a-f8e6edeab71d", "level": "info", "msg": "1 of 1 START sql table model dbt_kfajardo_marts.rpt_unearned_journals_reconciliation  [RUN]", "name": "LogStartLine", "pid": 25507, "thread": "Thread-1 (worker)", "ts": "2026-07-14T16:30:18.310277Z"}}';
  const REAL_SUCCESS_LINE = '{"data": {"description": "sql table model dbt_kfajardo_marts.rpt_unearned_journals_reconciliation", "execution_time": 7.043135, "index": 1, "node_info": {"materialized": "table", "meta": {}, "node_checksum": "ba4cc22d7446229ebedd18486b37bf766924863e9a3868b7c4fe3bebd5274e29", "node_finished_at": "2026-07-14T16:30:25.353697", "node_name": "rpt_unearned_journals_reconciliation", "node_path": "marts/presentation/finance/rpt_unearned_journals_reconciliation.sql", "node_relation": {"alias": "rpt_unearned_journals_reconciliation", "database": "testred", "relation_name": "testred.dbt_kfajardo_marts.rpt_unearned_journals_reconciliation", "schema": "dbt_kfajardo_marts"}, "node_started_at": "2026-07-14T16:30:18.309729", "node_status": "success", "resource_type": "model", "unique_id": "model.he_dbt_bi.rpt_unearned_journals_reconciliation"}, "status": "SUCCESS", "total": 1}, "info": {"category": "", "code": "Q012", "extra": {}, "invocation_id": "a7981581-12ff-4d3e-b97a-f8e6edeab71d", "level": "info", "msg": "1 of 1 OK created sql table model dbt_kfajardo_marts.rpt_unearned_journals_reconciliation  [SUCCESS in 7.04s]", "name": "LogModelResult", "pid": 25507, "thread": "Thread-1 (worker)", "ts": "2026-07-14T16:30:25.354735Z"}}';
  const REAL_FORMATTING_LINE = '{"data": {"msg": ""}, "info": {"category": "", "code": "Z017", "extra": {}, "invocation_id": "a7981581-12ff-4d3e-b97a-f8e6edeab71d", "level": "info", "msg": "", "name": "Formatting", "pid": 25507, "thread": "MainThread", "ts": "2026-07-14T16:30:09.076698Z"}}';

  it("real dbt 1.11.11 START line: displays the human msg and emits a running status", () => {
    const { event, display } = parseDbtLogLine(REAL_START_LINE);
    expect(display).toBe("1 of 1 START sql table model dbt_kfajardo_marts.rpt_unearned_journals_reconciliation  [RUN]");
    expect(event).toEqual({
      type: "status",
      nodeId: "model.he_dbt_bi.rpt_unearned_journals_reconciliation",
      status: "running",
    });
  });

  it("real dbt 1.11.11 SUCCESS line: displays the human msg and emits a success status", () => {
    const { event, display } = parseDbtLogLine(REAL_SUCCESS_LINE);
    expect(display).toBe("1 of 1 OK created sql table model dbt_kfajardo_marts.rpt_unearned_journals_reconciliation  [SUCCESS in 7.04s]");
    expect(event).toEqual({
      type: "status",
      nodeId: "model.he_dbt_bi.rpt_unearned_journals_reconciliation",
      status: "success",
    });
  });

  it("real dbt 1.11.11 blank formatting line: displays empty string, no event", () => {
    expect(parseDbtLogLine(REAL_FORMATTING_LINE)).toEqual({ event: null, display: "" });
  });

  // Real `dbt test --select int_invoices_with_invoice_lines --log-format
  // json` lines, captured 2026-07-14. A test's START event has no
  // attached_node (dbt doesn't say which model a just-started test belongs
  // to yet) — this is what originally caused test runs to show no status at
  // all, since the test's own unique_id never matches a DAG node.
  const REAL_TEST_START_LINE = '{"data": {"description": "test accepted_values_int_invoices_with_invoice_lines_invoice_source__chikpea__netsuite", "index": 1, "node_info": {"materialized": "test", "meta": {}, "node_checksum": "", "node_finished_at": "", "node_name": "accepted_values_int_invoices_with_invoice_lines_invoice_source__chikpea__netsuite", "node_path": "accepted_values_int_invoices_w_64a99420782d01b20a91c2230f4b3aec.sql", "node_relation": {"alias": "accepted_values_int_invoices_w_64a99420782d01b20a91c2230f4b3aec", "database": "testred", "relation_name": "", "schema": "dbt_kfajardo_dbt_test__audit"}, "node_started_at": "2026-07-14T17:30:50.933608", "node_status": "started", "resource_type": "test", "unique_id": "test.he_dbt_bi.accepted_values_int_invoices_with_invoice_lines_invoice_source__chikpea__netsuite.836aaa3c7c"}, "total": 2}, "info": {"category": "", "code": "Q011", "extra": {}, "invocation_id": "921e2394-7259-4fee-8376-937939e6ee27", "level": "info", "msg": "1 of 2 START test accepted_values_int_invoices_with_invoice_lines_invoice_source__chikpea__netsuite  [RUN]", "name": "LogStartLine", "pid": 89316, "thread": "Thread-1 (worker)", "ts": "2026-07-14T17:30:50.935312Z"}}';
  const REAL_TEST_PASS_LINE = '{"data": {"attached_node": "model.he_dbt_bi.int_invoices_with_invoice_lines", "execution_time": 3.1510031, "index": 1, "name": "accepted_values_int_invoices_with_invoice_lines_invoice_source__chikpea__netsuite", "node_info": {"materialized": "test", "meta": {}, "node_checksum": "", "node_finished_at": "2026-07-14T17:30:54.087596", "node_name": "accepted_values_int_invoices_with_invoice_lines_invoice_source__chikpea__netsuite", "node_path": "accepted_values_int_invoices_w_64a99420782d01b20a91c2230f4b3aec.sql", "node_relation": {"alias": "accepted_values_int_invoices_w_64a99420782d01b20a91c2230f4b3aec", "database": "testred", "relation_name": "", "schema": "dbt_kfajardo_dbt_test__audit"}, "node_started_at": "2026-07-14T17:30:50.933608", "node_status": "pass", "resource_type": "test", "unique_id": "test.he_dbt_bi.accepted_values_int_invoices_with_invoice_lines_invoice_source__chikpea__netsuite.836aaa3c7c"}, "num_failures": 0, "num_models": 2, "status": "pass"}, "info": {"category": "", "code": "Q007", "extra": {}, "invocation_id": "921e2394-7259-4fee-8376-937939e6ee27", "level": "info", "msg": "1 of 2 PASS accepted_values_int_invoices_with_invoice_lines_invoice_source__chikpea__netsuite  [PASS in 3.15s]", "name": "LogTestResult", "pid": 89316, "thread": "Thread-1 (worker)", "ts": "2026-07-14T17:30:54.087993Z"}}';

  it("real dbt 1.11.11 test START line: displays the human msg but emits NO status event (no attached_node yet)", () => {
    const { event, display } = parseDbtLogLine(REAL_TEST_START_LINE);
    expect(display).toBe("1 of 2 START test accepted_values_int_invoices_with_invoice_lines_invoice_source__chikpea__netsuite  [RUN]");
    expect(event).toBeNull();
  });

  it("real dbt 1.11.11 test PASS line: routes the status to the parent model via attached_node, not the test's own unique_id", () => {
    const { event, display } = parseDbtLogLine(REAL_TEST_PASS_LINE);
    expect(display).toBe("1 of 2 PASS accepted_values_int_invoices_with_invoice_lines_invoice_source__chikpea__netsuite  [PASS in 3.15s]");
    expect(event).toEqual({
      type: "status",
      nodeId: "model.he_dbt_bi.int_invoices_with_invoice_lines",
      status: "success",
    });
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
// Optional pid override lets a test distinguish two concurrent-in-sequence
// fake processes (e.g. a seed phase's process vs the main command's).
function fakeChild(pid = 4242) {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = pid;
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

    const line = JSON.stringify({
      data: { node_info: { unique_id: "model.proj.stg_orders", node_status: "started" } },
      info: { msg: "1 of 1 START ..." },
    });
    proc.stdout.emit("data", Buffer.from(line + "\n"));
    expect(written).toEqual(["1 of 1 START ..."]);
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
    expect(written).toEqual(["no trailing newline"]);
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

describe("startDbtRunWithSeed", () => {
  it("hasSeed=false bypasses straight to a single-phase run (no seed invocation)", () => {
    const proc = fakeChild();
    const spawnSpy = vi.fn(() => proc as unknown as ChildProcess);
    const events: unknown[] = [];
    startDbtRunWithSeed(
      "/proj", "run", "stg_orders", false,
      { onWrite: () => {}, onEvent: (e) => events.push(e) },
      { spawn: spawnSpy },
    );
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy).toHaveBeenCalledWith("/proj", ["run", "--select", "stg_orders", "--log-format", "json"]);
    proc.emit("close", 0);
    expect(events).toEqual([{ type: "done", exitCode: 0 }]);
  });

  it("hasSeed=true runs `dbt seed` first, then the main command, on one continuous event/write stream", () => {
    const seedProc = fakeChild(1111);
    const mainProc = fakeChild(2222);
    let call = 0;
    const spawnSpy = vi.fn(() => (call++ === 0 ? seedProc : mainProc) as unknown as ChildProcess);
    const written: string[] = [];
    const events: unknown[] = [];
    startDbtRunWithSeed(
      "/proj", "run", "stg_orders", true,
      { onWrite: (t) => written.push(t), onEvent: (e) => events.push(e) },
      { spawn: spawnSpy },
    );

    expect(spawnSpy).toHaveBeenNthCalledWith(1, "/proj", ["seed", "--select", "stg_orders", "--log-format", "json"]);

    const seedLine = JSON.stringify({
      data: { node_info: { unique_id: "seed.proj.my_seed", node_status: "success" } },
      info: { msg: "1 of 1 OK loaded seed ..." },
    });
    seedProc.stdout.emit("data", Buffer.from(seedLine + "\n"));
    expect(events).toEqual([{ type: "status", nodeId: "seed.proj.my_seed", status: "success" }]);
    expect(written).toContain("1 of 1 OK loaded seed ...");

    seedProc.emit("close", 0);

    // The seed phase's own `done` is swallowed (not forwarded) — instead
    // the main command starts, using the SAME selector string.
    expect(spawnSpy).toHaveBeenNthCalledWith(2, "/proj", ["run", "--select", "stg_orders", "--log-format", "json"]);
    expect(events).toEqual([{ type: "status", nodeId: "seed.proj.my_seed", status: "success" }]);

    const mainLine = JSON.stringify({
      data: { node_info: { unique_id: "model.proj.stg_orders", node_status: "started" } },
      info: { msg: "1 of 1 START ..." },
    });
    mainProc.stdout.emit("data", Buffer.from(mainLine + "\n"));
    mainProc.emit("close", 0);

    expect(events).toEqual([
      { type: "status", nodeId: "seed.proj.my_seed", status: "success" },
      { type: "status", nodeId: "model.proj.stg_orders", status: "running" },
      { type: "done", exitCode: 0 },
    ]);
  });

  it("aborts with the seed's exit code when the seed phase fails, never starting the main command", () => {
    const seedProc = fakeChild(1111);
    const spawnSpy = vi.fn(() => seedProc as unknown as ChildProcess);
    const events: unknown[] = [];
    startDbtRunWithSeed(
      "/proj", "run", "x", true,
      { onWrite: () => {}, onEvent: (e) => events.push(e) },
      { spawn: spawnSpy },
    );
    seedProc.emit("close", 1);
    expect(events).toEqual([{ type: "done", exitCode: 1 }]);
    expect(spawnSpy).toHaveBeenCalledTimes(1); // the main command was never spawned
  });

  it("cancel() during the seed phase kills the seed process and the main command never starts", () => {
    const seedProc = fakeChild(1111);
    const spawnSpy = vi.fn(() => seedProc as unknown as ChildProcess);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const events: unknown[] = [];
    const controller = startDbtRunWithSeed(
      "/proj", "run", "x", true,
      { onWrite: () => {}, onEvent: (e) => events.push(e) },
      { spawn: spawnSpy, platform: "darwin" },
    );
    controller.cancel();
    expect(killSpy).toHaveBeenCalledWith(-1111, "SIGTERM");
    // Cancel sends SIGTERM; the process then exits non-zero, which the
    // wrapper treats the same as any other seed failure — abort.
    seedProc.emit("close", null);
    expect(events).toEqual([{ type: "done", exitCode: -1 }]);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    killSpy.mockRestore();
  });

  it("cancel() during the main phase delegates to the main command's controller, not the already-finished seed one", () => {
    const seedProc = fakeChild(1111);
    const mainProc = fakeChild(2222);
    let call = 0;
    const spawnSpy = vi.fn(() => (call++ === 0 ? seedProc : mainProc) as unknown as ChildProcess);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const controller = startDbtRunWithSeed(
      "/proj", "run", "x", true,
      { onWrite: () => {}, onEvent: () => {} },
      { spawn: spawnSpy, platform: "darwin" },
    );
    seedProc.emit("close", 0); // seed succeeds → main phase starts (mainProc)
    controller.cancel();
    expect(killSpy).toHaveBeenCalledWith(-2222, "SIGTERM");
    expect(killSpy).not.toHaveBeenCalledWith(-1111, "SIGTERM");
    killSpy.mockRestore();
  });
});
