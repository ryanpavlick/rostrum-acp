/**
 * One live agent process and everything multiplexed over it.
 *
 * A connection is shared by every session running on that agent: the ACP
 * handshake, the negotiated capabilities and the callback router are
 * per-process, while transcripts and turn state are per-session.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import type { Agent, InitializeResponse } from "@agentclientprotocol/sdk";
import type { Capabilities } from "../shared/protocol.js";
import { NO_CAPABILITIES, readCapabilities } from "./capabilities.js";
import {
  launchAgent,
  launchPersistentAgent,
  type AgentDefinition,
  type AgentHandle,
} from "./agentProcess.js";
import { SessionRouter } from "./router.js";
import type { ManagedSession } from "./managedSession.js";

export interface PromptCapabilities {
  image: boolean;
  audio: boolean;
  embeddedContext: boolean;
}

export interface McpCapabilities {
  http: boolean;
  sse: boolean;
}

/** Long enough for an `npx` adapter to fetch its package on first run. */
const HANDSHAKE_TIMEOUT_MS = 60_000;

export const CLIENT_CAPABILITIES = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
  plan: {},
  elicitation: { form: {} },
  session: { configOptions: { boolean: {} } },
} as const;

/**
 * Identify a supervised agent process by what actually determines its
 * behaviour: the normalised workspace plus the effective launch definition.
 *
 * Keying on the agent's display name alone would let an edited command, env or
 * cwd silently reattach to a process still running the previous definition.
 */
export function connectionKey(
  agentKey: string,
  workspaceRoot: string,
  definition: AgentDefinition,
): string {
  const normalizedRoot = path.resolve(workspaceRoot);
  const fingerprint = JSON.stringify({
    agentKey,
    root: process.platform === "win32" ? normalizedRoot.toLowerCase() : normalizedRoot,
    command: definition.command,
    args: definition.args ?? [],
    env: Object.fromEntries(Object.entries(definition.env ?? {}).sort(([a], [b]) => a.localeCompare(b))),
    cwd: definition.cwd ? path.resolve(definition.cwd) : null,
  });
  return `${agentKey}-${createHash("sha256").update(fingerprint).digest("hex").slice(0, 32)}`;
}

export class AgentConnection {
  readonly router: SessionRouter;
  readonly sessions = new Set<ManagedSession>();
  capabilities: Capabilities = { ...NO_CAPABILITIES };
  promptCaps: PromptCapabilities = { image: false, audio: false, embeddedContext: false };
  mcpCaps: McpCapabilities = { http: false, sse: false };
  initialize: InitializeResponse | undefined;
  /** Whether the process is owned by the detached supervisor. */
  persistent: boolean;
  /** True once the process is gone or the connection was torn down. */
  disposed = false;
  /** Set when the agent exits on its own rather than at our request. */
  exitCode: number | null | undefined;

  /**
   * Whether this connection can still carry traffic.
   *
   * An agent that exited on its own is just as dead as one we disposed, and
   * anything recomputing session state has to see that — otherwise a session
   * whose agent is gone reports itself idle the moment it stops being busy.
   */
  get alive(): boolean {
    return !this.disposed && this.exitCode === undefined;
  }

  /**
   * Bytes the supervisor discarded while no window was attached.
   *
   * Non-zero means this connection resumed a stream with a hole in it, which
   * the user is told about rather than left to infer from a gap.
   */
  get droppedBytes(): number {
    return this.handle.droppedBytes ?? 0;
  }

  private constructor(
    readonly key: string,
    readonly agentKey: string,
    readonly definition: AgentDefinition,
    persistent: boolean,
    private handle: AgentHandle,
    router: SessionRouter,
  ) {
    this.router = router;
    this.persistent = persistent;
  }

  /**
   * Wrap an ACP transport in a connection.
   *
   * The router is built first and handed to `launch`, because the SDK takes
   * the client at construction time and the client must already be able to
   * demultiplex across sessions. Tests supply their own `launch` to drive the
   * provider without spawning a process.
   */
  static async attach(options: {
    agentKey: string;
    key: string;
    definition: AgentDefinition;
    persistent: boolean;
    onUnroutable: (method: string, sessionId: string | undefined) => void;
    launch: (client: () => SessionRouter) => AgentHandle | Promise<AgentHandle>;
  }): Promise<AgentConnection> {
    const router = new SessionRouter(options.onUnroutable);
    const handle = await options.launch(() => router);
    return new AgentConnection(
      options.key,
      options.agentKey,
      options.definition,
      options.persistent,
      handle,
      router,
    );
  }

  get agent(): Agent {
    return this.handle.agent;
  }

  get exited(): Promise<number | null> {
    return this.handle.exited;
  }

  /**
   * Start, or reattach to, the agent process.
   *
   * The supervisor is tried first so the agent outlives the window; a direct
   * child process is the fallback when it cannot be reached, which keeps the
   * extension usable in environments where the supervisor cannot run.
   */
  static async connect(options: {
    agentKey: string;
    definition: AgentDefinition;
    workspaceRoot: string;
    managerScript: string;
    stateFile: string;
    supervisorPort?: number;
    onUnroutable: (method: string, sessionId: string | undefined) => void;
    onStderr: (chunk: string) => void;
    log: (message: string) => void;
  }): Promise<AgentConnection> {
    const definition = { ...options.definition, cwd: options.definition.cwd ?? options.workspaceRoot };
    const key = connectionKey(options.agentKey, options.workspaceRoot, definition);

    let persistent = true;
    const connection = await AgentConnection.attach({
      agentKey: options.agentKey,
      key,
      definition,
      persistent: true,
      onUnroutable: options.onUnroutable,
      launch: async (client) => {
        try {
          return await launchPersistentAgent(
            definition,
            {
              managerScript: options.managerScript,
              stateFile: options.stateFile,
              key,
              agentKey: options.agentKey,
            },
            client,
          );
        } catch (error) {
          options.log(
            `Persistent manager unavailable; launching ${options.agentKey} directly: ${String(error)}`,
          );
          persistent = false;
          return launchAgent(definition, client, (chunk) => {
            connection.noteStderr(chunk);
            options.onStderr(chunk);
          });
        }
      },
    });
    // The supervisor may be unreachable; `launch` records which path was taken.
    connection.persistent = persistent;
    return connection;
  }

  /**
   * The last of the agent's own stderr, kept for when the handshake stalls.
   * An agent that blocks on credentials or a trust prompt says so there and
   * nowhere else — it never answers on the protocol at all.
   */
  private stderrTail = "";

  /**
   * An agent that starts but never answers `initialize` would otherwise hang
   * the panel with no error and nothing to act on. Observed with an
   * unauthenticated Gemini CLI, which blocks waiting for a credential rather
   * than exiting. The bound is generous because an adapter launched through
   * `npx` may be downloading its package on first run.
   */
  private async withHandshakeTimeout<T>(work: T | Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve(work),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const tail = this.stderrTail.trim().split("\n").filter(Boolean).slice(-4).join("\n");
            reject(
              new Error(
                `${this.agentKey} did not answer the ACP handshake within ${Math.round(timeoutMs / 1000)}s. ` +
                  "It may be waiting for authentication, or for a trust prompt that cannot be answered here." +
                  (tail ? `\n\nLast output from the agent:\n${tail}` : ""),
              ),
            );
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  noteStderr(chunk: string): void {
    this.stderrTail = (this.stderrTail + chunk).slice(-2000);
  }

  /** Perform (or adopt the supervisor's cached) ACP handshake. */
  async handshake(timeoutMs = HANDSHAKE_TIMEOUT_MS): Promise<InitializeResponse> {
    const init =
      this.handle.initialize ??
      (await this.withHandshakeTimeout(
        this.agent.initialize({ protocolVersion: 1, clientCapabilities: CLIENT_CAPABILITIES }),
        timeoutMs,
      ));
    this.initialize = init;
    this.capabilities = readCapabilities(init.agentCapabilities, this.agent);
    const prompt = init.agentCapabilities?.promptCapabilities;
    this.promptCaps = {
      image: prompt?.image === true,
      audio: prompt?.audio === true,
      embeddedContext: prompt?.embeddedContext === true,
    };
    this.mcpCaps = {
      http: init.agentCapabilities?.mcpCapabilities?.http === true,
      sse: init.agentCapabilities?.mcpCapabilities?.sse === true,
    };
    return init;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const session of this.sessions) session.dispose();
    this.sessions.clear();
    this.handle.dispose();
  }
}
