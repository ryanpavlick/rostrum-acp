/**
 * Demultiplexes one agent connection's client-side ACP callbacks across many
 * concurrent sessions.
 *
 * A `ClientSideConnection` takes a single `Client`, so before this router the
 * extension could only ever hold one live `Session` per agent process: every
 * `session/update` landed on whichever `Session` happened to be wired up.
 * Every client-bound ACP request carries `sessionId`, so the router can hand
 * each callback to the `Session` that owns it and let sessions run in
 * parallel on one agent.
 */
import type {
  Client,
  CreateTerminalRequest,
  KillTerminalRequest,
  ReadTextFileRequest,
  ReleaseTerminalRequest,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  TerminalOutputRequest,
  WaitForTerminalExitRequest,
  WriteTextFileRequest,
} from "@agentclientprotocol/sdk";
import type { Session } from "./session.js";

/** `session/elicit` is session-scoped or request-scoped; only the former routes. */
type ElicitationRequest = { sessionId?: string } & Record<string, unknown>;

export class SessionRouter implements Client {
  private readonly bySessionId = new Map<string, Session>();
  /**
   * Receives callbacks that arrive before `session/new` has returned an id.
   * Agents are permitted to stream updates for a session they have already
   * minted internally while the request is still in flight.
   */
  private provisional: Session | undefined;

  constructor(private readonly onUnroutable: (method: string, sessionId: string | undefined) => void) {}

  register(sessionId: string, session: Session): void {
    this.bySessionId.set(sessionId, session);
    if (this.provisional === session) this.provisional = undefined;
  }

  unregister(sessionId: string): void {
    this.bySessionId.delete(sessionId);
  }

  /** Re-key a session whose id changed, as a fork does. */
  rekey(oldSessionId: string | null, newSessionId: string, session: Session): void {
    if (oldSessionId) this.bySessionId.delete(oldSessionId);
    this.register(newSessionId, session);
  }

  setProvisional(session: Session | undefined): void {
    this.provisional = session;
  }

  get size(): number {
    return this.bySessionId.size;
  }

  sessions(): Session[] {
    return [...this.bySessionId.values()];
  }

  /**
   * Pick the session a callback belongs to.
   *
   * An unknown id while a `session/new` is in flight means the agent started
   * reporting before it answered, so the provisional session is the only
   * candidate. A single registered session absorbs id-less callbacks from
   * agents that omit the field.
   */
  private route(sessionId: string | undefined, method: string): Session | undefined {
    if (sessionId) {
      const known = this.bySessionId.get(sessionId);
      if (known) return known;
    }
    if (this.provisional) return this.provisional;
    if (this.bySessionId.size === 1) return this.bySessionId.values().next().value;
    this.onUnroutable(method, sessionId);
    return undefined;
  }

  private require(sessionId: string | undefined, method: string): Session {
    const session = this.route(sessionId, method);
    if (!session) throw new Error(`No live session for ${method} (sessionId: ${sessionId ?? "absent"})`);
    return session;
  }

  // --- ACP Client ----------------------------------------------------------

  async sessionUpdate(params: SessionNotification): Promise<void> {
    // A notification has no reply, so an unroutable update is dropped rather
    // than thrown: throwing here would surface as an unhandled rejection.
    await this.route(params.sessionId, "session/update")?.sessionUpdate(params);
  }

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const session = this.route(params.sessionId, "session/request_permission");
    // Never auto-approve on our own initiative: an unroutable ask is cancelled.
    if (!session) return { outcome: { outcome: "cancelled" } };
    return session.requestPermission(params);
  }

  async readTextFile(params: ReadTextFileRequest): Promise<{ content: string }> {
    return this.require(params.sessionId, "fs/read_text_file").readTextFile(params);
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<void> {
    return this.require(params.sessionId, "fs/write_text_file").writeTextFile(params);
  }

  async createTerminal(params: CreateTerminalRequest): Promise<{ terminalId: string }> {
    return this.require(params.sessionId, "terminal/create").createTerminal(params);
  }

  async terminalOutput(params: TerminalOutputRequest) {
    return this.require(params.sessionId, "terminal/output").terminalOutput(params);
  }

  async waitForTerminalExit(params: WaitForTerminalExitRequest) {
    return this.require(params.sessionId, "terminal/wait_for_exit").waitForTerminalExit(params);
  }

  async killTerminal(params: KillTerminalRequest): Promise<void> {
    return this.require(params.sessionId, "terminal/kill").killTerminal(params);
  }

  async releaseTerminal(params: ReleaseTerminalRequest): Promise<void> {
    return this.require(params.sessionId, "terminal/release").releaseTerminal(params);
  }

  async createElicitation(params: ElicitationRequest) {
    const session = this.route(params.sessionId, "session/elicit");
    if (!session) return { action: "decline" as const };
    return session.createElicitation(params as never);
  }
}
