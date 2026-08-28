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
  The window drives itself: it opens the chat panel, connects the demo agent,
  and sends a prompt. Within a few seconds it shows reasoning, a plan, a tool
  call, a file diff, a diagram, maths, and an approval request left waiting.

  Capture it. On macOS: Cmd+Shift+4, then Space, then click the window.

Save shots into docs/images/. Close the window to exit.
`);

const child = spawn(
  executable,
  [
    fixture,
    // Open the file the agent edits, so the editor shows real code beside the
    // panel instead of an empty watermark.
    path.join(fixture, "src", "webview", "transcript.ts"),
    `--extensionDevelopmentPath=${root}`,
    // A throwaway profile, so the screenshot is not of somebody's customised
    // editor and does not disturb their real one.
    `--user-data-dir=${path.join(root, ".vscode-test", "demo-profile")}`,
    "--disable-extensions",
    "--new-window",
    // A fresh profile otherwise opens on VS Code's own welcome and sign-in
    // nudges, which sit on top of the thing being photographed.
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-workspace-trust",
  ],
  {
    stdio: "inherit",
    // The extension drives itself when this is set, so the window arrives
    // already showing a turn instead of waiting to be clicked through.
    env: { ...process.env, ROSTRUM_DEMO: "1" },
  },
);

child.on("exit", (code) => {
  if (inherited !== undefined) process.env.ELECTRON_RUN_AS_NODE = inherited;
  process.exitCode = code ?? 0;
});
