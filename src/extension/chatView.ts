import * as vscode from "vscode";
import type { ContentBlock, SessionInfo } from "@agentclientprotocol/sdk";
import type {
  Block,
  Capabilities,
  ConfigOption,
  LiveSession,
  PlanEntry,
  SlashCommand,
  HostMessage,
  ModeOption,
  PendingRequest,
  SessionLifecycle,
  SessionMeta,
  Turn,
  UsageSummary,
  ViewMessage,
  ViewState,
} from "../shared/protocol.js";
import { managerStateFile, type AgentDefinition } from "./agentProcess.js";
import { AgentConnection, connectionKey } from "./agentConnection.js";
import { ManagedSession } from "./managedSession.js";
import { Session, displayBlocks, type PermissionMode } from "./session.js";
import { SessionStore, deriveTitle, type StoredSession } from "./store.js";
import type { UsageTracker } from "./usage.js";
import { NO_CAPABILITIES } from "./capabilities.js";
import { checkCommandExists, nodeProbe, validateAgentDefinition } from "./discovery.js";
import { mcpServersFromConfig, type McpServerDefinition } from "./mcp.js";
import { Preferences } from "./preferences.js";

/**
 * The chat sidebar.
 *
 * It owns a pool of agent connections and a pool of `ManagedSession`
 * controllers, plus the id of whichever one is on screen. Every ACP event
 * updates its own controller first and only then renders, so a background
 * turn keeps running — and keeps recording — while the user looks at
 * something else.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  /** One live process per configured agent, shared by all of its sessions. */
  private readonly connections = new Map<string, AgentConnection>();
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly lastCatalogSync = new Map<string, number>();
  private activeId: string | null = null;
  /** True while reopening a saved set, so partial state is never published. */
  private restoring = false;
  /**
   * Conversations that were saved but are not live right now.
   *
   * Kept so a conversation the agent could not reopen this time — it was
   * offline, mid-update, temporarily broken — is still there to try again
   * next time, rather than being forgotten the moment one attempt fails.
   */
  private unrestored: RestorableSession[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: SessionStore,
    private readonly output: vscode.OutputChannel,
    private readonly onFileEdited: (
      edit: { path: string; oldText?: string; newText?: string; toolCallId?: string },
      sessionId: string,
      agentKey: string,
    ) => void,
    private readonly usageTracker: UsageTracker,
    private readonly onTurnsChanged: (turns: Turn[]) => void,
    private readonly onSessionsChanged: () => void,
    private readonly preferences: Preferences = new Preferences(context.globalState),
  ) {}

  // --- active controller ---------------------------------------------------

  private active(): ManagedSession | undefined {
    return this.activeId ? this.sessions.get(this.activeId) : undefined;
  }

  private isActive(controller: ManagedSession): boolean {
    return this.activeId === controller.id;
  }

  private get currentAgentKey(): string | null {
    return this.active()?.agentKey ?? this.lastAgentKey;
  }

  /** Remembered so agent-scoped commands still work with no session on screen. */
  private lastAgentKey: string | null = null;

  /** Bring a controller on screen and re-render everything it owns. */
  private async activate(controller: ManagedSession): Promise<void> {
    this.activeId = controller.id;
    this.lastAgentKey = controller.agentKey;
    await this.pushState();
  }

  /** Supervisor keys for the connections this window is driving. */
  supervisedAgents(): { agentKey: string; key: string; persistent: boolean }[] {
    return [...this.connections.values()].map((connection) => ({
      agentKey: connection.agentKey,
      key: connection.key,
      persistent: connection.persistent,
    }));
  }

  /** Data for the diagnostics command; no agent request is made here. */
  diagnostics(): Array<{
    agentKey: string;
    persistent: boolean;
    alive: boolean;
    sessions: number;
    lastCatalogSync?: number;
    capabilities: Capabilities;
  }> {
    return [...this.connections.values()].map((connection) => ({
      agentKey: connection.agentKey,
      persistent: connection.persistent,
      alive: connection.alive,
      sessions: connection.sessions.size,
      lastCatalogSync: this.lastCatalogSync.get(connection.agentKey),
      capabilities: connection.capabilities,
    }));
  }

  recoverySessions(): ReadonlyArray<RestorableSession> {
    return this.unrestored;
  }

  /** Retry conversations that could not be attached during the last restore. */
  async retryRecovery(): Promise<number> {
    const waiting = [...this.unrestored];
    this.unrestored = [];
    let restored = 0;
    for (const entry of waiting) {
      const connection = await this.ensureConnection(entry.agentKey);
      if (!connection) {
        this.unrestored.push(entry);
        continue;
      }
      const controller = await this.loadSession(connection, entry.sessionId, await this.store.load(entry.sessionId));
      if (controller) restored += 1;
      else this.unrestored.push(entry);
    }
    await this.pushState();
    return restored;
  }

  /**
   * Live conversations in the order they were opened.
   *
   * Deliberately not sorted by recency: these back a tab strip, and chips that
   * reorder themselves whenever a background turn emits a token are unusable.
   */
  liveSessions(): LiveSession[] {
    return [...this.sessions.values()]
      .map((controller) => ({
        controllerId: controller.id,
        sessionId: controller.sessionId,
        agentKey: controller.agentKey,
        title: controller.title,
        lifecycle: controller.lifecycle,
        active: this.isActive(controller),
        updatedAt: controller.updatedAt,
        createdAt: controller.createdAt,
        queued: controller.queue.length,
      }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Scroll the chat panel to a turn picked in the Outline view. */
  revealTurn(turnId: string): void {
    this.post({ type: "revealTurn", turnId });
  }

  /** Public command entry point for cancelling the active ACP turn. */
  async cancel(): Promise<void> {
    const controller = this.active();
    if (controller) await this.cancelTurn(controller);
  }

  /** Open a searchable picker over live, local and agent-discovered sessions. */
  async pickSession(): Promise<void> {
    const live = this.liveSessions();
    const liveIds = new Set(live.flatMap((entry) => (entry.sessionId ? [entry.sessionId] : [])));
    const stored = await this.store.list();

    const picked = await vscode.window.showQuickPick(
      [
        ...live.map((entry) => ({
          label: `${lifecycleIcon(entry.lifecycle)} ${entry.title}`,
          description: `${entry.agentKey} · ${lifecycleLabel(entry.lifecycle)}${entry.active ? " · on screen" : ""}`,
          detail: new Date(entry.updatedAt).toLocaleString(),
          controllerId: entry.controllerId,
          sessionId: entry.sessionId,
        })),
        ...stored
          .filter((session) => !liveIds.has(session.sessionId))
          .map((session) => ({
            label: `$(history) ${session.title}`,
            description: session.agentKey,
            detail: session.updatedAt ? new Date(session.updatedAt).toLocaleString() : "Time unavailable",
            controllerId: undefined as string | undefined,
            sessionId: session.sessionId,
          })),
      ],
      { placeHolder: "Open a Rostrum session", matchOnDescription: true, matchOnDetail: true },
    );
    if (!picked) return;

    const controller = picked.controllerId ? this.sessions.get(picked.controllerId) : undefined;
    if (controller) await this.activate(controller);
    else if (picked.sessionId) await this.loadSessionById(picked.sessionId);
  }

  /**
   * Bring an already-running conversation on screen.
   *
   * Addressed by controller id rather than ACP session id, so it also reaches
   * a read-only transcript, which has no session id at all.
   */
  async revealSession(controllerId: string): Promise<void> {
    const controller = this.sessions.get(controllerId);
    if (!controller) {
      this.post({ type: "error", message: "That conversation is no longer running." });
      return;
    }
    await this.activate(controller);
  }

  /** Public command entry point; callers decide whether to ask for confirmation. */
  async deleteSessionById(sessionId: string): Promise<void> {
    await this.deleteSession(sessionId);
  }

  /** Restart the active agent and restore its current session when possible. */
  async restartCurrentAgent(): Promise<void> {
    const agentKey = this.currentAgentKey ?? this.config().get<string>("defaultAgent");
    const sessionId = this.active()?.sessionId;
    if (!agentKey) {
      this.post({ type: "error", message: "No agent is selected to restart." });
      return;
    }
    this.disconnect(agentKey);
    await this.startAgent(agentKey, false);
    const connection = this.connections.get(agentKey);
    if (!connection) return;

    if (sessionId) await this.loadSessionById(sessionId);
    // The old conversation may not be recoverable — an agent that cannot load
    // or resume, or one whose session was never persisted because it had no
    // turns yet. Restarting must still leave a usable session behind rather
    // than an empty panel.
    if (!this.active()) await this.newSession(connection);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "out")],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: ViewMessage) => {
      void this.handleMessage(message);
    });
  }

  // --- configuration -------------------------------------------------------

  private config() {
    return vscode.workspace.getConfiguration("rostrum");
  }

  private agentDefinitions(): Record<string, AgentDefinition> {
    return this.config().get<Record<string, AgentDefinition>>("agents") ?? {};
  }

  /** The agent's own mode when it has one, else the global default. */
  private permissionMode(agentKey?: string): PermissionMode {
    const fallback = this.config().get<PermissionMode>("permissionMode") ?? "ask";
    return agentKey ? this.preferences.permissionMode(agentKey, fallback) : fallback;
  }

  /** Change the permission mode for one agent, live sessions included. */
  async setAgentPermissionMode(agentKey: string, mode: PermissionMode | undefined): Promise<void> {
    await this.preferences.setPermissionMode(agentKey, mode);
    const effective = this.permissionMode(agentKey);
    for (const controller of this.sessions.values()) {
      if (controller.agentKey === agentKey) controller.session.setPermissionMode(effective);
    }
    await this.pushState();
  }

  /** Agents this window could set a mode on, for the command's picker. */
  knownAgents(): string[] {
    return Object.keys(this.agentDefinitions());
  }

  currentAgent(): string | null {
    return this.currentAgentKey;
  }

  private mcpServers(connection: AgentConnection) {
    const configured = this.config().get<Record<string, McpServerDefinition>>("mcpServers") ?? {};
    const agentServers = this.agentDefinitions()[connection.agentKey]?.mcpServers ?? {};
    // Per-agent definitions override a global server with the same name,
    // while the global setting remains convenient for shared infrastructure.
    return mcpServersFromConfig({ ...configured, ...agentServers }, connection.mcpCaps);
  }

  private workspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  private workspaceRoots(): string[] {
    return vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [process.cwd()];
  }

  private additionalDirectories(connection: AgentConnection): Partial<{ additionalDirectories: string[] }> {
    return connection.capabilities.additionalDirectories
      ? { additionalDirectories: this.workspaceRoots().slice(1) }
      : {};
  }

  /**
   * Record every live conversation, not just the visible one.
   *
   * The supervisor keeps agent processes alive across a window reload, but a
   * process is not a conversation: the new extension host has to know which
   * ACP session ids it was holding, or those conversations keep running with
   * nothing able to reach them.
   */
  private rememberSessions(): void {
    // A restore rebuilds the set one conversation at a time. Publishing each
    // intermediate state would let an interrupted restore overwrite the saved
    // set with the handful it had reached, losing the rest for good.
    if (this.restoring) return;
    const active = this.active();
    const live = [...this.sessions.values()]
      .filter((controller) => controller.sessionId && !controller.readOnly)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((controller) => ({
        agentKey: controller.agentKey,
        sessionId: controller.sessionId as string,
      }));

    const seen = new Set(live.map((entry) => entry.sessionId));
    const sessions = [
      ...live,
      ...this.unrestored.filter((entry) => !seen.has(entry.sessionId)),
    ];

    void this.context.workspaceState.update("rostrum.liveSessions", {
      activeSessionId: active?.sessionId ?? null,
      sessions,
    });
  }

  /** What was live when this window last closed. */
  private savedSessions(): { activeSessionId: string | null; sessions: RestorableSession[] } {
    const saved = this.context.workspaceState.get<unknown>("rostrum.liveSessions");
    if (saved && typeof saved === "object") {
      const value = saved as { activeSessionId?: unknown; sessions?: unknown };
      const sessions = Array.isArray(value.sessions)
        ? value.sessions.filter(isRestorableSession)
        : [];
      return {
        activeSessionId: typeof value.activeSessionId === "string" ? value.activeSessionId : null,
        sessions,
      };
    }

    // Fall back to the single-session key written by earlier versions.
    const legacy = this.context.workspaceState.get<unknown>("rostrum.activeSession");
    if (legacy && typeof legacy === "object" && isRestorableSession(legacy)) {
      return { activeSessionId: legacy.sessionId, sessions: [legacy] };
    }
    return { activeSessionId: null, sessions: [] };
  }

  /**
   * Reopen every conversation this window was holding.
   *
   * Restores are sequential: each one may involve an ACP `session/load` that
   * replays a whole transcript, so never run them concurrently at startup.
   */
  private async restoreSessions(): Promise<boolean> {
    const saved = this.savedSessions();
    if (saved.sessions.length === 0) return false;
    const configured = new Set(Object.keys(this.agentDefinitions()));

    let restored: ManagedSession | undefined;
    let active: ManagedSession | undefined;
    let failed = 0;

    const strategy = this.config().get<"all" | "recent" | "active">("restoreSessions") ?? "all";
    const candidates = strategy === "active"
      ? saved.sessions.filter((entry) => entry.sessionId === saved.activeSessionId)
      : strategy === "recent"
        ? saved.sessions.slice(-5)
        : saved.sessions;
    this.unrestored = saved.sessions.filter((entry) => !candidates.includes(entry));

    this.restoring = true;
    try {
      for (const entry of candidates) {
        if (!configured.has(entry.agentKey)) {
          // The agent may simply not be configured in this window yet.
          this.unrestored.push(entry);
          continue;
        }
        const connection = await this.ensureConnection(entry.agentKey);
        if (!connection) {
          this.unrestored.push(entry);
          continue;
        }

        const controller = await this.loadSession(
          connection,
          entry.sessionId,
          await this.store.load(entry.sessionId),
          // One notice at the end beats one per conversation.
          { announce: false },
        );
        if (!controller) {
          this.unrestored.push(entry);
          failed += 1;
          continue;
        }
        restored ??= controller;
        if (entry.sessionId === saved.activeSessionId) active = controller;
      }
    } finally {
      this.restoring = false;
    }

    const target = active ?? restored;
    if (!target) return false;
    await this.activate(target);

    if (failed > 0) {
      this.post({
        type: "error",
        message: `${failed} conversation${failed === 1 ? "" : "s"} could not be reopened. ${failed === 1 ? "It is" : "They are"} still in the session history.`,
      });
    }

    const readOnly = [...this.sessions.values()].filter((controller) => controller.readOnly).length;
    if (readOnly > 0) {
      this.post({
        type: "error",
        message: `${readOnly} conversation${readOnly === 1 ? "" : "s"} could not be resumed by the agent and ${readOnly === 1 ? "is" : "are"} shown as a saved transcript only.`,
      });
    }
    return true;
  }

  // --- connections ---------------------------------------------------------

  /**
   * Return the live connection for an agent, launching it if needed.
   *
   * A connection whose key no longer matches the configured definition is torn
   * down first: reattaching would otherwise keep talking to a process still
   * running the previous command, env or cwd.
   */
  private async ensureConnection(agentKey: string): Promise<AgentConnection | undefined> {
    const definition = this.agentDefinitions()[agentKey];
    if (!definition) {
      this.post({ type: "error", message: `No agent configured named "${agentKey}".` });
      return undefined;
    }

    // Check the configuration before spawning. A malformed definition
    // otherwise surfaces as an opaque spawn failure, or worse as a silent hang
    // while the ACP handshake waits for a process that never answers.
    const problems = validateAgentDefinition(agentKey, definition);
    for (const problem of problems) this.output.appendLine(`[${agentKey}] ${problem.message}`);
    const blocking = problems.filter((problem) => problem.severity === "error");
    if (blocking.length > 0) {
      this.post({ type: "error", message: blocking.map((problem) => problem.message).join(" ") });
      return undefined;
    }

    const missing = await checkCommandExists(definition, nodeProbe());
    if (missing) {
      this.post({ type: "error", message: `Cannot start ${agentKey}: ${missing.message}` });
      return undefined;
    }

    const root = this.workspaceRoot();
    const wanted = connectionKey(agentKey, root, { ...definition, cwd: definition.cwd ?? root });
    const existing = this.connections.get(agentKey);
    if (existing && !existing.disposed && existing.key === wanted) return existing;
    if (existing) this.disconnect(agentKey);

    let connection: AgentConnection;
    try {
      connection = await this.connect(agentKey, definition, root);
    } catch (error) {
      this.post({ type: "error", message: `Failed to launch ${agentKey}: ${String(error)}` });
      return undefined;
    }

    this.connections.set(agentKey, connection);
    this.watchExit(connection);
    if (connection.droppedBytes > 0) {
      // Reattaching to a supervisor that had to discard output is not a
      // silent event: the transcript genuinely lost frames.
      this.post({
        type: "error",
        message: `Reattached to ${agentKey}, but ${connection.droppedBytes} bytes of its output were discarded while no window was open. Its transcript may be incomplete.`,
      });
    }

    try {
      const init = await connection.handshake();
      await this.authenticateIfNeeded(connection, init.authMethods ?? []);
      await this.syncSessionCatalog(connection);
    } catch (error) {
      this.post({ type: "error", message: `Handshake with ${agentKey} failed: ${String(error)}` });
      this.disconnect(agentKey);
      return undefined;
    }
    return connection;
  }

  /**
   * Establish the agent connection.
   *
   * Overridable so tests can drive the provider against a scripted agent
   * instead of a real process.
   */
  protected connect(
    agentKey: string,
    definition: AgentDefinition,
    workspaceRoot: string,
  ): Promise<AgentConnection> {
    return AgentConnection.connect({
      agentKey,
      definition,
      workspaceRoot,
      managerScript: this.context.asAbsolutePath("out/agent-manager.cjs"),
      stateFile: managerStateFile(this.context.globalStorageUri.fsPath),
      supervisorPort: this.config().get<number>("supervisorPort"),
      onUnroutable: (method, sessionId) =>
        this.output.appendLine(
          `Dropped ${method} from ${agentKey}: no live session for id ${sessionId ?? "(absent)"}.`,
        ),
      onStderr: (chunk) => this.output.append(chunk),
      log: (message) => this.output.appendLine(message),
    });
  }

  /** Surface an agent that dies unexpectedly rather than hanging the UI. */
  private watchExit(connection: AgentConnection): void {
    void connection.exited.then((code) => {
      if (this.connections.get(connection.agentKey) !== connection) return;
      connection.exitCode = code;
      for (const controller of connection.sessions) {
        controller.session.cancelPending();
        controller.pending = [];
        controller.busy = false;
        controller.inFlightPrompts = 0;
        controller.setLifecycle("disconnected");
        if (this.isActive(controller)) this.setBusy(controller, false);
      }
      if (code !== 0 && code !== null) {
        this.post({
          type: "error",
          message: `${connection.agentKey} exited with code ${code}. See the Rostrum output channel.`,
        });
      }
    });
  }

  private disconnect(agentKey: string): void {
    const connection = this.connections.get(agentKey);
    if (!connection) return;
    this.connections.delete(agentKey);
    for (const controller of [...connection.sessions]) this.sessions.delete(controller.id);
    if (this.activeId && !this.sessions.has(this.activeId)) this.activeId = null;
    connection.dispose();
  }

  /** Start (or reveal) the named agent, optionally opening a fresh session. */
  async startAgent(agentKey: string, createSession = true): Promise<void> {
    const connection = await this.ensureConnection(agentKey);
    if (!connection) return;
    this.lastAgentKey = agentKey;

    // Switching back to an agent reveals the conversation it was already
    // running rather than piling up an empty one each time. A deliberately
    // new conversation goes through `newSession`.
    const existing = [...connection.sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (existing) {
      await this.activate(existing);
      return;
    }
    if (createSession) await this.newSession(connection);
    else await this.pushState();
  }

  /**
   * Offer the agent's auth methods when it advertises any.
   *
   * Most agents work unauthenticated (a local model needs no key), so this is
   * opt-in rather than a blocking gate: `session/new` will fail loudly if
   * authentication was actually required.
   */
  private async authenticateIfNeeded(
    connection: AgentConnection,
    methods: { id: string; name: string; description?: string | null }[],
  ): Promise<void> {
    if (methods.length === 0 || !connection.agent.authenticate) return;
    if (this.config().get<boolean>("promptForAuth") !== true) return;

    const picked = await vscode.window.showQuickPick(
      methods.map((method) => ({
        label: method.name,
        detail: method.description ?? undefined,
        id: method.id,
      })),
      { placeHolder: "Authenticate this agent (Esc to skip)" },
    );
    if (!picked) return;

    try {
      await connection.agent.authenticate({ methodId: picked.id });
    } catch (error) {
      this.post({ type: "error", message: `Authentication failed: ${String(error)}` });
    }
  }

  // --- session controllers -------------------------------------------------

  /**
   * Build a controller and the ACP `Session` that feeds it.
   *
   * Each handler writes through to its own controller before consulting the
   * active id, so a background conversation stays complete and correct while
   * something else is on screen.
   */
  private createController(connection: AgentConnection): ManagedSession {
    let controller!: ManagedSession;
    const live = () => this.isActive(controller);

    const session = new Session(
      {
        onTurn: (turn) => {
          controller.touch();
          if (!live()) return;
          this.post({ type: "turn", turn });
          this.publishTurns();
        },
        onTurnDelta: (turnId, index, block) => {
          controller.updatedAt = Date.now();
          if (!live()) return;
          this.post({ type: "turnDelta", turnId, index, block });
          this.publishTurns();
        },
        onPending: (request) => {
          // A null request means every outstanding ask was cancelled.
          if (!request) controller.pending = [];
          else controller.pending.push(request);
          controller.refreshLifecycle();
          if (live()) this.postPending(controller);
          else if (request) this.notifyBackgroundRequest(controller, request);
        },
        onPendingResolved: (requestId) => {
          controller.resolveRequest(requestId);
          if (live()) this.postPending(controller);
        },
        onModes: (modes, current) => {
          if (live()) void this.pushState(modes, current);
        },
        onError: (message) => {
          controller.fail(message);
          if (live()) this.post({ type: "error", message });
        },
        onCommands: (commands) => {
          controller.commands = commands;
          if (live()) this.post({ type: "commands", commands });
        },
        onPlan: (plan) => {
          controller.plan = plan;
          controller.touch();
          if (live()) this.post({ type: "plan", plan });
        },
        onConfigOptions: (options) => {
          controller.configOptions = mapConfigOptions(options);
          if (live()) this.post({ type: "configOptions", options: controller.configOptions });
        },
        onElicit: (request, resolve) => {
          controller.requestResolvers.set(request.requestId, (optionId, answers) =>
            resolve(optionId.startsWith("accept") ? (answers ?? {}) : undefined),
          );
          controller.pending.push(request);
          controller.refreshLifecycle();
          if (live()) this.postPending(controller);
          else this.notifyBackgroundRequest(controller, request);
        },
        onFileEdited: (edit) =>
          this.onFileEdited(edit, controller.sessionId ?? "unknown", controller.agentKey),
      },
      this.workspaceRoots(),
      this.permissionMode(connection.agentKey),
    );

    controller = new ManagedSession(connection, session, (changed) => {
      if (this.isActive(changed)) this.publishTurns();
      this.onSessionsChanged();
    });
    this.sessions.set(controller.id, controller);
    connection.sessions.add(controller);
    return controller;
  }

  /**
   * Authenticate in the chat panel, in response to a failure.
   *
   * ACP has no "you must authenticate" error code, so the trigger is a failed
   * `session/new` on an agent that advertises auth methods. Presenting it
   * where the user is already looking beats a modal that appears before they
   * have asked for anything — and unlike the opt-in startup prompt, this
   * only ever fires when authentication is actually blocking work.
   *
   * Resolves true when the agent should be retried.
   */
  private async offerAuthentication(
    connection: AgentConnection,
    controller: ManagedSession,
    error: unknown,
  ): Promise<boolean> {
    const methods = connection.initialize?.authMethods ?? [];
    if (methods.length === 0 || !connection.agent.authenticate) return false;

    const requestId = `auth-${connection.agentKey}-${Date.now()}`;
    const request: PendingRequest = {
      requestId,
      title: `${connection.agentKey} needs to be authenticated`,
      options: [
        ...methods.map((method) => ({
          optionId: method.id,
          name: method.name,
          kind: "allow_once",
        })),
        { optionId: "reject", name: "Not now", kind: "reject_once" },
      ],
      content: [{ kind: "text", text: String((error as Error)?.message ?? error) }],
    };

    // With nothing else on screen the user is starting this agent right now,
    // so put the prompt where they are already looking. If they are mid-
    // conversation elsewhere, a notification is less rude than a hijack.
    if (!this.active()) await this.activate(controller);

    const chosen = await new Promise<string>((resolve) => {
      controller.requestResolvers.set(requestId, (optionId) => resolve(optionId));
      controller.pending.push(request);
      controller.refreshLifecycle();
      if (this.isActive(controller)) this.postPending(controller);
      else this.notifyBackgroundRequest(controller, request);
    });

    if (chosen === "reject") return false;

    try {
      await connection.agent.authenticate({ methodId: chosen });
      return true;
    } catch (failure) {
      this.post({ type: "error", message: `Authentication failed: ${String(failure)}` });
      return false;
    }
  }

  /**
   * A session that needs the user while it is off screen.
   *
   * It is never answered on the user's behalf: the notification is the only
   * automatic step, and the request stays pending until they open it.
   */
  private notifyBackgroundRequest(controller: ManagedSession, request: PendingRequest): void {
    void vscode.window
      .showInformationMessage(
        `${controller.title} (${controller.agentKey}) needs you: ${request.title}`,
        "Open session",
      )
      .then((choice) => {
        if (choice) void this.activate(controller);
      });
  }

  private removeController(controller: ManagedSession): void {
    controller.connection.sessions.delete(controller);
    this.sessions.delete(controller.id);
    controller.dispose();
    if (this.activeId === controller.id) this.activeId = null;
  }

  /** Open a fresh conversation, on the active agent unless one is named. */
  async newSession(target?: AgentConnection): Promise<void> {
    const connection = target ?? this.active()?.connection ??
      (this.lastAgentKey ? this.connections.get(this.lastAgentKey) : undefined);
    if (!connection || connection.disposed) return;

    const controller = this.createController(connection);
    // Updates can arrive before `session/new` answers; the router needs
    // somewhere to put them until the id is known.
    connection.router.setProvisional(controller.session);
    try {
      const open = () =>
        connection.agent.newSession({
          cwd: this.workspaceRoot(),
          mcpServers: this.mcpServers(connection),
          ...this.additionalDirectories(connection),
        });

      let response;
      try {
        response = await open();
      } catch (error) {
        // The usual reason a first session fails is that the agent has not
        // been authenticated. Offer it in the panel and retry, rather than
        // handing back a raw protocol error.
        if (!(await this.offerAuthentication(connection, controller, error))) throw error;
        response = await open();
      }

      controller.resetConversation();
      controller.session.setTurns([]);
      controller.adoptSessionId(response.sessionId);

      const modes: ModeOption[] =
        response.modes?.availableModes.map((mode) => ({
          id: mode.id,
          name: mode.name,
          description: mode.description ?? undefined,
        })) ?? [];

      controller.session.modes = modes;
      controller.session.currentMode = response.modes?.currentModeId ?? null;
      controller.configOptions = mapConfigOptions(response.configOptions);
      await this.applySavedOptions(controller);
      await this.activate(controller);
    } catch (error) {
      this.removeController(controller);
      this.post({ type: "error", message: `Could not start a session: ${String(error)}` });
    } finally {
      connection.router.setProvisional(undefined);
    }
  }

  /** Refresh the current agent's cursor-paginated ACP session catalog. */
  async refreshSessionCatalog(): Promise<void> {
    const connection = this.active()?.connection ??
      (this.lastAgentKey ? this.connections.get(this.lastAgentKey) : undefined);
    if (!connection) {
      this.post({ type: "error", message: "Start an agent before refreshing its sessions." });
      return;
    }
    if (!connection.capabilities.listSessions) {
      this.post({ type: "error", message: "This agent does not support listing sessions." });
      return;
    }
    try {
      await this.syncSessionCatalog(connection);
      await this.pushState();
    } catch (error) {
      this.post({ type: "error", message: `Could not refresh sessions: ${String(error)}` });
    }
  }

  /** Fetch every page before replacing the stored index, never a partial result. */
  private async syncSessionCatalog(connection: AgentConnection): Promise<void> {
    const agent = connection.agent;
    if (!agent.listSessions || !connection.capabilities.listSessions) return;

    const discovered: SessionMeta[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null | undefined;
    for (let page = 0; page < 100; page += 1) {
      const response = await agent.listSessions({
        cwd: this.workspaceRoot(),
        ...(cursor ? { cursor } : {}),
      });
      discovered.push(...response.sessions.map((session) => sessionMeta(session, connection.agentKey)));
      cursor = response.nextCursor;
      if (!cursor) break;
      if (seenCursors.has(cursor)) {
        throw new Error("agent returned a repeated session-list cursor");
      }
      seenCursors.add(cursor);
      if (page === 99) throw new Error("agent returned more than 100 session-list pages");
    }
    await this.store.replaceAgentCatalog(connection.agentKey, discovered);
    this.lastCatalogSync.set(connection.agentKey, Date.now());
    this.onSessionsChanged();
  }

  // --- message handling ----------------------------------------------------

  private async handleMessage(message: ViewMessage): Promise<void> {
    const controller = this.active();
    switch (message.type) {
      case "ready": {
        if (controller) {
          await this.pushState();
          break;
        }
        const configured = Object.keys(this.agentDefinitions());
        const preferred = this.config().get<string>("defaultAgent");
        // Every conversation this window was holding, not just the last one
        // that happened to be on screen.
        if (await this.restoreSessions()) break;
        const initial = preferred && configured.includes(preferred) ? preferred : configured[0];
        if (initial) await this.startAgent(initial);
        else await this.pushState();
        break;
      }
      case "selectAgent":
        await this.startAgent(message.agent);
        break;
      case "newSession":
        await this.newSession();
        break;
      case "prompt":
        if (controller) await this.sendPrompt(controller, message.text);
        break;
      case "cancel":
        if (controller) await this.cancelTurn(controller);
        break;
      case "respond": {
        if (!controller) break;
        const resolver = controller.requestResolvers.get(message.requestId);
        if (resolver) {
          // Elicitation or a host-originated prompt: Rostrum owns the answer.
          resolver(message.optionId, message.answers);
          controller.resolveRequest(message.requestId);
        } else {
          // `respond` fires onPendingResolved, which dequeues this one and
          // leaves any others still waiting.
          controller.session.respond(message.requestId, message.optionId, message.answers);
        }
        this.postPending(controller);
        break;
      }
      case "selectMode":
        if (controller) await this.setMode(controller, message.mode);
        break;
      case "pickSession":
        await this.pickSession();
        break;
      case "loadSession":
        await this.loadSessionById(message.sessionId);
        break;
      case "revealSession":
        await this.revealSession(message.controllerId);
        break;
      case "forkSession":
        if (controller) await this.forkSession(controller);
        break;
      case "setConfigOption":
        if (controller) await this.setConfigOption(controller, message.id, message.value);
        break;
      case "setPermissionMode": {
        const agentKey = controller?.agentKey ?? this.lastAgentKey;
        if (agentKey) await this.setAgentPermissionMode(agentKey, message.mode);
        break;
      }
      case "queuePrompt":
        if (!controller) break;
        controller.queue.push(message.text);
        controller.touch();
        this.post({ type: "queued", queued: controller.queue });
        break;
      case "unqueuePrompt":
        if (!controller) break;
        controller.queue.splice(message.index, 1);
        controller.touch();
        this.post({ type: "queued", queued: controller.queue });
        break;
      case "steer":
        if (controller) await this.steer(controller, message.text);
        break;
      case "attach":
        if (controller) await this.pickAttachments(controller);
        break;
      case "removeAttachment":
        if (!controller) break;
        controller.attachments.splice(message.index, 1);
        this.postAttachments(controller);
        break;
      case "deleteSession":
        await this.deleteSession(message.sessionId);
        break;
      case "openDiff":
        await vscode.window.showTextDocument(vscode.Uri.file(message.path), {
          preview: true,
          selection: message.line
            ? new vscode.Range(Math.max(0, message.line - 1), 0, Math.max(0, message.line - 1), 0)
            : undefined,
        });
        break;
    }
  }

  // --- prompting -----------------------------------------------------------

  private async sendPrompt(controller: ManagedSession, text: string): Promise<void> {
    const sessionId = controller.sessionId;
    if (!sessionId || controller.busy || controller.readOnly) return;
    if (!text.trim()) return;

    const connection = controller.connection;
    const attachments = await this.attachmentBlocks(controller);
    controller.session.addUserTurn(text, attachments.flatMap(displayBlocks));
    controller.clearError();
    this.setBusy(controller, true);
    const abort = new AbortController();
    controller.abort = abort;
    controller.inFlightPrompts += 1;
    controller.mayDrainQueue = false;

    const prompt = [{ type: "text" as const, text }, ...attachments];
    controller.attachments = [];
    this.postAttachments(controller);

    let completed = false;
    const startedAt = Date.now();
    const toolCallsBefore = controller.session.toolCallCount();
    try {
      const response = await connection.agent.prompt({ sessionId, prompt });
      await this.recordUsage(controller, response.usage, {
        durationMs: Date.now() - startedAt,
        toolCalls: Math.max(0, controller.session.toolCallCount() - toolCallsBefore),
      });
      completed = !abort.signal.aborted;
    } catch (error) {
      if (!abort.signal.aborted) {
        const message = `Prompt failed: ${String(error)}`;
        controller.fail(message);
        if (this.isActive(controller)) this.post({ type: "error", message });
      }
    } finally {
      controller.inFlightPrompts = Math.max(0, controller.inFlightPrompts - 1);
      // Background turns must land in the store too, or a completed
      // conversation the user never returned to would be lost on reload.
      await this.persistSession(controller);
      this.setBusy(controller, controller.inFlightPrompts > 0);
      controller.mayDrainQueue = completed;
      await this.drainQueue(controller);
    }
  }

  /** Run the next queued prompt, if the turn ended cleanly. */
  private async drainQueue(controller: ManagedSession): Promise<void> {
    if (!controller.mayDrainQueue || controller.busy) return;
    const next = controller.queue.shift();
    if (next === undefined) return;
    controller.mayDrainQueue = false;
    if (this.isActive(controller)) this.post({ type: "queued", queued: controller.queue });
    await this.sendPrompt(controller, next);
  }

  /**
   * Inject guidance into the running turn.
   *
   * ACP has no steer method, so this is a second `session/prompt` on the same
   * session while the first is in flight; agents that serialise prompts will
   * apply it at the next opportunity.
   */
  private async steer(controller: ManagedSession, text: string): Promise<void> {
    const sessionId = controller.sessionId;
    if (!sessionId || !text.trim() || controller.readOnly) return;
    controller.inFlightPrompts += 1;
    this.setBusy(controller, true);
    try {
      await controller.connection.agent.prompt({
        sessionId,
        prompt: [{ type: "text", text }],
      });
    } catch (error) {
      const message = `Steering failed: ${String(error)}`;
      controller.fail(message);
      if (this.isActive(controller)) this.post({ type: "error", message });
    } finally {
      controller.inFlightPrompts = Math.max(0, controller.inFlightPrompts - 1);
      this.setBusy(controller, controller.inFlightPrompts > 0);
      await this.drainQueue(controller);
    }
  }

  private async recordUsage(
    controller: ManagedSession,
    usage: Parameters<UsageTracker["record"]>[1],
    cost: Parameters<UsageTracker["record"]>[2] = {},
  ): Promise<void> {
    if (!usage) return;
    await this.usageTracker.record(controller.agentKey, usage, cost);

    controller.usage = {
      turns: (controller.usage?.turns ?? 0) + 1,
      totalTokens: (controller.usage?.totalTokens ?? 0) + (usage.totalTokens ?? 0),
      inputTokens: (controller.usage?.inputTokens ?? 0) + (usage.inputTokens ?? 0),
      outputTokens: (controller.usage?.outputTokens ?? 0) + (usage.outputTokens ?? 0),
    };
    if (this.isActive(controller)) this.post({ type: "usage", usage: controller.usage });
  }

  private async setConfigOption(
    controller: ManagedSession,
    id: string,
    value: string | boolean,
  ): Promise<void> {
    const agent = controller.connection.agent;
    if (!agent.setSessionConfigOption || !controller.sessionId) {
      this.post({ type: "error", message: "This agent does not expose session options." });
      return;
    }
    try {
      // The request field is `configId`, and the value type follows the option.
      // Called through the object: a detached method reference would lose its
      // receiver on any agent whose methods live on a prototype.
      const response = await agent.setSessionConfigOption({
        sessionId: controller.sessionId,
        configId: id,
        value,
      } as never);

      // The agent returns the full option set, since one change can alter others.
      const returned = mapConfigOptions(response?.configOptions);
      controller.configOptions = returned.length
        ? returned
        : controller.configOptions.map((option) =>
            option.id === id ? { ...option, currentValue: value } : option,
          );
      // Remember it for this agent, so the next session starts where the user
      // left off rather than back at the agent's default.
      await this.preferences.setConfigOption(controller.agentKey, id, value);
      if (this.isActive(controller)) {
        this.post({ type: "configOptions", options: controller.configOptions });
      }
    } catch (error) {
      this.post({ type: "error", message: `Could not set ${id}: ${String(error)}` });
    }
  }

  /**
   * Encode staged files as prompt content.
   *
   * Images go as `image` blocks when the agent accepts them; everything else
   * rides as an embedded `resource`, falling back to a plain path mention when
   * the agent supports neither.
   */
  private async attachmentBlocks(controller: ManagedSession): Promise<ContentBlock[]> {
    const blocks: ContentBlock[] = [];
    const promptCaps = controller.connection.promptCaps;

    for (const uri of controller.attachments) {
      const stat = await vscode.workspace.fs.stat(uri);
      const maxBytes = 5 * 1024 * 1024;
      if (stat.size > maxBytes) {
        this.post({ type: "error", message: `${uri.path.split("/").pop()} is larger than 5 MiB and was not attached.` });
        continue;
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      const mime = mimeFor(uri.fsPath);

      if (mime.startsWith("image/") && promptCaps.image) {
        blocks.push({
          type: "image",
          mimeType: mime,
          data: Buffer.from(bytes).toString("base64"),
        });
        continue;
      }

      if (mime.startsWith("audio/") && promptCaps.audio) {
        blocks.push({
          type: "audio",
          mimeType: mime,
          data: Buffer.from(bytes).toString("base64"),
        });
        continue;
      }

      if (promptCaps.embeddedContext && isTextMime(mime)) {
        blocks.push({
          type: "resource",
          resource: {
            uri: uri.toString(),
            mimeType: mime,
            text: Buffer.from(bytes).toString("utf8"),
          },
        });
        continue;
      }

      blocks.push({ type: "text", text: `Attached file: ${uri.fsPath}` });
    }

    return blocks;
  }

  /** Stage files to send with the next prompt. */
  private async pickAttachments(controller: ManagedSession): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: "Attach",
      title: "Attach files to the next prompt",
    });
    if (!picked?.length) return;
    controller.attachments.push(...picked);
    this.postAttachments(controller);
  }

  /**
   * Show the oldest outstanding request, and say how many are behind it.
   *
   * The agent may be blocked on several at once; the count is what tells the
   * user more work is waiting rather than the panel having gone quiet.
   */
  private postPending(controller: ManagedSession): void {
    if (!this.isActive(controller)) return;
    this.post({
      type: "pending",
      request: controller.currentRequest,
      pendingCount: controller.pending.length,
    });
  }

  private postAttachments(controller: ManagedSession): void {
    if (!this.isActive(controller)) return;
    this.post({
      type: "attachments",
      names: controller.attachments.map((uri) => uri.path.split("/").pop() ?? uri.fsPath),
    });
  }

  private async cancelTurn(controller: ManagedSession): Promise<void> {
    const sessionId = controller.sessionId;
    if (!sessionId) return;
    controller.abort?.abort();
    controller.session.cancelPending();
    controller.pending = [];
    try {
      await controller.connection.agent.cancel({ sessionId });
    } catch {
      // The agent may already have finished; cancelling a settled turn is fine.
    }
    // Keep the composer locked until the outstanding prompt promise settles.
    // ACP cancellation is asynchronous; accepting another prompt immediately
    // can overlap work on agents that serialise requests per session.
    this.setBusy(controller, controller.inFlightPrompts > 0);
  }

  private async setMode(controller: ManagedSession, modeId: string): Promise<void> {
    const sessionId = controller.sessionId;
    if (!sessionId) return;
    // Mode switching is optional in ACP; not every agent implements it.
    if (!controller.connection.agent.setSessionMode) {
      this.post({ type: "error", message: "This agent does not support mode switching." });
      return;
    }
    try {
      await controller.connection.agent.setSessionMode({ sessionId, modeId });
      controller.session.currentMode = modeId;
      if (this.isActive(controller)) await this.pushState(controller.session.modes, modeId);
    } catch (error) {
      this.post({ type: "error", message: `Could not switch mode: ${String(error)}` });
    }
  }

  // --- loading past conversations ------------------------------------------

  /** Public entry point for the Sessions tree. */
  async loadSessionById(sessionId: string): Promise<void> {
    // A conversation already running in this window just needs revealing.
    const live = [...this.sessions.values()].find((entry) => entry.sessionId === sessionId);
    if (live) {
      await this.activate(live);
      return;
    }

    const stored = await this.store.load(sessionId);
    const meta = stored ?? (await this.store.meta(sessionId));
    if (!meta) {
      this.post({ type: "error", message: "That saved session no longer exists." });
      return;
    }
    const connection = await this.ensureConnection(meta.agentKey);
    if (!connection) return;
    await this.loadSession(connection, sessionId, stored);
  }

  /**
   * Reopen a past conversation in its own controller.
   *
   * When the agent supports `session/load` it replays its own history through
   * `session/update`, which restores the agent's context as well as the
   * transcript. Otherwise we fall back to the stored transcript, which is
   * display-only: the agent has no memory of it.
   */
  private async loadSession(
    connection: AgentConnection,
    sessionId: string,
    stored?: StoredSession,
    options: { announce?: boolean } = {},
  ): Promise<ManagedSession | undefined> {
    // A conversation already open in this window must not be duplicated.
    const existing = [...this.sessions.values()].find((entry) => entry.sessionId === sessionId);
    if (existing) return existing;

    const announce = options.announce ?? true;
    const controller = this.createController(connection);
    controller.title = stored?.title ?? "Loaded session";

    if (connection.agent.loadSession && connection.capabilities.loadSession) {
      controller.session.setTurns([]);
      // Register before the call: `session/load` replays history through
      // `session/update` while the request is still in flight.
      controller.adoptSessionId(sessionId);
      try {
        const response = await connection.agent.loadSession({
          sessionId,
          cwd: this.workspaceRoot(),
          mcpServers: this.mcpServers(connection),
          ...this.additionalDirectories(connection),
        });
        this.applySessionSetup(controller, response ?? undefined);
        await this.activate(controller);
        return controller;
      } catch (error) {
        if (announce) {
          this.post({
            type: "error",
            message: `Agent could not reload the session (${String(error)}); showing the saved transcript instead.`,
          });
        }
      }
    }

    if (connection.agent.resumeSession && connection.capabilities.resumeSession) {
      controller.adoptSessionId(sessionId);
      try {
        const response = await connection.agent.resumeSession({
          sessionId,
          cwd: this.workspaceRoot(),
          mcpServers: this.mcpServers(connection),
          ...this.additionalDirectories(connection),
        });
        controller.session.setTurns(stored?.turns ?? []);
        this.applySessionSetup(controller, response);
        await this.activate(controller);
        if (!stored && announce) {
          this.post({
            type: "error",
            message: "Session context resumed. This agent does not provide its prior transcript, so only new messages will appear here.",
          });
        }
        return controller;
      } catch (error) {
        if (announce) {
          this.post({
            type: "error",
            message: `Agent could not resume the session (${String(error)}); showing the saved transcript instead.`,
          });
        }
      }
    }

    const local = stored ?? (await this.store.load(sessionId));
    if (!local) {
      this.removeController(controller);
      return undefined;
    }
    // A transcript is useful to inspect but it must never be mistaken for a
    // live ACP session: prompts would otherwise target whichever session was
    // active before the load. Clearing the id makes this state read-only.
    controller.adoptSessionId(null);
    controller.readOnly = true;
    controller.session.setTurns(local.turns);
    await this.activate(controller);
    if (announce) {
      this.post({
        type: "error",
        message: "Showing a saved transcript only; this agent cannot restore its context. Start a new session to continue.",
      });
    }
    return controller;
  }

  private applySessionSetup(
    controller: ManagedSession,
    response: {
      modes?: { availableModes: { id: string; name: string; description?: string | null }[]; currentModeId: string } | null;
      configOptions?: unknown;
    } | undefined,
  ): void {
    if (response?.modes) {
      controller.session.modes = response.modes.availableModes.map((mode) => ({
        id: mode.id,
        name: mode.name,
        description: mode.description ?? undefined,
      }));
      controller.session.currentMode = response.modes.currentModeId;
    }
    if (response?.configOptions) controller.configOptions = mapConfigOptions(response.configOptions);
  }

  /**
   * Put this agent's remembered choices back on a fresh session.
   *
   * Only the ones that actually differ are sent: re-applying a value the agent
   * already holds costs a round trip and, on some agents, resets dependent
   * options. Failures are logged rather than surfaced — the session is usable
   * at the agent's own defaults, which is not worth an error banner.
   */
  private async applySavedOptions(controller: ManagedSession): Promise<void> {
    const agent = controller.connection.agent;
    const sessionId = controller.sessionId;
    if (!agent.setSessionConfigOption || !sessionId) return;

    for (const { id, value } of this.preferences.pendingOptions(
      controller.agentKey,
      controller.configOptions,
    )) {
      try {
        const response = await agent.setSessionConfigOption({ sessionId, configId: id, value } as never);
        const returned = mapConfigOptions(response?.configOptions);
        controller.configOptions = returned.length
          ? returned
          : controller.configOptions.map((option) =>
              option.id === id ? { ...option, currentValue: value } : option,
            );
      } catch (error) {
        this.output.appendLine(
          `[${controller.agentKey}] could not restore ${id}: ${String(error)}`,
        );
      }
    }
  }

  /** Branch the current conversation, leaving the original untouched. */
  private async forkSession(controller: ManagedSession): Promise<void> {
    const agent = controller.connection.agent;
    if (!agent.unstable_forkSession || !controller.sessionId) {
      this.post({ type: "error", message: "This agent does not support forking sessions." });
      return;
    }
    try {
      const forked = await agent.unstable_forkSession({
        sessionId: controller.sessionId,
        cwd: this.workspaceRoot(),
        ...this.additionalDirectories(controller.connection),
      });
      // The transcript so far carries over; only the id diverges.
      controller.adoptSessionId(forked.sessionId);
      await this.persistSession(controller);
      await this.pushState();
    } catch (error) {
      this.post({ type: "error", message: `Fork failed: ${String(error)}` });
    }
  }

  private async deleteSession(sessionId: string): Promise<void> {
    const live = [...this.sessions.values()].find((entry) => entry.sessionId === sessionId);
    // Ask the agent that owns the session, never whichever one happens to be
    // on screen: session ids are only meaningful to their own agent.
    const owner = live?.agentKey ?? (await this.store.meta(sessionId))?.agentKey;
    const connection = owner ? this.connections.get(owner) : undefined;
    if (connection?.agent.deleteSession && connection.capabilities.deleteSession) {
      // Best effort: the local copy goes regardless of what the agent says.
      try {
        await connection.agent.deleteSession({ sessionId });
      } catch {
        // The agent may not know this id; the local copy still goes.
      }
    }
    await this.store.delete(sessionId);
    this.unrestored = this.unrestored.filter((entry) => entry.sessionId !== sessionId);
    if (live) {
      const wasActive = this.isActive(live);
      this.removeController(live);
      if (wasActive) {
        const next = [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0];
        if (next) await this.activate(next);
        else await this.newSession(connection);
        return;
      }
    }
    this.onSessionsChanged();
    await this.pushState();
  }

  private async persistSession(controller: ManagedSession): Promise<void> {
    if (!controller.sessionId) return;
    const turns = controller.session.getTurns();
    if (turns.length === 0) return;

    controller.title = deriveTitle(turns);
    await this.store.save({
      sessionId: controller.sessionId,
      agentKey: controller.agentKey,
      title: controller.title,
      updatedAt: Date.now(),
      turns,
    });
    this.onSessionsChanged();
  }

  // --- view plumbing -------------------------------------------------------

  private publishTurns(): void {
    this.onTurnsChanged(this.active()?.session.getTurns() ?? []);
  }

  private setBusy(controller: ManagedSession, busy: boolean): void {
    controller.busy = busy;
    controller.refreshLifecycle();
    if (this.isActive(controller)) this.post({ type: "busy", busy });
  }

  private async pushState(
    modes?: ModeOption[],
    currentMode?: string | null,
  ): Promise<void> {
    const controller = this.active();
    const connection = controller?.connection;
    const state: ViewState = {
      agents: Object.keys(this.agentDefinitions()),
      currentAgent: controller?.agentKey ?? this.lastAgentKey,
      sessionId: controller?.sessionId ?? null,
      turns: controller?.session.getTurns() ?? [],
      busy: controller?.busy ?? false,
      pending: controller?.currentRequest ?? null,
      pendingCount: controller?.pending.length ?? 0,
      modes: modes ?? controller?.session.modes ?? [],
      currentMode: currentMode ?? controller?.session.currentMode ?? null,
      sessions: await this.store.list(),
      capabilities: connection?.capabilities ?? ({ ...NO_CAPABILITIES } as Capabilities),
      usage: controller?.usage ?? null,
      configOptions: controller?.configOptions ?? [],
      commands: controller?.commands ?? [],
      plan: controller?.plan ?? [],
      queued: controller?.queue ?? [],
      promptCapabilities: connection?.promptCaps ?? { image: false, audio: false, embeddedContext: false },
      liveSessions: this.liveSessions(),
      permissionMode: this.permissionMode(controller?.agentKey ?? this.lastAgentKey ?? undefined),
    };
    this.post({ type: "state", state });
    this.rememberSessions();
    this.publishTurns();
    if (controller) this.postAttachments(controller);
  }

  private post(message: HostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  dispose(): void {
    for (const agentKey of [...this.connections.keys()]) this.disconnect(agentKey);
    this.sessions.clear();
    this.activeId = null;
  }

  private html(webview: vscode.Webview): string {
    const asset = (...parts: string[]) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...parts));

    const script = asset("out", "webview", "main.js");
    const style = asset("out", "webview", "style.css");
    const nonce = Buffer.from(crypto.randomUUID()).toString("base64").slice(0, 16);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src data:; media-src data:;" />
<link rel="stylesheet" href="${style}" />
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

export type { Turn, Block };

/** How many conversations a reload will reopen before stopping. */
interface RestorableSession {
  agentKey: string;
  sessionId: string;
}

function isRestorableSession(value: unknown): value is RestorableSession {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<RestorableSession>;
  return typeof entry.agentKey === "string" && typeof entry.sessionId === "string";
}

function lifecycleIcon(state: SessionLifecycle): string {
  switch (state) {
    case "running": return "$(sync~spin)";
    case "awaiting-approval": return "$(question)";
    case "error": return "$(error)";
    case "disconnected": return "$(debug-disconnect)";
    default: return "$(comment-discussion)";
  }
}

function lifecycleLabel(state: SessionLifecycle): string {
  switch (state) {
    case "running": return "running";
    case "awaiting-approval": return "needs approval";
    case "error": return "error";
    case "disconnected": return "disconnected";
    default: return "idle";
  }
}

/** Normalise optional ACP list metadata into the compact local catalog shape. */
function sessionMeta(session: SessionInfo, agentKey: string): SessionMeta {
  const timestamp = session.updatedAt ? Date.parse(session.updatedAt) : 0;
  return {
    sessionId: session.sessionId,
    agentKey,
    title: session.title?.trim() || "Untitled session",
    updatedAt: Number.isFinite(timestamp) ? timestamp : 0,
  };
}

/** Normalise the agent's config options into the shape the webview renders. */
function mapConfigOptions(raw: unknown): ConfigOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): ConfigOption[] => {
    const option = entry as {
      id?: string;
      name?: string;
      description?: string | null;
      category?: string | null;
      type?: string;
      currentValue?: unknown;
      options?: { value?: string; name?: string; description?: string | null }[];
    };
    if (!option.id || !option.name) return [];

    return [
      {
        id: option.id,
        name: option.name,
        description: option.description ?? undefined,
        category: option.category ?? undefined,
        type: option.type === "boolean" ? "boolean" : "select",
        currentValue:
          typeof option.currentValue === "string" || typeof option.currentValue === "boolean"
            ? option.currentValue
            : null,
        options: (option.options ?? []).flatMap((choice) =>
          choice.value
            ? [
                {
                  value: choice.value,
                  name: choice.name ?? choice.value,
                  description: choice.description ?? undefined,
                },
              ]
            : [],
        ),
      },
    ];
  });
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  flac: "audio/flac",
  json: "application/json",
  md: "text/markdown",
};

function mimeFor(filePath: string): string {
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

function isTextMime(mime: string): boolean {
  return mime.startsWith("text/") || mime === "application/json";
}
