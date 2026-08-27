/**
 * The message contract between the extension host and the chat webview.
 *
 * Both sides import this file; it is the single source of truth for what may
 * cross the `postMessage` boundary. Keep it free of imports from `vscode` or
 * the ACP SDK so the webview bundle stays dependency-free.
 */

/** A single rendered block inside an assistant or user turn. */
export type Block =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "image"; mimeType: string; data: string }
  | { kind: "audio"; mimeType: string; data: string }
  | { kind: "resource"; label: string; uri?: string; mimeType?: string; text?: string }
  | { kind: "tool"; call: ToolCall }
  | { kind: "diff"; path: string; oldText: string; newText: string };

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export interface ToolCall {
  id: string;
  /** Human-facing label, e.g. "Read file". */
  title: string;
  /** ACP tool kind: read, edit, execute, search, fetch, think, other. */
  kind: string;
  status: ToolStatus;
  /** Raw tool input, when the agent supplies it. */
  input?: unknown;
  /** Flattened textual output, accumulated across updates. */
  output?: string;
  locations?: { path: string; line?: number }[];
  /**
   * Heuristic: ACP has no parent linkage between tool calls, so delegation is
   * inferred from the tool's name. See `isSubAgentCall`.
   */
  subAgent?: boolean;
}

export interface Turn {
  id: string;
  role: "user" | "assistant";
  blocks: Block[];
}

/**
 * A question posed to the user that expects structured answers back.
 *
 * ACP has no first-class "ask the user a question" request, so agents smuggle
 * it through `session/request_permission`. We normalise every dialect into
 * this shape (see `questions.ts`) so the webview renders one widget.
 */
export interface Question {
  /** Short chip label, e.g. "Library". */
  header?: string;
  question: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  /** allow_once | allow_always | reject_once | reject_always */
  kind: string;
}

/** A prompt awaiting the user: either a plain permission ask or a question form. */
export interface PendingRequest {
  requestId: string;
  title: string;
  /** Present only for question-style requests. */
  questions?: Question[];
  options: PermissionOption[];
  /** Extra context the agent attached (warnings, plan text). */
  content?: Block[];
}

export interface SessionMeta {
  sessionId: string;
  agentKey: string;
  title: string;
  updatedAt: number;
}

/**
 * Where a live conversation is in its lifecycle.
 *
 * `awaiting-approval` is deliberately distinct from `running`: a background
 * session blocked on a permission prompt needs the user, and has to be
 * distinguishable at a glance from one that is merely busy.
 */
export type SessionLifecycle =
  | "idle"
  | "running"
  | "awaiting-approval"
  | "error"
  | "disconnected";

/** A conversation this window is currently running. */
export interface LiveSession {
  /** Stable across ACP session-id changes, so it survives a fork. */
  controllerId: string;
  /** Null for a transcript loaded read-only, with no ACP session behind it. */
  sessionId: string | null;
  agentKey: string;
  title: string;
  lifecycle: SessionLifecycle;
  active: boolean;
  updatedAt: number;
  /** Open order, which is what the session switcher sorts by. */
  createdAt: number;
  queued: number;
}

export type ModeOption = { id: string; name: string; description?: string };

/** How much the agent may do without asking. */
export type PermissionModeId = "ask" | "acceptEdits" | "yolo";

/** Which optional ACP methods the connected agent actually supports. */
export interface Capabilities {
  loadSession: boolean;
  forkSession: boolean;
  listSessions: boolean;
  deleteSession: boolean;
  resumeSession: boolean;
  setSessionMode: boolean;
  additionalDirectories: boolean;
}

/**
 * A session knob the agent exposes (model, reasoning effort, mode, …).
 * Rendered generically so any agent's options work without special-casing.
 */
export interface ConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: "select" | "boolean";
  currentValue: string | boolean | null;
  options?: { value: string; name: string; description?: string }[];
}

export interface UsageSummary {
  turns: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
}

/** Host -> webview. */
export type HostMessage =
  | { type: "state"; state: ViewState }
  | { type: "turn"; turn: Turn }
  /**
   * One block changed. `index` addresses the block within the turn; an index
   * equal to the current length appends. Targeting a single block keeps a
   * token stream O(1) per update and — unlike sending a partial list — cannot
   * erase blocks the update does not mention.
   */
  | { type: "turnDelta"; turnId: string; index: number; block: Block }
  /** The oldest outstanding request, with how many are waiting in total. */
  | { type: "pending"; request: PendingRequest | null; pendingCount?: number }
  | { type: "busy"; busy: boolean }
  | { type: "usage"; usage: UsageSummary }
  | { type: "revealTurn"; turnId: string }
  | { type: "configOptions"; options: ConfigOption[] }
  | { type: "commands"; commands: SlashCommand[] }
  | { type: "plan"; plan: PlanEntry[] }
  | { type: "queued"; queued: string[] }
  | { type: "attachments"; names: string[] }
  | { type: "fileSuggestions"; query: string; files: FileSuggestion[] }
  | { type: "error"; message: string };

export interface ViewState {
  agents: string[];
  currentAgent: string | null;
  sessionId: string | null;
  turns: Turn[];
  busy: boolean;
  pending: PendingRequest | null;
  /** How many requests are waiting on the user, including the one shown. */
  pendingCount: number;
  modes: ModeOption[];
  currentMode: string | null;
  sessions: SessionMeta[];
  capabilities: Capabilities;
  usage: UsageSummary | null;
  configOptions: ConfigOption[];
  commands: SlashCommand[];
  plan: PlanEntry[];
  queued: string[];
  promptCapabilities: { image: boolean; audio: boolean; embeddedContext: boolean };
  /** Every conversation this window is running, not just the visible one. */
  liveSessions: LiveSession[];
  /** The mode in force for the visible agent, per-agent override included. */
  permissionMode: PermissionModeId;
}

/** A slash command the agent advertises. */
export interface SlashCommand {
  name: string;
  description?: string;
  hint?: string;
}

/** One item of the agent's working plan. */
export interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: string;
}

export interface FileSuggestion {
  label: string;
  path: string;
}

/** Webview -> host. */
export type ViewMessage =
  | { type: "ready" }
  | { type: "prompt"; text: string }
  | { type: "cancel" }
  | { type: "newSession" }
  | { type: "selectAgent"; agent: string }
  | { type: "selectMode"; mode: string }
  | { type: "pickSession" }
  | { type: "loadSession"; sessionId: string }
  /** Bring an already-running conversation on screen by controller id. */
  | { type: "revealSession"; controllerId: string }
  | { type: "openDiff"; path: string; line?: number }
  /** Show a fenced diagram in the quarantined viewer. */
  | { type: "openDiagram"; source: string; lang: string }
  | { type: "forkSession" }
  | { type: "setConfigOption"; id: string; value: string | boolean }
  | { type: "setPermissionMode"; mode: PermissionModeId }
  | { type: "queuePrompt"; text: string }
  | { type: "unqueuePrompt"; index: number }
  | { type: "steer"; text: string }
  | { type: "attach" }
  | { type: "attachWorkspaceFile"; path: string }
  | { type: "attachPastedImage"; mimeType: string; data: string; name?: string }
  | { type: "searchFiles"; query: string }
  | { type: "removeAttachment"; index: number }
  | { type: "deleteSession"; sessionId: string }
  /**
   * Answer to a pending request. `answers` is populated only for question
   * forms: it maps the question's index (as a string) to the chosen text.
   */
  | {
      type: "respond";
      requestId: string;
      optionId: string;
      answers?: Record<string, string>;
    };
