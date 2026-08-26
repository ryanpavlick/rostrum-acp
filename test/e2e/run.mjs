import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureUri = new URL("./fixture/", import.meta.url).href;
// An integrated VS Code terminal inherits this flag from its extension host.
// Passing it to the downloaded desktop binary makes Electron run as Node and
// reject every VS Code launch option.
const inheritedElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
delete process.env.ELECTRON_RUN_AS_NODE;

try {
  await runTests({
    // Pin the API baseline we publish against. Set ROSTRUM_VSCODE_VERSION to
    // exercise another VS Code release without changing the committed gate.
    version: process.env.ROSTRUM_VSCODE_VERSION ?? "1.104.0",
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, "test/e2e/suite.cjs"),
    launchArgs: [`--folder-uri=${fixtureUri}`],
  });
} catch (error) {
  console.error("Extension Development Host smoke test failed.", error);
  process.exitCode = 1;
} finally {
  if (inheritedElectronRunAsNode !== undefined) {
    process.env.ELECTRON_RUN_AS_NODE = inheritedElectronRunAsNode;
  }
}
