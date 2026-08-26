import * as vscode from "vscode";
import type {
  LiveSession,
  SessionLifecycle,
  SessionMeta,
  ToolCall,
  Turn,
} from "../shared/protocol.js";
import type { ChangeHistory, EditRecord, FileHistory } from "./history.js";
import type { SessionStore } from "./store.js";
import { formatTokens, type UsageTracker } from "./usage.js";

/**
 * One row in the Sessions view: a heading, a conversation this window is
 * running, or a saved transcript.
 */
export type SessionNode =
  | { type: "group"; id: string; label: string; children: SessionNode[] }
  | { type: "live"; session: LiveSession }
  | { type: "stored"; session: SessionMeta };

/**
 * How a live conversation is drawn.
 *
 * A background session that needs the user has to be findable without opening
 * it, so lifecycle drives both the icon and its colour rather than being
 * buried in a tooltip.
 */
const LIFECYCLE_PRESENTATION: Record<
  SessionLifecycle,
  { icon: string; color?: string; label: string }
> = {
  running: { icon: "sync~spin", color: "charts.blue", label: "running" },
  "awaiting-approval": {
    icon: "question",
    color: "notificationsWarningIcon.foreground",
    label: "needs approval",
  },
  error: { icon: "error", color: "notificationsErrorIcon.foreground", label: "error" },
  disconnected: { icon: "debug-disconnect", color: "disabledForeground", label: "disconnected" },
  idle: { icon: "comment-discussion", label: "idle" },
};

const DAY = 24 * 60 * 60 * 1000;

/** Bucket a saved conversation by age, so long histories stay navigable. */
function period(updatedAt: number, now: number): { id: string; label: string; order: number } {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (updatedAt >= startOfToday) return { id: "today", label: "Today", order: 1 };
  if (updatedAt >= startOfToday - DAY) return { id: "yesterday", label: "Yesterday", order: 2 };
  if (updatedAt >= startOfToday - 7 * DAY) return { id: "week", label: "Previous 7 days", order: 3 };
  if (updatedAt >= startOfToday - 30 * DAY) return { id: "month", label: "Previous 30 days", order: 4 };
  return { id: "older", label: "Older", order: 5 };
}

/**
 * Conversations this window is running, above the saved history.
 *
 * Live rows come from the chat provider rather than the store, because a
 * running conversation may not have been persisted yet — and its status
 * changes without anything being written.
 */
export class SessionsTree implements vscode.TreeDataProvider<SessionNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  private live: () => LiveSession[] = () => [];

  constructor(private readonly store: SessionStore) {}

  /**
   * Point the tree at the chat provider's live conversations.
   *
   * Set after construction because the provider needs this tree's `refresh`
   * in its own constructor.
   */
  setLiveSource(live: () => LiveSession[]): void {
    this.live = live;
  }

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(node: SessionNode): vscode.TreeItem {
    if (node.type === "group") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description = String(node.children.length);
      item.contextValue = "rostrum.sessionGroup";
      item.id = `group:${node.id}`;
      return item;
    }

    if (node.type === "live") {
      const { session } = node;
      const presentation = LIFECYCLE_PRESENTATION[session.lifecycle];
      const item = new vscode.TreeItem(session.title, vscode.TreeItemCollapsibleState.None);
      const queued = session.queued > 0 ? ` · ${session.queued} queued` : "";
      item.description = `${session.agentKey} · ${presentation.label}${queued}`;
      item.iconPath = new vscode.ThemeIcon(
        presentation.icon,
        presentation.color ? new vscode.ThemeColor(presentation.color) : undefined,
      );
      item.tooltip = new vscode.MarkdownString(
        [
          `**${session.title}**`,
          "",
          `Agent: \`${session.agentKey}\``,
          `Status: ${presentation.label}`,
          session.sessionId ? `Session: \`${session.sessionId}\`` : "Saved transcript (read-only)",
          `Updated: ${new Date(session.updatedAt).toLocaleString()}`,
        ].join("\n\n"),
      );
      // Only a persisted conversation can be exported or deleted by id.
      item.contextValue = session.sessionId ? "rostrum.session" : "rostrum.liveSession";
      item.id = `live:${session.controllerId}`;
      item.resourceUri = undefined;
      if (session.active) item.label = { label: session.title, highlights: [[0, session.title.length]] };
      item.command = {
        command: "rostrum.revealSession",
        title: "Show conversation",
        arguments: [session.controllerId],
      };
      return item;
    }

    const { session } = node;
    const item = new vscode.TreeItem(session.title, vscode.TreeItemCollapsibleState.None);
    item.description = `${session.agentKey} · ${new Date(session.updatedAt).toLocaleString()}`;
    item.iconPath = new vscode.ThemeIcon("history");
    item.contextValue = "rostrum.session";
    item.id = `stored:${session.sessionId}`;
    item.command = {
      command: "rostrum.loadSession",
      title: "Load session",
      arguments: [session.sessionId],
    };
    return item;
  }

  async getChildren(node?: SessionNode): Promise<SessionNode[]> {
    if (node) return node.type === "group" ? node.children : [];

    const live = this.live();
    const groups: SessionNode[] = [];
    if (live.length > 0) {
      groups.push({
        type: "group",
        id: "active",
        label: "Active",
        children: live.map((session) => ({ type: "live" as const, session })),
      });
    }

    // A conversation that is on screen must not also appear as history.
    const liveIds = new Set(live.flatMap((session) => (session.sessionId ? [session.sessionId] : [])));
    const stored = (await this.store.list()).filter((session) => !liveIds.has(session.sessionId));

    const now = Date.now();
    const buckets = new Map<string, { label: string; order: number; children: SessionNode[] }>();
    for (const session of stored) {
      const bucket = period(session.updatedAt, now);
      const entry = buckets.get(bucket.id) ?? { label: bucket.label, order: bucket.order, children: [] };
      entry.children.push({ type: "stored", session });
      buckets.set(bucket.id, entry);
    }

    for (const [id, bucket] of [...buckets].sort((a, b) => a[1].order - b[1].order)) {
      groups.push({ type: "group", id, label: bucket.label, children: bucket.children });
    }
    return groups;
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
