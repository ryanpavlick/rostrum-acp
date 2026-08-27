/**
 * One conversation as a first-class, independently-running unit.
 *
 * Everything a turn needs — its ACP session, busy state, abort controller,
 * queue, pending request, plan, usage and config options — lives on the
 * controller rather than on the view. The view holds a `Map` of these plus an
 * active id, so a prompt keeps running when the user switches away and its
 * events still land on the right conversation.
 */
import type * as vscode from "vscode";
import type {
  ConfigOption,
  PendingRequest,
  PlanEntry,
  SessionLifecycle,
  SlashCommand,
  UsageSummary,
} from "../shared/protocol.js";
import type { Session } from "./session.js";
import type { AgentConnection } from "./agentConnection.js";

export type { SessionLifecycle };

export type PromptAttachment =
  | { kind: "file"; uri: vscode.Uri }
  | { kind: "media"; label: string; mimeType: string; data: string }
  | { kind: "resource"; label: string; uri?: string; mimeType?: string; text: string };

let counter = 0;

export class ManagedSession {
  /** Stable across ACP session-id changes (a fork remints the ACP id). */
  readonly id = `ms-${Date.now().toString(36)}-${(counter += 1).toString(36)}`;
  readonly createdAt = Date.now();
  updatedAt = Date.now();
  title = "New session";

  busy = false;
  abort: AbortController | undefined;
  /** Includes experimental steer prompts, so queued work never overlaps them. */
  inFlightPrompts = 0;
  /** A successfully completed primary turn permits one queue drain. */
  mayDrainQueue = false;
  queue: string[] = [];
  attachments: PromptAttachment[] = [];
  /**
   * Every request waiting on the user, oldest first.
   *
   * An agent running tools concurrently can raise several at once. Holding
   * only the newest left the earlier ones unanswerable, which stalls the
   * agent on a promise nothing can ever resolve.
   */
  pending: PendingRequest[] = [];
  /**
   * Resolvers for requests Rostrum itself is waiting on, by request id.
   *
   * Covers ACP elicitation and host-originated prompts such as
   * authentication — anything whose answer is not routed back through
   * `Session.respond`.
   */
  readonly requestResolvers = new Map<
    string,
    (optionId: string, answers?: Record<string, string>) => void
  >();
  plan: PlanEntry[] = [];
  commands: SlashCommand[] = [];
  configOptions: ConfigOption[] = [];
  usage: UsageSummary | null = null;
  lastError: string | undefined;
  /**
   * A transcript with no live ACP session behind it. Prompts are refused
   * rather than being misdirected at whichever session was active before.
   */
  readOnly = false;

  private state: SessionLifecycle = "idle";

  constructor(
    readonly connection: AgentConnection,
    readonly session: Session,
    private readonly onChanged: (session: ManagedSession) => void,
  ) {}

  /** The request the user is being shown: the oldest still outstanding. */
  get currentRequest(): PendingRequest | null {
    return this.pending[0] ?? null;
  }

  /** Drop one answered request, keeping the rest. */
  resolveRequest(requestId: string): void {
    this.pending = this.pending.filter((request) => request.requestId !== requestId);
    this.requestResolvers.delete(requestId);
    this.refreshLifecycle();
  }

  get agentKey(): string {
    return this.connection.agentKey;
  }

  get sessionId(): string | null {
    return this.session.sessionId;
  }

  /** Point the ACP router at this controller under a (possibly new) id. */
  adoptSessionId(sessionId: string | null): void {
    const previous = this.session.sessionId;
    if (previous === sessionId) return;
    if (previous) this.connection.router.unregister(previous);
    this.session.sessionId = sessionId;
    if (sessionId) this.connection.router.register(sessionId, this.session);
    this.touch();
  }

  get lifecycle(): SessionLifecycle {
    return this.state;
  }

  /**
   * Derive the lifecycle from the runtime facts, so no call site has to
   * remember the precedence between "busy" and "waiting on the user".
   */
  refreshLifecycle(): void {
    const next: SessionLifecycle = !this.connection.alive
      ? "disconnected"
      : this.pending.length > 0
        ? "awaiting-approval"
        : this.busy || this.inFlightPrompts > 0
          ? "running"
          : this.lastError
            ? "error"
            : "idle";
    this.setLifecycle(next);
  }

  setLifecycle(state: SessionLifecycle): void {
    if (this.state === state) return;
    this.state = state;
    this.touch();
  }

  /** Clear a recorded failure once the session does something successfully. */
  clearError(): void {
    if (this.lastError === undefined) return;
    this.lastError = undefined;
    this.refreshLifecycle();
  }

  fail(message: string): void {
    this.lastError = message;
    this.refreshLifecycle();
  }

  touch(): void {
    this.updatedAt = Date.now();
    this.onChanged(this);
  }

  /** Reset per-conversation state when the controller adopts a new conversation. */
  resetConversation(): void {
    this.queue = [];
    this.plan = [];
    this.usage = null;
    this.configOptions = [];
    this.pending = [];
    this.requestResolvers.clear();
    this.mayDrainQueue = false;
    this.lastError = undefined;
    this.readOnly = false;
    this.refreshLifecycle();
  }

  dispose(): void {
    this.abort?.abort();
    // Anything waiting on an answer from this session gets a refusal rather
    // than waiting forever on a promise nothing will ever resolve.
    for (const [requestId, resolve] of this.requestResolvers) {
      this.requestResolvers.delete(requestId);
      resolve("reject");
    }
    this.pending = [];
    if (this.session.sessionId) this.connection.router.unregister(this.session.sessionId);
    this.session.dispose();
  }
}
