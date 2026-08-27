/**
 * Transcript windowing rules.
 *
 * These decide which turns exist in the DOM at all, so getting them wrong
 * loses agent output or shows it out of order — the same class of fault the
 * reconnect chaos check exists to catch, one layer up.
 */
import assert from "node:assert/strict";
import {
  TURN_WINDOW,
  shouldCollapse,
  shouldRenderUpdate,
  windowTurns,
} from "../out/test/transcript.js";

let passed = 0;
const ok = (n) => { passed += 1; console.log(`  ok  ${n}`); };
const turns = (count, offset = 0) =>
  Array.from({ length: count }, (_, i) => ({ id: `t${i + offset}`, role: "agent", blocks: [] }));

{
  const short = turns(5);
  const w = windowTurns(short, false);
  assert.equal(w.hidden, 0);
  assert.deepEqual(w.shown, short, "a short conversation is never truncated");
  ok("a conversation shorter than the window is shown whole");
}

{
  const long = turns(TURN_WINDOW + 12);
  const w = windowTurns(long, false);
  assert.equal(w.shown.length, TURN_WINDOW);
  assert.equal(w.hidden, 12);
  assert.equal(w.shown.at(-1).id, long.at(-1).id, "the newest turn is always built");
  assert.equal(w.shown[0].id, long[12].id, "the window is a suffix, not a sample");
  ok("a long conversation builds only its newest turns");
}

{
  const long = turns(TURN_WINDOW + 12);
  const w = windowTurns(long, true);
  assert.equal(w.hidden, 0);
  assert.equal(w.shown.length, long.length, "expanding builds everything");
  ok("asking for the earlier turns builds the whole conversation");
}

{
  const long = turns(TURN_WINDOW + 5);
  const w = windowTurns(long, false);
  // The oldest turn is outside the window and has no node.
  assert.equal(shouldRenderUpdate(long[0].id, w, false), false,
    "an update for an unbuilt, out-of-window turn is dropped rather than appended");
  // ...but if it was built before the window moved, it must still update.
  assert.equal(shouldRenderUpdate(long[0].id, w, true), true,
    "a turn already on screen is updated wherever the window now sits");
  assert.equal(shouldRenderUpdate(long.at(-1).id, w, false), true,
    "a new turn inside the window is built");
  ok("updates are dropped only when the turn is neither built nor in the window");
}

{
  assert.equal(shouldCollapse("session-1", "session-1"), false,
    "a state push during a turn must not undo the user's expansion");
  assert.equal(shouldCollapse("session-1", "session-2"), true);
  assert.equal(shouldCollapse(null, "session-1"), true);
  ok("expansion survives a state push and is forgotten on a real switch");
}

console.log(`\nPASS: ${passed} transcript checks`);
