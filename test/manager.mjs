/**
 * Integration checks for the detached ACP supervisor.
 *
 * These drive a real supervisor process over its loopback socket with a real
 * child "agent", covering the things the extension depends on but cannot see:
 * that an agent survives a window detaching and reattaching, that an
 * unattended agent cannot grow the supervisor's memory without bound, that a
 * second supervisor refuses to race the first, and that stop actually stops.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

let passed = 0;
const ok = (n) => { passed += 1; console.log(`  ok  ${n}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const here = path.dirname(fileURLToPath(import.meta.url));
const managerScript = path.join(here, "..", "out", "test", "manager.js");
const agentScript = path.join(here, "echo-agent.mjs");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rostrum-manager-"));
const stateFile = path.join(tmp, "state", "agent-manager.json");

const definition = { command: process.execPath, args: [agentScript] };
const spawned = [];

function startManager() {
  const child = spawn(process.execPath, [managerScript, stateFile], { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { child.captured = (child.captured ?? "") + chunk; });
  spawned.push(child);
  return child;
}

async function readState(timeoutMs = 4000) {
  for (let waited = 0; waited < timeoutMs; waited += 25) {
    try {
      const value = JSON.parse(await fs.readFile(stateFile, "utf8"));
      if (typeof value.port === "number" && value.port > 0) return value;
    } catch { /* not written yet */ }
    await sleep(25);
  }
  throw new Error("supervisor never published its state file");
}

/** Open a socket and send one line, without reading it back. */
function open(state, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: state.port });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ ...request, token: state.token })}\n`);
      resolve(socket);
    });
  });
}

/** Read newline-delimited JSON off a socket, one message at a time. */
function reader(socket) {
  let buffer = "";
  const queue = [];
  const waiters = [];
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) {
        const value = { raw: line, json: safeParse(line) };
        if (waiters.length) waiters.shift()(value);
        else queue.push(value);
      }
      newline = buffer.indexOf("\n");
    }
  });
  return {
    next(timeoutMs = 4000) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for a line")), timeoutMs);
        waiters.push((value) => { clearTimeout(timer); resolve(value); });
      });
    },
    /** Pull lines until one satisfies `match`, returning everything seen. */
    async until(match, timeoutMs = 6000) {
      const seen = [];
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = await this.next(Math.max(50, deadline - Date.now()));
        seen.push(value);
        if (match(value)) return seen;
      }
      throw new Error("timed out waiting for a matching line");
    },
  };
}

function safeParse(line) {
  try { return JSON.parse(line); } catch { return undefined; }
}

/** One-shot control request: send, read the single reply, close. */
async function control(state, request) {
  const socket = await open(state, request);
  const reply = await reader(socket).next();
  socket.destroy();
  return reply.json;
}

// --- start up ----------------------------------------------------------------
startManager();
const state = await readState();
assert.ok(state.port > 0 && typeof state.token === "string" && state.token.length >= 32);

const mode = (await fs.stat(stateFile)).mode & 0o777;
assert.equal(mode, 0o600, "the state file holds the supervisor token and must not be world-readable");
ok("the supervisor publishes a private state file with an unguessable token");

assert.deepEqual((await control(state, { type: "status" })).agents, []);
ok("status reports an empty supervisor before anything attaches");

// --- an unauthenticated caller gets nothing ----------------------------------
{
  const socket = net.connect({ host: "127.0.0.1", port: state.port });
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(`${JSON.stringify({ type: "status", token: "wrong-token" })}\n`);
  const closed = await new Promise((resolve) => {
    let got = "";
    socket.on("data", (chunk) => { got += chunk; });
    socket.once("close", () => resolve(got));
  });
  assert.equal(closed, "", "a bad token is disconnected without a reply");
  ok("a caller without the token is refused");
}

// --- attach, talk, detach, reattach ------------------------------------------
const first = await open(state, { type: "attach", key: "k1", agentKey: "echo", definition });
const firstReader = reader(first);
const attached = await firstReader.next();
assert.equal(attached.json.type, "attached");
assert.equal(attached.json.reused, false, "the first attachment starts the agent");

first.write(`${JSON.stringify({ cmd: "echo", text: "hello" })}\n`);
assert.equal((await firstReader.next()).json.echo, "hello");
ok("an attached client talks to the agent through the supervisor");

const running = await control(state, { type: "status" });
assert.equal(running.agents.length, 1);
assert.equal(running.agents[0].agentKey, "echo");
assert.equal(running.agents[0].alive, true);
assert.equal(running.agents[0].attached, true);
ok("status names the running agent and reports it attached");

// Ask for output that will arrive after we are gone, then detach.
first.write(`${JSON.stringify({ cmd: "emit", bytes: 64, tag: "while-away", delayMs: 200 })}\n`);
first.destroy();
await sleep(500);

const detached = await control(state, { type: "status" });
assert.equal(detached.agents[0].alive, true, "the agent outlives the window that started it");
assert.equal(detached.agents[0].attached, false);
assert.ok(detached.agents[0].pendingBytes > 0, "its output is held for the next attachment");
ok("an agent keeps running and buffering while no window is attached");

const second = await open(state, { type: "attach", key: "k1", agentKey: "echo", definition });
const secondReader = reader(second);
const reattached = await secondReader.next();
assert.equal(reattached.json.reused, true, "reattaching reuses the same process, not a new one");
assert.equal(reattached.json.droppedBytes, 0, "nothing was dropped at this size");

const replayed = await secondReader.until((line) => line.json?.done === "while-away");
assert.ok(replayed.length >= 1, "work finished while detached is replayed on reattach");
second.write(`${JSON.stringify({ cmd: "echo", text: "still here" })}\n`);
assert.equal((await secondReader.next()).json.echo, "still here");
ok("reattaching replays buffered output and resumes the same conversation");

assert.equal(
  (await control(state, { type: "status" })).agents[0].pid,
  running.agents[0].pid,
  "the agent process is the same one across the detach",
);
ok("the agent process survives a detach and reattach intact");

// --- bounded buffering -------------------------------------------------------
second.write(`${JSON.stringify({ cmd: "emit", bytes: 3_000_000, tag: "flood", delayMs: 200 })}\n`);
second.destroy();
await sleep(1200);

const flooded = await control(state, { type: "status" });
assert.ok(
  flooded.agents[0].pendingBytes <= 1_048_576 + 65_536,
  `an unattended agent must not grow the supervisor without bound (held ${flooded.agents[0].pendingBytes} B)`,
);
assert.ok(flooded.agents[0].droppedBytes > 0, "the overflow is counted, not silently forgotten");
ok("an unattended agent's buffered output is bounded and the loss is counted");

const third = await open(state, { type: "attach", key: "k1", agentKey: "echo", definition });
const thirdReader = reader(third);
const afterFlood = await thirdReader.next();
assert.equal(afterFlood.json.reused, true);
assert.ok(
  afterFlood.json.droppedBytes > 0,
  "a client that reattaches to a truncated stream is told its transcript has a hole",
);
ok("the reattaching client is told how much output was discarded");

// Drain the truncated replay. Its first line is a fragment of the dropped
// filler and does not parse, which is exactly what a hole in the stream
// looks like from the client side.
const replayedFlood = await thirdReader.until((line) => line.json?.done === "flood");
assert.ok(
  replayedFlood.some((line) => line.json === undefined),
  "a dropped prefix leaves a partial line, so the hole is visible in the stream itself",
);
ok("the truncated stream resumes cleanly at the next whole line");

// --- stderr capture ----------------------------------------------------------
third.write(`${JSON.stringify({ cmd: "log", text: "agent misconfigured: no API key" })}\n`);
await sleep(300);
const logs = await control(state, { type: "logs", key: "k1" });
assert.ok(
  logs.lines.some((line) => line.includes("agent misconfigured: no API key")),
  "the supervisor keeps the agent's stderr for the extension to show",
);
assert.ok(logs.lines.some((line) => line.includes("echo-agent: ready")));
ok("supervisor-captured agent stderr is retrievable");

// --- a second supervisor refuses to race -------------------------------------
const intruder = startManager();
const intruderExit = await new Promise((resolve) => intruder.once("exit", resolve));
assert.equal(intruderExit, 0, "a redundant supervisor exits quietly");
const unchanged = JSON.parse(await fs.readFile(stateFile, "utf8"));
assert.equal(unchanged.port, state.port, "it must not steal the state file from the live supervisor");
assert.equal(unchanged.token, state.token);
third.write(`${JSON.stringify({ cmd: "echo", text: "unaffected" })}\n`);
assert.equal((await thirdReader.next()).json.echo, "unaffected");
ok("a second supervisor for the same state file stands down");

// --- registry ----------------------------------------------------------------
const registry = JSON.parse(await fs.readFile(stateFile, "utf8"));
assert.equal(registry.agents.length, 1);
assert.equal(registry.agents[0].agentKey, "echo");
assert.equal(registry.agents[0].key, "k1");
assert.ok(registry.agents[0].pid > 0);
ok("the state file carries a registry of what is supervised");

// --- stopping one agent ------------------------------------------------------
const stoppedOne = await control(state, { type: "stop", key: "k1" });
assert.equal(stoppedOne.type, "stopped");
assert.equal(stoppedOne.remaining, 0);
await sleep(400);
assert.deepEqual((await control(state, { type: "status" })).agents, []);
ok("stopping one agent leaves the supervisor running and empty");

// --- stopping the supervisor -------------------------------------------------
await open(state, { type: "attach", key: "k2", agentKey: "echo", definition });
await sleep(300);
assert.equal((await control(state, { type: "status" })).agents.length, 1);

await control(state, { type: "stop" });
for (let waited = 0; waited < 4000; waited += 50) {
  if (!(await fs.stat(stateFile).catch(() => null))) break;
  await sleep(50);
}
assert.equal(await fs.stat(stateFile).catch(() => null), null, "shutdown clears its state file");
await assert.rejects(
  () => control(state, { type: "status" }),
  /ECONNREFUSED/,
  "the port is released, so a stale client cannot keep talking to a dead supervisor",
);
ok("stopping the supervisor kills its agents and clears the state file");

for (const child of spawned) child.kill("SIGKILL");
await fs.rm(tmp, { recursive: true, force: true });
console.log(`\nPASS: ${passed} supervisor checks`);
