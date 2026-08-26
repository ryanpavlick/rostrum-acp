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
  dispose(): void;
}

export interface PersistentAgentOptions { managerScript: string; stateFile: string; key: string }

/** Attach to the detached supervisor, starting it on demand. */
export async function launchPersistentAgent(
  definition: AgentDefinition,
  options: PersistentAgentOptions,
  toClient: (agent: Agent) => Client,
): Promise<AgentHandle> {
  let state = await managerState(options.stateFile);
  if (!state) {
    const manager = spawn(process.execPath, [options.managerScript, options.stateFile], { detached: true, stdio: "ignore" });
    manager.unref();
    for (let attempt = 0; attempt < 40 && !state; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      state = await managerState(options.stateFile);
    }
  }
  if (!state) throw new Error("Persistent agent manager did not start");
  const socket = await attach(state, options.key, definition);
  const stream = ndJsonStream(
    Writable.toWeb(socket) as WritableStream<Uint8Array>,
    Readable.toWeb(socket) as ReadableStream<Uint8Array>,
  );
  const agent = new ClientSideConnection(toClient, stream);
  return { agent, initialize: socket.initialize, exited: new Promise((resolve) => socket.once("close", () => resolve(null))), dispose: () => socket.destroy() };
}

type ManagerState = { port: number; token: string };
async function managerState(file: string): Promise<ManagerState | undefined> {
  try { const value = JSON.parse(await fs.readFile(file, "utf8")) as ManagerState; return typeof value.port === "number" && typeof value.token === "string" ? value : undefined; } catch { return undefined; }
}
type ManagedSocket = net.Socket & { initialize?: InitializeResponse };
function attach(state: ManagerState, key: string, definition: AgentDefinition): Promise<ManagedSocket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: state.port }) as ManagedSocket;
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify({ type: "attach", token: state.token, key, definition })}\n`));
    let received = Buffer.alloc(0);
    socket.on("data", function first(chunk: Buffer) {
      received = Buffer.concat([received, chunk]); const newline = received.indexOf(10); if (newline < 0) return;
      socket.off("data", first); try {
        const reply = JSON.parse(received.subarray(0, newline).toString("utf8")) as { type?: string; initialize?: InitializeResponse };
        if (reply.type !== "attached") throw new Error("Manager rejected attachment");
        socket.initialize = reply.initialize; const rest = received.subarray(newline + 1); if (rest.length) socket.unshift(rest); resolve(socket);
      } catch (error) { socket.destroy(); reject(error); }
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
