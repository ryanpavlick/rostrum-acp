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
    this.prompts = [];
    this.cancelled = [];
    this.loaded = [];
    this.supportsLoad = false;
    this.optionCalls = [];
    this.authMethods = [];
    this.authenticated = [];
    this.requireAuth = false;
    this.failLoadFor = undefined;
    this.exit = undefined;
    this.configOptions = [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "default",
        options: [
          { value: "default", name: "Default" },
          { value: "fast", name: "Fast" },
        ],
      },
    ];
    this.promptCapabilities = { image: true };
  }

  async initialize() {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: this.supportsLoad,
        promptCapabilities: this.promptCapabilities,
      },
      authMethods: this.authMethods,
    };
  }

  /** Present so `readCapabilities` sees the method; gated by `supportsLoad`. */
  async loadSession({ sessionId }) {
    if (this.failLoadFor === sessionId) throw new Error(`cannot load ${sessionId}`);
    this.loaded.push(sessionId);
    return {};
  }

  /** Simulate the agent process dying under the client. */
  die(code) {
    this.exit?.(code);
  }

  async newSession(params) {
    this.lastNewSession = params;
    if (this.requireAuth) throw new Error("unauthenticated: run `agent login` first");
    this.nextSessionId += 1;
    return {
      sessionId: `session-${this.nextSessionId}`,
      configOptions: this.configOptions.map((option) => ({ ...option })),
    };
  }

  async setSessionConfigOption({ configId, value }) {
    const option = this.configOptions.find((entry) => entry.id === configId);
    if (!option) throw new Error(`no such option ${configId}`);
    option.currentValue = value;
    this.optionCalls.push([configId, value]);
    return { configOptions: this.configOptions.map((entry) => ({ ...entry })) };
  }

  /** Resolves only when the test calls `finish(sessionId)`. */
  prompt({ sessionId, prompt }) {
    this.prompts.push({ sessionId, prompt });
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

  async authenticate({ methodId }) {
    this.authenticated.push(methodId);
    this.requireAuth = false;
    this.failLoadFor = undefined;
    this.exit = undefined;
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
        return {
          agent: this.scripted,
          exited: new Promise((resolve) => {
            this.scripted.exit = resolve;
          }),
          dispose: () => {},
        };
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

async function build(previous) {
  stub.reset();
  // A real executable: the provider validates that an agent's command exists
  // before launching it, and the scripted connection replaces the process, not
  // that check.
  stub.config = { agents: { scripted: { command: process.execPath } }, permissionMode: "ask" };

  const root = previous?.root ?? (await fs.mkdtemp(path.join(tmp, "run-")));
  const store = previous?.store ?? new SessionStore(path.join(root, "sessions"));
  // A reload keeps the same storage and workspace state; only the extension
  // host object graph is new.
  const workspaceState = previous?.workspaceState ?? new Map();
  // Per-agent preferences live in globalState, so they must outlive a reload.
  const globalState = previous?.globalState ?? new Map();
  const context = {
    extensionUri: { fsPath: root },
    asAbsolutePath: (p) => path.join(root, p),
    globalStorageUri: { fsPath: root },
    workspaceState: {
      get: (key) => workspaceState.get(key),
      update: (key, value) => { workspaceState.set(key, value); return Promise.resolve(); },
    },
    globalState: {
      get: (key) => globalState.get(key),
      update: (key, value) => { globalState.set(key, value); return Promise.resolve(); },
    },
  };
  const posted = [];
  const agent = new ScriptedAgent();
  agent.nextSessionId = previous?.agent.nextSessionId ?? 0;
  agent.supportsLoad = previous?.agent.supportsLoad ?? false;
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
  return { provider, agent, store, posted, workspaceState, globalState, context, root };
}

const textOf = (turns) =>
  turns.flatMap((turn) => turn.blocks.filter((b) => b.kind === "text").map((b) => b.text));

// --- editor context can be attached to the next prompt -----------------------
{
  const { provider, agent } = await build();
  agent.promptCapabilities = { image: true, embeddedContext: true };
  await provider.startAgent("scripted");

  const uri = { fsPath: "/workspace/src/example.ts", path: "/workspace/src/example.ts", toString: () => "file:///workspace/src/example.ts" };
  stub.files.set(uri.fsPath, "export const answer = 42;\n");
  stub.activeTextEditor = {
    document: {
      uri,
      getText: () => "answer = 42",
    },
    selection: {
      isEmpty: false,
      start: { line: 0 },
    },
  };

  provider.stageActiveEditorFile();
  provider.stageActiveEditorSelection();
  const running = provider.handleMessage({ type: "prompt", text: "Use this context" });
  await until(() => agent.prompts.length === 1, "prompt with editor attachments");

  const prompt = agent.prompts[0].prompt;
  assert.equal(prompt[0].text, "Use this context");
  assert.equal(prompt[1].type, "resource", "active text file is embedded as context");
  assert.equal(prompt[1].resource.text, "export const answer = 42;\n");
  assert.equal(prompt[2].type, "resource", "selection is embedded as context");
  assert.equal(prompt[2].resource.text, "answer = 42");
  assert.equal(prompt[2].resource.uri, "file:///workspace/src/example.ts#L1");
  agent.finish("session-1");
  await running;
ok("active editor file and selection attach to the next prompt");
}

// --- richer editor context attachments mirror the VS Code workspace ---------
{
  const { provider, agent, posted } = await build();
  agent.promptCapabilities = { image: true, embeddedContext: true };
  await provider.startAgent("scripted");

  const uri = { fsPath: "/workspace/src/app.ts", path: "/workspace/src/app.ts", toString: () => "file:///workspace/src/app.ts" };
  stub.activeTextEditor = {
    document: { uri, languageId: "typescript", lineCount: 10, getText: () => "selected" },
    selection: { isEmpty: true, start: { line: 0, character: 0 } },
  };
  stub.visibleTextEditors = [
    { document: { uri, languageId: "typescript", lineCount: 10 } },
  ];
  stub.diagnostics = [
    {
      uri,
      diagnostic: {
        range: { start: { line: 2, character: 4 } },
        severity: 0,
        code: "TS1234",
        message: "Example diagnostic",
      },
    },
  ];
  stub.workspaceFiles = [uri];
  stub.files.set(uri.fsPath, "console.log('ok');\n");

  provider.stageDiagnostics();
  provider.stageOpenEditors();
  provider.stageWorkspaceLayout();
  await provider.handleMessage({ type: "searchFiles", query: "app" });
  const suggestions = posted.filter((message) => message.type === "fileSuggestions").pop();
  assert.equal(suggestions.files[0].label, "src/app.ts");
  await provider.handleMessage({ type: "attachWorkspaceFile", path: uri.fsPath });
  await provider.handleMessage({
    type: "attachPastedImage",
    mimeType: "image/png",
    data: "aGVsbG8=",
    name: "clipboard.png",
  });

  const running = provider.handleMessage({ type: "prompt", text: "Use all context" });
  await until(() => agent.prompts.length === 1, "prompt with rich editor context");
  const prompt = agent.prompts[0].prompt;
  assert.equal(prompt.filter((block) => block.type === "resource").length, 4);
  assert.ok(prompt.some((block) => block.type === "resource" && block.resource.text.includes("Example diagnostic")));
  assert.ok(prompt.some((block) => block.type === "resource" && block.resource.text.includes("src/app.ts")));
  assert.ok(prompt.some((block) => block.type === "image" && block.data === "aGVsbG8="));
  agent.finish("session-1");
  await running;
  ok("diagnostics, workspace files, open editors, layout and pasted images attach to the next prompt");
}

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
  assert.match(stub.notifications.at(-1), /finished/);
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

  const request = provider.active().currentRequest;
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

// --- every live conversation survives a window reload -----------------------
{
  const first = await build();
  first.agent.supportsLoad = true;
  await first.provider.startAgent("scripted");

  // This check is about restore, not the live-session ceiling, so lift the cap
  // out of the way rather than letting it decide how many exist.
  stub.config.maxLiveSessions = 100;
  // Several finished conversations and one fresh, so restore has real work to do.
  for (const text of ["one", "two"]) {
    if (text === "two") await first.provider.newSession();
    const turn = first.provider.handleMessage({ type: "prompt", text });
    await tick();
    first.agent.finish(first.provider.active().sessionId);
    await turn;
  }
  await first.provider.newSession();
  for (let index = 0; index < 6; index += 1) await first.provider.newSession();
  assert.equal(first.provider.liveSessions().length, 9);

  // Leave the middle one on screen, so restore has to honour which was active.
  const middle = first.provider.liveSessions().find((s) => s.sessionId === "session-2");
  await first.provider.revealSession(middle.controllerId);
  assert.equal(first.provider.active().sessionId, "session-2");

  // The window closes. The supervisor keeps the agent process alive, but the
  // new extension host has to remember which conversations it was holding.
  first.provider.dispose();

  const reloaded = await build(first);
  await reloaded.provider.handleMessage({ type: "ready" });

  assert.deepEqual(
    reloaded.provider.liveSessions().map((s) => s.sessionId).sort(),
    Array.from({ length: 9 }, (_, index) => `session-${index + 1}`),
    "every conversation comes back, including more than the old startup cap",
  );
  assert.deepEqual(
    reloaded.agent.loaded.sort(),
    Array.from({ length: 9 }, (_, index) => `session-${index + 1}`),
    "each one is reloaded through the agent, so its context comes back too",
  );
  assert.equal(
    reloaded.provider.active().sessionId,
    "session-2",
    "the conversation that was on screen is the one restored to it",
  );
  ok("every live conversation is restored after a reload, with the right one on screen");

  const target = reloaded.provider.liveSessions().find((s) => s.sessionId === "session-1");
  await reloaded.provider.revealSession(target.controllerId);
  assert.equal(reloaded.provider.active().readOnly, false, "a restored session can be prompted");

  const running = reloaded.provider.handleMessage({ type: "prompt", text: "after reload" });
  await tick();
  assert.equal(reloaded.provider.active().lifecycle, "running");
  reloaded.agent.finish("session-1");
  await running;
  ok("a restored conversation accepts new prompts");
}

// --- agent preferences outlive a session ------------------------------------
{
  const first = await build();
  await first.provider.startAgent("scripted");
  await first.provider.handleMessage({
    type: "setConfigOption",
    id: "model",
    value: "fast",
  });
  assert.deepEqual(first.agent.optionCalls, [["model", "fast"]]);

  // A brand new conversation on the same agent must start where the user left
  // off, not back at the agent's default.
  first.agent.optionCalls.length = 0;
  first.agent.configOptions[0].currentValue = "default";
  await first.provider.newSession();
  assert.deepEqual(
    first.agent.optionCalls,
    [["model", "fast"]],
    "the remembered choice is re-applied to the new session",
  );

  // And re-applying a value the agent already holds is not worth a round trip.
  first.agent.optionCalls.length = 0;
  await first.provider.newSession();
  assert.deepEqual(first.agent.optionCalls, [], "no redundant round trip");
  ok("a config choice is remembered for the agent and restored on later sessions");

  // It must survive a reload too, since it lives in storage rather than state.
  first.provider.dispose();
  const reloaded = await build(first);
  reloaded.agent.configOptions[0].currentValue = "default";
  await reloaded.provider.startAgent("scripted");
  assert.deepEqual(reloaded.agent.optionCalls, [["model", "fast"]]);
  ok("a remembered config choice survives a window reload");
}

// --- permission mode is per agent -------------------------------------------
{
  const { provider } = await build();
  stub.config.agents = {
    scripted: { command: process.execPath },
    other: { command: process.execPath },
  };
  stub.config.permissionMode = "ask";

  await provider.startAgent("scripted");
  await provider.setAgentPermissionMode("scripted", "yolo");
  await provider.startAgent("other");

  // Reaching into the controllers is the only way to observe the mode the
  // ACP session was actually built with.
  const modeOf = (agentKey) => {
    const controller = [...provider.liveSessions()]
      .map((s) => s.controllerId)
      .map((id) => provider.sessions.get(id))
      .find((c) => c.agentKey === agentKey);
    return controller.session.currentPermissionMode;
  };
  assert.equal(modeOf("scripted"), "yolo", "the agent's own mode applies to its live session");
  assert.equal(modeOf("other"), "ask", "another agent still follows the global setting");
  ok("permission mode is set per agent and applies to that agent's live sessions");

  await provider.setAgentPermissionMode("scripted", undefined);
  assert.equal(modeOf("scripted"), "ask", "clearing returns the agent to the global setting");
  ok("an agent can be returned to the global permission mode");
}

// --- authentication happens in the panel ------------------------------------
{
  const { provider, agent, posted } = await build();
  agent.authMethods = [
    { id: "oauth", name: "Sign in with a browser" },
    { id: "token", name: "Paste an API token" },
  ];
  agent.requireAuth = true;

  const starting = provider.startAgent("scripted");
  await until(() => provider.active()?.currentRequest, "the authentication prompt");

  // The failure is surfaced where the user is already looking, as a choice,
  // rather than as a raw protocol error.
  const request = provider.active().currentRequest;
  assert.ok(request, "a failed first session offers authentication");
  assert.match(request.title, /needs to be authenticated/);
  assert.deepEqual(
    request.options.map((option) => option.optionId),
    ["oauth", "token", "reject"],
    "every advertised method is offered, plus a way out",
  );
  assert.match(request.content[0].text, /unauthenticated/, "the agent's own reason is shown");
  assert.equal(agent.authenticated.length, 0, "nothing is chosen on the user's behalf");

  await provider.handleMessage({ type: "respond", requestId: request.requestId, optionId: "token" });
  await starting;

  assert.deepEqual(agent.authenticated, ["token"], "the chosen method is the one used");
  assert.equal(provider.active().sessionId, "session-1", "the session opens once authenticated");
  assert.equal(provider.active().pending.length, 0);
  ok("a failed first session offers authentication in the panel and retries");
}

// --- declining authentication reports the real failure ----------------------
{
  const { provider, agent, posted } = await build();
  agent.authMethods = [{ id: "oauth", name: "Sign in" }];
  agent.requireAuth = true;

  const starting = provider.startAgent("scripted");
  await until(() => provider.active()?.currentRequest, "the authentication prompt");
  const request = provider.active().currentRequest;
  await provider.handleMessage({ type: "respond", requestId: request.requestId, optionId: "reject" });
  await starting;

  assert.deepEqual(agent.authenticated, []);
  assert.equal(provider.liveSessions().length, 0, "no half-built session is left behind");
  const errors = posted.filter((m) => m.type === "error").map((m) => m.message);
  assert.match(errors.pop(), /unauthenticated/, "declining surfaces the underlying reason");
  ok("declining authentication leaves the real failure visible");
}

// --- an agent needing no authentication is untouched -------------------------
{
  const { provider, agent } = await build();
  await provider.startAgent("scripted");
  assert.deepEqual(agent.authenticated, [], "an agent that works is never asked to authenticate");
  assert.equal(provider.active().sessionId, "session-1");
  ok("agents that need no authentication are not prompted");
}

// --- concurrent approvals are all reachable ---------------------------------
{
  const { provider, agent, posted } = await build();
  await provider.startAgent("scripted");
  const running = provider.handleMessage({ type: "prompt", text: "edit several files" });
  await tick();

  // An agent running tools concurrently raises several asks at once. Holding
  // only the newest left the earlier ones unanswerable, stalling the agent on
  // a promise nothing could resolve.
  const settled = [];
  const first = agent.ask("session-1", "Write a.ts").then((v) => (settled.push("a"), v));
  await tick();
  const second = agent.ask("session-1", "Write b.ts").then((v) => (settled.push("b"), v));
  await tick();
  const third = agent.ask("session-1", "Write c.ts").then((v) => (settled.push("c"), v));
  await tick();

  assert.equal(provider.active().pending.length, 3, "all three asks are held");
  assert.equal(
    provider.active().currentRequest.title,
    "Write a.ts",
    "the oldest ask is the one shown, so nothing waits behind a newer one forever",
  );

  const shown = posted.filter((m) => m.type === "pending").pop();
  assert.equal(shown.pendingCount, 3, "the view is told how many are waiting");

  // Answer them oldest-first; each must reach the call that raised it.
  for (const title of ["Write a.ts", "Write b.ts", "Write c.ts"]) {
    const request = provider.active().currentRequest;
    assert.equal(request.title, title);
    await provider.handleMessage({ type: "respond", requestId: request.requestId, optionId: "yes" });
    await tick();
  }

  assert.deepEqual(await Promise.all([first, second, third]), [
    { outcome: { outcome: "selected", optionId: "yes" } },
    { outcome: { outcome: "selected", optionId: "yes" } },
    { outcome: { outcome: "selected", optionId: "yes" } },
  ]);
  assert.deepEqual(settled, ["a", "b", "c"]);
  assert.equal(provider.active().pending.length, 0);
  assert.equal(provider.active().lifecycle, "running", "back to merely working");
  ok("several concurrent approvals are all reachable and each reaches its own caller");

  agent.finish("session-1");
  await running;
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

// --- a dead agent keeps saying so -------------------------------------------
{
  const { provider, agent } = await build();
  await provider.startAgent("scripted");
  const controllerId = provider.liveSessions()[0].controllerId;

  agent.die(3);
  for (let i = 0; i < 20; i += 1) await tick();

  assert.equal(
    provider.liveSessions()[0].lifecycle,
    "disconnected",
    "the exit is reflected in the session's lifecycle",
  );

  // Anything that recomputes the lifecycle must not quietly decide the
  // session is fine again just because it is no longer busy.
  provider.sessions.get(controllerId).refreshLifecycle();
  assert.equal(
    provider.liveSessions()[0].lifecycle,
    "disconnected",
    "a session whose agent has exited must not report itself idle",
  );
  ok("a session whose agent exited keeps reporting disconnected");
}

// --- an interrupted restore does not lose the other conversations ------------
{
  const first = await build();
  first.agent.supportsLoad = true;
  await first.provider.startAgent("scripted");
  await first.provider.newSession();
  await first.provider.newSession();
  assert.equal(first.provider.liveSessions().length, 3);
  first.provider.dispose();

  // The second conversation cannot be reloaded, so restore stops short of the
  // full set. What was saved must still describe all three, or the ones it
  // never reached are lost for good.
  const reloaded = await build(first);
  reloaded.agent.failLoadFor = "session-2";
  await reloaded.provider.handleMessage({ type: "ready" });

  const saved = reloaded.workspaceState.get("rostrum.liveSessions");
  assert.deepEqual(
    saved.sessions.map((entry) => entry.sessionId).sort(),
    ["session-1", "session-2", "session-3"],
    "a partial restore must not shrink the saved set",
  );
  ok("a restore that cannot reopen every conversation still remembers them all");
}

// --- a hung authentication prompt cannot wedge the agent ---------------------
{
  const { provider, agent } = await build();
  agent.authMethods = [{ id: "oauth", name: "Sign in" }];
  agent.requireAuth = true;

  const starting = provider.startAgent("scripted");
  await until(() => provider.active()?.currentRequest, "the authentication prompt");

  // Restarting the agent tears down the controller holding the prompt. The
  // caller waiting on that answer must not wait forever.
  provider.dispose();
  await Promise.race([
    starting,
    new Promise((_, reject) => setTimeout(() => reject(new Error("startAgent never settled")), 2000)),
  ]);
  ok("discarding a session answers any prompt it was holding, instead of hanging");
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

// --- the session ceiling and idle dehydration -------------------------------
{
  const { provider, agent } = await build();
  agent.supportsLoad = true;
  stub.config.sessionIdleMinutes = 30;
  await provider.startAgent("scripted");
  await provider.newSession();
  assert.equal(provider.liveSessions().length, 2, "two live conversations to work with");

  // The one on screen is exempt however stale it looks.
  for (const entry of provider.controllers()) entry.updatedAt = Date.now() - 60 * 60_000;
  const closed = await provider.sweepIdleSessions();
  assert.equal(closed, 1, "only the off-screen conversation is closed");
  assert.equal(provider.liveSessions().length, 1);
  assert.equal(provider.liveSessions()[0].active, true, "the visible conversation survives");
  ok("an idle off-screen conversation is released and the visible one is not");
}

{
  const { provider, agent } = await build();
  // An agent that can neither load nor resume cannot give a conversation back,
  // so releasing one would silently turn live work into read-only history.
  agent.supportsLoad = false;
  stub.config.sessionIdleMinutes = 30;
  await provider.startAgent("scripted");
  await provider.newSession();
  for (const entry of provider.controllers()) entry.updatedAt = Date.now() - 60 * 60_000;

  assert.equal(await provider.sweepIdleSessions(), 0, "nothing the agent cannot restore is closed");
  assert.equal(provider.liveSessions().length, 2);
  ok("a conversation its agent cannot reopen is never closed on idle");
}

{
  const { provider, agent } = await build();
  agent.supportsLoad = true;
  stub.config.sessionIdleMinutes = 0;
  await provider.startAgent("scripted");
  await provider.newSession();
  for (const entry of provider.controllers()) entry.updatedAt = 0;
  assert.equal(await provider.sweepIdleSessions(), 0, "zero disables idle closing outright");
  ok("setting the idle window to zero switches idle closing off");
}

// --- a conversation can be rooted in a subdirectory -------------------------
{
  const { provider, agent } = await build();
  await provider.startAgent("scripted");
  const root = stub.workspaceFolders[0];
  const sub = path.join(root, "packages", "api");

  await provider.newSession(undefined, sub);
  assert.equal(agent.lastNewSession.cwd, sub, "the chosen directory reaches session/new");

  await provider.newSession();
  assert.equal(agent.lastNewSession.cwd, root, "without one, the workspace root is used");
  ok("a conversation can be opened in a subdirectory of the workspace");
}

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\nPASS: ${passed} provider checks`);
