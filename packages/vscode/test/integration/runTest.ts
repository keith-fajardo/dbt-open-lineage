import * as path from "path";
import { runTests } from "@vscode/test-electron";

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, "../../");
  const extensionTestsPath = path.resolve(__dirname, "./open.test");
  const workspace = path.resolve(__dirname, "../fixtures/project");
  await runTests({ extensionDevelopmentPath, extensionTestsPath, launchArgs: [workspace] });
}
main().catch((e) => { console.error(e); process.exit(1); });
