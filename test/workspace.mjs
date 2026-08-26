/**
 * Change and workspace view checks.
 *
 * The Changes view has to stay readable when an agent has touched a hundred
 * files, the Timeline has to answer "what did this agent do this morning",
 * and usage has to say more than a token count. All three are pure shaping
 * logic, which is why they live outside the tree classes.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { buildFileTree, relativeTo } from "../out/test/changeTree.js";
import {
  DEFAULT_FILTER,
  agentsIn,
  describeFilter,
  filterEdits,
  isFiltered,
  windowRange,
} from "../out/test/timeline.js";
import { UsageTracker, emptyTotals, formatDuration, formatTokens } from "../out/test/usage.js";

let passed = 0;
const ok = (n) => { passed += 1; console.log(`  ok  ${n}`); };

const file = (p, at = 0) => ({ path: p, edits: [{ path: p, at, agentKey: "qwen", sessionId: "s" }] });

// --- relative paths ----------------------------------------------------------
assert.equal(relativeTo(["/work"], "/work/src/a.ts"), "src/a.ts");
assert.equal(relativeTo(["/work/"], "/work/src/a.ts"), "src/a.ts");
assert.equal(
  relativeTo(["/work", "/work/nested"], "/work/nested/a.ts"),
  "a.ts",
  "the most specific root wins when roots are nested",
);
assert.equal(
  relativeTo(["/work"], "/elsewhere/a.ts"),
  "/elsewhere/a.ts",
  "a file outside every root keeps its absolute path rather than being disguised",
);
assert.equal(relativeTo(["C:\\work"], "C:\\work\\src\\a.ts"), "src/a.ts");
ok("paths are shown relative to the root that contains them");

// A root prefix must match on a boundary: /work must not swallow /work-other.
assert.equal(relativeTo(["/work"], "/work-other/a.ts"), "/work-other/a.ts");
ok("a similarly named sibling directory is not mistaken for the workspace root");

// --- folder tree -------------------------------------------------------------
const tree = buildFileTree(
  [
    file("/work/src/extension/chatView.ts"),
    file("/work/src/extension/session.ts"),
    file("/work/src/webview/main.ts"),
    file("/work/README.md"),
  ],
  ["/work"],
);

assert.deepEqual(
  tree.map((node) => node.label),
  ["src", "README.md"],
  "folders sort before files, each alphabetically",
);

const src = tree[0];
assert.equal(src.type, "folder");
assert.equal(src.fileCount, 3, "a folder counts every file beneath it, not just its own");
assert.deepEqual(
  src.children.map((node) => node.label),
  ["extension", "webview"],
);
assert.deepEqual(
  src.children[0].children.map((node) => node.label),
  ["chatView.ts", "session.ts"],
);
ok("edited files are arranged into a folder hierarchy with counts");

// A chain of single-child folders collapses into one row.
const deep = buildFileTree([file("/work/a/b/c/d/leaf.ts")], ["/work"]);
assert.equal(deep.length, 1);
assert.equal(deep[0].label, "a/b/c/d", "a single-child chain compacts into one row");
assert.deepEqual(deep[0].children.map((n) => n.label), ["leaf.ts"]);
ok("chains of single-child folders are compacted");

// A folder holding both a file and a subfolder must not be compacted away.
const branching = buildFileTree(
  [file("/work/a/keep.ts"), file("/work/a/b/leaf.ts")],
  ["/work"],
);
assert.equal(branching[0].label, "a", "a folder with its own file cannot be folded into its child");
assert.deepEqual(branching[0].children.map((n) => n.label), ["b", "keep.ts"]);
ok("a folder holding its own file is not compacted away");

assert.deepEqual(buildFileTree([], ["/work"]), []);
ok("an empty change set yields an empty tree");

// Files outside the workspace still appear rather than vanishing.
const outside = buildFileTree([file("/elsewhere/x.ts")], ["/work"]);
assert.equal(outside.length, 1);
assert.equal(
  JSON.stringify(outside).includes("x.ts"),
  true,
  "an out-of-workspace edit must still be visible",
);
ok("edits outside the workspace are still shown");

// --- timeline windows --------------------------------------------------------
const noon = new Date("2026-08-26T12:00:00").getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const all = windowRange("all", noon);
assert.equal(all.from, -Infinity);
assert.equal(all.to, Infinity);

const yesterday = windowRange("yesterday", noon);
const startOfToday = new Date(noon).setHours(0, 0, 0, 0);
assert.equal(yesterday.from, startOfToday - DAY);
assert.equal(yesterday.to, startOfToday, "yesterday is a bounded day, not everything before today");
ok("time windows are half-open ranges, so yesterday excludes today");

const edits = [
  { path: "/a", at: noon - 10 * 60 * 1000, agentKey: "qwen", sessionId: "s1" },
  { path: "/b", at: noon - 5 * HOUR, agentKey: "claude", sessionId: "s2" },
  { path: "/c", at: startOfToday - 3 * HOUR, agentKey: "qwen", sessionId: "s1" },
  { path: "/d", at: startOfToday - 10 * DAY, agentKey: "claude", sessionId: "s3" },
];

const paths = (filter) => filterEdits(edits, filter, noon).map((e) => e.path).sort();
assert.deepEqual(paths({ window: "all" }), ["/a", "/b", "/c", "/d"]);
assert.deepEqual(paths({ window: "hour" }), ["/a"]);
assert.deepEqual(paths({ window: "today" }), ["/a", "/b"]);
assert.deepEqual(paths({ window: "yesterday" }), ["/c"]);
assert.deepEqual(paths({ window: "week" }), ["/a", "/b", "/c"]);
assert.deepEqual(paths({ window: "month" }), ["/a", "/b", "/c", "/d"]);
ok("each time window selects the right edits");

assert.deepEqual(paths({ window: "all", agentKey: "qwen" }), ["/a", "/c"]);
assert.deepEqual(paths({ window: "today", agentKey: "qwen" }), ["/a"]);
assert.deepEqual(paths({ window: "all", sessionId: "s1" }), ["/a", "/c"]);
assert.deepEqual(paths({ window: "all", agentKey: "claude", sessionId: "s3" }), ["/d"]);
ok("agent and session filters combine with the time window");

assert.deepEqual(agentsIn(edits), ["claude", "qwen"]);
ok("the agents present in the log are listed for the picker");

// --- filter description ------------------------------------------------------
assert.equal(isFiltered(DEFAULT_FILTER), false);
assert.equal(describeFilter(DEFAULT_FILTER), "all edits");
assert.equal(isFiltered({ window: "today" }), true);
assert.equal(describeFilter({ window: "today" }), "today");
assert.equal(describeFilter({ window: "today", agentKey: "qwen" }), "today · qwen");
assert.equal(isFiltered({ window: "all", agentKey: "qwen" }), true);
assert.equal(describeFilter({ window: "all", agentKey: "qwen" }), "qwen");
ok("the active filter describes itself for the view title");

// --- usage metrics -----------------------------------------------------------
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rostrum-usage-"));
const tracker = new UsageTracker(path.join(tmp, "usage.json"));

await tracker.record("qwen", { totalTokens: 100, inputTokens: 60, outputTokens: 40 }, {
  durationMs: 5000,
  toolCalls: 3,
});
await tracker.record("qwen", { totalTokens: 50, inputTokens: 30, outputTokens: 20 }, {
  durationMs: 1000,
  toolCalls: 1,
});

const [entry] = tracker.entries();
assert.equal(entry.totals.turns, 2);
assert.equal(entry.totals.totalTokens, 150);
assert.equal(entry.totals.durationMs, 6000);
assert.equal(entry.totals.toolCalls, 4);
ok("duration and tool calls accumulate alongside token counts");

// A turn with no reported cost must not corrupt the totals.
await tracker.record("qwen", { totalTokens: 10 });
assert.equal(tracker.entries()[0].totals.durationMs, 6000);
assert.equal(tracker.entries()[0].totals.toolCalls, 4);
assert.equal(tracker.entries()[0].totals.turns, 3);
ok("a turn without duration or tool counts leaves those totals untouched");

// Totals written before these fields existed must not poison later arithmetic.
const legacy = path.join(tmp, "legacy.json");
await fs.writeFile(
  legacy,
  JSON.stringify({ qwen: { turns: 5, totalTokens: 500, inputTokens: 300, outputTokens: 200 } }),
);
const upgraded = new UsageTracker(legacy);
await upgraded.record("qwen", { totalTokens: 100 }, { durationMs: 2000, toolCalls: 2 });
const totals = upgraded.entries()[0].totals;
assert.equal(totals.totalTokens, 600);
assert.equal(totals.durationMs, 2000, "a missing field starts from zero rather than becoming NaN");
assert.equal(totals.toolCalls, 2);
assert.ok(Number.isFinite(totals.thoughtTokens));
ok("usage totals written by an older version upgrade without producing NaN");

assert.deepEqual(Object.keys(emptyTotals()).sort(), [
  "cachedReadTokens", "durationMs", "inputTokens", "outputTokens",
  "thoughtTokens", "toolCalls", "totalTokens", "turns",
]);
ok("empty totals carry every field the tree expects");

// --- formatting --------------------------------------------------------------
assert.equal(formatTokens(999), "999");
assert.equal(formatTokens(1500), "1.5k");
assert.equal(formatTokens(2_500_000), "2.50M");
assert.equal(formatDuration(0), "0s");
assert.equal(formatDuration(-5), "0s");
assert.equal(formatDuration(4500), "5s");
assert.equal(formatDuration(72_000), "1m 12s");
assert.equal(formatDuration(3_720_000), "1h 2m");
ok("token counts and durations format compactly");

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\nPASS: ${passed} workspace view checks`);
