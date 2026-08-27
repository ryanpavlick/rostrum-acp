import * as vscode from "vscode";

/**
 * A diagram viewer in its own webview.
 *
 * Mermaid renders by building DOM from strings and has a history of XSS
 * findings. The transcript's guarantee — that agent output never becomes
 * markup — is worth more than inline diagrams, so the renderer is quarantined
 * here instead: a separate webview holding no transcript, no session state and
 * no message channel back into the chat panel, with a policy that admits
 * exactly its own nonce-tagged script and the inline styles an SVG needs.
 */
export class DiagramPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  show(source: string, title = "Diagram"): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Beside;

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "rostrum.diagram",
        title,
        { viewColumn: column, preserveFocus: true },
        {
          enableScripts: true,
          // Nothing here survives being hidden, and rebuilding is cheap
          // relative to holding a 3 MB bundle resident.
          retainContextWhenHidden: false,
          localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "out", "webview")],
        },
      );
      this.panel.onDidDispose(() => (this.panel = undefined));
      this.panel.webview.html = this.html(this.panel.webview);
    } else {
      this.panel.title = title;
      this.panel.reveal(column, true);
    }

    const dark =
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ||
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast;

    // The webview may still be loading its script; a small retry is simpler
    // and less fragile than a ready handshake for a one-shot view.
    const post = () => void this.panel?.webview.postMessage({
      type: "render",
      source,
      theme: dark ? "dark" : "light",
    });
    post();
    setTimeout(post, 120);
  }

  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "out", "webview", "diagram.js"),
    );
    const nonce = Array.from({ length: 32 }, () =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".charAt(
        Math.floor(Math.random() * 62),
      ),
    ).join("");

    // 'unsafe-inline' for style only: Mermaid writes presentation attributes
    // and a <style> block into the SVG it produces, and there is no way to
    // nonce those. Scripts stay locked to the nonce, and there is no
    // connect-src, img-src or font-src at all, so nothing here can reach out.
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<title>Diagram</title>
<style>
  body {
    margin: 0;
    padding: 16px;
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
  }
  #diagram { overflow: auto; }
  #diagram svg { max-width: 100%; height: auto; }
  #status { font-size: 0.9em; opacity: 0.75; padding: 4px 0; white-space: pre-wrap; }
  #status.failed {
    opacity: 1;
    color: var(--vscode-errorForeground, #f14c4c);
    font-family: var(--vscode-editor-font-family, monospace);
  }
</style>
</head>
<body>
<div id="status" role="status" aria-live="polite"></div>
<div id="diagram" role="img" aria-label="Rendered diagram"></div>
<script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }
}
