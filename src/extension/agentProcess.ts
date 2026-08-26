import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  type Agent,
  type Client,
  type InitializeResponse,
} from "@agentclientprotocol/sdk";
import type { McpServerDefinition } from "./mcp.js";

export interface AgentDefinition {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Agent-specific MCP servers, merged over the global Rostrum setting. */
  mcpServers?: Record<string, McpServerDefinition>;
}

export interface AgentHandle {
  agent: Agent;
  /** Resolves when the child exits. */
  exited: Promise<number | null>;
  /** Cached handshake when attaching to a supervisor-owned process. */
  initialize?: InitializeResponse;
  /**
   * Agent output the supervisor discarded while nothing was attached, so the
   * client can say the transcript has a hole rather than pretend otherwise.
   */
  droppedBytes?: number;
  dispose(): void;
}

/** Where the supervisor publishes its address, token and registry. */
export function managerStateFile(globalStoragePath: string): string {
  return `${globalStoragePath}/agent-manager.json`;
}

export interface PersistentAgentOptions {
  managerScript: string;
  stateFile: string;
  key: string;
  /** Display name, so supervisor status can name the agent, not just its hash. */
  agentKey?: string;
  /** Pin the supervisor to a port; 0 or omitted picks a free one. */
  port?: number;
}

/** One supervised agent, as the supervisor describes it. */
export interface ManagedAgentStatus {
  key: string;
  agentKey: string;
  pid: number | null;
  command: string;
  args: string[];
  cwd: string | null;
  startedAt: number;
  alive: boolean;
  attached: boolean;
  attachments: number;
  pendingBytes: number;
  droppedBytes: number;
  stderrLines: number;
}

export interface ManagerStatus {
  pid: number;
  startedAt: number;
  agents: ManagedAgentStatus[];
}

/**
 * Attach to the detached supervisor, starting it on demand.
 *
 * A state file can outlive the process that wrote it — a machine restart, a
 * killed supervisor. When attaching to the recorded address fails the state is
 * treated as stale: it is removed, a fresh supervisor is started, and the
 * attach is retried once before giving up to the direct-launch fallback.
 */
export async function launchPersistentAgent(
  definition: AgentDefinition,
  options: PersistentAgentOptions,
  toClient: (agent: Agent) => Client,
): Promise<AgentHandle> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const state = await ensureManager(options);
    try {
      const socket = await attach(state, options, definition);
      const stream = ndJsonStream(
        Writable.toWeb(socket) as WritableStream<Uint8Array>,
        Readable.toWeb(socket) as ReadableStream<Uint8Array>,
      );
      return {
        agent: new ClientSideConnection(toClient, stream),
        initialize: socket.initialize,
        droppedBytes: socket.droppedBytes,
        exited: new Promise((resolve) => socket.once("close", () => resolve(null))),
        dispose: () => socket.destroy(),
      };
    } catch (error) {
      lastError = error;
      // The recorded supervisor did not answer; drop the state and respawn.
      await fs.rm(options.stateFile, { force: true }).catch(() => undefined);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Return the running supervisor's state, starting one if none answers. */
async function ensureManager(options: PersistentAgentOptions): Promise<ManagerState> {
  let state = await managerState(options.stateFile);
  if (state) return state;

  const manager = spawn(
    process.execPath,
    [options.managerScript, options.stateFile, String(options.port ?? 0)],
    { detached: true, stdio: "ignore" },
  );
  manager.unref();
  for (let attempt = 0; attempt < 40 && !state; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    state = await managerState(options.stateFile);
  }
  if (!state) throw new Error("Persistent agent manager did not start");
  return state;
}

type ManagerState = { port: number; token: string };

async function managerState(file: string): Promise<ManagerState | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8")) as ManagerState;
    return typeof value.port === "number" && typeof value.token === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Send one control request to the supervisor and read its single-line reply.
 *
 * Returns `undefined` when no supervisor is running, which callers report as
 * "nothing supervised" rather than as an error.
 */
async function control<T>(stateFile: string, request: Record<string, unknown>): Promise<T | undefined> {
  const state = await managerState(stateFile);
  if (!state) return undefined;
  return new Promise<T | undefined>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: state.port });
    let received = Buffer.alloc(0);
    const settle = (value: T | undefined) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(2000, () => settle(undefined));
    socket.once("error", () => settle(undefined));
    socket.once("connect", () =>
      socket.write(`${JSON.stringify({ ...request, token: state.token })}\n`),
    );
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf(10);
      if (newline < 0) return;
      try {
        settle(JSON.parse(received.subarray(0, newline).toString("utf8")) as T);
      } catch {
        settle(undefined);
      }
    });
    socket.once("close", () => resolve(undefined));
  });
}

/** What the supervisor is currently running, or `undefined` if it is not up. */
export function managerStatus(stateFile: string): Promise<ManagerStatus | undefined> {
  return control<ManagerStatus>(stateFile, { type: "status" });
}

/** Recent supervisor-captured stderr for one agent. */
export async function managerLogs(stateFile: string, key: string, limit?: number): Promise<string[]> {
  const reply = await control<{ lines?: string[] }>(stateFile, { type: "logs", key, limit });
  return reply?.lines ?? [];
}

/** Stop one supervised agent, or the whole supervisor when no key is given. */
export function managerStop(
  stateFile: string,
  key?: string,
): Promise<{ stopped?: number; remaining?: number } | undefined> {
  return control(stateFile, { type: "stop", ...(key ? { key } : {}) });
}

type ManagedSocket = net.Socket & { initialize?: InitializeResponse; droppedBytes?: number };

function attach(
  state: ManagerState,
  options: PersistentAgentOptions,
  definition: AgentDefinition,
): Promise<ManagedSocket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: state.port }) as ManagedSocket;
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(5000, () => fail(new Error("Supervisor did not answer the attach request")));
    socket.once("error", reject);
    socket.once("connect", () =>
      socket.write(
        `${JSON.stringify({
          type: "attach",
          token: state.token,
          key: options.key,
          agentKey: options.agentKey ?? options.key,
          definition,
        })}\n`,
      ),
    );

    let received = Buffer.alloc(0);
    socket.on("data", function first(chunk: Buffer) {
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf(10);
      if (newline < 0) return;
      socket.off("data", first);
      try {
        const reply = JSON.parse(received.subarray(0, newline).toString("utf8")) as {
          type?: string;
          initialize?: InitializeResponse;
          droppedBytes?: number;
        };
        if (reply.type !== "attached") throw new Error("Manager rejected attachment");
        socket.setTimeout(0);
        socket.initialize = reply.initialize;
        socket.droppedBytes = reply.droppedBytes ?? 0;
        // Anything after the reply line is already ACP traffic.
        const rest = received.subarray(newline + 1);
        if (rest.length) socket.unshift(rest);
        resolve(socket);
      } catch (error) {
        socket.destroy();
        reject(error);
      }
    });
  });
}

/**
 * Launch an ACP agent as a child process and wrap its stdio in a client-side
 * connection.
 *
 * ACP frames are newline-delimited JSON on stdin/stdout, so stdout must never
 * be polluted by the agent's own logging — anything on stderr is surfaced via
 * `onStderr` instead of being parsed.
 */
export function launchAgent(
  definition: AgentDefinition,
  toClient: (agent: Agent) => Client,
  onStderr: (chunk: string) => void,
): AgentHandle {
  const child: ChildProcessWithoutNullStreams = spawn(
    definition.command,
    definition.args ?? [],
    {
      cwd: definition.cwd,
      env: { ...process.env, ...definition.env },
      stdio: ["pipe", "pipe", "pipe"],
      // Keep the agent off the extension host's controlling terminal.
      shell: false,
    },
  );

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => onStderr(chunk));

  // `Writable.toWeb`/`Readable.toWeb` do not install Node-style error
  // listeners. Without these, closing a child during teardown can surface as
  // an unhandled stream error even though the ACP connection has already
  // handled the close. The connection below owns protocol-level failures; the
  // listeners simply make process teardown safe.
  child.stdin.on("error", () => undefined);
  child.stdout.on("error", () => undefined);
  child.stderr.on("error", () => undefined);

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );

  const agent = new ClientSideConnection(toClient, stream);

  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });

  return {
    agent,
    exited,
    dispose() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        // Escalate if the agent ignores a polite shutdown.
        const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
        void exited.then(() => clearTimeout(timer));
      }
    },
  };
}
