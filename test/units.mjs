/**
 * Unit checks for the pieces added after the first cut: registry resolution,
 * usage accounting, change history, and the sub-agent heuristic.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { availability, platformKey, toDefinition } from "../out/test/registry.js";
import { UsageTracker, formatTokens } from "../out/test/usage.js";
import { ChangeHistory } from "../out/test/history.js";
import { isSubAgentCall } from "../out/test/session.js";
import { readCapabilities } from "../out/test/capabilities.js";
import { SessionStore } from "../out/test/store.js";
import { mcpServersFromConfig } from "../out/test/mcp.js";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rostrum-test-"));
let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
};

// --- platform key -----------------------------------------------------------
check("platformKey uses registry spelling", () => {
  assert.match(platformKey(), /^(linux|darwin|windows)-(x86_64|aarch64)$/);
});

// --- registry ---------------------------------------------------------------
const npxAgent = {
  id: "qwen-code",
  name: "Qwen Code",
  distribution: { npx: { package: "@qwen-code/qwen-code@0.22.1", args: ["--acp"] } },
};

check("npx agents are installable", () => {
  assert.deepEqual(availability(npxAgent), { kind: "npx" });
});

check("agents with no build for this platform are unavailable", () => {
  const other = { id: "x", name: "X", distribution: { binary: { "solaris-sparc": {} } } };
  assert.equal(availability(other), undefined);
});

const definition = await toDefinition(npxAgent, tmp, () => {});
assert.deepEqual(definition, {
  command: "npx",
  args: ["@qwen-code/qwen-code@0.22.1", "--acp"],
  env: undefined,
});
console.log("  ok  npx definition needs no download");
passed += 1;

// --- sub-agent heuristic ----------------------------------------------------
check("delegation tools are flagged", () => {
  assert.equal(isSubAgentCall("task", "other"), true);
  assert.equal(isSubAgentCall("dispatch_agent", "other"), true);
  assert.equal(isSubAgentCall("Sub-Agent", "other"), true);
});

check("ordinary tools are not flagged", () => {
  assert.equal(isSubAgentCall("read_file", "read"), false);
  assert.equal(isSubAgentCall(undefined, "edit"), false);
  // A thinking tool named "task" is still thinking, not delegation.
  assert.equal(isSubAgentCall("task", "think"), false);
});

// --- usage ------------------------------------------------------------------
const usage = new UsageTracker(path.join(tmp, "usage.json"));
await usage.record("Qwen Code", { totalTokens: 100, inputTokens: 70, outputTokens: 30 });
await usage.record("Qwen Code", { totalTokens: 50, inputTokens: 40, outputTokens: 10 });
await usage.record("Qwen Code", null);

const totals = usage.entries()[0].totals;
assert.equal(totals.totalTokens, 150, "totals should accumulate");
assert.equal(totals.turns, 2, "a null usage must not count as a turn");
console.log("  ok  usage accumulates and ignores absent counts");
passed += 1;

const reloaded = new UsageTracker(path.join(tmp, "usage.json"));
await reloaded.load();
assert.equal(reloaded.entries()[0].totals.totalTokens, 150, "usage should survive a reload");
console.log("  ok  usage persists across reload");
passed += 1;

check("token formatting is compact", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(12400), "12.4k");
  assert.equal(formatTokens(2_500_000), "2.50M");
});

// --- MCP transport mapping -------------------------------------------------
check("MCP transports respect agent capabilities and validate URLs", () => {
  const servers = mcpServersFromConfig({
    local: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], env: { MODE: "safe" } },
    remote: { type: "http", url: "https://mcp.example.test", headers: { Authorization: "Bearer test" } },
    events: { type: "sse", url: "https://events.example.test" },
    invalid: { type: "http", url: "file:///not-an-mcp" },
  }, { http: true, sse: false });
  assert.equal(servers.length, 2);
  assert.equal(servers[0].name, "local");
  assert.equal(servers[1].type, "http");
  assert.equal(servers[1].headers[0].name, "Authorization");
});

// --- session catalog -------------------------------------------------------
const sessions = new SessionStore(path.join(tmp, "sessions"));
await sessions.save({
  sessionId: "local-1",
  agentKey: "Qwen",
  title: "Local transcript",
  updatedAt: 100,
  turns: [],
});
await sessions.replaceAgentCatalog("Qwen", [
  { sessionId: "remote-1", agentKey: "ignored", title: "Remote session", updatedAt: 300 },
  { sessionId: "local-1", agentKey: "ignored", title: "Stale remote title", updatedAt: 400 },
]);
let catalog = await sessions.list();
assert.deepEqual(catalog.map((session) => session.sessionId), ["remote-1", "local-1"]);
assert.equal((await sessions.meta("remote-1"))?.agentKey, "Qwen");
assert.equal(catalog.find((session) => session.sessionId === "local-1")?.title, "Local transcript");
console.log("  ok  remote catalog merges with local transcripts safely");
passed += 1;

await sessions.replaceAgentCatalog("Qwen", [
  { sessionId: "remote-2", agentKey: "ignored", title: "New remote session", updatedAt: 500 },
]);
catalog = await sessions.list();
assert.deepEqual(catalog.map((session) => session.sessionId), ["remote-2", "local-1"]);
await sessions.delete("remote-2");
assert.equal(await sessions.meta("remote-2"), undefined);
console.log("  ok  full remote sync replaces stale entries and deletion clears catalog metadata");
passed += 1;

// --- change history ---------------------------------------------------------
const historyFile = path.join(tmp, "changes.jsonl");
const history = new ChangeHistory(historyFile);
await history.record({ path: "/w/a.ts", sessionId: "s1", agentKey: "Qwen", at: 1000 });
await history.record({ path: "/w/b.ts", sessionId: "s1", agentKey: "Qwen", at: 2000 });
await history.record({ path: "/w/a.ts", sessionId: "s2", agentKey: "Hermes", at: 3000 });

const files = history.files();
assert.equal(files.length, 2, "two distinct files");
assert.equal(files[0].path, "/w/a.ts", "most recently edited file comes first");
assert.equal(files[0].edits.length, 2, "both edits of a.ts retained");
assert.equal(files[0].edits[0].agentKey, "Hermes", "newest edit first");
console.log("  ok  change history groups and orders edits");
passed += 1;

assert.equal(history.lastTouchedBy("/w/a.ts").sessionId, "s2");
console.log("  ok  lastTouchedBy reports the newest session");

await history.record({
  path: "/w/diff.ts",
  sessionId: "s3",
  agentKey: "Qwen",
  toolCallId: "edit-1",
  oldText: "before",
  newText: "after",
  at: 4000,
});
await history.record({
  path: "/w/diff.ts",
  sessionId: "s3",
  agentKey: "Qwen",
  toolCallId: "edit-1",
  oldText: "before",
  newText: "after",
  at: 4001,
});
assert.equal(history.files().find((file) => file.path === "/w/diff.ts").edits.length, 1);
console.log("  ok  duplicate tool diff snapshots are deduplicated");
passed += 1;

const rehydrated = new ChangeHistory(historyFile);
await rehydrated.load();
assert.equal(rehydrated.files().length, 3, "history should survive a reload");
console.log("  ok  change history persists across reload");
passed += 1;

// A torn trailing line must not lose the whole log.
await fs.appendFile(historyFile, '{"path":"/w/c.ts","sessi', "utf8");
const torn = new ChangeHistory(historyFile);
await torn.load();
assert.equal(torn.files().length, 3, "a truncated line should be skipped, not fatal");
console.log("  ok  torn trailing line is skipped");
passed += 1;

// --- capabilities -----------------------------------------------------------
// Every optional method exists on the SDK connection object, so advertisement
// is what must gate the UI.
const allMethods = {
  loadSession: () => {},
  unstable_forkSession: () => {},
  listSessions: () => {},
  deleteSession: () => {},
  resumeSession: () => {},
  setSessionMode: () => {},
};

check("real Qwen capabilities map correctly", () => {
  // Exactly what Qwen Code 0.22 advertises.
  const caps = readCapabilities(
    { loadSession: true, sessionCapabilities: { list: {}, resume: {}, additionalDirectories: {} } },
    allMethods,
  );
  assert.equal(caps.loadSession, true);
  assert.equal(caps.listSessions, true, "empty object means supported");
  assert.equal(caps.resumeSession, true);
  assert.equal(caps.additionalDirectories, true);
  assert.equal(caps.forkSession, false, "fork was never advertised");
  assert.equal(caps.deleteSession, false);
});

check("undeclared capabilities stay off even though methods exist", () => {
  const caps = readCapabilities({}, allMethods);
  assert.equal(caps.loadSession, false);
  assert.equal(caps.forkSession, false);
  assert.equal(caps.listSessions, false);
});

check("declared capabilities stay off when the method is missing", () => {
  const caps = readCapabilities(
    { loadSession: true, sessionCapabilities: { fork: {} } },
    {},
  );
  assert.equal(caps.loadSession, false);
  assert.equal(caps.forkSession, false);
});

check("missing agentCapabilities does not throw", () => {
  const caps = readCapabilities(undefined, allMethods);
  assert.equal(caps.loadSession, false);
});

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\nPASS: ${passed} checks`);
