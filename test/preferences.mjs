/**
 * Per-agent preference checks.
 *
 * Model and reasoning controls arrive as generic ACP config options, so what
 * Rostrum can offer is memory: the choice a user made for one agent has to
 * come back on that agent's next session, and must never leak onto another.
 */
import assert from "node:assert/strict";
import { Preferences } from "../out/test/preferences.js";

let passed = 0;
const ok = (n) => { passed += 1; console.log(`  ok  ${n}`); };

function storage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get: (key) => map.get(key),
    update: async (key, value) => void map.set(key, value),
    raw: map,
  };
}

// --- config options ----------------------------------------------------------
const store = storage();
const prefs = new Preferences(store);

assert.deepEqual(prefs.forAgent("qwen"), { configOptions: {} });
ok("an agent with no history has empty preferences");

await prefs.setConfigOption("qwen", "model", "qwen-max");
await prefs.setConfigOption("qwen", "reasoning", "high");
await prefs.setConfigOption("claude", "model", "opus");

assert.deepEqual(prefs.forAgent("qwen").configOptions, { model: "qwen-max", reasoning: "high" });
assert.deepEqual(prefs.forAgent("claude").configOptions, { model: "opus" });
ok("choices are remembered per agent and never leak between agents");

await prefs.setConfigOption("qwen", "model", "qwen-turbo");
assert.equal(prefs.forAgent("qwen").configOptions.model, "qwen-turbo");
assert.equal(prefs.forAgent("qwen").configOptions.reasoning, "high", "other options survive");
ok("changing one option leaves the rest of that agent's choices alone");

await prefs.setConfigOption("qwen", "thinking", true);
assert.equal(prefs.forAgent("qwen").configOptions.thinking, true);
ok("boolean options are remembered as booleans");

// --- what to re-apply --------------------------------------------------------
const reported = [
  { id: "model", currentValue: "qwen-plus" },
  { id: "reasoning", currentValue: "high" },
  { id: "thinking", currentValue: false },
  { id: "unknown", currentValue: "x" },
];
assert.deepEqual(prefs.pendingOptions("qwen", reported), [
  { id: "model", value: "qwen-turbo" },
  { id: "thinking", value: true },
]);
ok("only options whose saved value differs from the agent's are re-applied");

assert.deepEqual(
  prefs.pendingOptions("qwen", [{ id: "model", currentValue: "qwen-turbo" }]),
  [],
  "a value the agent already holds costs a round trip for nothing",
);
assert.deepEqual(prefs.pendingOptions("nobody", reported), []);
ok("an agent with no saved choices asks for no changes");

// A null current value still counts as different, so a fresh session is set up.
assert.deepEqual(
  prefs.pendingOptions("claude", [{ id: "model", currentValue: null }]),
  [{ id: "model", value: "opus" }],
);
ok("an option the agent reports as unset is restored");

// --- permission mode ---------------------------------------------------------
assert.equal(prefs.permissionMode("qwen", "ask"), "ask", "the global default applies by default");

await prefs.setPermissionMode("qwen", "yolo");
assert.equal(prefs.permissionMode("qwen", "ask"), "yolo");
assert.equal(prefs.permissionMode("claude", "ask"), "ask", "one agent's mode is not another's");
assert.equal(
  prefs.forAgent("qwen").configOptions.model,
  "qwen-turbo",
  "setting a mode does not discard the config options",
);
ok("permission mode is remembered per agent, independently of the global setting");

await prefs.setPermissionMode("qwen", undefined);
assert.equal(prefs.permissionMode("qwen", "acceptEdits"), "acceptEdits");
assert.equal(
  "permissionMode" in prefs.forAgent("qwen"),
  false,
  "clearing must remove the override, not store an empty one",
);
ok("an agent can be returned to following the global setting");

// --- hostile or stale storage ------------------------------------------------
for (const junk of [null, "a string", [1, 2], 42, { qwen: "not an object" }, { qwen: null }]) {
  const hostile = new Preferences(storage({ "rostrum.agentPreferences": junk }));
  assert.doesNotThrow(() => hostile.forAgent("qwen"));
  assert.deepEqual(hostile.forAgent("qwen"), { configOptions: {} });
  assert.equal(hostile.permissionMode("qwen", "ask"), "ask");
}
ok("malformed stored preferences fall back to defaults instead of throwing");

const partial = new Preferences(
  storage({
    "rostrum.agentPreferences": {
      qwen: { configOptions: { good: "yes", bad: { nested: 1 }, alsoBad: null }, permissionMode: "nonsense" },
    },
  }),
);
assert.deepEqual(partial.forAgent("qwen").configOptions, { good: "yes" });
assert.equal(
  partial.permissionMode("qwen", "ask"),
  "ask",
  "an unrecognised permission mode must not be honoured",
);
ok("only well-formed values are read back out of storage");

// --- forgetting --------------------------------------------------------------
await prefs.forget("qwen");
assert.deepEqual(prefs.forAgent("qwen"), { configOptions: {} });
assert.equal(prefs.forAgent("claude").configOptions.model, "opus", "other agents are untouched");
ok("one agent's preferences can be forgotten without affecting the rest");

console.log(`\nPASS: ${passed} preference checks`);
