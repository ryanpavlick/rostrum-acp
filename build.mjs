import * as esbuild from "esbuild";
import { copyFile, mkdir, readdir } from "node:fs/promises";

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

/**
 * The diagram viewer, bundled separately because Mermaid is ~3.3 MB and the
 * transcript must not pay for it. Loaded only when a diagram is opened.
 */
const diagram = {
  entryPoints: ["src/webview/diagram.ts"],
  bundle: true,
  outfile: "out/webview/diagram.js",
  platform: "browser",
  target: "es2022",
  format: "iife",
  // Mermaid is large and never read by a human in this form.
  minify: true,
  sourcemap: false,
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

/**
 * Static assets. KaTeX's fonts are served from disk rather than inlined as
 * data URIs: base64 would add roughly a third again to ~300 KB of woff2 and
 * force a broader style policy, where `font-src ${webview.cspSource}` keeps
 * them local files that nothing off-machine can substitute.
 */
async function copyStyles() {
  await mkdir("out/webview", { recursive: true });
  await copyFile("src/webview/style.css", "out/webview/style.css");
  await copyFile("node_modules/katex/dist/katex.min.css", "out/webview/katex.css");

  await mkdir("out/webview/fonts", { recursive: true });
  const fonts = await readdir("node_modules/katex/dist/fonts");
  await Promise.all(
    fonts
      // woff2 only: every VS Code host is Chromium and supports it, so the
      // ttf and woff fallbacks are three quarters of the weight for nothing.
      .filter((name) => name.endsWith(".woff2"))
      .map((name) =>
        copyFile(`node_modules/katex/dist/fonts/${name}`, `out/webview/fonts/${name}`),
      ),
  );
}

await copyStyles();

if (watch) {
  for (const cfg of [extension, webview, diagram, manager]) {
    const ctx = await esbuild.context(cfg);
    await ctx.watch();
  }
} else {
  await Promise.all([
    esbuild.build(extension),
    esbuild.build(webview),
    esbuild.build(diagram),
    esbuild.build(manager),
  ]);
}
