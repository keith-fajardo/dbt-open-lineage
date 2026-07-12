import { describe, it, expect, vi } from "vitest";
import { compileSelectArgs, runTaskToCompletion } from "./compile";

describe("runTaskToCompletion", () => {
  it("resolves with the exit code when the matching task ends", async () => {
    const listeners: Array<(e: { execution: object; exitCode?: number }) => void> = [];
    const fakeExec = { id: "exec1" };
    const deps = {
      executeTask: vi.fn(async () => fakeExec),
      onDidEndTaskProcess: (cb: (e: { execution: object; exitCode?: number }) => void) => {
        listeners.push(cb); return { dispose() {} };
      },
    };
    const task = { name: "dbt compile" } as never;
    const p = runTaskToCompletion(task, deps as never);
    // Let the internal executeTask().then(...) chain run so the listener is
    // registered before we simulate the completion event (executeTask is
    // async, so registration happens on a later microtask).
    await deps.executeTask.mock.results[0].value;
    // simulate VSCode firing completion for our execution
    listeners[0]({ execution: fakeExec, exitCode: 0 });
    await expect(p).resolves.toBe(0);
    expect(deps.executeTask).toHaveBeenCalledWith(task);
  });
});

describe("compileSelectArgs", () => {
  it("passes the model as its own argv token", () => {
    expect(compileSelectArgs("stg_orders")).toEqual(["compile", "--select", "stg_orders"]);
  });
  it("keeps a hostile name as one opaque token — injection-safe by construction", () => {
    // ShellExecution(command, args[]) never splices args into a shell string,
    // so metacharacters in the name cannot break out. No sanitizer needed.
    expect(compileSelectArgs("x; rm -rf ~")).toEqual(["compile", "--select", "x; rm -rf ~"]);
  });
});
