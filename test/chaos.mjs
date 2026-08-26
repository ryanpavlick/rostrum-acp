/**
 * Reconnect chaos checks for the supervisor.
 *
 * The persistent-agent promise is that a window can go away and come back
 * without the agent noticing. These checks attack that promise directly:
 * detaching mid-stream, reattaching repeatedly and fast, racing two windows
 * for the same agent, killing the agent, and killing the supervisor itself.
 *
 * The property under test is that no ACP frame is silently lost. The
 * supervisor is allowed to drop output when its bounded buffer overflows, but
 * only if it says so — anything else would corrupt a transcript invisibly.
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
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rostrum-chaos-"));
const stateFile = path.join(tmp, "state", "agent-manager.json");
const definition = { command: process.execPath, args: [agentScript] };

const spawned = [];
function startManager() {
  const child = spawn(process.execPath, [managerScript, stateFile], { stdio: "ignore" });
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

/** A client attachment that collects every whole JSON line it receives. */
async function attach(state, key) {
  const socket = await new Promise((resolve, reject) => {
    const s = net.connect({ host: "127.0.0.1", port: state.port });
    s.once("error", reject);
    s.once("connect", () => {
      s.write(`${JSON.stringify({ type: "attach", token: state.token, key, agentKey: key, definition })}\n`);
      resolve(s);
    });
  });

  const client = {
    socket,
    lines: [],
    handshake: undefined,
    send(message) {
      socket.write(`${JSON.stringify(message)}\n`);
    },
    close() {
      socket.destroy();
    },
    /** Wait until a line satisfying `match` arrives. */
    async waitFor(match, timeoutMs = 6000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = client.lines.find(match);
        if (found) return found;
        await sleep(10);
      }
      throw new Error(
        `timed out on ${key}; destroyed=${socket.destroyed} lines=${JSON.stringify(client.lines).slice(0, 300)}`,
      );
    },
  };

  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const raw = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (raw.trim()) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.type === "attached") client.handshake = parsed;
          else client.lines.push(parsed);
        } catch {
          // A truncated line is what a reported drop looks like from here.
          client.lines.push({ torn: raw });
        }
      }
      newline = buffer.indexOf("\n");
    }
  });

  // The handshake is not a transcript line, so poll for it directly.
  for (let waited = 0; waited < 5000 && !client.handshake; waited += 10) await sleep(10);
  assert.ok(client.handshake, `the supervisor must answer an attach for ${key}`);
  return client;
}

async function control(state, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: state.port });
    let buffer = "";
    socket.once("error", reject);
    socket.once("connect", () =>
      socket.write(`${JSON.stringify({ ...request, token: state.token })}\n`),
    );
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    });
  });
}

startManager();
let state = await readState();

// --- rapid detach/reattach while the agent keeps working ---------------------
{
  let client = await attach(state, "churn");
  assert.equal(client.handshake.reused, false);

  const delivered = new Set();
  // Twenty cycles of "window closed, window reopened" while the agent is
  // answering. Every reply must arrive exactly once, at some attachment.
  for (let round = 0; round < 20; round += 1) {
    client.send({ cmd: "emit", bytes: 16, tag: `round-${round}`, delayMs: 15 });
    await sleep(5);
    client.close();
    await sleep(10);
    client = await attach(state, "churn");
    assert.equal(client.handshake.reused, true, `round ${round} must reuse the same agent`);
    for (const line of client.lines) if (line.done) delivered.add(line.done);
    client.lines.length = 0;
  }

  client.send({ cmd: "echo", text: "settled" });
  await client.waitFor((line) => line.echo === "settled");
  for (const line of client.lines) if (line.done) delivered.add(line.done);

  assert.equal(delivered.size, 20, `every round must be delivered once (got ${delivered.size})`);
  ok("twenty detach/reattach cycles mid-stream lose nothing and reuse one agent");

  const status = await control(state, { type: "status" });
  const churn = status.agents.find((agent) => agent.key === "churn");
  assert.equal(churn.alive, true, "the agent survived every cycle");
  assert.equal(churn.attachments, 21, "each reattach was counted");
  assert.equal(churn.droppedBytes, 0, "nothing was dropped at this volume");
  ok("the agent process is unchanged after repeated reconnection");

  client.close();
}

// --- two windows racing for the same agent -----------------------------------
{
  const first = await attach(state, "contested");
  const second = await attach(state, "contested");
  assert.equal(second.handshake.reused, true, "the second window joins the running agent");

  // Only one window may drive an agent; the newest wins and the older is cut.
  const firstClosed = await new Promise((resolve) => {
    if (first.socket.destroyed) return resolve(true);
    first.socket.once("close", () => resolve(true));
    setTimeout(() => resolve(first.socket.destroyed), 1500);
  });
  assert.equal(firstClosed, true, "the displaced window is disconnected rather than left half-live");

  second.send({ cmd: "echo", text: "mine" });
  const reply = await second.waitFor((line) => line.echo === "mine");
  assert.ok(reply);
  assert.equal(first.lines.some((line) => line.echo === "mine"), false, "no crosstalk to the old window");
  ok("a second window takes over an agent and the first is cleanly displaced");

  second.close();
}

// --- independent agents do not cross-talk ------------------------------------
{
  const alpha = await attach(state, "alpha");
  const beta = await attach(state, "beta");

  alpha.send({ cmd: "echo", text: "for-alpha" });
  beta.send({ cmd: "echo", text: "for-beta" });
  await alpha.waitFor((line) => line.echo === "for-alpha");
  await beta.waitFor((line) => line.echo === "for-beta");

  assert.equal(alpha.lines.some((line) => line.echo === "for-beta"), false);
  assert.equal(beta.lines.some((line) => line.echo === "for-alpha"), false);
  ok("agents supervised side by side never receive each other's traffic");

  alpha.close();
  beta.close();
  await control(state, { type: "stop", key: "alpha" });
  await control(state, { type: "stop", key: "beta" });
}

// --- the agent dies under the client -----------------------------------------
{
  const client = await attach(state, "doomed");
  client.send({ cmd: "echo", text: "alive" });
  await client.waitFor((line) => line.echo === "alive");

  client.send({ cmd: "exit", code: 3 });
  const closed = await new Promise((resolve) => {
    client.socket.once("close", () => resolve(true));
    setTimeout(() => resolve(false), 4000);
  });
  assert.equal(closed, true, "a dead agent closes its client rather than hanging it");

  await sleep(300);
  const status = await control(state, { type: "status" });
  assert.equal(
    status.agents.some((agent) => agent.key === "doomed"),
    false,
    "an exited agent is removed from the registry",
  );

  // Attaching again must start a fresh process, not resurrect the dead one.
  const revived = await attach(state, "doomed");
  assert.equal(revived.handshake.reused, false, "a dead agent is replaced, not reused");
  revived.send({ cmd: "echo", text: "reborn" });
  await revived.waitFor((line) => line.echo === "reborn");
  ok("an agent that exits is reported gone and replaced on the next attach");

  revived.close();
  await control(state, { type: "stop", key: "doomed" });
}

// --- the supervisor itself dies ----------------------------------------------
{
  const client = await attach(state, "orphan");
  client.send({ cmd: "echo", text: "before" });
  await client.waitFor((line) => line.echo === "before");

  const before = await control(state, { type: "status" });
  process.kill(before.pid, "SIGKILL");

  const closed = await new Promise((resolve) => {
    client.socket.once("close", () => resolve(true));
    setTimeout(() => resolve(false), 4000);
  });
  assert.equal(closed, true, "a killed supervisor closes its clients");

  // The state file now points at a supervisor that is gone. This is exactly
  // the stale state `launchPersistentAgent` has to recover from.
  const stale = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(stale.pid, before.pid, "the stale state file survives the kill");

  await assert.rejects(
    () => control(stale, { type: "status" }),
    /ECONNREFUSED|ECONNRESET/,
    "the recorded address no longer answers",
  );
  ok("a killed supervisor leaves stale state that fails fast rather than hanging");

  // Recovery: drop the stale file, start again, and everything works.
  await fs.rm(stateFile, { force: true });
  startManager();
  state = await readState();
  const recovered = await attach(state, "orphan");
  assert.equal(recovered.handshake.reused, false);
  recovered.send({ cmd: "echo", text: "after" });
  await recovered.waitFor((line) => line.echo === "after");
  ok("a fresh supervisor takes over cleanly after the old one is killed");

  recovered.close();
}

// --- concurrent attaches racing for one agent --------------------------------
{
  const clients = await Promise.all(
    Array.from({ length: 5 }, () => attach(state, "stampede").catch(() => undefined)),
  );
  const live = clients.filter(Boolean);
  assert.ok(live.length >= 1, "at least one of five simultaneous attaches must succeed");

  await sleep(300);
  const status = await control(state, { type: "status" });
  const stampede = status.agents.filter((agent) => agent.key === "stampede");
  assert.equal(stampede.length, 1, "five simultaneous attaches must not start five agents");
  assert.equal(stampede[0].alive, true);
  ok("simultaneous attaches for one key start exactly one agent");

  // The last attachment standing must still be able to drive it.
  const survivor = live[live.length - 1];
  survivor.send({ cmd: "echo", text: "survivor" });
  await survivor.waitFor((line) => line.echo === "survivor");
  ok("the surviving attachment still drives the agent after the race");

  for (const client of live) client.close();
}

await control(state, { type: "stop" }).catch(() => undefined);
await sleep(300);
for (const child of spawned) child.kill("SIGKILL");
await fs.rm(tmp, { recursive: true, force: true });
console.log(`\nPASS: ${passed} chaos checks`);
