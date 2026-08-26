import * as vscode from "vscode";
import type { SessionMeta, ToolCall, Turn } from "../shared/protocol.js";
import type { ChangeHistory, EditRecord, FileHistory } from "./history.js";
import type { SessionStore } from "./store.js";
import { formatTokens, type UsageTracker } from "./usage.js";

/** Past conversations, newest first. */
export class SessionsTree implements vscode.TreeDataProvider<SessionMeta> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly store: SessionStore) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(session: SessionMeta): vscode.TreeItem {
    const item = new vscode.TreeItem(session.title, vscode.TreeItemCollapsibleState.None);
    item.description = `${session.agentKey} · ${new Date(session.updatedAt).toLocaleString()}`;
    item.iconPath = new vscode.ThemeIcon("comment-discussion");
    item.contextValue = "rostrum.session";
    item.id = session.sessionId;
    item.command = {
      command: "rostrum.loadSession",
      title: "Load session",
      arguments: [session.sessionId],
    };
    return item;
  }

  getChildren(): Promise<SessionMeta[]> {
    return this.store.list();
  }
}

/** A file node, or one past edit of that file. */
type ChangeNode = { type: "file"; file: FileHistory } | { type: "edit"; file: FileHistory; index: number };

/**
 * Files the agents have edited, expandable into per-file edit history so you
 * can see which session last touched a file.
 */
export class ChangedFilesTree implements vscode.TreeDataProvider<ChangeNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly history: ChangeHistory) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(node: ChangeNode): vscode.TreeItem {
    if (node.type === "file") {
      const uri = vscode.Uri.file(node.file.path);
      const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.Collapsed);
      item.label = node.file.path.split("/").pop();
      const count = node.file.edits.length;
      item.description = count > 1 ? `${count} edits` : "1 edit";
      item.resourceUri = uri;
      item.contextValue = "rostrum.changedFile";
      item.command = { command: "vscode.open", title: "Open", arguments: [uri] };
      return item;
    }

    const edit = node.file.edits[node.index];
    const item = new vscode.TreeItem(
      new Date(edit.at).toLocaleString(),
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = edit.agentKey;
    item.iconPath = new vscode.ThemeIcon("history");
    item.tooltip = `Session ${edit.sessionId}`;
    item.command = {
      command: "rostrum.openHistoryDiff",
      title: "Open agent edit",
      arguments: [edit],
    };
    return item;
  }

  getChildren(node?: ChangeNode): ChangeNode[] {
    if (!node) {
      return this.history.files().map((file) => ({ type: "file" as const, file }));
    }
    if (node.type === "file") {
      return node.file.edits.map((_, index) => ({
        type: "edit" as const,
        file: node.file,
        index,
      }));
    }
    return [];
  }
}

interface UsageNode {
  agentKey: string;
  label: string;
  description: string;
}

/** Token totals per agent, accumulated across sessions. */
export class UsageStatsTree implements vscode.TreeDataProvider<UsageNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly tracker: UsageTracker) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(node: UsageNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.description = node.description;
    item.iconPath = new vscode.ThemeIcon("dashboard");
    return item;
  }

  async getChildren(): Promise<UsageNode[]> {
    await this.tracker.load();
    return this.tracker.entries().map(({ agentKey, totals }) => ({
      agentKey,
      label: agentKey,
      description:
        `${formatTokens(totals.totalTokens)} total · ` +
        `${formatTokens(totals.inputTokens)} in · ` +
        `${formatTokens(totals.outputTokens)} out · ` +
        `${totals.turns} turn${totals.turns === 1 ? "" : "s"}`,
    }));
  }
}

/** One navigable entry in the active session: a turn, or a tool call within it. */
type OutlineNode =
  | { type: "turn"; index: number; turn: Turn }
  | { type: "tool"; turnIndex: number; call: ToolCall };

/**
 * Structure of the conversation in the chat panel, so a long session can be
 * navigated without scrolling. Reflects live state rather than the store: the
 * outline should track the turn being streamed right now.
 */
export class OutlineTree implements vscode.TreeDataProvider<OutlineNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private turns: Turn[] = [];

  update(turns: Turn[]): void {
    this.turns = turns;
    this.changed.fire();
  }

  getTreeItem(node: OutlineNode): vscode.TreeItem {
    if (node.type === "turn") {
      const label = summarise(node.turn) || (node.turn.role === "user" ? "Prompt" : "Response");
      const tools = node.turn.blocks.filter((b) => b.kind === "tool").length;
      const item = new vscode.TreeItem(
        label,
        tools > 0
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
      );
      item.iconPath = new vscode.ThemeIcon(node.turn.role === "user" ? "account" : "sparkle");
      if (tools > 0) item.description = `${tools} tool${tools === 1 ? "" : "s"}`;
      item.command = {
        command: "rostrum.revealTurn",
        title: "Reveal in chat",
        arguments: [node.turn.id],
      };
      return item;
    }

    const item = new vscode.TreeItem(node.call.title, vscode.TreeItemCollapsibleState.None);
    item.description = node.call.subAgent ? "sub-agent" : node.call.kind;
    item.iconPath = new vscode.ThemeIcon(iconForStatus(node.call.status));
    return item;
  }

  getChildren(node?: OutlineNode): OutlineNode[] {
    if (!node) {
      return this.turns.map((turn, index) => ({ type: "turn" as const, index, turn }));
    }
    if (node.type === "turn") {
      return node.turn.blocks.flatMap((block) =>
        block.kind === "tool"
          ? [{ type: "tool" as const, turnIndex: node.index, call: block.call }]
          : [],
      );
    }
    return [];
  }
}

function summarise(turn: Turn): string {
  for (const block of turn.blocks) {
    if (block.kind === "text" && block.text.trim()) {
      const line = block.text.trim().split("\n")[0];
      return line.length > 50 ? `${line.slice(0, 47)}…` : line;
    }
  }
  return "";
}

function iconForStatus(status: string): string {
  if (status === "completed") return "check";
  if (status === "failed") return "error";
  if (status === "in_progress") return "sync";
  return "circle-outline";
}

/**
 * Every agent edit in chronological order, newest first — the cross-file view
 * that the per-file Changes tree does not give you.
 */
export class TimelineTree implements vscode.TreeDataProvider<EditRecord> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly history: ChangeHistory) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(edit: EditRecord): vscode.TreeItem {
    const uri = vscode.Uri.file(edit.path);
    const item = new vscode.TreeItem(
      uri.path.split("/").pop() ?? edit.path,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = `${edit.agentKey} · ${new Date(edit.at).toLocaleTimeString()}`;
    item.tooltip = `${edit.path}\nSession ${edit.sessionId}\n${new Date(edit.at).toLocaleString()}`;
    item.resourceUri = uri;
    item.iconPath = new vscode.ThemeIcon("diff-single");
    item.command = {
      command: "rostrum.openHistoryDiff",
      title: "Open agent edit",
      arguments: [edit],
    };
    return item;
  }

  getChildren(): EditRecord[] {
    return this.history
      .files()
      .flatMap((file) => file.edits)
      .sort((a, b) => b.at - a.at)
      .slice(0, 200);
  }
}
