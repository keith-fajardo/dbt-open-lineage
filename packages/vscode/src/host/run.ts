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

export interface ParsedLine { event: RunEvent | null; display: string }

/** Parse one line of `dbt ... --log-format json` output. `display` is always
 * populated (the JSON's human-readable `msg` field when present, otherwise
 * the raw line) so the terminal panel reads like normal dbt output even
 * though the underlying process emits structured JSON. A malformed line
 * (partial write, non-JSON noise) must never throw — it just displays raw
 * with no status event. */
export function parseDbtLogLine(line: string): ParsedLine {
  if (!line.trim()) return { event: null, display: line };
  let parsed: unknown;
  try { parsed = JSON.parse(line); }
  catch { return { event: null, display: line }; }
  const obj = parsed as { msg?: unknown; node_info?: { unique_id?: unknown; node_status?: unknown } };
  const display = typeof obj.msg === "string" ? obj.msg : line;
  const info = obj.node_info;
  if (info && typeof info.unique_id === "string" && typeof info.node_status === "string") {
    const status = mapNodeStatus(info.node_status);
    if (status) return { event: { type: "status", nodeId: info.unique_id, status }, display };
  }
  return { event: null, display };
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
 * to the terminal (via `cb.onWrite`, CRLF-terminated as vscode.Pseudoterminal
 * requires) and, when it carries node status, turned into a `RunEvent` (via
 * `cb.onEvent`). Emits a final `{type:"done"}` event when the process exits
 * or fails to spawn. */
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
      const { event, display } = parseDbtLogLine(line);
      cb.onWrite(display + "\r\n");
      if (event) cb.onEvent(event);
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
    cb.onWrite(`spawn error: ${e.message}\r\n`);
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
