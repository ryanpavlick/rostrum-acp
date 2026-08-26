/**
 * Detached local ACP supervisor.
 *
 * It owns agent stdio and relays raw ACP NDJSON to whichever extension host is
 * currently attached, so an agent outlives a window reload. The process is
 * loopback only and each manager instance has an unguessable token in its
 * state file.
 *
 * The same socket carries a small control protocol beside `attach`, so the
 * extension can report what is running, read an agent's recent stderr, and
 * shut things down cleanly.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";

interface AgentDefinition {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

type Request =
  | { type: "attach"; token: string; key: string; agentKey?: string; definition: AgentDefinition }
  | { type: "ping"; token: string }
  | { type: "status"; token: string }
  | { type: "logs"; token: string; key: string; limit?: number }
  | { type: "stop"; token: string; key?: string };

interface Managed {
  key: string;
  agentKey: string;
  child: ChildProcessWithoutNullStreams;
  definition: AgentDefinition;
  startedAt: number;
  client?: net.Socket;
  /** Agent output held for the next attachment, with its size tracked. */
  pending: Buffer[];
  pendingBytes: number;
  /** How much output was discarded because nobody was attached. */
  droppedBytes: number;
  stderr: string[];
  stderrBytes: number;
  initRequestId?: string | number;
  initialize?: unknown;
  attachments: number;
}

/** Output held for an unattended agent, so it cannot consume unbounded RAM. */
const MAX_PENDING_BYTES = 1_048_576;
/** Recent supervisor-side stderr kept per agent for the output channel. */
const MAX_STDERR_BYTES = 262_144;
const MAX_STDERR_LINES = 500;

const [stateFile] = process.argv.slice(2);
if (!stateFile) throw new Error("Expected manager state-file path");

const token = randomBytes(32).toString("hex");
const startedAt = Date.now();
const agents = new Map<string, Managed>();

// --- connection handling -----------------------------------------------------

const server = net.createServer((socket) => {
  socket.on("error", () => undefined);
  let initial = Buffer.alloc(0);
  const receive = (chunk: Buffer) => {
    initial = Buffer.concat([initial, chunk]);
    const newline = initial.indexOf(10);
    if (newline < 0) {
      // A control line is small; anything larger is not one of ours.
      if (initial.length > 1_048_576) socket.destroy();
      return;
    }
    socket.off("data", receive);
    const raw = initial.subarray(0, newline).toString("utf8");
    const rest = initial.subarray(newline + 1);

    let request: Request;
    try {
      request = JSON.parse(raw) as Request;
    } catch {
      socket.destroy();
      return;
    }
    if (!request || typeof request.type !== "string" || request.token !== token) {
      socket.destroy();
      return;
    }

    switch (request.type) {
      case "attach":
        attach(socket, request, rest);
        return;
      case "ping":
        reply(socket, { type: "pong", pid: process.pid, startedAt });
        return;
      case "status":
        reply(socket, {
          type: "status",
          pid: process.pid,
          startedAt,
          agents: [...agents.values()].map(describe),
        });
        return;
      case "logs":
        reply(socket, {
          type: "logs",
          key: request.key,
          lines: (agents.get(request.key)?.stderr ?? []).slice(-(request.limit ?? MAX_STDERR_LINES)),
        });
        return;
      case "stop":
        stop(socket, request.key);
        return;
      default:
        socket.destroy();
    }
  };
  socket.on("data", receive);
});

function reply(socket: net.Socket, payload: unknown): void {
  socket.end(`${JSON.stringify(payload)}\n`);
}

function describe(managed: Managed) {
  return {
    key: managed.key,
    agentKey: managed.agentKey,
    pid: managed.child.pid ?? null,
    command: managed.definition.command,
    args: managed.definition.args ?? [],
    cwd: managed.definition.cwd ?? null,
    startedAt: managed.startedAt,
    alive: managed.child.exitCode === null && managed.child.signalCode === null,
    attached: Boolean(managed.client && !managed.client.destroyed),
    attachments: managed.attachments,
    pendingBytes: managed.pendingBytes,
    droppedBytes: managed.droppedBytes,
    stderrLines: managed.stderr.length,
  };
}

function attach(
  socket: net.Socket,
  request: Extract<Request, { type: "attach" }>,
  rest: Buffer,
): void {
  if (!request.key || !request.definition?.command) {
    socket.destroy();
    return;
  }

  const existing = agents.get(request.key);
  const reused = Boolean(existing && existing.child.exitCode === null && existing.child.signalCode === null);
  const managed = reused ? existing! : start(request);

  // Only one extension host may drive an agent at a time; the newest wins.
  managed.client?.destroy();
  managed.client = socket;
  managed.attachments += 1;

  socket.write(
    `${JSON.stringify({
      type: "attached",
      reused,
      initialize: managed.initialize,
      droppedBytes: managed.droppedBytes,
      startedAt: managed.startedAt,
    })}\n`,
  );

  for (const buffered of managed.pending.splice(0)) socket.write(buffered);
  managed.pendingBytes = 0;
  managed.droppedBytes = 0;

  socket.on("data", (data) => relayToAgent(managed, data));
  socket.once("close", () => {
    if (managed.client === socket) managed.client = undefined;
  });
  if (rest.length) relayToAgent(managed, rest);
}

function start(request: Extract<Request, { type: "attach" }>): Managed {
  const child = spawn(request.definition.command, request.definition.args ?? [], {
    cwd: request.definition.cwd,
    env: { ...process.env, ...request.definition.env },
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });

  const managed: Managed = {
    key: request.key,
    agentKey: request.agentKey ?? request.key,
    child,
    definition: request.definition,
    startedAt: Date.now(),
    pending: [],
    pendingBytes: 0,
    droppedBytes: 0,
    stderr: [],
    stderrBytes: 0,
    attachments: 0,
  };
  agents.set(request.key, managed);

  child.stdin.on("error", () => undefined);
  child.stdout.on("error", () => undefined);
  child.stderr.on("error", () => undefined);
  child.on("error", (error) => recordStderr(managed, `[supervisor] spawn failed: ${String(error)}\n`));

  child.stdout.on("data", (data: Buffer) => relayFromAgent(managed, data));
  // stdout is the ACP channel and must never carry logging; stderr is kept
  // here so the extension can show why an agent misbehaved.
  child.stderr.on("data", (data: Buffer) => recordStderr(managed, data.toString("utf8")));
  child.on("exit", (code, signal) => {
    recordStderr(managed, `[supervisor] agent exited (code ${code}, signal ${signal})\n`);
    if (agents.get(request.key) === managed) agents.delete(request.key);
    void writeState();
  });

  void writeState();
  return managed;
}

function recordStderr(managed: Managed, text: string): void {
  for (const line of text.split("\n")) {
    if (!line) continue;
    managed.stderr.push(line);
    managed.stderrBytes += line.length;
  }
  while (managed.stderr.length > MAX_STDERR_LINES || managed.stderrBytes > MAX_STDERR_BYTES) {
    const dropped = managed.stderr.shift();
    if (dropped === undefined) break;
    managed.stderrBytes -= dropped.length;
  }
}

function relayFromAgent(managed: Managed, data: Buffer): void {
  observeInitializeResponse(managed, data);
  if (managed.client && !managed.client.destroyed) {
    managed.client.write(data);
    return;
  }
  managed.pending.push(data);
  managed.pendingBytes += data.length;
  // Do not permit an unattended agent to consume unbounded supervisor RAM.
  // Dropping the oldest frames keeps the most recent state, and the count is
  // reported on the next attach so the client knows its stream has a hole.
  while (managed.pendingBytes > MAX_PENDING_BYTES) {
    const dropped = managed.pending.shift();
    if (!dropped) break;
    managed.pendingBytes -= dropped.length;
    managed.droppedBytes += dropped.length;
  }
}

function relayToAgent(managed: Managed, data: Buffer): void {
  observeInitializeRequest(managed, data);
  if (managed.child.stdin.writable) managed.child.stdin.write(data);
}

function observeInitializeRequest(managed: Managed, data: Buffer): void {
  for (const line of data.toString("utf8").split("\n")) {
    try {
      const message = JSON.parse(line) as { id?: string | number; method?: string };
      if (message.method === "initialize" && message.id !== undefined) managed.initRequestId = message.id;
    } catch {
      /* raw ACP parser handles protocol errors */
    }
  }
}

function observeInitializeResponse(managed: Managed, data: Buffer): void {
  for (const line of data.toString("utf8").split("\n")) {
    try {
      const message = JSON.parse(line) as { id?: string | number; result?: unknown };
      if (message.id === managed.initRequestId && message.result) managed.initialize = message.result;
    } catch {
      /* raw ACP parser handles protocol errors */
    }
  }
}

// --- shutdown ----------------------------------------------------------------

function kill(managed: Managed): void {
  managed.client?.destroy();
  if (managed.child.exitCode === null && managed.child.signalCode === null) {
    managed.child.kill("SIGTERM");
    const timer = setTimeout(() => managed.child.kill("SIGKILL"), 3000);
    managed.child.once("exit", () => clearTimeout(timer));
  }
}

function stop(socket: net.Socket, key: string | undefined): void {
  if (key) {
    const managed = agents.get(key);
    if (managed) {
      agents.delete(key);
      kill(managed);
    }
    reply(socket, { type: "stopped", key, remaining: agents.size });
    void writeState();
    return;
  }

  // No key means the whole supervisor: kill every agent and exit.
  const stopped = agents.size;
  for (const managed of agents.values()) kill(managed);
  agents.clear();
  reply(socket, { type: "stopped", stopped, remaining: 0 });
  socket.once("close", shutdown);
  setTimeout(shutdown, 1000).unref();
}

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  void fs.rm(stateFile, { force: true }).finally(() => process.exit(0));
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    for (const managed of agents.values()) kill(managed);
    shutdown();
  });
}

// --- state file --------------------------------------------------------------

/**
 * Publish where this supervisor is listening, plus what it is running.
 *
 * The file is the token store, so it is created 0600 and its directory 0700.
 * `writeFile`'s mode applies only when it creates the file, so an existing
 * file is re-secured explicitly rather than trusted.
 */
async function writeState(): Promise<void> {
  const payload = JSON.stringify({
    pid: process.pid,
    port: (server.address() as net.AddressInfo | null)?.port ?? 0,
    token,
    startedAt,
    agents: [...agents.values()].map((managed) => ({
      key: managed.key,
      agentKey: managed.agentKey,
      pid: managed.child.pid ?? null,
      command: managed.definition.command,
      startedAt: managed.startedAt,
    })),
  });
  const temp = `${stateFile}.tmp`;
  await fs.writeFile(temp, payload, { mode: 0o600 });
  await fs.chmod(temp, 0o600).catch(() => undefined);
  await fs.rename(temp, stateFile);
}

/**
 * Refuse to become a second supervisor for the same state file.
 *
 * Two managers would each own agents the other cannot see, and the second
 * would overwrite the first's token. If the recorded one still answers, this
 * process is redundant and exits; otherwise the state is stale and ours wins.
 */
async function existingManagerAlive(): Promise<boolean> {
  let state: { port?: number; token?: string };
  try {
    state = JSON.parse(await fs.readFile(stateFile, "utf8")) as { port?: number; token?: string };
  } catch {
    return false;
  }
  if (typeof state.port !== "number" || typeof state.token !== "string") return false;

  return new Promise<boolean>((resolve) => {
    const probe = net.connect({ host: "127.0.0.1", port: state.port as number });
    const settle = (alive: boolean) => {
      probe.destroy();
      resolve(alive);
    };
    probe.setTimeout(500, () => settle(false));
    probe.once("error", () => settle(false));
    probe.once("connect", () =>
      probe.write(`${JSON.stringify({ type: "ping", token: state.token })}\n`),
    );
    probe.once("data", (data: Buffer) => settle(data.toString("utf8").includes('"pong"')));
  });
}

async function main(): Promise<void> {
  await fs.mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  if (await existingManagerAlive()) process.exit(0);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind manager port");
  await writeState();
}

void main();
