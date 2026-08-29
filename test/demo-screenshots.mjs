/**
 * Capture deterministic screenshots of the real VS Code demo window.
 *
 * The extension already self-drives when ROSTRUM_DEMO=1: it opens Rostrum Chat,
 * starts the Demo Agent, sends a prompt, and leaves a permission request on
 * screen. This script launches that same demo with Chromium remote debugging
 * enabled, waits until the permission card is visible in the workbench, and
 * saves browser-level screenshots for release/Marketplace review.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { reapProfile } from "./reap.mjs";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "test", "e2e", "fixture");
const profile = path.join(root, ".vscode-test", "screenshot-profile");
const outputDir = path.join(root, ".vscode-test", "demo-screenshots");
const timeoutMs = Number(process.env.ROSTRUM_SCREENSHOT_TIMEOUT_MS ?? 45_000);

fs.rmSync(profile, { recursive: true, force: true });
fs.mkdirSync(profile, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });

const inherited = process.env.ELECTRON_RUN_AS_NODE;
delete process.env.ELECTRON_RUN_AS_NODE;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === "string") reject(new Error("Could not allocate a local port"));
        else resolve(address.port);
      });
    });
  });
}

async function waitForJson(url, deadline) {
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastError?.message ?? lastError ?? "no response")}`);
}

async function waitForWorkbench(browser, deadline) {
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        const title = await page.title().catch(() => "");
        const url = page.url();
        if (title.includes("Visual Studio Code") || url.startsWith("vscode-file://")) return page;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the VS Code workbench page");
}

async function waitForDemoContent(page, deadline) {
  await page.getByText("Chat", { exact: true }).last().click({ timeout: 3000 }).catch(() => undefined);

  const expected = [
    "Rostrum",
    "Demo Agent",
    "running",
    "Changes",
    "2 edits",
    "Timeline",
    "Outline",
  ];

  let lastText = "";
  while (Date.now() < deadline) {
    lastText = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
    if (expected.every((text) => lastText.includes(text))) return lastText;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    [
      "Timed out waiting for the demo turn to produce visible release-shot state.",
      "Last visible workbench text:",
      lastText.slice(0, 2000),
    ].join("\n\n"),
  );
}

const port = await freePort();
const executable = await downloadAndUnzipVSCode(process.env.ROSTRUM_VSCODE_VERSION ?? "1.104.0");
const child = spawn(
  executable,
  [
    fixture,
    path.join(fixture, "src", "webview", "transcript.ts"),
    `--extensionDevelopmentPath=${root}`,
    `--user-data-dir=${profile}`,
    "--disable-extensions",
    "--new-window",
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-workspace-trust",
    `--remote-debugging-port=${port}`,
  ],
  {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ROSTRUM_DEMO: "1" },
  },
);

const log = [];
child.stdout.on("data", (chunk) => log.push(String(chunk)));
child.stderr.on("data", (chunk) => log.push(String(chunk)));

let browser;
try {
  const deadline = Date.now() + timeoutMs;
  await waitForJson(`http://127.0.0.1:${port}/json/version`, deadline);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await waitForWorkbench(browser, deadline);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const text = await waitForDemoContent(page, deadline);
  assert.match(text, /Demo Agent/, "demo session should be visible before capture");
  assert.match(text, /2 edits/, "demo edits should be visible before capture");

  await page.screenshot({
    path: path.join(outputDir, "rostrum-demo-window.png"),
    fullPage: false,
  });

  await page.setViewportSize({ width: 390, height: 900 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await page.screenshot({
    path: path.join(outputDir, "rostrum-demo-mobile-width.png"),
    fullPage: false,
  });

  fs.writeFileSync(path.join(outputDir, "workbench-text.txt"), text);
  console.log(`Captured demo screenshots in ${path.relative(root, outputDir)}`);
} finally {
  await browser?.close().catch(() => undefined);
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1500);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (child.exitCode === null) child.kill("SIGKILL");
  // Killing the editor is not enough: Rostrum's supervisor is detached by
  // design and owns the agent, so both outlive the window unless reaped.
  await reapProfile(profile);
  fs.writeFileSync(path.join(outputDir, "vscode.log"), log.join(""));
  if (inherited !== undefined) process.env.ELECTRON_RUN_AS_NODE = inherited;
}
