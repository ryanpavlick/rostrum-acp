/**
 * End-to-end check of the question path, driving the real Session class
 * against the mock Qwen-dialect agent.
 *
 * Asserts the two things the original bug got wrong:
 *   1. the questions reach the UI at all, and
 *   2. the answers reach the agent as a top-level `answers` map.
 */
import assert from "node:assert/strict";
import { launchAgent } from "../out/test/agentProcess.js";
import { Session } from "../out/test/session.js";

const events = {
  turns: [],
  pending: null,
  onTurn(turn) {
    this.turns.push(turn);
  },
  onTurnDelta() {},
  onPending(request) {
    this.pending = request;
  },
  onModes() {},
  onError(message) {
    console.error("agent error:", message);
  },
};

const session = new Session(events, process.cwd(), "yolo");

let stderr = "";
const handle = launchAgent(
  { command: "python3", args: ["test/mock-agent.py"], cwd: process.cwd() },
  () => session,
  (chunk) => {
    stderr += chunk;
  },
);

const agent = handle.agent;
await agent.initialize({ protocolVersion: 1, clientCapabilities: { fs: {} } });
const { sessionId } = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
session.sessionId = sessionId;

// Answer as soon as the prompt surfaces, mimicking the webview.
const answered = new Promise((resolve) => {
  const timer = setInterval(() => {
    if (!events.pending) return;
    clearInterval(timer);
    const request = events.pending;
    session.respond(request.requestId, "proceed_once", {
      "0": "Clamp-on",
      "1": "PLA, PETG",
    });
    resolve(request);
  }, 10);
});

const [request] = await Promise.all([
  answered,
  agent.prompt({ sessionId, prompt: [{ type: "text", text: "design a mount" }] }),
]);

handle.dispose();

// --- assertions -------------------------------------------------------------

assert.ok(request, "no permission request ever surfaced");
assert.ok(request.questions, "questions were not detected — the card would render empty");
assert.equal(request.questions.length, 2, "expected both questions");
assert.equal(request.questions[0].header, "Mount type");
assert.equal(request.questions[0].options.length, 2);
assert.equal(request.questions[1].multiSelect, true, "multiSelect flag lost");

const line = stderr.split("\n").find((l) => l.startsWith("PERMISSION_RESULT:"));
assert.ok(line, "agent never reported a permission result");
const result = JSON.parse(line.slice("PERMISSION_RESULT:".length));

assert.equal(result.outcome.outcome, "selected");
assert.equal(result.outcome.optionId, "proceed_once");
assert.deepEqual(
  result.answers,
  { "0": "Clamp-on", "1": "PLA, PETG" },
  "answers did not reach the agent as a top-level map — this is the original bug",
);

console.log("PASS: questions surfaced and answers round-tripped to the agent");
