/**
 * Detached local ACP supervisor. It owns agent stdio and relays raw ACP NDJSON
 * to whichever extension host is currently attached. The process is loopback
 * only and each manager instance has an unguessable token in its state file.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";

interface StartRequest { type: "attach"; token: string; key: string; definition: { command: string; args?: string[]; env?: Record<string, string>; cwd?: string } }
interface Managed { child: ChildProcessWithoutNullStreams; client?: net.Socket; pending: Buffer[]; initRequestId?: string | number; initialize?: unknown }

const [stateFile] = process.argv.slice(2);
if (!stateFile) throw new Error("Expected manager state-file path");
const token = randomBytes(32).toString("hex");
const agents = new Map<string, Managed>();

const server = net.createServer((socket) => {
  let initial = Buffer.alloc(0);
  const receive = (chunk: Buffer) => {
    initial = Buffer.concat([initial, chunk]);
    const newline = initial.indexOf(10);
    if (newline < 0) return;
    socket.off("data", receive);
    const raw = initial.subarray(0, newline).toString("utf8");
    const rest = initial.subarray(newline + 1);
    let request: StartRequest;
    try { request = JSON.parse(raw) as StartRequest; } catch { socket.destroy(); return; }
    if (request.type !== "attach" || request.token !== token || !request.key || !request.definition?.command) { socket.destroy(); return; }
    let managed = agents.get(request.key);
    const reused = Boolean(managed && managed.child.exitCode === null && managed.child.signalCode === null);
    if (!managed || !reused) {
      const child = spawn(request.definition.command, request.definition.args ?? [], {
        cwd: request.definition.cwd,
        env: { ...process.env, ...request.definition.env }, stdio: ["pipe", "pipe", "pipe"], shell: false,
      });
      managed = { child, pending: [] };
      agents.set(request.key, managed);
      child.stdout.on("data", (data: Buffer) => relayFromAgent(managed!, data));
      child.stderr.on("data", () => undefined); // supervisor deliberately never exposes stderr over ACP
      child.on("exit", () => agents.delete(request.key));
    }
    managed.client?.destroy();
    managed.client = socket;
    socket.write(`${JSON.stringify({ type: "attached", reused, initialize: managed.initialize })}\n`);
    for (const pending of managed.pending.splice(0)) socket.write(pending);
    socket.on("data", (data) => relayToAgent(managed!, data));
    socket.once("close", () => { if (managed!.client === socket) managed!.client = undefined; });
    if (rest.length) relayToAgent(managed, rest);
  };
  socket.on("data", receive);
});

function relayFromAgent(managed: Managed, data: Buffer): void {
  observeInitializeResponse(managed, data);
  if (managed.client && !managed.client.destroyed) managed.client.write(data);
  else {
    managed.pending.push(data);
    // Do not permit an unattended agent to consume unbounded supervisor RAM.
    while (managed.pending.reduce((size, part) => size + part.length, 0) > 1_048_576) managed.pending.shift();
  }
}
function relayToAgent(managed: Managed, data: Buffer): void {
  observeInitializeRequest(managed, data);
  managed.child.stdin.write(data);
}
function observeInitializeRequest(managed: Managed, data: Buffer): void {
  for (const line of data.toString("utf8").split("\n")) try {
    const message = JSON.parse(line) as { id?: string | number; method?: string };
    if (message.method === "initialize" && message.id !== undefined) managed.initRequestId = message.id;
  } catch { /* raw ACP parser handles protocol errors */ }
}
function observeInitializeResponse(managed: Managed, data: Buffer): void {
  for (const line of data.toString("utf8").split("\n")) try {
    const message = JSON.parse(line) as { id?: string | number; result?: unknown };
    if (message.id === managed.initRequestId && message.result) managed.initialize = message.result;
  } catch { /* raw ACP parser handles protocol errors */ }
}

server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind manager port");
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify({ pid: process.pid, port: address.port, token }), { mode: 0o600 });
});
