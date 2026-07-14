import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import { resolveBin } from "./gist";
import type { RunEvent, Status } from "@dbt-open-lineage/core/src/runStatus";

export function buildRunArgs(command: "run" | "build" | "test", selector: string): string[] {
  return [command, "--select", selector, "--log-format", "json"];
}

/** Accumulates chunks and yields only complete (newline-terminated) lines;
 * a trailing partial line carries over to the next push. `flush()` returns
 * any leftover partial line once — call it exactly once, when the stream
 * ends, so a final unterminated line isn't silently dropped. */
export class LineBuffer {
  private carry = "";
  push(chunk: string): string[] {
    const text = this.carry + chunk;
    const parts = text.split("\n");
    this.carry = parts.pop() ?? "";
    return parts;
  }
  flush(): string[] {
    const rest = this.carry;
    this.carry = "";
    return rest ? [rest] : [];
  }
}

/** dbt's `node_info.node_status` values (which vary a little across dbt
 * versions/resource types) collapsed onto our 4-state Status. Anything not
 * listed here (e.g. "warn") returns null: the line still displays in the
 * terminal, it just doesn't move the pilot light. */
export function mapNodeStatus(raw: string): Status | null {
  switch (raw) {
    case "started": return "running";
    case "success": case "passed": case "pass": case "reused": return "success";
    case "error": case "failed": case "fail": case "runtime error": return "failed";
    case "skipped": return "skipped";
    default: return null;
  }
}

export interface ParsedLine { event: RunEvent | null; logEvent: RunEvent | null; display: string }

/** Parse one line of `dbt ... --log-format json` output. `display` is always
 * populated (the JSON's human-readable `info.msg` field when present,
 * otherwise the raw line) so the terminal panel reads like normal dbt output
 * even though the underlying process emits structured JSON. A malformed line
 * (partial write, non-JSON noise) must never throw — it just displays raw
 * with no status/log event.
 *
 * dbt-core's real json-log schema (verified against dbt-core=1.11.11) wraps
 * every line as `{data: {...}, info: {...}}` — msg lives at `info.msg`,
 * node_info lives at `data.node_info`. Neither is top-level.
 *
 * A `dbt test` run needs extra care: a test is its own manifest node with
 * its own `unique_id` (e.g. `test.proj.not_null_x.<hash>`), which never
 * matches any id in the DAG — only models/seeds/snapshots/sources are graph
 * nodes, tests aren't. A test's status/log must instead route to the MODEL
 * it tests, via `data.attached_node` (verified against a live `dbt test`
 * run). That field is only present on the test's FINISH event, not its
 * START — dbt doesn't say which model a just-started test belongs to — so
 * a test starting produces no status AND no log event; the model's pilot
 * light and log both jump straight from idle to pass/fail once the test
 * ends.
 *
 * `event` (status) requires BOTH a resolvable node id AND a `node_status`
 * that maps to a known `Status`. `logEvent` requires only the resolvable
 * node id — a line whose `node_status` doesn't map to anything (e.g.
 * "warn") still carries a `logEvent`, it just carries no `event`. */
export function parseDbtLogLine(line: string): ParsedLine {
  if (!line.trim()) return { event: null, logEvent: null, display: line };
  let parsed: unknown;
  try { parsed = JSON.parse(line); }
  catch { return { event: null, logEvent: null, display: line }; }
  const obj = parsed as {
    info?: { msg?: unknown };
    data?: {
      node_info?: { unique_id?: unknown; node_status?: unknown; resource_type?: unknown };
      attached_node?: unknown;
    };
  };
  const display = typeof obj.info?.msg === "string" ? obj.info.msg : line;
  const info = obj.data?.node_info;
  let event: RunEvent | null = null;
  let logEvent: RunEvent | null = null;
  if (info) {
    const nodeId = info.resource_type === "test"
      ? (typeof obj.data?.attached_node === "string" ? obj.data.attached_node : undefined)
      : (typeof info.unique_id === "string" ? info.unique_id : undefined);
    if (nodeId) {
      logEvent = { type: "log", nodeId, line: display };
      if (typeof info.node_status === "string") {
        const status = mapNodeStatus(info.node_status);
        if (status) event = { type: "status", nodeId, status };
      }
    }
  }
  return { event, logEvent, display };
}

export interface RunCallbacks {
  onWrite(text: string): void;
  onEvent(event: RunEvent): void;
}

export interface RunDeps {
  spawn(cwd: string, args: string[]): ChildProcess;
  /** Overridable only for tests — real callers always use process.platform. */
  platform?: NodeJS.Platform;
}

const defaultDeps: RunDeps = {
  // No shell: args stay discrete argv tokens (same injection-safety rationale
  // as compileSelectArgs). resolveBin avoids the GUI-launch PATH problem
  // gist.ts already had to solve for `claude` — child_process.spawn, unlike
  // vscode.Task's ShellExecution, never goes through a login shell.
  spawn: (cwd, args) => nodeSpawn(resolveBin("dbt"), args, { cwd, detached: process.platform !== "win32" }),
};

export interface RunController { cancel(): void }

/** Spawn `dbt <command> --select <selector> --log-format json` in
 * `projectRoot`, parsing stdout/stderr line-by-line: every line is written
 * out (via `cb.onWrite`, one line, no trailing newline — the host's own sink
 * adds line breaks, e.g. vscode.OutputChannel.appendLine) and, when it
 * carries node status, turned into a `RunEvent` (via `cb.onEvent`). Emits a
 * final `{type:"done"}` event when the process exits or fails to spawn. */
export function startDbtRun(
  projectRoot: string, command: "run" | "build" | "test", selector: string,
  cb: RunCallbacks, deps: RunDeps = defaultDeps,
): RunController {
  const child = deps.spawn(projectRoot, buildRunArgs(command, selector));
  const platform = deps.platform ?? process.platform;
  const out = new LineBuffer();
  const err = new LineBuffer();

  const handle = (lines: string[]) => {
    for (const line of lines) {
      const { event, logEvent, display } = parseDbtLogLine(line);
      cb.onWrite(display);
      if (event) cb.onEvent(event);
      if (logEvent) cb.onEvent(logEvent);
    }
  };

  // On a real spawn failure (e.g. dbt not installed), Node emits BOTH
  // 'error' and 'close' — guard so only the first of the two sends the
  // single `done` event the RunEvent contract promises.
  let done = false;
  const emitDone = (exitCode: number) => {
    if (done) return;
    done = true;
    cb.onEvent({ type: "done", exitCode });
  };

  child.stdout?.on("data", (chunk: Buffer) => handle(out.push(chunk.toString("utf8"))));
  child.stderr?.on("data", (chunk: Buffer) => handle(err.push(chunk.toString("utf8"))));
  child.on("close", (code: number | null) => {
    handle(out.flush());
    handle(err.flush());
    emitDone(code ?? -1);
  });
  child.on("error", (e: Error) => {
    cb.onWrite(`spawn error: ${e.message}`);
    emitDone(-1);
  });

  return {
    cancel: () => {
      if (!child.pid) return;
      try {
        if (platform === "win32") {
          const killer = nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
          // Best-effort: nothing else can be done if taskkill itself fails
          // to spawn, but leaving 'error' unhandled would throw and could
          // crash the extension host.
          killer.on("error", () => {});
        }
        // Negative pid = signal the whole process GROUP, not just the direct
        // child — dbt/db-adapter children must die too, or Cancel leaves
        // orphans running (the class of bug process-group kills exist for).
        else process.kill(-child.pid, "SIGTERM");
      } catch { /* already exited */ }
    },
  };
}

/** Like `startDbtRun`, but when `hasSeed` is true, runs `dbt seed --select
 * <selector>` first — dbt run/build/test can never build a seed regardless
 * of what's in --select, since dbt excludes seeds from those commands by
 * resource type, not by selection scope. The SAME selector string is reused
 * for both phases; each dbt command's own resource-type filtering resolves
 * it to the subset it cares about, so there's no need to build a
 * seed-only selector separately.
 *
 * The seed phase's own `done` event is swallowed (never forwarded to `cb`)
 * — only its exit code is inspected. On success, the main command starts
 * exactly as `startDbtRun` would run it alone, and ITS `done` event is what
 * finally reaches `cb`. On failure, `cb` receives a `done` with the seed's
 * exit code immediately, and the main command never starts — a model that
 * depends on a seed that failed to load is likely to fail or produce wrong
 * data anyway, so stopping there is safer than proceeding.
 *
 * `hasSeed === false` bypasses this entirely and behaves identically to
 * calling `startDbtRun` directly. */
export function startDbtRunWithSeed(
  projectRoot: string, command: "run" | "build" | "test", selector: string, hasSeed: boolean,
  cb: RunCallbacks, deps: RunDeps = defaultDeps,
): RunController {
  if (!hasSeed) return startDbtRun(projectRoot, command, selector, cb, deps);

  // Reassigned once the main phase starts, so cancel() always delegates to
  // whichever phase is currently in flight.
  let current: RunController = startDbtRun(projectRoot, "seed" as "run" | "build" | "test", selector, {
    onWrite: cb.onWrite,
    onEvent: (event) => {
      // Forward everything except the seed phase's own `done` — that one
      // is inspected (for its exit code) rather than passed through, since
      // this wrapper's own `done` contract covers the WHOLE two-phase run.
      if (event.type !== "done") { cb.onEvent(event); return; }
      if (event.exitCode !== 0) { cb.onEvent({ type: "done", exitCode: event.exitCode }); return; }
      current = startDbtRun(projectRoot, command, selector, cb, deps);
    },
  }, deps);

  return { cancel: () => current.cancel() };
}
