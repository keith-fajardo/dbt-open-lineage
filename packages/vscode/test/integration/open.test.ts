import * as assert from "assert";
import * as vscode from "vscode";

export async function run(): Promise<void> {
  // Activate the extension first: contributed runtime commands (registerCommand)
  // only appear in getCommands after activate() runs.
  const ext = vscode.extensions.getExtension("keithfajardo.dbt-open-lineage");
  assert.ok(ext, "extension present in host");
  await ext!.activate();
  const cmds = await vscode.commands.getCommands(true);
  assert.ok(cmds.includes("dbt-open-lineage.open"), "command registered");
  assert.ok(cmds.includes("dbt-open-lineage.compile"), "compile command registered");
  assert.ok(cmds.includes("dbt-open-lineage.recompile"), "recompile command registered");
  // VS Code auto-registers `<viewId>.focus` from the manifest's contributed
  // view — asserting it exists catches an id mismatch between package.json's
  // view id and the `.focus` target the open command fires at.
  assert.ok(
    cmds.includes("dbtOpenLineage.graph.focus"),
    "panel view focus command registered (view id matches package.json)",
  );
  // Focusing the panel view resolves the WebviewViewProvider; must not throw.
  await vscode.commands.executeCommand("dbt-open-lineage.open");
  await new Promise((r) => setTimeout(r, 1000));
  assert.ok(cmds.includes("dbt-open-lineage.open"), "command still present after open");
}
