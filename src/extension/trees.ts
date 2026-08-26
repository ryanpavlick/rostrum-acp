import * as vscode from "vscode";
import type {
  LiveSession,
  SessionLifecycle,
  SessionMeta,
  ToolCall,
  Turn,
} from "../shared/protocol.js";
import { buildFileTree, relativeTo, type ChangeTreeNode } from "./changeTree.js";
import type { ChangeHistory, EditRecord, FileHistory } from "./history.js";
import {
  DEFAULT_FILTER,
  describeFilter,
  filterEdits,
  isFiltered,
  type TimelineFilter,
} from "./timeline.js";
import type { SessionStore } from "./store.js";
import { formatDuration, formatTokens, type UsageTotals, type UsageTracker } from "./usage.js";

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

/** A row in the Changes view: a folder, a changed file, or one past edit. */
export type ChangeNode =
  | { type: "folder"; node: Extract<ChangeTreeNode, { type: "folder" }> }
  | { type: "file"; file: FileHistory }
  | { type: "edit"; file: FileHistory; index: number };

/**
 * Files the agents have edited, expandable into per-file edit history so you
 * can see which session last touched a file.
 *
 * Flat by default, since a handful of changed files reads best as a list; the
 * folder view is what keeps a hundred of them navigable.
 */
export class ChangedFilesTree implements vscode.TreeDataProvider<ChangeNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private asTree = false;
  private roots: () => string[] = () => [];

  constructor(private readonly history: ChangeHistory) {}

  /** Workspace roots, so paths can be shown relative to them. */
  setRoots(roots: () => string[]): void {
    this.roots = roots;
  }

  get grouped(): boolean {
    return this.asTree;
  }

  setGrouped(asTree: boolean): void {
    if (this.asTree === asTree) return;
    this.asTree = asTree;
    this.refresh();
  }

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(node: ChangeNode): vscode.TreeItem {
    if (node.type === "folder") {
      const item = new vscode.TreeItem(node.node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${node.node.fileCount}`;
      item.iconPath = vscode.ThemeIcon.Folder;
      item.contextValue = "rostrum.changedFolder";
      item.id = `folder:${node.node.path}`;
      return item;
    }

    if (node.type === "file") {
      const uri = vscode.Uri.file(node.file.path);
      const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.Collapsed);
      item.label = node.file.path.split(/[\\/]/).pop();
      const count = node.file.edits.length;
      item.description = this.asTree
        ? count > 1 ? `${count} edits` : "1 edit"
        : `${relativeTo(this.roots(), node.file.path).split("/").slice(0, -1).join("/") || "."} · ${count > 1 ? `${count} edits` : "1 edit"}`;
      item.resourceUri = uri;
      item.contextValue = "rostrum.changedFile";
      item.id = `file:${node.file.path}`;
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
    item.tooltip = `${edit.path}\nSession ${edit.sessionId}`;
    item.id = `edit:${node.file.path}:${node.index}`;
    item.command = {
      command: "rostrum.openHistoryDiff",
      title: "Open agent edit",
      arguments: [edit],
    };
    return item;
  }

  getChildren(node?: ChangeNode): ChangeNode[] {
    if (!node) {
      const files = this.history.files();
      if (!this.asTree) return files.map((file) => ({ type: "file" as const, file }));
      return buildFileTree(files, this.roots()).map(toChangeNode);
    }
    if (node.type === "folder") return node.node.children.map(toChangeNode);
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

function toChangeNode(node: ChangeTreeNode): ChangeNode {
  return node.type === "folder" ? { type: "folder", node } : { type: "file", file: node.file };
}

/** An agent's totals, expandable into the individual measures. */
type UsageNode =
  | { type: "agent"; agentKey: string; totals: UsageTotals }
  | { type: "metric"; agentKey: string; label: string; value: string; icon: string };

/**
 * Token totals per agent, accumulated across sessions.
 *
 * Tokens alone do not say much about cost: an agent that burns twenty minutes
 * and two hundred tool calls to spend the same tokens is a different
 * proposition, so duration and tool-call counts sit alongside them.
 */
export class UsageStatsTree implements vscode.TreeDataProvider<UsageNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly tracker: UsageTracker) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(node: UsageNode): vscode.TreeItem {
    if (node.type === "metric") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.description = node.value;
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.id = `usage:${node.agentKey}:${node.label}`;
      return item;
    }

    const item = new vscode.TreeItem(node.agentKey, vscode.TreeItemCollapsibleState.Collapsed);
    const { totals } = node;
    item.description =
      `${formatTokens(totals.totalTokens)} tokens · ` +
      `${totals.turns} turn${totals.turns === 1 ? "" : "s"}` +
      (totals.durationMs > 0 ? ` · ${formatDuration(totals.durationMs)}` : "");
    item.iconPath = new vscode.ThemeIcon("dashboard");
    item.id = `usage:${node.agentKey}`;
    return item;
  }

  async getChildren(node?: UsageNode): Promise<UsageNode[]> {
    if (!node) {
      await this.tracker.load();
      return this.tracker.entries().map(({ agentKey, totals }) => ({
        type: "agent" as const,
        agentKey,
        totals,
      }));
    }
    if (node.type !== "agent") return [];

    const { agentKey, totals } = node;
    const metric = (label: string, value: string, icon: string): UsageNode => ({
      type: "metric",
      agentKey,
      label,
      value,
      icon,
    });

    const rows = [
      metric("Turns", String(totals.turns), "comment-discussion"),
      metric("Total tokens", formatTokens(totals.totalTokens), "symbol-numeric"),
      metric("Input", formatTokens(totals.inputTokens), "arrow-down"),
      metric("Output", formatTokens(totals.outputTokens), "arrow-up"),
    ];
    // Optional in ACP: an agent that never reports these should not be shown
    // a row of zeros implying it did no thinking and cached nothing.
    if (totals.thoughtTokens > 0) {
      rows.push(metric("Reasoning", formatTokens(totals.thoughtTokens), "lightbulb"));
    }
    if (totals.cachedReadTokens > 0) {
      rows.push(metric("Cached reads", formatTokens(totals.cachedReadTokens), "database"));
    }
    if (totals.toolCalls > 0) {
      rows.push(metric("Tool calls", String(totals.toolCalls), "tools"));
    }
    if (totals.durationMs > 0) {
      rows.push(metric("Time working", formatDuration(totals.durationMs), "watch"));
      rows.push(
        metric(
          "Average turn",
          formatDuration(totals.durationMs / Math.max(1, totals.turns)),
          "dashboard",
        ),
      );
    }
    return rows;
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
/**
 * Every agent edit in time order, narrowed by an optional filter.
 *
 * Unfiltered it answers "what just happened"; filtered it answers "what did
 * this agent do this morning", which is the question that actually comes up
 * once a log has more than a session or two in it.
 */
export class TimelineTree implements vscode.TreeDataProvider<EditRecord> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private filter: TimelineFilter = { ...DEFAULT_FILTER };

  constructor(private readonly history: ChangeHistory) {}

  refresh(): void {
    this.changed.fire();
  }

  get currentFilter(): TimelineFilter {
    return this.filter;
  }

  setFilter(filter: TimelineFilter): void {
    this.filter = filter;
    this.refresh();
  }

  /** What the view is showing, for the view title. */
  describe(): string {
    return isFiltered(this.filter) ? describeFilter(this.filter) : "";
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

  /** All edits matching the filter, newest first. */
  matching(): EditRecord[] {
    return filterEdits(
      this.history.files().flatMap((file) => file.edits),
      this.filter,
    ).sort((a, b) => b.at - a.at);
  }

  getChildren(): EditRecord[] {
    // Capped: the tree is for recent work, and the full log can be very long.
    return this.matching().slice(0, 200);
  }
}
