/**
 * Open a real VS Code window with Rostrum loaded and a scripted agent already
 * configured, so the README can show the actual product rather than an
 * illustration of it.
 *
 * Downloads the pinned VS Code build on first run, opens the fixture
 * workspace, and stays open until the window is closed. Not part of the test
 * suite: this exists to be photographed.
 */
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "test", "e2e", "fixture");

// An integrated VS Code terminal passes this down, and it makes the downloaded
// Electron binary behave as plain Node and reject every launch option.
const inherited = process.env.ELECTRON_RUN_AS_NODE;
delete process.env.ELECTRON_RUN_AS_NODE;

const executable = await downloadAndUnzipVSCode(
  process.env.ROSTRUM_VSCODE_VERSION ?? "1.104.0",
);

console.log(`
Rostrum demo window
-------------------
  1. Open the Rostrum view in the Activity Bar, then Rostrum Chat.
  2. Run "Rostrum: New Session" and choose Demo Agent.
  3. Send any prompt. The agent replies with reasoning, a plan, a tool call,
     a file diff, a diagram, maths, and an approval request it leaves waiting.
  4. Capture the window. On macOS: Cmd+Shift+4, then Space, then click it.

Save shots into docs/images/. Close the window to exit.
`);

const child = spawn(
  executable,
  [
    fixture,
    `--extensionDevelopmentPath=${root}`,
    // A throwaway profile, so the screenshot is not of somebody's customised
    // editor and does not disturb their real one.
    `--user-data-dir=${path.join(root, ".vscode-test", "demo-profile")}`,
    "--disable-extensions",
    "--new-window",
  ],
  { stdio: "inherit" },
);

child.on("exit", (code) => {
  if (inherited !== undefined) process.env.ELECTRON_RUN_AS_NODE = inherited;
  process.exitCode = code ?? 0;
});
