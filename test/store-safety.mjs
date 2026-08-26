/**
 * Session store safety checks.
 *
 * Session ids come from the agent. Treating one as a path component let a
 * malicious or faulty agent write and delete files anywhere the extension host
 * could reach, so these checks attack the store with ids designed to escape.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { SessionStore } from "../out/test/store.js";

let passed = 0;
const ok = (n) => { passed += 1; console.log(`  ok  ${n}`); };

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rostrum-store-"));
const root = path.join(tmp, "storage", "sessions");
const store = new SessionStore(root);

const turns = [{ id: "t", role: "user", blocks: [{ kind: "text", text: "hello" }] }];
const save = (sessionId, title = "T") =>
  store.save({ sessionId, agentKey: "qwen", title, updatedAt: 1, turns });

// --- traversal ---------------------------------------------------------------
const HOSTILE = [
  "../../escaped",
  "../escaped",
  "a/../../escaped",
  "/etc/rostrum-escaped",
  "..",
  ".",
  "nested/child",
  "with space/../../escaped",
  "\\\\..\\\\..\\\\escaped",
];

for (const sessionId of HOSTILE) {
  await save(sessionId, `hostile ${sessionId}`);
}

// Nothing may exist outside the store directory.
const outside = path.dirname(root);
const strayInStorage = (await fs.readdir(outside)).filter((name) => name !== "sessions");
assert.deepEqual(strayInStorage, [], `nothing may be written beside the store: ${strayInStorage}`);
const strayInTmp = (await fs.readdir(tmp)).filter((name) => name !== "storage");
assert.deepEqual(strayInTmp, [], `nothing may be written above the store: ${strayInTmp}`);
ok("a hostile session id cannot write outside the store directory");

// The store must be flat: no directories conjured from an id.
const entries = await fs.readdir(root, { withFileTypes: true });
assert.equal(
  entries.every((entry) => entry.isFile()),
  true,
  "an id containing a separator must not create directories",
);
assert.equal(
  entries.every((entry) => /^[0-9a-f]{64}\.json$/.test(entry.name) || entry.name === "catalog.json"),
  true,
  `every transcript is named by hash: ${entries.map((e) => e.name).join(", ")}`,
);
ok("transcripts are named by hash, so no id can steer the filename");

// Every hostile id still round-trips as data.
for (const sessionId of HOSTILE) {
  const loaded = await store.load(sessionId);
  assert.ok(loaded, `${JSON.stringify(sessionId)} must still be loadable`);
  assert.equal(loaded.sessionId, sessionId, "the real id is preserved inside the file");
}
ok("hostile ids are still usable as ids, just never as paths");

// Distinct ids must not collide.
assert.equal((await store.list()).length, HOSTILE.length);
ok("every distinct id gets its own transcript");

// --- deletion cannot escape either -------------------------------------------
const victim = path.join(outside, "important.json");
await fs.writeFile(victim, JSON.stringify({ keep: true }));
await store.delete("../important");
assert.ok(await fs.stat(victim).catch(() => null), "delete must not remove a file outside the store");
await fs.rm(victim, { force: true });
ok("a hostile id cannot delete files outside the store");

await store.delete("../../escaped");
assert.equal(await store.load("../../escaped"), undefined, "the real transcript is deleted");
assert.equal((await store.list()).length, HOSTILE.length - 1);
ok("deleting by a hostile id removes that session and nothing else");

// --- an id that looks like the catalog ---------------------------------------
await save("catalog", "not the catalog");
await store.replaceAgentCatalog("qwen", [
  { sessionId: "remote-1", agentKey: "qwen", title: "Remote", updatedAt: 5 },
]);
const listed = await store.list();
assert.ok(listed.some((entry) => entry.sessionId === "catalog"), "a session named catalog survives");
assert.ok(listed.some((entry) => entry.sessionId === "remote-1"), "the agent catalog survives");
ok("a session id of \"catalog\" cannot clobber the agent catalog");

// --- legacy transcripts remain readable --------------------------------------
const legacy = path.join(root, "legacy-session.json");
await fs.writeFile(
  legacy,
  JSON.stringify({ sessionId: "legacy-session", agentKey: "qwen", title: "Old", updatedAt: 9, turns }),
);
assert.equal((await store.load("legacy-session"))?.title, "Old");
assert.ok((await store.list()).some((entry) => entry.sessionId === "legacy-session"));
await store.delete("legacy-session");
assert.equal(await fs.stat(legacy).catch(() => null), null, "a legacy file is deleted, not orphaned");
ok("transcripts written by an earlier version stay readable and deletable");

// --- junk files are ignored rather than fatal --------------------------------
await fs.writeFile(path.join(root, "garbage.json"), "not json at all");
await fs.writeFile(path.join(root, "shapeless.json"), JSON.stringify({ nope: 1 }));
assert.doesNotThrow(async () => store.list());
const survived = await store.list();
assert.equal(
  survived.some((entry) => entry.sessionId === undefined),
  false,
  "a malformed file must not appear as a session",
);
ok("malformed files in the store are skipped rather than breaking the list");

// --- caching must not go stale ------------------------------------------------
{
  const cached = new SessionStore(path.join(tmp, "cached"));
  await cached.save({ sessionId: "c1", agentKey: "qwen", title: "First", updatedAt: 1, turns });
  assert.equal((await cached.list())[0].title, "First");

  // Our own write must be visible immediately.
  await cached.save({ sessionId: "c1", agentKey: "qwen", title: "Second", updatedAt: 2, turns });
  assert.equal((await cached.list())[0].title, "Second");
  assert.equal((await cached.load("c1")).title, "Second");
  ok("a transcript rewritten through the store is read back immediately");

  // A write from another window must be picked up too, which a cache keyed
  // only on our own writes would miss.
  const files = (await fs.readdir(path.join(tmp, "cached"))).filter((n) => n.endsWith(".json"));
  const target = path.join(tmp, "cached", files[0]);
  const raw = JSON.parse(await fs.readFile(target, "utf8"));
  // A different size and a later mtime, as any real external write would have.
  await fs.writeFile(target, JSON.stringify({ ...raw, title: "Changed elsewhere!!" }));
  await fs.utimes(target, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
  assert.equal((await cached.list())[0].title, "Changed elsewhere!!");
  ok("a transcript changed by another window is picked up rather than served stale");

  await cached.delete("c1");
  assert.deepEqual(await cached.list(), []);
  assert.equal(await cached.load("c1"), undefined);
  ok("a deleted transcript leaves the cache immediately");
}

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\nPASS: ${passed} store safety checks`);
