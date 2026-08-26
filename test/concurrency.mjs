/**
 * Concurrent-session runtime checks.
 *
 * These cover the pieces that make more than one live conversation per agent
 * possible: the callback router that demultiplexes one ACP connection across
 * many sessions, the connection fingerprint the supervisor is keyed by, and
 * the per-session lifecycle a background turn drives.
 */
import assert from "node:assert/strict";
import { Session } from "../out/test/session.js";
import { SessionRouter } from "../out/test/router.js";
import { ManagedSession } from "../out/test/managedSession.js";
import { connectionKey } from "../out/test/agentConnection.js";

let passed = 0;
const ok = (n) => { passed += 1; console.log(`  ok  ${n}`); };

const sink = () => ({ onTurn(){}, onTurnDelta(){}, onPending(){}, onModes(){}, onError(){} });

function makeSession(events = {}) {
  return new Session({ ...sink(), ...events }, "/workspace", "ask");
}

const dropped = [];
const router = new SessionRouter((method, sessionId) => dropped.push([method, sessionId]));

const alpha = makeSession();
const beta = makeSession();
router.register("alpha", alpha);
router.register("beta", beta);

// --- update demultiplexing ---------------------------------------------------
await router.sessionUpdate({
  sessionId: "beta",
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "for beta" } },
});
assert.equal(alpha.getTurns().length, 0, "alpha must not receive beta's stream");
assert.equal(beta.getTurns().length, 1);
assert.equal(beta.getTurns()[0].blocks[0].text, "for beta");
ok("session updates reach only the session they name");

await router.sessionUpdate({
  sessionId: "alpha",
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "for alpha" } },
});
assert.equal(alpha.getTurns()[0].blocks[0].text, "for alpha");
assert.equal(beta.getTurns()[0].blocks[0].text, "for beta", "beta's transcript is untouched");
ok("two sessions stream concurrently without crosstalk");

// --- permission routing ------------------------------------------------------
let alphaAsked = null, betaAsked = null;
const askAlpha = makeSession({ onPending: (r) => (alphaAsked = r) });
const askBeta = makeSession({ onPending: (r) => (betaAsked = r) });
const askRouter = new SessionRouter(() => {});
askRouter.register("a", askAlpha);
askRouter.register("b", askBeta);

const permission = askRouter.requestPermission({
  sessionId: "b",
  toolCall: { title: "Write file", kind: "edit" },
  options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
});
assert.equal(alphaAsked, null, "the wrong session must not be asked");
assert.ok(betaAsked, "the owning session is asked");
askBeta.respond(betaAsked.requestId, "yes");
assert.deepEqual((await permission).outcome, { outcome: "selected", optionId: "yes" });
ok("permission requests reach the owning session and answer back");

// --- unroutable traffic ------------------------------------------------------
dropped.length = 0;
await router.sessionUpdate({
  sessionId: "ghost",
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "nobody" } },
});
assert.deepEqual(dropped, [["session/update", "ghost"]]);
assert.equal(alpha.getTurns()[0].blocks[0].text, "for alpha", "a stray update writes nowhere");
ok("an unroutable notification is dropped and reported, not thrown");

const stray = await router.requestPermission({
  sessionId: "ghost",
  toolCall: { title: "rm -rf", kind: "execute" },
  options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
});
assert.deepEqual(stray.outcome, { outcome: "cancelled" }, "never auto-approve on our own initiative");
ok("an unroutable permission ask is cancelled, never approved");

await assert.rejects(
  () => router.readTextFile({ sessionId: "ghost", path: "/workspace/x" }),
  /No live session for fs\/read_text_file/,
);
ok("unroutable filesystem requests fail loudly");

// --- provisional routing -----------------------------------------------------
const newborn = makeSession();
router.setProvisional(newborn);
await router.sessionUpdate({
  sessionId: "not-yet-returned",
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "early" } },
});
assert.equal(newborn.getTurns()[0].blocks[0].text, "early");
router.register("not-yet-returned", newborn);
assert.equal(router.size, 3, "registering the provisional session clears the provisional slot");
await router.sessionUpdate({
  sessionId: "still-unknown",
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } },
});
assert.equal(newborn.getTurns()[0].blocks[0].text, "early", "no longer a catch-all once registered");
ok("updates arriving before session/new answers reach the session being created");

// --- lone-session tolerance --------------------------------------------------
const solo = makeSession();
const soloRouter = new SessionRouter(() => { throw new Error("should not be called"); });
soloRouter.register("only", solo);
await soloRouter.sessionUpdate({
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "id-less" } },
});
assert.equal(solo.getTurns()[0].blocks[0].text, "id-less");
ok("an agent that omits sessionId still works when only one session is live");

// --- unregistering -----------------------------------------------------------
const twoRouter = new SessionRouter(() => {});
const first = makeSession(), second = makeSession();
twoRouter.register("1", first);
twoRouter.register("2", second);
twoRouter.unregister("1");
await twoRouter.sessionUpdate({
  sessionId: "1",
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "gone" } },
});
assert.equal(first.getTurns().length, 0, "a closed session receives nothing");
assert.equal(second.getTurns().length, 1, "the lone survivor absorbs the orphaned update");
ok("unregistered sessions stop receiving traffic");

// --- connection fingerprint --------------------------------------------------
const base = { command: "qwen", args: ["--acp"], env: { A: "1", B: "2" }, cwd: "/work" };
assert.equal(
  connectionKey("qwen", "/work", base),
  connectionKey("qwen", "/work", { ...base, env: { B: "2", A: "1" } }),
  "env ordering must not change the key",
);
assert.equal(connectionKey("qwen", "/work", base), connectionKey("qwen", "/work/sub/..", base));
ok("connection keys are stable across env ordering and path spelling");

for (const [name, changed] of [
  ["command", { ...base, command: "qwen2" }],
  ["args", { ...base, args: ["--acp", "--debug"] }],
  ["env", { ...base, env: { A: "1", B: "3" } }],
  ["cwd", { ...base, cwd: "/other" }],
]) {
  assert.notEqual(
    connectionKey("qwen", "/work", base),
    connectionKey("qwen", "/work", changed),
    `a changed ${name} must not reattach to the old process`,
  );
}
assert.notEqual(connectionKey("qwen", "/work", base), connectionKey("qwen", "/elsewhere", base));
assert.match(connectionKey("qwen", "/work", base), /^qwen-[0-9a-f]{32}$/);
ok("an edited agent definition or workspace yields a different connection key");

// --- session lifecycle -------------------------------------------------------
const fakeConnection = {
  agentKey: "qwen",
  disposed: false,
  router: new SessionRouter(() => {}),
  sessions: new Set(),
};
const changes = [];
const controller = new ManagedSession(fakeConnection, makeSession(), (c) => changes.push(c.lifecycle));

assert.equal(controller.lifecycle, "idle");
controller.busy = true;
controller.refreshLifecycle();
assert.equal(controller.lifecycle, "running");

controller.pending = { requestId: "r", title: "Allow?", options: [] };
controller.refreshLifecycle();
assert.equal(controller.lifecycle, "awaiting-approval", "needing the user outranks merely being busy");

controller.pending = null;
controller.busy = false;
controller.fail("boom");
assert.equal(controller.lifecycle, "error");
controller.clearError();
assert.equal(controller.lifecycle, "idle");

fakeConnection.disposed = true;
controller.refreshLifecycle();
assert.equal(controller.lifecycle, "disconnected", "a dead process outranks every other state");
assert.deepEqual(changes, ["running", "awaiting-approval", "error", "idle", "disconnected"]);
ok("session lifecycle reflects busy, approval, failure and disconnection");

fakeConnection.disposed = false;
controller.adoptSessionId("s1");
assert.equal(fakeConnection.router.size, 1);
controller.adoptSessionId("s2");
assert.equal(fakeConnection.router.size, 1, "a fork re-keys rather than leaking the old id");
assert.equal(controller.sessionId, "s2");
controller.adoptSessionId(null);
assert.equal(fakeConnection.router.size, 0, "a read-only transcript is unrouted");
ok("adopting a session id keeps the router registration in step");

console.log(`\nPASS: ${passed} concurrency checks`);
