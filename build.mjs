import * as esbuild from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

const watch = process.argv.includes("--watch");

/** The extension host runs CommonJS and must not bundle the `vscode` module. */
const extension = {
  entryPoints: ["src/extension/extension.ts"],
  bundle: true,
  outfile: "out/extension.cjs",
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
};

/** The webview is a plain browser bundle with no Node builtins. */
const webview = {
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  outfile: "out/webview/main.js",
  platform: "browser",
  target: "es2022",
  format: "iife",
  sourcemap: true,
  logLevel: "info",
};

/** Detached supervisor used to retain ACP agents across extension-host reloads. */
const manager = {
  entryPoints: ["src/manager.ts"],
  bundle: true,
  outfile: "out/agent-manager.cjs",
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  logLevel: "info",
};

/** The stylesheet is static; esbuild only handles the two TS entry points. */
async function copyStyles() {
  await mkdir("out/webview", { recursive: true });
  await copyFile("src/webview/style.css", "out/webview/style.css");
}

await copyStyles();

if (watch) {
  for (const cfg of [extension, webview, manager]) {
    const ctx = await esbuild.context(cfg);
    await ctx.watch();
  }
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webview), esbuild.build(manager)]);
}
