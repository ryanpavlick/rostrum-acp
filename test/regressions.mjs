/**
 * Regressions for the two defects found in review:
 *   1. a streamed text delta erased earlier blocks (tool calls vanished)
 *   2. the workspace guard was a bare prefix test and never resolved ".."
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Session } from "../out/test/session.js";

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ok  ${name}`); };

// --- 1. delta contract ------------------------------------------------------
// Mirror the webview's apply logic exactly, so the two halves are tested together.
const view = new Map();
const events = {
  onTurn(turn) { view.set(turn.id, structuredClone(turn)); },
  onTurnDelta(turnId, index, block) {
    const t = view.get(turnId);
    if (t) t.blocks[index] = structuredClone(block);
  },
  onPending() {}, onModes() {}, onError() {},
};

const s = new Session(events, "/workspace", "yolo");
const upd = (update) => s.sessionUpdate({ sessionId: "x", update });

await upd({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read", kind: "read", status: "in_progress" });
await upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Here " } });
await upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "you go." } });
await upd({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });

const host = s.getTurns()[0].blocks;
const mirrored = view.get(s.getTurns()[0].id).blocks;

assert.deepEqual(mirrored.map((b) => b.kind), host.map((b) => b.kind),
  "view and host must agree on block layout");
assert.equal(host[0].kind, "tool", "the tool call must survive the text stream");
ok("streamed text does not erase an earlier tool call");

assert.equal(host[1].text, "Here you go.", "chunks coalesce");
ok("text chunks coalesce into one block");

assert.equal(mirrored[0].call.status, "completed", "late tool updates reach the view");
ok("tool status update targets the right block");

await upd({
  sessionUpdate: "agent_message_chunk",
  content: { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
});
await upd({
  sessionUpdate: "tool_call_update",
  toolCallId: "t1",
  content: [{
    type: "content",
    content: {
      type: "resource",
      resource: { uri: "file:///workspace/context.txt", mimeType: "text/plain", text: "context" },
    },
  }],
});
assert.equal(s.getTurns()[0].blocks.some((block) => block.kind === "image"), true, "agent media must be retained");
assert.match(s.getTurns()[0].blocks.find((block) => block.kind === "tool").call.output, /context/);
assert.equal(s.getTurns()[0].blocks.some((block) => block.kind === "resource"), true);
ok("agent media and embedded resources are not discarded");

// --- 2. workspace guard -----------------------------------------------------
const guard = new Session(events, "/workspace", "ask");
const escapes = [
  "/workspace-evil/secrets.txt",
  "/workspace/../etc/passwd",
  "../outside.txt",
  "/etc/passwd",
];

for (const p of escapes) {
  await assert.rejects(
    () => guard.readTextFile({ sessionId: "x", path: p }),
    /outside the workspace/,
    `must refuse ${p}`,
  );
}
ok(`workspace escapes refused (${escapes.length} vectors)`);

// A legitimate path must still resolve (ENOENT proves it passed the guard).
await assert.rejects(
  () => guard.readTextFile({ sessionId: "x", path: "inside.txt" }),
  (e) => !/outside the workspace/.test(String(e)),
  "in-workspace paths must not be blocked",
);
ok("in-workspace paths still allowed");

// Lexical checks alone are insufficient: an in-workspace symlink may point
// outside. Verify both an existing read target and a prospective write below
// that symlink are rejected.
const linkRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rostrum-workspace-"));
const outside = await fs.mkdtemp(path.join(os.tmpdir(), "rostrum-outside-"));
await fs.writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
await fs.symlink(outside, path.join(linkRoot, "linked"));
const symlinkGuard = new Session(events, linkRoot, "ask");
await assert.rejects(
  () => symlinkGuard.readTextFile({ sessionId: "x", path: "linked/secret.txt" }),
  /outside the workspace/,
);
await assert.rejects(
  () => symlinkGuard.writeTextFile({ sessionId: "x", path: "linked/new.txt", content: "nope" }),
  /outside the workspace/,
);
ok("workspace symlink escapes refused for reads and writes");

console.log(`\nPASS: ${passed} regression checks`);
