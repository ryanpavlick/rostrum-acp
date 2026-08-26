/**
 * End-to-end checks on the chat provider itself, driven headlessly against a
 * scripted agent.
 *
 * These cover the parity claim that motivated the concurrent-session runtime:
 * a turn keeps running, keeps recording, and gets persisted while the user is
 * looking at a different conversation — and a background session that needs
 * the user says so instead of being answered on its behalf.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ChatViewProvider } from "../out/test/chatView.js";
import { AgentConnection, connectionKey } from "../out/test/agentConnection.js";
import { SessionStore } from "../out/test/store.js";
import { UsageTracker } from "../out/test/usage.js";

/** The vscode stub is inlined into each bundle but shares one state object. */
const stub = globalThis.__rostrumVscodeStub;

let passed = 0;
const ok = (n) => { passed += 1; console.log(`  ok  ${n}`); };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const until = async (condition, what) => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${what}`);
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rostrum-provider-"));

/** An ACP agent whose every response the test decides, turn by turn. */
class ScriptedAgent {
  constructor() {
    this.router = null;
    this.nextSessionId = 0;
    /** sessionId -> { resolve } for prompts the test holds open. */
    this.openPrompts = new Map();
    this.cancelled = [];
  }

  async initialize() {
    return {
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: { image: true } },
    };
  }

  async newSession() {
    this.nextSessionId += 1;
    return { sessionId: `session-${this.nextSessionId}` };
  }

  /** Resolves only when the test calls `finish(sessionId)`. */
  prompt({ sessionId }) {
    return new Promise((resolve) => {
      this.openPrompts.set(sessionId, resolve);
    });
  }

  finish(sessionId, usage) {
    const resolve = this.openPrompts.get(sessionId);
    assert.ok(resolve, `no prompt in flight for ${sessionId}`);
    this.openPrompts.delete(sessionId);
    resolve({ stopReason: "end_turn", ...(usage ? { usage } : {}) });
  }

  async cancel({ sessionId }) {
    this.cancelled.push(sessionId);
  }

  /** Stream assistant text into one session, as an agent would mid-turn. */
  say(sessionId, text) {
    return this.router.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    });
  }

  ask(sessionId, title) {
    return this.router.requestPermission({
      sessionId,
      toolCall: { title, kind: "edit" },
      options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
    });
  }
}

/** A provider wired to a scripted agent rather than a real process. */
class TestProvider extends ChatViewProvider {
  constructor(agent, ...rest) {
    super(...rest);
    this.scripted = agent;
  }

  connect(agentKey, definition, workspaceRoot) {
    const resolved = { ...definition, cwd: definition.cwd ?? workspaceRoot };
    return AgentConnection.attach({
      agentKey,
      // The same fingerprint the provider computes, so a reveal reattaches
      // instead of silently tearing the connection down and rebuilding it.
      key: connectionKey(agentKey, workspaceRoot, resolved),
      definition: resolved,
      persistent: false,
      onUnroutable: () => {},
      launch: (client) => {
        this.scripted.router = client();
        return { agent: this.scripted, exited: new Promise(() => {}), dispose: () => {} };
      },
    });
  }
}

function fakeView(posted) {
  return {
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-resource:",
      asWebviewUri: (uri) => uri,
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage: (message) => { posted.push(message); return Promise.resolve(true); },
    },
  };
}

async function build() {
  stub.reset();
  // A real executable: the provider validates that an agent's command exists
  // before launching it, and the scripted connection replaces the process, not
  // that check.
  stub.config = { agents: { scripted: { command: process.execPath } }, permissionMode: "ask" };

  const root = await fs.mkdtemp(path.join(tmp, "run-"));
  const store = new SessionStore(path.join(root, "sessions"));
  const workspaceState = new Map();
  const context = {
    extensionUri: { fsPath: root },
    asAbsolutePath: (p) => path.join(root, p),
    globalStorageUri: { fsPath: root },
    workspaceState: {
      get: (key) => workspaceState.get(key),
      update: (key, value) => { workspaceState.set(key, value); return Promise.resolve(); },
    },
  };
  const posted = [];
  const agent = new ScriptedAgent();
  const provider = new TestProvider(
    agent,
    context,
    store,
    { appendLine() {}, append() {} },
    () => {},
    new UsageTracker(path.join(root, "usage.json")),
    () => {},
    () => {},
  );
  provider.resolveWebviewView(fakeView(posted));
  return { provider, agent, store, posted };
}

const textOf = (turns) =>
  turns.flatMap((turn) => turn.blocks.filter((b) => b.kind === "text").map((b) => b.text));

// --- a background turn keeps running, recording and persisting ---------------
{
  const { provider, agent, store, posted } = await build();

  await provider.startAgent("scripted");
  const [first] = provider.liveSessions();
  assert.equal(first.sessionId, "session-1");
  assert.equal(first.lifecycle, "idle");

  const running = provider.handleMessage({ type: "prompt", text: "work on A" });
  await tick();
  assert.equal(provider.liveSessions()[0].lifecycle, "running");

  // The user switches to a second conversation on the same agent while the
  // first is still working. This is the case the parked-agent layer could not
  // express: two live sessions on one agent server.
  await provider.newSession();
  const live = provider.liveSessions();
  assert.equal(live.length, 2, "both conversations stay live on one connection");
  assert.equal(live.find((s) => s.sessionId === "session-2").active, true);

  posted.length = 0;
  await agent.say("session-1", "background progress");
  await tick();
  assert.equal(
    posted.filter((m) => m.type === "turn" || m.type === "turnDelta").length,
    0,
    "a background turn must not render into the conversation on screen",
  );
  ok("a background session's output never leaks into the visible transcript");

  const stillRunning = provider.liveSessions().find((s) => s.sessionId === "session-1");
  assert.equal(stillRunning.lifecycle, "running", "the background turn is still going");

  // The webview needs the whole set, not just the visible conversation, or the
  // session switcher cannot offer a way back to the one still working.
  await provider.pushState();
  const { state } = posted.filter((m) => m.type === "state").pop();
  assert.deepEqual(
    state.liveSessions.map((s) => [s.sessionId, s.lifecycle, s.active]),
    [
      ["session-1", "running", false],
      ["session-2", "idle", true],
    ],
  );
  ok("view state carries every live conversation and its status, not just the visible one");

  agent.finish("session-1", { totalTokens: 30, inputTokens: 10, outputTokens: 20 });
  await running;

  const saved = await store.load("session-1");
  assert.ok(saved, "a turn that completed off screen is persisted");
  assert.deepEqual(textOf(saved.turns), ["work on A", "background progress"]);
  ok("a prompt continues to completion while the user works elsewhere");

  const visible = await store.load("session-2");
  assert.equal(visible, undefined, "the empty visible session records nothing of its own");
  assert.equal(
    provider.liveSessions().find((s) => s.sessionId === "session-1").lifecycle,
    "idle",
    "the finished background session settles",
  );
  ok("background completion is persisted without touching the other session");
}

// --- background approval is surfaced, never granted --------------------------
{
  const { provider, agent } = await build();

  await provider.startAgent("scripted");
  const background = provider.handleMessage({ type: "prompt", text: "edit files" });
  await tick();
  await provider.newSession();
  await tick();

  let settled = false;
  const permission = agent.ask("session-1", "Write src/index.ts").then((value) => {
    settled = true;
    return value;
  });
  await tick();

  assert.equal(settled, false, "an off-screen permission ask is never auto-answered");
  assert.equal(stub.notifications.length, 1, "the user is told which session needs them");
  assert.match(stub.notifications[0], /Write src\/index\.ts/);
  assert.match(stub.notifications[0], /scripted/);
  assert.equal(
    provider.liveSessions().find((s) => s.sessionId === "session-1").lifecycle,
    "awaiting-approval",
  );
  ok("a background permission request notifies instead of auto-approving");

  assert.equal(
    provider.active().sessionId,
    "session-2",
    "the notification alone must not yank the user out of what they were doing",
  );

  // Opening the session from its notification puts the request back on screen,
  // where answering it resolves the agent's original call.
  await provider.loadSessionById("session-1");
  await until(() => provider.active()?.sessionId === "session-1", "the session to come on screen");

  const request = provider.active().pending;
  assert.equal(request.title, "Write src/index.ts", "the ask survived being off screen");
  await provider.handleMessage({ type: "respond", requestId: request.requestId, optionId: "yes" });
  const outcome = await permission;
  assert.deepEqual(outcome.outcome, { outcome: "selected", optionId: "yes" });
  assert.equal(
    provider.liveSessions().find((s) => s.sessionId === "session-1").lifecycle,
    "running",
    "answering returns the session to merely running",
  );
  ok("answering an approval opened from the notification reaches the agent that asked");

  agent.finish("session-1");
  await background;
}

// --- switching agents keeps each conversation intact -------------------------
{
  const { provider, agent, posted } = await build();
  stub.config.agents = {
    scripted: { command: process.execPath },
    other: { command: process.execPath },
  };

  await provider.startAgent("scripted");
  await agent.say("session-1", "hello from scripted");
  await tick();

  await provider.startAgent("other");
  assert.equal(provider.liveSessions().length, 2);

  posted.length = 0;
  await provider.startAgent("scripted");
  const { state } = posted.filter((m) => m.type === "state").pop();
  assert.equal(state.currentAgent, "scripted");
  assert.deepEqual(textOf(state.turns), ["hello from scripted"]);
  ok("switching back to an agent reveals its conversation, not a fresh one");

  assert.equal(
    provider.liveSessions().length,
    2,
    "revisiting an agent does not pile up empty conversations",
  );
  ok("agent switching is idempotent");
}

// --- restarting an agent always leaves a usable session ---------------------
{
  const { provider, agent } = await build();
  await provider.startAgent("scripted");
  assert.equal(provider.liveSessions().length, 1);

  // Nothing has been said yet, so this session was never persisted and cannot
  // be reloaded after the restart. The panel must not be left empty.
  await provider.restartCurrentAgent();
  assert.equal(provider.liveSessions().length, 1, "restart leaves exactly one live session");
  assert.ok(provider.active(), "restart leaves a session on screen");
  assert.equal(provider.active().readOnly, false, "and it is one that can be prompted");

  const running = provider.handleMessage({ type: "prompt", text: "after restart" });
  await tick();
  assert.equal(provider.active().lifecycle, "running", "the restarted session accepts prompts");
  agent.finish(provider.active().sessionId);
  await running;
  ok("restarting an agent leaves a usable session even when the old one cannot be reloaded");
}

// --- a misconfigured agent fails with an explanation ------------------------
{
  const { provider, posted } = await build();
  const errors = () => posted.filter((m) => m.type === "error").map((m) => m.message);

  stub.config.agents = { broken: { command: "definitely-not-installed-anywhere" } };
  await provider.startAgent("broken");
  assert.match(errors().pop(), /not found on PATH/);
  assert.equal(provider.liveSessions().length, 0, "no half-built session is left behind");

  posted.length = 0;
  stub.config.agents = { malformed: { command: process.execPath, args: "--acp" } };
  await provider.startAgent("malformed");
  assert.match(errors().pop(), /must be an array/);
  assert.equal(provider.liveSessions().length, 0);
  ok("a misconfigured agent is refused with a specific reason, not left to hang");
}

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\nPASS: ${passed} provider checks`);
