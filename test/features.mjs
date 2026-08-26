/** Checks for the ten review fixes that are testable headlessly. */
import assert from "node:assert/strict";
import { Session, displayBlocks } from "../out/test/session.js";
import { TerminalRegistry } from "../out/test/terminals.js";

let passed = 0;
const ok = (n) => { passed += 1; console.log(`  ok  ${n}`); };

const sink = { onTurn(){}, onTurnDelta(){}, onPending(){}, onModes(){}, onError(){} };

// --- slash commands + plan ---------------------------------------------------
let commands = null, plan = null, configOptions = null;
const s = new Session(
  {
    ...sink,
    onCommands: (c) => (commands = c),
    onPlan: (p) => (plan = p),
    onConfigOptions: (options) => (configOptions = options),
  },
  "/workspace", "yolo",
);

await s.sessionUpdate({ sessionId: "x", update: {
  sessionUpdate: "available_commands_update",
  availableCommands: [
    { name: "compress", description: "Compress context" },
    { name: "model", description: "Switch model", input: { hint: "model name" } },
  ],
}});
assert.equal(commands.length, 2);
assert.equal(commands[1].hint, "model name", "input hint is carried through");
ok("slash commands are consumed (previously dropped)");

await s.sessionUpdate({ sessionId: "x", update: {
  sessionUpdate: "plan",
  entries: [
    { content: "Read the code", status: "completed", priority: "high" },
    { content: "Write the fix", status: "in_progress" },
  ],
}});
assert.equal(plan.length, 2);
assert.equal(plan[0].status, "completed");
ok("plan updates are consumed (previously dropped)");

await s.sessionUpdate({ sessionId: "x", update: {
  sessionUpdate: "config_option_update",
  configOptions: [{ id: "reasoning", name: "Reasoning", type: "select", currentValue: "high", options: [] }],
}});
assert.equal(configOptions[0].currentValue, "high");
ok("agent-driven config option updates reach the host");

// Attachments become part of the durable user turn, not transient composer UI.
const attachmentSession = new Session({ ...sink }, "/workspace", "ask");
attachmentSession.addUserTurn("Please inspect this", displayBlocks({
  type: "image", mimeType: "image/png", data: "aGVsbG8=",
}));
assert.deepEqual(attachmentSession.getTurns()[0].blocks.map((block) => block.kind), ["text", "image"]);
ok("sent attachments persist in the user transcript");

// --- elicitation -------------------------------------------------------------
let captured = null;
const elicitSession = new Session(
  { ...sink, onElicit: (req, resolve) => { captured = req; resolve({ "0": "PostgreSQL" }); } },
  "/workspace", "ask",
);

const accepted = await elicitSession.createElicitation({
  message: "Which database?",
  requestedSchema: {
    type: "object",
    properties: { database: { title: "Which database?", enum: ["PostgreSQL", "SQLite"] } },
  },
});
assert.equal(captured.questions.length, 1);
assert.equal(captured.questions[0].options.length, 2, "enum becomes choices");
assert.equal(accepted.action, "accept");
assert.deepEqual(accepted.content, { database: "PostgreSQL" }, "answers re-key by field name");
ok("elicitation renders as a question and returns field-keyed answers");

const declined = new Session({ ...sink }, "/workspace", "ask");
const noHandler = await declined.createElicitation({ message: "x", requestedSchema: { properties: {} } });
assert.equal(noHandler.action, "decline", "an unrenderable elicitation declines rather than hanging");
ok("empty elicitation declines instead of hanging");

// --- terminals ---------------------------------------------------------------
const terminals = new TerminalRegistry();
const id = terminals.create({ command: "sh", args: ["-c", "echo hello; echo err 1>&2; exit 3"] });
const exit = await terminals.waitForExit(id);
assert.equal(exit.exitCode, 3, "exit code is reported");

const out = terminals.output(id);
assert.match(out.output, /hello/, "stdout captured");
assert.match(out.output, /err/, "stderr captured");
ok("terminals run, capture both streams, and report exit codes");

const capped = terminals.create({ command: "sh", args: ["-c", "yes abcdefgh | head -c 50000"], outputByteLimit: 1000 });
await terminals.waitForExit(capped);
const cappedOut = terminals.output(capped);
assert.ok(cappedOut.output.length <= 1000, "output is capped");
assert.equal(cappedOut.truncated, true, "truncation is reported");
ok("terminal output is capped and flagged truncated");

terminals.disposeAll();
assert.throws(() => terminals.output(id), /Unknown terminal/);
ok("disposeAll releases every terminal");

console.log(`\nPASS: ${passed} feature checks`);
