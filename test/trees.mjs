/**
 * Sessions view checks.
 *
 * The view has to answer two questions at a glance: what is running right now,
 * and what happened before. That means live conversations come from the chat
 * provider rather than the store, a conversation never appears in both halves,
 * and a background session that needs the user is visibly different from one
 * that is merely busy.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { SessionsTree } from "../out/test/trees.js";
import { SessionStore } from "../out/test/store.js";

let passed = 0;
const ok = (n) => { passed += 1; console.log(`  ok  ${n}`); };

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rostrum-trees-"));
const store = new SessionStore(path.join(tmp, "sessions"));

const DAY = 24 * 60 * 60 * 1000;
const noon = new Date().setHours(12, 0, 0, 0);

const save = (sessionId, title, updatedAt) =>
  store.save({
    sessionId,
    agentKey: "qwen",
    title,
    updatedAt,
    turns: [{ id: "t1", role: "user", blocks: [{ kind: "text", text: title }] }],
  });

await save("s-today", "Today's work", noon);
await save("s-yesterday", "Yesterday's work", noon - DAY);
await save("s-week", "Last week", noon - 4 * DAY);
await save("s-month", "Last month", noon - 20 * DAY);
await save("s-ancient", "Long ago", noon - 200 * DAY);
await save("s-running", "Currently running", noon);

const liveSessions = [
  {
    controllerId: "c1",
    sessionId: "s-running",
    agentKey: "qwen",
    title: "Currently running",
    lifecycle: "running",
    active: true,
    updatedAt: noon,
    createdAt: noon,
    queued: 2,
  },
  {
    controllerId: "c2",
    sessionId: "s-blocked",
    agentKey: "claude",
    title: "Needs a decision",
    lifecycle: "awaiting-approval",
    active: false,
    updatedAt: noon,
    createdAt: noon + 1,
    queued: 0,
  },
  {
    controllerId: "c3",
    sessionId: null,
    agentKey: "claude",
    title: "Old transcript",
    lifecycle: "idle",
    active: false,
    updatedAt: noon,
    createdAt: noon + 2,
    queued: 0,
  },
];

const tree = new SessionsTree(store);
tree.setLiveSource(() => liveSessions);

const groups = await tree.getChildren();
const labels = groups.map((group) => group.label);
assert.deepEqual(labels, ["Active", "Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"]);
ok("saved conversations are grouped into time periods under the active ones");

const active = groups[0];
assert.equal(active.children.length, 3);
assert.deepEqual(
  active.children.map((node) => node.session.title),
  ["Currently running", "Needs a decision", "Old transcript"],
);
ok("every live conversation appears under Active, not just the visible one");

const today = groups.find((group) => group.label === "Today");
assert.deepEqual(today.children.map((node) => node.session.sessionId), ["s-today"]);
ok("a conversation that is live is not also listed as history");

for (const [label, ids] of [
  ["Yesterday", ["s-yesterday"]],
  ["Previous 7 days", ["s-week"]],
  ["Previous 30 days", ["s-month"]],
  ["Older", ["s-ancient"]],
]) {
  const group = groups.find((entry) => entry.label === label);
  assert.deepEqual(group.children.map((node) => node.session.sessionId), ids, `${label} bucket`);
}
ok("each saved conversation lands in the right time bucket");

// --- presentation ------------------------------------------------------------
const running = tree.getTreeItem(active.children[0]);
assert.equal(running.iconPath.id, "sync~spin");
assert.equal(running.iconPath.color.id, "charts.blue");
assert.match(running.description, /qwen · running · 2 queued/);
assert.deepEqual(running.command, {
  command: "rostrum.revealSession",
  title: "Show conversation",
  arguments: ["c1"],
});
ok("a running conversation is shown as running, with its queue depth");

const blocked = tree.getTreeItem(active.children[1]);
assert.equal(blocked.iconPath.id, "question");
assert.equal(blocked.iconPath.color.id, "notificationsWarningIcon.foreground");
assert.match(blocked.description, /needs approval/);
assert.notEqual(
  blocked.iconPath.id,
  running.iconPath.id,
  "a session waiting on the user must not look like one that is merely busy",
);
ok("a session awaiting approval is visually distinct from a running one");

const readOnly = tree.getTreeItem(active.children[2]);
assert.equal(
  readOnly.contextValue,
  "rostrum.liveSession",
  "a transcript with no ACP session must not offer export or delete by id",
);
assert.equal(running.contextValue, "rostrum.session");
ok("only conversations with a session id offer the id-based actions");

const stored = tree.getTreeItem(today.children[0]);
assert.equal(stored.iconPath.id, "history");
assert.deepEqual(stored.command.arguments, ["s-today"]);
assert.equal(stored.command.command, "rostrum.loadSession");
ok("saved conversations load by session id");

// --- ids stay distinct across the two halves ---------------------------------
const everyId = [
  ...groups.map((group) => tree.getTreeItem(group).id),
  ...groups.flatMap((group) => group.children.map((node) => tree.getTreeItem(node).id)),
];
assert.equal(new Set(everyId).size, everyId.length, "tree item ids must be unique");
ok("live and saved rows never collide on a tree item id");

// --- filters ------------------------------------------------------------------
tree.setFilter({ window: "today" });
const todayOnly = await tree.getChildren();
assert.deepEqual(
  todayOnly.map((group) => group.label),
  ["Active", "Today"],
  "a time filter drops the buckets outside the window",
);

tree.setFilter({ window: "all", agentKey: "claude" });
const claudeOnly = await tree.getChildren();
const claudeActive = claudeOnly.find((group) => group.label === "Active");
assert.deepEqual(
  claudeActive.children.map((node) => node.session.title).sort(),
  ["Currently running", "Needs a decision", "Old transcript"].sort(),
  "the conversation on screen stays visible even when the filter excludes it",
);
assert.equal(
  claudeOnly.some((group) => group.label !== "Active"),
  false,
  "no saved qwen conversation survives an agent filter for claude",
);
ok("sessions can be filtered by time window and by agent");

tree.setFilter({ window: "all", agentKey: "nobody" });
const none = await tree.getChildren();
assert.deepEqual(
  none.flatMap((group) => group.children.map((node) => node.session.title)),
  ["Currently running"],
  "only the on-screen conversation survives a filter that matches nothing",
);
ok("a filter matching nothing still leaves the visible conversation reachable");

assert.deepEqual((await tree.agents()).sort(), ["claude", "qwen"]);
ok("the agents present across live and saved sessions drive the filter picker");

tree.setFilter({ window: "all" });

// --- no live sessions ---------------------------------------------------------
tree.setLiveSource(() => []);
const quiet = await tree.getChildren();
assert.equal(quiet.find((group) => group.label === "Active"), undefined);
assert.deepEqual(
  // Both were saved at the same instant, so their relative order is not meaningful.
  quiet.find((group) => group.label === "Today").children.map((node) => node.session.sessionId).sort(),
  ["s-running", "s-today"],
);
ok("with nothing running the view is pure history again");

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\nPASS: ${passed} sessions view checks`);
