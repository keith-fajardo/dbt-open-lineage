// Type-only import: erased at compile time, so loading this module never
// triggers Node/Vite to resolve the real "vscode" package (which only exists
// inside the VSCode extension host, not as an npm dependency). That keeps
// runTaskToCompletion importable/testable outside VSCode. makeCompileTask
// lazily requires "vscode" at call time, since it's only ever invoked from
// extension.ts running inside the real extension host.
import type * as vscode from "vscode";

export function makeCompileTask(projectRoot: string): vscode.Task {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vs = require("vscode") as typeof vscode;
  const exec = new vs.ShellExecution("dbt compile", { cwd: projectRoot });
  const task = new vs.Task(
    { type: "dbt-open-lineage" }, vs.TaskScope.Workspace,
    "dbt compile", "dbt Open Lineage", exec,
  );
  task.presentationOptions = { reveal: vs.TaskRevealKind.Always, panel: vs.TaskPanelKind.Shared };
  return task;
}

/** Args for `dbt compile --select <model>` as a token array. Passing the model
 * as its own arg (not concatenated into a shell string) means no shell
 * metacharacter can break out — so, unlike a `sh -c "…"` invocation, the name
 * needs no sanitizing. */
export function compileSelectArgs(model: string): string[] {
  return ["compile", "--select", model];
}

/** A dbt Task that compiles only one model. Uses the arg-array ShellExecution
 * form (see compileSelectArgs) rather than a shell string. */
export function makeCompileSelectTask(projectRoot: string, model: string): vscode.Task {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vs = require("vscode") as typeof vscode;
  const exec = new vs.ShellExecution("dbt", compileSelectArgs(model), { cwd: projectRoot });
  const task = new vs.Task(
    { type: "dbt-open-lineage" }, vs.TaskScope.Workspace,
    `dbt compile --select ${model}`, "dbt Open Lineage", exec,
  );
  task.presentationOptions = { reveal: vs.TaskRevealKind.Always, panel: vs.TaskPanelKind.Shared };
  return task;
}

export interface TaskDeps {
  // vscode.tasks.executeTask returns a Thenable (not a native Promise), so
  // this is typed to match it exactly rather than requiring callers to wrap it.
  executeTask(task: vscode.Task): Thenable<vscode.TaskExecution>;
  onDidEndTaskProcess(cb: (e: vscode.TaskProcessEndEvent) => void): vscode.Disposable;
}

/** Run a task and resolve with its exit code (or -1 if none) when THAT
 * execution ends. Deps injected for testability. */
export function runTaskToCompletion(task: vscode.Task, deps: TaskDeps): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    deps.executeTask(task).then((execution) => {
      const sub = deps.onDidEndTaskProcess((e) => {
        if (e.execution === execution) { sub.dispose(); resolve(e.exitCode ?? -1); }
      });
    }, reject);
  });
}
