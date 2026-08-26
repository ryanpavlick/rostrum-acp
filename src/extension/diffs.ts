/**
 * Historical agent edits shown in VS Code's native diff editor.
 *
 * The snapshots are served through a virtual document scheme rather than as
 * untitled documents. That matters for three reasons: virtual documents are
 * read-only, so a historical record cannot be accidentally edited; they never
 * prompt to save; and because the URI path ends in the original filename,
 * VS Code infers the language and syntax-highlights both sides without the
 * original file having to still exist.
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { aggregateDiff, type EditRecord, type FileHistory } from "./history.js";

/** Snapshots kept addressable; old ones are evicted rather than accumulating. */
const MAX_SNAPSHOTS = 100;

export class AgentDiffProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly scheme = "rostrum-diff";

  private readonly contents = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  private readonly registration: vscode.Disposable;
  private counter = 0;
  /** What is on screen, so previous/next know where they are. */
  private position: { file: FileHistory; index: number } | undefined;

  readonly onDidChange = this.changed.event;

  constructor() {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(
      AgentDiffProvider.scheme,
      this,
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  private snapshot(side: "before" | "after", filePath: string, text: string): vscode.Uri {
    this.counter += 1;
    // The basename is last so the language is inferred from its extension.
    const uri = vscode.Uri.from({
      scheme: AgentDiffProvider.scheme,
      path: `/${side}/${this.counter}/${path.basename(filePath)}`,
    });
    this.contents.set(uri.toString(), text);

    while (this.contents.size > MAX_SNAPSHOTS) {
      const oldest = this.contents.keys().next().value;
      if (oldest === undefined) break;
      this.contents.delete(oldest);
    }
    return uri;
  }

  /**
   * Show a file's net change across every edit.
   *
   * This is what clicking a changed file should do: opening the file itself
   * answers nothing about what the agent changed.
   */
  async openFile(file: FileHistory): Promise<void> {
    const combined = aggregateDiff(file);
    if (!combined) {
      // Every edit was recorded without content, so there is nothing to diff.
      await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file.path));
      return;
    }

    this.position = { file, index: -1 };
    const name = path.basename(file.path);
    const before = this.snapshot("before", file.path, combined.oldText);
    const after = this.snapshot("after", file.path, combined.newText);
    const span =
      combined.edits === 1
        ? new Date(combined.to).toLocaleString()
        : `${combined.edits} edits, ${new Date(combined.from).toLocaleString()} → ${new Date(combined.to).toLocaleString()}`;

    await vscode.commands.executeCommand(
      "vscode.diff",
      before,
      after,
      `${name} — all agent changes (${span})`,
      { preview: true },
    );
  }

  /**
   * Walk a file's edits in time order.
   *
   * `edits` is newest-first, so moving to a *newer* edit means moving down the
   * array. Index -1 is the aggregate view of the whole file, which sits above
   * the newest individual edit.
   */
  async step(direction: "newer" | "older"): Promise<void> {
    const position = this.position;
    if (!position) {
      void vscode.window.showInformationMessage("Open an agent edit first to step through its history.");
      return;
    }

    const { file, index } = position;
    const name = path.basename(file.path);

    if (index === -1) {
      if (direction === "newer") {
        void vscode.window.showInformationMessage(`Already showing every change to ${name}.`);
        return;
      }
      await this.open(file.edits[0], file, 0);
      return;
    }

    const target = direction === "newer" ? index - 1 : index + 1;
    if (target < 0) {
      // Past the newest individual edit is the whole-file view.
      await this.openFile(file);
      return;
    }
    if (target >= file.edits.length) {
      void vscode.window.showInformationMessage(`No older edit to ${name}.`);
      return;
    }
    await this.open(file.edits[target], file, target);
  }

  /**
   * Open one recorded edit as a diff.
   *
   * An edit recorded without a snapshot — the agent reported the write but not
   * its content — can only be shown as the file itself, which is better than a
   * diff against nothing.
   */
  async open(edit: EditRecord, file?: FileHistory, index?: number): Promise<void> {
    if (typeof edit?.path !== "string") return;
    if (file && index !== undefined) this.position = { file, index };

    if (typeof edit.newText !== "string") {
      await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(edit.path));
      return;
    }

    const name = path.basename(edit.path);
    const when = new Date(edit.at).toLocaleString();
    const before = this.snapshot("before", edit.path, edit.oldText ?? "");
    const after = this.snapshot("after", edit.path, edit.newText);

    // Name both sides in the title: "which of these is the agent's version?"
    // is otherwise the first thing anyone has to work out.
    const position =
      this.position && this.position.index >= 0
        ? ` ${this.position.file.edits.length - this.position.index}/${this.position.file.edits.length}`
        : "";
    const title =
      edit.oldText === undefined
        ? `${name} — created by ${edit.agentKey} (${when})${position}`
        : `${name} — before ↔ after ${edit.agentKey} (${when})${position}`;

    await vscode.commands.executeCommand("vscode.diff", before, after, title, {
      preview: true,
    });
  }

  /**
   * Compare what the agent wrote with what is on disk now.
   *
   * Answers "has this been changed since?", which the stored before/after pair
   * cannot: that only ever shows the moment of the edit.
   */
  async compareWithCurrent(edit: EditRecord): Promise<void> {
    if (typeof edit?.newText !== "string") {
      await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(edit.path));
      return;
    }
    const name = path.basename(edit.path);
    const agentVersion = this.snapshot("after", edit.path, edit.newText);
    const onDisk = vscode.Uri.file(edit.path);

    try {
      await vscode.workspace.fs.stat(onDisk);
    } catch {
      void vscode.window.showWarningMessage(`${name} no longer exists on disk.`);
      return;
    }

    await vscode.commands.executeCommand(
      "vscode.diff",
      agentVersion,
      onDisk,
      `${name} — ${edit.agentKey}'s version ↔ current`,
      { preview: true },
    );
  }

  dispose(): void {
    this.registration.dispose();
    this.changed.dispose();
    this.contents.clear();
  }
}
