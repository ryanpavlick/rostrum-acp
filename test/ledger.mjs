/**
 * Capability ledger checks.
 *
 * Rostrum gates optional actions on what an agent declares, so an agent that
 * declares a method and then fails it shows up as a feature offered and then
 * broken. These checks cover the states that distinction produces — above all
 * "declared but every call has failed", which is the finding a compatibility
 * report exists to surface and the one nobody collects by hand.
 */
import assert from "node:assert/strict";
import { CapabilityLedger, stateOf } from "../out/test/ledger.js";

let passed = 0;
const ok = (n) => { passed += 1; console.log(`  ok  ${n}`); };
const stateFor = (agentKey, ledger, method) =>
  ledger.report(agentKey).find((entry) => entry.method === method)?.state;

{
  const l = new CapabilityLedger();
  l.declare("a", { "session/load": true, "session/fork": false });
  assert.equal(stateFor("a", l, "session/load"), "unexercised",
    "declaring is not evidence that it works");
  assert.equal(stateFor("a", l, "session/fork"), "not-declared");
  ok("a declared capability starts unexercised, not working");
}

{
  const l = new CapabilityLedger();
  l.declare("a", { "session/load": true });
  l.record("a", "session/load", true);
  l.record("a", "session/load", true);
  assert.equal(stateFor("a", l, "session/load"), "working");
  assert.equal(l.suspect("a").length, 0);
  ok("a capability that keeps working reports as working");
}

{
  // The whole point: advertised, called, never once succeeded.
  const l = new CapabilityLedger();
  l.declare("a", { "session/load": true });
  l.record("a", "session/load", false, new Error("method not implemented\nat foo"));
  l.record("a", "session/load", false, new Error("method not implemented"));
  const entry = l.report("a")[0];
  assert.equal(entry.state, "failing");
  assert.equal(entry.attempts, 2);
  assert.equal(entry.failures, 2);
  assert.equal(entry.lastError, "method not implemented", "the stack is not the finding");
  assert.deepEqual(l.suspect("a").map((e) => e.method), ["session/load"]);
  ok("a capability declared and never working is reported as failing");
}

{
  const l = new CapabilityLedger();
  l.declare("a", { "session/list": true });
  l.record("a", "session/list", true);
  l.record("a", "session/list", false, "timed out");
  assert.equal(stateFor("a", l, "session/list"), "unreliable",
    "one success does not clear a failure");
  assert.deepEqual(l.suspect("a").map((e) => e.method), ["session/list"]);
  ok("a capability that works only sometimes is called unreliable");
}

{
  // Should be unreachable while every call site gates on the declaration.
  // If it ever shows up, the gate has a hole and this names it.
  assert.equal(stateOf({ declared: false, attempts: 1, failures: 0 }), "undeclared-but-working");
  ok("a method used without being declared is named, not hidden");
}

{
  const l = new CapabilityLedger();
  l.declare("a", { "session/load": true });
  l.record("a", "session/load", false, "nope");
  // Reconnecting re-declares; the history it earned must survive that.
  l.declare("a", { "session/load": true });
  assert.equal(l.report("a")[0].attempts, 1, "re-declaring keeps what was observed");
  assert.equal(stateFor("a", l, "session/load"), "failing");
  ok("re-declaring on reconnect does not erase the call history");
}

{
  const l = new CapabilityLedger();
  l.declare("a", { "session/load": true });
  await assert.rejects(
    () => l.watch("a", "session/load", async () => { throw new Error("boom"); }),
    /boom/,
    "watch observes without swallowing",
  );
  assert.equal(stateFor("a", l, "session/load"), "failing");
  assert.equal(await l.watch("a", "session/load", () => "value"), "value",
    "a non-promise result is handled too");
  assert.equal(stateFor("a", l, "session/load"), "unreliable");
  ok("watch records both outcomes and re-throws the failure unchanged");
}

{
  const l = new CapabilityLedger();
  l.declare("a", { "session/load": true });
  l.declare("b", { "session/load": true });
  l.record("a", "session/load", false, "nope");
  assert.equal(stateFor("b", l, "session/load"), "unexercised", "agents do not share history");
  l.forget("a");
  assert.deepEqual(l.report("a"), []);
  assert.equal(stateFor("b", l, "session/load"), "unexercised");
  ok("observations are per agent and can be forgotten individually");
}

{
  // Modelled on Codex, which advertises session/load and session/resume and
  // answers "Internal error" to both.
  const l = new CapabilityLedger();
  l.declare("codex", { "session/load": true, "session/resume": true });
  assert.equal(l.usable("codex", "session/load", true), true,
    "before any evidence, a declaration is taken at face value");

  l.record("codex", "session/load", false, "Internal error");
  assert.equal(l.usable("codex", "session/load", true), false,
    "a method that has never worked is not usable, whatever it declared");
  assert.equal(l.usable("codex", "session/resume", true), true,
    "the other method is judged on its own record");

  l.record("codex", "session/load", true);
  assert.equal(l.usable("codex", "session/load", true), true,
    "one success makes it unreliable rather than unusable");

  assert.equal(l.usable("codex", "session/fork", false), false,
    "something never declared is never usable");
  ok("usability follows the evidence, not the declaration");
}

console.log(`\nPASS: ${passed} ledger checks`);
